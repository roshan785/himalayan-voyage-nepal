'use strict';

/**
 * Travel-assistant chat widget — talks to /api/chat, which is backed by a
 * LOCAL Ollama model (qwen2.5:7b). No cloud API is used, so it costs nothing
 * and works offline.
 *
 * The widget is injected by layout.js on every page, so it is available
 * everywhere without touching individual pages.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  const CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.3-.5L3 21l1.7-5A8.1 8.1 0 0 1 4 11.5 8.4 8.4 0 0 1 13 3a8.4 8.4 0 0 1 8 8.5z"/></svg>';
  const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';

  const SUGGESTIONS = [
    'Show me Nepal tour packages',
    'Do you help with a Japan visa?',
    'What is the best time to visit Nepal?',
    'I want a custom itinerary'
  ];

  let history = [];   // [{role:'user'|'assistant', content}]
  let sending = false;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function buildWidget() {
    // Floating button
    const fab = el('button', '', CHAT_ICON + '<span class="chat-fab__dot"></span>');
    fab.id = 'chat-fab';
    fab.setAttribute('aria-label', 'Open travel assistant');
    fab.type = 'button';

    // Panel
    const panel = el('div', 'chat-panel');
    panel.id = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Travel assistant');
    panel.innerHTML = `
      <div class="chat-head">
        <div class="chat-avatar">HV</div>
        <div>
          <h4>Travel Assistant</h4>
          <p><span class="pulse-dot"></span> Ask about packages, visas &amp; itineraries</p>
        </div>
        <button class="chat-close" type="button" aria-label="Close chat">&times;</button>
      </div>
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-chips" id="chat-chips"></div>
      <form class="chat-form" id="chat-form">
        <textarea id="chat-input" rows="1" placeholder="Ask about a trip, visa or price…" aria-label="Your message"></textarea>
        <button type="submit" id="chat-send" aria-label="Send">${SEND_ICON}</button>
      </form>`;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const log = panel.querySelector('#chat-log');
    const chips = panel.querySelector('#chat-chips');
    const form = panel.querySelector('#chat-form');
    const input = panel.querySelector('#chat-input');
    const sendBtn = panel.querySelector('#chat-send');

    // Welcome + suggestion chips
    addMessage(log, 'assistant', 'Namaste! 🙏 I can help you choose a tour package, plan an itinerary or explain our visa services. What would you like to know?');
    SUGGESTIONS.forEach((s) => {
      const c = el('button', 'chat-chip', App.escapeHtml(s));
      c.type = 'button';
      c.addEventListener('click', () => { input.value = s; send(); });
      chips.appendChild(c);
    });

    fab.addEventListener('click', () => openPanel(panel, fab, input));
    panel.querySelector('.chat-close').addEventListener('click', () => closePanel(panel, fab));

    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    async function send() {
      const text = input.value.trim();
      if (!text || sending) return;
      sending = true;
      sendBtn.disabled = true;
      input.value = '';
      input.style.height = 'auto';
      chips.style.display = 'none';
      addMessage(log, 'user', text);
      history.push({ role: 'user', content: text });

      const typing = el('div', 'chat-typing', '<span></span><span></span><span></span>');
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;

      try {
        const data = await App.api('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history.slice(-12) })
        });
        typing.remove();
        const reply = (data && data.reply) ? data.reply : '(no reply)';
        addMessage(log, 'assistant', reply);
        history.push({ role: 'assistant', content: reply });
      } catch (err) {
        typing.remove();
        addMessage(log, 'error', 'Sorry — the assistant is unavailable right now. ' +
          (err.message ? '(' + err.message + ')' : '') + ' Please call us on +977 9800000000.');
      } finally {
        sending = false;
        sendBtn.disabled = false;
        log.scrollTop = log.scrollHeight;
      }
    }

    function addMessage(container, kind, text) {
      const cls = kind === 'user' ? 'chat-msg chat-msg--user'
        : kind === 'error' ? 'chat-msg chat-msg--err' : 'chat-msg chat-msg--bot';
      const node = el('div', cls);
      // Escape first (never trust model output), then allow ONLY **bold** so a
      // stray asterisk cannot become markup. Everything else stays literal.
      node.innerHTML = App.escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      container.appendChild(node);
      container.scrollTop = container.scrollHeight;
    }
  }

  function openPanel(panel, fab, input) {
    panel.classList.add('is-open');
    fab.style.display = 'none';
    const dot = fab.querySelector('.chat-fab__dot');
    if (dot) dot.remove();
    setTimeout(() => input.focus(), 200);
  }

  function closePanel(panel, fab) {
    panel.classList.remove('is-open');
    fab.style.display = 'grid';
  }

  function boot() {
    if (!window.App) return;
    buildWidget();
  }

  // This script is appended by layout.js AFTER DOMContentLoaded has already
  // fired, so a plain listener would never run. Check readyState like main.js.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
