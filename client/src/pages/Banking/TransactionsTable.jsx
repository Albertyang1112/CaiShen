import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { fmtFull, CAT_COLOR, TYPE_LABELS, TYPE_COLORS } from './bankingFormat'
import ReceiptThumb from './ReceiptThumb'

const API = '/api'

// Toolbar control styling (mirrors Banking.jsx's inputStyle so the dark theme matches).
const inputStyle = { padding:'7px 10px', fontSize:12, borderRadius:'var(--radius-sm)', border:'0.5px solid var(--border)', background:'var(--bg-secondary)', color:'var(--text-primary)' }
const iconBtn    = { ...inputStyle, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap' }
const pgBtn      = (disabled) => ({ ...inputStyle, padding:'5px 9px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 })

// CSV cell encoder with a formula-injection guard (mirrors server/crypto-reports.js toCsv):
// prefix a ' to any cell that begins with = + - @ TAB or CR, but let plain signed numbers through.
function csvCell(val) {
  let s = val == null ? '' : String(val)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

// Inline receipt control per row: a thumbnail (click → enlarge) when a receipt is attached,
// else a ghost paper-clip button to attach one. Stops row-click propagation either way.
function AttachmentCell({ tx, receipts = [], onView, onAttach }) {
  if (receipts.length) {
    return (
      <span style={{ display:'inline-flex', alignItems:'center', gap:3 }} onClick={e => e.stopPropagation()}>
        <ReceiptThumb receipt={receipts[0]} onClick={() => onView?.(receipts[0])} />
        {receipts.length > 1 && (
          <span title={`${receipts.length} receipts attached`} style={{ fontSize:10, color:'var(--text-muted)' }}>+{receipts.length - 1}</span>
        )}
      </span>
    )
  }
  return (
    <button onClick={e => { e.stopPropagation(); onAttach?.(tx) }} title="Attach a receipt"
      style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:4, display:'inline-flex', borderRadius:4 }}
      onMouseEnter={e => e.currentTarget.style.color='var(--blue)'}
      onMouseLeave={e => e.currentTarget.style.color='var(--text-muted)'}>
      <i className="ti ti-paperclip" style={{ fontSize:15 }} aria-hidden="true" />
    </button>
  )
}

// Inline From/To (vendor / counterparty) editor. Clicking the cell opens a searchable
// dropdown of every From/To name already in use, so a name can be reused without retyping;
// you can also type a new one, or clear it. The menu is portaled to <body> with fixed
// positioning so the table's overflow clipping can't cut it off. Selecting a value saves via
// PATCH /transactions/:id/vendor, which learns the merchant pattern and back-fills matching
// rows server-side — hence the reload(). An "auto" chip marks a memory/Groq-filled value.
function VendorCell({ tx, knownVendors = [], reload }) {
  const [open, setOpen]     = useState(false)
  const [query, setQuery]   = useState('')
  const [hi, setHi]         = useState(0)          // highlighted row (keyboard nav)
  const [saving, setSaving] = useState(false)
  const [pos, setPos]       = useState(null)       // {left, top, width} for the portal menu
  const cellRef = useRef(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (q ? knownVendors.filter(v => v.toLowerCase().includes(q)) : knownVendors).slice(0, 50)
  }, [knownVendors, query])

  const typed = query.trim()
  const showAdd = !!typed && !knownVendors.some(v => v.toLowerCase() === typed.toLowerCase())
  // Heterogeneous, keyboard-navigable rows: optional Clear, the name matches, optional Add-new.
  const rows = [
    ...(tx.vendor && !typed ? [{ type: 'clear' }] : []),
    ...matches.map(v => ({ type: 'opt', value: v })),
    ...(showAdd ? [{ type: 'add', value: typed }] : []),
  ]

  const openMenu = () => {
    const r = cellRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 220) })
    setQuery(''); setHi(-1); setOpen(true)   // nothing highlighted until the user types/arrows
  }

  const save = async (value) => {
    setOpen(false)
    const v = String(value ?? '').trim()
    if (v === (tx.vendor || '')) return            // no change
    setSaving(true)
    try { await axios.patch(`${API}/transactions/${tx.id}/vendor`, { vendor: v }); if (reload) await reload() }
    catch (e) { console.error('From/To save failed:', e.message) }
    setSaving(false)
  }
  const choose = (row) => { if (row) (row.type === 'clear' ? save('') : save(row.value)) }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); setHi(h => Math.min(h + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter')     { e.preventDefault(); if (hi >= 0 && rows[hi]) choose(rows[hi]); else if (typed) save(typed) }
    else if (e.key === 'Escape')    { e.preventDefault(); setOpen(false) }
  }

  const item = (active, extra = {}) => ({
    padding:'7px 10px', fontSize:12, cursor:'pointer', whiteSpace:'nowrap', overflow:'hidden',
    textOverflow:'ellipsis', background: active ? 'var(--bg-hover)' : 'transparent', color:'var(--text-primary)', ...extra,
  })

  return (
    <>
      <span ref={cellRef} onClick={e => { e.stopPropagation(); openMenu() }}
        title="Set who this was paid to / received from"
        style={{ display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer', minHeight:18, maxWidth:170 }}>
        {tx.vendor
          ? <>
              <span style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{tx.vendor}</span>
              {tx.vendorAuto && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:99, background:'var(--blue-light)', color:'var(--blue)', textTransform:'uppercase', letterSpacing:'0.3px', flexShrink:0 }}>auto</span>}
            </>
          : <span style={{ color:'var(--text-muted)', fontSize:12 }}>+ Add</span>}
      </span>

      {open && pos && createPortal(
        <div onClick={e => e.stopPropagation()}>
          {/* click-away closes without saving (selection is the only commit) */}
          <div onMouseDown={() => setOpen(false)} style={{ position:'fixed', inset:0, zIndex:1000 }} />
          <div style={{ position:'fixed', left:pos.left, top:pos.top, width:pos.width, zIndex:1001,
            background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)',
            boxShadow:'0 8px 24px rgba(0,0,0,0.35)', overflow:'hidden' }}>
            <input autoFocus value={query} disabled={saving}
              onChange={e => { setQuery(e.target.value); setHi(0) }} onKeyDown={onKeyDown}
              placeholder="Search or add a name…"
              style={{ width:'100%', boxSizing:'border-box', padding:'8px 10px', fontSize:12, border:'none',
                borderBottom:'0.5px solid var(--border)', background:'var(--bg-secondary)', color:'var(--text-primary)', outline:'none' }} />
            <div style={{ maxHeight:220, overflowY:'auto' }}>
              {rows.map((row, i) => {
                if (row.type === 'clear') return (
                  <div key="__clear" onMouseDown={() => choose(row)} onMouseEnter={() => setHi(i)}
                    style={item(hi === i, { color:'var(--text-muted)', borderBottom:'0.5px solid var(--border)' })}>
                    <i className="ti ti-x" style={{ fontSize:11, marginRight:6 }} aria-hidden="true"/>Clear From/To
                  </div>
                )
                if (row.type === 'add') return (
                  <div key="__add" onMouseDown={() => choose(row)} onMouseEnter={() => setHi(i)}
                    style={item(hi === i, { color:'var(--blue)', borderTop: matches.length ? '0.5px solid var(--border)' : 'none' })}>
                    + Add &ldquo;{row.value}&rdquo;
                  </div>
                )
                return (
                  <div key={row.value} onMouseDown={() => choose(row)} onMouseEnter={() => setHi(i)}
                    style={item(hi === i)} title={row.value}>
                    {row.value}
                    {tx.vendor === row.value && <i className="ti ti-check" style={{ fontSize:11, marginLeft:6, color:'var(--blue)' }} aria-hidden="true"/>}
                  </div>
                )
              })}
              {!rows.length && (
                <div style={{ padding:'8px 10px', fontSize:12, color:'var(--text-muted)' }}>
                  {knownVendors.length ? 'No matches' : 'No saved names yet — type to add one'}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ── Transactions table (QuickBooks-style) — extracted from Banking.jsx ──────────
// Owns the table-local features: row selection + bulk actions, pagination, and
// CSV export / print. Filtering, search, status tabs, and totals stay in Banking
// and arrive here already applied via the `txs` prop.
export default function TransactionsTable({
  txs, bankAccounts, showAccount, sortDir, onToggleSort, onRowClick,
  coaById, reconcileFlags = {}, receiptsByTxn = {}, onViewReceipt, onAttachReceipt, reload,
  knownVendors = [],
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [page,        setPage]        = useState(1)
  const [pageSize,    setPageSize]    = useState(50)
  const [busy,        setBusy]        = useState('')   // bulk-action feedback

  // Reset selection + page when the underlying filtered set changes.
  useEffect(() => { setSelectedIds(new Set()) }, [txs.length])
  useEffect(() => { setPage(1) },                [txs.length, pageSize])

  const pageCount = Math.max(1, Math.ceil(txs.length / pageSize))
  const safePage  = Math.min(page, pageCount)
  const start     = (safePage - 1) * pageSize
  const pageTxs   = txs.slice(start, start + pageSize)

  const allOnPageSelected  = pageTxs.length > 0 && pageTxs.every(t => selectedIds.has(t.id))
  const someOnPageSelected = pageTxs.some(t => selectedIds.has(t.id))

  const toggleOne = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const toggleAll = () => setSelectedIds(prev => {
    const next = new Set(prev)
    if (allOnPageSelected) pageTxs.forEach(t => next.delete(t.id))
    else                   pageTxs.forEach(t => next.add(t.id))
    return next
  })

  // Bulk approve — server PATCH is a partial merge, so { approved:true } is enough.
  const bulkApprove = async () => {
    if (!selectedIds.size) return
    setBusy('Approving…')
    try {
      await Promise.all([...selectedIds].map(id =>
        axios.patch(`${API}/transactions/${id}`, { approved: true })))
      setSelectedIds(new Set())
      if (reload) await reload()
    } catch (e) { console.error('bulk approve failed:', e.message) }
    setBusy('')
  }

  // Export the full filtered set (not just the current page) to CSV.
  const exportCsv = () => {
    const header = ['Date','Description','From/To','Account','Category','Spent','Received','Status']
    const rows = txs.map(tx => {
      const acct  = bankAccounts.find(a => a.id === tx.account)
      const gl    = coaById?.get(tx.coaId)
      const debit = tx.amount < 0
      return [
        tx.date || '',
        tx.desc || '',
        tx.vendor || '',
        acct?.name || '',
        gl ? gl.name : (tx.category || ''),
        debit  ? Math.abs(tx.amount).toFixed(2) : '',
        !debit ? Math.abs(tx.amount).toFixed(2) : '',
        tx.approved ? 'Approved' : 'Pending',
      ]
    })
    const csv  = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `transactions_${txs.length}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // Print the full filtered set in a clean light-themed window.
  const printTable = () => {
    const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]))
    const body = txs.map(tx => {
      const acct  = bankAccounts.find(a => a.id === tx.account)
      const gl    = coaById?.get(tx.coaId)
      const debit = tx.amount < 0
      return `<tr><td>${esc(tx.date)}</td><td>${esc(tx.desc)}</td><td>${esc(tx.vendor || '')}</td><td>${esc(acct?.name || '')}</td>`
        + `<td>${esc(gl ? gl.name : (tx.category || ''))}</td>`
        + `<td class="r">${debit  ? '$' + Math.abs(tx.amount).toFixed(2) : ''}</td>`
        + `<td class="r">${!debit ? '$' + Math.abs(tx.amount).toFixed(2) : ''}</td></tr>`
    }).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Transactions</title>`
      + `<style>body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111}`
      + `h2{margin:0 0 12px;font-size:16px}table{width:100%;border-collapse:collapse;font-size:12px}`
      + `th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}`
      + `th{text-transform:uppercase;font-size:10px;color:#555}td.r,th.r{text-align:right}</style></head>`
      + `<body><h2>Transactions (${txs.length})</h2><table><thead><tr>`
      + `<th>Date</th><th>Description</th><th>From/To</th><th>Account</th><th>Category</th><th class="r">Spent</th><th class="r">Received</th>`
      + `</tr></thead><tbody>${body}</tbody></table></body></html>`
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(html); w.document.close(); w.focus(); w.print()
  }

  if (!txs.length) {
    return <p style={{color:'var(--text-muted)',fontSize:13,padding:'2rem',textAlign:'center'}}>No transactions match the current filters.</p>
  }

  const th = (label, opts={}) => (
    <th onClick={opts.onClick} style={{
      textAlign:opts.align||'left', padding:'8px 12px', fontSize:10, fontWeight:600,
      textTransform:'uppercase', letterSpacing:'0.4px', color:'var(--text-muted)',
      borderBottom:'0.5px solid var(--border)', whiteSpace:'nowrap',
      cursor:opts.onClick?'pointer':'default', userSelect:'none',
    }}>
      {label}
      {opts.sortable && <i className={`ti ti-arrow-${sortDir==='desc'?'down':'up'}`} style={{fontSize:11,marginLeft:4,verticalAlign:'middle',color:'var(--text-secondary)'}} aria-hidden="true"/>}
    </th>
  )

  return (
    <div>
      {/* Bulk action bar — appears only when rows are selected */}
      {selectedIds.size > 0 && (
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,padding:'8px 12px',background:'var(--bg-secondary)',border:'0.5px solid var(--green)',borderRadius:'var(--radius-sm)'}}>
          <span style={{fontSize:12,fontWeight:500}}>{selectedIds.size} selected</span>
          <button onClick={bulkApprove} disabled={!!busy}
            style={{...iconBtn,border:'0.5px solid var(--green)',color:'var(--green)',background:'var(--green-light)',opacity:busy?0.7:1}}>
            <i className="ti ti-check" aria-hidden="true"/> {busy || 'Approve'}
          </button>
          <button onClick={()=>setSelectedIds(new Set())} style={iconBtn}>Clear selection</button>
        </div>
      )}

      {/* Pagination + export / print bar */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
        <span style={{fontSize:12,color:'var(--text-muted)'}}>{start+1}–{Math.min(start+pageSize,txs.length)} of {txs.length}</span>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={safePage<=1} style={pgBtn(safePage<=1)} aria-label="Previous page"><i className="ti ti-chevron-left" aria-hidden="true"/></button>
          <span style={{fontSize:12,color:'var(--text-secondary)'}}>Page {safePage} of {pageCount}</span>
          <button onClick={()=>setPage(p=>Math.min(pageCount,p+1))} disabled={safePage>=pageCount} style={pgBtn(safePage>=pageCount)} aria-label="Next page"><i className="ti ti-chevron-right" aria-hidden="true"/></button>
        </div>
        <select value={pageSize} onChange={e=>setPageSize(Number(e.target.value))} style={inputStyle}>
          {[25,50,100].map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <div style={{flex:1}}/>
        <button onClick={exportCsv} title="Export filtered transactions to CSV" style={iconBtn}><i className="ti ti-download" aria-hidden="true"/> Export</button>
        <button onClick={printTable} title="Print filtered transactions" style={iconBtn}><i className="ti ti-printer" aria-hidden="true"/> Print</button>
      </div>

      <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-sm)',overflow:'hidden'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
          <thead>
            <tr style={{background:'var(--bg-secondary)'}}>
              <th style={{padding:'8px 12px',width:36,borderBottom:'0.5px solid var(--border)'}}>
                <input type="checkbox" checked={allOnPageSelected}
                  ref={el => { if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected }}
                  onChange={toggleAll} style={{accentColor:'var(--green)',cursor:'pointer'}} aria-label="Select all on page"/>
              </th>
              {th('Date', {onClick:onToggleSort, sortable:true})}
              {th('Description')}
              {th('From / To')}
              {showAccount && th('Account')}
              {th('Category')}
              {th('Spent', {align:'right'})}
              {th('Received', {align:'right'})}
              {th('Receipt', {align:'center'})}
            </tr>
          </thead>
          <tbody>
            {pageTxs.map(tx => {
              const acct = bankAccounts.find(a => a.id === tx.account)
              const catColor = CAT_COLOR[tx.category] || 'var(--text-muted)'
              const glAcct = coaById?.get(tx.coaId)            // assigned chart-of-accounts entry, if any
              const debit = tx.amount < 0
              const rcFlag = reconcileFlags[tx.id]
              const selected = selectedIds.has(tx.id)
              return (
                <tr key={tx.id} onClick={()=>onRowClick?.(tx)} style={{borderBottom:'0.5px solid var(--border)',cursor:onRowClick?'pointer':'default',background:selected?'var(--bg-hover)':'transparent'}}
                  onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                  onMouseLeave={e=>e.currentTarget.style.background=selected?'var(--bg-hover)':'transparent'}>
                  <td onClick={e=>e.stopPropagation()} style={{padding:'9px 12px',width:36}}>
                    <input type="checkbox" checked={selected} onChange={()=>toggleOne(tx.id)} style={{accentColor:'var(--green)',cursor:'pointer'}} aria-label="Select transaction"/>
                  </td>
                  <td style={{padding:'9px 12px',color:'var(--text-secondary)',whiteSpace:'nowrap'}}>
                    {tx.date}
                    {tx.pending && <span style={{marginLeft:6,fontSize:9,padding:'1px 5px',borderRadius:4,background:'var(--amber-light)',color:'var(--amber)',textTransform:'uppercase',letterSpacing:'0.3px'}}>Pending</span>}
                    {rcFlag === 'conflict'   && <span title="Reconcile: conflict — amount/date matched a statement row but merchant names differ" style={{marginLeft:5,fontSize:10,color:'var(--coral)'}}>⚠</span>}
                    {rcFlag === 'plaid_only' && <span title="Reconcile: transaction appears in Plaid but not in your bank statement" style={{marginLeft:5,fontSize:10,color:'var(--amber)'}}>◈</span>}
                    {rcFlag === 'matched'    && <span title="Reconcile: matched to bank statement ✓" style={{marginLeft:5,fontSize:10,color:'var(--teal)'}}>✓</span>}
                  </td>
                  <td style={{padding:'9px 12px',maxWidth:340}}>
                    <span style={{display:'flex',alignItems:'center',gap:6,minWidth:0}}>
                      <span style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0}} title={tx.desc||''}>{tx.desc||'—'}</span>
                    </span>
                  </td>
                  <td style={{padding:'9px 12px'}} onClick={e=>e.stopPropagation()}>
                    <VendorCell tx={tx} knownVendors={knownVendors} reload={reload}/>
                  </td>
                  {showAccount && <td style={{padding:'9px 12px',color:'var(--text-secondary)',whiteSpace:'nowrap'}}>{acct?.name||'—'}</td>}
                  <td style={{padding:'9px 12px'}}>
                    {glAcct ? (
                      <span style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,whiteSpace:'nowrap'}}
                        title={`${TYPE_LABELS[glAcct.type]||glAcct.type}${glAcct.subtype?' · '+glAcct.subtype:''}${tx.coaAuto?' · auto-categorized — click to confirm or change':''}`}>
                        <span style={{width:7,height:7,borderRadius:2,background:TYPE_COLORS[glAcct.type]||'var(--text-muted)',flexShrink:0}}/>
                        {glAcct.name}
                        {tx.coaAuto && <span style={{fontSize:9,padding:'1px 5px',borderRadius:99,background:'var(--amber-light)',color:'var(--amber)',textTransform:'uppercase',letterSpacing:'0.3px'}}>auto</span>}
                      </span>
                    ) : tx.category ? (
                      <span style={{fontSize:11,padding:'2px 8px',borderRadius:99,background:catColor+'22',color:catColor,whiteSpace:'nowrap'}}>{tx.category}</span>
                    ) : null}
                  </td>
                  <td style={{padding:'9px 12px',textAlign:'right',color:'var(--coral)',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>
                    {debit ? fmtFull(Math.abs(tx.amount)) : ''}
                  </td>
                  <td style={{padding:'9px 12px',textAlign:'right',color:'var(--teal)',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>
                    {!debit ? fmtFull(tx.amount) : ''}
                  </td>
                  <td onClick={e=>e.stopPropagation()} style={{padding:'9px 8px',textAlign:'center',width:64}}>
                    <AttachmentCell tx={tx} receipts={receiptsByTxn[tx.id]} onView={onViewReceipt} onAttach={onAttachReceipt}/>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
