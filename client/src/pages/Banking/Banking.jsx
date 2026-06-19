import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import axios from 'axios'
import TransactionsTable from './TransactionsTable'
import ReconcileVerify from './ReconcileVerify'
import { fd, fmtFull, TYPE_LABELS, TYPE_COLORS } from './bankingFormat'

const API = '/api'
const IS_LOCALHOST = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')

// ── Account classification ────────────────────────────────────────────────────
// Covers all documented Plaid subtypes + institution-name heuristics

// All Plaid retirement subtypes
const RETIREMENT_SUBS = new Set([
  '401a','401k','403b','457b','457plan',
  'ira','roth','roth ira','roth 401k','roth 403b','roth 457b','roth pension',
  'roth profit sharing plan','roth thrift savings plan',
  'pension','profit sharing plan','profit sharing',
  'simple ira','sep ira','sarsep','keogh',
  'thrift savings plan','retirement',
  'annuity','fixed annuity','variable annuity','other annuity',
  // education savings
  '529','education savings account',
  // Canadian / international
  'rrsp','rrif','rdsp','resp','tfsa','fhsa','lira','lif','lrif','rlif','prif','lrsp','sipp',
])

// All non-retirement Plaid investment subtypes
const EQUITY_SUBS = new Set([
  'brokerage','mutual fund','etf','non-taxable brokerage account',
  'trust','ugma','utma','stock plan',
  'gic','cash isa','isa (non-cash)',
  'life insurance','other insurance',
  'health reimbursement arrangement','hsa (non-cash)',
  'qshr',
])

// Crypto subtypes (Plaid 2022+)
const CRYPTO_SUBS = new Set(['crypto exchange','non-custodial wallet'])

// Depository subtypes
const BANK_SUBS = new Set([
  'checking','savings','cd','money market','prepaid',
  'cash management','paypal','hsa','ebt','limited purpose checking','cash',
])

// Loan subtypes
const LOAN_SUBS = new Set([
  'auto','student','consumer','installment','personal',
  'line of credit','business','commercial','construction','loan','overdraft',
])

// Real-estate-backed loan subtypes
const MORTGAGE_SUBS = new Set(['mortgage','home equity','heloc'])

const INVESTMENT_TYPES = new Set(['investment','brokerage'])
const BANK_TYPES       = new Set(['depository','bank'])

// ── Institution name → asset class ───────────────────────────────────────────
// Case-insensitive substring match; first match wins.
// Put more-specific names before more-general ones.
const INST_CLASS_MAP = [
  // Crypto exchanges
  ['coinbase',              'crypto'],
  ['gemini',                'crypto'],
  ['kraken',                'crypto'],
  ['binance',               'crypto'],
  ['crypto.com',            'crypto'],
  ['ftx',                   'crypto'],
  ['okx',                   'crypto'],
  ['bybit',                 'crypto'],
  ['bitfinex',              'crypto'],
  ['bitstamp',              'crypto'],
  ['gate.io',               'crypto'],
  ['kucoin',                'crypto'],
  ['huobi',                 'crypto'],
  ['uphold',                'crypto'],
  ['river financial',       'crypto'],
  ['swan bitcoin',          'crypto'],
  ['strike',                'crypto'],
  ['robinhood crypto',      'crypto'],  // before plain 'robinhood'
  ['voyager digital',       'crypto'],
  ['celsius network',       'crypto'],
  ['blockfi',               'crypto'],
  ['nexo',                  'crypto'],
  ['bitpanda',              'crypto'],
  ['deribit',               'crypto'],
  ['bitmex',                'crypto'],
  ['phemex',                'crypto'],
  ['bitget',                'crypto'],
  ['luno',                  'crypto'],
  ['coinsquare',            'crypto'],
  ['ndax',                  'crypto'],
  ['swyftx',                'crypto'],

  // Brokerages & investment platforms → equity
  ['m1 finance',            'equity'],
  ['m1finance',             'equity'],
  ['robinhood',             'equity'],
  ['acorns',                'equity'],
  ['public.com',            'equity'],
  ['webull',                'equity'],
  ['tastytrade',            'equity'],
  ['tastyworks',            'equity'],
  ['interactive brokers',   'equity'],
  ['ibkr',                  'equity'],
  ['charles schwab',        'equity'],
  ['schwab',                'equity'],
  ['fidelity',              'equity'],
  ['vanguard',              'equity'],
  ['td ameritrade',         'equity'],
  ['e*trade',               'equity'],
  ['etrade',                'equity'],
  ['merrill edge',          'equity'],
  ['merrill lynch',         'equity'],
  ['morgan stanley',        'equity'],
  ['ubs financial',         'equity'],
  ['raymond james',         'equity'],
  ['edward jones',          'equity'],
  ['ally invest',           'equity'],
  ['ally financial',        'equity'],
  ['firstrade',             'equity'],
  ['tradestation',          'equity'],
  ['thinkorswim',           'equity'],
  ['moomoo',                'equity'],
  ['stash',                 'equity'],
  ['sofi invest',           'equity'],
  ['sofi',                  'equity'],
  ['wealthfront',           'equity'],
  ['betterment',            'equity'],
  ['ellevest',              'equity'],
  ['titan',                 'equity'],
  ['composer',              'equity'],
  ['j.p. morgan',           'equity'],
  ['jpmorgan',              'equity'],
  ['lightspeed financial',  'equity'],
  ['apex clearing',         'equity'],
  ['drivewealth',           'equity'],
  ['tradier',               'equity'],
  ['folio investing',       'equity'],
  ['stockpile',             'equity'],
  ['magnifi',               'equity'],
  ['wealthsimple',          'equity'],
  ['nutmeg',                'equity'],
  ['moneyfarm',             'equity'],
  ['freetrade',             'equity'],
  ['trading 212',           'equity'],
  ['degiro',                'equity'],
  ['saxo bank',             'equity'],
  ['etoro',                 'equity'],
  ['plus500',               'equity'],
  ['ig group',              'equity'],
  ['avatrade',              'equity'],
  ['oanda',                 'equity'],
  ['forex.com',             'equity'],

  // Retirement-focused providers (subtype catches most; these are edge-case safety nets)
  ['guideline',             'retirement'],
  ['human interest',        'retirement'],
  ['voya financial',        'retirement'],
  ['principal financial',   'retirement'],
  ['tiaa',                  'retirement'],
  ['empower retirement',    'retirement'],
  ['empower',               'retirement'],
  ['transamerica',          'retirement'],
  ['john hancock',          'retirement'],
  ['massmutual',            'retirement'],
  ['nationwide retirement', 'retirement'],
  ['lincoln financial',     'retirement'],
  ['securian',              'retirement'],
  ['newport group',         'retirement'],
  ['ascensus',              'retirement'],
  ['paychex retirement',    'retirement'],
  ['adp retirement',        'retirement'],
  ['prudential retirement', 'retirement'],
  ['northwestern mutual',   'retirement'],
  ['guardian life',         'retirement'],
  ['new york life',         'retirement'],
  ['unum',                  'retirement'],
  ['standard insurance',    'retirement'],
]

// ── Account name pattern → asset class (last-resort fallback) ────────────────
const NAME_PATTERNS = [
  [/\b(401[ak]?|403[bB]|457[bB]|roth|[\s(]ira\b|sep\s+ira|simple\s+ira|pension|profit[- ]shar|thrift[- ]sav|\btsp\b|retirement)\b/i, 'retirement'],
  [/\b(bitcoin|btc|ethereum|eth|crypto|defi|nft|token|blockchain)\b/i,                                                               'crypto'],
  [/\b(brokerage|investm|portfolio|trading|equity|stock[^h]|mutual[- ]fund|securities)\b/i,                                          'equity'],
  [/\b(mortgage|heloc|home[- ]equity|home[- ]loan)\b/i,                                                                              'loan'],
]

export function classifyAccount(acc) {
  const t    = (acc.type        || '').toLowerCase().trim()
  const s    = (acc.subtype     || '').toLowerCase().trim()
  const inst = (acc.institution || '').toLowerCase()
  const name = (acc.name        || '').toLowerCase()

  // 1. Subtype-based — highest fidelity, directly from Plaid ─────────────────
  if (RETIREMENT_SUBS.has(s)) return 'retirement'
  if (CRYPTO_SUBS.has(s))     return 'crypto'
  if (MORTGAGE_SUBS.has(s))   return 'loan'
  if (LOAN_SUBS.has(s))       return 'loan'
  if (EQUITY_SUBS.has(s))     return 'equity'
  if (BANK_SUBS.has(s))       return 'bank'
  if (s === 'credit card' || s === 'bank issued credit card' || s === 'paypal credit card') return 'credit'

  // 2. Type-based ─────────────────────────────────────────────────────────────
  if (INVESTMENT_TYPES.has(t)) return 'equity'
  if (BANK_TYPES.has(t))       return 'bank'
  if (t === 'credit')          return 'credit'
  if (t === 'loan')            return 'loan'

  // 3. Institution name lookup ─────────────────────────────────────────────────
  for (const [key, cls] of INST_CLASS_MAP) {
    if (inst.includes(key)) return cls
  }

  // 4. Account name / institution name pattern matching ───────────────────────
  for (const [rx, cls] of NAME_PATTERNS) {
    if (rx.test(name) || rx.test(inst)) return cls
  }

  return 'other'
}

export const isBankAccount      = acc => classifyAccount(acc) === 'bank'
export const isEquityAccount    = acc => classifyAccount(acc) === 'equity'
export const isRetirementAccount= acc => classifyAccount(acc) === 'retirement'
export const isCryptoAccount    = acc => classifyAccount(acc) === 'crypto'

// ── Category colors ───────────────────────────────────────────────────────────
// CAT_COLOR → moved to ./bankingFormat

// ── Chart of Accounts types (mirrors Accounting.jsx) ──────────────────────────
// The "Account Type" — the QuickBooks-style top-level classification of a GL
// account. Determines which financial statement it lands on (Balance Sheet vs P&L).
// TYPE_ORDER / TYPE_LABELS / TYPE_COLORS → moved to ./bankingFormat

// ── Reusable modal + field (mirrors Accounting.jsx) ───────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'24px', width:520, maxHeight:'85vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <p style={{ fontSize:15, fontWeight:500, margin:0 }}>{title}</p>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', padding:4, fontSize:16, cursor:'pointer' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:4 }}>{label}</label>
      {children}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────
function MetricCard({ label, value, sub, subColor, icon, iconColor }) {
  return (
    <div className="metric-card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <p style={{fontSize:11,color:'var(--text-secondary)',margin:'0 0 6px',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.5px'}}>{label}</p>
        {icon && <i className={`ti ${icon}`} style={{fontSize:18,color:iconColor||'var(--text-secondary)'}} aria-hidden="true"/>}
      </div>
      <p style={{fontSize:22,fontWeight:500,margin:0}}>{value}</p>
      {sub && <p style={{fontSize:12,color:subColor||'var(--text-secondary)',margin:'4px 0 0'}}>{sub}</p>}
    </div>
  )
}

function AccountCard({ acc, selected, onClick, setting, properties = [], onSaveSetting }) {
  // availableBalance = what the bank shows / what you can spend; balance = posted.
  const available = acc.availableBalance ?? acc.balance ?? 0
  const posted    = acc.balance ?? 0
  const hasPostedDiff = acc.availableBalance != null && Math.abs(available - posted) >= 0.01
  const subLabel  = acc.subtype
    ? acc.subtype.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase())
    : (acc.type || 'Account').replace(/\b\w/g, c => c.toUpperCase())
  const sourceLabel = acc.source === 'plaid' ? 'Live' : acc.source === 'csv_import' ? 'CSV' : 'Manual'
  const business   = !!setting?.business
  const propertyId = setting?.propertyId || ''

  return (
    <div onClick={onClick} title="Click to show only this account's transactions"
      style={{
        background: selected ? 'rgba(99,153,34,0.10)' : 'var(--bg-card)',
        border: `1px solid ${selected ? 'var(--green)' : 'var(--border)'}`,
        borderRadius:'var(--radius-md)', padding:'12px 14px',
        display:'flex', flexDirection:'column', gap:10, cursor:'pointer',
        transition:'border-color .15s, background .15s',
      }}
      onMouseEnter={e=>{ if(!selected) e.currentTarget.style.borderColor='var(--border-light)' }}
      onMouseLeave={e=>{ if(!selected) e.currentTarget.style.borderColor='var(--border)' }}>

      {/* Name + subtype */}
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8}}>
        <div style={{minWidth:0}}>
          <p style={{fontSize:13,fontWeight:600,margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{acc.name}</p>
          <p style={{fontSize:11,color:'var(--text-secondary)',margin:'2px 0 0'}}>
            {acc.institution}{acc.last4 ? ` ••••${acc.last4}` : ''}
          </p>
        </div>
        <span style={{fontSize:10,fontWeight:500,padding:'2px 7px',borderRadius:99,background:'var(--bg-secondary)',color:'var(--text-secondary)',textTransform:'capitalize',border:'0.5px solid var(--border)',whiteSpace:'nowrap',flexShrink:0}}>
          {subLabel}
        </span>
      </div>

      {/* Balance */}
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:8}}>
        <p style={{fontSize:20,fontWeight:600,margin:0,color:available<0?'var(--coral)':'var(--text-primary)'}}>
          {fmtFull(available)}
        </p>
        {hasPostedDiff && (
          <span style={{fontSize:11,color:'var(--text-muted)',whiteSpace:'nowrap'}}>posted {fmtFull(posted)}</span>
        )}
      </div>

      {/* Business / property tag — purchases on a business account auto-categorize as business */}
      {onSaveSetting && (
        <div onClick={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()}
          style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
          <button onClick={()=>onSaveSetting(acc.id,{ business: !business })}
            title="Mark this account's purchases as business — they auto-categorize as business expenses, and big equipment/furniture buys become fixed assets"
            style={{fontSize:10,fontWeight:600,padding:'2px 8px',borderRadius:99,cursor:'pointer',display:'inline-flex',alignItems:'center',gap:3,
              border:`1px solid ${business?'var(--amber)':'var(--border)'}`,
              background: business?'var(--amber-light)':'transparent',
              color: business?'var(--amber)':'var(--text-muted)'}}>
            <i className={`ti ${business?'ti-briefcase':'ti-user'}`} style={{fontSize:11}} aria-hidden="true"/>
            {business?'Business':'Personal'}
          </button>
          {business && properties.length>0 && (
            <select value={propertyId} onChange={e=>onSaveSetting(acc.id,{ propertyId: e.target.value })}
              style={{fontSize:10,padding:'2px 4px',borderRadius:6,maxWidth:118,
                background:'var(--bg-secondary)',color:'var(--text-secondary)',border:'0.5px solid var(--border)'}}>
              <option value="">Tag property…</option>
              {properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontSize:10,padding:'1px 6px',borderRadius:99,
          background: acc.source==='plaid'?'var(--teal-light)':'var(--bg-secondary)',
          color: acc.source==='plaid'?'var(--teal)':'var(--text-muted)',
          border:`0.5px solid ${acc.source==='plaid'?'var(--teal)':'var(--border)'}`}}>
          {sourceLabel}
        </span>
        {acc.lastUpdated && <span style={{fontSize:10,color:'var(--text-muted)'}}>{new Date(acc.lastUpdated).toLocaleDateString()}</span>}
      </div>
    </div>
  )
}

function StmtCard({ f, onOpen }) {
  return (
    <div onClick={()=>onOpen(f)}
      style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',border:'0.5px solid var(--border)',borderRadius:'var(--radius-sm)',color:'var(--text-primary)',background:'var(--bg-card)',cursor:'pointer',transition:'border-color 0.15s'}}
      onMouseEnter={e=>e.currentTarget.style.borderColor='var(--green)'}
      onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
      <i className="ti ti-file-type-pdf" style={{fontSize:20,color:'var(--coral)',flexShrink:0}} aria-hidden="true"/>
      <div style={{flex:1,minWidth:0}}>
        <p style={{fontSize:12,fontWeight:500,margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{f.name}</p>
        <p style={{fontSize:10,color:'var(--text-muted)',margin:'2px 0 0'}}>{(f.size/1024).toFixed(0)} KB</p>
      </div>
      <i className="ti ti-eye" style={{fontSize:13,color:'var(--text-muted)',flexShrink:0}} aria-hidden="true"/>
    </div>
  )
}

// In-app PDF preview popup for a statement — fetched WITH auth (token → blob →
// iframe) so it mirrors the Data Vault preview instead of opening the raw API
// URL in a new tab (which 401s because a plain navigation carries no token).
function StmtPreviewModal({ f, onClose }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let objUrl, alive = true
    const token = localStorage.getItem('caishen_token') || ''
    fetch(`/api/vault/file/${f.id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(`Couldn't load file (HTTP ${r.status})`); return r.blob() })
      .then(blob => { if (alive) { objUrl = URL.createObjectURL(blob); setUrl(objUrl) } })
      .catch(e => alive && setErr(e.message))
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [f.id])
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
      onClick={e=>e.target===e.currentTarget && onClose()}>
      <div style={{background:'var(--bg-card)',borderRadius:'var(--radius-lg)',width:'min(900px,94vw)',height:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',border:'0.5px solid var(--border)'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'10px 14px',borderBottom:'0.5px solid var(--border)'}}>
          <span style={{fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.name}</span>
          <div style={{display:'flex',gap:14,alignItems:'center',flexShrink:0}}>
            {url && <a href={url} download={f.name} style={{fontSize:12,color:'var(--blue)',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:4}}><i className="ti ti-download" aria-hidden="true"/>Download</a>}
            <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-muted)',fontSize:16,cursor:'pointer'}} aria-label="Close">✕</button>
          </div>
        </div>
        <div style={{flex:1,background:'#222',minHeight:0}}>
          {err   ? <p style={{color:'var(--coral)',padding:20,fontSize:13}}>{err}</p>
           : url ? <iframe src={url} title={f.name} style={{width:'100%',height:'100%',border:'none'}}/>
           :       <p style={{color:'var(--text-muted)',padding:20,fontSize:13}}>Loading…</p>}
        </div>
      </div>
    </div>
  )
}

// ── Transactions table (QuickBooks-style columns) ──────────────────────────────
// TxTable → extracted to ./TransactionsTable.jsx (now includes row selection,
// bulk actions, pagination, and CSV export / print).

// ── Main export ───────────────────────────────────────────────────────────────
// ── Horizontal account strip — overflow scroll + paging arrows + drag-to-pan ────
function ArrowBtn({ dir, onClick }) {
  return (
    <button onClick={onClick} aria-label={dir==='left'?'Scroll left':'Scroll right'}
      style={{
        position:'absolute', top:'50%', [dir]:-4, transform:'translateY(-50%)', zIndex:3,
        width:30, height:30, borderRadius:'50%', background:'var(--bg-card)',
        border:'1px solid var(--border-light)', color:'var(--text-secondary)', cursor:'pointer',
        display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 2px 8px rgba(0,0,0,0.4)',
      }}>
      <i className={`ti ti-chevron-${dir}`} style={{ fontSize:16 }} aria-hidden="true"/>
    </button>
  )
}

function AccountStrip({ bankAccounts, selectedAcct, setSelectedAcct, settings = {}, properties = [], onSaveSetting }) {
  const ref  = useRef(null)
  const drag = useRef({ active:false, startX:0, startScroll:0, moved:false })
  const [arrows, setArrows] = useState({ left:false, right:false })

  const updateArrows = () => {
    const el = ref.current; if (!el) return
    setArrows({
      left:  el.scrollLeft > 4,
      right: el.scrollLeft < el.scrollWidth - el.clientWidth - 4,
    })
  }

  useEffect(() => {
    updateArrows()
    const el = ref.current
    const onScroll = () => updateArrows()
    el?.addEventListener('scroll', onScroll, { passive:true })
    window.addEventListener('resize', updateArrows)

    // Drag-to-pan: window-level listeners so a drag survives leaving the strip.
    const onMove = (e) => {
      const d = drag.current
      if (!d.active || !ref.current) return
      const dx = e.clientX - d.startX
      if (Math.abs(dx) > 4) d.moved = true
      ref.current.scrollLeft = d.startScroll - dx
    }
    const onUp = () => {
      if (drag.current.active && ref.current) ref.current.style.cursor = 'grab'
      drag.current.active = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      el?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', updateArrows)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [bankAccounts.length])

  const onDown = (e) => {
    const el = ref.current; if (!el) return
    drag.current = { active:true, startX:e.clientX, startScroll:el.scrollLeft, moved:false }
    el.style.cursor = 'grabbing'
  }

  const page = (d) => {
    const el = ref.current; if (!el) return
    el.scrollBy({ left: d * Math.max(el.clientWidth * 0.85, 250), behavior:'smooth' })
  }

  // A click that came from a drag should not toggle the account filter.
  const clickCard = (id) => {
    if (drag.current.moved) { drag.current.moved = false; return }
    setSelectedAcct(prev => prev === id ? null : id)
  }

  return (
    <div style={{ position:'relative' }}>
      {arrows.left  && <ArrowBtn dir="left"  onClick={()=>page(-1)}/>}
      {arrows.right && <ArrowBtn dir="right" onClick={()=>page(1)}/>}
      <div ref={ref} className="acct-scroll"
        onMouseDown={onDown} onDragStart={e=>e.preventDefault()}
        style={{ display:'flex', gap:10, overflowX:'auto', cursor:'grab', userSelect:'none', paddingBottom:2 }}>
        {bankAccounts.map(a => (
          <div key={a.id} style={{ flex:'0 0 240px' }}>
            <AccountCard acc={a} selected={selectedAcct===a.id} onClick={()=>clickCard(a.id)} setting={settings[a.id]} properties={properties} onSaveSetting={onSaveSetting}/>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Phase 4: Receipt attachment + OCR panel ───────────────────────────────────
const MATCH_STYLE = {
  matched:    { color: 'var(--teal)',   icon: 'ti ti-circle-check',  label: 'Matched' },
  partial:    { color: 'var(--amber)',  icon: 'ti ti-alert-circle',  label: 'Partial match' },
  mismatch:   { color: 'var(--coral)',  icon: 'ti ti-alert-triangle',label: 'Mismatch' },
  unreviewed: { color: 'var(--text-muted)', icon: 'ti ti-clock',     label: 'Pending OCR' },
}

// Full-size receipt viewer — fetched WITH auth (token → blob → img/iframe), same
// pattern as StmtPreviewModal. zIndex sits above the transaction detail modal.
function ReceiptViewModal({ receipt, onClose }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let objUrl, alive = true
    axios.get(`${API}/receipts/file/${receipt.id}`, { responseType: 'blob' })
      .then(res => {
        if (!alive) return
        objUrl = URL.createObjectURL(res.data); setUrl(objUrl)
      })
      .catch(e => alive && setErr(e.response?.data?.error || e.message))
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl) }
  }, [receipt.id])
  const isImg = (receipt.mime_type || '').startsWith('image/')
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:1100,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}
      onClick={e=>e.target===e.currentTarget && onClose()}>
      <div style={{background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-lg)',maxWidth:'94vw',maxHeight:'92vh',display:'flex',flexDirection:'column',overflow:'hidden',...(isImg?{}:{width:'min(860px,94vw)',height:'88vh'})}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:'10px 14px',borderBottom:'0.5px solid var(--border)'}}>
          <span style={{fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{receipt.original_name || 'Receipt'}</span>
          <div style={{display:'flex',gap:14,alignItems:'center',flexShrink:0}}>
            {url && <a href={url} download={receipt.original_name || 'receipt'} style={{fontSize:12,color:'var(--blue)',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:4}}><i className="ti ti-download" aria-hidden="true"/>Download</a>}
            <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-muted)',fontSize:16,cursor:'pointer'}} aria-label="Close">✕</button>
          </div>
        </div>
        <div style={{flex:1,minHeight:0,background:'#222',display:'flex',alignItems:'center',justifyContent:'center'}}>
          {err   ? <p style={{color:'var(--coral)',padding:20,fontSize:13}}>{err}</p>
           : !url ? <p style={{color:'var(--text-muted)',padding:20,fontSize:13}}>Loading…</p>
           : isImg ? <img src={url} alt={receipt.original_name || 'Receipt'} style={{maxWidth:'90vw',maxHeight:'82vh',objectFit:'contain',display:'block'}}/>
           :         <iframe src={url} title={receipt.original_name || 'Receipt'} style={{width:'100%',height:'100%',border:'none'}}/>}
        </div>
      </div>
    </div>
  )
}

function ReceiptPanel({ txId, onChanged }) {
  const [receipts,   setReceipts]   = useState([])
  const [uploading,  setUploading]  = useState(false)
  const [err,        setErr]        = useState('')
  const [expanded,   setExpanded]   = useState({})
  const [fileUrls,   setFileUrls]   = useState({})     // receiptId → blob object URL (thumbnails)
  const [viewing,    setViewing]    = useState(null)   // receipt open in the full-size viewer
  const [dragOver,   setDragOver]   = useState(false)
  const urlsRef = useRef({})                           // owns the object URLs for cleanup

  const load = useCallback(() => {
    axios.get(`${API}/receipts/${txId}`).then(r => setReceipts(r.data)).catch(() => {})
  }, [txId])

  useEffect(() => { load() }, [load])
  useEffect(() => () => {
    Object.values(urlsRef.current).forEach(u => { if (u && u !== 'pending') URL.revokeObjectURL(u) })
  }, [])

  // Lazy-fetch the bytes for image thumbnails (authed via the axios token header).
  const ensureFileUrl = useCallback((id) => {
    if (urlsRef.current[id]) return
    urlsRef.current[id] = 'pending'
    axios.get(`${API}/receipts/file/${id}`, { responseType: 'blob' })
      .then(res => {
        const u = URL.createObjectURL(res.data)
        urlsRef.current[id] = u
        setFileUrls(m => ({ ...m, [id]: u }))
      })
      .catch(() => { delete urlsRef.current[id] })
  }, [])
  useEffect(() => {
    receipts.filter(r => (r.mime_type || '').startsWith('image/')).forEach(r => ensureFileUrl(r.id))
  }, [receipts, ensureFileUrl])

  async function attach(fileList) {
    const files = [...(fileList || [])].filter(Boolean)
    if (!files.length || uploading) return
    setUploading(true); setErr('')
    try {
      for (const f of files) {
        const fd = new FormData(); fd.append('file', f)
        await axios.post(`${API}/receipts/attach/${txId}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
    } catch (e) {
      setErr(e.response?.data?.error || `Upload failed: ${e.message}`)
    }
    load(); onChanged?.()
    setUploading(false)
  }

  // Paste a screenshot (Ctrl+V) while the detail modal is open. Only fires when
  // the clipboard holds an image, so pasting text into the memo still works.
  const attachRef = useRef(null)
  attachRef.current = attach
  useEffect(() => {
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))
      if (!item) return
      const f = item.getAsFile()
      if (f) { e.preventDefault(); attachRef.current([f]) }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  async function del(id) {
    await axios.delete(`${API}/receipts/${id}`).catch(() => {})
    setReceipts(prev => prev.filter(r => r.id !== id))
    onChanged?.()
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); attach(e.dataTransfer.files) }}
      style={{marginBottom:16,borderTop:'0.5px solid var(--border)',paddingTop:14,
        outline: dragOver ? '1.5px dashed var(--blue)' : 'none', outlineOffset:4, borderRadius:6}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <span style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px'}}>
          <i className="ti ti-receipt-2" style={{marginRight:5}} aria-hidden="true"/>Receipts
        </span>
        <label style={{cursor:'pointer',fontSize:12,color:'var(--blue)',display:'flex',alignItems:'center',gap:4}}>
          <i className={uploading ? 'ti ti-loader-2' : 'ti ti-paperclip'} style={uploading ? {animation:'spin 1s linear infinite'} : {}} aria-hidden="true"/>
          {uploading ? 'Scanning…' : 'Attach'}
          <input type="file" accept="image/*,.pdf" multiple style={{display:'none'}}
            onChange={e => { attach(e.target.files); e.target.value = '' }} disabled={uploading}/>
        </label>
      </div>

      {err && (
        <p style={{fontSize:12,color:'var(--coral)',margin:'0 0 8px',display:'flex',alignItems:'flex-start',gap:5}}>
          <i className="ti ti-alert-triangle" style={{marginTop:1,flexShrink:0}} aria-hidden="true"/>{err}
        </p>
      )}

      {receipts.length === 0 && !err && (
        <p style={{fontSize:12,color:'var(--text-muted)',margin:'0 0 4px',fontStyle:'italic'}}>
          No receipts attached — click Attach, drop a file, or paste a screenshot (Ctrl+V).
        </p>
      )}

      {receipts.map(r => {
        const ms    = MATCH_STYLE[r.match_status] || MATCH_STYLE.unreviewed
        const ocr   = r.ocr_data || {}
        const open  = !!expanded[r.id]
        const isImg = (r.mime_type || '').startsWith('image/')
        const thumb = fileUrls[r.id]
        return (
          <div key={r.id} style={{marginBottom:8,borderRadius:6,border:'0.5px solid var(--border)',overflow:'hidden'}}>
            {/* Header row */}
            <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'var(--bg-secondary)',cursor:'pointer'}}
                 onClick={() => setExpanded(p => ({...p,[r.id]:!p[r.id]}))}>
              {isImg && thumb
                ? <img src={thumb} alt="" onClick={e => { e.stopPropagation(); setViewing(r) }}
                    style={{width:28,height:28,objectFit:'cover',borderRadius:4,border:'0.5px solid var(--border)',cursor:'zoom-in',flexShrink:0}}/>
                : <i className={isImg ? 'ti ti-photo' : 'ti ti-file-type-pdf'} style={{fontSize:16,color:isImg?'var(--text-secondary)':'var(--coral)',flexShrink:0}} aria-hidden="true"/>}
              <span style={{fontSize:12,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.original_name}</span>
              <i className={ms.icon} style={{color:ms.color,fontSize:13}} aria-hidden="true"/>
              <span style={{fontSize:11,color:ms.color,fontWeight:600,whiteSpace:'nowrap'}}>{ms.label}</span>
              <i className={open?'ti ti-chevron-up':'ti ti-chevron-down'} style={{fontSize:11,color:'var(--text-muted)'}} aria-hidden="true"/>
            </div>

            {/* Expanded detail */}
            {open && (
              <div style={{padding:'8px 10px',fontSize:12}}>
                {/* Preview — click to open full size */}
                {isImg && thumb && (
                  <img src={thumb} alt={r.original_name || 'Receipt'} onClick={() => setViewing(r)}
                    style={{maxWidth:'100%',maxHeight:160,borderRadius:6,border:'0.5px solid var(--border)',cursor:'zoom-in',display:'block',marginBottom:8}}/>
                )}

                {/* OCR fields */}
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:8}}>
                  {[
                    ['Merchant', ocr.merchant || '—'],
                    ['Total',    ocr.total != null ? `$${Number(ocr.total).toFixed(2)}` : '—'],
                    ['Date',     ocr.date || '—'],
                  ].map(([lbl,val]) => (
                    <div key={lbl} style={{background:'var(--bg-secondary)',borderRadius:4,padding:'4px 8px'}}>
                      <div style={{fontSize:10,color:'var(--text-muted)',fontWeight:600}}>{lbl}</div>
                      <div style={{fontWeight:500}}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Flags */}
                {r.match_flags?.length > 0 && (
                  <div style={{marginBottom:8}}>
                    {r.match_flags.map((f,i) => (
                      <div key={i} style={{fontSize:11,color:'var(--coral)',display:'flex',alignItems:'flex-start',gap:4,marginBottom:3}}>
                        <i className="ti ti-alert-triangle" style={{marginTop:1,flexShrink:0}} aria-hidden="true"/>
                        {f}
                      </div>
                    ))}
                  </div>
                )}

                {/* Line items (if any) */}
                {ocr.items?.length > 0 && (
                  <div style={{marginBottom:8}}>
                    <div style={{fontSize:10,color:'var(--text-muted)',fontWeight:600,marginBottom:4}}>LINE ITEMS</div>
                    {ocr.items.map((it,i) => (
                      <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0',borderBottom:'0.5px solid var(--border)'}}>
                        <span style={{color:'var(--text-secondary)'}}>{it.desc}</span>
                        <span>${Number(it.amount).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{display:'flex',gap:14}}>
                  <button onClick={() => setViewing(r)}
                    style={{fontSize:11,color:'var(--blue)',background:'none',border:'none',cursor:'pointer',padding:0}}>
                    <i className="ti ti-eye" style={{marginRight:3}} aria-hidden="true"/>View
                  </button>
                  <button onClick={() => del(r.id)}
                    style={{fontSize:11,color:'var(--coral)',background:'none',border:'none',cursor:'pointer',padding:0}}>
                    <i className="ti ti-trash" style={{marginRight:3}} aria-hidden="true"/>Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {viewing && <ReceiptViewModal receipt={viewing} onClose={() => setViewing(null)}/>}
    </div>
  )
}

// ── Hierarchical category picker (searchable tree + inline "add sub-category") ──
// Renders the Chart-of-Accounts tree (parentId nesting). Selecting any node sets
// its coaId; the ＋ on any row adds a child at any depth (e.g. Chipotle → Fast Food).
const PICKER_TYPE_COLOR = { income:'var(--green)', expense:'var(--amber)', asset:'var(--blue)', liability:'var(--coral)', equity:'var(--teal)' }

function CategoryPicker({ coa, value, onChange, onCreate }) {
  const [open, setOpen]         = useState(false)
  const [search, setSearch]     = useState('')
  const [expanded, setExpanded] = useState({})
  const [addingTo, setAddingTo] = useState(null)
  const [newName, setNewName]   = useState('')
  const [busy, setBusy]         = useState(false)
  const ref = useRef(null)

  const byId = useMemo(() => new Map(coa.map(a => [a.id, a])), [coa])
  const childrenOf = useMemo(() => {
    const m = {}
    for (const a of coa) { const p = a.parentId || '__root'; (m[p] = m[p] || []).push(a) }
    return m
  }, [coa])

  const pathOf = (id) => {
    const parts = []; let cur = byId.get(id)
    while (cur) { parts.unshift(cur.name); cur = cur.parentId ? byId.get(cur.parentId) : null }
    return parts
  }
  const selectedPath = value ? pathOf(value) : null

  useEffect(() => {
    if (!open) return
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const q = search.trim().toLowerCase()
  // During search, show matching nodes + their ancestors, fully expanded.
  const visibleIds = useMemo(() => {
    if (!q) return null
    const vis = new Set()
    for (const a of coa) if (a.name.toLowerCase().includes(q)) {
      let cur = a
      while (cur) { vis.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : null }
    }
    return vis
  }, [q, coa, byId])

  const add = async (parentId) => {
    if (!newName.trim() || busy) return
    setBusy(true)
    try {
      const node = await onCreate(newName.trim(), parentId)
      setNewName(''); setAddingTo(null)
      if (node?.id) { onChange(node.id); setOpen(false) }
    } catch (e) { alert('Could not add category: ' + (e.response?.data?.error || e.message)) }
    setBusy(false)
  }

  const renderNode = (a, depth) => {
    if (a.active === false) return null
    if (visibleIds && !visibleIds.has(a.id)) return null
    const kids = childrenOf[a.id] || []
    const hasKids = kids.length > 0
    const exp = q ? true : !!expanded[a.id]
    const sel = value === a.id
    // Click a branch → drill in (open its sub-categories); click a leaf → pick it.
    // The whole row is the target, so a category with sub-categories never gets
    // selected by accident — you choose a specific leaf instead.
    const rowClick = () => {
      if (hasKids) setExpanded(p => ({ ...p, [a.id]: !p[a.id] }))
      else { onChange(a.id); setOpen(false) }
    }
    return (
      <div key={a.id}>
        <div onClick={rowClick}
          style={{ display:'flex', alignItems:'center', gap:4, paddingLeft:6 + depth*15, borderRadius:6, cursor:'pointer',
            background: sel ? 'rgba(99,153,34,0.12)' : 'transparent' }}
          onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent' }}>
          <span style={{ width:18, height:24, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            {hasKids
              ? <i className={`ti ${exp ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize:12, color:'var(--text-muted)' }} aria-hidden="true"/>
              : <i className={`ti ${sel ? 'ti-circle-check-filled' : 'ti-point'}`} style={{ fontSize: sel ? 13 : 9, color: sel ? 'var(--green)' : 'var(--text-muted)' }} aria-hidden="true"/>}
          </span>
          <span style={{ flex:1, fontSize:13, padding:'5px 2px', fontWeight: a.parentId ? 400 : 600, color: sel ? 'var(--green)' : 'var(--text-primary)' }}>
            {a.name}
            {hasKids && <span style={{ fontSize:10, marginLeft:6, color:'var(--text-muted)' }}>{kids.length}</span>}
          </span>
          {!a.parentId && <span style={{ fontSize:9, textTransform:'uppercase', letterSpacing:'0.3px', color: PICKER_TYPE_COLOR[a.type] || 'var(--text-muted)', marginRight:2 }}>{a.scope}</span>}
          <button type="button" title={`Add a sub-category under "${a.name}"`}
            onClick={e => { e.stopPropagation(); setAddingTo(a.id); setExpanded(p => ({ ...p, [a.id]: true })); setNewName('') }}
            style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:24, height:21, background:'var(--green-light)', border:'0.5px solid var(--green)', borderRadius:6, padding:0, cursor:'pointer', color:'var(--green)', flexShrink:0, marginRight:2 }}>
            <i className="ti ti-plus" style={{ fontSize:13 }} aria-hidden="true"/>
          </button>
        </div>
        {addingTo === a.id && (
          <div onClick={e => e.stopPropagation()} style={{ display:'flex', gap:6, padding:'4px 6px', paddingLeft:6 + (depth+1)*15 + 18 }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder={`New under "${a.name}"…`}
              onKeyDown={e => { if (e.key === 'Enter') add(a.id); if (e.key === 'Escape') { setAddingTo(null); setNewName('') } }}
              style={{ flex:1, fontSize:12, padding:'5px 8px' }}/>
            <button type="button" disabled={busy || !newName.trim()} onClick={() => add(a.id)}
              style={{ fontSize:12, padding:'4px 10px', background:'var(--green)', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', opacity: busy || !newName.trim() ? 0.5 : 1 }}>
              {busy ? '…' : 'Add'}
            </button>
          </div>
        )}
        {exp && hasKids && kids.map(k => renderNode(k, depth + 1))}
      </div>
    )
  }

  const roots = childrenOf['__root'] || []

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button type="button" onClick={() => setOpen(o => !o)}
        style={{ width:'100%', display:'flex', alignItems:'center', gap:8, textAlign:'left', padding:'8px 10px', fontSize:13, background:'var(--bg-secondary)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', color:'var(--text-primary)', cursor:'pointer' }}>
        <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {selectedPath
            ? selectedPath.map((p, i) => <span key={i} style={{ color: i === selectedPath.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{i > 0 ? ' › ' : ''}{p}</span>)
            : <span style={{ color:'var(--text-muted)' }}>Uncategorized — choose a category</span>}
        </span>
        <i className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize:13, color:'var(--text-muted)', flexShrink:0 }} aria-hidden="true"/>
      </button>
      {open && (
        <div style={{ position:'absolute', zIndex:30, top:'calc(100% + 4px)', left:0, right:0, background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:8, boxShadow:'0 12px 32px rgba(0,0,0,0.45)', maxHeight:360, display:'flex', flexDirection:'column' }}>
          <div style={{ padding:8, borderBottom:'0.5px solid var(--border)' }}>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Search categories…" style={{ width:'100%', fontSize:13, padding:'7px 10px' }}/>
          </div>
          <div style={{ overflowY:'auto', padding:6 }}>
            <div onClick={() => { onChange(''); setOpen(false) }}
              style={{ padding:'6px 8px', fontSize:13, color:'var(--text-muted)', cursor:'pointer', borderRadius:6 }}>
              Uncategorized
            </div>
            {roots.map(r => renderNode(r, 0))}
            {roots.length === 0 && <p style={{ fontSize:12, color:'var(--text-muted)', padding:'8px' }}>No categories yet.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Statement match panel (inside the transaction detail popup) ───────────────
// Shows whether this Plaid transaction was verified against an uploaded bank
// statement. When it wasn't, a dropdown lists the unmatched statement rows on the
// same date (plus near dates — statements can post a couple days late) so the user
// can pair it. Matching ONCE auto-teaches the merchant name pairing on the server
// (Plaid "Walmart" ↔ statement "WM SUPERCENTER"), so every future pair with these
// names matches automatically — amount and date are still verified by the engine.
const aliasNorm = s => String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

function StatementMatchPanel({ tx, onChanged }) {
  const [rec, setRec]         = useState(null)    // GET /reconcile/txn/:id payload
  const [aliases, setAliases] = useState([])      // learned alias rules (to explain/undo rule matches)
  const [loadErr, setLoadErr] = useState(false)
  const [err, setErr]         = useState('')
  const [busy, setBusy]       = useState('')
  const [selCand, setSelCand] = useState('')      // selected candidate stmt_source_id

  const load = useCallback(() => {
    axios.get(`${API}/reconcile/txn/${tx.id}`).then(r => { setRec(r.data); setLoadErr(false) }).catch(() => setLoadErr(true))
    axios.get(`${API}/reconcile/aliases`).then(r => setAliases(Array.isArray(r.data) ? r.data : [])).catch(() => {})
  }, [tx.id])
  useEffect(() => { load(); setSelCand('') }, [load])

  // Dropdown candidates: same-day statement rows first (most likely the same
  // purchase), then near-date ones — statements often post a day or two late.
  const { sameDay, nearby } = useMemo(() => {
    const list    = rec?.candidates || []
    const amt     = Math.abs(Number(tx.amount) || 0)
    const dist    = d => Math.abs((new Date(d) - new Date(tx.date)) / 86400000) || 0
    const amtDiff = c => Math.abs(Math.abs(Number(c.amount) || 0) - amt)
    return {
      sameDay: list.filter(c => c.date === tx.date).sort((a, b) => amtDiff(a) - amtDiff(b)),
      nearby:  list.filter(c => c.date !== tx.date && dist(c.date) <= 4)
        .sort((a, b) => (dist(a.date) - dist(b.date)) || (amtDiff(a) - amtDiff(b))),
    }
  }, [rec, tx])

  const selRow = [...sameDay, ...nearby].find(c => c.stmt_source_id === selCand) || null

  // Learned rules that explain the current match — shown so a bad one can be
  // removed right here. Same normalized word-boundary test the server uses.
  const hitRules = useMemo(() => {
    if (!rec?.matchedStmt) return []
    const pd = ' ' + aliasNorm(tx.desc) + ' ', sd = ' ' + aliasNorm(rec.matchedStmt.desc) + ' '
    return aliases.filter(a => {
      if (!a || a.enabled === false) return false
      const ap = aliasNorm(a.plaid), as = aliasNorm(a.statement)
      return ap && as && pd.includes(' ' + ap + ' ') && sd.includes(' ' + as + ' ')
    })
  }, [aliases, rec, tx])

  const run = async (label, fn) => {
    setBusy(label); setErr('')
    try { await fn(); load(); onChanged?.() }
    catch (e) { setErr(e.response?.data?.error || e.message) }
    setBusy('')
  }
  const doMatch = () => run('match', async () => {
    await axios.post(`${API}/reconcile/match`, { stmtSourceId: selCand, plaidTxnId: tx.id })
    setSelCand('')
  })
  const unmatch = ()   => run('unmatch', () => axios.delete(`${API}/reconcile/manual/${rec.manualLinkId}`))
  const delRule = (id) => run('rule:' + id, () => axios.delete(`${API}/reconcile/aliases/${id}`))

  const matched = rec && (rec.status === 'matched' || rec.status === 'conflict')
  const amtWarn = selRow && Math.abs(Math.abs(Number(selRow.amount) || 0) - Math.abs(Number(tx.amount) || 0)) > 0.01
  const chip = (color, bg, label) => (
    <span style={{marginLeft:'auto',fontSize:10,fontWeight:600,padding:'2px 8px',borderRadius:99,background:bg,color,textTransform:'uppercase',letterSpacing:'0.3px'}}>{label}</span>
  )
  const optLabel = (c, withDate) => {
    const desc  = c.desc || '—'
    const short = desc.length > 46 ? desc.slice(0, 46) + '…' : desc
    return `${short} — ${fmtFull(Math.abs(Number(c.amount) || 0))}${withDate ? ` · ${c.date}` : ''}`
  }

  return (
    <div style={{marginBottom:16,padding:'10px 12px',background:'var(--bg-secondary)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-sm)'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        <span style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)',textTransform:'uppercase',letterSpacing:'0.5px'}}>
          <i className="ti ti-file-check" style={{marginRight:5}} aria-hidden="true"/>Statement match
        </span>
        {loadErr ? chip('var(--text-muted)','var(--bg-card)','Unavailable')
         : !rec  ? chip('var(--text-muted)','var(--bg-card)','Checking…')
         : rec.status === 'matched'  ? chip('var(--teal)','var(--teal-light)','Matched')
         : rec.status === 'conflict' ? chip('var(--coral)','var(--coral-light)','Conflict')
         : chip('var(--amber)','var(--amber-light)','Unmatched')}
      </div>

      {err && <p style={{fontSize:11.5,color:'var(--coral)',margin:'0 0 8px',display:'flex',alignItems:'center',gap:5}}><i className="ti ti-alert-triangle" aria-hidden="true"/>{err}</p>}

      {/* ── Matched / conflict: show what it verified against ── */}
      {matched && (
        <div>
          {rec.matchedStmt ? (
            <p style={{fontSize:12,margin:0,color:'var(--text-secondary)',lineHeight:1.6}}>
              On statement as <b style={{color:'var(--text-primary)'}}>{rec.matchedStmt.desc}</b>
              {' '}· {rec.matchedStmt.date} · {fmtFull(Math.abs(Number(rec.matchedStmt.amount) || 0))}
              {rec.matchedStmt.sourceFile && <span style={{color:'var(--text-muted)'}}> · {rec.matchedStmt.sourceFile}</span>}
            </p>
          ) : (
            <p style={{fontSize:12,margin:0,color:'var(--text-secondary)'}}>Verified against a bank statement.</p>
          )}
          {rec.status === 'conflict' && rec.flagReason && (
            <p style={{fontSize:11,color:'var(--coral)',margin:'6px 0 0'}}>{rec.flagReason}</p>
          )}
          {(hitRules.length > 0 || rec.manualLinkId) && (
            <div style={{display:'flex',alignItems:'center',gap:6,marginTop:8,flexWrap:'wrap'}}>
              {hitRules.map(r => (
                <span key={r.id} style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:11,padding:'2px 8px',borderRadius:99,background:'var(--bg-card)',border:'0.5px solid var(--border)',color:'var(--text-secondary)'}}>
                  <i className="ti ti-arrows-left-right" style={{fontSize:11,color:'var(--teal)'}} aria-hidden="true"/>
                  {r.plaid} ↔ {r.statement}
                  <button onClick={()=>delRule(r.id)} disabled={busy === 'rule:'+r.id} title="Delete this match rule (re-runs matching)"
                    style={{background:'none',border:'none',padding:0,cursor:'pointer',color:'var(--text-muted)',display:'inline-flex'}}>
                    <i className={`ti ${busy === 'rule:'+r.id ? 'ti-loader-2 spin' : 'ti-x'}`} style={{fontSize:11}} aria-hidden="true"/>
                  </button>
                </span>
              ))}
              {rec.manualLinkId && (
                <button onClick={unmatch} disabled={!!busy} title="Undo this manual match"
                  style={{fontSize:11,padding:'3px 9px',borderRadius:99,background:'none',border:'0.5px solid var(--border)',color:'var(--text-secondary)',cursor:'pointer',display:'inline-flex',alignItems:'center',gap:4}}>
                  <i className={`ti ${busy === 'unmatch' ? 'ti-loader-2 spin' : 'ti-unlink'}`} aria-hidden="true"/> Unmatch
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Unmatched: pick the statement transaction it actually is ── */}
      {rec && !matched && (
        <div>
          {(sameDay.length + nearby.length) === 0 ? (
            <p style={{fontSize:12,color:'var(--text-muted)',margin:0,lineHeight:1.6}}>
              {rec.stmtRowCount === 0
                ? <>This account has no bank statement data indexed yet — upload statements in Data Vault, then index them, and they'll appear here for matching.</>
                : <>Not found on any uploaded statement, and there are no unmatched statement transactions on or near {tx.date} to pair it with.</>}
            </p>
          ) : (
            <>
              <p style={{fontSize:12,color:'var(--text-secondary)',margin:'0 0 6px'}}>
                Not found on your statements. Pick the statement transaction this actually is:
              </p>
              <div style={{display:'flex',gap:8}}>
                <select value={selCand} onChange={e=>setSelCand(e.target.value)}
                  style={{flex:1,minWidth:0,fontSize:12,padding:'7px 8px',borderRadius:6,border:'0.5px solid var(--border)',background:'var(--bg-card)',color:'var(--text-primary)'}}>
                  <option value="">Choose a statement transaction…</option>
                  {sameDay.length > 0 && (
                    <optgroup label={`Same day — ${tx.date}`}>
                      {sameDay.map(c => <option key={c.stmt_source_id} value={c.stmt_source_id}>{optLabel(c, false)}</option>)}
                    </optgroup>
                  )}
                  {nearby.length > 0 && (
                    <optgroup label="Nearby dates — statements can post a few days late">
                      {nearby.map(c => <option key={c.stmt_source_id} value={c.stmt_source_id}>{optLabel(c, true)}</option>)}
                    </optgroup>
                  )}
                </select>
                <button onClick={doMatch} disabled={!selRow || !!busy}
                  style={{fontSize:12.5,fontWeight:600,padding:'0 16px',background:'var(--green)',color:'#fff',border:'none',borderRadius:6,cursor:selRow&&!busy?'pointer':'default',opacity:selRow&&!busy?1:0.5,display:'inline-flex',alignItems:'center',gap:6,flexShrink:0}}>
                  <i className={`ti ${busy === 'match' ? 'ti-loader-2 spin' : 'ti-link'}`} aria-hidden="true"/>
                  {busy === 'match' ? 'Matching…' : 'Match'}
                </button>
              </div>
              {amtWarn && (
                <p style={{fontSize:11,color:'var(--amber)',margin:'6px 0 0',display:'flex',alignItems:'flex-start',gap:5}}>
                  <i className="ti ti-alert-triangle" style={{marginTop:1,flexShrink:0}} aria-hidden="true"/>
                  Amounts differ ({fmtFull(Math.abs(Number(tx.amount)))} vs {fmtFull(Math.abs(Number(selRow.amount)))}) — double-check this is the same transaction.
                </p>
              )}
              <p style={{fontSize:10.5,color:'var(--text-muted)',margin:'7px 0 0',lineHeight:1.5}}>
                <i className="ti ti-bulb" style={{marginRight:4}} aria-hidden="true"/>
                Matching once teaches CaiShen the merchant pairing — future transactions with these names will match automatically (amount and date still checked).
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Transaction detail + QuickBooks-style categorization modal ────────────────
function TxDetailModal({ tx, bankAccounts, coa, coaById, onUpdate, reload, onClose, onCreateCategory, onReceiptsChanged, onReconciled }) {
  const [coaId,  setCoaId]  = useState(tx.coaId || '')
  const [note,   setNote]   = useState(tx.note  || '')
  const [saving, setSaving] = useState(false)
  const [remember, setRemember] = useState(false)
  const [keyword,  setKeyword]  = useState('')

  // Pre-fill a "remember this" keyword from the description (server heuristic).
  useEffect(() => {
    let alive = true
    axios.get(`${API}/categorization-rules/suggest`, { params: { desc: tx.desc || '' } })
      .then(r => alive && setKeyword(r.data.keyword || ''))
      .catch(() => {})
    return () => { alive = false }
  }, [tx.id])

  const acct   = bankAccounts.find(a => a.id === tx.account)   // resolved regardless of table's showAccount
  const glAcct = coaById.get(coaId)                             // currently-selected COA entry
  const debit  = tx.amount < 0

  const save = async () => {
    setSaving(true)
    try {
      // coaAuto:false marks this as a manual pick, so "Auto-categorize all" never overwrites it.
      await axios.patch(`${API}/transactions/${tx.id}`, { coaId: coaId || null, note, approved: !!coaId, coaAuto: false })
      // Functional update so a concurrent SSE refetch doesn't get mapped over a stale snapshot.
      onUpdate(prev => prev.map(t => t.id === tx.id ? { ...t, coaId: coaId || null, note, approved: !!coaId, coaAuto: false } : t))
      // "Remember this": save a rule and back-fill matching uncategorized txns.
      if (remember && coaId && keyword.trim()) {
        const { data } = await axios.post(`${API}/categorization-rules`, { value: keyword.trim(), coaId, applyNow: true })
        if (data.applied && reload) await reload()
      }
      onClose()
    } catch (e) {
      console.error('Save categorization failed:', e.message)
      setSaving(false)
    }
  }

  const row = (label, value) => (
    <div key={label} style={{display:'flex',justifyContent:'space-between',gap:14,padding:'7px 0',borderBottom:'0.5px solid var(--border)',fontSize:13}}>
      <span style={{color:'var(--text-secondary)',flexShrink:0}}>{label}</span>
      <span style={{textAlign:'right',color:'var(--text-primary)',minWidth:0,wordBreak:'break-word'}}>{value}</span>
    </div>
  )

  const tc = TYPE_COLORS[glAcct?.type] || 'var(--text-muted)'
  const sourceLabel = tx.source === 'plaid' ? 'Live (Plaid)' : tx.source === 'csv_import' ? 'CSV Import' : 'Manual'

  return (
    <Modal title="Transaction Detail" onClose={onClose}>
      {/* Amount headline */}
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:16}}>
        <p style={{fontSize:24,fontWeight:600,margin:0,color:debit?'var(--coral)':'var(--teal)',fontVariantNumeric:'tabular-nums'}}>
          {debit?'-':'+'}{fmtFull(Math.abs(tx.amount))}
        </p>
        <span style={{fontSize:10,padding:'2px 9px',borderRadius:99,textTransform:'uppercase',letterSpacing:'0.3px',
          background: tx.pending?'var(--amber-light)':'var(--bg-secondary)',
          color: tx.pending?'var(--amber)':'var(--text-muted)'}}>
          {tx.pending?'Pending':'Posted'}
        </span>
      </div>

      {/* Read-only details */}
      <div style={{marginBottom:18}}>
        {row('Description', tx.desc || '—')}
        {row('Date', tx.date)}
        {row('Account', acct ? `${acct.name}${acct.last4?` ••••${acct.last4}`:''}` : (tx.account || '—'))}
        {tx.institution && row('Institution', tx.institution)}
        {row('Source', sourceLabel)}
        {tx.plaidCategory && row('Bank category', tx.plaidCategory)}
        {row('Spending bucket', tx.category || '—')}
        {(tx.reconciled || tx.isSplit) && row('Flags', (
          <>
            {tx.reconciled && <span style={{fontSize:10,padding:'1px 6px',borderRadius:4,background:'var(--teal-light)',color:'var(--teal)'}}>Reconciled</span>}
            {tx.isSplit && <span style={{marginLeft:4,fontSize:10,padding:'1px 6px',borderRadius:4,background:'var(--purple-light)',color:'var(--purple)'}}>Split</span>}
          </>
        ))}
        {row('ID', <span style={{fontSize:11,color:'var(--text-muted)',fontFamily:'monospace'}}>{tx.id}</span>)}
      </div>

      {/* ── Statement match — verify against uploaded statements; manual pair + alias rules ── */}
      {(!tx.source || tx.source === 'plaid') && <StatementMatchPanel tx={tx} onChanged={onReconciled}/>}

      {/* Categorization — assign to a Chart-of-Accounts category (hierarchical) */}
      <Field label="Category">
        <CategoryPicker coa={coa} value={coaId} onChange={setCoaId} onCreate={onCreateCategory}/>
      </Field>

      {/* Live Account Type badge — the QuickBooks "Account Type" of the chosen category */}
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14,minHeight:24}}>
        <span style={{fontSize:12,color:'var(--text-secondary)'}}>Account Type:</span>
        {glAcct ? (
          <span style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,fontWeight:500,padding:'2px 10px',borderRadius:99,background:tc+'22',color:tc}}>
            <span style={{width:7,height:7,borderRadius:2,background:tc}}/>
            {TYPE_LABELS[glAcct.type]||glAcct.type}{glAcct.subtype?` · ${glAcct.subtype}`:''}
          </span>
        ) : <span style={{fontSize:12,color:'var(--text-muted)'}}>— uncategorized</span>}
      </div>

      <Field label="Memo">
        <textarea value={note} onChange={e=>setNote(e.target.value)} rows={2} placeholder="Add a note…"
          style={{width:'100%',resize:'vertical',fontFamily:'inherit'}}/>
      </Field>

      {/* "Remember this" — turn this categorization into an auto-rule */}
      {coaId && (
        <div style={{marginBottom:14,padding:'10px 12px',background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)'}}>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:12,color:'var(--text-secondary)',cursor:'pointer'}}>
            <input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} style={{width:'auto',cursor:'pointer'}}/>
            Always categorize transactions like this
          </label>
          {remember && (
            <div style={{marginTop:8}}>
              <p style={{fontSize:11,color:'var(--text-muted)',margin:'0 0 4px'}}>…when the description contains:</p>
              <input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="e.g. SHELL OIL" style={{width:'100%'}}/>
            </div>
          )}
        </div>
      )}

      {/* ── Receipts (Phase 4) ── */}
      <ReceiptPanel txId={tx.id} onChanged={onReceiptsChanged}/>

      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
        <button onClick={onClose} style={{cursor:'pointer'}}>Cancel</button>
        <button onClick={save} disabled={saving} style={{background:'var(--green)',color:'#fff',border:'none',cursor:'pointer',opacity:saving?0.6:1}}>
          {saving?'Saving…':'Save'}
        </button>
      </div>
    </Modal>
  )
}

export default function Banking({ accounts, transactions, onUpdate }) {
  const [vaultData, setVaultData]       = useState(null)
  const [coa, setCoa]                   = useState([])             // chart of accounts
  const [detailTx, setDetailTx]         = useState(null)           // transaction open in detail modal
  const [previewStmt, setPreviewStmt]   = useState(null)           // statement PDF open in preview popup
  const [selectedAcct, setSelectedAcct] = useState(null)          // null = all accounts
  const [view, setView]                 = useState('transactions') // 'transactions' | 'statements'
  const [search, setSearch]             = useState('')
  const [filterMonth, setFilterMonth]   = useState('all')
  const [sortDir, setSortDir]           = useState('desc')
  const [statusFilter, setStatusFilter] = useState('all')          // 'all' | 'pending' | 'approved'
  const [autoMsg, setAutoMsg]           = useState('')             // transient auto-categorize feedback
  const [reconcileFlags, setReconcileFlags] = useState({})        // {plaid_txn_id → status} for inline badges
  const [acctSettings, setAcctSettings] = useState({})            // {accountId → {business, propertyId}}
  const [properties, setProperties]     = useState([])            // rentals, for the business property tag
  const [receiptCounts, setReceiptCounts] = useState({})          // {txn_id → receipt count} for the 📎 row indicator

  // Refetched after every attach/remove in the detail modal so row 📎s stay current.
  const reloadReceiptCounts = useCallback(() => {
    axios.get(`${API}/receipts/counts`).then(r => setReceiptCounts(r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {})).catch(() => {})
  }, [])

  useEffect(() => {
    axios.get(`${API}/vault`).then(r => setVaultData(r.data)).catch(() => {})
    axios.get(`${API}/accounting/coa`).then(r => setCoa(r.data || [])).catch(() => {})
    axios.get(`${API}/reconcile/txn-flags`).then(r => setReconcileFlags(r.data || {})).catch(() => {})
    axios.get(`${API}/account-settings`).then(r => setAcctSettings(r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {})).catch(() => {})
    axios.get(`${API}/properties`).then(r => setProperties(Array.isArray(r.data) ? r.data : [])).catch(() => {})
    reloadReceiptCounts()
  }, [reloadReceiptCounts])

  // Lookup a COA entry by id — tolerant of missing (deleted) accounts.
  const coaById = useMemo(() => new Map(coa.map(a => [a.id, a])), [coa])

  // Refetch the full transaction list after server-side rule application.
  const reload = () => axios.get(`${API}/transactions`).then(r => onUpdate(r.data)).catch(() => {})
  const reloadCoa = () => axios.get(`${API}/accounting/coa`).then(r => setCoa(r.data || [])).catch(() => {})
  // After a manual match / alias change in the detail popup, refresh the inline
  // reconcile badges (✓ / ◈ / ⚠) on the transaction rows.
  const reloadFlags = () => axios.get(`${API}/reconcile/txn-flags`).then(r => setReconcileFlags(r.data || {})).catch(() => {})
  // Persist a per-account business flag / property tag (optimistic). Re-run "Auto-categorize
  // all" afterwards to reclassify that account's transactions as business.
  const saveAcctSetting = async (id, patch) => {
    setAcctSettings(s => ({ ...s, [id]: { ...(s[id] || {}), ...patch } }))
    try { await axios.put(`${API}/account-settings/${id}`, patch) } catch {}
  }
  // Create a (possibly deeply nested) category and refresh the chart. Powers the
  // CategoryPicker's inline "add sub-category" — e.g. Chipotle under Food & Dining → Fast Food.
  const createCategory = async (name, parentId) => {
    const { data } = await axios.post(`${API}/accounting/coa`, { name, parentId })
    await reloadCoa()
    return data
  }
  const autoCategorize = async () => {
    setAutoMsg('Categorizing…')
    try {
      const { data } = await axios.post(`${API}/transactions/auto-categorize`)
      if (Array.isArray(data.transactions)) onUpdate(data.transactions)   // render server result directly — avoids the DB re-read race
      else await reload()
      setAutoMsg(data.total ? `Categorized ${data.total} transaction${data.total===1?'':'s'}${data.capital?` · ${data.capital} fixed asset${data.capital===1?'':'s'}`:''} — review the “auto” ones` : 'Everything already categorized')
      setTimeout(() => setAutoMsg(''), 4000)
    } catch { setAutoMsg('') }
  }

  const bankAccounts = accounts.filter(isBankAccount)
  const bankTxs = transactions.filter(tx => bankAccounts.some(a => a.id === tx.account))

  // ── Metrics ───────────────────────────────────────────────────────────
  const totalBalance   = bankAccounts.reduce((s,a) => s+(a.balance||0), 0)
  const totalAvailable = bankAccounts.reduce((s,a) => s+(a.availableBalance??a.balance??0), 0)

  const now       = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`
  const prevMonth = (() => { const d = new Date(now.getFullYear(), now.getMonth()-1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` })()

  const thisMonthTxs = bankTxs.filter(t => t.month === thisMonth)
  const prevMonthTxs = bankTxs.filter(t => t.month === prevMonth)

  const monthIncome   = thisMonthTxs.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0)
  const monthExpenses = thisMonthTxs.filter(t=>t.amount<0).reduce((s,t)=>s+t.amount,0)
  const monthNet      = monthIncome + monthExpenses

  const prevNet  = prevMonthTxs.reduce((s,t)=>s+t.amount,0)
  const netDelta = monthNet - prevNet

  // ── Vault statements ───────────────────────────────────────────────────
  const stmtFiles = vaultData
    ? vaultData.files.filter(f => (f.folderPath||'').startsWith('Bank Statements') && f.type==='pdf')
    : []

  // Structure: Bank Statements/{Institution}/{Account}/{Year}  (new)
  //            Bank Statements/{Institution}/{Year}            (old — parts[2] is a 4-digit year)
  const stmtByInst = {}
  for (const f of stmtFiles) {
    const parts   = (f.folderPath||'').split('/')
    const inst    = parts[1] || 'Unknown'
    const isOld   = /^\d{4}$/.test(parts[2])
    const acctKey = isOld ? 'All Accounts' : (parts[2] || 'Unknown')
    const year    = isOld ? (parts[2] || '?') : (parts[3] || '?')
    if (!stmtByInst[inst]) stmtByInst[inst] = {}
    if (!stmtByInst[inst][acctKey]) stmtByInst[inst][acctKey] = {}
    if (!stmtByInst[inst][acctKey][year]) stmtByInst[inst][acctKey][year] = []
    stmtByInst[inst][acctKey][year].push(f)
  }

  // ── Selected account → scope (statements matched by last4 in path/name) ──
  const selectedAcctObj = bankAccounts.find(a => a.id === selectedAcct) || null
  const scopedStmts = selectedAcctObj
    ? stmtFiles.filter(f => {
        const hay = `${f.folderPath||''} ${f.name||''}`.toLowerCase()
        if (selectedAcctObj.last4) return hay.includes(String(selectedAcctObj.last4).toLowerCase())
        return !!selectedAcctObj.institution && hay.includes(selectedAcctObj.institution.toLowerCase())
      })
    : stmtFiles
  const scopedByYear = {}
  for (const f of scopedStmts) {
    const yr = ((f.folderPath||'').split('/').find(p => /^\d{4}$/.test(p))) || '?'
    ;(scopedByYear[yr] = scopedByYear[yr] || []).push(f)
  }

  // ── Transaction filtering (clicking an account is the filter) ──────────
  const months = [...new Set(bankTxs.map(t=>t.month))].sort().reverse()

  // account + month + search (everything except the status tab) → scopedTxs
  let scopedTxs = [...bankTxs]
  if (selectedAcct)          scopedTxs = scopedTxs.filter(t => t.account === selectedAcct)
  if (filterMonth !== 'all') scopedTxs = scopedTxs.filter(t => t.month === filterMonth)
  if (search.trim())         scopedTxs = scopedTxs.filter(t =>
    (t.desc||'').toLowerCase().includes(search.toLowerCase()) ||
    (t.category||'').toLowerCase().includes(search.toLowerCase())
  )
  const statusCounts = {
    all:     scopedTxs.length,
    pending:  scopedTxs.filter(t => !t.approved).length,
    approved: scopedTxs.filter(t =>  t.approved).length,
  }

  // status tab + sort → filteredTxs
  let filteredTxs = statusFilter === 'pending'  ? scopedTxs.filter(t => !t.approved)
                  : statusFilter === 'approved' ? scopedTxs.filter(t =>  t.approved)
                  : [...scopedTxs]
  filteredTxs.sort((a,b) => sortDir==='desc'
    ? b.date.localeCompare(a.date)
    : a.date.localeCompare(b.date))

  const filtIncome   = filteredTxs.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0)
  const filtExpenses = Math.abs(filteredTxs.filter(t=>t.amount<0).reduce((s,t)=>s+t.amount,0))
  const filtNet      = filteredTxs.reduce((s,t)=>s+t.amount,0)

  const scopeTxCount   = (selectedAcct ? bankTxs.filter(t=>t.account===selectedAcct) : bankTxs).length
  const scopeStmtCount = scopedStmts.length

  const inputStyle = {padding:'7px 10px',fontSize:12,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-primary)'}
  const noData = bankAccounts.length === 0

  return (
    <div>
      {noData ? (
        <div className="card" style={{textAlign:'center',padding:'3rem'}}>
          <i className="ti ti-building-bank" style={{fontSize:40,color:'var(--text-muted)'}} aria-hidden="true"/>
          <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>No banking accounts found</p>
          <p style={{fontSize:13,color:'var(--text-secondary)',maxWidth:360,margin:'0 auto'}}>
            Connect a bank via Plaid in Connections, or import a CSV in Data Vault. Depository accounts (checking, savings, money market, CDs) will appear here.
          </p>
        </div>
      ) : (
        <div>
          {/* ── Metric row ─────────────────────────────────────────── */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:20}}>
            <MetricCard label="Balance" value={fd(totalAvailable)}
              sub={`Across ${bankAccounts.length} account${bankAccounts.length!==1?'s':''}`}
              icon="ti-cash" iconColor="var(--green)"/>
            <MetricCard label="Posted Balance" value={fd(totalBalance)} sub="Officially settled"
              icon="ti-credit-card" iconColor="var(--teal)"/>
            <MetricCard label="This Month Net" value={(monthNet>=0?'+':'')+fd(monthNet)}
              subColor={monthNet>=0?'var(--teal)':'var(--coral)'}
              sub={`+${fd(monthIncome)} in / -${fd(Math.abs(monthExpenses))} out`}
              icon="ti-arrows-exchange" iconColor={monthNet>=0?'var(--teal)':'var(--coral)'}/>
            <MetricCard label="vs Last Month" value={(netDelta>=0?'+':'')+fd(netDelta)}
              subColor={netDelta>=0?'var(--teal)':'var(--coral)'}
              sub={prevNet!==0?`Last month: ${fd(prevNet)}`:'No prior month data'}
              icon="ti-trending-up" iconColor={netDelta>=0?'var(--teal)':'var(--coral)'}/>
          </div>

          {/* ── Accounts (click to filter) ─────────────────────────── */}
          <div style={{marginBottom:22}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
              <p style={{fontSize:11,fontWeight:500,color:'var(--text-secondary)',margin:0,textTransform:'uppercase',letterSpacing:'0.5px'}}>Accounts</p>
              {selectedAcct && (
                <button onClick={()=>setSelectedAcct(null)}
                  style={{fontSize:11,background:'none',border:'none',color:'var(--text-secondary)',cursor:'pointer',display:'flex',alignItems:'center',gap:4,padding:0}}>
                  <i className="ti ti-x" aria-hidden="true"/> Show all accounts
                </button>
              )}
            </div>
            <AccountStrip bankAccounts={bankAccounts} selectedAcct={selectedAcct} setSelectedAcct={setSelectedAcct} settings={acctSettings} properties={properties} onSaveSetting={saveAcctSetting}/>
          </div>

          {/* ── Transactions | Statements toggle ───────────────────── */}
          <div style={{display:'flex',alignItems:'center',borderBottom:'0.5px solid var(--border)',marginBottom:14}}>
            {[['transactions',`Transactions (${scopeTxCount})`],['statements',`Statements (${scopeStmtCount})`],...(IS_LOCALHOST?[['verify','🔧 Verify']]:[])].map(([id,label]) => (
              <button key={id} onClick={()=>setView(id)} style={{
                background:'none',border:'none',
                borderBottom:view===id?'2px solid var(--green)':'2px solid transparent',
                padding:'8px 16px',fontSize:13,fontWeight:view===id?500:400,
                color:view===id?'var(--text-primary)':'var(--text-secondary)',
                cursor:'pointer',marginBottom:-1,
              }}>{label}</button>
            ))}
            <span style={{marginLeft:'auto',fontSize:11,color:'var(--text-muted)'}}>
              {selectedAcctObj
                ? <>Showing <b style={{color:'var(--text-secondary)',fontWeight:500}}>{selectedAcctObj.name}</b></>
                : 'All accounts'}
            </span>
          </div>

          {/* ── Transactions view ──────────────────────────────────── */}
          {view==='transactions' && (
            <div>
              {/* Filters: search + month */}
              <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search description or category…"
                  style={{...inputStyle,flex:1,minWidth:180}}/>
                <select value={filterMonth} onChange={e=>setFilterMonth(e.target.value)} style={inputStyle}>
                  <option value="all">All months</option>
                  {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              {/* Status tabs (All / Pending / Approved — CaiShen confirmation state) */}
              <div style={{display:'flex',gap:6,marginBottom:14,alignItems:'center'}}>
                {[['all','All'],['pending','Pending'],['approved','Approved']].map(([id,label]) => (
                  <button key={id} onClick={()=>setStatusFilter(id)} style={{
                    fontSize:12, padding:'5px 13px', borderRadius:99, cursor:'pointer',
                    border:`0.5px solid ${statusFilter===id?'var(--green)':'var(--border)'}`,
                    background: statusFilter===id?'rgba(99,153,34,0.10)':'var(--bg-secondary)',
                    color: statusFilter===id?'var(--green)':'var(--text-secondary)',
                  }}>{label} ({statusCounts[id]})</button>
                ))}
                <div style={{flex:1}}/>
                {autoMsg && <span style={{fontSize:11,color:'var(--text-muted)'}}>{autoMsg}</span>}
                <button onClick={autoCategorize} title="Auto-categorize every uncategorized transaction — your saved rules first, then a best-effort merchant guess you can review or change" style={{
                  fontSize:12, padding:'5px 13px', borderRadius:99, cursor:'pointer',
                  border:'0.5px solid var(--blue)', background:'var(--blue-light)', color:'var(--blue)',
                }}><i className="ti ti-wand" aria-hidden="true"/> Auto-categorize all</button>
              </div>

              {/* Totals + table */}
              <div>
                {filteredTxs.length > 0 && (
                  <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
                    {[
                      ['Deposits',    fd(filtIncome),   'var(--teal)'],
                      ['Withdrawals', fd(filtExpenses), 'var(--coral)'],
                      ['Net',         (filtNet>=0?'+':'')+fd(filtNet), filtNet>=0?'var(--teal)':'var(--coral)'],
                      ['Count',       String(filteredTxs.length), 'var(--text-primary)'],
                    ].map(([label,val,color]) => (
                      <div key={label} style={{padding:'6px 14px',background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)'}}>
                        <p style={{fontSize:10,color:'var(--text-muted)',margin:'0 0 2px',textTransform:'uppercase'}}>{label}</p>
                        <p style={{fontSize:14,fontWeight:500,margin:0,color}}>{val}</p>
                      </div>
                    ))}
                  </div>
                )}
                <TransactionsTable txs={filteredTxs} bankAccounts={bankAccounts} showAccount={!selectedAcct}
                  sortDir={sortDir} onToggleSort={()=>setSortDir(d=>d==='desc'?'asc':'desc')}
                  onRowClick={setDetailTx} coaById={coaById} reconcileFlags={reconcileFlags}
                  receiptCounts={receiptCounts} reload={reload}/>
              </div>
            </div>
          )}

          {/* ── Statements view ────────────────────────────────────── */}
          {/* ── Verify view (dev only — reconciliation cross-check) ── */}
          {view==='verify' && IS_LOCALHOST && (
            <ReconcileVerify/>
          )}

          {view==='statements' && (
            <div>
              {scopedStmts.length === 0 ? (
                <div className="card" style={{textAlign:'center',padding:'3rem'}}>
                  <i className="ti ti-file-text" style={{fontSize:40,color:'var(--text-muted)'}} aria-hidden="true"/>
                  <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>
                    {selectedAcctObj ? `No statements for ${selectedAcctObj.name}` : 'No statements in vault'}
                  </p>
                  <p style={{fontSize:13,color:'var(--text-secondary)',maxWidth:380,margin:'0 auto',lineHeight:1.6}}>
                    Generate statements in <strong>Connections</strong>, or pull them in via the <strong>Importers</strong> tab. They'll appear here once in the vault.
                  </p>
                </div>
              ) : selectedAcctObj ? (
                Object.entries(scopedByYear).sort(([a],[b])=>Number(b)-Number(a)).map(([year,files]) => (
                  <div key={year} style={{marginBottom:18}}>
                    <p style={{fontSize:11,color:'var(--text-muted)',margin:'0 0 8px',textTransform:'uppercase',letterSpacing:'0.5px',fontWeight:500}}>{year}</p>
                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(230px,1fr))',gap:8}}>
                      {[...files].sort((a,b)=>b.name.localeCompare(a.name)).map(f => <StmtCard key={f.id} f={f} onOpen={setPreviewStmt}/>)}
                    </div>
                  </div>
                ))
              ) : (
                Object.entries(stmtByInst).map(([inst, accts]) => {
                  const totalStmts = Object.values(accts).flatMap(a => Object.values(a).flat()).length
                  return (
                    <div key={inst} style={{marginBottom:28}}>
                      <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:14,paddingBottom:6,borderBottom:'0.5px solid var(--border)'}}>
                        <p style={{fontSize:14,fontWeight:600,margin:0}}>{inst}</p>
                        <span style={{fontSize:11,color:'var(--text-muted)'}}>{totalStmts} statement{totalStmts!==1?'s':''}</span>
                      </div>
                      {Object.entries(accts).map(([acctName, years]) => (
                        <div key={acctName} style={{marginBottom:18,marginLeft:12}}>
                          <p style={{fontSize:12,fontWeight:500,margin:'0 0 10px',color:'var(--text-secondary)'}}>{acctName}</p>
                          {Object.entries(years).sort(([a],[b])=>Number(b)-Number(a)).map(([year,files]) => (
                            <div key={year} style={{marginBottom:14,marginLeft:12}}>
                              <p style={{fontSize:11,color:'var(--text-muted)',margin:'0 0 8px',textTransform:'uppercase',letterSpacing:'0.5px',fontWeight:500}}>{year}</p>
                              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(230px,1fr))',gap:8}}>
                                {[...files].sort((a,b)=>b.name.localeCompare(a.name)).map(f => <StmtCard key={f.id} f={f} onOpen={setPreviewStmt}/>)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>
      )}

      {previewStmt && <StmtPreviewModal f={previewStmt} onClose={()=>setPreviewStmt(null)}/>}

      {detailTx && (
        <TxDetailModal
          tx={detailTx}
          bankAccounts={bankAccounts}
          coa={coa}
          coaById={coaById}
          onUpdate={onUpdate}
          reload={reload}
          onCreateCategory={createCategory}
          onReceiptsChanged={reloadReceiptCounts}
          onReconciled={reloadFlags}
          onClose={()=>setDetailTx(null)}
        />
      )}
    </div>
  )
}
