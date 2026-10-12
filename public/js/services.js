'use strict';

/**
 * Services page: renders the service catalogue. The list lives here (rather
 * than in the database) because the service offerings are static marketing
 * copy, while packages and destinations are dynamic content.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  const SERVICES = [
    { title: 'Interview Preparation', text: 'Coaching and mock interviews for visa and study-abroad applicants, covering common questions and documentation.', icon: 'chat' },
    { title: 'Visa Application Assistance', text: 'Form filling, appointment booking and a full document review before submission for your destination country.', icon: 'doc' },
    { title: 'Custom Travel Packages', text: 'Flexible itineraries built around your dates, pace, group size and budget \u2014 domestic or international.', icon: 'route' },
    { title: 'Document Preparation', text: 'Checklists, certified translations and attestation guidance so nothing is missing at the counter.', icon: 'check' },
    { title: 'Free Visa Consultation', text: 'A no-cost assessment of your eligibility and the documents you will need before you apply.', icon: 'info' },
    { title: 'Itinerary & Booking Support', text: 'Flights, hotels, permits and airport transfers arranged and confirmed on your behalf.', icon: 'plane' },
    { title: 'Hotel & Accommodation', text: 'Hand-picked stays from budget guesthouses to comfortable city hotels, matched to your itinerary.', icon: 'bed' },
    { title: 'Trekking & Adventure', text: 'Licensed guides, permits and full logistics for treks and adventure activities across Nepal.', icon: 'mountain' },
    { title: 'Travel Insurance Guidance', text: 'Advice on the cover you actually need, including high-altitude and medical evacuation options.', icon: 'shield' }
  ];

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
    route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 0 0 0-8H9a4 4 0 0 1 0-8h6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.8 19.2 16 11l-9.5 4.5-1.5-1.5 5-3.5L8 4.5 9.5 3l6 4 5-2.5a2 2 0 1 1 2 3L17 12l4 6-1.5 1.5z"/></svg>',
    bed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4v16M2 10h20v10M7 10V7a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3"/></svg>',
    mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20l6-11 4 6 3-4 5 9z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 3 7v6c0 5 3.8 8.6 9 9 5.2-.4 9-4 9-9V7z"/></svg>'
  };

  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('services-grid');
    if (!box) return;
    box.innerHTML = SERVICES.map((s) => `
      <article class="card reveal is-in">
        <div class="feature">
          <div class="feature__icon">${ICONS[s.icon] || ICONS.info}</div>
          <div><h3>${App.escapeHtml(s.title)}</h3><p>${App.escapeHtml(s.text)}</p></div>
        </div>
      </article>`).join('');
  });
})();
