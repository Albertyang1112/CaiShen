'use strict';
// Dev helper: mint a messaging link code for a user and print it.
// Usage: node server/scripts/messaging-link-code.js [userId] [channel]
//   defaults: userId = Albert (1779502545957), channel = discord
require('./_env');
const { query } = require('../core/db');
const { createLinkCode } = require('../banking/messaging-store');

(async () => {
  const userId  = process.argv[2] || '1779502545957';
  const channel = process.argv[3] || 'discord';
  const code = await createLinkCode(query, userId, { channel });
  console.log(`\nLink code for user ${userId} (${channel}, valid 15 min): ${code}`);
  console.log(`→ In Discord, DM the CaiShen bot:  link ${code}\n`);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
