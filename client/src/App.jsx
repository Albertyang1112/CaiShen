import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import Projections from './Projections'
import PersonalSpending from './PersonalSpending'
import TransactionTransfer from './TransactionTransfer'
import DataVault from './DataVault'

const API = 'http://localhost:3001/api'

// ── Formatting ────────────────────────────────────────────────────────
const fmt = (n, d=0) => { if(Math.abs(n)>=1e6) return (n/1e6).toFixed(1)+'M'; if(Math.abs(n)>=1e3) return (n/1e3).toFixed(d)+'K'; return Math.abs(n).toFixed(d); }
const fd = (n, d=0) => (n<0?'-$':'$')+fmt(Math.abs(n),d)
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
const ASSET_CLASSES = [
  {id:'re',label:'Real Estate',icon:'ti-building-estate',color:'var(--blue)'},
  {id:'equity',label:'Equities',icon:'ti-chart-candle',color:'var(--purple)'},
  {id:'retirement',label:'Retirement',icon:'ti-piggy-bank',color:'var(--teal)'},
  {id:'crypto',label:'Crypto',icon:'ti-currency-bitcoin',color:'var(--amber)'},
  {id:'cash',label:'Cash',icon:'ti-wallet',color:'var(--green)'},
  {id:'personal',label:'Personal Spending',icon:'ti-receipt',color:'var(--pink)'},
]
const NAV_TOOLS = [
  {id:'connections',label:'Connections',icon:'ti-plug'},
  {id:'data', label:'Data Vault', icon:'ti-database'},
  {id:'taxes',label:'Tax Center',icon:'ti-receipt-tax'},
  {id:'projections',label:'Projections',icon:'ti-trending-up'},
  {id:'transactions', label:'Transactions', icon:'ti-arrows-exchange'},
  {id:'advisor',label:'AI Advisor',icon:'ti-brain'},
  {id:'settings',label:'Settings',icon:'ti-settings'},
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

function StatusBar({status}) {
  if(!status) return null
  return (
    <div style={{display:'flex',alignItems:'center',gap:16,padding:'6px 16px',background:'var(--bg-secondary)',borderBottom:'0.5px solid var(--border)',fontSize:11,color:'var(--text-muted)'}}>
      <span style={{display:'flex',alignItems:'center',gap:5}}>
        <span style={{width:6,height:6,borderRadius:'50%',background:status.plaidConfigured?'var(--teal)':'var(--text-muted)',display:'inline-block'}}/>
        Plaid {status.plaidConfigured?'connected':'not configured'}
      </span>
      <span style={{display:'flex',alignItems:'center',gap:5}}>
        <span style={{width:6,height:6,borderRadius:'50%',background:status.qbConfigured?'var(--teal)':'var(--text-muted)',display:'inline-block'}}/>
        QuickBooks {status.qbConfigured?'connected':'not configured'}
      </span>
      <span style={{marginLeft:'auto'}}>CaiShen v1.0 · Local</span>
    </div>
  )
}

// ── Donut chart ───────────────────────────────────────────────────────
function DonutChart({data, size=180}) {
  const total = data.reduce((s,d)=>s+d.value,0)
  let angle = -90
  const slices = data.map(d=>{
    const deg = (d.value/total)*360, start = angle, end = angle+deg
    angle += deg
    const r = size/2-10, cx = size/2, cy = size/2
    const toRad = a => Math.PI*a/180
    const x1=cx+r*Math.cos(toRad(start)), y1=cy+r*Math.sin(toRad(start))
    const x2=cx+r*Math.cos(toRad(end)), y2=cy+r*Math.sin(toRad(end))
    const ir=r-24
    const ix1=cx+ir*Math.cos(toRad(start)),iy1=cy+ir*Math.sin(toRad(start))
    const ix2=cx+ir*Math.cos(toRad(end)),iy2=cy+ir*Math.sin(toRad(end))
    const large=deg>180?1:0
    return {...d, path:`M${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} L${ix2},${iy2} A${ir},${ir} 0 ${large},0 ${ix1},${iy1} Z`}
  })
  const nw = DEMO_ACCOUNTS.reduce((s,a)=>s+a.balance,0)+DEMO_PROPS.reduce((s,p)=>s+p.value-p.mortgage,0)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((s,i)=><path key={i} d={s.path} fill={s.rawColor} opacity={0.88}/>)}
      <text x={size/2} y={size/2-8} textAnchor="middle" fontSize="14" fontWeight="500" fill="var(--text-primary)">{fd(nw)}</text>
      <text x={size/2} y={size/2+10} textAnchor="middle" fontSize="10" fill="var(--text-secondary)">net worth</text>
    </svg>
  )
}

// ── Screens ───────────────────────────────────────────────────────────
function MainDashboard({onDrill, accounts, properties}) {
  const accs = accounts.length ? accounts : DEMO_ACCOUNTS
  const props = properties.length ? properties : DEMO_PROPS
  const reVal = props.reduce((s,p)=>s+p.value,0)
  const reMort = props.reduce((s,p)=>s+p.mortgage,0)
  const totalAssets = accs.filter(a=>a.balance>0).reduce((s,a)=>s+a.balance,0)+reVal
  const totalLiab = Math.abs(accs.filter(a=>a.balance<0).reduce((s,a)=>s+a.balance,0))+reMort
  const nw = totalAssets-totalLiab
  const reEquity = reVal-reMort
  const noi = props.reduce((s,p)=>s+(p.rent-p.exp),0)

  const donutData = [
    {label:'Real Estate',value:reVal,rawColor:'#378ADD'},
    {label:'Equities',value:342800,rawColor:'#7F77DD'},
    {label:'Retirement',value:218000,rawColor:'#1D9E75'},
    {label:'Crypto',value:212000,rawColor:'#BA7517'},
    {label:'Cash',value:48250,rawColor:'#639922'},
  ]
  const total = donutData.reduce((s,d)=>s+d.value,0)

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:24}}>
        <MetricCard label="Net Worth" value={fd(nw)} sub="+$142K YTD" subColor="var(--teal)" icon="ti-crown" iconColor="var(--amber)"/>
        <MetricCard label="Total Assets" value={fd(totalAssets)} icon="ti-chart-pie" iconColor="var(--blue)"/>
        <MetricCard label="RE Equity" value={fd(reEquity)} sub={((reEquity/reVal)*100).toFixed(0)+'% of RE value'} subColor="var(--teal)" icon="var(--building-estate)" iconColor="var(--teal)"/>
        <MetricCard label="Monthly NOI" value={fd(noi)} sub="Real estate" subColor="var(--teal)" icon="ti-cash" iconColor="var(--teal)"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:24,alignItems:'start'}}>
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
          <DonutChart data={donutData} size={190}/>
          <div style={{display:'flex',flexDirection:'column',gap:5,width:'100%'}}>
            {donutData.map(d=>(
              <div key={d.label} style={{display:'flex',alignItems:'center',gap:8,fontSize:12}}>
                <div style={{width:9,height:9,borderRadius:2,background:d.rawColor,flexShrink:0}}/>
                <span style={{color:'var(--text-secondary)',flex:1}}>{d.label}</span>
                <span style={{fontWeight:500}}>{fd(d.value)}</span>
                <span style={{color:'var(--text-muted)',width:34,textAlign:'right'}}>{((d.value/total)*100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="section-title">Asset classes — click to explore</p>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {ASSET_CLASSES.map(a=>(
              <div key={a.id} onClick={()=>onDrill(a.id,a.label)}
                className="card"
                style={{cursor:'pointer',display:'flex',alignItems:'center',gap:14,padding:'12px 16px',transition:'border-color 0.15s'}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=a.color.replace('var(--','').replace(')','') === a.color ? a.color : 'var(--border-light)'}
                onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{width:38,height:38,borderRadius:'var(--radius-md)',background:a.color.replace(')','-light)').replace('var(--','var(--'),display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,opacity:0.8}}>
                  <Icon name={a.icon} size={19} color={a.color}/>
                </div>
                <div style={{flex:1}}>
                  <p style={{fontSize:14,fontWeight:500,margin:0}}>{a.label}</p>
                </div>
                <Icon name="ti-chevron-right" size={14} color="var(--text-muted)"/>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function RealEstateDash({onProp, properties}) {
  const props = properties.length ? properties : DEMO_PROPS
  const reVal = props.reduce((s,p)=>s+p.value,0)
  const reEquity = props.reduce((s,p)=>s+(p.value-p.mortgage),0)
  const noi = props.reduce((s,p)=>s+(p.rent-p.exp),0)
  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12,marginBottom:20}}>
        <MetricCard label="Portfolio Value" value={fd(reVal)} icon="ti-building-estate" iconColor="var(--blue)"/>
        <MetricCard label="Total Equity" value={fd(reEquity)} sub={((reEquity/reVal)*100).toFixed(0)+'% of value'} subColor="var(--teal)" icon="ti-trending-up" iconColor="var(--teal)"/>
        <MetricCard label="Monthly NOI" value={fd(noi)} sub={fd(noi*12)+'/year'} subColor="var(--green)" icon="ti-cash" iconColor="var(--green)"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
        {props.map(p=>{
          const noi=p.rent-p.exp, roi=((noi*12)/p.value*100).toFixed(1), ltv=((p.mortgage/p.value)*100).toFixed(0)
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
                    <p style={{fontSize:11,color:'var(--text-secondary)',margin:0}}>{p.sqft?.toLocaleString()} sqft · {p.yr}</p>
                  </div>
                </div>
                <span className="badge" style={{background:'var(--teal-light)',color:'var(--teal)'}}>{roi}% ROI</span>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:10}}>
                {[['Value',fd(p.value)],['Equity',fd(p.value-p.mortgage)],['NOI/mo',fd(noi)]].map(([l,v])=>(
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
                  <div style={{height:3,width:ltv+'%',background:p.color,borderRadius:2}}/>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PropertyDetail({propId, properties}) {
  const props = properties.length ? properties : DEMO_PROPS
  const p = props.find(x=>x.id===propId)
  if(!p) return <p style={{color:'var(--text-secondary)'}}>Property not found.</p>
  const noi=p.rent-p.exp, monthly=p.mortgage*p.rate/100/12
  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:20}}>
        <div style={{width:48,height:48,borderRadius:'var(--radius-md)',background:'var(--blue-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
          <Icon name="ti-building-estate" size={24} color={p.color}/>
        </div>
        <div>
          <h2 style={{margin:0,fontSize:20,fontWeight:500}}>{p.name}</h2>
          <p style={{margin:0,fontSize:13,color:'var(--text-secondary)'}}>{p.addr} · {p.sqft?.toLocaleString()} sqft · Built {p.yr}</p>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:16}}>
        {[['Market Value',fd(p.value)],['Equity',fd(p.value-p.mortgage)],['Mortgage',fd(p.mortgage)],['Rate',p.rate+'%']].map(([l,v])=>(
          <MetricCard key={l} label={l} value={v}/>
        ))}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Monthly cash flow</p>
          {[['Rental income',p.rent,true],['Mortgage payment',-Math.round(monthly),false],['Other expenses',-(p.exp-Math.round(monthly)),false],['Net cash flow',noi-Math.round(monthly),noi>Math.round(monthly)]].map(([l,v,pos])=>(
            <div className="row" key={l}>
              <span style={{color:'var(--text-secondary)'}}>{l}</span>
              <span style={{fontWeight:l==='Net cash flow'?500:400,color:pos?'var(--teal)':'var(--coral)'}}>{v>0?'+':''}{fd(v)}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <p style={{fontSize:14,fontWeight:500,margin:'0 0 12px'}}>Mortgage details</p>
          {[['Balance',fd(p.mortgage)],['Rate',p.rate+'%'],['Monthly payment',fd(Math.round(monthly))],['LTV',((p.mortgage/p.value)*100).toFixed(1)+'%'],['Annual interest',fd(Math.round(p.mortgage*p.rate/100))]].map(([l,v])=>(
            <div className="row" key={l}><span style={{color:'var(--text-secondary)'}}>{l}</span><span style={{fontWeight:500}}>{v}</span></div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ConnectionsScreen({status, onSync}) {
  const [syncing, setSyncing] = useState(false)
  const [plaidConns, setPlaidConns] = useState([])

  useEffect(()=>{
    axios.get(`${API}/plaid/connections`).then(r=>setPlaidConns(r.data)).catch(()=>{})
  },[])

  const syncAll = async () => {
    setSyncing(true)
    try { await axios.post(`${API}/plaid/sync`); onSync?.() }
    catch(e) { console.error(e) }
    setSyncing(false)
  }

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:20}}>
        <div className="card">
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
            <div style={{width:38,height:38,borderRadius:'var(--radius-md)',background:'var(--blue-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <Icon name="ti-building-bank" size={19} color="var(--blue)"/>
            </div>
            <div>
              <p style={{fontSize:14,fontWeight:500,margin:0}}>Plaid — Bank Connections</p>
              <p style={{fontSize:12,color:status?.plaidConfigured?'var(--teal)':'var(--coral)',margin:0}}>
                {status?.plaidConfigured?'✓ API keys configured':'⚠ Add keys to .env to enable'}
              </p>
            </div>
          </div>
          {plaidConns.length>0 ? (
            <div style={{marginBottom:12}}>
              {plaidConns.map(c=>(
                <div key={c.item_id} className="row">
                  <span>{c.institution_name}</span>
                  <span style={{fontSize:11,color:'var(--text-muted)'}}>Last sync: {c.lastSync?new Date(c.lastSync).toLocaleTimeString():'Never'}</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{fontSize:12,color:'var(--text-secondary)',marginBottom:12}}>No accounts connected yet. Add your Plaid API keys to .env then connect your first account.</p>
          )}
          <div style={{display:'flex',gap:8}}>
            <button className="sync-btn" onClick={syncAll} disabled={syncing||!status?.plaidConfigured}>
              <Icon name="ti-refresh" size={14}/> {syncing?'Syncing...':'Sync all'}
            </button>
          </div>
        </div>
        <div className="card">
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
            <div style={{width:38,height:38,borderRadius:'var(--radius-md)',background:'var(--green-light)',display:'flex',alignItems:'center',justifyContent:'center'}}>
              <Icon name="ti-file-spreadsheet" size={19} color="var(--green)"/>
            </div>
            <div>
              <p style={{fontSize:14,fontWeight:500,margin:0}}>QuickBooks</p>
              <p style={{fontSize:12,color:status?.qbConfigured?'var(--teal)':'var(--coral)',margin:0}}>
                {status?.qbConfigured?'✓ API keys configured':'⚠ Add keys to .env to enable'}
              </p>
            </div>
          </div>
          <p style={{fontSize:12,color:'var(--text-secondary)',marginBottom:12}}>One-click OAuth sync. Pulls all transactions, expenses, and P&L automatically.</p>
          <button onClick={()=>window.open('http://localhost:3001/auth/quickbooks/connect')} disabled={!status?.qbConfigured}>
            <Icon name="ti-plug" size={14}/> Connect QuickBooks
          </button>
        </div>
      </div>
      <div className="card">
        <p style={{fontSize:14,fontWeight:500,margin:'0 0 4px'}}>Setup checklist</p>
        <p style={{fontSize:12,color:'var(--text-secondary)',margin:'0 0 14px'}}>Complete these steps to activate live data</p>
        {[
          {label:'Node.js installed',done:true},
          {label:'CaiShen server running',done:true},
          {label:'Plaid account created at plaid.com',done:status?.plaidConfigured},
          {label:'Plaid keys added to .env (PLAID_CLIENT_ID + PLAID_SECRET)',done:status?.plaidConfigured},
          {label:'Plaid development access approved (1–2 days)',done:status?.plaidConfigured},
          {label:'QuickBooks developer account at developer.intuit.com',done:status?.qbConfigured},
          {label:'QuickBooks keys added to .env (QB_CLIENT_ID + QB_CLIENT_SECRET)',done:status?.qbConfigured},
        ].map((item,i)=>(
          <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:'0.5px solid var(--border)'}}>
            <Icon name={item.done?'ti-circle-check':'ti-circle'} size={16} color={item.done?'var(--teal)':'var(--text-muted)'}/>
            <span style={{fontSize:13,color:item.done?'var(--text-primary)':'var(--text-secondary)'}}>{item.label}</span>
          </div>
        ))}
      </div>
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

// ── Main App ──────────────────────────────────────────────────────────
export default function App() {
  const [nav, setNav] = useState('dashboard')
  const [trail, setTrail] = useState([{id:'dashboard',label:'Dashboard'}])
  const [collapsed, setCollapsed] = useState(false)
  const [status, setStatus] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [transactions, setTransactions] = useState([])
  const [properties, setProperties] = useState([])

  useEffect(()=>{
    axios.get(`${API}/status`).then(r=>setStatus(r.data)).catch(()=>{})
    axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])).catch(()=>{})
    axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])).catch(()=>{})
    axios.get(`${API}/properties`).then(r=>setProperties(r.data||[])).catch(()=>{})
  },[])

  const drill = (id, label) => { setNav(id); setTrail(prev=>[...prev,{id,label}]) }
  const navBC = idx => { const t=trail.slice(0,idx+1); setTrail(t); setNav(t[t.length-1].id) }
  const go = (id, label) => { setNav(id); setTrail([{id:label||id,label:label||id}]) }

  const renderContent = () => {
    if(nav==='dashboard') return <MainDashboard onDrill={drill} accounts={accounts} properties={properties}/>
    if(nav==='re') return <RealEstateDash onProp={(id,name)=>drill('prop_'+id,name)} properties={properties}/>
    if(nav.startsWith('prop_')) return <PropertyDetail propId={nav.replace('prop_','')} properties={properties}/>
    if(nav==='personal') return <PersonalSpending transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='transactions') return <TransactionTransfer transactions={transactions} onUpdate={setTransactions}/>
    if(nav==='connections') return <ConnectionsScreen status={status} onSync={()=>{ axios.get(`${API}/accounts`).then(r=>setAccounts(r.data||[])); axios.get(`${API}/transactions`).then(r=>setTransactions(r.data||[])) }}/>
    if(nav==='equity') return <PlaceholderScreen label="Equities"/>
    if(nav==='retirement') return <PlaceholderScreen label="Retirement"/>
    if(nav==='crypto') return <PlaceholderScreen label="Crypto"/>
    if(nav==='cash') return <PlaceholderScreen label="Cash Accounts"/>
    if(nav==='taxes') return <PlaceholderScreen label="Tax Center"/>
    if(nav==='projections') return <Projections/>
    if(nav==='advisor') return <PlaceholderScreen label="AI Advisor"/>
    if(nav==='data') return <DataVault onImportTransactions={txs=>setTransactions(prev=>[...prev,...txs])}/>
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
            {!collapsed && <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:'12px 14px 4px',textTransform:'uppercase',letterSpacing:'0.8px'}}>Asset Classes</p>}
            {ASSET_CLASSES.map(a=>(
              <NavBtn key={a.id} id={a.id} label={a.label} icon={a.icon} active={nav===a.id||nav.startsWith('prop_')&&a.id==='re'} collapsed={collapsed} color={a.color}
                onClick={()=>{ setNav(a.id); setTrail([{id:'dashboard',label:'Dashboard'},{id:a.id,label:a.label}]) }}/>
            ))}
            {!collapsed && <p style={{fontSize:10,fontWeight:500,color:'var(--text-muted)',margin:'12px 14px 4px',textTransform:'uppercase',letterSpacing:'0.8px'}}>Tools</p>}
            {NAV_TOOLS.map(t=>(
              <NavBtn key={t.id} id={t.id} label={t.label} icon={t.icon} active={nav===t.id} collapsed={collapsed} color="var(--blue)"
                onClick={()=>go(t.id,t.label)}/>
            ))}
          </nav>
          {!collapsed && (
            <div style={{padding:'10px 14px',borderTop:'0.5px solid var(--border)'}}>
              <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>Net worth</p>
              <p style={{fontSize:14,fontWeight:500,margin:'2px 0 0',color:'var(--teal)'}}>$4.18M</p>
            </div>
          )}
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
              <button onClick={()=>go('connections','Connections')} style={{fontSize:12}}>
                <Icon name="ti-plug" size={14}/> {!collapsed&&'Connections'}
              </button>
              <button onClick={()=>go('advisor','AI Advisor')} style={{background:'var(--purple-light)',color:'var(--purple)',borderColor:'var(--purple)',fontSize:12}}>
                <Icon name="ti-brain" size={14}/> AI Advisor
              </button>
            </div>
          </div>
          {renderContent()}
        </main>
      </div>
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