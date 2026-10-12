'use strict';

/**
 * Visa page: a country grid linking to a pre-filled contact enquiry. Visa
 * requirements change constantly, so we never publish fixed processing times
 * or fees \u2014 the enquiry form is the accurate path.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  // `img` maps each country to its downloaded photo slug so the card shows a
  // real, credited image; `page` links to that country's dedicated visa page.
  const COUNTRIES = [
    { name: 'America Visa', region: 'United States', img: 'newyork', page: 'visa-usa.html', note: 'B1/B2 tourist and business visitor categories.' },
    { name: 'Canada Visa', region: 'Canada', img: 'canada', page: 'visa-canada.html', note: 'Visitor visa and study permit documentation.' },
    { name: 'UK Visa', region: 'United Kingdom', img: 'london', page: 'visa-uk.html', note: 'Standard visitor and family visit routes.' },
    { name: 'Europe Visa', region: 'Schengen Area', img: 'paris', page: 'visa-europe.html', note: 'Short-stay Schengen application support.' },
    { name: 'Japan Visa', region: 'Japan', img: 'tokyo', page: 'visa-japan.html', note: 'Tourist visa with itinerary preparation.' },
    { name: 'China Visa', region: 'China', img: 'china', page: 'visa-china.html', note: 'Tourist and business visa assistance.' },
    { name: 'Thailand Visa', region: 'Thailand', img: 'bangkok', page: 'visa-thailand.html', note: 'Tourist visa and onward-travel documentation.' },
    { name: 'Bali Visa', region: 'Indonesia', img: 'bali-escape', page: 'visa-bali.html', note: 'Visa on arrival guidance and extensions.' },
    { name: 'Malaysia Visa', region: 'Malaysia', img: 'kualalumpur', page: 'visa-malaysia.html', note: 'Tourist visa processing support.' },
    { name: 'Turkey Visa', region: 'Turkey', img: 'turkey', page: 'visa-turkey.html', note: 'e-Visa eligibility and application help.' },
    { name: 'Hong Kong Visa', region: 'Hong Kong SAR', img: 'hongkong', page: 'visa-hong-kong.html', note: 'Visitor visa documentation review.' },
    { name: 'Australia Visa', region: 'Australia', img: 'sydney', page: 'visa-australia.html', note: 'Visitor and study visa file preparation.' }
  ];

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    const grid = document.getElementById('visa-grid');
    if (!grid) return;

    // A ?c=<Country> query (linked from the Visa sub-menu) filters the grid and
    // scrolls it into view so the visitor lands on the right card.
    const wanted = new URLSearchParams(location.search).get('c');
    const list = wanted
      ? COUNTRIES.filter((c) => c.name.toLowerCase().startsWith(wanted.toLowerCase()))
      : COUNTRIES;

    if (!list.length) {
      App.showEmpty(grid, 'No visa service found for "' + wanted + '".');
      return;
    }
    grid.innerHTML = list.map((c, i) => {
      const cov = App.coverInner({ title: c.name + ' ' + c.region, image: c.img }, {
        tag: 'Visa',
        label: c.region,
        overlay: { label: 'View Details', href: c.page }
      });
      const cls = cov.cls === 'cover--photo' ? cov.cls : 'cover--' + ['city', 'heritage', 'island', 'temple', 'sunset', 'forest'][i % 6];
      return `
      <article class="card reveal is-in">
        <div class="cover ${cls}">
          ${cov.html}
        </div>
        <div class="card__body">
          <h3 style="font-size:1.05rem">${App.escapeHtml(c.name)}</h3>
          <p>${App.escapeHtml(c.note)}</p>
          <div class="card__foot">
            <a class="btn btn--primary btn--sm" href="${c.page}">View Details</a>
          </div>
        </div>
      </article>`;
    }).join('');
  });
})();
