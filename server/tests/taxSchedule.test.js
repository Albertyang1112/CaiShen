'use strict';
// Tax payment schedule: recorder idempotency, refund handling, and bank-txn matching.

const { recordTaxSchedule, matchPendingTaxPayments, matchTaxToBankTxn } = require('../tax/schedule');

const IO = { read: (f) => f === 'properties.json' ? [{ id: 'p1', name: 'Alcita', address: '654 Alcita Ct' }] : [], write: () => {} };

const EXTRACTED = {
  docKind: 'property_tax_bill',
  authority: 'LA County Tax Collector',
  taxYear: 2026,
  propertyAddress: '654 Alcita Ct',
  installments: [
    { label: '1st installment', dueDate: '2026-12-10', amount: 5200 },
    { label: '2nd installment', dueDate: '2027-04-10', amount: 5200 },
  ],
  refund: null,
};

function mkQuery(calls) {
  return (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT 1 FROM documents/.test(sql)) return Promise.resolve({ rows: [{ 1: 1 }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}

describe('recordTaxSchedule', () => {
  test('one row per installment, property resolved, deterministic ids', async () => {
    const calls = [];
    const res = await recordTaxSchedule(mkQuery(calls), IO, 'u1', { documentId: 'doc1', extracted: EXTRACTED });
    expect(res.rows).toBe(2);
    expect(res.refunds).toBe(0);
    expect(res.propertyId).toBe('p1');
    const inserts = calls.filter(c => /INSERT INTO tax_payment_schedule/.test(c.sql));
    expect(inserts.length).toBe(2);
    expect(inserts[0].params[0]).toMatch(/^txsch_u1_[0-9a-f]{8}$/);
    // Replay produces the SAME ids (idempotent upsert).
    const calls2 = [];
    await recordTaxSchedule(mkQuery(calls2), IO, 'u1', { documentId: 'doc1', extracted: EXTRACTED });
    const inserts2 = calls2.filter(c => /INSERT INTO tax_payment_schedule/.test(c.sql));
    expect(inserts2.map(c => c.params[0])).toEqual(inserts.map(c => c.params[0]));
  });

  test('refund → one refund_expected row, no installments', async () => {
    const calls = [];
    const res = await recordTaxSchedule(mkQuery(calls), IO, 'u1', {
      documentId: 'doc2',
      extracted: { docKind: 'tax_return', authority: 'IRS', taxYear: 2025, installments: [], refund: { expected: true, amount: 1840 } },
    });
    expect(res.rows).toBe(0);
    expect(res.refunds).toBe(1);
    const ins = calls.find(c => /INSERT INTO tax_payment_schedule/.test(c.sql));
    expect(ins.sql).toContain("'refund_expected'");
    expect(ins.sql).toContain("'refund'");
  });

  test('ancient installments (due >1 year ago) are skipped', async () => {
    const calls = [];
    const res = await recordTaxSchedule(mkQuery(calls), IO, 'u1', {
      documentId: 'doc3',
      extracted: { ...EXTRACTED, installments: [{ label: 'old', dueDate: '2020-12-10', amount: 100 }] },
    });
    expect(res.rows).toBe(0);
  });
});

describe('matchTaxToBankTxn', () => {
  const io = { read: (f) => f === 'transactions.json' ? [
    { id: 't1', date: '2026-12-08', amount: -5200, desc: 'LA COUNTY TAX' },
    { id: 't2', date: '2026-12-08', amount: -50, desc: 'Coffee' },
    { id: 't3', date: '2026-12-20', amount: -5200, desc: 'LA COUNTY TAX' },   // too late (>5d after due)
  ] : null };
  test('matches by authority keyword + amount, −10/+5d window around due date', () => {
    expect(matchTaxToBankTxn(io, { dueDate: '2026-12-10', amount: 5200, authority: 'LA County Tax Collector' })).toBe('t1');
  });
  test('no match when amount is off', () => {
    expect(matchTaxToBankTxn(io, { dueDate: '2026-12-10', amount: 9999, authority: 'LA County' })).toBeNull();
  });
});

describe('matchPendingTaxPayments', () => {
  test('flips matched installments to paid; refunds never queried', async () => {
    const calls = [];
    const query = (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, due_date, amount, authority FROM tax_payment_schedule/.test(sql)) {
        expect(sql).toContain(`status='unpaid'`);   // refund rows excluded at the SQL level
        return Promise.resolve({ rows: [{ id: 'txsch_1', due_date: '2026-12-10', amount: '5200', authority: 'LA County' }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const io = { read: (f) => f === 'transactions.json' ? [{ id: 't1', date: '2026-12-08', amount: -5200, desc: 'LA COUNTY TAX' }] : null, write: () => {} };
    const n = await matchPendingTaxPayments(query, io, 'u1');
    expect(n).toBe(1);
    const upd = calls.find(c => /UPDATE tax_payment_schedule SET status='paid'/.test(c.sql));
    expect(upd.params).toEqual(['txsch_1', 't1']);
  });
});
