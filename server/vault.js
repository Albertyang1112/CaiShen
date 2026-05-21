const express = require('express')
const multer  = require('multer')
const path    = require('path')
const fs      = require('fs')
const router  = express.Router()

const VAULT_DIR  = path.join(__dirname, '../vault')
const META_FILE  = path.join(__dirname, '../data/vault.json')

// ── Ensure directories exist ──────────────────────────────────────────
if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true })
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify({ folders: [], files: [] }, null, 2))

// ── Helpers ───────────────────────────────────────────────────────────
const readMeta  = () => JSON.parse(fs.readFileSync(META_FILE, 'utf8'))
const writeMeta = (data) => fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2))

const getFileType = (filename) => {
  const ext = path.extname(filename).toLowerCase()
  if (['.pdf'].includes(ext))                    return 'pdf'
  if (['.csv'].includes(ext))                    return 'csv'
  if (['.xlsx','.xls'].includes(ext))            return 'excel'
  if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) return 'image'
  if (['.doc','.docx'].includes(ext))            return 'word'
  if (['.txt','.md'].includes(ext))              return 'text'
  return 'other'
}

const autoTag = (folderPath) => {
  const lower = folderPath.toLowerCase()
  if (lower.includes('haas'))      return { property: 'haas' }
  if (lower.includes('kobe'))      return { property: 'kobe' }
  if (lower.includes('bayhill') || lower.includes('bay hill')) return { property: 'bayhill' }
  if (lower.includes('muirfield')) return { property: 'muirfield' }
  if (lower.includes('alcita'))    return { property: 'alcita' }
  if (lower.includes('tax'))       return { type: 'tax' }
  if (lower.includes('personal'))  return { type: 'personal' }
  if (lower.includes('business'))  return { type: 'business' }
  return {}
}

// ── Multer — memory storage for processing ────────────────────────────
const upload = multer({ storage: multer.memoryStorage() })

// ── GET /api/vault — get full folder/file tree ────────────────────────
router.get('/', (req, res) => {
  try {
    const meta = readMeta()
    res.json(meta)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/vault/check-duplicate — check before upload ────────────
router.post('/check-duplicate', (req, res) => {
  const { folderName, fileNames } = req.body
  const meta = readMeta()
  const existing = meta.folders.find(f => f.name.toLowerCase() === folderName.toLowerCase())
  if (!existing) return res.json({ isDuplicate: false })

  const existingFiles = meta.files.filter(f => f.folderId === existing.id).map(f => f.name.toLowerCase())
  const incomingFiles = (fileNames || []).map(f => f.toLowerCase())
  const matches = incomingFiles.filter(f => existingFiles.includes(f))
  const matchPct = incomingFiles.length > 0 ? (matches.length / incomingFiles.length) * 100 : 0

  res.json({
    isDuplicate: true,
    isNearDuplicate: matchPct >= 60,
    matchPercent: Math.round(matchPct),
    existingFolder: existing,
    existingFileCount: existingFiles.length,
    newFileCount: incomingFiles.length,
    newFiles: incomingFiles.filter(f => !existingFiles.includes(f)).length,
    modifiedFiles: matches.length,
  })
})

// ── POST /api/vault/upload — upload files ─────────────────────────────
router.post('/upload', upload.array('files'), (req, res) => {
  try {
    const meta        = readMeta()
    const folderPath  = req.body.folderPath || 'Uploads'
    const folderId    = req.body.folderId   || null
    const mergeMode   = req.body.mergeMode  || 'merge' // merge | replace | keep | new

    // Build folder structure from path
    const parts = folderPath.split('/').filter(Boolean)
    let parentId = null
    let currentFolderId = null

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const fullPath = parts.slice(0, i+1).join('/')
      let folder = meta.folders.find(f => f.path === fullPath)

      if (!folder) {
        folder = {
          id:        `folder_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
          name,
          path:      fullPath,
          parentId,
          createdAt: new Date().toISOString(),
          tags:      autoTag(fullPath),
        }
        meta.folders.push(folder)
      }
      parentId = folder.id
      currentFolderId = folder.id
    }

    // Ensure physical folder exists
    const physicalPath = path.join(VAULT_DIR, folderPath)
    fs.mkdirSync(physicalPath, { recursive: true })

    const uploaded = []
    for (const file of req.files || []) {
      const existingFile = meta.files.find(f => f.folderId === currentFolderId && f.name === file.originalname)

      if (existingFile) {
        if (mergeMode === 'keep') continue // skip existing
        if (mergeMode === 'replace' || mergeMode === 'merge') {
          // Archive old version
          const archivePath = path.join(physicalPath, '_archive')
          fs.mkdirSync(archivePath, { recursive: true })
          const oldPhysical = path.join(physicalPath, existingFile.name)
          if (fs.existsSync(oldPhysical)) {
            const archiveName = `${path.basename(existingFile.name, path.extname(existingFile.name))}_${Date.now()}${path.extname(existingFile.name)}`
            fs.renameSync(oldPhysical, path.join(archivePath, archiveName))
          }
          // Update metadata
          existingFile.size       = file.size
          existingFile.updatedAt  = new Date().toISOString()
          existingFile.version    = (existingFile.version || 1) + 1
          // Write new file
          fs.writeFileSync(path.join(physicalPath, file.originalname), file.buffer)
          uploaded.push(existingFile)
          continue
        }
        if (mergeMode === 'new') {
          // Save with version suffix
          const base    = path.basename(file.originalname, path.extname(file.originalname))
          const ext     = path.extname(file.originalname)
          const newName = `${base}_v${Date.now()}${ext}`
          file.originalname = newName
        }
      }

      // Save file to disk
      fs.writeFileSync(path.join(physicalPath, file.originalname), file.buffer)

      const newFile = {
        id:         `file_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        name:       file.originalname,
        folderId:   currentFolderId,
        folderPath,
        size:       file.size,
        type:       getFileType(file.originalname),
        mimeType:   file.mimetype,
        createdAt:  new Date().toISOString(),
        updatedAt:  new Date().toISOString(),
        version:    1,
        tags:       autoTag(folderPath),
      }
      meta.files.push(newFile)
      uploaded.push(newFile)
    }

    writeMeta(meta)
    res.json({ success: true, uploaded: uploaded.length, files: uploaded })
  } catch (e) {
    console.error('Vault upload error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/vault/folder — create empty folder ──────────────────────
router.post('/folder', (req, res) => {
  try {
    const meta   = readMeta()
    const { name, parentId } = req.body
    const parent = parentId ? meta.folders.find(f => f.id === parentId) : null
    const path_  = parent ? `${parent.path}/${name}` : name

    if (meta.folders.find(f => f.path === path_)) {
      return res.status(400).json({ error: 'Folder already exists' })
    }
    const folder = {
      id:        `folder_${Date.now()}`,
      name,
      path:      path_,
      parentId:  parentId || null,
      createdAt: new Date().toISOString(),
      tags:      autoTag(name),
    }
    meta.folders.push(folder)
    fs.mkdirSync(path.join(VAULT_DIR, path_), { recursive: true })
    writeMeta(meta)
    res.json(folder)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── GET /api/vault/file/:id — download/preview file ──────────────────
router.get('/file/:id', (req, res) => {
  const meta = readMeta()
  const file = meta.files.find(f => f.id === req.params.id)
  if (!file) return res.status(404).json({ error: 'File not found' })
  const filePath = path.join(VAULT_DIR, file.folderPath, file.name)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' })
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${file.name}"`)
  res.sendFile(filePath)
})

// ── DELETE /api/vault/file/:id ────────────────────────────────────────
router.delete('/file/:id', (req, res) => {
  try {
    const meta = readMeta()
    const file = meta.files.find(f => f.id === req.params.id)
    if (!file) return res.status(404).json({ error: 'Not found' })
    const filePath = path.join(VAULT_DIR, file.folderPath, file.name)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    meta.files = meta.files.filter(f => f.id !== req.params.id)
    writeMeta(meta)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── DELETE /api/vault/folder/:id ──────────────────────────────────────
router.delete('/folder/:id', (req, res) => {
  try {
    const meta   = readMeta()
    const folder = meta.folders.find(f => f.id === req.params.id)
    if (!folder) return res.status(404).json({ error: 'Not found' })

    // Get all child folders recursively
    const getAllChildren = (id) => {
      const children = meta.folders.filter(f => f.parentId === id)
      return [id, ...children.flatMap(c => getAllChildren(c.id))]
    }
    const allIds = getAllChildren(folder.id)

    // Archive physical folder instead of deleting
    const physicalPath = path.join(VAULT_DIR, folder.path)
    const archivePath  = path.join(VAULT_DIR, '_deleted', `${folder.name}_${Date.now()}`)
    if (fs.existsSync(physicalPath)) {
      fs.mkdirSync(path.join(VAULT_DIR, '_deleted'), { recursive: true })
      fs.renameSync(physicalPath, archivePath)
    }

    meta.folders = meta.folders.filter(f => !allIds.includes(f.id))
    meta.files   = meta.files.filter(f => !allIds.includes(f.folderId))
    writeMeta(meta)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── PATCH /api/vault/file/:id — rename/retag ─────────────────────────
router.patch('/file/:id', (req, res) => {
  try {
    const meta = readMeta()
    const idx  = meta.files.findIndex(f => f.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: 'Not found' })
    meta.files[idx] = { ...meta.files[idx], ...req.body, updatedAt: new Date().toISOString() }
    writeMeta(meta)
    res.json(meta.files[idx])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router