'use strict';

/**
 * Generates one dedicated page per visa destination
 * (public/visa-<slug>.html) from a single template, matching the reference
 * site's structure where each visa has its own URL.
 *
 *   node scripts/generate-visa-pages.js
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public');

const COUNTRIES = [
  { slug: 'usa', name: 'America', full: 'United States', img: 'newyork', category: 'B1/B2 visitor',
    about: 'The United States B1/B2 visa covers tourism, family visits and business meetings. We help you assemble a convincing file, prepare for the interview and understand the fee structure before you pay anything.',
    docs: ['Passport valid 6+ months with 2 blank pages', 'DS-160 confirmation page', 'Two 5x5cm photographs (white background)',
      'Bank statements for the last 6 months', 'Proof of employment or business', 'Property / asset documents (if any)',
      'Confirmed return ticket and hotel bookings', 'Travel itinerary and cover letter'],
    steps: ['Eligibility assessment', 'Complete the DS-160 form', 'Pay the visa fee', 'Book the interview slot',
      'Attend the interview with documents', 'Collect the passport with the decision'],
    faqs: [
      ['How long can I stay on a B1/B2 visa?', 'A B1/B2 visa is usually issued for multiple entries over 5-10 years. Each stay is decided by the immigration officer at the port of entry, typically up to 6 months.'],
      ['Do I need an interview?', 'Yes, for most first-time applicants aged 14-79 an in-person interview at the consulate is required.'],
      ['What improves my chances?', 'A clear travel purpose, stable employment, sufficient funds and strong ties to your home country.']
    ] },
  { slug: 'canada', name: 'Canada', full: 'Canada', img: 'canada', category: 'Visitor / study permit',
    about: 'Canada offers visitor visas, study permits and work permits. We review your purpose of travel and financial documents carefully, since these are the most common reasons an application is refused.',
    docs: ['Passport valid for the whole trip', 'IMM 5257 application form', 'Two photographs as per specification',
      'Proof of funds (bank statements)', 'Employment / study proof', 'Invitation letter (if visiting family)',
      'Travel itinerary', 'Family information form'],
    steps: ['Determine the right permit category', 'Create an IRCC online account', 'Upload documents and pay biometrics',
      'Give biometrics at the VAC', 'Submit the application', 'Track the decision online'],
    faqs: [
      ['How early should I apply?', 'Apply at least 8-12 weeks before travel; processing times vary by country and season.'],
      ['Do I need a medical exam?', 'A medical exam is required for stays over 6 months and for certain categories.'],
      ['Can I work on a visitor visa?', 'No. A visitor visa does not permit employment; a separate work permit is required.']
    ] },
  { slug: 'uk', name: 'UK', full: 'United Kingdom', img: 'london', category: 'Standard visitor',
    about: 'The UK Standard Visitor visa covers tourism, business and family visits up to 6 months. We help with the online application, financial evidence and the appointment at the visa application centre.',
    docs: ['Passport with a blank page', 'Completed online application', 'Bank statements for 6 months',
      'Employment / business proof', 'Accommodation details', 'Return flight booking',
      'Invitation letter (if applicable)', 'Photograph as per UKVI rules'],
    steps: ['Complete the online application', 'Pay the visa fee and health surcharge if applicable',
      'Book a biometric appointment', 'Attend the appointment', 'Wait for the decision', 'Collect the passport'],
    faqs: [
      ['How long is the visa valid?', 'A standard visitor visa is commonly issued for 6 months, or for 2, 5 or 10 years for frequent travellers.'],
      ['Can I extend it?', 'It can be extended in limited circumstances; entry as a visitor must be genuine tourism or a permitted activity.'],
      ['How long does it take?', 'Typically around 3 weeks, but this can be longer during peak periods.']
    ] },
  { slug: 'europe', name: 'Europe', full: 'Schengen Area', img: 'paris', category: 'Short-stay Schengen',
    about: 'A Schengen visa lets you travel across 27 European countries on a single visa. The application must be made at the consulate of the country where you will spend the most nights.',
    docs: ['Passport valid 3+ months beyond return', 'Schengen application form', 'Two recent photographs',
      'Travel insurance covering \u20ac30,000', 'Flight and hotel bookings', 'Bank statements for 6 months',
      'Employment proof and leave letter', 'Day-by-day itinerary'],
    steps: ['Identify the main destination country', 'Book a consulate appointment', 'Prepare the full document set',
      'Submit biometrics and documents', 'Pay the visa fee', 'Collect the visa or passport'],
    faqs: [
      ['Which country do I apply to?', 'The country where you will stay the longest; if equal, the first country you enter.'],
      ['How much bank balance is needed?', 'There is no fixed figure, but it must comfortably cover your stay \u2014 roughly \u20ac50-100 per day.'],
      ['When should I apply?', 'Between 15 days and 6 months before travel; apply at least 4 weeks in advance.']
    ] },
  { slug: 'japan', name: 'Japan', full: 'Japan', img: 'tokyo', category: 'Tourist',
    about: 'Japan tourist visas require a clear itinerary and, in most cases, a certificate of eligibility is not needed for short visits. We prepare the full itinerary and financial evidence.',
    docs: ['Passport valid for the trip', 'Visa application form', 'Photograph 45x45mm',
      'Daily itinerary', 'Bank statements / tax documents', 'Employment certificate', 'Flight and hotel bookings', 'Guarantor documents if applicable'],
    steps: ['Prepare the itinerary', 'Complete the application', 'Submit at the embassy or authorised agency',
      'Pay the fee', 'Wait for processing', 'Collect the passport'],
    faqs: [
      ['Do I need a guarantor?', 'Not always. It depends on your nationality and whether you have a sponsor for the trip.'],
      ['How long can I stay?', 'Tourist visas are typically valid for 15, 30 or 90 days depending on the type issued.'],
      ['Is a detailed itinerary required?', 'Yes. Japan asks for a day-by-day plan with accommodation for each night.']
    ] },
  { slug: 'china', name: 'China', full: 'China', img: 'china', category: 'Tourist / business',
    about: 'China tourist (L) and business (M) visas need an invitation or a confirmed itinerary. We guide you through the application form and the biometric appointment.',
    docs: ['Passport valid 6+ months', 'Visa application form (COVA)', 'Photograph 33x48mm',
      'Invitation letter from China', 'Flight and hotel bookings', 'Bank statements', 'Employment proof', 'Previous visas (if any)'],
    steps: ['Complete the COVA form', 'Book an appointment at the visa centre', 'Submit documents and give biometrics',
      'Pay the fee', 'Wait for processing', 'Collect the visa'],
    faqs: [
      ['Do I need an invitation?', 'Yes for a business visa; tourists need confirmed hotel and flight bookings.'],
      ['How long is it valid?', 'Commonly 30-90 days per stay, with validity up to 10 years for some nationalities.'],
      ['Can I apply without an agent?', 'Yes, but the form and appointment process is strict, so many applicants use our service.']
    ] },
  { slug: 'thailand', name: 'Thailand', full: 'Thailand', img: 'bangkok', category: 'Tourist',
    about: 'Thailand tourist visas and visa-on-arrival are straightforward when the paperwork is complete. We confirm the current rules for your nationality before you apply.',
    docs: ['Passport valid 6+ months', 'Completed application form', 'Photograph 4x6cm',
      'Confirmed return ticket', 'Hotel booking', 'Proof of funds', 'Bank statement', 'Itinerary'],
    steps: ['Check eligibility for visa on arrival', 'Complete the form', 'Submit with supporting documents',
      'Pay the fee', 'Receive the visa', 'Travel'],
    faqs: [
      ['Is visa on arrival available?', 'For many nationalities, yes \u2014 with a fee, a return ticket and proof of funds.'],
      ['How long can I stay?', 'Usually 15-60 days depending on the visa type and your nationality.'],
      ['Can I extend my stay?', 'Yes, extensions are possible at a Thai immigration office for a fee.']
    ] },
  { slug: 'bali', name: 'Bali', full: 'Indonesia', img: 'bali-escape', category: 'Visa on arrival',
    about: 'Bali is part of Indonesia, which offers visa on arrival for many visitors. We explain the current fee, the e-VOA option and extension rules so you are not caught out on arrival.',
    docs: ['Passport valid 6+ months', 'Return or onward ticket', 'Proof of accommodation',
      'Proof of funds', 'Visa on arrival fee', 'Passport photos for extensions'],
    steps: ['Check VOA eligibility', 'Pay on arrival or apply for e-VOA online',
      'Present passport and documents', 'Receive 30-day stay', 'Extend if needed at immigration'],
    faqs: [
      ['Do I need a visa in advance?', 'For most nationalities a visa on arrival or e-VOA is available; no advance application is needed.'],
      ['How long can I stay?', '30 days on arrival, extendable once by another 30 days.'],
      ['Where do I extend?', 'At a local immigration office in Bali, before your initial stay expires.']
    ] },
  { slug: 'malaysia', name: 'Malaysia', full: 'Malaysia', img: 'kualalumpur', category: 'Tourist',
    about: 'Malaysia tourist visas are processed quickly when documents are in order. Certain nationalities may enter visa-free \u2014 we confirm which applies to you.',
    docs: ['Passport valid 6+ months', 'Visa application form', 'Photograph 35x50mm',
      'Return ticket', 'Hotel booking', 'Bank statements', 'Employment proof', 'Itinerary'],
    steps: ['Confirm whether a visa is required', 'Complete the form', 'Submit documents',
      'Pay the fee', 'Wait for processing', 'Collect the visa'],
    faqs: [
      ['Do I need a visa for Malaysia?', 'It depends on your nationality; many can enter visa-free for 30-90 days.'],
      ['How long is processing?', 'Usually 3-7 working days.'],
      ['Is a return ticket required?', 'Yes, proof of onward travel is generally required.']
    ] },
  { slug: 'turkey', name: 'Turkey', full: 'Turkey', img: 'turkey', category: 'e-Visa',
    about: 'Turkey offers an electronic visa for many nationalities, sometimes conditional on holding a valid visa or residence permit from certain other countries. We check your eligibility first.',
    docs: ['Passport valid 6+ months', 'e-Visa application', 'Return ticket', 'Hotel booking',
      'Proof of funds', 'Supporting visa if required', 'Photograph', 'Travel insurance'],
    steps: ['Check e-Visa eligibility', 'Complete the online application', 'Pay the e-Visa fee',
      'Receive the e-Visa by email', 'Print and carry it', 'Travel'],
    faqs: [
      ['Is the e-Visa instant?', 'Usually issued within minutes, but always apply at least a week before travel.'],
      ['Are there conditions?', 'Some nationalities need a valid visa or residence permit from the US, UK or Schengen area.'],
      ['How long can I stay?', 'Commonly 30 or 90 days depending on nationality.']
    ] },
  { slug: 'hong-kong', name: 'Hong Kong', full: 'Hong Kong SAR', img: 'hongkong', category: 'Visitor',
    about: 'Hong Kong has its own immigration rules separate from mainland China, with visa-free entry for many nationalities. We confirm your specific requirement and prepare the file if a visa is needed.',
    docs: ['Passport valid 6+ months', 'Application form ID(E) 936A', 'Photograph 40x50mm',
      'Return ticket', 'Hotel booking', 'Bank statements', 'Employment proof', 'Itinerary'],
    steps: ['Check visa-free eligibility', 'Complete the application if required', 'Submit documents',
      'Pay the fee', 'Wait for processing', 'Collect the visa'],
    faqs: [
      ['Do I need a visa for Hong Kong?', 'Many nationalities can enter visa-free for 7-180 days; others need a visa.'],
      ['Is it different from a China visa?', 'Yes \u2014 Hong Kong has its own immigration system and separate visa rules.'],
      ['How long is processing?', 'Typically around 4-6 weeks for applications requiring a visa.']
    ] },
  { slug: 'australia', name: 'Australia', full: 'Australia', img: 'sydney', category: 'Visitor / study',
    about: 'Australia visitor visas (subclass 600) and student visas (subclass 500) are lodged online. We help build the Genuine Temporary Entrant evidence that most refusals hinge on.',
    docs: ['Passport valid for the trip', 'Subclass 600/500 application', 'Photograph',
      'Bank statements and proof of funds', 'Employment / study evidence', 'Health insurance (required for students)',
      'Statement of purpose (students)', 'Flight and accommodation details'],
    steps: ['Choose the right subclass', 'Create an ImmiAccount', 'Upload documents',
      'Complete health and character checks if required', 'Submit and pay', 'Track the decision'],
    faqs: [
      ['What is the GTE requirement?', 'You must show that your intention is genuinely temporary and that you have strong ties to your home country.'],
      ['Do students need health insurance?', 'Yes, Overseas Student Health Cover (OSHC) is mandatory for a student visa.'],
      ['How long is processing?', 'Visitor visas often take 2-4 weeks; student visas can take longer.']
    ] }
];

function page(c) {
  const title = c.name + ' Visa | Himalayan Voyage Nepal';
  const faqHtml = c.faqs.map(([q, a], i) => `
        <article class="card" style="margin-bottom:12px">
          <button class="faq-q" aria-expanded="false" aria-controls="vfaq-${i}"
            style="width:100%;text-align:left;background:#fff;border:0;font:inherit;font-weight:600;color:var(--ink);padding:18px 20px;cursor:pointer;display:flex;justify-content:space-between;gap:14px;align-items:center">
            <span>${q}</span><span class="faq-sign" style="color:var(--brand);font-size:1.3rem;line-height:1">+</span>
          </button>
          <div id="vfaq-${i}" style="display:none;padding:0 20px 18px;color:var(--muted)">${a}</div>
        </article>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${c.name} visa assistance from Himalayan Voyage Nepal \u2014 document checklist, application steps and free consultation.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <div id="site-header"></div>

  <main>
    <section class="hero hero--slim">
      <div class="wrap"><div class="hero__inner">
        <div class="breadcrumbs"><a href="index.html">Home</a> / <a href="visa.html">Visa</a> / ${c.name}</div>
        <span class="eyebrow" style="color:#ffd08a">${c.category}</span>
        <h1>${c.name} Visa</h1>
        <p class="lead">${c.full} \u2014 document checklist, application support and a free eligibility assessment.</p>
        <div class="hero__actions">
          <a class="btn btn--accent" href="contact.html?subject=${encodeURIComponent(c.name + ' Visa Enquiry')}">Book Free Consultation</a>
          <a class="btn btn--light" href="docs/visa-${c.slug}.pdf" target="_blank" rel="noopener">\ud83d\udcc4 Download Checklist</a>
        </div>
      </div></div>
    </section>

    <section class="section">
      <div class="wrap" style="max-width:900px">
        <div class="cover cover--photo" style="aspect-ratio:21/9;border-radius:14px;margin-bottom:26px" id="visa-hero-cover">
          <img class="cover__img" src="images/${c.img}.jpg" alt="${c.full}" id="visa-hero-img">
          <div class="desti-overlay"><a class="desti-cta" href="contact.html"><span>Apply Now</span><span class="desti-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></a></div>
        </div>
        <h2>About this visa</h2>
        <p>${c.about}</p>
        <p class="credit" id="visa-hero-credit"></p>
      </div>
    </section>

    <section class="section section--alt">
      <div class="wrap split" style="align-items:start">
        <div>
          <span class="eyebrow">Checklist</span>
          <h2>Documents you will need</h2>
          <ul class="checklist">${c.docs.map((d) => `<li>${d}</li>`).join('')}</ul>
        </div>
        <div>
          <span class="eyebrow">Process</span>
          <h2>How it works</h2>
          <ul class="checklist">${c.steps.map((s, i) => `<li>${i + 1}. ${s}</li>`).join('')}</ul>
          <a class="btn btn--primary" style="margin-top:16px" href="contact.html?subject=${encodeURIComponent(c.name + ' Visa Enquiry')}">Start My Application</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap" style="max-width:820px">
        <div class="sec-head"><span class="eyebrow">FAQ</span><h2>${c.name} visa questions</h2></div>
        ${faqHtml}
        <div class="cta-band" style="margin-top:30px">
          <div><h2 style="font-size:1.25rem">Not sure if you qualify?</h2><p>Send us your details and we will tell you honestly.</p></div>
          <a class="btn btn--accent" href="contact.html">Ask Us</a>
        </div>
        <div style="margin-top:22px"><a class="btn btn--ghost btn--sm" href="visa.html">&larr; All visa services</a></div>
      </div>
    </section>
  </main>

  <div id="site-footer"></div>

  <script src="js/layout.js"></script>
  <script src="js/main.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      // Fill in the photo attribution for the hero image.
      if (!window.App) return;
      App.creditsReady().then(function () {
        var el = document.getElementById('visa-hero-credit');
        if (el) el.innerHTML = App.creditLine('${c.img}');
      });
      document.querySelectorAll('.faq-q').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var panel = document.getElementById(btn.getAttribute('aria-controls'));
          var open = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', open ? 'false' : 'true');
          panel.style.display = open ? 'none' : 'block';
          var s = btn.querySelector('.faq-sign'); if (s) s.textContent = open ? '+' : '\\u2212';
        });
      });
    });
  </script>
</body>
</html>
`;
}

let count = 0;
for (const c of COUNTRIES) {
  const file = path.join(OUT, 'visa-' + c.slug + '.html');
  fs.writeFileSync(file, page(c));
  count++;
}
console.log('Generated ' + count + ' visa pages:');
console.log('  ' + COUNTRIES.map((c) => 'visa-' + c.slug + '.html').join('\n  '));
