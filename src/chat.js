'use strict';

/**
 * Travel-assistant chat for the website, powered by a LOCAL Ollama model
 * (default: qwen2.5:7b). Runs entirely on the machine — no cloud API, no cost.
 *
 * The assistant is GROUNDED in the site's own data: it is handed a compact
 * snapshot of the packages, destinations and visa options from the database,
 * and is instructed to answer only from that snapshot. That keeps a 7B model
 * accurate without giving it tools.
 *
 * Fails soft: if Ollama is not running or the model is missing, /api/chat
 * returns a clear message instead of throwing.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.CHAT_MODEL || 'qwen2.5:7b';
const REQUEST_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 45000;
const MAX_MESSAGES = 12;     // keep the rolling history short (small context)
const MAX_CHARS = 800;       // per user message

const fallback = require('./travel-fallback');

/** Build a short factual snapshot of the site so the model answers accurately. */
function buildContext(query) {
  const packages = query.all(
    'SELECT title, destination, category, days, nights, price, discount, summary FROM packages ORDER BY id LIMIT 12'
  );
  const destinations = query.all(
    'SELECT name, kind, region, description FROM destinations ORDER BY id LIMIT 16'
  );
  const lines = [];

  lines.push('PACKAGES:');
  for (const p of packages) {
    const final = p.discount > 0 ? Math.round(p.price - (p.price * p.discount) / 100) : p.price;
    lines.push(`- ${p.title} | ${p.destination} | ${p.days}D/${p.nights}N | Rs.${final}` +
      (p.discount > 0 ? ` (${p.discount}% off Rs.${p.price})` : '') + ` | ${p.summary}`);
  }

  lines.push('');
  lines.push('DESTINATIONS:');
  for (const d of destinations) {
    lines.push(`- ${d.name} (${d.kind}, ${d.region}) — ${d.description}`);
  }

  lines.push('');
  lines.push('VISA SERVICES: America, Canada, UK, Europe (Schengen), Japan, China, Thailand, Bali, ' +
    'Malaysia, Turkey, Hong Kong, Australia. We help with document checklists, appointments and interviews.');

  return lines.join('\n');
}

function systemPrompt(context) {
  return [
    'You are the friendly travel assistant for "Himalayan Voyage Nepal", a travel agency in Pokhara, Nepal.',
    'Answer ONLY from the SITE DATA below. If something is not in the data, say you will pass the question to the team and suggest calling +977 9800000000 or using the Contact page.',
    'Be warm, concise and helpful. Use short paragraphs or bullet points.',
    'LANGUAGE RULE (strict): reply in the SAME language as the visitor\'s last message.',
    '  - If the visitor writes in ENGLISH, reply ONLY in English. Never reply in Hindi or Nepali.',
    '  - If the visitor writes in Nepali (Devanagari), reply in Nepali.',
    '  - Never mix languages and never default to Hindi.',
    'Never invent prices, dates, visa rules or packages that are not listed.',
    '',
    'SITE DATA:',
    context
  ].join('\n');
}

/** Ask Ollama for a non-streaming completion. Throws on transport/timeout. */
async function askOllama(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OLLAMA_HOST + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: { temperature: 0.4, num_ctx: 4096 }
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 404 usually means the model was never pulled — surface that as 503 so
      // the widget can show actionable advice instead of a generic server error.
      const status = res.status === 404 ? 503 : 502;
      throw Object.assign(
        new Error('ollama HTTP ' + res.status + (text ? ': ' + text.slice(0, 120) : '')),
        { status }
      );
    }
    const data = await res.json();
    return (data.message && data.message.content) || '';
  } catch (err) {
    // A transport failure (Ollama not running, host unreachable, timeout) arrives
    // as a bare "fetch failed" / AbortError with no HTTP status. Without this tag
    // the route reports a confusing 500 — and on a cloud host where Ollama is
    // simply absent, that is the normal, expected case. Tag it 503 + a clear
    // reason so the UI can tell the visitor the assistant is offline.
    if (!err.status) {
      const reason = err.name === 'AbortError'
        ? 'The assistant timed out.'
        : 'The travel assistant is offline right now.';
      throw Object.assign(new Error(reason), { status: 503, cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Is the configured model actually available in Ollama right now? */
async function status() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(OLLAMA_HOST + '/api/tags', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, model: OLLAMA_MODEL, reason: 'ollama HTTP ' + res.status };
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name);
    const has = names.includes(OLLAMA_MODEL) ||
      names.some((n) => n.split(':')[0] === OLLAMA_MODEL.split(':')[0]);
    return { ok: has, model: OLLAMA_MODEL, available: names,
      reason: has ? null : 'model ' + OLLAMA_MODEL + ' not pulled' };
  } catch (err) {
    return { ok: false, model: OLLAMA_MODEL, reason: 'ollama unreachable: ' + err.message };
  }
}

/**
 * Which engine answered the last turn. Exposed so /api/chat/status can be
 * honest about whether the model or the offline fallback is in use.
 */
let lastEngine = null;

/**
 * Handle one chat turn. `messages` is the raw client array; it is validated,
 * trimmed and prefixed with the grounded system prompt.
 *
 * Strategy: ask the local Ollama model (best answers, understands free text).
 * If Ollama is not running — the normal situation on a free cloud host — fall
 * back to the deterministic, database-grounded answerer so the assistant keeps
 * working instead of going dark. The fallback is also used for the very first
 * message when the model is slow, so visitors get an instant grounded reply.
 */
async function chat(history, query) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_CHARS) }));

  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    throw Object.assign(new Error('A user message is required'), { status: 400 });
  }

  const last = clean[clean.length - 1].content;

  // Try the model. Anything that stops it (not installed, not running, slow)
  // drops us into the grounded fallback rather than failing the request.
  let modelError = null;
  try {
    const messages = [{ role: 'system', content: systemPrompt(buildContext(query)) }].concat(clean);
    const reply = await askOllama(messages);
    if (reply.trim()) {
      lastEngine = 'ollama';
      return { reply: reply.trim(), engine: 'ollama' };
    }
    modelError = 'empty reply';
  } catch (err) {
    modelError = err.message;
  }

  const fb = fallback.answer(last, query);
  if (fb.reply) {
    lastEngine = 'fallback';
    return { reply: fb.reply, engine: 'fallback' };
  }

  // Nothing could answer — report the model failure honestly.
  throw Object.assign(new Error('The travel assistant is offline right now.'), {
    status: 503,
    cause: modelError
  });
}

module.exports = { chat, status, buildContext, OLLAMA_MODEL, getLastEngine: () => lastEngine };
