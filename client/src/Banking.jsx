import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'

const API = '/api'
const fmt = (n, d=0) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(d)+'K'; return String(Math.abs(n).toFixed(d)) }
const fd  = (n, d=0) => (n<0?'-$':'$')+fmt(Math.abs(n),d)
const fmtFull = n => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

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
const CAT_COLOR = {
  Dining:'var(--coral)',Shopping:'var(--amber)',Transport:'var(--blue)',Travel:'var(--blue)',
  Groceries:'var(--green)',Entertainment:'var(--purple)',Fitness:'var(--teal)',
  Health:'var(--teal)',Subscriptions:'var(--purple)',Coffee:'var(--amber)',
  Tech:'var(--blue)',Utilities:'var(--text-secondary)',Income:'var(--green)',
  Transfer:'var(--text-secondary)',Other:'var(--text-muted)',
}

// ── Chart of Accounts types (mirrors Accounting.jsx) ──────────────────────────
// The "Account Type" — the QuickBooks-style top-level classification of a GL
// account. Determines which financial statement it lands on (Balance Sheet vs P&L).
const TYPE_ORDER  = ['asset','liability','equity','income','expense']
const TYPE_LABELS = { asset:'Assets', liability:'Liabilities', equity:'Equity', income:'Income', expense:'Expenses' }
const TYPE_COLORS = { asset:'var(--blue)', liability:'var(--coral)', equity:'var(--teal)', income:'var(--green)', expense:'var(--amber)' }

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

function AccountCard({ acc, selected, onClick }) {
  // availableBalance = what the bank shows / what you can spend; balance = posted.
  const available = acc.availableBalance ?? acc.balance ?? 0
  const posted    = acc.balance ?? 0
  const hasPostedDiff = acc.availableBalance != null && Math.abs(available - posted) >= 0.01
  const subLabel  = acc.subtype
    ? acc.subtype.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase())
    : (acc.type || 'Account').replace(/\b\w/g, c => c.toUpperCase())
  const sourceLabel = acc.source === 'plaid' ? 'Live' : acc.source === 'csv_import' ? 'CSV' : 'Manual'

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

function StmtCard({ f }) {
  return (
    <a href={`/api/vault/file/${f.id}`} target="_blank" rel="noreferrer"
      style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',border:'0.5px solid var(--border)',borderRadius:'var(--radius-sm)',textDecoration:'none',color:'var(--text-primary)',background:'var(--bg-card)',transition:'border-color 0.15s'}}
      onMouseEnter={e=>e.currentTarget.style.borderColor='var(--green)'}
      onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
      <i className="ti ti-file-type-pdf" style={{fontSize:20,color:'var(--coral)',flexShrink:0}} aria-hidden="true"/>
      <div style={{flex:1,minWidth:0}}>
        <p style={{fontSize:12,fontWeight:500,margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{f.name}</p>
        <p style={{fontSize:10,color:'var(--text-muted)',margin:'2px 0 0'}}>{(f.size/1024).toFixed(0)} KB</p>
      </div>
      <i className="ti ti-external-link" style={{fontSize:12,color:'var(--text-muted)',flexShrink:0}} aria-hidden="true"/>
    </a>
  )
}

// ── Transactions table (QuickBooks-style columns) ──────────────────────────────
function TxTable({ txs, bankAccounts, showAccount, sortDir, onToggleSort, onRowClick, coaById }) {
  if (!txs.length) {
    return <p style={{color:'var(--text-muted)',fontSize:13,padding:'2rem',textAlign:'center'}}>No transactions match the current filters.</p>
  }
  const th = (label, opts={}) => (
    <th onClick={opts.onClick} style={{
      textAlign:opts.align||'left', padding:'8px 12px', fontSize:10, fontWeight:600,
      textTransform:'uppercase', letterSpacing:'0.4px', color:'var(--text-muted)',
      borderBottom:'0.5px solid var(--border)', whiteSpace:'nowrap',
      cursor:opts.onClick?'pointer':'default', userSelect:'none',
    }}>
      {label}
      {opts.sortable && <i className={`ti ti-arrow-${sortDir==='desc'?'down':'up'}`} style={{fontSize:11,marginLeft:4,verticalAlign:'middle',color:'var(--text-secondary)'}} aria-hidden="true"/>}
    </th>
  )
  return (
    <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-sm)',overflow:'hidden'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:13}}>
        <thead>
          <tr style={{background:'var(--bg-secondary)'}}>
            {th('Date', {onClick:onToggleSort, sortable:true})}
            {th('Description')}
            {showAccount && th('Account')}
            {th('Category')}
            {th('Spent', {align:'right'})}
            {th('Received', {align:'right'})}
          </tr>
        </thead>
        <tbody>
          {txs.map(tx => {
            const acct = bankAccounts.find(a => a.id === tx.account)
            const catColor = CAT_COLOR[tx.category] || 'var(--text-muted)'
            const glAcct = coaById?.get(tx.coaId)            // assigned chart-of-accounts entry, if any
            const debit = tx.amount < 0
            return (
              <tr key={tx.id} onClick={()=>onRowClick?.(tx)} style={{borderBottom:'0.5px solid var(--border)',cursor:onRowClick?'pointer':'default'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                <td style={{padding:'9px 12px',color:'var(--text-secondary)',whiteSpace:'nowrap'}}>
                  {tx.date}
                  {tx.pending && <span style={{marginLeft:6,fontSize:9,padding:'1px 5px',borderRadius:4,background:'var(--amber-light)',color:'var(--amber)',textTransform:'uppercase',letterSpacing:'0.3px'}}>Pending</span>}
                </td>
                <td style={{padding:'9px 12px',maxWidth:340}}>
                  <span style={{display:'block',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}} title={tx.desc||''}>{tx.desc||'—'}</span>
                </td>
                {showAccount && <td style={{padding:'9px 12px',color:'var(--text-secondary)',whiteSpace:'nowrap'}}>{acct?.name||'—'}</td>}
                <td style={{padding:'9px 12px'}}>
                  {glAcct ? (
                    <span style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,whiteSpace:'nowrap'}}
                      title={`${TYPE_LABELS[glAcct.type]||glAcct.type}${glAcct.subtype?' · '+glAcct.subtype:''}`}>
                      <span style={{width:7,height:7,borderRadius:2,background:TYPE_COLORS[glAcct.type]||'var(--text-muted)',flexShrink:0}}/>
                      {glAcct.name}
                    </span>
                  ) : tx.category ? (
                    <span style={{fontSize:11,padding:'2px 8px',borderRadius:99,background:catColor+'22',color:catColor,whiteSpace:'nowrap'}}>{tx.category}</span>
                  ) : null}
                </td>
                <td style={{padding:'9px 12px',textAlign:'right',color:'var(--coral)',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>
                  {debit ? fmtFull(Math.abs(tx.amount)) : ''}
                </td>
                <td style={{padding:'9px 12px',textAlign:'right',color:'var(--teal)',whiteSpace:'nowrap',fontVariantNumeric:'tabular-nums'}}>
                  {!debit ? fmtFull(tx.amount) : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Spending breakdown by category ────────────────────────────────────────────
function SpendingBreakdown({ txs }) {
  const expenses = txs.filter(t => t.amount < 0 && t.category !== 'Transfer')
  const byCat = {}
  for (const t of expenses) {
    byCat[t.category] = (byCat[t.category] || 0) + Math.abs(t.amount)
  }
  const sorted = Object.entries(byCat).sort((a,b) => b[1]-a[1]).slice(0, 7)
  const total = sorted.reduce((s,[,v]) => s+v, 0)
  if (!sorted.length) return null

  return (
    <div>
      <p style={{fontSize:11,fontWeight:500,color:'var(--text-secondary)',margin:'0 0 12px',textTransform:'uppercase',letterSpacing:'0.5px'}}>Spending by Category</p>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {sorted.map(([cat, amt]) => {
          const pct = total > 0 ? (amt / total) * 100 : 0
          const col = CAT_COLOR[cat] || 'var(--text-muted)'
          return (
            <div key={cat}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:3}}>
                <span style={{color:'var(--text-secondary)'}}>{cat}</span>
                <span style={{fontWeight:500}}>{fd(amt)}</span>
              </div>
              <div style={{height:3,background:'var(--bg-secondary)',borderRadius:2}}>
                <div style={{height:3,width:pct+'%',background:col,borderRadius:2}}/>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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

function AccountStrip({ bankAccounts, selectedAcct, setSelectedAcct }) {
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
            <AccountCard acc={a} selected={selectedAcct===a.id} onClick={()=>clickCard(a.id)}/>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Transaction detail + QuickBooks-style categorization modal ────────────────
function TxDetailModal({ tx, bankAccounts, coa, coaById, onUpdate, reload, onClose }) {
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

  // Active COA accounts grouped by Account Type for the <select>. Keep the
  // currently-assigned account selectable even if it was made inactive/deleted.
  const grouped = useMemo(() => {
    const byType = {}
    for (const t of TYPE_ORDER) byType[t] = coa.filter(a => a.type === t && a.active !== false)
    const cur = coaId ? coaById.get(coaId) : null
    if (cur && cur.active === false) (byType[cur.type] = byType[cur.type] || []).push(cur)
    return byType
  }, [coa, coaId, coaById])

  const save = async () => {
    setSaving(true)
    try {
      await axios.patch(`${API}/transactions/${tx.id}`, { coaId: coaId || null, note, approved: !!coaId })
      // Functional update so a concurrent SSE refetch doesn't get mapped over a stale snapshot.
      onUpdate(prev => prev.map(t => t.id === tx.id ? { ...t, coaId: coaId || null, note, approved: !!coaId } : t))
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

      {/* Categorization — assign to a Chart-of-Accounts account */}
      <Field label="Category (Chart of Accounts)">
        <select value={coaId} onChange={e=>setCoaId(e.target.value)} style={{width:'100%'}}>
          <option value="">Uncategorized</option>
          {TYPE_ORDER.map(t => grouped[t]?.length ? (
            <optgroup key={t} label={TYPE_LABELS[t]}>
              {grouped[t].map(a => <option key={a.id} value={a.id}>{a.number?`${a.number} `:''}{a.name}</option>)}
            </optgroup>
          ) : null)}
        </select>
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
  const [selectedAcct, setSelectedAcct] = useState(null)          // null = all accounts
  const [view, setView]                 = useState('transactions') // 'transactions' | 'statements'
  const [search, setSearch]             = useState('')
  const [filterMonth, setFilterMonth]   = useState('all')
  const [sortDir, setSortDir]           = useState('desc')
  const [statusFilter, setStatusFilter] = useState('all')          // 'all' | 'pending' | 'approved'
  const [autoMsg, setAutoMsg]           = useState('')             // transient auto-categorize feedback

  useEffect(() => {
    axios.get(`${API}/vault`).then(r => setVaultData(r.data)).catch(() => {})
    axios.get(`${API}/accounting/coa`).then(r => setCoa(r.data || [])).catch(() => {})
  }, [])

  // Lookup a COA entry by id — tolerant of missing (deleted) accounts.
  const coaById = useMemo(() => new Map(coa.map(a => [a.id, a])), [coa])

  // Refetch the full transaction list after server-side rule application.
  const reload = () => axios.get(`${API}/transactions`).then(r => onUpdate(r.data)).catch(() => {})
  const autoCategorize = async () => {
    setAutoMsg('Categorizing…')
    try {
      const { data } = await axios.post(`${API}/categorization-rules/apply`)
      await reload()
      setAutoMsg(data.count ? `Categorized ${data.count} transaction${data.count===1?'':'s'}` : 'No matching rules yet')
      setTimeout(() => setAutoMsg(''), 3500)
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
  const hasSpending    = filteredTxs.some(t => t.amount < 0 && t.category !== 'Transfer')

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
            <AccountStrip bankAccounts={bankAccounts} selectedAcct={selectedAcct} setSelectedAcct={setSelectedAcct}/>
          </div>

          {/* ── Transactions | Statements toggle ───────────────────── */}
          <div style={{display:'flex',alignItems:'center',borderBottom:'0.5px solid var(--border)',marginBottom:14}}>
            {[['transactions',`Transactions (${scopeTxCount})`],['statements',`Statements (${scopeStmtCount})`]].map(([id,label]) => (
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
                <button onClick={autoCategorize} title="Apply your saved rules to uncategorized transactions" style={{
                  fontSize:12, padding:'5px 13px', borderRadius:99, cursor:'pointer',
                  border:'0.5px solid var(--blue)', background:'var(--blue-light)', color:'var(--blue)',
                }}><i className="ti ti-wand" aria-hidden="true"/> Auto-categorize</button>
              </div>

              {/* Totals + table | spending sidebar */}
              <div style={{display:'grid',gridTemplateColumns:hasSpending?'1fr 240px':'1fr',gap:24,alignItems:'start'}}>
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
                  <TxTable txs={filteredTxs} bankAccounts={bankAccounts} showAccount={!selectedAcct}
                    sortDir={sortDir} onToggleSort={()=>setSortDir(d=>d==='desc'?'asc':'desc')}
                    onRowClick={setDetailTx} coaById={coaById}/>
                </div>
                {hasSpending && (
                  <div className="card" style={{padding:'14px 16px'}}>
                    <SpendingBreakdown txs={filteredTxs}/>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Statements view ────────────────────────────────────── */}
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
                      {[...files].sort((a,b)=>b.name.localeCompare(a.name)).map(f => <StmtCard key={f.id} f={f}/>)}
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
                                {[...files].sort((a,b)=>b.name.localeCompare(a.name)).map(f => <StmtCard key={f.id} f={f}/>)}
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

      {detailTx && (
        <TxDetailModal
          tx={detailTx}
          bankAccounts={bankAccounts}
          coa={coa}
          coaById={coaById}
          onUpdate={onUpdate}
          reload={reload}
          onClose={()=>setDetailTx(null)}
        />
      )}
    </div>
  )
}
