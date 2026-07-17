'use strict';
/**
 * tests/spreadsheetImport.test.js — the QuickBooks/spreadsheet import pipeline.
 * Pure-logic units (classify, journal grouping, entry conversion, chart plan) plus an
 * end-to-end dry-run over a synthetic in-memory workbook set built with exceljs —
 * no DB, no disk, no network (Groq is never reached: every sheet classifies by rule).
 */
// Hermetic: the non-dry-run path records provenance via core/db and mirrors accounts via
// banking-store — both best-effort in the importer, both mocked here so tests never need
// (or touch) a real Postgres.
jest.mock('../core/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  withTransaction: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
}));
jest.mock('../core/banking-store', () => ({
  mirrorAccounts: jest.fn(async () => {}), mirrorTransactions: jest.fn(async () => {}),
  listAccounts: jest.fn(async () => []), listTransactions: jest.fn(async () => []),
  pruneOrphanMatchSources: jest.fn(async () => 0),
}));

const ExcelJS = require('exceljs');
const { classifySheet, KINDS } = require('../imports/classify');
const { groupJournalEntries, convertEntries, toIsoDate } = require('../imports/qb-journal');
const { buildChartPlan, planToChartNodes, qbId } = require('../imports/qb-chart');
const { coerceCell, cellNum } = require('../imports/xlsx-parse');
const { runImport } = require('../imports/importer');
const { idForPath } = require('../accounting/categories');

// ── helpers ─────────────────────────────────────────────────────────────────────────
const banner = (title) => [['Co'], [title], ['All Dates'], []];

const JOURNAL_HEADER = [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'];
function journalRows(entries) {
  // entries: [{date, type, num, name, legs:[[account, memo, debit, credit]]}]
  const rows = [...banner('Journal'), JOURNAL_HEADER];
  for (const e of entries) {
    let firstLeg = true;
    let dSum = 0, cSum = 0;
    for (const [account, memo, debit, credit] of e.legs) {
      rows.push([null, firstLeg ? e.date : null, firstLeg ? e.type : null, firstLeg ? e.num : null,
        firstLeg ? e.name : null, memo, account, debit ?? null, credit ?? null]);
      dSum += debit || 0; cSum += credit || 0;
      firstLeg = false;
    }
    rows.push([null, null, null, null, null, null, null, dSum, cSum]);   // total line
    rows.push([]);
  }
  return rows;
}

const FIN = new Map([
  ['1111 - Test Checking', { accountId: 'acct_chk', institution: 'Bank of America', kind: 'bank', qbBalance: 0 }],
  ['2222 - Test CC',       { accountId: 'acct_cc',  institution: 'Chase',           kind: 'card', qbBalance: 0 }],
]);
const COA = new Map([
  ['Utilities:Electricity', 'cat_qb_utilities__electricity'],
  ['Rental Income',         'cat_qb_rental_income'],
  ['Owner draws',           'cat_qb_owner_draws'],
  ['Opening balance equity', 'cat_qb_opening_balance_equity'],
]);
const NAMES = new Map([...COA.values()].map(id => [id, id.split('__').pop().replace('cat_qb_', '')]));
const ctx = () => ({ financialByPath: FIN, coaIdByPath: new Map(COA), ensureCoaId: (p) => { const id = qbId(p.split(':')); return id; }, coaNameById: NAMES });

// ── cell coercion ───────────────────────────────────────────────────────────────────
describe('xlsx-parse cell coercion', () => {
  test('QB value-as-formula becomes a number', () => {
    expect(coerceCell({ formula: '938.88' })).toBe(938.88);
    expect(coerceCell({ formula: '-2052.00' })).toBe(-2052);
  });
  test('derived subtotal formulas coerce to null (recomputed, not read)', () => {
    expect(coerceCell({ formula: '(B9)+(B10)' })).toBe(null);
  });
  test('rich text joins, dates trim to ISO', () => {
    expect(coerceCell({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(coerceCell(new Date('2024-05-02T10:00:00Z'))).toBe('2024-05-02');
  });
  test('cellNum handles currency formatting and parens negatives', () => {
    expect(cellNum('$1,234.56')).toBe(1234.56);
    expect(cellNum('(500)')).toBe(-500);
    expect(cellNum('n/a')).toBe(null);
  });
});

// ── classification ──────────────────────────────────────────────────────────────────
describe('classifySheet', () => {
  test('QB banner titles classify all eight report kinds', () => {
    for (const [title, kind] of [
      ['Journal', KINDS.journal], ['General Ledger', KINDS.general_ledger],
      ['Trial Balance', KINDS.trial_balance], ['Balance Sheet', KINDS.balance_sheet],
      ['Profit and Loss', KINDS.profit_loss], ['Vendor Contact List', KINDS.vendor_list],
      ['Customer Contact List', KINDS.customer_list], ['Employee Contact List', KINDS.employee_list],
    ]) {
      expect(classifySheet({ name: 't', rows: [...banner(title), JOURNAL_HEADER] }).kind).toBe(kind);
    }
  });
  test('generic sheet with clearly-labeled columns classifies without a banner', () => {
    const c = classifySheet({ name: 'export', rows: [['Date', 'Description', 'Amount'], ['01/02/2024', 'x', -5]] });
    expect(c.kind).toBe(KINDS.generic_transactions);
    expect(c.header.cols).toMatchObject({ date: 0, memo: 1, amount: 2 });
  });
  test('unlabeled noise is unknown', () => {
    expect(classifySheet({ name: 'x', rows: [['a', 'b'], [1, 2]] }).kind).toBe(KINDS.unknown);
  });
});

// ── journal grouping + conversion ───────────────────────────────────────────────────
describe('groupJournalEntries', () => {
  test('groups legs between date row and total line; parses dates', () => {
    const rows = journalRows([
      { date: '12/20/2021', type: 'Expense', num: '101', name: 'SO CAL EDISON', legs: [
        ['1111 - Test Checking', 'power bill', null, 306.59],
        ['Utilities:Electricity', 'power bill', 306.59, null],
      ]},
      { date: '01/05/2022', type: 'Deposit', num: '', name: 'TENANT A', legs: [
        ['1111 - Test Checking', 'rent', 2000, null],
        ['Rental Income', 'rent', null, 2000],
      ]},
    ]);
    const entries = groupJournalEntries(rows, { rowIndex: 4, cols: {} });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ date: '2021-12-20', txnType: 'Expense', num: '101' });
    expect(entries[0].legs).toHaveLength(2);
    expect(toIsoDate('7/4/2023')).toBe('2023-07-04');
  });
});

describe('convertEntries', () => {
  test('expense: bank leg + category leg → one signed txn with coaId/vendor/check#', () => {
    const entries = [{ date: '2021-12-20', txnType: 'Expense', num: '101', name: 'SO CAL EDISON', memo: 'power',
      legs: [{ account: '1111 - Test Checking', debit: 0, credit: 306.59, memo: 'power', name: 'SO CAL EDISON' },
             { account: 'Utilities:Electricity', debit: 306.59, credit: 0, memo: 'power', name: 'SO CAL EDISON' }] }];
    const { txns, journalEntries } = convertEntries(entries, ctx());
    expect(journalEntries).toHaveLength(0);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      amount: -306.59, account: 'acct_chk', coaId: 'cat_qb_utilities__electricity',
      checkNumber: '101', transactionType: 'Expense', vendor: 'SO CAL EDISON', vendorAuto: false,
      source: 'quickbooks', month: '2021-12',
    });
  });

  test('income deposit is positive', () => {
    const entries = [{ date: '2022-01-05', txnType: 'Deposit', num: '', name: 'TENANT A', memo: 'rent',
      legs: [{ account: '1111 - Test Checking', debit: 2000, credit: 0, memo: 'rent', name: 'TENANT A' },
             { account: 'Rental Income', debit: 0, credit: 2000, memo: 'rent', name: 'TENANT A' }] }];
    const { txns } = convertEntries(entries, ctx());
    expect(txns[0].amount).toBe(2000);
  });

  test('QB split (1 bank leg, 2 category legs) → one txn per category portion', () => {
    const entries = [{ date: '2022-02-01', txnType: 'Check', num: '55', name: 'HOME DEPOT', memo: 'materials + power',
      legs: [{ account: '1111 - Test Checking', debit: 0, credit: 100 },
             { account: 'Utilities:Electricity', debit: 60, credit: 0 },
             { account: 'Rental Income', debit: 40, credit: 0 }] }];
    const { txns } = convertEntries(entries, ctx());
    expect(txns).toHaveLength(2);
    expect(txns.map(t => t.amount).sort()).toEqual([-60, -40].sort());
    expect(txns.every(t => t.isSplit)).toBe(true);
  });

  test('two financial legs → linked transfer pair excluded from reports', () => {
    const entries = [{ date: '2022-03-01', txnType: 'Transfer', num: '', name: '', memo: 'CC payment',
      legs: [{ account: '1111 - Test Checking', debit: 0, credit: 500 },
             { account: '2222 - Test CC', debit: 500, credit: 0 }] }];
    const { txns, transferGroups } = convertEntries(entries, ctx());
    expect(transferGroups).toBe(1);
    expect(txns).toHaveLength(2);
    expect(txns[0].transferGroup).toBe(txns[1].transferGroup);
    expect(txns.every(t => t.category === 'Transfer' && !t.coaId)).toBe(true);
    expect(txns.reduce((s, t) => s + t.amount, 0)).toBe(0);
  });

  test('no financial leg → accounting journal entry (debits = credits)', () => {
    const entries = [{ date: '2021-12-02', txnType: 'Transfer', num: '', name: '', memo: '',
      legs: [{ account: 'Owner draws', debit: 20.42, credit: 0 },
             { account: 'Opening balance equity', debit: 0, credit: 20.42 }] }];
    const { txns, journalEntries } = convertEntries(entries, ctx());
    expect(txns).toHaveLength(0);
    expect(journalEntries).toHaveLength(1);
    const je = journalEntries[0];
    expect(je.lines).toHaveLength(2);
    const d = je.lines.reduce((s, l) => s + l.debit, 0), c = je.lines.reduce((s, l) => s + l.credit, 0);
    expect(d).toBeCloseTo(c);
  });

  test('ids are deterministic and duplicate-safe (same rows → same ids; twins differ)', () => {
    const twin = { date: '2022-11-25', txnType: 'Deposit', num: '', name: 'SPACEX', memo: 'payroll',
      legs: [{ account: '1111 - Test Checking', debit: 1, credit: 0 },
             { account: 'Rental Income', debit: 0, credit: 1 }] };
    const a = convertEntries([twin, { ...twin }], ctx());
    const b = convertEntries([twin, { ...twin }], ctx());
    expect(a.txns.map(t => t.id)).toEqual(b.txns.map(t => t.id));     // re-import idempotent
    expect(a.txns[0].id).not.toBe(a.txns[1].id);                       // same-day twins kept distinct
  });
});

// ── chart plan ──────────────────────────────────────────────────────────────────────
describe('buildChartPlan + planToChartNodes', () => {
  const tbRows = [...banner('Trial Balance'), [null, 'Debit', 'Credit'],
    ['1111 - Test Checking', 500, null],
    ['2222 - Test CC', null, 200],
    ['Escrow:Alcita Escrow', 1000, null],
    ['Mortgages:Kobe Mortgage', null, 60000],
    ['Owner draws', 96307.77, null],
    ['Rental Income', null, 7000],
    ['Utilities:Electricity', 300, null],
    ['Insurance Refund', null, 905.16],
  ];
  const bsRows = [...banner('Balance Sheet'), [null, 'Total'],
    ['ASSETS', null],
    ['   Current Assets', null],
    ['      Bank Accounts', null],
    ['         1111 - Test Checking', 500],
    ['      Other Current Assets', null],
    ['         Escrow', null],
    ['            Alcita Escrow', 1000],
    ['LIABILITIES AND EQUITY', null],
    ['   Liabilities', null],
    ['      Credit Cards', null],
    ['         2222 - Test CC', 200],
    ['      Long-Term Liabilities', null],
    ['         Mortgages', null],
    ['            Kobe Mortgage', 60000],
    ['   Equity', null],
    ['      Owner draws', -96307.77],
  ];
  const plRows = [...banner('Profit and Loss'), [null, 'Total'],
    ['Income', null],
    ['   Rental Income', 7000],
    ['Expenses', null],
    ['   Utilities', null],
    ['      Electricity', 300],
    ['Other Income', null],
    ['   Insurance Refund', 905.16],
  ];
  const parts = {
    trialBalance: { rows: tbRows, header: { rowIndex: 4, cols: { debit: 1, credit: 2 } } },
    balanceSheet: { rows: bsRows, header: { rowIndex: 4, cols: {} } },
    profitLoss:   { rows: plRows, header: { rowIndex: 4, cols: {} } },
  };

  test('bank/card sections become financial accounts with signed balances', () => {
    const plan = buildChartPlan(parts);
    const bank = plan.financial.find(f => f.name.includes('Checking'));
    const card = plan.financial.find(f => f.name.includes('CC'));
    expect(bank).toMatchObject({ kind: 'bank', balance: 500, last4: '1111' });
    expect(card).toMatchObject({ kind: 'card', balance: 200 });    // owed positive
    expect(plan.financial).toHaveLength(2);
  });

  test('everything else becomes typed chart rows with natural-sign balances', () => {
    const plan = buildChartPlan(parts);
    const byPath = Object.fromEntries(plan.coa.map(r => [r.path.join(':'), r]));
    expect(byPath['Escrow:Alcita Escrow']).toMatchObject({ type: 'asset', balance: 1000 });
    expect(byPath['Mortgages:Kobe Mortgage']).toMatchObject({ type: 'liability', balance: 60000 });
    expect(byPath['Owner draws']).toMatchObject({ type: 'equity', balance: -96307.77 });   // debit-normal equity reads negative, like QB
    expect(byPath['Rental Income']).toMatchObject({ type: 'income' });
    expect(byPath['Utilities:Electricity']).toMatchObject({ type: 'expense' });
  });

  test('nodes nest under the matching default roots with ancestors created', () => {
    const plan = buildChartPlan(parts);
    const { nodes, balances } = planToChartNodes(plan.coa, idForPath);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const leaf = byId.get(qbId(['Escrow', 'Alcita Escrow']));
    expect(leaf).toBeTruthy();
    expect(byId.get(leaf.parentId).name).toBe('Escrow');
    expect(byId.get(leaf.parentId).parentId).toBe(idForPath(['Business Assets']));
    expect(nodes.every(n => n.system === false)).toBe(true);          // survives loadChart self-healing
    expect(balances[qbId(['Owner draws'])]).toBeCloseTo(-96307.77);
    expect(balances[qbId(['Rental Income'])]).toBeUndefined();        // income carries no BS balance
  });

  test('the whole QB tree is business-scoped, mirroring the one-books P&L layout', () => {
    const plan = buildChartPlan(parts);
    expect(plan.coa.every(r => r.scope === 'business')).toBe(true);
  });

  test('QB "Other Income" section becomes a real group node', () => {
    const plan = buildChartPlan(parts);
    const refund = plan.coa.find(r => r.path.join(':') === 'Insurance Refund');
    expect(refund).toMatchObject({ type: 'income', idPath: ['Other Income', 'Insurance Refund'] });
    const { nodes } = planToChartNodes(plan.coa, idForPath);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const leaf = byId.get(qbId(['Other Income', 'Insurance Refund']));
    expect(leaf).toBeTruthy();
    expect(byId.get(leaf.parentId).name).toBe('Other Income');
    expect(byId.get(leaf.parentId).parentId).toBe(idForPath(['Business Revenue']));
  });
});

// ── loan entity matching + import merge ─────────────────────────────────────────────
describe('loan-match: book mortgage leaf ↔ linked property', () => {
  const { findMortgageLeaf } = require('../core/loan-match');
  const coa = [
    { id: 'kobe', name: 'Kobe Mortgage', type: 'liability' },
    { id: 'bayhill', name: 'Bayhill Mortgage', type: 'liability' },
    { id: 'alcita', name: 'Alcita Mortgage', type: 'liability' },
    { id: 'rent', name: 'Rental Income', type: 'income' },
  ];
  test('address words match the book leaf (incl. adjacent-word joins)', () => {
    expect(findMortgageLeaf(coa, '8962 Kobe Pl')?.id).toBe('kobe');
    expect(findMortgageLeaf(coa, '30645 Bay Hill Ct Cathedral City Ca 92234')?.id).toBe('bayhill');
    expect(findMortgageLeaf(coa, '68391 Alcita Rd')?.id).toBe('alcita');
  });
  test('no match → null (never a wrong leaf, never a non-liability)', () => {
    expect(findMortgageLeaf(coa, '123 Main St')).toBe(null);
    expect(findMortgageLeaf(coa, '')).toBe(null);
  });
});

describe('runImport merges a book mortgage with an existing linked loan', () => {
  const db = require('../core/db');
  afterEach(() => db.query.mockImplementation(async () => ({ rows: [] })));

  test('book balance skipped, drift surfaced, category balance healed', async () => {
    db.query.mockImplementation(async (sql) =>
      /FROM mortgage_accounts/.test(String(sql))
        ? { rows: [{ account_id: 'loan_8201', property_id: 'prop_kobe', current_principal: '570491.28' }] }
        : { rows: [] });

    const tb = [...banner('Trial Balance'), [null, 'Debit', 'Credit'],
      ['1111 - Test Checking', 100, null],
      ['Mortgages:Kobe Mortgage', null, 560425.51],
      ['Escrow:Kobe Escrow', 900, null],
    ];
    const bs = [...banner('Balance Sheet'), [null, 'Total'],
      ['ASSETS', null], ['   Bank Accounts', null], ['      1111 - Test Checking', 100],
      ['   Other Current Assets', null], ['      Escrow', null], ['         Kobe Escrow', 900],
      ['LIABILITIES AND EQUITY', null], ['   Liabilities', null], ['      Long-Term Liabilities', null],
      ['         Mortgages', null], ['            Kobe Mortgage', 560425.51],
    ];
    const wb = new ExcelJS.Workbook();
    const mk = async (title, rows) => { const w = new ExcelJS.Workbook(); const s = w.addWorksheet(title); rows.forEach(r => s.addRow(r)); return Buffer.from(await w.xlsx.writeBuffer()); };
    const files = [
      { name: 'tb.xlsx', buffer: await mk('Trial Balance', tb) },
      { name: 'bs.xlsx', buffer: await mk('Balance Sheet', bs) },
    ];
    const store = {
      'properties.json': [{ id: 'prop_kobe', name: '8962 Kobe Pl' }],
      // an earlier pre-merge import left a stale book balance — the merge must heal it
      'category_balances.json': { 'cat_qb_mortgages__kobe_mortgage': { amount: 560425.51 } },
    };
    const io = { read: (f) => store[f] ?? null, write: (f, d) => { store[f] = d; } };
    const summary = await runImport(files, { userId: 'test', io, dryRun: false });

    expect(summary.mergedLoans).toHaveLength(1);
    expect(summary.mergedLoans[0]).toMatchObject({ property: '8962 Kobe Pl', book: 560425.51, live: 570491.28, drift: 10065.77 });
    expect(summary.warnings.some(w => /off by 10065.77/.test(w))).toBe(true);
    expect(store['category_balances.json']['cat_qb_mortgages__kobe_mortgage']).toBeUndefined();  // healed
    expect(store['category_balances.json']['cat_qb_escrow__kobe_escrow']).toBeDefined();          // unrelated leaf untouched
  });
});

// ── end-to-end dry run over synthetic workbooks ─────────────────────────────────────
describe('runImport (dry run, synthetic workbook set)', () => {
  async function buildXlsx(title, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title);
    rows.forEach(r => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  test('accounts + txns + verification reconcile end-to-end', async () => {
    const tb = [...banner('Trial Balance'), [null, 'Debit', 'Credit'],
      ['1111 - Test Checking', 1693.41, null],
      ['Rental Income', null, 2000],
      ['Utilities:Electricity', 306.59, null],
    ];
    const bs = [...banner('Balance Sheet'), [null, 'Total'],
      ['ASSETS', null], ['   Bank Accounts', null], ['      1111 - Test Checking', 1693.41],
    ];
    const pl = [...banner('Profit and Loss'), [null, 'Total'],
      ['Income', null], ['   Rental Income', 2000],
      ['Expenses', null], ['   Utilities', null], ['      Electricity', 306.59],
    ];
    const jr = journalRows([
      { date: '01/05/2022', type: 'Deposit', num: '', name: 'TENANT A', legs: [
        ['1111 - Test Checking', 'rent', 2000, null], ['Rental Income', 'rent', null, 2000]] },
      { date: '01/20/2022', type: 'Expense', num: '', name: 'EDISON', legs: [
        ['1111 - Test Checking', 'power', null, 306.59], ['Utilities:Electricity', 'power', 306.59, null]] },
    ]);
    const files = [
      { name: 'Trial_balance.xlsx', buffer: await buildXlsx('Trial Balance', tb) },
      { name: 'Balance_sheet.xlsx', buffer: await buildXlsx('Balance Sheet', bs) },
      { name: 'Profit_and_loss.xlsx', buffer: await buildXlsx('Profit and Loss', pl) },
      { name: 'Journal.xlsx', buffer: await buildXlsx('Journal', jr) },
    ];
    const io = { read: () => null, write: () => { throw new Error('dry run must not write'); } };
    const summary = await runImport(files, { userId: 'test', io, dryRun: true });

    expect(summary.accountsCreated).toHaveLength(1);
    expect(summary.accountsCreated[0].balance).toBeCloseTo(1693.41);
    expect(summary.txnsImported).toBe(2);
    expect(summary.verification.accounts).toEqual([]);   // 2000 − 306.59 = 1693.41 ✓
    expect(summary.verification.categories).toEqual([]);
  });

  test('re-import against existing data replaces rows instead of duplicating', async () => {
    const jr = journalRows([
      { date: '01/05/2022', type: 'Deposit', num: '', name: 'T', legs: [
        ['1111 - Test Checking', 'rent', 2000, null], ['Rental Income', 'rent', null, 2000]] },
    ]);
    const tb = [...banner('Trial Balance'), [null, 'Debit', 'Credit'],
      ['1111 - Test Checking', 2000, null], ['Rental Income', null, 2000]];
    const bs = [...banner('Balance Sheet'), [null, 'Total'],
      ['ASSETS', null], ['   Bank Accounts', null], ['      1111 - Test Checking', 2000]];
    const files = [
      { name: 'tb.xlsx', buffer: await buildXlsx('Trial Balance', tb) },
      { name: 'bs.xlsx', buffer: await buildXlsx('Balance Sheet', bs) },
      { name: 'j.xlsx', buffer: await buildXlsx('Journal', jr) },
    ];
    const store = {};
    const io = { read: (f) => store[f] || null, write: (f, d) => { store[f] = d; } };
    const s1 = await runImport(files, { userId: 'test', io, dryRun: true });
    // First pass writes nothing (dry) — simulate a real first import result:
    store['transactions.json'] = [];  // start clean, then run twice for real
    const ioReal = { read: (f) => store[f] || null, write: (f, d) => { store[f] = d; } };
    // Stub out DB provenance by running with dryRun:false but intercepting: importer treats
    // DB failures as best-effort, and there is no DB in tests — expect it to survive.
    const s2 = await runImport(files, { userId: 'test', io: ioReal, dryRun: false });
    const s3 = await runImport(files, { userId: 'test', io: ioReal, dryRun: false });
    expect(s1.txnsImported).toBe(1);
    expect(store['transactions.json']).toHaveLength(1);            // no duplicates after double import
    expect(s3.txnsReplaced).toBe(1);
    expect(store['accounts.json'].filter(a => a.source === 'quickbooks')).toHaveLength(1);
    expect(s3.warnings.some(w => /imported before/.test(w))).toBe(true);
  });
});
