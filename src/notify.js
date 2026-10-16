'use strict';

/**
 * Optional booking notification, delivered by EMAIL.
 *
 * Design goals:
 *   • Zero required dependency — works with a plain SMTP relay over the core
 *     `net`/`tls` modules, OR a HTTP email API (Resend/SendGrid) if its key is
 *     present. No package is installed to send mail.
 *   • Graceful when nothing is configured: `notifyBooking()` becomes a no-op
 *     that reports `{ sent:false, reason:'not-configured' }`. It NEVER throws
 *     and NEVER blocks the booking response beyond a short best-effort await.
 *   • Secrets stay in the environment (or the OpenOS credential vault, injected
 *     into env by scripts/notify-setup.js). Nothing is ever logged in the clear.
 *
 * Configure ONE of these (all optional):
 *   HTTP API : RESEND_API_KEY  (and NOTIFY_FROM, NOTIFY_TO)
 *   SMTP     : SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_FROM, NOTIFY_TO
 *
 * When no provider is configured the module reports `configured:false` so the
 * admin UI / health output can say so honestly instead of pretending mail works.
 */

const net = require('net');

const FROM = () => process.env.NOTIFY_FROM || process.env.SMTP_FROM || '';
const TO = () => process.env.NOTIFY_TO || process.env.ADMIN_EMAIL || '';

/** Which delivery method, if any, is configured. Never prints secret values. */
function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SENDGRID_API_KEY) return 'sendgrid';
  if (process.env.SMTP_HOST && process.env.SMTP_PORT) return 'smtp';
  return null;
}

function configured() {
  return Boolean(provider() && FROM() && TO());
}

/** Human-readable booking summary (no HTML injection: values are escaped). */
function bookingLines(b) {
  const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return [
    `New booking enquiry #${b.id}`,
    `Package : ${esc(b.package_title || b.package_slug || '(none)')}`,
    `Name    : ${esc(b.name)}`,
    `Email   : ${esc(b.email)}`,
    `Phone   : ${esc(b.phone || '(none)')}`,
    `Travellers: ${esc(b.travellers)}`,
    `Travel date: ${esc(b.travel_date || '(not set)')}`,
    `Message : ${esc(b.message || '(none)')}`
  ];
}

/** Send via a HTTP email API (Resend or SendGrid). */
async function sendViaApi(b) {
  return sendViaApiRaw({ to: TO(), subject: `New booking enquiry #${b.id}`, text: bookingLines(b).join('\n') });
}

/** Low-level HTTP email send (Resend/SendGrid) for arbitrary subject/body. */
async function sendViaApiRaw({ to, subject, text }) {
  const payload = JSON.stringify({ from: FROM(), to: [to], subject, text });

  const isResend = process.env.RESEND_API_KEY;
  const host = isResend ? 'api.resend.com' : 'api.sendgrid.com';
  const path = isResend ? '/emails' : '/v3/mail/send';
  const auth = isResend ? `Bearer ${process.env.RESEND_API_KEY}` : `Bearer ${process.env.SENDGRID_API_KEY}`;

  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: host, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', () => resolve({ sent: false, status: 0 }));
    req.setTimeout(8000, () => req.destroy());
    req.write(payload);
    req.end();
  });
}

/** Minimal SMTP conversation over net/tls — no dependency. */
function sendViaSmtp(b) {
  return sendViaSmtpRaw({ to: TO(), subject: `New booking enquiry #${b.id}`, text: bookingLines(b).join('\r\n') });
}

/** Minimal SMTP conversation over net/tls for an arbitrary message. */
function sendViaSmtpRaw({ to, subject, text }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = FROM();
  const body = String(text || '');
  const message = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body
  ].join('\r\n');

  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let stage = 0;
    let buffer = '';
    const finish = (sent) => { try { socket.end(); } catch (_e) {} resolve({ sent }); };
    socket.setTimeout(10000, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n')) return;
      const code = buffer.slice(0, 3);
      buffer = '';
      // A tiny handshake: EHLO -> AUTH -> MAIL/RCPT/DATA. Best-effort only; any
      // non-2xx/3xx response ends the attempt without throwing.
      if (stage === 0 && code.startsWith('220')) { socket.write(`EHLO ${host}\r\n`); stage = 1; }
      else if (stage === 1) {
        if (code.startsWith('250') || code.startsWith('220')) {
          if (user && pass) { socket.write('AUTH LOGIN\r\n'); stage = 2; }
          else { socket.write(`MAIL FROM:<${from}>\r\n`); stage = 5; }
        } else { finish(false); }
      } else if (stage === 2 && code === '334') { socket.write(Buffer.from(user).toString('base64') + '\r\n'); stage = 3; }
      else if (stage === 3 && code === '334') { socket.write(Buffer.from(pass).toString('base64') + '\r\n'); stage = 4; }
      else if (stage === 4 && code.startsWith('235')) { socket.write(`MAIL FROM:<${from}>\r\n`); stage = 5; }
      else if (stage === 5 && code.startsWith('250')) { socket.write(`RCPT TO:<${to}>\r\n`); stage = 6; }
      else if (stage === 6 && code.startsWith('250')) { socket.write('DATA\r\n'); stage = 7; }
      else if (stage === 7 && code.startsWith('354')) { socket.write(message + '\r\n.\r\n'); stage = 8; }
      else if (stage === 8 && code.startsWith('250')) { socket.write('QUIT\r\n'); finish(true); }
      else { finish(false); }
    });
    socket.on('connect', () => {});
  });
}

/**
 * Notify an admin of a new booking. Never throws; always resolves to a status
 * object so the caller can log the outcome without risking the request.
 */
async function notifyBooking(booking) {
  if (!configured()) return { sent: false, reason: 'not-configured', provider: provider() };
  try {
    const b = Object.assign({ id: '?', travellers: 1 }, booking);
    const p = provider();
    const result = p === 'smtp' ? await sendViaSmtp(b) : await sendViaApi(b);
    return Object.assign({ provider: p }, result);
  } catch (err) {
    return { sent: false, reason: 'error', detail: err.message };
  }
}

/** Human-readable order summary lines for the customer's receipt email. */
function orderLines(o) {
  const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const rows = (o.items || []).map((it) =>
    `  \u2022 ${esc(it.title)}  x${it.qty}  =  Rs. ${Number(it.line_total || 0).toLocaleString('en-IN')}`);
  return [
    `Thank you for your booking, ${esc(o.customer_name || 'traveller')}!`,
    '',
    `Order reference : ${esc(o.reference)}`,
    `Travel date     : ${esc(o.travel_date || 'To be confirmed')}`,
    '',
    'Your packages:',
    ...(rows.length ? rows : ['  (none)']),
    '',
    `Subtotal        : Rs. ${Number(o.subtotal || 0).toLocaleString('en-IN')}`,
    `Discount        : - Rs. ${Number(o.discount_total || 0).toLocaleString('en-IN')}`,
    `TOTAL           : Rs. ${Number(o.total || 0).toLocaleString('en-IN')}`,
    `Payment         : ${esc(String(o.payment_status || 'unpaid').toUpperCase())}`,
    '',
    `View / pay online : ${publicOrderUrl(o.reference)}`,
    '',
    'Our team will contact you to confirm the details.',
    'Himalayan Voyage Nepal'
  ];
}

/** Absolute order URL, derived from a configured public base or the admin URL. */
function publicOrderUrl(reference) {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return (base || '') + '/order.html?ref=' + encodeURIComponent(String(reference || ''));
}

/** Send a plain email through whichever provider is configured. Never throws. */
async function sendMail({ to, subject, text }) {
  if (!configured() || !to) return { sent: false, reason: 'not-configured' };
  try {
    const p = provider();
    if (p === 'smtp') {
      // Reuse the SMTP conversation with an explicit recipient/subject.
      return await sendViaSmtpRaw({ to, subject, text });
    }
    return await sendViaApiRaw({ to, subject, text });
  } catch (err) {
    return { sent: false, reason: 'error', detail: err.message };
  }
}

/** Email a customer their order confirmation/receipt. Best-effort. */
async function notifyCustomer(order) {
  if (!configured()) return { sent: false, reason: 'not-configured', provider: provider() };
  return sendMail({
    to: order.customer_email,
    subject: `Your Himalayan Voyage booking ${order.reference}`,
    text: orderLines(order).join('\n')
  });
}

/** Status for /api/health and the admin UI — never reveals secret values. */
function status() {
  return { configured: configured(), provider: provider(), toSet: Boolean(TO()), fromSet: Boolean(FROM()) };
}

module.exports = { notifyBooking, notifyCustomer, sendMail, status, configured, provider };
