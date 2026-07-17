import { useState, useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// Shared statement-PDF preview (extracted verbatim from pages/Mortgage/Mortgage.jsx so the
// Mortgage and Insurance pages render statements the same way). Chrome won't reliably
// render blob-URL PDFs inside an iframe, so pdfjs paints each page onto a canvas — the
// same approach as the Data Vault preview. Files are fetched WITH auth.

// A ".pdf" in the vault is sometimes really a photo of the bill (phone upload / chatbot
// ingest) — pdfjs throws "Invalid PDF structure" on those. Sniff the magic bytes so
// callers can fall back to an <img> preview instead of erroring.
export function sniffImageMime(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer.slice(0, 12))
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

// One rendered PDF page.
export function PdfPage({ pdf, pageNum, scale }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    let renderTask = null, cancelled = false
    ;(async () => {
      try {
        const page = await pdf.getPage(pageNum)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport })
        await renderTask.promise
      } catch (e) { if (!cancelled) console.error('PDF render error page', pageNum, e) }
    })()
    return () => { cancelled = true; renderTask?.cancel() }
  }, [pdf, pageNum, scale])
  return <canvas ref={canvasRef} style={{ display: 'block', maxWidth: '100%', boxShadow: '0 2px 12px rgba(0,0,0,0.4)', borderRadius: 2 }} />
}

// Modal: fetch the vault file with auth, render page-by-page via pdfjs.
export function PdfModal({ docId, title, onClose }) {
  const [pdf, setPdf] = useState(null)
  const [numPages, setNumPages] = useState(0)
  const [dlUrl, setDlUrl] = useState(null)
  const [imgMime, setImgMime] = useState(null)   // set when the ".pdf" is really a photo
  const [err, setErr] = useState('')
  useEffect(() => {
    let objUrl, alive = true
    const token = localStorage.getItem('caishen_token') || ''
    ;(async () => {
      try {
        const res = await fetch(`/api/vault/file/${docId}`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`Couldn't load statement (HTTP ${res.status})`)
        const data = await res.arrayBuffer()
        if (!alive) return
        const mime = sniffImageMime(data)
        if (mime) {   // photographed bill saved as .pdf → show the image directly
          objUrl = URL.createObjectURL(new Blob([data], { type: mime }))
          setDlUrl(objUrl); setImgMime(mime)
          return
        }
        objUrl = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
        setDlUrl(objUrl)
        const loaded = await pdfjsLib.getDocument({ data }).promise
        if (!alive) return
        setPdf(loaded)
        setNumPages(loaded.numPages)
      } catch (e) { if (alive) setErr(e.message) }
    })()
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [docId])
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', width: 'min(900px,94vw)', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
            {dlUrl && <a href={dlUrl} download={`${title}.${imgMime ? imgMime.split('/')[1] : 'pdf'}`} style={{ fontSize: 12, color: 'var(--blue)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-download" aria-hidden="true" />Download</a>}
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer' }} aria-label="Close">✕</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 16 }}>
          {err
            ? <div style={{ padding: 24, color: 'var(--coral)', fontSize: 13 }}>{err}</div>
            : imgMime && dlUrl
              ? <img src={dlUrl} alt={title} style={{ maxWidth: '100%', height: 'auto', boxShadow: '0 2px 12px rgba(0,0,0,0.4)', borderRadius: 2 }} />
            : pdf
              ? Array.from({ length: numPages }, (_, i) => <PdfPage key={i + 1} pdf={pdf} pageNum={i + 1} scale={1.4} />)
              : <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>}
        </div>
      </div>
    </div>
  )
}
