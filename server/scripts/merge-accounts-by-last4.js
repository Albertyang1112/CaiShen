'use strict';
/**
 * scripts/merge-accounts-by-last4.js — consolidate bank-account folders that share a
 * last-4 into ONE folder. A bank renaming an account (e.g. "High School Checking" ->
 * "Chase Total Checking") previously split one account across two folders; the last-4
 * is the real identity, so this merges them under the most-recent name + "(••last4)".
 *
 * Dry-run by default; pass --apply to write. Operates on the user_kv-backed vault.json.
 *
 *   DATABASE_URL=<conn> node server/scripts/merge-accounts-by-last4.js <userId> [--apply]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const store = require('../core/store');
const { query } = require('../core/db');

const last4Of    = (s) => { const m = String(s || '').match(/(\d{4})(?!.*\d)/); return m ? m[1] : null; };
const stripLast4 = (s) => String(s || '').replace(/\s*\(?[•·.*x\s]*\d{4}\)?\s*$/i, '').trim();

(async () => {
  const userId = process.argv[2];
  const apply  = process.argv.includes('--apply');
  if (!userId) { console.error('usage: merge-accounts-by-last4 <userId> [--apply]'); process.exit(2); }

  const r = await query("SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'", [userId]);
  if (!r.rows.length || !r.rows[0].text_data) { console.error('no vault.json for user', userId); process.exit(1); }
  const meta = JSON.parse(r.rows[0].text_data);
  meta.folders = meta.folders || []; meta.files = meta.files || [];

  // 1. Group bank files by (institution, last4)
  const groups = new Map();
  for (const f of meta.files) {
    const fp = String(f.folderPath || '');
    if (!fp.startsWith('Bank Statements/')) continue;
    const parts = fp.split('/');                          // [Bank Statements, inst, acctSeg, year]
    if (parts.length < 4) continue;
    const inst = parts[1], seg = parts[2], year = parts[3];
    const l4 = (f.tags && f.tags.last4) || last4Of(seg) || last4Of(f.name);
    if (!l4) continue;
    const key = `${inst}|${l4}`;
    let g = groups.get(key);
    if (!g) { g = { inst, last4: l4, files: [], segs: new Set(), latestYear: '', latestName: '' }; groups.set(key, g); }
    g.files.push({ f, year }); g.segs.add(seg);
    if (year >= g.latestYear) { g.latestYear = year; g.latestName = stripLast4(seg) || seg; }
  }

  // 2. Plan: a group needs merging if any of its segments isn't the canonical one.
  const plan = [];
  for (const g of groups.values()) {
    const base = g.latestName || `Account`;
    const canonical = base.includes(g.last4) ? base : `${base} (••${g.last4})`;
    if ([...g.segs].some(s => s !== canonical)) plan.push({ ...g, canonical });
  }
  if (!plan.length) { console.log('Nothing to merge — all accounts already grouped by last-4.'); process.exit(0); }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${plan.length} account(s) to consolidate:\n`);
  for (const g of plan)
    console.log(`  ${g.inst} ••${g.last4}: [${[...g.segs].join('  |  ')}]\n     -> "${g.canonical}"  (${g.files.length} files)`);

  if (!apply) { console.log('\n(dry run — re-run with --apply to write)'); process.exit(0); }

  // 3. Apply — move files, ensure canonical folders exist, prune emptied bank folders
  const ensureFolderPath = (targetPath) => {
    let parentId = null, full = '';
    for (const name of targetPath.split('/').filter(Boolean)) {
      full = full ? `${full}/${name}` : name;
      let fo = meta.folders.find(x => x.path === full);
      if (!fo) { fo = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, path: full, parentId, createdAt: new Date().toISOString(), tags: {} }; meta.folders.push(fo); }
      parentId = fo.id;
    }
    return parentId;
  };
  let moved = 0;
  for (const g of plan) for (const { f, year } of g.files) {
    const newPath = `Bank Statements/${g.inst}/${g.canonical}/${year}`;
    if (f.folderPath !== newPath) { f.folderId = ensureFolderPath(newPath); f.folderPath = newPath; moved++; }
  }
  const filePaths = meta.files.map(f => String(f.folderPath || ''));
  const needed = (fp) => filePaths.some(p => p === fp || p.startsWith(fp + '/'));
  const before = meta.folders.length;
  meta.folders = meta.folders.filter(fo => !String(fo.path).startsWith('Bank Statements') || needed(fo.path));
  console.log(`\nmoved ${moved} files; folders ${before} -> ${meta.folders.length}`);

  store.write('vault.json', meta, userId);
  await store.flush();
  console.log('✓ written to user_kv. Restart the server to pick it up.');
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
