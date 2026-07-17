import { useState, useEffect, useRef, createContext, useContext, Component } from 'react'
import axios from 'axios'
// Projections + PersonalSpending are hidden from the nav (Phase 1) but kept wired
// so they can be restored by re-adding a sidebar/NAV_TOOLS entry.
import Projections from './pages/Projections/Projections'
import PersonalSpending from './pages/PersonalSpending/PersonalSpending'
import DataVault from './pages/DataVault/DataVault'
import Accounting from './pages/Accounting/Accounting'
import Crypto from './pages/Crypto/Crypto'
import Scrapers from './pages/Scrapers/Scrapers'
import Banking, { classifyAccount } from './pages/Banking/Banking'
import Mortgage from './pages/Mortgage/Mortgage'
import Insurance from './pages/Insurance/Insurance'
import Equities from './pages/Equities/Equities'
import Login from './pages/Login/Login'
import DevChat from './dev/DevChat'
import { usePlaidLink } from 'react-plaid-link'

// ── Auth context ──────────────────────────────────────────────────────
export const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

// ── Axios auth interceptors ───────────────────────────────────────────
axios.interceptors.request.use(config => {
  const token = localStorage.getItem('caishen_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
axios.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401 && !err.config.url?.includes('/auth/')) {
    localStorage.removeItem('caishen_token')
    window.location.reload()
  }
  return Promise.reject(err)
})

const API = '/api'

// ── Formatting ────────────────────────────────────────────────────────
const fd = (n, d=0) => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d })
const fp = n => (n>=0?'+':'')+n.toFixed(1)+'%'

// Catches render-time errors in a page so one broken component doesn't blank the
// whole app — and surfaces the message on-screen for quick diagnosis.
class ErrorBoundary extends Component {
  constructor(props){ super(props); this.state = { error: null } }
  static getDerivedStateFromError(error){ return { error } }
  componentDidCatch(error, info){ console.error('Page render error:', error, info) }
  render(){
    if (this.state.error) {
      return (
        <div style={{padding:'20px',border:'1px solid var(--coral)',borderRadius:'var(--radius-md)',background:'var(--coral-light)'}}>
          <p style={{color:'var(--coral)',fontWeight:600,margin:'0 0 8px',fontSize:14}}>⚠ This page hit an error</p>
          <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:12,color:'var(--text-secondary)',margin:0,fontFamily:'monospace'}}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
          <button onClick={()=>this.setState({error:null})} style={{marginTop:12,fontSize:12}}>Dismiss</button>
        </div>
      )
    }
    return this.props.children
  }
}

// Real-estate portfolio is loaded per-user from GET /api/properties (see the
// `properties` state below). No demo data — an account with no properties shows none.
const DEMO_ACCOUNTS = [
  {id:'chase',name:'Chase Checking',type:'bank',balance:48250,institution:'Chase',last4:'4821'},
  {id:'schwab',name:'Schwab Brokerage',type:'brokerage',balance:342800,institution:'Charles Schwab',last4:'9912'},
  {id:'eth',name:'ETH Wallet',type:'crypto',balance:87400,institution:'Self-Custody',last4:'a3f2'},
  {id:'btc',name:'BTC Wallet',type:'crypto',balance:124600,institution:'Self-Custody',last4:'b7c1'},
  {id:'401k',name:'401(k)',type:'retirement',balance:218000,institution:'Fidelity',last4:'3344'},
  {id:'amex',name:'Amex Platinum',type:'credit',balance:-18400,institution:'AmEx',last4:'5566'},
]
const DEMO_TXS = [
  {id:1,date:'2024-05-15',desc:'Nobu LA',amount:-480,category:'Dining',icon:'ti-tools-kitchen-2',color:'var(--coral)'},
  {id:2,date:'2024-05-14',desc:'Amazon Order',amount:-284,category:'Shopping',icon:'ti-shopping-bag',color:'var(--amber)'},
  {id:3,date:'2024-05-13',desc:'Equinox',amount:-250,category:'Fitness',icon:'ti-barbell',color:'var(--teal)'},
  {id:4,date:'2024-05-12',desc:'Delta Airlines',amount:-1240,category:'Travel',icon:'ti-plane',color:'var(--blue)'},
  {id:5,date:'2024-05-11',desc:'Starbucks',amount:-8,category:'Coffee',icon:'ti-coffee',color:'var(--amber)'},
  {id:6,date:'2024-05-10',desc:'Whole Foods',amount:-320,category:'Groceries',icon:'ti-apple',color:'var(--green)'},
  {id:7,date:'2024-05-09',desc:'Netflix',amount:-23,category:'Entertainment',icon:'ti-device-tv',color:'var(--purple)'},
  {id:8,date:'2024-05-08',desc:'Apple Store',amount:-1299,category:'Tech',icon:'ti-device-laptop',color:'var(--blue)'},
]

const FRIEND_COMMENTS = {
  Dining:["Bro, Nobu again?? You could buy a small country with your sushi tab 🍣","Your food budget is eating your food budget","A wise man once said 'cook at home'. That man clearly never had omakase."],
  Shopping:["Amazon Prime hits different when you're buying your 4th air fryer","Your UPS driver knows your name, your dog's name, and your WiFi password","Legend says the packages never stop arriving..."],
  Fitness:["Paying $250/month to run on a treadmill you could buy for $1,200... classic","The commitment to looking like you work out is unmatched 💪","Your fitness spend is actually up. The gains must be real."],
  Travel:["First class? Of course. Your real estate portfolio demanded it.","Your passport works harder than most people's W-2","Somewhere, a travel agent just shed a single tear of joy"],
  Coffee:["$8 coffee is just a mortgage payment in liquid form","Starbucks sees you coming and starts printing your name","The audacity of spending $8 on coffee when you own five houses"],
  Groceries:["Erewhon? A $12 water? Truly living the California dream","Your grocery bill is the GDP of a small island nation","You didn't just buy groceries, you curated an artisanal food journey"],
  Entertainment:["Netflix — the one affordable thing in your budget. Respect.","$23 for Netflix while your monthly NOI is $16K... the contrast is iconic"],
  Tech:["A $1,299 purchase and you didn't even negotiate...","Apple just sent a thank-you card. It's addressed to your W-2."],
}

// ── Colors ────────────────────────────────────────────────────────────
// Opt-in asset class modules (manually added via + button)
const ASSET_CLASSES = [
  {id:'re',        label:'Real Estate',      icon:'ti-building-estate',   color:'var(--blue)'},
  {id:'equity',    label:'Equities',         icon:'ti-chart-candle',      color:'var(--purple)', devOnly:true},
  {id:'retirement',label:'Retirement',       icon:'ti-briefcase',         color:'var(--teal)',   devOnly:true},
  {id:'crypto',    label:'Crypto',           icon:'ti-currency-bitcoin',  color:'var(--amber)'},
]
// True when running locally — used to gate the Bank Scraper tab
const IS_LOCALHOST =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'

const NAV_TOOLS = [
  {id:'connections',   label:'Connections',   icon:'ti-plug',             adminOnly:false, localhostOnly:false},
  {id:'data',          label:'Data Vault',    icon:'ti-database',         adminOnly:false, localhostOnly:false},
  {id:'accounting',    label:'Report',        icon:'ti-building-bank',    adminOnly:false, localhostOnly:false},
  {id:'scrapers',      label:'Scrapers',      icon:'ti-cloud-download',   adminOnly:false, localhostOnly:true},
  {id:'settings',      label:'Settings',      icon:'ti-settings',         adminOnly:false, localhostOnly:false},
]

// ── Small components ──────────────────────────────────────────────────
function Icon({name, size=16, color}) {
  return <i className={`ti ${name}`} style={{fontSize:size, color, flexShrink:0}} aria-hidden="true"/>
}

function MetricCard({label, value, sub, subColor, icon, iconColor}) {
  return (
    <div className="metric-card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <p style={{fontSize:11,color:'var(--text-secondary)',margin:'0 0 6px',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.5px'}}>{label}</p>
        {icon && <Icon name={icon} size={18} color={iconColor||'var(--text-secondary)'}/>}
      </div>
      <p style={{fontSize:22,fontWeight:500,margin:0}}>{value}</p>
      {sub && <p style={{fontSize:12,color:subColor||'var(--text-secondary)',margin:'4px 0 0'}}>{sub}</p>}
    </div>
  )
}

function Breadcrumb({trail, onNav}) {
  if(trail.length<=1) return null
  return (
    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:14,fontSize:13}}>
      {trail.map((t,i)=>(
        <span key={t.id} style={{display:'flex',alignItems:'center',gap:6}}>
          {i>0 && <Icon name="ti-chevron-right" size={12} color="var(--text-muted)"/>}
          <button onClick={()=>onNav(i)} style={{background:'none',border:'none',padding:0,color:i<trail.length-1?'var(--text-secondary)':'var(--text-primary)',fontWeight:i===trail.length-1?500:400,fontSize:13,cursor:i<trail.length-1?'pointer':'default'}}>
            {t.label}
          </button>
        </span>
      ))}
    </div>
  )
}

function StatusBar() { return null }

// ── Donut chart ───────────────────────────────────────────────────────
function DonutChart({data, size=180, nw=0}) {
  const total = data.reduce((s,d)=>s+d.value,0)
  const cx = size/2, cy = size/2, r = size/2-10, ir = r-24
  const center = <>{
    <text x={cx} y={cy-8} textAnchor="middle" fontSize="14" fontWeight="500" fill="var(--text-primary)">{fd(nw)}</text>
  }{
    <text x={cx} y={cy+10} textAnchor="middle" fontSize="10" fill="var(--text-secondary)">net worth</text>
  }</>

  // SVG arcs can't represent a full 360° — handle single-slice as two circles
  if (data.filter(d=>d.value>0).length === 1) {
    const col = data.find(d=>d.value>0).rawColor
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill={col} opacity={0.88}/>
        <circle cx={cx} cy={cy} r={ir} fill="var(--bg-primary)"/>
        {center}
      </svg>
    )
  }

  let angle = -90
  const slices = data.filter(d=>d.value>0).map(d=>{
    const deg = (d.value/total)*360, start = angle, end = angle+deg
    angle += deg
    const toRad = a => Math.PI*a/180
    const x1=cx+r*Math.cos(toRad(start)), y1=cy+r*Math.sin(toRad(start))
    const x2=cx+r*Math.cos(toRad(end)),   y2=cy+r*Math.sin(toRad(end))
    const ix1=cx+ir*Math.cos(toRad(start)),iy1=cy+ir*Math.sin(toRad(start))
    const ix2=cx+ir*Math.cos(toRad(end)),  iy2=cy+ir*Math.sin(toRad(end))
    const large=deg>180?1:0
    return {...d, path:`M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} L${ix2},${iy2} A${ir},${ir} 0 ${large},0 ${ix1},${iy1} Z`}
  })
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s,i)=><path key={i} d={s.path} fill={s.rawColor} opacity={0.88}/>)}
      {center}
    </svg>
  )
}

// ── Screens ───────────────────────────────────────────────────────────
function MainDashboard({onDrill, accounts, transactions=[], properties, onConnect, enabledClasses=[], hasTransactions=false}) {
  // NaN-safe: value/rent are optional now (mortgage/exp are document-derived server-side).
  const reVal  = properties.reduce((s,p)=>s+(Number(p.value)||0),0)
  const reMort = properties.reduce((s,p)=>s+(Number(p.mortgage)||0),0)
  const reEquity = reVal-reMort
  const reExp    = properties.reduce((s,p)=>s+(Number(p.exp)||0),0)
  const hasRent  = properties.some(p=>Number(p.rent)>0)
  const noi      = properties.reduce((s,p)=>s+((Number(p.rent)||0)-(Number(p.exp)||0)),0)

  // For bank/credit accounts: only show balance when we have settled transaction data
  // (guards against stale or unsynced manual accounts showing phantom balances).
  // For investment/retirement/crypto accounts: use the Plaid balance directly —
  // these accounts get their balance from Plaid's Balance API and may not generate
  // regular Transactions API entries (e.g. a brokerage holding ETFs).
  const settledAcctIds = new Set(
    transactions.filter(t => !t.pending && t.account).map(t => t.account)
  )
  const BALANCE_DIRECT_CLASSES = new Set(['equity', 'retirement', 'crypto'])
  const acctBal = acct => {
    const cls = classifyAccount(acct)
    if (!BALANCE_DIRECT_CLASSES.has(cls) && !settledAcctIds.has(acct.id)) return 0
    return acct.availableBalance ?? acct.balance ?? 0
  }

  // For liability-type accounts (credit cards, loans) keep their negative balance as a liability.
  // For asset-type accounts (bank, savings) treat negative as $0 — not a liability.
  const isLiabilityAcct = a => ['credit', 'loan'].includes((a.type || '').toLowerCase())

  const acctVal = cls => accounts
    .filter(a => classifyAccount(a) === cls)
    .reduce((s, a) => {
      const b = acctBal(a)
      return s + (b > 0 ? b : 0)
    }, 0)

  const bankVal       = acctVal('bank')
  const equityVal     = acctVal('equity')
  const retirementVal = acctVal('retirement')
  const cryptoVal     = acctVal('crypto')
  const bankCount     = accounts.filter(a=>classifyAccount(a)==='bank').length

  const totalAssets = accounts.reduce((s, a) => {
    const b = acctBal(a); return s + (b > 0 ? b : 0)
  }, 0) + reVal
  const totalLiab = accounts.reduce((s, a) => {
    const b = acctBal(a)
    return s + (isLiabilityAcct(a) && b < 0 ? Math.abs(b) : 0)
  }, 0) + reMort
  const nw = totalAssets - totalLiab

  const donutData = [
    reVal > 0         && {label:'Real Estate', value:reVal,         rawColor:'#378ADD'},
    equityVal > 0     && {label:'Equities',    value:equityVal,     rawColor:'#7F77DD'},
    retirementVal > 0 && {label:'Retirement',  value:retirementVal, rawColor:'#1D9E75'},
    cryptoVal > 0     && {label:'Crypto',      value:cryptoVal,     rawColor:'#BA7517'},
    bankVal > 0       && {label:'Cash & Checking', value:bankVal,   rawColor:'#639922'},
  ].filter(Boolean)
  const total = donutData.reduce((s,d)=>s+d.value,0)

  // Cards for modules added to sidebar + Personal Spending (auto)
  const ALL_MODULES = [
    {id:'re',        label:'Real Estate',      icon:'ti-building-estate',  color:'var(--blue)',   val: reEquity>0?fd(reEquity):null,    sub: reVal>0?'equity · '+fd(reVal)+' value':null},
    {id:'equity',    label:'Equities',         icon:'ti-chart-candle',     color:'var(--purple)', val: equityVal>0?fd(equityVal):null,   sub: null},
    {id:'retirement',label:'Retirement',       icon:'ti-briefcase',        color:'var(--teal)',   val: retirementVal>0?fd(retirementVal):null, sub: null},
    {id:'crypto',    label:'Crypto',           icon:'ti-currency-bitcoin', color:'var(--amber)',  val: cryptoVal>0?fd(cryptoVal):null,   sub: null},
  ]
  const dashModules = ALL_MODULES.filter(m => enabledClasses.includes(m.id))

  const noAccounts = accounts.length === 0

  if (noAccounts) {
    return (
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:420,gap:20,textAlign:'center'}}>
        <div style={{width:72,height:72,borderRadius:'50%',background:'var(--teal-light)',border:'0.5px solid var(--teal)',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <Icon name="ti-building-bank" size={34} color="var(--teal)"/>
        </div>
        <div style={{maxWidth:360}}>
          <p style={{margin:'0 0 8px',fontSize:20,fontWeight:600}}>Connect an account</p>
          <p style={{margin:0,fontSize:14,color:'var(--text-secondary)',lineHeight:1.7}}>
            Link your bank via Plaid for live balances, or import CSV transaction history to get started.
          </p>
        </div>
        <button onClick={onConnect} style={{background:'var(--teal)',color:'#fff',borderColor:'var(--teal)',padding:'11px 28px',fontSize:14,fontWeight:500,marginTop:4}}>
          <Icon name="ti-plus" size={15}/> Add Account
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <MetricCard label="Net Worth" value={fd(nw)} icon="ti-crown" iconColor="var(--amber)"/>
        <MetricCard label="Total Assets" value={fd(totalAssets)} icon="ti-chart-pie" iconColor="var(--blue)"/>
        {/* Equity/NOI need market value & rent (not tracked right now) — fall back to the
            document-derived debt/cost views so these cards never show misleading negatives. */}
        {reVal>0
          ? <MetricCard label="RE Equity" value={fd(reEquity)} sub={((reEquity/reVal)*100).toFixed(0)+'% of RE value'} subColor="var(--teal)" icon="ti-building-estate" iconColor="var(--teal)"/>
          : <MetricCard label="RE Mortgage Debt" value={fdFull(reMort)} sub={properties.length?`${properties.length} propert${properties.length===1?'y':'ies'}`:undefined} icon="ti-building-estate" iconColor="var(--purple)"/>}
        {hasRent
          ? <MetricCard label="Monthly NOI" value={fd(noi)} sub={noi>0?fd(noi*12)+'/year':undefined} subColor="var(--teal)" icon="ti-cash" iconColor="var(--teal)"/>
          : <MetricCard label="RE Monthly Costs" value={fdFull(reExp)} sub="tax · insurance · escrow" icon="ti-cash" iconColor="var(--coral)"/>}
      </div>

      {/* Legend includes all enabled classes even at $0; donut slices only non-zero */}
      {(() => {
        const legendData = [
          {label:'Cash & Checking', value:bankVal,       rawColor:'#639922', always:true},
          enabledClasses.includes('re')         && {label:'Real Estate',    value:reVal,         rawColor:'#378ADD'},
          enabledClasses.includes('equity')     && {label:'Equities',       value:equityVal,     rawColor:'#7F77DD'},
          enabledClasses.includes('retirement') && {label:'Retirement',     value:retirementVal, rawColor:'#1D9E75'},
          enabledClasses.includes('crypto')     && {label:'Crypto',         value:cryptoVal,     rawColor:'#BA7517'},
        ].filter(Boolean)
        return (
      <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:32,alignItems:'start'}}>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
          <DonutChart data={donutData} size={190} nw={nw}/>
          <div style={{display:'flex',flexDirection:'column',gap:5,width:'100%'}}>
            {legendData.map(d=>(
              <div key={d.label} style={{display:'flex',alignItems:'center',gap:10,fontSize:12}}>
                <div style={{width:9,height:9,borderRadius:2,background:d.rawColor,flexShrink:0}}/>
                <span style={{color:'var(--text-secondary)',flex:1}}>{d.label}</span>
                <span style={{fontWeight:500,color:d.value===0?'var(--text-muted)':undefined}}>{fd(d.value)}</span>
                <span style={{color:'var(--text-muted)',width:36,textAlign:'right'}}>{total>0?((d.value/total)*100).toFixed(0):0}%</span>
              </div>
            ))}
          </div>
        </div>

        {dashModules.length > 0 && (
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {dashModules.map(m=>(
              <div key={m.id} onClick={()=>onDrill(m.id,m.label)} className="card"
                style={{cursor:'pointer',display:'flex',alignItems:'center',gap:14,padding:'12px 16px',transition:'border-color 0.15s'}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=m.color}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{width:38,height:38,borderRadius:'var(--radius-md)',background:m.color.replace('var(--','var(--').replace(')','-light)'),display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <Icon name={m.icon} size={19} color={m.color}/>
                </div>
                <div style={{flex:1}}>
                  <p style={{fontSize:14,fontWeight:500,margin:0}}>{m.label}</p>
                  {m.sub && <p style={{fontSize:11,color:'var(--text-muted)',margin:'2px 0 0'}}>{m.sub}</p>}
                </div>
                {m.val && <span style={{fontSize:14,fontWeight:500}}>{m.val}</span>}
                <Icon name="ti-chevron-right" size={14} color="var(--text-muted)"/>
              </div>
            ))}
          </div>
        )}
      </div>
        )
      })()}
    </div>
  )
}

// ── Property form (add / edit) ────────────────────────────────────────
const PROP_COLORS = [
  {label:'Blue',   val:'var(--blue)'},
  {label:'Teal',   val:'var(--teal)'},
  {label:'Purple', val:'var(--purple)'},
  {label:'Amber',  val:'var(--amber)'},
  {label:'Coral',  val:'var(--coral)'},
  {label:'Green',  val:'var(--green)'},
]
const BLANK_PROP = {name:'',addr:'',color:'var(--blue)'}
// Full-dollar formatter (no K/M abbreviation — this is a finance app).
const fdFull = n => (Number(n)<0?'-$':'$')+Math.abs(Math.round(Number(n)||0)).toLocaleString('en-US')

function PropertyForm({initial, onSave, onDelete, onClose, saving}) {
  const [form, setForm] = useState(initial || BLANK_PROP)
  const set = (k,v) => setForm(f=>({...f,[k]:v}))
  const isEdit = !!initial?.id

  const field = (label, key, type='number', placeholder='') => (
    <div style={{display:'flex',flexDirection:'column',gap:4}}>
      <label style={{fontSize:11,color:'var(--text-secondary)',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.5px'}}>{label}</label>
      <input type={type} value={form[key]} placeholder={placeholder}
        onChange={e=>set(key,type==='number'?e.target.value:e.target.value)}
        style={{padding:'8px 10px',fontSize:13,borderRadius:'var(--radius-sm)',border:'0.5px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-primary)',width:'100%'}}/>
    </div>
  )

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
      <div className="card" style={{width:'100%',maxWidth:540,maxHeight:'90vh',overflowY:'auto',padding:24}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
          <p style={{fontSize:16,fontWeight:500,margin:0}}>{isEdit?'Edit Property':'Add Property'}</p>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-muted)',fontSize:18,cursor:'pointer',padding:0}}>✕</button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
          <div style={{gridColumn:'1/-1'}}>{field('Property name','name','text','e.g. Maple St Duplex')}</div>
          <div style={{gridColumn:'1/-1'}}>{field('Address','addr','text','123 Main St, Los Angeles CA')}</div>
          <div style={{display:'flex',flexDirection:'column',gap:4}}>
            <label style={{fontSize:11,color:'var(--text-secondary)',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.5px'}}>Color</label>
            <div style={{display:'flex',gap:8}}>
              {PROP_COLORS.map(c=>(
                <button key={c.val} title={c.label} onClick={()=>set('color',c.val)}
                  style={{width:24,height:24,borderRadius:'50%',background:c.val,border:form.color===c.val?'2px solid var(--text-primary)':'2px solid transparent',cursor:'pointer'}}/>
              ))}
            </div>
          </div>
        </div>
        <p style={{fontSize:11.5,color:'var(--text-muted)',margin:'0 0 16px',lineHeight:1.5}}>
          <Icon name="ti-sparkles" size={12}/> Mortgage balance, rate, payment, and monthly expenses fill in automatically
          from this property's linked mortgage statements, insurance policies, and property-tax bills — and stay current
          as new ones are uploaded.
        </p>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:8}}>
          {isEdit
            ? <button onClick={onDelete} disabled={saving}
                style={{fontSize:12,color:'var(--coral)',borderColor:'var(--coral)',background:'var(--coral-light)'}}>
                Delete property
              </button>
            : <span/>
          }
          <div style={{display:'flex',gap:8}}>
            <button onClick={onClose} style={{fontSize:12}}>Cancel</button>
            <button onClick={()=>onSave(form)} disabled={saving||!form.name}
              style={{fontSize:12,background:'var(--blue)',color:'#fff',border:'none',borderRadius:'var(--radius-md)',padding:'8px 16px',cursor:'pointer',fontWeight:500}}>
              {saving?'Saving…':isEdit?'Save changes':'Add property'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const titleCase = s => String(s||'').toLowerCase().replace(/\b\w/g, c=>c.toUpperCase())

function RealEstateDash({onProp, properties, onRefresh}) {
  const [showForm, setShowForm]   = useState(false)
  const [editProp, setEditProp]   = useState(null)
  const [saving, setSaving]       = useState(false)
  const [suggestions, setSuggestions] = useState([])   // new addresses found on mortgage/insurance docs
  const [pendingSug, setPendingSug]   = useState(null) // suggestion the Add-Property form was opened from

  // Addresses printed on ingested mortgage statements / insurance policies that don't
  // match any portfolio property → offer to add them (dismissals persist server-side).
  useEffect(() => {
    axios.get(`${API}/re/address-suggestions`).then(r=>setSuggestions(Array.isArray(r.data)?r.data:[])).catch(()=>{})
  }, [])

  // All three are document-derived server-side (linked mortgage/insurance/tax rows).
  const totalDebt = properties.reduce((s,p)=>s+(Number(p.mortgage)||0),0)
  const totalPay  = properties.reduce((s,p)=>s+(Number(p.monthlyPayment)||0),0)
  const totalExp  = properties.reduce((s,p)=>s+(Number(p.exp)||0),0)

  const openAdd  = () => { setEditProp(null); setPendingSug(null); setShowForm(true) }
  const openEdit = (p,e) => { e.stopPropagation(); setEditProp(p); setPendingSug(null); setShowForm(true) }
  // "Add property" on a suggestion: open the normal form pre-filled from the document's address.
  const openFromSuggestion = (s) => {
    const street = s.address.split(/[\n,]/)[0]
    setEditProp({ ...BLANK_PROP, name: titleCase(street), addr: titleCase(s.address) })
    setPendingSug(s)
    setShowForm(true)
  }
  const dismissSuggestion = async (s) => {
    setSuggestions(list => list.filter(x => x.key !== s.key))
    try { await axios.post(`${API}/re/address-suggestions/dismiss`, { key: s.key }) } catch {}
  }

  const saveProperty = async (form) => {
    setSaving(true)
    const body = { ...form }   // name, address, color — the financial fields are derived server-side
    try {
      if (form.id) await axios.put(`${API}/properties/${form.id}`, body)
      else {
        const { data } = await axios.post(`${API}/properties`, body)
        // Added from a suggestion → link the source mortgage/insurance rows to the new
        // property so those tabs label it by name, and retire the suggestion.
        if (pendingSug && data?.id) {
          try { await axios.post(`${API}/re/address-suggestions/link`, { propertyId: data.id, mortgageAccountIds: pendingSug.mortgageAccountIds, policyIds: pendingSug.policyIds }) } catch {}
          setSuggestions(list => list.filter(x => x.key !== pendingSug.key))
        }
      }
      await onRefresh()
      setShowForm(false)
      setPendingSug(null)
    } catch(e) { alert('Save failed: '+e.message) }
    setSaving(false)
  }

  const deleteProperty = async () => {
    if (!window.confirm(`Delete "${editProp.name}"?`)) return
    setSaving(true)
    try {
      await axios.delete(`${API}/properties/${editProp.id}`)
      await onRefresh()
      setShowForm(false)
    } catch(e) { alert('Delete failed: '+e.message) }
    setSaving(false)
  }

  return (
    <div>
      {showForm && (
        <PropertyForm
          initial={editProp}
          onSave={saveProperty}
          onDelete={deleteProperty}
          onClose={()=>{ setShowForm(false); setPendingSug(null) }}
          saving={saving}/>
      )}

      {/* New addresses found on mortgage statements / insurance policies */}
      {suggestions.length > 0 && (
        <div style={{marginBottom:16,display:'flex',flexDirection:'column',gap:8}}>
          {suggestions.map(s => (
            <div key={s.key} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--blue-light)',border:'0.5px solid var(--blue)',borderRadius:'var(--radius-md)',flexWrap:'wrap'}}>
              <Icon name="ti-home-plus" size={18} color="var(--blue)"/>
              <div style={{flex:1,minWidth:220}}>
                <p style={{margin:0,fontSize:13,fontWeight:500}}>New address found: {titleCase(s.address)}</p>
                <p style={{margin:'2px 0 0',fontSize:11,color:'var(--text-secondary)'}}>
                  From your {s.sources.map(x=>x.label).join(' and ')} — add it to your portfolio?
                </p>
              </div>
              <button onClick={()=>openFromSuggestion(s)}
                style={{fontSize:12,background:'var(--blue)',color:'#fff',border:'none',borderRadius:'var(--radius-md)',padding:'7px 14px',cursor:'pointer',fontWeight:500}}>
                Add property
              </button>
              <button onClick={()=>dismissSuggestion(s)}
                style={{fontSize:12,background:'none',color:'var(--text-secondary)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',padding:'7px 12px',cursor:'pointer'}}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,flex:1,marginRight:12}}>
          <MetricCard label="Mortgage Debt" value={fdFull(totalDebt)} sub={`${properties.length} propert${properties.length===1?'y':'ies'}`} icon="ti-building-estate" iconColor="var(--blue)"/>
          <MetricCard label="Monthly Payments" value={fdFull(totalPay)} sub="P&I + escrow, from statements" icon="ti-calendar-dollar" iconColor="var(--purple)"/>
          <MetricCard label="Monthly Expenses" value={fdFull(totalExp)} sub="tax · insurance · escrow" icon="ti-cash" iconColor="var(--coral)"/>
        </div>
        <button onClick={openAdd} style={{flexShrink:0,fontSize:12,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)',whiteSpace:'nowrap'}}>
          <Icon name="ti-plus" size={13}/> Add property
        </button>
      </div>

      {properties.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'3rem'}}>
          <Icon name="ti-building-estate" size={40} color="var(--text-muted)"/>
          <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>No properties yet</p>
          <p style={{fontSize:13,color:'var(--text-secondary)',marginBottom:16}}>Add your properties — mortgage balances, rates, and expenses fill in automatically from your statements.</p>
          <button onClick={openAdd} style={{fontSize:13,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>
            <Icon name="ti-plus" size={14}/> Add your first property
          </button>
        </div>
      ) : (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          {properties.map(p=>{
            const linked = !!p.derived
            return (
              <div key={p.id} onClick={()=>onProp(p.id,p.name)} className="card" style={{cursor:'pointer',transition:'border-color 0.15s'}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=p.color}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,minWidth:0}}>
                    <div style={{width:34,height:34,borderRadius:'var(--radius-md)',background:'var(--blue-light)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <Icon name="ti-building-estate" size={17} color={p.color}/>
                    </div>
                    <div style={{minWidth:0}}>
                      <p style={{fontWeight:500,fontSize:14,margin:0}}>{p.name}</p>
                      {p.addr && <p style={{fontSize:11,color:'var(--text-secondary)',margin:0,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{p.addr}</p>}
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
                    {linked && (
                      <span className="badge" title={`Live from ${p.derived.loans} linked loan${p.derived.loans===1?'':'s'} + ${p.derived.policies} polic${p.derived.policies===1?'y':'ies'}`}
                        style={{background:'var(--teal-light)',color:'var(--teal)'}}>auto</span>
                    )}
                    <button onClick={e=>openEdit(p,e)} style={{background:'none',border:'none',color:'var(--text-muted)',padding:4,cursor:'pointer',fontSize:14,lineHeight:1}} title="Edit">
                      <Icon name="ti-pencil" size={13}/>
                    </button>
                  </div>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6}}>
                  {[['Mortgage',fdFull(p.mortgage||0)],['Rate',p.rate?`${p.rate}%`:'—'],['Expenses/mo',fdFull(p.exp||0)]].map(([l,v])=>(
                    <div key={l} style={{background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',padding:'6px 8px'}}>
                      <p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 2px'}}>{l}</p>
                      <p style={{fontSize:13,fontWeight:500,margin:0}}>{v}</p>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PropertyDetail({propId, properties, onRefresh}) {
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const p = properties.find(x=>x.id===propId)

  if(!p) return (
    <div className="card" style={{textAlign:'center',padding:'3rem'}}>
      <Icon name="ti-building-off" size={40} color="var(--text-muted)"/>
      <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>Property not found</p>
      <p style={{fontSize:13,color:'var(--text-secondary)'}}>This property may have been deleted or the link is stale.</p>
    </div>
  )

  // Prefer the real statement-derived payment; fall back to an interest-only estimate.
  const d = p.derived || {}
  const monthly  = Number(p.monthlyPayment) || (Number(p.mortgage)||0)*(Number(p.rate)||0)/100/12
  const extrasMo = p.derived ? (d.taxMo||0)+(d.insuranceMo||0) : (Number(p.exp)||0)

  const saveProperty = async (form) => {
    setSaving(true)
    const body = { ...form }   // name, address, color — the financial fields are derived server-side
    try { await axios.put(`${API}/properties/${p.id}`,body); await onRefresh(); setShowForm(false) }
    catch(e) { alert('Save failed: '+e.message) }
    setSaving(false)
  }
  const deleteProperty = async () => {
    if (!window.confirm(`Delete "${p.name}"?`)) return
    setSaving(true)
    try { await axios.delete(`${API}/properties/${p.id}`); await onRefresh() }
    catch(e) { alert('Delete failed: '+e.message) }
    setSaving(false)
  }

  return (
    <div>
      {showForm && <PropertyForm initial={p} onSave={saveProperty} onDelete={deleteProperty} onClose={()=>setShowForm(false)} saving={saving}/>}
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:20}}>
        <div style={{width:48,height:48,borderRadius:'var(--radius-md)',background:'var(--blue-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <Icon name="ti-building-estate" size={24} color={p.color}/>
        </div>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:20,fontWeight:500}}>{p.name}</h2>
          <p style={{margin:0,fontSize:13,color:'var(--text-secondary)'}}>{p.addr}</p>
        </div>
        <button onClick={()=>setShowForm(true)} style={{fontSize:12}}>
          <Icon name="ti-pencil" size={13}/> Edit
        </button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        {[['Mortgage Balance',fdFull(p.mortgage||0)],['Rate',p.rate?`${p.rate}%`:'—'],['Monthly Payment',fdFull(Math.round(monthly))],['Expenses/mo',fdFull(p.exp||0)]].map(([l,v])=>(
          <MetricCard key={l} label={l} value={v}/>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Monthly costs</p>
          {[
            ['Mortgage payment', Math.round(monthly)],
            ...(d.escrowMo    ? [['· includes escrow (tax + insurance)', Math.round(d.escrowMo)]] : []),
            ...(d.taxMo       ? [['Property tax', Math.round(d.taxMo)]] : []),
            ...(d.insuranceMo ? [['Insurance', Math.round(d.insuranceMo)]] : []),
            ...(!p.derived && p.exp ? [['Other expenses', Math.round(p.exp)]] : []),
            ['Total monthly cost', Math.round(monthly + extrasMo)],
          ].map(([l,v])=>(
            <div className="row" key={l}>
              <span style={{color:'var(--text-secondary)'}}>{l}</span>
              <span style={{fontWeight:l==='Total monthly cost'?500:400}}>{fdFull(v)}</span>
            </div>
          ))}
          {p.derived && (
            <p style={{fontSize:11,color:'var(--text-muted)',margin:'10px 0 0',lineHeight:1.5}}>
              <Icon name="ti-sparkles" size={11}/> Live from {d.loans} linked loan{d.loans===1?'':'s'} and {d.policies} linked polic{d.policies===1?'y':'ies'} — updates as new statements arrive.
            </p>
          )}
        </div>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Mortgage details</p>
          {[
            ['Balance',          fdFull(p.mortgage||0)],
            ['Rate',             p.rate?`${p.rate}%`:'—'],
            ['Monthly payment',  fdFull(Math.round(monthly))],
            ['Annual interest',  fdFull(Math.round((p.mortgage||0)*(p.rate||0)/100))],
          ].map(([l,v])=>(
            <div className="row" key={l}><span style={{color:'var(--text-secondary)'}}>{l}</span><span style={{fontWeight:500}}>{v}</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Net Worth Verification ────────────────────────────────────────────
function NetWorthVerification({ accounts }) {
  const [expanded, setExpanded] = useState(false)

  // Group by institution
  const byInst = {}
  for (const a of accounts) {
    const k = a.institution || 'Unknown'
    if (!byInst[k]) byInst[k] = []
    byInst[k].push(a)
  }

  // Flag institutions where same name appears >1 time (likely duplicate)
  const dupWarnings = Object.entries(byInst)
    .filter(([, accts]) => {
      const names = accts.map(a => a.name?.toLowerCase().trim())
      return names.length !== new Set(names).size
    })
    .map(([inst]) => inst)

  const fd2 = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits:0, maximumFractionDigits:0 })
  const hasDups = dupWarnings.length > 0

  return (
    <div style={{ marginBottom:16 }}>
      <button onClick={() => setExpanded(e => !e)}
        style={{ width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background: hasDups ? 'var(--amber-light,rgba(180,120,20,0.08))' : 'rgba(4,126,87,0.06)', border:`0.5px solid ${hasDups ? 'var(--amber)' : 'var(--teal)'}`, borderRadius:'var(--radius-sm)', cursor:'pointer', color: hasDups ? 'var(--amber)' : 'var(--teal)', fontSize:12 }}>
        <i className={`ti ${hasDups ? 'ti-alert-triangle' : 'ti-shield-check'}`} style={{ fontSize:14 }} aria-hidden="true"/>
        {hasDups
          ? `⚠ Possible duplicate accounts in: ${dupWarnings.join(', ')} — expand to review`
          : `Account data verified · ${accounts.length} account${accounts.length !== 1 ? 's' : ''} across ${Object.keys(byInst).length} institution${Object.keys(byInst).length !== 1 ? 's' : ''}`}
        <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize:12, marginLeft:'auto', color:'inherit', opacity:0.7 }} aria-hidden="true"/>
      </button>

      {expanded && (
        <div style={{ marginTop:8, border:'0.5px solid var(--border)', borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
          {Object.entries(byInst).map(([inst, accts], idx) => {
            const isDup = dupWarnings.includes(inst)
            const total = accts.reduce((s, a) => s + (a.availableBalance ?? a.balance ?? 0), 0)
            return (
              <div key={inst} style={{ borderBottom: idx < Object.keys(byInst).length - 1 ? '0.5px solid var(--border)' : 'none' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--bg-secondary)' }}>
                  <i className="ti ti-building-bank" style={{ fontSize:13, color: isDup ? 'var(--amber)' : 'var(--blue)', flexShrink:0 }} aria-hidden="true"/>
                  <span style={{ fontSize:12, fontWeight:500, flex:1 }}>{inst}</span>
                  {isDup && <span style={{ fontSize:10, color:'var(--amber)', background:'rgba(180,120,20,0.12)', padding:'2px 6px', borderRadius:'var(--radius-sm)' }}>possible duplicate</span>}
                  <span style={{ fontSize:12, fontWeight:500, color: total >= 0 ? 'var(--teal)' : 'var(--coral)' }}>{fd2(total)}</span>
                </div>
                {accts.map((a, i) => (
                  <div key={a.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 12px 5px 34px', borderTop:'0.5px solid var(--border)' }}>
                    <span style={{ fontSize:11, flex:1, color:'var(--text-secondary)' }}>
                      {a.name}{a.last4 ? ` ••••${a.last4}` : ''}
                      <span style={{ color:'var(--text-muted)', marginLeft:5, fontSize:10 }}>{a.subtype || a.type || ''}</span>
                    </span>
                    <span style={{ fontSize:11, color: (a.availableBalance ?? a.balance ?? 0) >= 0 ? 'var(--text-primary)' : 'var(--coral)', fontVariantNumeric:'tabular-nums' }}>
                      {fd2(a.availableBalance ?? a.balance ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Plaid Link hook ───────────────────────────────────────────────────
// One place that owns the connect flow: fetch a link token, auto-open Plaid
// Link as soon as it's ready, exchange the public token on success. Shared by
// the global "Add Account" button (MainApp) and the Connections screen so the
// connect logic lives in exactly one spot.
function usePlaidConnect({ onConnected } = {}) {
  const [linkToken, setLinkToken]   = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [linkError, setLinkError]   = useState(null)
  const updateItemRef = useRef(null)   // set → Link opened in update mode (re-consent, no token exchange)

  // connect() → link a NEW bank. connect(itemId) → UPDATE an existing connection to grant
  // the liabilities product (mortgage detail). Guarded so onClick={connect} (event arg) still
  // means "new connection".
  const connect = async (itemId) => {
    const updating = typeof itemId === 'string' && itemId
    updateItemRef.current = updating ? itemId : null
    setConnecting(true)
    setLinkError(null)
    try {
      const res = await axios.post(`${API}/plaid/create-link-token`, updating ? { item_id: itemId } : {})
      setLinkToken(res.data.link_token)
    } catch (e) {
      setLinkError(e.response?.data?.error || e.message)
      setConnecting(false)
    }
  }

  const plaidConfig = {
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        if (updateItemRef.current) {
          // Update mode: same connection, new permission — no token exchange. Sync now so
          // the fresh mortgage data lands immediately.
          await axios.post(`${API}/plaid/sync`)
        } else {
          await axios.post(`${API}/plaid/exchange-token`, {
            public_token: publicToken,
            institution_name: metadata.institution?.name || 'Unknown'
          })
        }
        setLinkToken(null)
        await onConnected?.()
      } catch (e) {
        setLinkError('Failed to connect account: ' + e.message)
      }
      updateItemRef.current = null
      setConnecting(false)
    },
    onExit: () => { updateItemRef.current = null; setLinkToken(null); setConnecting(false) },
    onEvent: () => {}
  }

  const { open: openPlaidLink, ready: plaidReady } = usePlaidLink(
    linkToken ? plaidConfig : { token: null, onSuccess: () => {} }
  )

  // Auto-open Plaid Link once the token is ready
  useEffect(() => {
    if (linkToken && plaidReady) openPlaidLink()
  }, [linkToken, plaidReady, openPlaidLink])

  return { connect, connecting, linkError, setLinkError }
}

function ConnectionsScreen({status, accounts, onSync}) {
  const [syncing, setSyncing]               = useState(false)
  const [historyRunning, setHistoryRunning] = useState(false)
  const [plaidConns, setPlaidConns]         = useState([])
  const [qbStatus, setQbStatus]             = useState(null)
  const [showHistoryWarning, setShowHistoryWarning] = useState(false)

  // Plaid connect flow (shared hook); on success refresh connections + parent data.
  const { connect, connecting, linkError, setLinkError } = usePlaidConnect({
    onConnected: async () => {
      const res = await axios.get(`${API}/plaid/connections`)
      setPlaidConns(Array.isArray(res.data) ? res.data : [])
      onSync?.()
    }
  })

  const plaidAccounts = (accounts || []).filter(a => a.source === 'plaid')

  // Load existing connections and QB status
  useEffect(() => {
    axios.get(`${API}/plaid/connections`)
      .then(r => setPlaidConns(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
    axios.get(`${API}/quickbooks/status`)
      .then(r => setQbStatus(r.data))
      .catch(() => {})
  }, [])

  // Pull full 2-year transaction history from Plaid (statements are upload-only — none generated).
  const syncFullHistory = async () => {
    setHistoryRunning(true)
    setLinkError(null)
    try {
      await axios.post(`${API}/plaid/sync-history`)
      // Server responds immediately and processes async; SSE pushes data-updated when done.
      setTimeout(async () => {
        try {
          const connsRes = await axios.get(`${API}/plaid/connections`)
          setPlaidConns(Array.isArray(connsRes.data) ? connsRes.data : [])
          onSync?.()
        } catch {}
        setHistoryRunning(false)
      }, 45000)
    } catch (e) {
      setLinkError(e.response?.data?.error || e.message)
      setHistoryRunning(false)
    }
  }

  const syncAll = async () => {
    setSyncing(true)
    try {
      await axios.post(`${API}/plaid/sync`)
      onSync?.()
      const res = await axios.get(`${API}/plaid/connections`)
      setPlaidConns(Array.isArray(res.data) ? res.data : [])
    } catch(e) { console.error(e) }
    setSyncing(false)
  }

  const removeConnection = async (itemId) => {
    if (!window.confirm('Disconnect this account?')) return
    try {
      await axios.delete(`${API}/plaid/connections/${itemId}`)
      setPlaidConns(prev => prev.filter(c => c.item_id !== itemId))
      onSync?.()
    } catch(e) { console.error(e) }
  }

  const connectQB = () => {
    window.open('/auth/quickbooks/connect', '_blank', 'width=600,height=700')
  }

  const syncQB = async () => {
    setSyncing(true)
    try {
      await axios.post(`${API}/quickbooks/sync`)
      const res = await axios.get(`${API}/quickbooks/status`)
      setQbStatus(res.data)
      onSync?.()
    } catch(e) { console.error(e) }
    setSyncing(false)
  }

  return (
    <div>
      {linkError && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', marginBottom:16, fontSize:13, color:'var(--coral)', border:'0.5px solid var(--coral)' }}>
          <i className="ti ti-alert-circle" style={{ fontSize:15 }} aria-hidden="true"/> {linkError}
          <button onClick={()=>setLinkError(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--coral)', padding:0 }}>✕</button>
        </div>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:12, marginBottom:20 }}>

        {/* Plaid */}
        <div className="card">
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
            <div style={{ width:38, height:38, borderRadius:'var(--radius-md)', background:'var(--blue-light)', display:'flex', alignItems:'center', justifyContent:'center' }}>
              <i className="ti ti-building-bank" style={{ fontSize:19, color:'var(--blue)' }} aria-hidden="true"/>
            </div>
            <div>
              <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Plaid — Bank Connections</p>
              <p style={{ fontSize:12, color:status?.plaidConfigured?'var(--teal)':'var(--coral)', margin:0 }}>
                {status?.plaidConfigured ? '✓ API keys configured' : '⚠ Add keys to .env to enable'}
              </p>
            </div>
          </div>

          {plaidConns.length > 0 ? (
            <div style={{ marginBottom:12 }}>
              {plaidConns.map(c=>(
                <div key={c.item_id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)', marginBottom:6 }}>
                  <i className="ti ti-circle-check" style={{ fontSize:14, color:'var(--teal)', flexShrink:0 }} aria-hidden="true"/>
                  <div style={{ flex:1 }}>
                    <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{c.institution_name}</p>
                    <p style={{ fontSize:11, color:'var(--text-secondary)', margin:0 }}>
                      Last sync: {c.lastSync ? new Date(c.lastSync).toLocaleString() : 'Never'}
                    </p>
                  </div>
                  <button onClick={()=>connect(c.item_id)} disabled={connecting}
                    title="Grant access to loan/mortgage details (rate, escrow, payoff, YTD interest) — re-opens the bank's approval once"
                    style={{ fontSize:11, padding:'3px 8px', color:'var(--purple)', borderColor:'var(--purple)', background:'var(--purple-light)' }}>
                    Loan data
                  </button>
                  <button onClick={()=>removeConnection(c.item_id)} style={{ fontSize:11, padding:'3px 8px', color:'var(--coral)', borderColor:'var(--coral)', background:'var(--coral-light)' }}>
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:12 }}>
              No accounts connected yet. Click below to connect your bank.
            </p>
          )}

          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={connect} disabled={connecting || !status?.plaidConfigured}
              style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
              <i className="ti ti-plug" aria-hidden="true"/> {connecting ? 'Opening...' : 'Connect account'}
            </button>
            {plaidConns.length > 0 && (
              <button className="sync-btn" onClick={syncAll} disabled={syncing}>
                <i className="ti ti-refresh" aria-hidden="true"/> {syncing ? 'Syncing...' : 'Sync all'}
              </button>
            )}
            {plaidConns.length > 0 && (
              <button onClick={() => setShowHistoryWarning(true)} disabled={syncing || historyRunning}
                title="Pull up to 2 years of transaction history from Plaid"
                style={{ fontSize:12, background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
                <i className={`ti ${historyRunning ? 'ti-loader-2 spin' : 'ti-clock-down'}`} aria-hidden="true"/>
                {' '}{historyRunning ? 'Pulling history…' : 'Sync full history'}
              </button>
            )}
          </div>
        </div>

        {showHistoryWarning && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
            <div className="card" style={{ maxWidth:480, width:'90%', padding:28 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
                <i className="ti ti-alert-triangle" style={{ fontSize:22, color:'var(--amber)' }} aria-hidden="true"/>
                <p style={{ fontSize:16, fontWeight:600, margin:0 }}>Heads up — Plaid history limits</p>
              </div>
              <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, margin:'0 0 12px' }}>
                Plaid can only pull as far back as your bank allows — typically <strong>90 days to 2 years</strong> depending on your institution. For example, Chase sometimes only provides the last 4 months of transactions via the API.
              </p>
              <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.7, margin:'0 0 18px' }}>
                For older history, you'll need to <strong>import CSV exports manually</strong>. Use the <em>Import CSV History</em> button in the <strong>Data Vault</strong> to import Chase or other bank CSV files — deduplication is automatic.
              </p>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={() => setShowHistoryWarning(false)}
                  style={{ background:'var(--bg-secondary)', color:'var(--text-secondary)', borderColor:'var(--border)' }}>
                  Cancel
                </button>
                <button onClick={() => { setShowHistoryWarning(false); syncFullHistory() }}
                  style={{ background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
                  <i className="ti ti-clock-down" aria-hidden="true"/> Pull Plaid history anyway
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Statement generation removed — statements are upload-only (Data Vault). */}

    </div>
  )
}

function PlaceholderScreen({label}) {
  return (
    <div className="card" style={{textAlign:'center',padding:'3rem'}}>
      <Icon name="ti-tools" size={40} color="var(--text-muted)"/>
      <p style={{fontSize:16,fontWeight:500,margin:'14px 0 6px'}}>{label}</p>
      <p style={{fontSize:13,color:'var(--text-secondary)'}}>This module is coming in the next build iteration.</p>
    </div>
  )
}

const AUTH_API = '/api/auth'

function SettingsScreen({ auth }) {
  const [twoFaStatus, setTwoFaStatus] = useState(null)
  const [setupStep, setSetupStep]     = useState(null)  // null | 'scanning' | 'done'
  const [qrData, setQrData]           = useState(null)
  const [code, setCode]               = useState('')
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [success, setSuccess]         = useState('')
  const [exporting, setExporting]     = useState(false)
  const [links, setLinks]             = useState([])
  const [linkCode, setLinkCode]       = useState(null)
  const [msgLoading, setMsgLoading]   = useState(false)
  const [msgErr, setMsgErr]           = useState('')
  const [copied, setCopied]           = useState(false)

  useEffect(() => {
    axios.get(`${AUTH_API}/2fa/status`)
      .then(r => setTwoFaStatus(r.data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    axios.get(`${API}/messaging/links`).then(r => setLinks(r.data || [])).catch(() => {})
  }, [])

  const startTotpSetup = async () => {
    setLoading(true); setError(''); setSuccess('')
    try {
      const r = await axios.post(`${AUTH_API}/2fa/setup-totp`)
      setQrData(r.data)
      setSetupStep('scanning')
    } catch (e) { setError(e.response?.data?.error || e.message) }
    setLoading(false)
  }

  const confirmTotp = async () => {
    if (!code.trim()) { setError('Enter the 6-digit code from your app'); return }
    setLoading(true); setError('')
    try {
      await axios.post(`${AUTH_API}/2fa/confirm-totp`, { code: code.trim() })
      setTwoFaStatus({ method: 'totp', totpConfigured: true })
      setSetupStep('done')
      setSuccess("Authenticator app enabled! You'll use it next time you sign in from a new device.")
    } catch (e) { setError(e.response?.data?.error || e.message) }
    setLoading(false)
  }

  const switchToEmail = async () => {
    setLoading(true); setError(''); setSuccess('')
    try {
      await axios.post(`${AUTH_API}/2fa/set-email`)
      setTwoFaStatus({ method: 'email', totpConfigured: false })
      setSetupStep(null); setQrData(null); setCode('')
      setSuccess('Switched to email verification.')
    } catch (e) { setError(e.response?.data?.error || e.message) }
    setLoading(false)
  }

  const exportAllData = async () => {
    setExporting(true)
    try {
      const token = localStorage.getItem('caishen_token')
      const res = await fetch(`${API}/backup`, { headers: { Authorization: `Bearer ${token}` } })
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `caishen-backup-${new Date().toISOString().slice(0,10)}.json`
      a.click()
    } catch (e) { setError('Export failed: ' + e.message) }
    setExporting(false)
  }

  // ── Messaging (categorizer bot) linking ──
  const loadLinks = async () => {
    try { const r = await axios.get(`${API}/messaging/links`); setLinks(r.data || []); return r.data || [] }
    catch { return [] }
  }
  const connectMessaging = async (channel = 'discord') => {
    setMsgLoading(true); setMsgErr('')
    try { const r = await axios.post(`${API}/messaging/link-code`, { channel }); setLinkCode(r.data) }
    catch (e) { setMsgErr(e.response?.data?.error || e.message) }
    setMsgLoading(false)
  }
  const checkLinked = async () => {
    setMsgLoading(true); setMsgErr('')
    const arr = await loadLinks()
    const ch = linkCode?.channel || 'discord'
    if (arr.find(l => l.channel === ch)) setLinkCode(null)
    else setMsgErr(`Not linked yet — make sure you sent:  link ${linkCode?.code || ''}`)
    setMsgLoading(false)
  }
  const unlinkMessaging = async (channel) => {
    setMsgLoading(true); setMsgErr('')
    try { await axios.delete(`${API}/messaging/links/${channel}`); await loadLinks(); setLinkCode(null) }
    catch (e) { setMsgErr(e.response?.data?.error || e.message) }
    setMsgLoading(false)
  }
  const copyCode = () => { try { navigator.clipboard.writeText(linkCode.code); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {} }
  const discordLink = links.find(l => l.channel === 'discord')
  const smsLink = links.find(l => l.channel === 'sms')

  const isTotp = twoFaStatus?.method === 'totp'

  return (
    <div style={{ maxWidth: 540 }}>
      {/* Account info */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{ width:44, height:44, borderRadius:12, background:'var(--blue-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <i className="ti ti-user" style={{ fontSize:22, color:'var(--blue)' }} aria-hidden="true"/>
          </div>
          <div>
            <p style={{ fontSize:15, fontWeight:500, margin:0 }}>{auth.user.displayName || auth.user.username}</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'2px 0 0', textTransform:'uppercase', letterSpacing:'0.5px' }}>{auth.user.role}</p>
          </div>
        </div>
      </div>

      {/* 2FA */}
      <div className="card">
        <p style={{ fontSize:14, fontWeight:500, margin:'0 0 4px' }}>Two-factor authentication</p>
        <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 16px', lineHeight:1.5 }}>
          2FA is required whenever you sign in from a new device. Choose your preferred verification method.
        </p>

        {error && (
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', fontSize:12, color:'var(--coral)', border:'0.5px solid var(--coral)', marginBottom:12 }}>
            <i className="ti ti-alert-circle" aria-hidden="true"/> {error}
          </div>
        )}
        {success && (
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', fontSize:12, color:'var(--teal)', border:'0.5px solid var(--teal)', marginBottom:12 }}>
            <i className="ti ti-circle-check" aria-hidden="true"/> {success}
          </div>
        )}

        {/* Current method */}
        {twoFaStatus && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', marginBottom:16 }}>
            <i className={`ti ${isTotp ? 'ti-lock' : 'ti-device-mobile'}`}
               style={{ fontSize:18, color: isTotp ? 'var(--blue)' : 'var(--amber)' }} aria-hidden="true"/>
            <div style={{ flex:1 }}>
              <p style={{ fontSize:13, fontWeight:500, margin:0 }}>
                {isTotp ? 'Authenticator app' : 'Email code'}
              </p>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'1px 0 0' }}>
                {isTotp ? 'Google Authenticator, Authy, or any TOTP app' : 'A 6-digit code is sent to your email address'}
              </p>
            </div>
            <span className="badge" style={{ background: isTotp ? 'var(--blue-light)' : 'var(--amber-light)', color: isTotp ? 'var(--blue)' : 'var(--amber)' }}>
              Active
            </span>
          </div>
        )}

        {/* Start TOTP setup */}
        {!isTotp && setupStep === null && (
          <button onClick={startTotpSetup} disabled={loading}
            style={{ fontSize:13, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
            {loading
              ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Generating…</>
              : <><i className="ti ti-lock" aria-hidden="true"/> Set up authenticator app</>}
          </button>
        )}

        {/* QR scan step */}
        {setupStep === 'scanning' && qrData && (
          <div>
            <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 14px', lineHeight:1.6 }}>
              Scan this QR code with <strong>Google Authenticator</strong>, <strong>Authy</strong>, or any TOTP app, then enter the 6-digit code to confirm.
            </p>
            <div style={{ display:'flex', gap:20, alignItems:'flex-start', marginBottom:16 }}>
              <div style={{ flexShrink:0, padding:8, background:'#fff', borderRadius:8, border:'1px solid var(--border)' }}>
                <img src={qrData.qrDataUrl} alt="QR code for authenticator setup" style={{ width:160, height:160, display:'block' }}/>
              </div>
              <div>
                <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px', fontWeight:500 }}>Or enter key manually</p>
                <p style={{ fontSize:12, fontFamily:'monospace', background:'var(--bg-secondary)', padding:'6px 10px', borderRadius:'var(--radius-sm)', letterSpacing:2, margin:0, wordBreak:'break-all', lineHeight:1.8 }}>
                  {qrData.secret}
                </p>
                <p style={{ fontSize:11, color:'var(--text-muted)', margin:'6px 0 0', lineHeight:1.5 }}>
                  App → Add account → Enter setup key
                </p>
              </div>
            </div>
            <label style={{ fontSize:12, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
              Enter the 6-digit code from your app to confirm setup
            </label>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <input
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                autoFocus
                style={{ width:130, padding:'9px 12px', fontSize:20, textAlign:'center', letterSpacing:6 }}
                autoComplete="one-time-code"
                onKeyDown={e => e.key === 'Enter' && confirmTotp()}
              />
              <button onClick={confirmTotp} disabled={loading || code.length < 6}
                style={{ fontSize:13, background:'var(--blue)', color:'#fff', border:'none', borderRadius:'var(--radius-md)', padding:'9px 16px', cursor:'pointer', fontWeight:500 }}>
                {loading ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Verifying…</> : 'Confirm'}
              </button>
              <button onClick={() => { setSetupStep(null); setQrData(null); setCode(''); setError('') }}
                style={{ fontSize:12 }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Post-confirm message */}
        {setupStep === 'done' && (
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <i className="ti ti-circle-check" style={{ color:'var(--teal)', fontSize:16 }} aria-hidden="true"/>
            <span style={{ fontSize:13, color:'var(--text-secondary)' }}>Authenticator app enabled! You'll use it next time you sign in from a new device.</span>
          </div>
        )}
      </div>

      {/* Data & Privacy */}
      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ fontSize:14, fontWeight:500, margin:'0 0 4px' }}>Data &amp; privacy</p>
        <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 16px', lineHeight:1.5 }}>
          All your financial data lives locally on this machine. Export a full JSON backup at any time, or use it to restore on another device.
        </p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button onClick={exportAllData} disabled={exporting}
            style={{ fontSize:13, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
            {exporting
              ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Exporting…</>
              : <><i className="ti ti-download" aria-hidden="true"/> Export all data</>}
          </button>
        </div>
        <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)', fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
          Backup includes: accounts, transactions, properties, tax years, crypto transactions, invoices, bills, chart of accounts, and journal entries.
          It does <strong>not</strong> include vault files — use the Data Vault's "Download all" button for those.
        </div>
      </div>

      {/* Transaction categorizer bot (Discord / SMS) */}
      <div className="card" style={{ marginTop: 16 }}>
        <p style={{ fontSize:14, fontWeight:500, margin:'0 0 4px' }}>Transaction categorizer bot</p>
        <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 16px', lineHeight:1.5 }}>
          Connect Discord or SMS and the bot will message you about each new transaction so you can confirm or fix its category — and you can text it a photo of a receipt.
        </p>

        {msgErr && (
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', fontSize:12, color:'var(--coral)', border:'0.5px solid var(--coral)', marginBottom:12 }}>
            <i className="ti ti-alert-circle" aria-hidden="true"/> {msgErr}
          </div>
        )}

        {/* Connected channels */}
        {discordLink && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', marginBottom:8 }}>
            <i className="ti ti-brand-discord" style={{ fontSize:18, color:'var(--purple)' }} aria-hidden="true"/>
            <div style={{ flex:1 }}>
              <p style={{ fontSize:13, fontWeight:500, margin:0 }}>Discord connected</p>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'1px 0 0' }}>
                {discordLink.display_name ? `as ${discordLink.display_name}` : `id ${discordLink.external_id}`}
              </p>
            </div>
            <button onClick={() => unlinkMessaging('discord')} disabled={msgLoading}
              style={{ fontSize:12, background:'var(--coral-light)', color:'var(--coral)', borderColor:'var(--coral)' }}>
              Disconnect
            </button>
          </div>
        )}
        {smsLink && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', marginBottom:8 }}>
            <i className="ti ti-message-2" style={{ fontSize:18, color:'var(--teal)' }} aria-hidden="true"/>
            <div style={{ flex:1 }}>
              <p style={{ fontSize:13, fontWeight:500, margin:0 }}>SMS connected</p>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'1px 0 0' }}>{smsLink.external_id}</p>
            </div>
            <button onClick={() => unlinkMessaging('sms')} disabled={msgLoading}
              style={{ fontSize:12, background:'var(--coral-light)', color:'var(--coral)', borderColor:'var(--coral)' }}>
              Disconnect
            </button>
          </div>
        )}

        {/* Pending link code, or the connect buttons */}
        {linkCode ? (
          <div style={{ marginTop:8 }}>
            <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 8px', lineHeight:1.6 }}>
              {linkCode.channel === 'sms'
                ? <>From your phone, text this to <strong>{linkCode.smsNumber || 'the CaiShen number'}</strong>:</>
                : <>In Discord, open a DM with the <strong>CaiShen</strong> bot and send:</>}
            </p>
            <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:10 }}>
              <code style={{ flex:1, fontSize:14, fontFamily:'monospace', background:'var(--bg-secondary)', padding:'10px 12px', borderRadius:'var(--radius-sm)', letterSpacing:1 }}>
                link {linkCode.code}
              </code>
              <button onClick={copyCode} style={{ fontSize:12 }}>
                {copied ? <><i className="ti ti-check" aria-hidden="true"/> Copied</> : <><i className="ti ti-copy" aria-hidden="true"/> Copy</>}
              </button>
            </div>
            <p style={{ fontSize:11, color:'var(--text-muted)', margin:'0 0 12px' }}>
              Code expires in {linkCode.expiresInMinutes || 15} minutes.
            </p>
            <button onClick={checkLinked} disabled={msgLoading}
              style={{ fontSize:13, background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
              {msgLoading ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Checking…</> : "I've sent it — check link"}
            </button>
          </div>
        ) : (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:8 }}>
            {!discordLink && (
              <button onClick={() => connectMessaging('discord')} disabled={msgLoading}
                style={{ fontSize:13, background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }}>
                {msgLoading
                  ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Generating…</>
                  : <><i className="ti ti-brand-discord" aria-hidden="true"/> Connect Discord</>}
              </button>
            )}
            {!smsLink && (
              <button onClick={() => connectMessaging('sms')} disabled={msgLoading}
                style={{ fontSize:13, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
                <i className="ti ti-message-2" aria-hidden="true"/> Connect SMS
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────
export default function App() {
  const [auth, setAuth] = useState(null) // null=loading, false=logged out, {user,token}=in

  useEffect(() => {
    const token = localStorage.getItem('caishen_token')
    if (!token) { setAuth(false); return }
    fetch('/api/auth/me', { headers:{ Authorization:`Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(user => setAuth({ user, token }))
      .catch(() => { localStorage.removeItem('caishen_token'); setAuth(false) })
  }, [])

  const handleLogout = () => { localStorage.removeItem('caishen_token'); setAuth(false) }

  if (auth === null) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'var(--bg-primary)',color:'var(--text-muted)',fontSize:13}}>
      <i className="ti ti-loader-2 spin" style={{fontSize:20,marginRight:8}} aria-hidden="true"/> Loading…
    </div>
  )
  if (!auth) return <Login onLogin={setAuth}/>

  return (
    <AuthContext.Provider value={auth}>
      <MainApp auth={auth} onLogout={handleLogout}/>
    </AuthContext.Provider>
  )
}

function MainApp({ auth, onLogout }) {
  const [nav, setNav] = useState('dashboard')
  const [trail, setTrail] = useState([{id:'dashboard',label:'Dashboard'}])
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [enabledClasses, setEnabledClasses] = useState(() => {
    try { return JSON.parse(localStorage.getItem('enabledClasses') || '[]') } catch { return [] }
  })
  const [showAddClass, setShowAddClass] = useState(false)
  const [addClassPos, setAddClassPos] = useState({top:0, left:0})
  const addClassRef = useRef(null)
  const addDropdownRef = useRef(null)

  const toggleClass = (id) => {
    setEnabledClasses(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      localStorage.setItem('enabledClasses', JSON.stringify(next))
      return next
    })
  }
  const addClass = (id) => {
    if (!enabledClasses.includes(id)) {
      const next = [...enabledClasses, id]
      setEnabledClasses(next)
      localStorage.setItem('enabledClasses', JSON.stringify(next))
    }
    setShowAddClass(false)
    go(id, ASSET_CLASSES.find(a => a.id === id)?.label || id)
  }
  const [properties, setProperties] = useState([])
  const isAdmin = auth?.user?.role === 'admin'

  useEffect(()=>{
    axios.get(`${API}/status`).then(r=>setStatus(r.data)).catch(()=>{})
    axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{})
    axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{})
    axios.get(`${API}/properties`).then(r=>setProperties(r.data||[])).catch(()=>{})
  },[])

  // Auto-enable sidebar asset-class modules when matching accounts are connected
  useEffect(() => {
    if (!accounts.length) return
    const AUTO_CLASSES = ['equity', 'retirement', 'crypto']
    const presentClasses = accounts.map(a => classifyAccount(a))
    const toAdd = AUTO_CLASSES.filter(cls =>
      presentClasses.includes(cls) && !enabledClasses.includes(cls)
    )
    if (toAdd.length) {
      setEnabledClasses(prev => {
        const next = [...new Set([...prev, ...toAdd])]
        localStorage.setItem('enabledClasses', JSON.stringify(next))
        return next
      })
    }
  }, [accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live push: server notifies the browser whenever a Plaid sync writes new data
  useEffect(()=>{
    let es, retryTimer
    const connect = () => {
      es = new EventSource(`/api/events`)
      es.onmessage = () => {
        axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{})
        axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{})
      }
      es.onerror = () => {
        es.close()
        retryTimer = setTimeout(connect, 5000) // reconnect after 5s if connection drops
      }
    }
    connect()
    return () => { es?.close(); clearTimeout(retryTimer) }
  },[])

  useEffect(() => {
    if (!showAddClass) return
    const handler = (e) => {
      const inBtn = addClassRef.current?.contains(e.target)
      const inDrop = addDropdownRef.current?.contains(e.target)
      if (!inBtn && !inDrop) setShowAddClass(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAddClass])

  const drill = (id, label) => { setNav(id); setTrail(prev=>[...prev,{id,label}]) }
  const navBC = idx => { const t=trail.slice(0,idx+1); setTrail(t); setNav(t[t.length-1].id) }
  const go = (id, label) => { setNav(id); setTrail([{id:label||id,label:label||id}]) }

  // Connect a bank from anywhere via Plaid Link; refresh data when it succeeds.
  const { connect: connectPlaid, connecting: plaidConnecting, linkError: plaidLinkError, setLinkError: setPlaidLinkError } = usePlaidConnect({
    onConnected: () => {
      axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{})
      axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{})
    }
  })
  // "Add Account" anywhere: open the Plaid popup when configured, otherwise fall
  // back to the Connections page (which explains the missing setup).
  const addAccount = () => {
    if (status?.plaidConfigured) connectPlaid()
    else go('connections', 'Connections')
  }

  const renderContent = () => {
    if(nav==='dashboard') return <MainDashboard onDrill={drill} accounts={accounts} transactions={transactions} properties={properties} onConnect={addAccount} enabledClasses={enabledClasses} hasTransactions={transactions.length>0}/>
    const refreshProps = () => axios.get(`${API}/properties`).then(r=>setProperties(r.data||[])).catch(()=>{})
    // Real Estate section — Properties | Mortgage | Insurance as tabs within one page.
    if(nav==='re'||nav==='mortgage'||nav==='insurance') return (
      <div>
        <div style={{display:'flex',alignItems:'center',borderBottom:'0.5px solid var(--border)',marginBottom:18}}>
          {[['re','Properties'],['mortgage','Mortgage'],['insurance','Insurance']].map(([id,label])=>(
            <button key={id} onClick={()=>setNav(id)} style={{
              background:'none',border:'none',
              borderBottom:nav===id?'2px solid var(--blue)':'2px solid transparent',
              padding:'8px 16px',fontSize:13,fontWeight:nav===id?500:400,
              color:nav===id?'var(--text-primary)':'var(--text-secondary)',
              cursor:'pointer',marginBottom:-1,
            }}>{label}</button>
          ))}
        </div>
        {nav==='re'
          ? <RealEstateDash onProp={(id,name)=>drill('prop_'+id,name)} properties={properties} onRefresh={refreshProps}/>
          : nav==='mortgage' ? <Mortgage/> : <Insurance/>}
      </div>
    )
    if(nav.startsWith('prop_')) return <PropertyDetail propId={nav.replace('prop_','')} properties={properties} onRefresh={refreshProps}/>
    if(nav==='personal') return <PersonalSpending transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='connections') return <ConnectionsScreen status={status} accounts={accounts} onSync={()=>{ axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])); axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])) }}/>
    if(nav==='equity') return <Equities accounts={accounts}/>
    if(nav==='retirement' && IS_LOCALHOST) return <PlaceholderScreen label="Retirement"/>
    if(nav==='crypto') return <Crypto/>
    if(nav==='cash') return <Banking accounts={accounts} transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='projections') return <Projections/>
    if(nav==='accounting') return <Accounting/>
    if(nav==='scrapers' && IS_LOCALHOST) return <Scrapers/>
    if(nav==='data')       return <DataVault accounts={accounts} transactions={transactions} onImportTransactions={txs=>setTransactions(prev=>[...prev,...txs])} onTransactionsChanged={()=>{ axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{}); axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{}) }}/>
    if(nav==='settings')   return <SettingsScreen auth={auth}/>
    return null
  }

  const curLabel = trail[trail.length-1]?.label || 'Dashboard'

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh'}}>
      {IS_LOCALHOST && <DevChat nav={nav}/>}
      <StatusBar status={status}/>
      <div style={{display:'flex',flex:1,overflow:'hidden'}}>
        {/* Sidebar */}
        <aside style={{width:collapsed?52:196,flexShrink:0,borderRight:'0.5px solid var(--border)',display:'flex',flexDirection:'column',transition:'width 0.2s',overflow:'hidden',background:'var(--bg-secondary)'}}>
          <div style={{padding:collapsed?'14px 8px':'14px 14px',borderBottom:'0.5px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',minHeight:52}}>
            {!collapsed && <span style={{fontWeight:500,fontSize:15,letterSpacing:'-0.3px'}}>CaiShen</span>}
            <button onClick={()=>setCollapsed(!collapsed)} style={{background:'none',border:'none',padding:4,marginLeft:collapsed?0:'auto',color:'var(--text-muted)'}} aria-label="Toggle sidebar">
              <Icon name={collapsed?'ti-layout-sidebar-right':'ti-layout-sidebar'} size={17}/>
            </button>
          </div>
          <nav style={{flex:1,padding:'8px 0',overflowY:'auto'}}>
            {!collapsed && <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:'8px 14px 4px',textTransform:'uppercase',letterSpacing:'0.8px'}}>Overview</p>}
            <NavBtn id="dashboard" label="Dashboard" icon="ti-layout-dashboard" active={nav==='dashboard'} collapsed={collapsed} color="var(--blue)" onClick={()=>{ setNav('dashboard'); setTrail([{id:'dashboard',label:'Dashboard'}]) }}/>
            <NavBtn id="cash" label="Banking" icon="ti-building-bank" active={nav==='cash'} collapsed={collapsed} color="var(--green)" onClick={()=>go('cash','Banking')}/>
            {/* Mortgage + Insurance live under Real Estate below; keep them reachable here if the RE class is toggled off */}
            {!enabledClasses.includes('re') && <>
              <NavBtn id="mortgage" label="Mortgage" icon="ti-home-dollar" active={nav==='mortgage'} collapsed={collapsed} color="var(--purple)" onClick={()=>go('mortgage','Mortgage')}/>
              <NavBtn id="insurance" label="Insurance" icon="ti-shield-dollar" active={nav==='insurance'} collapsed={collapsed} color="var(--teal)" onClick={()=>go('insurance','Insurance')}/>
            </>}
            {/* Asset Classes — opt-in */}
            {!collapsed && (
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',margin:'12px 14px 4px'}}>
                <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:0,textTransform:'uppercase',letterSpacing:'0.8px'}}>Asset Classes</p>
                <button ref={addClassRef} title="Add asset class"
                  onClick={e => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    setAddClassPos({ top: rect.bottom + 6, left: rect.left })
                    setShowAddClass(v => !v)
                  }}
                  style={{background:'none',border:'none',padding:'2px 4px',color: showAddClass ? 'var(--text-primary)' : 'var(--text-muted)',cursor:'pointer',display:'flex',alignItems:'center',borderRadius:4}}>
                  <Icon name={showAddClass ? 'ti-x' : 'ti-plus'} size={13}/>
                </button>
              </div>
            )}
            {collapsed && (
              <button ref={addClassRef} title="Add asset class"
                onClick={e => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setAddClassPos({ top: rect.top, left: rect.right + 6 })
                  setShowAddClass(v => !v)
                }}
                style={{display:'flex',alignItems:'center',justifyContent:'center',width:'100%',padding:'7px 0',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer'}}>
                <Icon name="ti-plus" size={15}/>
              </button>
            )}
            {enabledClasses.map(id=>{
              const a = ASSET_CLASSES.find(x=>x.id===id)
              if(!a || (a.devOnly && !IS_LOCALHOST)) return null
              // Mortgage + Insurance render as tabs inside the Real Estate page, so the RE
              // entry stays highlighted while either of them is open.
              const active = nav===a.id || (a.id==='re' && (nav.startsWith('prop_') || nav==='mortgage' || nav==='insurance'))
              return (
                <NavBtn key={a.id} id={a.id} label={a.label} icon={a.icon} active={active} collapsed={collapsed} color={a.color}
                  onClick={()=>{ setNav(a.id); setTrail([{id:'dashboard',label:'Dashboard'},{id:a.id,label:a.label}]) }}/>
              )
            })}
            {!collapsed && <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:'12px 14px 4px',textTransform:'uppercase',letterSpacing:'0.8px'}}>Tools</p>}
            {NAV_TOOLS.filter(t => (!t.adminOnly || isAdmin) && (!t.localhostOnly || IS_LOCALHOST)).map(t=>(
              <NavBtn key={t.id} id={t.id} label={t.label} icon={t.icon} active={nav===t.id} collapsed={collapsed} color="var(--blue)"
                onClick={()=>go(t.id,t.label)}/>
            ))}
          </nav>
          <div style={{padding: collapsed ? '10px 8px' : '10px 14px', borderTop:'0.5px solid var(--border)', display:'flex', alignItems:'center', justifyContent: collapsed ? 'center' : 'space-between'}}>
            {!collapsed && (
              <div>
                <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>{auth.user.displayName || auth.user.username}</p>
                <p style={{fontSize:10,color:'var(--text-muted)',margin:'1px 0 0',textTransform:'uppercase',letterSpacing:'0.5px'}}>{auth.user.role}</p>
              </div>
            )}
            <button onClick={onLogout} title="Sign out" style={{background:'none',border:'none',color:'var(--text-muted)',padding:4,cursor:'pointer'}}>
              <Icon name="ti-logout" size={15}/>
            </button>
          </div>
        </aside>

        {/* Main */}
        <main style={{flex:1,overflow:'auto',padding:'22px 26px',minWidth:0}}>
          <Breadcrumb trail={trail} onNav={navBC}/>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
            <div>
              <h1 style={{margin:0,fontSize:20,fontWeight:500}}>{curLabel}</h1>
              <p style={{margin:'2px 0 0',fontSize:12,color:'var(--text-secondary)'}}>
                {new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
              </p>
            </div>
            <div style={{display:'flex',gap:8}}>
              <button onClick={addAccount} disabled={plaidConnecting} style={{fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>
                <Icon name="ti-plus" size={14}/> {plaidConnecting ? 'Opening…' : 'Add Account'}
              </button>
            </div>
          </div>
          {plaidLinkError && (
            <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--coral-light)',borderRadius:'var(--radius-md)',marginBottom:16,fontSize:13,color:'var(--coral)',border:'0.5px solid var(--coral)'}}>
              <Icon name="ti-alert-circle" size={15}/> {plaidLinkError}
              <button onClick={()=>setPlaidLinkError(null)} style={{marginLeft:'auto',background:'none',border:'none',color:'var(--coral)',padding:0}}>✕</button>
            </div>
          )}
          <ErrorBoundary key={nav}>{renderContent()}</ErrorBoundary>
        </main>
      </div>

      {/* Asset class picker — fixed so it escapes sidebar overflow:hidden */}
      {showAddClass && (
        <div ref={addDropdownRef} style={{position:'fixed',top:addClassPos.top,left:addClassPos.left,zIndex:500,background:'var(--bg-primary)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',padding:'6px',minWidth:230,boxShadow:'0 10px 30px rgba(0,0,0,0.4)'}}>
          <p style={{fontSize:11,color:'var(--text-muted)',margin:'4px 10px 8px',textTransform:'uppercase',letterSpacing:'0.6px'}}>Asset Modules</p>
          {ASSET_CLASSES.map(a=>{
            const enabled = enabledClasses.includes(a.id)
            return (
              <button key={a.id}
                onClick={()=> enabled ? toggleClass(a.id) : addClass(a.id)}
                style={{display:'flex',alignItems:'center',gap:12,width:'100%',padding:'10px 12px',background:'none',border:'none',borderRadius:'var(--radius-sm)',color: enabled ? 'var(--text-primary)' : 'var(--text-secondary)',cursor:'pointer',fontSize:14,textAlign:'left'}}
                onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
                onMouseLeave={e=>e.currentTarget.style.background='none'}>
                <div style={{width:30,height:30,borderRadius:'var(--radius-sm)',background: enabled ? a.color.replace('var(--','var(--').replace(')','-light)') : 'var(--bg-secondary)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <Icon name={a.icon} size={16} color={enabled ? a.color : 'var(--text-muted)'}/>
                </div>
                <span style={{flex:1}}>{a.label}</span>
                <Icon name={enabled ? 'ti-x' : 'ti-plus'} size={13} color={enabled ? 'var(--coral)' : 'var(--text-muted)'}/>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function NavBtn({id, label, icon, active, collapsed, color, onClick}) {
  return (
    <button onClick={onClick} title={collapsed?label:undefined}
      style={{width:'100%',display:'flex',alignItems:'center',gap:9,padding:collapsed?'9px 14px':'9px 14px',background:active?'var(--bg-hover)':'none',border:'none',borderLeft:active?`3px solid ${color}`:'3px solid transparent',borderRadius:0,color:active?'var(--text-primary)':'var(--text-secondary)',fontWeight:active?500:400,fontSize:13,cursor:'pointer',whiteSpace:'nowrap',justifyContent:collapsed?'center':'flex-start'}}>
      <Icon name={icon} size={17} color={active?color:undefined}/>
      {!collapsed && label}
    </button>
  )
}