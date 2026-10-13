'use strict';

/**
 * Admin console. Talks to the JWT-protected /api/admin/* endpoints.
 *
 * The token is stored in localStorage and sent as a Bearer header on every
 * request (the login response also sets an HttpOnly cookie for same-origin
 * browser requests, but the explicit header keeps this page simple and works
 * even when cookies are blocked).
 */

(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const App = window.App;

  const TOKEN_KEY = 'hv_admin_token';
  const state = { view: 'overview', data: [] };

  // ------------------------------------------------------------------
  // API helper that attaches the bearer token
  // ------------------------------------------------------------------
  async function adminApi(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    return App.api('/api/admin' + path, opts);
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function enterConsole(user) {
    hide(document.getElementById('admin-login'));
    show(document.getElementById('admin-console'));
    document.getElementById('who').textContent = user ? `${user.name} (${user.email})` : '';
    await renderView('overview');
  }

  async function checkSession() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    try {
      const me = await App.api('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      await enterConsole(me.user);
      return true;
    } catch (_err) {
      setToken(null);
      return false;
    }
  }

  function wireLogin() {
    const form = document.getElementById('login-form');
    const note = document.getElementById('login-note');
    const submit = document.getElementById('login-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('lg-email').value.trim();
      const password = document.getElementById('lg-password').value;
      note.className = 'form-note';
      submit.disabled = true;
      submit.textContent = 'Signing in\u2026';
      try {
        const res = await App.api('/api/auth/login', { method: 'POST', body: { email, password } });
        setToken(res.token);
        await enterConsole(res.user);
      } catch (err) {
        note.className = 'form-note is-err';
        note.textContent = err.message || 'Sign in failed.';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Sign In';
      }
    });
  }

  function wireLogout() {
    document.getElementById('logout-btn').addEventListener('click', async () => {
      try { await App.api('/api/auth/logout', { method: 'POST' }); } catch (_e) { /* ignore */ }
      setToken(null);
      hide(document.getElementById('admin-console'));
      show(document.getElementById('admin-login'));
    });
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  const VIEWS = {
    overview: {
      title: 'Overview',
      fields: [],
      load: () => adminApi('/overview'),
      render(data) {
        const c = data.counts;
        const card = (label, value) => `<div class="admin-card"><b>${value}</b><span>${label}</span></div>`;
        const rows = data.recentContacts.map((r) => `
          <tr>
            <td>${App.escapeHtml(r.name)}</td>
            <td>${App.escapeHtml(r.email)}</td>
            <td class="wrap-cell">${App.escapeHtml(r.subject || '\u2014')}</td>
            <td>${r.handled ? '<span class="badge badge--ok">Handled</span>' : '<span class="badge badge--off">New</span>'}</td>
            <td>${App.formatDate(r.created_at)}</td>
          </tr>`).join('');
        return `
          <div class="admin-cards">
            ${card('Packages', c.packages)}
            ${card('Destinations', c.destinations)}
            ${card('Blog Posts', c.posts)}
            ${card('Testimonials', c.testimonials)}
            ${card('Enquiries', c.contacts)}
            ${card('Unread Enquiries', c.unreadContacts)}
            ${card('Subscribers', c.subscribers)}
          </div>
          <h3>Recent enquiries</h3>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Name</th><th>Email</th><th>Subject</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="muted">No enquiries yet.</td></tr>'}</tbody>
          </table></div>`;
      }
    },
    packages: {
      title: 'Packages',
      endpoint: '/packages',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'category', label: 'Category', type: 'select', options: ['domestic', 'international', 'historical', 'religious', 'trekking'] },
        { name: 'destination', label: 'Destination', type: 'text' },
        { name: 'days', label: 'Days', type: 'number' },
        { name: 'nights', label: 'Nights', type: 'number' },
        { name: 'price', label: 'Price (Rs.)', type: 'number' },
        { name: 'discount', label: 'Discount (%)', type: 'number' },
        { name: 'image', label: 'Image', type: 'image' },
        { name: 'summary', label: 'Summary', type: 'textarea' },
        { name: 'highlights', label: 'Highlights (one per line)', type: 'lines' },
        { name: 'featured', label: 'Featured', type: 'checkbox' }
      ],
      columns: ['id', 'title', 'category', 'destination', 'price', 'discount', 'featured']
    },
    destinations: {
      title: 'Destinations',
      endpoint: '/destinations',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'kind', label: 'Kind', type: 'select', options: ['nepal', 'international'] },
        { name: 'region', label: 'Region', type: 'text' },
        { name: 'image', label: 'Image', type: 'image' },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'country', label: 'Country', type: 'text' },
        { name: 'capital', label: 'Capital', type: 'text' },
        { name: 'currency', label: 'Currency', type: 'text' },
        { name: 'language', label: 'Language', type: 'text' },
        { name: 'best_time', label: 'Best Time to Visit', type: 'text' },
        { name: 'visa', label: 'Visa Requirements', type: 'text' },
        { name: 'featured', label: 'Featured', type: 'checkbox' }
      ],
      columns: ['id', 'name', 'kind', 'region', 'featured']
    },
    posts: {
      title: 'Blog Posts',
      endpoint: '/posts',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'excerpt', label: 'Excerpt', type: 'textarea' },
        { name: 'body', label: 'Body', type: 'textarea' },
        { name: 'author', label: 'Author', type: 'text' },
        { name: 'cover', label: 'Cover Image', type: 'image' },
        { name: 'published', label: 'Published', type: 'checkbox' }
      ],
      columns: ['id', 'title', 'author', 'published', 'created_at']
    },
    bookings: {
      title: 'Bookings',
      endpoint: '/bookings',
      fields: [
        { name: 'package_title', label: 'Package', type: 'text' },
        { name: 'name', label: 'Customer Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'text' },
        { name: 'phone', label: 'Phone', type: 'text' },
        { name: 'travellers', label: 'Travellers', type: 'number' },
        { name: 'travel_date', label: 'Travel Date', type: 'text' },
        { name: 'status', label: 'Status', type: 'select', options: ['new', 'confirmed', 'cancelled', 'done'] },
        { name: 'message', label: 'Message', type: 'textarea' }
      ],
      columns: ['id', 'package_title', 'name', 'travellers', 'status']
    },
    testimonials: {
      title: 'Testimonials',
      endpoint: '/testimonials',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'rating', label: 'Rating (1-5)', type: 'number' },
        { name: 'content', label: 'Content', type: 'textarea' }
      ],
      columns: ['id', 'name', 'location', 'rating']
    }
  };

  function fieldHtml(f, value) {
    const id = 'fld-' + f.name;
    const v = value == null ? '' : value;
    if (f.type === 'textarea') {
      return `<div class="field"><label for="${id}">${f.label}</label><textarea id="${id}" name="${f.name}">${App.escapeHtml(v)}</textarea></div>`;
    }
    if (f.type === 'select') {
      const opts = f.options.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('');
      return `<div class="field"><label for="${id}">${f.label}</label><select id="${id}" name="${f.name}">${opts}</select></div>`;
    }
    if (f.type === 'checkbox') {
      return `<div class="field"><label><input type="checkbox" id="${id}" name="${f.name}" ${v ? 'checked' : ''}> ${f.label}</label></div>`;
    }
    if (f.type === 'lines') {
      const text = Array.isArray(v) ? v.join('\n') : v;
      return `<div class="field"><label for="${id}">${f.label}</label><textarea id="${id}" name="${f.name}">${App.escapeHtml(text)}</textarea></div>`;
    }
    if (f.type === 'image') {
      // Image picker: paste a URL / filename OR upload a file (turned into a
      // data URL if it is small enough). A live preview shows what the frontend
      // will render, so the admin sees the change before saving.
      const preview = v ? `<img class="img-preview" src="${App.escapeHtml(App.imgSrc(v))}" alt="">` : '';
      return `<div class="field">
        <label for="${id}">${f.label}</label>
        <div class="img-field">
          <div class="img-field__main">
            <input id="${id}" name="${f.name}" type="text" value="${App.escapeHtml(v)}" placeholder="images/my-photo.jpg or https://…">
            <input type="file" accept="image/*" data-img-upload="${f.name}" class="img-upload">
          </div>
          <div class="img-field__preview" data-img-preview="${f.name}">${preview}</div>
        </div>
        <span class="small muted">Paste a path/URL or choose a file (small files are embedded).</span>
      </div>`;
    }
    return `<div class="field"><label for="${id}">${f.label}${f.required ? ' *' : ''}</label><input id="${id}" name="${f.name}" type="${f.type}" value="${App.escapeHtml(v)}" ${f.required ? 'required' : ''}></div>`;
  }

  function readForm(fields) {
    const out = {};
    for (const f of fields) {
      const el = document.getElementById('fld-' + f.name);
      if (!el) continue;
      if (f.type === 'checkbox') out[f.name] = el.checked ? 1 : 0;
      else if (f.type === 'number') out[f.name] = Number(el.value) || 0;
      else if (f.type === 'lines') out[f.name] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else out[f.name] = el.value.trim();
    }
    return out;
  }

  function editorOpen(view, item) {
    const cfg = VIEWS[view];
    const backdrop = document.getElementById('editor-backdrop');
    document.getElementById('editor-title').textContent = (item ? 'Edit ' : 'New ') + cfg.title.replace(/s$/, '');
    const form = document.getElementById('editor-form');
    form.dataset.view = view;
    form.dataset.id = item ? item.id : '';
    form.innerHTML = cfg.fields.map((f) => fieldHtml(f, item ? item[f.name] : (f.type === 'checkbox' ? 1 : ''))).join('');
    wireImageFields(form);
    backdrop.classList.add('is-open');
  }

  /**
   * Let an admin pick an image for a text/image field: typing a path keeps it,
   * choosing a file reads it as a data URL (only when small, so we never blow
   * the 1 MB request limit) and updates the preview immediately.
   */
  function wireImageFields(form) {
    form.querySelectorAll('[data-img-upload]').forEach((input) => {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const target = form.querySelector('#fld-' + input.dataset.imgUpload);
        const preview = form.querySelector('[data-img-preview="' + input.dataset.imgUpload + '"]');
        if (file.size > 400 * 1024) {
          App.toast('Image too large (max 400 KB) \u2014 use a URL or compress it.', 'err');
          input.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (target) target.value = reader.result;
          if (preview) preview.innerHTML = '<img class="img-preview" src="' + reader.result + '" alt="">';
        };
        reader.readAsDataURL(file);
      });
    });
    // Keep the preview in step when the admin edits the text path directly.
    form.querySelectorAll('[data-img-preview]').forEach((box) => {
      const name = box.dataset.imgPreview;
      const input = form.querySelector('#fld-' + name);
      if (!input) return;
      input.addEventListener('input', () => {
        const val = input.value.trim();
        box.innerHTML = val ? '<img class="img-preview" src="' + App.escapeHtml(App.imgSrc(val)) + '" alt="">' : '';
      });
    });
  }

  function editorClose() {
    document.getElementById('editor-backdrop').classList.remove('is-open');
  }

  async function editorSave() {
    const form = document.getElementById('editor-form');
    const view = form.dataset.view;
    const id = form.dataset.id;
    const cfg = VIEWS[view];
    const body = readForm(cfg.fields);
    const required = cfg.fields.find((f) => f.required);
    if (required && !body[required.name]) {
      App.toast(required.label + ' is required', 'err');
      return;
    }
    try {
      if (id) await adminApi(`${cfg.endpoint}/${id}`, { method: 'PUT', body });
      else await adminApi(cfg.endpoint, { method: 'POST', body });
      editorClose();
      App.toast('Saved', 'ok');
      renderView(view);
    } catch (err) {
      App.toast(err.message || 'Could not save', 'err');
    }
  }

  async function removeItem(view, id) {
    const cfg = VIEWS[view];
    if (!confirm('Delete this item? This cannot be undone.')) return;
    try {
      await adminApi(`${cfg.endpoint}/${id}`, { method: 'DELETE' });
      App.toast('Deleted', 'ok');
      renderView(view);
    } catch (err) {
      App.toast(err.message || 'Could not delete', 'err');
    }
  }

  async function renderCrud(view) {
    const cfg = VIEWS[view];
    const viewEl = document.getElementById('view');
    viewEl.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const data = await adminApi(cfg.endpoint);
      state.data = data.items || [];
      const head = cfg.columns.map((c) => `<th>${c}</th>`).join('');
      const rows = state.data.map((item) => {
        const cells = cfg.columns.map((c) => {
          let val = item[c];
          if (c === 'featured') val = val ? '<span class="badge badge--ok">Yes</span>' : '\u2014';
          else if (c === 'published') val = val ? '<span class="badge badge--ok">Live</span>' : '<span class="badge badge--off">Draft</span>';
          else if (c === 'price') val = App.money(val);
          else val = App.escapeHtml(val == null ? '' : String(val));
          return `<td>${val}</td>`;
        }).join('');
        return `<tr>${cells}
          <td><div class="row-actions">
            <button class="icon-btn" data-edit="${item.id}">Edit</button>
            <button class="icon-btn danger" data-del="${item.id}">Delete</button>
          </div></td></tr>`;
      }).join('');
      viewEl.innerHTML = `
        <div class="table-wrap"><table class="data">
          <thead><tr>${head}<th>Actions</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="${cfg.columns.length + 1}" class="muted">No ${cfg.title.toLowerCase()} yet. Click “+ New”.</td></tr>`}</tbody>
        </table></div>`;
      viewEl.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        editorOpen(view, state.data.find((x) => String(x.id) === b.dataset.edit));
      }));
      viewEl.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => removeItem(view, b.dataset.del)));
    } catch (err) {
      viewEl.innerHTML = `<div class="empty">Could not load ${cfg.title}. ${App.escapeHtml(err.message)}</div>`;
    }
  }

  async function renderBookings() {
    const viewEl = document.getElementById('view');
    viewEl.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const data = await adminApi('/bookings');
      renderBookingTable(data.items || []);
    } catch (err) {
      viewEl.innerHTML = `<div class="empty">Could not load bookings. ${App.escapeHtml(err.message)}</div>`;
    }
  }

  /**
   * Booking management with client-side search, status filter, bulk status
   * changes and CSV export. Data is fetched once; filtering is instant and never
   * re-queries. All values pass through App.escapeHtml before insertion.
   */
  function renderBookingTable(items) {
    const viewEl = document.getElementById('view');
    const state = { q: '', status: 'all' };
    const statusBadge = (st) => {
      const map = { new: 'badge--off', confirmed: 'badge--ok', cancelled: 'badge--err', done: 'badge' };
      return '<span class="badge ' + (map[st] || '') + '">' + App.escapeHtml(st) + '</span>';
    };
    const counts = items.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

    viewEl.innerHTML = `
      <div class="toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <input id="bk-q" type="search" placeholder="Search name, email or package…" style="flex:1;min-width:200px;padding:9px 12px;border:1px solid #d5dbe4;border-radius:9px">
        <select id="bk-status" style="padding:9px 12px;border:1px solid #d5dbe4;border-radius:9px">
          <option value="all">All statuses (${items.length})</option>
          <option value="new">New (${counts.new || 0})</option>
          <option value="confirmed">Confirmed (${counts.confirmed || 0})</option>
          <option value="cancelled">Cancelled (${counts.cancelled || 0})</option>
          <option value="done">Done (${counts.done || 0})</option>
        </select>
        <button class="btn btn--ghost btn--sm" id="bk-export">Export CSV</button>
      </div>
      <div id="bk-summary" class="muted small" style="margin-bottom:8px"></div>
      <div id="bk-table"></div>`;

    const shown = () => {
      const q = state.q.trim().toLowerCase();
      return items.filter((r) => {
        if (state.status !== 'all' && r.status !== state.status) return false;
        if (!q) return true;
        return [r.name, r.email, r.package_title, r.phone, r.travel_date]
          .some((v) => String(v || '').toLowerCase().includes(q));
      });
    };

    const paint = () => {
      const list = shown();
      const box = document.getElementById('bk-table');
      const sum = document.getElementById('bk-summary');
      sum.textContent = `Showing ${list.length} of ${items.length} bookings`;
      const rows = list.map((r) => `
        <tr>
          <td>${App.escapeHtml(r.package_title || '\u2014')}</td>
          <td>${App.escapeHtml(r.name)}</td>
          <td>${App.escapeHtml(r.email)}</td>
          <td>${App.escapeHtml(r.phone || '\u2014')}</td>
          <td>${r.travellers}</td>
          <td>${r.travel_date ? App.escapeHtml(r.travel_date) : '\u2014'}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${App.formatDate(r.created_at)}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-edit="${r.id}">Edit</button>
            <button class="icon-btn danger" data-del="${r.id}">Delete</button>
          </div></td>
        </tr>`).join('');
      box.innerHTML = `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Package</th><th>Customer</th><th>Email</th><th>Phone</th><th>Travellers</th><th>Travel Date</th><th>Status</th><th>Received</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="9" class="muted">No bookings match.</td></tr>'}</tbody>
        </table></div>`;
      box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        editorOpen('bookings', items.find((x) => String(x.id) === b.dataset.edit));
      }));
      box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this booking?')) return;
        await adminApi('/bookings/' + b.dataset.del, { method: 'DELETE' });
        items = items.filter((x) => String(x.id) !== b.dataset.del);
        App.toast('Deleted', 'ok');
        renderBookingTable(items);
      }));
    };

    document.getElementById('bk-q').addEventListener('input', (e) => { state.q = e.target.value; paint(); });
    document.getElementById('bk-status').addEventListener('change', (e) => { state.status = e.target.value; paint(); });
    document.getElementById('bk-export').addEventListener('click', () => exportCsv(shown()));
    paint();
  }

  /** Download the given bookings as a CSV file (client-side, no data leaves the browser). */
  function exportCsv(rows) {
    const cols = ['id', 'package_title', 'name', 'email', 'phone', 'travellers', 'travel_date', 'status', 'created_at'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bookings-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  async function renderContacts() {
    const viewEl = document.getElementById('view');
    viewEl.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const data = await adminApi('/contacts');
      const rows = (data.items || []).map((r) => `
        <tr>
          <td>${App.escapeHtml(r.name)}</td>
          <td>${App.escapeHtml(r.email)}</td>
          <td>${App.escapeHtml(r.phone || '\u2014')}</td>
          <td class="wrap-cell">${App.escapeHtml(r.subject || '\u2014')}</td>
          <td class="wrap-cell">${App.escapeHtml(r.message)}</td>
          <td>${r.handled ? '<span class="badge badge--ok">Handled</span>' : '<span class="badge badge--off">New</span>'}</td>
          <td>${App.formatDate(r.created_at)}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-toggle="${r.id}" data-handled="${r.handled}">${r.handled ? 'Reopen' : 'Mark handled'}</button>
            <button class="icon-btn danger" data-del="${r.id}">Delete</button>
          </div></td>
        </tr>`).join('');
      viewEl.innerHTML = `
        <div class="toolbar" style="display:flex;gap:10px;justify-content:flex-end;margin-bottom:12px">
          <button class="btn btn--ghost btn--sm" id="ct-export">Export CSV</button>
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Subject</th><th>Message</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="muted">No enquiries yet.</td></tr>'}</tbody>
        </table></div>`;
      const ctExport = document.getElementById('ct-export');
      if (ctExport) ctExport.addEventListener('click', () => {
        const cols = ['id', 'name', 'email', 'phone', 'subject', 'message', 'handled', 'created_at'];
        const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const csv = [cols.join(',')].concat((data.items || []).map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'enquiries-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
      });
      viewEl.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        await adminApi('/contacts/' + b.dataset.toggle, { method: 'PATCH', body: { handled: b.dataset.handled === '1' ? 0 : 1 } });
        App.toast('Updated', 'ok');
        renderContacts();
      }));
      viewEl.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this enquiry?')) return;
        await adminApi('/contacts/' + b.dataset.del, { method: 'DELETE' });
        App.toast('Deleted', 'ok');
        renderContacts();
      }));
    } catch (err) {
      viewEl.innerHTML = `<div class="empty">Could not load enquiries. ${App.escapeHtml(err.message)}</div>`;
    }
  }

  async function renderSubscribers() {
    const viewEl = document.getElementById('view');
    viewEl.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    try {
      const data = await adminApi('/subscribers');
      const rows = (data.items || []).map((r) => `<tr><td>${App.escapeHtml(r.email)}</td><td>${App.formatDate(r.created_at)}</td></tr>`).join('');
      viewEl.innerHTML = `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Email</th><th>Subscribed</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="2" class="muted">No subscribers yet.</td></tr>'}</tbody>
        </table></div>`;
    } catch (err) {
      viewEl.innerHTML = `<div class="empty">Could not load subscribers. ${App.escapeHtml(err.message)}</div>`;
    }
  }

  async function renderView(view) {
    state.view = view;
    document.getElementById('view-title').textContent = VIEWS[view] ? VIEWS[view].title : view;
    document.querySelectorAll('#admin-nav button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
    const newBtn = document.getElementById('new-btn');
    if (VIEWS[view] && VIEWS[view].endpoint) show(newBtn);
    else hide(newBtn);

    if (view === 'overview') {
      const viewEl = document.getElementById('view');
      viewEl.innerHTML = '<div class="skeleton" style="height:60px"></div>';
      try {
        viewEl.innerHTML = VIEWS.overview.render(await adminApi('/overview'));
      } catch (err) {
        viewEl.innerHTML = `<div class="empty">Could not load overview. ${App.escapeHtml(err.message)}</div>`;
      }
    } else if (view === 'bookings') {
      await renderBookings();
    } else if (view === 'contacts') {
      await renderContacts();
    } else if (view === 'subscribers') {
      await renderSubscribers();
    } else if (VIEWS[view] && VIEWS[view].endpoint) {
      await renderCrud(view);
    }
  }

  function wireNav() {
    document.getElementById('admin-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) renderView(btn.dataset.view);
    });
    document.getElementById('new-btn').addEventListener('click', () => {
      if (VIEWS[state.view] && VIEWS[state.view].endpoint) editorOpen(state.view, null);
    });
    document.getElementById('editor-close').addEventListener('click', editorClose);
    document.getElementById('editor-cancel').addEventListener('click', editorClose);
    document.getElementById('editor-save').addEventListener('click', editorSave);
    document.getElementById('editor-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'editor-backdrop') editorClose();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await App.creditsReady();
    wireLogin();
    wireLogout();
    wireNav();
    const ok = await checkSession();
    if (!ok) hide(document.getElementById('admin-console'));
  });
})();
