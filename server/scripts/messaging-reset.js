'use strict';
// Dev helper: clear the categorizer question queue (txn_messages) for a user. Links kept.
// Usage: node server/scripts/messaging-reset.js [userId]
require('./_env');
const { query } = require('../core/db');

(async () => {
  const userId = process.argv[2] || '1779502545957';
  const r = await query(`DELETE FROM txn_messages WHERE user_id=$1`, [userId]);
  console.log(`Cleared ${r.rowCount} txn_messages row(s) for user ${userId}.`);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
