// States.jsx — shared loading / empty placeholders for the Chart of Accounts.

export function LoadingState({ label = 'Loading accounts…' }) {
  return (
    <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      <i className="ti ti-loader-2 spin" style={{ fontSize: 22, display: 'block', marginBottom: 10 }} aria-hidden="true" />
      {label}
    </div>
  )
}

export function EmptyState({ title = 'No accounts match', hint, icon = 'ti-search-off', action }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--text-muted)' }}>
      <i className={`ti ${icon}`} style={{ fontSize: 34, display: 'block', marginBottom: 12, color: 'var(--text-secondary)' }} aria-hidden="true" />
      <p style={{ margin: 0, fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</p>
      {hint && <p style={{ margin: '6px 0 0', fontSize: 12.5 }}>{hint}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}
