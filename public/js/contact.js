'use strict';

/**
 * Contact page: validates and submits the enquiry form, then shows inline
 * success/failure feedback. The subject query parameter pre-fills the form so
 * "Enquire" buttons elsewhere can link straight here.
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('contact-form');
    if (!form) return;
    const note = document.getElementById('contact-note');
    const submit = document.getElementById('contact-submit');

    // Pre-fill the subject from ?subject=
    const subject = new URLSearchParams(location.search).get('subject');
    if (subject) {
      const field = document.getElementById('cf-subject');
      if (field) field.value = subject;
    }

    function show(kind, message) {
      note.className = 'form-note ' + kind;
      note.textContent = message;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: document.getElementById('cf-name').value.trim(),
        email: document.getElementById('cf-email').value.trim(),
        phone: document.getElementById('cf-phone').value.trim(),
        subject: document.getElementById('cf-subject').value.trim(),
        message: document.getElementById('cf-message').value.trim()
      };
      if (!body.name) return show('is-err', 'Please enter your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return show('is-err', 'Please enter a valid email address.');
      if (body.message.length < 5) return show('is-err', 'Please write a short message.');

      submit.disabled = true;
      submit.textContent = 'Sending\u2026';
      try {
        await App.api('/api/contact', { method: 'POST', body });
        form.reset();
        show('is-ok', 'Thank you \u2014 your message has been sent. We will reply shortly.');
        App.toast('Message sent', 'ok');
      } catch (err) {
        show('is-err', err.message || 'Could not send your message. Please try again.');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Send Message';
      }
    });
  });
})();
