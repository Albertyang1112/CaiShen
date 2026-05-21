import { useState, useRef, useCallback } from 'react'

const fd = (n, d=2) => {
  return (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d})
}

// ── Categories with keyword fallback ─────────────────────────────────
const CATEGORIES = {
  'Dining':        { icon:'ti-tools-kitchen-2', color:'var(--coral)',  keywords:['restaurant','cafe','starbucks','mcdonalds','chipotle','doordash','ubereats','grubhub','nobu','sushi','pizza','burger','taco','diner','dining','eatery','kitchen','grill','bistro','mcdonald','wendy','chick-fil','panera','subway','dunkin','peet','coffee bean'] },
  'Groceries':     { icon:'ti-apple',           color:'var(--green)',  keywords:['whole foods','trader joe','safeway','kroger','vons','ralph','sprouts','erewhon','instacart','grocery','supermarket','market','food 4 less','costco food','walmart grocery'] },
  'Shopping':      { icon:'ti-shopping-bag',    color:'var(--amber)',  keywords:['amazon','walmart','target','best buy','apple store','nike','adidas','zara','hm','nordstrom','macy','costco','sam\'s club','home depot','lowe\'s','ikea','tj maxx','marshalls','ross','gap','old navy','uniqlo','lululemon'] },
  'Transport':     { icon:'ti-car',             color:'var(--blue)',   keywords:['uber','lyft','shell','chevron','bp','exxon','arco','76','mobil','valero','parking','metro','bart','mta','caltrain','gas','fuel','autozone','jiffy lube','carwash','enterprise','hertz','avis'] },
  'Travel':        { icon:'ti-plane',           color:'var(--purple)', keywords:['delta','united','american airlines','southwest','alaska air','jetblue','spirit','frontier','hotel','marriott','hilton','hyatt','airbnb','vrbo','expedia','booking.com','travelocity','kayak','flight','airline'] },
  'Entertainment': { icon:'ti-device-tv',       color:'var(--purple)', keywords:['netflix','hulu','disney','hbo','peacock','paramount','apple tv','spotify','tidal','youtube','ticketmaster','amc','regal','cinema','theater','concert','events','stub hub','live nation'] },
  'Fitness':       { icon:'ti-barbell',         color:'var(--teal)',   keywords:['equinox','planet fitness','la fitness','24 hour','crunch','soulcycle','peloton','gym','crossfit','yoga','pilates','barry','orangetheory','f45','cycling'] },
  'Health':        { icon:'ti-heart-rate-monitor', color:'var(--green)', keywords:['cvs','walgreens','rite aid','pharmacy','hospital','urgent care','doctor','dentist','medical','dental','vision','optometrist','clinic','kaiser','blue shield','anthem','health','wellness','vitamin','supplement'] },
  'Subscriptions': { icon:'ti-refresh',         color:'var(--pink)',   keywords:['icloud','google one','dropbox','adobe','microsoft','office 365','apple one','notion','slack','zoom','linkedin','premium','annual','membership','subscription','recurring'] },
  'Coffee':        { icon:'ti-coffee',          color:'var(--amber)',  keywords:['starbucks','peet','blue bottle','philz','verve','intelligentsia','coffee','espresso','latte','cappuccino','cafe'] },
  'Tech':          { icon:'ti-device-laptop',   color:'var(--blue)',   keywords:['apple','best buy','newegg','micro center','b&h','adorama','dell','lenovo','samsung','techni','electronics','computer','laptop','phone','iphone','ipad','macbook','device'] },
  'Utilities':     { icon:'ti-bolt',            color:'var(--amber)',  keywords:['pg&e','sce','sdge','verizon','at&t','tmobile','sprint','comcast','xfinity','cox','spectrum','internet','electric','water','gas bill','utility','phone bill','wireless'] },
  'Income':        { icon:'ti-arrow-down-left', color:'var(--teal)',   keywords:[] },
  'Transfer':      { icon:'ti-arrows-exchange', color:'var(--text-secondary)', keywords:['transfer','zelle','venmo','paypal','cashapp','wire','deposit','withdrawal','atm'] },
  'Other':         { icon:'ti-dots',            color:'var(--text-secondary)', keywords:[] },
}

// Chase-specific category mapping (from Chase CSV Category column)
const CHASE_CAT_MAP = {
  'food & drink':       'Dining',
  'restaurants':        'Dining',
  'groceries':          'Groceries',
  'supermarkets':       'Groceries',
  'gas':                'Transport',
  'gas & fuel':         'Transport',
  'auto & transport':   'Transport',
  'travel':             'Travel',
  'airlines':           'Travel',
  'hotels':             'Travel',
  'entertainment':      'Entertainment',
  'movies & dvds':      'Entertainment',
  'music':              'Entertainment',
  'health & fitness':   'Fitness',
  'gym':                'Fitness',
  'pharmacy':           'Health',
  'health':             'Health',
  'shopping':           'Shopping',
  'clothing':           'Shopping',
  'electronics':        'Tech',
  'technology':         'Tech',
  'bills & utilities':  'Utilities',
  'utilities':          'Utilities',
  'mobile phone':       'Utilities',
  'coffee shops':       'Coffee',
  'transfer':           'Transfer',
  'payment':            'Transfer',
  'income':             'Income',
  'paycheck':           'Income',
  'deposit':            'Income',
}

function categorize(description, chaseCategory) {
  // 1. Use Chase's own category if available and not "misc"
  if (chaseCategory) {
    const lower = chaseCategory.toLowerCase().trim()
    if (!['misc','miscellaneous','uncategorized','other','general merchandise','personal'].includes(lower)) {
      const mapped = CHASE_CAT_MAP[lower]
      if (mapped) return mapped
    }
  }
  // 2. Keyword matching fallback
  if (!description) return 'Other'
  const desc = description.toLowerCase()
  for (const [cat, { keywords }] of Object.entries(CATEGORIES)) {
    if (['Other','Income','Transfer'].includes(cat)) continue
    if (keywords.some(k => desc.includes(k))) return cat
  }
  return 'Other'
}

// ── CSV parser — supports Chase, Amex, Schwab, generic ───────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase())

  // Detect columns
  const dateIdx   = headers.findIndex(h => ['date','transaction date','posted date','trans date','posting date'].includes(h))
  const descIdx   = headers.findIndex(h => ['description','merchant','name','memo','transaction description','payee'].some(k => h.includes(k)))
  const amtIdx    = headers.findIndex(h => ['amount','debit','credit','transaction amount'].some(k => h.includes(k)))
  const catIdx    = headers.findIndex(h => h.includes('category') || h === 'type' || h === 'details')
  const typeIdx   = headers.findIndex(h => h === 'type' || h === 'details')

  if (dateIdx === -1 || descIdx === -1 || amtIdx === -1) return null

  const txs = []
  for (let i = 1; i < lines.length; i++) {
    // CSV-safe split handling quoted fields
    const cols = []
    let cur = '', inQ = false
    for (const ch of lines[i]) {
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = '' }
      else cur += ch
    }
    cols.push(cur.trim())

    if (cols.length < 3) continue

    const dateRaw = cols[dateIdx]?.replace(/"/g,'').trim()
    const desc    = cols[descIdx]?.replace(/"/g,'').trim() || ''
    const amtRaw  = cols[amtIdx]?.replace(/[$,"\s]/g,'').trim() || '0'
    const chaseCat = catIdx >= 0 ? cols[catIdx]?.replace(/"/g,'').trim() : ''

    const amount = parseFloat(amtRaw)
    if (!dateRaw || isNaN(amount) || amount === 0) continue

    const date = new Date(dateRaw)
    if (isNaN(date.getTime())) continue

    // Chase CSV: negative = debit/expense, positive = credit/deposit
    // Preserve the original sign — do NOT normalize
    const normalized = amount

    // Categorize credits/deposits as Income
    const isCredit = amount > 0
    const category = isCredit ? 'Income' : categorize(desc, chaseCat)

    txs.push({
      id:       `csv_${i}_${Date.now()}`,
      date:     date.toISOString().split('T')[0],
      desc,
      amount:   normalized,
      category,
      source:   'csv',
      month:    `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`,
    })
  }
  return txs
}

const monthLabel = m => {
  if (!m) return ''
  const [y, mo] = m.split('-')
  return new Date(y, parseInt(mo)-1).toLocaleString('en-US', { month:'long', year:'numeric' })
}

const FRIEND_COMMENTS = {
  'Dining':        ["Bro, Nobu again? You could buy a small country with your sushi tab 🍣","Your food budget is eating your food budget","A wise man once said 'cook at home'. That man never had omakase."],
  'Groceries':     ["Erewhon? $12 water? Living the California dream","Your grocery bill is the GDP of a small island","You didn't buy groceries, you curated an artisanal food journey"],
  'Shopping':      ["Amazon Prime hits different when you're buying your 4th air fryer","Your UPS driver considers you family at this point","Legend says the packages never stop arriving..."],
  'Transport':     ["Uber surge pricing is not your friend but you keep inviting it over","The gas prices hurt everyone. You just feel it more.","Your car is basically a subscription service at this point"],
  'Travel':        ["First class? Of course. Your portfolio demanded it.","Your passport works harder than most people's W-2","Somewhere a travel agent just shed a single tear of joy"],
  'Entertainment': ["Netflix, Spotify, Disney+ — you're basically running a media empire","$23/month for Netflix while your NOI is $21K... the contrast is iconic","The entertainment portfolio is diverse. The wallet, less so."],
  'Fitness':       ["Paying $250/mo to run on a treadmill you could buy for $1,200... classic","The commitment to looking like you work out is unmatched 💪","Your fitness spend is up. The gains better be real."],
  'Health':        ["Investing in health is valid. The Whole Foods smoothie bar, debatable.","CVS receipts longer than a mortgage document","The supplements are adding up. You better be getting jacked."],
  'Subscriptions': ["You have more subscriptions than free hours in the day","Somewhere a SaaS founder is smiling because of you","The subscription creep is real and it has found you"],
  'Coffee':        ["$8 coffee is just a mortgage payment in liquid form","Starbucks sees you coming and starts printing your name","The audacity of $8 coffee when you own five houses"],
  'Tech':          ["Apple just sent a thank-you card. It's addressed to your W-2.","A new device? Didn't you just buy one?","Best Buy has your photo in their break room. Employee of the month."],
  'Utilities':     ["Bills paying themselves would be nice. Until then, here we are.","Utilities: the most boring yet unavoidable spend","PG&E said thank you. In writing."],
  'Other':         ["Mysterious spending. The plot thickens.","Some expenses defy categorization. This is one of them.","We'll call this 'life happens' and move on."],
}

function MetricCard({ label, value, sub, subColor, icon, iconColor }) {
  return (
    <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'1rem' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 6px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px' }}>{label}</p>
        {icon && <i className={`ti ${icon}`} style={{ fontSize:18, color:iconColor||'var(--text-secondary)' }} aria-hidden="true"/>}
      </div>
      <p style={{ fontSize:22, fontWeight:500, margin:0 }}>{value}</p>
      {sub && <p style={{ fontSize:12, color:subColor||'var(--text-secondary)', margin:'4px 0 0' }}>{sub}</p>}
    </div>
  )
}

export default function PersonalSpending(props) {
  const { transactions, onUpdate } = props
  const [uploading, setUploading]         = useState(false)
  const [uploadError, setUploadError]     = useState(null)
  const [uploadSuccess, setUploadSuccess] = useState(null)
  const [selectedMonth, setSelectedMonth] = useState('all')
  const [selectedCat, setSelectedCat]     = useState(null)
  const [friendComment, setFriendComment] = useState(null)
  const [friendCat, setFriendCat]         = useState(null)
  const [dragOver, setDragOver]           = useState(false)
  const [view, setView]                   = useState('overview')
  const [sortBy, setSortBy]               = useState('date')
  const fileRef = useRef()

  const processFile = useCallback(async (file) => {
    setUploading(true); setUploadError(null); setUploadSuccess(null)
    const ext = file.name.split('.').pop().toLowerCase()
    if (ext !== 'csv') {
      setUploadError('PDF parsing requires the Anthropic API key (not yet configured). Please export your statement as CSV from your bank.')
      setUploading(false); return
    }
    const text = await file.text()
    const parsed = parseCSV(text)
    if (!parsed || parsed.length === 0) {
      setUploadError('Could not parse CSV. Make sure it has Date, Description, and Amount columns.')
      setUploading(false); return
    }
    onUpdate(prev => {
      const ids = new Set(prev.map(t => t.id))
      const merged = [...prev, ...parsed.filter(t => !ids.has(t.id))]
      return merged.sort((a,b) => new Date(b.date) - new Date(a.date))
    })
    setUploadSuccess(`✓ Imported ${parsed.length} transactions from ${file.name}`)
    setUploading(false)
  }, [])

  const onDrop = e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]) }

  // ── Derived data ────────────────────────────────────────────────────
  const allMonths = [...new Set(transactions.map(t => t.month))].sort().reverse()

  const baseTxs = transactions.filter(t => {
    if (selectedMonth !== 'all' && t.month !== selectedMonth) return false
    return true
  })

  const expenses  = baseTxs.filter(t => t.amount < 0)
  const income    = baseTxs.filter(t => t.amount > 0)
  const totalSpend = expenses.reduce((s,t) => s + Math.abs(t.amount), 0)
  const totalIncome = income.reduce((s,t) => s + t.amount, 0)

  const byCat = expenses.reduce((acc,t) => { acc[t.category]=(acc[t.category]||0)+Math.abs(t.amount); return acc },{})
  const catList = Object.entries(byCat).sort((a,b) => b[1]-a[1])

  const filteredTxs = baseTxs
    .filter(t => !selectedCat || t.category === selectedCat)
    .sort((a,b) => {
      if (sortBy === 'date')   return new Date(b.date) - new Date(a.date)
      if (sortBy === 'amount') return Math.abs(b.amount) - Math.abs(a.amount)
      if (sortBy === 'name')   return a.desc.localeCompare(b.desc)
      return 0
    })

  const pickCat = cat => {
    setSelectedCat(cat === selectedCat ? null : cat)
    const opts = FRIEND_COMMENTS[cat] || FRIEND_COMMENTS['Other']
    setFriendComment(opts[Math.floor(Math.random()*opts.length)])
    setFriendCat(cat)
    setView('overview')
  }

  const recategorize = (id, newCat) => onUpdate(prev => prev.map(t => t.id===id ? {...t, category:newCat} : t))

  const clearAll = () => { if (window.confirm('Clear all imported transactions?')) { onUpdate([]); setSelectedMonth('all'); setSelectedCat(null); setUploadSuccess(null) } }

  return (
    <div>
      {/* Upload zone */}
      <div
        onDragOver={e=>{e.preventDefault();setDragOver(true)}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={onDrop}
        onClick={()=>fileRef.current.click()}
        style={{ border:`1.5px dashed ${dragOver?'var(--blue)':'var(--border-light)'}`, borderRadius:'var(--radius-lg)', padding:'16px 20px', display:'flex', alignItems:'center', gap:14, cursor:'pointer', background:dragOver?'var(--blue-light)':'var(--bg-secondary)', marginBottom:14, transition:'all 0.15s' }}>
        <div style={{ width:40, height:40, borderRadius:'var(--radius-md)', background:'var(--bg-card)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          {uploading
            ? <i className="ti ti-loader-2" style={{ fontSize:20, color:'var(--blue)', animation:'spin 1s linear infinite' }} aria-hidden="true"/>
            : <i className="ti ti-upload" style={{ fontSize:20, color:'var(--blue)' }} aria-hidden="true"/>}
        </div>
        <div style={{ flex:1 }}>
          <p style={{ fontSize:14, fontWeight:500, margin:'0 0 2px' }}>{uploading?'Processing...':'Upload bank statement (CSV)'}</p>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0 }}>Chase, Amex, Schwab, and most banks. Export as CSV from your bank's website.</p>
        </div>
        <div style={{ display:'flex', gap:6, flexShrink:0 }}>
          {['Chase CSV','Amex CSV','Schwab CSV'].map(f=>(
            <span key={f} style={{ fontSize:10, padding:'2px 7px', background:'var(--bg-card)', border:'0.5px solid var(--border-light)', borderRadius:4, color:'var(--text-secondary)' }}>{f}</span>
          ))}
        </div>
        <input ref={fileRef} type="file" accept=".csv" style={{ display:'none' }} onChange={e=>{ if(e.target.files[0]) processFile(e.target.files[0]) }}/>
      </div>

      {uploadSuccess && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', background:'var(--teal-light)', borderRadius:'var(--radius-md)', marginBottom:12, fontSize:13, color:'var(--teal)', border:'0.5px solid var(--teal)' }}>
          <i className="ti ti-circle-check" style={{ fontSize:15 }} aria-hidden="true"/> {uploadSuccess}
          <button onClick={()=>setUploadSuccess(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--teal)', padding:0, fontSize:13 }}>✕</button>
        </div>
      )}
      {uploadError && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', background:'var(--coral-light)', borderRadius:'var(--radius-md)', marginBottom:12, fontSize:13, color:'var(--coral)', border:'0.5px solid var(--coral)' }}>
          <i className="ti ti-alert-circle" style={{ fontSize:15 }} aria-hidden="true"/> {uploadError}
          <button onClick={()=>setUploadError(null)} style={{ marginLeft:'auto', background:'none', border:'none', color:'var(--coral)', padding:0, fontSize:13 }}>✕</button>
        </div>
      )}

      {transactions.length === 0 ? (
        <div style={{ textAlign:'center', padding:'3rem', background:'var(--bg-card)', borderRadius:'var(--radius-lg)', border:'0.5px solid var(--border)' }}>
          <i className="ti ti-file-upload" style={{ fontSize:44, color:'var(--text-muted)', display:'block', marginBottom:12 }} aria-hidden="true"/>
          <p style={{ fontSize:15, fontWeight:500, margin:'0 0 6px' }}>No transactions yet</p>
          <p style={{ fontSize:13, color:'var(--text-secondary)', margin:'0 0 20px' }}>Upload a CSV bank statement to get started.</p>
          <div style={{ display:'flex', justifyContent:'center', gap:10 }}>
            {[['Chase','Account Activity → Download → CSV'],['Amex','Statements → Download → CSV'],['Schwab','History → Export → CSV']].map(([bank,note])=>(
              <div key={bank} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'10px 14px', textAlign:'left', fontSize:12 }}>
                <p style={{ fontWeight:500, margin:'0 0 3px' }}>{bank}</p>
                <p style={{ color:'var(--text-secondary)', margin:0 }}>{note}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          {/* Controls */}
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:14, flexWrap:'wrap' }}>
            <select value={selectedMonth} onChange={e=>{ setSelectedMonth(e.target.value); setSelectedCat(null) }} style={{ fontSize:13, padding:'7px 12px', minWidth:180 }}>
              <option value="all">All months ({transactions.length} txns)</option>
              {allMonths.map(m=>(
                <option key={m} value={m}>{monthLabel(m)} ({transactions.filter(t=>t.month===m).length})</option>
              ))}
            </select>
            <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{ fontSize:13, padding:'7px 10px' }}>
              <option value="date">Sort: Date</option>
              <option value="amount">Sort: Amount</option>
              <option value="name">Sort: Name</option>
            </select>
            <div style={{ display:'flex', border:'0.5px solid var(--border-light)', borderRadius:'var(--radius-sm)', overflow:'hidden' }}>
              {[['overview','ti-layout-grid','Overview'],['transactions','ti-list','All Txns']].map(([v,ico,lbl])=>(
                <button key={v} onClick={()=>setView(v)} style={{ borderRadius:0, border:'none', borderRight:v==='overview'?'0.5px solid var(--border-light)':'none', background:view===v?'var(--blue-light)':'var(--bg-card)', color:view===v?'var(--blue)':'var(--text-secondary)', fontSize:12, padding:'6px 12px' }}>
                  <i className={`ti ${ico}`} style={{ fontSize:13 }} aria-hidden="true"/> {lbl}
                </button>
              ))}
            </div>
            {selectedCat && (
              <button onClick={()=>setSelectedCat(null)} style={{ fontSize:12 }}>
                <i className="ti ti-x" style={{ fontSize:12 }} aria-hidden="true"/> {selectedCat}
              </button>
            )}
            <button onClick={()=>fileRef.current.click()} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
              <i className="ti ti-plus" style={{ fontSize:12 }} aria-hidden="true"/> Add statement
            </button>
            <button onClick={clearAll} style={{ marginLeft:'auto', fontSize:12, color:'var(--coral)', borderColor:'var(--coral)', background:'var(--coral-light)' }}>
              <i className="ti ti-trash" style={{ fontSize:12 }} aria-hidden="true"/> Clear
            </button>
          </div>

          {/* Metrics */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:18 }}>
            <MetricCard label={selectedMonth==='all'?'Total Spend':monthLabel(selectedMonth)} value={fd(totalSpend)} icon="ti-receipt" iconColor="var(--pink)"/>
            <MetricCard label="Income / Credits" value={fd(totalIncome)} subColor="var(--teal)" icon="ti-arrow-down-left" iconColor="var(--teal)"/>
            <MetricCard label="Net Cash Flow" value={fd(totalIncome-totalSpend)} subColor={totalIncome-totalSpend>=0?'var(--teal)':'var(--coral)'} icon="ti-trending-up" iconColor={totalIncome-totalSpend>=0?'var(--teal)':'var(--coral)'}/>
            <MetricCard label="Transactions" value={baseTxs.length} sub={`${expenses.length} expenses · ${income.length} credits`} icon="ti-arrows-exchange" iconColor="var(--purple)"/>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 270px', gap:16 }}>
            <div>
              {/* Category grid */}
              {view === 'overview' && (
                <>
                  <p style={{ fontSize:11, fontWeight:500, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:'0.6px', margin:'0 0 10px' }}>Spending by category</p>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:18 }}>
                    {catList.map(([cat,amt])=>{
                      const pct = totalSpend>0?((amt/totalSpend)*100).toFixed(0):0
                      const { icon, color } = CATEGORIES[cat]||{ icon:'ti-dots', color:'var(--text-secondary)' }
                      return (
                        <div key={cat} onClick={()=>pickCat(cat)}
                          style={{ background:'var(--bg-card)', border:`0.5px solid ${selectedCat===cat?color:'var(--border)'}`, borderRadius:'var(--radius-lg)', padding:'12px 14px', cursor:'pointer', transition:'all 0.15s' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                            <div style={{ width:32, height:32, borderRadius:'var(--radius-md)', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                              <i className={`ti ${icon}`} style={{ fontSize:16, color }} aria-hidden="true"/>
                            </div>
                            <div style={{ flex:1 }}>
                              <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{cat}</p>
                              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:0 }}>{pct}% · {expenses.filter(t=>t.category===cat).length} txns</p>
                            </div>
                            <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{fd(amt)}</p>
                          </div>
                          <div style={{ height:3, background:'var(--bg-secondary)', borderRadius:2 }}>
                            <div style={{ height:3, width:pct+'%', background:color, borderRadius:2 }}/>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Transaction list */}
              <p style={{ fontSize:11, fontWeight:500, color:'var(--text-secondary)', textTransform:'uppercase', letterSpacing:'0.6px', margin:'0 0 10px' }}>
                {view==='transactions'?`Transactions${selectedCat?' — '+selectedCat:''}`:selectedCat?`${selectedCat} transactions`:'Recent transactions'}
                <span style={{ fontWeight:400 }}> ({filteredTxs.length})</span>
              </p>
              <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                {filteredTxs.length === 0 ? (
                  <p style={{ padding:'20px 16px', color:'var(--text-secondary)', fontSize:13, textAlign:'center' }}>No transactions match this filter.</p>
                ) : (
                  (view==='overview'?filteredTxs.slice(0,10):filteredTxs).map((t,i,arr)=>{
                    const { icon, color } = CATEGORIES[t.category]||{ icon:'ti-dots', color:'var(--text-secondary)' }
                    return (
                      <div key={t.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderBottom:i<arr.length-1?'0.5px solid var(--border)':'none' }}>
                        <div style={{ width:32, height:32, borderRadius:'50%', background:'var(--bg-secondary)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          <i className={`ti ${icon}`} style={{ fontSize:14, color }} aria-hidden="true"/>
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <p style={{ fontSize:13, fontWeight:500, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.desc}</p>
                          <p style={{ fontSize:11, color:'var(--text-secondary)', margin:0 }}>{t.date} · {t.month}</p>
                        </div>
                        <select value={t.category} onChange={e=>recategorize(t.id,e.target.value)} onClick={e=>e.stopPropagation()}
                          style={{ fontSize:11, padding:'3px 6px', background:'var(--bg-secondary)', color, border:'0.5px solid var(--border-light)', borderRadius:4, maxWidth:130 }}>
                          {Object.keys(CATEGORIES).map(c=><option key={c} value={c}>{c}</option>)}
                        </select>
                        <p style={{ fontSize:13, fontWeight:500, margin:0, color:t.amount>=0?'var(--teal)':'var(--coral)', flexShrink:0, minWidth:60, textAlign:'right' }}>{t.amount>=0?'+':''}{fd(t.amount)}</p>
                      </div>
                    )
                  })
                )}
                {view==='overview' && filteredTxs.length>10 && (
                  <div style={{ padding:'10px 16px', textAlign:'center', borderTop:'0.5px solid var(--border)' }}>
                    <button onClick={()=>setView('transactions')} style={{ fontSize:12, background:'none', border:'none', color:'var(--blue)', cursor:'pointer' }}>
                      View all {filteredTxs.length} transactions →
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right sidebar */}
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {/* Friend comment */}
              <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.25rem' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                  <div style={{ width:34, height:34, borderRadius:'50%', background:'var(--pink-light)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <i className="ti ti-message-circle" style={{ fontSize:17, color:'var(--pink)' }} aria-hidden="true"/>
                  </div>
                  <div>
                    <p style={{ fontSize:13, fontWeight:500, margin:0 }}>Your financial friend</p>
                    <p style={{ fontSize:11, color:'var(--text-secondary)', margin:0 }}>Has opinions</p>
                  </div>
                </div>
                {friendComment ? (
                  <div style={{ background:'var(--pink-light)', borderRadius:'var(--radius-sm)', padding:'10px 12px', borderLeft:'3px solid var(--pink)' }}>
                    <p style={{ fontSize:12, color:'var(--text-primary)', margin:0, lineHeight:1.6, fontStyle:'italic' }}>"{friendComment}"</p>
                    <p style={{ fontSize:11, color:'var(--pink)', margin:'6px 0 0' }}>— on your {friendCat} spend</p>
                  </div>
                ) : (
                  <p style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.6, margin:0 }}>Click any category and I'll have thoughts...</p>
                )}
              </div>

              {/* Month bar chart */}
              {allMonths.length > 0 && (
                <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.25rem' }}>
                  <p style={{ fontSize:13, fontWeight:500, margin:'0 0 12px' }}>Month by month</p>
                  {allMonths.map(m => {
                    const mAmt = transactions.filter(t=>t.month===m&&t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0)
                    const maxAmt = Math.max(...allMonths.map(mo=>transactions.filter(t=>t.month===mo&&t.amount<0).reduce((s,t)=>s+Math.abs(t.amount),0)))
                    const pct = maxAmt>0?(mAmt/maxAmt*100).toFixed(0):0
                    const active = selectedMonth===m
                    return (
                      <div key={m} onClick={()=>setSelectedMonth(m===selectedMonth?'all':m)} style={{ cursor:'pointer', marginBottom:8, opacity:selectedMonth!=='all'&&!active?0.45:1 }}>
                        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                          <span style={{ color:active?'var(--blue)':'var(--text-secondary)', fontWeight:active?500:400 }}>{monthLabel(m)}</span>
                          <span style={{ fontWeight:500 }}>{fd(mAmt)}</span>
                        </div>
                        <div style={{ height:3, background:'var(--bg-secondary)', borderRadius:2 }}>
                          <div style={{ height:3, width:pct+'%', background:active?'var(--blue)':'var(--border-light)', borderRadius:2 }}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Category breakdown */}
              {catList.length > 0 && (
                <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.25rem' }}>
                  <p style={{ fontSize:13, fontWeight:500, margin:'0 0 10px' }}>Breakdown</p>
                  {catList.map(([cat,amt])=>{
                    const { color } = CATEGORIES[cat]||{ color:'var(--text-secondary)' }
                    return (
                      <div key={cat} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                        <div style={{ width:7, height:7, borderRadius:'50%', background:color, flexShrink:0 }}/>
                        <span style={{ fontSize:12, color:'var(--text-secondary)', flex:1 }}>{cat}</span>
                        <span style={{ fontSize:12, fontWeight:500 }}>{fd(amt)}</span>
                        <span style={{ fontSize:11, color:'var(--text-muted)', width:30, textAlign:'right' }}>{totalSpend>0?((amt/totalSpend)*100).toFixed(0):0}%</span>
                      </div>
                    )
                  })}
                  <div style={{ borderTop:'0.5px solid var(--border)', paddingTop:8, marginTop:4, display:'flex', justifyContent:'space-between', fontSize:12 }}>
                    <span style={{ fontWeight:500 }}>Total</span><span style={{ fontWeight:500 }}>{fd(totalSpend)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  )
}