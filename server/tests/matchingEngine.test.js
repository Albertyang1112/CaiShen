'use strict';
// banking/matching.js — centralized evidence-bridge writer. SQL-shape unit tests
// against a mocked executor (no DB).
jest.mock('../core/banking-store', () => ({ pruneOrphanMatchSources: jest.fn() }));
const matching = require('../banking/matching');

const mkExec = () => {
  const calls = [];
  const fn = (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 0 }); };
  fn.calls = calls;
  return fn;
};

describe('linkSource', () => {
  test('upserts one link and returns the source id', async () => {
    const exec = mkExec();
    const r = await matching.linkSource(exec, 'u1', { transactionId: 'txA', sourceTransactionId: 'srcB', sourceRole: 'receipt', confidence: 0.9 });
    expect(r).toBe('srcB');
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].sql).toMatch(/INSERT INTO matched_transaction_sources/);
    expect(exec.calls[0].sql).toMatch(/ON CONFLICT \(transaction_id, source_transaction_id\)/);
    expect(exec.calls[0].params.slice(1)).toEqual(['u1', 'txA', 'srcB', 'receipt', 0.9]);   // [uuid, …]
  });

  test('no-ops when a side is missing', async () => {
    const exec = mkExec();
    expect(await matching.linkSource(exec, 'u1', { transactionId: null, sourceTransactionId: 'x', sourceRole: 'receipt' })).toBeNull();
    expect(exec.calls).toHaveLength(0);
  });

  test('rejects an unknown role', async () => {
    const exec = mkExec();
    await expect(matching.linkSource(exec, 'u1', { transactionId: 'a', sourceTransactionId: 'b', sourceRole: 'bogus' }))
      .rejects.toThrow(/invalid source_role/);
    expect(exec.calls).toHaveLength(0);
  });
});

describe('linkSourcesBulk', () => {
  test('chunks multi-row inserts and skips invalid rows', async () => {
    const exec = mkExec();
    const rows = [];
    for (let i = 0; i < 150; i++) rows.push({ transactionId: 't' + i, sourceTransactionId: 's' + i, sourceRole: 'bank_statement', confidence: 1 });
    rows.push({ transactionId: null, sourceTransactionId: 'x', sourceRole: 'bank_statement' });   // dropped
    const n = await matching.linkSourcesBulk(exec, 'u1', rows, { chunk: 100 });
    expect(n).toBe(150);
    expect(exec.calls).toHaveLength(2);            // 100 + 50
    expect(exec.calls[0].params).toHaveLength(600);   // 100 rows × 6 params
    expect(exec.calls[1].params).toHaveLength(300);   // 50 rows × 6 params
  });
});

describe('replaceRoleLinks', () => {
  test('deletes prior role links for the source ids, then bulk-inserts', async () => {
    const calls = [];
    const client = { query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 0 }); } };
    const rows = [{ transactionId: 'p1', sourceTransactionId: 's1', sourceRole: 'bank_statement', confidence: 0.5 }];
    const n = await matching.replaceRoleLinks(client, 'u1', 'bank_statement', ['s1', 's2'], rows);
    expect(n).toBe(1);
    expect(calls[0].sql).toMatch(/DELETE FROM matched_transaction_sources/);
    expect(calls[0].params).toEqual(['u1', 'bank_statement', ['s1', 's2']]);
    expect(calls[1].sql).toMatch(/INSERT INTO matched_transaction_sources/);
  });
});
