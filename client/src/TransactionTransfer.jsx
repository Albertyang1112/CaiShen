import { useState, useEffect } from 'react'

const fd = (n, d=2) => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})

const PROPERTIES = [
  { id:'haas',     name:'Haas',     type:'property', icon:'ti-building-estate', color:'var(--blue)'   },
  { id:'kobe',     name:'Kobe',     type:'property', icon:'ti-building-estate', color:'var(--teal)'   },
  { id:'bayhill',  name:'Bay Hill', type:'property', icon:'ti-building-estate', color:'var(--purple)' },
  { id:'muirfield',name:'Muirfield',type:'property', icon:'ti-building-estate', color:'var(--amber)'  },
  { id:'alcita',   name:'Alcita',   type:'property', icon:'ti-building-estate', color:'var(--coral)'  },
]

const ACCOUNTS = [
  { id:'personal', name:'Personal',          type:'personal', icon:'ti-wallet',        color:'var(--pink)'   },
  { id:'business', name:'Business',          type:'business', icon:'ti-briefcase',     color:'var(--purple)' },
  { id:'chase',    name:'Chase Checking',    type:'bank',     icon:'ti-building-bank', color:'var(--blue)'   },
  { id:'schwab',   name:'Schwab Brokerage',  type:'bank',     icon:'ti-chart-candle',  color:'var(--purple)' },
  { id:'amex',     name:'Amex Platinum',     type:'credit',   icon:'ti-credit-card',   color:'var(--teal)'   },
  ...PROPERTIES,
]

const CATEGORIES = ['Dining','Groceries','Shopping','Transport','Travel','Entertainment','Fitness','Health','Subscriptions','Coffee','Tech','Utilities','Repairs & Maintenance','Property Management','Insurance','HOA','Mortgage','Income','Transfer','Other']

const CAT_ICONS = {
  'Dining':'ti-tools-kitchen-2','Groceries':'ti-apple','Shopping':'ti-shopping-bag',
  'Transport':'ti-car','Travel':'ti-plane','Entertainment':'ti-device-tv',
  'Fitness':'ti-barbell','Health':'ti-heart-rate-monitor','Subscriptions':'ti-refresh',
  'Coffee':'ti-coffee','Tech':'ti-device-laptop','Utilities':'ti-bolt',
  'Repairs & Maintenance':'ti-hammer','Property Management':'ti-building-estate',
  'Insurance':'ti-shield','HOA':'ti-home','Mortgage':'ti-home-dollar',
  'Income':'ti-arrow-down-left','Transfer':'ti-arrows-exchange','Other':'ti-dots',
}

// ── Rule engine ───────────────────────────────────────────────────────
function applyRules(tx, rules) {
  for (const rule of rules) {
    const descMatch  = !rule.keyword  || tx.desc.toLowerCase().includes(rule.keyword.toLowerCase())
    const acctMatch  = !rule.fromAccount || tx.account === rule.fromAccount
    const catMatch   = !rule.category || tx.category === rule.category
    if (descMatch && acctMatch && catMatch) {
      return { ...tx, account: rule.toAccount, category: rule.toCategory || tx.category, ruleApplied: rule.id }
    }
  }
  return tx
}

// ── Split modal ───────────────────────────────────────────────────────
function SplitModal({ tx, onConfirm, onClose }) {
  const [splits, setSplits] = useState([
    { account: ACCOUNTS[0].id, category: tx.category, amount: Math.abs(tx.amount), pct: 100, note: '' }
  ])

  const totalPct = splits.reduce((s,sp)=>s+sp.pct,0)
  const totalAmt = splits.reduce((s,sp)=>s+sp.amount,0)

  const addSplit = () => setSplits(prev=>[...prev,{ account:ACCOUNTS[0].id, category:tx.category, amount:0, pct:0, note:'' }])
  const removeSplit = i => setSplits(prev=>prev.filter((_,idx)=>idx!==i))

  const updateSplit = (i, field, val) => {
    setSplits(prev => prev.map((sp,idx) => {
      if (idx !== i) return sp
      const updated = { ...sp, [field]: val }
      if (field === 'pct') updated.amount = parseFloat((Math.abs(tx.amount) * val / 100).toFixed(2))
      if (field === 'amount') updated.pct = parseFloat((val / Math.abs(tx.amount) * 100).toFixed(1))
      return updated
    }))
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.5rem', width:520, maxHeight:'80vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <div>
            <p style={{ fontSize:15, fontWeight:500, margin:0 }}>Split transaction</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'2px 0 0' }}>{tx.desc} · {fd(tx.amount)}</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-secondary)', fontSize:18, padding:4 }}>✕</button>
        </div>

        {splits.map((sp,i)=>(
          <div key={i} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'12px 14px', marginBottom:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
              <p style={{ fontSize:13, fontWeight:500, margin:0 }}>Split {i+1}</p>
              {splits.length>1 && <button onClick={()=>removeSplit(i)} style={{ background:'none', border:'none', color:'var(--coral)', fontSize:12, cursor:'pointer', padding:0 }}>Remove</button>}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
              <div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Account / Property</p>
                <select value={sp.account} onChange={e=>updateSplit(i,'account',e.target.value)} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                  {ACCOUNTS.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Category</p>
                <select value={sp.category} onChange={e=>updateSplit(i,'category',e.target.value)} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
              <div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Amount ($)</p>
                <input type="number" value={sp.amount} onChange={e=>updateSplit(i,'amount',parseFloat(e.target.value)||0)} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}/>
              </div>
              <div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Percent (%)</p>
                <input type="number" value={sp.pct} onChange={e=>updateSplit(i,'pct',parseFloat(e.target.value)||0)} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}/>
              </div>
              <div>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Note</p>
                <input type="text" value={sp.note} onChange={e=>updateSplit(i,'note',e.target.value)} placeholder="Optional" style={{ width:'100%', fontSize:12, padding:'6px 8px' }}/>
              </div>
            </div>
          </div>
        ))}

        <button onClick={addSplit} style={{ width:'100%', fontSize:12, marginBottom:14, background:'var(--bg-secondary)' }}>
          <i className="ti ti-plus" aria-hidden="true"/> Add split
        </button>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 12px', background:'var(--bg-secondary)', borderRadius:'var(--radius-sm)', marginBottom:14, fontSize:12 }}>
          <span style={{ color:'var(--text-secondary)' }}>Total allocated</span>
          <span style={{ fontWeight:500, color: Math.abs(totalAmt - Math.abs(tx.amount)) < 0.01 ? 'var(--teal)' : 'var(--coral)' }}>
            {fd(totalAmt)} / {fd(Math.abs(tx.amount))} ({totalPct.toFixed(1)}%)
          </span>
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ fontSize:12 }}>Cancel</button>
          <button onClick={()=>onConfirm(splits)} disabled={Math.abs(totalPct-100)>0.5}
            style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
            Confirm split
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Transfer modal ────────────────────────────────────────────────────
function TransferModal({ tx, onConfirm, onClose }) {
  const [toAccount, setToAccount] = useState(ACCOUNTS[0].id)
  const [toCategory, setToCategory] = useState(tx.category)
  const [note, setNote] = useState('')

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'1.5rem', width:420 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <div>
            <p style={{ fontSize:15, fontWeight:500, margin:0 }}>Move transaction</p>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'2px 0 0' }}>{tx.desc} · {fd(tx.amount)}</p>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-secondary)', fontSize:18, padding:4 }}>✕</button>
        </div>

        <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'10px 12px', marginBottom:14, fontSize:12 }}>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ color:'var(--text-secondary)' }}>From account</span>
            <span style={{ fontWeight:500 }}>{ACCOUNTS.find(a=>a.id===tx.account)?.name || tx.account}</span>
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}>
            <span style={{ color:'var(--text-secondary)' }}>Current category</span>
            <span style={{ fontWeight:500 }}>{tx.category}</span>
          </div>
        </div>

        <div style={{ marginBottom:12 }}>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px' }}>Move to account / property</p>
          <select value={toAccount} onChange={e=>setToAccount(e.target.value)} style={{ width:'100%', fontSize:13, padding:'8px 10px' }}>
            <optgroup label="Personal">
              {ACCOUNTS.filter(a=>a.type==='personal'||a.type==='bank'||a.type==='credit').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
            <optgroup label="Properties">
              {PROPERTIES.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
            <optgroup label="Business">
              {ACCOUNTS.filter(a=>a.type==='business').map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          </select>
        </div>

        <div style={{ marginBottom:12 }}>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px' }}>Update category (optional)</p>
          <select value={toCategory} onChange={e=>setToCategory(e.target.value)} style={{ width:'100%', fontSize:13, padding:'8px 10px' }}>
            {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div style={{ marginBottom:16 }}>
          <p style={{ fontSize:12, color:'var(--text-secondary)', margin:'0 0 6px' }}>Note (optional)</p>
          <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. Bathroom repair for Bay Hill" style={{ width:'100%', fontSize:13, padding:'8px 10px' }}/>
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ fontSize:12 }}>Cancel</button>
          <button onClick={()=>onConfirm({ toAccount, toCategory, note })}
            style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
            Move transaction
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Rule builder ──────────────────────────────────────────────────────
function RuleBuilder({ rules, onSave, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ keyword:'', fromAccount:'', category:'', toAccount:'', toCategory:'', name:'' })

  const startNew = () => { setForm({ keyword:'', fromAccount:'', category:'', toAccount:ACCOUNTS[0].id, toCategory:'', name:'' }); setEditing('new') }
  const save = () => { onSave({ ...form, id: editing==='new'?Date.now().toString():editing }); setEditing(null) }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <p style={{ fontSize:13, fontWeight:500, margin:0 }}>Auto-transfer rules</p>
        <button onClick={startNew} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
          <i className="ti ti-plus" aria-hidden="true"/> New rule
        </button>
      </div>

      {editing && (
        <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'14px', marginBottom:12, border:'0.5px solid var(--blue)' }}>
          <p style={{ fontSize:13, fontWeight:500, margin:'0 0 12px' }}>{editing==='new'?'New rule':'Edit rule'}</p>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Rule name</p>
              <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Home Depot → Bay Hill" style={{ width:'100%', fontSize:12, padding:'6px 8px' }}/>
            </div>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>If description contains</p>
              <input value={form.keyword} onChange={e=>setForm(f=>({...f,keyword:e.target.value}))} placeholder="e.g. Home Depot" style={{ width:'100%', fontSize:12, padding:'6px 8px' }}/>
            </div>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>From account (optional)</p>
              <select value={form.fromAccount} onChange={e=>setForm(f=>({...f,fromAccount:e.target.value}))} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                <option value="">Any account</option>
                {ACCOUNTS.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>From category (optional)</p>
              <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                <option value="">Any category</option>
                {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Move to account</p>
              <select value={form.toAccount} onChange={e=>setForm(f=>({...f,toAccount:e.target.value}))} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                {ACCOUNTS.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'0 0 4px' }}>Change category to (optional)</p>
              <select value={form.toCategory} onChange={e=>setForm(f=>({...f,toCategory:e.target.value}))} style={{ width:'100%', fontSize:12, padding:'6px 8px' }}>
                <option value="">Keep existing</option>
                {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button onClick={()=>setEditing(null)} style={{ fontSize:12 }}>Cancel</button>
            <button onClick={save} disabled={!form.name||!form.toAccount}
              style={{ fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
              Save rule
            </button>
          </div>
        </div>
      )}

      {rules.length === 0 ? (
        <div style={{ textAlign:'center', padding:'20px', background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', fontSize:13, color:'var(--text-secondary)' }}>
          No rules yet. Create a rule to automatically move transactions between accounts.
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {rules.map(rule=>(
            <div key={rule.id} style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'10px 14px', display:'flex', alignItems:'center', gap:12 }}>
              <i className="ti ti-git-branch" style={{ fontSize:16, color:'var(--blue)', flexShrink:0 }} aria-hidden="true"/>
              <div style={{ flex:1 }}>
                <p style={{ fontSize:13, fontWeight:500, margin:0 }}>{rule.name}</p>
                <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'2px 0 0' }}>
                  {rule.keyword && `Contains "${rule.keyword}"`}
                  {rule.fromAccount && ` · From ${ACCOUNTS.find(a=>a.id===rule.fromAccount)?.name}`}
                  {rule.category && ` · Category: ${rule.category}`}
                  {' → '}{ACCOUNTS.find(a=>a.id===rule.toAccount)?.name}
                  {rule.toCategory && ` (${rule.toCategory})`}
                </p>
              </div>
              <button onClick={()=>{ setForm(rule); setEditing(rule.id) }} style={{ fontSize:11, padding:'4px 10px' }}>Edit</button>
              <button onClick={()=>onDelete(rule.id)} style={{ fontSize:11, padding:'4px 10px', color:'var(--coral)', borderColor:'var(--coral)', background:'var(--coral-light)' }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────
export default function TransactionTransfer({ transactions, onUpdate }) {
  const [rules, setRules] = useState(() => {
    try { return JSON.parse(localStorage.getItem('caishing_rules') || '[]') } catch { return [] }
  })
  const [transferModal, setTransferModal] = useState(null)
  const [splitModal, setSplitModal] = useState(null)
  const [filterAccount, setFilterAccount] = useState('all')
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('transactions')
  const [history, setHistory] = useState([])

  // Persist rules
  useEffect(() => {
    localStorage.setItem('caishing_rules', JSON.stringify(rules))
  }, [rules])

  const saveRule = rule => {
    setRules(prev => {
      const idx = prev.findIndex(r => r.id === rule.id)
      if (idx >= 0) return prev.map(r => r.id===rule.id ? rule : r)
      return [...prev, rule]
    })
  }

  const deleteRule = id => setRules(prev => prev.filter(r => r.id !== id))

  // Apply all rules to transactions
  const applyAllRules = () => {
    const updated = transactions.map(tx => applyRules(tx, rules))
    const changed = updated.filter((tx,i) => tx.account !== transactions[i]?.account || tx.category !== transactions[i]?.category)
    if (changed.length === 0) { alert('No transactions matched any rules.'); return }
    onUpdate(updated)
    setHistory(prev => [...prev, { type:'bulk_rule', count:changed.length, timestamp:new Date().toISOString() }])
  }

  // Manual transfer
  const handleTransfer = (tx, { toAccount, toCategory, note }) => {
    const updated = transactions.map(t => t.id===tx.id ? { ...t, account:toAccount, category:toCategory||t.category, transferNote:note, originalAccount:t.account } : t)
    onUpdate(updated)
    setHistory(prev => [...prev, { type:'transfer', desc:tx.desc, from:tx.account, to:toAccount, timestamp:new Date().toISOString() }])
    setTransferModal(null)
  }

  // Split transaction
  const handleSplit = (tx, splits) => {
    const newTxs = splits.map((sp,i) => ({
      ...tx,
      id: `${tx.id}_split${i}`,
      amount: -(sp.amount),
      account: sp.account,
      category: sp.category,
      splitNote: sp.note,
      isSplit: true,
      splitOf: tx.id,
    }))
    const updated = [...transactions.filter(t => t.id !== tx.id), ...newTxs]
    onUpdate(updated)
    setHistory(prev => [...prev, { type:'split', desc:tx.desc, parts:splits.length, timestamp:new Date().toISOString() }])
    setSplitModal(null)
  }

  // Filter
  const filtered = transactions.filter(t => {
    if (filterAccount !== 'all' && t.account !== filterAccount) return false
    if (filterCat !== 'all' && t.category !== filterCat) return false
    if (search && !t.desc.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }).slice(0, 200)

  const cats = [...new Set(transactions.map(t => t.category))].sort()

  return (
    <div>
      {/* Tabs */}
      <div style={{ display:'flex', gap:8, marginBottom:20, borderBottom:'0.5px solid var(--border)', paddingBottom:12 }}>
        {[['transactions','ti-arrows-exchange','Transactions'],['rules','ti-git-branch','Auto-Transfer Rules'],['history','ti-history','History']].map(([id,ico,lbl])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{ fontSize:13, padding:'7px 14px', background:tab===id?'var(--blue-light)':'var(--bg-card)', color:tab===id?'var(--blue)':'var(--text-secondary)', borderColor:tab===id?'var(--blue)':'var(--border)', display:'flex', alignItems:'center', gap:6 }}>
            <i className={`ti ${ico}`} style={{ fontSize:14 }} aria-hidden="true"/>{lbl}
          </button>
        ))}
        {tab==='transactions' && (
          <button onClick={applyAllRules} style={{ marginLeft:'auto', fontSize:12, background:'var(--teal-light)', color:'var(--teal)', borderColor:'var(--teal)' }}>
            <i className="ti ti-player-play" aria-hidden="true"/> Apply all rules
          </button>
        )}
      </div>

      {/* Transactions tab */}
      {tab==='transactions' && (
        <div>
          {transactions.length === 0 ? (
            <div style={{ textAlign:'center', padding:'3rem', background:'var(--bg-card)', borderRadius:'var(--radius-lg)', border:'0.5px solid var(--border)' }}>
              <i className="ti ti-arrows-exchange" style={{ fontSize:44, color:'var(--text-muted)', display:'block', marginBottom:12 }} aria-hidden="true"/>
              <p style={{ fontSize:15, fontWeight:500, margin:'0 0 6px' }}>No transactions loaded</p>
              <p style={{ fontSize:13, color:'var(--text-secondary)', margin:0 }}>Upload a bank statement in Personal Spending first, then come back here to transfer or split transactions.</p>
            </div>
          ) : (
            <>
              {/* Filters */}
              <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search transactions..." style={{ fontSize:13, padding:'7px 12px', flex:1, minWidth:180 }}/>
                <select value={filterAccount} onChange={e=>setFilterAccount(e.target.value)} style={{ fontSize:13, padding:'7px 10px' }}>
                  <option value="all">All accounts</option>
                  {ACCOUNTS.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={{ fontSize:13, padding:'7px 10px' }}>
                  <option value="all">All categories</option>
                  {cats.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 120px 140px 100px 120px', gap:0, padding:'8px 16px', background:'var(--bg-secondary)', borderBottom:'0.5px solid var(--border)', fontSize:11, color:'var(--text-secondary)', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.5px' }}>
                  <span>Transaction</span><span>Account</span><span>Category</span><span style={{ textAlign:'right' }}>Amount</span><span style={{ textAlign:'center' }}>Actions</span>
                </div>
                {filtered.map((t,i)=>{
                  const acct = ACCOUNTS.find(a=>a.id===t.account)
                  const ico = CAT_ICONS[t.category]||'ti-dots'
                  return (
                    <div key={t.id} style={{ display:'grid', gridTemplateColumns:'1fr 120px 140px 100px 120px', gap:0, padding:'10px 16px', borderBottom:i<filtered.length-1?'0.5px solid var(--border)':'none', alignItems:'center' }}>
                      <div style={{ minWidth:0 }}>
                        <p style={{ fontSize:13, fontWeight:500, margin:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{t.desc}</p>
                        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:2 }}>
                          <p style={{ fontSize:11, color:'var(--text-secondary)', margin:0 }}>{t.date}</p>
                          {t.isSplit && <span style={{ fontSize:10, padding:'1px 6px', background:'var(--purple-light)', color:'var(--purple)', borderRadius:4 }}>Split</span>}
                          {t.ruleApplied && <span style={{ fontSize:10, padding:'1px 6px', background:'var(--teal-light)', color:'var(--teal)', borderRadius:4 }}>Auto-transferred</span>}
                          {t.originalAccount && <span style={{ fontSize:10, color:'var(--text-muted)' }}>was {ACCOUNTS.find(a=>a.id===t.originalAccount)?.name}</span>}
                        </div>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <i className={`ti ${acct?.icon||'ti-wallet'}`} style={{ fontSize:13, color:acct?.color||'var(--text-secondary)' }} aria-hidden="true"/>
                        <span style={{ fontSize:12, color:'var(--text-secondary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{acct?.name||t.account}</span>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <i className={`ti ${ico}`} style={{ fontSize:13, color:'var(--text-secondary)' }} aria-hidden="true"/>
                        <span style={{ fontSize:12, color:'var(--text-secondary)' }}>{t.category}</span>
                      </div>
                      <p style={{ fontSize:13, fontWeight:500, margin:0, textAlign:'right', color:t.amount>=0?'var(--teal)':'var(--coral)' }}>{fd(t.amount)}</p>
                      <div style={{ display:'flex', gap:4, justifyContent:'center' }}>
                        <button onClick={()=>setTransferModal(t)} style={{ fontSize:11, padding:'4px 8px', background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }} title="Move to another account">
                          <i className="ti ti-arrows-exchange" aria-hidden="true"/>
                        </button>
                        <button onClick={()=>setSplitModal(t)} style={{ fontSize:11, padding:'4px 8px', background:'var(--purple-light)', color:'var(--purple)', borderColor:'var(--purple)' }} title="Split transaction">
                          <i className="ti ti-scissors" aria-hidden="true"/>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              {filtered.length === 0 && <p style={{ textAlign:'center', padding:'20px', color:'var(--text-secondary)', fontSize:13 }}>No transactions match your filters.</p>}
            </>
          )}
        </div>
      )}

      {/* Rules tab */}
      {tab==='rules' && (
        <div>
          <div style={{ background:'var(--bg-secondary)', borderRadius:'var(--radius-md)', padding:'12px 14px', marginBottom:16, display:'flex', gap:10, alignItems:'flex-start' }}>
            <i className="ti ti-info-circle" style={{ fontSize:16, color:'var(--blue)', flexShrink:0, marginTop:1 }} aria-hidden="true"/>
            <p style={{ fontSize:12, color:'var(--text-secondary)', margin:0, lineHeight:1.6 }}>
              Rules automatically move transactions to the correct account or property when you click "Apply all rules". For example: if a transaction contains "Home Depot" and comes from the Haas account, automatically move it to Bay Hill under Repairs & Maintenance.
            </p>
          </div>
          <RuleBuilder rules={rules} onSave={saveRule} onDelete={deleteRule}/>
        </div>
      )}

      {/* History tab */}
      {tab==='history' && (
        <div>
          {history.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', background:'var(--bg-card)', borderRadius:'var(--radius-lg)', border:'0.5px solid var(--border)', fontSize:13, color:'var(--text-secondary)' }}>
              No transfer history yet. Move or split a transaction to see it here.
            </div>
          ) : (
            <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden' }}>
              {[...history].reverse().map((h,i)=>(
                <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderBottom:i<history.length-1?'0.5px solid var(--border)':'none' }}>
                  <i className={`ti ${h.type==='split'?'ti-scissors':h.type==='bulk_rule'?'ti-player-play':'ti-arrows-exchange'}`} style={{ fontSize:15, color:'var(--blue)', flexShrink:0 }} aria-hidden="true"/>
                  <div style={{ flex:1 }}>
                    {h.type==='transfer' && <p style={{ fontSize:13, margin:0 }}><strong>{h.desc}</strong> moved from <strong>{ACCOUNTS.find(a=>a.id===h.from)?.name||h.from}</strong> → <strong>{ACCOUNTS.find(a=>a.id===h.to)?.name||h.to}</strong></p>}
                    {h.type==='split' && <p style={{ fontSize:13, margin:0 }}><strong>{h.desc}</strong> split into {h.parts} transactions</p>}
                    {h.type==='bulk_rule' && <p style={{ fontSize:13, margin:0 }}>Rules applied — {h.count} transactions updated</p>}
                    <p style={{ fontSize:11, color:'var(--text-secondary)', margin:'2px 0 0' }}>{new Date(h.timestamp).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {transferModal && <TransferModal tx={transferModal} onConfirm={(opts)=>handleTransfer(transferModal,opts)} onClose={()=>setTransferModal(null)}/>}
      {splitModal && <SplitModal tx={splitModal} onConfirm={(splits)=>handleSplit(splitModal,splits)} onClose={()=>setSplitModal(null)}/>}
    </div>
  )
}