import { useState, useEffect } from 'react'
import axios from 'axios'

const API = '/api'

// DEV-ONLY dashboard: independently re-checks every transaction the Banking tab
// shows as "matched" against the source CSVs, so we can confirm the displayed
// data is actually the data that was compared. Rendered only on localhost.
export default function ReconcileVerify() {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr]         = useState('')

  const run = () => {
    setLoading(true); setErr('')
    axios.get(`${API}/dev-verify`)
      .then(r => setData(r.data))
      .catch(e => setErr(e.response?.data?.error || e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { run() }, [])

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14,padding:'10px 14px',background:'var(--amber-light)',border:'0.5px solid var(--amber)',borderRadius:'var(--radius-md)'}}>
        <i className="ti ti-tool" style={{color:'var(--amber)',fontSize:18}} aria-hidden="true"/>
        <div style={{flex:1}}>
          <p style={{margin:0,fontSize:13,fontWeight:500}}>Reconciliation Verification — dev only</p>
          <p style={{margin:'2px 0 0',fontSize:11,color:'var(--text-secondary)',lineHeight:1.5}}>
            Re-compares every transaction shown as <b>matched</b> against the source CSVs: the displayed Plaid value vs <code>plaid_transactions.csv</code>, and the matched statement row vs <code>statement_transactions.csv</code>. Localhost-only; never shipped to production.
          </p>
        </div>
        <button onClick={run} disabled={loading} style={{background:'var(--blue-light)',color:'var(--blue)',border:'0.5px solid var(--blue)'}}>
          <i className={`ti ti-refresh ${loading?'spin':''}`} aria-hidden="true"/> {loading?'Checking…':'Re-run'}
        </button>
      </div>

      {err && <p style={{color:'var(--coral)',fontSize:13}}>Error: {err}</p>}

      {data && (
        <>
          <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap',alignItems:'center'}}>
            {[
              ['Matched rows checked', data.summary.total, 'var(--text-primary)'],
              ['Verified', data.summary.pass, 'var(--teal)'],
              ['Divergent', data.summary.diverge, data.summary.diverge ? 'var(--coral)' : 'var(--text-muted)'],
            ].map(([label,val,color]) => (
              <div key={label} style={{padding:'8px 16px',background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)'}}>
                <p style={{margin:0,fontSize:10,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.4px'}}>{label}</p>
                <p style={{margin:0,fontSize:18,fontWeight:600,color}}>{val}</p>
              </div>
            ))}
            <span style={{marginLeft:'auto',fontSize:11,color:'var(--text-muted)'}}>
              sources: {data.sources.displayed} displayed · {data.sources.plaidCsv} plaid-csv · {data.sources.stmtCsv} stmt-csv
            </span>
          </div>

          {data.summary.total === 0 ? (
            <div className="card" style={{textAlign:'center',padding:'2rem'}}>
              <p style={{fontSize:14,fontWeight:500,margin:0}}>No matched transactions to verify yet</p>
              <p style={{fontSize:12,color:'var(--text-secondary)',margin:'6px 0 0',lineHeight:1.6}}>
                Reconcile a bank statement (scrape or upload one) so the engine matches it against Plaid, then re-run this check.
              </p>
            </div>
          ) : (
            <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',overflow:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr style={{background:'var(--bg-secondary)',textAlign:'left'}}>
                    {['','Status','Source','Date','Amount','Description','Checks'].map((h,i) =>
                      <th key={i} style={{padding:'7px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:'0.4px',color:'var(--text-muted)',fontWeight:600,whiteSpace:'nowrap'}}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => <VerifyRow key={`${r.plaidTxnId}|${r.stmtSourceId}`} r={r}/>)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function VerifyRow({ r }) {
  const cell = { padding:'6px 10px', fontSize:12, borderBottom:'0.5px solid var(--border)', whiteSpace:'nowrap' }
  const srcRow = (label, v) => (
    <>
      <td style={{...cell,color:'var(--text-muted)',fontSize:10}}>{label}</td>
      <td style={cell}>{v ? v.date : '—'}</td>
      <td style={{...cell,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{v ? v.amount : '—'}</td>
      <td style={{...cell,maxWidth:280,overflow:'hidden',textOverflow:'ellipsis'}} title={v?v.desc:''}>{v ? (v.desc || '—') : '—'}</td>
    </>
  )
  const failed = r.checks.filter(c => !c.ok)
  return (
    <>
      <tr style={{borderTop:'2px solid var(--border)'}}>
        <td rowSpan={3} style={{...cell,verticalAlign:'top',fontSize:16,textAlign:'center'}}>
          <i className={`ti ti-${r.ok?'circle-check':'alert-triangle'}`} style={{color:r.ok?'var(--teal)':'var(--coral)'}} aria-hidden="true"/>
        </td>
        <td rowSpan={3} style={{...cell,verticalAlign:'top'}}>
          <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:r.ok?'var(--teal-light)':'var(--coral-light)',color:r.ok?'var(--teal)':'var(--coral)'}}>{r.status}</span>
        </td>
        {srcRow('displayed', r.displayed)}
        <td rowSpan={3} style={{...cell,verticalAlign:'top',fontSize:11,whiteSpace:'normal',maxWidth:280}}>
          {r.ok
            ? <span style={{color:'var(--teal)'}}>all checks pass</span>
            : failed.map(c => <div key={c.key} style={{color:'var(--coral)'}}>✗ {c.key}{c.detail ? `: ${c.detail}` : ''}</div>)}
        </td>
      </tr>
      <tr>{srcRow('plaid.csv', r.plaidCsv)}</tr>
      <tr>{srcRow('stmt.csv', r.stmtCsv)}</tr>
    </>
  )
}
