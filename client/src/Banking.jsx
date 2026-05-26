import { useState, useEffect } from 'react'
import axios from 'axios'

const API = '/api'
const fmt = (n, d=0) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(d)+'K'; return String(Math.abs(n).toFixed(d)) }
const fd  = (n, d=0) => (n<0?'-$':'$')+fmt(Math.abs(n),d)
const fmtFull = n => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})

// ── Account classification ────────────────────────────────────────────────────
const RETIREMENT_SUBS = new Set(['401k','401a','ira','roth','roth ira','403b','457b','pension','profit sharing','simple ira','sep ira','keogh'])
const INVESTMENT_TYPES = new Set(['investment','brokerage'])
const INVESTMENT_SUBS  = new Set(['brokerage','mutual fund','etf'])
const BANK_TYPES       = new Set(['depository','bank'])
const BANK_SUBS        = new Set(['checking','savings','cd','money market','prepaid','cash management','paypal','hsa'])

export function classifyAccount(acc) {
  const t = (acc.type    || '').toLowerCase()
  const s = (acc.subtype || '').toLowerCase()
  if (RETIREMENT_SUBS.has(s))                           return 'retirement'
  if (INVESTMENT_TYPES.has(t) || INVESTMENT_SUBS.has(s)) return 'equity'
  if (BANK_TYPES.has(t) || BANK_SUBS.has(s))            return 'bank'
  if (t === 'credit' || s === 'credit card')             return 'credit'
  if (t === 'crypto')                                    return 'crypto'
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

function AccountCard({ acc }) {
  // availableBalance = what the bank shows you / what you can spend (may include early-released pending deposits)
  // balance = officially posted balance (may lag behind if the bank released funds early)
  // Show available as the primary number since that's what matches the bank's own app
  const available = acc.availableBalance ?? acc.balance ?? 0
  const posted    = acc.balance ?? 0
  const hasPostedDiff = acc.availableBalance != null && Math.abs(available - posted) >= 0.01
  const subLabel  = acc.subtype
    ? acc.subtype.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase())
    : (acc.type || 'Account').replace(/\b\w/g, c => c.toUpperCase())
  const sourceLabel = acc.source === 'plaid' ? 'Live' : acc.source === 'csv_import' ? 'CSV' : 'Manual'

  return (
    <div className="card" style={{display:'flex',flexDirection:'column',gap:10}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between'}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:36,height:36,borderRadius:'var(--radius-md)',background:'var(--green-light)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <i className="ti ti-building-bank" style={{fontSize:17,color:'var(--green)'}} aria-hidden="true"/>
          </div>
          <div>
            <p style={{fontSize:14,fontWeight:500,margin:0}}>{acc.name}</p>
            <p style={{fontSize:11,color:'var(--text-secondary)',margin:'2px 0 0'}}>
              {acc.institution}{acc.last4 ? ` ••••${acc.last4}` : ''}
            </p>
          </div>
        </div>
        <span style={{fontSize:10,fontWeight:500,padding:'2px 7px',borderRadius:99,background:'var(--bg-secondary)',color:'var(--text-secondary)',textTransform:'capitalize',border:'0.5px solid var(--border)',whiteSpace:'nowrap'}}>
          {subLabel}
        </span>
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end'}}>
        <div>
          <p style={{fontSize:10,color:'var(--text-muted)',margin:'0 0 2px'}}>BALANCE</p>
          <p style={{fontSize:20,fontWeight:500,margin:0,color:available<0?'var(--coral)':'var(--text-primary)'}}>
            {fmtFull(available)}
          </p>
        </div>
        {hasPostedDiff && (
          <div style={{textAlign:'right'}}>
            <p style={{fontSize:10,color:'var(--text-muted)',margin:'0 0 2px'}}>POSTED</p>
            <p style={{fontSize:13,fontWeight:500,margin:0,color:'var(--text-secondary)'}}>{fmtFull(posted)}</p>
          </div>
        )}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        {acc.lastUpdated
          ? <p style={{fontSize:10,color:'var(--text-muted)',margin:0}}>Updated {new Date(acc.lastUpdated).toLocaleDateString()}</p>
          : <span/>}
        <span style={{fontSize:10,padding:'1px 6px',borderRadius:99,
          background: acc.source==='plaid'?'var(--teal-light)':'var(--bg-secondary)',
          color: acc.source==='plaid'?'var(--teal)':'var(--text-muted)',
          border:`0.5px solid ${acc.source==='plaid'?'var(--teal)':'var(--border)'}`}}>
          {sourceLabel}
        </span>
      </div>
    </div>
  )
}

function FlowChart({ data }) {
  const maxVal = Math.max(...data.map(d => Math.max(d.income, d.expenses)), 1)
  return (
    <div>
      <p style={{fontSize:11,fontWeight:500,color:'var(--text-secondary)',margin:'0 0 12px',textTransform:'uppercase',letterSpacing:'0.5px'}}>6-Month Cash Flow</p>
      <div style={{display:'flex',alignItems:'flex-end',gap:10,height:100}}>
        {data.map(d => (
          <div key={d.month} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
            <div style={{display:'flex',gap:2,alignItems:'flex-end',height:78}}>
              <div title={`Income: ${fd(d.income)}`} style={{width:10,height:Math.max(2,(d.income/maxVal)*78)+'px',background:'var(--teal)',borderRadius:'2px 2px 0 0'}}/>
              <div title={`Expenses: ${fd(d.expenses)}`} style={{width:10,height:Math.max(2,(d.expenses/maxVal)*78)+'px',background:'var(--coral)',borderRadius:'2px 2px 0 0'}}/>
            </div>
            <span style={{fontSize:9,color:'var(--text-muted)'}}>{d.label}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:14,marginTop:8}}>
        <span style={{fontSize:10,color:'var(--teal)',display:'flex',alignItems:'center',gap:4}}>
          <span style={{width:8,height:8,background:'var(--teal)',borderRadius:2,display:'inline-block'}}/> Deposits
        </span>
        <span style={{fontSize:10,color:'var(--coral)',display:'flex',alignItems:'center',gap:4}}>
          <span style={{width:8,height:8,background:'var(--coral)',borderRadius:2,display:'inline-block'}}/> Withdrawals
        </span>
      </div>
    </div>
  )
}

function TxRow({ tx, bankAccounts }) {
  const acct     = bankAccounts.find(a => a.id === tx.account)
  const catColor = CAT_COLOR[tx.category] || 'var(--text-muted)'
  const isDebit  = tx.amount < 0
  return (
    <div style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'0.5px solid var(--border)'}}>
      <div style={{width:32,height:32,borderRadius:'var(--radius-md)',background:catColor+'22',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
        <i className={`ti ${isDebit?'ti-arrow-up-right':'ti-arrow-down-left'}`} style={{fontSize:14,color:catColor}} aria-hidden="true"/>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <p style={{fontSize:13,fontWeight:500,margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{tx.desc||'—'}</p>
        <p style={{fontSize:11,color:'var(--text-secondary)',margin:'2px 0 0'}}>
          {tx.date}
          {tx.category ? ` · ${tx.category}` : ''}
          {acct ? ` · ${acct.name}` : ''}
        </p>
      </div>
      <div style={{textAlign:'right',flexShrink:0}}>
        <p style={{fontSize:14,fontWeight:500,margin:0,color:tx.amount>=0?'var(--teal)':'var(--text-primary)'}}>
          {tx.amount>=0?'+':''}{fmtFull(tx.amount)}
        </p>
        {tx.pending && <p style={{fontSize:10,color:'var(--amber)',margin:'2px 0 0'}}>Pending</p>}
      </div>
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
export default function Banking({ accounts, transactions }) {
  const [tab, setTab]               = useState('overview')
  const [vaultData, setVaultData]   = useState(null)
  const [search, setSearch]         = useState('')
  const [filterAcct, setFilterAcct] = useState('all')
  const [filterMonth, setFilterMonth] = useState('all')
  const [sortDir, setSortDir]       = useState('desc')

  useEffect(() => {
    axios.get(`${API}/vault`).then(r => setVaultData(r.data)).catch(() => {})
  }, [])

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

  const prevNet = prevMonthTxs.reduce((s,t)=>s+t.amount,0)
  const netDelta = monthNet - prevNet

  // ── 6-month flow chart ─────────────────────────────────────────────────
  const last6 = []
  for (let i=5; i>=0; i--) {
    const d   = new Date(now.getFullYear(), now.getMonth()-i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    const mtxs = bankTxs.filter(t => t.month===key)
    last6.push({
      month: key,
      label: d.toLocaleDateString('en-US',{month:'short'}),
      income:   mtxs.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0),
      expenses: Math.abs(mtxs.filter(t=>t.amount<0).reduce((s,t)=>s+t.amount,0)),
    })
  }

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

  // ── Transaction filtering ─────────────────────────────────────────────
  const months = [...new Set(bankTxs.map(t=>t.month))].sort().reverse()

  let filteredTxs = [...bankTxs]
  if (filterAcct  !== 'all') filteredTxs = filteredTxs.filter(t => t.account === filterAcct)
  if (filterMonth !== 'all') filteredTxs = filteredTxs.filter(t => t.month === filterMonth)
  if (search.trim())         filteredTxs = filteredTxs.filter(t =>
    (t.desc||'').toLowerCase().includes(search.toLowerCase()) ||
    (t.category||'').toLowerCase().includes(search.toLowerCase())
  )
  filteredTxs.sort((a,b) => sortDir==='desc'
    ? b.date.localeCompare(a.date)
    : a.date.localeCompare(b.date))

  const filtIncome   = filteredTxs.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0)
  const filtExpenses = Math.abs(filteredTxs.filter(t=>t.amount<0).reduce((s,t)=>s+t.amount,0))
  const filtNet      = filteredTxs.reduce((s,t)=>s+t.amount,0)

  const noData = bankAccounts.length === 0

  const TABS = [
    { id:'overview',     label:'Overview' },
    { id:'transactions', label:`Transactions${bankTxs.length?` (${bankTxs.length})`:''}` },
    { id:'statements',   label:`Statements${stmtFiles.length?` (${stmtFiles.length})`:''}` },
  ]

  return (
    <div>
      {/* ── Tab bar ─────────────────────────────────────────────────── */}
      <div style={{display:'flex',gap:0,marginBottom:20,borderBottom:'0.5px solid var(--border)'}}>
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            background:'none',border:'none',
            borderBottom:tab===t.id?'2px solid var(--green)':'2px solid transparent',
            padding:'8px 18px',fontSize:13,fontWeight:tab===t.id?500:400,
            color:tab===t.id?'var(--text-primary)':'var(--text-secondary)',
            cursor:'pointer',marginBottom:-1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── OVERVIEW ────────────────────────────────────────────────── */}
      {tab==='overview' && (
        <div>
          {noData ? (
            <div className="card" style={{textAlign:'center',padding:'3rem'}}>
              <i className="ti ti-building-bank" style={{fontSize:40,color:'var(--text-muted)'}} aria-hidden="true"/>
              <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>No banking accounts found</p>
              <p style={{fontSize:13,color:'var(--text-secondary)',maxWidth:360,margin:'0 auto'}}>
                Connect a bank via Plaid in Connections, or import a CSV in Data Vault. Depository accounts (checking, savings, money market, CDs) will appear here.
              </p>
              <p style={{fontSize:11,color:'var(--text-muted)',marginTop:12}}>
                Investment accounts (brokerages, M1Finance, etc.) appear under Equities.
              </p>
            </div>
          ) : (
            <div>
              {/* Metric row */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
                <MetricCard
                  label="Balance" value={fd(totalAvailable)}
                  sub={`Across ${bankAccounts.length} account${bankAccounts.length!==1?'s':''}`}
                  icon="ti-cash" iconColor="var(--green)"/>
                <MetricCard
                  label="Posted Balance" value={fd(totalBalance)}
                  sub="Officially settled"
                  icon="ti-credit-card" iconColor="var(--teal)"/>
                <MetricCard
                  label="This Month Net" value={(monthNet>=0?'+':'')+fd(monthNet)}
                  subColor={monthNet>=0?'var(--teal)':'var(--coral)'}
                  sub={`+${fd(monthIncome)} in / -${fd(Math.abs(monthExpenses))} out`}
                  icon="ti-arrows-exchange" iconColor={monthNet>=0?'var(--teal)':'var(--coral)'}/>
                <MetricCard
                  label="vs Last Month" value={(netDelta>=0?'+':'')+fd(netDelta)}
                  subColor={netDelta>=0?'var(--teal)':'var(--coral)'}
                  sub={prevNet!==0?`Last month: ${fd(prevNet)}`:'No prior month data'}
                  icon="ti-trending-up" iconColor={netDelta>=0?'var(--teal)':'var(--coral)'}/>
              </div>

              {/* Accounts + flow chart */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 220px',gap:20,marginBottom:24}}>
                <div>
                  <p style={{fontSize:11,fontWeight:500,color:'var(--text-secondary)',margin:'0 0 10px',textTransform:'uppercase',letterSpacing:'0.5px'}}>Accounts</p>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))',gap:10}}>
                    {bankAccounts.map(a => <AccountCard key={a.id} acc={a}/>)}
                  </div>
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:20}}>
                  <FlowChart data={last6}/>
                  <SpendingBreakdown txs={thisMonthTxs}/>
                </div>
              </div>

              {/* Recent transactions */}
              <div>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
                  <p style={{fontSize:11,fontWeight:500,color:'var(--text-secondary)',margin:0,textTransform:'uppercase',letterSpacing:'0.5px'}}>
                    Recent Transactions
                  </p>
                  {bankTxs.length > 8 && (
                    <button onClick={()=>setTab('transactions')}
                      style={{fontSize:11,background:'none',border:'none',color:'var(--text-secondary)',cursor:'pointer',padding:0}}>
                      View all {bankTxs.length} →
                    </button>
                  )}
                </div>
                {bankTxs.length === 0
                  ? <p style={{fontSize:13,color:'var(--text-muted)',padding:'1rem 0'}}>No transactions yet.</p>
                  : [...bankTxs].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8).map(tx =>
                      <TxRow key={tx.id} tx={tx} bankAccounts={bankAccounts}/>)
                }
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TRANSACTIONS ────────────────────────────────────────────── */}
      {tab==='transactions' && (
        <div>
          {/* Filters */}
          <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
            <input
              value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search description or category…"
              style={{flex:1,minWidth:180,padding:'7px 10px',fontSize:12,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-primary)'}}/>
            <select value={filterAcct} onChange={e=>setFilterAcct(e.target.value)}
              style={{padding:'7px 10px',fontSize:12,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-primary)'}}>
              <option value="all">All accounts</option>
              {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={filterMonth} onChange={e=>setFilterMonth(e.target.value)}
              style={{padding:'7px 10px',fontSize:12,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-primary)'}}>
              <option value="all">All months</option>
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <button onClick={()=>setSortDir(d=>d==='desc'?'asc':'desc')}
              style={{padding:'7px 10px',fontSize:12,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',cursor:'pointer',display:'flex',alignItems:'center',gap:5}}>
              <i className={`ti ti-sort-${sortDir==='desc'?'descending':'ascending'}`} aria-hidden="true"/> Date
            </button>
          </div>

          {/* Totals strip */}
          {filteredTxs.length > 0 && (
            <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
              {[
                ['Deposits',  fd(filtIncome),    'var(--teal)'],
                ['Withdrawals', fd(filtExpenses), 'var(--coral)'],
                ['Net',        (filtNet>=0?'+':'')+fd(filtNet), filtNet>=0?'var(--teal)':'var(--coral)'],
                ['Count',      String(filteredTxs.length), 'var(--text-primary)'],
              ].map(([label,val,color]) => (
                <div key={label} style={{padding:'6px 14px',background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)'}}>
                  <p style={{fontSize:10,color:'var(--text-muted)',margin:'0 0 2px',textTransform:'uppercase'}}>{label}</p>
                  <p style={{fontSize:14,fontWeight:500,margin:0,color}}>{val}</p>
                </div>
              ))}
            </div>
          )}

          {filteredTxs.length === 0
            ? <p style={{color:'var(--text-muted)',fontSize:13,padding:'2rem',textAlign:'center'}}>No transactions match the current filters.</p>
            : filteredTxs.map(tx => <TxRow key={tx.id} tx={tx} bankAccounts={bankAccounts}/>)
          }
        </div>
      )}

      {/* ── STATEMENTS ──────────────────────────────────────────────── */}
      {tab==='statements' && (
        <div>
          {stmtFiles.length === 0 ? (
            <div className="card" style={{textAlign:'center',padding:'3rem'}}>
              <i className="ti ti-file-text" style={{fontSize:40,color:'var(--text-muted)'}} aria-hidden="true"/>
              <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>No statements in vault</p>
              <p style={{fontSize:13,color:'var(--text-secondary)',maxWidth:380,margin:'0 auto',lineHeight:1.6}}>
                Go to <strong>Connections → Generate Statements</strong> to create PDF bank statements from your transaction history. Statements will appear here once generated.
              </p>
            </div>
          ) : (
            <div>
              <p style={{fontSize:12,color:'var(--text-secondary)',margin:'0 0 20px'}}>
                {stmtFiles.length} statement{stmtFiles.length!==1?'s':''} across {Object.keys(stmtByInst).length} institution{Object.keys(stmtByInst).length!==1?'s':''}. Click any to open the PDF.
              </p>
              {Object.entries(stmtByInst).map(([inst, accounts]) => {
                const totalStmts = Object.values(accounts).flatMap(a => Object.values(a).flat()).length
                return (
                <div key={inst} style={{marginBottom:32}}>
                  {/* Institution header */}
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
                    <div style={{width:34,height:34,borderRadius:'var(--radius-md)',background:'var(--green-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <i className="ti ti-building-bank" style={{fontSize:17,color:'var(--green)'}} aria-hidden="true"/>
                    </div>
                    <div>
                      <p style={{fontSize:14,fontWeight:600,margin:0}}>{inst}</p>
                      <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>{totalStmts} statement{totalStmts!==1?'s':''}</p>
                    </div>
                  </div>

                  {/* Account subfolders */}
                  {Object.entries(accounts).map(([acctName, years]) => {
                    const acctTotal = Object.values(years).flat().length
                    return (
                    <div key={acctName} style={{marginBottom:20,marginLeft:44}}>
                      {/* Account name row */}
                      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,paddingBottom:6,borderBottom:'0.5px solid var(--border)'}}>
                        <i className="ti ti-credit-card" style={{fontSize:13,color:'var(--text-muted)'}} aria-hidden="true"/>
                        <p style={{fontSize:12,fontWeight:500,margin:0,color:'var(--text-secondary)'}}>{acctName}</p>
                        <span style={{fontSize:11,color:'var(--text-muted)',marginLeft:'auto'}}>{acctTotal} file{acctTotal!==1?'s':''}</span>
                      </div>

                      {/* Years */}
                      {Object.entries(years).sort(([a],[b])=>Number(b)-Number(a)).map(([year,files]) => (
                        <div key={year} style={{marginBottom:14,marginLeft:20}}>
                          <p style={{fontSize:11,color:'var(--text-muted)',margin:'0 0 8px',textTransform:'uppercase',letterSpacing:'0.5px',fontWeight:500}}>{year}</p>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:8}}>
                            {[...files].sort((a,b)=>b.name.localeCompare(a.name)).map(f => (
                              <a key={f.id} href={`/api/vault/file/${f.id}`} target="_blank" rel="noreferrer"
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
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )})}
                </div>
              )})}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
