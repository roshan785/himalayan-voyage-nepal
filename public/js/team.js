'use strict';

/**
 * Team page: renders the team grid with real photos where available.
 * Photos are matched through the shared credit manifest, so each card gets a
 * proper, attributed image — or falls back to decorative CSS artwork.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  // `img` points at a downloaded photo slug used for the card background.
  const TEAM = [
    { name: 'Aarav Shrestha', role: 'Managing Director', img: 'kathmandu-durbar',
      bio: 'Oversees operations, international partnerships and quality control on every itinerary.' },
    { name: 'Nisha Gurung', role: 'Head of Tours', img: 'ghandruk',
      bio: 'Designs itineraries across Nepal and beyond, and trains the tour desk team.' },
    { name: 'Bikash Tamang', role: 'Lead Trekking Guide', img: 'annapurna-panorama',
      bio: 'Licensed guide with over 12 years in the Annapurna and Langtang regions.' },
    { name: 'Pooja Rai', role: 'Visa Desk Lead', img: 'kathmandu-heritage',
      bio: 'Handles documentation, appointments and interview preparation for every applicant.' },
    { name: 'Suman Thapa', role: 'Adventure Coordinator', img: 'paragliding',
      bio: 'Runs paragliding, rafting and jungle safari bookings with vetted local operators.' },
    { name: 'Maya Lama', role: 'Guest Relations', img: 'cultural-dance',
      bio: 'Your first point of contact from booking through to your return home.' },
    { name: 'Rajan Adhikari', role: 'Transport Manager', img: 'pokhara-lakeside',
      bio: 'Coordinates airport transfers and all ground transport across the country.' },
    { name: 'Sarita Karki', role: 'Finance & Support', img: 'momo-food',
      bio: 'Manages payments, receipts and the 24/7 support line.' }
  ];

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    const grid = document.getElementById('team-grid');
    if (!grid) return;
    grid.innerHTML = TEAM.map((m) => {
      const cov = App.coverInner({ title: m.name, image: m.img }, {
        label: m.name,
        overlay: { label: 'View Profile', href: 'team.html' }
      });
      return `
      <article class="card reveal is-in">
        <div class="cover ${cov.cls}" style="aspect-ratio:4/3">${cov.html}</div>
        <div class="card__body">
          <h3 style="margin:0">${App.escapeHtml(m.name)}</h3>
          <span class="badge badge--soft" style="align-self:flex-start">${App.escapeHtml(m.role)}</span>
          <p style="margin-top:6px">${App.escapeHtml(m.bio)}</p>
        </div>
      </article>`;
    }).join('');
  });
})();
