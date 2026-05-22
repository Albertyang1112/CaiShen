const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

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
      const meta   = readMeta(userId);
      const file   = meta.files.find(f => f.id === req.params.id);
      if (!file) return res.status(404).json({ error: 'Not found' });
      const filePath = path.join(getUserVaultDir(userId), file.folderPath, file.name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      meta.files = meta.files.filter(f => f.id !== req.params.id);
      writeMeta(meta, userId);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DELETE /api/vault/folder/:id ──────────────────────────────────────
  router.delete('/folder/:id', (req, res) => {
    try {
      const userId   = req.user.id;
      const vaultDir = getUserVaultDir(userId);
      const meta     = readMeta(userId);
      const folder   = meta.folders.find(f => f.id === req.params.id);
      if (!folder) return res.status(404).json({ error: 'Not found' });
      const getAllChildren = (id) => {
        const children = meta.folders.filter(f => f.parentId === id);
        return [id, ...children.flatMap(c => getAllChildren(c.id))];
      };
      const allIds     = getAllChildren(folder.id);
      const physicalPath = path.join(vaultDir, folder.path);
      const archivePath  = path.join(vaultDir, '_deleted', `${folder.name}_${Date.now()}`);
      if (fs.existsSync(physicalPath)) {
        fs.mkdirSync(path.join(vaultDir, '_deleted'), { recursive: true });
        fs.renameSync(physicalPath, archivePath);
      }
      meta.folders = meta.folders.filter(f => !allIds.includes(f.id));
      meta.files   = meta.files.filter(f => !allIds.includes(f.folderId));
      writeMeta(meta, userId);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

  return router;
};
