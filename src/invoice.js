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
 */

const PDFDocument = require('pdfkit');

const BRAND = '#0b4f9e';
const INK = '#14213d';
const MUTED = '#6b7a90';
const LINE = '#e4e9f2';
const OK = '#12805c';

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

function header(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 108).fill(BRAND);
  doc.fillColor('#ffffff').fontSize(19).font('Helvetica-Bold')
    .text(COMPANY.name, 54, 30, { width: doc.page.width - 108 });
  doc.fontSize(9.5).font('Helvetica').fillColor('#cfe0f6')
    .text(COMPANY.tagline, 54, 56);
  doc.fillColor('#ffd08a').fontSize(13).font('Helvetica-Bold')
    .text(title, 54, 76);
  if (subtitle) {
    doc.fillColor('#cfe0f6').fontSize(9).font('Helvetica').text(subtitle, 54, 92);
  }
  doc.fillColor(INK);
  doc.y = 140;
}

function footer(doc) {
  const y = doc.page.height - 62;
  doc.moveTo(54, y).lineTo(doc.page.width - 54, y).strokeColor(LINE).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text(`${COMPANY.phone}  \u00b7  ${COMPANY.email}  \u00b7  ${COMPANY.address}  \u00b7  ${COMPANY.pan}`,
      54, y + 8, { width: doc.page.width - 108, align: 'center' });
}

/** One labelled key/value pair per line, two columns. */
function facts(doc, rows) {
  const startY = doc.y;
  const colW = (doc.page.width - 108) / 2;
  rows.forEach((row, i) => {
    const col = i % 2;
    const lineY = startY + Math.floor(i / 2) * 30;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED).text(String(row[0]).toUpperCase(), 54 + col * colW, lineY, { width: colW - 12 });
    doc.fontSize(10).font('Helvetica').fillColor(INK).text(String(row[1] == null ? '' : row[1]), 54 + col * colW, lineY + 12, { width: colW - 12 });
  });
  doc.y = startY + Math.ceil(rows.length / 2) * 30 + 8;
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
    const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Author: COMPANY.name, Title: `Invoice ${order.reference}` } });
    doc.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', resolve);
    doc.pipe(stream);

    header(doc, 'INVOICE / RECEIPT', 'Thank you for travelling with us');

    const paid = order.payment_status === 'paid';
    facts(doc, [
      ['Invoice No.', order.reference],
      ['Date', order.created_at],
      ['Customer', order.customer_name || '\u2014'],
      ['Email', order.customer_email || '\u2014'],
      ['Phone', order.customer_phone || '\u2014'],
      ['Travel date', order.travel_date || 'To be confirmed'],
      ['Payment status', paid ? 'PAID' : String(order.payment_status || 'unpaid').toUpperCase()],
      ['Payment method', order.payment_method || '\u2014']
    ]);

    // Items table
    const tableTop = doc.y + 8;
    const cols = [
      { label: 'Package', x: 54, w: 300 },
      { label: 'Qty', x: 360, w: 50, align: 'right' },
      { label: 'Unit', x: 414, w: 90, align: 'right' },
      { label: 'Amount', x: 508, w: 84, align: 'right' }
    ];
    doc.rect(54, tableTop - 4, doc.page.width - 108, 22).fill('#f4f7fc');
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold');
    cols.forEach((c) => doc.text(c.label.toUpperCase(), c.x, tableTop, { width: c.w, align: c.align || 'left' }));

    let y = tableTop + 24;
    doc.fillColor(INK).font('Helvetica').fontSize(9.5);
    (order.items || []).forEach((it) => {
      if (y > doc.page.height - 140) { doc.addPage(); y = 90; }
      doc.font('Helvetica').fillColor(INK).text(String(it.title || ''), 54, y, { width: 300 });
      doc.text(String(it.qty), 360, y, { width: 50, align: 'right' });
      doc.text(rs(it.unit_price), 414, y, { width: 90, align: 'right' });
      doc.text(rs(it.line_total), 508, y, { width: 84, align: 'right' });
      y += 22;
      doc.moveTo(54, y - 6).lineTo(doc.page.width - 54, y - 6).strokeColor(LINE).lineWidth(0.5).stroke();
    });

    // Totals block
    y += 6;
    const totalRow = (label, value, opts = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.big ? 12 : 10)
        .fillColor(opts.color || INK);
      doc.text(label, 360, y, { width: 144, align: 'right' });
      doc.text(value, 508, y, { width: 84, align: 'right' });
      y += opts.big ? 24 : 18;
    };
    totalRow('Subtotal', rs(order.subtotal));
    if (Number(order.discount_total) > 0) totalRow('Discount', '\u2212 ' + rs(order.discount_total), { color: OK });
    totalRow('Total', rs(order.total), { bold: true, big: true });
    if (paid) totalRow('Paid', rs(order.total), { color: OK });

    footer(doc);

    if (!paid) {
      doc.fontSize(9).font('Helvetica').fillColor(MUTED)
        .text('This invoice is provisional until payment is confirmed by our team.', 54, doc.page.height - 96, { width: doc.page.width - 108 });
    }

    doc.end();
  });
}

module.exports = { writeInvoice, COMPANY };
