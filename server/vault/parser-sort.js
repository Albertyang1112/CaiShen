'use strict';
/**
 * vault/parser-sort.js — deterministic, no-AI triage + extraction (Tier 1+2 of the
 * hybrid vault sorter).
 *
 * Reads a statement PDF locally (core/pdf-parser), decides the document TYPE from
 * cheap signals (content keywords + filename + folder), pulls the filing fields, and
 * — only when corroborating signals agree (the confidence gate) — returns a fully
 * reconciled filing decision WITHOUT any Groq call. When it isn't confident (unknown
 * type, missing fields, scanned/no-text), it returns null and the caller falls back
 * to Groq (vault/ai-sort.js). No network, no rate limit.
 *
 * Disambiguation learned from real data: a BANK statement also prints the customer's
 * MAILING address, which findPropertyAddress surfaces — so a present address NEVER
 * implies "mortgage". The bank-account signature wins and the address is ignored for
 * bank statements; only a STRONG mortgage signal (principal balance / escrow /
 * "mortgage") + a corroborated property address, with NO bank-summary block, routes
 * a file to mortgage.
 */
const { extractStatementMeta } = require('../core/pdf-parser');
const { reconcile, indexFolders, snap } = require('./ai-sort');
const { detectTaxFormTags } = require('./helpers');

// A deposit/credit account statement's tell-tale summary block.
const BANK_SIG = [/\b(checking|savings|brokerage)\s+summary\b/i, /deposits?\s+and\s+additions/i];
const hasBankSig = (t) =>
  BANK_SIG.some(re => re.test(t)) || (/beginning\s+balance/i.test(t) && /ending\s+balance/i.test(t));

// Markers a mortgage LOAN statement has that a bank/credit account statement does not.
const STRONG_MORTGAGE = [/principal\s+balance/i, /unpaid\s+principal/i, /\bescrow\b/i,
                         /\bmortgage\s+(?:statement|loan|payment|servic)/i];
const hasStrongMortgage = (t) => STRONG_MORTGAGE.some(re => re.test(t));

// Markers of an INSURANCE bill / declarations page. A homeowner's insurance bill often
// mentions "escrow" (mortgagee clause: "billed to your escrow account"), which trips
// STRONG_MORTGAGE — so an insurance-looking document with NO principal-balance signal is
// deferred to Groq rather than deterministically (mis)filed as a mortgage. Carriers vary
// too much for confident Tier-1 filing anyway.
const INSURANCE_SIG = [/\bpolicy\s+(?:number|no\.?|#)/i, /\bpremium\b/i, /\bdeclarations?\s+page\b/i,
                       /\binsurance\s+(?:company|policy|bill|statement|premium)\b/i, /\bcoverage\s+(?:period|type|limit)/i];
const PRINCIPAL_SIG = /principal\s+balance|unpaid\s+principal/i;
const looksInsurance = (t) => INSURANCE_SIG.filter(re => re.test(t)).length >= 2 && !PRINCIPAL_SIG.test(t);

const mk = (decision, type, confidence, reasoning) => ({ decision, type, confidence, reasoning, viaParser: true });

/**
 * Deterministic triage + extraction for ONE PDF.
 * @param {Buffer} buffer
 * @param {{ name?: string, folderPath?: string, tags?: object }} file
 * @param {Array} folders  existing vault folders (for reuse-snapping)
 * @returns {Promise<{decision,type,confidence,reasoning,viaParser:true}|null>}
 */
async function parserSort(buffer, file, folders) {
  let meta;
  try { meta = await extractStatementMeta(buffer); } catch { return null; }
  const text = meta.text || '';
  if (text.length < 40) return null;                 // scanned / no text layer → Groq (vision)

  const folderHint = (file.folderPath || '').toLowerCase();
  const idx = indexFolders(folders);

  // ── Tax form: filename signal (1098 / 1099 / W-2 …) + a year, content-corroborated ──
  const tax = detectTaxFormTags(file.name || '');
  const taxYear = tax.year || (text.match(/\b(20\d{2})\b/) || [])[1];
  if (tax.taxFormType && taxYear &&
      (folderHint.includes('tax') || /\b(1098|1099|w-?2|1040|ssa-?1099|schedule\s+k)\b/i.test(text))) {
    const flat = { docType: 'tax_form', formType: tax.taxFormType, institution: meta.institution || null,
                   year: taxYear, reasoning: `parser: tax form ${tax.taxFormType}` };
    const decision = reconcile(flat, idx, file.name);
    if (decision.folder && decision.folder.startsWith('Tax Documents/')) return mk(decision, 'tax_form', 0.9, flat.reasoning);
  }

  const bankish    = hasBankSig(text);
  const strongMort = hasStrongMortgage(text);

  // ── Insurance bill: defer to Groq (which knows the Insurance/ filing rules) ──
  if (!bankish && looksInsurance(text)) return null;

  // ── Bank statement: a bank brand + a bank-account signature → bank (ignore address) ──
  // Grouping key is the LAST-4. The parser files deterministically only when this account
  // (institution + last4) ALREADY has a folder; a brand-NEW last4 is handed to Groq so it can
  // name the account properly — once. Every later statement for that last4 reuses the folder
  // here, no Groq. (The merge migration seeds the first folder for pre-existing accounts.)
  if (meta.institution && meta.last4 &&
      (bankish || folderHint.includes('bank statement') || !strongMort) &&
      meta.year && meta.month) {
    const instKey = (snap(meta.institution, idx.banks) || meta.institution).toLowerCase();
    const known = idx.accountFolderByLast4[instKey] && idx.accountFolderByLast4[instKey][meta.last4];
    if (!known) return null;                          // new account → let Groq name it
    const flat = { docType: 'bank_statement', institution: meta.institution, accountName: meta.accountName,
                   last4: meta.last4, year: meta.year, month: meta.month,
                   periodStart: meta.periodStart, periodEnd: meta.periodEnd,
                   reasoning: `parser: ${meta.institution} ••${meta.last4}${bankish ? ' (summary)' : ''}` };
    const decision = reconcile(flat, idx, file.name);
    if (decision.folder && decision.folder.startsWith('Bank Statements/')) {
      const conf = (bankish && meta.periodStart) ? 0.95 : 0.8;
      return mk(decision, 'bank_statement', conf, flat.reasoning);
    }
    return null;
  }

  // ── Mortgage statement: a STRONG mortgage signal + a corroborated property address ──
  if (strongMort && meta.propertyAddress && !bankish && meta.year && meta.month) {
    const flat = { docType: 'mortgage_statement', propertyAddress: meta.propertyAddress,
                   institution: meta.institution, year: meta.year, month: meta.month,
                   periodStart: meta.periodStart, periodEnd: meta.periodEnd,
                   reasoning: `parser: mortgage ${meta.propertyAddress}` };
    const decision = reconcile(flat, idx, file.name);
    if (decision.folder && decision.folder.startsWith('Mortgage Statements/')) return mk(decision, 'mortgage_statement', 0.85, flat.reasoning);
  }

  return null;                                        // unknown / low-confidence → Groq
}

module.exports = { parserSort, hasBankSig, hasStrongMortgage, looksInsurance };
