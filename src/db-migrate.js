'use strict';

/**
 * Destination detail columns.
 *
 * The reference site shows an "Overview" box on each destination detail page
 * (Country / Capital / Currency / Language / Best Time to Visit / Visa
 * Requirements). Those fields are added here so the destination page can render
 * that box.
 *
 * This module is intentionally tiny and idempotent: it inspects the existing
 * table with PRAGMA table_info and only ALTERs the columns that are missing, so
 * it is safe to run on every boot and on an already-populated database.
 */

const DESTINATION_COLUMNS = [
  ['country', "TEXT NOT NULL DEFAULT ''"],
  ['capital', "TEXT NOT NULL DEFAULT ''"],
  ['currency', "TEXT NOT NULL DEFAULT ''"],
  ['language', "TEXT NOT NULL DEFAULT ''"],
  ['best_time', "TEXT NOT NULL DEFAULT ''"],
  ['visa', "TEXT NOT NULL DEFAULT ''"]
];

/**
 * Add any missing columns to `destinations`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]} names of the columns that were actually created
 */
function ensureDestinationColumns(db) {
  const existing = new Set(
    db.prepare('PRAGMA table_info(destinations)').all().map((c) => c.name)
  );
  const added = [];
  for (const [name, def] of DESTINATION_COLUMNS) {
    if (!existing.has(name)) {
      // Column name + type are fixed literals here (never user input), so the
      // interpolation below cannot be an injection vector.
      db.exec(`ALTER TABLE destinations ADD COLUMN ${name} ${def}`);
      added.push(name);
    }
  }
  return added;
}

module.exports = { DESTINATION_COLUMNS, ensureDestinationColumns };
