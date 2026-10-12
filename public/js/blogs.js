'use strict';

/** Blog listing page: renders published posts from the API. */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  function card(b) {
    const cov = App.coverInner(b, {
      tag: 'Article',
      overlay: { label: 'Read Article', href: 'posts.html?slug=' + encodeURIComponent(b.slug) }
    });
    return `
      <article class="card post-card reveal is-in">
        <div class="cover ${cov.cls}">${cov.html}</div>
        <div class="card__body">
          <span class="post-date">${App.formatDate(b.created_at)}</span>
          <h3><a href="posts.html?slug=${encodeURIComponent(b.slug)}">${App.escapeHtml(b.title)}</a></h3>
          <p>${App.escapeHtml(b.excerpt)}</p>
          <div class="card__foot" style="margin-top:auto">
            <a class="btn btn--ghost btn--sm" href="posts.html?slug=${encodeURIComponent(b.slug)}">Read More</a>
          </div>
        </div>
      </article>`;
  }

  let allPosts = [];

  function renderPosts(items, q) {
    const grid = document.getElementById('blog-grid');
    if (!grid) return;
    const count = document.getElementById('blog-count');
    if (count) count.textContent = items.length + (items.length === 1 ? ' article' : ' articles');
    if (!items.length) {
      grid.innerHTML = '<div class="toolbar__empty">' +
        (q ? 'No articles match &ldquo;' + App.escapeHtml(q) + '&rdquo;.' : 'No articles published yet.') +
        '</div>';
      return;
    }
    grid.innerHTML = items.map(card).join('');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    const grid = document.getElementById('blog-grid');
    App.skeletonCards(grid, 3);
    try {
      const data = await App.api('/api/posts');
      allPosts = data.items || [];
      const apply = App.wireToolbar({
        searchId: 'blog-search',
        sortId: 'blog-sort',
        getItems: () => allPosts,
        searchKeys: ['title', 'excerpt', 'author'],
        render: renderPosts
      });
      if (apply) apply();
      else renderPosts(allPosts, '');
    } catch (err) {
      App.showEmpty(grid, 'Could not load articles.');
      App.toast(err.message, 'err');
    }
  });
})();
