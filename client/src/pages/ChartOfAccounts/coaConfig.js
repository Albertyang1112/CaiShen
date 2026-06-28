// coaConfig.js — vocabulary + formatting for the (simplified) Chart of Accounts.
//
// This is the everyday version of the page: a plain list of money categories with a
// number next to each. No account codes, debits/credits, reconciliation, or tax-line
// mapping — those lived in the old QuickBooks-style page and were removed. Keep this
// file data-only (no React) so the page and a future mapper can both import it.

// The five money types, in the order the tree shows them. Each carries a `basis`:
//   activity → the number is a total over the chosen period ("this year")
//   balance  → the number is what's in it right now ("current balance")
export const TYPE_META = {
  income:    { label: 'Income',      icon: 'ti-arrow-down-left', color: 'var(--green)', basis: 'activity' },
  expense:   { label: 'Expenses',    icon: 'ti-arrow-up-right',  color: 'var(--coral)', basis: 'activity' },
  asset:     { label: 'Assets',      icon: 'ti-building-bank',   color: 'var(--blue)',  basis: 'balance'  },
  liability: { label: 'Liabilities', icon: 'ti-credit-card',     color: 'var(--pink)',  basis: 'balance'  },
  equity:    { label: 'Net worth',   icon: 'ti-pig-money',       color: 'var(--teal)',  basis: 'balance'  },
}
export const SECTION_ORDER = ['income', 'expense', 'asset', 'liability', 'equity']

// The two bands the tree is split into, by basis. Used for the divider rows.
export const BAND = {
  activity: { label: 'Money in & out' },
  balance:  { label: 'What you own & owe' },
}
export const basisOf = (type) => TYPE_META[type]?.basis || 'activity'

// ── Period presets (drive the date picker + the /pl date range) ─────────────
// Pure date math; `today` is injected so the helper stays testable.
export const PERIODS = [
  { key: 'ytd',        label: 'This year'       },
  { key: '12m',        label: 'Last 12 months'  },
  { key: 'last_month', label: 'Last month'      },
  { key: 'all',        label: 'All time'        },
]
const iso = (d) => d.toISOString().split('T')[0]
export function periodRange(key, today = new Date()) {
  const end = iso(today)
  if (key === '12m') {
    const s = new Date(today); s.setFullYear(s.getFullYear() - 1)
    return { start: iso(s), end }
  }
  if (key === 'last_month') {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const last  = new Date(today.getFullYear(), today.getMonth(), 0)
    return { start: iso(first), end: iso(last) }
  }
  if (key === 'all') return { start: '1970-01-01', end }
  // ytd (default)
  return { start: `${today.getFullYear()}-01-01`, end }
}
export const periodLabel = (key) => PERIODS.find(p => p.key === key)?.label || 'This year'

// ── Money + date formatting ─────────────────────────────────────────────────
export const fd = (n) => {
  const v = Number(n) || 0
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// Compact money for tight spots: $1.2k, $980, -$3.4k.
export const fdShort = (n) => {
  const v = Number(n) || 0
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`
  return `${sign}$${abs.toFixed(0)}`
}
export const fmtDate = (d) => {
  if (!d) return '—'
  const dt = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d)
  return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
