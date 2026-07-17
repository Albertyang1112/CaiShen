'use strict';
/**
 * imports/xlsx-parse.js — read an .xlsx (or .csv) upload ENTIRELY from its in-memory
 * buffer into plain row arrays. The file itself is never written to disk or the vault —
 * per design, only extracted data persists (plus a sha256 in the import batch record).
 *
 * QuickBooks report exports carry values as formula cells whose "formula" is just the
 * literal number ("938.88") with no cached result, so cell coercion prefers, in order:
 * rich text → hyperlink text → numeric-literal formula → cached formula result → raw.
 * Derived cells (real formulas like (B9)+(B10) with no cached result) coerce to null —
 * those are the report's own subtotals, which we recompute rather than trust.
 */
const ExcelJS = require('exceljs');

function coerceCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if (v.text !== undefined) return typeof v.text === 'object' ? coerceCell(v.text) : v.text;
    if (v.formula !== undefined) {
      const lit = String(v.formula).trim();
      if (/^-?\d+(\.\d+)?$/.test(lit)) return Number(lit);      // QB value-as-formula
      if (v.result !== undefined && !(v.result && v.result.error)) return coerceCell(v.result);
      return null;                                              // derived subtotal — recomputed, not read
    }
    if (v.result !== undefined) return coerceCell(v.result);
    if (v.error !== undefined) return null;
    return String(v);
  }
  return v;   // string | number | boolean
}

/** One workbook buffer → [{ name, rows: [[cell,…],…] }] (1-based sheet order kept). */
async function parseWorkbook(buffer, originalName = '') {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(originalName)) {
    // csv → single pseudo-sheet, so CSVs flow through the same classify/import pipe.
    const { Readable } = require('stream');
    const ws = await wb.csv.read(Readable.from(buffer));
    return [sheetToRows(ws, originalName.replace(/\.csv$/i, ''))];
  }
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet(ws => sheets.push(sheetToRows(ws, ws.name)));
  return sheets;
}

function sheetToRows(ws, name) {
  const rows = [];
  const rowCount = ws.rowCount || 0;
  const colCount = Math.min(ws.columnCount || 0, 24);
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const out = [];
    for (let c = 1; c <= colCount; c++) out.push(coerceCell(row.getCell(c).value));
    while (out.length && (out[out.length - 1] === null || out[out.length - 1] === '')) out.pop();
    rows.push(out);
  }
  return { name, rows };
}

const isBlankRow = (row) => !row || row.every(c => c === null || c === '' || c === undefined);
const cellStr = (c) => (c === null || c === undefined) ? '' : String(c).trim();

/** Number coercion for debit/credit/amount cells: numbers pass, "1,234.56"/"$-5" parse, else null. */
function cellNum(c) {
  if (c === null || c === undefined || c === '') return null;
  if (typeof c === 'number') return c;
  const s = String(c).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

module.exports = { parseWorkbook, coerceCell, isBlankRow, cellStr, cellNum };
