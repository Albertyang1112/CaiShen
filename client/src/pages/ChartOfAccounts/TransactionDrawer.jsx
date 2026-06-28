// TransactionDrawer.jsx — slide-in panel listing the transactions behind one category.
//
// Opens when a category row is clicked. Shows the period total + count up top, then the
// transactions (date, merchant, account, an "auto" chip for machine-categorized rows).
// Hovering a row reveals "Move", which re-files that transaction under another category
// (PATCH /api/transactions/:id { coaId }) and refreshes both the list and the tree totals.

import { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import { fd, fmtDate, basisOf, TYPE_META } from './coaConfig'
import CategorySelect from './CategorySelect'

export default function TransactionDrawer({ node, period, moveOptions, onMoved, onClose }) {
  const [data, setData] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [movingId, setMovingId] = useState(null)
  const [hoverId, setHoverId] = useState(null)

  const load = useCallback(async () => {
    if (!node) return
    setData(null); setError(null)
    try {
      const qs = `coaId=${encodeURIComponent(node.id)}&startDate=${period.start}&endDate=${period.end}`
      const { data } = await axios.get(`/api/accounting/pl/transactions?${qs}`)
      setData(data)
    } catch (e) { setError(e?.response?.data?.error || 'Could not load transactions.'); setData({ transactions: [] }) }
  }, [node, period.start, period.end])

  useEffect(() => { load() }, [load])

  if (!node) return null
  const meta = TYPE_META[node.type] || {}
  const isBalance = basisOf(node.type) === 'balance'
  const txns = data?.transactions || []

  const moveTx = async (txId, coaId) => {
    if (!coaId) { setMovingId(null); return }
    try {
      await axios.patch(`/api/transactions/${txId}`, { coaId, coaAuto: false })
      setMovingId(null)
      await load()          // refresh this drawer
      onMoved && onMoved()  // refresh the tree totals
    } catch { setError('Could not move that transaction.') }
  }

  const path = data?.categoryPath || [node.name]

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1050 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      <div style={{
        position: 'absolute', top: 0, right: 0, height: '100%', width: 'min(420px, 100%)',
        background: 'var(--bg-card)', borderLeft: '0.5px solid var(--border)', boxShadow: '-8px 0 32px rgba(0,0,0,0.3)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '0.5px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {path.slice(0, -1).join(' › ') || meta.label}
              </p>
              <p style={{ fontSize: 16, fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className={`ti ${meta.icon}`} style={{ color: meta.color, fontSize: 18 }} aria-hidden="true" />{node.name}
              </p>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, padding: 4 }} aria-label="Close">✕</button>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 14 }}>
            <div>
              <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{isBalance ? 'Current balance' : 'Total'}</p>
              <p style={{ fontSize: 20, fontWeight: 600, margin: '2px 0 0' }}>{data ? fd(data.total) : '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Transactions</p>
              <p style={{ fontSize: 20, fontWeight: 600, margin: '2px 0 0' }}>{data ? (data.count || 0) : '—'}</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {error && <p style={{ fontSize: 12, color: 'var(--coral)', padding: '12px 20px', margin: 0 }}>{error}</p>}
          {data === null ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '16px 20px' }}><i className="ti ti-loader-2 spin" aria-hidden="true" /> Loading…</p>
          ) : txns.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '16px 20px', lineHeight: 1.6 }}>
              {isBalance
                ? 'No transactions are filed here directly — balances for assets and debts come from your linked accounts and any balance you’ve entered manually.'
                : 'No transactions in this category for the selected period.'}
            </p>
          ) : (
            txns.map(tx => (
              <div
                key={tx.id}
                onMouseEnter={() => setHoverId(tx.id)} onMouseLeave={() => setHoverId(h => h === tx.id ? null : h)}
                style={{ borderBottom: '0.5px solid var(--border)', background: movingId === tx.id ? 'var(--bg-hover)' : 'transparent' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 20px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tx.merchant || tx.desc || 'Transaction'}
                      {tx.auto && <span style={{ fontSize: 10, color: 'var(--text-muted)', border: '0.5px solid var(--border)', borderRadius: 4, padding: '0 5px', marginLeft: 6 }}>auto</span>}
                    </p>
                    <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 0' }}>{fmtDate(tx.date)}{tx.account ? ` · ${tx.account}` : ''}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    {!isBalance && (hoverId === tx.id || movingId === tx.id) && (
                      <button onClick={() => setMovingId(movingId === tx.id ? null : tx.id)} style={{ fontSize: 11.5, padding: '3px 8px' }}>
                        <i className="ti ti-arrows-exchange" aria-hidden="true" /> Move
                      </button>
                    )}
                    <span style={{ fontSize: 13.5, fontVariantNumeric: 'tabular-nums', color: tx.signed > 0 ? 'var(--green)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>{fd(tx.signed)}</span>
                  </div>
                </div>
                {movingId === tx.id && (
                  <div style={{ padding: '0 20px 12px' }}>
                    <CategorySelect options={moveOptions} value="" placeholder="Move to category…" onChange={(coaId) => moveTx(tx.id, coaId)} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
