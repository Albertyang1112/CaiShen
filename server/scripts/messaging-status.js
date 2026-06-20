'use strict';
// Dev helper: inspect the messaging state for a user (links + question queue).
// Usage: node server/scripts/messaging-status.js [userId]
require('./_env');
const { query } = require('../core/db');

(async () => {
  const userId = process.argv[2] || '1779502545957';
  const links = await query(`SELECT channel, external_id, display_name FROM messaging_links WHERE user_id=$1`, [userId]);
  console.log('\nmessaging_links:', JSON.stringify(links.rows));
  const byState = await query(`SELECT state, COUNT(*)::int AS n FROM txn_messages WHERE user_id=$1 GROUP BY state ORDER BY state`, [userId]);
  console.log('txn_messages by state:', JSON.stringify(byState.rows));
  const dupes = await query(
    `SELECT transaction_id, COUNT(*)::int AS n FROM txn_messages WHERE user_id=$1 GROUP BY transaction_id HAVING COUNT(*)>1`, [userId]);
  console.log('DUPLICATE rows (same transaction_id):', JSON.stringify(dupes.rows));
  const live = await query(
    `SELECT id, transaction_id, state FROM txn_messages WHERE user_id=$1 AND state IN ('open','asked') ORDER BY created_at`, [userId]);
  console.log('open/asked rows:', JSON.stringify(live.rows, null, 2));
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
