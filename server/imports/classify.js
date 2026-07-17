'use strict';
/**
 * imports/classify.js — decide WHAT each uploaded sheet is and WHERE its columns are.
 *
 * Deterministic first: QuickBooks report exports share a fixed signature (company row,
 * report-title row, optional date-range row, header row, data, timestamp footer), so the
 * title row alone classifies all eight known exports. Sheets that don't match fall back
 * to header-keyword sniffing (a "clearly labeled" generic spreadsheet with Date/Amount/…
 * columns still imports), and only a sheet neither path can read goes to Groq — one
 * small call with the first rows, never the data itself.
 */
const { cellStr } = require('./xlsx-parse');

const KINDS = {
  journal: 'journal', general_ledger: 'general_ledger', trial_balance: 'trial_balance',
  balance_sheet: 'balance_sheet', profit_loss: 'profit_loss',
  vendor_list: 'vendor_list', customer_list: 'customer_list', employee_list: 'employee_list',
  generic_transactions: 'generic_transactions', unknown: 'unknown',
};

const TITLE_MAP = [
  [/^journal$/i, KINDS.journal],
  [/^general ledger$/i, KINDS.general_ledger],
  [/^trial balance$/i, KINDS.trial_balance],
  [/^balance sheet$/i, KINDS.balance_sheet],
  [/^profit and loss/i, KINDS.profit_loss],
  [/^vendor contact list$/i, KINDS.vendor_list],
  [/^customer contact list$/i, KINDS.customer_list],
  [/^employee contact list$/i, KINDS.employee_list],
];

// Canonical column names → header-label synonyms (lowercased, punctuation-stripped).
const HEADER_SYNONYMS = {
  date:        ['date', 'transaction date', 'posting date', 'posted date', 'txn date'],
  txnType:     ['transaction type', 'type'],
  num:         ['num', 'no', 'number', 'check number', 'check #', 'ref no', 'reference'],
  name:        ['name', 'payee', 'customer', 'vendor', 'merchant'],
  memo:        ['memo/description', 'memo', 'description', 'details'],
  account:     ['account', 'account name', 'split'],
  debit:       ['debit', 'debits'],
  credit:      ['credit', 'credits'],
  amount:      ['amount', 'amount (usd)', 'value'],
  balance:     ['balance', 'running balance'],
  phone:       ['phone numbers', 'phone'],
  email:       ['email'],
  fullName:    ['full name'],
  address:     ['address', 'billing address'],
  accountNo:   ['account #', 'account no'],
};

const norm = (s) => cellStr(s).toLowerCase().replace(/[^a-z0-9#/ ]+/g, '').replace(/\s+/g, ' ').trim();

/** Find the header row (index + canonical column map) in the first `scan` rows. */
function findHeader(rows, scan = 12) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, scan); i++) {
    const row = rows[i] || [];
    const cols = {};
    let hits = 0;
    for (let c = 0; c < row.length; c++) {
      const label = norm(row[c]);
      if (!label) continue;
      for (const [canon, syns] of Object.entries(HEADER_SYNONYMS)) {
        if (syns.includes(label) && cols[canon] === undefined) { cols[canon] = c; hits++; break; }
      }
    }
    if (hits >= 3 && (!best || hits > best.hits)) best = { rowIndex: i, cols, hits };
  }
  return best;   // null when nothing header-shaped exists
}

/** Deterministic classification of one parsed sheet. */
function classifySheet(sheet) {
  const rows = sheet.rows || [];
  // 1. QB banner: a report title in the first few rows (col A, all cells identical).
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const t = cellStr((rows[i] || [])[0]);
    for (const [re, kind] of TITLE_MAP) if (re.test(t)) return { kind, header: findHeader(rows), title: t };
  }
  // 2. Generic: a recognizable header row with date + (amount | debit/credit).
  const header = findHeader(rows);
  if (header && header.cols.date !== undefined &&
      (header.cols.amount !== undefined || (header.cols.debit !== undefined && header.cols.credit !== undefined))) {
    return { kind: KINDS.generic_transactions, header };
  }
  return { kind: KINDS.unknown, header };
}

/**
 * Groq fallback for a sheet the rules couldn't read: sends ONLY the first 15 rows and
 * asks for {kind, headerRow, columns:{canonical→index}}. Best-effort — returns null on
 * any failure (missing key, rate limit, bad JSON) so the import continues without it.
 */
async function classifyWithGroq(sheet) {
  try {
    const { groqChat } = require('../vault/groq-client');
    const sample = (sheet.rows || []).slice(0, 15).map((r, i) => `${i}: ${JSON.stringify((r || []).slice(0, 12))}`).join('\n');
    const resp = await groqChat({
      model: process.env.GROQ_SORT_MODEL || 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content:
          'You classify a spreadsheet from its first rows. Respond with JSON only: ' +
          '{"kind": one of journal|general_ledger|trial_balance|balance_sheet|profit_loss|vendor_list|customer_list|employee_list|generic_transactions|unknown, ' +
          '"headerRow": <0-based row index of the column-header row or null>, ' +
          '"columns": {"date"|"txnType"|"num"|"name"|"memo"|"account"|"debit"|"credit"|"amount"|"balance": <0-based column index>} (only columns that exist)}' },
        { role: 'user', content: `Sheet name: ${sheet.name}\nFirst rows:\n${sample}` },
      ],
    }, { timeout: 30000 });
    const parsed = JSON.parse(resp.data.choices[0].message.content);
    if (!parsed || !KINDS[parsed.kind]) return null;
    const header = parsed.headerRow == null ? null
      : { rowIndex: Number(parsed.headerRow), cols: parsed.columns || {}, hits: Object.keys(parsed.columns || {}).length };
    return { kind: parsed.kind, header, viaGroq: true };
  } catch (e) {
    console.log('[import] groq classify unavailable:', e.message);
    return null;
  }
}

/** Full classification: rules, then Groq only for sheets the rules called unknown. */
async function classifyWorkbook(sheets) {
  const out = [];
  for (const sheet of sheets) {
    let c = classifySheet(sheet);
    if (c.kind === KINDS.unknown) c = (await classifyWithGroq(sheet)) || c;
    out.push({ sheet, ...c });
  }
  return out;
}

module.exports = { KINDS, classifySheet, classifyWorkbook, findHeader, HEADER_SYNONYMS };
