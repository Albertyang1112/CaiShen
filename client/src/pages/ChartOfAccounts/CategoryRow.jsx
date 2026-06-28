// CategoryRow.jsx — one row in the category tree.
//
// A caret expands/collapses groups; clicking a leaf opens the transaction drawer.
// Double-click the name to rename inline. The ⋯ menu (on hover) holds rename, add
// sub-category, hide/unhide, and delete. Hidden (inactive) categories render greyed.

import { useState, useRef, useEffect } from 'react'
import { TYPE_META, fd } from './coaConfig'

export default function CategoryRow({
  row, isEditing, editValue, setEditValue, commitRename, cancelRename,
  menuOpen, toggleMenu, onToggleExpand, onOpenDrawer, onMenu,
}) {
  const { node, depth, hasChildren, open, amount } = row
  const [hover, setHover] = useState(false)
  const menuRef = useRef(null)
  const inactive = node.active === false
  const isRoot = depth === 0
  const meta = TYPE_META[node.type] || {}
  const canDelete = !hasChildren && (row.count || 0) === 0

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) toggleMenu(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [menuOpen, toggleMenu])

  const onNameClick = () => { if (isEditing) return; hasChildren ? onToggleExpand(node.id) : onOpenDrawer(node) }

  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px 8px ' + (12 + depth * 18) + 'px',
        borderBottom: '0.5px solid var(--border)',
        background: hover ? 'var(--bg-hover)' : (isRoot ? 'var(--bg-secondary)' : 'transparent'),
      }}
    >
      {/* caret */}
      <span onClick={() => hasChildren && onToggleExpand(node.id)} style={{ width: 16, flexShrink: 0, cursor: hasChildren ? 'pointer' : 'default', color: 'var(--text-muted)' }}>
        {hasChildren && <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: 15 }} aria-hidden="true" />}
      </span>

      {/* section icon (roots only) */}
      {isRoot && <i className={`ti ${meta.icon}`} style={{ fontSize: 16, color: inactive ? 'var(--text-muted)' : meta.color, flexShrink: 0 }} aria-hidden="true" />}

      {/* name / rename input */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {isEditing ? (
          <input
            autoFocus defaultValue={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename() }}
            onBlur={commitRename}
            style={{ width: '100%', maxWidth: 280, fontSize: 13.5, height: 30 }}
          />
        ) : (
          <span
            onClick={onNameClick}
            onDoubleClick={() => onMenu('rename', node)}
            title={hasChildren ? 'Expand' : 'View transactions'}
            style={{
              fontSize: isRoot ? 14 : 13.5, fontWeight: isRoot ? 600 : 400, cursor: 'pointer',
              color: inactive ? 'var(--text-muted)' : 'var(--text-primary)', fontStyle: inactive ? 'italic' : 'normal',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%',
            }}
          >
            {node.name}
            {inactive && <span style={{ fontSize: 10, fontStyle: 'normal', color: 'var(--text-muted)', border: '0.5px solid var(--border)', borderRadius: 4, padding: '0 5px', marginLeft: 6 }}>hidden</span>}
          </span>
        )}
      </div>

      {/* amount */}
      <span style={{
        fontSize: isRoot ? 14 : 13.5, fontWeight: isRoot ? 600 : 400, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        color: inactive ? 'var(--text-muted)' : isRoot && meta.basis === 'activity' ? meta.color : 'var(--text-primary)',
      }}>{fd(amount)}</span>

      {/* row menu */}
      <div ref={menuRef} style={{ position: 'relative', width: 20, flexShrink: 0 }}>
        <button
          onClick={() => toggleMenu(menuOpen ? null : node.id)}
          aria-label="Row actions"
          style={{ background: 'none', border: 'none', padding: 2, color: 'var(--text-muted)', visibility: hover || menuOpen ? 'visible' : 'hidden' }}
        >
          <i className="ti ti-dots" style={{ fontSize: 16 }} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 20, minWidth: 168,
            background: 'var(--bg-card)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-md)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.25)', padding: 4,
          }}>
            <MenuItem icon="ti-pencil" label="Rename" onClick={() => { toggleMenu(null); onMenu('rename', node) }} />
            <MenuItem icon="ti-plus" label="Add sub-category" onClick={() => { toggleMenu(null); onMenu('add_child', node) }} />
            <MenuItem icon={inactive ? 'ti-eye' : 'ti-eye-off'} label={inactive ? 'Unhide' : 'Hide'} onClick={() => { toggleMenu(null); onMenu(inactive ? 'unhide' : 'hide', node) }} />
            <MenuItem icon="ti-trash" label="Delete" danger disabled={!canDelete}
              hint={!canDelete ? (hasChildren ? 'Has sub-categories' : 'Has transactions') : null}
              onClick={() => { if (canDelete) { toggleMenu(null); onMenu('delete', node) } }} />
          </div>
        )}
      </div>
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger, disabled, hint }) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={hint || ''}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        background: 'none', border: 'none', borderRadius: 'var(--radius-sm)', padding: '7px 9px', fontSize: 12.5,
        color: disabled ? 'var(--text-muted)' : danger ? 'var(--coral)' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
    >
      <i className={`ti ${icon}`} style={{ fontSize: 15 }} aria-hidden="true" />{label}
    </button>
  )
}
