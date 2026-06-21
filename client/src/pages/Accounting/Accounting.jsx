import { useState, useEffect, Fragment } from 'react'
import axios from 'axios'

const API = '/api/accounting'

// Per-user real properties for the invoice / bill / P&L property pickers.
// (Replaces the old hardcoded demo list — an account with no properties shows none.)
function useProperties() {
  const [props, setProps] = useState([])
  // Properties live at the top-level /api/properties (NOT under /api/accounting).
  // Array.isArray guards against a stale/unknown route returning the SPA index.html.
  useEffect(() => { axios.get('/api/properties').then(r => setProps(Array.isArray(r.data) ? r.data : [])).catch(() => {}) }, [])
  return props
}

const TYPE_COLORS = { asset:'var(--blue)', liability:'var(--coral)', equity:'var(--teal)', income:'var(--green)', expense:'var(--amber)' }
const STATUS_STYLE = {
  draft:    { bg:'var(--bg-secondary)',  color:'var(--text-muted)',    label:'Draft'    },
  sent:     { bg:'var(--blue-light)',    color:'var(--blue)',          label:'Sent'     },
  paid:     { bg:'var(--teal-light)',    color:'var(--teal)',          label:'Paid'     },
  overdue:  { bg:'var(--coral-light)',   color:'var(--coral)',         label:'Overdue'  },
  cancelled:{ bg:'var(--bg-secondary)',  color:'var(--text-muted)',    label:'Cancelled'},
  unpaid:   { bg:'var(--amber-light)',   color:'var(--amber)',         label:'Unpaid'   },
}

const fd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })

// ── Tree helpers (shared by P&L, Balance Sheet, Chart of Accounts) ────
function childrenMap(list) {
  const m = {}
  for (const a of list) { const p = a.parentId || '__root'; (m[p] = m[p] || []).push(a) }
  return m
}
// Roll each node's amount up through its descendants. amountOf(id) -> number.
function computeTotals(list, amountOf) {
  const kids = childrenMap(list)
  const totals = {}
  const calc = (id) => {
    if (totals[id] != null) return totals[id]
    let s = amountOf(id) || 0
    for (const c of kids[id] || []) s += calc(c.id)
    return (totals[id] = s)
  }
  for (const a of list) calc(a.id)
  return { kids, totals }
}
const rootTotal = (calc) => (calc.kids['__root'] || []).reduce((s, r) => s + (calc.totals[r.id] || 0), 0)

function Badge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.unpaid
  return <span style={{ fontSize:11, padding:'2px 9px', borderRadius:10, background:s.bg, color:s.color, fontWeight:500 }}>{s.label}</span>
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'24px', width:520, maxHeight:'80vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <p style={{ fontSize:15, fontWeight:500, margin:0 }}>{title}</p>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', padding:4, fontSize:16 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:4 }}>{label}</label>
      {children}
    </div>
  )
}

// ── Chart of Accounts (hierarchical tree + library) ───────────────────
function ChartOfAccounts() {
  const [coa, setCoa]             = useState([])
  const [rules, setRules]         = useState([])
  const [expanded, setExpanded]   = useState({})
  const [addingTo, setAddingTo]   = useState(null)
  const [newName, setNewName]     = useState('')
  const [renaming, setRenaming]   = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [busy, setBusy]           = useState(false)
  const [libOpen, setLibOpen]     = useState(false)
  const [library, setLibrary]     = useState([])
  const [libSearch, setLibSearch] = useState('')

  const loadCoa = () => axios.get(`${API}/coa`).then(r => setCoa(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  useEffect(() => {
    loadCoa()
    axios.get('/api/categorization-rules').then(r => setRules(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [])

  const delRule = async (id) => {
    await axios.delete(`/api/categorization-rules/${id}`)
    setRules(prev => prev.filter(r => r.id !== id))
  }

  const kids   = childrenMap(coa)
  const roots  = kids['__root'] || []
  const byId   = new Map(coa.map(a => [a.id, a]))
  const pathOf = (id) => { const parts = []; let cur = byId.get(id); while (cur) { parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null } return parts.join(' › ') }

  const addChild = async (parentId) => {
    if (!newName.trim() || busy) return
    setBusy(true)
    try { await axios.post(`${API}/coa`, { name: newName.trim(), parentId }); await loadCoa(); setNewName(''); setAddingTo(null) }
    catch (e) { alert(e.response?.data?.error || e.message) }
    setBusy(false)
  }
  const rename = async (id) => {
    if (!renameVal.trim()) { setRenaming(null); return }
    try { await axios.put(`${API}/coa/${id}`, { name: renameVal.trim() }); await loadCoa() } catch {}
    setRenaming(null); setRenameVal('')
  }
  const toggleActive = async (node) => {
    try { await axios.put(`${API}/coa/${node.id}`, { active: node.active === false }); await loadCoa() } catch {}
  }
  const del = async (node) => {
    if (!window.confirm(`Delete "${node.name}"?`)) return
    try { await axios.delete(`${API}/coa/${node.id}`); await loadCoa() }
    catch (e) { alert(e.response?.data?.error || 'Could not delete') }
  }

  const openLibrary = async () => {
    setLibOpen(true); setLibSearch('')
    try { const { data } = await axios.get(`${API}/category-library`); setLibrary(Array.isArray(data) ? data : []) } catch {}
  }
  const addFromLibrary = async (id) => {
    try { await axios.post(`${API}/coa/from-library`, { id }); await loadCoa(); setLibrary(prev => prev.filter(l => l.id !== id)) }
    catch (e) { alert(e.response?.data?.error || e.message) }
  }

  const iconBtn = { background:'none', border:'none', padding:'2px 5px', cursor:'pointer', color:'var(--text-muted)', fontSize:13, lineHeight:1 }

  const renderNode = (node, depth) => {
    const childNodes = kids[node.id] || []
    const isGroup = childNodes.length > 0
    const exp = expanded[node.id] ?? (depth === 0)
    const inactive = node.active === false
    return (
      <Fragment key={node.id}>
        <div style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 10px', paddingLeft:10 + depth*16, borderBottom:'0.5px solid var(--border)', background:'var(--bg-card)', opacity: inactive ? 0.55 : 1 }}>
          <button onClick={() => setExpanded(p => ({ ...p, [node.id]: !(p[node.id] ?? (depth === 0)) }))}
            style={{ width:16, height:20, background:'none', border:'none', padding:0, cursor: isGroup ? 'pointer' : 'default', color:'var(--text-muted)', flexShrink:0 }}>
            {isGroup && <i className={`ti ${exp ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize:12 }} aria-hidden="true"/>}
          </button>
          {renaming === node.id ? (
            <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onBlur={() => rename(node.id)}
              onKeyDown={e => { if (e.key === 'Enter') rename(node.id); if (e.key === 'Escape') setRenaming(null) }}
              style={{ flex:1, fontSize:13, padding:'3px 6px' }}/>
          ) : (
            <span onClick={() => { setRenaming(node.id); setRenameVal(node.name) }} title="Click to rename"
              style={{ flex:1, fontSize:13, cursor:'text', fontWeight: depth === 0 ? 600 : (isGroup ? 500 : 400), color: depth === 0 ? (TYPE_COLORS[node.type] || 'var(--text-primary)') : 'var(--text-primary)' }}>
              {node.name}
            </span>
          )}
          {depth === 0 && <span style={{ fontSize:9, textTransform:'uppercase', color:'var(--text-muted)', letterSpacing:'0.3px' }}>{node.scope}</span>}
          {inactive && <span style={{ fontSize:10, color:'var(--text-muted)' }}>inactive</span>}
          <button title="Add sub-category" onClick={() => { setAddingTo(node.id); setExpanded(p => ({ ...p, [node.id]: true })); setNewName('') }} style={iconBtn}><i className="ti ti-plus" aria-hidden="true"/></button>
          <button title={inactive ? 'Activate' : 'Deactivate'} onClick={() => toggleActive(node)} style={iconBtn}><i className={`ti ${inactive ? 'ti-eye' : 'ti-eye-off'}`} aria-hidden="true"/></button>
          <button title="Delete" onClick={() => del(node)} style={{ ...iconBtn, color:'var(--coral)' }}><i className="ti ti-trash" aria-hidden="true"/></button>
        </div>
        {addingTo === node.id && (
          <div style={{ display:'flex', gap:6, padding:'5px 10px', paddingLeft:10 + (depth+1)*16 + 16, background:'var(--bg-secondary)' }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder={`New under "${node.name}"…`}
              onKeyDown={e => { if (e.key === 'Enter') addChild(node.id); if (e.key === 'Escape') { setAddingTo(null); setNewName('') } }}
              style={{ flex:1, fontSize:12, padding:'4px 8px' }}/>
            <button disabled={busy || !newName.trim()} onClick={() => addChild(node.id)} style={{ fontSize:12, padding:'3px 10px', background:'var(--blue)', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', opacity: busy || !newName.trim() ? 0.5 : 1 }}>Add</button>
            <button onClick={() => { setAddingTo(null); setNewName('') }} style={{ fontSize:12, padding:'3px 8px' }}>Cancel</button>
          </div>
        )}
        {exp && childNodes.map(c => renderNode(c, depth + 1))}
      </Fragment>
    )
  }

  const filteredLib = library.filter(l => !libSearch || (l.name + ' ' + (l.parentPath || '')).toLowerCase().includes(libSearch.toLowerCase()))

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div>
          <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Chart of Accounts</p>
          <p style={{ fontSize:11, color:'var(--text-muted)', margin:'2px 0 0' }}>{coa.filter(a => a.active !== false).length} categories · click a name to rename, ＋ to add a sub-category at any depth</p>
        </div>
        <button onClick={openLibrary} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
          <i className="ti ti-books" aria-hidden="true"/> Add from library
        </button>
      </div>

      <div style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
        {roots.map(r => renderNode(r, 0))}
        {roots.length === 0 && <p style={{ fontSize:12, color:'var(--text-muted)', padding:16, textAlign:'center' }}>Loading…</p>}
      </div>

      {/* Auto-categorization rules */}
      <div style={{ marginTop:28 }}>
        <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Auto-categorization Rules</p>
        <p style={{ fontSize:11, color:'var(--text-muted)', margin:'2px 0 12px' }}>{rules.length} rule{rules.length===1?'':'s'} — applied automatically on every sync and via the "Auto-categorize" button in Banking.</p>
        {rules.length === 0 ? (
          <p style={{ fontSize:12, color:'var(--text-muted)', padding:'14px', border:'0.5px dashed var(--border)', borderRadius:'var(--radius-md)', textAlign:'center' }}>
            No rules yet. In Banking, open a transaction, choose a category, and tick "Always categorize transactions like this."
          </p>
        ) : (
          <div style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
            {rules.map((r, i) => {
              const acct = byId.get(r.coaId)
              return (
                <div key={r.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderBottom: i<rules.length-1?'0.5px solid var(--border)':'none', background:'var(--bg-card)' }}>
                  <span style={{ fontSize:11, color:'var(--text-muted)', whiteSpace:'nowrap' }}>{r.field||'desc'} {r.op||'contains'}</span>
                  <span style={{ fontSize:12, fontWeight:500, fontFamily:'monospace', background:'var(--bg-secondary)', padding:'1px 6px', borderRadius:4 }}>{r.value}</span>
                  <i className="ti ti-arrow-right" style={{ fontSize:13, color:'var(--text-muted)' }} aria-hidden="true"/>
                  <span style={{ flex:1, fontSize:13, color: acct?'var(--text-primary)':'var(--coral)' }}>{acct ? pathOf(acct.id) : '(deleted category)'}</span>
                  <button onClick={() => delRule(r.id)} title="Delete rule" style={{ fontSize:11, padding:'2px 6px', background:'none', border:'none', color:'var(--coral)' }}><i className="ti ti-trash" aria-hidden="true"/></button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {libOpen && (
        <Modal title="Add from category library" onClose={() => setLibOpen(false)}>
          <p style={{ fontSize:12, color:'var(--text-muted)', margin:'0 0 12px' }}>
            These are the less-common categories kept out of your default chart. Add any you need.
          </p>
          <input value={libSearch} onChange={e => setLibSearch(e.target.value)} placeholder="Search library…" style={{ width:'100%', marginBottom:12 }}/>
          <div style={{ maxHeight:'48vh', overflowY:'auto' }}>
            {filteredLib.map(l => (
              <div key={l.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 4px', borderBottom:'0.5px solid var(--border)' }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{ fontSize:13, margin:0 }}>{l.name}</p>
                  <p style={{ fontSize:11, color:'var(--text-muted)', margin:'1px 0 0' }}>{l.parentPath}</p>
                </div>
                <button onClick={() => addFromLibrary(l.id)} style={{ fontSize:12, padding:'4px 10px', background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
                  <i className="ti ti-plus" aria-hidden="true"/> Add
                </button>
              </div>
            ))}
            {filteredLib.length === 0 && <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:16 }}>{library.length === 0 ? 'Everything from the library has been added.' : 'No matches.'}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

// Percentage label, e.g. pct(50,200) → "25.0%". Empty string when there's no base.
const pct = (part, whole) => (whole ? `${(part / whole * 100).toFixed(1)}%` : '')

// Short human date for transaction rows ("Jun 12, 2026"). Tolerates YYYY-MM-DD and ISO.
function fmtDate(d) {
  if (!d) return ''
  const s = String(d)
  const dt = new Date(s.length <= 10 ? s + 'T00:00:00' : s)
  return isNaN(dt) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Centered muted message for empty states.
function Empty({ text }) {
  return <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '14px 0', margin: 0 }}>{text}</p>
}

// ── P&L Report ────────────────────────────────────────────────────────
// Progressive disclosure, all inline: major categories first (Summary), expand to
// subcategories (Detailed / per-row caret), then drill a subcategory into its merchants
// and each merchant into individual transactions. The category tree is the server-seeded
// Chart of Accounts; amounts come from /pl's byAccount roll-up; merchant/transaction
// detail is lazy-loaded per leaf from /pl/transactions for the report's period.
// Personal Income/Expenses/Net then Business, plus an overall Net Income line.
function PLReport() {
  const thisYear = new Date().getFullYear()
  const [startDate, setStartDate] = useState(`${thisYear}-01-01`)
  const [endDate,   setEndDate]   = useState(new Date().toISOString().split('T')[0])
  const [data, setData]       = useState(null)
  const [coa, setCoa]         = useState([])
  const [loading, setLoading] = useState(false)
  const [showZero, setShowZero] = useState(false)
  const [view, setView] = useState(() => localStorage.getItem('caishen_pl_view') || 'summary')
  const [expandedMap, setExpandedMap] = useState({})         // id → bool overrides (else the view default)
  const [leafTxns, setLeafTxns] = useState({})               // coaId → { loading, error, groups, total, count } (lazy)

  const load = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      const [pl, chart] = await Promise.all([
        axios.get(`${API}/pl?${params}`),
        axios.get(`${API}/coa`),
      ])
      setData(pl.data); setCoa(Array.isArray(chart.data) ? chart.data : [])
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem('caishen_pl_view', view) }, [view])
  // Switching Summary/Detailed re-applies that mode's default expansion (drop overrides).
  useEffect(() => { setExpandedMap({}) }, [view])
  // A fresh report run resets the tree to the view default and drops cached drill-downs.
  useEffect(() => { setExpandedMap({}); setLeafTxns({}) }, [data])

  const byAccount      = data?.byAccount || {}
  const countByAccount = data?.countByAccount || {}

  // One rolled-up tree per type+scope, carrying both summed amounts and txn counts.
  const tree = (type, scope) => {
    const list = coa.filter(a => a.type === type && a.scope === scope)
    const t = computeTotals(list, id => byAccount[id])
    const c = computeTotals(list, id => countByAccount[id])
    return { kids: t.kids, totals: t.totals, counts: c.totals }
  }
  const pInc = tree('income', 'personal'), pExp = tree('expense', 'personal')
  const bInc = tree('income', 'business'), bExp = tree('expense', 'business')
  const pIncT = rootTotal(pInc), pExpT = rootTotal(pExp)
  const bIncT = rootTotal(bInc), bExpT = rootTotal(bExp)
  const overallNet = (pIncT + bIncT) - (pExpT + bExpT)
  const empty = (pIncT + pExpT + bIncT + bExpT) === 0

  // Children worth rendering at the current zero-filter. A category with COA children
  // expands into them; a spending leaf (no children but has spend) drills into merchants.
  const visKids = (node, calc) => (calc.kids[node.id] || []).filter(c => showZero || (calc.totals[c.id] || 0) !== 0)
  const groupsOf = (calc) => { const root = (calc.kids['__root'] || [])[0]; return root ? visKids(root, calc) : [] }

  const defaultOpen = (depth) => view === 'detailed' && depth === 0    // Detailed pre-opens main categories
  const isOpen = (id, depth) => (id in expandedMap) ? expandedMap[id] : defaultOpen(depth)
  const toggle = (id, depth) => setExpandedMap(m => ({ ...m, [id]: !isOpen(id, depth) }))

  // All expandable ids for Expand/Collapse all: COA groups plus spending leaves (which
  // drill into merchants). `leaves` is the subset that needs a lazy transaction fetch.
  const collectExpandable = () => {
    const ids = [], leaves = []
    const walk = (node, calc) => {
      const kids = visKids(node, calc)
      if (kids.length) { ids.push(node.id); kids.forEach(k => walk(k, calc)) }
      else if ((calc.totals[node.id] || 0) !== 0) { ids.push(node.id); leaves.push(node.id) }
    }
    for (const calc of [pInc, pExp, bInc, bExp]) groupsOf(calc).forEach(g => walk(g, calc))
    return { ids, leaves }
  }
  const expandAll = () => {
    const { ids, leaves } = collectExpandable()
    setExpandedMap(Object.fromEntries(ids.map(id => [id, true])))
    leaves.forEach(id => { if (!leafTxns[id]) fetchLeaf(id) })
  }
  const collapseAll = () => setExpandedMap(Object.fromEntries(collectExpandable().ids.map(id => [id, false])))

  // Group a leaf's transactions by merchant (location/type), biggest spend first.
  const groupByMerchant = (txns) => {
    const map = new Map()
    for (const t of txns) {
      const key = t.merchant || 'Unknown'
      const g = map.get(key) || { name: key, amount: 0, count: 0, txns: [] }
      g.amount += t.amount; g.count += 1; g.txns.push(t)
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount)
  }

  // Lazily load a spending leaf's transactions for the report's actual period (data.period),
  // so the drill-down always matches the totals on screen even if the date inputs changed.
  const fetchLeaf = async (coaId) => {
    const start = data?.period?.start, end = data?.period?.end
    setLeafTxns(m => ({ ...m, [coaId]: { loading: true } }))
    try {
      const params = new URLSearchParams({ coaId, startDate: start, endDate: end })
      const { data: d } = await axios.get(`${API}/pl/transactions?${params}`)
      // A missing endpoint (stale backend) falls through to the SPA → HTML, not JSON.
      // Treat anything without a transactions array as an error, not "no transactions".
      if (!d || !Array.isArray(d.transactions)) throw new Error('unexpected response')
      setLeafTxns(m => ({ ...m, [coaId]: { loading: false, groups: groupByMerchant(d.transactions), total: d.total, count: d.count } }))
    } catch {
      setLeafTxns(m => ({ ...m, [coaId]: { loading: false, error: true } }))
    }
  }

  // Toggle a row; on first open of a spending leaf, kick off its merchant fetch.
  const onToggleNode = (node, depth, drillable) => {
    const willOpen = !isOpen(node.id, depth)
    toggle(node.id, depth)
    if (willOpen && drillable && !leafTxns[node.id]) fetchLeaf(node.id)
  }

  // A muted single-line note (loading / empty / error) indented to a given depth.
  const infoRow = (depth, content, key) => (
    <div key={key} style={{ padding:'6px 8px', paddingLeft:8 + depth*18, fontSize:12, color:'var(--text-muted)', borderBottom:'0.5px solid var(--border)' }}>{content}</div>
  )

  // One individual transaction (deepest level): date · account — amount.
  const renderTxn = (t, depth, color) => (
    <div key={t.id} className="pl-row" style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', paddingLeft:8 + depth*18, borderBottom:'0.5px solid var(--border)' }}>
      <span style={{ width:13, flexShrink:0 }}/>
      <span style={{ flex:1, minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize:12, color:'var(--text-muted)' }}>
        {fmtDate(t.date)}{t.account ? ` · ${t.account}` : ''}{t.pending ? ' · pending' : ''}
      </span>
      <span style={{ flexShrink:0, fontSize:12, color, fontVariantNumeric:'tabular-nums' }}>{fd(t.amount)}</span>
      <span style={{ width:12, flexShrink:0 }}/>
    </div>
  )

  // One merchant/location under a leaf. Single-purchase merchants show their date inline;
  // multi-purchase merchants get their own caret that expands into individual transactions.
  const renderMerchantGroup = (g, leafId, depth, color) => {
    const single = g.txns.length === 1
    const mkey = `m:${leafId}:${g.name}`
    const open = !single && expandedMap[mkey] === true
    return (
      <Fragment key={mkey}>
        <div className="pl-row" onClick={single ? undefined : () => setExpandedMap(m => ({ ...m, [mkey]: !open }))}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 8px', paddingLeft:8 + depth*18, borderBottom:'0.5px solid var(--border)', cursor: single ? 'default' : 'pointer' }}>
          <span style={{ width:13, flexShrink:0, display:'inline-flex', justifyContent:'center', color:'var(--text-muted)' }}>
            {!single && <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize:12 }} aria-hidden="true"/>}
          </span>
          <span style={{ flex:1, minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize:12.5, color:'var(--text-secondary)' }}>
            {g.name}
            <span style={{ marginLeft:8, fontSize:11, color:'var(--text-muted)' }}>{single ? fmtDate(g.txns[0].date) : `${g.count} txns`}</span>
          </span>
          <span style={{ flexShrink:0, fontSize:12.5, color, fontVariantNumeric:'tabular-nums' }}>{fd(g.amount)}</span>
          <span style={{ width:12, flexShrink:0 }}/>
        </div>
        {open && g.txns.map(t => renderTxn(t, depth + 1, color))}
      </Fragment>
    )
  }

  // The merchant list shown when a spending leaf is expanded (lazy-loaded).
  const renderMerchants = (leafId, depth, color) => {
    const entry = leafTxns[leafId]
    if (!entry || entry.loading) return infoRow(depth, <span><i className="ti ti-loader-2 spin" aria-hidden="true"/> Loading…</span>, leafId + ':load')
    if (entry.error)             return infoRow(depth, 'Couldn’t load transactions.', leafId + ':err')
    if (!entry.groups || !entry.groups.length) return infoRow(depth, 'No transactions in this period.', leafId + ':none')
    return entry.groups.map(g => renderMerchantGroup(g, leafId, depth, color))
  }

  // One report row. Groups expand into sub-categories; spending leaves drill into merchants.
  const renderRow = (node, calc, depth, color, scopeTotal) => {
    const total = calc.totals[node.id] || 0
    if (!showZero && total === 0) return null
    const kids = visKids(node, calc)
    const hasCoaKids = kids.length > 0
    const drillable = !hasCoaKids && total !== 0          // spending leaf with transactions behind it
    const expandable = hasCoaKids || drillable
    const open = expandable && isOpen(node.id, depth)
    const count = calc.counts[node.id] || 0
    const strong = depth === 0 ? 600 : (hasCoaKids ? 500 : 400)
    return (
      <Fragment key={node.id}>
        <div className="pl-row" onClick={() => expandable && onToggleNode(node, depth, drillable)}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 8px', paddingLeft:8 + depth*18, borderBottom:'0.5px solid var(--border)', cursor: expandable ? 'pointer' : 'default' }}>
          <span style={{ width:13, flexShrink:0, display:'inline-flex', justifyContent:'center', color:'var(--text-muted)' }}>
            {expandable && <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize:12 }} aria-hidden="true"/>}
          </span>
          <span style={{ flex:1, minWidth:0, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', fontSize: depth===0?13:12.5, fontWeight:strong, color: depth===0?'var(--text-primary)':'var(--text-secondary)' }}>
            {node.name}
            {!hasCoaKids && count > 0 && <span style={{ marginLeft:8, fontSize:11, color:'var(--text-muted)', fontWeight:400 }}>· {count} txn{count>1?'s':''}</span>}
          </span>
          {depth===0 && scopeTotal > 0 && <span style={{ fontSize:11, color:'var(--text-muted)', flexShrink:0 }}>{pct(total, scopeTotal)}</span>}
          <span style={{ flexShrink:0, fontSize: depth===0?13:12.5, fontWeight:strong, color, fontVariantNumeric:'tabular-nums' }}>{fd(total)}</span>
          <span style={{ width:12, flexShrink:0 }}/>
        </div>
        {open && hasCoaKids && kids.map(c => renderRow(c, calc, depth+1, color, scopeTotal))}
        {open && drillable && renderMerchants(node.id, depth+1, color)}
      </Fragment>
    )
  }

  const totalRow = (label, val, color, weight = 600, border = '0.5px solid var(--border)') => (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'6px 8px', fontSize:13, fontWeight:weight, borderTop:border }}>
      <span>{label}</span><span style={{ color, fontVariantNumeric:'tabular-nums' }}>{fd(val)}</span>
    </div>
  )
  const subHead = (label, color, margin) => (
    <p style={{ fontSize:11, fontWeight:600, color, margin, textTransform:'uppercase', letterSpacing:'0.5px' }}>{label}</p>
  )
  const renderScope = (key, label, incomeLabel, netLabel, incTree, expTree, incT, expT) => {
    if (!showZero && incT === 0 && expT === 0) return null
    const net = incT - expT
    return (
      <div key={key} style={{ marginBottom:20 }}>
        <p style={{ fontSize:12, fontWeight:700, margin:'0 0 4px', paddingBottom:5, borderBottom:'2px solid var(--border)', textTransform:'uppercase', letterSpacing:'0.6px', color:'var(--text-secondary)' }}>{label}</p>
        {subHead(incomeLabel, 'var(--green)', '10px 0 2px')}
        {groupsOf(incTree).map(g => renderRow(g, incTree, 0, 'var(--green)', incT))}
        {incT === 0 && <Empty text={`No ${incomeLabel.toLowerCase()} in this period.`}/>}
        {totalRow(`Total ${incomeLabel}`, incT, 'var(--green)')}
        {subHead('Expenses', 'var(--coral)', '16px 0 2px')}
        {groupsOf(expTree).map(g => renderRow(g, expTree, 0, 'var(--coral)', expT))}
        {expT === 0 && <Empty text="No expenses in this period."/>}
        {totalRow('Total Expenses', expT, 'var(--coral)')}
        {totalRow(netLabel, net, net >= 0 ? 'var(--teal)' : 'var(--coral)', 700, '1px solid var(--border)')}
      </div>
    )
  }

  const segBtn = (val, label, icon) => (
    <button onClick={() => setView(val)}
      style={{ fontSize:12, padding:'5px 12px', borderRadius:0, border:'none', cursor:'pointer', background: view===val?'var(--blue-light)':'transparent', color: view===val?'var(--blue)':'var(--text-secondary)', fontWeight: view===val?600:400 }}>
      <i className={`ti ${icon}`} aria-hidden="true"/> {label}
    </button>
  )
  const ctrlBtn = { fontSize:12, padding:'5px 10px', background:'var(--bg-secondary)', color:'var(--text-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', cursor:'pointer' }

  return (
    <div>
      {/* Date range + run */}
      <div style={{ display:'flex', gap:10, alignItems:'flex-end', marginBottom:12, flexWrap:'wrap' }}>
        <div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>From</label>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{fontSize:12}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>To</label>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{fontSize:12}}/>
        </div>
        <button onClick={load} disabled={loading} style={{fontSize:12,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>
          <i className={`ti ${loading?'ti-loader-2 spin':'ti-refresh'}`} aria-hidden="true"/> Run report
        </button>
      </div>

      {/* View toggle + expand controls */}
      <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:18, flexWrap:'wrap' }}>
        <div style={{ display:'flex', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
          {segBtn('summary', 'Summary', 'ti-list')}
          {segBtn('detailed', 'Detailed', 'ti-list-tree')}
        </div>
        <button onClick={expandAll} style={ctrlBtn}><i className="ti ti-arrows-maximize" aria-hidden="true"/> Expand all</button>
        <button onClick={collapseAll} style={ctrlBtn}><i className="ti ti-arrows-minimize" aria-hidden="true"/> Collapse all</button>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--text-secondary)', marginLeft:'auto', cursor:'pointer' }}>
          <input type="checkbox" checked={showZero} onChange={e=>setShowZero(e.target.checked)}/> Show empty categories
        </label>
      </div>

      {loading && !data ? (
        <div style={{ color:'var(--text-muted)', fontSize:13, padding:'24px 0' }}><i className="ti ti-loader-2 spin" aria-hidden="true"/> Generating report…</div>
      ) : data ? (
        <div className="card" style={{ maxWidth:620, padding:'18px 16px' }}>
          <div style={{ textAlign:'center', marginBottom:10 }}>
            <p style={{ fontSize:14, fontWeight:600, margin:0 }}>Profit &amp; Loss</p>
            <p style={{ fontSize:11, color:'var(--text-muted)', margin:'2px 0 0' }}>
              {new Date(data.period.start).toLocaleDateString()} – {new Date(data.period.end).toLocaleDateString()}
            </p>
          </div>
          {empty ? (
            <Empty text="No report data found for this date range."/>
          ) : (
            <>
              {renderScope('personal', 'Personal', 'Income', 'Net Surplus / (Deficit)', pInc, pExp, pIncT, pExpT)}
              {renderScope('business', 'Business', 'Revenue', 'Net Income', bInc, bExp, bIncT, bExpT)}
              <div style={{ display:'flex', justifyContent:'space-between', padding:'12px 8px 2px', marginTop:4, fontSize:16, fontWeight:700, borderTop:'2px solid var(--border)' }}>
                <span>Net Income (All)</span><span style={{ color: overallNet>=0?'var(--teal)':'var(--coral)', fontVariantNumeric:'tabular-nums' }}>{fd(overallNet)}</span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── Balance Sheet (hierarchical: linked accounts + properties + fixed assets + manual) ──
function BalanceSheet() {
  const [coa, setCoa]             = useState([])
  const [balances, setBalances]   = useState({})     // manual category balances
  const [live, setLive]           = useState(null)    // { asOf, byLeaf, totals }
  const [expanded, setExpanded]   = useState({})
  const [editing, setEditing]     = useState(null)
  const [draft, setDraft]         = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [loading, setLoading]     = useState(true)

  const load = async () => {
    try {
      const [c, b, l] = await Promise.all([
        axios.get(`${API}/coa`),
        axios.get(`${API}/category-balances`),
        axios.get(`${API}/balance-sheet`),
      ])
      setCoa(Array.isArray(c.data) ? c.data : [])
      setBalances(b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {})
      setLive(l.data && typeof l.data === 'object' ? l.data : null)
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  // Each leaf's amount = linked balance (accounts / properties / capitalized buys) + manual entry.
  const byLeaf   = (live && live.byLeaf) || {}
  const manualOf = id => (balances[id]?.amount || 0)
  const amountOf = id => (byLeaf[id]?.linked || 0) + manualOf(id)

  const assets      = computeTotals(coa.filter(a => a.type === 'asset'),     amountOf)
  const liabilities = computeTotals(coa.filter(a => a.type === 'liability'), amountOf)
  const equity      = computeTotals(coa.filter(a => a.type === 'equity'),    amountOf)

  const totalAssets = rootTotal(assets)
  const totalLiab   = rootTotal(liabilities)
  const netWorth    = totalAssets - totalLiab

  const saveBalance = async (id) => {
    const amt = parseFloat(draft)
    try {
      const { data } = await axios.put(`${API}/category-balances/${id}`, { amount: isNaN(amt) ? 0 : amt })
      setBalances(data && typeof data === 'object' && !Array.isArray(data) ? data : {})
    } catch {}
    setEditing(null); setDraft('')
  }

  const isExp = (id, depth) => expanded[id] ?? (depth === 0)

  const renderNode = (node, calc, depth) => {
    const kids  = calc.kids[node.id] || []
    const total = calc.totals[node.id] || 0
    if (kids.length > 0) {
      if (!showEmpty && total === 0) return null
      const exp = isExp(node.id, depth)
      return (
        <Fragment key={node.id}>
          <div onClick={() => setExpanded(p => ({ ...p, [node.id]: !isExp(node.id, depth) }))}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 0', paddingLeft:depth*16, borderBottom:'0.5px solid var(--border)', cursor:'pointer' }}>
            <i className={`ti ${exp ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize:12, color:'var(--text-muted)', width:14 }} aria-hidden="true"/>
            <span style={{ flex:1, fontSize:13, fontWeight: depth === 0 ? 600 : 500 }}>{node.name}</span>
            <span style={{ fontSize:13, fontWeight:600, fontVariantNumeric:'tabular-nums' }}>{fd(total)}</span>
          </div>
          {exp && kids.map(c => renderNode(c, calc, depth + 1))}
        </Fragment>
      )
    }
    // Leaf: header (linked + manual total, click to edit the manual part) + itemized linked rows.
    const accts     = byLeaf[node.id]?.accounts || []
    const manual    = manualOf(node.id)
    const leafTotal = amountOf(node.id)
    if (!showEmpty && leafTotal === 0 && accts.length === 0) return null
    const ed = editing === node.id
    return (
      <Fragment key={node.id}>
        <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 0', paddingLeft:depth*16 + 20, borderBottom:'0.5px solid var(--border)' }}>
          <span style={{ flex:1, fontSize:12, color:'var(--text-secondary)' }}>{node.name}</span>
          {ed ? (
            <input autoFocus type="number" value={draft} onChange={e => setDraft(e.target.value)}
              onBlur={() => saveBalance(node.id)} onKeyDown={e => { if (e.key === 'Enter') saveBalance(node.id); if (e.key === 'Escape') { setEditing(null); setDraft('') } }}
              placeholder="0.00" style={{ width:120, fontSize:12, textAlign:'right', padding:'3px 6px' }}/>
          ) : (
            <span onClick={() => { setEditing(node.id); setDraft(manual ? String(manual) : '') }}
              title={accts.length ? 'Click to add a manual adjustment on top of the linked balance' : 'Click to enter a manual balance'}
              style={{ fontSize:12, cursor:'pointer', minWidth:84, textAlign:'right', color: leafTotal ? 'var(--text-primary)' : 'var(--text-muted)', borderBottom:'1px dashed var(--border)', fontVariantNumeric:'tabular-nums' }}>
              {leafTotal ? fd(leafTotal) : '+ add'}
            </span>
          )}
        </div>
        {accts.map((a, i) => (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0', paddingLeft:depth*16 + 38 }}>
            <i className="ti ti-link" style={{ fontSize:10, color:'var(--teal)' }} aria-hidden="true"/>
            <span style={{ flex:1, fontSize:11, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {a.name}{a.last4 ? ` ••${a.last4}` : ''}
            </span>
            {a.needsReview && <span style={{ fontSize:9, fontWeight:600, color:'var(--amber)', background:'var(--amber-light)', border:'0.5px solid var(--amber)', borderRadius:99, padding:'0 6px' }}>review</span>}
            <span style={{ fontSize:11, color:'var(--text-muted)', minWidth:72, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fd(a.balance)}</span>
          </div>
        ))}
        {manual !== 0 && accts.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'2px 0', paddingLeft:depth*16 + 38 }}>
            <i className="ti ti-pencil" style={{ fontSize:10, color:'var(--text-muted)' }} aria-hidden="true"/>
            <span style={{ flex:1, fontSize:11, color:'var(--text-muted)' }}>Manual adjustment</span>
            <span style={{ fontSize:11, color:'var(--text-muted)', minWidth:72, textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{fd(manual)}</span>
          </div>
        )}
      </Fragment>
    )
  }

  const renderTree = (calc) => {
    const roots = (calc.kids['__root'] || []).filter(r => showEmpty || (calc.totals[r.id] || 0) !== 0)
    if (roots.length === 0) return <p style={{ fontSize:12, color:'var(--text-muted)', margin:'4px 0' }}>Nothing yet — connect accounts, or tick “Show empty categories” to add a manual balance.</p>
    return roots.map(r => renderNode(r, calc, 0))
  }

  if (loading) return <div style={{ color:'var(--text-muted)', fontSize:13 }}>Loading…</div>

  const hasEquityRows = (equity.kids['__root'] || []).some(r => (equity.totals[r.id] || 0) !== 0)

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, gap:12, flexWrap:'wrap' }}>
        <p style={{ fontSize:12, color:'var(--text-muted)', margin:0, flex:1, minWidth:240 }}>
          As of {new Date(live?.asOf || Date.now()).toLocaleDateString()} · linked balances come from connected accounts, properties &amp; capitalized purchases; click any category to add a manual balance.
        </p>
        <label style={{ fontSize:11, color:'var(--text-secondary)', display:'flex', alignItems:'center', gap:6, cursor:'pointer', whiteSpace:'nowrap' }}>
          <input type="checkbox" checked={showEmpty} onChange={e => setShowEmpty(e.target.checked)}/> Show empty categories
        </label>
      </div>

      {/* Grand totals */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:18 }}>
        {[['Total Assets','var(--blue)',totalAssets],['Total Liabilities','var(--coral)',totalLiab],['Net Worth',netWorth>=0?'var(--teal)':'var(--coral)',netWorth]].map(([label,color,val])=>(
          <div key={label} className="metric-card">
            <p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px'}}>{label}</p>
            <p style={{fontSize:20,fontWeight:500,margin:0,color}}>{fd(val)}</p>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, alignItems:'start' }}>
        {/* Assets */}
        <div className="card" style={{ borderLeft:'3px solid var(--blue)' }}>
          <p style={{ fontSize:13, fontWeight:600, color:'var(--blue)', margin:'0 0 12px' }}>ASSETS</p>
          {renderTree(assets)}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, fontWeight:700, borderTop:'1px solid var(--border)', paddingTop:10, marginTop:8 }}>
            <span style={{ color:'var(--blue)' }}>Total Assets</span><span style={{ color:'var(--blue)' }}>{fd(totalAssets)}</span>
          </div>
        </div>

        {/* Liabilities + Equity */}
        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
          <div className="card" style={{ borderLeft:'3px solid var(--coral)' }}>
            <p style={{ fontSize:13, fontWeight:600, color:'var(--coral)', margin:'0 0 12px' }}>LIABILITIES</p>
            {renderTree(liabilities)}
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, fontWeight:700, borderTop:'1px solid var(--border)', paddingTop:10, marginTop:8 }}>
              <span style={{ color:'var(--coral)' }}>Total Liabilities</span><span style={{ color:'var(--coral)' }}>{fd(totalLiab)}</span>
            </div>
          </div>

          <div className="card" style={{ borderLeft:'3px solid var(--teal)' }}>
            <p style={{ fontSize:13, fontWeight:600, color:'var(--teal)', margin:'0 0 12px' }}>EQUITY / NET WORTH</p>
            {hasEquityRows && <div style={{ marginBottom:8 }}>{renderTree(equity)}</div>}
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--text-secondary)', padding:'2px 0' }}>
              <span>Total Assets</span><span style={{ fontVariantNumeric:'tabular-nums' }}>{fd(totalAssets)}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--text-secondary)', padding:'2px 0' }}>
              <span>− Total Liabilities</span><span style={{ fontVariantNumeric:'tabular-nums' }}>{fd(totalLiab)}</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:16, fontWeight:700, borderTop:'1px solid var(--border)', paddingTop:10, marginTop:8 }}>
              <span>Net Worth</span><span style={{ color: netWorth>=0?'var(--teal)':'var(--coral)' }}>{fd(netWorth)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Invoices ──────────────────────────────────────────────────────────
function Invoices() {
  const PROPS = useProperties()
  const [invoices, setInvoices] = useState([])
  const [modal, setModal]   = useState(false)
  const [form, setForm]     = useState({ propertyId:'', tenantName:'', amount:'', dueDate:'', issueDate:new Date().toISOString().split('T')[0], notes:'', recurring:false })

  const load = () => axios.get(`${API}/invoices`).then(r=>setInvoices(r.data)).catch(()=>{})
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.tenantName || !form.amount || !form.dueDate) return
    const inv = { ...form, amount: parseFloat(form.amount), items:[{description:'Monthly rent', amount:parseFloat(form.amount)}] }
    await axios.post(`${API}/invoices`, inv)
    setModal(false); load()
  }

  const updateStatus = async (id, status) => {
    await axios.put(`${API}/invoices/${id}`, { status, ...(status==='paid'?{paidDate:new Date().toISOString().split('T')[0]}:{}) })
    load()
  }

  const del = async (id) => {
    if (!window.confirm('Delete invoice?')) return
    await axios.delete(`${API}/invoices/${id}`); load()
  }

  const summary = { total: invoices.length, paid: invoices.filter(i=>i.status==='paid').length, overdue: invoices.filter(i=>i.status==='overdue').length, pending: invoices.filter(i=>['draft','sent'].includes(i.status)).length, totalDue: invoices.filter(i=>['sent','overdue'].includes(i.status)).reduce((s,i)=>s+i.amount,0) }

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:20}}>
        {[['Open Invoices',summary.pending,'var(--blue)'],['Overdue',summary.overdue,'var(--coral)'],['Paid',summary.paid,'var(--teal)'],['Amount Due',fd(summary.totalDue),'var(--amber)']].map(([l,v,c])=>(
          <div key={l} className="metric-card"><p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px'}}>{l}</p><p style={{fontSize:20,fontWeight:500,margin:0,color:c}}>{v}</p></div>
        ))}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Rent Roll & Invoices</p>
        <button onClick={()=>setModal(true)} style={{fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> New invoice
        </button>
      </div>

      {invoices.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-file-invoice" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No invoices yet — create your first rent invoice</p>
        </div>
      ) : (
        <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',overflow:'hidden'}}>
          {invoices.map((inv, i) => (
            <div key={inv.id} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderBottom:i<invoices.length-1?'0.5px solid var(--border)':'none',background:'var(--bg-card)'}}>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                  <span style={{fontSize:13,fontWeight:500}}>{inv.tenantName || 'Tenant'}</span>
                  <Badge status={inv.status}/>
                  {PROPS.find(p=>p.id===inv.propertyId) && <span style={{fontSize:11,color:'var(--text-muted)'}}>{PROPS.find(p=>p.id===inv.propertyId)?.name}</span>}
                </div>
                <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>Due {inv.dueDate} {inv.recurring && '· Recurring'}</p>
              </div>
              <span style={{fontSize:15,fontWeight:500,color:'var(--teal)'}}>{fd(inv.amount)}</span>
              <div style={{display:'flex',gap:4}}>
                {inv.status === 'draft' && <button onClick={()=>updateStatus(inv.id,'sent')} style={{fontSize:11,padding:'3px 8px',background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>Send</button>}
                {['sent','overdue'].includes(inv.status) && <button onClick={()=>updateStatus(inv.id,'paid')} style={{fontSize:11,padding:'3px 8px',background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>Mark paid</button>}
                <button onClick={()=>del(inv.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title="New Invoice" onClose={()=>setModal(false)}>
          <Field label="Property">
            <select value={form.propertyId} onChange={e=>setForm(p=>({...p,propertyId:e.target.value}))} style={{width:'100%'}}>
              {PROPS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Tenant name *"><input value={form.tenantName} onChange={e=>setForm(p=>({...p,tenantName:e.target.value}))} placeholder="John Doe" style={{width:'100%'}}/></Field>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Amount *"><input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="6500" style={{width:'100%'}}/></Field>
            <Field label="Due date *"><input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Issue date"><input type="date" value={form.issueDate} onChange={e=>setForm(p=>({...p,issueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} rows={2} style={{width:'100%'}}/></Field>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,marginBottom:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.recurring} onChange={e=>setForm(p=>({...p,recurring:e.target.checked}))}/> Recurring monthly invoice
          </label>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(false)}>Cancel</button>
            <button onClick={save} style={{background:'var(--teal)',color:'#fff',border:'none'}}>Create invoice</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Bills ─────────────────────────────────────────────────────────────
function Bills() {
  const PROPS = useProperties()
  const [bills, setBills]   = useState([])
  const [vendors, setVendors] = useState([])
  const [modal, setModal]   = useState(false)
  const [form, setForm]     = useState({ vendorId:'', propertyId:'', amount:'', dueDate:'', category:'Mortgage Payment', notes:'', recurring:false, recurringPeriod:'monthly' })

  const load = () => {
    axios.get(`${API}/bills`).then(r=>setBills(r.data)).catch(()=>{})
    axios.get(`${API}/vendors`).then(r=>setVendors(r.data)).catch(()=>{})
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.amount || !form.dueDate) return
    await axios.post(`${API}/bills`, { ...form, amount: parseFloat(form.amount) })
    setModal(false); load()
  }

  const markPaid = async (id) => {
    await axios.put(`${API}/bills/${id}`, { status:'paid', paidDate: new Date().toISOString().split('T')[0] }); load()
  }
  const del = async (id) => { if (!window.confirm('Delete bill?')) return; await axios.delete(`${API}/bills/${id}`); load() }

  const totalDue = bills.filter(b=>['unpaid','overdue'].includes(b.status)).reduce((s,b)=>s+b.amount,0)

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:20}}>
        {[['Unpaid Bills',bills.filter(b=>b.status==='unpaid').length,'var(--amber)'],['Overdue',bills.filter(b=>b.status==='overdue').length,'var(--coral)'],['Paid This Month',bills.filter(b=>b.status==='paid'&&b.paidDate>=new Date().toISOString().slice(0,7)).length,'var(--teal)'],['Total Due',fd(totalDue),'var(--coral)']].map(([l,v,c])=>(
          <div key={l} className="metric-card"><p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px'}}>{l}</p><p style={{fontSize:20,fontWeight:500,margin:0,color:c}}>{v}</p></div>
        ))}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Bills & Payables</p>
        <button onClick={()=>setModal(true)} style={{fontSize:12,background:'var(--amber-light)',color:'var(--amber)',borderColor:'var(--amber)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> New bill
        </button>
      </div>

      {bills.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-receipt" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No bills yet</p>
        </div>
      ) : (
        <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',overflow:'hidden'}}>
          {bills.map((bill,i) => {
            const vendor = vendors.find(v=>v.id===bill.vendorId)
            const prop   = PROPS.find(p=>p.id===bill.propertyId)
            return (
              <div key={bill.id} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderBottom:i<bills.length-1?'0.5px solid var(--border)':'none',background:'var(--bg-card)'}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <span style={{fontSize:13,fontWeight:500}}>{vendor?.name || bill.category}</span>
                    <Badge status={bill.status}/>
                    {prop && <span style={{fontSize:11,color:'var(--text-muted)'}}>{prop.name}</span>}
                  </div>
                  <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>Due {bill.dueDate} {bill.recurring&&'· '+bill.recurringPeriod}</p>
                </div>
                <span style={{fontSize:15,fontWeight:500,color:'var(--coral)'}}>{fd(bill.amount)}</span>
                <div style={{display:'flex',gap:4}}>
                  {['unpaid','overdue'].includes(bill.status) && <button onClick={()=>markPaid(bill.id)} style={{fontSize:11,padding:'3px 8px',background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>Mark paid</button>}
                  <button onClick={()=>del(bill.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <Modal title="New Bill" onClose={()=>setModal(false)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Vendor">
              <select value={form.vendorId} onChange={e=>setForm(p=>({...p,vendorId:e.target.value}))} style={{width:'100%'}}>
                <option value="">No vendor</option>
                {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="Property">
              <select value={form.propertyId} onChange={e=>setForm(p=>({...p,propertyId:e.target.value}))} style={{width:'100%'}}>
                <option value="">General</option>
                {PROPS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Amount *"><input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="1200" style={{width:'100%'}}/></Field>
            <Field label="Due date *"><input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Category"><input value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} placeholder="Mortgage Payment" style={{width:'100%'}}/></Field>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,marginBottom:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.recurring} onChange={e=>setForm(p=>({...p,recurring:e.target.checked}))}/>
            Recurring
            {form.recurring && <select value={form.recurringPeriod} onChange={e=>setForm(p=>({...p,recurringPeriod:e.target.value}))} style={{marginLeft:8,fontSize:12}}>
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annually">Annually</option>
            </select>}
          </label>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(false)}>Cancel</button>
            <button onClick={save} style={{background:'var(--amber)',color:'#fff',border:'none'}}>Create bill</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Vendors ───────────────────────────────────────────────────────────
function Vendors() {
  const [vendors, setVendors] = useState([])
  const [modal, setModal]     = useState(null)
  const [form, setForm]       = useState({ name:'', type:'contractor', email:'', phone:'', address:'', notes:'' })

  const load = () => axios.get(`${API}/vendors`).then(r=>setVendors(r.data)).catch(()=>{})
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name) return
    if (modal === 'add') { await axios.post(`${API}/vendors`, form) }
    else { await axios.put(`${API}/vendors/${modal.id}`, form) }
    setModal(null); load()
  }
  const del = async (id) => { if (!window.confirm('Delete vendor?')) return; await axios.delete(`${API}/vendors/${id}`); load() }
  const openEdit = v => { setForm({ name:v.name, type:v.type||'contractor', email:v.email||'', phone:v.phone||'', address:v.address||'', notes:v.notes||'' }); setModal(v) }
  const openAdd  = () => { setForm({ name:'', type:'contractor', email:'', phone:'', address:'', notes:'' }); setModal('add') }

  const VENDOR_TYPES = ['contractor','lender','insurance','utility','service','other']

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Vendors & Payees ({vendors.length})</p>
        <button onClick={openAdd} style={{fontSize:12,background:'var(--purple-light)',color:'var(--purple)',borderColor:'var(--purple)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> Add vendor
        </button>
      </div>

      {vendors.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-building-community" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No vendors yet — add your contractors, lenders, and service providers</p>
        </div>
      ) : (
        <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10}}>
          {vendors.map(v => (
            <div key={v.id} className="card" style={{display:'flex',alignItems:'flex-start',gap:12}}>
              <div style={{width:36,height:36,borderRadius:'var(--radius-md)',background:'var(--purple-light)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <i className="ti ti-building" style={{fontSize:17,color:'var(--purple)'}} aria-hidden="true"/>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:13,fontWeight:500,margin:'0 0 3px'}}>{v.name}</p>
                <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>{v.type}{v.email&&` · ${v.email}`}</p>
              </div>
              <div style={{display:'flex',gap:4}}>
                <button onClick={()=>openEdit(v)} style={{fontSize:11,padding:'3px 8px',background:'none',borderColor:'var(--border-light)'}}><i className="ti ti-edit" aria-hidden="true"/></button>
                <button onClick={()=>del(v.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal==='add'?'Add Vendor':'Edit Vendor'} onClose={()=>setModal(null)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Name *"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="ABC Contractors" style={{width:'100%'}}/></Field>
            <Field label="Type">
              <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={{width:'100%'}}>
                {VENDOR_TYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
              </select>
            </Field>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Email"><input type="email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} style={{width:'100%'}}/></Field>
            <Field label="Phone"><input value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Address"><input value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))} style={{width:'100%'}}/></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} rows={2} style={{width:'100%'}}/></Field>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(null)}>Cancel</button>
            <button onClick={save} style={{background:'var(--purple)',color:'#fff',border:'none'}}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Main Accounting Component ─────────────────────────────────────────
// Only P&L + Balance Sheet for now. Invoices/Bills/Vendors/ChartOfAccounts components
// remain defined below and can be re-added here when needed.
const TABS = [
  { id:'pl', label:'P&L',           icon:'ti-chart-bar' },
  { id:'bs', label:'Balance Sheet', icon:'ti-scale'     },
]

export default function Accounting() {
  const [tab, setTab] = useState('pl')
  return (
    <div>
      <div style={{display:'flex',gap:0,borderBottom:'0.5px solid var(--border)',marginBottom:20,flexWrap:'wrap'}}>
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{display:'flex',alignItems:'center',gap:7,padding:'10px 16px',background:'none',border:'none',
              borderBottom:`2px solid ${tab===t.id?'var(--blue)':'transparent'}`,
              color:tab===t.id?'var(--blue)':'var(--text-secondary)',
              fontWeight:tab===t.id?500:400,fontSize:13,cursor:'pointer',borderRadius:0,marginBottom:-1}}>
            <i className={`ti ${t.icon}`} aria-hidden="true"/> {t.label}
          </button>
        ))}
      </div>
      {tab === 'pl' && <PLReport/>}
      {tab === 'bs' && <BalanceSheet/>}
    </div>
  )
}
