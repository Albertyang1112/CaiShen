const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const {
  validateUploadFile, getFileType, detectTaxFormTags, autoTag,
  titleCase, stmtFilename, wordJaccard, upload, DUPE_SIMILARITY_THRESHOLD,
} = require('./helpers');

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
  // Bytes go to R2 (core/documents); metadata to the documents table + vault.json.
  // NOTHING touches local disk. A file whose month+year already exists in the same
  // folder is NOT auto-replaced — it's returned as a `conflict` for the user to resolve
  // (send conflictResolution: { "<key>": "replace" | "keep" } on the retry).
  router.post('/upload', upload.array('files'), async (req, res) => {
    try {
      const userId     = req.user.id;
      const meta       = readMeta(userId);
      const folderPath = req.body.folderPath || 'Uploads';
      const documents  = require('../core/documents');
      let resolutions  = {};
      try { resolutions = req.body.conflictResolution ? JSON.parse(req.body.conflictResolution) : {}; } catch (e) {}

      // ── Validate every file first ─────────────────────────────────────
      const rejections = [];
      for (const file of req.files || []) {
        const err = validateUploadFile(file.originalname, file.mimetype);
        if (err) rejections.push({ name: file.originalname, reason: err });
      }
      if (rejections.length > 0) {
        return res.status(400).json({
          error: 'One or more files were rejected.', rejected: rejections,
          hint: 'The vault only accepts financial documents: PDF, CSV, Excel, images (JPG/PNG), and Word docs.',
        });
      }

      // ── Ensure the folder tree exists in metadata (no disk) ───────────
      const parts = folderPath.split('/').filter(Boolean);
      let parentId = null, currentFolderId = null;
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i], fullPath = parts.slice(0, i + 1).join('/');
        let folder = meta.folders.find(f => f.path === fullPath);
        if (!folder) {
          folder = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name, path: fullPath, parentId, createdAt: new Date().toISOString(), tags: autoTag(fullPath) };
          meta.folders.push(folder);
        }
        parentId = folder.id; currentFolderId = folder.id;
      }

      const uploaded = [], conflicts = [];
      for (const file of req.files || []) {
        // Year/month from the filename (e.g. "2026-03 …", "20260331-…").
        const d1 = file.originalname.match(/^(\d{4})[-._\s](\d{2})\b/);
        const d2 = !d1 && file.originalname.match(/^(\d{4})(\d{2})\d{2}[-_.]/);
        const ym = d1 ? { year: d1[1], month: d1[2] } : d2 ? { year: d2[1], month: d2[2] } : {};
        const tags = { ...autoTag(folderPath), ...ym, ...detectTaxFormTags(file.originalname) };

        // Conflict = same month+year already in this folder (preferred), else same filename.
        const existing = (ym.year && ym.month)
          ? meta.files.find(f => f.folderPath === folderPath && f.tags && f.tags.year === ym.year && f.tags.month === ym.month)
          : meta.files.find(f => f.folderId === currentFolderId && f.name === file.originalname);
        const key = (ym.year && ym.month) ? `${ym.year}-${ym.month}|${folderPath}` : `name|${folderPath}|${file.originalname}`;

        if (existing) {
          const choice = resolutions[key];
          if (!choice) {
            conflicts.push({
              key,
              incoming: { name: file.originalname, size: file.size, year: ym.year || null, month: ym.month || null },
              existing: { id: existing.id, name: existing.name, size: existing.size, createdAt: existing.createdAt },
            });
            continue; // hold this file until the user decides which to keep
          }
          if (choice === 'keep') continue;            // keep existing, drop the upload
          if (choice === 'replace') {                 // remove existing (R2 + row + meta), then store the new
            try { await documents.deleteDocument(userId, existing.id); } catch (e) {}
            meta.files = meta.files.filter(f => f.id !== existing.id);
          }
        }

        // Store: bytes → R2, metadata row → documents table.
        const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
        await documents.saveDocument({
          id: fileId, userId, name: file.originalname, mimeType: file.mimetype, bytes: file.buffer,
          folderPath, tags, periodYear: ym.year ? parseInt(ym.year) : null, periodMonth: ym.month ? parseInt(ym.month) : null,
        });
        const newFile = {
          id: fileId, name: file.originalname, folderId: currentFolderId, folderPath, size: file.size,
          type: getFileType(file.originalname), mimeType: file.mimetype,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1, tags,
        };
        meta.files.push(newFile); uploaded.push(newFile);
      }
      writeMeta(meta, userId);
      res.json({ success: true, uploaded: uploaded.length, files: uploaded, conflicts });
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
  router.get('/file/:id', async (req, res) => {
    const userId = req.user.id;
    const meta   = readMeta(userId);
    const file   = meta.files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
    // Serve from R2 (bytes are off-machine); fall back to local disk for anything
    // not yet migrated. R2 access stays behind this route's auth (no public URL).
    try {
      const bytes = await require('../core/documents').getDocumentBytes(userId, req.params.id);
      if (bytes) return res.send(bytes);
    } catch (e) { /* fall through to disk */ }
    const filePath = path.join(getUserVaultDir(userId), file.folderPath, file.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });
    res.sendFile(filePath);
  });

  // ── DELETE /api/vault/file/:id ────────────────────────────────────────
  router.delete('/file/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const meta   = readMeta(userId);
      const file   = meta.files.find(f => f.id === req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      // Delete the bytes from R2 + the documents row (no disk). A statement is now a
      // plain document — deleting it no longer wipes transactions (those are Plaid data).
      try { await require('../core/documents').deleteDocument(userId, req.params.id); }
      catch (e) { console.error('[vault] R2 delete:', e.message); }
      meta.files = meta.files.filter(f => f.id !== req.params.id);
      writeMeta(meta, userId);
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

  // ── POST /api/vault/auto-organize — classify each PDF with AI, sort into folders ──
  // body: { folderId?, consolidate?, duplicateResolutions? }
  //   folderId   — limit to PDFs in this folder (omit = all un-sorted PDFs)
  //   consolidate — no-op for the AI sorter (kept for client compatibility)
  // Powered by Groq (vault/ai-organize.js → ai-sort.js); replaces the old heuristic.
  router.post('/auto-organize', require('./ai-organize')({ getUserVaultDir, makeIO, readMeta, writeMeta }));

  // ── Vault review — propose cleanups (dup files, empty/redundant folders); apply on approval ──
  {
    const { reviewHandler, applyHandler } = require('./ai-review')({ getUserVaultDir, makeIO, readMeta, writeMeta });
    router.post('/review', reviewHandler);
    router.post('/review/apply', applyHandler);
  }

  // ── POST /api/vault/extract-stats ───────────────────────────────────────────
  // Caches each statement's income/spending/net from its STATED period totals
  // (Beginning Balance / Deposits / Ending Balance) — read deterministically from the
  // text when possible, else via Groq validated by the balance equation. This is far
  // steadier than summing individual transactions with an LLM (which wobbles between
  // runs). Transaction-summing remains only as a last-resort fallback.
  // body: { fileIds? } — force re-extraction of those files; otherwise only statements
  // without stats yet (retry up to 3×).
  router.post('/extract-stats', async (req, res) => {
    try {
      const { extractTransactions, extractSummary } = require('./ai-extract');
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);

      const { fileIds, revalidate } = req.body || {};
      const want = Array.isArray(fileIds) && fileIds.length ? new Set(fileIds) : null;

      // Normally only statements without stats yet. `revalidate: true` re-checks EVERY
      // statement and corrects any whose figures changed — the retroactive fix for a
      // value that got cached wrong (e.g. a rate-limited extraction that stored $0).
      const needsStats = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.institution &&
        !f.tags?.mortgage &&            // mortgage statements aren't bank-transaction PDFs
        f.tags?.year &&
        f.tags?.month &&
        (want
          ? want.has(f.id)
          : revalidate
            ? true
            : (f.tags?.income === undefined && (f.tags?.statsAttempts || 0) < 3))
      );

      if (!needsStats.length) return res.json({ processed: 0, corrected: 0 });

      let processed = 0, corrected = 0;
      // Sequential — one statement at a time keeps Groq under its rate limit.
      for (const f of needsStats) {
        try {
          let buffer = await require('../core/documents').getDocumentBytes(userId, f.id);
          if (!buffer) {
            const fp = path.join(vaultDir, f.folderPath, f.name);
            buffer = fs.existsSync(fp) ? fs.readFileSync(fp) : null;
          }
          if (!buffer) continue;

          // 1. Period totals from the stated summary (deterministic, or Groq-validated).
          let stats = null;   // { income, spending, net, txCount? }
          try {
            const s = await extractSummary(buffer, { year: f.tags?.year });
            if (s.income != null) stats = { income: s.income, spending: s.spending, net: s.net };
          } catch (e) { console.error('[vault/extract-stats] summary:', e.message); }

          // 2. Last resort — sum transactions (only a trustworthy, non-empty result).
          if (!stats) {
            try {
              const r = await extractTransactions(buffer, { year: f.tags?.year });
              if (!r.needsOcr && !r.suspicious && r.transactions.length) {
                const inc = +r.transactions.filter(t => t.amount > 0).reduce((a, t) => a + t.amount, 0).toFixed(2);
                const spd = +r.transactions.filter(t => t.amount < 0).reduce((a, t) => a + t.amount, 0).toFixed(2);
                stats = { income: inc, spending: spd, net: +(inc + spd).toFixed(2), txCount: r.transactions.length };
              }
            } catch (e) { console.error('[vault/extract-stats] txns:', e.message); }
          }

          const fi = meta.files.findIndex(x => x.id === f.id);
          if (fi < 0) continue;
          if (!stats) {                                 // couldn't read it reliably — retry later, don't cache a fake $0
            meta.files[fi].tags = { ...meta.files[fi].tags, statsAttempts: (meta.files[fi].tags.statsAttempts || 0) + 1 };
            continue;
          }
          const prev = meta.files[fi].tags || {};
          const changed = prev.income !== stats.income || prev.spending !== stats.spending;
          meta.files[fi].tags = {
            ...prev,
            statsProcessed: true,
            statsAttempts:  (prev.statsAttempts || 0) + 1,
            income:   stats.income,
            spending: stats.spending,
            net:      stats.net,
            ...(stats.txCount != null && { txCount: stats.txCount }),
          };
          processed++;
          if (changed && prev.income !== undefined) corrected++;   // a previously-cached value we just fixed
        } catch {}
      }

      if (processed > 0) writeMeta(meta, userId);
      console.log(`[vault/extract-stats] ${processed}/${needsStats.length} processed, ${corrected} corrected`);
      res.json({ processed, corrected });
    } catch (e) {
      console.error('[vault/extract-stats]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/vault/index-statements ────────────────────────────────────────
  // Closes the loop: mirror an uploaded statement's transactions into the DB and
  // reconcile them against Plaid, so an upload flows straight through to the Banking
  // tab. Reuses the existing banking reconciler (parse → mirror → reconcile) as-is —
  // no changes to it. Body: { fileIds?: [...] } limits to those files; otherwise
  // every Bank-Statements PDF is re-indexed (mirrorStatement is idempotent).
  router.post('/index-statements', async (req, res) => {
    try {
      const userId    = req.user.id;
      const io        = makeIO(userId);
      const meta      = readMeta(userId);
      const { query } = require('../core/db');
      const documents = require('../core/documents');
      const { parseStatement, mirrorStatement, reconcileUser } = require('../banking/reconciler');

      const { fileIds } = req.body || {};
      let targets = meta.files.filter(f =>
        f.type === 'pdf' && (f.folderPath || '').startsWith('Bank Statements/'));
      if (Array.isArray(fileIds) && fileIds.length) {
        const want = new Set(fileIds);
        targets = targets.filter(f => want.has(f.id));
      }

      let statements = 0, mirrored = 0, failed = 0;
      for (const f of targets) {
        try {
          const bytes = await documents.getDocumentBytes(userId, f.id);
          if (!bytes) { failed++; continue; }
          const rows = await parseStatement(bytes, f.name);   // PDF → [{date,amount,desc}]
          if (!rows.length) { failed++; continue; }
          mirrored += await mirrorStatement(query, userId, rows, f.name, { documentId: f.id }); // → source_transactions (+ period, bank_statement)
          statements++;
        } catch (e) { failed++; console.error('[vault/index-statements]', f.name, e.message); }
      }

      // Compare to Plaid + (re)populate statement_matches — the Banking badges read these.
      let reconcile = null;
      if (statements > 0) {
        try { reconcile = await reconcileUser(query, userId, io); }
        catch (e) { console.error('[vault/index-statements] reconcile:', e.message); }
      }
      console.log(`[vault/index-statements] ${statements} statement(s), ${mirrored} rows mirrored, ${failed} failed`);
      res.json({ statements, mirrored, failed, reconcile });
    } catch (e) {
      console.error('[vault/index-statements]', e.message);
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
        const { extractRawText } = require('../core/pdf-parser');
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
      const { parsePDFTransactions, extractStatementMeta, guessAccountTypeSubtype } = require('../core/pdf-parser');
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

  // ── POST /api/vault/parse-tax-form/:id — extract tax form boxes via Claude ──
  // Reads the PDF from disk, sends to Claude, caches result in file.tags.taxFormData.
  // On repeat calls the cached result is returned without re-calling the API.
  router.post('/parse-tax-form/:id', async (req, res) => {
    try {
      const { extractTaxFormData, detectFormTypeFromFilename } = require('../tax/form-parser');
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      let   meta     = readMeta(userId);
      const file     = meta.files.find(f => f.id === req.params.id);
      if (!file)                return res.status(404).json({ error: 'File not found' });
      if (file.type !== 'pdf') return res.status(400).json({ error: 'Only PDF files can be parsed as tax forms' });

      const filePath = path.join(vaultDir, file.folderPath, file.name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

      // Return cached result if already extracted (skip API call)
      if (file.tags?.taxFormData && !req.body?.force) {
        return res.json({ cached: true, ...file.tags.taxFormData });
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured — add it to .env to enable tax form extraction' });
      }

      const buffer   = fs.readFileSync(filePath);
      const formData = await extractTaxFormData(buffer, file.name);

      // Fill in formType from filename if Claude didn't detect it
      if (!formData.formType) {
        formData.formType = detectFormTypeFromFilename(file.name) || 'Unknown';
      }

      // Cache in vault metadata
      const fi = meta.files.findIndex(f => f.id === file.id);
      if (fi >= 0) {
        meta.files[fi].tags = {
          ...meta.files[fi].tags,
          taxFormType: formData.formType,
          taxFormData: formData,
          taxFormExtractedAt: new Date().toISOString(),
        };
      }
      writeMeta(meta, userId);

      res.json({ cached: false, ...formData });
    } catch (e) {
      console.error('[vault/parse-tax-form]', e.response?.data || e.message);
      res.status(500).json({ error: e.response?.data?.error?.message || e.message });
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

  // ── POST /api/vault/verify ─────────────────────────────────────────────
  // Compares each organized PDF statement against settled Plaid transactions.
  // Sets file.tags.verificationStatus:
  //   'verified'     — ≥70% of PDF transactions matched in Plaid (permanent)
  //   'unverified'   — Plaid exists but match rate is low, OR file is flagged fudge
  //   'no_plaid_data'— no settled Plaid transactions for that account+month
  // Once 'verified', the status is NEVER downgraded automatically.
  router.post('/verify', async (req, res) => {
    try {
      const { execFileSync } = require('child_process');
      const workerPath = path.join(__dirname, 'pdf-parse-worker.js');
      const userId   = req.user.id;
      const io       = makeIO(userId);
      const vaultDir = getUserVaultDir(userId);
      const meta     = readMeta(userId);
      const allTxs   = io.read('transactions.json') || [];
      const accounts = io.read('accounts.json') || [];

      // Only settled Plaid transactions are reliable for matching
      const plaidTxs = allTxs.filter(t => t.source === 'plaid' && !t.pending);

      // Month abbreviation → 2-digit month
      const MONTH_ABBR = {
        jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
        jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12',
      };

      // Build candidate list — include fudge-named files even if missing year/month tags
      const isFudgeName = (name) => /fudged|_flagged/i.test(name);
      const candidates  = meta.files.filter(f =>
        f.type === 'pdf' &&
        f.tags?.institution &&
        !f.tags?.mortgage &&                          // mortgages have no Plaid txns to match
        f.tags?.verificationStatus !== 'verified' && // frozen once verified
        (
          (f.tags?.year && f.tags?.month) ||          // normal organized file
          f.tags?.fudge === true ||                    // fudge-tagged
          isFudgeName(f.name)                          // fudge-named
        )
      );

      const counts = { verified: 0, unverified: 0, noPlaidData: 0, failed: 0 };
      let changed = false;

      for (const file of candidates) {
        const fi = meta.files.findIndex(x => x.id === file.id);
        if (fi < 0) continue;

        // Resolve year/month — from tags or filename
        let { last4, year, month } = file.tags || {};
        if (!year || !month) {
          // e.g. "9092 Statement May 2026 (fudged).pdf"
          const m = file.name.match(/Statement\s+([A-Za-z]{3})\s+(\d{4})/i);
          if (m) { month = MONTH_ABBR[m[1].toLowerCase()]; year = m[2]; }
        }
        if (!year || !month) { counts.failed++; continue; }

        const monthStr = `${year}-${String(month).padStart(2, '0')}`;

        // Find the Plaid account for this statement's last4.
        // Only use a Plaid-sourced account ID — a pdf_import account would filter
        // out every Plaid transaction since the IDs don't match.
        let plaidAcctId = null;
        if (last4) {
          const pa = accounts.find(a => a.last4 === String(last4) && a.source === 'plaid');
          plaidAcctId = pa?.id || null;
        }

        // Settled Plaid transactions for this account + month
        const monthPlaid = plaidTxs.filter(t =>
          t.month === monthStr &&
          (!plaidAcctId || t.account === plaidAcctId)
        );

        if (monthPlaid.length === 0) {
          meta.files[fi].tags.verificationStatus = 'no_plaid_data';
          counts.noPlaidData++;
          changed = true;
          continue;
        }

        // Extract PDF transactions — run in a child process so pdf2json's
        // global state is reset for every file (avoids wrong-transactions bug
        // when parsing multiple files sequentially in the same process).
        let pdfTxs = [];
        try {
          const fp = path.join(vaultDir, file.folderPath, file.name);
          if (!fs.existsSync(fp)) { counts.failed++; continue; }
          const raw = execFileSync(
            process.execPath,
            [workerPath, fp, String(year), String(month)],
            { cwd: __dirname, timeout: 30000, maxBuffer: 1024 * 1024 }
          );
          // pdf2json emits "Warning: Setting up fake worker." on stdout before
          // the JSON line — find the last line that starts with '{'
          const jsonLine = raw.toString().split('\n')
            .map(l => l.trim()).filter(l => l.startsWith('{')).pop() || '{}';
          const result = JSON.parse(jsonLine);
          pdfTxs = result.transactions || [];
        } catch {
          counts.failed++;
          continue;
        }
        if (!pdfTxs.length) { counts.failed++; continue; }

        // Match by amount (±$0.02) AND date (±1 day)
        let matched = 0;
        for (const pt of pdfTxs) {
          const ptAmt = Math.abs(pt.amount);
          const ptMs  = new Date(pt.date).getTime();
          if (monthPlaid.some(lt =>
            Math.abs(Math.abs(lt.amount) - ptAmt) <= 0.02 &&
            Math.abs(new Date(lt.date).getTime() - ptMs) <= 86400000
          )) matched++;
        }

        const score = matched / pdfTxs.length;

        // A fudge-flagged file is always unverified regardless of match rate
        const isFudged = file.tags?.fudge === true || isFudgeName(file.name);
        const newStatus = (!isFudged && score >= 0.70) ? 'verified' : 'unverified';

        meta.files[fi].tags.verificationStatus      = newStatus;
        meta.files[fi].tags.verificationScore       = +score.toFixed(3);
        meta.files[fi].tags.verificationMatchCount  = matched;
        meta.files[fi].tags.verificationPdfCount    = pdfTxs.length;
        meta.files[fi].tags.verificationPlaidCount  = monthPlaid.length;

        if (newStatus === 'verified') {
          // verifiedAt is set once and never cleared
          if (!meta.files[fi].tags.verifiedAt) {
            meta.files[fi].tags.verifiedAt = new Date().toISOString();
          }
          counts.verified++;
        } else {
          counts.unverified++;
        }
        changed = true;
        console.log(`[vault/verify] ${file.name}: ${newStatus} (score=${score.toFixed(2)}, matched=${matched}/${pdfTxs.length}, plaid=${monthPlaid.length})`);
      }

      if (changed) writeMeta(meta, userId);
      res.json({ ...counts, total: candidates.length });
    } catch (e) {
      console.error('[vault/verify]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
