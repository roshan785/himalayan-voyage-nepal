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
 * 3. "MOCK" IS THE DEFAULT. It produces a real, verifiable payment flow with no
 *    external dependency, which is exactly what the automated tests exercise.
 *    Live eSewa/Khalti adapters are implemented from their documented APIs but
 *    are NOT claimed to work until they are run against real sandbox keys —
 *    see PROVIDER_STATUS below for an honest per-provider statement.
 *
 * PROVIDERS
 *   mock    — offline, always available. Simulates a redirect + a signed callback.
 *   esewa   — eSewa ePay v2 (form POST + HMAC-SHA256 signature verification).
 *   khalti  — Khalti ePayment v2 (server-initiated initiate + lookup verify).
 *
 * SECURITY
 *   • Amounts are ALWAYS recomputed server-side from the order before a payment
 *     is started or verified — `verifySignature` never trusts the posted amount.
 *   • The signature scheme is constant-time compared to avoid timing leaks.
 *   • The callback URL is built from a configured PUBLIC_BASE_URL, never from a
 *     client-supplied host (open-redirect / host-header-injection defence).
 */

const crypto = require('crypto');

const PAYMENT_METHODS = ['mock', 'esewa', 'khalti', 'bank'];

/** Honest status per provider — shown by /api/payments/providers. */
const PROVIDER_STATUS = {
  mock: { live: false, note: 'Offline test provider — always available, no real money moves.' },
  esewa: { live: false, note: 'eSewa ePay v2 adapter implemented from public docs; requires ES test/prod keys + a verification run against eSewa sandbox before it is production-proven.' },
  khalti: { live: false, note: 'Khalti ePayment v2 adapter implemented from public docs; requires KHALTI_SECRET_KEY + a verification run against Khalti sandbox before it is production-proven.' },
  bank: { live: false, note: 'Manual bank transfer — the order is marked awaiting-confirmation and an admin marks it paid.' }
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

/* ── eSewa ePay v2 ─────────────────────────────────────────────────────────
   Signature: base64(HMAC-SHA256(message, secret)) where message is
   "total_amount=..,transaction_uuid=..,product_code=..".
   The success callback is signed the same way over the fields it returns, and
   the returned base64 JSON contains `status`, `total_amount`, `transaction_uuid`. */

function esewaConfig() {
  return {
    productCode: String(process.env.ESEWA_PRODUCT_CODE || '').trim(),
    secret: String(process.env.ESEWA_SECRET_KEY || '').trim(),
    base: String(process.env.ESEWA_BASE_URL || 'https://rc-epay.esewa.com.np').replace(/\/+$/, '')
  };
}

function esewaSignature(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/** Build the signed form fields the browser must POST to eSewa. */
function esewaStart(order) {
  const cfg = esewaConfig();
  if (!cfg.productCode || !cfg.secret) {
    return { ok: false, reason: 'not-configured', provider: 'esewa', message: 'eSewa keys are not configured.' };
  }
  const base = publicBaseUrl();
  if (!base) {
    return { ok: false, reason: 'not-configured', provider: 'esewa', message: 'PUBLIC_BASE_URL is not configured.' };
  }
  const amount = String(order.total);
  const uuid = order.reference;
  const message = `total_amount=${amount},transaction_uuid=${uuid},product_code=${cfg.productCode}`;
  const signature = esewaSignature(message, cfg.secret);
  return {
    ok: true,
    provider: 'esewa',
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
      success_url: `${base}/order.html?ref=${encodeURIComponent(uuid)}&status=success`,
      failure_url: `${base}/order.html?ref=${encodeURIComponent(uuid)}&status=failure`,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
      signature
    }
  };
}

/**
 * Decode + verify an eSewa success callback.
 * The callback arrives as base64 JSON in `?data=`. We re-derive the signature
 * over the returned signed fields and compare against the returned signature —
 * a forged callback that did not know the secret cannot produce a match.
 */
function esewaVerify(encodedData) {
  const cfg = esewaConfig();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(encodedData || ''), 'base64').toString('utf8'));
  } catch (_e) {
    return { ok: false, reason: 'bad-payload' };
  }
  if (!cfg.secret) return { ok: false, reason: 'not-configured', payload };

  const signedNames = String(payload.signed_field_names || 'total_amount,transaction_uuid,product_code')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const message = signedNames.map((f) => `${f}=${payload[f]}`).join(',');
  const expected = esewaSignature(message, cfg.secret);
  const provided = String(payload.signature || '');
  if (!safeEqual(expected, provided)) return { ok: false, reason: 'bad-signature', payload };

  return {
    ok: true,
    provider: 'esewa',
    reference: String(payload.transaction_uuid || ''),
    amount: Number(payload.total_amount),
    providerRef: String(payload.transaction_code || ''),
    status: String(payload.status || '')
  };
}

/* ── Khalti ePayment v2 ────────────────────────────────────────────────────
   Server-initiated: POST /epayment/initiate/ with an Authorization: Key <secret>.
   Response carries a `pidx`; the browser is redirected to `payment_url`. The
   server then confirms with POST /epayment/lookup/ { pidx }. */

function khaltiConfig() {
  return {
    secret: String(process.env.KHALTI_SECRET_KEY || '').trim(),
    base: String(process.env.KHALTI_BASE_URL || 'https://a.khalti.com/api/v2').replace(/\/+$/, '')
  };
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
    amount: Math.round(Number(order.total) * 100), // Khalti expects paisa
    purchase_order_id: order.reference,
    purchase_order_name: `Himalayan Voyage order ${order.reference}`,
    customer_info: {
      name: order.customer_name || 'Guest',
      email: order.customer_email || '',
      phone: order.customer_phone || ''
    }
  };
  const res = await fetch(`${cfg.base}/epayment/initiate/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${cfg.secret}` },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.pidx) {
    return { ok: false, reason: 'provider-error', provider: 'khalti', status: res.status, message: data.detail || data.error_key || 'Khalti initiate failed' };
  }
  return { ok: true, provider: 'khalti', mode: 'redirect', redirectUrl: data.payment_url, pidx: data.pidx };
}

/** Confirm a Khalti payment by pidx. */
async function khaltiVerify(pidx) {
  const cfg = khaltiConfig();
  if (!cfg.secret) return { ok: false, reason: 'not-configured' };
  const res = await fetch(`${cfg.base}/epayment/lookup/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${cfg.secret}` },
    body: JSON.stringify({ pidx })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: 'provider-error', status: res.status, payload: data };
  const paid = ['Completed', 'COMPLETED'].includes(String(data.status));
  return {
    ok: true,
    provider: 'khalti',
    paid,
    reference: String(data.purchase_order_id || ''),
    amount: Number(data.total_amount) / 100, // back to rupees
    providerRef: String(data.transaction_id || pidx),
    status: String(data.status || '')
  };
}

/* ── Mock provider (default; offline, fully verifiable) ────────────────────
   Simulates the exact shape of a real gateway: `start()` returns a signed
   redirect, and `verify()` checks the signature and the amount against the
   order. This is what the automated tests drive. */

function mockStart(order) {
  const base = publicBaseUrl() || 'http://127.0.0.1';
  const ts = Date.now();
  const sig = esewaSignature(`${order.reference}:${order.total}:${ts}`, 'mock-secret');
  return {
    ok: true,
    provider: 'mock',
    mode: 'redirect',
    redirectUrl: `${base}/order.html?ref=${encodeURIComponent(order.reference)}&status=paid&mock_sig=${encodeURIComponent(sig)}&mock_ts=${ts}`
  };
}

function mockVerify(reference, total, signature, ts) {
  const expected = esewaSignature(`${reference}:${total}:${ts}`, 'mock-secret');
  if (!safeEqual(expected, String(signature || ''))) return { ok: false, reason: 'bad-signature' };
  return { ok: true, provider: 'mock', paid: true, reference, amount: Number(total), providerRef: 'MOCK-' + String(ts).slice(-8), status: 'COMPLETED' };
}

/* ── Public API ────────────────────────────────────────────────────────── */

/** Providers a customer may pick, with an honest configured/live flag. */
function listProviders() {
  const esewaReady = Boolean(esewaConfig().productCode && esewaConfig().secret && publicBaseUrl());
  const khaltiReady = Boolean(khaltiConfig().secret && publicBaseUrl());
  return [
    { id: 'mock', label: 'Test payment (sandbox)', configured: true, live: false, note: PROVIDER_STATUS.mock.note },
    { id: 'esewa', label: 'eSewa', configured: esewaReady, live: false, note: PROVIDER_STATUS.esewa.note },
    { id: 'khalti', label: 'Khalti', configured: khaltiReady, live: false, note: PROVIDER_STATUS.khalti.note },
    { id: 'bank', label: 'Bank transfer', configured: true, live: false, note: PROVIDER_STATUS.bank.note }
  ];
}

/**
 * Begin a payment for an order. Returns a provider-specific instruction:
 *   { mode: 'redirect', redirectUrl } | { mode: 'form-post', action, fields }
 *   | { mode: 'manual' }  (bank transfer)
 * Never throws for a missing config — the caller turns `ok:false` into a 400.
 */
async function startPayment(method, order) {
  switch (method) {
    case 'esewa': return esewaStart(order);
    case 'khalti': return khaltiStart(order);
    case 'bank': return { ok: true, provider: 'bank', mode: 'manual', message: 'Transfer to the account shown, then wait for confirmation.' };
    case 'mock':
    default: return mockStart(order);
  }
}

/**
 * Verify a payment result. The caller passes ONLY the provider's returned
 * evidence; the amount is cross-checked against the order inside the route.
 */
async function verifyPayment(method, order, evidence = {}) {
  switch (method) {
    case 'esewa': return esewaVerify(evidence.data);
    case 'khalti': return khaltiVerify(evidence.pidx);
    case 'mock': return mockVerify(order.reference, order.total, evidence.mock_sig, evidence.mock_ts);
    case 'bank': return { ok: true, provider: 'bank', paid: false, reason: 'manual-confirmation-required' };
    default: return { ok: false, reason: 'unknown-method' };
  }
}

module.exports = {
  PAYMENT_METHODS,
  PROVIDER_STATUS,
  listProviders,
  startPayment,
  verifyPayment,
  publicBaseUrl,
  // exported for tests
  esewaSignature,
  esewaVerify,
  mockVerify
};
