'use strict';
/**
 * core/loan-match.js — entity resolution between a LIVE mortgage (mortgage_accounts row,
 * statement/Plaid-derived, linked to a property) and its BOOK representation (an imported
 * chart-of-accounts liability leaf like "Mortgages:Kobe Mortgage").
 *
 * Policy (Albert, July 2026): imported data must reconcile against everything already in
 * the app — the same physical loan is ONE entity: one balance-sheet row, live balance
 * preferred, book-vs-servicer drift surfaced, never double-counted.
 *
 * Matching is by property: the QB leaf name carries the property's short name ("Kobe
 * Mortgage"), the property record carries the address ("8962 Kobe Pl"). We match when any
 * significant word (or adjacent-word join, so "Bay Hill" ↔ "Bayhill") from the property
 * name appears in the leaf name. Loan masks can't help — book names carry no numbers.
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Street/geo words that would create meaningless matches.
const STOP = new Set([
  'mortgage', 'loan', 'the', 'ave', 'avenue', 'blvd', 'boulevard', 'court', 'ct', 'dr',
  'drive', 'lane', 'ln', 'pl', 'place', 'rd', 'road', 'st', 'street', 'way', 'apt', 'unit',
]);

/** Significant match keys for a property name/address (words + adjacent joins, ≥4 chars). */
function propertyKeys(name) {
  const words = String(name || '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w))
    .map(w => w.toLowerCase())
    .filter(w => !STOP.has(w));
  const keys = new Set(words);
  for (let i = 0; i < words.length - 1; i++) keys.add(words[i] + words[i + 1]);
  return [...keys].filter(k => k.length >= 4);
}

/** The mortgage-ish liability leaf in `coa` that names this property, or null. */
function findMortgageLeaf(coa, propertyName) {
  const keys = propertyKeys(propertyName);
  if (!keys.length) return null;
  const candidates = (coa || []).filter(n => n && n.type === 'liability' && /mortgage/i.test(n.name || ''));
  for (const n of candidates) {
    const ln = norm(n.name);
    if (keys.some(k => ln.includes(k))) return n;
  }
  return null;
}

/**
 * Resolve every linked mortgage for a user against the chart.
 * Returns Map(coaLeafId → { accountId, propertyName, live }) — best-effort (empty on any
 * DB unavailability, e.g. dry-run scripts without env).
 */
async function linkedMortgageLeaves(userId, { chart, properties, accounts }) {
  const out = new Map();
  try {
    const { query } = require('./db');
    const m = await query(
      `SELECT account_id, property_id, current_principal FROM mortgage_accounts WHERE user_id = $1`,
      [userId]
    );
    for (const row of m.rows || []) {
      const prop = (properties || []).find(p => p.id === row.property_id);
      if (!prop) continue;
      const leaf = findMortgageLeaf(chart, prop.name);
      if (!leaf) continue;
      const acct = (accounts || []).find(a => a.id === row.account_id);
      const live = acct?.balance ?? (row.current_principal != null ? Number(row.current_principal) : null);
      out.set(leaf.id, { accountId: row.account_id || null, propertyName: prop.name, live });
    }
  } catch (e) { /* no DB (dry-run script) or no mortgage domain yet — merge simply skips */ }
  return out;
}

module.exports = { findMortgageLeaf, propertyKeys, linkedMortgageLeaves };
