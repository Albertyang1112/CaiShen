import { useState, useEffect, useRef } from 'react'

const API = 'http://localhost:3001/api'
const getToken = () => localStorage.getItem('caishen_token') || ''
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })

const CATEGORY_STYLE = {
  'Spending':    { bg: 'var(--coral-light)',  color: 'var(--coral)'  },
  'Cash Flow':   { bg: 'var(--teal-light)',   color: 'var(--teal)'   },
  'Tax':         { bg: 'var(--amber-light)',  color: 'var(--amber)'  },
  'Real Estate': { bg: 'var(--blue-light)',   color: 'var(--blue)'   },
  'Portfolio':   { bg: 'var(--purple-light)', color: 'var(--purple)' },
}
const PRIORITY_STYLE = {
  high:   { bg: 'var(--coral-light)',  color: 'var(--coral)'  },
  medium: { bg: 'var(--amber-light)',  color: 'var(--amber)'  },
  low:    { bg: 'var(--teal-light)',   color: 'var(--teal)'   },
}
const SUGGESTED = [
  "What's my biggest spending category this month?",
  "How is my real estate portfolio performing?",
  "What are my biggest tax planning opportunities?",
  "Give me a quick summary of my overall financial health",
  "Should I be concerned about any of my cash flows?",
]

export default function Advisor() {
  const [tab, setTab]             = useState('chat')
  const [configured, setConfigured] = useState(null)
  const [messages, setMessages]   = useState([])
  const [input, setInput]         = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [insights, setInsights]   = useState([])
  const [insightsAt, setInsightsAt] = useState(null)
  const [genLoading, setGenLoading] = useState(false)
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    fetch(`${API}/advisor/status`)
      .then(r => r.json())
      .then(d => setConfigured(d.configured))
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    if (tab === 'insights') loadInsights()
  }, [tab])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamText])

  const loadInsights = () => {
    fetch(`${API}/advisor/insights`)
      .then(r => r.json())
      .then(d => { setInsights(d.insights || []); setInsightsAt(d.generatedAt) })
      .catch(() => {})
  }

  const generateInsights = async () => {
    setGenLoading(true)
    const startTime = new Date().toISOString()
    try {
      await fetch(`${API}/advisor/generate-insights`, { method: 'POST', headers: authHeaders() })
      let attempts = 0
      const poll = () => {
        fetch(`${API}/advisor/insights`)
          .then(r => r.json())
          .then(d => {
            attempts++
            if ((d.generatedAt && d.generatedAt > startTime) || attempts >= 12) {
              setInsights(d.insights || [])
              setInsightsAt(d.generatedAt)
              setGenLoading(false)
            } else {
              setTimeout(poll, 2500)
            }
          })
          .catch(() => { if (++attempts >= 12) setGenLoading(false); else setTimeout(poll, 2500) })
      }
      setTimeout(poll, 4000)
    } catch {
      setGenLoading(false)
    }
  }

  const sendMessage = async (text) => {
    const msg = text ?? input.trim()
    if (!msg || streaming) return
    setInput('')

    const newMessages = [...messages, { role: 'user', content: msg }]
    setMessages(newMessages)
    setStreaming(true)
    setStreamText('')

    try {
      const response = await fetch(`${API}/advisor/chat`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ messages: newMessages })
      })

      if (!response.ok) {
        const err = await response.json()
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.error}` }])
        setStreaming(false)
        return
      }

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let fullText  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.text) { fullText += data.text; setStreamText(fullText) }
            if (data.done) {
              setMessages(prev => [...prev, { role: 'assistant', content: fullText }])
              setStreamText(''); setStreaming(false)
            }
            if (data.error) {
              setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error}` }])
              setStreamText(''); setStreaming(false)
            }
          } catch {}
        }
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Connection error: ${e.message}` }])
      setStreamText('')
      setStreaming(false)
    }
  }

  const clearChat = () => { setMessages([]); setStreamText('') }

  // ── Loading state ─────────────────────────────────────────────────────
  if (configured === null) {
    return (
      <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:200, color:'var(--text-muted)', fontSize:13 }}>
        <i className="ti ti-loader-2" style={{ fontSize:20, marginRight:8 }} aria-hidden="true"/> Loading advisor...
      </div>
    )
  }

  // ── Not configured ────────────────────────────────────────────────────
  if (!configured) {
    return (
      <div className="card" style={{ textAlign:'center', padding:'3rem', maxWidth:500, margin:'0 auto' }}>
        <div style={{ width:60, height:60, borderRadius:'var(--radius-md)', background:'var(--purple-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 18px' }}>
          <i className="ti ti-brain" style={{ fontSize:30, color:'var(--purple)' }} aria-hidden="true"/>
        </div>
        <p style={{ fontSize:18, fontWeight:500, margin:'0 0 10px' }}>AI Advisor not configured</p>
        <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 22px', lineHeight:1.7 }}>
          Add your Anthropic API key to <code style={{ background:'var(--bg-secondary)', padding:'2px 6px', borderRadius:4, fontSize:12 }}>.env</code> to enable AI-powered financial insights and real-time chat.
        </p>
        <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'14px 18px', textAlign:'left', fontFamily:'monospace', fontSize:12, color:'var(--teal)', marginBottom:16 }}>
          ANTHROPIC_API_KEY=sk-ant-api03-...
        </div>
        <p style={{ fontSize:12, color:'var(--text-muted)', margin:0, lineHeight:1.6 }}>
          Get your key at <strong>console.anthropic.com</strong> → API Keys<br/>
          Then restart the server with <code style={{ fontSize:11 }}>npm start</code>
        </p>
      </div>
    )
  }

  // ── Main UI ───────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 165px)' }}>

      {/* Tab bar */}
      <div style={{ display:'flex', borderBottom:'0.5px solid var(--border)', marginBottom:0, flexShrink:0 }}>
        {[['chat','Chat','ti-message'],['insights','Proactive Insights','ti-sparkles']].map(([id, label, icon]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 20px', background:'none', border:'none',
              borderBottom:`2px solid ${tab===id ? 'var(--purple)' : 'transparent'}`,
              color: tab===id ? 'var(--purple)' : 'var(--text-secondary)',
              fontWeight: tab===id ? 500 : 400, fontSize:13, cursor:'pointer', borderRadius:0, marginBottom:-1 }}>
            <i className={`ti ${icon}`} aria-hidden="true"/> {label}
          </button>
        ))}
        {tab === 'chat' && messages.length > 0 && (
          <button onClick={clearChat}
            style={{ marginLeft:'auto', fontSize:11, color:'var(--text-muted)', background:'none', border:'none', paddingRight:4 }}>
            <i className="ti ti-trash" aria-hidden="true"/> Clear
          </button>
        )}
      </div>

      {/* ── Chat tab ─────────────────────────────────────────────────── */}
      {tab === 'chat' && (
        <>
          <div style={{ flex:1, overflowY:'auto', padding:'16px 2px', display:'flex', flexDirection:'column', gap:14 }}>

            {messages.length === 0 && !streaming && (
              <div style={{ textAlign:'center', padding:'2.5rem 1rem' }}>
                <div style={{ width:52, height:52, borderRadius:'var(--radius-md)', background:'var(--purple-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px' }}>
                  <i className="ti ti-brain" style={{ fontSize:26, color:'var(--purple)' }} aria-hidden="true"/>
                </div>
                <p style={{ fontSize:16, fontWeight:500, margin:'0 0 6px' }}>Ask your AI advisor</p>
                <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 22px', lineHeight:1.6 }}>
                  Powered by Claude Opus — has full access to your accounts, transactions, and real estate data
                </p>
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, justifyContent:'center' }}>
                  {SUGGESTED.map((s, i) => (
                    <button key={i} onClick={() => sendMessage(s)}
                      style={{ fontSize:11, padding:'7px 14px', background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)', borderRadius:20 }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => <Bubble key={i} role={m.role} content={m.content}/>)}

            {streaming && streamText && <Bubble role="assistant" content={streamText} streaming/>}

            {streaming && !streamText && (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', maxWidth:'80%', fontSize:13, color:'var(--text-muted)', border:'0.5px solid var(--border)' }}>
                <i className="ti ti-loader-2 spin" style={{ fontSize:14 }} aria-hidden="true"/>
                Thinking...
              </div>
            )}

            <div ref={bottomRef}/>
          </div>

          <div style={{ padding:'12px 0 0', borderTop:'0.5px solid var(--border)', display:'flex', gap:8, alignItems:'flex-end', flexShrink:0 }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
              disabled={streaming}
              placeholder="Ask about your finances… (Enter to send, Shift+Enter for new line)"
              style={{ flex:1, padding:'9px 12px', background:'var(--bg-secondary)', border:'0.5px solid var(--border-light)', borderRadius:'var(--radius-md)', color:'var(--text-primary)', fontSize:13, resize:'none', minHeight:42, maxHeight:120, lineHeight:1.5, outline:'none', fontFamily:'inherit', overflow:'hidden' }}
              rows={1}
            />
            <button onClick={() => sendMessage()} disabled={!input.trim() || streaming}
              style={{ padding:'9px 16px', background:'var(--purple)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer', flexShrink:0 }}>
              <i className="ti ti-send" aria-hidden="true"/>
            </button>
          </div>
        </>
      )}

      {/* ── Insights tab ─────────────────────────────────────────────── */}
      {tab === 'insights' && (
        <div style={{ flex:1, overflowY:'auto', paddingTop:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <div>
              <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Proactive Insights</p>
              {insightsAt
                ? <p style={{ fontSize:11, color:'var(--text-muted)', margin:'3px 0 0' }}>Generated {new Date(insightsAt).toLocaleString()}</p>
                : <p style={{ fontSize:11, color:'var(--text-muted)', margin:'3px 0 0' }}>AI analysis of your complete financial picture</p>
              }
            </div>
            <button onClick={generateInsights} disabled={genLoading}
              style={{ fontSize:12, background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
              <i className={`ti ${genLoading ? 'ti-loader-2 spin' : 'ti-sparkles'}`} aria-hidden="true"/>
              {genLoading ? 'Generating…' : 'Generate insights'}
            </button>
          </div>

          {insights.length === 0 ? (
            <div className="card" style={{ textAlign:'center', padding:'2.5rem' }}>
              <i className="ti ti-sparkles" style={{ fontSize:38, color:'var(--text-muted)', display:'block', marginBottom:14 }} aria-hidden="true"/>
              <p style={{ fontSize:14, fontWeight:500, margin:'0 0 8px' }}>No insights yet</p>
              <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0, lineHeight:1.6 }}>
                Click "Generate insights" to get AI-powered analysis of your spending, cash flow, taxes, and real estate portfolio.
              </p>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {insights.map((ins, i) => {
                const cat = ins.category || 'Portfolio'
                const pri = ins.priority || 'medium'
                const catStyle = CATEGORY_STYLE[cat] || { bg:'var(--blue-light)', color:'var(--blue)' }
                const priStyle = PRIORITY_STYLE[pri] || { bg:'var(--amber-light)', color:'var(--amber)' }
                return (
                  <div key={i} className="card" style={{ borderLeft:`3px solid ${catStyle.color}` }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                      <span style={{ fontSize:11, padding:'2px 9px', borderRadius:10, background:catStyle.bg, color:catStyle.color, fontWeight:500 }}>{cat}</span>
                      <span style={{ fontSize:11, padding:'2px 9px', borderRadius:10, background:priStyle.bg, color:priStyle.color }}>{pri} priority</span>
                    </div>
                    <p style={{ fontSize:14, fontWeight:500, margin:'0 0 6px' }}>{ins.title}</p>
                    <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0, lineHeight:1.65 }}>{ins.insight}</p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Bubble({ role, content, streaming }) {
  const isUser = role === 'user'
  return (
    <div style={{ display:'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', gap:10, alignItems:'flex-start' }}>
      {!isUser && (
        <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--purple-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
          <i className="ti ti-brain" style={{ fontSize:13, color:'var(--purple)' }} aria-hidden="true"/>
        </div>
      )}
      <div style={{
        maxWidth:'76%',
        padding:'10px 14px',
        borderRadius: isUser
          ? 'var(--radius-md) var(--radius-md) 4px var(--radius-md)'
          : 'var(--radius-md) var(--radius-md) var(--radius-md) 4px',
        background: isUser ? 'var(--purple)' : 'var(--bg-secondary)',
        color: isUser ? '#fff' : 'var(--text-primary)',
        fontSize: 13,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        border: isUser ? 'none' : '0.5px solid var(--border)',
      }}>
        {content}
        {streaming && (
          <span style={{ display:'inline-block', width:2, height:14, background:'var(--purple)', marginLeft:2, verticalAlign:'text-bottom', animation:'cursor-blink 0.7s step-end infinite' }}/>
        )}
      </div>
      {isUser && (
        <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--blue-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
          <i className="ti ti-user" style={{ fontSize:13, color:'var(--blue)' }} aria-hidden="true"/>
        </div>
      )}
    </div>
  )
}
