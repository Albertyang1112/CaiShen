import { useState, useEffect, useMemo } from 'react'
import axios from 'axios'
import { PdfModal } from '../../components/PdfPreview'

const API = '/api'

// ── Insurance page — carrier-portal style view over the insurance domain ──────────
// Read-only: policies, contact info, due dates, paid status, statement history, and
// upcoming tax payments. Data arrives via Data Vault / chatbot uploads and Plaid sync —
// nothing to click here. Paid (green) is derived from the premium payment being matched
// to a bank transaction; reminders run in the chatbot off the same fact.

const fd = n => { const v = Number(n); return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
const fdate = d => { if (!d) return '—'; const s = String(d); return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
const fmon = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'
const cap = s => s ? String(s).replace(/\b\w/g, c => c.toUpperCase()) : s
const daysUntil = d => d == null ? null : Math.ceil((new Date(String(d).slice(0, 10) + 'T12:00:00') - new Date()) / 86400000)

const FREQ_LABEL = { annual: 'billed yearly', semiannual: 'billed twice a year', quarterly: 'billed quarterly', monthly: 'billed monthly' }

const Card = ({ label, value, sub, subColor }) => (
  <div className="metric-card">
    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</p>
    <p style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{value}</p>
    {sub && <p style={{ fontSize: 11.5, color: subColor || 'var(--text-muted)', margin: '4px 0 0' }}>{sub}</p>}
  </div>
)

const Row = ({ l, v, href }) => v != null && v !== '' ? (
  <div className="row">
    <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
    {href
      ? <a href={href} style={{ fontWeight: 500, color: 'var(--blue)', textDecoration: 'none' }}>{v}</a>
      : <span style={{ fontWeight: 500 }}>{v}</span>}
  </div>
) : null

const ALERT_STYLE = {
  premium_changed:   { icon: 'ti-arrows-diff', color: 'var(--amber)', bg: 'var(--amber-light)' },
  premium_paid:      { icon: 'ti-circle-check', color: 'var(--green)', bg: 'var(--green-light)' },
  payment_unmatched: { icon: 'ti-link-off',    color: 'var(--coral)', bg: 'var(--coral-light)' },
}

// Compact form of an insured address for labels: strip a trailing "CA 92234"-style
// state+zip so "30645 Bay Hill Ct Cathedral City CA 92234" reads "30645 Bay Hill Ct Cathedral City".
const shortAddr = a => a ? String(a).replace(/[,\s]+[A-Z]{2}[,\s]+[\d-]{5,10}$/, '').trim() : null

// Human label for a policy: the linked property's name, else the INSURED address printed
// on the bill, else carrier + coverage. The dropdown must distinguish policies by the
// insured location, not just billing-account digits.
function policyLabel(pol, properties) {
  const prop = (properties || []).find(p => p.id === pol.property_id)
  const cov = pol.coverage_type ? cap(pol.coverage_type) : 'Insurance'
  const where = prop?.name || shortAddr(pol.insured_address)
  if (where) return `${where} — ${cov}`
  return `${pol.carrier || 'Policy'} ${cov}`
}

// Paid / due status pill for the current cycle.
function StatusPill({ pol }) {
  if (pol.paidCurrentCycle) return (
    <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 99, background: 'var(--green-light)', color: 'var(--green)', fontWeight: 600 }}>
      Paid ✓{pol.paidDate ? ` ${fdate(pol.paidDate)}` : ''}
    </span>
  )
  const days = daysUntil(pol.next_due_date)
  if (days == null) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>no due date yet</span>
  if (days < 0) return (
    <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 99, background: 'var(--coral-light)', color: 'var(--coral)', fontWeight: 600 }}>
      Overdue {Math.abs(days)}d
    </span>
  )
  if (days <= 30) return (
    <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 99, background: 'var(--amber-light)', color: 'var(--amber)', fontWeight: 600 }}>
      Due in {days}d
    </span>
  )
  return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>due {fdate(pol.next_due_date)}</span>
}

export default function Insurance() {
  const [policies, setPolicies] = useState(null)      // null = loading
  const [sel, setSel] = useState(null)
  const [stmts, setStmts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [properties, setProperties] = useState([])
  const [taxSched, setTaxSched] = useState([])
  const [preview, setPreview] = useState(null)
  const [showPolicyNo, setShowPolicyNo] = useState(false)

  useEffect(() => {
    axios.get(`${API}/insurance`).then(r => {
      const rows = Array.isArray(r.data) ? r.data : []
      setPolicies(rows)
      if (rows.length) setSel(rows[0].id)
    }).catch(() => setPolicies([]))
    axios.get(`${API}/insurance/alerts`).then(r => setAlerts(Array.isArray(r.data) ? r.data : [])).catch(() => {})
    axios.get(`${API}/properties`).then(r => setProperties(Array.isArray(r.data) ? r.data : [])).catch(() => {})
    axios.get(`${API}/tax-schedule`).then(r => setTaxSched(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sel) return
    setStmts([])
    setShowPolicyNo(false)
    axios.get(`${API}/insurance/${sel}/statements`).then(r => setStmts(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [sel])

  const pol = (policies || []).find(p => p.id === sel)
  const polAlerts = alerts.filter(a => !sel || a.insurancePolicyId === sel).slice(0, 4)

  // Upcoming tax payments (next 90 days or overdue) + expected refunds — shown because
  // this is the "payments due" surface; the chatbot nags on the same schedule.
  const upcomingTax = useMemo(() => taxSched.filter(t => {
    if (t.status === 'refund_expected') return true
    if (t.status !== 'unpaid') return false
    const days = daysUntil(t.due_date)
    return days != null && days <= 90
  }).slice(0, 6), [taxSched])

  if (policies === null) return <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>Loading insurance data…</div>

  if (!policies.length) return (
    <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center' }}>
      <i className="ti ti-shield-dollar" style={{ fontSize: 44, color: 'var(--text-muted)' }} aria-hidden="true" />
      <p style={{ fontSize: 16, fontWeight: 600, margin: '14px 0 6px' }}>No insurance policies yet</p>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Policies appear here automatically when an insurance bill lands in the Data Vault
        (drop the PDF in and run sort) or when you send one to the chatbot.
      </p>
      {upcomingTax.length > 0 && <TaxStrip items={upcomingTax} properties={properties} standalone />}
    </div>
  )

  const propName = pol && (properties.find(p => p.id === pol.property_id)?.name || null)
  const days = pol ? daysUntil(pol.next_due_date) : null

  return (
    <div style={{ maxWidth: 1060 }}>
      {/* ── Policy identity + selector ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          {pol && (
            <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 2px' }}>
              {policyLabel(pol, properties)}
              <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-secondary)', marginLeft: 8 }}>
                {pol.carrier || 'Carrier'} · policy {showPolicyNo && pol.policy_number ? pol.policy_number : `••••${pol.policy_number_mask || '????'}`}
                {pol.policy_number && (
                  <button onClick={() => setShowPolicyNo(v => !v)}
                    title={showPolicyNo ? 'Hide policy number' : 'Show full policy number'}
                    aria-label={showPolicyNo ? 'Hide policy number' : 'Show full policy number'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 0 0 6px', fontSize: 13, verticalAlign: 'middle' }}>
                    <i className={`ti ${showPolicyNo ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                  </button>
                )}
              </span>
            </p>
          )}
          {(propName || pol?.insured_address) && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 16px' }}>
            <i className="ti ti-map-pin" style={{ marginRight: 4 }} aria-hidden="true" />
            {propName ? `${propName} · ${pol.insured_address || ''}`.replace(/ · $/, '') : pol.insured_address}</p>}
        </div>
        {policies.length > 1 && (
          <select value={sel || ''} onChange={e => setSel(e.target.value)} aria-label="Select policy"
            style={{ fontSize: 12.5, padding: '6px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
            {policies.map(p => (
              <option key={p.id} value={p.id}>
                {policyLabel(p, properties)} — {(p.carrier || 'Policy')} ••••{p.policy_number_mask || '????'}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── Alerts ── */}
      {polAlerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {polAlerts.map(a => {
            const st = ALERT_STYLE[a.kind] || { icon: 'ti-bell', color: 'var(--text-secondary)', bg: 'var(--bg-secondary)' }
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: st.bg, border: `1px solid ${st.color}22` }}>
                <i className={`ti ${st.icon}`} style={{ color: st.color, fontSize: 15 }} aria-hidden="true" />
                <span style={{ fontSize: 12.5, color: 'var(--text-primary)', flex: 1 }}>{a.message}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fdate(a.createdAt)}</span>
              </div>
            )
          })}
        </div>
      )}

      {pol && <>
        {/* ── Hero metrics ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
          <Card label="Premium" value={pol.premium_amount != null ? fd(pol.premium_amount) : '—'}
            sub={FREQ_LABEL[pol.billing_frequency] || null} />
          <div className="metric-card">
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Next bill</p>
            <p style={{ fontSize: 22, fontWeight: 600, margin: '0 0 6px' }}>{pol.next_due_date ? fdate(pol.next_due_date) : '—'}</p>
            <StatusPill pol={pol} />
          </div>
          <Card label="Coverage" value={pol.coverage_type ? cap(pol.coverage_type) : '—'}
            sub={pol.period_start && pol.period_end ? `${fdate(pol.period_start)} – ${fdate(pol.period_end)}` : null} />
          <Card label="Carrier" value={pol.carrier || '—'}
            sub={pol.carrier_phone || null} />
        </div>

        {/* ── Contact + policy details ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16, alignItems: 'start' }}>
          <div className="card">
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 12px' }}>Carrier contact</p>
            <Row l="Phone" v={pol.carrier_phone} href={pol.carrier_phone ? `tel:${pol.carrier_phone.replace(/[^\d+]/g, '')}` : null} />
            <Row l="Email" v={pol.carrier_email} href={pol.carrier_email ? `mailto:${pol.carrier_email}` : null} />
            <Row l="Website" v={pol.carrier_website} href={pol.carrier_website ? (pol.carrier_website.startsWith('http') ? pol.carrier_website : `https://${pol.carrier_website}`) : null} />
            <Row l="Address" v={pol.carrier_address} />
            {!pol.carrier_phone && !pol.carrier_email && !pol.carrier_website &&
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                Contact info fills in automatically from the next statement that prints it.</p>}
          </div>
          <div className="card">
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 12px' }}>Policy details</p>
            <Row l="Carrier" v={pol.carrier} />
            <Row l="Policy number" v={showPolicyNo && pol.policy_number ? pol.policy_number : (pol.policy_number_mask ? `••••${pol.policy_number_mask}` : null)} />
            <Row l="Coverage type" v={pol.coverage_type ? cap(pol.coverage_type) : null} />
            <Row l="Insured property" v={propName} />
            <Row l="Insured address" v={pol.insured_address} />
            <Row l="Policy period" v={pol.period_start && pol.period_end ? `${fdate(pol.period_start)} – ${fdate(pol.period_end)}` : null} />
            <Row l="Premium" v={pol.premium_amount != null ? fd(pol.premium_amount) : null} />
            <Row l="Billing" v={FREQ_LABEL[pol.billing_frequency] ? cap(FREQ_LABEL[pol.billing_frequency].replace('billed ', '')) : null} />
            <Row l="Next due" v={pol.next_due_date ? `${fdate(pol.next_due_date)}${days != null && days >= 0 && !pol.paidCurrentCycle ? ` (in ${days}d)` : ''}` : null} />
          </div>
        </div>

        {/* ── Billing history ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Billing history</p>
          {stmts.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No parsed bills yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  {['Bill', 'Due date', 'Amount', 'Status', 'Paid', ''].map(h =>
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500, fontSize: 11 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {stmts.map(s => {
                  const p = (s.payments || [])[0] || {}
                  const paid = !!p.matched_transaction_id
                  return (
                    <tr key={s.id} style={{ borderBottom: '0.5px solid var(--border-light)' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 500 }}>{fmon(s.due_date || s.statement_date)}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{fdate(s.due_date)}</td>
                      <td style={{ padding: '7px 8px' }}>{s.amount_due != null ? fd(s.amount_due) : '—'}</td>
                      <td style={{ padding: '7px 8px' }}>
                        {paid
                          ? <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 99, background: 'var(--green-light)', color: 'var(--green)', fontWeight: 500 }}>paid ✓</span>
                          : <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 99, background: 'var(--amber-light)', color: 'var(--amber)', fontWeight: 500 }}>unpaid</span>}
                      </td>
                      <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{paid && p.payment_date ? fdate(p.payment_date) : '—'}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                        {s.document_id && (
                          <button onClick={() => setPreview({ docId: s.document_id, title: `Bill — ${fmon(s.due_date || s.statement_date)}` })}
                            title="View bill PDF"
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', fontSize: 14, padding: 2 }}>
                            <i className="ti ti-file-type-pdf" aria-hidden="true" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </>}

      {/* ── Upcoming tax payments (chatbot reminds on the same schedule) ── */}
      {upcomingTax.length > 0 && <TaxStrip items={upcomingTax} properties={properties} />}

      {preview && <PdfModal docId={preview.docId} title={preview.title} onClose={() => setPreview(null)} />}
    </div>
  )
}

function TaxStrip({ items, properties, standalone }) {
  return (
    <div className="card" style={{ marginBottom: 16, marginTop: standalone ? 32 : 0, textAlign: 'left' }}>
      <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Upcoming tax payments</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(t => {
          const refund = t.status === 'refund_expected'
          const days = daysUntil(t.due_date)
          const overdue = !refund && days != null && days < 0
          const propName = properties.find(p => p.id === t.property_id)?.name
          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 'var(--radius-sm)',
              background: refund ? 'var(--green-light)' : overdue ? 'var(--coral-light)' : 'var(--bg-secondary)' }}>
              <i className={`ti ${refund ? 'ti-cash-banknote' : 'ti-calendar-dollar'}`}
                style={{ color: refund ? 'var(--green)' : overdue ? 'var(--coral)' : 'var(--amber)', fontSize: 15 }} aria-hidden="true" />
              <span style={{ fontSize: 12.5, flex: 1 }}>
                {refund
                  ? <>Expected refund{t.amount != null ? ` of ${fd(t.amount)}` : ''} from {t.authority || 'tax authority'}{t.tax_year ? ` (${t.tax_year})` : ''}</>
                  : <>{t.label || 'Tax payment'} — {t.authority || 'tax authority'}{propName ? ` · ${propName}` : ''}{t.amount != null ? ` · ${fd(t.amount)}` : ''}</>}
              </span>
              {!refund && t.due_date && (
                <span style={{ fontSize: 11.5, fontWeight: 600, color: overdue ? 'var(--coral)' : days <= 30 ? 'var(--amber)' : 'var(--text-secondary)', flexShrink: 0 }}>
                  {overdue ? `overdue ${Math.abs(days)}d` : `due ${fdate(t.due_date)}`}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
