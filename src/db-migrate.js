'use strict';

/**
 * Destination detail columns — driver-agnostic migration.
 *
 * The reference site shows an "Overview" box on each destination detail page
 * (Country / Capital / Currency / Language / Best Time to Visit / Visa
 * Requirements). Those fields are added here so the destination page can render
 * that box.
 *
 * The module is intentionally tiny and idempotent: it asks the DRIVER for the
 * table's current column names and only ALTERs the columns that are missing, so
 * it is safe to run on every boot and on an already-populated database.
 *
 * It works with both drivers (`node:sqlite` locally, `pg` in production) because
 * it only uses the `columns()` / `run()` methods they both expose — there is no
 * PRAGMA or information_schema here.
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
 * @param {{columns: (t:string)=>Promise<string[]>, run: Function}} driver
 * @returns {Promise<string[]>} names of the columns that were actually created
 */
async function ensureDestinationColumns(driver) {
  const existing = new Set(await driver.columns('destinations'));
  const added = [];
  for (const [name, def] of DESTINATION_COLUMNS) {
    if (!existing.has(name)) {
      // `name` and `def` are fixed literals in this file (never user input), so
      // the interpolation below cannot be an injection vector. The column name
      // is additionally whitelisted against the same literal list.
      if (!/^[a-z_]+$/.test(name)) throw new Error('unsafe column name: ' + name);
      await driver.run(`ALTER TABLE destinations ADD COLUMN ${name} ${def}`);
      added.push(name);
    }
  }
  return added;
}

module.exports = { DESTINATION_COLUMNS, ensureDestinationColumns };
