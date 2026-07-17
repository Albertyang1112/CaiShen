import { useRef, useState } from 'react'
import axios from 'axios'

const API = '/api'

/**
 * ImportSpreadsheets — the one control for spreadsheet (QuickBooks-export) imports.
 * A single button that is also a drop target; everything after the file pick is
 * automatic (classify → create accounts → chart → transactions → verify), and the
 * result shows once as an inline summary. Files are parsed server-side in memory and
 * never stored — only their data.
 */
export default function ImportSpreadsheets({ onDone, compact = false }) {
  const inputRef = useRef(null)
  const [busy, setBusy]       = useState(false)
  const [drag, setDrag]       = useState(false)
  const [summary, setSummary] = useState(null)
  const [error, setError]     = useState('')

  const send = async (fileList) => {
    const files = [...fileList].filter(f => /\.(xlsx|csv)$/i.test(f.name))
    if (!files.length || busy) return
    setBusy(true); setError(''); setSummary(null)
    const form = new FormData()
    files.forEach(f => form.append('files', f))
    try {
      const { data } = await axios.post(`${API}/import/spreadsheets`, form, { timeout: 10 * 60 * 1000 })
      setSummary(data)
      onDone?.(data)
    } catch (e) {
      setError(e.response?.data?.error || e.message)
    }
    setBusy(false)
  }

  const acctIssues = summary?.verification?.accounts?.length || 0
  const catIssues  = summary?.verification?.categories?.length || 0
  const clean      = summary && !acctIssues && !catIssues

  // Compact (header) placement floats the result panel under the button so the
  // surrounding flex row keeps its height; the empty-state placement flows inline.
  const panelStyle = compact
    ? { position:'absolute', right:0, top:'calc(100% + 6px)', width:520, maxWidth:'80vw', zIndex:60, boxShadow:'0 8px 24px rgba(0,0,0,0.18)' }
    : { position:'relative', maxWidth:640, margin:'10px auto 0' }

  return (
    <div style={{ position:'relative', display:'inline-block' }}>
      <input ref={inputRef} type="file" multiple accept=".xlsx,.csv" style={{ display:'none' }}
        onChange={e => { send(e.target.files); e.target.value = '' }}/>
      <button onClick={() => inputRef.current?.click()} disabled={busy}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files) }}
        title="Import QuickBooks exports or any clearly-labeled .xlsx/.csv — accounts, categories and transactions are created automatically; the files themselves are not stored"
        style={{
          fontSize:12, padding:'5px 13px', borderRadius:99, cursor: busy ? 'wait' : 'pointer',
          border:`0.5px solid ${drag ? 'var(--green)' : 'var(--border)'}`,
          background: drag ? 'rgba(99,153,34,0.10)' : 'var(--bg-secondary)',
          color: drag ? 'var(--green)' : 'var(--text-secondary)',
          display:'inline-flex', alignItems:'center', gap:6,
        }}>
        <i className={`ti ${busy ? 'ti-loader-2 spin' : 'ti-file-spreadsheet'}`} aria-hidden="true"/>
        {busy ? 'Importing…' : 'Import data'}
      </button>

      {(summary || error) && (
        <div style={{
          ...panelStyle,
          padding:'10px 14px', paddingRight:28, fontSize:12, borderRadius:'var(--radius-md)',
          background:'var(--bg-card)',
          border:'0.5px solid var(--border)',
          borderLeft:`3px solid ${error ? 'var(--coral)' : clean ? 'var(--teal)' : 'var(--amber)'}`,
          textAlign:'left',
        }}>
          <button onClick={() => { setSummary(null); setError('') }}
            style={{ position:'absolute', top:6, right:8, background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:13, padding:2 }}
            aria-label="Dismiss"><i className="ti ti-x" aria-hidden="true"/></button>
          {error ? (
            <span style={{ color:'var(--coral)', fontWeight:500 }}>Import failed: {error}</span>
          ) : (
            <>
              <p style={{ margin:0, fontWeight:600 }}>
                {clean ? '✓ Import complete — everything reconciles' : '⚠ Import complete, with differences to review'}
              </p>
              <p style={{ margin:'4px 0 0', color:'var(--text-secondary)', lineHeight:1.6 }}>
                {summary.accountsCreated.length} account{summary.accountsCreated.length !== 1 ? 's' : ''} created
                {summary.accountsMatched.length ? ` (${summary.accountsMatched.length} matched existing)` : ''}
                {' · '}{summary.txnsImported.toLocaleString()} transactions
                {summary.transferGroups ? ` · ${summary.transferGroups} transfer pairs linked` : ''}
                {summary.journalEntries ? ` · ${summary.journalEntries} journal entries` : ''}
                {summary.coaNodesAdded ? ` · ${summary.coaNodesAdded} categories added` : ''}
                {summary.vendorsSeeded ? ` · ${summary.vendorsSeeded} vendors learned` : ''}
                {summary.mergedLoans?.length ? ` · ${summary.mergedLoans.length} loan${summary.mergedLoans.length !== 1 ? 's' : ''} merged with linked mortgage${summary.mergedLoans.length !== 1 ? 's' : ''}` : ''}
              </p>
              {(acctIssues > 0 || catIssues > 0) && (
                <ul style={{ margin:'6px 0 0', paddingLeft:18, color:'var(--text-secondary)', lineHeight:1.6 }}>
                  {(summary.verification.accounts || []).slice(0, 5).map(v => (
                    <li key={v.account}>{v.account}: expected {v.expected}, imported {v.actual}</li>
                  ))}
                  {(summary.verification.categories || []).slice(0, 5).map(v => (
                    <li key={v.category}>{v.category}: expected {v.expected}, imported {v.actual}</li>
                  ))}
                  {acctIssues + catIssues > 10 && <li>… and {acctIssues + catIssues - 10} more (see import batch record)</li>}
                </ul>
              )}
              {(summary.warnings || []).slice(0, 4).map((w, i) => (
                <p key={i} style={{ margin:'4px 0 0', color:'var(--text-secondary)' }}>⚠ {w}</p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
