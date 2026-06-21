'use strict';
/**
 * redate-mortgages.js — re-date/re-file mortgage statements by their PRINTED
 * "Statement Date" (the authoritative page-1 field), ignoring the embedded sample
 * page that fools date-clustering. Canonical target:
 *   Mortgage Statements/{property}/{stmtYear}/{street} {Mon} {stmtYear}.pdf
 *
 * Dry-run by default; --apply re-files + renames. Re-file is metadata-only
 * (documents.original_name via renameDocument — R2 key embeds the id, bytes never
 * move — plus vault.json folderPath/name; local disk is best-effort two-phase).
 * Skips Mortgage Statements/Unassigned and tags.userPlaced. Flags unreadable PDFs
 * and same-period duplicates (left for a manual call).
 *   node server/scripts/redate-mortgages.js [userId] [--apply]
 */
require('./_env');
const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const { query } = require('../core/db');
const documents = require('../core/documents');
const store = require('../core/store');

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const streetOf = (prop) => String(prop).replace(/^\d+\s+/, '').trim();

function pdftotext(buf) {
  const tmp = path.join(os.tmpdir(), `redate_${process.pid}_${Math.random().toString(36).slice(2, 7)}.pdf`);
  try { fs.writeFileSync(tmp, buf); return execFileSync('pdftotext', ['-layout', tmp, '-'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).toString(); }
  catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
// First "Statement Date" label → first MM/DD/YYYY after it. The real statement date
// is in the page-1 header; the 2017 sample page's own label comes later, so the FIRST
// match is the authoritative one.
function printedDate(text) {
  const m = /STATEMENT\s+DATE[\s\S]{0,400}?\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(text || '');
  if (!m) return null;
  const mo = +m[1], yr = +m[3];
  return (mo >= 1 && mo <= 12 && yr >= 2000 && yr <= 2040) ? { year: yr, month: mo } : null;
}

(async () => {
  const apply = process.argv.includes('--apply');
  let userId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!userId) {
    const r = await query("SELECT user_id, text_data FROM user_kv WHERE doc_key='vault.json'");
    let best = null;
    for (const row of r.rows) { try { const n = (JSON.parse(row.text_data || '{}').files || []).filter(f => /^Mortgage Statements\//.test(f.folderPath || '')).length; if (n && (!best || n > best.n)) best = { userId: row.user_id, n }; } catch {} }
    userId = best?.userId;
  }
  const r = await query("SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'", [userId]);
  const meta = JSON.parse(r.rows[0].text_data); meta.folders = meta.folders || []; meta.files = meta.files || [];
  const vaultDir = path.join(process.cwd(), 'vault', 'users', String(userId));

  const ensureFolder = (p) => {
    const parts = p.split('/').filter(Boolean); let parentId = null;
    for (let i = 0; i < parts.length; i++) {
      const full = parts.slice(0, i + 1).join('/');
      let fo = meta.folders.find(x => x.path === full);
      if (!fo) { fo = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: parts[i], path: full, parentId, createdAt: new Date().toISOString(), tags: {} }; meta.folders.push(fo); }
      parentId = fo.id;
    }
    return parentId;
  };

  const targets = meta.files.filter(f => f.type === 'pdf'
    && /^Mortgage Statements\/[^/]+\//.test(f.folderPath || '')
    && !/^Mortgage Statements\/Unassigned\//.test(f.folderPath || '')
    && !f.tags?.userPlaced);

  const plans = [];
  for (const f of targets) {
    const prop = f.folderPath.split('/')[1];
    let bytes = null; try { bytes = await documents.getDocumentBytes(userId, f.id); } catch {}
    if (!bytes) { const lp = path.join(vaultDir, f.folderPath, f.name); if (fs.existsSync(lp)) bytes = fs.readFileSync(lp); }
    const d = bytes ? printedDate(pdftotext(bytes)) : null;
    if (!d) { plans.push({ f, prop, status: 'unreadable' }); continue; }
    const folder = `Mortgage Statements/${prop}/${d.year}`;
    const name = `${streetOf(prop)} ${MON[d.month - 1]} ${d.year}.pdf`;
    plans.push({ f, prop, d, folder, name, key: `${folder}/${name}`, changed: folder !== f.folderPath || name !== f.name });
  }

  const byKey = {}; for (const p of plans) if (p.key) (byKey[p.key] = byKey[p.key] || []).push(p);
  const dupKeys = new Set(Object.entries(byKey).filter(([, a]) => a.length > 1).map(([k]) => k));

  const changed    = plans.filter(p => p.changed && p.key && !dupKeys.has(p.key));
  const unchanged  = plans.filter(p => p.key && !p.changed);
  const unreadable = plans.filter(p => p.status === 'unreadable');

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} re-date — user ${userId}, ${targets.length} mortgage PDFs\n`);
  console.log(`RENAME / RE-FILE: ${changed.length}`);
  for (const p of changed) console.log(`   ${p.f.folderPath}/${p.f.name}\n        → ${p.folder}/${p.name}   (stmt date ${p.d.year}-${String(p.d.month).padStart(2,'0')})`);
  console.log(`\nalready correct: ${unchanged.length}`);
  if (unreadable.length) { console.log(`\nUNREADABLE (skipped): ${unreadable.length}`); for (const p of unreadable) console.log(`   ${p.f.folderPath}/${p.f.name}`); }
  if (dupKeys.size) { console.log(`\n⚠ SAME-PERIOD DUPLICATES (skipped — your call):`); for (const k of dupKeys) console.log(`   ${k}  ←  [${byKey[k].map(p => p.f.name).join(', ')}]`); }

  if (!apply) { console.log('\n(dry run — re-run with --apply)'); process.exit(0); }

  // Apply. Metadata first (authoritative): R2 original_name + vault.json. Then a
  // two-phase local move (all → temp, then temp → final) so the month-shift chain
  // never hits a transient same-path collision on disk. Local is best-effort.
  const tmpDir = path.join(vaultDir, '.redate_tmp');
  for (const p of changed) {
    const f = p.f;
    try { await documents.renameDocument(userId, f.id, p.name); } catch (e) { console.error('  rename R2', f.id, e.message); }
    try { const op = path.join(vaultDir, f.folderPath, f.name); if (fs.existsSync(op)) { fs.mkdirSync(tmpDir, { recursive: true }); fs.renameSync(op, path.join(tmpDir, f.id + '.pdf')); } } catch {}
    f.folderPath = p.folder; f.folderId = ensureFolder(p.folder); f.name = p.name;
  }
  for (const p of changed) {
    try { const tp = path.join(tmpDir, p.f.id + '.pdf'); if (fs.existsSync(tp)) { const np = path.join(vaultDir, p.folder, p.name); fs.mkdirSync(path.dirname(np), { recursive: true }); fs.renameSync(tp, np); } } catch {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  const used = new Set(); for (const f of meta.files) { let q = f.folderPath; while (q) { used.add(q); q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : ''; } }
  meta.folders = meta.folders.filter(fo => used.has(fo.path));

  store.write('vault.json', meta, userId); await store.flush();
  console.log(`\n✓ re-dated ${changed.length} file(s). Restart the server to pick it up.`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message, e.stack); process.exit(1); });
