'use strict';
/**
 * vault/heal.js — retroactive vault cleanup sweep.
 *
 * Fixes files that bypassed the normal upload → sort → R2 flow (chiefly scraper
 * imports, which write to local disk + vault.json but never call documents.saveDocument
 * and file mortgage PDFs at `Mortgage/{property_id||'mortgage'}/{year}`). It NEVER
 * touches a file the user placed by hand (tags.userPlaced, set by /move). Per file:
 *
 *   • migrate — bytes missing from R2 but present on local disk → upload to R2
 *   • resort  — a scraper file in a non-canonical folder that we CAN identify as a
 *               statement → re-file to the canonical folder. parserSort first;
 *               pdftotext property-match as a fallback for PDFs pdf2json can't read
 *               (e.g. Rocket mortgage statements that crash pdf2json on form XObjects).
 *   • review  — a scraper file we CANNOT identify → flag tags.needsReview (never
 *               guessed; surfaced for one-click manual assignment in the UI).
 *
 * Dry-run by default: returns the plan and changes nothing. apply:true performs it
 * and calls persist(meta). Caller supplies the live vault meta + a persist callback,
 * so the same engine serves the HTTP endpoint and the dev dry-run script.
 */
const path = require('path');
const fs   = require('fs');
const documents = require('../core/documents');
const { reconcile, indexFolders } = require('./ai-sort');
const { parserSort } = require('./parser-sort');

const CANON = /^(Bank Statements|Mortgage Statements|Tax Documents|Receipts)\//;
const isCanonical = (p) => CANON.test(String(p || ''));
const isScraper   = (f) => f.source === 'scraper' || !!f.tags?.source;

// Property folder names already in the vault (e.g. "8962 Kobe Pl"), for text matching.
function knownProperties(meta) {
  return meta.folders
    .filter(f => /^Mortgage Statements\/[^/]+$/.test(f.path || ''))
    .map(f => f.path.split('/')[1]);
}

// pdftotext (poppler) — a different engine than pdf2json, so it reads PDFs pdf2json
// crashes on. Returns '' if the binary is absent or it fails.
function pdftotext(buffer) {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `heal_${process.pid}_${Math.random().toString(36).slice(2, 7)}.pdf`);
  try { fs.writeFileSync(tmp, buffer); return execFileSync('pdftotext', ['-layout', tmp, '-'], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }).toString(); }
  catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Unambiguous property match: the house number AND a street word, and exactly one
// known property hits. Conservative on purpose — a guess here would misfile.
function matchProperty(text, properties) {
  const lc = String(text || '').toLowerCase();
  const hits = properties.filter(p => {
    const num  = (p.match(/^\d+/) || [])[0];
    const word = (p.toLowerCase().match(/[a-z]{3,}/) || [])[0];
    return num && word && lc.includes(num) && lc.includes(word);
  });
  return hits.length === 1 ? hits[0] : null;
}

function uniqueName(meta, folder, name, selfId) {
  if (!meta.files.some(x => x.id !== selfId && x.folderPath === folder && x.name === name)) return name;
  const ext = path.extname(name), base = path.basename(name, ext);
  return `${base}_${Date.now()}${ext}`;
}

module.exports = async function healVault({ userId, meta, vaultDir, apply = false, persist }) {
  meta.folders = meta.folders || []; meta.files = meta.files || [];
  const props = knownProperties(meta);
  const idx   = indexFolders(meta.folders);

  const plan = { dryRun: !apply, migrate: [], resort: [], review: [], userSkipped: 0, okSkipped: 0, leftAlone: 0, errors: [] };

  const ensureFolderPath = (targetPath) => {
    const parts = targetPath.split('/').filter(Boolean);
    let parentId = null;
    for (let i = 0; i < parts.length; i++) {
      const full = parts.slice(0, i + 1).join('/');
      let fo = meta.folders.find(x => x.path === full);
      if (!fo) { fo = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: parts[i], path: full, parentId, createdAt: new Date().toISOString(), tags: {} }; meta.folders.push(fo); try { fs.mkdirSync(path.join(vaultDir, full), { recursive: true }); } catch {} }
      parentId = fo.id;
    }
    return parentId;
  };

  for (const f of meta.files) {
    if (f.type !== 'pdf') continue;
    if (f.tags?.userPlaced) { plan.userSkipped++; continue; }          // never relocate a manual placement

    let inR2 = false;
    try { inR2 = await documents.documentExists(userId, f.id); } catch {}
    const localPath   = path.join(vaultDir, f.folderPath, f.name);
    const localExists  = fs.existsSync(localPath);
    const orphaned     = !inR2 && localExists;
    const candidate    = isScraper(f) && !isCanonical(f.folderPath) && !f.tags?.aiSorted;  // could be re-sorted

    if (!orphaned && !candidate) { plan.okSkipped++; continue; }

    // Read bytes (R2 → local disk fallback) once, for identification + migration.
    let bytes = null;
    if (inR2) { try { bytes = await documents.getDocumentBytes(userId, f.id); } catch {} }
    if (!bytes && localExists) { try { bytes = fs.readFileSync(localPath); } catch {} }

    // Try to identify a re-sort target for misplaced scraper files.
    let target = null;   // { folder, name, how }
    if (candidate && bytes) {
      const det = await parserSort(bytes, f, meta.folders).catch(() => null);   // parserSort already swallows pdf2json crashes → null
      if (det && det.decision?.folder && det.confidence >= 0.75) {
        target = { folder: det.decision.folder, name: det.decision.filename, how: 'parser' };
      } else if (props.length) {                                                 // fallback: pdftotext property match
        const prop = matchProperty(pdftotext(bytes), props);
        const year = f.tags?.year || (f.name.match(/20\d{2}/) || [])[0];
        if (prop && year) {
          const dec = reconcile({ docType: 'mortgage_statement', propertyAddress: prop, year }, idx, f.name);
          if (dec.folder?.startsWith('Mortgage Statements/')) target = { folder: dec.folder, name: dec.filename, how: 'pdftotext' };
        }
      }
    }

    const base = { id: f.id, name: f.name, from: f.folderPath, source: f.tags?.source || f.source };
    if (orphaned) plan.migrate.push({ ...base, dest: (candidate && target) ? target.folder : f.folderPath });
    if (candidate && target)      plan.resort.push({ ...base, to: target.folder, newName: target.name, how: target.how });
    else if (candidate && !target) plan.review.push({ ...base, reason: bytes ? 'could not identify document/property' : 'no readable bytes' });
    else if (candidate)            plan.leftAlone++;   // (unreachable; kept for clarity)

    if (!apply) continue;

    // ── Apply ──────────────────────────────────────────────────────────────────
    try {
      let destFolder = f.folderPath, destName = f.name;
      if (candidate && target) {
        destFolder = target.folder;
        destName   = uniqueName(meta, target.folder, target.name, f.id);
        const newFolderId = ensureFolderPath(destFolder);
        try {                                                          // best-effort local move
          const op = path.join(vaultDir, f.folderPath, f.name), np = path.join(vaultDir, destFolder, destName);
          if (fs.existsSync(op)) { fs.mkdirSync(path.dirname(np), { recursive: true }); if (!fs.existsSync(np)) fs.renameSync(op, np); }
        } catch {}
        f.folderPath = destFolder; f.folderId = newFolderId; f.name = destName;
        f.tags = { ...(f.tags || {}), aiSorted: true, docType: 'mortgage_statement', mortgage: true, healed: target.how };
      }
      if (orphaned && bytes) {                                          // put the bytes into R2 at the final location
        await documents.saveDocument({ id: f.id, userId, name: destName, mimeType: 'application/pdf', bytes,
          folderPath: destFolder, tags: f.tags || {}, periodYear: f.tags?.year ? parseInt(f.tags.year) : null });
      } else if (candidate && target && inR2 && destName !== base.name) {
        try { await documents.renameDocument(userId, f.id, destName); } catch {}
      }
      if (candidate && !target) {                                       // flag for one-click manual assignment
        f.tags = { ...(f.tags || {}), needsReview: true, reviewReason: bytes ? 'unidentified' : 'no bytes' };
      }
    } catch (e) { plan.errors.push({ id: f.id, name: f.name, error: e.message }); }
  }

  // Drop folders left empty by re-sorting (e.g. the stray Mortgage/mortgage/2026 tree).
  if (apply) {
    const used = new Set();
    for (const f of meta.files) { let p = f.folderPath; while (p) { used.add(p); p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; } }
    meta.folders = meta.folders.filter(fo => used.has(fo.path));
    if (persist) await persist(meta);
  }
  return plan;
};

// Reused by the scraper importer (forward fix) so imports file + identify the same way.
module.exports.knownProperties = knownProperties;
module.exports.matchProperty   = matchProperty;
module.exports.pdftotext       = pdftotext;
