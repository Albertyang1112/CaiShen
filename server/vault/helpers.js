'use strict';
/**
 * vault/helpers.js — pure helpers + the multer upload instance for the DataVault.
 * Upload validation, file-type + tax-form detection, folder auto-tagging, statement
 * filename formatting, and word-Jaccard duplicate similarity. No request/router state.
 */
const path   = require('path');
const multer = require('multer');

// ── Upload validation ────────────────────────────────────────────────────────
// Only financial document formats are accepted. Code files, project folders,
// config files, and archives are rejected before anything touches disk.

const ALLOWED_EXTS = new Set([
  '.pdf',                                    // bank statements, tax forms, mortgages, contracts
  '.csv',                                    // bank/brokerage transaction exports
  '.xlsx', '.xls',                           // Excel exports (Quicken, brokerage, etc.)
  '.jpg', '.jpeg', '.png', '.gif', '.webp',  // receipt/check images
  '.doc', '.docx',                           // scanned Word documents
  '.txt',                                    // plain-text exports (rare, but harmless)
]);

// Known-bad filenames and path segments — blocks things like .env, node_modules,
// package.json even if the uploader renames them with an allowed extension.
const SUSPICIOUS_NAMES = /^(\.env|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|node_modules|\.git|\.gitignore|webpack\.config|vite\.config|tsconfig|eslint|babel\.config|\.babelrc|jest\.config|rollup\.config|CLAUDE\.md)/i;

function validateUploadFile(filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  if (SUSPICIOUS_NAMES.test(path.basename(filename))) {
    return `"${filename}" looks like a project/config file and cannot be stored in the vault.`;
  }
  if (!ALLOWED_EXTS.has(ext)) {
    return `"${filename}" (${ext || 'no extension'}) is not a supported financial document type. `
      + `Allowed formats: PDF, CSV, Excel (.xlsx/.xls), images (JPG/PNG/GIF/WebP), Word (.doc/.docx).`;
  }
  return null; // valid
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,   // 50 MB per file
    files: 500,                    // max 500 files per upload batch
  },
});

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

// ── Tax-form type detection from filename ─────────────────────────────────────
// Populates tags.taxFormType so the Tax Center's "Import from docs" panel can
// identify which forms are in the vault without re-reading each PDF.
const TAX_FORM_PATTERNS = [
  { type: 'SSA-1099', re: /\bSSA[-_]?1099\b/i },
  { type: '1099-INT', re: /\b1099[-_]?INT\b/i },
  { type: '1099-DIV', re: /\b1099[-_]?DIV\b/i },
  { type: '1099-NEC', re: /\b1099[-_]?NEC\b/i },
  { type: '1099-MISC',re: /\b1099[-_]?MISC\b/i },
  { type: '1099-R',   re: /\b1099[-_]?R\b/i },
  { type: '1099-B',   re: /\b1099[-_]?B\b/i },
  { type: '1099',     re: /\b1099\b/i },
  { type: '1098-E',   re: /\b1098[-_]?E\b/i },
  { type: '1098',     re: /\b1098\b/i },
  { type: 'W-2',      re: /\bW[-_]?2\b/i },
];

function detectTaxFormTags(filename) {
  const extra = {};
  for (const { type, re } of TAX_FORM_PATTERNS) {
    if (re.test(filename)) {
      extra.taxFormType = type;
      break;
    }
  }
  // Pull 4-digit year from filename if present and not already tagged
  if (!extra.year) {
    const ym = filename.match(/\b(20\d{2})\b/);
    if (ym) extra.year = ym[1];
  }
  return extra;
}

// Auto-tag a vault folder by its path. Property matching uses the user's real
// properties (passed in) — no hardcoded demo names; unknown paths stay untagged.
const autoTag = (folderPath, properties = []) => {
  const l = folderPath.toLowerCase();
  for (const p of properties) {
    const name = String(p.name || '').toLowerCase();
    if (name && l.includes(name)) return { property: p.id };
  }
  if (l.includes('tax'))      return { type: 'tax' };
  if (l.includes('personal')) return { type: 'personal' };
  if (l.includes('business')) return { type: 'business' };
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

// ── Tags for a classified filing decision ────────────────────────────────────
// The tags written on an organized file (vault auto-organize AND chatbot doc-ingest use
// this — one builder so bot filings carry identical tags). `institution` doubles as the
// "already sorted" marker the auto-load flow checks; mortgage:true / no-month keep the
// bank-only extract-stats/verify passes off non-bank files.
function decisionTags(d) {
  const mm = d.month ? String(d.month).padStart(2, '0') : null;
  const t = { docType: d.docType, aiSorted: true };
  if (d.year) t.year = String(d.year);
  if (d.periodStart) t.periodStart = d.periodStart;
  if (d.periodEnd)   t.periodEnd   = d.periodEnd;
  if (d.docType === 'bank_statement') {
    t.institution = d.institution || 'Bank';
    if (d.accountName) t.account = d.accountName;
    if (d.last4) t.last4 = String(d.last4);
    if (mm) t.month = mm;
  } else if (d.docType === 'mortgage_statement' || d.docType === 'escrow') {
    t.institution = d.institution || 'Mortgage'; t.mortgage = true;
    if (d.propertyAddress) t.street = d.propertyAddress;
    if (mm && d.docType === 'mortgage_statement') t.month = mm;
  } else if (d.docType === 'tax_form') {
    t.institution = d.institution || 'Tax';
    if (d.formType) t.formType = d.formType;
  } else if (d.docType === 'insurance_statement') {
    t.institution = d.institution || 'Insurance'; t.insurance = true;
    if (d.coverageType) t.coverageType = d.coverageType;
    if (d.propertyAddress) t.street = d.propertyAddress;
    if (d.policyNumber) t.last4 = String(d.policyNumber).replace(/[^A-Za-z0-9]/g, '').slice(-4);
    if (mm) t.month = mm;
  } else if (d.docType === 'disclosure') {
    t.institution = d.institution || 'Disclosure';
    if (mm) t.month = mm;
  }
  return t;
}

// ── Register a file into a user's vault metadata ─────────────────────────────
// The one shared "place a file in the vault" path: ensure the folder tree exists in meta,
// de-dupe the filename within the folder, store bytes → R2 + documents row, append the
// vault.json entry. Used by the HTTP upload handler's siblings (chatbot doc-ingest) so bot
// filings go through the same code as browser uploads. Mutates `meta`; the CALLER persists
// it (write vault.json). Returns the new file entry.
async function registerVaultFile(meta, { userId, buffer, name, mimeType, folderPath, tags = {} }) {
  const documents = require('../core/documents');
  const now = new Date().toISOString();

  const parts = String(folderPath || 'Uploads').split('/').filter(Boolean);
  let parentId = null, folderId = null;
  for (let i = 0; i < parts.length; i++) {
    const fullPath = parts.slice(0, i + 1).join('/');
    let folder = meta.folders.find(f => f.path === fullPath);
    if (!folder) {
      folder = { id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                 name: parts[i], path: fullPath, parentId, createdAt: now, tags: autoTag(fullPath) };
      meta.folders.push(folder);
    }
    parentId = folder.id; folderId = folder.id;
  }

  // Name needs an extension for type detection; derive one from the mime type if missing.
  let finalName = String(name || 'document').trim() || 'document';
  if (!path.extname(finalName)) finalName += mimeType === 'application/pdf' ? '.pdf' : /^image\//.test(mimeType || '') ? '.jpg' : '';
  const target = parts.join('/');
  if (meta.files.some(f => f.folderPath === target && f.name === finalName)) {
    const ext = path.extname(finalName);
    finalName = `${path.basename(finalName, ext)}_${Date.now()}${ext}`;
  }

  const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await documents.saveDocument({
    id: fileId, userId, name: finalName, mimeType, bytes: buffer, folderPath: target, tags,
    periodYear: tags.year ? parseInt(tags.year) : null, periodMonth: tags.month ? parseInt(tags.month) : null,
  });
  const newFile = {
    id: fileId, name: finalName, folderId, folderPath: target, size: buffer.length,
    type: getFileType(finalName), mimeType, createdAt: now, updatedAt: now, version: 1, tags,
  };
  meta.files.push(newFile);
  return newFile;
}

module.exports = { validateUploadFile, getFileType, detectTaxFormTags, autoTag, titleCase, stmtFilename, MONTH_ABBR, wordJaccard, upload, DUPE_SIMILARITY_THRESHOLD, registerVaultFile, decisionTags };
