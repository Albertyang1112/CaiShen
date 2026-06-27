'use strict';
// core/coa-store.js — write-through mirror of chart_of_accounts.json → chart_of_accounts table.
const calls = [];
const mockClient = { query: jest.fn((sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 0 }); }) };
jest.mock('../core/db', () => ({
  query: jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 })),
  withTransaction: jest.fn(async (fn) => fn(mockClient)),
}));
const coa = require('../core/coa-store');

beforeEach(() => { calls.length = 0; mockClient.query.mockClear(); });

describe('flattenChart', () => {
  test('projects queryable columns + keeps the node; drops id-less entries', () => {
    const rows = coa.flattenChart([
      { id: 'cat_income', name: 'Income', type: 'income', scope: 'personal', parentId: null },
      { id: 'cat_income__salary', name: 'Salary', parentId: 'cat_income' },
      { name: 'no id — dropped' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'cat_income', parentId: null, type: 'income', scope: 'personal' });
    expect(rows[1]).toMatchObject({ id: 'cat_income__salary', parentId: 'cat_income' });
  });
});

describe('mirrorChartOfAccounts', () => {
  test('upserts each node and targeted-deletes the rest (non-destructive)', async () => {
    const n = await coa.mirrorChartOfAccounts('u1', [
      { id: 'cat_a', name: 'A', type: 'expense', parentId: null },
      { id: 'cat_b', name: 'B', parentId: 'cat_a' },
    ]);
    expect(n).toBe(2);
    expect(calls.filter(c => /INSERT INTO chart_of_accounts/.test(c.sql))).toHaveLength(2);
    const del = calls.filter(c => /DELETE FROM chart_of_accounts/.test(c.sql));
    expect(del).toHaveLength(1);
    expect(del[0].sql).toMatch(/NOT \(id = ANY\(\$2::text\[\]\)\)/);
    expect(del[0].params).toEqual(['u1', ['cat_a', 'cat_b']]);
  });
});
