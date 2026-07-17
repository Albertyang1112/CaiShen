'use strict';
/**
 * vault/domain-hooks.js — post-filing domain recorders.
 *
 * Filing a PDF into the vault only places bytes + tags; this hook gives structured
 * domains their rows. After a file lands in its target folder (vault auto-organize) or is
 * filed by the chatbot (banking/doc-ingest), runDomainRecorder() routes it to the matching
 * domain recorder:
 *
 *   insurance_statement → parse (insurance-parse, Groq fallback) → insurance_policies /
 *                         insurance_statements / insurance_payments (banking/insurance.js)
 *   tax_form            → payment-schedule extraction (tax/schedule-extract, Groq) →
 *                         tax_payment_schedule rows (tax/schedule.js)
 *
 * Best-effort by contract: NEVER throws — a recorder failure must not break vault filing.
 * The vault file id IS the documents-row id (bytes in R2), so it is passed as documentId.
 * Callers pass `text` when they already extracted it (classify step) to avoid a second
 * pdf2json pass; the hook extracts only as a fallback.
 */
const { query } = require('../core/db');

async function getText(text, buffer) {
  if (text && text.length > 20) return text;
  if (!buffer || sniffImage(buffer)) return '';   // photos have no text layer — vision handles them
  try { const { extractRawText } = require('../core/pdf-parser'); return (await extractRawText(buffer) || '').trim(); }
  catch { return ''; }
}

// Magic-byte sniff: uploads lie about their extension (real case: JPEG photos named .pdf).
// Returns the image mime type or null.
function sniffImage(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
  if (buffer.length > 11 && buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ── insurance_statement ────────────────────────────────────────────────────────
async function recordInsurance({ userId, io, fileId, buffer, text, decision }) {
  const parse = require('../banking/insurance-parse');
  const insurance = require('../banking/insurance');
  const d = decision || {};

  const body = await getText(text, buffer);
  let parsed = parse.parseInsuranceStatement(body);

  // Groq fallback when the deterministic read isn't actionable: text extraction for weird
  // carrier layouts, VISION for photographed bills (a JPEG named .pdf has no text layer at
  // all — sniff the bytes, don't trust the extension). Deterministic values win on merge.
  if (parsed.confidence < 0.6 || parsed.dueDate == null || parsed.amountDue == null || parsed.propertyAddress == null) {
    try {
      const { extractInsuranceFields, extractInsuranceFieldsFromImage, mergeParsed } = require('../banking/insurance-ai');
      const imgMime = sniffImage(buffer);
      if (body) parsed = mergeParsed(parsed, await extractInsuranceFields(body));
      else if (imgMime) parsed = mergeParsed(parsed, await extractInsuranceFieldsFromImage(buffer, imgMime));
    } catch (e) { console.log('[domain-hooks] insurance Groq fallback failed:', e.message); }
  }
  // The classifier's own extraction is a last-resort fill (it read the same document —
  // for images it is the ONLY reader).
  const fill = (k, v) => { if (parsed[k] == null && v != null) parsed[k] = v; };
  fill('carrier', d.institution); fill('coverageType', d.coverageType);
  fill('dueDate', d.dueDate); fill('amountDue', d.amountDue);
  fill('policyNumber', d.policyNumber); fill('propertyAddress', d.propertyAddress);
  if (!parsed.policyNumberMask && parsed.policyNumber)
    parsed.policyNumberMask = String(parsed.policyNumber).replace(/[^A-Z0-9]/gi, '').slice(-4);

  if (parsed.carrier == null && parsed.amountDue == null && parsed.dueDate == null) {
    return { recorded: false, reason: 'nothing actionable parsed' };
  }

  // Models sometimes misfile the unlabeled insured address (printed under the carrier's
  // name on CEA-style bills) as the CARRIER's address. A street-looking "carrier address"
  // is far more likely the insured property — promote it as a candidate. Safe: if no
  // property matches, the add-property QUESTION puts the user in the loop before anything
  // is created, so a wrong promotion just gets a "no".
  if (!parsed.propertyAddress && /^\d{1,6}\s+\S/.test(String(parsed.carrierAddress || ''))) {
    parsed.propertyAddress = parsed.carrierAddress;
    parsed.carrierAddress = null;
  }

  const propertyId = insurance.resolvePropertyId(io, parsed.propertyAddress);
  const policyId = await insurance.upsertInsurancePolicy(query, userId, {
    carrier: parsed.carrier, policyNumber: parsed.policyNumber, policyMask: parsed.policyNumberMask,
    coverageType: parsed.coverageType, propertyId, insuredAddress: parsed.propertyAddress,
    premiumAmount: parsed.amountDue, billingFrequency: parsed.billingFrequency,
    periodStart: parsed.periodStart, periodEnd: parsed.periodEnd, nextDueDate: parsed.dueDate,
    carrierPhone: parsed.carrierPhone, carrierEmail: parsed.carrierEmail, carrierWebsite: parsed.carrierWebsite,
  });
  const res = await insurance.recordInsuranceStatement(query, io, userId, {
    policyId, documentId: fileId || null, parsed, carrier: parsed.carrier,
  });

  // Insured address read but it isn't one of the user's properties → ask (via the chatbot)
  // whether to add it, instead of silently leaving the policy unlinked. Best-effort.
  let propertyQuestion = null;
  if (!propertyId && parsed.propertyAddress) {
    try {
      const year = (parsed.dueDate || parsed.statementDate || '').slice(0, 4) || (d.year ? String(d.year) : null);
      propertyQuestion = await require('../banking/property-link').createPropertyQuestion(query, userId, {
        policyId, address: parsed.propertyAddress, carrier: parsed.carrier,
        coverageType: parsed.coverageType, fileId: fileId || null, year,
      });
    } catch (e) { console.log('[domain-hooks] property question failed:', e.message); }
  }
  return { recorded: true, policyId, propertyId, propertyQuestion, ...res, parsed };
}

// ── tax_form ───────────────────────────────────────────────────────────────────
// Cheap pre-gate so ordinary 1099s/W-2s don't burn a Groq call — only documents that
// look like they carry a payment schedule (or a refund) go to the extractor.
const TAX_SCHEDULE_GATE = /installment|estimated\s+tax|1040-?ES|540-?ES|property\s+tax|refund|balance\s+due|amount\s+you\s+owe/i;

async function recordTax({ userId, io, fileId, buffer, text }) {
  const body = await getText(text, buffer);
  if (!body || !TAX_SCHEDULE_GATE.test(body)) return { recorded: false, reason: 'no payment-schedule signals' };
  const { extractTaxSchedule } = require('../tax/schedule-extract');
  const { recordTaxSchedule } = require('../tax/schedule');
  const extracted = await extractTaxSchedule(body);
  if (!extracted) return { recorded: false, reason: 'extractor returned nothing' };
  const res = await recordTaxSchedule(query, io, userId, { documentId: fileId || null, extracted });
  return { recorded: true, ...res };
}

// ── disclosure (action letters) ────────────────────────────────────────────────
// Most disclosures are informational (privacy notices, fee schedules) — filed and done.
// But some are ACTION LETTERS (unclaimed-property/escheatment notices, address
// confirmations): those create a manual account carrying the letter's reported amount
// (flagged unconfirmed) and an action item the reminder engine nags on until "done".
async function recordDisclosureNotice({ userId, io, fileId, buffer, text }) {
  const { extractNotice, extractNoticeFromImage, ACTION_GATE } = require('../banking/notice-extract');
  const body = await getText(text, buffer);
  const imgMime = sniffImage(buffer);
  // Pre-gate on text when we have it; photographed letters can't be pre-gated cheaply —
  // extract and let isActionNotice decide.
  if (body && !ACTION_GATE.test(body)) return { recorded: false, reason: 'informational disclosure (no action signals)' };
  let n = null;
  if (body) n = await extractNotice(body);
  else if (imgMime) n = await extractNoticeFromImage(buffer, imgMime);
  if (!n || !n.isActionNotice) return { recorded: false, reason: 'no action required' };
  const { recordNotice } = require('../banking/notices');
  const res = recordNotice(io, userId, n, { fileId });
  return { recorded: !!(res.accountId || res.actionId), notice: n, ...res };
}

const REGISTRY = {
  insurance_statement: recordInsurance,
  tax_form: recordTax,
  disclosure: recordDisclosureNotice,
};

/**
 * Run the domain recorder for a freshly-filed document. Best-effort: never throws.
 * @param {object} io      per-user scoped { read, write } (from makeIO(userId))
 * @param {string} userId
 * @param {{ docType, fileId, buffer?, text?, decision? }} args
 * @returns {Promise<object|null>}  recorder result, or null (no recorder / failed)
 */
async function runDomainRecorder(io, userId, { docType, fileId, buffer, text, decision } = {}) {
  const fn = REGISTRY[docType];
  if (!fn) return null;
  try {
    return await fn({ userId, io, fileId, buffer, text, decision });
  } catch (e) {
    console.error(`[domain-hooks] ${docType} recorder failed:`, e.message);
    return null;
  }
}

module.exports = { runDomainRecorder };
