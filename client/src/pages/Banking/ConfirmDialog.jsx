import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// Styled in-app replacement for window.confirm — a small dark-theme dialog matching
// the page's modals. Portaled to <body> with a zIndex above every other popup
// (detail modal 1000, receipt viewer 1100) so it always sits on top.
// Enter confirms (the confirm button is auto-focused), Escape / backdrop-click cancels.
export default function ConfirmDialog({ message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  useEffect(() => {
    const h = e => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  return createPortal(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1300,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
      onClick={e => e.target === e.currentTarget && onCancel()}>
      <div role="dialog" aria-modal="true"
        style={{background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 22px',width:'min(400px,92vw)',boxShadow:'0 16px 48px rgba(0,0,0,0.5)'}}>
        <p style={{fontSize:14,margin:'0 0 18px',color:'var(--text-primary)',lineHeight:1.5}}>{message}</p>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onCancel} style={{cursor:'pointer'}}>Cancel</button>
          <button autoFocus onClick={onConfirm}
            style={{background: danger ? 'var(--coral)' : 'var(--green)', color:'#fff', border:'none', cursor:'pointer'}}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
