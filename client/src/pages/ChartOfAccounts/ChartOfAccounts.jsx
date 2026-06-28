// ChartOfAccounts.jsx — your master list of money categories, on one screen.
//
// A single collapsible tree (Income · Expenses · Assets · Liabilities · Net worth) with
// the amount in each category beside it. Search, a Personal/Business filter, and a period
// picker sit on top. Click a category to see the transactions behind it; rename inline;
// add / hide / delete from the row menu. Everything reads and writes the SAME backend the
// Banking tab and Report use — no separate model, no demo data.

import { useState, useMemo } from 'react'
import { useChartOfAccounts, buildTree, postableLeaves, parentOptions } from './useChartOfAccounts'
import { PERIODS, periodRange, periodLabel, BAND } from './coaConfig'
import CategoryRow from './CategoryRow'
import TransactionDrawer from './TransactionDrawer'
import AddCategoryPanel from './AddCategoryPanel'
import { LoadingState, EmptyState } from './States'

const SCOPES = [{ key: 'all', label: 'All' }, { key: 'personal', label: 'Personal' }, { key: 'business', label: 'Business' }]

export default function ChartOfAccounts() {
  const [periodKey, setPeriodKey] = useState('ytd')
  const period = useMemo(() => periodRange(periodKey), [periodKey])

  const {
    coa, amountById, countById, balanceById, loading, error,
    reloadAmounts, addCategory, renameCategory, setActive, removeCategory,
  } = useChartOfAccounts(period)

  const [scope, setScope]     = useState('all')
  const [search, setSearch]   = useState('')
  const [expanded, setExpanded] = useState({})
  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [menuId, setMenuId]   = useState(null)
  const [drawerNode, setDrawerNode] = useState(null)
  const [addPanel, setAddPanel] = useState(null)   // { parentId } | null
  const [notice, setNotice]   = useState(null)     // { type, msg }

  const rows = useMemo(
    () => buildTree(coa, { scope, search, amountById, countById, balanceById, expanded, periodLabel: periodLabel(periodKey) }),
    [coa, scope, search, amountById, countById, balanceById, expanded, periodKey]
  )
  const moveOptions = useMemo(() => postableLeaves(coa), [coa])
  const parentOpts  = useMemo(() => parentOptions(coa), [coa])

  const toggleExpand = (id) => setExpanded(m => ({ ...m, [id]: !m[id] }))

  const startRename = (node) => { setEditingId(node.id); setEditValue(node.name) }
  const cancelRename = () => { setEditingId(null); setEditValue('') }
  const commitRename = async () => {
    const id = editingId; if (!id) return
    const node = coa.find(n => n.id === id)
    const v = editValue.trim()
    setEditingId(null)
    if (node && v && v !== node.name) {
      const r = await renameCategory(id, v)
      if (!r.ok) setNotice({ type: 'error', msg: r.error })
    }
  }

  const onMenu = async (action, node) => {
    if (action === 'rename') return startRename(node)
    if (action === 'add_child') return setAddPanel({ parentId: node.id })
    if (action === 'hide' || action === 'unhide') {
      const r = await setActive(node.id, action === 'unhide')
      if (!r.ok) setNotice({ type: 'error', msg: r.error })
      return
    }
    if (action === 'delete') {
      if (!window.confirm(`Delete "${node.name}"? This can’t be undone.`)) return
      const r = await removeCategory(node.id)
      setNotice(r.ok ? { type: 'ok', msg: `Deleted "${node.name}".` } : { type: 'error', msg: r.error })
    }
  }

  const onAdd = async (payload) => {
    const r = await addCategory(payload)
    if (r.ok) { setExpanded(m => ({ ...m, [payload.parentId]: true })); setNotice({ type: 'ok', msg: `Added "${r.node.name}".` }) }
    return r
  }

  const tBtn = { fontSize: 12.5 }

  return (
    <div style={{ maxWidth: 760 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>Chart of Accounts</h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 0', maxWidth: 520 }}>
            Your master list of money categories. The number beside each one is how much went into it.
          </p>
        </div>
        <button style={{ ...tBtn, background: 'var(--blue)', color: '#fff', borderColor: 'var(--blue)' }} onClick={() => setAddPanel({ parentId: '' })}>
          <i className="ti ti-plus" aria-hidden="true" /> Add category
        </button>
      </div>

      {/* Notices */}
      {(notice || error) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, margin: '0 0 12px', padding: '8px 12px', borderRadius: 'var(--radius-sm)',
          color: (notice?.type === 'ok') ? 'var(--teal)' : 'var(--coral)',
          background: (notice?.type === 'ok') ? 'var(--teal-light)' : 'var(--coral-light)',
          border: `0.5px solid ${(notice?.type === 'ok') ? 'var(--teal)' : 'var(--coral)'}`,
        }}>
          <i className={`ti ${notice?.type === 'ok' ? 'ti-check' : 'ti-alert-triangle'}`} aria-hidden="true" />
          <span style={{ flex: 1 }}>{notice?.msg || error}</span>
          <button onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 14 }} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <i className="ti ti-search" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: 'var(--text-muted)' }} aria-hidden="true" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search categories…" style={{ width: '100%', fontSize: 13, paddingLeft: 32 }} />
        </div>
        <div style={{ display: 'inline-flex', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {SCOPES.map(s => (
            <button key={s.key} onClick={() => setScope(s.key)} style={{
              fontSize: 12.5, padding: '7px 13px', border: 'none', borderRadius: 0,
              background: scope === s.key ? 'var(--bg-secondary)' : 'transparent',
              color: scope === s.key ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>{s.label}</button>
          ))}
        </div>
        <select value={periodKey} onChange={e => setPeriodKey(e.target.value)} style={{ fontSize: 12.5, width: 'auto' }}>
          {PERIODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {/* Tree */}
      {loading ? (
        <LoadingState label="Loading categories…" />
      ) : rows.length === 0 ? (
        <EmptyState title="No categories match" hint="Try a different search or scope, or add a category." />
      ) : (
        <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {/* column header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', background: 'var(--bg-card)', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ fontSize: 10.5, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Category</span>
            <span style={{ fontSize: 10.5, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Amount</span>
          </div>
          {rows.map((row, i) => row.band ? (
            <div key={`band-${i}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 16px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ fontSize: 10.5, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>{BAND[row.basis].label}</span>
              <span style={{ fontSize: 10.5, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{row.caption}</span>
            </div>
          ) : (
            <CategoryRow
              key={row.node.id}
              row={row}
              isEditing={editingId === row.node.id}
              editValue={editValue}
              setEditValue={setEditValue}
              commitRename={commitRename}
              cancelRename={cancelRename}
              menuOpen={menuId === row.node.id}
              toggleMenu={setMenuId}
              onToggleExpand={toggleExpand}
              onOpenDrawer={setDrawerNode}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '10px 2px 0' }}>
        Click a category to see the transactions inside it · double-click a name to rename · the ⋯ menu adds, hides, or deletes.
      </p>

      {/* Drawer + Add panel */}
      {drawerNode && (
        <TransactionDrawer
          node={drawerNode} period={period} moveOptions={moveOptions}
          onMoved={reloadAmounts} onClose={() => setDrawerNode(null)}
        />
      )}
      {addPanel && (
        <AddCategoryPanel
          coa={coa} options={parentOpts} initialParentId={addPanel.parentId}
          onAdd={onAdd} onClose={() => setAddPanel(null)}
        />
      )}
    </div>
  )
}
