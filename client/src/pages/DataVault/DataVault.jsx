import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const API = '/api/vault'

const FILE_ICONS = {
  pdf:   { icon:'ti-file-type-pdf',   color:'var(--coral)'  },
  csv:   { icon:'ti-file-spreadsheet', color:'var(--green)' },
  excel: { icon:'ti-file-spreadsheet', color:'var(--green)' },
  image: { icon:'ti-photo',            color:'var(--blue)'  },
  word:  { icon:'ti-file-type-doc',    color:'var(--blue)'  },
  text:  { icon:'ti-file-text',        color:'var(--text-secondary)' },
  other: { icon:'ti-file',             color:'var(--text-secondary)' },
}

// Folder-tag colors. Type tags get fixed colors; property tags (keyed by the
// user's real property id) get a stable hashed color — no hardcoded properties.
const TAG_TYPE_COLORS = { tax:'var(--pink)', personal:'var(--green)', business:'var(--blue)' }
const TAG_PALETTE = ['var(--blue)','var(--teal)','var(--purple)','var(--amber)','var(--coral)','var(--pink)','var(--green)']
const tagColor = (tag) => TAG_TYPE_COLORS[tag] ||
  TAG_PALETTE[[...String(tag||'')].reduce((h,c)=>h+c.charCodeAt(0),0) % TAG_PALETTE.length]

// Sort folders: 4-digit year names → descending (newest first); others → alphabetical
const sortFoldersByDate = (arr) => [...arr].sort((a, b) => {
  const aNum = /^\d{4}$/.test(a.name) ? parseInt(a.name) : NaN
  const bNum = /^\d{4}$/.test(b.name) ? parseInt(b.name) : NaN
  if (!isNaN(aNum) && !isNaN(bNum)) return bNum - aNum
  if (!isNaN(aNum)) return -1   // year folders before non-year
  if (!isNaN(bNum)) return 1
  return a.name.localeCompare(b.name)
})

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

// ── PDF preview — rendered via PDF.js (no browser plugin needed) ─────
function PDFPage({ pdf, pageNum, scale }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    let renderTask = null
    let cancelled  = false

    ;(async () => {
      try {
        const page     = await pdf.getPage(pageNum)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const canvas   = canvasRef.current
        if (!canvas || cancelled) return
        canvas.width  = viewport.width
        canvas.height = viewport.height
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport })
        await renderTask.promise
      } catch (e) {
        if (!cancelled) console.error('PDF render error page', pageNum, e)
      }
    })()

    return () => { cancelled = true; renderTask?.cancel() }
  }, [pdf, pageNum, scale])

  return (
    <canvas ref={canvasRef} style={{ display:'block', maxWidth:'100%', boxShadow:'0 2px 12px rgba(0,0,0,0.4)', borderRadius:2 }}/>
  )
}

function PDFPreview({ url, onTransactions }) {
  const [pdf, setPdf]         = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale]     = useState(1.4)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  useEffect(() => {
    let cancelled = false
    const token = localStorage.getItem('caishen_token') || ''

    const load = async () => {
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.arrayBuffer()
        if (cancelled) return

        const loaded = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) return
        setPdf(loaded)
        setNumPages(loaded.numPages)
        setLoading(false)

        // Background text extraction for transaction import
        const blob = new Blob([data], { type: 'application/pdf' })
        const fd = new FormData()
        fd.append('file', blob, 'document.pdf')
        axios.post('/api/pdf-render', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
          .then(r => { const txs = parseTransactionsFromText(r.data.text || ''); if (txs.length) onTransactions?.(txs) })
          .catch(() => {})
      } catch (e) {
        if (!cancelled) { setError(e.message); setLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
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
      <p style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:16 }}>Could not load PDF: {error}</p>
    </div>
  )

  return (
    <>
      {/* Toolbar */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 16px', background:'var(--bg-secondary)', borderBottom:'0.5px solid var(--border)', flexShrink:0 }}>
        <span style={{ fontSize:12, color:'var(--text-secondary)' }}>{numPages} page{numPages !== 1 ? 's' : ''}</span>
        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6 }}>
          <button onClick={() => setScale(s => Math.max(0.6, +(s - 0.2).toFixed(1)))}
            style={{ fontSize:16, background:'none', border:'0.5px solid var(--border)', borderRadius:4, width:28, height:28, cursor:'pointer', color:'var(--text-secondary)', lineHeight:1 }}>−</button>
          <span style={{ fontSize:12, color:'var(--text-secondary)', minWidth:38, textAlign:'center' }}>{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(s => Math.min(3, +(s + 0.2).toFixed(1)))}
            style={{ fontSize:16, background:'none', border:'0.5px solid var(--border)', borderRadius:4, width:28, height:28, cursor:'pointer', color:'var(--text-secondary)', lineHeight:1 }}>+</button>
        </div>
      </div>
      {/* Pages */}
      <div style={{ flex:1, overflowY:'auto', background:'#525659', padding:'20px 16px', display:'flex', flexDirection:'column', gap:16, alignItems:'center' }}>
        {Array.from({ length: numPages }, (_, i) => (
          <PDFPage key={i} pdf={pdf} pageNum={i + 1} scale={scale} />
        ))}
      </div>
    </>
  )
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

// ── File preview modal ────────────────────────────────────────────────
function FilePreviewModal({ file, accounts = [], onClose, onTransactionsChanged, onVaultChanged }) {
  const [parseState, setParseState]     = useState('idle') // idle | loading | done | error
  const [parseResult, setParseResult]   = useState(null)
  const [parseError, setParseError]     = useState(null)
  const [detected, setDetected]         = useState(null)   // metadata returned by parse-statement-local
  const [selAccountId, setSelAccountId] = useState(null)
  // Import flow: ready → previewing → reviewing (if conflicts) → importing → done
  const [importStep, setImportStep]     = useState('ready')
  const [preview, setPreview]           = useState(null)   // { new, duplicates, conflicts, conflictDetails }
  const [importResult, setImportResult] = useState(null)
  const fileUrl = `${API}/file/${file.id}`
  const isPdf   = file.type === 'pdf'

  // Called when the PDF viewer's background extraction finds transactions
  const handleBackgroundTxs = (txs) => {
    if (parseState !== 'idle') return // don't overwrite a manual extraction in progress
    if (!txs.length) return
    setParseResult({ transactions: txs, count: txs.length, accountId: accounts[0]?.id ?? null })
    setSelAccountId(accounts[0]?.id ?? null)
    setParseState('done')
  }

  // Kick off local (no-AI) extraction
  const extract = async () => {
    setParseState('loading')
    setParseError(null)
    setParseResult(null)
    setDetected(null)
    setImportResult(null)
    setPreview(null)
    setImportStep('ready')
    try {
      const res = await axios.post(`${API}/parse-statement-local/${file.id}`)
      if (!res.data.transactions?.length) {
        setParseError('No transactions found. The PDF may use an unsupported layout — try importing via CSV export from your bank instead.')
        setParseState('error')
        return
      }
      setDetected(res.data)
      setParseResult(res.data)
      setSelAccountId(res.data.accountId || (accounts[0]?.id ?? null))
      setParseState('done')
      // If the file was auto-organized into a new folder, refresh the vault list
      if (res.data.organized) onVaultChanged?.()
      // If a new account was auto-created, refresh the accounts list in App
      if (res.data.autoCreated) onTransactionsChanged?.()
    } catch (e) {
      setParseError(e.response?.data?.error || e.message)
      setParseState('error')
    }
  }

  // Step 1: preview (dry-run) to detect duplicates / conflicts
  const startImport = async () => {
    if (!parseResult?.transactions?.length) return
    const accountId = selAccountId || parseResult.accountId
    if (!accountId) { setParseError('Select an account to import into.'); return }
    setImportStep('previewing')
    setParseError(null)
    try {
      const res = await axios.post('/api/import-history/preview', {
        transactions: parseResult.transactions.map(t => ({ ...t, account: accountId })),
      })
      const p = res.data
      setPreview(p)
      // If no conflicts, skip review and import immediately
      if (p.conflicts === 0) {
        await doImport(accountId, parseResult.transactions, false)
      } else {
        setImportStep('reviewing')
      }
    } catch (e) {
      setParseError(e.response?.data?.error || e.message)
      setImportStep('ready')
    }
  }

  // Step 2: actual import — skipConflicts drops conflicting rows, keepAll keeps them
  const doImport = async (accountId, transactions, skipConflicts) => {
    const acctId = accountId || selAccountId || parseResult.accountId
    if (!acctId) return
    setImportStep('importing')
    try {
      let txsToImport = transactions || parseResult.transactions
      if (skipConflicts && preview?.conflictDetails?.length) {
        // Remove conflicting transactions from the batch
        const conflictKeys = new Set(
          preview.conflictDetails.map(c =>
            `${c.incoming.date}|${String(c.incoming.desc||'').toLowerCase().slice(0,20)}`
          )
        )
        txsToImport = txsToImport.filter(t =>
          !conflictKeys.has(`${t.date}|${String(t.desc||'').toLowerCase().slice(0,20)}`)
        )
      }
      const res = await axios.post('/api/import-history', {
        transactions: txsToImport.map(t => ({ ...t, account: acctId })),
        accountId: acctId,
      })
      setImportResult(res.data)
      setImportStep('done')
      onTransactionsChanged?.()
    } catch (e) {
      setParseError(e.response?.data?.error || e.message)
      setImportStep('ready')
    }
  }

  const renderContent = () => {
    switch (file.type) {
      case 'pdf':   return <PDFPreview url={fileUrl} onTransactions={handleBackgroundTxs}/>
      case 'csv':   return <CSVPreview url={fileUrl}/>
      case 'excel': return <ExcelPreview url={fileUrl}/>
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

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', flexShrink:0 }}>
          <i className={`ti ${FILE_ICONS[file.type]?.icon||'ti-file'}`} style={{ fontSize:18, color:FILE_ICONS[file.type]?.color }} aria-hidden="true"/>
          <div style={{ flex:1, minWidth:0 }}>
            <p style={{ fontSize:14, fontWeight:500, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{file.name}</p>
            <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'1px 0 0' }}>{file.folderPath} · {formatSize(file.size)} · {new Date(file.createdAt).toLocaleDateString()}</p>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0 }}>
            {/* Extract button — local parser, no AI required */}
            {isPdf && (parseState === 'idle' || parseState === 'error') && (
              <button onClick={extract}
                style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
                <i className="ti ti-table-import" aria-hidden="true"/>
                {parseState === 'error' ? ' Retry Extract' : ' Extract Transactions'}
              </button>
            )}
            {isPdf && parseState === 'loading' && (
              <span style={{ fontSize:12, color:'var(--teal)', display:'flex', alignItems:'center', gap:5 }}>
                <i className="ti ti-loader-2" style={{ animation:'spin 1s linear infinite' }} aria-hidden="true"/>
                Reading statement…
              </span>
            )}
            {isPdf && parseState === 'done' && importStep === 'ready' && (
              <span style={{ fontSize:12, color:'var(--teal)' }}>
                <i className="ti ti-circle-check" aria-hidden="true"/> {parseResult.count} transactions found
              </span>
            )}
            {isPdf && parseState === 'done' && importStep === 'reviewing' && preview && (
              <span style={{ fontSize:12, color:'var(--coral)', display:'flex', alignItems:'center', gap:5 }}>
                <i className="ti ti-alert-triangle" aria-hidden="true"/> {preview.conflicts} conflict{preview.conflicts !== 1 ? 's' : ''} · review below
              </span>
            )}
            {isPdf && importStep === 'done' && importResult && (
              <span style={{ fontSize:12, color:'var(--teal)', display:'flex', alignItems:'center', gap:5 }}>
                <i className="ti ti-circle-check" aria-hidden="true"/> {importResult.imported} imported · {importResult.skipped} skipped
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

        {/* Extraction results panel */}
        {isPdf && (parseState === 'done' || parseState === 'error') && (
          <div style={{ borderTop:'0.5px solid var(--border)', padding:'12px 16px', background:'var(--bg-secondary)', flexShrink:0 }}>
            {parseError && (
              <p style={{ fontSize:12, color:'var(--coral)', margin:'0 0 8px' }}>
                <i className="ti ti-alert-circle" aria-hidden="true"/> {parseError}
              </p>
            )}

            {parseState === 'done' && importStep === 'done' && importResult && (
              <p style={{ fontSize:12, color:'var(--teal)', margin:0, display:'flex', alignItems:'center', gap:6 }}>
                <i className="ti ti-circle-check" aria-hidden="true"/>
                <strong>{importResult.imported}</strong> imported · <strong>{importResult.skipped}</strong> exact duplicates skipped
              </p>
            )}

            {parseState === 'done' && importStep !== 'done' && (
              <>
                {/* Auto-detected metadata badge */}
                {detected && (detected.institution || detected.year) && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center', marginBottom:10, padding:'6px 10px', background:'var(--bg-card)', borderRadius:'var(--radius-sm)', border:'0.5px solid var(--border)', fontSize:11 }}>
                    <i className="ti ti-scan" style={{ fontSize:12, color:'var(--text-muted)', flexShrink:0 }} aria-hidden="true"/>
                    {detected.institution && (
                      <span style={{ color:'var(--text-primary)', fontWeight:500 }}>{detected.institution}</span>
                    )}
                    {detected.accountName && (
                      <span style={{ color:'var(--text-secondary)' }}>
                        {detected.accountName}{detected.last4 ? ` ••••${detected.last4}` : ''}
                      </span>
                    )}
                    {detected.year && detected.month && (
                      <span style={{ color:'var(--text-secondary)' }}>
                        {new Date(detected.year, detected.month - 1).toLocaleString('en-US', { month:'long', year:'numeric' })}
                      </span>
                    )}
                    {detected.autoCreated && (
                      <span style={{ padding:'1px 7px', borderRadius:3, background:'var(--amber-light)', color:'var(--amber)', border:'0.5px solid var(--amber)', fontWeight:500 }}>
                        <i className="ti ti-user-plus" style={{ fontSize:10 }} aria-hidden="true"/> New account created
                      </span>
                    )}
                    {!detected.autoCreated && detected.accountId && (
                      <span style={{ padding:'1px 7px', borderRadius:3, background:'var(--teal-light)', color:'var(--teal)', border:'0.5px solid var(--teal)', fontWeight:500 }}>
                        <i className="ti ti-link" style={{ fontSize:10 }} aria-hidden="true"/> Matched
                      </span>
                    )}
                    {detected.organized && detected.newFolderPath && (
                      <span style={{ padding:'1px 7px', borderRadius:3, background:'var(--blue-light)', color:'var(--blue)', border:'0.5px solid var(--blue)', fontWeight:500 }} title={detected.newFolderPath}>
                        <i className="ti ti-folder-check" style={{ fontSize:10 }} aria-hidden="true"/> Auto-filed
                      </span>
                    )}
                  </div>
                )}

                {/* Transaction preview rows */}
                <div style={{ maxHeight:140, overflowY:'auto', marginBottom:10 }}>
                  {parseResult.transactions.slice(0, 8).map((t, i) => (
                    <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 0', borderBottom:'0.5px solid var(--border)', fontSize:12 }}>
                      <span style={{ color:'var(--text-secondary)', minWidth:78, flexShrink:0 }}>{t.date}</span>
                      <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text-primary)' }}>{t.desc}</span>
                      <span style={{ fontWeight:500, color:t.amount>=0?'var(--teal)':'var(--coral)', flexShrink:0, minWidth:80, textAlign:'right' }}>{fd(t.amount)}</span>
                    </div>
                  ))}
                  {parseResult.count > 8 && (
                    <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'5px 0 0', textAlign:'center' }}>+ {parseResult.count - 8} more</p>
                  )}
                </div>

                {/* Conflict review panel */}
                {importStep === 'reviewing' && preview && preview.conflicts > 0 && (
                  <div style={{ border:'0.5px solid var(--coral)', borderRadius:'var(--radius-sm)', padding:'10px 12px', marginBottom:10, background:'rgba(185,28,28,0.06)' }}>
                    <p style={{ fontSize:12, color:'var(--coral)', margin:'0 0 8px', fontWeight:500, display:'flex', alignItems:'center', gap:6 }}>
                      <i className="ti ti-alert-triangle" aria-hidden="true"/>
                      {preview.conflicts} conflicting transaction{preview.conflicts !== 1 ? 's' : ''} — same date & description, different amounts
                    </p>
                    {preview.conflictDetails.slice(0, 5).map((c, i) => (
                      <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, marginBottom:6, padding:'6px 8px', background:'var(--bg-card)', borderRadius:'var(--radius-sm)', border:'0.5px solid var(--border)' }}>
                        <div>
                          <p style={{ fontSize:10, color:'var(--text-muted)', margin:'0 0 2px', textTransform:'uppercase', letterSpacing:'0.5px' }}>Incoming</p>
                          <p style={{ fontSize:11, margin:0, color:'var(--text-primary)' }}>{c.incoming.date} · {c.incoming.desc?.slice(0,30)}</p>
                          <p style={{ fontSize:12, fontWeight:500, color:'var(--coral)', margin:0 }}>{fd(c.incoming.amount)}</p>
                        </div>
                        <div>
                          <p style={{ fontSize:10, color:'var(--text-muted)', margin:'0 0 2px', textTransform:'uppercase', letterSpacing:'0.5px' }}>Existing</p>
                          <p style={{ fontSize:11, margin:0, color:'var(--text-secondary)' }}>{c.existing.date} · {c.existing.desc?.slice(0,30)}</p>
                          <p style={{ fontSize:12, fontWeight:500, color:'var(--text-secondary)', margin:0 }}>{fd(c.existing.amount)}</p>
                        </div>
                      </div>
                    ))}
                    {preview.conflicts > 5 && (
                      <p style={{ fontSize:11, color:'var(--text-muted)', margin:'4px 0 0', textAlign:'center' }}>+ {preview.conflicts - 5} more conflicts</p>
                    )}
                    {preview.duplicates > 0 && (
                      <p style={{ fontSize:11, color:'var(--amber)', margin:'8px 0 0', display:'flex', alignItems:'center', gap:5 }}>
                        <i className="ti ti-info-circle" aria-hidden="true"/>
                        {preview.duplicates} exact duplicate{preview.duplicates !== 1 ? 's' : ''} will be skipped automatically
                      </p>
                    )}
                    <div style={{ display:'flex', gap:8, marginTop:10 }}>
                      <button
                        onClick={() => doImport(null, null, true)}
                        style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)', flex:1 }}>
                        <i className="ti ti-shield-check" aria-hidden="true"/> Skip conflicts · import {preview.new} new
                      </button>
                      <button
                        onClick={() => doImport(null, null, false)}
                        style={{ fontSize:12, background:'var(--coral-light)', color:'var(--coral)', borderColor:'var(--coral)', flex:1 }}>
                        <i className="ti ti-database-import" aria-hidden="true"/> Import everything anyway
                      </button>
                    </div>
                  </div>
                )}

                {/* Normal ready / previewing state */}
                {(importStep === 'ready' || importStep === 'previewing') && (
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <select
                      value={selAccountId || ''}
                      onChange={e => setSelAccountId(e.target.value)}
                      style={{ flex:1, padding:'6px 8px', background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:12 }}>
                      {!selAccountId && <option value="">— Select account —</option>}
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name}{a.institution ? ` (${a.institution})` : ''}</option>
                      ))}
                    </select>
                    <button onClick={startImport} disabled={importStep === 'previewing' || !selAccountId}
                      style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)', whiteSpace:'nowrap' }}>
                      {importStep === 'previewing'
                        ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Checking…</>
                        : <><i className="ti ti-database-import" aria-hidden="true"/> Import {parseResult.count} transactions</>}
                    </button>
                  </div>
                )}

                {importStep === 'importing' && (
                  <p style={{ fontSize:12, color:'var(--teal)', display:'flex', alignItems:'center', gap:6, margin:0 }}>
                    <i className="ti ti-loader-2 spin" aria-hidden="true"/> Importing…
                  </p>
                )}
              </>
            )}
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
// dataTransfer MIME marking an INTERNAL move (file/folder → folder), so it's
// distinguishable from an OS file drop (which uploads). Payload: { kind, id }.
const MOVE_MIME = 'application/x-caishen-move'

function FolderNode({ folder, folders, files, selectedId, onSelect, onMoveItem, depth=0 }) {
  const [open, setOpen] = useState(depth < 1)
  const [dropOver, setDropOver] = useState(false)
  const children  = folders.filter(f => f.parentId === folder.id)
  const fileCount = files.filter(f => f.folderId === folder.id).length
  const tag = folder.tags?.property || folder.tags?.type
  const bg = dropOver ? 'var(--blue-light)' : (selectedId===folder.id ? 'var(--blue-light)' : 'transparent')

  return (
    <div>
      <div
        draggable
        onDragStart={e=>{ e.stopPropagation(); e.dataTransfer.setData(MOVE_MIME, JSON.stringify({ kind:'folder', id:folder.id })); e.dataTransfer.effectAllowed='move' }}
        onDragOver={e=>{ if(e.dataTransfer.types.includes(MOVE_MIME)){ e.preventDefault(); setDropOver(true) } }}
        onDragLeave={()=>setDropOver(false)}
        onDrop={e=>{ const r=e.dataTransfer.getData(MOVE_MIME); if(r){ e.preventDefault(); e.stopPropagation(); setDropOver(false); try{ onMoveItem(JSON.parse(r), folder.id) }catch{} } }}
        onClick={()=>{ setOpen(!open); onSelect(folder.id) }}
        title={folder.name}
        style={{ display:'flex', alignItems:'center', gap:7, padding:'5px 8px', paddingLeft:(depth*14+8)+'px', borderRadius:'var(--radius-sm)', background:bg, outline:dropOver?'1px dashed var(--blue)':'none', cursor:'pointer', userSelect:'none' }}
        onMouseEnter={e=>{ if(selectedId!==folder.id && !dropOver) e.currentTarget.style.background='var(--bg-hover)' }}
        onMouseLeave={e=>{ if(selectedId!==folder.id && !dropOver) e.currentTarget.style.background='transparent' }}>
        {children.length>0
          ? <i className={`ti ${open?'ti-chevron-down':'ti-chevron-right'}`} style={{ fontSize:11, color:'var(--text-muted)', width:12, flexShrink:0 }} aria-hidden="true"/>
          : <span style={{ width:12, flexShrink:0 }}/>}
        <i className={`ti ${open&&fileCount>0?'ti-folder-open':'ti-folder'}`} style={{ fontSize:14, color:selectedId===folder.id?'var(--blue)':'var(--amber)', flexShrink:0 }} aria-hidden="true"/>
        <span style={{ fontSize:13, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:selectedId===folder.id?'var(--blue)':'var(--text-primary)', fontWeight:selectedId===folder.id?500:400 }}>{folder.name}</span>
        {tag && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:3, background:'var(--bg-card)', color:tagColor(tag), flexShrink:0, textTransform:'capitalize' }}>{tag}</span>}
        {fileCount>0 && <span style={{ fontSize:10, color:'var(--text-muted)', flexShrink:0 }}>{fileCount}</span>}
      </div>
      {open && sortFoldersByDate(children).map(child=>(
        <FolderNode key={child.id} folder={child} folders={folders} files={files} selectedId={selectedId} onSelect={onSelect} onMoveItem={onMoveItem} depth={depth+1}/>
      ))}
    </div>
  )
}

// ── Chase CSV import helpers ──────────────────────────────────────────
const CHASE_CAT_MAP = {
  'food & drink':       'Dining',
  'restaurants':        'Dining',
  'groceries':          'Groceries',
  'supermarkets':       'Groceries',
  'gas':                'Transport',
  'automotive':         'Transport',
  'travel':             'Travel',
  'airlines':           'Travel',
  'hotels & resorts':   'Travel',
  'entertainment':      'Entertainment',
  'shopping':           'Shopping',
  'merchandise':        'Shopping',
  'health & wellness':  'Health',
  'medical':            'Health',
  'utilities':          'Utilities',
  'bills & utilities':  'Utilities',
  'home':               'Repairs',
  'insurance':          'Insurance',
  'mortgage & rent':    'Mortgage',
  'personal':           'Other',
  'education':          'Other',
  'fees & charges':     'Other',
  'business services':  'Other',
  'payments':           'Other',
  'transfer':           'Other',
}

function parseCSVLine(line) {
  const fields = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { inQ = !inQ }
    else if (c === ',' && !inQ) { fields.push(cur.trim()); cur = '' }
    else cur += c
  }
  fields.push(cur.trim())
  return fields
}

function parseHistoryCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return null
  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase())
  const dateIdx = headers.findIndex(h => ['date','transaction date','posting date'].includes(h))
  const descIdx = headers.findIndex(h => ['description','merchant','name','details'].some(k => h.includes(k)))
  const amtIdx  = headers.findIndex(h => ['amount','debit'].some(k => h.includes(k)))
  const catIdx  = headers.findIndex(h => h.includes('category') || h === 'type')
  if (dateIdx === -1 || descIdx === -1 || amtIdx === -1) return null
  const txs = []
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i])
    const dateRaw = cols[dateIdx] || ''
    const desc    = cols[descIdx] || ''
    const amtRaw  = cols[amtIdx]  || '0'
    const catRaw  = catIdx >= 0 ? (cols[catIdx] || '') : ''
    let amount    = parseFloat(amtRaw.replace(/[$,]/g,''))
    if (isNaN(amount)) continue
    // Normalize date to YYYY-MM-DD
    const parts = dateRaw.split('/')
    let date = dateRaw
    if (parts.length === 3) {
      const [m, d, y] = parts
      date = `${y.length === 2 ? '20'+y : y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
    }
    // Categorize
    const chaseCat = CHASE_CAT_MAP[catRaw.toLowerCase().trim()] || null
    const category = chaseCat || categorize(desc)
    txs.push({ date, desc: desc.replace(/"/g,''), amount, category })
  }
  return txs.length ? txs : null
}

// ── Import CSV History modal ───────────────────────────────────────────
function ImportHistoryModal({ accounts, onClose, onImported }) {
  const allAccounts = accounts || []
  const [file, setFile]               = useState(null)
  const [parsed, setParsed]           = useState(null)
  const [parseError, setParseError]   = useState(null)
  const [accountId, setAccountId]     = useState(allAccounts[0]?.id || '__new__')
  const [importing, setImporting]     = useState(false)
  const [result, setResult]           = useState(null)
  const [newAcctName, setNewAcctName] = useState('')
  const [newAcctInst, setNewAcctInst] = useState('')
  const [creatingAcct, setCreatingAcct] = useState(false)
  const fileRef2 = useRef()

  const handleFile = async (f) => {
    setFile(f); setParseError(null); setParsed(null)
    const text = await f.text()
    const txs  = parseHistoryCSV(text)
    if (!txs) { setParseError('Could not parse CSV. Make sure it has Date, Description, and Amount columns.'); return }
    setParsed(txs)
  }

  const doImport = async () => {
    if (!parsed) return
    setImporting(true)
    setParseError(null)
    try {
      let targetId = accountId
      if (accountId === '__new__') {
        if (!newAcctName.trim()) { setParseError('Enter an account name.'); setImporting(false); return }
        setCreatingAcct(true)
        const r = await axios.post('/api/accounts', {
          name: newAcctName.trim(),
          institution: newAcctInst.trim() || newAcctName.trim(),
          type: 'depository',
          subtype: 'checking',
        })
        targetId = r.data.id
        setCreatingAcct(false)
      }
      const res = await axios.post('/api/import-history', { transactions: parsed, accountId: targetId })
      setResult(res.data)
      onImported?.(res.data)
    } catch (e) {
      setParseError(e.response?.data?.error || e.message)
      setCreatingAcct(false)
    }
    setImporting(false)
  }

  const showNewAcctFields = accountId === '__new__'

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div className="card" style={{ maxWidth:520, width:'92%', padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
          <p style={{ fontSize:16, fontWeight:600, margin:0 }}>Import CSV History</p>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-secondary)', padding:0, fontSize:18, cursor:'pointer' }}>✕</button>
        </div>

        {result ? (
          <div>
            <div style={{ padding:'14px 16px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', border:'0.5px solid var(--teal)', marginBottom:18 }}>
              <p style={{ margin:0, fontSize:14, color:'var(--teal)', fontWeight:500 }}>
                <i className="ti ti-circle-check" aria-hidden="true"/> Import complete
              </p>
              <p style={{ margin:'6px 0 0', fontSize:13, color:'var(--teal)' }}>
                {result.imported} transactions added · {result.skipped} duplicates skipped
              </p>
            </div>
            <button onClick={onClose} style={{ width:'100%' }}>Done</button>
          </div>
        ) : (
          <>
            <div style={{ padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)', borderLeft:'3px solid var(--blue)', fontSize:12, color:'var(--text-secondary)', lineHeight:1.7, marginBottom:18 }}>
              <strong style={{ color:'var(--text-primary)' }}>How to export from Chase:</strong><br/>
              1. Go to <a href="https://www.chase.com" target="_blank" rel="noreferrer" style={{ color:'var(--blue)' }}>chase.com</a> → Account → Statements &amp; Activity<br/>
              2. Set your date range and click <em>Download account activity</em><br/>
              3. Choose <strong>CSV</strong> format and download<br/>
              4. Upload the file below — deduplication is automatic
            </div>

            <div style={{ marginBottom:14 }}>
              <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px' }}>Select account to import into</p>
              <select value={accountId} onChange={e => setAccountId(e.target.value)}
                style={{ width:'100%', padding:'8px 10px', background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:13, marginBottom: showNewAcctFields ? 8 : 0 }}>
                {allAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.last4 ? ` ···${a.last4}` : ''}{a.institution ? ` (${a.institution})` : ''}</option>
                ))}
                <option value="__new__">+ Create new account…</option>
              </select>
              {showNewAcctFields && (
                <div style={{ display:'flex', gap:8 }}>
                  <input value={newAcctName} onChange={e => setNewAcctName(e.target.value)} placeholder="Account name (e.g. Chase Checking)"
                    style={{ flex:2, padding:'7px 10px', background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:13 }}/>
                  <input value={newAcctInst} onChange={e => setNewAcctInst(e.target.value)} placeholder="Institution (optional)"
                    style={{ flex:1, padding:'7px 10px', background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:13 }}/>
                </div>
              )}
            </div>

            <div
              onClick={() => fileRef2.current?.click()}
              style={{ border:'1.5px dashed var(--border)', borderRadius:'var(--radius-md)', padding:'24px 20px', textAlign:'center', cursor:'pointer', background:'var(--bg-secondary)', marginBottom:14 }}>
              <i className="ti ti-table-import" style={{ fontSize:22, color:'var(--text-muted)', display:'block', marginBottom:6 }} aria-hidden="true"/>
              <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0 }}>
                {file ? file.name : 'Click to select Chase CSV file'}
              </p>
              {parsed && (
                <p style={{ fontSize:12, color:'var(--teal)', margin:'4px 0 0' }}>{parsed.length} transactions found</p>
              )}
            </div>
            <input ref={fileRef2} type="file" accept=".csv" style={{ display:'none' }} onChange={e => e.target.files[0] && handleFile(e.target.files[0])}/>

            {parseError && (
              <p style={{ fontSize:12, color:'var(--coral)', margin:'0 0 12px' }}>{parseError}</p>
            )}

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={onClose} style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>Cancel</button>
              <button onClick={doImport} disabled={!parsed || importing || (showNewAcctFields && !newAcctName.trim())}
                style={{ background:'var(--amber-light)', color:'var(--amber)', borderColor:'var(--amber)' }}>
                {importing
                  ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> {creatingAcct ? 'Creating account…' : 'Importing…'}</>
                  : <><i className="ti ti-table-import" aria-hidden="true"/> Import {parsed ? parsed.length+' transactions' : ''}</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────
export default function DataVault({ onImportTransactions, onTransactionsChanged, accounts, transactions = [] }) {
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
  const [exporting, setExporting]   = useState(false)
  const [wiping, setWiping]         = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [verifying, setVerifying]   = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showWipeConfirm, setShowWipeConfirm] = useState(false)
  const [conflictModal, setConflictModal] = useState(null)   // { conflicts, resolve } | null — same month/year prompt
  const [conflictChoices, setConflictChoices] = useState({}) // { [key]: 'keep' | 'replace' }
  const [dupModal, setDupModal]     = useState(null)         // { pairs, resolve } | null — auto-organize duplicate prompt
  const [dupChoices, setDupChoices] = useState({})           // { [pairKey]: fileIdToKeep }
  const [reviewing, setReviewing]       = useState(false)
  const [reviewModal, setReviewModal]   = useState(null)     // { proposals } | null — AI vault-review proposals
  const [reviewPicks, setReviewPicks]   = useState({})       // { [proposalId]: true } — approved
  const [applyingReview, setApplyingReview] = useState(false)
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
      setLoading(false)
      return res.data
    } catch {
      setUploadError('Cannot connect to backend. Run npm start in the CaiShen root folder.')
      setLoading(false)
      return null
    }
  }

  // ── Drag-and-drop move: re-home a file or folder into another folder ──
  // (payload { kind:'file'|'folder', id }; targetFolderId null = vault root)
  const moveTo = async (payload, targetFolderId) => {
    if (!payload || !payload.id || (payload.kind === 'folder' && payload.id === targetFolderId)) return
    try {
      await axios.post(`${API}/move`, payload.kind === 'folder'
        ? { folderId: payload.id, targetFolderId }
        : { fileIds: [payload.id], targetFolderId })
      await load()
    } catch (e) { setUploadError('Move failed: ' + (e.response?.data?.error || e.message)) }
  }

  const exportVault = async () => {
    if (!meta.files.length) { setUploadError('Vault is empty — nothing to export.'); return }
    setExporting(true)
    try {
      const token = localStorage.getItem('caishen_token') || ''
      const res   = await fetch(`${API}/export`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Export failed'); }
      const blob  = await res.blob()
      const url   = URL.createObjectURL(blob)
      const a     = document.createElement('a')
      a.href      = url
      a.download  = `caishen-vault-${new Date().toISOString().split('T')[0]}.zip`
      document.body.appendChild(a); a.click()
      setTimeout(() => { URL.revokeObjectURL(url); document.body.removeChild(a) }, 1000)
      setUploadSuccess('✓ Vault exported as ZIP')
    } catch (e) { setUploadError('Export failed: ' + e.message) }
    setExporting(false)
  }

  const wipeVault = async () => {
    setShowWipeConfirm(false)
    setWiping(true)
    try {
      await axios.delete(API)
      setMeta({ folders: [], files: [] })
      setSelectedFolderId(null)
      setUploadSuccess('✓ Vault wiped — all files permanently removed from server')
      onTransactionsChanged?.()
    } catch (e) { setUploadError('Wipe failed: ' + e.message) }
    setWiping(false)
  }

  useEffect(() => {
    load().then(vaultData => {
      if (!vaultData) return
      ;(async () => {
        setOrganizing(true)
        let orgOrg = 0, consolidated = 0, renamed = 0, dupeRemoved = 0, orgFudge = 0, dupesKept = 0
        const deletedFolders = []

        // 1. Backfill last4 + consolidate duplicate account folders + resolve
        //    period-exact duplicates (user picks which copy to keep) + rename to
        //    canonical format. This is always cheap if there's nothing to do.
        try {
          const cr = await organizeWithDupPrompt({ consolidate: true })
          consolidated = cr.consolidated        || 0
          renamed      = cr.renamed             || 0
          dupeRemoved  = cr.duplicatesRemoved   || 0
          dupesKept   += cr.duplicatesKept      || 0
          // Mortgage re-heal stripped organize tags server-side — refresh the file
          // list so the per-folder pass below picks up the requeued PDFs now.
          if (cr.mortgageHealed > 0) {
            const fresh = await load()
            if (fresh) vaultData = fresh
          }
        } catch {}

        // 2. Organize any folders with PDFs not yet sorted (no institution tag, and
        //    not already attempted by the AI sorter — aiSorted marks "other" files the
        //    AI couldn't classify, so we don't re-call Groq on every load; the manual
        //    Sort button still retries them).
        const unsortedFolderIds = [
          ...new Set(
            (vaultData.files || [])
              .filter(f => f.type === 'pdf' && !f.tags?.institution && !f.tags?.aiSorted)
              .map(f => f.folderId)
              .filter(Boolean)
          )
        ]
        for (const fid of unsortedFolderIds) {
          try {
            const r = await organizeWithDupPrompt({ folderId: fid })
            orgOrg      += r.organized         || 0
            renamed     += r.renamed           || 0
            dupeRemoved += r.duplicatesRemoved || 0
            orgFudge    += r.fudgedCount       || 0
            dupesKept   += r.duplicatesKept    || 0
            if (r.sourceFolderDeleted) deletedFolders.push(r.sourceFolderName)
          } catch {}
        }

        if (orgOrg > 0 || consolidated > 0 || renamed > 0 || dupeRemoved > 0 || orgFudge > 0 || dupesKept > 0) {
          await load()
          onTransactionsChanged?.()
          if (deletedFolders.length) setSelectedFolderId(null)
          const parts = [
            orgOrg       > 0 ? `${orgOrg} PDF${orgOrg !== 1 ? 's' : ''} sorted` : null,
            consolidated > 0 ? `${consolidated} file${consolidated !== 1 ? 's' : ''} merged into correct account` : null,
            renamed      > 0 ? `${renamed} file${renamed !== 1 ? 's' : ''} renamed` : null,
            dupeRemoved  > 0 ? `${dupeRemoved} duplicate${dupeRemoved !== 1 ? 's' : ''} resolved` : null,
            dupesKept    > 0 ? `${dupesKept} duplicate pair${dupesKept !== 1 ? 's' : ''} kept (both copies)` : null,
            orgFudge     > 0 ? `⚠ ${orgFudge} potentially tampered statement${orgFudge !== 1 ? 's' : ''} flagged` : null,
          ].filter(Boolean)
          setUploadSuccess(`✓ ${parts.join(' · ')} automatically`)
        }

        // 3. Extract financial stats (income/spending/net) for any organized PDFs
        //    that haven't been scanned yet. Runs server-side in batches of 5.
        try {
          const sr = await axios.post(`${API}/extract-stats`, {}, { timeout: 600000 })
          if (sr.data.processed > 0) {
            await load()
            setUploadSuccess(`✓ Financial stats extracted for ${sr.data.processed} statement${sr.data.processed !== 1 ? 's' : ''}`)
          }
        } catch {}

        setOrganizing(false)

        // 4. Silently compare all PDF statements against Plaid data.
        //    'verified' status is permanent — only new/changed files get re-checked.
        try {
          setVerifying(true)
          const vr = await axios.post(`${API}/verify`, {}, { timeout: 600000 })
          if (vr.data.verified > 0 || vr.data.unverified > 0) await load()
        } catch {}
        setVerifying(false)
      })()
    })
  }, [])

  const verifyStatements = async () => {
    setVerifying(true)
    try {
      const vr = await axios.post(`${API}/verify`, {}, { timeout: 600000 })
      if (vr.data.verified > 0 || vr.data.unverified > 0) {
        await load()
        const parts = [
          vr.data.verified    > 0 ? `${vr.data.verified} verified ✓`    : null,
          vr.data.unverified  > 0 ? `${vr.data.unverified} unverified`  : null,
          vr.data.noPlaidData > 0 ? `${vr.data.noPlaidData} outside Plaid window` : null,
        ].filter(Boolean)
        setUploadSuccess('Plaid verification: ' + parts.join(' · '))
      }
    } catch (e) {
      setUploadError('Verification failed: ' + (e.response?.data?.error || e.message))
    }
    setVerifying(false)
  }

  // AI vault review — (1) re-validate every statement's income/spending and auto-correct
  // any stale/wrong figures (non-destructive), then (2) fetch proposed cleanups for
  // duplicates/empty/redundant folders (nothing destructive happens until you approve).
  const runReview = async () => {
    setReviewing(true); setUploadError(null)
    try {
      // (1) retroactive financial-stats correction
      let corrected = 0
      try {
        const sr = await axios.post(`${API}/extract-stats`, { revalidate: true }, { timeout: 300000 })
        corrected = sr.data?.corrected || 0
        if (corrected > 0) await load()
      } catch {}

      // (2) cleanup proposals
      const r = await axios.post(`${API}/review`, {}, { timeout: 120000 })
      const proposals = r.data.proposals || []
      const fixedMsg = corrected > 0 ? `Corrected ${corrected} financial figure${corrected !== 1 ? 's' : ''}. ` : ''
      if (!proposals.length) {
        setUploadSuccess(`✓ ${fixedMsg}AI reviewed your vault — no duplicate files, empty folders, or redundant folders found.`)
      } else {
        if (fixedMsg) setUploadSuccess('✓ ' + fixedMsg)
        setReviewPicks(Object.fromEntries(proposals.map(p => [p.id, true]))) // pre-check all
        setReviewModal({ proposals })
      }
    } catch (e) {
      setUploadError('Review failed: ' + (e.response?.data?.error || e.message))
    }
    setReviewing(false)
  }

  const applyReview = async () => {
    if (!reviewModal) return
    const approved = reviewModal.proposals.filter(p => reviewPicks[p.id])
    if (!approved.length) { setReviewModal(null); return }
    setApplyingReview(true)
    try {
      const r = await axios.post(`${API}/review/apply`, { proposals: approved }, { timeout: 120000 })
      setReviewModal(null)
      await load()
      onTransactionsChanged?.()
      const failed = (r.data.results || []).filter(x => !x.ok).length
      setUploadSuccess(`✓ Applied ${r.data.applied} change${r.data.applied !== 1 ? 's' : ''}${failed ? ` · ${failed} skipped` : ''}`)
    } catch (e) {
      setUploadError('Apply failed: ' + (e.response?.data?.error || e.message))
    }
    setApplyingReview(false)
  }

  const organizeFolder = async (folderId) => {
    setOrganizing(true); setUploadError(null)
    try {
      const res = await organizeWithDupPrompt({ folderId })
      await load()
      onTransactionsChanged?.()   // refresh accounts if any were auto-created
      const parts = [
        res.organized         > 0 ? `${res.organized} PDF${res.organized !== 1 ? 's' : ''} sorted` : null,
        res.duplicatesRemoved > 0 ? `${res.duplicatesRemoved} duplicate${res.duplicatesRemoved !== 1 ? 's' : ''} resolved` : null,
        res.duplicatesKept    > 0 ? `${res.duplicatesKept} duplicate pair${res.duplicatesKept !== 1 ? 's' : ''} kept (both copies)` : null,
        res.skipped           > 0 ? `${res.skipped} couldn't be matched` : null,
        res.failed            > 0 ? `${res.failed} failed` : null,
        res.sourceFolderDeleted ? `"${res.sourceFolderName}" folder cleaned up` : null,
      ].filter(Boolean)
      setUploadSuccess('✓ ' + (parts.length ? parts.join(' · ') : 'Nothing to sort'))
      if (res.sourceFolderDeleted) setSelectedFolderId(null)
    } catch (e) {
      setUploadError('Sort failed: ' + (e.response?.data?.error || e.message))
    }
    setOrganizing(false)
  }

  // Open the same-month/year modal and resolve with the user's per-period choices.
  // Defaults every conflict to 'replace' (the common case: a real statement over a placeholder).
  const askConflicts = useCallback((conflicts) => new Promise((resolve) => {
    setConflictChoices(Object.fromEntries(conflicts.map(c => [c.key, 'replace'])))
    setConflictModal({ conflicts, resolve })
  }), [])

  // Open the duplicate-statement modal and resolve with { [pairKey]: fileIdToKeep },
  // or null if the user dismisses (keep both copies for now). Defaults to the existing copy.
  const askDuplicates = useCallback((pairs) => new Promise((resolve) => {
    setDupChoices(Object.fromEntries(pairs.map(p => [p.key, p.existing.id])))
    setDupModal({ pairs, resolve })
  }), [])

  // Run auto-organize; if the server reports duplicate pairs, ask the user which copy
  // to keep and retry the same request with those decisions. Returns merged result data
  // (plus `duplicatesKept` — pairs the user chose to leave unresolved).
  const organizeWithDupPrompt = useCallback(async (body) => {
    const r = await axios.post(`${API}/auto-organize`, body, { timeout: 300000 })
    const d = r.data
    if (!d.duplicates?.length) return { ...d, duplicatesKept: 0 }
    const resolutions = await askDuplicates(d.duplicates)
    if (!resolutions) return { ...d, duplicatesKept: d.duplicates.length }
    const r2 = await axios.post(`${API}/auto-organize`, { ...body, duplicateResolutions: resolutions }, { timeout: 300000 })
    return {
      ...r2.data,
      organized:           (d.organized         || 0) + (r2.data.organized         || 0),
      renamed:             (d.renamed           || 0) + (r2.data.renamed           || 0),
      consolidated:        (d.consolidated      || 0) + (r2.data.consolidated      || 0),
      failed:              (d.failed            || 0) + (r2.data.failed            || 0),
      fudgedCount:         (d.fudgedCount       || 0) + (r2.data.fudgedCount       || 0),
      duplicatesRemoved:   (d.duplicatesRemoved || 0) + (r2.data.duplicatesRemoved || 0),
      skipped:             (d.skipped           || 0),  // retry re-runs only the resolved files
      sourceFolderDeleted: d.sourceFolderDeleted || r2.data.sourceFolderDeleted,
      sourceFolderName:    r2.data.sourceFolderName || d.sourceFolderName,
      duplicatesKept:      (r2.data.duplicates || []).length,
    }
  }, [askDuplicates])

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
      const pdfFolderIds  = new Set()
      const newPdfFileIds = []  // track newly uploaded PDF IDs for duplicate check
      for (const [folderPath, files] of Object.entries(byFolder)) {
        const fd = new FormData()
        fd.append('folderPath', folderPath)
        fd.append('mergeMode', mergeMode)
        files.forEach(f => fd.append('files', f))
        const res = await axios.post(`${API}/upload`, fd, { headers:{ 'Content-Type':'multipart/form-data' } })
        total += res.data.uploaded || 0
        const collectPdfs = (data) => {
          const pdfsIn = (data.files || []).filter(f => f.type === 'pdf')
          pdfsIn.forEach(f => { if (f.folderId) pdfFolderIds.add(f.folderId) })
          pdfsIn.forEach(f => newPdfFileIds.push(f.id))
        }
        collectPdfs(res.data)

        // Same month+year already exists → ask which to keep, then re-upload the chosen ones.
        if (res.data.conflicts && res.data.conflicts.length) {
          const resolutions = await askConflicts(res.data.conflicts)   // { [key]: 'keep'|'replace' }
          const retry = res.data.conflicts
            .filter(c => resolutions[c.key] === 'replace')
            .map(c => files.find(ff => ff.name === c.incoming.name))
            .filter(Boolean)
          if (retry.length) {
            const fd2 = new FormData()
            fd2.append('folderPath', folderPath)
            fd2.append('conflictResolution', JSON.stringify(resolutions))
            retry.forEach(f => fd2.append('files', f))
            const res2 = await axios.post(`${API}/upload`, fd2, { headers:{ 'Content-Type':'multipart/form-data' } })
            total += res2.data.uploaded || 0
            collectPdfs(res2.data)
          }
        }
      }
      await load()

      // Auto-sort any PDFs that were just uploaded
      if (pdfFolderIds.size > 0) {
        setOrganizing(true)
        setUploadSuccess(`✓ ${total} file${total !== 1 ? 's' : ''} uploaded — sorting PDFs into account folders…`)
        let orgOrg = 0, orgSkip = 0, orgFail = 0, orgDupe = 0, orgFudge = 0, orgDupeKept = 0
        const deletedFolders = []
        for (const fid of pdfFolderIds) {
          try {
            const r = await organizeWithDupPrompt({ folderId: fid })
            orgOrg      += r.organized          || 0
            orgSkip     += r.skipped            || 0
            orgFail     += r.failed             || 0
            orgDupe     += r.duplicatesRemoved  || 0
            orgFudge    += r.fudgedCount        || 0
            orgDupeKept += r.duplicatesKept     || 0
            if (r.sourceFolderDeleted) deletedFolders.push(r.sourceFolderName)
          } catch {}
        }
        await load()
        onTransactionsChanged?.()
        if (deletedFolders.length) setSelectedFolderId(null)
        const parts = [
          orgOrg      > 0 ? `${orgOrg} PDF${orgOrg !== 1 ? 's' : ''} sorted into account folders` : null,
          orgDupe     > 0 ? `${orgDupe} duplicate${orgDupe !== 1 ? 's' : ''} resolved` : null,
          orgDupeKept > 0 ? `${orgDupeKept} duplicate pair${orgDupeKept !== 1 ? 's' : ''} kept (both copies)` : null,
          orgFudge    > 0 ? `⚠ ${orgFudge} potentially tampered statement${orgFudge !== 1 ? 's' : ''} flagged` : null,
          orgSkip     > 0 ? `${orgSkip} couldn't be matched` : null,
          orgFail     > 0 ? `${orgFail} failed` : null,
          deletedFolders.length ? `"${deletedFolders.join('", "')}" cleaned up` : null,
        ].filter(Boolean)
        setUploadSuccess(`✓ ${total} file${total !== 1 ? 's' : ''} uploaded · ${parts.join(' · ')} — extracting financial stats…`)
        // Extract income/spending/net for the newly organized PDFs
        try {
          const sr = await axios.post(`${API}/extract-stats`, {}, { timeout: 600000 })
          if (sr.data.processed > 0) await load()
        } catch {}
        // Mirror the uploaded statements into the DB and reconcile against Plaid so
        // they flow through to the Banking tab. Surface failures instead of hiding
        // them — a statement that won't parse otherwise silently never reconciles.
        let indexNote = ''
        try {
          const ir = await axios.post(`${API}/index-statements`, { fileIds: newPdfFileIds }, { timeout: 600000 })
          if (ir.data?.statements > 0) onTransactionsChanged?.()
          if (ir.data?.failed > 0) {
            indexNote = ` · ⚠ ${ir.data.failed} statement${ir.data.failed !== 1 ? 's' : ''} couldn't be read`
            console.warn('[index-statements] failures:', ir.data.failures)
          }
        } catch (e) {
          indexNote = ' · ⚠ statement indexing failed'
          console.error('[index-statements] request failed:', e.response?.data?.error || e.message)
        }
        setOrganizing(false)
        setUploadSuccess(`✓ ${total} file${total !== 1 ? 's' : ''} uploaded · ${parts.join(' · ')}${indexNote}`)
      } else {
        setUploadSuccess(`✓ ${total} file${total !== 1 ? 's' : ''} uploaded successfully`)
      }

    } catch (e) {
      setUploadError('Upload failed: ' + (e.response?.data?.error || e.message))
    }
    setUploading(false); setPendingUpload(null); setMergeInfo(null)
  }, [selectedFolderId, meta.folders, askConflicts, organizeWithDupPrompt])

  // ── Allowed financial document extensions ──────────────────────────────
  const VAULT_ALLOWED_EXTS = new Set([
    '.pdf', '.csv', '.xlsx', '.xls',
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.doc', '.docx', '.txt',
  ])
  const VAULT_SUSPICIOUS = /^(\.env|package\.json|package-lock\.json|yarn\.lock|node_modules|\.git|\.gitignore|webpack\.config|vite\.config|tsconfig|eslint|babel\.config|\.babelrc|jest\.config|CLAUDE\.md)/i

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList)
    if (!files.length) return

    // ── Client-side validation: catch bad files before any network request ──
    const rejected = files.filter(f => {
      const name = f.webkitRelativePath || f.name
      const base = name.split('/').pop()
      const ext  = '.' + base.split('.').pop().toLowerCase()
      return VAULT_SUSPICIOUS.test(base) || !VAULT_ALLOWED_EXTS.has(ext)
    })
    if (rejected.length > 0) {
      const names  = rejected.slice(0, 5).map(f => (f.webkitRelativePath || f.name).split('/').pop())
      const extra  = rejected.length > 5 ? ` and ${rejected.length - 5} more` : ''
      setUploadError(
        `Upload blocked — ${rejected.length} file${rejected.length !== 1 ? 's' : ''} can't be stored in the vault: `
        + names.join(', ') + extra
        + '. Only financial documents are allowed: PDF, CSV, Excel, images (JPG/PNG), and Word docs.'
      )
      return
    }

    // PDFs are always auto-organized into the correct account folders —
    // skip the merge-conflict check entirely and go straight to upload.
    const hasPdfs = files.some(f => (f.webkitRelativePath || f.name).toLowerCase().endsWith('.pdf'))
    if (hasPdfs) {
      doUpload(files, 'merge')
      return
    }

    // Non-PDF folders: check for name collisions as before
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
    try {
      await axios.delete(`${API}/file/${fileId}`)
      setPreviewFile(null)
      await load()
      onTransactionsChanged?.()
    }
    catch (e) { setUploadError('Delete failed: ' + e.message) }
  }

  const deleteFolder = async (folderId) => {
    if (!window.confirm('Delete folder? Files will be archived, not permanently removed.')) return
    try {
      await axios.delete(`${API}/folder/${folderId}`)
      setSelectedFolderId(null)
      await load()
      onTransactionsChanged?.()
    }
    catch (e) { setUploadError('Delete failed: ' + e.message) }
  }

  // Derived
  const rootFolders    = sortFoldersByDate(meta.folders.filter(f => !f.parentId))
  const selectedFolder = selectedFolderId ? meta.folders.find(f=>f.id===selectedFolderId) : null

  // Subfolders of the current location (shown first in explorer)
  const childFolders = sortFoldersByDate(selectedFolderId
    ? meta.folders.filter(f => f.parentId === selectedFolderId)
    : rootFolders)

  // Recursive file count for a folder
  const countInFolder = (folderId) => {
    const direct = meta.files.filter(f => f.folderId === folderId).length
    const children = meta.folders.filter(f => f.parentId === folderId)
    return direct + children.reduce((s, c) => s + countInFolder(c.id), 0)
  }

  // When searching: match all files. Otherwise: only direct children of current folder.
  const visibleFiles = (search
    ? meta.files
    : selectedFolderId
      ? meta.files.filter(f => f.folderId === selectedFolderId)
      : meta.files.filter(f => !meta.folders.some(folder => folder.id === f.folderId))
  ).filter(f => {
    if (search && !f.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterType !== 'all' && f.type !== filterType) return false
    return true
  }).sort((a, b) => {
    // Sort by year DESC, then month DESC (newest statement first)
    const ay = parseInt(a.tags?.year  || '0')
    const by = parseInt(b.tags?.year  || '0')
    if (ay !== by) return by - ay
    const am = parseInt(a.tags?.month || '0')
    const bm = parseInt(b.tags?.month || '0')
    if (am !== bm) return bm - am
    return a.name.localeCompare(b.name)
  })

  const totalSize  = meta.files.reduce((s,f)=>s+(f.size||0),0)

  // Build a month→accountId→txs lookup for statement summaries
  const acctByName = {}
  for (const a of accounts) acctByName[a.name] = a.id

  const stmtSummary = (file) => {
    const { year: tagYear, month: tagMonth, account: acctName,
            income: cachedIncome, spending: cachedSpending,
            net: cachedNet, txCount: cachedTxCount } = file.tags || {}

    // Derive year/month from tags; fall back to parsing filename
    // e.g. "2026-02 TOTAL CHECKING Statement.pdf"  →  year=2026, month=02
    // e.g. "20190116-statements-9092-.pdf"          →  year=2019, month=01
    let year = tagYear, month = tagMonth
    if (!year || !month) {
      const m = file.name.match(/^(\d{4})[-._\s](\d{2})\b/)
      if (m) { year = m[1]; month = m[2] }
    }
    if (!year || !month) {
      const m2 = file.name.match(/^(\d{4})(\d{2})\d{2}[-_.]/)
      if (m2) { year = m2[1]; month = m2[2] }
    }
    if (!year || !month) return null

    const monthStr = `${year}-${String(month).padStart(2,'0')}`
    const acctId   = acctByName[acctName]

    const txs = transactions.filter(t => {
      if (t.pending || t.month !== monthStr) return false
      if (acctId)                  return t.account === acctId          // exact account match
      if (file.tags?.institution)  return t.institution === file.tags.institution // institution match
      return true  // no identifier yet — sum all transactions for this month
    })

    if (txs.length) {
      const income   = txs.filter(t => t.amount > 0).reduce((s,t) => s + t.amount, 0)
      const spending = txs.filter(t => t.amount < 0).reduce((s,t) => s + t.amount, 0)
      return { income, spending, net: income + spending, count: txs.length }
    }
    // Fall back to financial summary baked into file tags at generation time
    if (cachedIncome !== undefined || cachedSpending !== undefined) {
      return { income: cachedIncome || 0, spending: cachedSpending || 0, net: cachedNet || 0, count: cachedTxCount || 0 }
    }
    return null
  }

  const fmtMoney = (n) => {
    const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 })
    return (n < 0 ? '-$' : '$') + abs
  }

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
        <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
          <button onClick={runReview} disabled={reviewing}
            title="Let AI review the vault for duplicate files, empty folders, and redundant folders — you approve any changes"
            style={{ fontSize:12, background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
            <i className={`ti ${reviewing ? 'ti-loader-2 spin' : 'ti-sparkles'}`} aria-hidden="true"/>
            {' '}{reviewing ? 'Reviewing…' : 'Review vault'}
          </button>
          <button onClick={verifyStatements} disabled={verifying}
            title="Compare PDF statement transactions against Plaid data to verify authenticity"
            style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
            <i className={`ti ${verifying ? 'ti-loader-2' : 'ti-shield-check'}`} style={{ animation: verifying ? 'spin 1s linear infinite' : 'none' }} aria-hidden="true"/>
            {' '}{verifying ? 'Verifying…' : 'Verify vs Plaid'}
          </button>
          <button onClick={() => setShowImportModal(true)}
            title="Import Chase or other bank CSV to add historical transactions"
            style={{ fontSize:12, background:'var(--amber-light)', color:'var(--amber)', borderColor:'var(--amber)' }}>
            <i className="ti ti-table-import" aria-hidden="true"/> Import CSV history
          </button>
          <button onClick={exportVault} disabled={exporting || !meta.files.length}
            title="Download all vault files as a ZIP"
            style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
            <i className={`ti ${exporting?'ti-loader-2 spin':'ti-download'}`} aria-hidden="true"/>
            {' '}{exporting ? 'Exporting…' : 'Download all'}
          </button>
          <button onClick={() => setShowWipeConfirm(true)} disabled={wiping || !meta.files.length}
            title="Permanently delete all vault files from the server"
            style={{ fontSize:12, background:'var(--coral-light)', color:'var(--coral)', borderColor:'var(--coral)' }}>
            <i className={`ti ${wiping?'ti-loader-2 spin':'ti-trash'}`} aria-hidden="true"/>
            {' '}{wiping ? 'Wiping…' : 'Wipe vault'}
          </button>
        </div>
        <input ref={folderRef} type="file" webkitdirectory="" multiple style={{ display:'none' }} onChange={e=>handleFiles(e.target.files)}/>
        <input ref={fileRef}   type="file" multiple accept=".pdf,.csv,.xlsx,.xls,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.txt" style={{ display:'none' }} onChange={e=>handleFiles(e.target.files)}/>
      </div>

      {organizing && !uploadSuccess?.includes('sorting') && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', marginBottom:10, fontSize:13, color:'var(--teal)', border:'0.5px solid var(--teal)' }}>
          <i className="ti ti-loader-2" style={{ animation:'spin 1s linear infinite' }} aria-hidden="true"/>
          Scanning PDFs and sorting into account folders — this may take a minute for large batches…
        </div>
      )}
      {uploadSuccess && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', marginBottom:10, fontSize:13, color:'var(--teal)', border:'0.5px solid var(--teal)' }}>
          <i className={`ti ${organizing ? 'ti-loader-2' : 'ti-circle-check'}`} style={{ animation: organizing ? 'spin 1s linear infinite' : 'none' }} aria-hidden="true"/>
          {uploadSuccess}
          {!organizing && <button onClick={()=>setUploadSuccess(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--teal)', padding:0 }}>✕</button>}
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
          onDragOver={e=>{ if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDragOver(true)} }}
          onDragLeave={()=>setDragOver(false)}
          onDrop={e=>{ if(!e.dataTransfer.types.includes('Files'))return; e.preventDefault();setDragOver(false);handleFiles(e.dataTransfer.files) }}
          style={{ width:sidebarWidth, flexShrink:0, background:dragOver?'var(--blue-light)':'var(--bg-card)', border:`0.5px solid ${dragOver?'var(--blue)':'var(--border)'}`, borderRadius:'var(--radius-lg)', overflow:'auto', padding:'8px 4px', transition:'background 0.15s, border-color 0.15s' }}>
          <div style={{ padding:'4px 8px 8px', borderBottom:'0.5px solid var(--border)', marginBottom:4 }}>
            <p style={{ fontSize:10, fontWeight:500, color:'var(--text-secondary)', margin:0, textTransform:'uppercase', letterSpacing:'0.5px' }}>Vault</p>
          </div>
          <div onClick={()=>setSelectedFolderId(null)}
            onDragOver={e=>{ if(e.dataTransfer.types.includes(MOVE_MIME)){ e.preventDefault(); e.currentTarget.style.background='var(--blue-light)'; e.currentTarget.style.outline='1px dashed var(--blue)' } }}
            onDragLeave={e=>{ e.currentTarget.style.background=!selectedFolderId?'var(--blue-light)':'transparent'; e.currentTarget.style.outline='none' }}
            onDrop={e=>{ const r=e.dataTransfer.getData(MOVE_MIME); if(r){ e.preventDefault(); e.stopPropagation(); e.currentTarget.style.background=!selectedFolderId?'var(--blue-light)':'transparent'; e.currentTarget.style.outline='none'; try{ moveTo(JSON.parse(r), null) }catch{} } }}
            style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:'var(--radius-sm)', background:!selectedFolderId?'var(--blue-light)':'transparent', cursor:'pointer', marginBottom:2 }}>
            <i className="ti ti-home" style={{ fontSize:13, color:!selectedFolderId?'var(--blue)':'var(--text-secondary)' }} aria-hidden="true"/>
            <span style={{ fontSize:13, color:!selectedFolderId?'var(--blue)':'var(--text-secondary)', fontWeight:!selectedFolderId?500:400 }}>All files</span>
            <span style={{ fontSize:10, color:'var(--text-muted)', marginLeft:'auto' }}>{meta.files.length}</span>
          </div>
          {rootFolders.map(folder=>(
            <FolderNode key={folder.id} folder={folder} folders={meta.folders} files={meta.files} selectedId={selectedFolderId} onSelect={setSelectedFolderId} onMoveItem={moveTo} depth={0}/>
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

        {/* Explorer panel */}
        <div style={{ flex:1, minWidth:0, background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', display:'flex', flexDirection:'column' }}>
          {/* Header */}
          <div style={{ padding:'10px 16px', borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', gap:8 }}>
            {selectedFolder && (
              <button onClick={()=>setSelectedFolderId(selectedFolder.parentId||null)}
                onDragOver={e=>{ if(e.dataTransfer.types.includes(MOVE_MIME)){ e.preventDefault(); e.currentTarget.style.background='var(--blue-light)' } }}
                onDragLeave={e=>{ e.currentTarget.style.background='none' }}
                onDrop={e=>{ const r=e.dataTransfer.getData(MOVE_MIME); if(r){ e.preventDefault(); e.currentTarget.style.background='none'; try{ moveTo(JSON.parse(r), selectedFolder.parentId||null) }catch{} } }}
                title="Drop here to move up one level"
                style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', padding:'2px 6px', borderRadius:4, display:'flex', alignItems:'center', gap:4, fontSize:12 }}>
                <i className="ti ti-arrow-left" style={{ fontSize:13 }} aria-hidden="true"/> Up
              </button>
            )}
            <i className={`ti ${selectedFolder?'ti-folder-open':'ti-files'}`} style={{ fontSize:14, color:'var(--amber)' }} aria-hidden="true"/>
            <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{selectedFolder?.name||'All files'}</p>
            <span style={{ fontSize:11, color:'var(--text-secondary)' }}>
              {childFolders.length > 0 && `${childFolders.length} folder${childFolders.length!==1?'s':''}`}
              {childFolders.length > 0 && visibleFiles.length > 0 && ', '}
              {visibleFiles.length > 0 && `${visibleFiles.length} file${visibleFiles.length!==1?'s':''}`}
            </span>
            {selectedFolder && (
              <button onClick={()=>deleteFolder(selectedFolder.id)}
                style={{ marginLeft: meta.files.filter(f => f.folderId === selectedFolder.id && f.type === 'pdf').length > 0 ? '6px' : 'auto', fontSize:11, color:'var(--coral)', borderColor:'var(--coral)', background:'var(--coral-light)', padding:'3px 8px' }}>
                <i className="ti ti-trash" aria-hidden="true"/> Delete folder
              </button>
            )}
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'8px' }}>
            {childFolders.length === 0 && visibleFiles.length === 0 ? (
              <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-secondary)' }}>
                <i className="ti ti-file-off" style={{ fontSize:36, display:'block', marginBottom:10 }} aria-hidden="true"/>
                <p style={{ fontSize:13, margin:0 }}>{search ? 'No files match your search' : 'This folder is empty — upload files or drag a folder here'}</p>
              </div>
            ) : (
              <>
                {/* Folder rows */}
                {!search && childFolders.map(folder => {
                  const count = countInFolder(folder.id)
                  return (
                    <div key={folder.id} draggable
                      onDragStart={e=>{ e.dataTransfer.setData(MOVE_MIME, JSON.stringify({ kind:'folder', id:folder.id })); e.dataTransfer.effectAllowed='move' }}
                      onDragOver={e=>{ if(e.dataTransfer.types.includes(MOVE_MIME)){ e.preventDefault(); e.currentTarget.style.background='var(--blue-light)'; e.currentTarget.style.outline='1px dashed var(--blue)' } }}
                      onDragLeave={e=>{ e.currentTarget.style.background='transparent'; e.currentTarget.style.outline='none' }}
                      onDrop={e=>{ const r=e.dataTransfer.getData(MOVE_MIME); if(r){ e.preventDefault(); e.currentTarget.style.background='transparent'; e.currentTarget.style.outline='none'; try{ moveTo(JSON.parse(r), folder.id) }catch{} } }}
                      onClick={()=>setSelectedFolderId(folder.id)}
                      style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:'var(--radius-sm)', cursor:'pointer', transition:'background 0.1s' }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
                      onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <i className="ti ti-folder" style={{ fontSize:17, color:'var(--amber)', flexShrink:0 }} aria-hidden="true"/>
                      <p style={{ fontSize:13, fontWeight:500, margin:0, flex:1 }}>{folder.name}</p>
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>{count} item{count!==1?'s':''}</span>
                      <i className="ti ti-chevron-right" style={{ fontSize:12, color:'var(--text-muted)' }} aria-hidden="true"/>
                    </div>
                  )
                })}

                {/* Divider between folders and files */}
                {!search && childFolders.length > 0 && visibleFiles.length > 0 && (
                  <div style={{ borderTop:'0.5px solid var(--border)', margin:'6px 0' }}/>
                )}

                {/* File rows — list with financial data */}
                {visibleFiles.length > 0 && (
                  <>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 90px 90px 90px 70px', gap:12, padding:'5px 10px', fontSize:10, color:'var(--text-muted)', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px', borderBottom:'0.5px solid var(--border)', marginBottom:2 }}>
                      <span>File</span>
                      <span style={{textAlign:'right'}}>Income</span>
                      <span style={{textAlign:'right'}}>Spending</span>
                      <span style={{textAlign:'right'}}>Net Flow</span>
                      <span style={{textAlign:'right'}}>Size</span>
                    </div>
                    {visibleFiles.map((file, idx) => {
                      const isFlagged = file.tags?.fudge === true
                      const { icon, color } = isFlagged
                        ? { icon:'ti-alert-triangle', color:'var(--coral)' }
                        : (FILE_ICONS[file.type]||FILE_ICONS.other)
                      const summ = file.type === 'pdf' ? stmtSummary(file) : null
                      const rowBg = isFlagged
                        ? 'rgba(185,28,28,0.08)'
                        : (idx%2===1 ? 'rgba(255,255,255,0.02)' : 'transparent')
                      return (
                        <div key={file.id} draggable
                          onDragStart={e=>{ e.dataTransfer.setData(MOVE_MIME, JSON.stringify({ kind:'file', id:file.id })); e.dataTransfer.effectAllowed='move' }}
                          onClick={()=>setPreviewFile(file)}
                          style={{ display:'grid', gridTemplateColumns:'1fr 90px 90px 90px 70px', gap:12, padding:'8px 10px', cursor:'pointer', borderRadius:'var(--radius-sm)', alignItems:'center', background: rowBg, transition:'background 0.1s', outline: isFlagged ? '1px solid rgba(185,28,28,0.3)' : 'none' }}
                          onMouseEnter={e=>e.currentTarget.style.background=isFlagged?'rgba(185,28,28,0.15)':'var(--bg-secondary)'}
                          onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                          <div style={{ display:'flex', alignItems:'center', gap:9, minWidth:0 }}>
                            <i className={`ti ${icon}`} style={{ fontSize:16, color, flexShrink:0 }} aria-hidden="true"/>
                            <p style={{ fontSize:12, fontWeight:500, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color: isFlagged ? 'var(--coral)' : undefined }} title={isFlagged ? `⚠ Potentially tampered — amounts differ from original statement` : file.name}>{file.name}</p>
                            {isFlagged && <span style={{ fontSize:10, fontWeight:600, color:'var(--coral)', background:'rgba(185,28,28,0.15)', border:'1px solid rgba(185,28,28,0.4)', borderRadius:3, padding:'1px 5px', whiteSpace:'nowrap', flexShrink:0 }}>FLAGGED</span>}
                          {file.tags?.verificationStatus === 'verified' && (
                            <span
                              title={`Verified against Plaid · ${Math.round((file.tags.verificationScore||0)*100)}% match (${file.tags.verificationMatchCount||0}/${file.tags.verificationPdfCount||0} txs)${file.tags.verifiedAt ? ' · ' + new Date(file.tags.verifiedAt).toLocaleDateString() : ''}`}
                              style={{ fontSize:9, fontWeight:700, color:'var(--teal)', background:'rgba(20,184,166,0.12)', border:'1px solid rgba(20,184,166,0.35)', borderRadius:3, padding:'1px 5px', whiteSpace:'nowrap', flexShrink:0, letterSpacing:'0.3px' }}>
                              ✓ VERIFIED
                            </span>
                          )}
                          {file.tags?.verificationStatus === 'unverified' && (
                            <span
                              title={`Plaid mismatch · ${Math.round((file.tags.verificationScore||0)*100)}% match (${file.tags.verificationMatchCount||0}/${file.tags.verificationPdfCount||0} PDF txs vs ${file.tags.verificationPlaidCount||0} Plaid txs)`}
                              style={{ fontSize:9, fontWeight:700, color:'var(--amber)', background:'rgba(245,158,11,0.12)', border:'1px solid rgba(245,158,11,0.35)', borderRadius:3, padding:'1px 5px', whiteSpace:'nowrap', flexShrink:0, letterSpacing:'0.3px' }}>
                              ✗ UNVERIFIED
                            </span>
                          )}
                          </div>
                          {summ ? <>
                            <p style={{ fontSize:12, color:'var(--teal)', margin:0, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtMoney(summ.income)}</p>
                            <p style={{ fontSize:12, color:'var(--coral)', margin:0, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fmtMoney(Math.abs(summ.spending))}</p>
                            <p style={{ fontSize:12, color:summ.net>=0?'var(--teal)':'var(--coral)', margin:0, textAlign:'right', fontWeight:500, fontVariantNumeric:'tabular-nums' }}>{fmtMoney(summ.net)}</p>
                          </> : <>
                            <p style={{ fontSize:11, color:'var(--text-muted)', margin:0, textAlign:'right' }}>—</p>
                            <p style={{ fontSize:11, color:'var(--text-muted)', margin:0, textAlign:'right' }}>—</p>
                            <p style={{ fontSize:11, color:'var(--text-muted)', margin:0, textAlign:'right' }}>—</p>
                          </>}
                          <p style={{ fontSize:11, color:'var(--text-muted)', margin:0, textAlign:'right' }}>{formatSize(file.size)}</p>
                        </div>
                      )
                    })}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          accounts={accounts}
          onClose={()=>setPreviewFile(null)}
          onTransactionsChanged={onTransactionsChanged}
          onVaultChanged={load}
        />
      )}

      {/* Wipe vault confirmation modal */}
      {showWipeConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div className="card" style={{ maxWidth:420, width:'90%', padding:28 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize:22, color:'var(--coral)' }} aria-hidden="true"/>
              <p style={{ fontSize:16, fontWeight:600, margin:0 }}>Wipe vault?</p>
            </div>
            <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, margin:'0 0 8px' }}>
              This permanently deletes <strong>all files</strong> from the server. Your data will no longer be accessible from any device.
            </p>
            <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, margin:'0 0 20px' }}>
              Download a backup first if you want to keep a local copy. <strong>This action cannot be undone.</strong>
            </p>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={() => setShowWipeConfirm(false)}
                style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
                Cancel
              </button>
              <button onClick={wipeVault}
                style={{ background:'var(--coral)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'9px 16px', fontWeight:500, cursor:'pointer', fontSize:13 }}>
                <i className="ti ti-trash" aria-hidden="true"/> Yes, wipe everything
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import CSV history modal */}
      {showImportModal && (
        <ImportHistoryModal
          accounts={accounts}
          onClose={() => setShowImportModal(false)}
          onImported={async () => {
            setShowImportModal(false)
            await load()              // refresh vault file list
            onTransactionsChanged?.() // refresh transactions in app
          }}
        />
      )}

      {mergeInfo && pendingUpload && (
        <MergeModal info={mergeInfo} onSelect={mode=>doUpload(pendingUpload,mode)} onClose={()=>{ setMergeInfo(null); setPendingUpload(null) }}/>
      )}

      {conflictModal && (() => {
        const keepAll = () => { conflictModal.resolve(Object.fromEntries(conflictModal.conflicts.map(c => [c.key, 'keep']))); setConflictModal(null) }
        const apply   = () => { conflictModal.resolve({ ...conflictChoices }); setConflictModal(null) }
        const n = conflictModal.conflicts.length
        return (
          <div onClick={keepAll}
            style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
            <div className="card" onClick={e=>e.stopPropagation()}
              style={{ width:'min(560px, 94vw)', maxHeight:'84vh', overflowY:'auto', padding:24 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                <i className="ti ti-versions" style={{ fontSize:22, color:'var(--amber)' }} aria-hidden="true"/>
                <p style={{ fontSize:16, fontWeight:600, margin:0 }}>
                  {n === 1 ? 'A statement already exists for this period' : `${n} periods already have a statement`}
                </p>
              </div>
              <p style={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6, margin:'0 0 18px' }}>
                Pick which file to keep for each. <strong>Replacing permanently removes the existing file</strong> and stores your new upload in its place.
              </p>

              {conflictModal.conflicts.map(c => {
                const choice = conflictChoices[c.key] || 'replace'
                const m = c.incoming.month
                const mLabel = /^\d+$/.test(String(m)) ? (['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m,10)-1] || m) : m
                const period = (c.incoming.year || m) ? [mLabel, c.incoming.year].filter(Boolean).join(' ') : 'Same filename'
                const opts = [
                  { id:'keep',    label:'Keep existing', file:c.existing, sub: c.existing.createdAt ? `uploaded ${new Date(c.existing.createdAt).toLocaleDateString()}` : 'already in vault' },
                  { id:'replace', label:'Use new file',  file:c.incoming, sub:'just selected' },
                ]
                return (
                  <div key={c.key} style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', padding:12, marginBottom:10 }}>
                    <p style={{ fontSize:12, fontWeight:600, margin:'0 0 9px', color:'var(--text-secondary)', letterSpacing:0.2 }}>{period}</p>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                      {opts.map(opt => {
                        const active = choice === opt.id
                        return (
                          <button key={opt.id} type="button"
                            onClick={() => setConflictChoices(p => ({ ...p, [c.key]: opt.id }))}
                            style={{
                              textAlign:'left', padding:'9px 11px', borderRadius:'var(--radius-sm)', cursor:'pointer',
                              border:`1px solid ${active ? 'var(--teal)' : 'var(--border)'}`,
                              background: active ? 'var(--teal-light)' : 'var(--bg-secondary)',
                              display:'flex', flexDirection:'column', gap:3, minWidth:0,
                            }}>
                            <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <i className={`ti ${active ? 'ti-circle-check-filled' : 'ti-circle'}`} style={{ fontSize:15, color: active ? 'var(--teal)' : 'var(--text-muted)' }} aria-hidden="true"/>
                              <span style={{ fontSize:12, fontWeight:600, color: active ? 'var(--teal)' : 'var(--text-primary)' }}>{opt.label}</span>
                            </span>
                            <span style={{ fontSize:11, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={opt.file.name}>{opt.file.name}</span>
                            <span style={{ fontSize:10.5, color:'var(--text-muted)' }}>{formatSize(opt.file.size)}{opt.sub ? ` · ${opt.sub}` : ''}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:14 }}>
                <button onClick={keepAll}
                  style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
                  Cancel · keep all existing
                </button>
                <button onClick={apply}
                  style={{ background:'var(--teal)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'9px 16px', fontWeight:500, cursor:'pointer', fontSize:13 }}>
                  <i className="ti ti-check" aria-hidden="true"/> Apply
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {dupModal && (() => {
        const decideLater = () => { dupModal.resolve(null); setDupModal(null) }
        const apply       = () => { dupModal.resolve({ ...dupChoices }); setDupModal(null) }
        const n = dupModal.pairs.length
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        return (
          <div onClick={decideLater}
            style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
            <div className="card" onClick={e=>e.stopPropagation()}
              style={{ width:'min(620px, 94vw)', maxHeight:'84vh', overflowY:'auto', padding:24 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                <i className="ti ti-copy" style={{ fontSize:22, color:'var(--amber)' }} aria-hidden="true"/>
                <p style={{ fontSize:16, fontWeight:600, margin:0 }}>
                  {n === 1 ? 'Duplicate statement found' : `${n} duplicate statements found`}
                </p>
              </div>
              <p style={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6, margin:'0 0 18px' }}>
                Two copies of the same statement period exist. Pick which copy to keep —
                <strong> the other copy is permanently removed</strong>. Or decide later to keep both for now.
              </p>

              {dupModal.pairs.map(pr => {
                const chosen = dupChoices[pr.key] || pr.existing.id
                const mNum   = parseInt(pr.period?.month, 10)
                const mLabel = MONTHS[mNum - 1] || pr.period?.month
                const fmtD   = (s) => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) }
                const range  = (pr.period?.periodStart && pr.period?.periodEnd) ? `${fmtD(pr.period.periodStart)} – ${fmtD(pr.period.periodEnd)}` : null
                const heading = [
                  pr.period?.last4 ? `Account ····${pr.period.last4}` : (pr.period?.street || null),
                  range || [mLabel, pr.period?.year].filter(Boolean).join(' '),
                ].filter(Boolean).join(' · ') || 'Same statement period'
                const opts = [
                  { file: pr.existing, label: 'Keep existing copy', sub: pr.existing.createdAt ? `uploaded ${new Date(pr.existing.createdAt).toLocaleDateString()}` : 'already in vault' },
                  { file: pr.incoming, label: 'Keep other copy',    sub: pr.incoming.createdAt ? `uploaded ${new Date(pr.incoming.createdAt).toLocaleDateString()}` : null },
                ]
                return (
                  <div key={pr.key} style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', padding:12, marginBottom:10 }}>
                    <p style={{ fontSize:12, fontWeight:600, margin:'0 0 9px', color:'var(--text-secondary)', letterSpacing:0.2 }}>{heading}</p>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                      {opts.map(opt => {
                        const active = chosen === opt.file.id
                        return (
                          <button key={opt.file.id} type="button"
                            onClick={() => setDupChoices(p => ({ ...p, [pr.key]: opt.file.id }))}
                            style={{
                              textAlign:'left', padding:'9px 11px', borderRadius:'var(--radius-sm)', cursor:'pointer',
                              border:`1px solid ${active ? 'var(--teal)' : 'var(--border)'}`,
                              background: active ? 'var(--teal-light)' : 'var(--bg-secondary)',
                              display:'flex', flexDirection:'column', gap:3, minWidth:0,
                            }}>
                            <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <i className={`ti ${active ? 'ti-circle-check-filled' : 'ti-circle'}`} style={{ fontSize:15, color: active ? 'var(--teal)' : 'var(--text-muted)' }} aria-hidden="true"/>
                              <span style={{ fontSize:12, fontWeight:600, color: active ? 'var(--teal)' : 'var(--text-primary)' }}>{opt.label}</span>
                            </span>
                            <span style={{ fontSize:11, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={opt.file.name}>{opt.file.name}</span>
                            <span style={{ fontSize:10.5, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={opt.file.folderPath}>
                              <i className="ti ti-folder" style={{ fontSize:10 }} aria-hidden="true"/> {opt.file.folderPath}
                            </span>
                            <span style={{ fontSize:10.5, color:'var(--text-muted)' }}>
                              {formatSize(opt.file.size)}
                              {opt.file.txCount != null ? ` · ${opt.file.txCount} txn${opt.file.txCount !== 1 ? 's' : ''}` : ''}
                              {opt.sub ? ` · ${opt.sub}` : ''}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:14 }}>
                <button onClick={decideLater}
                  style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
                  Decide later · keep both
                </button>
                <button onClick={apply}
                  style={{ background:'var(--teal)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'9px 16px', fontWeight:500, cursor:'pointer', fontSize:13 }}>
                  <i className="ti ti-check" aria-hidden="true"/> Apply
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {reviewModal && (() => {
        const TYPE = {
          delete_file:   { label: 'Delete duplicate file', icon: 'ti-file-x',   color: 'var(--coral)' },
          delete_folder: { label: 'Delete empty folder',   icon: 'ti-folder-x', color: 'var(--coral)' },
          merge_folder:  { label: 'Merge folders',         icon: 'ti-arrow-merge', color: 'var(--amber)' },
        }
        const picks = reviewModal.proposals.filter(p => reviewPicks[p.id]).length
        const toggle = (id) => setReviewPicks(s => ({ ...s, [id]: !s[id] }))
        return (
          <div onClick={() => !applyingReview && setReviewModal(null)}
            style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
            <div className="card" onClick={e=>e.stopPropagation()}
              style={{ width:'min(640px, 95vw)', maxHeight:'86vh', overflowY:'auto', padding:24 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                <i className="ti ti-sparkles" style={{ fontSize:22, color:'var(--purple)' }} aria-hidden="true"/>
                <p style={{ fontSize:16, fontWeight:600, margin:0 }}>AI found {reviewModal.proposals.length} suggested cleanup{reviewModal.proposals.length!==1?'s':''}</p>
              </div>
              <p style={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.6, margin:'0 0 16px' }}>
                Review each one and uncheck anything you want to keep. <strong>Only the checked items are applied</strong>, and these actions delete or move files.
              </p>

              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {reviewModal.proposals.map(p => {
                  const t = TYPE[p.type] || { label: p.type, icon: 'ti-question-mark', color: 'var(--text-muted)' }
                  const on = !!reviewPicks[p.id]
                  const target = p.type === 'merge_folder'
                    ? <span><code style={{ fontSize:11 }}>{p.fromPath}</code> → <code style={{ fontSize:11 }}>{p.intoPath}</code> <span style={{ color:'var(--text-muted)' }}>({p.fileCount} file{p.fileCount!==1?'s':''})</span></span>
                    : <code style={{ fontSize:11 }}>{p.folderPath || `${p.folderPath||''}/${p.fileName||''}`.replace(/^\//,'') || p.fileName}</code>
                  return (
                    <label key={p.id} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:11, borderRadius:'var(--radius-sm)',
                      border:`1px solid ${on ? t.color : 'var(--border)'}`, background: on ? 'var(--bg-secondary)' : 'transparent', cursor:'pointer' }}>
                      <input type="checkbox" checked={on} onChange={() => toggle(p.id)} style={{ marginTop:2, accentColor:t.color }}/>
                      <div style={{ minWidth:0, flex:1 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                          <i className={`ti ${t.icon}`} style={{ fontSize:14, color:t.color }} aria-hidden="true"/>
                          <span style={{ fontSize:12.5, fontWeight:600, color:t.color }}>{t.label}</span>
                        </div>
                        <div style={{ fontSize:12, color:'var(--text-primary)', marginBottom:3, wordBreak:'break-all' }}>{target}</div>
                        <div style={{ fontSize:11.5, color:'var(--text-muted)', lineHeight:1.5 }}>{p.reason}</div>
                      </div>
                    </label>
                  )
                })}
              </div>

              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:16 }}>
                <button onClick={() => setReviewModal(null)} disabled={applyingReview}
                  style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>Cancel</button>
                <button onClick={applyReview} disabled={applyingReview || !picks}
                  style={{ background: picks ? 'var(--purple)' : 'var(--bg-hover)', color: picks ? '#fff' : 'var(--text-muted)',
                    border:'none', borderRadius:'var(--radius-md)', padding:'9px 16px', fontWeight:500, cursor: picks ? 'pointer' : 'default', fontSize:13 }}>
                  <i className={`ti ${applyingReview ? 'ti-loader-2 spin' : 'ti-check'}`} aria-hidden="true"/> {applyingReview ? 'Applying…' : `Apply ${picks} change${picks!==1?'s':''}`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {showNewFolder && <NewFolderModal onConfirm={createFolder} onClose={()=>setShowNewFolder(false)}/>}

      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}