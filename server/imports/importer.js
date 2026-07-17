'use strict';
/**
 * imports/importer.js — orchestrates one spreadsheet-import batch for one user.
 *
 * Order matters within a batch: report files (Trial Balance / Balance Sheet / P&L) build
 * the account + chart plan first, then the Journal converts against that plan, then
 * everything verifies against the reports' own numbers (they are the answer key, never
 * imported). The General Ledger is deliberately ignored — it repeats every Journal txn
 * once per account and its only unique column (running balance) is derivable.
 *
 * Persistence (all through io.write → core/store, which mirrors to Postgres):
 *   accounts.json, chart_of_accounts.json, category_balances.json, transactions.json,
 *   journal_entries.json, vendor_memory.json, qb_import_batches.json
 * plus direct DB provenance: source_transactions (source 'quickbooks') + evidence links.
 *
 * The uploaded bytes are parsed in memory and discarded — only data + a sha256 persist.
 */
const crypto = require('crypto');
const { parseWorkbook, cellStr } = require('./xlsx-parse');
const { classifyWorkbook, KINDS } = require('./classify');
const { buildChartPlan, planToChartNodes, walkHierarchyReport, accountPathOf, typeFromPath, qbId, seg } = require('./qb-chart');
const { groupJournalEntries, convertEntries } = require('./qb-journal');
const { idForPath } = require('../accounting/categories');
const { learnAuto, vendorKey } = require('../banking/vendor-learn');
const { linkedMortgageLeaves } = require('../core/loan-match');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round2 = (n) => Math.round(n * 100) / 100;

// ── contact-list sheets → plain name lists (details deferred by design) ────────────
function namesFromContactList(sheet, header) {
  const hi = header?.rowIndex ?? 4;
  const col = header?.cols?.name ?? 1;
  const out = [];
  for (let i = hi + 1; i < (sheet.rows || []).length; i++) {
    const v = cellStr((sheet.rows[i] || [])[col]);
    if (v && !/^this report contains no data/i.test(v) && !/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),/i.test(v)) out.push(v);
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────────────
/**
 * @param {Array<{name:string, buffer:Buffer}>} files
 * @param {object} opts { userId, io: {read,write}, dryRun }
 */
async function runImport(files, { userId, io, dryRun = false }) {
  const summary = { files: [], accountsCreated: [], accountsMatched: [], coaNodesAdded: 0,
    txnsImported: 0, txnsReplaced: 0, transferGroups: 0, journalEntries: 0,
    vendorsSeeded: 0, categoryBalancesSet: 0, mergedLoans: [],
    verification: { accounts: [], categories: [] },
    skipped: [], warnings: [], dryRun };

  // 1. Parse + classify every uploaded workbook (in memory only).
  const classified = [];
  for (const f of files) {
    let sheets;
    try { sheets = await parseWorkbook(f.buffer, f.name); }
    catch (e) { summary.files.push({ name: f.name, kind: 'unreadable', error: e.message }); continue; }
    const cls = await classifyWorkbook(sheets);
    const primary = cls.find(c => c.kind !== KINDS.unknown) || cls[0];
    if (!primary) { summary.files.push({ name: f.name, kind: 'empty' }); continue; }
    classified.push({ file: f, ...primary });
    summary.files.push({ name: f.name, kind: primary.kind, sha256: sha256(f.buffer), rows: primary.sheet.rows.length, viaGroq: !!primary.viaGroq });
  }
  const byKind = (k) => classified.filter(c => c.kind === k);
  const first  = (k) => byKind(k)[0] || null;

  for (const c of byKind(KINDS.general_ledger)) summary.skipped.push(`${c.file.name}: General Ledger — same data as the Journal, used for verification only`);
  for (const c of byKind(KINDS.employee_list))  summary.skipped.push(`${c.file.name}: employee list — no data rows`);
  for (const c of byKind(KINDS.generic_transactions)) summary.skipped.push(`${c.file.name}: generic transaction sheet — QB pipeline covers this batch; generic import lands with the next iteration`);
  for (const c of classified.filter(x => x.kind === KINDS.unknown)) summary.warnings.push(`${c.file.name}: could not classify — nothing imported from it`);

  // 2. Chart + account plan from the report files (journal account names as fallback).
  const tb = first(KINDS.trial_balance), bs = first(KINDS.balance_sheet), pl = first(KINDS.profit_loss);
  const journalWb = first(KINDS.journal);
  const entries = journalWb ? groupJournalEntries(journalWb.sheet.rows, journalWb.header) : [];
  const journalAccounts = [...new Set(entries.flatMap(e => e.legs.map(l => l.account)))];

  const plan = buildChartPlan({
    trialBalance: tb ? { rows: tb.sheet.rows, header: tb.header } : null,
    balanceSheet: bs ? { rows: bs.sheet.rows, header: bs.header } : null,
    profitLoss:   pl ? { rows: pl.sheet.rows, header: pl.header } : null,
    journalAccounts,
  });

  // 3. Accounts: reuse an existing account when the last-4 (or exact name) already
  // exists — one physical account must never split into two rows. Otherwise create.
  const accounts = (io.read('accounts.json') || []).slice();
  const byLast4 = new Map(accounts.filter(a => a.last4).map(a => [String(a.last4), a]));
  const byName  = new Map(accounts.map(a => [String(a.name || '').toLowerCase(), a]));
  const financialByPath = new Map();
  for (const fin of plan.financial) {
    let acct = (fin.last4 && byLast4.get(fin.last4)) || byName.get(fin.name.toLowerCase());
    if (acct) {
      summary.accountsMatched.push({ path: fin.path, accountId: acct.id });
    } else {
      acct = {
        id: `qb_acct_${seg(fin.path)}`, name: fin.name, officialName: fin.path,
        type: fin.kind === 'card' ? 'credit' : 'depository',
        subtype: fin.kind === 'card' ? 'credit card' : (/saving/i.test(fin.name) ? 'savings' : 'checking'),
        balance: round2(fin.balance), availableBalance: null,
        institution: fin.institution, last4: fin.last4, currency: 'USD',
        source: 'quickbooks', createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
      };
      // idempotent re-import: same deterministic id → update in place, not duplicate
      const i = accounts.findIndex(a => a.id === acct.id);
      if (i >= 0) accounts[i] = { ...accounts[i], ...acct, createdAt: accounts[i].createdAt };
      else { accounts.push(acct); summary.accountsCreated.push({ path: fin.path, accountId: acct.id, balance: acct.balance }); }
      if (fin.last4) byLast4.set(fin.last4, acct);
      byName.set(fin.name.toLowerCase(), acct);
    }
    financialByPath.set(fin.path, { accountId: acct.id, institution: acct.institution || fin.institution, kind: fin.kind, qbBalance: fin.balance });
  }

  // 4. Chart nodes (+ balances for asset/liability/equity leaves). Existing QB nodes are
  // RE-HOMED in place when the plan moved them (scope/section changes on a re-import) —
  // ids are path-stable, so transaction coaIds survive the move.
  const { nodes: qbNodes, balances } = planToChartNodes(plan.coa, idForPath);
  let chart = (io.read('chart_of_accounts.json') || []).slice();
  const chartById = new Map(chart.map(n => [n.id, n]));
  const chartIds = new Set(chartById.keys());
  let added = 0;
  for (const n of qbNodes) {
    const cur = chartById.get(n.id);
    if (!cur) { chart.push(n); chartById.set(n.id, n); chartIds.add(n.id); added++; }
    else if (cur.qb && (cur.parentId !== n.parentId || cur.scope !== n.scope || cur.type !== n.type)) {
      Object.assign(cur, { parentId: n.parentId, scope: n.scope, type: n.type });
    }
  }
  summary.coaNodesAdded = added;

  const coaIdByPath = new Map(plan.coa.map(r => [r.path.join(':'), qbId(r.idPath || r.path)]));
  const coaNameById = new Map(chart.map(n => [n.id, n.name]));
  // A journal leg naming an account absent from every report → create an expense leaf on
  // the fly (guardrail: no leg is ever dropped for lack of a chart node).
  const ensureCoaId = (path) => {
    const parts = path.split(':').map(s => s.trim());
    const id = qbId(parts);
    if (!chartIds.has(id)) {
      let parentId = idForPath(['Business Expenses']);
      for (let d = 0; d < parts.length; d++) {
        const nid = qbId(parts.slice(0, d + 1));
        if (!chartIds.has(nid)) {
          chart.push({ id: nid, name: parts[d], parentId, type: 'expense', scope: 'business', active: true, system: false, qb: true });
          chartIds.add(nid); coaNameById.set(nid, parts[d]); added++;
        }
        parentId = nid;
      }
      summary.warnings.push(`Account "${path}" appears in the Journal but in no report — added as an expense category`);
      summary.coaNodesAdded = added;
    }
    coaIdByPath.set(path, id);
    return id;
  };

  // 5. Journal → transactions / transfers / journal entries.
  const converted = convertEntries(entries, { financialByPath, coaIdByPath, ensureCoaId, coaNameById });
  summary.transferGroups = converted.transferGroups;

  // 6. Category balances (manual balance-sheet amounts for non-account leaves).
  // Entity merge: a book mortgage leaf that matches a LIVE linked loan (mortgage domain,
  // statement/Plaid-derived) gets NO book balance — the loan is one entity and the live
  // number wins on the balance sheet (the /balance-sheet route maps the linked account
  // onto this same leaf). Book-vs-servicer drift is surfaced, never silently dropped.
  const mergedLoanLeaves = await linkedMortgageLeaves(userId, {
    chart, properties: io.read('properties.json') || [], accounts,
  });
  const catBal = { ...(io.read('category_balances.json') || {}) };
  for (const [id, amount] of Object.entries(balances)) {
    if (mergedLoanLeaves.has(id)) {
      const m = mergedLoanLeaves.get(id);
      delete catBal[id];                       // heals an earlier pre-merge import too
      const drift = m.live != null ? round2(m.live - round2(amount)) : null;
      summary.mergedLoans.push({ leaf: coaNameById.get(id) || id, property: m.propertyName, book: round2(amount), live: m.live, drift });
      if (drift !== null && Math.abs(drift) > 0.01) {
        summary.warnings.push(`${coaNameById.get(id) || id}: merged with the linked loan for "${m.propertyName}" — balance sheet shows the live ${m.live}, but your books say ${round2(amount)} (off by ${drift})`);
      }
      continue;
    }
    catBal[id] = { amount: round2(amount), note: 'QuickBooks import (Trial Balance)', asOf: new Date().toISOString() };
    summary.categoryBalancesSet++;
  }

  // 7. Merge transactions + journal entries (replace-by-id keeps re-imports idempotent).
  const existingTxns = io.read('transactions.json') || [];
  const newIds = new Set(converted.txns.map(t => t.id));
  summary.txnsReplaced = existingTxns.filter(t => newIds.has(t.id)).length;
  const mergedTxns = [...existingTxns.filter(t => !newIds.has(t.id)), ...converted.txns];
  summary.txnsImported = converted.txns.length;

  const existingJes = io.read('journal_entries.json') || [];
  const jeIds = new Set(converted.journalEntries.map(j => j.id));
  const mergedJes = [...existingJes.filter(j => !jeIds.has(j.id)), ...converted.journalEntries];
  summary.journalEntries = converted.journalEntries.length;

  // 7b. Prune QB nodes the current plan no longer produces (e.g. an account that moved
  // under a new "Other Income" group node got a new path-derived id, orphaning the old
  // one). Only qb:true nodes, and only when nothing references them anymore.
  {
    const planIds = new Set(qbNodes.map(n => n.id));
    const referenced = new Set(Object.keys(catBal));
    for (const t of mergedTxns) if (t.coaId) referenced.add(t.coaId);
    for (const je of mergedJes) for (const l of je.lines || []) if (l.accountId) referenced.add(l.accountId);
    const before = chart.length;
    chart = chart.filter(n => !(n.qb && !planIds.has(n.id) && !referenced.has(n.id)));
    if (chart.length < before) summary.warnings.push(`${before - chart.length} stale imported categor${before - chart.length === 1 ? 'y' : 'ies'} removed (accounts were re-sectioned)`);
  }

  // 8. Vendor/customer NAME seeding into the From/To memory (contact details deferred).
  const vendorMem = { ...(io.read('vendor_memory.json') || {}) };
  const contactNames = [
    ...byKind(KINDS.vendor_list).flatMap(c => namesFromContactList(c.sheet, c.header)),
    ...byKind(KINDS.customer_list).flatMap(c => namesFromContactList(c.sheet, c.header)),
  ];
  const seedEntries = contactNames.map(n => ({ key: vendorKey(n), vendor: n })).filter(e => e.key && !vendorMem[e.key]);
  const seededMem = learnAuto(vendorMem, seedEntries, { source: 'quickbooks' });
  summary.vendorsSeeded = seedEntries.length;

  // 9. Verification — the reports are the answer key.
  verifyAccounts(summary, mergedTxns, financialByPath, accounts);
  verifyCategories(summary, pl, chart, mergedTxns, mergedJes);

  // 10. Batch record: the durable trace of the discarded files.
  const batches = io.read('qb_import_batches.json') || [];
  const batch = { id: `qbimp_${Date.now()}`, at: new Date().toISOString(), dryRun,
    files: summary.files, counts: { txns: summary.txnsImported, journalEntries: summary.journalEntries,
      accountsCreated: summary.accountsCreated.length, coaNodesAdded: summary.coaNodesAdded },
    verification: summary.verification };
  if (batches.some(b => !b.dryRun && sameFileSet(b.files, summary.files))) summary.warnings.push('This exact file set was imported before — re-run is idempotent (existing rows updated, none duplicated)');

  if (!dryRun) {
    io.write('accounts.json', accounts);
    io.write('chart_of_accounts.json', chart);
    io.write('category_balances.json', catBal);
    io.write('transactions.json', mergedTxns);
    io.write('journal_entries.json', mergedJes);
    io.write('vendor_memory.json', seededMem);
    io.write('qb_import_batches.json', [...batches, batch].slice(-20));
    // Drain the queued DB persists BEFORE returning: store.write's table mirrors are
    // fire-and-forget, but (a) the response triggers UI refetches that read the
    // transactions TABLE (a mid-mirror read atomically sees the OLD set → "0 transactions"),
    // and (b) provenance rows FK onto accounts. flush() awaits every pending mirror commit.
    try { await require('../core/store').flush(); } catch (e) { console.error('[import] mirror flush:', e.message); }
    await recordProvenance(userId, converted.txns, summary.files.find(f => f.kind === 'journal')?.name || 'journal.xlsx');
  }
  return summary;
}

function sameFileSet(a, b) {
  const key = (fs) => (fs || []).map(f => f.sha256).filter(Boolean).sort().join('|');
  return key(a) && key(a) === key(b);
}

// Every imported txn's balance impact per account vs the Trial Balance figure. Only
// checked for QB-created accounts — accounts matched to pre-existing rows may hold
// unrelated (e.g. Plaid) history.
function verifyAccounts(summary, mergedTxns, financialByPath, accounts) {
  const qbIds = new Set(summary.accountsCreated.map(a => a.accountId));
  const sums = new Map();
  for (const t of mergedTxns) if (qbIds.has(t.account)) sums.set(t.account, (sums.get(t.account) || 0) + (Number(t.amount) || 0));
  for (const [path, fin] of financialByPath) {
    if (!qbIds.has(fin.accountId)) continue;
    const actual = round2(sums.get(fin.accountId) || 0);
    const expected = round2(fin.kind === 'card' ? -fin.qbBalance : fin.qbBalance);
    if (Math.abs(actual - expected) > 0.01) {
      summary.verification.accounts.push({ account: path, expected, actual, delta: round2(actual - expected) });
    }
  }
}

// Every P&L account row (any depth) vs imported txn + journal-entry postings on that
// EXACT chart node. QB parent rows show the parent's own postings only (subtree totals
// live on the "Total …" rows we skip), so per-node comparison is the correct check.
function verifyCategories(summary, pl, chart, mergedTxns, mergedJes) {
  if (!pl) return;
  const byId = new Map(chart.map(n => [n.id, n]));
  const rows = walkHierarchyReport(pl.sheet.rows, pl.header?.rowIndex)
    .filter(r => r.value !== null && accountPathOf(r.path).length && typeFromPath(r.path));
  const txnSum = new Map(), jeSum = new Map();
  for (const tx of mergedTxns) if (tx.coaId) txnSum.set(tx.coaId, (txnSum.get(tx.coaId) || 0) + (Number(tx.amount) || 0));
  for (const je of mergedJes) for (const l of je.lines || []) if (l.accountId) jeSum.set(l.accountId, (jeSum.get(l.accountId) || 0) + ((l.credit || 0) - (l.debit || 0)));
  for (const r of rows) {
    const path = accountPathOf(r.path);
    const t = typeFromPath(r.path);
    const id = qbId(t.group ? [t.group, ...path] : path);   // grouped sections nest under their group node
    if (!byId.has(id)) continue;
    // txn amounts + JE (credit−debit) are both credit-normal signed; income reads as-is,
    // expense flips to QB's debit-positive presentation.
    const signed = (txnSum.get(id) || 0) + (jeSum.get(id) || 0);
    const actual = round2(t.type === 'income' ? signed : -signed);
    if (Math.abs(actual - r.value) > 0.05) {
      summary.verification.categories.push({ category: path.join(':'), type: t.type, expected: r.value, actual, delta: round2(actual - r.value) });
    }
  }
}

// source_transactions rows + evidence links, chunked bulk inserts. Best-effort: a DB
// hiccup here never fails the import (display layer + user_kv already persisted).
async function recordProvenance(userId, txns, sourceFile) {
  if (!txns.length) return;
  try {
    const { query } = require('../core/db');
    const matching = require('../banking/matching');
    const CH = 200;
    for (let i = 0; i < txns.length; i += CH) {
      const part = txns.slice(i, i + CH);
      const values = part.map((_, r) => `(${Array.from({ length: 12 }, (_, c) => '$' + (r * 12 + c + 1)).join(',')})`).join(',');
      const params = part.flatMap(t => [
        `qbsrc_${t.id}`, userId, 'quickbooks', sourceFile,
        Number(String(t.date).slice(0, 4)) || null, t.account || null, t.date || null,
        t.desc || null, t.merchantName || null, t.amount ?? null,
        crypto.createHash('sha256').update(`${userId}|quickbooks|${t.id}`).digest('hex'), JSON.stringify(t),
      ]);
      await query(
        `INSERT INTO source_transactions
           (id,user_id,source,source_file,period_year,account_id,txn_date,description,merchant_name,amount,source_hash,raw)
         VALUES ${values}
         ON CONFLICT (id) DO UPDATE SET txn_date=EXCLUDED.txn_date, description=EXCLUDED.description,
           amount=EXCLUDED.amount, raw=EXCLUDED.raw`,
        params
      );
      await matching.linkSourcesBulk(query, userId, part.map(t => ({
        transactionId: t.id, sourceTransactionId: `qbsrc_${t.id}`, sourceRole: 'quickbooks', confidence: 1.0,
      })));
    }
  } catch (e) {
    console.error('[import] provenance recording failed (import itself succeeded):', e.message);
  }
}

module.exports = { runImport };
