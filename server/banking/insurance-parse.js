'use strict';
/**
 * banking/insurance-parse.js — best-effort extractor for insurance billing-statement TEXT.
 *
 * parseInsuranceStatement(text) → {
 *   carrier, policyNumber, policyNumberMask, coverageType,
 *   statementDate, dueDate, amountDue, periodStart, periodEnd,
 *   propertyAddress, carrierPhone, carrierEmail, carrierWebsite,
 *   billingFrequency, confidence (0..1), parserStatus ('parsed'|'partial'|'failed')
 * }
 *
 * PURE (text → object) like mortgage-parse.js, whose label-gap/column helpers it reuses.
 * Carrier statements vary wildly (Farmers, State Farm, GeoVera, CEA, Mercury, …) so this is
 * label-driven and heuristic; the recorder falls back to Groq (insurance-ai.js) when
 * confidence is low or the money/date fields come back null. Never throws.
 */

const { grabMoney, grabDate, grabByColumn, normDate } = require('./mortgage-parse');

// ── Coverage type: keyword sweep, most-specific first (an earthquake policy mentions the
// dwelling too, so specific perils outrank the generic homeowner words).
const COVERAGE_TYPES = [
  ['earthquake',  /\bearthquake\b/i],
  ['flood',       /\bflood\b/i],
  ['umbrella',    /\bumbrella\b/i],
  ['auto',        /\b(?:auto(?:mobile)?|vehicle)\s+(?:insurance|policy|coverage)\b/i],
  ['landlord',    /\b(?:landlord|rental\s+dwelling|dwelling\s+fire)\b/i],
  ['renters',     /\brenters?\s+(?:insurance|policy)\b/i],
  ['condo',       /\bcondo(?:minium)?\s+(?:insurance|policy|unit)\b/i],
  ['life',        /\blife\s+insurance\b/i],
  ['homeowners',  /\bhome\s*owner'?s?\b/i],
];
function grabCoverageType(text) {
  for (const [type, re] of COVERAGE_TYPES) if (re.test(text)) return type;
  return null;
}

// ── Carrier name: "X Insurance (Company|Group|Exchange|…)" wording, or an explicit
// underwriter line. Take the shortest plausible hit — long matches usually swallowed a
// sentence. Strips leading boilerplate words that ride along ("Thank you for choosing …").
const CARRIER_STOP = /^(?:the|your|from|by|of|for|with|to|dear|thank(?:s| you)?(?: for)?(?: choosing)?|this|a|an)\s+/i;
function grabCarrier(text) {
  const hits = [];
  const NAME = "([A-Z][A-Za-z&.'’-]*(?:\\s+[A-Z&][A-Za-z&.'’-]*){0,4})";
  // All-caps variant for letterhead lines ("FARMERS INSURANCE", "GEOVERA INSURANCE COMPANY").
  const CAPS = "([A-Z][A-Z&.'’-]*(?:\\s+[A-Z&][A-Z&.'’-]*){0,4})";
  const res = [
    new RegExp(NAME + '\\s+Insurance(?:\\s+(?:Company|Group|Exchange|Agency|Services))?', 'g'),
    new RegExp(CAPS + '\\s+INSURANCE(?:\\s+(?:COMPANY|GROUP|EXCHANGE|AGENCY|SERVICES))?', 'g'),
    new RegExp('(?:Underwritten|Issued|Administered)\\s+by[:\\s]+' + NAME, 'gi'),
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let name = m[1].trim();
      for (let prev = null; prev !== name;) { prev = name; name = name.replace(CARRIER_STOP, ''); }
      if (name && name.length >= 3 && !/^(?:Insurance|Policy|Premium|Statement)$/i.test(name)) hits.push(name);
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.length - b.length);
  return hits[0];
}

// ── Policy number: alphanumeric with optional dashes/spaces (carriers love "92-BH-1234-5").
function grabPolicyNumber(text) {
  const VALUE = '([A-Z0-9][A-Z0-9 -]{4,24}[A-Z0-9])';
  for (const l of ['Policy\\s*(?:Number|No\\.?|#)', 'Policy[:\\s]']) {
    const m = text.match(new RegExp(l + ':?[^\\S\\n]{0,80}' + VALUE, 'i'));
    if (m) {
      const v = m[1].replace(/\s{2,}.*$/, '').trim();          // stop at a column gap
      if (/\d/.test(v) && !/^(?:NUMBER|PERIOD|HOLDER)/i.test(v)) return v;
    }
  }
  // Column-aware fallback (label above, value below in the same visual column). Policy
  // numbers carry dashes/letters, so grabByColumn's digits-only 'loan' kind can't be reused.
  const lines = String(text).split(/\r?\n/);
  const labelRe = /POLICY\s+(?:NUMBER|NO\.?)/i;
  for (let i = 0; i < lines.length; i++) {
    const lm = labelRe.exec(lines[i]);
    if (!lm) continue;
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      const re = new RegExp(VALUE, 'g');
      let m;
      while ((m = re.exec(lines[j])) !== null) {
        if (Math.abs(m.index - lm.index) > 20) continue;
        const v = m[1].replace(/\s{2,}.*$/, '').trim();
        if (/\d/.test(v)) return v;
      }
    }
  }
  return null;
}

// ── Policy period: two dates joined by to/through/–.
function grabPolicyPeriod(text) {
  const D = '((?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}))';
  const m = text.match(new RegExp(
    '(?:Policy|Coverage)\\s*(?:Period|Term|Dates?)|Effective(?:\\s*Dates?)?', 'i'));
  if (!m) return { periodStart: null, periodEnd: null };
  const tail = text.slice(m.index, m.index + 160);
  const pm = tail.match(new RegExp(D + '\\s*(?:to|through|thru|[-–—])\\s*' + D, 'i'));
  if (pm) return { periodStart: normDate(pm[1]), periodEnd: normDate(pm[2]) };
  const single = tail.match(new RegExp(D));
  return { periodStart: single ? normDate(single[1]) : null, periodEnd: null };
}

// ── Contact info ────────────────────────────────────────────────────────────────
const PHONE = /(?:1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g;
function grabPhone(text) {
  // Prefer a number near customer-service wording; else the first 8xx number; else any.
  const ctx = text.match(new RegExp('(?:customer\\s+service|questions|contact\\s+us|call(?:\\s+us)?|billing)[^\\n]{0,80}?(' + PHONE.source + ')', 'i'));
  if (ctx) return ctx[1].trim();
  const all = text.match(PHONE) || [];
  return all.find(p => /8\d{2}/.test(p.replace(/\D/g, '').slice(-10, -7))) || all[0] || null;
}
function grabEmail(text) {
  const m = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  return m ? m[0] : null;
}
function grabWebsite(text) {
  const m = text.match(/\b(?:https?:\/\/)?(?:www\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\/[^\s,)]*)?/i);
  return m ? m[0].replace(/[.,;]$/, '') : null;
}

// ── Insured property address: same-line grab, then column fallback. Returns street or null.
function grabInsuredAddress(text) {
  const LABELS = ['Insured\\s+Location', 'Location\\s+of\\s+(?:Premises|Property)', 'Property\\s+Address',
                  'Risk\\s+Address', 'Insured\\s+Property', 'Dwelling\\s+Location', 'Location\\s+Address'];
  const STREET = '(\\d{1,6}\\s+[A-Za-z0-9][A-Za-z0-9 .\'’-]{2,50})';
  for (const l of LABELS) {
    const m = text.match(new RegExp(l + ':?[^\\S\\n]{0,80}' + STREET, 'i'));
    if (m) return m[1].replace(/\s{2,}.*$/, '').trim();
  }
  // Column fallback: street on a following line under the label.
  const lines = String(text).split(/\r?\n/);
  for (const l of LABELS) {
    const labelRe = new RegExp(l, 'i');
    for (let i = 0; i < lines.length; i++) {
      const lm = labelRe.exec(lines[i]);
      if (!lm) continue;
      for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
        const sm = new RegExp(STREET).exec(lines[j]);
        if (sm && Math.abs(sm.index - lm.index) <= 20) return sm[1].replace(/\s{2,}.*$/, '').trim();
      }
    }
  }
  return null;
}

// ── Billing frequency: explicit wording first, else inferred from the policy period span.
function grabBillingFrequency(text, periodStart, periodEnd) {
  if (/\bmonthly\s+(?:premium|payment|installment)|\bpaid?\s+monthly\b/i.test(text)) return 'monthly';
  if (/\bquarterly\b/i.test(text)) return 'quarterly';
  if (/\bsemi-?annual/i.test(text)) return 'semiannual';
  if (/\bannual\s+(?:premium|payment)|\bpaid?\s+annually\b|\b12[-\s]month\s+(?:policy|term)\b/i.test(text)) return 'annual';
  if (periodStart && periodEnd) {
    const days = (new Date(periodEnd) - new Date(periodStart)) / 86400000;
    if (days > 300) return 'annual';
    if (days > 150) return 'semiannual';
    if (days > 60)  return 'quarterly';
    if (days > 20)  return 'monthly';
  }
  return null;
}

function parseInsuranceStatement(text) {
  text = String(text || '');
  const { periodStart, periodEnd } = grabPolicyPeriod(text);
  const out = {
    carrier:       grabCarrier(text),
    policyNumber:  grabPolicyNumber(text),
    coverageType:  grabCoverageType(text),
    statementDate: grabDate(text, ['Statement\\s*Date', 'Bill(?:ing)?\\s*Date', 'Invoice\\s*Date', 'Date\\s*(?:Prepared|Issued)']),
    dueDate:       grabDate(text, ['Payment\\s*Due\\s*Date', 'Due\\s*Date', 'Pay\\s*By', 'Due\\s*By', 'Payment\\s*Due']),
    amountDue:     grabMoney(text, ['Total\\s*Amount\\s*Due', 'Amount\\s*(?:Now\\s*)?Due', 'Premium\\s*Due', 'Total\\s*Premium',
                                    'Total\\s*Due', 'Minimum\\s*(?:Amount\\s*)?Due', 'Balance\\s*Due', 'Payment\\s*Amount', 'Amount\\s*Enclosed']),
    periodStart, periodEnd,
    propertyAddress: grabInsuredAddress(text),
    carrierPhone:  grabPhone(text),
    carrierEmail:  grabEmail(text),
    carrierWebsite: grabWebsite(text),
  };
  // Column-aware second chance for the fields that decide usability.
  if (out.dueDate == null)   out.dueDate   = grabByColumn(text, ['(?:PAYMENT\\s+)?DUE\\s+DATE', 'PAY\\s+BY'], 'date');
  if (out.amountDue == null) out.amountDue = grabByColumn(text, ['(?:TOTAL\\s+)?AMOUNT\\s+DUE', 'TOTAL\\s+PREMIUM', 'PREMIUM\\s+DUE'], 'money');
  out.policyNumberMask = out.policyNumber ? out.policyNumber.replace(/[^A-Z0-9]/gi, '').slice(-4) : null;
  out.billingFrequency = grabBillingFrequency(text, out.periodStart, out.periodEnd);

  // Confidence = fraction of the four CORE fields found (what makes a bill actionable).
  const core = [out.carrier, out.policyNumber, out.amountDue, out.dueDate];
  out.confidence = Number((core.filter(v => v != null).length / core.length).toFixed(4));
  out.parserStatus = out.confidence >= 0.75 ? 'parsed' : out.confidence > 0 ? 'partial' : 'failed';
  return out;
}

module.exports = { parseInsuranceStatement, grabCarrier, grabPolicyNumber, grabCoverageType,
                   grabInsuredAddress, grabBillingFrequency };
