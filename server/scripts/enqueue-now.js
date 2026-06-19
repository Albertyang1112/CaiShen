'use strict';
// Dev helper: enqueue categorization questions for a user right now, without waiting for a
// Plaid sync. The running server's in-process bot will then DM them one at a time.
// Usage: node server/scripts/enqueue-now.js [userId] [limit]   (defaults: Albert, 3)
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { query } = require('../core/db');
const store = require('../core/store');
const { enqueueQuestions } = require('../banking/categorizer-core');

(async () => {
  const userId = process.argv[2] || '1779502545957';
  const limit  = Number(process.argv[3] || 3);
  await store.preloadAll();
  const io = { read: (f) => store.read(f, userId), write: (f, d) => store.write(f, d, userId) };
  const n = await enqueueQuestions(query, io, userId, { channel: 'discord', limit });
  console.log(`Enqueued ${n} categorization question(s) for user ${userId}.`);
  await store.flush();
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
