'use strict';
/**
 * banking/vendor-learn.js — the "From/To" (vendor / counterparty) learning brain.
 *
 * Mirrors the categorization model: the user labels who a transaction was paid to /
 * received from; we remember the pattern and auto-fill matching transactions (past and
 * future). Pure + dependency-light (only the merchant-keyword heuristic) so it unit-tests
 * the same way as banking/plaid.js's stageAndImport.
 *
 * On a transaction:
 *   • vendor        — the From/To string shown in the Banking table + used as the primary
 *                     name in the Report drill-down (server/accounting cleanMerchant()).
 *   • vendorAuto    — true  => filled by memory/Groq (overwritable, shows an "auto" chip)
 *                     false => the user set it by hand (incl. a deliberate blank); NEVER
 *                              auto-touched.
 *
 * Memory shape (per-user vendor_memory.json): { [merchantKey]: { vendor, source, updatedAt } }
 *   source: 'user' (typed/confirmed) | 'auto'/'groq' (machine-proposed; never clobbers 'user').
 */
const { suggestKeyword } = require('./categorize');

// Normalized merchant key from a noisy bank description — reuse the categorizer's heuristic
// so "Audible*8D5QA2TN3 Amzn.com/billNJ" and "Audible*JR9AF56Z3 Amzn.com/billNJ" collapse
// to the same key ("AUDIBLE").
const vendorKey = (desc) => suggestKeyword(desc);

// A vendor the user set by hand — auto-fill must never overwrite it.
const isManual = (t) => t && t.vendorAuto === false;

// Apply learned memory to a transaction list (deterministic, no network). Fills a blank
// (non-manual) vendor or refreshes a previously auto-filled one; never touches a manual
// value or a non-auto vendor that's already present. Returns { transactions, count }.
function applyLearnedVendors(transactions, memory) {
  const mem = memory || {};
  let count = 0;
  const out = (transactions || []).map(t => {
    const fillable = (!t.vendor && t.vendorAuto !== false) || t.vendorAuto === true;
    if (!fillable) return t;
    const key = vendorKey(t.desc);
    const m = key && mem[key];
    if (!m || !m.vendor) return t;
    if (t.vendor === m.vendor && t.vendorAuto === true) return t;   // already current
    count++;
    return { ...t, vendor: m.vendor, vendorAuto: true };
  });
  return { transactions: out, count };
}

// The user sets (or clears) the From/To on one transaction: record/forget the pattern,
// mark that transaction as a manual value, and propagate to matching auto/blank rows so
// labeling a merchant once updates every occurrence. Returns { transactions, memory, updated }.
function setVendorAndLearn(transactions, targetId, rawVendor, memory, { now = new Date().toISOString() } = {}) {
  const list = Array.isArray(transactions) ? transactions : [];
  const mem = { ...(memory || {}) };
  const target = list.find(t => t.id === targetId);
  const vendor = String(rawVendor == null ? '' : rawVendor).trim();
  const key = target ? vendorKey(target.desc) : '';

  if (key) {
    if (vendor) mem[key] = { vendor, source: 'user', updatedAt: now };
    else delete mem[key];                       // user cleared it → forget the pattern
  }

  let updated = 0;
  const out = list.map(t => {
    if (t.id === targetId) { updated++; return { ...t, vendor, vendorAuto: false }; }  // manual (incl. blank)
    if (isManual(t)) return t;                  // never touch another hand-set value
    if (!key || vendorKey(t.desc) !== key) return t;
    if (vendor) {                               // propagate the new label to this merchant's rows
      if (t.vendor === vendor && t.vendorAuto === true) return t;
      updated++;
      return { ...t, vendor, vendorAuto: true };
    }
    if (t.vendor) {                             // user cleared the label → clear auto copies too
      updated++;
      const { vendor: _v, vendorAuto: _a, ...rest } = t;
      return rest;
    }
    return t;
  });
  return { transactions: out, memory: mem, updated };
}

// Fold a batch of machine-proposed (key → vendor) names (e.g. from Groq) into memory,
// without ever clobbering something the user taught. Returns the new memory object.
function learnAuto(memory, entries, { now = new Date().toISOString(), source = 'auto' } = {}) {
  const mem = { ...(memory || {}) };
  for (const e of entries || []) {
    const key = e && e.key, vendor = e && e.vendor;
    if (!key || !vendor) continue;
    if (mem[key] && mem[key].source === 'user') continue;   // user label is authoritative
    mem[key] = { vendor, source, updatedAt: now };
  }
  return mem;
}

module.exports = { vendorKey, isManual, applyLearnedVendors, setVendorAndLearn, learnAuto };
