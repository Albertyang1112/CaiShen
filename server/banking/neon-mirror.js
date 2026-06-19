// neon-mirror.js — mirror per-user transaction rows into the Neon
// source_transactions audit table. Idempotent upsert by id, so re-syncs never
// duplicate. Best-effort: callers wrap in try/catch so a DB hiccup never breaks a sync.
//
// Increment 3 (remodel write-flow): each Plaid row now also carries its remodel
// provenance — external_transaction_id (= the Plaid txn id, drives the dedup index),
// account_id (FK, only when the account exists), source_hash, merchant/category, and
// its month's bank_account_period (find-or-created here so live activity lands in the
// same period a statement already established).
const { query } = require('../core/db');
const crypto = require('crypto');
const { periodIdFor, findOrCreatePeriod } = require('./periods');

const plaidSourceHash = (userId, txnId) =>
  crypto.createHash('sha256').update(`${userId}|plaid|${txnId}`).digest('hex');

async function mirrorPlaid(userId, txs) {
  const rows = (txs || []).filter(t => t.source === 'plaid');
  if (!rows.length) return 0;

  // FK guard: only set account_id to an account that actually exists (a re-sync after a
  // reconnect can reference an old account id that's no longer in the accounts table).
  const acctRes = await query(`SELECT id FROM accounts WHERE user_id = $1`, [userId]);
  const validAccts = new Set(acctRes.rows.map(r => r.id));

  const seenPeriods = new Set();
  let n = 0;
  for (const t of rows) {
    const accountId = t.account && validAccts.has(t.account) ? t.account : null;
    const year = t.date ? (Number(String(t.date).slice(0, 4)) || null) : null;

    // Find-or-create the month's period once per (account, month) per call.
    let periodId = periodIdFor(userId, accountId, t.date);
    if (periodId && !seenPeriods.has(periodId)) {
      try { await findOrCreatePeriod(query, userId, accountId, t.date); seenPeriods.add(periodId); }
      catch (e) { periodId = null; }   // never let a period hiccup drop the transaction
    }

    await query(
      `INSERT INTO source_transactions
         (id, user_id, source, source_file, period_year, account, account_id,
          external_transaction_id, bank_account_period_id, txn_date, description,
          merchant_name, amount, category, source_hash, raw, ingested_at)
       VALUES ($1,$2,'plaid','plaid_transactions.csv',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (id) DO UPDATE SET
         amount=EXCLUDED.amount, description=EXCLUDED.description, merchant_name=EXCLUDED.merchant_name,
         txn_date=EXCLUDED.txn_date, account=EXCLUDED.account, account_id=EXCLUDED.account_id,
         external_transaction_id=EXCLUDED.external_transaction_id,
         bank_account_period_id=COALESCE(EXCLUDED.bank_account_period_id, source_transactions.bank_account_period_id),
         category=EXCLUDED.category, source_hash=EXCLUDED.source_hash,
         raw=EXCLUDED.raw, ingested_at=NOW()`,
      [t.id, userId, year, t.account || null, accountId,
       t.id, periodId, t.date || null, t.desc || null,
       t.desc || null, (t.amount == null ? null : Number(t.amount)), t.category || null,
       plaidSourceHash(userId, t.id), JSON.stringify(t)]
    );
    n++;
  }
  return n;
}

// Prune pending rows that a posted transaction has since replaced. When a pending charge
// settles, Plaid re-issues it under a new id (its pending_transaction_id points back at
// the pending one); stageAndImport drops the pending twin from transactions.json, and this
// clears the matching audit row so period counts / reconciliation stop seeing it. Scoped
// to source='plaid' (statement/receipt rows untouched); any matched_transaction_sources
// rows pointing at a deleted row cascade-delete via FK. Idempotent: a no-op once pruned.
async function deleteSupersededPending(userId, pendingIds) {
  const ids = [...new Set((pendingIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const r = await query(
    `DELETE FROM source_transactions
      WHERE user_id = $1 AND source = 'plaid' AND id = ANY($2::text[])`,
    [userId, ids]
  );
  return r.rowCount || 0;
}

module.exports = { mirrorPlaid, deleteSupersededPending };
