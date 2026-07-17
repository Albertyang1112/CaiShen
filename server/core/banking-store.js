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
const { query, withTransaction } = require('./db');

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
      type: a.plaid_type, subtype: a.plaid_subtype, accountClass: a.account_class,
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

// ── Write-through mirror (NON-DESTRUCTIVE; called from writeData at one choke point) ──
// Upsert every row in the canonical set (a stable id ⇒ an in-place UPDATE, no churn),
// then delete ONLY the ids that are no longer present (a genuine removal). This replaces
// the old DELETE-all + INSERT-all, which rewrote every row on every sync AND — because
// bank_account_periods.account_id / matched_transaction_sources etc. point here — fired
// ON DELETE CASCADE on the whole table each sync (wiping periods' finalized status and
// statement balances, which mirrorPlaid then re-created as 'open'). With the targeted
// delete, a cascade fires only when a row truly disappears. Runs atomically (BEGIN…COMMIT)
// so a concurrent GET never sees the table mid-rewrite (the old "Transactions (0)" bug).
//
// `list` is always the FULL accumulated set (store.write passes the whole accounts.json /
// transactions.json), so "delete ids not in list" removes only genuinely-gone rows and
// preserves out-of-Plaid-window history. An empty list still clears the table (the
// "removed the last account/txn" case) — `NOT (id = ANY('{}'))` is true for every row.
async function mirrorAccounts(userId, accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const ids  = list.map(a => a.id);
  await withTransaction(async (client) => {
    for (const a of list) {
      let itemId = null;
      if (a.source === 'plaid' && a.institution) {
        const r = await client.query(`SELECT id FROM plaid_items WHERE user_id=$1 AND institution_name=$2 LIMIT 1`, [userId, a.institution]);
        if (r.rows.length) itemId = r.rows[0].id;
      }
      await client.query(
        `INSERT INTO accounts (id,user_id,plaid_item_id,source,account_class,plaid_type,plaid_subtype,name,official_name,mask,current_balance,available_balance,currency,details,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (id) DO UPDATE SET plaid_item_id=EXCLUDED.plaid_item_id, source=EXCLUDED.source,
           account_class=EXCLUDED.account_class, plaid_type=EXCLUDED.plaid_type, plaid_subtype=EXCLUDED.plaid_subtype,
           name=EXCLUDED.name, official_name=EXCLUDED.official_name, mask=EXCLUDED.mask,
           current_balance=EXCLUDED.current_balance, available_balance=EXCLUDED.available_balance,
           currency=EXCLUDED.currency, details=EXCLUDED.details, updated_at=NOW()`,
        [a.id, userId, itemId, a.source || 'manual', accountClass(a), a.type || null, a.subtype || null, a.name || null,
         a.officialName || null, a.last4 || null, a.balance ?? null, a.availableBalance ?? null, a.currency || 'USD',
         JSON.stringify({ institution: a.institution || null, lastUpdated: a.lastUpdated || null, createdAt: a.createdAt || null })]
      );
    }
    // Remove only accounts that genuinely vanished (e.g. a reconnect that issued new ids).
    await client.query(`DELETE FROM accounts WHERE user_id = $1 AND NOT (id = ANY($2::text[]))`, [userId, ids]);
  });
}

async function mirrorTransactions(userId, txs) {
  const list = Array.isArray(txs) ? txs : [];
  const ids  = list.map(t => t.id);
  await withTransaction(async (client) => {
    for (const t of list) {
      await client.query(
        `INSERT INTO transactions (id,user_id,account,txn_date,month,description,amount,category,plaid_category,institution,pending,source,data,
           merchant_name,merchant_entity_id,payment_channel,category_detailed,category_confidence,authorized_date,currency,logo_url,website,
           transaction_type,transaction_code,check_number,account_owner,location_city,location_region,location_address,location_postal_code,
           location_country,location_store_number,counterparty_name,counterparty_type,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,NOW())
         ON CONFLICT (id) DO UPDATE SET account=EXCLUDED.account, txn_date=EXCLUDED.txn_date, month=EXCLUDED.month,
           description=EXCLUDED.description, amount=EXCLUDED.amount, category=EXCLUDED.category,
           plaid_category=EXCLUDED.plaid_category, institution=EXCLUDED.institution, pending=EXCLUDED.pending,
           source=EXCLUDED.source, data=EXCLUDED.data,
           merchant_name=EXCLUDED.merchant_name, merchant_entity_id=EXCLUDED.merchant_entity_id, payment_channel=EXCLUDED.payment_channel,
           category_detailed=EXCLUDED.category_detailed, category_confidence=EXCLUDED.category_confidence, authorized_date=EXCLUDED.authorized_date,
           currency=EXCLUDED.currency, logo_url=EXCLUDED.logo_url, website=EXCLUDED.website, transaction_type=EXCLUDED.transaction_type,
           transaction_code=EXCLUDED.transaction_code, check_number=EXCLUDED.check_number, account_owner=EXCLUDED.account_owner,
           location_city=EXCLUDED.location_city, location_region=EXCLUDED.location_region, location_address=EXCLUDED.location_address,
           location_postal_code=EXCLUDED.location_postal_code, location_country=EXCLUDED.location_country,
           location_store_number=EXCLUDED.location_store_number, counterparty_name=EXCLUDED.counterparty_name,
           counterparty_type=EXCLUDED.counterparty_type, updated_at=NOW()`,
        [t.id, userId, t.account || null, t.date || null, t.month || null, t.desc || null, t.amount ?? null,
         t.category || null, t.plaidCategory || null, t.institution || null, !!t.pending, t.source || null, JSON.stringify(t),
         t.merchantName || null, t.merchantEntityId || null, t.paymentChannel || null, t.plaidDetailed || null, t.pfcConfidence || null,
         t.authorizedDate || null, t.currency || null, t.logoUrl || null, t.website || null, t.transactionType || null,
         t.transactionCode || null, t.checkNumber || null, t.accountOwner || null, t.locCity || null, t.locRegion || null,
         t.locAddress || null, t.locPostal || null, t.locCountry || null, t.locStore || null, t.cpName || null, t.cpType || null]
      );
    }
    // Remove only transactions no longer in the canonical set (settled-pending prune,
    // disconnect, manual delete). History outside Plaid's window is in `list`, so kept.
    await client.query(`DELETE FROM transactions WHERE user_id = $1 AND NOT (id = ANY($2::text[]))`, [userId, ids]);
  });
}

// Drop evidence links (matched_transaction_sources) whose DISPLAYED transaction no longer
// exists. transaction_id is a deliberate soft ref (not a DB FK) because the display layer
// is rebuilt from JSON; with the non-destructive mirror those ids are now stable across
// syncs, so the only orphans are genuine removals (a disconnected institution's txns).
// source_transaction_id orphans are already handled by its real ON DELETE CASCADE FK.
async function pruneOrphanMatchSources(userId) {
  const r = await query(
    `DELETE FROM matched_transaction_sources mts
      WHERE mts.user_id = $1 AND mts.transaction_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = mts.transaction_id AND t.user_id = $1)`,
    [userId]
  );
  return r.rowCount || 0;
}

module.exports = { listAccounts, listTransactions, mirrorAccounts, mirrorTransactions, pruneOrphanMatchSources };
