// AddCategoryPanel.jsx — small modal to add a category. The user types a name and picks
// which existing category it goes under; type (income/expense/asset/…) and scope
// (personal/business) are INHERITED from that parent, so a non-accountant never has to
// answer "is this an asset or an expense?". The backend does the inheriting on POST.

import { useState, useMemo } from 'react'
import { TYPE_META } from './coaConfig'
import CategorySelect from './CategorySelect'

export default function AddCategoryPanel({ coa, options, initialParentId, onAdd, onClose }) {
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState(initialParentId || '')
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const parent = useMemo(() => coa.find(n => n.id === parentId) || null, [coa, parentId])
  const meta = parent ? TYPE_META[parent.type] : null

  const submit = async () => {
    if (!name.trim()) { setError('Give the category a name.'); return }
    if (!parentId)     { setError('Pick where it goes.'); return }
    setBusy(true); setError(null)
    const res = await onAdd({ name: name.trim(), parentId, active })
    setBusy(false)
    if (res?.ok) onClose()
    else setError(res?.error || 'Could not add the category.')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1060, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div className="card" style={{ position: 'relative', width: 'min(440px, 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>New category</p>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 17, color: 'var(--text-muted)' }} aria-label="Close">✕</button>
        </div>

        <label style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 5 }}>Name</label>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. Chipotle" style={{ width: '100%', fontSize: 13, marginBottom: 16 }} />

        <label style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 5 }}>Goes under</label>
        <CategorySelect options={options} value={parentId} onChange={setParentId} placeholder="Choose a category…" />
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-info-circle" aria-hidden="true" />
          {meta
            ? <span>Inherits <span style={{ color: 'var(--text-secondary)' }}>{meta.label}{parent.scope ? ' · ' + parent.scope : ''}</span> from its parent — no need to pick.</span>
            : <span>Type and scope are inherited from whatever you put it under.</span>}
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 18, cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />
          Active &amp; available for categorizing
        </label>

        {error && <p style={{ fontSize: 12, color: 'var(--coral)', margin: '0 0 12px' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ fontSize: 13 }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ fontSize: 13, background: 'var(--blue)', color: '#fff', borderColor: 'var(--blue)', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Adding…' : 'Add category'}
          </button>
        </div>
      </div>
    </div>
  )
}
