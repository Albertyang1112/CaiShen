import { useState, useEffect, useMemo } from 'react'
import axios from 'axios'
import { PdfModal } from '../../components/PdfPreview'

const API = '/api'

// ── Servicer-portal style mortgage page (what Rocket / Mr. Cooper / Fay show you) ──
// Read-only over the mortgage domain: the account snapshot (statements + Plaid
// Liabilities), the parsed statement history with P/I/E splits, escrow activity, and
// alerts. Data arrives via statement uploads and Plaid sync — nothing to click here.

const fd = n => { const v = Number(n); return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
// Date-only strings (e.g. FRED's "2026-06-25") parse as UTC midnight and would display a
// day early in US timezones — pin them to local noon first.
const fdate = d => { if (!d) return '—'; const s = String(d); return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
const fmon = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'
const num = v => (v == null ? null : Number(v))

// Amortize forward from the current balance at the loan's rate and P&I payment.
// Returns { months, payoffDate, remainingInterest } or null when inputs are unusable.
function amortize(balance, annualRatePct, monthlyPI, fromDate) {
  balance = num(balance); const r = num(annualRatePct) / 100 / 12; monthlyPI = num(monthlyPI)
  if (!balance || balance <= 0 || !monthlyPI || r == null || Number.isNaN(r)) return null
  if (monthlyPI <= balance * r) return null                    // payment doesn't cover interest
  let b = balance, interest = 0, months = 0
  while (b > 0 && months < 720) { const i = b * r; interest += i; b = b - (monthlyPI - i); months++ }
  const d = fromDate ? new Date(fromDate) : new Date()
  d.setMonth(d.getMonth() + months)
  return { months, payoffDate: d, remainingInterest: interest }
}

// Principal-balance history line (SVG). Points = statements ascending by date.
function BalanceChart({ points }) {
  if (points.length < 2) return null
  const W = 640, H = 180, PX = 8, PY = 14
  const xs = points.map(p => new Date(p.date).getTime())
  const ys = points.map(p => p.bal)
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const yMin = Math.min(...ys), yMax = Math.max(...ys)
  const pad = Math.max((yMax - yMin) * 0.15, 1)
  const X = t => PX + (W - 2 * PX) * (t - x0) / Math.max(x1 - x0, 1)
  const Y = v => PY + (H - 2 * PY) * (1 - (v - (yMin - pad)) / (yMax + pad - (yMin - pad)))
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(new Date(p.date).getTime()).toFixed(1)},${Y(p.bal).toFixed(1)}`).join(' ')
  const area = `${path} L${X(x1).toFixed(1)},${H - PY} L${X(x0).toFixed(1)},${H - PY} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} aria-label="Principal balance over time">
      <defs>
        <linearGradient id="mortFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--blue)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--blue)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#mortFill)" />
      <path d={path} fill="none" stroke="var(--blue)" strokeWidth="2" />
      {points.map((p, i) => (i === 0 || i === points.length - 1) && (
        <g key={i}>
          <circle cx={X(new Date(p.date).getTime())} cy={Y(p.bal)} r="3" fill="var(--blue)" />
          <text x={X(new Date(p.date).getTime())} y={Y(p.bal) - 7} fontSize="10.5" fill="var(--text-secondary)"
            textAnchor={i === 0 ? 'start' : 'end'}>{fd(p.bal)}</text>
        </g>
      ))}
      <text x={PX} y={H - 2} fontSize="10" fill="var(--text-muted)">{fdate(points[0].date)}</text>
      <text x={W - PX} y={H - 2} fontSize="10" fill="var(--text-muted)" textAnchor="end">{fdate(points[points.length - 1].date)}</text>
    </svg>
  )
}

const Card = ({ label, value, sub, subColor }) => (
  <div className="metric-card">
    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</p>
    <p style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{value}</p>
    {sub && <p style={{ fontSize: 11.5, color: subColor || 'var(--text-muted)', margin: '4px 0 0' }}>{sub}</p>}
  </div>
)

const Row = ({ l, v }) => v != null && v !== '' ? (
  <div className="row"><span style={{ color: 'var(--text-secondary)' }}>{l}</span><span style={{ fontWeight: 500 }}>{v}</span></div>
) : null

const ALERT_STYLE = {
  payment_changed:   { icon: 'ti-arrows-diff',      color: 'var(--amber)', bg: 'var(--amber-light)' },
  escrow_changed:    { icon: 'ti-shield-dollar',    color: 'var(--purple)', bg: 'var(--purple-light)' },
  payment_unmatched: { icon: 'ti-link-off',         color: 'var(--coral)', bg: 'var(--coral-light)' },
}

// Human label for a loan: the property it's on (name from /api/properties, else the
// street printed on the statement), falling back to servicer + loan digits.
function loanLabel(loan, properties) {
  const prop = (properties || []).find(p => p.id === loan.property_id)
  if (prop?.name) return prop.name
  if (loan.property_street) return loan.property_street.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase())
  return `${loan.servicer || 'Loan'} ••••${loan.loan_number_mask || '????'}`
}

export default function Mortgage() {
  const [loans, setLoans] = useState(null)          // null = loading
  const [sel, setSel] = useState(null)
  const [stmts, setStmts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [properties, setProperties] = useState([])
  const [preview, setPreview] = useState(null)
  const [market, setMarket] = useState(null)          // live 30/15-yr averages (server-cached)
  const [showLoanNo, setShowLoanNo] = useState(false) // eye toggle: reveal full loan number
  const [payInput, setPayInput] = useState('')        // what-if monthly payment (editable)
  const [payTouched, setPayTouched] = useState(false)

  useEffect(() => {
    axios.get(`${API}/mortgage`).then(r => {
      const rows = Array.isArray(r.data) ? r.data : []
      setLoans(rows)
      if (rows.length) setSel(rows[0].id)
    }).catch(() => setLoans([]))
    axios.get(`${API}/mortgage/alerts`).then(r => setAlerts(Array.isArray(r.data) ? r.data : [])).catch(() => {})
    axios.get(`${API}/properties`).then(r => setProperties(Array.isArray(r.data) ? r.data : [])).catch(() => {})
    axios.get(`${API}/mortgage/market-rates`).then(r => setMarket(r.data)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!sel) return
    setStmts([])
    setShowLoanNo(false)
    setPayTouched(false)
    axios.get(`${API}/mortgage/${sel}/statements`).then(r => setStmts(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [sel])

  const loan = (loans || []).find(l => l.id === sel)

  // Statement rows ascending for the chart, descending for the table.
  const series = useMemo(() => stmts
    .filter(s => s.statement_date && s.principal_balance != null)
    .map(s => ({ date: s.statement_date, bal: num(s.principal_balance) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date)), [stmts])

  const latestPay = useMemo(() => {
    for (const s of stmts) for (const p of (s.payments || []))
      if (p.principal_portion != null && p.interest_portion != null)
        return num(p.principal_portion) + num(p.interest_portion)
    return null
  }, [stmts])

  // Prefer the real P&I split from the newest payment; monthly_payment includes escrow,
  // so it's only a fair fallback when no split has been parsed yet.
  const actualPI = latestPay ?? num(loan?.monthly_payment)
  const savedWhatIf = loan?.whatIfPayment != null ? Number(loan.whatIfPayment) : null

  // Seed the editable payment from the saved scenario (else the actual) — but never
  // clobber an in-progress edit when the statements finish loading.
  useEffect(() => {
    if (!payTouched && actualPI != null) setPayInput(String(Math.round((savedWhatIf ?? actualPI) * 100) / 100))
  }, [sel, actualPI, savedWhatIf, payTouched])

  const projPay = Number(payInput) > 0 ? Number(payInput) : null
  const scenarioActive = projPay != null && actualPI != null && Math.abs(projPay - actualPI) > 0.5
  const payoff = loan && amortize(loan.current_principal, loan.interest_rate, projPay ?? actualPI, loan.next_due_date)
  const basePayoff = scenarioActive && loan ? amortize(loan.current_principal, loan.interest_rate, actualPI, loan.next_due_date) : null

  const dirty = actualPI != null && payInput !== '' && Number(payInput) !== (savedWhatIf ?? Math.round(actualPI * 100) / 100)
  const saveWhatIf = async () => {
    if (!sel || !projPay) return
    try {
      await axios.put(`${API}/mortgage/${sel}/whatif`, { payment: projPay })
      setLoans(ls => ls.map(l => l.id === sel ? { ...l, whatIfPayment: projPay } : l))
      setPayTouched(false)
    } catch (e) { alert('Save failed: ' + (e.response?.data?.error || e.message)) }
  }
  const revertWhatIf = async () => {
    if (dirty) { setPayInput(String(Math.round((savedWhatIf ?? actualPI) * 100) / 100)); setPayTouched(false); return }
    if (savedWhatIf != null) {
      try {
        await axios.put(`${API}/mortgage/${sel}/whatif`, { payment: null })
        setLoans(ls => ls.map(l => l.id === sel ? { ...l, whatIfPayment: null } : l))
        setPayInput(String(Math.round(actualPI * 100) / 100))
        setPayTouched(false)
      } catch (e) { alert('Revert failed: ' + (e.response?.data?.error || e.message)) }
    }
  }

  const paidDown = series.length >= 2 ? series[0].bal - series[series.length - 1].bal : null
  const escrowRows = useMemo(() => stmts.flatMap(s => s.escrow || []).filter(e => num(e.amount)), [stmts])
  const loanAlerts = alerts.filter(a => !sel || a.mortgageAccountId === sel).slice(0, 4)

  if (loans === null) return <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13 }}>Loading mortgage data…</div>

  if (!loans.length) return (
    <div style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center' }}>
      <i className="ti ti-home-dollar" style={{ fontSize: 44, color: 'var(--text-muted)' }} aria-hidden="true" />
      <p style={{ fontSize: 16, fontWeight: 600, margin: '14px 0 6px' }}>No mortgage data yet</p>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Mortgage detail appears here automatically once statements land in the Data Vault,
        or after granting <b>Loan data</b> access on a connected bank in Connections.
      </p>
    </div>
  )

  const addr = loan && [loan.property_street, loan.property_city && `${loan.property_city}, ${loan.property_region || ''} ${loan.property_postal_code || ''}`.trim()]
    .filter(Boolean).join(' · ')

  return (
    <div style={{ maxWidth: 1060 }}>
      {/* ── Loan identity + property selector (the app shell renders the page title) ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          {loan && (
            <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 2px' }}>
              {loanLabel(loan, properties)}
              <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--text-secondary)', marginLeft: 8 }}>
                {loan.servicer || 'Servicer'} · loan {showLoanNo && loan.loan_number ? loan.loan_number : `••••${loan.loan_number_mask || '????'}`}
                {loan.loan_number && (
                  <button onClick={() => setShowLoanNo(v => !v)}
                    title={showLoanNo ? 'Hide loan number' : 'Show full loan number'}
                    aria-label={showLoanNo ? 'Hide loan number' : 'Show full loan number'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 0 0 6px', fontSize: 13, verticalAlign: 'middle' }}>
                    <i className={`ti ${showLoanNo ? 'ti-eye-off' : 'ti-eye'}`} aria-hidden="true" />
                  </button>
                )}
              </span>
            </p>
          )}
          {addr && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 16px' }}>
            <i className="ti ti-map-pin" style={{ marginRight: 4 }} aria-hidden="true" />{addr}</p>}
        </div>
        {loans.length > 1 && (
          <select value={sel || ''} onChange={e => setSel(e.target.value)} aria-label="Select property"
            style={{ fontSize: 12.5, padding: '6px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
            {loans.map(l => (
              <option key={l.id} value={l.id}>
                {loanLabel(l, properties)} — {(l.servicer || 'Loan')} ••••{l.loan_number_mask || '????'}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* ── Alerts ── */}
      {loanAlerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {loanAlerts.map(a => {
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

      {loan && <>
        {/* ── Hero metrics ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
          <Card label="Principal balance" value={loan.current_principal != null ? fd(loan.current_principal) : '—'}
            sub={paidDown != null ? `${fd(paidDown)} paid down since ${fmon(series[0]?.date)}` : null} subColor="var(--green)" />
          <Card label="Monthly payment" value={loan.monthly_payment != null ? fd(loan.monthly_payment) : '—'}
            sub={loan.next_due_date ? `next due ${fdate(loan.next_due_date)}` : null} />
          <Card label="Interest rate" value={loan.interest_rate != null ? `${Number(loan.interest_rate)}%` : '—'}
            sub={market?.rate30
              ? `market 30-yr avg ${market.rate30.rate}%${loan.interest_rate != null ? ` — you're ${Math.abs(Number(loan.interest_rate) - market.rate30.rate).toFixed(2)} pts ${Number(loan.interest_rate) <= market.rate30.rate ? 'below' : 'above'}` : ''}`
              : ([loan.rate_type, loan.loan_term].filter(Boolean).join(' · ') || null)}
            subColor={market?.rate30 && loan.interest_rate != null
              ? (Number(loan.interest_rate) <= market.rate30.rate ? 'var(--green)' : 'var(--coral)')
              : undefined} />
          <Card label="Escrow balance" value={loan.escrow_balance != null ? fd(loan.escrow_balance) : '—'}
            sub={num(loan.escrow_balance) === 0 ? 'no escrow account' : 'taxes & insurance'} />
        </div>

        {/* ── Balance chart + loan details ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 10, marginBottom: 16, alignItems: 'start' }}>
          <div className="card">
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Principal paydown</p>
            {series.length >= 2
              ? <BalanceChart points={series} />
              : <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Not enough statement history to chart yet.</p>}
            {/* What-if payment editor: type a payment → projection updates live. Save keeps
                the scenario; revert undoes an edit, or (once saved) restores the actual. */}
            {actualPI != null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Monthly payment (P&I)</span>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>$</span>
                <input type="number" min="0" step="50" value={payInput}
                  onChange={e => { setPayInput(e.target.value); setPayTouched(true) }}
                  aria-label="What-if monthly payment"
                  style={{ width: 110, fontSize: 13, fontWeight: 600, padding: '5px 8px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${scenarioActive ? 'var(--blue)' : 'var(--border)'}`, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                {dirty && projPay != null && (
                  <button onClick={saveWhatIf} title="Save this payment scenario" aria-label="Save payment scenario"
                    style={{ background: 'var(--blue-light)', border: '1px solid var(--blue)', color: 'var(--blue)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '4px 8px', fontSize: 14, display: 'inline-flex' }}>
                    <i className="ti ti-device-floppy" aria-hidden="true" />
                  </button>
                )}
                {(dirty || savedWhatIf != null) && (
                  <button onClick={revertWhatIf}
                    title={dirty ? 'Undo edit' : `Revert to your actual payment (${fd(actualPI)} — last month's P&I)`}
                    aria-label="Revert payment"
                    style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', padding: '4px 8px', fontSize: 14, display: 'inline-flex' }}>
                    <i className="ti ti-arrow-back-up" aria-hidden="true" />
                  </button>
                )}
                {savedWhatIf != null && !dirty && (
                  <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 99, background: 'var(--blue-light)', color: 'var(--blue)', fontWeight: 500 }}>saved scenario</span>
                )}
                {scenarioActive && (
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>actual: {fd(actualPI)}/mo</span>
                )}
              </div>
            )}
            {payoff && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 10 }}>
                {[['Projected payoff', payoff.payoffDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })],
                  ['Payments left', `${payoff.months} mo (${(payoff.months / 12).toFixed(1)} yr)`],
                  ['Interest remaining', fd(payoff.remainingInterest)]].map(([l, v]) => (
                  <div key={l} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '7px 9px' }}>
                    <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '0 0 2px' }}>{l}</p>
                    <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>{v}</p>
                  </div>
                ))}
              </div>
            )}
            {scenarioActive && payoff && basePayoff && (
              <p style={{ fontSize: 11.5, color: basePayoff.remainingInterest >= payoff.remainingInterest ? 'var(--green)' : 'var(--coral)', margin: '8px 0 0', fontWeight: 500 }}>
                {basePayoff.months >= payoff.months
                  ? `vs your actual payment: pays off ${basePayoff.months - payoff.months} months sooner and saves ${fd(basePayoff.remainingInterest - payoff.remainingInterest)} in interest.`
                  : `vs your actual payment: adds ${payoff.months - basePayoff.months} months and ${fd(payoff.remainingInterest - basePayoff.remainingInterest)} in interest.`}
              </p>
            )}
            {projPay != null && !payoff && loan.current_principal != null && loan.interest_rate != null && (
              <p style={{ fontSize: 11.5, color: 'var(--coral)', margin: '8px 0 0' }}>
                This payment doesn't cover the monthly interest (≈{fd(num(loan.current_principal) * num(loan.interest_rate) / 1200)}) — the balance would grow.
              </p>
            )}
            {payoff && <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '10px 0 0' }}>
              Projection assumes this payment and rate continue unchanged — not a payoff quote.</p>}
          </div>

          <div className="card">
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 12px' }}>Loan details</p>
            <Row l="Servicer" v={loan.servicer} />
            <Row l="Loan number" v={showLoanNo && loan.loan_number ? loan.loan_number : (loan.loan_number_mask ? `••••${loan.loan_number_mask}` : null)} />
            <Row l="Interest rate" v={loan.interest_rate != null ? `${Number(loan.interest_rate)}%` : null} />
            <Row l="Rate type" v={loan.rate_type} />
            <Row l="Loan term" v={loan.loan_term} />
            <Row l="Loan type" v={loan.loan_type} />
            <Row l="Original principal" v={loan.original_principal != null ? fd(loan.original_principal) : null} />
            <Row l="Originated" v={loan.origination_date ? fdate(loan.origination_date) : null} />
            <Row l="Maturity" v={loan.maturity_date ? fdate(loan.maturity_date) : null} />
            <Row l="PMI" v={loan.has_pmi == null ? null : (loan.has_pmi ? 'Yes' : 'No')} />
            <Row l="Prepayment penalty" v={loan.has_prepayment_penalty == null ? null : (loan.has_prepayment_penalty ? 'Yes' : 'No')} />
            <Row l="Past due" v={num(loan.past_due_amount) ? fd(loan.past_due_amount) : null} />
            <Row l="Late fee owed" v={num(loan.current_late_fee) ? fd(loan.current_late_fee) : null} />
            <Row l="Interest paid YTD" v={loan.ytd_interest_paid != null ? fd(loan.ytd_interest_paid) : null} />
            <Row l="Principal paid YTD" v={loan.ytd_principal_paid != null ? fd(loan.ytd_principal_paid) : null} />
            <Row l="Market 30-yr avg" v={market?.rate30 ? `${market.rate30.rate}% (${fdate(market.rate30.asOf)})` : null} />
            <Row l="Market 15-yr avg" v={market?.rate15 ? `${market.rate15.rate}% (${fdate(market.rate15.asOf)})` : null} />
            {(loan.rate_type == null && loan.ytd_interest_paid == null) &&
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
                Rate type, term, PMI and YTD figures fill in automatically after granting
                <b> Loan data</b> access on this bank in Connections.</p>}
          </div>
        </div>

        {/* ── Payment history ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Payment history</p>
          {stmts.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No parsed statements yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  {['Statement', 'Due date', 'Payment', 'Principal', 'Interest', 'Escrow', 'Balance after', 'Bank txn', ''].map(h =>
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500, fontSize: 11 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {stmts.map(s => {
                  const p = (s.payments || [])[0] || {}
                  return (
                    <tr key={s.id} style={{ borderBottom: '0.5px solid var(--border-light)' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 500 }}>{fmon(s.statement_date)}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{fdate(s.due_date)}</td>
                      <td style={{ padding: '7px 8px' }}>{p.total_paid != null ? fd(p.total_paid) : (s.amount_due != null ? fd(s.amount_due) : '—')}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--green)' }}>{p.principal_portion != null ? fd(p.principal_portion) : '—'}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{p.interest_portion != null ? fd(p.interest_portion) : '—'}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{num(p.escrow_portion) ? fd(p.escrow_portion) : '—'}</td>
                      <td style={{ padding: '7px 8px' }}>{s.principal_balance != null ? fd(s.principal_balance) : '—'}</td>
                      <td style={{ padding: '7px 8px' }}>
                        {p.matched_transaction_id
                          ? <span style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 99, background: 'var(--green-light)', color: 'var(--green)', fontWeight: 500 }}>matched</span>
                          : <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ padding: '7px 8px', textAlign: 'right' }}>
                        {s.document_id && (
                          <button onClick={() => setPreview({ docId: s.document_id, title: `Statement — ${fmon(s.statement_date)}` })}
                            title="View statement PDF"
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

        {/* ── Escrow activity (only when there is any) ── */}
        {escrowRows.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 10px' }}>Escrow activity</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  {['Date', 'Type', 'Description', 'Amount'].map(h =>
                    <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500, fontSize: 11 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {escrowRows.map(e => (
                  <tr key={e.id} style={{ borderBottom: '0.5px solid var(--border-light)' }}>
                    <td style={{ padding: '7px 8px' }}>{fdate(e.date)}</td>
                    <td style={{ padding: '7px 8px', textTransform: 'capitalize' }}>{e.type || '—'}</td>
                    <td style={{ padding: '7px 8px', color: 'var(--text-secondary)' }}>{e.description || '—'}</td>
                    <td style={{ padding: '7px 8px' }}>{fd(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>}

      {preview && <PdfModal docId={preview.docId} title={preview.title} onClose={() => setPreview(null)} />}
    </div>
  )
}
