'use strict';
/**
 * scripts/qb-import-dryrun.js — run the spreadsheet importer against real export files
 * WITHOUT writing anything (no JSON, no DB, no vault). Prints the full plan + verification.
 *
 *   node server/scripts/qb-import-dryrun.js "C:\path\to\folder-of-xlsx"
 *   node server/scripts/qb-import-dryrun.js file1.xlsx file2.xlsx …
 */
const fs = require('fs');
const path = require('path');
const { runImport } = require('../imports/importer');

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('usage: node qb-import-dryrun.js <dir-or-files…>'); process.exit(1); }
  let paths = args;
  if (args.length === 1 && fs.statSync(args[0]).isDirectory()) {
    paths = fs.readdirSync(args[0]).filter(f => /\.(xlsx|csv)$/i.test(f)).map(f => path.join(args[0], f));
  }
  const files = paths.map(p => ({ name: path.basename(p), buffer: fs.readFileSync(p) }));
  console.log(`Dry-run over ${files.length} file(s)…\n`);

  // Stub IO: pretend the user has no existing data. read() → null, write() forbidden.
  const io = { read: () => null, write: () => { throw new Error('dry-run must not write'); } };
  const summary = await runImport(files, { userId: 'dryrun', io, dryRun: true });

  console.log('── Files ────────────────────────────────────────────');
  for (const f of summary.files) console.log(`  ${f.kind.padEnd(22)} ${f.name}  (${f.rows} rows${f.viaGroq ? ', via Groq' : ''})`);
  console.log('\n── Accounts to create ───────────────────────────────');
  for (const a of summary.accountsCreated) console.log(`  ${String(a.balance).padStart(12)}  ${a.path}`);
  for (const a of summary.accountsMatched) console.log(`  (matched existing)  ${a.path}`);
  console.log(`\n── Chart nodes added: ${summary.coaNodesAdded}   Category balances set: ${summary.categoryBalancesSet}`);
  console.log(`── Transactions: ${summary.txnsImported}   Transfer groups: ${summary.transferGroups}   Journal entries: ${summary.journalEntries}   Vendors seeded: ${summary.vendorsSeeded}`);
  console.log('\n── Verification: account balance mismatches ─────────');
  if (!summary.verification.accounts.length) console.log('  ✓ every created account matches the Trial Balance');
  for (const v of summary.verification.accounts) console.log(`  ✗ ${v.account}: expected ${v.expected}, got ${v.actual} (Δ ${v.delta})`);
  console.log('\n── Verification: P&L category mismatches ────────────');
  if (!summary.verification.categories.length) console.log('  ✓ every P&L account matches');
  for (const v of summary.verification.categories.slice(0, 40)) console.log(`  ✗ [${v.type}] ${v.category}: expected ${v.expected}, got ${v.actual} (Δ ${v.delta})`);
  if (summary.verification.categories.length > 40) console.log(`  … ${summary.verification.categories.length - 40} more`);
  console.log('\n── Warnings ─────────────────────────────────────────');
  for (const w of summary.warnings) console.log(`  ⚠ ${w}`);
  for (const s of summary.skipped) console.log(`  • ${s}`);
})().catch(e => { console.error(e); process.exit(1); });
