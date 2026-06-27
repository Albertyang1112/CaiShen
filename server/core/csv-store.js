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

// Audit CSVs are write-only snapshots for the dev verification dashboard (/api/dev-verify,
// /api/dev-csv) — NOT inputs to any flow; the real data lives in transactions /
// source_transactions. They cost a DB write (and a full recompute, for statements/confirmed)
// on every sync/reconcile, so they're OFF unless DEBUG_AUDIT_CSV is set. Enable only when
// actively using those dev inspectors.
const auditCsvEnabled = () => /^(1|true|yes|on)$/i.test(process.env.DEBUG_AUDIT_CSV || '');

/** Upsert a CSV blob for a user under `key` (e.g. 'statements.csv'). No-op unless enabled. */
async function saveCsv(userId, key, text) {
  if (!auditCsvEnabled()) return;
  await dbQuery(
    `INSERT INTO user_kv (user_id, doc_key, text_data, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, doc_key) DO UPDATE SET text_data = EXCLUDED.text_data, data = NULL, updated_at = NOW()`,
    [userId, key, text]
  );
}

/** Rebuild statements.csv from the canonical source_transactions statement rows.
 *  The single statement CSV (period_year is redundant — it's in the date + source_file). */
async function refreshStatementsCsv(query, userId) {
  if (!auditCsvEnabled()) return 0;
  const r = await query(
    `SELECT txn_date::text AS date, description, amount, source_file
       FROM source_transactions
      WHERE user_id = $1 AND source = 'statement'
      ORDER BY txn_date, source_file`,
    [userId]
  );
  const text = csv.stringify(r.rows, ['date', 'description', 'amount', 'source_file']);
  await saveCsv(userId, 'statements.csv', text);
  return r.rows.length;
}

/**
 * Rebuild confirmed_transactions.csv — the reconciled ("confirmed") rows: each
 * statement transaction that was verified against a Plaid transaction (status
 * 'matched'). This is the Plaid ∩ statement intersection, with the match quality.
 */
async function refreshConfirmedCsv(query, userId) {
  if (!auditCsvEnabled()) return 0;
  const r = await query(
    `SELECT st.txn_date::text AS date, st.description, st.amount, st.source_file,
            sm.match_score, sm.name_sim, sm.date_delta_days, sm.plaid_txn_id
       FROM statement_matches sm
       JOIN source_transactions st ON st.id = sm.stmt_source_id AND st.user_id = sm.user_id
      WHERE sm.user_id = $1 AND sm.status = 'matched'
      ORDER BY st.txn_date, st.source_file`,
    [userId]
  );
  const text = csv.stringify(r.rows,
    ['date', 'description', 'amount', 'source_file', 'match_score', 'name_sim', 'date_delta_days', 'plaid_txn_id']);
  await saveCsv(userId, 'confirmed_transactions.csv', text);
  return r.rows.length;
}

module.exports = { saveCsv, refreshStatementsCsv, refreshConfirmedCsv };
