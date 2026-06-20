'use strict';
// Diagnostic: which DB am I on, and what's in it? Usage: node server/scripts/db-info.js
require('./_env');
const { query } = require('../core/db');

const show = async (label, sql, params = []) => {
  try { const r = await query(sql, params); console.log(label, JSON.stringify(r.rows)); }
  catch (e) { console.log(label, 'ERR:', e.message); }
};

(async () => {
  console.log('DATABASE_URL:', (process.env.DATABASE_URL || '(unset)').replace(/:[^:@/]+@/, ':***@'));
  await show('tables       :', `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);
  await show('users        :', `SELECT id, username, role FROM users ORDER BY created_at`);
  await show('txns by user :', `SELECT user_id, COUNT(*)::int n FROM transactions GROUP BY user_id`);
  await show('messaging    :', `SELECT user_id, channel, external_id, display_name FROM messaging_links`);
  await show('txn_messages :', `SELECT state, COUNT(*)::int n FROM txn_messages GROUP BY state`);
  await show('receipts     :', `SELECT COUNT(*)::int n FROM receipts`);
  await show('receipts.txn_id nullable:', `SELECT is_nullable FROM information_schema.columns WHERE table_name='receipts' AND column_name='txn_id'`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
