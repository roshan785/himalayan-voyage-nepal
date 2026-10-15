'use strict';

/**
 * Contact page: wires the enquiry form. Validation, submission and feedback all
 * live in App.wireContactForm (main.js) so the page form and the "Contact Now"
 * popup can never drift apart — this file only supplies the ids.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;
  if (!App || typeof App.wireContactForm !== 'function') return;

  document.addEventListener('DOMContentLoaded', () => {
    App.wireContactForm({
      formId: 'contact-form',
      noteId: 'contact-note',
      submitId: 'contact-submit',
      ids: {
        name: 'cf-name',
        email: 'cf-email',
        phone: 'cf-phone',
        subject: 'cf-subject',
        message: 'cf-message'
      }
    });
  });
})();
