'use strict';
// Diagnostic: show the latest receipt(s) for a user + items + storage + source row.
// Usage: node server/scripts/receipt-info.js [userId]
require('./_env');
const { query } = require('../core/db');

(async () => {
  const userId = process.argv[2] || '1781913882747';
  const r = await query(
    `SELECT id, txn_id, file_path, doc_id, original_name, mime_type, match_status, match_flags,
            merchant_name, receipt_date, total_amount, tax_amount, tip_amount, payment_method,
            parser_status, account_id, bank_account_period_id, ocr_data, created_at
       FROM receipts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  if (!r.rows[0]) { console.log('No receipts for user', userId); process.exit(0); }
  const rec = r.rows[0];
  console.log('=== receipts row ===');
  console.log(JSON.stringify(rec, null, 2));

  console.log('\n=== receipt_items ===');
  const items = await query(
    `SELECT item_name, quantity, unit_price, total_price, category FROM receipt_items WHERE receipt_id=$1 ORDER BY id`, [rec.id]);
  console.log(`count=${items.rows.length}`);
  console.log(JSON.stringify(items.rows, null, 2));

  console.log('\n=== storage ===');
  if (rec.doc_id) {
    const d = await query(`SELECT id, storage_bucket, storage_key, size_bytes, sha256, mime_type, doc_type FROM documents WHERE id=$1`, [rec.doc_id]);
    console.log('R2 document row:', JSON.stringify(d.rows[0] || null, null, 2));
  } else {
    console.log('No doc_id → disk fallback. file_path =', rec.file_path);
  }

  console.log('\n=== source_transactions (receipt-sourced) ===');
  const st = await query(`SELECT id, source, amount, txn_date, merchant_name, receipt_id FROM source_transactions WHERE receipt_id=$1`, [rec.id]);
  console.log(JSON.stringify(st.rows, null, 2));
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
