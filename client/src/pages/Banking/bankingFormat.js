// Shared formatting helpers + display constants for the Banking page.
// Imported by Banking.jsx and TransactionsTable.jsx (avoids a circular import).

export const fmt = (n, d=0) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(d)+'K'; return String(Math.abs(n).toFixed(d)) }
export const fd  = (n, d=0) => (n<0?'-$':'$')+fmt(Math.abs(n),d)
export const fmtFull = n => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

// ── Category colors ───────────────────────────────────────────────────────────
export const CAT_COLOR = {
  Dining:'var(--coral)',Shopping:'var(--amber)',Transport:'var(--blue)',Travel:'var(--blue)',
  Groceries:'var(--green)',Entertainment:'var(--purple)',Fitness:'var(--teal)',
  Health:'var(--teal)',Subscriptions:'var(--purple)',Coffee:'var(--amber)',
  Tech:'var(--blue)',Utilities:'var(--text-secondary)',Income:'var(--green)',
  Transfer:'var(--text-secondary)',Other:'var(--text-muted)',
}

// ── Chart of Accounts types (mirrors Accounting.jsx) ──────────────────────────
// The "Account Type" — the QuickBooks-style top-level classification of a GL
// account. Determines which financial statement it lands on (Balance Sheet vs P&L).
export const TYPE_ORDER  = ['asset','liability','equity','income','expense']
export const TYPE_LABELS = { asset:'Assets', liability:'Liabilities', equity:'Equity', income:'Income', expense:'Expenses' }
export const TYPE_COLORS = { asset:'var(--blue)', liability:'var(--coral)', equity:'var(--teal)', income:'var(--green)', expense:'var(--amber)' }
