'use strict';
/**
 * scripts/verify-bulk-parse.js — regression check for the bulk-PDF parsing fix.
 *
 * Parses EVERY Bank Statement PDF sequentially in ONE process — the exact scenario
 * that used to bleed pdf2json's module-level global state and return 0 rows ~20% of
 * the time. Now that reconciler.parseStatement spawns pdf-parse-worker.js per file,
 * each parse gets a fresh process, so every text PDF should yield rows.
 *
 *   node server/scripts/verify-bulk-parse.js [userId]
 *
 * Loads .env then .env.local (via _env), so it hits the SAME DB as the running
 * server (local Postgres in dev). Read-only — never writes.
 */
require('./_env');
const { query } = require('../core/db');
const documents = require('../core/documents');
const { classifyStatement } = require('../banking/reconciler');

const isStmtPdf = (f) =>
  f && f.type === 'pdf' && String(f.folderPath || '').startsWith('Bank Statements/');

(async () => {
  const useGroq = process.argv.includes('--groq');   // also exercise the Groq fallback on misses
  let userId = process.argv.slice(2).find(a => !a.startsWith('--'));

  // Auto-detect the user with the most Bank Statement PDFs when none is given.
  if (!userId) {
    const r = await query("SELECT user_id, text_data FROM user_kv WHERE doc_key='vault.json'");
    let best = null;
    for (const row of r.rows) {
      try {
        const n = (JSON.parse(row.text_data || '{}').files || []).filter(isStmtPdf).length;
        if (n && (!best || n > best.n)) best = { userId: row.user_id, n };
      } catch { /* skip unparseable */ }
    }
    if (!best) { console.error('No user has Bank Statement PDFs.'); process.exit(1); }
    userId = best.userId;
    console.log(`auto-detected user ${userId} (${best.n} Bank Statement PDFs)`);
  }

  const r = await query("SELECT text_data FROM user_kv WHERE user_id=$1 AND doc_key='vault.json'", [userId]);
  if (!r.rows.length || !r.rows[0].text_data) { console.error('no vault.json for user', userId); process.exit(1); }
  const targets = (JSON.parse(r.rows[0].text_data).files || []).filter(isStmtPdf);

  console.log(`Classifying ${targets.length} Bank Statement PDFs sequentially in ONE process${useGroq ? ' (Groq fallback ON)' : ''}…\n`);
  const tally = { ok: 0, empty: 0, unparsed: 0, unreadable: 0 };
  let totalRows = 0, viaGroq = 0;
  const genuine = [];   // unparsed/unreadable — the real candidates for the Groq fallback
  const t0 = Date.now();

  for (const f of targets) {
    try {
      const bytes = await documents.getDocumentBytes(userId, f.id);
      if (!bytes) { tally.unreadable++; genuine.push([f.name, 'no bytes in R2']); continue; }
      const { rows, kind, method } = await classifyStatement(bytes, f.name, { groqFallback: useGroq });
      tally[kind]++;
      if (kind === 'ok') { totalRows += rows.length; if (method === 'groq') { viaGroq++; console.log(`  ✓ ${f.name}: recovered ${rows.length} txns via Groq`); } }
      else if (kind !== 'empty') { genuine.push([f.name, kind]); console.log(`  ! ${f.name}: ${kind}`); }
    } catch (e) { tally.unreadable++; genuine.push([f.name, e.message]); console.log(`  ✗ ${f.name}: ${e.message}`); }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n── Result ──`);
  console.log(`ok (parsed)        : ${tally.ok}/${targets.length}  (${totalRows} rows total${viaGroq ? `, ${viaGroq} via Groq` : ''})`);
  console.log(`empty (no activity): ${tally.empty}   ← legitimate, NOT failures`);
  console.log(`unparsed (miss)    : ${tally.unparsed}${useGroq ? '   ← remaining after Groq' : '   ← real parser misses → run with --groq'}`);
  console.log(`unreadable         : ${tally.unreadable}`);
  console.log(`time               : ${secs}s  (${targets.length ? (secs / targets.length).toFixed(2) : 0}s/file)`);
  if (genuine.length) {
    console.log(`\nremaining gaps:`);
    for (const [n, why] of genuine) console.log(`  - ${n}: ${why}`);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
