'use strict';
// Mortgage domain: the text parser (pure) + the recorder/matcher (mocked DB + io).

const { parseMortgageStatement, grabPropertyAddress, normDate } = require('../banking/mortgage-parse');
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

// Rocket's 2026 layout (from real statements): value on the line BELOW the label in the
// same visual column, and a genuine "Total amount due: $0.00" autopay artifact whose real
// figure lives in the page-1 header.
const ROCKET_COLUMNS = [
  '                                             Mortgage Loan statement',
  '                                             Loan number',
  '                                             0731308201',
  '                                             Property address',
  '                                             8962 KOBE PL',
  '         JIACHAO YANG                        SAN DIEGO, CA 92123',
  '         8962 KOBE PL                        Statement date',
  '         SAN DIEGO, CA 92123                 03/03/2026',
  '',
  '                                             Amount due',
  '                                             $2,748.51',
  '',
  '                                             Due date',
  '                                             04/01/2026',
  '',
  'Account information                          Explanation of amount due',
  'Interest bearing principal balance:              $575,749.42',
  'Interest rate                                           2.999%',
  'Escrow balance:                                           $0.00',
  '                                             Total amount due:                $0.00',
  '  Principal:                                     $1,309.62',
  '  Interest:                                      $1,438.89',
].join('\n');

// Mr. Cooper's layout: label rows with the value 1–2 lines below in the same column, other
// columns' text interleaved between them.
const MRCOOPER_COLUMNS = [
  '                            RETURN SERVICE ONLY                      STATEMENT DATE               PAYMENT DUE DATE',
  '                            PLEASE DO NOT SEND MAIL TO THIS ADDRESS',
  '                            PO Box 818060                            05/10/2024                   06/01/2024',
  '',
  '                                                                     LOAN NUMBER                  AMOUNT DUE',
  '',
  '                                                                     0731308201                   $2,748.51',
  '',
  '                                             INTEREST                ACCOUNT OVERVIEW                       INTEREST RATE',
  '                                             $1,508.87',
  '                                                                     INTEREST BEARING                       2.999%',
  '                                                                     PRINCIPAL BALANCE',
  '                                  REGULAR',
  '                            MONTHLY PAYMENT                          $603,749.20',
  '',
  '                            $2,748.51                                                             ESCROW BALANCE',
  '',
  '                                                                                                  $0.00',
  '       PRINCIPAL',
  '        $1,239.64',
  // payment coupon — this inline label is what "amount due" actually resolves from
  // (label priority: Total Amount Due beats the Regular Monthly Payment fallback, whose
  // merged-column line carries the principal balance).
  '             TOTAL AMOUNT DUE:        $2,748.51',
].join('\n');

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

  test('Rocket column layout: value below label, $0.00 autopay artifact overridden by header', () => {
    const p = parseMortgageStatement(ROCKET_COLUMNS);
    expect(p.statementDate).toBe('2026-03-03');
    expect(p.dueDate).toBe('2026-04-01');
    expect(p.amountDue).toBe(2748.51);          // NOT the "Total amount due: $0.00" artifact
    expect(p.principalBalance).toBe(575749.42);
    expect(p.escrowBalance).toBe(0);
    expect(p.interestRate).toBe(2.999);
    expect(p.principalPaid).toBe(1309.62);
    expect(p.interestPaid).toBe(1438.89);
    expect(p.loanNumberMask).toBe('8201');
  });

  test('Mr. Cooper column layout: interleaved two-column labels resolve by column alignment', () => {
    const p = parseMortgageStatement(MRCOOPER_COLUMNS);
    expect(p.statementDate).toBe('2024-05-10');
    expect(p.dueDate).toBe('2024-06-01');
    expect(p.amountDue).toBe(2748.51);
    expect(p.principalBalance).toBe(603749.20);
    expect(p.escrowBalance).toBe(0);
    expect(p.interestRate).toBe(2.999);         // NOT grabbed as money from "2.999%"
    expect(p.principalPaid).toBe(1239.64);
    expect(p.interestPaid).toBe(1508.87);
    expect(p.loanNumberMask).toBe('8201');
  });

  test('grabPropertyAddress reads street + city/state/zip from the label column', () => {
    const a = grabPropertyAddress(ROCKET_COLUMNS);
    expect(a).toEqual({ street: '8962 KOBE PL', city: 'SAN DIEGO', region: 'CA', postalCode: '92123' });
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
      if (/SELECT monthly_payment, escrow_balance, loan_number_mask FROM mortgage_accounts/.test(sql))
        return Promise.resolve({ rows: [{ monthly_payment: 2400, escrow_balance: 4000, loan_number_mask: '8201' }] });   // prior state
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
    // Alerts must name the exact statement + loan — every statement can be from one servicer.
    const unmatched = res.alerts.find(a => a.kind === 'payment_unmatched');
    expect(unmatched.message).toContain('Mar 2026 statement');
    expect(unmatched.message).toContain('••••8201');
    expect(written['mortgage_alerts.json'].length).toBe(3);
    expect(calls.some(c => /INSERT INTO mortgage_statements/.test(c.sql))).toBe(true);
    expect(calls.some(c => /INSERT INTO mortgage_payments/.test(c.sql))).toBe(true);
  });
});
