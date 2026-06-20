/**
 * pdf-parser.js — Local (no-AI) bank statement PDF parser
 *
 * Strategy:
 *  1. Use pdf2json to extract text with X/Y positions from every page
 *  2. Group items sharing the same Y coordinate into rows; sort each row left→right
 *  3. Detect column layout from header rows (Date / Description / Amount / Balance etc.)
 *  4. Identify transaction rows (rows that start with a date)
 *  5. Determine sign via: explicit sign → parens → debit/credit column position →
 *     running-balance delta → description keywords
 *  6. Return clean [{date, desc, amount, category, source}] array
 */

'use strict';

const PDFParser = require('pdf2json');

// ── Text extraction ───────────────────────────────────────────────────────────

// pdf2json keeps MODULE-LEVEL global state, so two parses running concurrently in
// the same process corrupt each other (one returns the other's data, or empty).
// Serialize every parse through one queue: callers (classify / extract-stats /
// metadata) can fan out freely, but the actual pdf2json work runs one at a time.
let _pdfQueue = Promise.resolve();
function extractItems(buffer) {
  const run = _pdfQueue.then(() => _extractItems(buffer), () => _extractItems(buffer));
  _pdfQueue = run.then(() => {}, () => {});   // keep the chain alive regardless of outcome
  return run;
}

async function _extractItems(buffer) {
  // pdf2json intermittently fires pdfParser_dataError on some pdfkit-generated PDFs
  // (e.g. Invalid XRef stream) even though the file is valid — retry up to 3 times.
  // verbose=1 silences noisy console output; the resolved guard prevents a late
  // error event from rejecting a promise that already resolved.
  const parser = new PDFParser(null, 1);
  const data   = await new Promise((resolve, reject) => {
    let resolved = false;
    let errorTimer = null;
    parser.on('pdfParser_dataReady', d => {
      resolved = true;
      if (errorTimer) clearTimeout(errorTimer);
      resolve(d);
    });
    // Some pdfkit PDFs fire dataError BEFORE dataReady (recoverable XRef warning).
    // Don't reject immediately — give dataReady 300 ms to arrive.  If it does,
    // we resolve normally; if not, we reject with the original error.
    parser.on('pdfParser_dataError', e => {
      if (!resolved) {
        errorTimer = setTimeout(() => { if (!resolved) reject(e); }, 300);
      }
    });
    parser.parseBuffer(buffer);
  });

  const items = [];
  for (let p = 0; p < (data.Pages || []).length; p++) {
    for (const el of (data.Pages[p].Texts || [])) {
      const text = el.R
        .map(r => { try { return decodeURIComponent(r.T); } catch { return r.T; } })
        .join('')
        .trim();
      if (text) items.push({ text, x: el.x, y: el.y, w: el.w || 0, page: p });
    }
  }
  return items;
}

// ── Row grouping ─────────────────────────────────────────────────────────────

function groupRows(items, tolerance = 0.38) {
  // Sort page-first, then Y (rows), then X (columns)
  const sorted = [...items].sort((a, b) =>
    a.page !== b.page  ? a.page - b.page :
    Math.abs(a.y - b.y) < tolerance ? a.x - b.x : a.y - b.y
  );

  const rows = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    if (last && last[0].page === item.page && Math.abs(last[0].y - item.y) < tolerance) {
      last.push(item);
    } else {
      rows.push([item]);
    }
  }
  return rows.map(r => r.sort((a, b) => a.x - b.x));
}

// ── Page text assembly with split-word gluing ─────────────────────────────────
// pdf2json splits words into fragments on kerning ("Statement" → "St" + "atement");
// a blind space-join turns them into separate words ("St atement"), which corrupts
// pattern matching (that fake "St" token is how junk like "Mortgage Loan Statement St"
// got matched as a street address). Same-word fragments continue at (almost) the
// previous fragment's end position — but item widths over-report on some PDFs,
// making COLUMN-adjacent items look glued too ("…KOBE PL" + "If payment…" →
// "PLIf"). So a near-zero gap is necessary but NOT sufficient: the join must also
// look like a word continuation —
//   lower→lower  ("Woodw"+"ard", "St"+"atement")          → glue
//   single CAP→lower ("K"+"obe", "P"+"ostal")             → glue
//   digit→digit, →UPPER, digit→letter, token→lower (etc.) → keep the space
function glueOk(prevText, nextText) {
  const a = prevText[prevText.length - 1] || '';
  const b = nextText[0] || '';
  if (/[a-z]/.test(a) && /[a-z]/.test(b)) return true;             // word continuation
  const lastTok = prevText.split(/\s+/).pop();
  if (/^[A-Z]$/.test(lastTok) && /[A-Za-z]/.test(b)) return true;  // "K"+"obe", "K"+"OBE"
  return false;
}
function assemblePages(items) {
  const pageMap = new Map();
  for (const row of groupRows(items)) {
    let line = row[0].text;
    for (let k = 1; k < row.length; k++) {
      const prev = row[k - 1];
      const gap  = prev.w > 0 ? row[k].x - (prev.x + prev.w) : Infinity;
      line += (gap < 0.05 && glueOk(prev.text, row[k].text) ? '' : ' ') + row[k].text;
    }
    const p = row[0].page;
    pageMap.set(p, (pageMap.get(p) || '') + line + '\n');
  }
  return [...pageMap.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
}

// ── Date parsing ─────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/;

function parseDate(s, year) {
  const m = s.match(DATE_RE);
  if (!m) return null;
  const [, mo, dy, yr] = m;
  const y = yr
    ? (yr.length === 2 ? (parseInt(yr) > 50 ? '19' : '20') + yr : yr)
    : String(year || new Date().getFullYear());
  const date = `${y}-${mo.padStart(2, '0')}-${dy.padStart(2, '0')}`;
  const d = new Date(date + 'T12:00:00');
  if (isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2040) return null;
  return date;
}

// ── Amount parsing ────────────────────────────────────────────────────────────

function isAmountStr(s) {
  const c = s.replace(/\s/g, '');
  // Standard:    1234.56  $1,234.56  (1,234.56)  -1,234.56  1,234.56-
  // CaiShen PDF: -$8.99  (minus before dollar sign)
  return /^\$?\-?\(?\d[\d,]*\.\d{2}\)?-?$/.test(c) ||
         /^-\$\d[\d,]*\.\d{2}$/.test(c);
}

function parseAmount(s) {
  const clean = s.replace(/[$,\s]/g, '');
  // Trailing minus (some banks: "1,234.56-")
  if (/^\d[\d.]*-$/.test(clean)) return -parseFloat(clean.slice(0, -1));
  // Parentheses = negative
  if (/^\([\d.]+\)$/.test(clean)) return -parseFloat(clean.slice(1, -1));
  // Leading minus
  const f = parseFloat(clean);
  return isNaN(f) ? null : f;
}

// ── Infer statement year from all text ───────────────────────────────────────

function inferYear(items) {
  const years = [];
  for (const { text } of items) {
    const m = text.match(/\b(20[12]\d)\b/g);
    if (m) m.forEach(y => years.push(parseInt(y)));
  }
  if (!years.length) return new Date().getFullYear();
  // Return most-frequent year
  const freq = {};
  for (const y of years) freq[y] = (freq[y] || 0) + 1;
  return parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
}

// ── Column header detection ───────────────────────────────────────────────────
// Returns approximate X positions for debit / credit / amount / balance columns.
// null means the column wasn't found.

function detectColumnLayout(rows) {
  const layout = { debitX: null, creditX: null, amountX: null, balanceX: null };
  for (const row of rows.slice(0, 40)) { // only look in the first ~40 rows
    for (const item of row) {
      const t = item.text.toLowerCase().trim();
      if (/^(debit|withdrawal|withdrawals|charges|amount charged|payment)$/.test(t)) layout.debitX  = item.x;
      else if (/^(credit|deposit|deposits|credits|amount credited)$/.test(t))        layout.creditX = item.x;
      else if (/^(amount|transaction amount|amt)$/.test(t))                           layout.amountX = item.x;
      else if (/^(balance|running balance|bal\.?)$/.test(t))                         layout.balanceX = item.x;
    }
  }
  return layout;
}

// ── Skip-row patterns ─────────────────────────────────────────────────────────

const SKIP_PATTERNS = [
  /^(date|posting date|transaction date|effective date|value date)\b/i,
  /^(description|details|merchant|payee|memo|narrative)\b/i,
  /^(debit|credit|deposits?|withdrawals?|charges?|payments?)\s*$/i,
  /^(balance|running balance|ending balance|beginning balance|opening balance)\s*$/i,
  /^(total|subtotal|page \d|account (number|ending)|statement (period|date|summary))\b/i,
  /^(continued on|brought forward|carried forward)\b/i,
  /^(service charge|monthly fee|interest paid|interest earned|annual fee)\s*$/i,
];

function shouldSkipRow(rowText) {
  return SKIP_PATTERNS.some(r => r.test(rowText.trim()));
}

// ── Transaction categorisation ────────────────────────────────────────────────

const CATEGORIES = [
  [/\bamazon\b|amzn|prime.*video/i,                                                                          'Shopping'],
  [/walmart|target|costco|sam.s club|kroger|publix|safeway|whole foods|trader joe|aldi|sprouts/i,           'Groceries'],
  [/cvs|walgreen|rite aid|duane reade|pharmacy/i,                                                            'Groceries'],
  [/starbucks|dunkin|peet.s|blue bottle|coffee|cafe|espresso/i,                                              'Coffee'],
  [/mcdonald|burger king|chipotle|taco bell|subway|domino|pizza|kfc|chick.fil|wendy|sonic|five guys|shake shack|panera/i, 'Dining'],
  [/uber eats|doordash|grubhub|instacart|postmates|seamless|caviar/i,                                        'Dining'],
  [/restaurant|dining|diner|bistro|kitchen|grill|steakhouse|sushi|ramen|thai|chinese|italian|mexican/i,     'Dining'],
  [/netflix|hulu|disney\+?|spotify|apple.*music|youtube.*premium|hbo|paramount|peacock|amazon.*prime video|audible/i, 'Subscriptions'],
  [/gym|planet fitness|la fitness|anytime fitness|equinox|orange theory|crossfit|24 hour|blink fitness/i,   'Fitness'],
  [/lyft|uber(?!\s*eats)|taxi|cab\b|metro|mta|cta|bart|transit|toll|parking/i,                              'Transport'],
  [/\bgas\b|shell|chevron|bp\b|exxon|mobil|sunoco|marathon|valero|circle k|wawa/i,                          'Transport'],
  [/airline|delta|united|american air|southwest|jetblue|spirit|frontier|alaska air|virgin/i,                'Travel'],
  [/hotel|marriott|hilton|hyatt|ihg|airbnb|vrbo|motel|resort|inn\b/i,                                       'Travel'],
  [/doctor|dentist|hospital|pharmacy|medical|health|urgent care|kaiser|cigna|aetna|blue cross|quest/i,      'Health'],
  [/electric|gas company|water|internet|comcast|att\b|verizon|t.?mobile|spectrum|utility|utilities/i,       'Utilities'],
  [/payroll|direct dep|salary|wages|employer|ach.*credit.*company|paylocity|adp\b|paychex/i,                'Income'],
  [/zelle|venmo|paypal|cashapp|cash app|wire transfer|ach transfer|transfer (from|to)/i,                    'Transfer'],
  [/apple.*store|microsoft|google play|adobe|slack|zoom|dropbox|github/i,                                   'Tech'],
];

function categorize(desc) {
  for (const [re, cat] of CATEGORIES) if (re.test(desc)) return cat;
  return 'Other';
}

// ── Deposit keyword detector (for sign heuristics) ────────────────────────────

const DEPOSIT_KEYWORDS = /direct dep|payroll|zelle.*from|venmo.*from|transfer from|ach credit|mobile dep|check dep|teller dep|wire in|refund|dividend|interest paid|reward|cashback|tax refund|irs|ssdi|ss benefit|pension|annuity|deposit\b/i;
const WITHDRAWAL_KEYWORDS = /purchase|pos |withdrawal|payment|charge|fee|bill pay|autopay|subscription|transfer to|wire out|check.*\d+|atm/i;

function inferSign(desc, amountMagnitude) {
  if (DEPOSIT_KEYWORDS.test(desc)) return +1;
  if (WITHDRAWAL_KEYWORDS.test(desc)) return -1;
  return null; // truly ambiguous
}

// ── Core export ───────────────────────────────────────────────────────────────

async function parsePDFTransactions(buffer, fileTags = {}) {
  const items  = await extractItems(buffer);
  const year   = fileTags.year ? parseInt(fileTags.year) : inferYear(items);
  const rows   = groupRows(items);
  const layout = detectColumnLayout(rows);

  // Does this PDF have separate debit/credit columns?
  const hasSplitCols = layout.debitX !== null && layout.creditX !== null;

  const transactions = [];
  let prevBalance    = null;

  for (const row of rows) {
    const texts  = row.map(r => r.text);
    const rowStr = texts.join(' ');
    if (shouldSkipRow(rowStr)) continue;

    // ── Find date — try single items first, then adjacent pairs/triples.
    // Handles PDFs where dates are split across items: ['01', '/16'] or ['01', '/', '16']
    let dateStr = null, dateIdx = -1;
    dateSearch: for (let len = 1; len <= 3; len++) {
      for (let i = 0; i <= Math.min(5, texts.length) - len; i++) {
        const d = parseDate(texts.slice(i, i + len).join(''), year);
        if (d) { dateStr = d; dateIdx = i + len - 1; break dateSearch; }
      }
    }
    if (!dateStr) continue;

    // ── Collect amount tokens and description tokens ─────────────────────────
    const amtItems  = [];
    const descParts = [];

    for (let i = dateIdx + 1; i < texts.length; i++) {
      let t = texts[i];
      // Merge a lone "$" prefix with the following item (some PDFs split "$" from the number)
      if (t === '$' && i + 1 < texts.length) { t = '$' + texts[++i]; }
      if (isAmountStr(t)) {
        amtItems.push({ text: t, x: row[i].x });
      } else {
        // Only add to description if it's not a date repeat and has content
        if (!DATE_RE.test(t) && t.length > 0) descParts.push(t);
      }
    }

    if (amtItems.length === 0) continue;

    // ── Build description ────────────────────────────────────────────────────
    const desc = descParts.join(' ').trim().replace(/\s+/g, ' ').slice(0, 100);

    // ── Determine amount and sign ─────────────────────────────────────────────
    let amount = null;

    if (hasSplitCols) {
      // Separate debit / credit columns — classify each amount by X proximity
      let debitAmt = null, creditAmt = null;
      for (const a of amtItems) {
        const dDist = layout.debitX  !== null ? Math.abs(a.x - layout.debitX)  : Infinity;
        const cDist = layout.creditX !== null ? Math.abs(a.x - layout.creditX) : Infinity;
        const bDist = layout.balanceX !== null ? Math.abs(a.x - layout.balanceX) : Infinity;
        if (bDist < dDist && bDist < cDist) continue; // skip balance column
        const v = parseAmount(a.text);
        if (v === null) continue;
        if (dDist <= cDist) debitAmt  = Math.abs(v);
        else                creditAmt = Math.abs(v);
      }
      if      (debitAmt  !== null) amount = -debitAmt;
      else if (creditAmt !== null) amount = +creditAmt;

    } else {
      // Single or 2-column layout (amount + balance OR just amount)
      // Last amount = balance (if ≥2), second-to-last = transaction amount
      const txAmtItem = amtItems.length >= 2
        ? amtItems[amtItems.length - 2]
        : amtItems[0];
      const balItem   = amtItems.length >= 2 ? amtItems[amtItems.length - 1] : null;

      const rawAmt = parseAmount(txAmtItem.text);
      if (rawAmt === null) continue;

      // If the raw amount already has an explicit sign, use it
      if (rawAmt < 0 || txAmtItem.text.trim().startsWith('-')) {
        amount = rawAmt;
      } else if (/^\(/.test(txAmtItem.text.trim())) {
        amount = -rawAmt; // parentheses = negative
      } else {
        // No explicit sign — try balance chain
        if (balItem !== null && prevBalance !== null) {
          const balance = parseAmount(balItem.text);
          if (balance !== null) {
            const delta = balance - prevBalance;
            // Allow 1¢ rounding tolerance
            if (Math.abs(Math.abs(delta) - rawAmt) < 0.015) {
              amount = delta >= 0 ? rawAmt : -rawAmt;
            }
          }
        }

        // Still no sign — use description keywords
        if (amount === null) {
          const signum = inferSign(desc, rawAmt);
          amount = (signum === null ? -1 : signum) * rawAmt; // default: withdrawal
        }
      }

      // Update running balance tracker
      if (balItem !== null) {
        const balance = parseAmount(balItem.text);
        if (balance !== null) prevBalance = balance;
      }
    }

    if (amount === null || amount === 0) continue;
    // Sanity-check: skip suspiciously large amounts (likely parsing errors)
    if (Math.abs(amount) > 1_000_000) continue;

    const [y, m] = dateStr.split('-');
    transactions.push({
      id:       `pdf_${dateStr}_${transactions.length}_${Math.random().toString(36).slice(2, 5)}`,
      date:     dateStr,
      month:    `${y}-${m}`,
      desc:     desc || 'Transaction',
      amount:   Math.round(amount * 100) / 100,
      category: categorize(desc),
      source:   'pdf_import',
    });
  }

  return transactions;
}

// ── Statement metadata extraction ─────────────────────────────────────────────
// Returns: { institution, accountName, last4, year, month, closingBalance }

// Institution name lookup — ordered most-specific first
const INST_PATTERNS = [
  [/jpmorgan chase/i,           'Chase'],
  [/\bchase\b/i,                'Chase'],
  [/bank of america/i,          'Bank of America'],
  [/wells fargo/i,              'Wells Fargo'],
  [/charles schwab/i,           'Charles Schwab'],
  [/\bschwab\b/i,               'Charles Schwab'],
  [/citibank/i,                 'Citi'],
  [/\bciti\b/i,                 'Citi'],
  [/u\.s\.?\s*bank/i,           'U.S. Bank'],
  [/\btd bank/i,                'TD Bank'],
  [/capital one/i,              'Capital One'],
  [/american express/i,         'American Express'],
  [/discover bank/i,            'Discover'],
  [/\bdiscover\b/i,             'Discover'],
  [/pnc bank/i,                 'PNC'],
  [/regions bank/i,             'Regions'],
  [/fifth third/i,              'Fifth Third'],
  [/huntington bank/i,          'Huntington'],
  [/\btruist\b/i,               'Truist'],
  [/suntrust/i,                 'Truist'],
  [/bb&t/i,                     'Truist'],
  [/navy federal/i,             'Navy Federal'],
  [/\busaa\b/i,                 'USAA'],
  [/\bsofi\b/i,                 'SoFi'],
  [/ally bank/i,                'Ally Bank'],
  [/marcus.*goldman/i,          'Marcus by Goldman Sachs'],
  [/goldman sachs/i,            'Goldman Sachs'],
  [/fidelity/i,                 'Fidelity'],
  [/vanguard/i,                 'Vanguard'],
  [/td ameritrade/i,            'TD Ameritrade'],
  [/e\*?trade/i,                'E*TRADE'],
  [/merrill edge/i,             'Merrill Edge'],
  [/merrill lynch/i,            'Merrill Lynch'],
  [/\bmerrill\b/i,              'Merrill'],
  [/morgan stanley/i,           'Morgan Stanley'],
  [/raymond james/i,            'Raymond James'],
  [/edward jones/i,             'Edward Jones'],
  [/interactive brokers/i,      'Interactive Brokers'],
  [/m1 finance/i,               'M1 Finance'],
  [/robinhood/i,                'Robinhood'],
  [/wealthfront/i,              'Wealthfront'],
  [/betterment/i,               'Betterment'],
  [/acorns/i,                   'Acorns'],
  [/coinbase/i,                 'Coinbase'],
  [/gemini/i,                   'Gemini'],
  [/kraken/i,                   'Kraken'],
  [/webull/i,                   'Webull'],
  [/tastytrade/i,               'tastytrade'],
  [/firstrade/i,                'Firstrade'],
  [/moomoo/i,                   'moomoo'],
];

// Account type keywords — ordered longest/most-specific first
const ACCOUNT_TYPES = [
  'TOTAL CHECKING', 'PREMIER CHECKING', 'SAPPHIRE CHECKING', 'SECURE CHECKING',
  'STUDENT CHECKING', 'PERFORMANCE CHECKING', 'ADVANTAGE CHECKING',
  'PREFERRED CHECKING', 'SIGNATURE CHECKING', 'PREMIER PLUS CHECKING',
  'EVERYDAY CHECKING', 'FREE CHECKING', 'BASIC CHECKING',
  'HIGH YIELD CHECKING', 'INTEREST CHECKING', 'BUSINESS CHECKING',
  'MONEY MARKET CHECKING', 'CHECKING',
  'HIGH YIELD SAVINGS', 'ONLINE SAVINGS', 'PREMIER SAVINGS', 'TOTAL SAVINGS',
  'MONEY MARKET SAVINGS', 'STATEMENT SAVINGS', 'BUSINESS SAVINGS', 'SAVINGS',
  'MONEY MARKET', 'CASH MANAGEMENT',
  'INDIVIDUAL BROKERAGE', 'ONE BROKERAGE', 'BROKERAGE',
  'ROTH IRA', 'TRADITIONAL IRA', 'ROLLOVER IRA', 'SEP IRA',
  'INDIVIDUAL RETIREMENT ACCOUNT',
  '401(K)', '403(B)', '457(B)',
  'CASH BACK CREDIT', 'REWARDS CREDIT', 'PLATINUM CREDIT',
  'CREDIT CARD', 'CHARGE CARD',
  'HOME EQUITY LINE', 'HOME EQUITY',
  'AUTO LOAN', 'STUDENT LOAN', 'PERSONAL LOAN', 'MORTGAGE',
];

function detectInstitution(text) {
  for (const [re, name] of INST_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

function extractLast4(text) {
  // Priority 0: full unmasked account number (e.g. "Account Number: 000000252859092")
  // Must be checked before the 4-digit patterns to avoid false positives
  const fullAcct = text.match(/account\s*(?:number|#|no\.?)[:\s]+(\d{6,})\b/i);
  if (fullAcct) return fullAcct[1].slice(-4);

  // Ordered by reliability
  const patterns = [
    /account\s*(?:number|#|no\.?)[:\s]*[*•x\-\s]*(\d{4})\b/i,
    /account\s*(?:ending|end)\s*(?:in|with)?[:\s]*[*•x\-\s]*(\d{4})\b/i,
    /[*•x]{3,}(\d{4})\b/,
    /[-]{3,}(\d{4})\b/,
    /account\s+(\d{4})\b/i,
    /acct[:\s]+[*•x\-]*(\d{4})\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function extractAccountName(text) {
  // Priority 1a: account name appears to the RIGHT of a "CHECKING/SAVINGS SUMMARY" header
  // Chase layout: "CHECKING SUMMARY   High School Checking   AMOUNT   ..."
  const afterSummaryM = text.match(/(?:checking|savings|credit card|brokerage|ira)\s+summary\s+([A-Za-z][A-Za-z ]{2,50}?)(?=\s+(?:AMOUNT|Balance|Beginning|Ending|DATE|Transaction|\$|\d))/i);
  if (afterSummaryM) return afterSummaryM[1].trim().toUpperCase();

  // Priority 1b: account name appears immediately BEFORE a "CHECKING/SAVINGS SUMMARY" header
  // Some banks: "High School Checking   CHECKING SUMMARY" → "HIGH SCHOOL CHECKING"
  const beforeSummaryM = text.match(/\b([A-Za-z][A-Za-z ]{1,39}?(?:checking|savings|credit card|brokerage|ira))\b\s+(?:checking|savings|credit card|brokerage|ira)\s+summary\b/i);
  if (beforeSummaryM) return beforeSummaryM[1].trim().toUpperCase();

  // Priority 2: explicit type keywords (longest/most-specific first)
  const upper = text.toUpperCase();
  for (const type of ACCOUNT_TYPES) {
    if (upper.includes(type)) return type;
  }
  // Priority 3: "Account Type: ..." or "Account Name: ..."
  const m = text.match(/account\s+(?:type|name)[:\s]+([A-Za-z ]{3,40})(?:\n|\.|\d|$)/i);
  if (m) return m[1].trim().toUpperCase();
  return null;
}

const MONTH_NAMES = ['january','february','march','april','may','june',
                     'july','august','september','october','november','december'];

// Word-month alternation — full names, 3-letter abbreviations, and "Sept".
const MONTH_WORD = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
function monthFromWord(w) {
  const k = String(w).toLowerCase().replace(/\./g, '').slice(0, 3);
  const i = MONTH_NAMES.findIndex(n => n.startsWith(k));
  return i < 0 ? null : i + 1;
}

// Parse "Month DD, YYYY" into {year, month, day}, or null. Accepts abbreviations.
function parseWordDate(monthWord, day, year) {
  const m = monthFromWord(monthWord);
  return m == null ? null : { year: parseInt(year), month: m, day: parseInt(day) };
}

// Validate + normalize a calendar date. Rejects impossible days (e.g. 04/31).
function makeYMD(year, month, day) {
  const y = parseInt(year), m = parseInt(month), d = parseInt(day);
  if (!y || !m || !d || y < 2000 || y > 2040 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) ? { year: y, month: m, day: d } : null;
}
const epochDays = (x) => Date.UTC(x.year, x.month - 1, x.day) / 86400000;
const fullYear  = (y) => String(y).length === 2 ? 2000 + parseInt(y) : parseInt(y);

// Find the statement DATE RANGE (start → end) in the page text. Handles:
//   "April 16, 2026 through May 15, 2026"   (word months, incl. Apr/Sept-style abbreviations)
//   "Dec 16 - Jan 15, 2027"                 (year only on the end date; start year rolls back)
//   "04/16/2026 - 05/15/2026"               (numeric, 2- or 4-digit year)
//   "Payment history (04/03/2026 - 05/11/2026)"
// Every match in the text is scored — a label like "statement/billing/period/history"
// just before it and a plausible monthly span beat a bare unlabeled range — and
// implausibly long spans (annual disclosures) are rejected outright.
const RANGE_SEP = '(?:through|thru|to|[-–—])';
function extractDateRange(text) {
  const candidates = [];
  const consider = (idx, s, e) => {
    const start = makeYMD(s.year, s.month, s.day);
    const end   = makeYMD(e.year, e.month, e.day);
    if (!start || !end) return;
    const span = epochDays(end) - epochDays(start);
    if (span < 0 || span > 95) return;       // statement cycles top out around a quarter
    let score = 0;
    const before = text.slice(Math.max(0, idx - 60), idx);
    if (/(statement|billing|activity|history|period|cycle|service)[^.]{0,60}$/i.test(before)) score += 2;
    if (span >= 20 && span <= 70) score += 1; // looks like a monthly cycle
    candidates.push({ start, end, score, idx });
  };

  const reWordFull = new RegExp(`${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\s*${RANGE_SEP}\\s*${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'gi');
  for (const m of text.matchAll(reWordFull)) {
    consider(m.index, { year: m[3], month: monthFromWord(m[1]), day: m[2] },
                      { year: m[6], month: monthFromWord(m[4]), day: m[5] });
  }
  const reWordShared = new RegExp(`${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*${RANGE_SEP}\\s*${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'gi');
  for (const m of text.matchAll(reWordShared)) {
    const sm = monthFromWord(m[1]), em = monthFromWord(m[3]), ey = parseInt(m[5]);
    consider(m.index, { year: sm > em ? ey - 1 : ey, month: sm, day: m[2] },
                      { year: ey, month: em, day: m[4] });
  }
  const reNumFull = new RegExp(`\\b(\\d{1,2})[/\\-](\\d{1,2})[/\\-](20\\d{2}|\\d{2})\\s*${RANGE_SEP}\\s*(\\d{1,2})[/\\-](\\d{1,2})[/\\-](20\\d{2}|\\d{2})\\b`, 'gi');
  for (const m of text.matchAll(reNumFull)) {
    consider(m.index, { year: fullYear(m[3]), month: m[1], day: m[2] },
                      { year: fullYear(m[6]), month: m[4], day: m[5] });
  }
  const reNumShared = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})\\s*${RANGE_SEP}\\s*(\\d{1,2})/(\\d{1,2})/(20\\d{2}|\\d{2})\\b`, 'gi');
  for (const m of text.matchAll(reNumShared)) {
    const sm = parseInt(m[1]), em = parseInt(m[3]), ey = fullYear(m[5]);
    consider(m.index, { year: sm > em ? ey - 1 : ey, month: sm, day: m[2] },
                      { year: ey, month: em, day: m[4] });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return { start: candidates[0].start, end: candidates[0].end };
}

// ── Date probing: collect every date on the page, in any common format ────────
// Each hit: { year, month, day, idx, due } — `due` marks dates whose preceding
// context looks like a due/owed/pay-by label (those are excluded from clustering,
// since a due date sits outside the statement period).
const DUE_CTX = /(due|owe[ds]?|payable|pay\s*by|received\s+after|paid\s+after|deadline|expir)/i;
function collectDates(text, fallbackYear = null) {
  const out = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);
  const add = (m, ymd) => {
    const v = makeYMD(ymd.year, ymd.month, ymd.day);
    if (!v) return;
    const s = m.index, e = m.index + m[0].length;
    if (overlaps(s, e)) return;
    taken.push([s, e]);
    out.push({ ...v, idx: s, due: DUE_CTX.test(text.slice(Math.max(0, s - 40), s)) });
  };

  for (const m of text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g))
    add(m, { year: m[1], month: m[2], day: m[3] });
  for (const m of text.matchAll(/\b(\d{1,2})[/\-](\d{1,2})[/\-](20\d{2})\b/g))
    add(m, { year: m[3], month: m[1], day: m[2] });
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/g))
    add(m, { year: 2000 + parseInt(m[3]), month: m[1], day: m[2] });
  const reWordMDY = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi');
  for (const m of text.matchAll(reWordMDY)) add(m, { year: m[3], month: monthFromWord(m[1]), day: m[2] });
  const reDWordY = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_WORD}\\.?,?\\s+(20\\d{2})\\b`, 'gi');
  for (const m of text.matchAll(reDWordY)) add(m, { year: m[3], month: monthFromWord(m[2]), day: m[1] });

  // No-year forms ("04/03", "Apr 3") — common in payment-history tables; the year
  // comes from the dominant 4-digit year elsewhere on the page.
  if (fallbackYear) {
    const reWordMD = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
    for (const m of text.matchAll(reWordMD)) add(m, { year: fallbackYear, month: monthFromWord(m[1]), day: m[2] });
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\s*\/)/g))
      add(m, { year: fallbackYear, month: m[1], day: m[2] });
  }
  return out;
}

// Densest 45-day window over the collected dates = the statement period.
// Dates outside the window (and due-labeled dates) are outliers — typically the
// payment due date or a late-fee deadline. Needs a real concentration to fire:
// at least 3 dates, holding at least 40% of everything found.
function clusterDates(dates, { windowDays = 45, minCount = 3 } = {}) {
  const usable = dates.filter(d => !d.due);
  if (usable.length < minCount) return null;
  const pts = usable.map(d => ({ ...d, ep: epochDays(d) })).sort((a, b) => a.ep - b.ep);
  let best = null;
  for (let i = 0, j = 0; i < pts.length; i++) {
    if (j < i) j = i;
    while (j + 1 < pts.length && pts[j + 1].ep - pts[i].ep <= windowDays) j++;
    const count = j - i + 1;
    if (!best || count > best.count) best = { i, j, count };
  }
  if (!best || best.count < minCount || best.count < usable.length * 0.4) return null;
  const s = pts[best.i], e = pts[best.j];
  return { start: { year: s.year, month: s.month, day: s.day },
           end:   { year: e.year, month: e.month, day: e.day },
           count: best.count };
}

// Most frequent 4-digit year on the page — used to date no-year rows like "04/03".
function inferYearFromText(text) {
  const m = text.match(/\b(20[1-3]\d)\b/g);
  if (!m) return null;
  const freq = {};
  for (const y of m) freq[y] = (freq[y] || 0) + 1;
  return parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
}

// Which month does a statement "belong to"? Name it after its CLOSING month if the
// period runs through at least the middle (the 15th) of that month; otherwise it only
// barely entered the close month and the bulk of the transactions are in the opening
// month, so use that. The 15th pivot keeps a normal "16th-to-15th" bank cycle naming
// every statement by its closing month, uniformly. Examples:
//   "Apr 16 – May 15"  → May    (closes on the 15th → close month)
//   "Apr 1  – May 1"   → Apr    (only 1 day into May → opening month)
//   "Dec 16 – Jan 15"  → Jan    (closes on the 15th → close month, year rolls forward)
function periodFromRange(range) {
  const { start, end } = range;
  if (start.year === end.year && start.month === end.month) return { year: end.year, month: end.month };
  return end.day >= 15
    ? { year: end.year, month: end.month }
    : { year: start.year, month: start.month };
}

function extractPeriod(text) {
  // 1) An explicit, plausible statement date range beats everything — e.g.
  //    "Statement period 04/01/2026 to 04/30/2026" or "Payment history (04/03/2026 - 05/11/2026)".
  const range = extractDateRange(text);
  if (range) return periodFromRange(range);

  // 2) Otherwise probe EVERY date on the page (all formats, word months included)
  //    and use the concentrated cluster — transaction/payment-history rows — with
  //    due dates and outliers excluded.
  const cluster = clusterDates(collectDates(text, inferYearFromText(text)));
  if (cluster) return periodFromRange(cluster);

  // 3) Single month-name + year (full or abbreviated), then numeric fallbacks.
  const mw = text.match(new RegExp(`\\b${MONTH_WORD}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?[,\\s]+)?(20\\d{2})\\b`, 'i'));
  if (mw) return { year: parseInt(mw[2]), month: monthFromWord(mw[1]) };
  const m2 = text.match(/\b(\d{1,2})\/(?:\d{1,2}\/)?(20\d{2})\b/);
  if (m2) return { year: parseInt(m2[2]), month: parseInt(m2[1]) };
  const m3 = text.match(/\b(20\d{2})[\/\-](\d{2})\b/);
  if (m3) return { year: parseInt(m3[1]), month: parseInt(m3[2]) };
  return { year: null, month: null };
}

// ── Property address detection (mortgage statements) ─────────────────────────
// A street address is identified by CORROBORATING signals, not shape alone — a
// bare "<number> <words> <suffix>" match isn't enough (loan numbers + document
// titles can look address-shaped). The signals, and what they're worth:
//   +4  a "Property Address:" / "Subject Property" / "Premises" label right before
//   +3  "<STATE> <ZIP>" within 80 chars after (city/state/zip line structure)
//   +1  a bare 5-digit ZIP after, or an Apt/Unit/Ste designator right after
//   +2  the same address repeats on 2+ pages (statement headers repeat the property)
//   +1  near the top of page 1
// Hard rejects: street-name words from statement vocabulary (Mortgage/Loan/
// Statement/…), single-letter fragments (except N/S/E/W), a house number that is
// really the tail of a longer number or a ZIP following a state abbreviation,
// and remit-payment context (the servicer's own address). Total < 2 → no address.
const STREET_SUFFIX = '(?:st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|ct|court|rd|road|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|aly|alley|bnd|bend|cv|cove|xing|crossing|cmn|commons|sq|square|pt|point|pike|path|row|run|walk)';
const ADDR_RE_SRC = `(\\d{1,6})\\s+([A-Za-z][A-Za-z.'\\-]*(?:\\s+[A-Za-z.'\\-]+){0,4}?)\\s+(${STREET_SUFFIX})\\b\\.?`;
const STATE_ABBRS = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
// Statement vocabulary that can never be part of a street name. This is what
// rejects "9175 Mortgage Loan Statement St"-style junk outright.
const DOC_WORDS = new Set([
  'mortgage','loan','statement','account','payment','payments','escrow','interest',
  'principal','balance','amount','total','page','summary','history','notice','date',
  'customer','service','contact','questions','insurance','tax','taxes','period',
  'activity','transaction','transactions','disclosure','information','important',
  'overdue','fee','fees','charge','charges','breakdown','detail','details','number',
  'online','autopay','due','past','box',
]);

function plausibleStreetName(name) {
  for (const w of String(name).trim().split(/\s+/)) {
    const lw = w.toLowerCase().replace(/[.']/g, '');
    if (DOC_WORDS.has(lw)) return false;
    if (lw.length === 1 && !/^[nsew]$/.test(lw)) return false; // stray split fragment ("K Obe")
  }
  return true;
}

// Is this string a believable "<number> <street name> <suffix>"? Used to sanity-
// check stored street tags.
function looksLikeStreet(s) {
  if (!s || typeof s !== 'string') return false;
  const m = s.trim().match(new RegExp(`^${ADDR_RE_SRC}$`, 'i'));
  return !!m && plausibleStreetName(m[2]);
}

function findPropertyAddress(pages) {
  const tc  = (w) => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase();
  const fmt = (m) => {
    const name   = m[2].trim().split(/\s+/).map(tc).join(' ');
    const suffix = tc(m[3].replace(/\.$/, ''));
    return { address: `${m[1]} ${name} ${suffix}`, streetName: `${name} ${suffix}` };
  };

  // Split house numbers arrive as separate fragments ("89"+"62 KOBE PL" → the
  // regex sees "62"). Absorb 1-3 digit fragments sitting right before the match —
  // never a 4+ digit run (that's a ZIP or loan number), never across a line break,
  // and never past 6 total digits.
  const repairNumber = (page, m) => {
    let num = m[1], cursor = m.index;
    for (;;) {
      const tail = page.slice(Math.max(0, cursor - 8), cursor);
      const frag = tail.match(/(?:^|[^\d.,$\-])(\d{1,3}) $/);
      if (!frag || num.length + frag[1].length > 6) break;
      num = frag[1] + num;
      cursor -= frag[1].length + 1;
    }
    return num;
  };

  const byKey = new Map(); // normalized address → best occurrence + page spread
  pages.forEach((page, pi) => {
    for (const m of page.matchAll(new RegExp(ADDR_RE_SRC, 'gi'))) {
      // Hard rejects — things that merely look address-shaped
      if (!plausibleStreetName(m[2])) continue;
      const prevCh = m.index > 0 ? page[m.index - 1] : '';
      if (/[\d#]/.test(prevCh)) continue;                       // tail of a longer number
      const before = page.slice(Math.max(0, m.index - 35), m.index);
      if (new RegExp(`\\b(?:${STATE_ABBRS})[,\\s]+$`).test(before)) continue; // "… OH 44181 …" → ZIP, not house number
      if (/(remit|send\s+payment|mail\s+(?:payment|to)|p\.?\s*o\.?\s*box|payment\s+processing)/i.test(before)) continue;
      // A company name right before = the servicer's own address, not the property
      if (/\b(?:llc|inc|n\.?a|corp|servicing|cooper|bank|company)\b[.,]?\s*$/i.test(before)) continue;

      // Corroboration. The label check looks back 60 chars (not just adjacent) —
      // statements often put "PROPERTY ADDRESS" a line above, with the amount-due
      // column's text landing in between.
      let score = 0, labeled = false;
      const labelCtx = page.slice(Math.max(0, m.index - 60), m.index);
      if (/(property\s*(?:address|location)|subject\s+property|premises)/i.test(labelCtx)) { score += 4; labeled = true; }
      const after = page.slice(m.index + m[0].length, m.index + m[0].length + 80);
      if (new RegExp(`\\b(?:${STATE_ABBRS})\\s*,?\\s*\\d{5}(?:-\\d{4})?\\b`).test(after)) score += 3;
      else if (/\b\d{5}(?:-\d{4})?\b/.test(after)) score += 1;
      if (/^\s*[,#]?\s*(?:apt|unit|ste|suite|#)\b/i.test(after)) score += 1;
      if (pi === 0 && m.index < page.length * 0.4) score += 1;  // near the top of page 1

      const num = repairNumber(page, m);
      const key = `${num} ${m[2]} ${m[3]}`.toLowerCase().replace(/\s+/g, ' ');
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { m, num, pi, idx: m.index, pages: new Set([pi]), score, labeled });
      else {
        cur.pages.add(pi);
        if (score > cur.score) cur.score = score;
        cur.labeled = cur.labeled || labeled;
      }
    }
  });
  if (!byKey.size) return null;

  // The repeat bonus only counts the first two pages: the property repeats on the
  // summary/coupon pages, while the servicer's address repeats in the disclosure
  // boilerplate on every later page.
  const ranked = [...byKey.values()]
    .map(c => ({ ...c, final: c.score + ([...c.pages].filter(p => p <= 1).length >= 2 ? 2 : 0) }))
    .sort((a, b) => b.final - a.final || (b.labeled - a.labeled) || a.pi - b.pi || a.idx - b.idx);
  if (ranked[0].final < 2) return null;
  const best = fmt(ranked[0].m);
  const addr = `${ranked[0].num} ${best.streetName}`;
  return { address: addr, streetName: best.streetName };
}

// Items → glued per-page text (see assemblePages) → findPropertyAddress.
function extractPropertyAddress(items) {
  if (!items.length) return null;
  return findPropertyAddress(assemblePages(items));
}

function extractClosingBalance(text) {
  const patterns = [
    /ending\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /closing\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /new\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /statement\s+(?:closing|ending)\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /balance\s+as\s+of[:\s]+.*?\$?([\d,]+\.\d{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

// Guess Plaid-style type/subtype from institution + account name
function guessAccountTypeSubtype(institution, accountName) {
  const inst = (institution || '').toLowerCase();
  const name = (accountName  || '').toLowerCase();

  if (/coinbase|gemini|kraken|binance|crypto/i.test(inst))
    return { type: 'investment', subtype: 'crypto exchange' };
  if (/roth|traditional ira|rollover ira|sep ira|401|403b|457|retirement/i.test(name))
    return { type: 'investment', subtype: name.includes('roth') ? 'roth' : name.includes('401') ? '401k' : 'ira' };
  if (/brokerage|schwab|fidelity|vanguard|merrill|morgan stanley|e\*?trade|td ameritrade|robinhood|m1|wealthfront|betterment|interactive brokers|webull|tastytrade|firstrade|moomoo/i.test(inst))
    return { type: 'investment', subtype: 'brokerage' };
  if (/money market/i.test(name))
    return { type: 'depository', subtype: 'money market' };
  if (/savings/i.test(name))
    return { type: 'depository', subtype: 'savings' };
  if (/credit card|charge card|cash back|rewards/i.test(name) || /american express|discover/i.test(inst))
    return { type: 'credit', subtype: 'credit card' };
  if (/mortgage/i.test(name))
    return { type: 'loan', subtype: 'mortgage' };
  if (/home equity/i.test(name))
    return { type: 'loan', subtype: 'home equity' };
  if (/student loan/i.test(name))
    return { type: 'loan', subtype: 'student' };
  if (/auto loan/i.test(name))
    return { type: 'loan', subtype: 'auto' };
  return { type: 'depository', subtype: 'checking' };
}

async function extractStatementMeta(buffer) {
  const items = await extractItems(buffer);
  // Raw PDF-internal order (for institution/period/balance — mostly robust)
  const rawText = items.map(i => i.text).join(' ');
  // Reading order with split-word fragments glued back together — required for
  // position-sensitive patterns (label before value) and so words pdf2json split
  // ("St"+"atement") don't corrupt matching.
  const pages       = assemblePages(items);
  const readingText = pages.join('\n');

  const institution    = detectInstitution(rawText);
  const last4          = extractLast4(readingText);      // reading order: label before value
  const accountName    = extractAccountName(readingText); // reading order: name before SUMMARY
  // Period from page CONTENT (range string → date cluster → single-date fallbacks).
  // Reading order first — ranges/labels need tokens in human order; raw order as retry.
  let period = extractPeriod(readingText);
  if (!period.year || !period.month) {
    const p2 = extractPeriod(rawText);
    if (p2.year && p2.month) period = p2;
  }
  const closingBalance = extractClosingBalance(rawText);
  const property       = pages.length ? findPropertyAddress(pages) : null;  // mortgage statements

  // Statement coverage range (start → end) when the page exposes one — from an
  // explicit range string, else the densest date cluster. Lets the hybrid sorter
  // dedup by date range and corroborate the closing-month naming.
  const range = extractDateRange(readingText) || extractDateRange(rawText) ||
    (() => { const c = clusterDates(collectDates(readingText, inferYearFromText(readingText))); return c ? { start: c.start, end: c.end } : null; })();
  const isoOf = (x) => x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : null;

  return { institution, accountName, last4, year: period.year, month: period.month, closingBalance,
           propertyAddress: property?.address || null, propertyStreet: property?.streetName || null,
           periodStart: isoOf(range?.start), periodEnd: isoOf(range?.end), text: readingText };
}

// ── Raw text extraction (for similarity comparison) ───────────────────────────
// Returns a single reading-order string — lightweight, no metadata extraction.
async function extractRawText(buffer) {
  const items = await extractItems(buffer);
  return items
    .sort((a, b) =>
      a.page !== b.page ? a.page - b.page :
      Math.abs(a.y - b.y) < 0.5 ? a.x - b.x : a.y - b.y
    )
    .map(i => i.text)
    .join(' ');
}

module.exports = {
  parsePDFTransactions, extractStatementMeta, guessAccountTypeSubtype, extractRawText,
  // date-probe + address primitives (exported for the mortgage flow and tests)
  extractPeriod, extractDateRange, collectDates, clusterDates, periodFromRange,
  inferYearFromText, findPropertyAddress, extractPropertyAddress, looksLikeStreet,
  assemblePages,
};
