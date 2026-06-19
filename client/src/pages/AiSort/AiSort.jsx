// AiSort.jsx — DORMANT page: AI (Groq) document sorter for the Data Vault.
//
// ⚠ NOT wired into the app yet (by request). To activate later:
//   1. Mount the backend route — in server/vault/index.js add:
//        router.post('/ai-classify', require('./ai-sort-routes').classifyHandler({ readMeta }));
//   2. Import + render this page in App.jsx (add a nav item, e.g. nav==='ai-sort').
// Until then it is unreachable and affects nothing.
//
// Flow: drop files → POST /api/vault/ai-classify (dry-run, stores nothing) → the AI
// returns the doc type + the exact folder it belongs in (reusing existing folders).
// You can tweak the target folder, then Apply (reuses the normal upload + rename
// endpoints to actually file it).
import React, { useCallback, useRef, useState } from 'react'
import axios from 'axios'

const API = '/api/vault'

const TYPE_META = {
  bank_statement:     { label: 'Bank statement',     color: 'var(--blue)',   icon: 'ti-building-bank' },
  mortgage_statement: { label: 'Mortgage statement', color: 'var(--purple)', icon: 'ti-home' },
  escrow:             { label: 'Escrow',             color: 'var(--amber)',  icon: 'ti-file-invoice' },
  tax_form:           { label: 'Tax form',           color: 'var(--teal)',   icon: 'ti-receipt-tax' },
  other:              { label: 'Other / unsorted',   color: 'var(--text-muted)', icon: 'ti-file' },
}
const fmtSize = (b) => !b ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB'

export default function AiSort({ onApplied }) {
  const [rows, setRows]   = useState([])   // { file, status, decision, error, needsOcr }
  const [busy, setBusy]   = useState(false)
  const [model, setModel] = useState(null)
  const [drag, setDrag]   = useState(false)
  const fileRef = useRef()

  const classify = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter(f => /\.(pdf|png|jpe?g|webp)$/i.test(f.name))
    if (!files.length) return
    setBusy(true)
    setRows(files.map(file => ({ file, status: 'classifying', decision: null, error: null })))
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const res = await axios.post(`${API}/ai-classify`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setModel(res.data.model || null)
      const byName = {}
      ;(res.data.results || []).forEach(r => { byName[r.filename] = r })
      setRows(files.map(file => {
        const r = byName[file.name] || {}
        return { file, status: r.ok ? 'ready' : 'warn', decision: r.decision || null,
                 error: r.error || null, needsOcr: r.needsOcr || false }
      }))
    } catch (e) {
      setRows(files.map(file => ({ file, status: 'error', decision: null,
        error: e.response?.data?.error || e.message })))
    }
    setBusy(false)
  }, [])

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDrag(false)
    if (e.dataTransfer.files?.length) classify(e.dataTransfer.files)
  }, [classify])

  const editFolder = (i, folder)   => setRows(rs => rs.map((r, j) => j === i ? { ...r, decision: { ...r.decision, folder } } : r))
  const editName   = (i, filename) => setRows(rs => rs.map((r, j) => j === i ? { ...r, decision: { ...r.decision, filename } } : r))

  // Apply = store the file at the chosen folder via the normal upload endpoint, then
  // rename it to the AI's filename. Reuses existing endpoints; no new storage code.
  const applyOne = async (i) => {
    const row = rows[i]
    if (!row?.decision?.folder) return
    setRows(rs => rs.map((r, j) => j === i ? { ...r, status: 'applying' } : r))
    try {
      const fd = new FormData()
      fd.append('folderPath', row.decision.folder)
      fd.append('files', row.file)
      const up = await axios.post(`${API}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      const stored = up.data.files?.[0]
      if (stored && row.decision.filename && row.decision.filename !== stored.name) {
        await axios.patch(`${API}/file/${stored.id}`, { name: row.decision.filename })
      }
      setRows(rs => rs.map((r, j) => j === i ? { ...r, status: 'applied' } : r))
      onApplied?.()
    } catch (e) {
      setRows(rs => rs.map((r, j) => j === i ? { ...r, status: 'warn', error: e.response?.data?.error || e.message } : r))
    }
  }
  const applyAll = async () => { for (let i = 0; i < rows.length; i++) if (rows[i].status === 'ready') await applyOne(i) }

  const readyCount = rows.filter(r => r.status === 'ready').length

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
        <i className="ti ti-sparkles" style={{ fontSize:22, color:'var(--teal)' }} aria-hidden="true"/>
        <h2 style={{ margin:0, fontSize:20, fontWeight:600 }}>AI Document Sorter</h2>
        <span style={{ fontSize:11, color:'var(--text-muted)', border:'0.5px solid var(--border)', borderRadius:999, padding:'2px 8px' }}>
          experimental{model ? ` · ${model}` : ''}
        </span>
      </div>
      <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 16px', lineHeight:1.6 }}>
        Drop statements, tax forms, or mortgage documents. The AI reads each file, decides what it is,
        and proposes the exact vault folder — reusing folders that already exist. Nothing is filed until you hit Apply.
      </p>

      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          border:`1.5px dashed ${drag ? 'var(--teal)' : 'var(--border)'}`,
          background: drag ? 'var(--teal-light)' : 'var(--bg-secondary)',
          borderRadius:'var(--radius-lg)', padding:'30px 20px', textAlign:'center', cursor:'pointer',
          transition:'all .15s', marginBottom:18,
        }}>
        <i className="ti ti-cloud-upload" style={{ fontSize:30, color:'var(--text-muted)' }} aria-hidden="true"/>
        <p style={{ margin:'8px 0 2px', fontSize:14, fontWeight:500 }}>Drop files or click to choose</p>
        <p style={{ margin:0, fontSize:12, color:'var(--text-muted)' }}>PDF or image · {busy ? 'analyzing…' : 'classified instantly, filed only on Apply'}</p>
        <input ref={fileRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" hidden
               onChange={e => classify(e.target.files)} />
      </div>

      {rows.length > 0 && (
        <>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <span style={{ fontSize:12.5, color:'var(--text-secondary)' }}>
              {rows.length} file{rows.length!==1?'s':''} · {readyCount} ready to file
            </span>
            <button onClick={applyAll} disabled={!readyCount}
              style={{ background: readyCount ? 'var(--teal)' : 'var(--bg-hover)', color: readyCount ? '#fff' : 'var(--text-muted)',
                border:'none', borderRadius:'var(--radius-md)', padding:'8px 14px', fontSize:13, fontWeight:500,
                cursor: readyCount ? 'pointer' : 'default' }}>
              <i className="ti ti-check" aria-hidden="true"/> Apply all ({readyCount})
            </button>
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {rows.map((row, i) => {
              const d = row.decision || {}
              const tm = TYPE_META[d.docType] || TYPE_META.other
              return (
                <div key={i} className="card" style={{ padding:14, opacity: row.status==='applied' ? 0.65 : 1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: row.status==='classifying'?0:10 }}>
                    <i className={`ti ${tm.icon}`} style={{ fontSize:20, color: tm.color }} aria-hidden="true"/>
                    <div style={{ minWidth:0, flex:1 }}>
                      <div style={{ fontSize:13.5, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{row.file.name}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>{fmtSize(row.file.size)}</div>
                    </div>
                    {row.status==='classifying' && <span style={{ fontSize:12, color:'var(--text-muted)' }}>analyzing…</span>}
                    {d.docType && (
                      <span style={{ fontSize:11.5, fontWeight:600, color:tm.color, background:'var(--bg-secondary)',
                        border:`1px solid ${tm.color}`, borderRadius:999, padding:'3px 10px' }}>
                        {tm.label}{d.confidence!=null ? ` · ${(d.confidence*100).toFixed(0)}%` : ''}
                      </span>
                    )}
                    {row.status==='applied' && <span style={{ fontSize:12, color:'var(--green)', fontWeight:600 }}><i className="ti ti-check"/> filed</span>}
                  </div>

                  {row.error && <div style={{ fontSize:12, color:'var(--coral)', marginBottom:8 }}>
                    <i className="ti ti-alert-triangle" aria-hidden="true"/> {row.error}</div>}

                  {row.decision && row.status!=='classifying' && (
                    <>
                      {d.reasoning && <div style={{ fontSize:11.5, color:'var(--text-muted)', fontStyle:'italic', marginBottom:8 }}>“{d.reasoning}”</div>}
                      <div style={{ display:'grid', gridTemplateColumns:'70px 1fr', gap:'6px 10px', alignItems:'center' }}>
                        <label style={{ fontSize:11, color:'var(--text-secondary)' }}>Folder</label>
                        <input value={d.folder||''} onChange={e=>editFolder(i, e.target.value)}
                          style={{ fontSize:12.5, padding:'6px 9px', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)',
                            background:'var(--bg-secondary)', color:'var(--text-primary)', fontFamily:'monospace' }}/>
                        <label style={{ fontSize:11, color:'var(--text-secondary)' }}>Filename</label>
                        <input value={d.filename||''} onChange={e=>editName(i, e.target.value)}
                          style={{ fontSize:12.5, padding:'6px 9px', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)',
                            background:'var(--bg-secondary)', color:'var(--text-primary)' }}/>
                      </div>
                      {row.status!=='applied' && (
                        <div style={{ display:'flex', justifyContent:'flex-end', marginTop:10 }}>
                          <button onClick={()=>applyOne(i)} disabled={row.status==='applying' || !d.folder}
                            style={{ background:'var(--bg-secondary)', color:'var(--text-primary)', border:'0.5px solid var(--border)',
                              borderRadius:'var(--radius-md)', padding:'6px 12px', fontSize:12.5, cursor:'pointer' }}>
                            {row.status==='applying' ? 'Filing…' : 'Apply'}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
