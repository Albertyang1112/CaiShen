'use strict';
/**
 * tax/schedule-extract.js — Groq extraction of a PAYMENT SCHEDULE from tax-document text.
 *
 * Property-tax bills (1st/2nd installments), estimated-tax voucher packets (1040-ES /
 * 540-ES quarterlies), balance-due notices, and refunds (a filed return or notice showing
 * an overpayment). Tax layouts vary too much for a deterministic Tier-1 parser, so this is
 * Groq-only — but callers pre-gate on cheap keywords (see vault/domain-hooks.js) so
 * ordinary 1099s/W-2s never burn a call. All traffic through the shared rate gateway.
 */
const { groqChat } = require('../vault/groq-client');

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const SYSTEM = `You extract the PAYMENT SCHEDULE from the TEXT of a tax document.
Respond with ONLY JSON, no prose:
{"docKind":"property_tax_bill"|"estimated_tax_voucher"|"tax_return"|"refund_notice"|"balance_due_notice"|"other",
 "authority":string|null,        // who is owed/paying: "IRS", "FTB", "Los Angeles County Tax Collector", …
 "taxYear":number|null,          // the tax year the document is for
 "propertyAddress":string|null,  // for property-tax bills: the taxed property's address
 "installments":[{"label":string,"dueDate":"YYYY-MM-DD","amount":number}],
 "refund":{"expected":boolean,"amount":number|null}|null}
Rules:
- Property-tax bills list installments with distinct due dates (e.g. "1st installment due Dec 10", "2nd installment due Apr 10") — return EACH as its own entry with its own amount.
- Estimated-tax packets (1040-ES / 540-ES) contain four quarterly vouchers — return each voucher with its statutory due date and printed amount.
- A filed return or notice showing an OVERPAYMENT / amount to be refunded → refund.expected=true with the amount, installments=[].
- A balance-due notice or a return with an amount owed → one installment labeled "Balance due" with the payment deadline.
- Amounts in dollars (numbers). Dates YYYY-MM-DD. Use null / [] when not clearly present. Never invent values.`;

function tolerantJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = String(s || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const toNum  = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v
  : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ''))) ? Number(v.replace(/[$,]/g, '')) : null);

/** Extract + normalize. Returns { docKind, authority, taxYear, propertyAddress, installments[], refund } or null. */
async function extractTaxSchedule(text) {
  if (!process.env.GROQ_API_KEY) return null;
  const res = await groqChat({
    model: MODEL, temperature: 0, max_tokens: 700,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: String(text || '').slice(0, 12000) },
    ],
  }, { timeout: 45000 });
  const j = tolerantJson(res?.data?.choices?.[0]?.message?.content);
  if (!j) return null;

  const installments = (Array.isArray(j.installments) ? j.installments : [])
    .map(i => ({
      label: (typeof i?.label === 'string' && i.label.trim()) ? i.label.trim().slice(0, 80) : 'Payment',
      dueDate: isDate(i?.dueDate) ? i.dueDate : null,
      amount: toNum(i?.amount),
    }))
    .filter(i => i.dueDate || i.amount != null);

  const refund = (j.refund && j.refund.expected === true)
    ? { expected: true, amount: toNum(j.refund.amount) }
    : null;

  if (!installments.length && !refund) return null;
  return {
    docKind: typeof j.docKind === 'string' ? j.docKind : 'other',
    authority: (typeof j.authority === 'string' && j.authority.trim()) ? j.authority.trim().slice(0, 80) : null,
    taxYear: Number.isFinite(Number(j.taxYear)) && Number(j.taxYear) > 1990 ? Number(j.taxYear) : null,
    propertyAddress: (typeof j.propertyAddress === 'string' && j.propertyAddress.trim()) ? j.propertyAddress.trim() : null,
    installments, refund,
  };
}

module.exports = { extractTaxSchedule };
