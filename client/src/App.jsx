import { useState, useEffect, useRef, createContext, useContext } from 'react'
import axios from 'axios'
import Projections from './Projections'
import PersonalSpending from './PersonalSpending'
import TransactionTransfer from './TransactionTransfer'
import DataVault from './DataVault'
import Advisor from './Advisor'
import Accounting from './Accounting'
import Crypto from './Crypto'
import Banking, { classifyAccount } from './Banking'
import Login from './Login'
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

// ── Static demo data (replaced by API data once connected) ───────────
const DEMO_PROPS = [
  {id:'haas',name:'Haas',addr:'123 Haas Ave, LA',value:1250000,mortgage:780000,rate:3.875,rent:6500,exp:2800,sqft:2400,yr:2005,color:'var(--blue)'},
  {id:'kobe',name:'Kobe',addr:'456 Kobe Blvd, LA',value:980000,mortgage:610000,rate:4.125,rent:5200,exp:2100,sqft:1950,yr:2010,color:'var(--teal)'},
  {id:'bayhill',name:'Bay Hill',addr:'789 Bay Hill Dr, SF',value:1680000,mortgage:1050000,rate:3.5,rent:8800,exp:3500,sqft:3100,yr:1998,color:'var(--purple)'},
  {id:'muirfield',name:'Muirfield',addr:'321 Muirfield Ln, SD',value:2100000,mortgage:1320000,rate:3.25,rent:10500,exp:4200,sqft:3800,yr:2015,color:'var(--amber)'},
  {id:'alcita',name:'Alcita',addr:'654 Alcita Ct, OC',value:875000,mortgage:540000,rate:4.25,rent:4800,exp:1900,sqft:1700,yr:2008,color:'var(--coral)'},
]
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
  {id:'equity',    label:'Equities',         icon:'ti-chart-candle',      color:'var(--purple)'},
  {id:'retirement',label:'Retirement',       icon:'ti-briefcase',         color:'var(--teal)'},
  {id:'crypto',    label:'Crypto',           icon:'ti-currency-bitcoin',  color:'var(--amber)'},
]
const NAV_TOOLS = [
  {id:'connections',   label:'Connections',   icon:'ti-plug',             adminOnly:false},
  {id:'data',          label:'Data Vault',    icon:'ti-database',         adminOnly:false},
  {id:'taxes',         label:'Tax Center',    icon:'ti-receipt-tax',      adminOnly:false},
  {id:'projections',   label:'Projections',   icon:'ti-trending-up',      adminOnly:false},
  {id:'transactions',  label:'Transactions',  icon:'ti-arrows-exchange',  adminOnly:false},
  {id:'accounting',    label:'Report',        icon:'ti-building-bank',    adminOnly:false},
  {id:'advisor',       label:'AI Advisor',    icon:'ti-brain',            adminOnly:false},
  {id:'settings',      label:'Settings',      icon:'ti-settings',         adminOnly:false},
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
  const reVal  = properties.reduce((s,p)=>s+p.value,0)
  const reMort = properties.reduce((s,p)=>s+p.mortgage,0)
  const reEquity = reVal-reMort
  const noi      = properties.reduce((s,p)=>s+(p.rent-p.exp),0)

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
    {id:'personal',  label:'Personal Spending',icon:'ti-receipt',          color:'var(--pink)',   val: null, sub: 'view spending breakdown'},
  ]
  const dashModules = ALL_MODULES.filter(m =>
    (m.id === 'personal' && hasTransactions) || enabledClasses.includes(m.id)
  )

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
        <MetricCard label="RE Equity" value={fd(reEquity)} sub={reVal>0?((reEquity/reVal)*100).toFixed(0)+'% of RE value':undefined} subColor="var(--teal)" icon="ti-building-estate" iconColor="var(--teal)"/>
        <MetricCard label="Monthly NOI" value={fd(noi)} sub={noi>0?fd(noi*12)+'/year':undefined} subColor="var(--teal)" icon="ti-cash" iconColor="var(--teal)"/>
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
const BLANK_PROP = {name:'',addr:'',value:'',mortgage:'',rate:'',rent:'',exp:'',sqft:'',yr:'',color:'var(--blue)'}

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
          <div style={{gridColumn:'1/-1'}}>{field('Property name','name','text','e.g. Haas')}</div>
          <div style={{gridColumn:'1/-1'}}>{field('Address','addr','text','123 Main St, Los Angeles CA')}</div>
          {field('Market value ($)','value','number','1250000')}
          {field('Mortgage balance ($)','mortgage','number','780000')}
          {field('Interest rate (%)','rate','number','3.875')}
          {field('Monthly rent ($)','rent','number','6500')}
          {field('Monthly expenses ($)','exp','number','2800')}
          {field('Square footage','sqft','number','2400')}
          {field('Year built','yr','number','2005')}
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
            <button onClick={()=>onSave(form)} disabled={saving||!form.name||!form.value}
              style={{fontSize:12,background:'var(--blue)',color:'#fff',border:'none',borderRadius:'var(--radius-md)',padding:'8px 16px',cursor:'pointer',fontWeight:500}}>
              {saving?'Saving…':isEdit?'Save changes':'Add property'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RealEstateDash({onProp, properties, onRefresh}) {
  const [showForm, setShowForm]   = useState(false)
  const [editProp, setEditProp]   = useState(null)
  const [saving, setSaving]       = useState(false)

  const reVal    = properties.reduce((s,p)=>s+p.value,0)
  const reEquity = properties.reduce((s,p)=>s+(p.value-p.mortgage),0)
  const noi      = properties.reduce((s,p)=>s+(p.rent-p.exp),0)

  const openAdd  = () => { setEditProp(null); setShowForm(true) }
  const openEdit = (p,e) => { e.stopPropagation(); setEditProp(p); setShowForm(true) }

  const saveProperty = async (form) => {
    setSaving(true)
    const body = {
      ...form,
      value:form.value?Number(form.value):0, mortgage:form.mortgage?Number(form.mortgage):0,
      rate:form.rate?Number(form.rate):0, rent:form.rent?Number(form.rent):0,
      exp:form.exp?Number(form.exp):0, sqft:form.sqft?Number(form.sqft):undefined,
      yr:form.yr?Number(form.yr):undefined,
    }
    try {
      if (form.id) await axios.put(`${API}/properties/${form.id}`, body)
      else         await axios.post(`${API}/properties`, body)
      await onRefresh()
      setShowForm(false)
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
          onClose={()=>setShowForm(false)}
          saving={saving}/>
      )}

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,flex:1,marginRight:12}}>
          <MetricCard label="Portfolio Value" value={fd(reVal)} icon="ti-building-estate" iconColor="var(--blue)"/>
          <MetricCard label="Total Equity" value={fd(reEquity)} sub={reVal>0?((reEquity/reVal)*100).toFixed(0)+'% of value':undefined} subColor="var(--teal)" icon="ti-trending-up" iconColor="var(--teal)"/>
          <MetricCard label="Monthly NOI" value={fd(noi)} sub={noi>0?fd(noi*12)+'/year':undefined} subColor="var(--green)" icon="ti-cash" iconColor="var(--green)"/>
        </div>
        <button onClick={openAdd} style={{flexShrink:0,fontSize:12,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)',whiteSpace:'nowrap'}}>
          <Icon name="ti-plus" size={13}/> Add property
        </button>
      </div>

      {properties.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'3rem'}}>
          <Icon name="ti-building-estate" size={40} color="var(--text-muted)"/>
          <p style={{fontSize:15,fontWeight:500,margin:'14px 0 6px'}}>No properties yet</p>
          <p style={{fontSize:13,color:'var(--text-secondary)',marginBottom:16}}>Add your real estate portfolio to track values, equity, and cash flow.</p>
          <button onClick={openAdd} style={{fontSize:13,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>
            <Icon name="ti-plus" size={14}/> Add your first property
          </button>
        </div>
      ) : (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          {properties.map(p=>{
            const pnoi=p.rent-p.exp, roi=((pnoi*12)/p.value*100).toFixed(1), ltv=((p.mortgage/p.value)*100).toFixed(0)
            return (
              <div key={p.id} onClick={()=>onProp(p.id,p.name)} className="card" style={{cursor:'pointer',transition:'border-color 0.15s'}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=p.color}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{width:34,height:34,borderRadius:'var(--radius-md)',background:'var(--blue-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <Icon name="ti-building-estate" size={17} color={p.color}/>
                    </div>
                    <div>
                      <p style={{fontWeight:500,fontSize:14,margin:0}}>{p.name}</p>
                      <p style={{fontSize:11,color:'var(--text-secondary)',margin:0}}>{p.sqft?.toLocaleString()} sqft{p.yr?` · ${p.yr}`:''}</p>
                    </div>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span className="badge" style={{background:'var(--teal-light)',color:'var(--teal)'}}>{roi}% ROI</span>
                    <button onClick={e=>openEdit(p,e)} style={{background:'none',border:'none',color:'var(--text-muted)',padding:4,cursor:'pointer',fontSize:14,lineHeight:1}} title="Edit">
                      <Icon name="ti-pencil" size={13}/>
                    </button>
                  </div>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10}}>
                  {[['Value',fd(p.value)],['Equity',fd(p.value-p.mortgage)],['NOI/mo',fd(pnoi)]].map(([l,v])=>(
                    <div key={l} style={{background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',padding:'6px 8px'}}>
                      <p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 2px'}}>{l}</p>
                      <p style={{fontSize:13,fontWeight:500,margin:0}}>{v}</p>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--text-muted)',marginBottom:3}}>
                    <span>LTV {ltv}%</span><span>{p.rate}% rate</span>
                  </div>
                  <div style={{height:3,background:'var(--bg-secondary)',borderRadius:2}}>
                    <div style={{height:3,width:Math.min(100,ltv)+'%',background:p.color,borderRadius:2}}/>
                  </div>
                </div>
                {p.addr && <p style={{fontSize:11,color:'var(--text-muted)',margin:'8px 0 0'}}>{p.addr}</p>}
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

  const noi=p.rent-p.exp, monthly=p.mortgage*(p.rate/100)/12

  const saveProperty = async (form) => {
    setSaving(true)
    const body={...form,value:Number(form.value),mortgage:Number(form.mortgage),rate:Number(form.rate),rent:Number(form.rent),exp:Number(form.exp),sqft:form.sqft?Number(form.sqft):undefined,yr:form.yr?Number(form.yr):undefined}
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
          <p style={{margin:0,fontSize:13,color:'var(--text-secondary)'}}>{p.addr}{p.sqft?` · ${p.sqft.toLocaleString()} sqft`:''}{p.yr?` · Built ${p.yr}`:''}</p>
        </div>
        <button onClick={()=>setShowForm(true)} style={{fontSize:12}}>
          <Icon name="ti-pencil" size={13}/> Edit
        </button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        {[['Market Value',fd(p.value)],['Equity',fd(p.value-p.mortgage)],['Mortgage',fd(p.mortgage)],['Rate',p.rate+'%']].map(([l,v])=>(
          <MetricCard key={l} label={l} value={v}/>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Monthly cash flow</p>
          {[
            ['Rental income',    p.rent,                   true],
            ['Mortgage payment', -Math.round(monthly),      false],
            ['Other expenses',   -(p.exp-Math.round(monthly)), false],
            ['Net cash flow',    noi-Math.round(monthly),   noi>Math.round(monthly)],
          ].map(([l,v,pos])=>(
            <div className="row" key={l}>
              <span style={{color:'var(--text-secondary)'}}>{l}</span>
              <span style={{fontWeight:l==='Net cash flow'?500:400,color:pos?'var(--teal)':'var(--coral)'}}>{v>0?'+':''}{fd(v)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Mortgage details</p>
          {[
            ['Balance',          fd(p.mortgage)],
            ['Rate',             p.rate+'%'],
            ['Monthly payment',  fd(Math.round(monthly))],
            ['LTV',              ((p.mortgage/p.value)*100).toFixed(1)+'%'],
            ['Annual interest',  fd(Math.round(p.mortgage*(p.rate/100)))],
          ].map(([l,v])=>(
            <div className="row" key={l}><span style={{color:'var(--text-secondary)'}}>{l}</span><span style={{fontWeight:500}}>{v}</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}


// ── Statements Panel ──────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function StatementsPanel() {
  const [activeTab, setActiveTab]   = useState('monthly')
  const [months, setMonths]         = useState([])
  const [loading, setLoading]       = useState(true)
  const [generating, setGenerating] = useState({})
  const [genAllBusy, setGenAllBusy] = useState(false)
  const [expandedAcct, setExpandedAcct] = useState(null)
  const [result, setResult]         = useState(null)

  const fetchMonths = async () => {
    setLoading(true)
    try {
      const r = await axios.get(`${API}/statements/months`)
      const data = Array.isArray(r.data) ? r.data : []
      setMonths(data)
      if (data.length > 0 && !expandedAcct) setExpandedAcct(data[0].id)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { fetchMonths() }, [])

  const generateOne = async (accountId, month) => {
    const key = `${accountId}:${month}`
    setGenerating(g => ({ ...g, [key]: true }))
    try {
      await axios.post(`${API}/statements/generate-single`, { accountId, month })
      await fetchMonths()
    } catch (e) {
      setResult({ error: e.response?.data?.error || e.message })
    }
    setGenerating(g => ({ ...g, [key]: false }))
  }

  const generateAll = async () => {
    setGenAllBusy(true); setResult(null)
    try {
      const r = await axios.post(`${API}/statements/generate`)
      setResult(r.data)
      await fetchMonths()
    } catch (e) {
      setResult({ error: e.response?.data?.error || e.message })
    }
    setGenAllBusy(false)
  }

  const totalMissing = months.reduce((s, a) => s + (a.missingCount || 0), 0)

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14 }}>
        <div style={{ width:38, height:38, borderRadius:'var(--radius-md)', background:'var(--teal-light)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          <i className="ti ti-file-description" style={{ fontSize:19, color:'var(--teal)' }} aria-hidden="true"/>
        </div>
        <div style={{ flex:1 }}>
          <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Statements</p>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0 }}>
            {loading ? 'Checking…' : totalMissing > 0 ? `${totalMissing} statement${totalMissing !== 1 ? 's' : ''} not yet generated` : 'All statements up to date'}
          </p>
        </div>
        {!loading && totalMissing > 0 && (
          <button onClick={generateAll} disabled={genAllBusy}
            style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)', whiteSpace:'nowrap' }}>
            <i className={`ti ${genAllBusy ? 'ti-loader-2 spin' : 'ti-wand'}`} aria-hidden="true"/>
            {' '}{genAllBusy ? 'Generating…' : `Generate ${totalMissing} Missing`}
          </button>
        )}
      </div>

      {/* Result banner */}
      {result && (
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:'var(--radius-sm)', background: result.error ? 'var(--coral-light)' : 'var(--teal-light)', border:`0.5px solid ${result.error ? 'var(--coral)' : 'var(--teal)'}`, color: result.error ? 'var(--coral)' : 'var(--teal)', fontSize:12, marginBottom:12 }}>
          <i className={`ti ${result.error ? 'ti-alert-circle' : 'ti-circle-check'}`} aria-hidden="true"/>
          {result.error || (result.generated === 0
            ? `All statements already exist (${result.skipped} total)`
            : `Generated ${result.generated} PDF${result.generated !== 1 ? 's' : ''} → Data Vault`)}
          <button onClick={() => setResult(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'inherit', padding:0, cursor:'pointer' }}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:'0.5px solid var(--border)', marginBottom:12 }}>
        {[['monthly','Monthly Statements','ti-calendar-month'],['tax','Tax Forms','ti-receipt-tax'],['escrow','Escrow','ti-home-dollar']].map(([tab, label, icon]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{ fontSize:12, padding:'7px 14px', border:'none', borderRadius:0, borderBottom: activeTab === tab ? '2px solid var(--teal)' : '2px solid transparent', background:'none', color: activeTab === tab ? 'var(--teal)' : 'var(--text-secondary)', fontWeight: activeTab === tab ? 500 : 400, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}>
            <i className={`ti ${icon}`} aria-hidden="true"/>{label}
          </button>
        ))}
      </div>

      {/* Monthly tab */}
      {activeTab === 'monthly' && (
        loading ? (
          <div style={{ padding:'16px', textAlign:'center', color:'var(--text-secondary)', fontSize:12 }}>
            <i className="ti ti-loader-2 spin" aria-hidden="true"/> Loading statement availability…
          </div>
        ) : months.length === 0 ? (
          <p style={{ fontSize:12, color:'var(--text-secondary)', textAlign:'center', padding:'16px 0 4px' }}>
            No Plaid accounts connected. Connect a bank to start generating statements.
          </p>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {months.map(acct => (
              <div key={acct.id} style={{ border:`0.5px solid ${acct.missingCount > 0 ? 'var(--border)' : 'var(--teal)'}`, borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
                {/* Account header row */}
                <button onClick={() => setExpandedAcct(expandedAcct === acct.id ? null : acct.id)}
                  style={{ width:'100%', display:'flex', alignItems:'center', gap:10, padding:'9px 12px', background:'var(--bg-secondary)', border:'none', cursor:'pointer', borderBottom: expandedAcct === acct.id ? '0.5px solid var(--border)' : 'none' }}>
                  <i className="ti ti-building-bank" style={{ fontSize:14, color:'var(--blue)', flexShrink:0 }} aria-hidden="true"/>
                  <span style={{ fontSize:13, fontWeight:500, flex:1, textAlign:'left', color:'var(--text-primary)' }}>
                    {acct.name}{acct.last4 ? ` ••••${acct.last4}` : ''}
                    <span style={{ color:'var(--text-muted)', fontWeight:400, fontSize:11 }}>{' '}({acct.institution})</span>
                  </span>
                  <span style={{ fontSize:11, color: acct.missingCount > 0 ? 'var(--amber)' : 'var(--teal)', flexShrink:0 }}>
                    {acct.missingCount > 0 ? `${acct.missingCount} missing` : '✓ all generated'}
                  </span>
                  <i className={`ti ${expandedAcct === acct.id ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize:12, color:'var(--text-muted)', flexShrink:0 }} aria-hidden="true"/>
                </button>

                {/* Month grid */}
                {expandedAcct === acct.id && (
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(120px, 1fr))', gap:6, padding:12 }}>
                    {acct.months.map(m => {
                      const key = `${acct.id}:${m.month}`
                      const busy = !!generating[key]
                      const [y, mo] = m.month.split('-')
                      const label  = `${MONTH_NAMES[parseInt(mo,10)-1]} ${y}`
                      return (
                        <div key={m.month} style={{ display:'flex', flexDirection:'column', gap:4, padding:'8px 10px', background:'var(--bg-card)', borderRadius:'var(--radius-sm)', border:`0.5px solid ${m.hasStatement ? 'var(--teal)' : 'var(--border)'}` }}>
                          <span style={{ fontSize:12, fontWeight:500, color: m.hasStatement ? 'var(--teal)' : 'var(--text-primary)' }}>{label}</span>
                          <span style={{ fontSize:10, color:'var(--text-muted)' }}>{m.txCount} transaction{m.txCount !== 1 ? 's' : ''}</span>
                          {m.hasStatement ? (
                            <span style={{ fontSize:11, color:'var(--teal)', display:'flex', alignItems:'center', gap:4 }}>
                              <i className="ti ti-circle-check" aria-hidden="true"/> PDF ready
                            </span>
                          ) : (
                            <button onClick={() => generateOne(acct.id, m.month)} disabled={busy}
                              style={{ fontSize:10, padding:'3px 8px', background:'var(--blue-light)', color:'var(--blue)', border:'0.5px solid var(--blue)', borderRadius:'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer', display:'flex', alignItems:'center', gap:4 }}>
                              {busy ? <><i className="ti ti-loader-2 spin" aria-hidden="true"/> Generating…</> : <><i className="ti ti-sparkles" aria-hidden="true"/> Generate</>}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* Tax Forms tab (placeholder) */}
      {activeTab === 'tax' && (
        <div style={{ padding:'24px', textAlign:'center', color:'var(--text-secondary)' }}>
          <i className="ti ti-receipt-tax" style={{ fontSize:36, display:'block', marginBottom:10, color:'var(--text-muted)' }} aria-hidden="true"/>
          <p style={{ fontSize:13, margin:'0 0 6px', color:'var(--text-primary)', fontWeight:500 }}>Tax form generation coming soon</p>
          <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>Will include Schedule A, 1098, and 1099 summaries from your transaction data.</p>
        </div>
      )}

      {/* Escrow tab (placeholder) */}
      {activeTab === 'escrow' && (
        <div style={{ padding:'24px', textAlign:'center', color:'var(--text-secondary)' }}>
          <i className="ti ti-home-dollar" style={{ fontSize:36, display:'block', marginBottom:10, color:'var(--text-muted)' }} aria-hidden="true"/>
          <p style={{ fontSize:13, margin:'0 0 6px', color:'var(--text-primary)', fontWeight:500 }}>Escrow statement generation coming soon</p>
          <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>Auto-generate monthly escrow reports per property once linked.</p>
        </div>
      )}
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

function ConnectionsScreen({status, accounts, onSync}) {
  const [syncing, setSyncing]               = useState(false)
  const [historyRunning, setHistoryRunning] = useState(false)
  const [plaidConns, setPlaidConns]         = useState([])
  const [linkToken, setLinkToken]           = useState(null)
  const [linkError, setLinkError]           = useState(null)
  const [qbStatus, setQbStatus]             = useState(null)
  const [connecting, setConnecting]         = useState(false)
  const [stmtResult, setStmtResult]         = useState(null)
  const [showHistoryWarning, setShowHistoryWarning] = useState(false)

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

  // Get Plaid Link token from backend
  const getLinkToken = async () => {
    setConnecting(true)
    setLinkError(null)
    try {
      const res = await axios.post(`${API}/plaid/create-link-token`)
      setLinkToken(res.data.link_token)
    } catch (e) {
      setLinkError(e.response?.data?.error || e.message)
      setConnecting(false)
    }
  }

  // Pull full 2-year transaction history from Plaid then generate all statements
  const syncFullHistory = async () => {
    setHistoryRunning(true)
    setStmtResult(null)
    setLinkError(null)
    try {
      await axios.post(`${API}/plaid/sync-history`)
      // Server responds immediately and processes async — wait then generate statements.
      // SSE will also push data-updated when the sync finishes on the server.
      setTimeout(async () => {
        try {
          const [connsRes, stmtRes] = await Promise.all([
            axios.get(`${API}/plaid/connections`),
            axios.post(`${API}/statements/generate`)
          ])
          setPlaidConns(Array.isArray(connsRes.data) ? connsRes.data : [])
          setStmtResult(stmtRes.data)
          onSync?.()
        } catch {}
        setHistoryRunning(false)
      }, 45000)
    } catch (e) {
      setLinkError(e.response?.data?.error || e.message)
      setHistoryRunning(false)
    }
  }

  // Plaid Link config
  const plaidConfig = {
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        await axios.post(`${API}/plaid/exchange-token`, {
          public_token: publicToken,
          institution_name: metadata.institution?.name || 'Unknown'
        })
        const res = await axios.get(`${API}/plaid/connections`)
        setPlaidConns(Array.isArray(res.data) ? res.data : [])
        setLinkToken(null)
        onSync?.()
      } catch (e) {
        setLinkError('Failed to connect account: ' + e.message)
      }
      setConnecting(false)
    },
    onExit: () => {
      setLinkToken(null)
      setConnecting(false)
    },
    onEvent: () => {}
  }

  const { open: openPlaidLink, ready: plaidReady } = usePlaidLink(
    linkToken ? plaidConfig : { token: null, onSuccess: () => {} }
  )

  // Auto-open Plaid Link once token is ready
  useEffect(() => {
    if (linkToken && plaidReady) {
      openPlaidLink()
    }
  }, [linkToken, plaidReady, openPlaidLink])

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
      {stmtResult && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background: stmtResult.error ? 'var(--coral-light)' : 'var(--teal-light)', borderRadius:'var(--radius-md)', marginBottom:16, fontSize:13, color: stmtResult.error ? 'var(--coral)' : 'var(--teal)', border:`0.5px solid ${stmtResult.error ? 'var(--coral)' : 'var(--teal)'}` }}>
          <i className={`ti ${stmtResult.error ? 'ti-alert-circle' : 'ti-circle-check'}`} style={{ fontSize:15 }} aria-hidden="true"/>
          {stmtResult.error
            ? stmtResult.error
            : stmtResult.generated === 0
              ? `All statements up to date — ${stmtResult.skipped} PDF${stmtResult.skipped !== 1 ? 's' : ''} already in Data Vault`
              : `Generated ${stmtResult.generated} new statement PDF${stmtResult.generated !== 1 ? 's' : ''} → Data Vault${stmtResult.skipped ? ` (${stmtResult.skipped} already existed)` : ''}`
          }
          <button onClick={()=>setStmtResult(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'inherit', padding:0 }}>✕</button>
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
            <button onClick={getLinkToken} disabled={connecting || !status?.plaidConfigured}
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
                title="Pull up to 2 years of transaction history from Plaid, then generate statements for every month found"
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

      {/* Statement Generation Panel */}
      <StatementsPanel />

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

const AUTH_API = 'http://localhost:3001/api/auth'

function SettingsScreen({ auth }) {
  const [twoFaStatus, setTwoFaStatus] = useState(null)
  const [setupStep, setSetupStep]     = useState(null)  // null | 'scanning' | 'done'
  const [qrData, setQrData]           = useState(null)
  const [code, setCode]               = useState('')
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState('')
  const [success, setSuccess]         = useState('')
  const [exporting, setExporting]     = useState(false)

  useEffect(() => {
    axios.get(`${AUTH_API}/2fa/status`)
      .then(r => setTwoFaStatus(r.data))
      .catch(() => {})
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

  const renderContent = () => {
    if(nav==='dashboard') return <MainDashboard onDrill={drill} accounts={accounts} transactions={transactions} properties={properties} onConnect={()=>go('connections','Connections')} enabledClasses={enabledClasses} hasTransactions={transactions.length>0}/>
    const refreshProps = () => axios.get(`${API}/properties`).then(r=>setProperties(r.data||[])).catch(()=>{})
    if(nav==='re') return <RealEstateDash onProp={(id,name)=>drill('prop_'+id,name)} properties={properties} onRefresh={refreshProps}/>
    if(nav.startsWith('prop_')) return <PropertyDetail propId={nav.replace('prop_','')} properties={properties} onRefresh={refreshProps}/>
    if(nav==='personal') return <PersonalSpending transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='transactions') return <TransactionTransfer transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='connections') return <ConnectionsScreen status={status} accounts={accounts} onSync={()=>{ axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])); axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])) }}/>
    if(nav==='equity') return <PlaceholderScreen label="Equities"/>
    if(nav==='retirement') return <PlaceholderScreen label="Retirement"/>
    if(nav==='crypto') return <Crypto/>
    if(nav==='cash') return <Banking accounts={accounts} transactions={transactions}/>
    if(nav==='taxes') return <PlaceholderScreen label="Tax Center"/>
    if(nav==='projections') return <Projections/>
    if(nav==='advisor')    return <Advisor/>
    if(nav==='accounting') return <Accounting/>
    if(nav==='data')       return <DataVault accounts={accounts} transactions={transactions} onImportTransactions={txs=>setTransactions(prev=>[...prev,...txs])} onTransactionsChanged={()=>{ axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{}); axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{}) }}/>
    if(nav==='settings')   return <SettingsScreen auth={auth}/>
    return null
  }

  const curLabel = trail[trail.length-1]?.label || 'Dashboard'

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100vh'}}>
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
              if(!a) return null
              return (
                <NavBtn key={a.id} id={a.id} label={a.label} icon={a.icon} active={nav===a.id||(nav.startsWith('prop_')&&a.id==='re')} collapsed={collapsed} color={a.color}
                  onClick={()=>{ setNav(a.id); setTrail([{id:'dashboard',label:'Dashboard'},{id:a.id,label:a.label}]) }}/>
              )
            })}
            {transactions.length > 0 && (
              <NavBtn id="personal" label="Personal Spending" icon="ti-receipt" active={nav==='personal'} collapsed={collapsed} color="var(--pink)" onClick={()=>go('personal','Personal Spending')}/>
            )}

            {!collapsed && <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:'12px 14px 4px',textTransform:'uppercase',letterSpacing:'0.8px'}}>Tools</p>}
            {NAV_TOOLS.filter(t => !t.adminOnly || isAdmin).map(t=>(
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
              <button onClick={()=>go('connections','Connections')} style={{fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>
                <Icon name="ti-plus" size={14}/> Add Account
              </button>
              <button onClick={()=>go('advisor','AI Advisor')} style={{background:'var(--purple-light)',color:'var(--purple)',borderColor:'var(--purple)',fontSize:12}}>
                <Icon name="ti-brain" size={14}/> AI Advisor
              </button>
            </div>
          </div>
          {renderContent()}
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