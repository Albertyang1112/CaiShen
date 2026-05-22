import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'

const API = 'http://localhost:3001/api/vault'

const FILE_ICONS = {
  pdf:   { icon:'ti-file-type-pdf',   color:'var(--coral)'  },
  csv:   { icon:'ti-file-spreadsheet', color:'var(--green)' },
  excel: { icon:'ti-file-spreadsheet', color:'var(--green)' },
  image: { icon:'ti-photo',            color:'var(--blue)'  },
  word:  { icon:'ti-file-type-doc',    color:'var(--blue)'  },
  text:  { icon:'ti-file-text',        color:'var(--text-secondary)' },
  other: { icon:'ti-file',             color:'var(--text-secondary)' },
}

const TAG_COLORS = {
  haas:'var(--blue)', kobe:'var(--teal)', bayhill:'var(--purple)',
  muirfield:'var(--amber)', alcita:'var(--coral)',
  tax:'var(--pink)', personal:'var(--green)', business:'var(--blue)'
}

const CATEGORIES = {
  'Dining':        { icon:'ti-tools-kitchen-2',    color:'var(--coral)',  keywords:['restaurant','cafe','starbucks','doordash','ubereats','grubhub','food','dining','sushi','pizza','burger'] },
  'Groceries':     { icon:'ti-apple',              color:'var(--green)',  keywords:['whole foods','trader joe','safeway','kroger','instacart','grocery','supermarket'] },
  'Shopping':      { icon:'ti-shopping-bag',       color:'var(--amber)',  keywords:['amazon','walmart','target','best buy','costco'] },
  'Transport':     { icon:'ti-car',                color:'var(--blue)',   keywords:['uber','lyft','shell','chevron','gas','fuel','parking','airline','delta','united'] },
  'Travel':        { icon:'ti-plane',              color:'var(--purple)', keywords:['hotel','marriott','hilton','airbnb','flight','expedia'] },
  'Entertainment': { icon:'ti-device-tv',          color:'var(--purple)', keywords:['netflix','spotify','hulu','disney','apple tv','concert','theater'] },
  'Fitness':       { icon:'ti-barbell',            color:'var(--teal)',   keywords:['equinox','gym','crossfit','yoga','peloton','fitness'] },
  'Health':        { icon:'ti-heart-rate-monitor', color:'var(--green)',  keywords:['pharmacy','cvs','walgreens','hospital','doctor','dental','medical'] },
  'Utilities':     { icon:'ti-bolt',               color:'var(--amber)',  keywords:['pg&e','sce','verizon','at&t','comcast','internet','electric','water','utility'] },
  'Repairs':       { icon:'ti-hammer',             color:'var(--coral)',  keywords:['home depot','lowe','repair','maintenance','plumber','contractor','hardware'] },
  'Insurance':     { icon:'ti-shield',             color:'var(--blue)',   keywords:['insurance','allstate','state farm','progressive','geico','premium'] },
  'Mortgage':      { icon:'ti-home-dollar',        color:'var(--purple)', keywords:['mortgage','loan','escrow','interest','principal','payment'] },
  'HOA':           { icon:'ti-home',               color:'var(--teal)',   keywords:['hoa','homeowner','association','dues'] },
  'Subscriptions': { icon:'ti-refresh',            color:'var(--pink)',   keywords:['subscription','membership','monthly','annual','icloud','adobe','microsoft'] },
  'Income':        { icon:'ti-arrow-down-left',    color:'var(--teal)',   keywords:['deposit','payroll','direct deposit','transfer in','refund','credit'] },
  'Other':         { icon:'ti-dots',               color:'var(--text-secondary)', keywords:[] },
}

const categorize = (desc) => {
  if (!desc) return 'Other'
  const d = desc.toLowerCase()
  for (const [cat, { keywords }] of Object.entries(CATEGORIES)) {
    if (cat === 'Other') continue
    if (keywords.some(k => d.includes(k))) return cat
  }
  return 'Other'
}

const formatSize = (bytes) => {
  if (!bytes) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB'
  return (bytes/1024/1024).toFixed(2) + ' MB'
}

const fd = (n) => (n<0?'-$':'$') + Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

// ── PDF preview — native browser renderer via authenticated blob URL ──
function PDFPreview({ url, onTransactions }) {
  const [blobUrl, setBlobUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    let objUrl = null
    const token = localStorage.getItem('caishen_token') || ''

    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() })
      .then(blob => {
        objUrl = URL.createObjectURL(blob)
        setBlobUrl(objUrl)
        setLoading(false)

        // Background: attempt text extraction for transaction import
        const fd = new FormData()
        fd.append('file', blob, 'document.pdf')
        axios.post('http://localhost:3001/api/pdf-render', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
          .then(res => {
            const txs = parseTransactionsFromText(res.data.text || '')
            if (txs.length > 0) onTransactions?.(txs)
          })
          .catch(() => {}) // silently skip extraction if it fails
      })
      .catch(e => { setError(e.message); setLoading(false) })

    return () => { if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [url])

  if (loading) return (
    <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:12, color:'var(--text-secondary)' }}>
      <i className="ti ti-loader-2" style={{ fontSize:22, animation:'spin 1s linear infinite' }} aria-hidden="true"/>
      Loading PDF...
    </div>
  )

  if (error) return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'2rem' }}>
      <i className="ti ti-alert-circle" style={{ fontSize:36, color:'var(--amber)', marginBottom:12 }} aria-hidden="true"/>
      <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:16 }}>Could not load PDF</p>
      <a href={url} download style={{ fontSize:13, padding:'8px 16px', background:'var(--blue-light)', color:'var(--blue)', border:'0.5px solid var(--blue)', borderRadius:'var(--radius-sm)', textDecoration:'none' }}>
        Download PDF instead
      </a>
    </div>
  )

  return <iframe src={`${blobUrl}#navpanes=0`} title="PDF Preview" style={{ flex:1, width:'100%', border:'none', display:'block' }}/>
}

// ── CSV preview ───────────────────────────────────────────────────────
function CSVPreview({ url, onTransactions }) {
  const [rows, setRows]       = useState([])
  const [headers, setHeaders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(url).then(r => r.text()).then(text => {
      const lines = text.trim().split('\n').filter(Boolean)
      if (!lines.length) return
      const hdrs = lines[0].split(',').map(h => h.replace(/"/g,'').trim())
      const data = lines.slice(1).map(l => {
        const cols = []
        let cur = '', inQ = false
        for (const ch of l) {
          if (ch==='"') inQ=!inQ
          else if (ch===',' && !inQ) { cols.push(cur.trim()); cur='' }
          else cur+=ch
        }
        cols.push(cur.trim())
        return cols.map(c => c.replace(/"/g,'').trim())
      })
      setHeaders(hdrs)
      setRows(data)
      setLoading(false)

      // Extract transactions
      const dateIdx = hdrs.findIndex(h => ['date','posting date','transaction date'].includes(h.toLowerCase()))
      const descIdx = hdrs.findIndex(h => h.toLowerCase().includes('description') || h.toLowerCase().includes('merchant'))
      const amtIdx  = hdrs.findIndex(h => h.toLowerCase().includes('amount'))
      if (dateIdx>=0 && descIdx>=0 && amtIdx>=0) {
        const txs = data.slice(0,500).map((row,i) => {
          const amt  = parseFloat(row[amtIdx]?.replace(/[$,]/g,'')||'0')
          const date = new Date(row[dateIdx])
          return {
            id: `csv_preview_${i}`,
            date: isNaN(date) ? row[dateIdx] : date.toISOString().split('T')[0],
            desc: row[descIdx]||'',
            amount: amt,
            category: categorize(row[descIdx]||''),
            source: 'vault',
          }
        }).filter(t => !isNaN(t.amount) && t.amount !== 0)
        onTransactions?.(txs)
      }
    }).catch(() => setLoading(false))
  }, [url])

  if (loading) return <div style={{ padding:'2rem', textAlign:'center', color:'var(--text-secondary)' }}>Loading CSV...</div>

  return (
    <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:'60vh' }}>
      <table style={{ borderCollapse:'collapse', fontSize:12, width:'100%' }}>
        <thead>
          <tr style={{ background:'var(--bg-secondary)', position:'sticky', top:0 }}>
            <th style={{ padding:'8px 10px', color:'var(--text-muted)', borderBottom:'0.5px solid var(--border)', width:36, fontSize:11 }}>#</th>
            {headers.map((h,i) => (
              <th key={i} style={{ padding:'8px 12px', textAlign:'left', fontWeight:500, color:'var(--text-secondary)', borderBottom:'0.5px solid var(--border)', whiteSpace:'nowrap', borderRight:'0.5px solid var(--border)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0,200).map((row,i) => (
            <tr key={i} style={{ borderBottom:'0.5px solid var(--border)' }}
              onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <td style={{ padding:'6px 10px', color:'var(--text-muted)', fontSize:11, textAlign:'right' }}>{i+1}</td>
              {row.map((cell,j) => (
                <td key={j} style={{ padding:'7px 12px', whiteSpace:'nowrap', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', borderRight:'0.5px solid var(--border)' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <p style={{ padding:'10px', fontSize:11, color:'var(--text-secondary)', textAlign:'center' }}>Showing 200 of {rows.length} rows</p>}
    </div>
  )
}

// ── Excel preview — uses ExcelJS, 0 vulnerabilities ───────────────────
function ExcelPreview({ url, onTransactions }) {
  const [sheets, setSheets]         = useState({})
  const [activeSheet, setActiveSheet] = useState('')
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const ExcelJS  = (await import('exceljs/dist/exceljs.bare.min.js')).default
        const response = await fetch(url)
        const buffer   = await response.arrayBuffer()
        const wb       = new ExcelJS.Workbook()
        await wb.xlsx.load(buffer)

        const allSheets = {}
        wb.eachSheet(ws => {
          const rows = []
          ws.eachRow(row => {
            rows.push(row.values.slice(1).map(v => {
              if (v === null || v === undefined) return ''
              if (v instanceof Date) return v.toLocaleDateString()
              if (typeof v === 'object' && v.text) return v.text
              if (typeof v === 'object' && v.result !== undefined) return v.result
              return String(v)
            }))
          })
          allSheets[ws.name] = rows
        })

        if (!cancelled) {
          setSheets(allSheets)
          const firstName = Object.keys(allSheets)[0] || ''
          setActiveSheet(firstName)
          setLoading(false)

          // Transaction extraction from first sheet
          const firstRows = allSheets[firstName] || []
          if (firstRows.length > 1) {
            const headers = firstRows[0].map(h => String(h).toLowerCase())
            const dateIdx = headers.findIndex(h => h.includes('date'))
            const descIdx = headers.findIndex(h => h.includes('desc') || h.includes('memo') || h.includes('name'))
            const amtIdx  = headers.findIndex(h => h.includes('amount') || h.includes('debit') || h.includes('credit'))
            if (dateIdx>=0 && descIdx>=0 && amtIdx>=0) {
              const txs = firstRows.slice(1).map((row,i) => {
                const date = new Date(row[dateIdx])
                const amt  = parseFloat(String(row[amtIdx]).replace(/[$,]/g,'')) || 0
                const desc = String(row[descIdx] || '')
                if (isNaN(date.getTime()) || !amt) return null
                return {
                  id: `xlsx_${i}_${Date.now()}`,
                  date: date.toISOString().split('T')[0],
                  desc,
                  amount: amt < 0 ? amt : -Math.abs(amt),
                  category: categorize(desc),
                  source: 'vault',
                  month: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`,
                }
              }).filter(Boolean)
              if (txs.length > 0) onTransactions?.(txs)
            }
          }
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [url])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'3rem', gap:12, color:'var(--text-secondary)' }}>
      <i className="ti ti-loader-2" style={{ fontSize:22, animation:'spin 1s linear infinite' }} aria-hidden="true"/>
      Reading spreadsheet...
    </div>
  )
  if (error) return (
    <div style={{ padding:'2rem', textAlign:'center', color:'var(--coral)' }}>
      <i className="ti ti-alert-circle" style={{ fontSize:28, display:'block', marginBottom:8 }} aria-hidden="true"/>
      Could not read Excel file: {error}
    </div>
  )

  const rows    = sheets[activeSheet] || []
  const headers = rows[0] || []
  const data    = rows.slice(1)

  return (
    <div>
      {Object.keys(sheets).length > 1 && (
        <div style={{ display:'flex', gap:0, borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', overflowX:'auto' }}>
          {Object.keys(sheets).map(name => (
            <button key={name} onClick={() => setActiveSheet(name)}
              style={{ fontSize:12, padding:'8px 16px', borderRadius:0, border:'none', borderBottom: activeSheet===name?'2px solid var(--green)':'2px solid transparent', background:'none', color: activeSheet===name?'var(--green)':'var(--text-secondary)', fontWeight: activeSheet===name?500:400, whiteSpace:'nowrap', cursor:'pointer' }}>
              <i className="ti ti-table" style={{ fontSize:12, marginRight:5 }} aria-hidden="true"/>
              {name}
            </button>
          ))}
        </div>
      )}
      <div style={{ padding:'6px 16px', background:'var(--bg-secondary)', borderBottom:'0.5px solid var(--border)', display:'flex', gap:16, fontSize:11, color:'var(--text-secondary)' }}>
        <span><strong style={{ color:'var(--text-primary)' }}>{data.length.toLocaleString()}</strong> rows</span>
        <span><strong style={{ color:'var(--text-primary)' }}>{headers.length}</strong> columns</span>
        <span>Sheet: <strong style={{ color:'var(--green)' }}>{activeSheet}</strong></span>
        {data.length > 200 && <span style={{ color:'var(--amber)' }}>Showing first 200 rows</span>}
      </div>
      <div style={{ overflowX:'auto', overflowY:'auto', maxHeight:'52vh' }}>
        <table style={{ borderCollapse:'collapse', fontSize:12, width:'100%', minWidth:'max-content' }}>
          <thead>
            <tr style={{ background:'var(--bg-secondary)', position:'sticky', top:0, zIndex:1 }}>
              <th style={{ padding:'8px 10px', color:'var(--text-muted)', borderBottom:'0.5px solid var(--border)', width:36, fontSize:11 }}>#</th>
              {headers.map((h,i) => (
                <th key={i} style={{ padding:'8px 12px', textAlign:'left', fontWeight:500, color:'var(--text-secondary)', borderBottom:'0.5px solid var(--border)', whiteSpace:'nowrap', borderRight:'0.5px solid var(--border)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.slice(0,200).map((row,i) => (
              <tr key={i} style={{ borderBottom:'0.5px solid var(--border)' }}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <td style={{ padding:'6px 10px', color:'var(--text-muted)', fontSize:11, textAlign:'right' }}>{i+1}</td>
                {headers.map((_,j) => {
                  const val = row[j] ?? ''
                  const isNum = !isNaN(parseFloat(val)) && String(val).trim() !== ''
                  const isNeg = isNum && parseFloat(val) < 0
                  return (
                    <td key={j} style={{ padding:'6px 12px', color: isNeg?'var(--coral)':'var(--text-primary)', textAlign: isNum?'right':'left', whiteSpace:'nowrap', maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', borderRight:'0.5px solid var(--border)', fontVariantNumeric: isNum?'tabular-nums':'normal' }}>
                      {val}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Image preview ─────────────────────────────────────────────────────
function ImagePreview({ url }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:'#111', maxHeight:'60vh', overflow:'auto' }}>
      <img src={url} alt="preview" style={{ maxWidth:'100%', maxHeight:'55vh', objectFit:'contain', borderRadius:4 }}/>
    </div>
  )
}

// ── Text extraction for transactions ──────────────────────────────────
function parseTransactionsFromText(text) {
  const txs = []
  const lines = text.split('\n')

  // Pattern: date + description + amount
  const datePattern = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/
  const amtPattern  = /\$?([\d,]+\.\d{2})/g

  for (const line of lines) {
    const dateMatch = line.match(datePattern)
    const amtMatches = [...line.matchAll(/\$?([\d,]+\.\d{2})/g)]
    if (!dateMatch || amtMatches.length === 0) continue

    const date = new Date(dateMatch[1])
    if (isNaN(date.getTime())) continue

    const amount = parseFloat(amtMatches[amtMatches.length-1][1].replace(',',''))
    if (isNaN(amount) || amount === 0) continue

    // Description = text between date and amount
    const desc = line.replace(datePattern,'').replace(/\$?[\d,]+\.\d{2}/g,'').trim().replace(/\s+/g,' ')
    if (!desc || desc.length < 2) continue

    txs.push({
      id:       `vault_${Date.now()}_${txs.length}`,
      date:     date.toISOString().split('T')[0],
      desc:     desc.slice(0,80),
      amount:   -amount,
      category: categorize(desc),
      source:   'vault',
      month:    `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`,
    })
  }
  return txs.slice(0, 500)
}

// ── File preview modal (Discord-style) ───────────────────────────────
function FilePreviewModal({ file, onClose, onImportTransactions }) {
  const [extracted, setExtracted] = useState([])
  const [importing, setImporting] = useState(false)
  const [imported, setImported]   = useState(false)
  const fileUrl = `${API}/file/${file.id}`

  const handleTransactions = useCallback((txs) => {
    setExtracted(txs)
  }, [])

  const doImport = () => {
    setImporting(true)
    onImportTransactions?.(extracted)
    setImported(true)
    setImporting(false)
  }

  const renderContent = () => {
    switch (file.type) {
        case 'pdf':   return <PDFPreview url={fileUrl} onTransactions={handleTransactions}/>
        case 'csv':   return <CSVPreview url={fileUrl} onTransactions={handleTransactions}/>
        case 'excel': return <ExcelPreview url={fileUrl} onTransactions={handleTransactions}/>
        case 'image': return <ImagePreview url={fileUrl}/>
        default:
        return (
          <div style={{ padding:'3rem', textAlign:'center', color:'var(--text-secondary)' }}>
            <i className={`ti ${FILE_ICONS[file.type]?.icon||'ti-file'}`} style={{ fontSize:48, display:'block', marginBottom:12, color:FILE_ICONS[file.type]?.color }} aria-hidden="true"/>
            <p style={{ fontSize:14, margin:'0 0 16px' }}>Preview not available for this file type</p>
            <a href={fileUrl} download={file.name}
              style={{ fontSize:13, padding:'8px 16px', background:'var(--blue-light)', color:'var(--blue)', border:'0.5px solid var(--blue)', borderRadius:'var(--radius-sm)', textDecoration:'none' }}>
              Download {file.name}
            </a>
          </div>
        )
    }
  }

  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2000, padding:'16px' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', width:'min(1380px, 97vw)', height:'93vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Modal header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', flexShrink:0 }}>
          <i className={`ti ${FILE_ICONS[file.type]?.icon||'ti-file'}`} style={{ fontSize:18, color:FILE_ICONS[file.type]?.color }} aria-hidden="true"/>
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ fontSize:14, fontWeight:500, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{file.name}</p>
            <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'1px 0 0' }}>{file.folderPath} · {formatSize(file.size)} · {new Date(file.createdAt).toLocaleDateString()}</p>
          </div>
          <div style={{ display:'flex', gap:6, flexShrink:0 }}>
            {extracted.length > 0 && !imported && (
              <button onClick={doImport} disabled={importing}
                style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
                <i className="ti ti-download" aria-hidden="true"/> Import {extracted.length} transactions
              </button>
            )}
            {imported && (
              <span style={{ fontSize:12, color:'var(--teal)', display:'flex', alignItems:'center', gap:5 }}>
                <i className="ti ti-circle-check" aria-hidden="true"/> Imported
              </span>
            )}
            <a href={fileUrl} download={file.name}
              style={{ fontSize:12, padding:'6px 10px', background:'var(--bg-card)', color:'var(--text-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', textDecoration:'none', display:'flex', alignItems:'center', gap:5 }}>
              <i className="ti ti-download" aria-hidden="true"/> Save
            </a>
            <button onClick={onClose} style={{ fontSize:16, background:'none', border:'none', color:'var(--text-secondary)', padding:'4px 8px', lineHeight:1 }}>✕</button>
          </div>
        </div>

        {/* File content */}
        <div style={{ flex:1, overflow:'hidden', minHeight:0, display:'flex', flexDirection:'column' }}>
          {renderContent()}
        </div>

        {/* Extracted transactions preview */}
        {extracted.length > 0 && (
          <div style={{ borderTop:'0.5px solid var(--border)', padding:'10px 16px', background:'var(--bg-secondary)', flexShrink:0, maxHeight:180, overflowY:'auto' }}>
            <p style={{ fontSize:12, fontWeight:500, margin:'0 0 8px', color:'var(--text-secondary)' }}>
              EXTRACTED TRANSACTIONS ({extracted.length})
            </p>
            {extracted.slice(0,8).map((t,i)=>{
              const { icon, color } = CATEGORIES[t.category] || CATEGORIES['Other']
              return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'5px 0', borderBottom:'0.5px solid var(--border)', fontSize:12 }}>
                  <i className={`ti ${icon}`} style={{ fontSize:13, color, flexShrink:0 }} aria-hidden="true"/>
                  <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text-secondary)' }}>{t.desc}</span>
                  <span style={{ color:'var(--text-secondary)', flexShrink:0 }}>{t.date}</span>
                  <span style={{ fontWeight:500, color:t.amount>=0?'var(--teal)':'var(--coral)', flexShrink:0, minWidth:70, textAlign:'right' }}>{fd(t.amount)}</span>
                  <span style={{ fontSize:10, padding:'1px 6px', background:'var(--bg-card)', borderRadius:3, color, flexShrink:0 }}>{t.category}</span>
                </div>
              )
            })}
            {extracted.length > 8 && <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'6px 0 0', textAlign:'center' }}>+{extracted.length-8} more transactions</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Merge prompt modal ────────────────────────────────────────────────
function MergeModal({ info, onSelect, onClose }) {
  const options = [
    { id:'merge',   icon:'ti-git-merge', color:'var(--teal)',   label:'Merge', desc:`Keep all. Add ${info.newFiles} new files, keep ${info.existingFileCount} existing. Nothing deleted.` },
    { id:'replace', icon:'ti-refresh',   color:'var(--blue)',   label:'Replace changed', desc:'Update matching files. Old versions archived. Unique files kept.' },
    { id:'keep',    icon:'ti-shield',    color:'var(--green)',  label:'Keep existing', desc:'Only add truly new files. Skip any filename that already exists.' },
    { id:'new',     icon:'ti-copy',      color:'var(--purple)', label:'Save as new folder', desc:`Upload as "${info.existingFolder?.name} 2". Both folders coexist.` },
  ]
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.5rem', width:460 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:14 }}>
          <div style={{ width:38, height:38, borderRadius:'var(--radius-md)', background:'var(--amber-light)', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <i className="ti ti-folder-symlink" style={{ fontSize:19, color:'var(--amber)' }} aria-hidden="true"/>
          </div>
          <div>
            <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Folder conflict detected</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'2px 0 0' }}>"{info.existingFolder?.name}" · {info.matchPercent}% overlap</p>
          </div>
        </div>
        <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'10px 12px', marginBottom:14, display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, fontSize:12 }}>
          <div><span style={{ color:'var(--text-secondary)' }}>Existing:</span> <strong>{info.existingFileCount} files</strong></div>
          <div><span style={{ color:'var(--text-secondary)' }}>Incoming:</span> <strong>{info.newFileCount} files</strong></div>
          <div><span style={{ color:'var(--text-secondary)' }}>New files:</span> <strong style={{ color:'var(--teal)' }}>{info.newFiles}</strong></div>
          <div><span style={{ color:'var(--text-secondary)' }}>Matching:</span> <strong style={{ color:'var(--amber)' }}>{info.modifiedFiles}</strong></div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:14 }}>
          {options.map(opt=>(
            <div key={opt.id} onClick={()=>onSelect(opt.id)}
              style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 12px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', cursor:'pointer', border:'0.5px solid var(--border)', transition:'border-color 0.15s' }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=opt.color}
              onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
              <i className={`ti ${opt.icon}`} style={{ fontSize:17, color:opt.color, flexShrink:0, marginTop:1 }} aria-hidden="true"/>
              <div>
                <p style={{ fontSize:13, fontWeight:500, margin:'0 0 2px', color:opt.color }}>{opt.label}</p>
                <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0, lineHeight:1.5 }}>{opt.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <button onClick={onClose} style={{ width:'100%', fontSize:12, background:'none' }}>Cancel</button>
      </div>
    </div>
  )
}

// ── New folder modal ──────────────────────────────────────────────────
function NewFolderModal({ onConfirm, onClose }) {
  const [name, setName] = useState('')
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.5rem', width:340 }}>
        <p style={{ fontSize:14, fontWeight:500, margin:'0 0 14px' }}>New folder</p>
        <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&name&&onConfirm(name)} placeholder="Folder name" style={{ width:'100%', fontSize:13, padding:'8px 10px', marginBottom:12 }} autoFocus/>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ fontSize:12 }}>Cancel</button>
          <button onClick={()=>name&&onConfirm(name)} disabled={!name} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>Create</button>
        </div>
      </div>
    </div>
  )
}

// ── Folder tree node ──────────────────────────────────────────────────
function FolderNode({ folder, folders, files, selectedId, onSelect, depth=0 }) {
  const [open, setOpen] = useState(depth < 1)
  const children  = folders.filter(f => f.parentId === folder.id)
  const fileCount = files.filter(f => f.folderId === folder.id).length
  const tag = folder.tags?.property || folder.tags?.type

  return (
    <div>
      <div onClick={()=>{ setOpen(!open); onSelect(folder.id) }}
        style={{ display:'flex', alignItems:'center', gap:7, padding:'5px 8px', paddingLeft:(depth*14+8)+'px', borderRadius:'var(--radius-sm)', background:selectedId===folder.id?'var(--blue-light)':'transparent', cursor:'pointer', userSelect:'none' }}
        onMouseEnter={e=>{ if(selectedId!==folder.id) e.currentTarget.style.background='var(--bg-hover)' }}
        onMouseLeave={e=>{ if(selectedId!==folder.id) e.currentTarget.style.background='transparent' }}>
        {children.length>0
          ? <i className={`ti ${open?'ti-chevron-down':'ti-chevron-right'}`} style={{ fontSize:11, color:'var(--text-muted)', width:12, flexShrink:0 }} aria-hidden="true"/>
          : <span style={{ width:12, flexShrink:0 }}/>}
        <i className={`ti ${open&&fileCount>0?'ti-folder-open':'ti-folder'}`} style={{ fontSize:14, color:selectedId===folder.id?'var(--blue)':'var(--amber)', flexShrink:0 }} aria-hidden="true"/>
        <span style={{ fontSize:13, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:selectedId===folder.id?'var(--blue)':'var(--text-primary)', fontWeight:selectedId===folder.id?500:400 }}>{folder.name}</span>
        {tag && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:3, background:'var(--bg-card)', color:TAG_COLORS[tag]||'var(--text-muted)', flexShrink:0, textTransform:'capitalize' }}>{tag}</span>}
        {fileCount>0 && <span style={{ fontSize:10, color:'var(--text-muted)', flexShrink:0 }}>{fileCount}</span>}
      </div>
      {open && children.map(child=>(
        <FolderNode key={child.id} folder={child} folders={folders} files={files} selectedId={selectedId} onSelect={onSelect} depth={depth+1}/>
      ))}
    </div>
  )
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────
export default function DataVault({ onImportTransactions }) {
  const [meta, setMeta]             = useState({ folders:[], files:[] })
  const [loading, setLoading]       = useState(true)
  const [uploading, setUploading]   = useState(false)
  const [selectedFolderId, setSelectedFolderId] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)
  const [mergeInfo, setMergeInfo]   = useState(null)
  const [pendingUpload, setPendingUpload] = useState(null)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [dragOver, setDragOver]     = useState(false)
  const [search, setSearch]         = useState('')
  const [filterType, setFilterType] = useState('all')
  const [uploadError, setUploadError]   = useState(null)
  const [uploadSuccess, setUploadSuccess] = useState(null)
  const [sidebarWidth, setSidebarWidth] = useState(210)
  const folderRef  = useRef()
  const fileRef    = useRef()
  const dividerDrag = useRef(null)

  const onDividerMouseDown = (e) => {
    e.preventDefault()
    dividerDrag.current = { startX: e.clientX, startWidth: sidebarWidth }
    const onMove = (e) => {
      if (!dividerDrag.current) return
      const delta = e.clientX - dividerDrag.current.startX
      setSidebarWidth(Math.min(420, Math.max(140, dividerDrag.current.startWidth + delta)))
    }
    const onUp = () => {
      dividerDrag.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const load = async () => {
    try {
      const res = await axios.get(API)
      setMeta(res.data)
    } catch {
      setUploadError('Cannot connect to backend. Run npm start in the CaiShen root folder.')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const doUpload = useCallback(async (fileList, mergeMode='merge') => {
    setUploading(true); setUploadError(null); setUploadSuccess(null)
    try {
      const byFolder = {}
      for (const file of fileList) {
        const rel        = file.webkitRelativePath || file.name
        const parts      = rel.split('/')
        const folderPath = parts.length > 1 ? parts.slice(0,-1).join('/') : (selectedFolderId ? meta.folders.find(f=>f.id===selectedFolderId)?.path||'Uploads' : 'Uploads')
        if (!byFolder[folderPath]) byFolder[folderPath] = []
        byFolder[folderPath].push(file)
      }
      let total = 0
      for (const [folderPath, files] of Object.entries(byFolder)) {
        const fd = new FormData()
        fd.append('folderPath', folderPath)
        fd.append('mergeMode', mergeMode)
        files.forEach(f => fd.append('files', f))
        const res = await axios.post(`${API}/upload`, fd, { headers:{ 'Content-Type':'multipart/form-data' } })
        total += res.data.uploaded || 0
      }
      setUploadSuccess(`✓ ${total} files uploaded successfully`)
      await load()
    } catch (e) {
      setUploadError('Upload failed: ' + (e.response?.data?.error || e.message))
    }
    setUploading(false); setPendingUpload(null); setMergeInfo(null)
  }, [selectedFolderId, meta.folders])

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList)
    if (!files.length) return
    const firstPath  = files[0].webkitRelativePath || files[0].name
    const folderName = firstPath.split('/')[0]
    const fileNames  = files.map(f=>(f.webkitRelativePath||f.name).split('/').pop())
    try {
      const res = await axios.post(`${API}/check-duplicate`, { folderName, fileNames })
      if (res.data.isDuplicate || res.data.isNearDuplicate) {
        setMergeInfo(res.data); setPendingUpload(files)
      } else {
        doUpload(files, 'merge')
      }
    } catch { doUpload(files, 'merge') }
  }, [doUpload])

  const createFolder = async (name) => {
    try {
      const parentId = selectedFolderId || null
      await axios.post(`${API}/folder`, { name, parentId })
      setShowNewFolder(false)
      await load()
    } catch (e) { setUploadError('Could not create folder: ' + e.message) }
  }

  const deleteFile = async (fileId) => {
    if (!window.confirm('Delete this file?')) return
    try { await axios.delete(`${API}/file/${fileId}`); setPreviewFile(null); await load() }
    catch (e) { setUploadError('Delete failed: ' + e.message) }
  }

  const deleteFolder = async (folderId) => {
    if (!window.confirm('Delete folder? Files will be archived, not permanently removed.')) return
    try { await axios.delete(`${API}/folder/${folderId}`); setSelectedFolderId(null); await load() }
    catch (e) { setUploadError('Delete failed: ' + e.message) }
  }

  // Derived
  const rootFolders    = meta.folders.filter(f => !f.parentId)
  const selectedFolder = selectedFolderId ? meta.folders.find(f=>f.id===selectedFolderId) : null

  const visibleFiles = (selectedFolder
    ? meta.files.filter(f => f.folderId === selectedFolderId)
    : meta.files
  ).filter(f => {
    if (search && !f.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterType !== 'all' && f.type !== filterType) return false
    return true
  })

  const totalSize  = meta.files.reduce((s,f)=>s+(f.size||0),0)

  if (loading) return (
    <div style={{ textAlign:'center', padding:'4rem', color:'var(--text-secondary)' }}>
      <i className="ti ti-loader-2" style={{ fontSize:32, display:'block', marginBottom:12, animation:'spin 1s linear infinite' }} aria-hidden="true"/>
      Loading vault...
    </div>
  )

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 130px)' }}>
      {/* Toolbar */}
      <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:12, flexWrap:'wrap' }}>
        <button onClick={()=>folderRef.current.click()} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }} disabled={uploading}>
          <i className="ti ti-folder-up" aria-hidden="true"/> {uploading?'Uploading...':'Upload folder'}
        </button>
        <button onClick={()=>fileRef.current.click()} style={{ fontSize:12 }} disabled={uploading}>
          <i className="ti ti-upload" aria-hidden="true"/> Upload files
        </button>
        <button onClick={()=>setShowNewFolder(true)} style={{ fontSize:12 }}>
          <i className="ti ti-folder-plus" aria-hidden="true"/> New folder
        </button>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search files..." style={{ fontSize:12, padding:'6px 10px', flex:1, minWidth:140 }}/>
        <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={{ fontSize:12, padding:'6px 8px' }}>
          <option value="all">All types</option>
          {['pdf','csv','excel','image','word','text','other'].map(t=><option key={t} value={t}>{t.toUpperCase()}</option>)}
        </select>
        <span style={{ fontSize:11, color:'var(--text-secondary)' }}>{meta.files.length} files · {formatSize(totalSize)}</span>
        <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display:'none' }} onChange={e=>handleFiles(e.target.files)}/>
        <input ref={fileRef}   type="file" multiple          style={{ display:'none' }} onChange={e=>handleFiles(e.target.files)}/>
      </div>

      {uploadSuccess && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', marginBottom:10, fontSize:13, color:'var(--teal)', border:'0.5px solid var(--teal)' }}>
          <i className="ti ti-circle-check" aria-hidden="true"/> {uploadSuccess}
          <button onClick={()=>setUploadSuccess(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--teal)', padding:0 }}>✕</button>
        </div>
      )}
      {uploadError && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', marginBottom:10, fontSize:13, color:'var(--coral)', border:'0.5px solid var(--coral)' }}>
          <i className="ti ti-alert-circle" aria-hidden="true"/> {uploadError}
          <button onClick={()=>setUploadError(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--coral)', padding:0 }}>✕</button>
        </div>
      )}

      {/* Main layout */}
      <div style={{ display:'flex', flex:1, minHeight:0, gap:0 }}>
        {/* Folder tree */}
        <div
          onDragOver={e=>{e.preventDefault();setDragOver(true)}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files)}}
          style={{ width:sidebarWidth, flexShrink:0, background:dragOver?'var(--blue-light)':'var(--bg-card)', border:`0.5px solid ${dragOver?'var(--blue)':'var(--border)'}`, borderRadius:'var(--radius-lg)', overflow:'auto', padding:'8px 4px', transition:'background 0.15s, border-color 0.15s' }}>
          <div style={{ padding:'4px 8px 8px', borderBottom:'0.5px solid var(--border)', marginBottom:4 }}>
            <p style={{ fontSize:10, fontWeight:500, color:'var(--text-secondary)', margin:0, textTransform:'uppercase', letterSpacing:'0.5px' }}>Vault</p>
          </div>
          <div onClick={()=>setSelectedFolderId(null)}
            style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:'var(--radius-sm)', background:!selectedFolderId?'var(--blue-light)':'transparent', cursor:'pointer', marginBottom:2 }}>
            <i className="ti ti-home" style={{ fontSize:13, color:!selectedFolderId?'var(--blue)':'var(--text-secondary)' }} aria-hidden="true"/>
            <span style={{ fontSize:13, color:!selectedFolderId?'var(--blue)':'var(--text-secondary)', fontWeight:!selectedFolderId?500:400 }}>All files</span>
            <span style={{ fontSize:10, color:'var(--text-muted)', marginLeft:'auto' }}>{meta.files.length}</span>
          </div>
          {rootFolders.map(folder=>(
            <FolderNode key={folder.id} folder={folder} folders={meta.folders} files={meta.files} selectedId={selectedFolderId} onSelect={setSelectedFolderId} depth={0}/>
          ))}
          {rootFolders.length===0 && (
            <div style={{ padding:'20px 8px', textAlign:'center', fontSize:12, color:'var(--text-muted)' }}>
              <i className="ti ti-folder-open" style={{ fontSize:22, display:'block', marginBottom:6 }} aria-hidden="true"/>
              Drop a folder or click Upload
            </div>
          )}
        </div>

        {/* Drag-to-resize divider */}
        <div
          onMouseDown={onDividerMouseDown}
          title="Drag to resize"
          style={{ width:8, flexShrink:0, cursor:'col-resize', display:'flex', alignItems:'center', justifyContent:'center', position:'relative', zIndex:1 }}
          onMouseEnter={e=>e.currentTarget.querySelector('span').style.background='var(--blue)'}
          onMouseLeave={e=>e.currentTarget.querySelector('span').style.background='var(--border)'}>
          <span style={{ width:2, height:'40px', borderRadius:2, background:'var(--border)', transition:'background 0.15s', pointerEvents:'none' }}/>
        </div>

        {/* File grid */}
        <div style={{ flex:1, minWidth:0, background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'10px 16px', borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', gap:10 }}>
            <i className={`ti ${selectedFolder?'ti-folder-open':'ti-files'}`} style={{ fontSize:14, color:'var(--amber)' }} aria-hidden="true"/>
            <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{selectedFolder?.name||'All files'}</p>
            <span style={{ fontSize:11, color:'var(--text-secondary)' }}>{visibleFiles.length} files</span>
            {selectedFolder && (
              <button onClick={()=>deleteFolder(selectedFolder.id)} style={{ marginLeft:'auto', fontSize:11, color:'var(--coral)', borderColor:'var(--coral)', background:'var(--coral-light)', padding:'3px 8px' }}>
                <i className="ti ti-trash" aria-hidden="true"/> Delete folder
              </button>
            )}
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'12px' }}>
            {visibleFiles.length===0 ? (
              <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-secondary)' }}>
                <i className="ti ti-file-off" style={{ fontSize:36, display:'block', marginBottom:10 }} aria-hidden="true"/>
                <p style={{ fontSize:13, margin:0 }}>{search?'No files match your search':'This folder is empty — upload files or drag a folder here'}</p>
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))', gap:8 }}>
                {visibleFiles.map(file=>{
                  const { icon, color } = FILE_ICONS[file.type]||FILE_ICONS.other
                  const tag = file.tags?.property||file.tags?.type
                  return (
                    <div key={file.id} onClick={()=>setPreviewFile(file)}
                      style={{ background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', padding:'12px 10px', cursor:'pointer', transition:'all 0.15s', textAlign:'center' }}
                      onMouseEnter={e=>e.currentTarget.style.borderColor=color}
                      onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                      <i className={`ti ${icon}`} style={{ fontSize:30, color, display:'block', marginBottom:8 }} aria-hidden="true"/>
                      <p style={{ fontSize:11, fontWeight:500, margin:'0 0 3px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={file.name}>{file.name}</p>
                      <p style={{ fontSize:10, color:'var(--text-muted)', margin:'0 0 5px' }}>{formatSize(file.size)}</p>
                      {tag && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:3, background:'var(--bg-card)', color:TAG_COLORS[tag]||'var(--text-muted)', textTransform:'capitalize' }}>{tag}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={()=>setPreviewFile(null)}
          onImportTransactions={txs=>{ onImportTransactions?.(txs); setPreviewFile(null) }}
        />
      )}

      {mergeInfo && pendingUpload && (
        <MergeModal info={mergeInfo} onSelect={mode=>doUpload(pendingUpload,mode)} onClose={()=>{ setMergeInfo(null); setPendingUpload(null) }}/>
      )}

      {showNewFolder && <NewFolderModal onConfirm={createFolder} onClose={()=>setShowNewFolder(false)}/>}

      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}