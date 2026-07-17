'use strict';
/**
 * tests/balanceSheetMerge.test.js — /api/accounting/balance-sheet loan entity-merge:
 * a linked mortgage account whose property matches an imported book leaf is itemized ON
 * that leaf (live balance, books' section), the leaf's stale book/manual balance is
 * self-healed away on read, and credit cards net SIGNED (QB parity), not abs().
 */
jest.mock('../core/db', () => ({
  query: jest.fn(async (sql) =>
    /FROM mortgage_accounts/.test(String(sql))
      ? { rows: [{ account_id: 'loan_8201', property_id: 'p_kobe', current_principal: '570491.28' }] }
      : { rows: [] }),
  withTransaction: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
}));
jest.mock('../core/banking-store', () => ({
  listAccounts: jest.fn(async () => [
    { id: 'loan_8201', name: 'Kobe Loan ••8201', type: 'loan', subtype: 'mortgage', balance: 570491.28, last4: '8201' },
    { id: 'cc_owed',   name: 'United CC',  type: 'credit', subtype: 'credit card', balance: 989.14 },
    { id: 'cc_credit', name: 'BlockFi CC', type: 'credit', subtype: 'credit card', balance: -11781.74 },
  ]),
  listTransactions: jest.fn(async () => []),
  mirrorAccounts: jest.fn(async () => {}), mirrorTransactions: jest.fn(async () => {}),
  pruneOrphanMatchSources: jest.fn(async () => 0),
}));

const express = require('express');
const request = require('supertest');

const KOBE_LEAF = 'cat_qb_mortgages__kobe_mortgage';

function makeApp(store) {
  const makeIO = () => ({
    read:  (f) => (f in store ? store[f] : null),
    write: (f, d) => { store[f] = d; },
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
  app.use('/api/accounting', require('../accounting')(makeIO).router);
  return app;
}

describe('GET /balance-sheet — merged loan + card netting', () => {
  let store;
  beforeEach(() => {
    store = {
      'properties.json': [{ id: 'p_kobe', name: '8962 Kobe Pl' }],
      'chart_of_accounts.json': [
        { id: 'cat_qb_mortgages', name: 'Mortgages', parentId: null, type: 'liability', scope: 'business', system: false },
        { id: KOBE_LEAF, name: 'Kobe Mortgage', parentId: 'cat_qb_mortgages', type: 'liability', scope: 'business', system: false },
      ],
      // stale book balance from a pre-merge import — must be healed away on read
      'category_balances.json': { [KOBE_LEAF]: { amount: 560425.51, note: 'QuickBooks import (Trial Balance)' } },
      'account_settings.json': {},
      'transactions.json': [],
    };
  });

  test('live loan lands on the book leaf; stale manual balance self-heals', async () => {
    const res = await request(makeApp(store)).get('/api/accounting/balance-sheet');
    expect(res.status).toBe(200);
    const leaf = res.body.byLeaf[KOBE_LEAF];
    expect(leaf).toBeDefined();
    expect(leaf.linked).toBeCloseTo(570491.28);                       // live number, once
    expect(leaf.accounts).toHaveLength(1);
    expect(store['category_balances.json'][KOBE_LEAF]).toBeUndefined();  // healed on read
    // response carries the POST-heal manual balances so the client can't race the heal
    expect(res.body.manualBalances).toBeDefined();
    expect(res.body.manualBalances[KOBE_LEAF]).toBeUndefined();
    // and it did NOT also land on the hardcoded fallback leaf
    const { idForPath } = require('../accounting/categories');
    expect(res.body.byLeaf[idForPath(['Personal Liabilities', 'Mortgage & Real Estate Debt', 'Primary Mortgage'])]).toBeUndefined();
  });

  test('cards contribute SIGNED balances (owed + / credit −), like QuickBooks', async () => {
    const res = await request(makeApp(store)).get('/api/accounting/balance-sheet');
    const cards = Object.values(res.body.byLeaf)
      .flatMap(e => e.accounts || [])
      .filter(a => a.sub === 'credit card');
    expect(cards.map(a => a.balance).sort((x, y) => x - y)).toEqual([-11781.74, 989.14]);
    const cardTotal = cards.reduce((s, a) => s + a.balance, 0);
    expect(cardTotal).toBeCloseTo(-10792.60);                          // netted, not |abs| summed
  });
});
