'use strict';
// Non-destructive transactions/accounts mirror (core/banking-store.js).
// Asserts the mirror now UPSERTs each row + TARGETED-deletes only the ids no longer
// present, instead of the old DELETE-all + INSERT-all (which churned every row and
// cascade-wiped bank_account_periods each sync). Mocks the DB so it runs without Postgres.

const calls = [];
const mockClient = {
  query: jest.fn((sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 0 }); }),
};
jest.mock('../core/db', () => ({
  query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
  withTransaction: jest.fn(async (fn) => fn(mockClient)),
}));

const bank = require('../core/banking-store');
const db = require('../core/db');

beforeEach(() => { calls.length = 0; mockClient.query.mockClear(); db.query.mockClear(); });

describe('mirrorTransactions — non-destructive', () => {
  test('upserts each row and deletes only ids NOT in the canonical set', async () => {
    await bank.mirrorTransactions('u1', [
      { id: 'a', date: '2026-01-01', amount: -5, desc: 'X' },
      { id: 'b', date: '2026-01-02', amount: -7, desc: 'Y' },
    ]);

    const inserts = calls.filter(c => /INSERT INTO transactions/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);

    const deletes = calls.filter(c => /DELETE FROM transactions/.test(c.sql));
    expect(deletes).toHaveLength(1);                       // exactly one delete, and it's targeted
    expect(deletes[0].sql).toMatch(/NOT \(id = ANY\(\$2::text\[\]\)\)/);
    expect(deletes[0].params).toEqual(['u1', ['a', 'b']]);

    // The dangerous old "DELETE FROM transactions WHERE user_id = $1" (no filter) is gone.
    expect(calls.some(c => /DELETE FROM transactions WHERE user_id = \$1\s*$/.test(c.sql.trim()))).toBe(false);
  });

  test('empty set still clears the table (removed-last-txn case)', async () => {
    await bank.mirrorTransactions('u1', []);
    expect(calls.filter(c => /INSERT INTO transactions/.test(c.sql))).toHaveLength(0);
    const deletes = calls.filter(c => /DELETE FROM transactions/.test(c.sql));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params).toEqual(['u1', []]);         // NOT (id = ANY('{}')) ⇒ deletes all
  });
});

describe('mirrorAccounts — non-destructive', () => {
  test('targeted-deletes the rest so the period cascade does not fire each sync', async () => {
    await bank.mirrorAccounts('u1', [{ id: 'acc1', source: 'manual', name: 'Checking' }]);
    expect(calls.filter(c => /INSERT INTO accounts/.test(c.sql))).toHaveLength(1);
    const deletes = calls.filter(c => /DELETE FROM accounts/.test(c.sql));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/NOT \(id = ANY\(\$2::text\[\]\)\)/);
    expect(deletes[0].params).toEqual(['u1', ['acc1']]);
  });
});

describe('pruneOrphanMatchSources', () => {
  test('deletes evidence links whose displayed transaction no longer exists', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 3 });
    const n = await bank.pruneOrphanMatchSources('u1');
    expect(n).toBe(3);
    expect(db.query.mock.calls[0][0]).toMatch(/DELETE FROM matched_transaction_sources/);
    expect(db.query.mock.calls[0][0]).toMatch(/NOT EXISTS/);
    expect(db.query.mock.calls[0][1]).toEqual(['u1']);
  });
});
