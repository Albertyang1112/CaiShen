import { useState, useEffect } from 'react'
import axios from 'axios'
import { fmtFull, CAT_COLOR, TYPE_LABELS, TYPE_COLORS } from './bankingFormat'

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

// ── Transactions table (QuickBooks-style) — extracted from Banking.jsx ──────────
// Owns the table-local features: row selection + bulk actions, pagination, and
// CSV export / print. Filtering, search, status tabs, and totals stay in Banking
// and arrive here already applied via the `txs` prop.
export default function TransactionsTable({
  txs, bankAccounts, showAccount, sortDir, onToggleSort, onRowClick,
  coaById, reconcileFlags = {}, receiptCounts = {}, reload,
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
    const header = ['Date','Description','Account','Category','Spent','Received','Status']
    const rows = txs.map(tx => {
      const acct  = bankAccounts.find(a => a.id === tx.account)
      const gl    = coaById?.get(tx.coaId)
      const debit = tx.amount < 0
      return [
        tx.date || '',
        tx.desc || '',
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
      return `<tr><td>${esc(tx.date)}</td><td>${esc(tx.desc)}</td><td>${esc(acct?.name || '')}</td>`
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
      + `<th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="r">Spent</th><th class="r">Received</th>`
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
              {showAccount && th('Account')}
              {th('Category')}
              {th('Spent', {align:'right'})}
              {th('Received', {align:'right'})}
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
                      {receiptCounts[tx.id] > 0 && (
                        <i className="ti ti-paperclip" aria-hidden="true"
                          title={`${receiptCounts[tx.id]} receipt${receiptCounts[tx.id]>1?'s':''} attached — open the transaction to view`}
                          style={{fontSize:12,color:'var(--text-secondary)',flexShrink:0}}/>
                      )}
                    </span>
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
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
