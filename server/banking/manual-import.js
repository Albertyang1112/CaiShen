'use strict';
/**
 * banking/manual-import.js — route user-imported CSV rows (the /api/import-history path)
 * into the universal intake, so manual CSV is a first-class source alongside plaid /
 * statement / receipt instead of writing straight to the display layer with no provenance.
 *
 * The imported row IS the displayed transaction (the route still writes transactions.json),
 * so here we only ADD the audit trail:
 *   1. a source_transactions row per imported txn (source='manual_csv');
 *   2. an evidence link (role 'manual_csv') from the display txn → that source row,
 *      via the centralized matching engine.
 *
 * Best-effort + idempotent: deterministic source id (`mcsv_{displayId}`), a per-row
 * source_hash (includes the display id so identical-looking rows never collide on the
 * source_transactions dedup index), ON CONFLICT (id) DO UPDATE.
 */
const crypto = require('crypto');
const { findOrCreatePeriod } = require('./periods');
const matching = require('./matching');

const MANUAL_SOURCE = 'manual_csv';

// rows: the freshly-added display transactions ({ id, date, desc, amount, account }).
async function recordManualCsvRows(query, userId, rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const sourceFile = opts.sourceFile || 'import-history';
  // FK-safe account set — only attach account_id to a real accounts row.
  const accts = new Set((await query(`SELECT id FROM accounts WHERE user_id=$1`, [userId])).rows.map(r => r.id));

  let n = 0;
  for (const t of rows) {
    const accountId  = t.account && accts.has(t.account) ? t.account : null;
    const date       = t.date || null;
    const year       = date ? (Number(String(date).slice(0, 4)) || null) : null;
    let periodId = null;
    if (date) { try { periodId = await findOrCreatePeriod(query, userId, accountId, date); } catch {} }

    const srcId      = `mcsv_${t.id}`;
    const amount     = t.amount == null ? null : Number(t.amount);
    const sourceHash = crypto.createHash('sha256')
      .update(`${userId}|manual_csv|${t.id}|${date}|${amount}|${t.desc || ''}`).digest('hex');

    await query(
      `INSERT INTO source_transactions
         (id,user_id,source,source_file,period_year,account_id,bank_account_period_id,
          txn_date,description,merchant_name,amount,source_hash,raw)
       VALUES ($1,$2,'manual_csv',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         account_id=COALESCE(EXCLUDED.account_id, source_transactions.account_id),
         bank_account_period_id=COALESCE(EXCLUDED.bank_account_period_id, source_transactions.bank_account_period_id),
         txn_date=EXCLUDED.txn_date, description=EXCLUDED.description, amount=EXCLUDED.amount, raw=EXCLUDED.raw`,
      [srcId, userId, sourceFile, year, accountId, periodId, date, t.desc || null, null, amount, sourceHash, JSON.stringify(t)]
    );
    await matching.linkSource(query, userId, {
      transactionId: t.id, sourceTransactionId: srcId, sourceRole: MANUAL_SOURCE, confidence: 1.0,
    });
    n++;
  }
  return n;
}

module.exports = { recordManualCsvRows, MANUAL_SOURCE };
