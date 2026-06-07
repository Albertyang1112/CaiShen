const csv = require('../csv');

describe('csv round-trip', () => {
  test('handles commas, quotes, newlines, empties, and signed numbers', () => {
    const cols = ['a', 'b', 'c', 'd', 'e'];
    const rows = [
      { a: 'plain', b: 'has,comma', c: 'has "quote"', d: 'line\nbreak', e: -12.5 },
      { a: '',      b: 'x',         c: 'y',           d: 'z',           e: 0 },
    ];
    const text = csv.stringify(rows, cols);
    const back = csv.parse(text);

    expect(back).toHaveLength(2);
    expect(back[0].a).toBe('plain');
    expect(back[0].b).toBe('has,comma');     // comma inside quotes survived
    expect(back[0].c).toBe('has "quote"');   // escaped quotes survived
    expect(back[0].d).toBe('line\nbreak');   // embedded newline survived
    expect(back[0].e).toBe('-12.5');         // values come back as strings
    expect(back[1].a).toBe('');              // empty field preserved
    expect(back[1].e).toBe('0');
  });

  test('parses CRLF line endings the same as LF', () => {
    const lf   = 'id,desc\n1,Coffee\n2,Tea\n';
    const crlf = 'id,desc\r\n1,Coffee\r\n2,Tea\r\n';
    expect(csv.parse(crlf)).toEqual(csv.parse(lf));
    expect(csv.parse(crlf)).toHaveLength(2);
  });

  test('empty input and header-only input yield no rows', () => {
    expect(csv.parse('')).toEqual([]);
    expect(csv.parse('id,desc\n')).toEqual([]);
  });

  test('a quoted field containing a comma is not split', () => {
    const back = csv.parse('a,b\n"x,y",z\n');
    expect(back[0].a).toBe('x,y');
    expect(back[0].b).toBe('z');
  });
});
