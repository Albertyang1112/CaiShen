'use strict';
// Inspect (default) or delete (--delete) receipt(s) + all related rows + the R2 document.
//   node server/scripts/cleanup-receipt.js <id...>            -> DRY RUN (show what relates)
//   node server/scripts/cleanup-receipt.js <id...> --delete   -> delete them
require('./_env');
const { query } = require('../core/db');
const { deleteDocument } = require('../core/documents');

const USER = process.env.REFEED_USER || '1781913882747';

(async () => {
  const args = process.argv.slice(2);
  const doDelete = args.includes('--delete');
  const ids = args.filter(a => a !== '--delete');
  if (!ids.length) { console.log('usage: cleanup-receipt.js <receiptId...> [--delete]'); process.exit(1); }

  const recs = await query(
    `SELECT id, doc_id, merchant_name, total_amount, txn_id FROM receipts WHERE id = ANY($1) AND user_id=$2`, [ids, USER]);
  if (!recs.rows.length) { console.log('No matching receipts for', ids); process.exit(0); }
  console.log('Receipts matched:');
  for (const r of recs.rows) console.log(`  ${r.id}  ${r.merchant_name} $${r.total_amount}  doc=${r.doc_id} txn=${r.txn_id || '-'}`);
  const found = recs.rows.map(r => r.id);

  const items = await query(`SELECT COUNT(*)::int n FROM receipt_items WHERE receipt_id = ANY($1)`, [found]);
  const st    = await query(`SELECT id, source, amount, receipt_id FROM source_transactions WHERE receipt_id = ANY($1)`, [found]);
  const dchk  = await query(`SELECT id FROM receipt_duplicate_checks WHERE new_receipt_id = ANY($1) OR possible_duplicate_receipt_id = ANY($1)`, [found]);
  const msgs  = await query(
    `SELECT id, kind, state FROM txn_messages WHERE ${found.map((_, i) => `payload::text LIKE '%' || $${i + 1} || '%'`).join(' OR ')}`, found);
  console.log('Related:');
  console.log(`  receipt_items: ${items.rows[0].n}  (cascade)`);
  console.log(`  source_transactions: ${st.rows.length}`, JSON.stringify(st.rows));
  console.log(`  receipt_duplicate_checks: ${dchk.rows.length}`);
  console.log(`  txn_messages referencing: ${msgs.rows.length}`, JSON.stringify(msgs.rows));

  if (!doDelete) { console.log('\nDRY RUN — re-run with --delete to remove these.'); process.exit(0); }

  await query(`DELETE FROM source_transactions WHERE receipt_id = ANY($1)`, [found]);
  await query(`DELETE FROM receipt_duplicate_checks WHERE new_receipt_id = ANY($1) OR possible_duplicate_receipt_id = ANY($1)`, [found]);
  if (msgs.rows.length) await query(`DELETE FROM txn_messages WHERE id = ANY($1)`, [msgs.rows.map(m => m.id)]);
  await query(`DELETE FROM receipts WHERE id = ANY($1) AND user_id=$2`, [found, USER]);   // cascades receipt_items
  for (const r of recs.rows) {
    if (r.doc_id) { try { await deleteDocument(USER, r.doc_id); console.log('  deleted doc', r.doc_id); } catch (e) { console.log('  doc delete failed', r.doc_id, e.message); } }
  }
  console.log(`\nDeleted ${found.length} receipt(s) + related rows.`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.stack); process.exit(1); });
