import { useState, useEffect } from 'react'
import axios from 'axios'

const API = '/api'

// Session-lived cache of receiptId → blob object URL, so paginating / re-rendering the table
// doesn't refetch a thumbnail we already have. (URLs live for the page session — cheap.)
const thumbCache = new Map()

// A small receipt thumbnail. Images are fetched WITH auth (axios token header → blob → object
// URL); PDFs render a file icon. Click → onClick (the caller opens the full-size lightbox).
export default function ReceiptThumb({ receipt, onClick, size = 30 }) {
  const isImg = (receipt.mime_type || '').startsWith('image/')
  const [url, setUrl] = useState(() => thumbCache.get(receipt.id) || null)

  useEffect(() => {
    if (!isImg || thumbCache.has(receipt.id)) return
    let alive = true
    axios.get(`${API}/receipts/file/${receipt.id}`, { responseType: 'blob' })
      .then(res => { const u = URL.createObjectURL(res.data); thumbCache.set(receipt.id, u); if (alive) setUrl(u) })
      .catch(() => {})
    return () => { alive = false }
  }, [receipt.id, isImg])

  const box = {
    width: size, height: size, borderRadius: 4, border: '0.5px solid var(--border)',
    flexShrink: 0, objectFit: 'cover', display: 'block',
  }

  if (!isImg) {
    return (
      <div onClick={onClick} title="Open receipt"
        style={{ ...box, cursor: 'zoom-in', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)' }}>
        <i className="ti ti-file-type-pdf" style={{ fontSize: Math.round(size * 0.55), color: 'var(--coral)' }} aria-hidden="true" />
      </div>
    )
  }
  if (!url) return <div style={{ ...box, background: 'var(--bg-secondary)' }} aria-busy="true" />
  return <img src={url} alt="receipt" onClick={onClick} title="Click to enlarge" style={{ ...box, cursor: 'zoom-in' }} />
}
