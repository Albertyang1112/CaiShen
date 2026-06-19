const { statementCsv, STMT_COLUMNS } = require('../banking/statement-csv');
const csv = require('../core/csv');

describe('statementCsv', () => {
  test('serializes statement rows with the expected header and survives commas', () => {
    const rows = [
      { id: 'stmt_a', date: '2026-01-05', desc: 'WHOLE FOODS, MKT', amount: -52.13 },
      { id: 'stmt_b', date: '2026-01-06', desc: 'PAYROLL',          amount: 5000 },
    ];
    const text = statementCsv(rows);
    expect(text.split('\n')[0]).toBe(STMT_COLUMNS.join(','));

    const back = csv.parse(text);
    expect(back).toHaveLength(2);
    expect(back[0].id).toBe('stmt_a');
    expect(back[0].desc).toBe('WHOLE FOODS, MKT');   // comma preserved via quoting
    expect(back[0].amount).toBe('-52.13');
    expect(back[1].amount).toBe('5000');
  });

  test('empty rows → header only', () => {
    expect(statementCsv([]).trim()).toBe(STMT_COLUMNS.join(','));
    expect(statementCsv(undefined).trim()).toBe(STMT_COLUMNS.join(','));
  });
});
