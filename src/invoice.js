'use strict';

/**
 * Order invoice / receipt PDF generator.
 *
 * Reuses the SAME visual language as scripts/generate-docs.js (branded header
 * band, muted footer, key/value facts block) so an invoice looks like every
 * other document the agency produces. Streams straight into the HTTP response —
 * nothing is written to disk, so there is no temp file to clean up and no shared
 * state between concurrent requests.
 *
 * All figures come from the stored order (server-computed). The generator never
 * reads anything the client sent.
 *
 * LAYOUT CONTRACT (why this file is careful about the footer)
 * ──────────────────────────────────────────────────────────
 * PDFKit starts a new page the moment ANY text's bottom edge would reach past
 * `page.height - margin`. The previous footer placed its text at
 * `height - 62 + 8 = height - 54` — EXACTLY the bottom-margin boundary — and the
 * address line wraps to two lines, so its bottom (≈ height - 28) fell outside
 * the printable area and PDFKit appended an almost-empty second page to every
 * one-item invoice.
 *
 * Therefore:
 *   • every footer/note string is positioned from the bottom edge UP, so its
 *     whole block stays inside `[margin, height - margin]`;
 *   • the single-line footer uses `lineBreak: false` so it can never wrap onto
 *     a second line (which is what pushed it past the boundary);
 *   • the totals block (and the TEST banner) are measured before being drawn,
 *     and a page break is requested EXPLICITLY when they would not fit — rather
 *     than letting PDFKit add a page mid-draw and leave a blank remainder.
 */

const PDFDocument = require('pdfkit');

const BRAND = '#0b4f9e';
const INK = '#14213d';
const MUTED = '#6b7a90';
const LINE = '#e4e9f2';
const OK = '#12805c';
const TEST_FILL = '#fff4e0';
const TEST_INK = '#8a4b00';

const MARGIN = 54;

/** The one footer line; kept short so it never wraps (see lineBreak below). */
const FOOTER_LINE = '+977 9800000000  \u00b7  hello@himalayanvoyage.test  \u00b7  Lakeside Road, Pokhara, Nepal';

const COMPANY = {
  name: 'Himalayan Voyage Nepal',
  tagline: 'Discover Nepal & Explore the World',
  phone: '+977 9800000000',
  email: 'hello@himalayanvoyage.test',
  address: 'Lakeside Road, Pokhara, Nepal',
  pan: 'PAN: 601234567'
};

/** Rupees with thousands separators, matching the site's money() format. */
function rs(value) {
  return 'Rs. ' + (Number(value) || 0).toLocaleString('en-IN');
}

/**
 * Is this order backed by the offline test provider (or otherwise not real
 * money)? Test payments must never be presented as received funds.
 */
function isTestPayment(order) {
  const method = String((order && order.payment_method) || '').toLowerCase();
  if (method === 'mock') return true;
  const ref = String((order && order.payment_ref) || '');
  // The mock provider stamps references as MOCK-xxxxxxxx.
  if (/^MOCK-/i.test(ref)) return true;
  return false;
}

function header(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 108).fill(BRAND);
  doc.fillColor('#ffffff').fontSize(19).font('Helvetica-Bold')
    .text(COMPANY.name, MARGIN, 30, { width: doc.page.width - MARGIN * 2, lineBreak: false });
  doc.fontSize(9.5).font('Helvetica').fillColor('#cfe0f6')
    .text(COMPANY.tagline, MARGIN, 56, { lineBreak: false });
  doc.fillColor('#ffd08a').fontSize(13).font('Helvetica-Bold')
    .text(title, MARGIN, 76, { lineBreak: false });
  if (subtitle) {
    doc.fillColor('#cfe0f6').fontSize(9).font('Helvetica')
      .text(subtitle, MARGIN, 92, { lineBreak: false });
  }
  doc.fillColor(INK);
  doc.y = 140;
}

/**
 * Footer drawn entirely INSIDE the printable area of the CURRENT page.
 *
 * Positioned from the bottom edge so the address line + rule + note never cross
 * `height - margin`; `lineBreak:false` guarantees a single line even if the text
 * were longer than expected.
 */
function footer(doc, { provisional = false } = {}) {
  const bottom = doc.page.height - MARGIN;          // printable bottom edge
  const textY = bottom - 10;                        // footer text baseline area
  const ruleY = textY - 7;

  // A provisional note (unpaid order) is placed ABOVE the rule, still inside
  // the printable area, so it can never push content past the bottom edge.
  if (provisional) {
    doc.fillColor(MUTED).fontSize(8).font('Helvetica')
      .text('This invoice is provisional until payment is confirmed by our team.',
        MARGIN, ruleY - 18, { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false });
  }

  doc.moveTo(MARGIN, ruleY).lineTo(doc.page.width - MARGIN, ruleY)
    .strokeColor(LINE).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(7.5).font('Helvetica')
    .text(FOOTER_LINE, MARGIN, textY,
      { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false });
}

/** Stamp the footer onto EVERY buffered page (a multi-page invoice must not lose it). */
function stampFooterOnAllPages(doc, opts) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    footer(doc, opts);
  }
  doc.flushPages();
}
// NOTE: COMPANY.pan is intentionally shown in the facts block (not the footer)
// so the footer stays one guaranteed single line.

/** One labelled key/value pair per line, two columns. */
function facts(doc, rows) {
  const startY = doc.y;
  const colW = (doc.page.width - MARGIN * 2) / 2;
  rows.forEach((row, i) => {
    const col = i % 2;
    const lineY = startY + Math.floor(i / 2) * 30;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED)
      .text(String(row[0]).toUpperCase(), MARGIN + col * colW, lineY, { width: colW - 12, lineBreak: false });
    doc.fontSize(10).font('Helvetica').fillColor(INK)
      .text(String(row[1] == null ? '' : row[1]), MARGIN + col * colW, lineY + 12, { width: colW - 12, lineBreak: false });
  });
  doc.y = startY + Math.ceil(rows.length / 2) * 30 + 8;
}

/** Draw the "TEST PAYMENT" banner. Returns the height it consumed. */
function testBanner(doc) {
  const w = doc.page.width - MARGIN * 2;
  const x = MARGIN;
  const y = doc.y;
  const h = 30;
  doc.rect(x, y, w, h).fill(TEST_FILL);
  doc.rect(x, y, 4, h).fill('#ff8a00');
  doc.fillColor(TEST_INK).fontSize(9.5).font('Helvetica-Bold')
    .text('TEST PAYMENT \u2014 no real funds were received', x + 12, y + 6,
      { width: w - 24, lineBreak: false });
  doc.fontSize(7.5).font('Helvetica')
    .text('This document is a system-generated test receipt and is NOT proof of payment.',
      x + 12, y + 18, { width: w - 24, lineBreak: false });
  doc.fillColor(INK);
  doc.y = y + h + 8;
  return h + 8;
}

/**
 * Write an order invoice to a writable stream (an HTTP response, a file, etc.).
 * Returns a promise that resolves once the document has been flushed.
 *
 * @param {object} order a full order (with `items`) as returned by commerce.js
 * @param {NodeJS.WritableStream} stream destination
 */
function writeInvoice(order, stream) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      // Buffer pages so the footer can be stamped onto EVERY page at the end.
      // Without this a multi-page invoice would show the footer only on the
      // last page (the pages are streamed out as they are finished).
      bufferPages: true,
      info: { Author: COMPANY.name, Title: `Invoice ${order.reference}` }
    });
    doc.on('error', reject);
    stream.on('error', reject);
    doc.on('end', resolve);
    doc.pipe(stream);

    header(doc, 'INVOICE / RECEIPT', 'Thank you for travelling with us');

    const paid = order.payment_status === 'paid';
    const testPayment = isTestPayment(order);
    // A mock/test order is never "really" paid. Present it as such everywhere.
    const statusLabel = testPayment
      ? (paid ? 'TEST PAID' : 'TEST \u2014 UNPAID')
      : (paid ? 'PAID' : String(order.payment_status || 'unpaid').toUpperCase());

    facts(doc, [
      ['Invoice No.', order.reference],
      ['Date', order.created_at],
      ['Customer', order.customer_name || '\u2014'],
      ['Email', order.customer_email || '\u2014'],
      ['Phone', order.customer_phone || '\u2014'],
      ['Travel date', order.travel_date || 'To be confirmed'],
      ['Payment status', statusLabel],
      ['Payment method', testPayment ? 'Test (sandbox)' : (order.payment_method || '\u2014')]
    ]);

    // Explicit TEST banner sits directly under the facts, before the items.
    if (testPayment) testBanner(doc);

    // ── Items table ────────────────────────────────────────────────────────
    const tableTop = doc.y + 8;
    const cols = [
      { label: 'Package', x: MARGIN, w: 300 },
      { label: 'Qty', x: 360, w: 50, align: 'right' },
      { label: 'Unit', x: 414, w: 90, align: 'right' },
      { label: 'Amount', x: 508, w: 84, align: 'right' }
    ];
    doc.rect(MARGIN, tableTop - 4, doc.page.width - MARGIN * 2, 22).fill('#f4f7fc');
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold');
    cols.forEach((c) => doc.text(c.label.toUpperCase(), c.x, tableTop, { width: c.w, align: c.align || 'left', lineBreak: false }));

    const ROW_H = 22;
    // Leave room for the totals block + footer on the SAME page.
    const totalsHeight = 18 + (Number(order.discount_total) > 0 ? 18 : 0) + 24 + (paid ? 18 : 0);
    const limit = doc.page.height - MARGIN - 30 - totalsHeight; // 30 = footer band
    let y = tableTop + 24;
    doc.fillColor(INK).font('Helvetica').fontSize(9.5);
    (order.items || []).forEach((it) => {
      if (y > limit) { doc.addPage(); y = MARGIN + 30; }
      doc.font('Helvetica').fillColor(INK).text(String(it.title || ''), MARGIN, y, { width: 300, lineBreak: false });
      doc.text(String(it.qty), 360, y, { width: 50, align: 'right', lineBreak: false });
      doc.text(rs(it.unit_price), 414, y, { width: 90, align: 'right', lineBreak: false });
      doc.text(rs(it.line_total), 508, y, { width: 84, align: 'right', lineBreak: false });
      y += ROW_H;
      doc.moveTo(MARGIN, y - 6).lineTo(doc.page.width - MARGIN, y - 6).strokeColor(LINE).lineWidth(0.5).stroke();
    });

    // ── Totals block (explicit break if it would not fit) ──────────────────
    const totalsTop = y + 6;
    if (totalsTop + totalsHeight > doc.page.height - MARGIN - 30) {
      doc.addPage();
      y = MARGIN + 30;
    } else {
      y = totalsTop;
    }
    const totalRow = (label, value, opts = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.big ? 12 : 10)
        .fillColor(opts.color || INK);
      doc.text(label, 360, y, { width: 144, align: 'right', lineBreak: false });
      doc.text(value, 508, y, { width: 84, align: 'right', lineBreak: false });
      y += opts.big ? 24 : 18;
    };
    totalRow('Subtotal', rs(order.subtotal));
    if (Number(order.discount_total) > 0) totalRow('Discount', '\u2212 ' + rs(order.discount_total), { color: OK });
    totalRow(testPayment ? 'Total (test)' : 'Total', rs(order.total), { bold: true, big: true });
    if (paid && !testPayment) totalRow('Paid', rs(order.total), { color: OK });

    // Stamp the footer onto every buffered page, then flush them in order.
    stampFooterOnAllPages(doc, { provisional: !paid });
    doc.end();
  });
}

module.exports = { writeInvoice, COMPANY, isTestPayment, FOOTER_LINE };
