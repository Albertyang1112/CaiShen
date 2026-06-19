const { parseStmtMeta } = require('../banking/reconciler');

describe('reconciler/parseStmtMeta — statement filename → {last4, month, year}', () => {
  test('canonical "{last4} Statement {Mon} {YYYY}.pdf"', () => {
    expect(parseStmtMeta('9092 Statement Apr 2021.pdf')).toEqual({ last4: '9092', month: 4, year: 2021 });
    expect(parseStmtMeta('9092 Statement Dec 2026.pdf')).toEqual({ last4: '9092', month: 12, year: 2026 });
  });

  test('generated "{YYYY-MM} {NAME} Statement.pdf" (no last4 in name)', () => {
    expect(parseStmtMeta('2026-02 TOTAL CHECKING Statement.pdf')).toEqual({ last4: null, month: 2, year: 2026 });
  });

  test('case-insensitive month, 3+ letter month names', () => {
    expect(parseStmtMeta('1234 Statement september 2024.pdf')).toEqual({ last4: '1234', month: 9, year: 2024 });
  });

  test('unparseable names return null', () => {
    expect(parseStmtMeta('random.pdf')).toBeNull();
    expect(parseStmtMeta('')).toBeNull();
    expect(parseStmtMeta(null)).toBeNull();
  });
});
