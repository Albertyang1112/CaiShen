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

module.exports = { validateUploadFile, getFileType, detectTaxFormTags, autoTag, titleCase, stmtFilename, wordJaccard, upload, DUPE_SIMILARITY_THRESHOLD };
