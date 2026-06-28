// useChartOfAccounts.js — data layer for the (simplified) Chart of Accounts page.
//
// Everything talks to the SAME backend the rest of the app uses (Banking, Report):
//   GET    /api/accounting/coa                 → the category tree (one source of truth)
//   GET    /api/accounting/pl                  → period totals per income/expense category
//   GET    /api/accounting/balance-sheet       → linked balances per asset/liability leaf
//   GET    /api/accounting/category-balances   → manual balances the user typed in
//   POST   /api/accounting/coa                 → add a category
//   PUT    /api/accounting/coa/:id             → rename / hide (active) / move
//   DELETE /api/accounting/coa/:id             → delete (server guards children + txns)
//
// No mock data, no parallel account schema — the tree IS the chart. Mutations hit the
// API and update local state so the UI feels instant.

import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { basisOf, SECTION_ORDER } from './coaConfig'

// ── The hook ────────────────────────────────────────────────────────────────
export function useChartOfAccounts(period) {
  const [coa, setCoa] = useState([])
  const [amountById, setAmountById] = useState({})   // income/expense: period total
  const [countById, setCountById]   = useState({})   // income/expense: # transactions
  const [balanceById, setBalanceById] = useState({}) // asset/liability/equity: current balance
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const periodRef = useRef(period)
  periodRef.current = period

  const loadStructure = useCallback(async () => {
    const { data } = await axios.get('/api/accounting/coa')
    setCoa(Array.isArray(data) ? data : [])
  }, [])

  const loadAmounts = useCallback(async () => {
    const p = periodRef.current
    const qs = `startDate=${p.start}&endDate=${p.end}`
    const [pl, bs, cb] = await Promise.allSettled([
      axios.get(`/api/accounting/pl?${qs}`),
      axios.get('/api/accounting/balance-sheet'),
      axios.get('/api/accounting/category-balances'),
    ])
    if (pl.status === 'fulfilled') {
      setAmountById(pl.value.data?.byAccount || {})
      setCountById(pl.value.data?.countByAccount || {})
    }
    // Balance per leaf = linked accounts + any manual balance the user entered.
    const bal = {}
    if (bs.status === 'fulfilled') {
      for (const [id, e] of Object.entries(bs.value.data?.byLeaf || {})) bal[id] = (bal[id] || 0) + (e.linked || 0)
    }
    if (cb.status === 'fulfilled') {
      for (const [id, e] of Object.entries(cb.value.data || {})) bal[id] = (bal[id] || 0) + (Number(e?.amount) || 0)
    }
    setBalanceById(bal)
  }, [])

  const reload = useCallback(async () => {
    setLoading(true); setError(null)
    try { await Promise.all([loadStructure(), loadAmounts()]) }
    catch (e) { setError(e?.response?.data?.error || e?.message || 'Could not load the chart of accounts.') }
    setLoading(false)
  }, [loadStructure, loadAmounts])

  useEffect(() => { reload() }, [])               // initial load
  useEffect(() => { loadAmounts() }, [period.start, period.end, loadAmounts])   // re-total on period change

  // ── Mutations (hit the API, then patch local state) ───────────────────────
  const addCategory = useCallback(async (payload) => {
    try {
      const { data } = await axios.post('/api/accounting/coa', payload)
      setCoa(prev => [...prev, data])
      return { ok: true, node: data }
    } catch (e) { return { ok: false, error: e?.response?.data?.error || 'Could not add the category.' } }
  }, [])

  const updateCategory = useCallback(async (id, patch) => {
    try {
      const { data } = await axios.put(`/api/accounting/coa/${id}`, patch)
      setCoa(prev => prev.map(n => n.id === id ? data : n))
      return { ok: true, node: data }
    } catch (e) { return { ok: false, error: e?.response?.data?.error || 'Could not update the category.' } }
  }, [])

  const renameCategory = useCallback((id, name) => updateCategory(id, { name }), [updateCategory])
  const setActive      = useCallback((id, active) => updateCategory(id, { active }), [updateCategory])

  const removeCategory = useCallback(async (id) => {
    try {
      await axios.delete(`/api/accounting/coa/${id}`)
      setCoa(prev => prev.filter(n => n.id !== id))
      return { ok: true }
    } catch (e) { return { ok: false, error: e?.response?.data?.error || 'Could not delete the category.' } }
  }, [])

  return {
    coa, amountById, countById, balanceById, loading, error,
    reload, reloadAmounts: loadAmounts,
    addCategory, renameCategory, setActive, removeCategory,
  }
}

// ── Pure tree builder ─────────────────────────────────────────────────────────
// Rolls each category's own number up through its children, filters by the
// Personal/Business toggle + search (keeping ancestors of any match so the tree
// stays intact), then flattens to ordered rows with a band divider before the
// "money in/out" section and before the "own/owe" section.
export function buildTree(coa, { scope, search, amountById, countById, balanceById, expanded, periodLabel }) {
  const byId = new Map(coa.map(n => [n.id, n]))
  const kids = {}
  for (const n of coa) { const p = n.parentId || '__root'; (kids[p] = kids[p] || []).push(n) }

  // Each node's own number: a period total for income/expense, a balance otherwise.
  const own = (n) => basisOf(n.type) === 'activity' ? (amountById[n.id] || 0) : (balanceById[n.id] || 0)

  const memo = {}
  const calc = (id) => {
    if (memo[id]) return memo[id]
    const n = byId.get(id)
    let amount = own(n), count = countById[n.id] || 0
    for (const c of kids[id] || []) { const r = calc(c.id); amount += r.amount; count += r.count }
    return (memo[id] = { amount, count })
  }
  for (const n of coa) calc(n.id)

  const q = (search || '').trim().toLowerCase()
  const scopeOk = (n) => scope === 'all' || n.scope === scope || !n.scope
  const selfMatch = (n) => scopeOk(n) && (!q || (n.name || '').toLowerCase().includes(q))

  const keep = {}
  const visit = (n) => {
    let any = selfMatch(n)
    for (const c of kids[n.id] || []) any = visit(c) || any
    keep[n.id] = any
    return any
  }
  for (const r of kids['__root'] || []) visit(r)

  // Section roots, ordered by money-type then personal-before-business.
  const roots = (kids['__root'] || [])
    .filter(r => keep[r.id])
    .sort((a, b) =>
      (SECTION_ORDER.indexOf(a.type) - SECTION_ORDER.indexOf(b.type)) ||
      (a.scope === b.scope ? 0 : a.scope === 'personal' ? -1 : 1))

  const force = !!q
  const rows = []
  let prevBasis = null
  const walk = (n, depth) => {
    if (!keep[n.id]) return
    const childList = (kids[n.id] || []).filter(c => keep[c.id])
    const hasChildren = childList.length > 0
    const open = hasChildren && (force || !!expanded[n.id])
    rows.push({ node: n, depth, hasChildren, open, amount: memo[n.id].amount, count: memo[n.id].count })
    if (open) for (const c of childList) walk(c, depth + 1)
  }
  for (const r of roots) {
    const basis = basisOf(r.type)
    if (basis !== prevBasis) {
      rows.push({ band: true, basis, caption: basis === 'activity' ? periodLabel : 'Current balance' })
      prevBasis = basis
    }
    walk(r, 0)
  }
  return rows
}

// Flat list of categories you can file a transaction under (income/expense leaves),
// each tagged with its full path, for the drawer's "Move" picker. Grouped by section.
export function postableLeaves(coa) {
  const byId = new Map(coa.map(n => [n.id, n]))
  const hasKid = new Set(coa.map(n => n.parentId).filter(Boolean))
  const pathOf = (n) => { const p = []; let c = n; while (c) { p.unshift(c.name); c = c.parentId ? byId.get(c.parentId) : null } return p }
  return coa
    .filter(n => !hasKid.has(n.id) && basisOf(n.type) === 'activity' && n.active !== false)
    .map(n => ({ id: n.id, type: n.type, scope: n.scope, path: pathOf(n) }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.type) - SECTION_ORDER.indexOf(b.type) || a.path.join('/').localeCompare(b.path.join('/')))
}

// Valid parents for the Add form: every node except the one being edited and its
// descendants (prevents a category becoming its own ancestor). Tagged with path.
export function parentOptions(coa, excludeId) {
  const byId = new Map(coa.map(n => [n.id, n]))
  const kids = {}
  for (const n of coa) { const p = n.parentId || '__root'; (kids[p] = kids[p] || []).push(n) }
  const banned = new Set()
  if (excludeId) {
    banned.add(excludeId)
    const stack = [excludeId]
    while (stack.length) { const id = stack.pop(); for (const c of kids[id] || []) { banned.add(c.id); stack.push(c.id) } }
  }
  const pathOf = (n) => { const p = []; let c = n; while (c) { p.unshift(c.name); c = c.parentId ? byId.get(c.parentId) : null } return p }
  return coa
    .filter(n => !banned.has(n.id) && n.active !== false)
    .map(n => ({ id: n.id, type: n.type, scope: n.scope, path: pathOf(n) }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.type) - SECTION_ORDER.indexOf(b.type) || a.path.join('/').localeCompare(b.path.join('/')))
}
