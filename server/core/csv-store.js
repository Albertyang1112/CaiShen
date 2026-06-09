'use strict';
/**
 * core/csv-store.js — keep the extracted-data CSV artifacts in the database.
 *
 * Two CSVs, both stored per-user in user_kv (text_data):
 *   • plaid_transactions.csv — the raw Plaid pull (written by banking/plaid.js)
 *   • statements.csv         — rows extracted from bank-statement PDFs
 *
 * These are the auditable "source" snapshots the dev verification view compares the
 * displayed/used data against, so a parse or matching bug that swaps in the wrong
 * value is visible. The structured data itself lives in transactions / source_transactions.
 */
const { query: dbQuery } = require('./db');
const csv = require('./csv');

/** Upsert a CSV blob for a user under `key` (e.g. 'statements.csv'). */
async function saveCsv(userId, key, text) {
  await dbQuery(
    `INSERT INTO user_kv (user_id, doc_key, text_data, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, doc_key) DO UPDATE SET text_data = EXCLUDED.text_data, data = NULL, updated_at = NOW()`,
    [userId, key, text]
  );
}

/** Rebuild statements.csv from the canonical source_transactions statement rows. */
async function refreshStatementsCsv(query, userId) {
  const r = await query(
    `SELECT txn_date::text AS date, description, amount, source_file, period_year
       FROM source_transactions
      WHERE user_id = $1 AND source = 'statement'
      ORDER BY txn_date, source_file`,
    [userId]
  );
  const text = csv.stringify(r.rows, ['date', 'description', 'amount', 'source_file', 'period_year']);
  await saveCsv(userId, 'statements.csv', text);
  return r.rows.length;
}

module.exports = { saveCsv, refreshStatementsCsv };
