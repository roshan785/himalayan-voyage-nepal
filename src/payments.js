'use strict';

/**
 * Payment gateways for the Travel Shop — Nepal-supported providers.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * 1. NO SECRET IS EVER HARDCODED. Each provider reads its own environment
 *    variables and reports `configured: false` when they are missing, so the
 *    site runs fine before a merchant account exists.
 *
 * 2. NO NETWORK CALL UNLESS CONFIGURED. `start()` for a live provider returns a
 *    clear `{ ok: false, reason: 'not-configured' }` instead of throwing, so a
 *    deployment without credentials degrades gracefully instead of 500-ing.
 *
 * 3. SANDBOX AND PRODUCTION ARE SELECTED BY `PAYMENT_ENV`, never guessed. Every
 *    provider base URL is derived from that one switch, so pointing the app at
 *    eSewa/Khalti's sandbox or live host is a single, explicit, reversible
 *    environment change — credentials and URLs can never drift apart.
 *
 * 4. THE BROWSER REDIRECT IS NEVER TRUSTED AS PROOF. A callback only supplies
 *    EVIDENCE; the server re-derives it:
 *      • eSewa  — the `data` blob's HMAC is re-computed with the merchant
 *                 secret, AND the transaction is re-checked against eSewa's own
 *                 transaction-status API.
 *      • Khalti — the `pidx` is confirmed through Khalti's server-to-server
 *                 lookup endpoint.
 *    Only after that does the order route mark an order paid (and atomically).
 *
 * 5. `mock` IS A DEVELOPMENT PROVIDER. It is hard-disabled whenever
 *    PAYMENT_ENV=production unless ALLOW_MOCK_PAYMENTS=true is set explicitly,
 *    so a live site can never be "paid" with a self-produced signature.
 *
 * PROVIDERS
 *   mock    — offline, development only (blocked in production).
 *   esewa   — eSewa ePay v2 (signed form POST + HMAC verification + status API).
 *   khalti  — Khalti ePayment v2 (server initiate + server lookup).
 *   bank    — manual transfer, confirmed by an admin (never auto-paid).
 *
 * HONEST STATUS: `PROVIDER_STATUS[].live` is a statement about what has been
 * VERIFIED, not about what is implemented. It stays false until a real sandbox
 * run has been performed with the user's own credentials.
 */

const crypto = require('crypto');

const PAYMENT_METHODS = ['mock', 'esewa', 'khalti', 'bank'];

/**
 * Which environment's gateway hosts to use.
 *
 * DEFAULT IS DERIVED FROM THE HOST, not hard-coded, because a live site that
 * silently defaults to "sandbox" would leave the development-only mock provider
 * enabled — letting anyone mark an order paid with a self-produced signature.
 * So: production is the default whenever we are clearly NOT on a dev machine
 * (NODE_ENV=production, or running on Render, which sets RENDER=true), and
 * sandbox otherwise. An explicit PAYMENT_ENV always wins.
 */
function paymentEnv() {
  const v = String(process.env.PAYMENT_ENV || '').trim().toLowerCase();
  if (v === 'production' || v === 'sandbox') return v;
  const looksLive = process.env.NODE_ENV === 'production'
    || String(process.env.RENDER || '').toLowerCase() === 'true';
  return looksLive ? 'production' : 'sandbox';
}

function isProduction() {
  return paymentEnv() === 'production';
}

/**
 * May the development-only `mock` provider be offered?
 * Never in production, unless an operator deliberately opts in for a rehearsal
 * (ALLOW_MOCK_PAYMENTS=true). This is the guard that stops a live site from
 * being able to "pay" an order with a signature it produced itself.
 */
function mockAllowed() {
  if (!isProduction()) return true;
  return String(process.env.ALLOW_MOCK_PAYMENTS || '').trim().toLowerCase() === 'true';
}

/** Honest status per provider — shown by /api/payments/providers. */
const PROVIDER_STATUS = {
  mock: { live: false, note: 'Development-only test provider. Blocked automatically when PAYMENT_ENV=production.' },
  esewa: { live: false, note: 'eSewa ePay v2 adapter (signed form POST + HMAC verify + server transaction-status check). Requires ESEWA_* env vars and a sandbox run with your merchant credentials before it is production-proven.' },
  khalti: { live: false, note: 'Khalti ePayment v2 adapter (server initiate + server lookup verify). Requires KHALTI_SECRET_KEY and a sandbox run before it is production-proven.' },
  bank: { live: false, note: 'Manual bank transfer — an admin confirms it; the site never auto-marks these paid.' }
};

/** The site's public origin, used to build absolute callback URLs. */
function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_e) { return false; }
}

/** fetch() with a hard timeout so a slow gateway can never hang a request. */
async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/* ── eSewa ePay v2 ─────────────────────────────────────────────────────────
   Sandbox host : https://rc-epay.esewa.com.np   (eSewa's test/live RC host)
   Production   : https://epay.esewa.com.np
   A test product code ("EPAYTEST") with its published secret exists for the
   integration phase — it never moves real money.

   Signature: base64(HMAC-SHA256(message, secret)) where message is
   "total_amount=<amt>,transaction_uuid=<uuid>,product_code=<code>".
   The success callback returns base64 JSON whose `signature` covers the fields
   listed in `signed_field_names`. */

function esewaConfig() {
  const prod = isProduction();
  return {
    productCode: String(process.env.ESEWA_PRODUCT_CODE || '').trim(),
    secret: String(process.env.ESEWA_SECRET_KEY || '').trim(),
    // A per-environment host, overridable but never guessed from credentials.
    base: String(
      process.env.ESEWA_BASE_URL || (prod ? 'https://epay.esewa.com.np' : 'https://rc-epay.esewa.com.np')
    ).replace(/\/+$/, '')
  };
}

function esewaSignature(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/**
 * Parse an amount that a gateway sent back, WITHOUT ever coercing a malformed
 * value into a plausible-looking number.
 *
 * Why this exists: eSewa's own documented response example shows the amount as
 * the STRING "1,000.0" (with a thousands separator). `Number("1,000.0")` is
 * `NaN`, which — before this helper — made the route's `NaN !== total` check
 * reject EVERY callback, so a real, valid payment could never confirm.
 *
 * The separator is accepted ONLY in the one unambiguous ASCII form
 * `\d{1,3}(,\d{3})+` (e.g. 1,000 / 12,345,678.90). Anything ambiguous or
 * locale-specific is REJECTED (returns null) rather than guessed:
 *   • "1,23,750"   (South-Asian grouping — ambiguous)      -> null
 *   • "1.000,0"    (European decimal comma)                -> null
 *   • "Rs. 1000"   (unit prefix)                           -> null
 *   • ""/"abc"/"-100"/"1 000"/"1,000."                     -> null
 *
 * NOTE: it is NOT confirmed that eSewa emits the comma form on a real callback
 * — that can only be settled with a live sandbox run. This helper makes the
 * code correct under BOTH shapes without loosening the validation for the rest.
 *
 * @returns {number|null} the numeric amount, or null if the format is not one
 *   we can accept unambiguously.
 */
function parseEsewaAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Plain integer or decimal: 1234, 1234.5, 0, 80960
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  // Thousands-separated (strict ASCII grouping only): 1,000 / 12,345,678.90
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  return null;
}

/** Build the signed form fields the browser must POST to eSewa. */
function esewaStart(order) {
  const cfg = esewaConfig();
  if (!cfg.productCode || !cfg.secret) {
    return { ok: false, reason: 'not-configured', provider: 'esewa', message: 'eSewa product code / secret are not configured.' };
  }
  const base = publicBaseUrl();
  if (!base) {
    return { ok: false, reason: 'not-configured', provider: 'esewa', message: 'PUBLIC_BASE_URL is not configured.' };
  }
  const amount = String(order.total);
  const uuid = order.reference;
  const message = `total_amount=${amount},transaction_uuid=${uuid},product_code=${cfg.productCode}`;
  const signature = esewaSignature(message, cfg.secret);

  // The return URLs MUST NOT carry a query string of their own.
  //
  // eSewa redirects the browser back to `success_url?data=<base64>` (appending
  // with a literal '?'). If success_url already had "?ref=..&status=..", the
  // browser would parse the result as
  //     status = "esewa-success?data=eyJ..."
  // and `data` would be LOST — so the signed response could never be verified.
  // Keeping the URLs clean means "order.html?data=..." parses correctly, and
  // the order reference is recovered from the decoded `data` blob (which
  // contains transaction_uuid) or from sessionStorage as a fallback.
  const cleanReturn = `${base}/order.html`;
  return {
    ok: true,
    provider: 'esewa',
    env: paymentEnv(),
    mode: 'form-post',
    action: `${cfg.base}/api/epay/main/v2/form`,
    fields: {
      amount,
      tax_amount: '0',
      total_amount: amount,
      transaction_uuid: uuid,
      product_code: cfg.productCode,
      product_service_charge: '0',
      product_delivery_charge: '0',
      success_url: cleanReturn,
      failure_url: cleanReturn,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
      signature
    }
  };
}

/**
 * Ask eSewa's own server whether a transaction succeeded.
 * This is the independent check that does not depend on anything the browser
 * sent: it re-queries the gateway with the merchant's product code.
 * Returns { ok, status, amount, reference, providerRef } — `ok` means the call
 * itself worked; callers must still inspect `status`.
 */
async function esewaTransactionStatus(reference, amount) {
  const cfg = esewaConfig();
  if (!cfg.productCode) return { ok: false, reason: 'not-configured' };
  const url = `${cfg.base}/api/epay/transaction/status/` +
    `?product_code=${encodeURIComponent(cfg.productCode)}` +
    `&total_amount=${encodeURIComponent(String(amount))}` +
    `&transaction_uuid=${encodeURIComponent(String(reference))}`;
  const res = await fetchJson(url, { method: 'GET' });
  if (!res.ok) return { ok: false, reason: res.error || 'status-api-error', status: res.status, payload: res.data };
  return {
    ok: true,
    status: String(res.data.status || ''),
    // The status API returns a JSON number, but parse defensively so a
    // string form ("1,000.0") cannot silently become NaN.
    total_amount: parseEsewaAmount(res.data.total_amount),
    reference: String(res.data.transaction_uuid || reference),
    providerRef: String(res.data.ref_id || res.data.transaction_code || '')
  };
}

/**
 * Verify an eSewa success callback.
 *
 * Two independent checks must both pass:
 *   1. the returned JSON's HMAC matches the merchant secret, and
 *   2. the gateway's own transaction-status API reports status === COMPLETE
 *      with the expected amount.
 *
 * A forged callback that did not know the secret fails step 1; a genuine but
 * non-complete transaction (CANCELED/PENDING) fails step 2. `paid` is set ONLY
 * when both pass — the previous version never set `paid` at all, so a real
 * success could never confirm an order.
 */
async function esewaVerify(encodedData, order) {
  const cfg = esewaConfig();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(encodedData || ''), 'base64').toString('utf8'));
  } catch (_e) {
    return { ok: false, reason: 'bad-payload' };
  }
  if (!cfg.secret) return { ok: false, reason: 'not-configured', payload };

  // ── Check 1: signature ──
  const signedNames = String(payload.signed_field_names || 'total_amount,transaction_uuid,product_code')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const message = signedNames.map((f) => `${f}=${payload[f]}`).join(',');
  const expected = esewaSignature(message, cfg.secret);
  if (!safeEqual(expected, String(payload.signature || ''))) {
    return { ok: false, reason: 'bad-signature', payload };
  }

  const reference = String(payload.transaction_uuid || '');
  const amount = parseEsewaAmount(payload.total_amount);
  const status = String(payload.status || '').toUpperCase();

  // ── Signature already PASSED above (checked against the raw strings). ──
  // Now enforce the amount format. A malformed/absent amount (null) must never
  // be treated as a match — return not-ok so the route marks the order failed.
  if (amount === null) {
    return { ok: false, reason: 'bad-amount', reference, amount, status };
  }

  // A signed callback can still describe a non-success state.
  if (status && status !== 'COMPLETE') {
    return { ok: true, provider: 'esewa', paid: false, reason: 'status-' + status.toLowerCase(), reference, amount, status };
  }

  // ── Check 2: the gateway's own view of the transaction ──
  // Only meaningful once we know which order/reference we are reconciling.
  if (order) {
    const st = await esewaTransactionStatus(reference || order.reference, order.total);
    if (st.ok) {
      const stStatus = String(st.status || '').toUpperCase();
      if (stStatus !== 'COMPLETE') {
        return { ok: true, provider: 'esewa', paid: false, reason: 'status-api-' + (stStatus.toLowerCase() || 'unknown'), reference, amount, status: stStatus };
      }
    } else if (st.reason && st.reason !== 'not-configured') {
      // Could not independently confirm — do NOT claim paid. The admin can
      // reconcile manually; a false "paid" is worse than a delayed one.
      return { ok: false, reason: 'status-api-unavailable', reference, amount, status };
    }
  }

  return {
    ok: true,
    provider: 'esewa',
    paid: true,
    reference,
    amount,
    providerRef: String(payload.transaction_code || ''),
    status: 'COMPLETE'
  };
}

/* ── Khalti ePayment v2 ────────────────────────────────────────────────────
   Sandbox host    : https://dev.khalti.com/api/v2
   Production host : https://khalti.com/api/v2
   The previous default ("a.khalti.com") is not a documented endpoint — with
   real keys every call would have failed. The host is now chosen by
   PAYMENT_ENV and nothing else.

   Flow: POST /epayment/initiate/ (→ pidx + payment_url), then the browser
   returns and the server confirms with POST /epayment/lookup/ { pidx }. */

function khaltiConfig() {
  const prod = isProduction();
  return {
    secret: String(process.env.KHALTI_SECRET_KEY || '').trim(),
    base: String(
      process.env.KHALTI_BASE_URL || (prod ? 'https://khalti.com/api/v2' : 'https://dev.khalti.com/api/v2')
    ).replace(/\/+$/, '')
  };
}

/** Khalti expects the amount in paisa (rupees × 100), as an integer string/int. */
function toPaisa(rupees) {
  return Math.round(Number(rupees) * 100);
}

/** Ask Khalti to start a payment. Returns the redirect URL + pidx. */
async function khaltiStart(order) {
  const cfg = khaltiConfig();
  if (!cfg.secret) {
    return { ok: false, reason: 'not-configured', provider: 'khalti', message: 'Khalti secret key is not configured.' };
  }
  const base = publicBaseUrl();
  if (!base) {
    return { ok: false, reason: 'not-configured', provider: 'khalti', message: 'PUBLIC_BASE_URL is not configured.' };
  }
  const body = {
    return_url: `${base}/order.html?ref=${encodeURIComponent(order.reference)}&status=khalti-return`,
    website_url: base,
    amount: toPaisa(order.total),
    purchase_order_id: order.reference,
    purchase_order_name: `Himalayan Voyage order ${order.reference}`,
    customer_info: {
      name: order.customer_name || 'Guest',
      email: order.customer_email || '',
      phone: order.customer_phone || ''
    }
  };
  const res = await fetchJson(`${cfg.base}/epayment/initiate/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${cfg.secret}` },
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.data.pidx) {
    return {
      ok: false, reason: 'provider-error', provider: 'khalti', status: res.status,
      message: res.data.detail || res.data.error_key || res.data.raw || `Khalti initiate failed (${res.status})`
    };
  }
  return { ok: true, provider: 'khalti', env: paymentEnv(), mode: 'redirect', redirectUrl: res.data.payment_url, pidx: res.data.pidx };
}

/**
 * Confirm a Khalti payment by pidx through the server-to-server lookup.
 * `paid` is true only for a Completed transaction.
 */
async function khaltiVerify(pidx) {
  const cfg = khaltiConfig();
  if (!cfg.secret) return { ok: false, reason: 'not-configured' };
  if (!pidx) return { ok: false, reason: 'missing-pidx' };
  const res = await fetchJson(`${cfg.base}/epayment/lookup/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${cfg.secret}` },
    body: JSON.stringify({ pidx })
  });
  if (!res.ok) return { ok: false, reason: res.error || 'provider-error', status: res.status, payload: res.data };
  const status = String(res.data.status || '');
  const paid = ['Completed', 'COMPLETED'].includes(status);
  return {
    ok: true,
    provider: 'khalti',
    paid,
    reason: paid ? undefined : 'status-' + status.toLowerCase(),
    reference: String(res.data.purchase_order_id || ''),
    amount: Number(res.data.total_amount) / 100, // paisa -> rupees
    providerRef: String(res.data.transaction_id || pidx),
    status
  };
}

/* ── Mock provider (development only; hard-blocked in production) ─────────── */

function mockStart(order) {
  if (!mockAllowed()) {
    return { ok: false, reason: 'mock-disabled', provider: 'mock', message: 'Test payments are disabled on this environment.' };
  }
  const base = publicBaseUrl() || 'http://127.0.0.1';
  const ts = Date.now();
  const sig = esewaSignature(`${order.reference}:${order.total}:${ts}`, 'mock-secret');
  return {
    ok: true,
    provider: 'mock',
    env: paymentEnv(),
    mode: 'redirect',
    redirectUrl: `${base}/order.html?ref=${encodeURIComponent(order.reference)}&status=paid&mock_sig=${encodeURIComponent(sig)}&mock_ts=${ts}`
  };
}

function mockVerify(reference, total, signature, ts) {
  if (!mockAllowed()) return { ok: false, reason: 'mock-disabled' };
  const expected = esewaSignature(`${reference}:${total}:${ts}`, 'mock-secret');
  if (!safeEqual(expected, String(signature || ''))) return { ok: false, reason: 'bad-signature' };
  return { ok: true, provider: 'mock', paid: true, reference, amount: Number(total), providerRef: 'MOCK-' + String(ts).slice(-8), status: 'COMPLETED' };
}

/* ── Public API ────────────────────────────────────────────────────────── */

/** Providers a customer may pick, with an honest configured/live flag. */
function listProviders() {
  const esewaReady = Boolean(esewaConfig().productCode && esewaConfig().secret && publicBaseUrl());
  const khaltiReady = Boolean(khaltiConfig().secret && publicBaseUrl());
  const mockReady = mockAllowed();
  const items = [
    { id: 'esewa', label: 'eSewa', configured: esewaReady, live: false, env: paymentEnv(), note: PROVIDER_STATUS.esewa.note },
    { id: 'khalti', label: 'Khalti', configured: khaltiReady, live: false, env: paymentEnv(), note: PROVIDER_STATUS.khalti.note },
    { id: 'bank', label: 'Bank transfer', configured: true, live: false, note: PROVIDER_STATUS.bank.note }
  ];
  // The development provider is only advertised where it is actually usable.
  if (mockReady) {
    items.unshift({ id: 'mock', label: 'Test payment (sandbox)', configured: true, live: false, env: paymentEnv(), note: PROVIDER_STATUS.mock.note });
  }
  return items;
}

/** Is a given method usable on this environment? */
function methodAllowed(method) {
  if (method === 'mock') return mockAllowed();
  return PAYMENT_METHODS.includes(method);
}

/**
 * Begin a payment for an order. Returns a provider-specific instruction:
 *   { mode: 'redirect', redirectUrl } | { mode: 'form-post', action, fields }
 *   | { mode: 'manual' }  (bank transfer)
 * Never throws for a missing config — the caller turns `ok:false` into a 400.
 */
async function startPayment(method, order) {
  if (!methodAllowed(method)) {
    return { ok: false, reason: 'method-disabled', provider: method, message: 'That payment method is not available on this environment.' };
  }
  switch (method) {
    case 'esewa': return esewaStart(order);
    case 'khalti': return khaltiStart(order);
    case 'bank': return { ok: true, provider: 'bank', env: paymentEnv(), mode: 'manual', message: 'Transfer to the account shown, then wait for confirmation.' };
    case 'mock':
    default: return mockStart(order);
  }
}

/**
 * Verify a payment result. The caller passes ONLY the provider's returned
 * evidence; the amount is cross-checked against the order inside the route.
 * `paid:true` is a statement that the GATEWAY confirmed payment server-side.
 */
async function verifyPayment(method, order, evidence = {}) {
  if (!methodAllowed(method)) return { ok: false, reason: 'method-disabled' };
  switch (method) {
    case 'esewa': return esewaVerify(evidence.data, order);
    case 'khalti': return khaltiVerify(evidence.pidx);
    case 'mock': return mockVerify(order.reference, order.total, evidence.mock_sig, evidence.mock_ts);
    case 'bank': return { ok: true, provider: 'bank', paid: false, reason: 'manual-confirmation-required' };
    default: return { ok: false, reason: 'unknown-method' };
  }
}

/** Non-secret status for /api/health (helps an operator see what is wired). */
function status() {
  const esewa = esewaConfig();
  const khalti = khaltiConfig();
  return {
    env: paymentEnv(),
    mockAllowed: mockAllowed(),
    publicBaseUrlSet: Boolean(publicBaseUrl()),
    esewa: { configured: Boolean(esewa.productCode && esewa.secret), host: esewa.base },
    khalti: { configured: Boolean(khalti.secret), host: khalti.base }
  };
}

module.exports = {
  PAYMENT_METHODS,
  PROVIDER_STATUS,
  listProviders,
  methodAllowed,
  startPayment,
  verifyPayment,
  status,
  publicBaseUrl,
  paymentEnv,
  isProduction,
  mockAllowed,
  toPaisa,
  // exported for tests
  esewaSignature,
  parseEsewaAmount,
  esewaVerify,
  esewaTransactionStatus,
  khaltiVerify,
  mockVerify
};
