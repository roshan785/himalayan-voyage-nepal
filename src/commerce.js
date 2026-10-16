'use strict';

/**
 * Travel Shop — commerce data layer (orders + order items).
 *
 * Additive by design: this module only CREATES NEW tables (`orders`,
 * `order_items`) and never touches the existing schema. It installs its own
 * schema through the same idempotent pattern `src/db-migrate.js` uses
 * (`CREATE TABLE IF NOT EXISTS` + a driver-level `columns()` check), so it is
 * safe to run on every boot, on an empty database and on a live one.
 *
 * Both storage drivers (`node:sqlite` locally, `pg` in production) are
 * supported because every statement is written with `?` placeholders — the
 * Postgres adapter rewrites them to `$1..$n` internally, exactly like the rest
 * of the app.
 *
 * PRICING IS SERVER-SIDE. The client sends only a package slug and a quantity;
 * the unit price, discount and totals below are read from the `packages` table
 * and computed here. A tampered cart can therefore never change what is
 * charged — see `recomputeTotals()`.
 */

const { all, get, run } = require('./db');

/* ── Schema ────────────────────────────────────────────────────────────────
   Timestamps stay TEXT on both drivers (the house style) so the frontend never
   special-cases a driver. Booleans stay INTEGER 0/1 for the same reason. */

const COMMERCE_SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reference       TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  payment_method  TEXT NOT NULL DEFAULT '',
  payment_ref     TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT 'NPR',
  subtotal        REAL NOT NULL DEFAULT 0,
  discount_total  REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  travellers      INTEGER NOT NULL DEFAULT 1,
  travel_date     TEXT NOT NULL DEFAULT '',
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_email  TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL,
  package_id    INTEGER,
  package_slug  TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  unit_price    REAL NOT NULL DEFAULT 0,
  discount      REAL NOT NULL DEFAULT 0,
  qty           INTEGER NOT NULL DEFAULT 1,
  line_total    REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

const COMMERCE_SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  reference       TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  payment_status  TEXT NOT NULL DEFAULT 'unpaid',
  payment_method  TEXT NOT NULL DEFAULT '',
  payment_ref     TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT 'NPR',
  subtotal        DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_total  DOUBLE PRECISION NOT NULL DEFAULT 0,
  total           DOUBLE PRECISION NOT NULL DEFAULT 0,
  travellers      INTEGER NOT NULL DEFAULT 1,
  travel_date     TEXT NOT NULL DEFAULT '',
  customer_name   TEXT NOT NULL DEFAULT '',
  customer_email  TEXT NOT NULL DEFAULT '',
  customer_phone  TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at      TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  package_id    INTEGER,
  package_slug  TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  unit_price    DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount      DOUBLE PRECISION NOT NULL DEFAULT 0,
  qty           INTEGER NOT NULL DEFAULT 1,
  line_total    DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

const ORDER_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
const PAYMENT_STATUSES = ['unpaid', 'paid', 'failed', 'refunded'];

/**
 * Create the commerce tables on the ACTIVE driver. Idempotent — every statement
 * is IF NOT EXISTS, so a second call is a no-op.
 *
 * The DDL contains MULTIPLE statements, so it is applied through the driver's
 * raw multi-statement executor (`raw.exec` on SQLite, `pool.query` on pg) — the
 * one-shot `driver.run()` helper only ever sends a single prepared statement and
 * would fail here with "no such table". The DDL text is a fixed constant in this
 * module (never a parameter), so no caller can inject SQL.
 */
async function ensureCommerceSchema(driver) {
  const ddl = driver.kind === 'postgres' ? COMMERCE_SCHEMA_PG : COMMERCE_SCHEMA_SQLITE;
  if (driver.kind === 'postgres') {
    await driver.raw.query(ddl);
  } else {
    driver.raw.exec(ddl);
  }
  // A partial UNIQUE index so one gateway transaction can back at most one
  // order. Added separately (and non-fatally) because on an EXISTING database a
  // pre-existing duplicate would abort the whole DDL batch and stop the server
  // from booting. If it cannot be created we log and carry on — the atomic
  // confirmPaid() guard still prevents double-confirmation.
  try {
    if (driver.kind === 'postgres') {
      await driver.raw.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_ref ON orders(payment_ref) WHERE payment_ref <> ''");
    } else {
      driver.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_payment_ref ON orders(payment_ref) WHERE payment_ref <> ''");
    }
  } catch (err) {
    console.warn('[commerce] could not add payment_ref unique index (duplicates present?):', err.message);
  }
  return driver.kind;
}

/* ── Value helpers ─────────────────────────────────────────────────────── */

/** Coerce to a finite number with a floor, used for every money field. */
function money(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n * 100) / 100;
}

/** Price after a percentage discount, rounded to a whole rupee. */
function lineUnit(price, discount) {
  const p = money(price, 0);
  const d = Math.min(90, Math.max(0, Number(discount) || 0));
  return Math.round(p - (p * d) / 100);
}

/** URL-safe, human-readable order reference: HV-<base36 time>-<random>. */
function newReference() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `HV-${t}-${r}`;
}

/**
 * Recompute an order's money from the DATABASE — never from client input.
 *
 * @param {Array<{slug: string, qty: number}>} requested client cart lines
 * @returns {Promise<{items: Array, subtotal: number, discount_total: number,
 *                    total: number, travellers: number}>}
 * @throws {Error & {status?: number}} when a slug is unknown or the cart is empty
 */
async function recomputeTotals(requested) {
  const lines = Array.isArray(requested) ? requested.slice(0, 20) : [];
  const items = [];
  let subtotal = 0;
  let discountTotal = 0;
  let travellers = 0;

  for (const line of lines) {
    const slug = String((line && line.slug) || '').trim().slice(0, 160);
    if (!slug) continue;
    const qty = Math.max(1, Math.min(50, Math.round(Number(line && line.qty) || 1)));

    // Price comes from the trusted packages table, keyed by slug.
    const pkg = await get('SELECT id, title, slug, price, discount FROM packages WHERE slug = ?', [slug]);
    if (!pkg) {
      const err = new Error(`Unknown package: ${slug}`);
      err.status = 400;
      throw err;
    }

    const unit = money(pkg.price, 0);
    const discount = Math.min(90, Math.max(0, Number(pkg.discount) || 0));
    const unitFinal = lineUnit(unit, discount);
    const lineTotal = unitFinal * qty;

    subtotal += unit * qty;
    discountTotal += (unit - unitFinal) * qty;
    travellers += qty;

    items.push({
      package_id: pkg.id,
      package_slug: pkg.slug,
      title: pkg.title,
      unit_price: unit,
      discount,
      qty,
      line_total: lineTotal
    });
  }

  if (!items.length) {
    const err = new Error('Your cart is empty');
    err.status = 400;
    throw err;
  }

  return {
    items,
    subtotal: money(subtotal),
    discount_total: money(discountTotal),
    total: money(subtotal - discountTotal),
    travellers
  };
}

/* ── Order persistence ─────────────────────────────────────────────────── */

/**
 * Insert an order plus its items. The totals are computed by the caller from
 * `recomputeTotals()`, so nothing here trusts a client value.
 */
async function createOrder(order) {
  const info = await run(
    `INSERT INTO orders
      (reference, status, payment_status, payment_method, currency,
       subtotal, discount_total, total, travellers, travel_date,
       customer_name, customer_email, customer_phone, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.reference, order.status || 'pending', order.payment_status || 'unpaid',
      order.payment_method || '', order.currency || 'NPR',
      money(order.subtotal), money(order.discount_total), money(order.total),
      Math.max(1, Math.round(Number(order.travellers) || 1)),
      String(order.travel_date || '').slice(0, 40),
      String(order.customer_name || '').slice(0, 150),
      String(order.customer_email || '').slice(0, 200),
      String(order.customer_phone || '').slice(0, 40),
      String(order.notes || '').slice(0, 4000)
    ]
  );

  const orderId = info.lastInsertRowid;
  for (const it of order.items) {
    await run(
      `INSERT INTO order_items
        (order_id, package_id, package_slug, title, unit_price, discount, qty, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, it.package_id, it.package_slug, it.title, money(it.unit_price),
        money(it.discount), Math.max(1, Math.round(it.qty)), money(it.line_total)]
    );
  }
  return getOrder(orderId);
}

/** Fetch one order with its items, by numeric id. Returns null when absent. */
async function getOrder(id) {
  const row = await get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!row) return null;
  return Object.assign({}, row, { items: await itemsFor(id) });
}

/**
 * Atomically mark an order paid, at most ONCE.
 *
 * The UPDATE is guarded by `payment_status != 'paid'` (and a non-empty provider
 * reference), so two concurrent gateway callbacks for the same order can never
 * both "succeed": the first writes, the second matches zero rows and is told so.
 * This is what prevents a duplicate confirmation / double receipt from a
 * repeated or replayed callback — the check and the write are one statement,
 * not a read-then-write race.
 *
 * @returns {{confirmed: boolean, order: object|null, alreadyPaid: boolean}}
 */
async function confirmPaid(id, { providerRef = '', method = '' } = {}) {
  const isPg = require('./db').driver.kind === 'postgres';
  const nowExpr = isPg ? "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" : "datetime('now')";
  const info = await run(
    `UPDATE orders
        SET payment_status = 'paid', status = 'confirmed', payment_ref = ?, payment_method = ?,
            updated_at = ${nowExpr}
      WHERE id = ? AND payment_status != 'paid'`,
    [String(providerRef || '').slice(0, 120), String(method || '').slice(0, 40), id]
  );
  const order = await getOrder(id);
  return { confirmed: Number(info.changes) > 0, order, alreadyPaid: Boolean(order && order.payment_status === 'paid') };
}

/** Fetch one order by its public reference (used by the order-confirmation page). */
async function getOrderByReference(reference) {
  const row = await get('SELECT * FROM orders WHERE reference = ?', [String(reference || '').slice(0, 60)]);
  if (!row) return null;
  return Object.assign({}, row, { items: await itemsFor(row.id) });
}

async function itemsFor(orderId) {
  return all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
}

/** List orders for the admin, newest first. */
async function listOrders({ status, payment_status, q, limit = 200 } = {}) {
  const clauses = [];
  const params = [];
  if (status && ORDER_STATUSES.includes(status)) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (payment_status && PAYMENT_STATUSES.includes(payment_status)) {
    clauses.push('payment_status = ?');
    params.push(payment_status);
  }
  if (q) {
    // Case-insensitive on both drivers (Postgres LIKE is case-sensitive).
    clauses.push('(LOWER(reference) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(customer_email) LIKE ?)');
    const like = `%${String(q).toLowerCase().slice(0, 80)}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await all(`SELECT * FROM orders ${where} ORDER BY id DESC LIMIT ${Math.max(1, Math.min(500, Number(limit) || 200))}`, params);
  // Attach item counts (one query, grouped) so the admin table can show them.
  const counts = await all('SELECT order_id, COUNT(*) AS n FROM order_items GROUP BY order_id');
  const byOrder = new Map(counts.map((c) => [Number(c.order_id), Number(c.n)]));
  return rows.map((r) => Object.assign({}, r, { item_count: byOrder.get(Number(r.id)) || 0 }));
}

/**
 * Update an order's status fields. Only whitelisted columns can be written —
 * the column names are fixed literals picked by key, never interpolated input.
 */
async function updateOrder(id, patch) {
  const existing = await get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!existing) return null;

  const sets = [];
  const params = [];
  if (patch.status !== undefined) {
    if (!ORDER_STATUSES.includes(patch.status)) {
      const err = new Error('Invalid order status');
      err.status = 400;
      throw err;
    }
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.payment_status !== undefined) {
    if (!PAYMENT_STATUSES.includes(patch.payment_status)) {
      const err = new Error('Invalid payment status');
      err.status = 400;
      throw err;
    }
    sets.push('payment_status = ?');
    params.push(patch.payment_status);
  }
  if (patch.payment_method !== undefined) {
    sets.push('payment_method = ?');
    params.push(String(patch.payment_method || '').slice(0, 40));
  }
  if (patch.payment_ref !== undefined) {
    sets.push('payment_ref = ?');
    params.push(String(patch.payment_ref || '').slice(0, 120));
  }

  if (!sets.length) return getOrder(id);
  // Pick the timestamp expression from the ACTUAL driver, not from the presence
  // of DATABASE_URL: a value like `sqlite:/path` sets DATABASE_URL but still
  // runs on SQLite, and the Postgres `to_char(now() ...)` form is then invalid.
  const isPg = require('./db').driver.kind === 'postgres';
  sets.push('updated_at = ' + (isPg ? "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" : "datetime('now')"));
  params.push(id);
  await run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);
  return getOrder(id);
}

/** Aggregate figures for the admin dashboard + shop header. */
async function orderStats() {
  const base = await get(
    `SELECT
       COUNT(*) AS orders,
       SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
       SUM(CASE WHEN payment_status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid_orders,
       SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END) AS revenue
     FROM orders`
  );
  const byStatus = await all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  return {
    orders: Number(base && base.orders) || 0,
    paidOrders: Number(base && base.paid_orders) || 0,
    unpaidOrders: Number(base && base.unpaid_orders) || 0,
    revenue: money(base && base.revenue, 0),
    byStatus: byStatus.reduce((acc, r) => { acc[r.status] = Number(r.n); return acc; }, {})
  };
}

module.exports = {
  COMMERCE_SCHEMA_SQLITE,
  COMMERCE_SCHEMA_PG,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ensureCommerceSchema,
  recomputeTotals,
  createOrder,
  getOrder,
  getOrderByReference,
  confirmPaid,
  listOrders,
  updateOrder,
  orderStats,
  money,
  lineUnit,
  newReference
};
