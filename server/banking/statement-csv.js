'use strict';
/**
 * statement-csv.js — Stage parsed bank-statement rows to a per-user CSV.
 *
 * Mirrors the Plaid CSV staging (plaid_transactions.csv): every reconciliation
 * run writes the exact statement rows it matched against to a CSV on disk, so
 * there is a uniform, eyeball-able audit source for BOTH sides of the Plaid-vs-
 * statement comparison. The dev verification dashboard validates the data the
 * Banking tab displays as "matched" against this file.
 *
 * The rows come straight from reconcileUser's source_transactions query, so the
 * CSV is guaranteed to equal the data actually used for matching.
 */
const csv = require('../core/csv');

const STMT_CSV     = 'statement_transactions.csv';
const STMT_COLUMNS = ['id', 'date', 'desc', 'amount'];

// Pure: statement rows → CSV text (header + one row each).
function statementCsv(rows) {
  const norm = (rows || []).map(r => ({
    id: r.id, date: r.date, desc: r.desc,
    amount: r.amount == null ? '' : r.amount,
  }));
  return csv.stringify(norm, STMT_COLUMNS);
}

// Side-effecting: write the per-user statement CSV via io.writeText (non-fatal).
// Audit-only snapshot — gated behind DEBUG_AUDIT_CSV like the other audit CSVs.
function stageStatementCsv(io, rows) {
  if (!/^(1|true|yes|on)$/i.test(process.env.DEBUG_AUDIT_CSV || '')) return;
  try { io.writeText(STMT_CSV, statementCsv(rows)); }
  catch (e) { console.error('[statement-csv] stage failed:', e.message); }
}

module.exports = { statementCsv, stageStatementCsv, STMT_CSV, STMT_COLUMNS };
