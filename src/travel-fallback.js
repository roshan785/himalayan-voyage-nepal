'use strict';

/**
 * Offline travel assistant — a grounded fallback that answers from the site's
 * own database WITHOUT any language model.
 *
 * WHY THIS EXISTS
 * The primary assistant (`chat.js`) calls a local Ollama model. That is perfect
 * on the machine that runs the site, but a free cloud host has no Ollama and
 * cannot run a 7B model. Rather than switching the widget off in the cloud,
 * this module answers the common questions directly from the same SQLite data.
 *
 * HONEST BY DESIGN
 * It never invents anything. Every number it prints comes from a database row,
 * and anything it cannot answer is handed to the team with the real phone
 * number and contact page — exactly what the LLM is instructed to do.
 *
 * It is also used as an instant first answer on the local machine, so the
 * visitor never waits 10-45 s for the model just to learn a package price.
 */

const PHONE = '+977 9800000000';
const CONTACT_LINE = `Call ${PHONE} or use the Contact page and our team will help you right away.`;

/**
 * Words too generic to identify a package. Without this list, "international
 * tours" would match "Pokhara Leisure Tour" purely because of the word "tour",
 * and the visitor would never reach the international-package list.
 */
const GENERIC_WORDS = new Set([
  'tour', 'tours', 'package', 'packages', 'trip', 'trips', 'holiday', 'holidays',
  'travel', 'trek', 'treks', 'trekking', 'nepal', 'the', 'and', 'for', 'you', 'your'
]);

/**
 * Resolve the best package for a visitor's query, or null when none matches.
 *
 * Only the package TITLE and DESTINATION contribute relevance. Category names
 * ("international", "trekking") deliberately do NOT, because "international
 * tours" is a request for the whole list, not for one package — the caller
 * handles those with `opts`. Discount is a tiebreaker only; it never creates a
 * match on its own (otherwise every discounted package would match everything).
 */
function findPackage(text, query, opts = {}) {
  const packages = query.all(
    'SELECT title, slug, destination, category, days, nights, price, discount, summary FROM packages ORDER BY id'
  );
  if (!packages.length) return null;

  const lowered = text.toLowerCase();
  const scored = packages.map((p) => {
    let base = 0;
    const title = (p.title || '').toLowerCase();
    const dest = (p.destination || '').toLowerCase();

    if (title && lowered.includes(title)) base += 10;

    // Word-level matching keeps "thai" from matching "thailand" by accident
    // while still letting "pokhara" or "annapurna" find their package. Generic
    // words are skipped so a vague "tours" cannot pin one random package.
    const words = `${title} ${dest}`.split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
    for (const w of words) if (lowered.includes(w)) base += 3;
    if (dest && lowered.includes(dest)) base += 5;

    let bonus = 0;
    if (base > 0 && p.discount > 0) bonus += 0.5;   // tiebreak only
    if (opts.cheapest) bonus += (100000 - p.price) / 100000;
    if (opts.trekking && p.category === 'trekking') bonus += 8;
    if (opts.international && p.category === 'international') bonus += 8;
    if (opts.domestic && p.category === 'domestic') bonus += 8;

    return { p, base, score: base + bonus };
  });

  scored.sort((a, b) => b.score - a.score);

  // Without opts, a package must be genuinely named to be returned — otherwise
  // the caller's list/keyword intents should handle the question.
  const needsName = !opts.cheapest && !opts.trekking && !opts.international && !opts.domestic;
  if (needsName && scored[0].base === 0) return null;
  if (!needsName && scored[0].base === 0 && scored[0].score <= 0.6) return null;
  return scored[0].p;
}

/** Price after discount, as the site displays it. */
function finalPrice(p) {
  return p.discount > 0 ? Math.round(p.price - (p.price * p.discount) / 100) : Math.round(p.price);
}

function describePackage(p) {
  const bits = [
    `${p.title} — ${p.destination}, ${p.days} days / ${p.nights} nights`,
    `Price: Rs.${finalPrice(p).toLocaleString('en-US')} per person` +
      (p.discount > 0 ? ` (${p.discount}% off Rs.${Math.round(p.price).toLocaleString('en-US')})` : '')
  ];
  if (p.summary) bits.push(p.summary);
  bits.push(`You can see the full itinerary on the Packages page, or ${CONTACT_LINE.charAt(0).toLowerCase()}${CONTACT_LINE.slice(1)}`);
  return bits.join('\n\n');
}

/** Is the visitor writing Nepali (Devanagari)? */
function isNepali(text) {
  return /[\u0900-\u097F]/.test(text);
}

/** Catalogue summary — also the greeting when someone just says "hi". */
function listPackages(query, opts = {}) {
  const rows = query.all(
    'SELECT title, destination, days, nights, price, discount, category FROM packages ORDER BY price'
  );
  const filtered = opts.category ? rows.filter((r) => r.category === opts.category) : rows;
  if (!filtered.length) return null;

  const show = filtered.slice(0, opts.limit || 6);
  const lines = show.map(
    (p) => `• ${p.title} — ${p.destination}, ${p.days}D/${p.nights}N · Rs.${finalPrice(p).toLocaleString('en-US')}`
  );
  const label = opts.category ? `${opts.category} ` : '';
  return (
    `Here are our ${label}packages:\n\n` + lines.join('\n') +
    (filtered.length > show.length ? `\n\n…and ${filtered.length - show.length} more on the Packages page.` : '') +
    `\n\n${CONTACT_LINE}`
  );
}

function listDestinations(query, kind) {
  const rows = query.all('SELECT name, kind, region FROM destinations ORDER BY name');
  const filtered = kind ? rows.filter((r) => r.kind === kind) : rows;
  if (!filtered.length) return null;
  return (
    `We cover these destinations:\n\n` +
    filtered.map((d) => `• ${d.name}${d.region ? ` (${d.region})` : ''}`).join('\n') +
    `\n\n${CONTACT_LINE}`
  );
}

/**
 * Answer a visitor message from site data alone.
 * @returns {{reply: string|null, intent: string}} reply is null when unknown.
 */
function answer(message, query) {
  const text = String(message || '');
  const t = text.toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  const np = isNepali(text);

  // Country-specific visa first, e.g. "visa for canada" must not fall through
  // to the generic visa list.
  const VISA_COUNTRIES = ['america', 'usa', 'united states', 'canada', 'uk', 'england', 'britain',
    'europe', 'schengen', 'japan', 'china', 'thailand', 'bali', 'malaysia', 'turkey', 'hong kong', 'australia'];
  if (has('visa', 'passport', 'embassy', 'भिसा', 'पासपोर्ट')) {
    const country = VISA_COUNTRIES.find((c) => t.includes(c));
    if (country) {
      const label = country === 'usa' || country === 'united states' ? 'America' : country.replace(/\b\w/g, (m) => m.toUpperCase());
      const slug = country.replace(/\s+/g, '-');
      return {
        intent: 'visa-country',
        reply:
          `We help with the ${label} visa — document checklist, appointment booking and interview preparation.\n\n` +
          `Open the ${label} Visa page from the Visa menu (or visit visa-${slug === 'usa' ? 'usa' : slug}.html) for the full checklist, ` +
          'and download the PDF to print. Tell me your travel dates and I can flag anything time-sensitive.\n\n' + CONTACT_LINE
      };
    }
    return {
      intent: 'visa',
      reply:
        'We help with visa documentation, appointment booking and interview preparation for ' +
        'America, Canada, the UK, Europe (Schengen), Japan, China, Thailand, Bali, Malaysia, ' +
        'Turkey, Hong Kong and Australia.\n\n' +
        'Each country has its own page with a document checklist and a downloadable PDF under ' +
        'the Visa menu. Tell me which country and I will point you to it.\n\n' + CONTACT_LINE
    };
  }

  // --- specific package: naming a package always beats a generic list
  const named = findPackage(t, query);
  if (named) return { reply: describePackage(named), intent: 'package' };

  // --- cheapest / budget
  if (has('cheap', 'cheapest', 'budget', 'affordable', 'sasto', 'किफायती', 'सस्तो', 'lowest price', 'minimum')) {
    const p = findPackage(t, query, { cheapest: true });
    if (p) return { reply: describePackage(p), intent: 'cheapest' };
  }

  // --- trekking
  if (has('trek', 'trekking', 'hike', 'hiking', 'base camp', 'ट्रेक')) {
    const p = findPackage(t, query, { trekking: true });
    if (p) return { reply: describePackage(p), intent: 'trekking' };
  }

  // --- international vs domestic
  if (has('international', 'abroad', 'foreign', 'overseas', 'बिदेश', 'अन्तर्राष्ट्रिय')) {
    return { reply: listPackages(query, { category: 'international' }), intent: 'international' };
  }
  if (has('domestic', 'nepal package', 'within nepal', 'स्वदेश')) {
    return { reply: listPackages(query, { category: 'domestic' }), intent: 'domestic' };
  }

  // --- price in general
  if (has('price', 'cost', 'how much', 'rate', 'पैसा', 'मूल्य', 'कति')) {
    return { reply: listPackages(query), intent: 'price' };
  }

  // --- duration
  if (has('how many days', 'duration', 'how long', 'कति दिन')) {
    const p = findPackage(t, query);
    if (p) return { reply: describePackage(p), intent: 'duration' };
  }

  // --- destinations
  if (has('destination', 'where do you', 'place', 'गन्तव्य', 'कहाँ')) {
    return { reply: listDestinations(query, null), intent: 'destinations' };
  }

  // --- contact / booking
  if (has('contact', 'book', 'booking', 'enquire', 'inquiry', 'phone', 'call', 'email', 'सम्पर्क', 'बुक')) {
    return {
      intent: 'contact',
      reply:
        `You can reach our team directly:\n\n• Phone: ${PHONE}\n• Email: hello@himalayanvoyage.test\n` +
        '• Office: Lakeside Road, Pokhara, Nepal\n• Or use the Contact page to send a message.\n\n' +
        'Tell me which trip you are interested in and I can share the details first.'
    };
  }

  // --- browse/ask about trips (generic) → show the catalogue
  if (has('package', 'packages', 'tour', 'tours', 'trip', 'trips', 'holiday', 'holidays', 'itinerary')) {
    return { reply: listPackages(query), intent: 'packages' };
  }

  // --- greeting → a short welcome, NOT the whole catalogue
  if (has('hello', 'hi ', 'hey', 'namaste', 'नमस्ते') || t.trim() === 'hi' || t.trim() === 'hey') {
    return {
      intent: 'greeting',
      reply:
        (np
          ? 'नमस्ते! 🙏 म Himalayan Voyage Nepal को यात्रा सहायक हुँ। '
          : 'Namaste! 🙏 I am the travel assistant for Himalayan Voyage Nepal. ') +
        'I can help with our tour packages and prices, destinations in and around Nepal, ' +
        'trekking options and visa services.\n\n' +
        (np ? 'के जान्न चाहनुहुन्छ?' : 'What would you like to explore?')
    };
  }

  // --- anything else: be honest and hand over to the team
  return {
    intent: 'unknown',
    reply:
      (np
        ? 'यो प्रश्नको जवाफ मसँग सिधै छैन। '
        : 'I do not have that detail to hand. ') +
      'I can help with our packages and prices, destinations, trekking options and visa services. ' +
      CONTACT_LINE
  };
}

/** Short capability blurb for GET /api/chat/status. */
const INTENTS = ['package', 'cheapest', 'trekking', 'international', 'domestic', 'visa', 'price', 'destinations', 'contact', 'greeting'];

module.exports = { answer, findPackage, listPackages, listDestinations, finalPrice, isNepali, INTENTS };
