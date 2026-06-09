'use strict';
/**
 * core/banking-store.js — DB-backed reads + write-through mirror for the two
 * high-volume banking entities (accounts, transactions).
 *
 * Transition design: writes still go through the JSON store, but writeData() calls
 * mirrorAccounts/mirrorTransactions so the structured tables stay current. Reads
 * (GET /accounts, GET /transactions) come from the tables — targeted, indexed,
 * scalable — instead of loading a whole JSON blob. Once every reader is on the DB,
 * the JSON writes get dropped and the mirror becomes the primary write path.
 */
const { query } = require('./db');

function accountClass(a) {
  if (a.source === 'crypto') return 'crypto';
  const t = (a.type || '').toLowerCase(), st = (a.subtype || '').toLowerCase();
  if (st.includes('mortgage')) return 'loan';
  if (t === 'depository') return 'bank';
  if (t === 'credit')     return 'card';
  if (t === 'loan')       return 'loan';
  if (t === 'investment') return 'investment';
  return 'bank';
}

// ── Reads (DB → the shape the app/frontend already expects) ──────────────────
async function listAccounts(userId) {
  const r = await query(`SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return r.rows.map(a => {
    const d = a.details || {};
    return {
      id: a.id, name: a.name, officialName: a.official_name,
      type: a.plaid_type, subtype: a.plaid_subtype,
      balance: a.current_balance == null ? null : Number(a.current_balance),
      availableBalance: a.available_balance == null ? null : Number(a.available_balance),
      institution: d.institution || null, last4: a.mask,
      currency: a.currency, source: a.source,
      lastUpdated: d.lastUpdated || null, createdAt: d.createdAt || null,
    };
  });
}

async function listTransactions(userId) {
  // The full original object lives in `data` JSONB → faithful for the app.
  const r = await query(`SELECT data FROM transactions WHERE user_id = $1 ORDER BY txn_date DESC NULLS LAST`, [userId]);
  return r.rows.map(row => row.data);
}

// ── Write-through mirror (full-replace; called from writeData at one choke point) ──
async function mirrorAccounts(userId, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  await query(`DELETE FROM accounts WHERE user_id = $1`, [userId]);
  for (const a of list) {
    let itemId = null;
    if (a.source === 'plaid' && a.institution) {
      const r = await query(`SELECT id FROM plaid_items WHERE user_id=$1 AND institution_name=$2 LIMIT 1`, [userId, a.institution]);
      if (r.rows.length) itemId = r.rows[0].id;
    }
    await query(
      `INSERT INTO accounts (id,user_id,plaid_item_id,source,account_class,plaid_type,plaid_subtype,name,official_name,mask,current_balance,available_balance,currency,details,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (id) DO UPDATE SET current_balance=EXCLUDED.current_balance, available_balance=EXCLUDED.available_balance,
         name=EXCLUDED.name, account_class=EXCLUDED.account_class, details=EXCLUDED.details, updated_at=NOW()`,
      [a.id, userId, itemId, a.source || 'manual', accountClass(a), a.type || null, a.subtype || null, a.name || null,
       a.officialName || null, a.last4 || null, a.balance ?? null, a.availableBalance ?? null, a.currency || 'USD',
       JSON.stringify({ institution: a.institution || null, lastUpdated: a.lastUpdated || null, createdAt: a.createdAt || null })]
    );
  }
}

async function mirrorTransactions(userId, txs) {
  const list = Array.isArray(txs) ? txs : [];
  await query(`DELETE FROM transactions WHERE user_id = $1`, [userId]);
  for (const t of list) {
    await query(
      `INSERT INTO transactions (id,user_id,account,txn_date,month,description,amount,category,plaid_category,institution,pending,source,data,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (id) DO UPDATE SET amount=EXCLUDED.amount, category=EXCLUDED.category, description=EXCLUDED.description, data=EXCLUDED.data, updated_at=NOW()`,
      [t.id, userId, t.account || null, t.date || null, t.month || null, t.desc || null, t.amount ?? null,
       t.category || null, t.plaidCategory || null, t.institution || null, !!t.pending, t.source || null, JSON.stringify(t)]
    );
  }
}

module.exports = { listAccounts, listTransactions, mirrorAccounts, mirrorTransactions };
