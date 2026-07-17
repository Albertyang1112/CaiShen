'use strict';
/**
 * vault/ai-sort.js — Groq-backed document classifier + filer for the Data Vault.
 *
 * This is the AI alternative to the regex/heuristic auto-organize. Instead of keying
 * off the upload folder path and a fragile address scan (which mis-filed a Chase
 * BANK statement as a MORTGAGE because the customer's mailing address looked like a
 * property address), it reads the document's TEXT and asks an LLM two things:
 *
 *   1. What KIND of document is this?  (bank_statement | mortgage_statement |
 *      escrow | tax_form | other)
 *   2. Exactly which vault folder should it live in, following CaiShen's filing
 *      rules, REUSING folders that already exist?
 *
 * The model's answer is then reconciled in code (snapped to existing folder names,
 * filename recomputed deterministically) so the final path is consistent and never
 * depends on the model's spelling/casing.
 *
 * Provider: Groq's OpenAI-compatible chat API (same key/pattern the receipt OCR and
 * categorizer already use). PDFs are read via their text layer (pdf-parser); image
 * uploads go through the Groq vision model. Scanned/textless PDFs return needsOcr.
 *
 * Pure module — NO Express, NO routes, NO wiring. classifyDocument() does the work;
 * vault/ai-sort-routes.js (not mounted) and the AiSort page consume it later.
 */
const { extractRawText } = require('../core/pdf-parser');
const { groqChat } = require('./groq-client');   // shared rate-limit-aware gateway

const TEXT_MODEL  = process.env.GROQ_MODEL        || 'openai/gpt-oss-120b';
const VISION_MODEL= process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── System prompt: the filing rules live here ────────────────────────────────
const SYSTEM = `You are a document-filing assistant for a personal-finance vault. You are given the TEXT of ONE uploaded financial document. Decide (a) what KIND of document it is and (b) which vault folder it belongs in, following the filing rules. Respond with ONLY a JSON object — no prose, no markdown.

DOCUMENT TYPES — choose ONE for "docType":
- "bank_statement"     : a checking / savings / brokerage account statement from a bank or brokerage. It lists transactions (deposits/withdrawals) and an account balance.
- "mortgage_statement" : a monthly mortgage LOAN statement from a mortgage servicer. Shows principal balance, interest rate, escrow, amount due, and the PROPERTY address securing the loan.
- "escrow"             : an escrow analysis / disclosure from a mortgage servicer (annual escrow account review).
- "tax_form"           : an IRS / tax form (1098, 1099-INT/DIV/B/NEC/MISC/R, W-2, SSA-1099, 1040, Schedule K-1, a property-tax bill, or an estimated-tax voucher like 1040-ES/540-ES).
- "insurance_statement": an insurance bill / premium statement / declarations page from an insurance carrier (homeowners, earthquake, flood, auto, umbrella, …). Shows a policy number, a premium or amount due, and usually the INSURED property or vehicle.
- "disclosure"         : a bank / brokerage / lender disclosure or notice (privacy notice, fee schedule, terms update, regulatory disclosure). Informational — no transactions, no amount due.
- "other"              : anything else.

HOW TO TELL BANK vs MORTGAGE (critical):
- A BANK statement is about a deposit account: it lists individual transactions and a running/ending balance. The mailing address printed on it is the CUSTOMER's home address — IGNORE it for filing. File by BANK, never by that address.
- A MORTGAGE statement is about a loan: principal balance, interest rate, escrow, "amount due", payment coupon, and a PROPERTY ADDRESS the loan is secured by. File by that PROPERTY address.
- Never classify a document as a mortgage just because an address appears on it.

FILING RULES — set "folder" (a forward-slash path) and "filename":
- bank_statement     -> "Bank Statements/{institution}/{accountName} (••{last4})/{year}"
    institution = bank/brokerage brand only (e.g. "Chase", "Bank of America", "Charles Schwab").
    accountName = the product name on the statement (e.g. "Total Checking", "Premier Savings").
    The ACCOUNT IS IDENTIFIED BY ITS LAST 4 DIGITS — always extract last4, and if a folder
    already exists for the same institution + last4 (even under a DIFFERENT name), REUSE it
    rather than create a new one. The last4 keeps a renamed account from splitting in two.
    filename = "{last4} Statement {Mon} {year}.pdf"  (Mon = 3-letter month). If no last4: "{accountName} {Mon} {year}.pdf".
- mortgage_statement -> "Mortgage Statements/{propertyAddress}/{year}"
    propertyAddress = the property/subject address securing the loan (e.g. "8962 Kobe Pl"). NOT the servicer's payment/remit address.
    filename = "{streetName} {Mon} {year}.pdf"  (streetName = address WITHOUT the house number, e.g. "Kobe Pl Jun 2026.pdf").
- escrow             -> "Mortgage Statements/{propertyAddress}/{year}" , filename "{streetName} Escrow {year}.pdf".
- tax_form           -> "Tax Documents/{year}" , filename "{formType} {issuer} {year}.pdf"  (e.g. "1098 Mr Cooper 2025.pdf").
- insurance_statement-> "Insurance/{insured property address, else carrier}/{year}"
    institution = the CARRIER brand only (e.g. "Farmers", "GeoVera", "State Farm").
    propertyAddress = the INSURED property's street address (not the mailing or carrier address); null for auto/umbrella.
    filename = "{carrier} {coverageType} {policyLast4} {Mon} {year}.pdf"  (e.g. "GeoVera Earthquake 5678 Aug 2026.pdf").
    year/month = of the DUE DATE (or statement date if no due date).
- disclosure         -> "Disclosures/{institution}/{year}" , filename "{institution} Disclosure {Mon} {year}.pdf" (omit {Mon} if unknown).
- other              -> "Unsorted" , keep the original file name.

REUSE EXISTING FOLDERS: You are given the folders that already exist. If the right institution / account / property already exists — even under different casing or minor spelling — reuse that EXACT existing name. Do not create a near-duplicate.

STATEMENT PERIOD (which month a statement is named after):
- A statement usually covers a period like "January 17, 2026 through February 17, 2026" (or "MM/DD/YYYY - MM/DD/YYYY"). Extract those two dates as periodStart and periodEnd (YYYY-MM-DD).
- The statement is named by its CLOSING month — the month/year of periodEnd, NOT the opening month. So "January 17 through February 17, 2026" is named for FEBRUARY 2026, and "December 16, 2025 through January 16, 2026" is named for JANUARY 2026. Set "month" and "year" to the closing month/year accordingly. (If the period sits entirely within one month, use that month.)

Also extract (null if unknown): institution, accountName, last4 (4 digits), propertyAddress, periodStart (YYYY-MM-DD), periodEnd (YYYY-MM-DD), year (4-digit int = closing year), month (1-12 int = closing month), formType.
For insurance_statement also fill: policyNumber (as printed), coverageType (lowercase: homeowners|earthquake|flood|auto|umbrella|landlord|renters|condo|life|other), dueDate (YYYY-MM-DD payment due date), amountDue (number, dollars). Leave them null for other types.
Add "confidence" (0..1) and "reasoning" (ONE short sentence on what told you the type).

Respond with EXACTLY this JSON shape:
{"docType":"...","institution":null,"accountName":null,"last4":null,"propertyAddress":null,"periodStart":null,"periodEnd":null,"year":null,"month":null,"formType":null,"policyNumber":null,"coverageType":null,"dueDate":null,"amountDue":null,"folder":"...","filename":"...","confidence":0.0,"reasoning":"..."}`;

// ── Parse the existing folder tree into reuse candidates ─────────────────────
function indexFolders(folders = [], userProperties = []) {
  const paths = folders.map(f => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  const banks = new Set(), properties = new Set(), insuranceSegs = new Set(), disclosureIssuers = new Set();
  const accountsByBank = {};
  const accountFolderByLast4 = {};   // { instKey: { last4: accountFolderSegment } } — last4 is the account identity
  const last4Of = (seg) => { const m = String(seg).match(/(\d{4})(?!.*\d)/); return m ? m[1] : null; };
  for (const p of paths) {
    const parts = p.split('/');
    if (parts[0] === 'Bank Statements' && parts[1]) {
      banks.add(parts[1]);
      if (parts[2]) {
        const instKey = parts[1].toLowerCase();
        (accountsByBank[instKey] ||= new Set()).add(parts[2]);
        const l4 = last4Of(parts[2]);
        if (l4) (accountFolderByLast4[instKey] ||= {})[l4] = parts[2];
      }
    } else if (parts[0] === 'Mortgage Statements' && parts[1]) {
      properties.add(parts[1]);
    } else if (parts[0] === 'Insurance' && parts[1]) {
      insuranceSegs.add(parts[1]);              // property name or carrier — reuse either way
    } else if (parts[0] === 'Disclosures' && parts[1]) {
      disclosureIssuers.add(parts[1]);
    }
  }
  return { paths, banks, properties, accountsByBank, accountFolderByLast4,
           insuranceSegs, disclosureIssuers,
           userProperties: Array.isArray(userProperties) ? userProperties : [] };
}

// A compact view of the existing tree for the prompt (depths 1-3, deduped).
function folderTreeForPrompt(folders) {
  const keep = (p) => /^(Bank Statements|Mortgage Statements|Tax Documents|Insurance|Disclosures)(\/|$)/.test(p);
  const paths = [...new Set((folders || [])
    .map(f => (typeof f === 'string' ? f : f.path))
    .filter(p => p && keep(p) && p.split('/').length <= 3))].sort();
  return paths.length ? paths.join('\n') : '(vault is empty — no folders yet)';
}

// Snap a model-proposed name to an existing folder name when they clearly refer to
// the same thing (case-insensitive exact, or strong token overlap). Keeps the vault
// from sprouting "CHASE" next to "Chase" or "Kobe Pl" next to "8962 Kobe Pl".
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function snap(proposed, candidates) {
  const want = norm(proposed);
  if (!want) return proposed;
  const list = [...candidates];
  for (const c of list) if (norm(c) === want) return c;                 // exact (case-insensitive)
  const wantToks = new Set(want.split(' ').filter(Boolean));
  for (const c of list) {                                               // containment either way
    const cToks = new Set(norm(c).split(' ').filter(Boolean));
    if (!cToks.size) continue;
    const inter = [...wantToks].filter(t => cToks.has(t)).length;
    const ratio = inter / Math.min(wantToks.size, cToks.size);
    if (ratio >= 0.8) return c;
  }
  return proposed;
}

const sanitize = (s) => String(s || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
// Folder paths sanitize per SEGMENT — plain sanitize() strips '/' and would collapse
// "Insurance/CEA/2026" into the junk root folder "InsuranceCEA2026".
const sanitizePath = (s) => String(s || '').split('/').map(sanitize).filter(Boolean).join('/');
const streetNameOf = (addr) => sanitize(addr).replace(/^\d+\s+/, '').trim();   // drop house number

// Match a printed insured address against the user's own properties ({id,name,address}) —
// house number + a street token, or the property's name appearing in the text. Returns the
// property's display NAME (the folder segment) or null. Nothing hardcoded.
function matchUserProperty(address, userProperties = []) {
  const a = norm(address);
  if (!a) return null;
  const aNum = (a.match(/\b\d{1,6}\b/) || [])[0] || null;
  for (const p of userProperties) {
    if (!p) continue;
    const name = norm(p.name);
    if (name && a.includes(name)) return sanitize(p.name);
    const pa = norm(p.address);
    if (!pa) continue;
    const pNum = (pa.match(/\b\d{1,6}\b/) || [])[0] || null;
    if (aNum && pNum && aNum === pNum) {
      const streetTokens = pa.split(' ').filter(t => t.length >= 3 && !/^\d+$/.test(t));
      if (streetTokens.some(t => a.includes(t))) return sanitize(p.name);
    }
  }
  return null;
}

// ── Text / image extraction ──────────────────────────────────────────────────
async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf' || !mimeType) {
    try { return (await extractRawText(buffer) || '').trim(); } catch { return ''; }
  }
  return ''; // images handled via vision in classifyDocument
}

// Rate-limit handling (global concurrency cap + shared cooldown) lives in groq-client.
async function groqJson(model, messages, maxTokens = 900) {
  const resp = await groqChat({ model, messages, max_tokens: maxTokens, temperature: 0 });
  const raw = resp.data?.choices?.[0]?.message?.content || '';
  const usage = resp.data?.usage || null;
  let parsed = null;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
  return { parsed, raw, usage, model };
}

// ── Reconcile the model's answer against existing folders + recompute the path ─
function reconcile(ai, idx, originalName) {
  const d = ai || {};
  const docType = ['bank_statement','mortgage_statement','escrow','tax_form','insurance_statement','disclosure','other'].includes(d.docType)
    ? d.docType : 'other';

  // Naming month/year. Prefer the statement's COVERAGE dates (closing-month rule —
  // matches the existing scheme: a "Jan 17 → Feb 17" statement is named February)
  // over the model's single month, which is ambiguous on cycle-spanning statements.
  const parseISO = (s) => { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
    return m ? { year: +m[1], month: +m[2], day: +m[3] } : null; };
  let nYear  = d.year  ? parseInt(String(d.year).replace(/[^\d]/g, '').slice(0, 4)) : null;
  let nMonth = d.month && d.month >= 1 && d.month <= 12 ? parseInt(d.month) : null;
  const ps = parseISO(d.periodStart), pe = parseISO(d.periodEnd);
  if (pe && pe.month >= 1 && pe.month <= 12) {
    if (ps && ps.month >= 1 && ps.month <= 12 && !(ps.year === pe.year && ps.month === pe.month)) {
      const naming = pe.day >= 15 ? pe : ps;     // closing month if it ran past mid-month, else opening
      nYear = naming.year; nMonth = naming.month;
    } else { nYear = pe.year; nMonth = pe.month; }
  }
  let year  = nYear ? String(nYear) : null;
  let month = nMonth || null;
  let mon   = month ? MONTH_ABBR[month - 1] : null;
  const last4 = d.last4 ? String(d.last4).replace(/[^\d]/g, '').slice(-4) : null;
  // Normalized coverage dates (YYYY-MM-DD) — used downstream for date-range
  // duplicate detection: two statements covering the same range are the same statement.
  const isoFmt = (x) => x ? `${x.year}-${String(x.month).padStart(2, '0')}-${String(x.day).padStart(2, '0')}` : null;
  const periodStart = isoFmt(ps), periodEnd = isoFmt(pe);

  let folder = sanitizePath(d.folder || '');
  let filename = sanitize(d.filename || originalName) || originalName;
  let institution = d.institution ? sanitize(d.institution) : null;
  let accountName = d.accountName ? sanitize(d.accountName) : null;
  let property    = d.propertyAddress ? sanitize(d.propertyAddress) : null;

  if (docType === 'bank_statement') {
    institution = institution ? snap(institution, idx.banks) : null;
    const instKey = institution ? institution.toLowerCase() : '';
    // Account identity = last4. A renamed account must NOT split into two folders, so if a
    // folder already exists for this (institution, last4) reuse it verbatim. Only a NEW last4
    // mints a folder "{name} (••last4)" — last4 is the eternal key, name is the model's call.
    let acctSeg = (last4 && idx.accountFolderByLast4[instKey]) ? idx.accountFolderByLast4[instKey][last4] : null;
    if (!acctSeg) {
      const readable = (accountName || 'Account').trim() || 'Account';
      acctSeg = last4 ? (readable.includes(last4) ? readable : `${readable} (••${last4})`) : readable;
    }
    accountName = acctSeg;
    if (institution && acctSeg && year) {
      folder = `Bank Statements/${institution}/${acctSeg}/${year}`;
      filename = last4 && mon ? `${last4} Statement ${mon} ${year}.pdf`
               : (mon ? `${acctSeg} ${mon} ${year}.pdf` : filename);
    }
  } else if (docType === 'mortgage_statement' || docType === 'escrow') {
    property = property ? snap(property, idx.properties) : null;
    if (property && year) {
      folder = `Mortgage Statements/${property}/${year}`;
      const sn = streetNameOf(property);
      filename = docType === 'escrow'
        ? `${sn} Escrow ${year}.pdf`
        : (mon ? `${sn} ${mon} ${year}.pdf` : filename);
    }
  } else if (docType === 'tax_form') {
    if (year) {
      folder = `Tax Documents/${year}`;
      const ft = sanitize(d.formType || 'Tax Form');
      const issuer = institution ? ` ${institution}` : '';
      filename = `${ft}${issuer} ${year}.pdf`;
    }
  } else if (docType === 'insurance_statement') {
    // Naming year/month for a bill = its DUE DATE — derive them when the model omitted
    // year/month (photos especially), so the folder never degrades to the raw fallback
    // and the tags/dedup keys still carry the billing month.
    const dueISO = /^\d{4}-\d{2}-\d{2}$/.test(String(d.dueDate || '')) ? d.dueDate : null;
    if (!year && dueISO) { year = dueISO.slice(0, 4); month = Number(dueISO.slice(5, 7)); mon = MONTH_ABBR[month - 1]; }
    const iYear = year, iMon = mon;
    // Second-level segment: the insured property's NAME when the address matches one of the
    // user's properties (so "Insurance/Alcita/2026"), else the printed address snapped to an
    // existing Insurance/ folder, else the carrier. Nothing hardcoded — properties come from
    // the user's own properties.json, passed through indexFolders.
    const propHit = property ? matchUserProperty(property, idx.userProperties) : null;
    const seg = propHit
      || (property ? snap(property, idx.insuranceSegs || new Set()) : null)
      || (institution ? snap(institution, idx.insuranceSegs || new Set()) : null);
    if (propHit) property = propHit;
    if (seg) {
      // No year at all → file under the carrier/property without a year folder (never junk).
      folder = iYear ? `Insurance/${seg}/${iYear}` : `Insurance/${seg}`;
      const cov = d.coverageType ? ` ${sanitize(String(d.coverageType)).replace(/^./, c => c.toUpperCase())}` : '';
      // Policy last-4 in the filename keeps same-carrier same-month bills (one per property)
      // from colliding into "_<timestamp>" rename suffixes.
      const p4 = d.policyNumber ? String(d.policyNumber).replace(/[^A-Za-z0-9]/g, '').slice(-4) : null;
      filename = `${institution || 'Insurance'}${cov}${p4 ? ` ${p4}` : ''}${iMon ? ` ${iMon}` : ''}${iYear ? ` ${iYear}` : ''}.pdf`;
    }
  } else if (docType === 'disclosure') {
    const issuer = institution ? snap(institution, idx.disclosureIssuers || new Set()) : null;
    if (issuer) {
      institution = issuer;
      folder = year ? `Disclosures/${issuer}/${year}` : `Disclosures/${issuer}`;
      filename = `${issuer} Disclosure${mon ? ` ${mon}` : ''}${year ? ` ${year}` : ''}.pdf`;
    }
  } else {
    if (!folder) folder = 'Unsorted';
    filename = originalName;
  }
  if (!filename.toLowerCase().endsWith('.pdf') && /\.pdf$/i.test(originalName)) filename += '.pdf';

  return {
    docType, institution, accountName, last4, propertyAddress: property,
    year: year ? parseInt(year) : null, month, formType: d.formType || null,
    periodStart, periodEnd,
    // Insurance fields (null for other types) — the domain recorder uses these as a
    // fallback when the deterministic text parse misses them.
    policyNumber: d.policyNumber ? sanitize(String(d.policyNumber)) : null,
    coverageType: d.coverageType ? String(d.coverageType).toLowerCase().trim() : null,
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.dueDate || '')) ? d.dueDate : null,
    amountDue: typeof d.amountDue === 'number' && Number.isFinite(d.amountDue) ? d.amountDue : null,
    folder, filename,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    reasoning: d.reasoning || null,
  };
}

/**
 * Classify one document and decide where it should be filed.
 * @param {{ buffer: Buffer, filename: string, mimeType?: string, folders?: any[] }} args
 * @returns {Promise<{ ok, decision, raw, textChars, needsOcr?, usage, model, error? }>}
 */
async function classifyDocument({ buffer, filename, mimeType = 'application/pdf', folders = [], properties = [] }) {
  const idx  = indexFolders(folders, properties);
  const tree = folderTreeForPrompt(folders);
  const isImage = /^image\//.test(mimeType);

  let result;
  if (isImage) {
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    result = await groqJson(VISION_MODEL, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: `EXISTING VAULT FOLDERS (reuse these names where they match):\n${tree}\n\nUPLOADED FILE NAME: ${filename}\n\nClassify and file the document in this image.` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ]);
    return finish(result, idx, filename, null, null);
  }

  const text = await extractText(buffer, mimeType);
  if (!text || text.length < 20) {
    return { ok: false, needsOcr: true, textChars: text.length,
      decision: reconcile({ docType: 'other' }, idx, filename),
      error: 'No extractable text layer (likely a scanned PDF — needs OCR/vision).' };
  }
  result = await groqJson(TEXT_MODEL, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content:
      `EXISTING VAULT FOLDERS (reuse these names where they match):\n${tree}\n\n` +
      `UPLOADED FILE NAME: ${filename}\n\nDOCUMENT TEXT (truncated):\n${text.slice(0, 7000)}` },
  ]);
  return finish(result, idx, filename, text.length, text);
}

function finish(result, idx, filename, textChars, text) {
  if (!result.parsed) {
    return { ok: false, error: 'Model did not return valid JSON', raw: result.raw,
      decision: reconcile({ docType: 'other' }, idx, filename), usage: result.usage, model: result.model, textChars, text };
  }
  return { ok: true, decision: reconcile(result.parsed, idx, filename),
    raw: result.parsed, usage: result.usage, model: result.model, textChars, text };
}

module.exports = { classifyDocument, indexFolders, folderTreeForPrompt, snap, reconcile, matchUserProperty, TEXT_MODEL, VISION_MODEL };
