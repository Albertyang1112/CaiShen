'use strict';
// Dry-run the vault-heal sweep: show what it WOULD migrate / re-file / flag. No writes.
//   node server/scripts/heal-dryrun.js [userId] [--apply]
require('./_env');
const path = require('path');
const { query } = require('../core/db');
const healVault = require('../vault/heal');
const store = require('../core/store');

(async () => {
  const apply = process.argv.includes('--apply');
  let userId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!userId) {
    const r = await query("SELECT user_id, text_data FROM user_kv WHERE doc_key='vault.json'");
    let best = null;
    for (const row of r.rows) { try { const n=(JSON.parse(row.text_data||'{}').files||[]).length; if (n&&(!best||n>best.n)) best={userId:row.user_id,n}; } catch {} }
    userId = best?.userId;
  }
  const r = await query("SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'", [userId]);
  const meta = JSON.parse(r.rows[0].text_data);
  const vaultDir = path.join(process.cwd(), 'vault', 'users', String(userId));

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} heal for user ${userId} — ${meta.files.length} files\n`);
  const persist = apply ? async (m) => { store.write('vault.json', m, userId); await store.flush(); } : undefined;
  const plan = await healVault({ userId, meta, vaultDir, apply, persist });

  const show = (label, arr, fmt) => { console.log(`\n${label}: ${arr.length}`); for (const x of arr) console.log('   ' + fmt(x)); };
  show('MIGRATE bytes → R2', plan.migrate, x => `${x.name}  [${x.from}]  → R2 at ${x.dest}`);
  show('RE-SORT (identified)', plan.resort, x => `${x.name}  [${x.from}]  → ${x.to}/${x.newName}  (via ${x.how})`);
  show('FLAG for manual review (couldn\'t identify)', plan.review, x => `${x.name}  [${x.from}]  — ${x.reason}`);
  if (plan.errors.length) show('ERRORS', plan.errors, x => `${x.name}: ${x.error}`);
  console.log(`\nuserPlaced skipped: ${plan.userSkipped}   already-OK skipped: ${plan.okSkipped}`);
  console.log(apply ? '\n✓ applied + persisted. Restart the server to pick it up.' : '\n(dry run — re-run with --apply to perform it)');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(1); });
