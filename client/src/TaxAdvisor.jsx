import { useState, useEffect, useRef } from 'react'
import TaxDataReview from './TaxDataReview'

const API = '/api'
const getToken = () => localStorage.getItem('caishen_token') || ''
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` })

const FILING_STATUSES = [
  ['single', 'Single'], ['mfj', 'Married Filing Jointly'], ['mfs', 'Married Filing Separately'],
  ['hoh', 'Head of Household'], ['qss', 'Qualifying Surviving Spouse'],
]
const TAX_YEARS = [2025, 2024, 2026]

const SUGGESTED = [
  'What is the standard deduction for my filing status?',
  'Can I deduct a home office if I am self-employed?',
  'How is my rental income taxed?',
  'What is my federal tax on a $150,000 salary?',
  'How does the QBI deduction work for my business?',
]

const usd = n => `$${Math.round(Math.abs(n || 0)).toLocaleString()}`
const pct = n => `${((n || 0) * 100).toFixed(n < 0.1 ? 1 : 0)}%`

export default function TaxAdvisor() {
  const [status, setStatus]   = useState(null)        // null = loading
  const [tab, setTab]         = useState('chat')

  // Context controls
  const [taxYear, setTaxYear]           = useState(2024)
  const [filingStatus, setFilingStatus] = useState('single')
  const [stateCode, setStateCode]       = useState('')
  const [provider, setProvider]         = useState('')

  // Chat state
  const [messages, setMessages] = useState([])         // {role:'user',content} | {role:'assistant',data}
  const [input, setInput]       = useState('')
  const [busy, setBusy]         = useState(false)

  // History
  const [sessions, setSessions] = useState([])

  const bottomRef = useRef(null)

  // ── Load status ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/tax-advisor/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        setStatus(d)
        setProvider(d?.providers?.default || 'ollama')
      })
      .catch(() => setStatus({ ready: false, providers: {}, rag: {} }))
  }, [])

  useEffect(() => { if (tab === 'history') loadHistory() }, [tab])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  const loadHistory = () => {
    fetch(`${API}/ai-sessions?limit=30`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(() => {})
  }

  // ── Send a question ──────────────────────────────────────────────────
  const ask = async (text) => {
    const q = (text ?? input).trim()
    if (!q || busy) return
    setInput('')

    // Build neutral history from prior turns
    const history = messages.map(m =>
      m.role === 'user'
        ? { role: 'user', content: m.content }
        : { role: 'assistant', content: m.data?.answer || '' }
    )

    const next = [...messages, { role: 'user', content: q }]
    setMessages(next)
    setBusy(true)

    try {
      const resp = await fetch(`${API}/tax-advisor/ask`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: q, taxYear, filingStatus, state: stateCode || undefined, provider, history }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setMessages(prev => [...prev, { role: 'assistant', data: { answer: `Error: ${data.error || 'request failed'}${data.detail ? `\n\n${data.detail}` : ''}`, _error: true } }])
      } else {
        setMessages(prev => [...prev, { role: 'assistant', data }])
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', data: { answer: `Connection error: ${e.message}`, _error: true } }])
    } finally {
      setBusy(false)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────
  if (status === null) {
    return (
      <div style={{ display:'flex', justifyContent:'center', alignItems:'center', height:200, color:'var(--text-muted)', fontSize:13 }}>
        <i className="ti ti-loader-2 spin" style={{ fontSize:20, marginRight:8 }} aria-hidden="true"/> Loading tax advisor…
      </div>
    )
  }

  // ── Not ready (no model backend) ─────────────────────────────────────
  if (!status.ready) {
    return <SetupScreen status={status}/>
  }

  const providerOptions = Object.entries({
    ollama: status.rag?.ollama, groq: status.providers?.groq, anthropic: status.providers?.anthropic,
  }).filter(([, on]) => on).map(([k]) => k)

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 165px)' }}>

      {/* Tab bar */}
      <div style={{ display:'flex', borderBottom:'0.5px solid var(--border)', flexShrink:0 }}>
        {[['chat','Advisor','ti-message-chatbot'], ['data','My Data','ti-table'], ['history','History','ti-history']].map(([id, label, icon]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display:'flex', alignItems:'center', gap:7, padding:'10px 20px', background:'none', border:'none',
              borderBottom:`2px solid ${tab===id ? 'var(--teal)' : 'transparent'}`,
              color: tab===id ? 'var(--teal)' : 'var(--text-secondary)',
              fontWeight: tab===id ? 500 : 400, fontSize:13, cursor:'pointer', borderRadius:0, marginBottom:-1 }}>
            <i className={`ti ${icon}`} aria-hidden="true"/> {label}
          </button>
        ))}
        {tab === 'chat' && messages.length > 0 && (
          <button onClick={() => setMessages([])}
            style={{ marginLeft:'auto', fontSize:11, color:'var(--text-muted)', background:'none', border:'none', paddingRight:4 }}>
            <i className="ti ti-trash" aria-hidden="true"/> Clear
          </button>
        )}
      </div>

      {/* RAG-offline banner (non-blocking) */}
      {!status.rag?.ready && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', margin:'10px 0 0',
          background:'var(--amber-light)', color:'var(--amber)', borderRadius:'var(--radius-sm)', fontSize:12 }}>
          <i className="ti ti-alert-triangle" aria-hidden="true"/>
          Source retrieval is offline (Qdrant/Ollama). Answers will be general and may lack citations until it's running.
        </div>
      )}

      {/* Context bar — shared by Advisor + My Data tabs */}
      {(tab === 'chat' || tab === 'data') && (
        <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', padding:'12px 0', flexShrink:0 }}>
          <ContextSelect label="Tax Year" value={taxYear} onChange={v => setTaxYear(Number(v))}
            options={TAX_YEARS.map(y => [y, y])} />
          <ContextSelect label="Filing Status" value={filingStatus} onChange={setFilingStatus}
            options={FILING_STATUSES} />
          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
            <label style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:0.4 }}>State</label>
            <input value={stateCode} onChange={e => setStateCode(e.target.value.toUpperCase().slice(0,2))}
              placeholder="—" maxLength={2}
              style={{ width:54, padding:'6px 8px', background:'var(--bg-secondary)', border:'0.5px solid var(--border-light)',
                borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:13, outline:'none', textAlign:'center' }}/>
          </div>
          {tab === 'chat' && providerOptions.length > 1 && (
            <ContextSelect label="Model" value={provider} onChange={setProvider}
              options={providerOptions.map(p => [p, p])} />
          )}
        </div>
      )}

      {tab === 'chat' && (
        <>
          {/* Messages */}
          <div style={{ flex:1, overflowY:'auto', padding:'4px 2px', display:'flex', flexDirection:'column', gap:14 }}>
            {messages.length === 0 && !busy && (
              <div style={{ textAlign:'center', padding:'2rem 1rem' }}>
                <div style={{ width:52, height:52, borderRadius:'var(--radius-md)', background:'var(--teal-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px' }}>
                  <i className="ti ti-receipt-tax" style={{ fontSize:26, color:'var(--teal)' }} aria-hidden="true"/>
                </div>
                <p style={{ fontSize:16, fontWeight:500, margin:'0 0 6px' }}>Tax Advisor</p>
                <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px', lineHeight:1.6, maxWidth:440, marginInline:'auto' }}>
                  Answers are grounded in retrieved IRS sources and a deterministic tax calculator — never invented numbers.
                  Always verify important decisions with a professional.
                </p>
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, justifyContent:'center', marginTop:16 }}>
                  {SUGGESTED.map((s, i) => (
                    <button key={i} onClick={() => ask(s)}
                      style={{ fontSize:11, padding:'7px 14px', background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)', borderRadius:20 }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'user'
                ? <UserBubble key={i} content={m.content}/>
                : <AssistantAnswer key={i} data={m.data}/>
            )}

            {busy && (
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', maxWidth:'80%', fontSize:13, color:'var(--text-muted)', border:'0.5px solid var(--border)' }}>
                <i className="ti ti-loader-2 spin" style={{ fontSize:14 }} aria-hidden="true"/>
                Retrieving sources, calculating, and checking citations…
              </div>
            )}
            <div ref={bottomRef}/>
          </div>

          {/* Input */}
          <div style={{ padding:'12px 0 0', borderTop:'0.5px solid var(--border)', display:'flex', gap:8, alignItems:'flex-end', flexShrink:0 }}>
            <textarea value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,120)+'px' }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
              disabled={busy}
              placeholder="Ask a tax question… (Enter to send, Shift+Enter for new line)"
              style={{ flex:1, padding:'9px 12px', background:'var(--bg-secondary)', border:'0.5px solid var(--border-light)', borderRadius:'var(--radius-md)', color:'var(--text-primary)', fontSize:13, resize:'none', minHeight:42, maxHeight:120, lineHeight:1.5, outline:'none', fontFamily:'inherit', overflow:'hidden' }}
              rows={1}/>
            <button onClick={() => ask()} disabled={!input.trim() || busy}
              style={{ padding:'9px 16px', background:'var(--teal)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', fontSize:13, cursor:'pointer', flexShrink:0 }}>
              <i className="ti ti-send" aria-hidden="true"/>
            </button>
          </div>
        </>
      )}

      {tab === 'data' && <TaxDataReview key={taxYear} taxYear={taxYear} filingStatus={filingStatus}/>}

      {tab === 'history' && <HistoryView sessions={sessions} onRefresh={loadHistory}/>}
    </div>
  )
}

// ── Context dropdown ─────────────────────────────────────────────────────
function ContextSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
      <label style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:0.4 }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ padding:'6px 8px', background:'var(--bg-secondary)', border:'0.5px solid var(--border-light)',
          borderRadius:'var(--radius-sm)', color:'var(--text-primary)', fontSize:13, outline:'none', cursor:'pointer' }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}

// ── User message ─────────────────────────────────────────────────────────
function UserBubble({ content }) {
  return (
    <div style={{ display:'flex', justifyContent:'flex-end', gap:10, alignItems:'flex-start' }}>
      <div style={{ maxWidth:'76%', padding:'10px 14px', borderRadius:'var(--radius-md) var(--radius-md) 4px var(--radius-md)',
        background:'var(--teal)', color:'#fff', fontSize:13, lineHeight:1.65, whiteSpace:'pre-wrap' }}>
        {content}
      </div>
      <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--blue-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
        <i className="ti ti-user" style={{ fontSize:13, color:'var(--blue)' }} aria-hidden="true"/>
      </div>
    </div>
  )
}

// ── Assistant answer (rich) ───────────────────────────────────────────────
function AssistantAnswer({ data }) {
  const [showCalc, setShowCalc] = useState(false)
  const v = data.validation
  const isError = data._error

  return (
    <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
      <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--teal-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, marginTop:2 }}>
        <i className="ti ti-receipt-tax" style={{ fontSize:13, color:'var(--teal)' }} aria-hidden="true"/>
      </div>

      <div style={{ maxWidth:'82%', display:'flex', flexDirection:'column', gap:8 }}>

        {/* Escalation / risk banner */}
        {data.escalated && (
          <div style={{ display:'flex', alignItems:'flex-start', gap:8, padding:'8px 12px', background:'var(--coral-light)', color:'var(--coral)', borderRadius:'var(--radius-sm)', fontSize:12, lineHeight:1.5 }}>
            <i className="ti ti-alert-octagon" style={{ marginTop:1 }} aria-hidden="true"/>
            <span><strong>Professional review recommended.</strong> {data.escalationReason}</span>
          </div>
        )}

        {/* Answer text */}
        <div style={{ padding:'10px 14px', borderRadius:'var(--radius-md) var(--radius-md) var(--radius-md) 4px',
          background:'var(--bg-secondary)', color: isError ? 'var(--coral)' : 'var(--text-primary)',
          fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap', border:'0.5px solid var(--border)' }}>
          {data.answer}
        </div>

        {/* Calculation breakdown */}
        {data.calculation && (
          <div style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
            <button onClick={() => setShowCalc(s => !s)}
              style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--bg-card)', border:'none', color:'var(--text-secondary)', fontSize:12, cursor:'pointer', borderRadius:0 }}>
              <i className={`ti ti-chevron-${showCalc ? 'down' : 'right'}`} aria-hidden="true"/>
              <i className="ti ti-calculator" style={{ color:'var(--teal)' }} aria-hidden="true"/>
              Calculation breakdown — {usd(data.calculation.totalLiability)} total tax
              <span style={{ marginLeft:'auto', fontSize:11, color:'var(--text-muted)' }}>
                {pct(data.calculation.effectiveRate)} effective · {pct(data.calculation.marginalRate)} marginal
              </span>
            </button>
            {showCalc && <CalculationBreakdown calc={data.calculation}/>}
          </div>
        )}

        {/* Citations */}
        {data.citations?.length > 0 && (
          <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center' }}>
            <span style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:0.4 }}>Sources:</span>
            {data.citations.map((c, i) => (
              <CitationChip key={i} c={c} n={i + 1}/>
            ))}
          </div>
        )}

        {/* Footer: validation + model */}
        {!isError && (
          <div style={{ display:'flex', alignItems:'center', gap:10, fontSize:11, color:'var(--text-muted)', flexWrap:'wrap' }}>
            {v && <ValidationBadge v={v}/>}
            {data.model && <span><i className="ti ti-cpu" aria-hidden="true"/> {data.model}</span>}
            {typeof data.latencyMs === 'number' && <span>{(data.latencyMs/1000).toFixed(1)}s</span>}
            {data.ragAvailable === false && <span style={{ color:'var(--amber)' }}><i className="ti ti-plug-off" aria-hidden="true"/> sources offline</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function CalculationBreakdown({ calc }) {
  return (
    <div style={{ padding:'10px 12px', background:'var(--bg-secondary)', fontSize:12 }}>
      <table style={{ width:'100%', borderCollapse:'collapse' }}>
        <tbody>
          {(calc.steps || []).map((s, i) => (
            <tr key={i} style={{ borderBottom:'0.5px solid var(--border)' }}>
              <td style={{ padding:'5px 0', color:'var(--text-secondary)', verticalAlign:'top' }}>
                {s.label}
                {s.irsRef && <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:6 }}>{s.irsRef}</span>}
                {s.note && <div style={{ color:'var(--amber)', fontSize:10, marginTop:2, lineHeight:1.4 }}>{s.note}</div>}
              </td>
              <td style={{ padding:'5px 0', textAlign:'right', color:'var(--text-primary)', fontVariantNumeric:'tabular-nums', whiteSpace:'nowrap', verticalAlign:'top' }}>
                {usd(s.value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(calc.assumptions?.length > 0) && (
        <div style={{ marginTop:10, padding:'8px 10px', background:'var(--amber-light)', borderRadius:'var(--radius-sm)' }}>
          <div style={{ fontSize:10, color:'var(--amber)', textTransform:'uppercase', letterSpacing:0.4, marginBottom:4 }}>Assumptions</div>
          {calc.assumptions.map((a, i) => (
            <div key={i} style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.5, marginBottom:3 }}>• {a}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function CitationChip({ c, n }) {
  const label = [c.sourceName, c.codeSection].filter(Boolean).join(' · ')
  const inner = (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10, padding:'3px 8px',
      background:'var(--blue-light)', color:'var(--blue)', borderRadius:10, lineHeight:1.4 }}>
      <i className="ti ti-file-text" aria-hidden="true"/> {label || `Source ${n}`}
      {c.url && <i className="ti ti-external-link" style={{ fontSize:9 }} aria-hidden="true"/>}
    </span>
  )
  return c.url
    ? <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration:'none' }}>{inner}</a>
    : inner
}

function ValidationBadge({ v }) {
  if (!v.passed) {
    return (
      <span title={(v.blocking || []).join('; ')} style={{ display:'inline-flex', alignItems:'center', gap:4, color:'var(--coral)' }}>
        <i className="ti ti-shield-x" aria-hidden="true"/> Unverified
      </span>
    )
  }
  if (v.warnings?.length) {
    return (
      <span title={v.warnings.join('; ')} style={{ display:'inline-flex', alignItems:'center', gap:4, color:'var(--amber)' }}>
        <i className="ti ti-shield-check" aria-hidden="true"/> Verified (notes)
      </span>
    )
  }
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, color:'var(--green)' }}>
      <i className="ti ti-shield-check" aria-hidden="true"/> Verified
    </span>
  )
}

// ── History tab ───────────────────────────────────────────────────────────
function HistoryView({ sessions, onRefresh }) {
  return (
    <div style={{ flex:1, overflowY:'auto', paddingTop:16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Advisor history <span style={{ fontSize:12, color:'var(--text-muted)', fontWeight:400 }}>(audit trail)</span></p>
        <button onClick={onRefresh} style={{ fontSize:12, background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
          <i className="ti ti-refresh" aria-hidden="true"/> Refresh
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="card" style={{ textAlign:'center', padding:'2.5rem' }}>
          <i className="ti ti-history" style={{ fontSize:38, color:'var(--text-muted)', display:'block', marginBottom:14 }} aria-hidden="true"/>
          <p style={{ fontSize:14, fontWeight:500, margin:'0 0 8px' }}>No advisor history yet</p>
          <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0 }}>Every question you ask is logged here with its sources, model, and verification result.</p>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {sessions.map(s => (
            <div key={s.id} className="card" style={{ padding:'12px 14px' }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
                <p style={{ fontSize:13, fontWeight:500, margin:0, flex:1, lineHeight:1.5 }}>{s.user_question}</p>
                {s.escalated && <span style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'var(--coral-light)', color:'var(--coral)', whiteSpace:'nowrap' }}>escalated</span>}
                {s.validation_passed === false && <span style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'var(--coral-light)', color:'var(--coral)', whiteSpace:'nowrap' }}>unverified</span>}
                {s.validation_passed === true && <span style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'var(--green-light)', color:'var(--green)', whiteSpace:'nowrap' }}>verified</span>}
              </div>
              <div style={{ display:'flex', gap:12, marginTop:8, fontSize:11, color:'var(--text-muted)', flexWrap:'wrap' }}>
                {s.tax_year && <span><i className="ti ti-calendar" aria-hidden="true"/> {s.tax_year}</span>}
                {s.model_used && <span><i className="ti ti-cpu" aria-hidden="true"/> {s.model_used}</span>}
                {Array.isArray(s.risk_flags) && s.risk_flags.length > 0 &&
                  <span><i className="ti ti-flag" aria-hidden="true"/> {s.risk_flags.map(f => f.flag || f).join(', ')}</span>}
                <span style={{ marginLeft:'auto' }}>{new Date(s.created_at).toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Setup screen (no backend ready) ───────────────────────────────────────
function SetupScreen({ status }) {
  return (
    <div className="card" style={{ maxWidth:560, margin:'0 auto', padding:'2.5rem' }}>
      <div style={{ width:60, height:60, borderRadius:'var(--radius-md)', background:'var(--teal-light)', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 18px' }}>
        <i className="ti ti-receipt-tax" style={{ fontSize:30, color:'var(--teal)' }} aria-hidden="true"/>
      </div>
      <p style={{ fontSize:18, fontWeight:500, margin:'0 0 10px', textAlign:'center' }}>Tax Advisor — backend not ready</p>
      <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 20px', lineHeight:1.7, textAlign:'center' }}>
        The advisor needs at least one AI model backend. Choose the easiest path:
      </p>

      <Step icon="ti-server" title="Option A — Local (free, private)"
        body={<>Install <strong>Ollama</strong>, then pull a chat model and the embedding model:<Code>ollama pull qwen2.5:32b-instruct{'\n'}ollama pull nomic-embed-text</Code>Set <code>AI_PROVIDER=ollama</code> in <code>.env</code>.</>}/>
      <Step icon="ti-bolt" title="Option B — Groq (free tier, cloud)"
        body={<>Get a key at <strong>console.groq.com</strong>, then in <code>.env</code>:<Code>AI_PROVIDER=groq{'\n'}GROQ_API_KEY=gsk_...</Code></>}/>
      <Step icon="ti-database" title="For grounded citations — Qdrant"
        body={<>Start the vector DB and seed IRS sources:<Code>docker compose -f server/rag/docker-compose.yml up -d{'\n'}node server/rag/seed.js</Code></>}/>

      <div style={{ marginTop:18, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)', fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
        Current status — model backend: <b style={{ color: status.ready ? 'var(--green)' : 'var(--coral)' }}>{status.ready ? 'ready' : 'not ready'}</b>,
        {' '}Ollama: <b style={{ color: status.rag?.ollama ? 'var(--green)' : 'var(--coral)' }}>{status.rag?.ollama ? 'up' : 'down'}</b>,
        {' '}Qdrant: <b style={{ color: status.rag?.qdrant ? 'var(--green)' : 'var(--coral)' }}>{status.rag?.qdrant ? 'up' : 'down'}</b>,
        {' '}Groq: <b style={{ color: status.providers?.groq ? 'var(--green)' : 'var(--text-muted)' }}>{status.providers?.groq ? 'configured' : 'no key'}</b>
      </div>
      <p style={{ fontSize:11, color:'var(--text-muted)', margin:'14px 0 0', textAlign:'center' }}>Restart the server after editing <code>.env</code>.</p>
    </div>
  )
}

function Step({ icon, title, body }) {
  return (
    <div style={{ display:'flex', gap:12, marginBottom:16 }}>
      <div style={{ width:34, height:34, borderRadius:'var(--radius-sm)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <i className={`ti ${icon}`} style={{ fontSize:16, color:'var(--teal)' }} aria-hidden="true"/>
      </div>
      <div style={{ flex:1 }}>
        <p style={{ fontSize:13, fontWeight:500, margin:'0 0 4px' }}>{title}</p>
        <div style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.6 }}>{body}</div>
      </div>
    </div>
  )
}

function Code({ children }) {
  return (
    <pre style={{ background:'var(--bg-primary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)',
      padding:'8px 10px', margin:'6px 0', fontSize:11, color:'var(--teal)', overflowX:'auto', whiteSpace:'pre' }}>{children}</pre>
  )
}
