import { useState, useEffect } from 'react'

const API = '/api'
const getToken = () => localStorage.getItem('caishen_token') || ''
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })

const usd = n => `$${Math.round(Math.abs(n || 0)).toLocaleString()}`
const pct = n => `${((n || 0) * 100).toFixed(n < 0.1 ? 1 : 0)}%`

/**
 * "My Data" tab — turns the user's transactions into categorized tax data,
 * shows the income/deduction breakdown, estimates taxes from real numbers,
 * and lets the user fix flagged (needs_review) transactions.
 */
export default function TaxDataReview({ taxYear, filingStatus }) {
  const [categories, setCategories] = useState({})
  const [summary, setSummary]       = useState(null)   // normalization result
  const [calc, setCalc]             = useState(null)   // { result, breakdown, dataSummary }
  const [review, setReview]         = useState([])     // needs_review transactions
  const [busy, setBusy]             = useState('')     // '', 'normalize', 'calc'
  const [useAI, setUseAI]           = useState(false)

  // Mount-only: the component is keyed by taxYear in the parent, so a year change
  // remounts it and resets all state — no separate reset effect needed.
  useEffect(() => {
    fetch(`${API}/tax-history/categories`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setCategories(d.categories || {})).catch(() => {})
    fetch(`${API}/tax-transactions?year=${taxYear}&category=needs_review&limit=200`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setReview(d.transactions || [])).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadReview = () => {
    fetch(`${API}/tax-transactions?year=${taxYear}&category=needs_review&limit=200`, { headers: authHeaders() })
      .then(r => r.json()).then(d => setReview(d.transactions || [])).catch(() => {})
  }

  const runNormalize = async () => {
    setBusy('normalize')
    try {
      const r = await fetch(`${API}/tax-normalize/${taxYear}`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ useAI }),
      })
      setSummary(await r.json())
      loadReview()
    } catch (e) { setSummary({ error: e.message }) }
    finally { setBusy('') }
  }

  const runCalc = async () => {
    setBusy('calc')
    try {
      const r = await fetch(`${API}/tax-normalize/${taxYear}/calculate`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ filingStatus }),
      })
      setCalc(await r.json())
    } catch (e) { setCalc({ error: e.message }) }
    finally { setBusy('') }
  }

  const fixCategory = async (id, taxCategory) => {
    await fetch(`${API}/tax-transactions/${id}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ taxCategory, userVerified: true }),
    }).catch(() => {})
    setReview(prev => prev.filter(t => t.id !== id))
  }

  const catOptions = Object.entries(categories)
    .map(([k, v]) => [k, v.label]).sort((a, b) => a[1].localeCompare(b[1]))

  const result = calc?.result

  return (
    <div style={{ flex:1, overflowY:'auto', paddingTop:16, display:'flex', flexDirection:'column', gap:14 }}>

      {/* Actions */}
      <div className="card" style={{ padding:'14px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10 }}>
          <div>
            <p style={{ fontSize:14, fontWeight:500, margin:'0 0 3px' }}>Normalize {taxYear} transactions</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0, lineHeight:1.5 }}>
              Categorize your transactions into tax buckets, then estimate taxes from the real numbers.
            </p>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
              <input type="checkbox" checked={useAI} onChange={e => setUseAI(e.target.checked)} />
              AI-assist ambiguous
            </label>
            <button onClick={runNormalize} disabled={busy === 'normalize'}
              style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
              <i className={`ti ${busy === 'normalize' ? 'ti-loader-2 spin' : 'ti-wand'}`} aria-hidden="true"/>
              {busy === 'normalize' ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
        </div>

        {summary && !summary.error && (
          <div style={{ display:'flex', gap:18, marginTop:14, flexWrap:'wrap', fontSize:12 }}>
            <Stat label="Transactions" value={summary.totalForYear}/>
            <Stat label="By rules" value={summary.classifiedByRule} color="var(--teal)"/>
            {summary.aiUsed && <Stat label="By AI" value={summary.classifiedByAI} color="var(--purple)"/>}
            <Stat label="Need review" value={summary.needsReview} color={summary.needsReview ? 'var(--amber)' : 'var(--text-muted)'}/>
          </div>
        )}
        {summary?.error && <p style={{ fontSize:12, color:'var(--coral)', margin:'10px 0 0' }}>{summary.error}</p>}
      </div>

      {/* Calculation */}
      <div className="card" style={{ padding:'14px 16px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: result ? 14 : 0 }}>
          <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Estimate {taxYear} taxes <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>({filingStatus})</span></p>
          <button onClick={runCalc} disabled={busy === 'calc'}
            style={{ fontSize:12, background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
            <i className={`ti ${busy === 'calc' ? 'ti-loader-2 spin' : 'ti-calculator'}`} aria-hidden="true"/>
            {busy === 'calc' ? 'Calculating…' : 'Calculate'}
          </button>
        </div>

        {calc?.error && <p style={{ fontSize:12, color:'var(--coral)', margin:0 }}>{calc.error}</p>}

        {result && (
          <>
            <div style={{ display:'flex', gap:18, flexWrap:'wrap', marginBottom:14 }}>
              <BigStat label="AGI" value={usd(result.agi)}/>
              <BigStat label="Taxable income" value={usd(result.taxableIncome)}/>
              <BigStat label="Total tax" value={usd(result.totalLiability)} color="var(--coral)"/>
              <BigStat label={result.balanceDue >= 0 ? 'Balance due' : 'Refund'} value={usd(result.balanceDue)}
                color={result.balanceDue >= 0 ? 'var(--coral)' : 'var(--green)'}/>
              <BigStat label="Effective / marginal" value={`${pct(result.effectiveRate)} / ${pct(result.marginalRate)}`}/>
            </div>
            <details>
              <summary style={{ fontSize:12, color:'var(--text-secondary)', cursor:'pointer' }}>Full breakdown ({(result.steps || []).length} steps)</summary>
              <table style={{ width:'100%', borderCollapse:'collapse', marginTop:10, fontSize:12 }}>
                <tbody>
                  {(result.steps || []).map((s, i) => (
                    <tr key={i} style={{ borderBottom:'0.5px solid var(--border)' }}>
                      <td style={{ padding:'5px 0', color:'var(--text-secondary)' }}>
                        {s.label}{s.irsRef && <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:6 }}>{s.irsRef}</span>}
                      </td>
                      <td style={{ padding:'5px 0', textAlign:'right', color:'var(--text-primary)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap' }}>{usd(s.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            {result.warnings?.length > 0 && (
              <div style={{ marginTop:12, padding:'8px 12px', background:'var(--amber-light)', borderRadius:'var(--radius-sm)', fontSize:11, color:'var(--text-secondary)', lineHeight:1.5 }}>
                {result.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Review list */}
      {review.length > 0 && (
        <div className="card" style={{ padding:'14px 16px' }}>
          <p style={{ fontSize:14, fontWeight:500, margin:'0 0 4px' }}>
            <i className="ti ti-flag" style={{ color:'var(--amber)' }} aria-hidden="true"/> Needs review ({review.length})
          </p>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 12px', lineHeight:1.5 }}>
            These couldn't be auto-categorized. Pick a category to include them in your tax estimate. Items are excluded until reviewed.
          </p>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {review.slice(0, 100).map(t => (
              <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, color:'var(--text-primary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.description || '(no description)'}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)' }}>{t.date} · {usd(t.amount)}{t.notes ? ` · ${t.notes}` : ''}</div>
                </div>
                <select defaultValue="" onChange={e => e.target.value && fixCategory(t.id, e.target.value)}
                  style={{ fontSize:11, padding:'5px 7px', background:'var(--bg-card)', border:'0.5px solid var(--border-light)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', maxWidth:200, cursor:'pointer' }}>
                  <option value="" disabled>Categorize…</option>
                  {catOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <p style={{ fontSize:11, color:'var(--text-muted)', textAlign:'center', lineHeight:1.6, margin:'4px 0 8px' }}>
        Estimates come from the deterministic tax engine using your categorized transactions.
        They are informational only — verify with a professional before filing.
      </p>
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div>
      <span style={{ fontSize:18, fontWeight:600, color: color || 'var(--text-primary)' }}>{value}</span>
      <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:6 }}>{label}</span>
    </div>
  )
}

function BigStat({ label, value, color }) {
  return (
    <div style={{ minWidth:110 }}>
      <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:0.4, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:17, fontWeight:600, color: color || 'var(--text-primary)', fontVariantNumeric:'tabular-nums' }}>{value}</div>
    </div>
  )
}
