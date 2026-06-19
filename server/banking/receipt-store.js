'use strict';
/**
 * banking/receipt-store.js — Increment 3d (remodel write-flow for receipts).
 *
 * recordReceiptRemodel(query, { userId, receiptId, txnId, txn, ocrData, matchScore })
 *   Wires a just-attached receipt into the remodel structure:
 *     1. enriches the receipts row with structured columns (account, period, merchant,
 *        date, total, parser_status) — promoted out of ocr_data;
 *     2. (re)creates receipt_items from the OCR line items;
 *     3. writes a source_transactions row (source='receipt', spending → negative);
 *     4. links it to the transaction it backs via matched_transaction_sources
 *        (role 'receipt') so the UI can show "has receipt support".
 *
 * Best-effort: the caller wraps this in try/catch — the receipt itself is already
 * saved, so a remodel hiccup must never fail the upload. Idempotent: deterministic
 * source-txn id (`rcptxn_{receiptId}`) + receipt_items rebuilt by receipt_id.
 */
const crypto = require('crypto');
const { findOrCreatePeriod } = require('./periods');

async function recordReceiptRemodel(query, { userId, receiptId, txnId, txn, ocrData, matchScore = null }) {
  // FK-safe account: only when the attached transaction's account is a real row.
  let accountId = null;
  if (txn && txn.account) {
    const a = await query(`SELECT 1 FROM accounts WHERE id=$1 AND user_id=$2`, [txn.account, userId]);
    if (a.rows.length) accountId = txn.account;
  }
  const date     = (ocrData && ocrData.date) || (txn && txn.date) || null;
  const merchant = (ocrData && ocrData.merchant) || null;
  const total    = (ocrData && ocrData.total != null) ? Number(ocrData.total) : null;

  let periodId = null;
  if (date) { try { periodId = await findOrCreatePeriod(query, userId, accountId, date); } catch {} }

  // 1. Enrich the receipts row.
  await query(
    `UPDATE receipts SET account_id=$1, bank_account_period_id=$2, merchant_name=$3,
        receipt_date=$4, total_amount=$5, parser_status='parsed'
      WHERE id=$6 AND user_id=$7`,
    [accountId, periodId, merchant, date, total, receiptId, userId]
  );

  // 2. receipt_items — rebuilt from OCR line items (idempotent by receipt_id).
  await query(`DELETE FROM receipt_items WHERE receipt_id=$1`, [receiptId]);
  const items = Array.isArray(ocrData && ocrData.items) ? ocrData.items : [];
  for (const it of items) {
    if (!it || (it.desc == null && it.amount == null)) continue;
    await query(
      `INSERT INTO receipt_items (id, receipt_id, item_name, total_price)
       VALUES ($1,$2,$3,$4)`,
      [`ritem_${receiptId}_${crypto.randomBytes(4).toString('hex')}`, receiptId,
       it.desc || null, (it.amount == null ? null : Number(it.amount))]
    );
  }

  // 3. source_transactions row (spending → negative amount).
  const stId       = `rcptxn_${receiptId}`;
  const amount     = total == null ? null : -Math.abs(total);
  const sourceHash = crypto.createHash('sha256').update(`${userId}|receipt|${receiptId}`).digest('hex');
  const year       = date ? (Number(String(date).slice(0, 4)) || null) : null;
  await query(
    `INSERT INTO source_transactions
       (id,user_id,source,source_file,period_year,account_id,bank_account_period_id,receipt_id,
        txn_date,description,merchant_name,amount,source_hash,raw)
     VALUES ($1,$2,'receipt',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       account_id=EXCLUDED.account_id, bank_account_period_id=EXCLUDED.bank_account_period_id,
       receipt_id=EXCLUDED.receipt_id, txn_date=EXCLUDED.txn_date, description=EXCLUDED.description,
       merchant_name=EXCLUDED.merchant_name, amount=EXCLUDED.amount, raw=EXCLUDED.raw`,
    [stId, userId, null, year, accountId, periodId, receiptId,
     date, merchant, merchant, amount, sourceHash, JSON.stringify(ocrData || {})]
  );

  // 4. Evidence link to the transaction it backs (role 'receipt').
  if (txnId) {
    await query(
      `INSERT INTO matched_transaction_sources
         (id,user_id,transaction_id,source_transaction_id,source_role,match_confidence)
       VALUES ($1,$2,$3,$4,'receipt',$5)
       ON CONFLICT (transaction_id, source_transaction_id)
         DO UPDATE SET match_confidence=EXCLUDED.match_confidence, updated_at=NOW()`,
      [crypto.randomUUID(), userId, txnId, stId, matchScore]
    );
  }
  return stId;
}

module.exports = { recordReceiptRemodel };
