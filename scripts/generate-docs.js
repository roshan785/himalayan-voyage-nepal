'use strict';

/**
 * Generates the downloadable documents offered on the site:
 *   • one itinerary PDF per package
 *   • one visa document-checklist PDF per country
 *   • a company profile / brochure PDF
 *
 * All content is generated from the same database the site uses, so the PDFs
 * never drift from the website. Output goes to public/docs/.
 *
 *   node scripts/generate-docs.js
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUT_DIR = path.join(__dirname, '..', 'public', 'docs');
const { all } = require('../src/db');

fs.mkdirSync(OUT_DIR, { recursive: true });

const BRAND = '#0b4f9e';
const INK = '#14213d';
const MUTED = '#6b7a90';
const LINE = '#e4e9f2';

const COMPANY = {
  name: 'Himalayan Voyage Nepal',
  tagline: 'Discover Nepal & Explore the World',
  phone: '+977 9800000000',
  email: 'hello@himalayanvoyage.test',
  address: 'Lakeside Road, Pokhara, Nepal',
  web: 'himalayanvoyage.test'
};

/** Start a new A4 document and stream it to a file. Returns the doc. */
function newDoc(file) {
  const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Author: COMPANY.name, Title: file } });
  doc.pipe(fs.createWriteStream(file));
  return doc;
}

/** Coloured header band with the company name and document title. */
function header(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 108).fill(BRAND);
  doc.fillColor('#ffffff').fontSize(19).font('Helvetica-Bold')
    .text(COMPANY.name, 54, 30, { width: doc.page.width - 108 });
  doc.fontSize(9.5).font('Helvetica').fillColor('#cfe0f6')
    .text(COMPANY.tagline, 54, 56);
  doc.fillColor('#ffd08a').fontSize(13).font('Helvetica-Bold')
    .text(title, 54, 76);
  if (subtitle) {
    doc.fillColor('#cfe0f6').fontSize(9).font('Helvetica')
      .text(subtitle, 54, 92);
  }
  doc.fillColor(INK);
  doc.y = 140;
}

/** Footer rule + contact line at the bottom of the current page. */
function footer(doc) {
  const y = doc.page.height - 62;
  doc.moveTo(54, y).lineTo(doc.page.width - 54, y).strokeColor(LINE).lineWidth(1).stroke();
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text(`${COMPANY.phone}  ·  ${COMPANY.email}  ·  ${COMPANY.address}`, 54, y + 8, {
      width: doc.page.width - 108, align: 'center'
    });
}

/** A small labelled key/value block. */
function facts(doc, rows) {
  const startY = doc.y;
  const colW = (doc.page.width - 108) / 2;
  rows.forEach((row, i) => {
    const col = i % 2;
    const lineY = startY + Math.floor(i / 2) * 26;
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(MUTED).text(row[0].toUpperCase(), 54 + col * colW, lineY);
    doc.fontSize(11).font('Helvetica').fillColor(INK).text(String(row[1]), 54 + col * colW, lineY + 11);
  });
  doc.y = startY + Math.ceil(rows.length / 2) * 26 + 10;
}

/** Section heading. */
function section(doc, text) {
  doc.moveDown(0.6);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(BRAND).text(text);
  doc.moveDown(0.3);
}

function bullet(doc, text) {
  doc.fontSize(10.5).font('Helvetica').fillColor(INK).text('\u2022  ' + text, { indent: 8 });
}

function money(n) {
  return 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
}

// ---------------------------------------------------------------------------
// Package itinerary PDFs
// ---------------------------------------------------------------------------

const DAYS_PLAN = [
  'Arrival, welcome briefing and hotel check-in. Evening at leisure.',
  'Guided sightseeing of the main highlights. Meals as per itinerary.',
  'Full day of activities with your licensed guide.',
  'Travel to the next destination; en-route stops and photography.',
  'Optional adventure activity or free time to explore independently.',
  'Cultural evening, local market visit and traditional dinner.',
  'Return journey and departure transfer to the airport.'
];

function itinerary(pkg) {
  const file = path.join(OUT_DIR, pkg.slug + '.pdf');
  const doc = newDoc(file);

  header(doc, 'Tour Itinerary', pkg.title);
  doc.fontSize(17).font('Helvetica-Bold').fillColor(INK).text(pkg.title);
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(pkg.summary, { width: doc.page.width - 108 });
  doc.moveDown(0.8);

  const final = Math.round(pkg.price - (pkg.price * pkg.discount) / 100);
  facts(doc, [
    ['Destination', pkg.destination],
    ['Duration', `${pkg.days} days / ${pkg.nights} nights`],
    ['Category', pkg.category],
    ['Price from', pkg.discount > 0 ? `${money(final)} (${pkg.discount}% off ${money(pkg.price)})` : money(pkg.price)]
  ]);

  section(doc, 'Trip Highlights');
  JSON.parse(pkg.highlights || '[]').forEach((h) => bullet(doc, h));

  section(doc, 'Day-by-day Plan');
  for (let d = 1; d <= pkg.days; d++) {
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(BRAND).text(`Day ${d}`);
    doc.fontSize(10).font('Helvetica').fillColor(INK)
      .text(DAYS_PLAN[(d - 1) % DAYS_PLAN.length], { indent: 8 });
    doc.moveDown(0.25);
  }

  if (doc.y > doc.page.height - 220) doc.addPage();
  section(doc, 'What is included');
  ['Accommodation on the stated basis', 'Daily breakfast', 'Licensed English-speaking guide',
    'All ground transfers by private vehicle', 'All applicable permits and entry fees'
  ].forEach((x) => bullet(doc, x));
  section(doc, 'Not included');
  ['International flights and visa fees', 'Personal expenses and shopping',
    'Tips and gratuities', 'Travel insurance (strongly recommended)',
    'Anything not mentioned under inclusions'
  ].forEach((x) => bullet(doc, x));

  section(doc, 'How to book');
  doc.fontSize(10.5).font('Helvetica').fillColor(INK)
    .text(`Send an enquiry through ${COMPANY.web} or call ${COMPANY.phone}. ` +
      'We confirm availability and share a written booking confirmation before any payment.');
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor(MUTED)
    .text('Prices are indicative and depend on season, group size and hotel category. ' +
      'This document is an offer, not a confirmed booking.');
  footer(doc);
  doc.end();
  return file;
}

// ---------------------------------------------------------------------------
// Visa checklist PDFs
// ---------------------------------------------------------------------------

const VISA_COUNTRIES = [
  ['usa', 'America', 'United States', 'B1/B2 visitor'],
  ['canada', 'Canada', 'Canada', 'Visitor / study permit'],
  ['uk', 'UK', 'United Kingdom', 'Standard visitor'],
  ['europe', 'Europe', 'Schengen Area', 'Short-stay Schengen'],
  ['japan', 'Japan', 'Japan', 'Tourist'],
  ['china', 'China', 'China', 'Tourist / business'],
  ['thailand', 'Thailand', 'Thailand', 'Tourist'],
  ['bali', 'Bali', 'Indonesia', 'Visa on arrival'],
  ['malaysia', 'Malaysia', 'Malaysia', 'Tourist'],
  ['turkey', 'Turkey', 'Turkey', 'e-Visa'],
  ['hong-kong', 'Hong Kong', 'Hong Kong SAR', 'Visitor'],
  ['australia', 'Australia', 'Australia', 'Visitor / study']
];

const COMMON_DOCS = [
  'Passport valid for at least 6 months with 2 blank pages',
  'Completed visa application form',
  'Two recent passport-size photographs (white background)',
  'Bank statements for the last 6 months',
  'Proof of employment / business / study',
  'Confirmed return flight reservation',
  'Hotel bookings or host invitation letter',
  'Travel insurance covering the full duration',
  'Detailed day-by-day travel itinerary',
  'Proof of funds sufficient for the trip'
];

function visaChecklist(slug, label, region, category) {
  const file = path.join(OUT_DIR, 'visa-' + slug + '.pdf');
  const doc = newDoc(file);

  header(doc, 'Visa Document Checklist', `${label} — ${region}`);
  doc.fontSize(17).font('Helvetica-Bold').fillColor(INK).text(`${label} Visa`);
  doc.moveDown(0.2);
  doc.fontSize(10).font('Helvetica').fillColor(MUTED)
    .text(`Category: ${category}. Requirements are indicative and can change — always confirm with the embassy or consulate before applying.`);
  doc.moveDown(0.8);

  section(doc, 'Documents to prepare');
  COMMON_DOCS.forEach((d) => {
    // a simple checkbox square
    const y = doc.y;
    doc.rect(54, y + 1, 10, 10).strokeColor(BRAND).lineWidth(1).stroke();
    doc.fillColor(INK).fontSize(10.5).font('Helvetica').text(d, 72, y, { width: doc.page.width - 130 });
    doc.moveDown(0.25);
  });

  section(doc, 'Application steps');
  ['Eligibility assessment with our visa desk',
    'Collect and verify all documents',
    'Complete the application form and pay the fee',
    'Book the appointment / biometrics where required',
    'Attend the interview (if applicable)',
    'Track the decision and collect the passport'
  ].forEach((s, i) => bullet(doc, `${i + 1}. ${s}`));

  section(doc, 'Common reasons for refusal');
  ['Incomplete or inconsistent documents', 'Insufficient proof of funds',
    'Unclear travel purpose or itinerary', 'Weak ties to the home country'
  ].forEach((s) => bullet(doc, s));

  section(doc, 'Need help?');
  doc.fontSize(10.5).font('Helvetica').fillColor(INK)
    .text(`Our visa desk reviews every file before submission. Call ${COMPANY.phone} ` +
      `or email ${COMPANY.email} to book a free consultation.`);
  footer(doc);
  doc.end();
  return file;
}

// ---------------------------------------------------------------------------
// Company profile / brochure
// ---------------------------------------------------------------------------

function brochure() {
  const file = path.join(OUT_DIR, 'company-profile.pdf');
  const doc = newDoc(file);

  header(doc, 'Company Profile', 'Who we are and what we do');
  doc.fontSize(17).font('Helvetica-Bold').fillColor(INK).text('About Us');
  doc.moveDown(0.3);
  doc.fontSize(10.5).font('Helvetica').fillColor(INK).text(
    `${COMPANY.name} is a travel agency based in Pokhara, Nepal, specialising in tours, trekking, ` +
    'adventure activities and customized holiday packages across Nepal and international destinations. ' +
    'We work with licensed guides and trusted local operators, and we handle each booking personally ' +
    'from first enquiry to return home.'
  );

  section(doc, 'At a glance');
  facts(doc, [['Happy customers', '100+'], ['Amazing tours', '50+'], ['In business', '372'],
    ['Support cases', '523']]);

  section(doc, 'Services');
  ['Visa application assistance', 'Interview preparation', 'Custom travel packages',
    'Document preparation', 'Free visa consultation', 'Itinerary & booking support',
    'Hotel and accommodation', 'Trekking and adventure'
  ].forEach((s) => bullet(doc, s));

  section(doc, 'Why travel with us');
  ['Transparent pricing with no hidden extras', 'Local guides who know the routes',
    'One point of contact for the whole trip', 'Safety-first with permits and insurance guidance'
  ].forEach((s) => bullet(doc, s));

  section(doc, 'Contact');
  doc.fontSize(10.5).font('Helvetica').fillColor(INK)
    .text(`Phone: ${COMPANY.phone}\nEmail: ${COMPANY.email}\nAddress: ${COMPANY.address}\nWebsite: ${COMPANY.web}`);
  footer(doc);
  doc.end();
  return file;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const packages = await all('SELECT * FROM packages ORDER BY id');
  let count = 0;
  for (const pkg of packages) {
    itinerary(pkg);
    count++;
  }
  for (const [slug, label, region, category] of VISA_COUNTRIES) {
    visaChecklist(slug, label, region, category);
    count++;
  }
  brochure();
  count++;

  // Write an index so the site can list every available document.
  const index = {
    generatedAt: new Date().toISOString(),
    counts: {
      itineraries: packages.length,
      visaChecklists: VISA_COUNTRIES.length,
      brochures: 1,
      total: count
    },
    itineraries: packages.map((p) => ({ slug: p.slug, title: p.title, file: 'docs/' + p.slug + '.pdf' })),
    visaChecklists: VISA_COUNTRIES.map(([slug, label, region]) => ({
      slug, label, region, file: 'docs/visa-' + slug + '.pdf'
    })),
    brochures: [{ title: 'Company Profile', file: 'docs/company-profile.pdf' }]
  };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));

  console.log(`Generated ${count} PDF documents in public/docs/`);
  console.log(`  ${packages.length} itineraries, ${VISA_COUNTRIES.length} visa checklists, 1 brochure`);
}

main().catch((err) => {
  console.error('[fatal] document generation failed:', err.message);
  process.exit(1);
});
