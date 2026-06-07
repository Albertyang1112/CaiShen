import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

const STATUS_META = {
  matched:    { label: 'Matched',        color: 'var(--green)',  icon: 'ti-circle-check' },
  stmt_only:  { label: 'Statement Only', color: 'var(--yellow)', icon: 'ti-alert-circle' },
  plaid_only: { label: 'Plaid Only',     color: 'var(--blue)',   icon: 'ti-info-circle'  },
  conflict:   { label: 'Conflict',       color: 'var(--red)',    icon: 'ti-alert-triangle'},
}

function fmt(amount) {
  if (amount == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

function Badge({ status }) {
  const m = STATUS_META[status] || { label: status, color: 'var(--text-muted)', icon: 'ti-circle' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: m.color + '22', color: m.color, whiteSpace: 'nowrap',
    }}>
      <i className={m.icon} style={{ fontSize: 11 }}/>
      {m.label}
    </span>
  )
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{
      background: 'var(--card)', borderRadius: 10, padding: '16px 20px',
      border: `1px solid ${color}33`, flex: 1, minWidth: 120,
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function Reconcile() {
  const [status,   setStatus]   = useState(null)
  const [flagged,  setFlagged]  = useState([])
  const [tab,      setTab]      = useState('all')   // 'all' | 'stmt_only' | 'plaid_only' | 'conflict'
  const [loading,  setLoading]  = useState(false)
  const [uploading,setUploading]= useState(false)
  const [message,  setMessage]  = useState(null)    // { type:'ok'|'err', text }
  const [drag,     setDrag]     = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/reconcile/status`)
      setStatus(r.data)
    } catch { /* no data yet */ }
  }, [])

  const loadFlagged = useCallback(async (filter) => {
    setLoading(true)
    try {
      const params = filter && filter !== 'all' ? { status: filter } : {}
      const r = await axios.get(`${API}/reconcile/flagged`, { params })
      setFlagged(r.data || [])
    } catch (e) {
      setFlagged([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { if (status?.stats) loadFlagged(tab) }, [status, tab, loadFlagged])

  async function uploadFile(file) {
    if (!file) return
    setUploading(true)
    setMessage(null)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const r = await axios.post(`${API}/reconcile/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const d = r.data
      setMessage({
        type: 'ok',
        text: `${d.filename}: parsed ${d.parsed} txns → ${d.matched} matched, ${d.stmtOnly} statement-only, ${d.plaidOnly} Plaid-only${d.conflicts ? `, ${d.conflicts} conflicts` : ''}.`
      })
      await loadStatus()
      await loadFlagged(tab)
    } catch (e) {
      setMessage({ type: 'err', text: e.response?.data?.error || e.message })
    } finally {
      setUploading(false)
    }
  }

  async function reRun() {
    setLoading(true)
    setMessage(null)
    try {
      const r = await axios.post(`${API}/reconcile/run`)
      const d = r.data
      setMessage({ type: 'ok', text: `Re-run complete: ${d.matched} matched, ${d.stmtOnly} statement-only, ${d.plaidOnly} Plaid-only.` })
      await loadStatus()
      await loadFlagged(tab)
    } catch (e) {
      setMessage({ type: 'err', text: e.response?.data?.error || e.message })
    } finally {
      setLoading(false)
    }
  }

  const stats = status?.stats || {}
  const files = status?.files || []
  const total = (stats.matched || 0) + (stats.stmt_only || 0) + (stats.plaid_only || 0) + (stats.conflict || 0)

  const TABS = [
    { id: 'all',        label: 'All Issues' },
    { id: 'stmt_only',  label: 'Statement Only' },
    { id: 'plaid_only', label: 'Plaid Only' },
    { id: 'conflict',   label: 'Conflicts' },
  ]

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            <i className="ti-arrows-exchange-2" style={{ marginRight: 8, color: 'var(--blue)' }}/>
            Statement Reconciliation
          </h2>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
            Upload a bank statement (PDF or CSV) to match against your Plaid transactions and surface gaps.
          </p>
        </div>
        {total > 0 && (
          <button onClick={reRun} disabled={loading}
            style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontSize: 13 }}>
            <i className="ti-refresh" style={{ marginRight: 5 }}/>Re-run
          </button>
        )}
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); uploadFile(e.dataTransfer.files[0]) }}
        style={{
          border: `2px dashed ${drag ? 'var(--blue)' : 'var(--border)'}`,
          borderRadius: 12, padding: '28px 20px', textAlign: 'center',
          background: drag ? 'var(--blue)08' : 'var(--card)',
          transition: 'all 0.15s', marginBottom: 20, cursor: 'pointer',
        }}
        onClick={() => document.getElementById('reconcile-file-input').click()}
      >
        <input id="reconcile-file-input" type="file" accept=".pdf,.csv,.txt" style={{ display: 'none' }}
          onChange={e => uploadFile(e.target.files[0])} />
        {uploading
          ? <><i className="ti-loader-2" style={{ fontSize: 28, color: 'var(--blue)', animation: 'spin 1s linear infinite' }}/><p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>Parsing…</p></>
          : <>
              <i className="ti-cloud-upload" style={{ fontSize: 32, color: 'var(--text-muted)' }}/>
              <p style={{ margin: '8px 0 4px', fontWeight: 600 }}>Drop a statement here or click to browse</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>PDF bank statement or CSV (Chase, BofA, or generic date/desc/amount)</p>
            </>}
      </div>

      {/* Message */}
      {message && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 20, fontSize: 13,
          background: message.type === 'ok' ? 'var(--green)18' : 'var(--red)18',
          color: message.type === 'ok' ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${message.type === 'ok' ? 'var(--green)' : 'var(--red)'}44`,
        }}>
          <i className={message.type === 'ok' ? 'ti-circle-check' : 'ti-alert-circle'} style={{ marginRight: 6 }}/>
          {message.text}
        </div>
      )}

      {/* Stats */}
      {total > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <StatCard label="Matched"        value={stats.matched    || 0} color="var(--green)"  sub="Verified against Plaid" />
          <StatCard label="Statement Only" value={stats.stmt_only  || 0} color="var(--yellow)" sub="Not in Plaid (gap-fill)" />
          <StatCard label="Plaid Only"     value={stats.plaid_only || 0} color="var(--blue)"   sub="In Plaid, not statement" />
          <StatCard label="Conflicts"      value={stats.conflict   || 0} color="var(--red)"    sub="Name mismatch warning" />
        </div>
      )}

      {/* Uploaded files */}
      {files.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Uploaded Statements</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {files.map((f, i) => (
              <span key={i} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <i className="ti-file-text" style={{ marginRight: 4 }}/>{f.source_file} <span style={{ color: 'var(--text-muted)' }}>({f.period_year})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Flagged / unmatched rows */}
      {total > 0 && (
        <>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{
                  padding: '7px 14px', borderRadius: '6px 6px 0 0', border: 'none', cursor: 'pointer', fontSize: 13,
                  background: tab === t.id ? 'var(--card)' : 'transparent',
                  color: tab === t.id ? 'var(--text)' : 'var(--text-muted)',
                  fontWeight: tab === t.id ? 600 : 400,
                  borderBottom: tab === t.id ? '2px solid var(--blue)' : '2px solid transparent',
                }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Rows */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
              <i className="ti-loader-2" style={{ fontSize: 24 }}/><br/>Loading…
            </div>
          ) : flagged.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 14 }}>
              {tab === 'all' ? 'No flagged rows — everything matched.' : `No ${tab.replace('_', '-')} rows.`}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Status</th>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Date</th>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Description</th>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right' }}>Amount</th>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Source</th>
                    <th style={{ padding: '8px 10px', color: 'var(--text-muted)', fontWeight: 600 }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {flagged.map((row, i) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--surface)44' }}>
                      <td style={{ padding: '8px 10px' }}><Badge status={row.status}/></td>
                      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{row.stmt_date || '—'}</td>
                      <td style={{ padding: '8px 10px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={row.stmt_desc}>{row.stmt_desc || '—'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {fmt(row.stmt_amount)}
                      </td>
                      <td style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)' }}>
                        {row.source_file || '—'}
                      </td>
                      <td style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={row.flag_reason}>{row.flag_reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {flagged.length === 200 && (
                <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  Showing first 200 rows.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!total && !uploading && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
          <i className="ti-file-invoice" style={{ fontSize: 48, opacity: 0.3 }}/><br/>
          <p style={{ marginTop: 12, fontSize: 14 }}>No statements uploaded yet.</p>
          <p style={{ fontSize: 12 }}>Upload a PDF or CSV bank statement above to start reconciling.</p>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
