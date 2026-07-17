'use strict';
/**
 * banking/insurance-ai.js — Groq fallback for insurance bills the deterministic parser
 * (insurance-parse.js) can't read confidently. Called only when parse confidence < 0.6 or
 * the actionable fields (dueDate / amountDue) came back null; deterministic values win on
 * merge. All traffic goes through the shared rate-limit gateway (vault/groq-client.js).
 */
const { groqChat } = require('../vault/groq-client');

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const SYSTEM = `You extract fields from the TEXT of an insurance billing statement (any carrier, any coverage type).
Respond with ONLY JSON, no prose:
{"carrier":string|null,           // insurer name, e.g. "Farmers", "GeoVera" — brand only, no "Insurance Company" suffix
 "policyNumber":string|null,      // exactly as printed
 "coverageType":string|null,      // lowercase: homeowners|earthquake|flood|auto|umbrella|landlord|renters|condo|life|other
 "statementDate":string|null,     // YYYY-MM-DD
 "dueDate":string|null,           // YYYY-MM-DD — the payment due date
 "amountDue":number|null,         // dollars, e.g. 412.00 — the amount the customer must pay now
 "periodStart":string|null,"periodEnd":string|null,   // policy/coverage period, YYYY-MM-DD
 "propertyAddress":string|null,   // the INSURED property's street address (not the mailing or carrier address)
 "carrierPhone":string|null,"carrierEmail":string|null,"carrierWebsite":string|null,
 "carrierAddress":string|null,    // the insurer's own address IF distinctly printed (rare) — see address rules below
 "billingFrequency":"annual"|"semiannual"|"quarterly"|"monthly"|null}
Rules: use null when a field is not clearly present. Never invent values. Dates must be YYYY-MM-DD.
The insured property address is the LOCATION COVERED BY THE POLICY. It may be labeled ("Insured Location",
"Location of Property", "Property Address", "Risk Address", "Dwelling") — or UNLABELED: on many billing
statements (CEA/Foremost style) it is printed near the top of the page directly under the carrier or product
name, where it can look like the insurer's own address. Sort every address on the document into one of:
  (a) the customer's MAILING address — in the address window / payment coupon, next to the customer's name;
  (b) the AGENT's or broker's address — near "your agent" or an agency name;
  (c) a REMIT-TO / PO Box payment address;
  (d) anything else — this is almost certainly the INSURED PROPERTY. Return it as propertyAddress.
Never return (a), (b), or (c). If every address on the document is one of those, return null.
IMPORTANT: a street address printed directly under the carrier or product name at the TOP of a billing
statement is the INSURED PROPERTY, not the insurer's office (insurers don't print a street address there) —
return it as propertyAddress, never as carrierAddress.`;

function tolerantJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

const normDateish = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const normNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : null));
const normStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Groq field extraction over statement text. Returns a parse-shaped object or null. */
async function extractInsuranceFields(text) {
  if (!process.env.GROQ_API_KEY) return null;
  return runExtract([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: String(text || '').slice(0, 12000) },
  ], MODEL);
}

/** Vision variant for photographed bills (no text layer). Same JSON contract. */
async function extractInsuranceFieldsFromImage(buffer, mimeType = 'image/jpeg') {
  if (!process.env.GROQ_API_KEY || !buffer) return null;
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return runExtract([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [
      { type: 'text', text: 'Extract the insurance billing fields from this image.' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] },
  ], VISION_MODEL);
}

async function runExtract(messages, model) {
  const res = await groqChat({ model, temperature: 0, max_tokens: 500, messages }, { timeout: 45000 });
  const raw = res?.data?.choices?.[0]?.message?.content;
  const j = tolerantJson(raw);
  if (!j) return null;
  const out = {
    carrier: normStr(j.carrier),
    policyNumber: normStr(j.policyNumber),
    coverageType: normStr(j.coverageType) ? String(j.coverageType).toLowerCase() : null,
    statementDate: normDateish(j.statementDate),
    dueDate: normDateish(j.dueDate),
    amountDue: normNum(j.amountDue),
    periodStart: normDateish(j.periodStart),
    periodEnd: normDateish(j.periodEnd),
    propertyAddress: normStr(j.propertyAddress),
    carrierPhone: normStr(j.carrierPhone),
    carrierEmail: normStr(j.carrierEmail),
    carrierWebsite: normStr(j.carrierWebsite),
    carrierAddress: normStr(j.carrierAddress),
    billingFrequency: ['annual', 'semiannual', 'quarterly', 'monthly'].includes(j.billingFrequency) ? j.billingFrequency : null,
  };
  out.policyNumberMask = out.policyNumber ? out.policyNumber.replace(/[^A-Z0-9]/gi, '').slice(-4) : null;
  return out;
}

/** Merge a deterministic parse with an AI extraction — deterministic wins where non-null. */
function mergeParsed(parsed, ai) {
  if (!ai) return parsed;
  const out = { ...parsed };
  for (const k of Object.keys(ai)) if (out[k] == null && ai[k] != null) out[k] = ai[k];
  // Re-grade confidence on the merged result (same core fields as insurance-parse).
  const core = [out.carrier, out.policyNumber, out.amountDue, out.dueDate];
  out.confidence = Number((core.filter(v => v != null).length / core.length).toFixed(4));
  out.parserStatus = out.confidence >= 0.75 ? 'parsed' : out.confidence > 0 ? 'partial' : 'failed';
  return out;
}

module.exports = { extractInsuranceFields, extractInsuranceFieldsFromImage, mergeParsed };
