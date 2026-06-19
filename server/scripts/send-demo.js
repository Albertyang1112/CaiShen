'use strict';
// Demo helper: queue two specific transactions in order —
//   1) one already categorized (bot shows the learned suggestion)
//   2) one whose suggested category we deliberately override to a "wrong" one
// Usage: node server/scripts/send-demo.js [userId]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const crypto = require('crypto');
const { query } = require('../core/db');
const store = require('../core/store');
const core = require('../banking/categorizer-core');
const { buildDefaultChart } = require('../accounting/categories');

const USER = process.argv[2] || '1779502545957';
// [search, datePrefix, overrideSuggestionText|null]
const DEMO = [
  ['chipotle',      '', null],              // already categorized → learned suggestion
  ['pf inglewood',  '', 'health and medical'],  // deliberately wrong (but health-adjacent) suggestion to correct live
];

(async () => {
  await store.preloadAll();
  const io = { read: (f) => store.read(f, USER), write: (f, d) => store.write(f, d, USER), dir: null };
  const txns = io.read('transactions.json') || [];
  const chart = buildDefaultChart();

  // Clean slate so the demo pair delivers in order.
  await query(`UPDATE txn_messages SET state='closed' WHERE user_id=$1 AND state IN ('open','asked')`, [USER]);

  let seq = 0;
  for (const [search, datePrefix, override] of DEMO) {
    const tx = txns.find(t => String(t.desc || '').toLowerCase().includes(search) && (!datePrefix || String(t.date || '').startsWith(datePrefix)));
    if (!tx) { console.log(`SKIP — no match for "${search}"`); continue; }
    await query(`DELETE FROM txn_messages WHERE user_id=$1 AND transaction_id=$2`, [USER, tx.id]);

    let suggestion;
    if (override) {
      const m = core.matchCategories(override, chart);
      const pick = m.best || m.candidates[0];
      suggestion = pick ? { coaId: pick.id, label: core.coaPath(pick.id, chart), bucket: core.coaScope(pick.id, chart), source: 'manual' } : null;
    } else {
      suggestion = await core.suggestionFor(query, io, USER, tx);
    }

    await query(
      `INSERT INTO txn_messages (id,user_id,transaction_id,channel,kind,state,payload,created_at)
       VALUES ($1,$2,$3,'discord','confirm','open',$4, NOW() + ($5 || ' seconds')::interval)`,
      [`txm_${crypto.randomBytes(6).toString('hex')}`, USER, tx.id,
       JSON.stringify({ stage: 'await_first', tx: core.snapshotTx(tx), suggestion }), String(seq)]);
    console.log(`Queued #${seq + 1}: ${tx.date} ${tx.desc} ${tx.amount}  → suggested: ${suggestion ? suggestion.label : 'none'}`);
    seq++;
  }
  await store.flush();
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
