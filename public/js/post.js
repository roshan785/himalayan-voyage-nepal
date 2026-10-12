'use strict';

/** Single article page — reads ?slug= and renders the full post. */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  function paragraphs(text) {
    return String(text || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${App.escapeHtml(p.trim())}</p>`)
      .join('');
  }

  async function load() {
    await App.creditsReady();
    const box = document.getElementById('post-detail');
    const slug = new URLSearchParams(location.search).get('slug');
    if (!slug) {
      box.innerHTML = '<div class="empty">No article selected. <a href="blogs.html">Browse all articles</a>.</div>';
      return;
    }
    box.innerHTML = '<div class="skeleton" style="height:280px;margin-bottom:20px"></div><div class="skeleton" style="height:18px;width:70%;margin-bottom:10px"></div><div class="skeleton" style="height:18px"></div>';
    try {
      const post = (await App.api('/api/posts/' + encodeURIComponent(slug))).item;
      document.title = post.title + ' | Himalayan Voyage Nepal';
      const cov = App.coverInner(post);
      box.innerHTML = `
        <div class="breadcrumbs"><a href="index.html">Home</a> / <a href="blogs.html">Blogs</a> / Article</div>
        <div class="cover ${cov.cls}" style="aspect-ratio:21/9;border-radius:14px;margin-bottom:22px">${cov.html}</div>
        <span class="post-date">${App.formatDate(post.created_at)} &bull; ${App.escapeHtml(post.author)}</span>
        <h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem);margin-top:8px">${App.escapeHtml(post.title)}</h1>
        <p class="muted" style="font-size:1.05rem">${App.escapeHtml(post.excerpt)}</p>
        <div class="post-body">${paragraphs(post.body)}</div>
        <div class="cta-band" style="margin-top:30px">
          <div><h2 style="font-size:1.3rem">Planning a trip like this?</h2><p>Tell us your dates and we'll build the itinerary.</p></div>
          <a class="btn btn--accent" href="contact.html">Contact Now</a>
        </div>
        <div style="margin-top:24px"><a class="btn btn--ghost btn--sm" href="blogs.html">&larr; All articles</a></div>`;
    } catch (_err) {
      box.innerHTML = '<div class="empty">Article not found. <a href="blogs.html">Back to all articles</a>.</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
