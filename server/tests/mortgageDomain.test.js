'use strict';
// Mortgage domain: the text parser (pure) + the recorder/matcher (mocked DB + io).

const { parseMortgageStatement, normDate } = require('../banking/mortgage-parse');
const mortgage = require('../banking/mortgage');

const SAMPLE = `
ROCKET MORTGAGE
Statement Date: 03/15/2026
Payment Due Date: 04/01/2026
Total Amount Due $2,450.00
Outstanding Principal Balance $312,500.00
Escrow Balance $4,200.50
Interest Rate 6.250%

Explanation of Amount Due
Principal $850.25
Interest $1,300.75
Escrow (Taxes and Insurance) $299.00
`;

describe('parseMortgageStatement', () => {
  test('extracts the core + breakdown fields from a typical statement', () => {
    const p = parseMortgageStatement(SAMPLE);
    expect(p.statementDate).toBe('2026-03-15');
    expect(p.dueDate).toBe('2026-04-01');
    expect(p.amountDue).toBe(2450.00);
    expect(p.principalBalance).toBe(312500.00);
    expect(p.escrowBalance).toBe(4200.50);
    expect(p.interestRate).toBe(6.25);
    expect(p.principalPaid).toBe(850.25);   // "Principal $…" not "Principal Balance"
    expect(p.interestPaid).toBe(1300.75);   // "Interest $…" not "Interest Rate"
    expect(p.escrowPaid).toBe(299.00);      // "Escrow (Taxes…) $…" not "Escrow Balance"
    expect(p.totalPaid).toBe(2450.00);
    expect(p.confidence).toBe(1);
    expect(p.parserStatus).toBe('parsed');
  });

  test('grades confidence down + parses "Month DD, YYYY" dates', () => {
    const p = parseMortgageStatement('Statement Date: January 5, 2026\nSome unparseable body.');
    expect(p.statementDate).toBe('2026-01-05');
    expect(p.amountDue).toBeNull();
    expect(p.confidence).toBeLessThan(0.5);
    expect(p.parserStatus).toBe('partial');
  });

  test('empty text → failed, no throw', () => {
    const p = parseMortgageStatement('');
    expect(p.parserStatus).toBe('failed');
    expect(p.confidence).toBe(0);
  });

  test('normDate handles slash and long-month forms', () => {
    expect(normDate('4/1/26')).toBe('2026-04-01');
    expect(normDate('Apr 1, 2026')).toBe('2026-04-01');
    expect(normDate('garbage')).toBeNull();
  });
});

describe('matchPaymentToBankTxn', () => {
  const io = {
    read: (f) => f === 'transactions.json' ? [
      { id: 't1', date: '2026-04-01', amount: -2450.00, desc: 'ROCKET MORTGAGE PYMT' },
      { id: 't2', date: '2026-04-01', amount: -50.00,  desc: 'Coffee' },
    ] : null,
  };
  test('matches by name + amount + date', () => {
    expect(mortgage.matchPaymentToBankTxn(io, { date: '2026-04-01', total: 2450.00, servicer: 'Rocket Mortgage' })).toBe('t1');
  });
  test('no false match when nothing is close', () => {
    expect(mortgage.matchPaymentToBankTxn(io, { date: '2026-04-01', total: 9999, servicer: 'Rocket' })).toBeNull();
  });
});

describe('recordMortgageStatement', () => {
  test('upserts statement+payment and raises change/unmatched alerts', async () => {
    const calls = [];
    const query = (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT monthly_payment, escrow_balance FROM mortgage_accounts/.test(sql))
        return Promise.resolve({ rows: [{ monthly_payment: 2400, escrow_balance: 4000 }] });   // prior state
      if (/SELECT 1 FROM documents/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const written = {};
    const io = { read: (f) => (f === 'transactions.json' ? [] : written[f] || null), write: (f, v) => { written[f] = v; } };
    const parsed = parseMortgageStatement(SAMPLE);

    const res = await mortgage.recordMortgageStatement(query, io, 'u1', {
      mortgageAccountId: 'mort_u1_rocket_haas', documentId: null, parsed, servicer: 'Rocket',
    });

    expect(res.mortgageStatementId).toBe('mstmt_mort_u1_rocket_haas_202603');
    expect(res.matchedTxnId).toBeNull();                    // no transactions to match against
    const kinds = res.alerts.map(a => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['payment_changed', 'escrow_changed', 'payment_unmatched']));
    expect(written['mortgage_alerts.json'].length).toBe(3);
    expect(calls.some(c => /INSERT INTO mortgage_statements/.test(c.sql))).toBe(true);
    expect(calls.some(c => /INSERT INTO mortgage_payments/.test(c.sql))).toBe(true);
  });
});
