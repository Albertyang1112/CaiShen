// Minimal, dependency-free RFC-4180 CSV (de)serializer.
// Used to stage tabular data (e.g. the Plaid transaction pull) as a real .csv
// file that can be audited on disk, then read back and imported like a table.
//
//   stringify(rows, columns?) -> string   // columns defaults to keys of rows[0]
//   parse(text)               -> rows      // array of objects keyed by header row
//
// Quoting rules: a field is wrapped in double-quotes iff it contains a comma,
// double-quote, CR, or LF; embedded double-quotes are escaped by doubling.
// Values are emitted/returned as strings — callers coerce types as needed.

function esc(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function stringify(rows, columns) {
  const cols  = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(esc).join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

// State-machine row splitter — correctly handles quoted commas, escaped quotes,
// embedded newlines, and LF / CRLF / lone-CR line endings.
function parseRows(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  const s = text;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { pushField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; }
        else { inQ = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') { inQ = true; i++; }
    else if (c === ',')  { pushField(); i++; }
    else if (c === '\n') { pushRow(); i++; }
    else if (c === '\r') { i += s[i + 1] === '\n' ? 2 : 1; pushRow(); }
    else { field += c; i++; }
  }
  if (field.length || row.length) pushRow();
  // Drop blank lines produced by a trailing newline.
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function parse(text) {
  if (!text) return [];
  const rows = parseRows(text);
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(cells => {
    const o = {};
    header.forEach((h, idx) => { o[h] = cells[idx] !== undefined ? cells[idx] : ''; });
    return o;
  });
}

module.exports = { stringify, parse };
