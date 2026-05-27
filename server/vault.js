const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');

const upload = multer({ storage: multer.memoryStorage() });

const getFileType = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  if (['.pdf'].includes(ext))                              return 'pdf';
  if (['.csv'].includes(ext))                              return 'csv';
  if (['.xlsx', '.xls'].includes(ext))                     return 'excel';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.doc', '.docx'].includes(ext))                     return 'word';
  if (['.txt', '.md'].includes(ext))                       return 'text';
  return 'other';
};

const autoTag = (folderPath) => {
  const l = folderPath.toLowerCase();
  if (l.includes('haas'))                              return { property: 'haas' };
  if (l.includes('kobe'))                              return { property: 'kobe' };
  if (l.includes('bayhill') || l.includes('bay hill')) return { property: 'bayhill' };
  if (l.includes('muirfield'))                         return { property: 'muirfield' };
  if (l.includes('alcita'))                            return { property: 'alcita' };
  if (l.includes('tax'))                               return { type: 'tax' };
  if (l.includes('personal'))                          return { type: 'personal' };
  if (l.includes('business'))                          return { type: 'business' };
  return {};
};

const titleCase = s => s.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const stmtFilename = (l4, year, month) =>
  `${l4} Statement ${MONTH_ABBR[Math.max(0, parseInt(month) - 1)]} ${year}.pdf`;

// ── Duplicate detection helpers ───────────────────────────────────────────────
const DUPE_SIMILARITY_THRESHOLD = 0.82; // word-Jaccard ≥ 82% → highly similar

function wordJaccard(text1, text2) {
  const tok = t => new Set((t.toLowerCase().match(/\b[\w.$,%-]+\b/g) || []).filter(w => w.length > 1));
  const a = tok(text1), b = tok(text2);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

module.exports = function(BASE_VAULT_DIR, makeIO) {
  const router = express.Router();

  const getUserVaultDir = (userId) => path.join(BASE_VAULT_DIR, 'users', userId);

  const readMeta  = (userId) => makeIO(userId).read('vault.json') || { folders: [], files: [] };
  const writeMeta = (data, userId) => makeIO(userId).write('vault.json', data);

  // ── GET /api/vault ────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    try { res.json(readMeta(req.user.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/vault/check-duplicate ──────────────────────────────────
  router.post('/check-duplicate', (req, res) => {
    const { folderName, fileNames } = req.body;
    const meta = readMeta(req.user.id);
    const existing = meta.folders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
    if (!existing) return res.json({ isDuplicate: false });

    const existingFiles = meta.files.filter(f => f.folderId === existing.id).map(f => f.name.toLowerCase());
    const incomingFiles = (fileNames || []).map(f => f.toLowerCase());
    const matches  = incomingFiles.filter(f => existingFiles.includes(f));
    const matchPct = incomingFiles.length > 0 ? (matches.length / incomingFiles.length) * 100 : 0;
    res.json({
      isDuplicate: true, isNearDuplicate: matchPct >= 60,
      matchPercent: Math.round(matchPct), existingFolder: existing,
      existingFileCount: existingFiles.length, newFileCount: incomingFiles.length,
      newFiles: incomingFiles.filter(f => !existingFiles.includes(f)).length,
      modifiedFiles: matches.length,
    });
  });

  // ── POST /api/vault/upload ────────────────────────────────────────────
  router.post('/upload', upload.array('files'), (req, res) => {
    try {
      const userId     = req.user.id;
      const vaultDir   = getUserVaultDir(userId);
      const meta       = readMeta(userId);
      const folderPath = req.body.folderPath || 'Uploads';
      const mergeMode  = req.body.mergeMode  || 'merge';

      const parts = folderPath.split('/').filter(Boolean);
      let parentId = null, currentFolderId = null;
      for (let i = 0; i < parts.length; i++) {
        const name     = parts[i];
        const fullPath = parts.slice(0, i + 1).join('/');
        let folder     = meta.folders.find(f => f.path === fullPath);
        if (!folder) {
          folder = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name, path: fullPath, parentId, createdAt: new Date().toISOString(), tags: autoTag(fullPath) };
          meta.folders.push(folder);
        }
        parentId = folder.id; currentFolderId = folder.id;
      }

      const physicalPath = path.join(vaultDir, folderPath);
      fs.mkdirSync(physicalPath, { recursive: true });

      const uploaded = [];
      for (const file of req.files || []) {
        const existingFile = meta.files.find(f => f.folderId === currentFolderId && f.name === file.originalname);
        if (existingFile) {
          if (mergeMode === 'keep') continue;
          if (mergeMode === 'replace' || mergeMode === 'merge') {
            const archivePath = path.join(physicalPath, '_archive');
            fs.mkdirSync(archivePath, { recursive: true });
            const oldPhysical = path.join(physicalPath, existingFile.name);
            if (fs.existsSync(oldPhysical)) {
              const archiveName = `${path.basename(existingFile.name, path.extname(existingFile.name))}_${Date.now()}${path.extname(existingFile.name)}`;
              fs.renameSync(oldPhysical, path.join(archivePath, archiveName));
            }
            existingFile.size = file.size; existingFile.updatedAt = new Date().toISOString(); existingFile.version = (existingFile.version || 1) + 1;
            fs.writeFileSync(path.join(physicalPath, file.originalname), file.buffer);
            uploaded.push(existingFile); continue;
          }
          if (mergeMode === 'new') {
            const base = path.basename(file.originalname, path.extname(file.originalname));
            const ext  = path.extname(file.originalname);
            file.originalname = `${base}_v${Date.now()}${ext}`;
          }
        }
        fs.writeFileSync(path.join(physicalPath, file.originalname), file.buffer);
        // Auto-parse year/month from filenames like "2026-02 TOTAL CHECKING Statement.pdf"
        // or YYYYMMDD format like "20190116-statements-9092-.pdf"
        const fnDate1 = file.originalname.match(/^(\d{4})[-._\s](\d{2})\b/);
        const fnDate2 = !fnDate1 && file.originalname.match(/^(\d{4})(\d{2})\d{2}[-_.]/);
        const fnDateTags = fnDate1 ? { year: fnDate1[1], month: fnDate1[2] } :
                           fnDate2 ? { year: fnDate2[1], month: fnDate2[2] } : {};
        const newFile = {
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name: file.originalname,
          folderId: currentFolderId, folderPath, size: file.size,
          type: getFileType(file.originalname), mimeType: file.mimetype,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
          tags: { ...autoTag(folderPath), ...fnDateTags },
        };
        meta.files.push(newFile); uploaded.push(newFile);
      }
      writeMeta(meta, userId);
      res.json({ success: true, uploaded: uploaded.length, files: uploaded });
    } catch (e) { console.error('Vault upload error:', e); res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/vault/folder ────────────────────────────────────────────
  router.post('/folder', (req, res) => {
    try {
      const userId = req.user.id;
      const meta   = readMeta(userId);
      const { name, parentId } = req.body;
      const parent = parentId ? meta.folders.find(f => f.id === parentId) : null;
      const folderPath = parent ? `${parent.path}/${name}` : name;
      if (meta.folders.find(f => f.path === folderPath)) return res.status(400).json({ error: 'Folder already exists' });
      const folder = { id: `folder_${Date.now()}`, name, path: folderPath, parentId: parentId || null, createdAt: new Date().toISOString(), tags: autoTag(name) };
      meta.folders.push(folder);
      fs.mkdirSync(path.join(getUserVaultDir(userId), folderPath), { recursive: true });
      writeMeta(meta, userId);
      res.json(folder);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/vault/file/:id ───────────────────────────────────────────
  router.get('/file/:id', (req, res) => {
    const userId = req.user.id;
    const meta   = readMeta(userId);
    const file   = meta.files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(getUserVaultDir(userId), file.folderPath, file.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
    res.sendFile(filePath);
  });

  // ── DELETE /api/vault/file/:id ────────────────────────────────────────
  router.delete('/file/:id', (req, res) => {
    try {
      const userId = req.user.id;
      const io     = makeIO(userId);
      const meta   = readMeta(userId);
      const file   = meta.files.find(f => f.id === req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const filePath = path.join(getUserVaultDir(userId), file.folderPath, file.name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      meta.files = meta.files.filter(f => f.id !== req.params.id);
      writeMeta(meta, userId);

      // Remove ALL transactions matching this statement's account+month (both plaid and csv_import)
      const { year, month, account: acctName } = file.tags || {};
      if (year && month && acctName) {
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const accounts = io.read('accounts.json') || [];
        const acct     = accounts.find(a => a.name === acctName);
        const txs      = io.read('transactions.json') || [];
        const filtered = txs.filter(t =>
          !(t.month === monthStr && (acct ? t.account === acct.id : true))
        );
        if (filtered.length !== txs.length) io.write('transactions.json', filtered);
      }

      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/vault/folder/:id ──────────────────────────────────────
  router.delete('/folder/:id', (req, res) => {
    try {
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);
      const meta     = readMeta(userId);
      const folder   = meta.folders.find(f => f.id === req.params.id);
      if (!folder) return res.status(404).json({ error: 'Not found' });
      const getAllChildren = (id) => {
        const children = meta.folders.filter(f => f.parentId === id);
        return [id, ...children.flatMap(c => getAllChildren(c.id))];
      };
      const allIds       = getAllChildren(folder.id);
      const deletedFiles = meta.files.filter(f => allIds.includes(f.folderId));

      const physicalPath = path.join(vaultDir, folder.path);
      const archivePath  = path.join(vaultDir, '_deleted', `${folder.name}_${Date.now()}`);
      if (fs.existsSync(physicalPath)) {
        fs.mkdirSync(path.join(vaultDir, '_deleted'), { recursive: true });
        fs.renameSync(physicalPath, archivePath);
      }
      meta.folders = meta.folders.filter(f => !allIds.includes(f.id));
      meta.files   = meta.files.filter(f => !allIds.includes(f.folderId));
      writeMeta(meta, userId);

      // Remove ALL transactions (both plaid and csv_import) for every tagged statement file in deleted folders
      const accounts = io.read('accounts.json') || [];
      const txs      = io.read('transactions.json') || [];
      const keysToRemove = new Set();
      for (const file of deletedFiles) {
        const { year, month, account: acctName } = file.tags || {};
        if (!year || !month || !acctName) continue;
        const monthStr = `${year}-${String(month).padStart(2, '0')}`;
        const acct     = accounts.find(a => a.name === acctName);
        const acctId   = acct ? acct.id : null;
        txs.forEach((t, i) => {
          if (t.month === monthStr && (!acctId || t.account === acctId))
            keysToRemove.add(i);
        });
      }
      if (keysToRemove.size > 0) {
        io.write('transactions.json', txs.filter((_, i) => !keysToRemove.has(i)));
      }

      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/vault/auto-organize — scan PDFs, detect metadata, sort into folders ──
  // body: { folderId?, consolidate? }
  //   folderId   — limit to PDFs in this folder (omit = all untagged PDFs)
  //   consolidate — skip organizing, only backfill last4 and merge duplicate folders
  router.post('/auto-organize', async (req, res) => {
    try {
      const { extractStatementMeta, guessAccountTypeSubtype } = require('./pdf-parser');
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);
      let   accounts = io.read('accounts.json') || [];

      const { folderId, consolidate } = req.body;

      // ── Helper: ensure folder path exists in meta + on disk ─────────────────
      const ensureFolderPath = (targetPath) => {
        const parts = targetPath.split('/').filter(Boolean);
        let parentId = null;
        for (let i = 0; i < parts.length; i++) {
          const fullPath = parts.slice(0, i + 1).join('/');
          let f = meta.folders.find(x => x.path === fullPath);
          if (!f) {
            f = {
              id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: parts[i], path: fullPath, parentId,
              createdAt: new Date().toISOString(), tags: {},
            };
            meta.folders.push(f);
            fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true });
          }
          parentId = f.id;
        }
        return parentId;
      };

      // ── Score an account folder name — higher = more "official" ─────────────
      // All-caps names (like "TOTAL CHECKING") are typically the bank's own label.
      // Descriptive/contextual names (like "High School Checking") score lower.
      const scoreAccountName = (name) => {
        let score = 0;
        if (name === name.toUpperCase() && /[A-Z]/.test(name)) score += 20; // all-caps
        const keywords = ['TOTAL', 'PREMIER', 'SIGNATURE', 'PLATINUM', 'BUSINESS',
                          'CHECKING', 'SAVINGS', 'MONEY MARKET', 'BROKERAGE'];
        for (const kw of keywords) if (name.toUpperCase().includes(kw)) score += 5;
        score -= name.length * 0.5; // shorter names score slightly higher
        return score;
      };

      // ── Step 1: Backfill last4 on vault PDFs that have institution but no last4 ──
      // Necessary so files sorted by older code (no last4 tag) can be cross-matched.
      const needsBackfill = meta.files.filter(f =>
        f.type === 'pdf' && f.tags?.institution && !f.tags?.last4
      );
      if (needsBackfill.length > 0) {
        const BFCONC = 5;
        for (let i = 0; i < needsBackfill.length; i += BFCONC) {
          await Promise.allSettled(needsBackfill.slice(i, i + BFCONC).map(async (f) => {
            const fp = path.join(vaultDir, f.folderPath, f.name);
            if (!fs.existsSync(fp)) return;
            const buf = fs.readFileSync(fp);
            const { last4: pdfL4 } = await extractStatementMeta(buf);
            const fnL4M = f.name.match(/statements?[-_](\d{4})/i);
            const resolved = (fnL4M ? fnL4M[1] : null) || pdfL4;
            if (resolved) {
              const fi = meta.files.findIndex(x => x.id === f.id);
              if (fi >= 0) meta.files[fi].tags = { ...meta.files[fi].tags, last4: resolved };
            }
          }));
        }
        writeMeta(meta, userId);
        console.log(`[vault/auto-organize] Backfilled last4 for ${needsBackfill.length} files`);
      }

      // ── Step 2: Build vault-folder → last4 map for cross-file matching ───────
      // Maps inst+last4 → best canonical account folder name.
      // This lets PDFs find the "right" folder even if accounts.json is empty.
      const vaultFolderL4Map = {}; // key: "inst_lower:l4" → best folder name
      for (const folder of meta.folders) {
        const parts = folder.path.split('/');
        if (parts[0] !== 'Bank Statements' || parts.length !== 3) continue;
        const instName = parts[1], acctName = parts[2];
        const folderFiles = meta.files.filter(f => f.folderPath.startsWith(folder.path + '/') || f.folderPath === folder.path);
        const last4s = [...new Set(folderFiles.map(f => f.tags?.last4).filter(Boolean))];
        for (const l4 of last4s) {
          const key = `${instName.toLowerCase()}:${l4}`;
          const cur = vaultFolderL4Map[key];
          if (!cur || scoreAccountName(acctName) > scoreAccountName(cur)) {
            vaultFolderL4Map[key] = acctName;
          }
        }
      }

      // ── Step 3: Consolidate duplicate account folders ────────────────────────
      // If multiple Bank Statements/{inst}/{acct}/ folders share the same last4,
      // merge them into the highest-scoring (most official) one.
      let consolidated = 0;
      const acctLevelFolders = meta.folders.filter(f => {
        const p = f.path.split('/');
        return p.length === 3 && p[0] === 'Bank Statements';
      });
      // Group: inst → last4 → [folders]
      const instL4Groups = {};
      for (const folder of acctLevelFolders) {
        const inst = folder.path.split('/')[1];
        const folderFiles = meta.files.filter(f => f.folderPath.startsWith(folder.path));
        const last4s = [...new Set(folderFiles.map(f => f.tags?.last4).filter(Boolean))];
        for (const l4 of last4s) {
          const key = `${inst}::${l4}`;
          if (!instL4Groups[key]) instL4Groups[key] = [];
          instL4Groups[key].push(folder);
        }
      }
      for (const [key, folders] of Object.entries(instL4Groups)) {
        if (folders.length <= 1) continue;
        const l4   = key.split('::')[1];
        const inst = key.split('::')[0];
        // Pick canonical: highest name score
        folders.sort((a, b) => scoreAccountName(b.name) - scoreAccountName(a.name));
        const canonical  = folders[0];
        const duplicates = folders.slice(1);
        for (const dup of duplicates) {
          const dupFiles = meta.files.filter(f => f.folderPath.startsWith(dup.path));
          for (const f of dupFiles) {
            const rel           = f.folderPath.slice(dup.path.length); // e.g. "/2019"
            const newFolderPath = canonical.path + rel;
            const targetFolderId = ensureFolderPath(newFolderPath);
            const src = path.join(vaultDir, f.folderPath, f.name);
            const dst = path.join(vaultDir, newFolderPath, f.name);
            try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch {}
            const fi = meta.files.findIndex(x => x.id === f.id);
            if (fi >= 0) {
              meta.files[fi].folderPath = newFolderPath;
              meta.files[fi].folderId   = targetFolderId;
              meta.files[fi].tags       = { ...meta.files[fi].tags, account: canonical.name, last4: l4 };
            }
            consolidated++;
          }
          // Remove dup folder tree from meta + disk
          const toRemove = meta.folders
            .filter(x => x.path === dup.path || x.path.startsWith(dup.path + '/'))
            .map(x => x.id);
          meta.folders = meta.folders.filter(x => !toRemove.includes(x.id));
          try { fs.rmSync(path.join(vaultDir, dup.path), { recursive: true, force: true }); } catch {}
        }
        // Ensure accounts.json reflects the canonical name
        let acctEntry = accounts.find(a =>
          a.last4 === l4 && (a.institution || '').toLowerCase() === inst.toLowerCase()
        );
        if (acctEntry && acctEntry.name !== canonical.name) {
          acctEntry.name = canonical.name;
          io.write('accounts.json', accounts);
        } else if (!acctEntry) {
          const { type, subtype } = guessAccountTypeSubtype(inst, canonical.name);
          accounts.push({
            id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: canonical.name, institution: inst, type, subtype,
            last4: l4, source: 'pdf_import',
            createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
          });
          io.write('accounts.json', accounts);
        }
      }
      if (consolidated > 0) {
        writeMeta(meta, userId);
        console.log(`[vault/auto-organize] Consolidated ${consolidated} files across duplicate account folders`);
      }

      // ── Rename pass (runs in both modes) — canonical filename for Bank Statement PDFs ─
      // Renames files that have last4 + year + month tags but non-canonical names.
      // Target format: "{last4} Statement {MonAbbr} {YYYY}.pdf"
      // If the canonical name already exists in the same folder, the file being renamed
      // is a period-exact duplicate — it is deleted automatically.
      let renamed = 0;
      const bankStmtFiles = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.last4 && f.tags?.year && f.tags?.month &&
        f.folderPath && f.folderPath.startsWith('Bank Statements/')
      );
      let dupeRemoved = 0;
      for (const f of bankStmtFiles) {
        const canonical = stmtFilename(f.tags.last4, f.tags.year, f.tags.month);
        if (f.name === canonical) continue; // already correct
        const dir     = path.join(vaultDir, f.folderPath);
        const oldPath = path.join(dir, f.name);
        if (!fs.existsSync(oldPath)) continue;

        // If canonical name already exists (owned by a DIFFERENT meta entry) → duplicate
        if (fs.existsSync(path.join(dir, canonical))) {
          try { fs.unlinkSync(oldPath); } catch {}
          const fi = meta.files.findIndex(x => x.id === f.id);
          if (fi >= 0) meta.files.splice(fi, 1);
          dupeRemoved++;
          console.log(`[vault/auto-organize] Auto-removed duplicate: ${f.name} (kept: ${canonical})`);
          continue;
        }

        // Rename to canonical
        try {
          fs.renameSync(oldPath, path.join(dir, canonical));
          const fi = meta.files.findIndex(x => x.id === f.id);
          if (fi >= 0) meta.files[fi].name = canonical;
          renamed++;
        } catch (e) {
          console.warn(`[vault/auto-organize] rename failed: ${f.name} → ${canonical}:`, e.message);
        }
      }

      // ── Period-exact cleanup: remove any remaining (2)/(3) duplicates ─────────
      // Catches files that were already named with a suffix before this pass ran.
      const periodGroups = {};
      for (const f of meta.files.filter(x =>
        x.type === 'pdf' && x.tags?.last4 && x.tags?.year && x.tags?.month
      )) {
        const key = `${f.tags.last4}::${f.tags.year}::${f.tags.month}`;
        if (!periodGroups[key]) periodGroups[key] = [];
        periodGroups[key].push(f);
      }
      for (const group of Object.values(periodGroups)) {
        if (group.length < 2) continue;
        // Prefer canonical name (no numeric suffix), then shortest name
        group.sort((a, b) => {
          const aIsClean = !/\s\(\d+\)\.pdf$/i.test(a.name);
          const bIsClean = !/\s\(\d+\)\.pdf$/i.test(b.name);
          if (aIsClean !== bIsClean) return aIsClean ? -1 : 1;
          return a.name.length - b.name.length;
        });
        for (const dup of group.slice(1)) {
          const fp = path.join(vaultDir, dup.folderPath, dup.name);
          try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
          const fi = meta.files.findIndex(x => x.id === dup.id);
          if (fi >= 0) meta.files.splice(fi, 1);
          dupeRemoved++;
          console.log(`[vault/auto-organize] Auto-removed duplicate: ${dup.name} (kept: ${group[0].name})`);
        }
      }

      if (renamed > 0 || dupeRemoved > 0) {
        writeMeta(meta, userId);
        if (renamed    > 0) console.log(`[vault/auto-organize] Renamed ${renamed} files to canonical format`);
        if (dupeRemoved > 0) console.log(`[vault/auto-organize] Auto-removed ${dupeRemoved} duplicate file(s)`);
      }

      // ── Consolidate-only mode: return after backfill + merge + cleanup ────────
      if (consolidate) {
        return res.json({ processed:0, organized:0, failed:0, skipped:0, fudgedCount:0, consolidated, renamed, duplicatesRemoved: dupeRemoved });
      }

      // ── Step 4: Gather PDF files to organize ──────────────────────────────────
      const pdfFiles = folderId
        ? meta.files.filter(f => f.folderId === folderId && f.type === 'pdf')
        : meta.files.filter(f => f.type === 'pdf' && !f.tags?.institution);

      if (!pdfFiles.length) {
        return res.json({ processed:0, organized:0, failed:0, skipped:0, consolidated });
      }

      // ── Step 5: Sort newest-first so auto-created accounts use current names ─
      const filenameDate = name => {
        const m1 = name.match(/^(\d{8})/);           if (m1) return m1[1];
        const m2 = name.match(/^(\d{4})[-._](\d{2})/); if (m2) return m2[1] + m2[2] + '00';
        return '00000000';
      };
      pdfFiles.sort((a, b) => filenameDate(b.name).localeCompare(filenameDate(a.name)));

      // ── Step 6: Extract metadata in parallel (5 at a time) ───────────────────
      const CONCURRENCY = 5;
      const extracted = [];
      for (let i = 0; i < pdfFiles.length; i += CONCURRENCY) {
        const batch = pdfFiles.slice(i, i + CONCURRENCY);
        const batchOut = await Promise.allSettled(batch.map(async (file) => {
          const filePath = path.join(vaultDir, file.folderPath, file.name);
          if (!fs.existsSync(filePath)) throw new Error('File missing from disk');
          const buffer   = fs.readFileSync(filePath);
          const detected = await extractStatementMeta(buffer);
          return { file, detected };
        }));
        extracted.push(...batchOut);
      }

      const results = { processed:0, organized:0, failed:0, skipped:0, fudgedCount:0, consolidated, duplicatesRemoved:0, details:[] };

      for (const outcome of extracted) {
        if (outcome.status === 'rejected') { results.failed++; continue; }
        const { file, detected } = outcome.value;
        results.processed++;

        // Supplement with filename-based extraction (e.g. "20190116-statements-9092-.pdf")
        const fnLast4M = file.name.match(/statements?[-_](\d{4})/i);
        const fnDateM  = file.name.match(/^(\d{4})(\d{2})\d{2}[-_.]/);
        const fnLast4  = fnLast4M ? fnLast4M[1] : null;
        const fnYear   = fnDateM  ? parseInt(fnDateM[1]) : null;
        const fnMonth  = fnDateM  ? parseInt(fnDateM[2]) : null;

        const inst  = detected.institution;
        const l4    = fnLast4 || detected.last4;
        const aName = detected.accountName;
        const year  = detected.year  || fnYear;
        const month = detected.month || fnMonth;

        // ── Account matching (priority order) ────────────────────────────────
        let matchedAcct = null;
        let autoCreated = false;

        // P1: Plaid accounts first (most authoritative)
        if (l4 && inst) {
          const instKey = inst.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            a.source === 'plaid' && a.last4 === l4 &&
            (a.institution || '').toLowerCase().includes(instKey)
          );
        }
        // P2: any account by last4 + institution
        if (!matchedAcct && l4 && inst) {
          const instKey = inst.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            a.last4 === l4 && (a.institution || '').toLowerCase().includes(instKey)
          );
        }
        // P3: any account by last4 alone
        if (!matchedAcct && l4) matchedAcct = accounts.find(a => a.last4 === l4);
        // P4: existing vault folder for same institution + last4 → use that folder's name
        if (!matchedAcct && l4 && inst) {
          const key          = `${inst.toLowerCase()}:${l4}`;
          const canonicalName = vaultFolderL4Map[key];
          if (canonicalName) {
            matchedAcct = accounts.find(a => a.name === canonicalName &&
              (a.institution||'').toLowerCase().includes(inst.toLowerCase().split(' ')[0])
            );
            if (!matchedAcct) {
              const { type, subtype } = guessAccountTypeSubtype(inst, canonicalName);
              const newAcct = {
                id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: canonicalName, institution: inst, type, subtype,
                balance: detected.closingBalance ?? 0,
                availableBalance: detected.closingBalance ?? 0,
                last4: l4, source: 'pdf_import',
                createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
              };
              accounts.push(newAcct);
              io.write('accounts.json', accounts);
              matchedAcct = newAcct;
              autoCreated = true;
            }
          }
        }
        // P5: match by institution + account name
        if (!matchedAcct && inst && aName) {
          const instKey = inst.toLowerCase().split(' ')[0];
          const nameKey = aName.toLowerCase().split(' ')[0];
          matchedAcct = accounts.find(a =>
            (a.institution || '').toLowerCase().includes(instKey) &&
            (a.name        || '').toLowerCase().includes(nameKey)
          );
        }
        // P6: auto-create (files are sorted newest-first so name comes from current PDF)
        if (!matchedAcct && inst) {
          const { type, subtype } = guessAccountTypeSubtype(inst, aName);
          const newAcct = {
            id:               `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name:             aName ? titleCase(aName) : `${inst} Account`,
            institution:      inst, type, subtype,
            balance:          detected.closingBalance ?? 0,
            availableBalance: detected.closingBalance ?? 0,
            last4:            l4 || null, source: 'pdf_import',
            createdAt:        new Date().toISOString(),
            lastUpdated:      new Date().toISOString(),
          };
          accounts.push(newAcct);
          io.write('accounts.json', accounts);
          matchedAcct = newAcct;
          autoCreated = true;
        }

        if (!matchedAcct || !inst || !year) {
          results.skipped++;
          results.details.push({ file: file.name, status: 'skipped',
            reason: !inst ? 'Institution not detected' : !year ? 'Year not detected' : 'No matching account',
          });
          continue;
        }

        const cleanName  = (matchedAcct.name || inst).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        const targetPath = `Bank Statements/${inst}/${cleanName}/${year}`;

        // ── Period duplicate / fudge detection (runs before the already-in-place check) ─
        if (l4 && year && month) {
          const mStr = String(month).padStart(2, '0');
          const existingPeriodFile = meta.files.find(f2 =>
            f2.id !== file.id && f2.type === 'pdf' &&
            f2.folderPath === targetPath &&
            f2.tags?.last4 === String(l4) &&
            f2.tags?.year  === String(year) &&
            f2.tags?.month === mStr
          );
          if (existingPeriodFile) {
            // ── Compare transactions to distinguish fudge from true duplicate ──
            // Run in a child process: pdf2json has shared global state that
            // corrupts when a pdfkit "bufferPages" PDF is parsed after another PDF
            // in the same process — resulting in hangs or wrong results.
            let isFudge = false;
            try {
              const { execFileSync } = require('child_process');
              const workerPath = path.join(__dirname, 'fudge-detect-worker.js');
              const origPath   = path.join(vaultDir, existingPeriodFile.folderPath, existingPeriodFile.name);
              const newPath    = path.join(vaultDir, file.folderPath, file.name);
              const tags       = existingPeriodFile.tags || {};
              const raw = execFileSync(
                process.execPath, [workerPath, origPath, newPath, tags.year || '', tags.month || ''],
                { cwd: __dirname, timeout: 30000, maxBuffer: 1024 * 1024 }
              );
              const { orig: origTxs, new: newTxs } = JSON.parse(raw.toString().trim());
              if (newTxs.length > 0 && origTxs.length > 0) {
                let fudgeCount = 0, matchCount = 0;
                for (const t2 of newTxs) {
                  const sameDateTxs = origTxs.filter(t1 => t1.date === t2.date);
                  if (!sameDateTxs.length) continue;
                  const minDiff = Math.min(...sameDateTxs.map(t1 =>
                    Math.abs(Math.abs(t2.amount) - Math.abs(t1.amount))
                  ));
                  if (minDiff < 0.02) matchCount++;
                  else fudgeCount++;
                }
                const total = fudgeCount + matchCount;
                isFudge = total >= 2 && (fudgeCount / total) >= 0.2;
                console.log(`[vault/fudge-detect] orig=${origTxs.length} new=${newTxs.length} fudge=${fudgeCount}/${total} isFudge=${isFudge}`);
              }
            } catch (e) {
              console.error('[vault/auto-organize] fudge detection:', e.message);
            }

            if (isFudge) {
              // Rename to a clearly flagged filename and tag as suspicious
              const flaggedName = stmtFilename(l4, year, month).replace('.pdf', '_FLAGGED.pdf');
              const srcPhys     = path.join(vaultDir, file.folderPath, file.name);
              const dstPhys     = path.join(vaultDir, file.folderPath, flaggedName);
              if (file.name !== flaggedName && fs.existsSync(srcPhys)) {
                try { fs.renameSync(srcPhys, dstPhys); } catch {}
              }
              const fi = meta.files.findIndex(f2 => f2.id === file.id);
              if (fi >= 0) {
                if (file.name !== flaggedName) meta.files[fi].name = flaggedName;
                meta.files[fi].tags = {
                  ...meta.files[fi].tags,
                  institution: inst, account: matchedAcct.name,
                  ...(l4    && { last4: String(l4) }),
                  ...(year  && { year:  String(year) }),
                  ...(month && { month: mStr }),
                  fudge: true, fudgeOf: existingPeriodFile.id,
                };
              }
              results.fudgedCount = (results.fudgedCount || 0) + 1;
              console.log(`[vault/auto-organize] Fudge detected: ${file.name} vs ${existingPeriodFile.name}`);
              continue;
            } else if (file.folderPath !== targetPath) {
              // True duplicate arriving from a different folder — auto-remove
              const srcPath = path.join(vaultDir, file.folderPath, file.name);
              try { if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath); } catch {}
              const fi = meta.files.findIndex(f2 => f2.id === file.id);
              if (fi >= 0) meta.files.splice(fi, 1);
              results.duplicatesRemoved++;
              console.log(`[vault/auto-organize] Auto-removed duplicate: ${file.name} (kept: ${existingPeriodFile.name})`);
              continue;
            } else {
              // True duplicate already in target folder — silently ignore
              continue;
            }
          }
        }

        // Already in the correct place with no period conflict — skip silently (not an error)
        if (file.folderPath === targetPath) { continue; }

        // Move physical file — use canonical filename immediately if we have all tags
        const targetFolderId = ensureFolderPath(targetPath);
        let   dstName = (l4 && year && month) ? stmtFilename(l4, year, month) : file.name;
        if (fs.existsSync(path.join(vaultDir, targetPath, dstName))) {
          // Shouldn't reach here (period-exact check above should have caught it),
          // but guard just in case a file exists on disk but not in meta
          const base = path.basename(dstName, path.extname(dstName));
          dstName    = `${base}_${Date.now()}${path.extname(dstName)}`;
        }
        fs.renameSync(
          path.join(vaultDir, file.folderPath, file.name),
          path.join(vaultDir, targetPath, dstName)
        );

        const fileIdx = meta.files.findIndex(f2 => f2.id === file.id);
        if (fileIdx >= 0) {
          meta.files[fileIdx].name       = dstName;
          meta.files[fileIdx].folderPath = targetPath;
          meta.files[fileIdx].folderId   = targetFolderId;
          meta.files[fileIdx].tags = {
            ...meta.files[fileIdx].tags,
            institution: inst, account: matchedAcct.name,
            ...(l4    && { last4: l4 }),
            ...(year  && { year:  String(year) }),
            ...(month && { month: String(month).padStart(2, '0') }),
          };
        }
        results.organized++;
        results.details.push({ file: dstName, status: 'organized', targetPath,
          institution: inst, account: matchedAcct.name, year, month, autoCreated });
      }

      writeMeta(meta, userId);

      // ── Clean up source folder and any now-empty ancestor folders ───────────
      // Walk up the parentId chain, removing every folder that becomes empty
      // after its children are organized out. This prevents ghost empty parent
      // folders (e.g. "statements") from lingering and blocking future re-uploads.
      if (folderId) {
        let cleanId      = folderId;
        let firstDeleted = null;
        while (cleanId) {
          const cleanHasFiles    = meta.files.some(f => f.folderId === cleanId);
          const cleanHasChildren = meta.folders.some(f => f.parentId === cleanId);
          if (cleanHasFiles || cleanHasChildren) break; // still has content — stop
          const cleanFolder = meta.folders.find(f => f.id === cleanId);
          if (!cleanFolder) break;
          if (!firstDeleted) firstDeleted = cleanFolder; // remember the first (deepest) one
          const nextParent = cleanFolder.parentId;
          try {
            const physPath = path.join(vaultDir, cleanFolder.path);
            if (fs.existsSync(physPath)) fs.rmSync(physPath, { recursive: true, force: true });
          } catch {}
          meta.folders = meta.folders.filter(f => f.id !== cleanId);
          cleanId = nextParent;
        }
        if (firstDeleted) {
          writeMeta(meta, userId);
          results.sourceFolderDeleted = true;
          results.sourceFolderName    = firstDeleted.name;
        }
      }

      results.renamed = renamed;
      console.log(`[vault/auto-organize] ${results.organized}/${results.processed} sorted, ${results.duplicatesRemoved} dupes removed, ${results.fudgedCount} flagged, ${results.skipped} skipped, ${results.failed} failed, ${consolidated} consolidated, ${renamed} renamed`);
      res.json(results);
    } catch (e) {
      console.error('[vault/auto-organize]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/vault/extract-stats ───────────────────────────────────────────
  // Scans all organized PDFs that haven't had financial stats extracted yet,
  // runs parsePDFTransactions on each (5 at a time), and caches income/spending/net
  // in the file's tags so the vault list can show them without a manual click.
  router.post('/extract-stats', async (req, res) => {
    try {
      const { parsePDFTransactions } = require('./pdf-parser');
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);

      // Process organized PDFs that either haven't been scanned yet, or were scanned
      // but returned 0 transactions (income still undefined) — retry up to 3 times
      // in case the parser improves between runs.
      const needsStats = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.institution &&
        f.tags?.year &&
        f.tags?.month &&
        f.tags?.income === undefined &&
        (f.tags?.statsAttempts || 0) < 3
      );

      if (!needsStats.length) return res.json({ processed: 0 });

      let processed = 0;
      const CONC = 5;
      for (let i = 0; i < needsStats.length; i += CONC) {
        await Promise.allSettled(needsStats.slice(i, i + CONC).map(async (f) => {
          const fp = path.join(vaultDir, f.folderPath, f.name);
          if (!fs.existsSync(fp)) return;
          try {
            const buffer       = fs.readFileSync(fp);
            const transactions = await parsePDFTransactions(buffer, f.tags || {});
            const fi         = meta.files.findIndex(x => x.id === f.id);
            if (fi < 0) return;
            const txIncome   = +transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0).toFixed(2);
            const txSpending = +transactions.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0).toFixed(2);
            // Always write income/spending/net — even 0 — so the UI shows $0 instead of "—"
            // for months that genuinely have no parseable transactions.
            meta.files[fi].tags = {
              ...meta.files[fi].tags,
              statsProcessed: true,
              statsAttempts:  (meta.files[fi].tags.statsAttempts || 0) + 1,
              income:   txIncome,
              spending: txSpending,
              net:      +(txIncome + txSpending).toFixed(2),
              txCount:  transactions.length,
            };
            processed++;
          } catch {}
        }));
      }

      if (processed > 0) writeMeta(meta, userId);
      console.log(`[vault/extract-stats] Cached stats for ${processed}/${needsStats.length} PDFs`);
      res.json({ processed });
    } catch (e) {
      console.error('[vault/extract-stats]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/vault/find-duplicates ──────────────────────────────────────────
  // body: { fileIds?: string[], includeTextSimilarity?: boolean }
  //   fileIds               — IDs to check; omit = scan all Bank Statement PDFs (period-exact only)
  //   includeTextSimilarity — also compare PDF text content (requires fileIds; expensive)
  // returns: { pairs: [{ fileA, fileB, similarity, reason }] }
  router.post('/find-duplicates', async (req, res) => {
    try {
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      const meta     = readMeta(userId);
      const { fileIds, includeTextSimilarity = false } = req.body;

      // All Bank Statement PDFs with period tags
      const allTagged = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.last4 && f.tags?.year && f.tags?.month &&
        f.folderPath?.startsWith('Bank Statements/')
      );

      const targetIds = fileIds?.length ? new Set(fileIds) : null;

      // ── Period-exact check: group by last4::year::month ───────────────────
      const periodGroups = {};
      for (const f of allTagged) {
        const key = `${f.tags.last4}::${f.tags.year}::${f.tags.month}`;
        if (!periodGroups[key]) periodGroups[key] = [];
        periodGroups[key].push(f);
      }

      const pairs     = [];
      const seenPairs = new Set();

      for (const group of Object.values(periodGroups)) {
        if (group.length < 2) continue;
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const fA = group[i], fB = group[j];
            // If fileIds given, at least one must be in the set
            if (targetIds && !targetIds.has(fA.id) && !targetIds.has(fB.id)) continue;
            const pk = [fA.id, fB.id].sort().join('|');
            if (seenPairs.has(pk)) continue;
            seenPairs.add(pk);
            pairs.push({
              fileA:      { id: fA.id, name: fA.name, folderPath: fA.folderPath, tags: fA.tags },
              fileB:      { id: fB.id, name: fB.name, folderPath: fB.folderPath, tags: fB.tags },
              similarity: 1.0,
              reason:     'Same statement period',
            });
          }
        }
      }

      // ── Text similarity check (opt-in, requires fileIds) ─────────────────
      if (includeTextSimilarity && targetIds) {
        const { extractRawText } = require('./pdf-parser');
        const targets    = allTagged.filter(f => targetIds.has(f.id));
        const textCache  = new Map();

        const getText = async (f) => {
          if (textCache.has(f.id)) return textCache.get(f.id);
          const fp = path.join(vaultDir, f.folderPath, f.name);
          if (!fs.existsSync(fp)) { textCache.set(f.id, ''); return ''; }
          try {
            const t = await extractRawText(fs.readFileSync(fp));
            textCache.set(f.id, t); return t;
          } catch { textCache.set(f.id, ''); return ''; }
        };

        for (const fileA of targets) {
          if (!fileA.tags?.last4) continue;
          // Compare against same-account files (same last4), skip already-found pairs
          const neighbors = allTagged.filter(f =>
            f.id !== fileA.id &&
            f.tags.last4 === fileA.tags.last4 &&
            !seenPairs.has([fileA.id, f.id].sort().join('|'))
          ).slice(0, 20); // cap comparisons per file

          for (const fileB of neighbors) {
            const pk = [fileA.id, fileB.id].sort().join('|');
            if (seenPairs.has(pk)) continue;
            seenPairs.add(pk);

            const [textA, textB] = await Promise.all([getText(fileA), getText(fileB)]);
            if (!textA || !textB || textA.length < 100) continue;

            const sim = wordJaccard(textA, textB);
            if (sim >= DUPE_SIMILARITY_THRESHOLD) {
              pairs.push({
                fileA:      { id: fileA.id, name: fileA.name, folderPath: fileA.folderPath, tags: fileA.tags },
                fileB:      { id: fileB.id, name: fileB.name, folderPath: fileB.folderPath, tags: fileB.tags },
                similarity: Math.round(sim * 1000) / 1000,
                reason:     'Highly similar content',
              });
            }
          }
        }
      }

      console.log(`[vault/find-duplicates] Found ${pairs.length} duplicate pair(s)`);
      res.json({ pairs });
    } catch (e) {
      console.error('[vault/find-duplicates]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/vault/parse-statement-local/:id — extract transactions (no AI) ──
  // Full pipeline: parse PDF → detect metadata → match/create account →
  // auto-organize vault file → tag file → return everything
  router.post('/parse-statement-local/:id', async (req, res) => {
    try {
      const { parsePDFTransactions, extractStatementMeta, guessAccountTypeSubtype } = require('./pdf-parser');
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);                    // may be mutated below
      const file     = meta.files.find(f => f.id === req.params.id);
      if (!file)                return res.status(404).json({ error: 'File not found' });
      if (file.type !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be parsed' });

      let filePath = path.join(vaultDir, file.folderPath, file.name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

      const buffer = fs.readFileSync(filePath);

      // ── 1. Parse transactions + extract metadata in parallel ────────────────
      const [transactions, detected] = await Promise.all([
        parsePDFTransactions(buffer, file.tags || {}),
        extractStatementMeta(buffer),
      ]);

      // ── 2. Account matching / auto-creation ─────────────────────────────────
      let accounts     = io.read('accounts.json') || [];
      let matchedAcct  = null;
      let autoCreated  = false;

      // Supplement with filename-based extraction (e.g. "20190116-statements-9092-.pdf")
      const fnLast4M2 = file.name.match(/statements?[-_](\d{4})/i);
      const fnDateM2  = file.name.match(/^(\d{4})(\d{2})\d{2}[-_.]/);
      const fnLast4_2 = fnLast4M2 ? fnLast4M2[1] : null;
      const fnYear2   = fnDateM2  ? parseInt(fnDateM2[1]) : null;
      const fnMonth2  = fnDateM2  ? parseInt(fnDateM2[2]) : null;

      const inst  = detected.institution || file.tags?.institution || null;
      const l4    = fnLast4_2 || detected.last4 || file.tags?.last4 || null;
      const aName = detected.accountName || file.tags?.account     || null;
      // Use PDF-detected year/month first; fall back to filename-parsed, then file tags
      const detYear  = detected.year  || fnYear2  || (file.tags?.year  ? parseInt(file.tags.year)  : null);
      const detMonth = detected.month || fnMonth2 || (file.tags?.month ? parseInt(file.tags.month) : null);

      if (l4 && inst) {
        // Most precise: last4 + institution prefix
        const instKey = inst.toLowerCase().split(' ')[0];
        matchedAcct = accounts.find(a =>
          a.last4 === l4 && (a.institution || '').toLowerCase().includes(instKey)
        );
      }
      if (!matchedAcct && l4) {
        // last4 alone (rare collision risk but usually fine)
        matchedAcct = accounts.find(a => a.last4 === l4);
      }
      if (!matchedAcct && inst && aName) {
        // institution + account name prefix
        const instKey  = inst.toLowerCase().split(' ')[0];
        const nameKey  = aName.toLowerCase().split(' ')[0];
        matchedAcct = accounts.find(a =>
          (a.institution || '').toLowerCase().includes(instKey) &&
          (a.name        || '').toLowerCase().includes(nameKey)
        );
      }

      if (!matchedAcct && inst) {
        // Auto-create a manual account from detected metadata
        const { type, subtype } = guessAccountTypeSubtype(inst, aName);
        const newAcct = {
          id:               `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name:             aName ? titleCase(aName) : `${inst} Account`,
          institution:      inst,
          type, subtype,
          balance:          detected.closingBalance ?? 0,
          availableBalance: detected.closingBalance ?? 0,
          last4:            l4 || null,
          source:           'pdf_import',
          createdAt:        new Date().toISOString(),
          lastUpdated:      new Date().toISOString(),
        };
        accounts.push(newAcct);
        io.write('accounts.json', accounts);
        matchedAcct = newAcct;
        autoCreated = true;
        console.log(`[vault/parse-local] Auto-created account: ${newAcct.name} (${inst})`);
      }

      // ── 3. Auto-organize vault file into correct folder ─────────────────────
      let organized = false;
      let newFolderPath = file.folderPath;

      if (inst && detYear && matchedAcct) {
        const cleanName  = (matchedAcct.name || inst).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        const targetPath = `Bank Statements/${inst}/${cleanName}/${detYear}`;

        if (file.folderPath !== targetPath) {
          // Ensure target folder exists in meta + on disk
          const parts = targetPath.split('/').filter(Boolean);
          let parentId = null;
          for (let i = 0; i < parts.length; i++) {
            const fullPath = parts.slice(0, i + 1).join('/');
            let f = meta.folders.find(x => x.path === fullPath);
            if (!f) {
              f = {
                id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: parts[i], path: fullPath, parentId,
                createdAt: new Date().toISOString(), tags: {},
              };
              meta.folders.push(f);
              fs.mkdirSync(path.join(vaultDir, fullPath), { recursive: true });
            }
            parentId = f.id;
          }

          // Move physical file
          const srcPath  = path.join(vaultDir, file.folderPath, file.name);
          const dstDir   = path.join(vaultDir, targetPath);
          const dstPath  = path.join(dstDir, file.name);
          fs.mkdirSync(dstDir, { recursive: true });
          fs.renameSync(srcPath, dstPath);

          // Update file entry in vault meta
          const fileIdx = meta.files.findIndex(f => f.id === file.id);
          if (fileIdx >= 0) {
            meta.files[fileIdx].folderPath = targetPath;
            meta.files[fileIdx].folderId   = parentId;
          }

          newFolderPath = targetPath;
          organized     = true;
          filePath      = dstPath;
          console.log(`[vault/parse-local] Organized: ${file.name} → ${targetPath}`);
        }
      }

      // ── 4. Update file tags with detected metadata + bake in financial stats ────
      const txIncome   = +transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0).toFixed(2);
      const txSpending = +transactions.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0).toFixed(2);
      const fileIdx = meta.files.findIndex(f => f.id === file.id);
      if (fileIdx >= 0) {
        meta.files[fileIdx].tags = {
          ...meta.files[fileIdx].tags,
          ...(inst              && { institution: inst }),
          ...(matchedAcct?.name && { account: matchedAcct.name }),
          ...(l4                && { last4: l4 }),
          ...(detYear           && { year: String(detYear) }),
          ...(detMonth          && { month: String(detMonth).padStart(2, '0') }),
          ...(transactions.length && {
            income:   txIncome,
            spending: txSpending,
            net:      +(txIncome + txSpending).toFixed(2),
            txCount:  transactions.length,
          }),
        };
      }
      writeMeta(meta, userId);

      res.json({
        transactions,
        count:        transactions.length,
        accountId:    matchedAcct?.id   || null,
        accountName:  matchedAcct?.name || aName,
        institution:  inst,
        last4:        l4,
        year:         detYear,
        month:        detMonth,
        autoCreated,
        organized,
        newFolderPath: organized ? newFolderPath : null,
      });
    } catch (e) {
      console.error('[vault/parse-statement-local]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/vault/parse-statement/:id — extract transactions via Claude ──
  router.post('/parse-statement/:id', async (req, res) => {
    try {
      const userId  = req.user.id;
      const io      = makeIO(userId);
      const meta    = readMeta(userId);
      const file    = meta.files.find(f => f.id === req.params.id);
      if (!file)                return res.status(404).json({ error: 'File not found' });
      if (file.type !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be parsed' });

      const filePath = path.join(getUserVaultDir(userId), file.folderPath, file.name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
        return res.status(503).json({ error: 'AI Advisor not configured — add ANTHROPIC_API_KEY to .env to enable statement parsing' });
      }

      const base64 = fs.readFileSync(filePath).toString('base64');
      const { year, month, account: acctName, institution } = file.tags || {};
      const periodHint = year ? ` The statement is for ${institution || 'a bank'} — use ${year} as the year for all transaction dates.` : '';

      const axios = require('axios');
      const response = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-opus-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: `Extract every transaction from this bank statement.${periodHint} Return ONLY a raw JSON array — no markdown fences, no explanation. Each element: { "date": "YYYY-MM-DD", "desc": "merchant or description", "amount": -45.23 }. Negative amounts for debits/withdrawals/purchases. Positive for credits/deposits. Include ALL transactions. If the statement period spans two calendar years, use the correct year per transaction date.` }
        ]}]
      }, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });

      const raw = response.data.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);

      // Look up account by name from tags
      const accounts = io.read('accounts.json') || [];
      const acct     = accounts.find(a => a.name === acctName) || null;

      const transactions = parsed
        .filter(t => t.date && t.amount != null && !isNaN(parseFloat(t.amount)))
        .map((t, i) => {
          const d = new Date(t.date);
          return {
            id:          `pdf_${Date.now()}_${i}`,
            date:        t.date,
            desc:        (t.desc || t.description || '').slice(0, 100),
            amount:      parseFloat(t.amount),
            category:    'Other',
            source:      'csv_import',   // treated same as imported data for cleanup purposes
            month:       isNaN(d) ? (year && month ? `${year}-${String(month).padStart(2,'0')}` : '') : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,
            institution: institution || acct?.institution || '',
          };
        })
        .filter(t => t.month);

      res.json({
        transactions,
        count:       transactions.length,
        accountId:   acct?.id   || null,
        accountName: acctName   || null,
        institution: institution || null,
      });
    } catch (e) {
      console.error('[vault/parse-statement]', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error?.message || e.message });
    }
  });

  // ── PATCH /api/vault/file/:id ─────────────────────────────────────────
  router.patch('/file/:id', (req, res) => {
    try {
      const userId = req.user.id;
      const meta   = readMeta(userId);
      const idx    = meta.files.findIndex(f => f.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      meta.files[idx] = { ...meta.files[idx], ...req.body, updatedAt: new Date().toISOString() };
      writeMeta(meta, userId);
      res.json(meta.files[idx]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/vault/export — download entire vault as ZIP ──────────────
  router.get('/export', (req, res) => {
    const userId   = req.user.id;
    const vaultDir = getUserVaultDir(userId);
    const meta     = readMeta(userId);

    if (!meta.files.length) {
      return res.status(400).json({ error: 'Vault is empty — nothing to export.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="caishen-vault-${userId}-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', e => { console.error('ZIP error:', e.message); res.status(500).end(); });
    archive.pipe(res);

    for (const file of meta.files) {
      const filePath = path.join(vaultDir, file.folderPath, file.name);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: path.join(file.folderPath, file.name) });
      }
    }

    archive.finalize();
  });

  // ── DELETE /api/vault — permanently wipe all vault data ──────────────
  router.delete('/', (req, res) => {
    try {
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);

      if (fs.existsSync(vaultDir)) {
        fs.rmSync(vaultDir, { recursive: true, force: true });
      }

      writeMeta({ folders: [], files: [] }, userId);

      // Remove ALL transactions when vault is wiped (user can re-sync Plaid to restore)
      io.write('transactions.json', []);

      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
