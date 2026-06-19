'use strict';
// Dev helper: manually queue ONE specific transaction as a categorizer question (the bot
// then DMs it). Finds by description substring (+ optional date prefix).
//   node server/scripts/send-txn.js [userId] <search> [YYYY-MM-DD]            # dry run (lists)
//   node server/scripts/send-txn.js [userId] <search> [YYYY-MM-DD] --send     # actually queue
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const crypto = require('crypto');
const { query } = require('../core/db');
const store = require('../core/store');
const core = require('../banking/categorizer-core');

(async () => {
  const args = process.argv.slice(2).filter(a => a !== '--send');
  const userId = args[0] || '1779502545957';
  const search = (args[1] || 'robinhood').toLowerCase();
  const dateArg = args[2] || '';
  const doSend = process.argv.includes('--send');

  await store.preloadAll();
  const io = { read: (f) => store.read(f, userId), write: (f, d) => store.write(f, d, userId), dir: null };
  const txns = io.read('transactions.json') || [];
  let matches = txns.filter(t => String(t.desc || '').toLowerCase().includes(search));
  if (dateArg) matches = matches.filter(t => String(t.date || '').startsWith(dateArg));

  if (!matches.length) { console.log(`No transaction matching "${search}"${dateArg ? ' on ' + dateArg : ''}.`); process.exit(0); }
  console.log(`Found ${matches.length} match(es):`);
  for (const m of matches) console.log(`  ${m.id}  ${m.date}  ${String(m.desc).slice(0, 50)}  ${m.amount}  ${m.approved ? '[approved]' : ''}`);

  if (!doSend) { console.log('\n(dry run — re-run with --send to queue the first match)'); process.exit(0); }

  const tx = matches[0];
  // Make this the next question delivered: close any other pending ones, refresh this one.
  await query(`UPDATE txn_messages SET state='closed' WHERE user_id=$1 AND state IN ('open','asked')`, [userId]);
  await query(`DELETE FROM txn_messages WHERE user_id=$1 AND transaction_id=$2`, [userId, tx.id]);
  const suggestion = await core.suggestionFor(query, io, userId, tx);
  await query(
    `INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload)
     VALUES ($1,$2,$3,'discord','confirm','open',$4)`,
    [`txm_${crypto.randomBytes(6).toString('hex')}`, userId, tx.id,
     JSON.stringify({ stage: 'await_first', tx: core.snapshotTx(tx), suggestion })]);
  console.log(`\nQueued: ${tx.date} ${tx.desc} ${tx.amount} (suggested: ${suggestion ? suggestion.label : 'none'})`);
  await store.flush();
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
