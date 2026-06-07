// neon-mirror.js — mirror per-user transaction rows into the Neon
// source_transactions audit table (Phase 0). Idempotent upsert by id, so
// re-syncs never duplicate. Best-effort: callers wrap in try/catch so a DB
// hiccup never breaks a sync.
const { query } = require('./db');

async function mirrorPlaid(userId, txs) {
  const rows = (txs || []).filter(t => t.source === 'plaid');
  let n = 0;
  for (const t of rows) {
    const year = t.date ? (Number(String(t.date).slice(0, 4)) || null) : null;
    await query(
      `INSERT INTO source_transactions
         (id, user_id, source, source_file, period_year, account, txn_date, description, amount, raw, ingested_at)
       VALUES ($1,$2,'plaid','plaid_transactions.csv',$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (id) DO UPDATE SET
         amount=EXCLUDED.amount, description=EXCLUDED.description,
         txn_date=EXCLUDED.txn_date, account=EXCLUDED.account,
         raw=EXCLUDED.raw, ingested_at=NOW()`,
      [t.id, userId, year, t.account || null, t.date || null, t.desc || null,
       (t.amount == null ? null : Number(t.amount)), JSON.stringify(t)]
    );
    n++;
  }
  return n;
}

module.exports = { mirrorPlaid };
