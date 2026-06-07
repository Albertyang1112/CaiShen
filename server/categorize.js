// Rule-based auto-categorization. Assigns a Chart-of-Accounts account (coaId) to
// a transaction by matching its description / vendor / Plaid category against the
// user's saved rules. Pure + dependency-free: reused by the on-demand
// "Auto-categorize" endpoint and applied automatically after each Plaid sync.
//
// Rule: { id, field, op, value, coaId, enabled }
//   field: 'desc' (default) | 'vendor' | 'plaidCategory'
//   op:    'contains' (default) | 'equals' | 'startsWith'   (all case-insensitive)

function ruleMatches(tx, rule) {
  if (!rule || rule.enabled === false || !rule.coaId) return false;
  const needle = String(rule.value || '').trim().toLowerCase();
  if (!needle) return false;
  const hay = String((tx && tx[rule.field || 'desc']) || '').toLowerCase();
  if (!hay) return false;
  switch (rule.op) {
    case 'equals':     return hay === needle;
    case 'startsWith': return hay.startsWith(needle);
    default:           return hay.includes(needle);
  }
}

// Assign coaId using the first matching rule. By default only fills *uncategorized*
// transactions (never overwrites a manual coaId) and skips excluded ones.
// Returns { transactions, count, byRule }.
function applyRules(transactions, rules, { overwrite = false } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  let count = 0;
  const byRule = {};
  const out = (transactions || []).map(tx => {
    if (tx.excluded) return tx;                 // never touch excluded txns
    if (!overwrite && tx.coaId) return tx;      // keep the user's manual choice
    const rule = list.find(r => ruleMatches(tx, r));
    if (!rule || tx.coaId === rule.coaId) return tx;
    count++;
    byRule[rule.id] = (byRule[rule.id] || 0) + 1;
    return { ...tx, coaId: rule.coaId };
  });
  return { transactions: out, count, byRule };
}

// Best-effort merchant keyword from a noisy bank description, to pre-fill a
// "remember this" rule. e.g. "SHELL OIL 57444103 LOS ANGELES CA" -> "SHELL OIL".
// The user edits the suggestion before saving, so heuristics need only be close.
function suggestKeyword(desc) {
  const raw = String(desc || '').trim();
  if (!raw) return '';
  const s = raw
    .replace(/^(sq|tst|pp|paypal|sp|gumrd)\s*\*+/i, '') // strip processor prefixes (Square/Toast/PayPal)
    .replace(/[*#].*$/, ' ')                            // drop store/ref numbers after * or #
    .replace(/\b\d[\d-]*\b/g, ' ')                      // drop standalone number runs
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+[A-Za-z]{2}$/, '')                     // drop a trailing state code
    .trim();
  const words = s.split(' ').filter(Boolean);
  return (words.slice(0, 2).join(' ') || raw).toUpperCase();
}

module.exports = { ruleMatches, applyRules, suggestKeyword };
