'use strict';
// banking/manual-import.js — import-history rows → source_transactions(source='manual_csv')
// + evidence links. Mocks the matching engine and DB (no Postgres).
jest.mock('../banking/matching', () => ({ linkSource: jest.fn(() => Promise.resolve('src')) }));
const matching = require('../banking/matching');
const { recordManualCsvRows } = require('../banking/manual-import');

beforeEach(() => matching.linkSource.mockClear());

function mockQuery() {
  const calls = [];
  const fn = (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM accounts/.test(sql)) return Promise.resolve({ rows: [{ id: 'acc1' }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  fn.calls = calls;
  return fn;
}

test('writes a manual_csv source row per import and links it to the display txn', async () => {
  const query = mockQuery();
  const rows = [
    { id: 'csv_1', date: '2026-03-01', desc: 'Coffee', amount: -4.5, account: 'acc1' },
    { id: 'csv_2', date: '2026-03-02', desc: 'Books',  amount: -20,  account: 'nope' },   // bad account → nulled
  ];
  const n = await recordManualCsvRows(query, 'u1', rows);
  expect(n).toBe(2);

  const inserts = query.calls.filter(c => /INSERT INTO source_transactions/.test(c.sql));
  expect(inserts).toHaveLength(2);
  expect(inserts[0].sql).toMatch(/'manual_csv'/);
  // params: [srcId, userId, sourceFile, year, accountId, periodId, date, desc, merchant, amount, hash, raw]
  expect(inserts[0].params[0]).toBe('mcsv_csv_1');
  expect(inserts[0].params[4]).toBe('acc1');     // FK-safe account kept
  expect(inserts[1].params[4]).toBeNull();       // unknown account nulled

  expect(matching.linkSource).toHaveBeenCalledTimes(2);
  expect(matching.linkSource.mock.calls[0][2]).toMatchObject({
    transactionId: 'csv_1', sourceTransactionId: 'mcsv_csv_1', sourceRole: 'manual_csv',
  });
});

test('no rows → no work', async () => {
  const query = mockQuery();
  expect(await recordManualCsvRows(query, 'u1', [])).toBe(0);
  expect(matching.linkSource).not.toHaveBeenCalled();
});
