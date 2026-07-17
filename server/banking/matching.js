'use strict';
/**
 * banking/matching.js — the ONE place that writes the evidence bridge
 * (matched_transaction_sources): "this displayed transaction is backed by these
 * source_transactions rows, in these roles". Previously every caller hand-rolled the
 * same `INSERT … ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE`:
 * reconciler.js (bank_statement), receipt-store.js (receipt), receipt-match.js
 * (receipt/cash). They now all route through here, so the upsert shape, the conflict
 * key, and the role vocabulary live in a single module.
 *
 * Scope note: this owns the *evidence bridge* only. `statement_matches` stays as
 * reconciliation's own status ledger (it also tracks UNMATCHED state — stmt_only /
 * plaid_only / conflict — which the Banking badges read and which the bridge doesn't
 * model). matched_transaction_sources is the canonical "what backs this txn" table.
 *
 * `exec` is any function with the pg `(sql, params) => Promise` signature — pass
 * db.query for autocommit, or a client's `.query` (bound) to enlist in a transaction.
 */
const crypto = require('crypto');
const { pruneOrphanMatchSources } = require('../core/banking-store');

// The roles a source row can play for a displayed transaction. Free TEXT in the DB,
// but validated here so a typo can't silently create an unqueryable role.
const ROLES = new Set([
  'plaid',          // the displayed txn's own Plaid source row
  'bank_statement', // a parsed bank-statement line that corroborates it
  'receipt',        // an uploaded/where-sent receipt
  'check',          // a check image attached as proof of a payment
  'cash',           // a cash transaction's backing evidence
  'manual_csv',     // a user-imported CSV row (import-history)
  'manual_entry',   // a hand-entered transaction
  'legacy_csv',     // pre-remodel CSV provenance
  'quickbooks',     // a QuickBooks spreadsheet-import row (imports/importer.js)
]);

function assertRole(role) {
  if (!ROLES.has(role)) throw new Error(`matching: invalid source_role "${role}"`);
}

const UPSERT_TAIL =
  `ON CONFLICT (transaction_id, source_transaction_id) DO UPDATE SET
     source_role=EXCLUDED.source_role, match_confidence=EXCLUDED.match_confidence, updated_at=NOW()`;

/** Upsert a single evidence link. No-op (returns null) if either side is missing. */
async function linkSource(exec, userId, { transactionId, sourceTransactionId, sourceRole, confidence = null }) {
  assertRole(sourceRole);
  if (!transactionId || !sourceTransactionId) return null;
  await exec(
    `INSERT INTO matched_transaction_sources
       (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
     VALUES ($1,$2,$3,$4,$5,$6)
     ${UPSERT_TAIL}`,
    [crypto.randomUUID(), userId, transactionId, sourceTransactionId, sourceRole, confidence]
  );
  return sourceTransactionId;
}

/** Bulk upsert evidence links (chunked multi-row INSERTs). Returns # rows written. */
async function linkSourcesBulk(exec, userId, rows, { chunk = 100 } = {}) {
  const valid = (rows || []).filter(r => r && r.transactionId && r.sourceTransactionId);
  for (const r of valid) assertRole(r.sourceRole);
  for (let i = 0; i < valid.length; i += chunk) {
    const part   = valid.slice(i, i + chunk);
    const values = part.map((_, r) => `(${Array.from({ length: 6 }, (_, c) => '$' + (r * 6 + c + 1)).join(',')})`).join(',');
    const params = part.flatMap(r => [crypto.randomUUID(), userId, r.transactionId, r.sourceTransactionId, r.sourceRole, r.confidence ?? null]);
    await exec(
      `INSERT INTO matched_transaction_sources
         (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
       VALUES ${values}
       ${UPSERT_TAIL}`,
      params
    );
  }
  return valid.length;
}

/**
 * Replace every link of one role for a set of source rows, atomically on `client`:
 * clear the role's prior links for those source_transaction_ids, then bulk-insert the
 * new set. This is reconciliation's pattern (recompute a run's bank_statement links
 * without disturbing other roles or other rows). Caller supplies a transaction client.
 */
async function replaceRoleLinks(client, userId, sourceRole, sourceTransactionIds, rows, { chunk = 100 } = {}) {
  assertRole(sourceRole);
  await client.query(
    `DELETE FROM matched_transaction_sources
      WHERE user_id=$1 AND source_role=$2 AND source_transaction_id = ANY($3)`,
    [userId, sourceRole, sourceTransactionIds]
  );
  return linkSourcesBulk(client.query.bind(client), userId, rows, { chunk });
}

module.exports = { ROLES, linkSource, linkSourcesBulk, replaceRoleLinks, pruneOrphans: pruneOrphanMatchSources };
