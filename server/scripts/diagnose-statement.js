'use strict';
/**
 * scripts/diagnose-statement.js — why does a statement parse to 0 transactions?
 * Dumps item count, extracted metadata, parsed-row count, and the reading-order
 * text for one FAILING and one PASSING Bank Statement PDF, so we can see how the
 * old (2019-2021) layout differs from the parseable one.
 *   node server/scripts/diagnose-statement.js [userId]
 */
require('./_env');
const { query } = require('../core/db');
const documents = require('../core/documents');
const { parsePDFTransactions, extractStatementMeta, extractRawText } = require('../core/pdf-parser');

const isStmtPdf = (f) => f && f.type === 'pdf' && String(f.folderPath || '').startsWith('Bank Statements/');

async function dump(label, userId, f) {
  const bytes = await documents.getDocumentBytes(userId, f.id);
  const meta  = await extractStatementMeta(bytes);
  const rows  = await parsePDFTransactions(bytes, { year: meta.year });
  const text  = (meta.text || await extractRawText(bytes) || '');
  console.log(`\n══════════ ${label}: ${f.name} ══════════`);
  console.log(`meta: inst=${meta.institution} last4=${meta.last4} ${meta.month}/${meta.year} period=${meta.periodStart}..${meta.periodEnd} bal=${meta.closingBalance}`);
  console.log(`parsePDFTransactions rows: ${rows.length}   text length: ${text.length}`);
  console.log(`── reading text (first 1800 chars) ──`);
  console.log(text.slice(0, 1800));
}

(async () => {
  let userId = process.argv[2];
  if (!userId) {
    const r = await query("SELECT user_id, text_data FROM user_kv WHERE doc_key='vault.json'");
    let best = null;
    for (const row of r.rows) {
      try { const n = (JSON.parse(row.text_data || '{}').files || []).filter(isStmtPdf).length; if (n && (!best || n > best.n)) best = { userId: row.user_id, n }; } catch {}
    }
    userId = best.userId;
  }
  const r = await query("SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'", [userId]);
  const targets = (JSON.parse(r.rows[0].text_data).files || []).filter(isStmtPdf)
    .sort((a, b) => a.name.localeCompare(b.name));

  let failing = null, passing = null;
  for (const f of targets) {
    const bytes = await documents.getDocumentBytes(userId, f.id);
    if (!bytes) continue;
    const rows = await parsePDFTransactions(bytes, {});
    if (rows.length === 0 && !failing) failing = f;
    if (rows.length > 0 && !passing) passing = f;
    if (failing && passing) break;
  }
  if (failing) await dump('FAILING', userId, failing);
  if (passing) await dump('PASSING', userId, passing);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
