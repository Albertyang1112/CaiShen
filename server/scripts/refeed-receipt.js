'use strict';
// Diagnostic: list recent receipts, or refeed one stored image back through the REAL OCR
// pipeline (layer 1 EXIF/normalize + layer 2 rotation sweep) to see what Groq reads now.
//   node server/scripts/refeed-receipt.js                -> list the last 10 receipts
//   node server/scripts/refeed-receipt.js <receiptId>    -> refeed that receipt's image
require('./_env');
const { query } = require('../core/db');
const { getDocumentBytes } = require('../core/documents');
const { ocrReceipt } = require('../banking/receipt-ocr');

const USER = process.env.REFEED_USER || '1781913882747';

(async () => {
  const id = process.argv[2];

  if (!id) {
    const r = await query(
      `SELECT id, merchant_name, total_amount, receipt_date, doc_id, txn_id, mime_type,
              left(file_sha256, 12) AS sha, created_at
         FROM receipts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [USER]);
    console.log('Recent receipts for', USER, '(newest first):\n');
    for (const x of r.rows) {
      console.log(`${x.id}  |  ${x.merchant_name || '(no merchant)'}  $${x.total_amount}  ${x.receipt_date || ''}`);
      console.log(`   sha=${x.sha}  txn=${x.txn_id || '-'}  doc=${x.doc_id || '-'}  ${x.mime_type || ''}  @ ${x.created_at}`);
    }
    process.exit(0);
  }

  const r = await query(
    `SELECT id, doc_id, mime_type, merchant_name, total_amount, receipt_date, txn_id
       FROM receipts WHERE id=$1 AND user_id=$2`, [id, USER]);
  const rec = r.rows[0];
  if (!rec) { console.log('No receipt', id, 'for user', USER); process.exit(1); }
  console.log('Stored read :', rec.merchant_name, '$' + rec.total_amount, rec.receipt_date, '| txn=', rec.txn_id);
  if (!rec.doc_id) { console.log('No doc_id — cannot refeed (disk fallback).'); process.exit(1); }
  const bytes = await getDocumentBytes(USER, rec.doc_id);
  if (!bytes) { console.log('No bytes in R2 for doc', rec.doc_id); process.exit(1); }
  console.log('Image bytes :', bytes.length, '| mime', rec.mime_type, '\n');
  console.log('Re-feeding through ocrReceipt (layer 1 + 2)…\n');
  const out = await ocrReceipt(bytes, rec.mime_type || 'image/jpeg');
  console.log('Fresh OCR   :', JSON.stringify(out, null, 2));
  if (out._rotated != null) console.log(`\n*** sweep rescued it by rotating ${out._rotated}° ***`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
