'use strict';
/**
 * ai-sort-test.js — run the Groq document classifier on local files and print what
 * it decided (doc type + destination folder + filename), WITHOUT moving anything.
 *
 *   node server/scripts/ai-sort-test.js "<file1.pdf>" "<file2.pdf>" ...
 *
 * It loads the user's live vault folder tree from Neon so the classifier reuses
 * existing folders (e.g. an existing "Chase / TOTAL CHECKING"). Read-only.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const { Pool } = require('pg');
const { classifyDocument, TEXT_MODEL } = require('../vault/ai-sort');

const USER_ID = process.env.AI_SORT_TEST_USER || '1779502545957';
const mimeOf = (f) => {
  const e = path.extname(f).toLowerCase();
  return e === '.pdf' ? 'application/pdf'
    : e === '.png' ? 'image/png'
    : (e === '.jpg' || e === '.jpeg') ? 'image/jpeg'
    : e === '.webp' ? 'image/webp' : 'application/octet-stream';
};

async function liveFolders() {
  if (!process.env.DATABASE_URL) return [];
  const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const v = await p.query(`SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'`, [USER_ID]);
    return v.rows.length ? (JSON.parse(v.rows[0].text_data).folders || []) : [];
  } finally { await p.end(); }
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Usage: node server/scripts/ai-sort-test.js <file.pdf> [...]'); process.exit(1); }
  const folders = await liveFolders();
  console.log(`Model: ${TEXT_MODEL}  |  existing folders loaded: ${folders.length}\n`);

  for (const f of files) {
    const abs = path.resolve(f);
    console.log('─'.repeat(78));
    console.log('FILE: ' + f);
    if (!fs.existsSync(abs)) { console.log('  ✗ not found on disk\n'); continue; }
    try {
      const t0 = Date.now();
      const r = await classifyDocument({ buffer: fs.readFileSync(abs), filename: path.basename(abs), mimeType: mimeOf(abs), folders });
      const ms = Date.now() - t0;
      const d = r.decision;
      if (!r.ok) console.log(`  ⚠ ${r.error}`);
      console.log(`  doc type   : ${d.docType}${d.confidence != null ? `  (confidence ${(d.confidence*100).toFixed(0)}%)` : ''}`);
      console.log(`  → FOLDER   : ${d.folder}`);
      console.log(`  → FILENAME : ${d.filename}`);
      const ex = [
        d.institution && `institution=${d.institution}`,
        d.accountName && `account=${d.accountName}`,
        d.last4 && `last4=${d.last4}`,
        d.propertyAddress && `property=${d.propertyAddress}`,
        d.formType && `form=${d.formType}`,
        (d.year || d.month) && `period=${d.year || '?'}-${d.month ? String(d.month).padStart(2,'0') : '??'}`,
      ].filter(Boolean).join('  ');
      if (ex) console.log(`  extracted  : ${ex}`);
      if (d.reasoning) console.log(`  reasoning  : ${d.reasoning}`);
      console.log(`  (${r.textChars ?? '?'} text chars, ${ms} ms${r.usage ? `, ${r.usage.total_tokens} tok` : ''})\n`);
    } catch (e) {
      console.log('  ✗ ERROR: ' + (e.response?.data?.error?.message || e.message) + '\n');
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
