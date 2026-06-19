import { useState, useEffect } from 'react'

const API = '/api'
const getToken = () => localStorage.getItem('caishen_token') || ''
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })

const fmtBytes = b => b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`
const fmtDate  = d => { try { return new Date(d).toLocaleString() } catch { return String(d) } }

// Minimal CSV → rows[][] (handles double-quoted fields containing commas).
function parseCsv(text) {
  return String(text || '').split(/\r?\n/).filter(l => l.length).map(line => {
    const out = []; let cur = '', q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
      else if (c === ',' && !q) { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur); return out
  })
}

const SECTIONS = [
  { key: 'plaid',     icon: 'ti-building-bank', label: 'Plaid CSV files',         hint: 'Raw Plaid transaction pulls' },
  { key: 'statement', icon: 'ti-file-text',     label: 'Statement CSV files',     hint: 'Rows extracted from uploaded bank statements' },
  { key: 'confirmed', icon: 'ti-circle-check',  label: 'Confirmed data CSV files', hint: 'Reconciled — a statement row verified against a Plaid transaction' },
]

function CsvCard({ item }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw]   = useState(false)
  const rows   = open && !raw ? parseCsv(item.text) : null
  const header = rows && rows[0]
  const body   = rows && rows.slice(1)

  return (
    <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 8, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 15, color: 'var(--text-muted)' }} aria-hidden="true" />
        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-primary)' }}>{item.key}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
          <span>{item.rows} row{item.rows !== 1 ? 's' : ''}</span><span>{fmtBytes(item.bytes)}</span><span>{fmtDate(item.updatedAt)}</span>
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '0.5px solid var(--border)', padding: 12, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button onClick={() => setRaw(r => !r)}
              style={{ fontSize: 11, padding: '3px 8px', background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              {raw ? 'Table view' : 'Raw text'}
            </button>
          </div>
          {item.rows === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, fontStyle: 'italic' }}>Empty (header only) — no data yet.</p>
          ) : raw ? (
            <pre style={{ fontSize: 12, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)', margin: 0, maxHeight: '65vh', overflow: 'auto', whiteSpace: 'pre' }}>{item.text}</pre>
          ) : (
            <div style={{ maxHeight: '65vh', overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr>{(header || []).map((h, i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 600, position: 'sticky', top: 0, background: 'var(--bg-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}</tr></thead>
                <tbody>{(body || []).map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => (
                    <td key={ci} style={{ padding: '6px 10px', borderBottom: '0.5px solid var(--border)', color: 'var(--text-primary)', whiteSpace: 'normal', wordBreak: 'break-word', verticalAlign: 'top' }} title={c}>{c}</td>
                  ))}</tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function CsvFiles() {
  const [data, setData]       = useState(null)
  const [err, setErr]         = useState(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true); setErr(null)
    fetch(`${API}/dev-csv`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j.error || `HTTP ${r.status}`)))
      .then(setData)
      .catch(e => setErr(typeof e === 'string' ? e : 'Could not load CSVs (is the server running locally?)'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const groups = data?.groups || {}

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>CSV files in the database</h2>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--amber)', border: '0.5px solid var(--amber)', borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Dev only</span>
        <button onClick={load}
          style={{ marginLeft: 'auto', fontSize: 12, padding: '5px 10px', background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-refresh" style={{ fontSize: 13 }} aria-hidden="true" /> Refresh
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 18px' }}>
        Every CSV blob stored per-user in <code>user_kv.text_data</code> (Neon). The confirmed list is rebuilt from matched reconciliation rows on each load.
      </p>

      {err && <p style={{ fontSize: 13, color: 'var(--coral)' }}>{err}</p>}
      {loading && !data && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</p>}

      {data && SECTIONS.map(sec => {
        const items = groups[sec.key] || []
        return (
          <section key={sec.key} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <i className={`ti ${sec.icon}`} style={{ fontSize: 17, color: 'var(--teal)' }} aria-hidden="true" />
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{sec.label}</h3>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{items.length} file{items.length !== 1 ? 's' : ''}</span>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>{sec.hint}</p>
            {items.length === 0
              ? <p style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', margin: 0 }}>No CSV files in this category yet.</p>
              : items.map(it => <CsvCard key={it.key} item={it} />)}
          </section>
        )
      })}

      {data && groups.other?.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>Other CSV files</h3>
          {groups.other.map(it => <CsvCard key={it.key} item={it} />)}
        </section>
      )}
    </div>
  )
}
