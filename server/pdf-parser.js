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

async function extractItems(buffer) {
  const parser = new PDFParser(null, 0);
  const data   = await new Promise((resolve, reject) => {
    parser.on('pdfParser_dataReady', resolve);
    parser.on('pdfParser_dataError', reject);
    parser.parseBuffer(buffer);
  });

  const items = [];
  for (let p = 0; p < (data.Pages || []).length; p++) {
    for (const el of (data.Pages[p].Texts || [])) {
      const text = el.R
        .map(r => { try { return decodeURIComponent(r.T); } catch { return r.T; } })
        .join('')
        .trim();
      if (text) items.push({ text, x: el.x, y: el.y, page: p });
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
  // Matches: 1234.56  $1,234.56  (1,234.56)  -1,234.56  1,234.56-
  return /^\$?\-?\(?\d[\d,]*\.\d{2}\)?-?$/.test(s.replace(/\s/g, ''));
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

    // ── Find date (first or second token) ───────────────────────────────────
    let dateStr = null, dateIdx = -1;
    for (let i = 0; i < Math.min(3, texts.length); i++) {
      const d = parseDate(texts[i], year);
      if (d) { dateStr = d; dateIdx = i; break; }
    }
    if (!dateStr) continue;

    // ── Collect amount tokens and description tokens ─────────────────────────
    const amtItems  = [];
    const descParts = [];

    for (let i = dateIdx + 1; i < texts.length; i++) {
      const t = texts[i];
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

function extractPeriod(text) {
  const t = text.toLowerCase();
  // "January 2024" or "January 1, 2024"
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const re = new RegExp(`${MONTH_NAMES[i]}\\s+(?:\\d{1,2}[,\\s]+)?(20\\d{2})`);
    const m = t.match(re);
    if (m) return { year: parseInt(m[1]), month: i + 1 };
  }
  // MM/DD/YYYY or MM/YYYY
  const m2 = text.match(/\b(\d{1,2})\/(?:\d{1,2}\/)?(20\d{2})\b/);
  if (m2) return { year: parseInt(m2[2]), month: parseInt(m2[1]) };
  // YYYY-MM
  const m3 = text.match(/\b(20\d{2})[\/\-](\d{2})\b/);
  if (m3) return { year: parseInt(m3[1]), month: parseInt(m3[2]) };
  return { year: null, month: null };
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
  // Reading order (sorted page → Y → X) — required for position-sensitive patterns
  // where one token (e.g. "Account Number:") must precede the value token
  const readingText = [...items]
    .sort((a, b) =>
      a.page !== b.page ? a.page - b.page :
      Math.abs(a.y - b.y) < 0.5 ? a.x - b.x : a.y - b.y
    )
    .map(i => i.text)
    .join(' ');

  const institution    = detectInstitution(rawText);
  const last4          = extractLast4(readingText);      // reading order: label before value
  const accountName    = extractAccountName(readingText); // reading order: name before SUMMARY
  const { year, month} = extractPeriod(rawText);
  const closingBalance = extractClosingBalance(rawText);

  return { institution, accountName, last4, year, month, closingBalance };
}

module.exports = { parsePDFTransactions, extractStatementMeta, guessAccountTypeSubtype };
