/**
 * client/src/dev/DevChat.jsx — floating LOCALHOST-ONLY dev assistant.
 *
 * A small bug-icon button (bottom-right) opens a chat panel you can use on ANY
 * page to ask the assistant two kinds of questions:
 *   • "What can you see on this page right now?"  — it reads a snapshot of the
 *     current page (nav, URL, visible text, and any structured state a page
 *     exposes via window.__caishenDev.snapshot()).
 *   • "What did the backend just see when I did X?" — it reads the server's
 *     recent /api activity (captured by server/dev/dev-capture.js).
 *
 * Rendered only when IS_LOCALHOST (gated by the caller in App.jsx), so it never
 * ships to mycaishen.ai. Talks to the localhost-only /api/dev-chat router.
 */
import { useState, useRef, useEffect } from 'react'

const API = '/api/dev-chat'

// Build the frontend snapshot sent with each message. Best-effort — every field
// is optional on the server side.
function capturePageContext(nav) {
  let visibleText = ''
  try {
    const root = document.querySelector('main') || document.getElementById('root') || document.body
    // Kept small on purpose — Groq's free tier is token-per-minute limited, and the
    // structured window.__caishenDev.snapshot() state (below) carries the useful data.
    visibleText = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 2500)
  } catch { /* ignore */ }

  let state
  try {
    // Opt-in hook: any page can do `window.__caishenDev = { snapshot: () => ({...}) }`
    // to expose its structured client state (selected folder, upload queue, etc.).
    if (window.__caishenDev && typeof window.__caishenDev.snapshot === 'function') {
      state = window.__caishenDev.snapshot()
    }
  } catch { /* ignore */ }

  return { nav, url: window.location.href, title: document.title, visibleText, state }
}

export default function DevChat({ nav }) {
  const [open, setOpen]       = useState(false)
  const [configured, setCfg]  = useState(null)   // null = unknown, then bool
  const [messages, setMsgs]   = useState([])     // {role, content}
  const [input, setInput]     = useState('')
  const [busy, setBusy]       = useState(false)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (open && configured === null) {
      // /api/dev-chat/status sits behind the global auth middleware, so it needs the token.
      const token = localStorage.getItem('caishen_token') || ''
      fetch(`${API}/status`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json()).then(d => setCfg(!!d.configured)).catch(() => setCfg(false))
    }
  }, [open, configured])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open])

  async function clearLog() {
    try {
      const token = localStorage.getItem('caishen_token') || ''
      await fetch(`${API}/log/clear`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      setMsgs(m => [...m, { role: 'system', content: '🧹 Backend activity log cleared. Now perform your action, then ask about it.' }])
    } catch { /* ignore */ }
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const history = [...messages.filter(m => m.role !== 'system'), { role: 'user', content: text }]
    setMsgs(m => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setBusy(true)

    try {
      const token = localStorage.getItem('caishen_token') || ''
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: history.map(m => ({ role: m.role, content: m.content })),
          pageContext: capturePageContext(nav),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const evt = JSON.parse(line.slice(6))
          if (evt.text) setMsgs(m => { const c = [...m]; c[c.length - 1].content += evt.text; return c })
          if (evt.error) setMsgs(m => { const c = [...m]; c[c.length - 1].content += `\n⚠ ${evt.error}`; return c })
        }
      }
    } catch (e) {
      setMsgs(m => { const c = [...m]; c[c.length - 1].content = `⚠ ${e.message}`; return c })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="Dev Assistant (localhost only)"
        style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 9000, width: 44, height: 44, borderRadius: '50%',
          background: 'var(--purple)', color: '#fff', border: 'none', boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          fontSize: 20, cursor: 'pointer' }}>🐞</button>
    )
  }

  return (
    <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 9000, width: 400, maxWidth: 'calc(100vw - 24px)',
      height: 560, maxHeight: 'calc(100vh - 36px)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-card)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)',
      boxShadow: '0 8px 30px rgba(0,0,0,0.4)', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <span style={{ fontSize: 16 }}>🐞</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Dev Assistant</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>localhost • page: {nav}</div>
        </div>
        <button onClick={clearLog} title="Clear backend activity log"
          style={{ background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}>Clear log</button>
        <button onClick={() => setOpen(false)} title="Close"
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {configured === false && (
          <div style={{ fontSize: 12, color: 'var(--coral)' }}>Not configured — add <code>GROQ_API_KEY</code> to <code>.env</code> and restart the server.</div>
        )}
        {messages.length === 0 && configured !== false && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Ask what the app sees. For a clean read of a backend action: click <b>Clear log</b>, do the action (e.g. batch-upload a folder in Data Vault), then ask.<br /><br />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {['What can you see on this page right now?',
                'What did the backend receive when I last uploaded files?',
                'Summarize the last few /api calls and their responses.'].map(s => (
                <button key={s} onClick={() => setInput(s)}
                  style={{ textAlign: 'left', background: 'var(--bg-hover)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 11, padding: '6px 8px', cursor: 'pointer' }}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
            <div style={{
              fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', padding: '7px 10px', borderRadius: 'var(--radius-md)',
              background: m.role === 'user' ? 'var(--blue)' : m.role === 'system' ? 'transparent' : 'var(--bg-hover)',
              color: m.role === 'user' ? '#fff' : m.role === 'system' ? 'var(--text-muted)' : 'var(--text-primary)',
              border: m.role === 'system' ? '0.5px dashed var(--border)' : 'none',
              fontStyle: m.role === 'system' ? 'italic' : 'normal',
            }}>{m.content || (busy && i === messages.length - 1 ? '▍' : '')}</div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '0.5px solid var(--border)' }}>
        <textarea value={input} onChange={e => setInput(e.target.value)} rows={1} placeholder="Ask the dev assistant…"
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={configured === false}
          style={{ flex: 1, resize: 'none', background: 'var(--bg-secondary)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, padding: '8px 10px', fontFamily: 'inherit', maxHeight: 90 }} />
        <button onClick={send} disabled={busy || configured === false || !input.trim()}
          style={{ background: 'var(--purple)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '0 14px', fontSize: 12, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: (busy || !input.trim()) ? 0.5 : 1 }}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
