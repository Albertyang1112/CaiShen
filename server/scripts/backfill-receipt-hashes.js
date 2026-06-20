'use strict';
// One-off: copy documents.sha256 → receipts.file_sha256 for receipts ingested before the
// dedup build, so re-uploading the exact same image is caught as a HARD duplicate.
// Usage: node server/scripts/backfill-receipt-hashes.js
require('./_env');
const { query } = require('../core/db');

(async () => {
  const r = await query(
    `UPDATE receipts SET file_sha256 = d.sha256
       FROM documents d
      WHERE receipts.doc_id = d.id AND receipts.doc_id IS NOT NULL AND receipts.file_sha256 IS NULL`);
  console.log(`Backfilled file_sha256 on ${r.rowCount} receipt(s) from documents.sha256.`);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
