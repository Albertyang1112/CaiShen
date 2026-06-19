const makeDevVerifyRouter = require('../banking/dev-verify');
const { verifyMatches } = makeDevVerifyRouter;

describe('verifyMatches (dev reconciliation cross-check)', () => {
  test('PASS when displayed == plaid CSV, statement agrees + is in statements.csv', () => {
    const { summary, rows } = verifyMatches({
      matches:       [{ plaid_txn_id: 'p1', status: 'matched', s_date: '2026-01-06', s_desc: 'WHOLE FOODS MKT', s_amount: 52.13 }],
      displayedById: { p1: { id: 'p1', date: '2026-01-05', amount: -52.13, desc: 'WHOLE FOODS' } },
      plaidCsvById:  { p1: { id: 'p1', date: '2026-01-05', amount: '-52.13', desc: 'WHOLE FOODS' } },
      stmtCsvKeys:   new Set(['2026-01-06|52.13']),
    });
    expect(summary).toEqual({ total: 1, pass: 1, diverge: 0 });
    expect(rows[0].ok).toBe(true);
  });

  test('DIVERGENCE when the displayed amount differs from the Plaid CSV (staging bug)', () => {
    const { summary, rows } = verifyMatches({
      matches:       [{ plaid_txn_id: 'p1', status: 'matched', s_date: '2026-01-05', s_desc: 'X', s_amount: 52.13 }],
      displayedById: { p1: { id: 'p1', date: '2026-01-05', amount: -99.99, desc: 'X' } },  // wrong
      plaidCsvById:  { p1: { id: 'p1', date: '2026-01-05', amount: '-52.13', desc: 'X' } },
      stmtCsvKeys:   new Set(['2026-01-05|52.13']),
    });
    expect(summary.diverge).toBe(1);
    expect(rows[0].checks.find(c => c.key === 'plaid_amount==csv').ok).toBe(false);
  });

  test('DIVERGENCE when the matched statement amount is missing from statements.csv', () => {
    const { rows } = verifyMatches({
      matches:       [{ plaid_txn_id: 'p1', status: 'matched', s_date: '2026-01-05', s_desc: 'X', s_amount: 52.13 }],
      displayedById: { p1: { id: 'p1', date: '2026-01-05', amount: -52.13, desc: 'X' } },
      plaidCsvById:  { p1: { id: 'p1', date: '2026-01-05', amount: '-52.13', desc: 'X' } },
      stmtCsvKeys:   new Set(),  // statements.csv empty
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].checks.find(c => c.key === 'stmt_in_statements_csv').ok).toBe(false);
  });

  test('DIVERGENCE when Plaid and statement amounts do not agree (the live demo case)', () => {
    const { rows } = verifyMatches({
      matches:       [{ plaid_txn_id: 'p1', status: 'matched', s_date: '2026-01-05', s_desc: 'X', s_amount: 503.97 }],
      displayedById: { p1: { id: 'p1', date: '2026-01-05', amount: -3.97, desc: 'X' } },
      plaidCsvById:  { p1: { id: 'p1', date: '2026-01-05', amount: '-3.97', desc: 'X' } },
      stmtCsvKeys:   new Set(['2026-01-05|503.97']),
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].checks.find(c => c.key === 'amounts_agree').ok).toBe(false);
  });
});
