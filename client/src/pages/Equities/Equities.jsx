import { useMemo } from 'react'
import { isEquityAccount } from '../Banking/Banking'

// ── Equities / investment accounts ────────────────────────────────────────────
// Read-only list of every equity-class account (Plaid-connected brokerages + manual
// accounts created from notices/letters). Manual notice-created accounts carry an
// UNCONFIRMED flag — the balance came from a letter, not from holdings data — and show
// a warning chip until a real connection confirms them.

const fd = n => { const v = Number(n); return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
const fdate = d => { if (!d) return '—'; const s = String(d); return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }

export default function Equities({ accounts = [] }) {
  const equities = useMemo(() => accounts.filter(isEquityAccount), [accounts])
  const confirmedTotal = equities.filter(a => !a.unconfirmed).reduce((s, a) => s + Math.max(Number(a.availableBalance ?? a.balance ?? 0), 0), 0)
  const unconfirmedTotal = equities.filter(a => a.unconfirmed).reduce((s, a) => s + Math.max(Number(a.balance ?? 0), 0), 0)

  if (!equities.length) return (
    <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center' }}>
      <i className="ti ti-chart-line" style={{ fontSize: 44, color: 'var(--text-muted)' }} aria-hidden="true" />
      <p style={{ fontSize: 16, fontWeight: 600, margin: '14px 0 6px' }}>No investment accounts yet</p>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Brokerage accounts appear here when connected via Plaid — or automatically when a
        letter naming one lands in the Data Vault or the chatbot.
      </p>
    </div>
  )

  return (
    <div style={{ maxWidth: 900 }}>
      {/* ── Totals ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
        {[['Total value', fd(confirmedTotal + unconfirmedTotal), null],
          ['Confirmed', fd(confirmedTotal), null],
          ['Unconfirmed', fd(unconfirmedTotal), unconfirmedTotal > 0 ? 'reported by letters — not verified holdings' : null]].map(([l, v, sub]) => (
          <div key={l} className="metric-card">
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{l}</p>
            <p style={{ fontSize: 22, fontWeight: 600, margin: 0, color: l === 'Unconfirmed' && unconfirmedTotal > 0 ? 'var(--amber)' : undefined }}>{v}</p>
            {sub && <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '4px 0 0' }}>{sub}</p>}
          </div>
        ))}
      </div>

      {/* ── Accounts ── */}
      <div className="card">
        <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Investment accounts</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {equities.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
              borderRadius: 'var(--radius-sm)', background: 'var(--bg-secondary)',
              border: a.unconfirmed ? '1px solid var(--amber)' : '1px solid transparent' }}>
              <i className={`ti ${a.unconfirmed ? 'ti-alert-triangle' : 'ti-building-bank'}`}
                style={{ fontSize: 17, color: a.unconfirmed ? 'var(--amber)' : 'var(--text-secondary)', flexShrink: 0 }} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                  {a.name || a.institution || 'Account'}
                  <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
                    {a.institution}{a.last4 ? ` ••${a.last4}` : ''}{a.source === 'manual' ? ' · from a mailed notice' : ''}
                  </span>
                </p>
                {a.unconfirmed && (
                  <p style={{ fontSize: 11.5, color: 'var(--amber)', margin: '3px 0 0' }}>
                    ⚠ Unconfirmed amount — {a.unconfirmedNote || 'reported by a letter, actual holdings unknown.'}
                  </p>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 600, margin: 0, color: a.unconfirmed ? 'var(--amber)' : undefined }}>
                  {fd(a.availableBalance ?? a.balance ?? 0)}
                </p>
                <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                  {a.unconfirmed ? 'unconfirmed' : `as of ${fdate(a.lastUpdated)}`}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
