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
        const newFile = {
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name: file.originalname,
          folderId: currentFolderId, folderPath, size: file.size,
          type: getFileType(file.originalname), mimeType: file.mimetype,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1, tags: autoTag(folderPath),
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

      const inst = detected.institution || file.tags?.institution || null;
      const l4   = detected.last4       || file.tags?.last4       || null;
      const aName= detected.accountName || file.tags?.account     || null;

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

      if (inst && detected.year && matchedAcct) {
        const cleanName  = (matchedAcct.name || inst).replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
        const targetPath = `Bank Statements/${inst}/${cleanName}/${detected.year}`;

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

      // ── 4. Update file tags with detected metadata ───────────────────────────
      const fileIdx = meta.files.findIndex(f => f.id === file.id);
      if (fileIdx >= 0) {
        meta.files[fileIdx].tags = {
          ...meta.files[fileIdx].tags,
          ...(inst             && { institution: inst }),
          ...(matchedAcct?.name&& { account: matchedAcct.name }),
          ...(l4               && { last4: l4 }),
          ...(detected.year    && { year: String(detected.year) }),
          ...(detected.month   && { month: String(detected.month).padStart(2, '0') }),
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
        year:         detected.year,
        month:        detected.month,
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
