import { useState, useEffect, useRef } from 'react'
import axios from 'axios'

const API = 'http://localhost:3001/api'

const fd = (n, d=2) => (n<0?'-$':'$')+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})

const PROPERTIES = [
  { id:'haas',      name:'Haas',      type:'property', icon:'ti-building-estate', color:'var(--blue)'   },
  { id:'kobe',      name:'Kobe',      type:'property', icon:'ti-building-estate', color:'var(--teal)'   },
  { id:'bayhill',   name:'Bay Hill',  type:'property', icon:'ti-building-estate', color:'var(--purple)' },
  { id:'muirfield', name:'Muirfield', type:'property', icon:'ti-building-estate', color:'var(--amber)'  },
  { id:'alcita',    name:'Alcita',    type:'property', icon:'ti-building-estate', color:'var(--coral)'  },
]
const BASE_ACCOUNTS = [
  { id:'personal', name:'Personal',       type:'personal', icon:'ti-wallet',        color:'var(--pink)'   },
  { id:'business', name:'Business',       type:'business', icon:'ti-briefcase',     color:'var(--purple)' },
  { id:'chase',    name:'Chase Checking', type:'bank',     icon:'ti-building-bank', color:'var(--blue)'   },
  { id:'schwab',   name:'Schwab',         type:'bank',     icon:'ti-chart-candle',  color:'var(--purple)' },
  { id:'amex',     name:'Amex Platinum',  type:'credit',   icon:'ti-credit-card',   color:'var(--teal)'   },
  ...PROPERTIES,
]

const CATEGORIES = [
  'Dining','Groceries','Shopping','Transport','Travel','Entertainment',
  'Fitness','Health','Subscriptions','Coffee','Tech','Utilities',
  'Repairs & Maintenance','Property Management','Insurance','HOA','Mortgage',
  'Income','Transfer','Other',
]
const CAT_ICONS = {
  'Dining':'ti-tools-kitchen-2','Groceries':'ti-apple','Shopping':'ti-shopping-bag',
  'Transport':'ti-car','Travel':'ti-plane','Entertainment':'ti-device-tv',
  'Fitness':'ti-barbell','Health':'ti-heart-rate-monitor','Subscriptions':'ti-refresh',
  'Coffee':'ti-coffee','Tech':'ti-device-laptop','Utilities':'ti-bolt',
  'Repairs & Maintenance':'ti-hammer','Property Management':'ti-building-estate',
  'Insurance':'ti-shield','HOA':'ti-home','Mortgage':'ti-home-dollar',
  'Income':'ti-arrow-down-left','Transfer':'ti-arrows-exchange','Other':'ti-dots',
}

const today = () => new Date().toISOString().split('T')[0]

const DATE_RANGES = [
  { id:'this_month',   label:'This month' },
  { id:'last_month',   label:'Last month' },
  { id:'last_3',       label:'Last 3 months' },
  { id:'ytd',          label:'Year to date' },
  { id:'last_year',    label:'Last year' },
  { id:'all',          label:'All time' },
  { id:'custom',       label:'Custom range' },
]

function getDateRange(rangeId, customFrom, customTo) {
  const now  = new Date()
  const y    = now.getFullYear()
  const m    = now.getMonth()
  if (rangeId === 'this_month')  return { from:`${y}-${String(m+1).padStart(2,'0')}-01`, to:today() }
  if (rangeId === 'last_month') {
    const lm = new Date(y, m, 1); lm.setDate(0)
    const fm = new Date(y, m-1, 1)
    return { from:fm.toISOString().split('T')[0], to:lm.toISOString().split('T')[0] }
  }
  if (rangeId === 'last_3') {
    const from = new Date(y, m-2, 1)
    return { from:from.toISOString().split('T')[0], to:today() }
  }
  if (rangeId === 'ytd') return { from:`${y}-01-01`, to:today() }
  if (rangeId === 'last_year') return { from:`${y-1}-01-01`, to:`${y-1}-12-31` }
  if (rangeId === 'custom') return { from:customFrom||`${y}-01-01`, to:customTo||today() }
  return { from:null, to:null } // all
}

function applyRules(tx, rules) {
  for (const rule of rules) {
    const descMatch = !rule.keyword  || tx.desc.toLowerCase().includes(rule.keyword.toLowerCase())
    const acctMatch = !rule.fromAccount || tx.account === rule.fromAccount
    const catMatch  = !rule.category || tx.category === rule.category
    if (descMatch && acctMatch && catMatch) {
      return { ...tx, account:rule.toAccount, category:rule.toCategory||tx.category, ruleApplied:rule.id }
    }
  }
  return tx
}

// ── Inline row form (add / edit) ──────────────────────────────────────
function TxRowForm({ initial, accounts, onSave, onCancel, isNew }) {
  const [form, setForm] = useState({
    date: initial?.date || today(),
    desc: initial?.desc || '',
    account: initial?.account || accounts[0]?.id || 'personal',
    category: initial?.category || 'Other',
    amount: initial?.amount !== undefined ? String(Math.abs(initial.amount)) : '',
    isExpense: initial?.amount !== undefined ? initial.amount < 0 : true,
    reconciled: initial?.reconciled || false,
    note: initial?.note || '',
  })
  const descRef = useRef()

  useEffect(() => { descRef.current?.focus() }, [])

  const save = () => {
    if (!form.desc.trim() || !form.amount || isNaN(parseFloat(form.amount))) return
    const amount = form.isExpense ? -Math.abs(parseFloat(form.amount)) : Math.abs(parseFloat(form.amount))
    onSave({ ...form, amount, desc: form.desc.trim() })
  }

  return (
    <div style={{ background:'var(--blue-light)', border:'1px solid var(--blue)', borderRadius:'var(--radius-md)', padding:'10px 14px', marginBottom:4 }}>
      <div style={{ display:'grid', gridTemplateColumns:'130px 1fr 160px 170px auto auto 80px', gap:8, alignItems:'center' }}>
        <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}
          style={{ fontSize:12, padding:'5px 8px' }}/>
        <input ref={descRef} value={form.desc} onChange={e=>setForm(f=>({...f,desc:e.target.value}))}
          placeholder="Description / payee" style={{ fontSize:12, padding:'5px 8px' }}
          onKeyDown={e=>{ if(e.key==='Enter') save(); if(e.key==='Escape') onCancel() }}/>
        <select value={form.account} onChange={e=>setForm(f=>({...f,account:e.target.value}))}
          style={{ fontSize:12, padding:'5px 8px' }}>
          {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}
          style={{ fontSize:12, padding:'5px 8px' }}>
          {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
        {/* Payment / Deposit toggle + amount */}
        <div style={{ display:'flex', gap:4, alignItems:'center' }}>
          <button type="button" onClick={()=>setForm(f=>({...f,isExpense:true}))}
            style={{ fontSize:11, padding:'4px 8px', background:form.isExpense?'var(--coral)':'var(--bg-card)', color:form.isExpense?'#fff':'var(--text-secondary)', border:`1px solid ${form.isExpense?'var(--coral)':'var(--border)'}`, borderRadius:'var(--radius-sm)', cursor:'pointer' }}>
            Payment
          </button>
          <button type="button" onClick={()=>setForm(f=>({...f,isExpense:false}))}
            style={{ fontSize:11, padding:'4px 8px', background:!form.isExpense?'var(--teal)':'var(--bg-card)', color:!form.isExpense?'#fff':'var(--text-secondary)', border:`1px solid ${!form.isExpense?'var(--teal)':'var(--border)'}`, borderRadius:'var(--radius-sm)', cursor:'pointer' }}>
            Deposit
          </button>
        </div>
        <input type="number" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))}
          placeholder="0.00" min="0" step="0.01"
          style={{ fontSize:12, padding:'5px 8px', textAlign:'right', width:90 }}
          onKeyDown={e=>{ if(e.key==='Enter') save(); if(e.key==='Escape') onCancel() }}/>
        <div style={{ display:'flex', gap:4 }}>
          <button onClick={save} disabled={!form.desc.trim() || !form.amount}
            style={{ fontSize:11, padding:'4px 8px', background:'var(--blue)', color:'#fff', border:'none', borderRadius:'var(--radius-sm)', cursor:'pointer', fontWeight:500 }}>
            {isNew ? 'Add' : 'Save'}
          </button>
          <button onClick={onCancel}
            style={{ fontSize:11, padding:'4px 8px', background:'none', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', cursor:'pointer' }}>
            ✕
          </button>
        </div>
      </div>
      <input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}
        placeholder="Memo / note (optional)" style={{ fontSize:11, padding:'4px 8px', marginTop:6, width:'100%' }}/>
    </div>
  )
}

// ── Split modal ───────────────────────────────────────────────────────
function SplitModal({ tx, accounts, onConfirm, onClose }) {
  const [splits, setSplits] = useState([
    { account:accounts[0]?.id||'personal', category:tx.category, amount:Math.abs(tx.amount), pct:100, note:'' }
  ])
  const totalPct = splits.reduce((s,sp)=>s+sp.pct,0)
  const totalAmt = splits.reduce((s,sp)=>s+sp.amount,0)
  const addSplit    = () => setSplits(prev=>[...prev,{account:accounts[0]?.id||'personal',category:tx.category,amount:0,pct:0,note:''}])
  const removeSplit = i  => setSplits(prev=>prev.filter((_,idx)=>idx!==i))
  const updateSplit = (i,field,val) => setSplits(prev=>prev.map((sp,idx)=>{
    if(idx!==i) return sp
    const u={...sp,[field]:val}
    if(field==='pct')    u.amount=parseFloat((Math.abs(tx.amount)*val/100).toFixed(2))
    if(field==='amount') u.pct=parseFloat((val/Math.abs(tx.amount)*100).toFixed(1))
    return u
  }))

  return (
    <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000 }}>
      <div style={{ background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'1.5rem',width:540,maxHeight:'80vh',overflowY:'auto' }}>
        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16 }}>
          <div>
            <p style={{ fontSize:15,fontWeight:500,margin:0 }}>Split transaction</p>
            <p style={{ fontSize:12,color:'var(--text-secondary)',margin:'2px 0 0' }}>{tx.desc} · {fd(tx.amount)}</p>
          </div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'var(--text-secondary)',fontSize:18,padding:4 }}>✕</button>
        </div>
        {splits.map((sp,i)=>(
          <div key={i} style={{ background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',padding:'12px 14px',marginBottom:10 }}>
            <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10 }}>
              <p style={{ fontSize:13,fontWeight:500,margin:0 }}>Split {i+1}</p>
              {splits.length>1 && <button onClick={()=>removeSplit(i)} style={{ background:'none',border:'none',color:'var(--coral)',fontSize:12,cursor:'pointer',padding:0 }}>Remove</button>}
            </div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8 }}>
              <div>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Account / Property</p>
                <select value={sp.account} onChange={e=>updateSplit(i,'account',e.target.value)} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                  {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Category</p>
                <select value={sp.category} onChange={e=>updateSplit(i,'category',e.target.value)} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                  {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8 }}>
              <div>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Amount ($)</p>
                <input type="number" value={sp.amount} onChange={e=>updateSplit(i,'amount',parseFloat(e.target.value)||0)} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}/>
              </div>
              <div>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Percent (%)</p>
                <input type="number" value={sp.pct} onChange={e=>updateSplit(i,'pct',parseFloat(e.target.value)||0)} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}/>
              </div>
              <div>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Note</p>
                <input type="text" value={sp.note} onChange={e=>updateSplit(i,'note',e.target.value)} placeholder="Optional" style={{ width:'100%',fontSize:12,padding:'6px 8px' }}/>
              </div>
            </div>
          </div>
        ))}
        <button onClick={addSplit} style={{ width:'100%',fontSize:12,marginBottom:14,background:'var(--bg-secondary)' }}>
          <i className="ti ti-plus" aria-hidden="true"/> Add split
        </button>
        <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 12px',background:'var(--bg-secondary)',borderRadius:'var(--radius-sm)',marginBottom:14,fontSize:12 }}>
          <span style={{ color:'var(--text-secondary)' }}>Total allocated</span>
          <span style={{ fontWeight:500,color:Math.abs(totalAmt-Math.abs(tx.amount))<0.01?'var(--teal)':'var(--coral)' }}>
            {fd(totalAmt)} / {fd(Math.abs(tx.amount))} ({totalPct.toFixed(1)}%)
          </span>
        </div>
        <div style={{ display:'flex',gap:8,justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ fontSize:12 }}>Cancel</button>
          <button onClick={()=>onConfirm(splits)} disabled={Math.abs(totalPct-100)>0.5}
            style={{ fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)' }}>
            Confirm split
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Rule builder ──────────────────────────────────────────────────────
function RuleBuilder({ rules, accounts, onSave, onDelete }) {
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ keyword:'',fromAccount:'',category:'',toAccount:'',toCategory:'',name:'' })
  const startNew = () => { setForm({ keyword:'',fromAccount:'',category:'',toAccount:accounts[0]?.id||'personal',toCategory:'',name:'' }); setEditing('new') }
  const save = () => { onSave({ ...form, id:editing==='new'?Date.now().toString():editing }); setEditing(null) }

  return (
    <div>
      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12 }}>
        <p style={{ fontSize:13,fontWeight:500,margin:0 }}>Auto-transfer rules</p>
        <button onClick={startNew} style={{ fontSize:12,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)' }}>
          <i className="ti ti-plus" aria-hidden="true"/> New rule
        </button>
      </div>
      {editing && (
        <div style={{ background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',padding:'14px',marginBottom:12,border:'0.5px solid var(--blue)' }}>
          <p style={{ fontSize:13,fontWeight:500,margin:'0 0 12px' }}>{editing==='new'?'New rule':'Edit rule'}</p>
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10 }}>
            {[['Rule name','name','e.g. Home Depot → Bay Hill'],['If description contains','keyword','e.g. Home Depot']].map(([lbl,key,ph])=>(
              <div key={key}>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>{lbl}</p>
                <input value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} placeholder={ph} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}/>
              </div>
            ))}
            <div>
              <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>From account (optional)</p>
              <select value={form.fromAccount} onChange={e=>setForm(f=>({...f,fromAccount:e.target.value}))} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                <option value="">Any account</option>
                {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>From category (optional)</p>
              <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                <option value="">Any category</option>
                {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Move to account</p>
              <select value={form.toAccount} onChange={e=>setForm(f=>({...f,toAccount:e.target.value}))} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px' }}>Change category to (optional)</p>
              <select value={form.toCategory} onChange={e=>setForm(f=>({...f,toCategory:e.target.value}))} style={{ width:'100%',fontSize:12,padding:'6px 8px' }}>
                <option value="">Keep existing</option>
                {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display:'flex',gap:8,justifyContent:'flex-end' }}>
            <button onClick={()=>setEditing(null)} style={{ fontSize:12 }}>Cancel</button>
            <button onClick={save} disabled={!form.name||!form.toAccount}
              style={{ fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)' }}>
              Save rule
            </button>
          </div>
        </div>
      )}
      {rules.length===0 ? (
        <div style={{ textAlign:'center',padding:'20px',background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',fontSize:13,color:'var(--text-secondary)' }}>
          No rules yet. Create a rule to automatically move transactions between accounts.
        </div>
      ) : (
        <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
          {rules.map(rule=>(
            <div key={rule.id} style={{ background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',padding:'10px 14px',display:'flex',alignItems:'center',gap:12 }}>
              <i className="ti ti-git-branch" style={{ fontSize:16,color:'var(--blue)',flexShrink:0 }} aria-hidden="true"/>
              <div style={{ flex:1 }}>
                <p style={{ fontSize:13,fontWeight:500,margin:0 }}>{rule.name}</p>
                <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'2px 0 0' }}>
                  {rule.keyword&&`Contains "${rule.keyword}"`}
                  {rule.fromAccount&&` · From ${accounts.find(a=>a.id===rule.fromAccount)?.name}`}
                  {rule.category&&` · Category: ${rule.category}`}
                  {' → '}{accounts.find(a=>a.id===rule.toAccount)?.name}
                  {rule.toCategory&&` (${rule.toCategory})`}
                </p>
              </div>
              <button onClick={()=>{ setForm(rule); setEditing(rule.id) }} style={{ fontSize:11,padding:'4px 10px' }}>Edit</button>
              <button onClick={()=>onDelete(rule.id)} style={{ fontSize:11,padding:'4px 10px',color:'var(--coral)',borderColor:'var(--coral)',background:'var(--coral-light)' }}>Delete</button>
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
    try { return JSON.parse(localStorage.getItem('caishing_rules')||'[]') } catch { return [] }
  })
  const [splitModal,    setSplitModal]    = useState(null)
  const [filterAccount, setFilterAccount] = useState('all')
  const [filterCat,     setFilterCat]     = useState('all')
  const [search,        setSearch]        = useState('')
  const [tab,           setTab]           = useState('register')
  const [history,       setHistory]       = useState([])
  const [dateRange,     setDateRange]     = useState('this_month')
  const [customFrom,    setCustomFrom]    = useState('')
  const [customTo,      setCustomTo]      = useState('')
  const [addingNew,     setAddingNew]     = useState(false)
  const [editingId,     setEditingId]     = useState(null)
  const [showReconciled, setShowReconciled] = useState(true)
  const [savingId,      setSavingId]      = useState(null)
  const [accounts,      setAccounts]      = useState(BASE_ACCOUNTS)

  // Merge Plaid account names into the accounts list
  useEffect(() => {
    axios.get(`${API}/accounts`).then(r => {
      const plaidAccts = (r.data || []).filter(a => a.source === 'plaid').map(a => ({
        id: a.id, name: a.name, type: a.type, icon: 'ti-building-bank', color: 'var(--blue)'
      }))
      if (plaidAccts.length) {
        setAccounts(prev => {
          const ids = new Set(prev.map(a => a.id))
          return [...prev, ...plaidAccts.filter(a => !ids.has(a.id))]
        })
      }
    }).catch(() => {})
  }, [])

  // Persist rules
  useEffect(() => { localStorage.setItem('caishing_rules', JSON.stringify(rules)) }, [rules])

  const saveRule   = rule => setRules(prev => { const i=prev.findIndex(r=>r.id===rule.id); return i>=0?prev.map(r=>r.id===rule.id?rule:r):[...prev,rule] })
  const deleteRule = id   => setRules(prev => prev.filter(r => r.id !== id))

  const applyAllRules = () => {
    const updated = transactions.map(tx => applyRules(tx, rules))
    const changed = updated.filter((tx,i) => tx.account !== transactions[i]?.account || tx.category !== transactions[i]?.category)
    if (!changed.length) { alert('No transactions matched any rules.'); return }
    onUpdate(updated)
    setHistory(prev => [...prev, { type:'bulk_rule', count:changed.length, timestamp:new Date().toISOString() }])
  }

  // ── Add new transaction ──────────────────────────────────────────────
  const handleAdd = async (form) => {
    try {
      const res = await axios.post(`${API}/transactions`, {
        date: form.date, desc: form.desc, amount: form.amount,
        category: form.category, account: form.account, note: form.note,
      })
      onUpdate([...transactions, res.data])
      setHistory(prev => [...prev, { type:'add', desc:form.desc, timestamp:new Date().toISOString() }])
    } catch (e) { console.error('Add tx failed:', e.message) }
    setAddingNew(false)
  }

  // ── Save inline edit ─────────────────────────────────────────────────
  const handleEdit = async (tx, form) => {
    setSavingId(tx.id)
    try {
      await axios.patch(`${API}/transactions/${tx.id}`, {
        date: form.date, desc: form.desc, amount: form.amount,
        category: form.category, account: form.account, note: form.note,
      })
      onUpdate(transactions.map(t => t.id===tx.id ? { ...t, ...form } : t))
      setHistory(prev => [...prev, { type:'edit', desc:form.desc, timestamp:new Date().toISOString() }])
    } catch (e) { console.error('Edit tx failed:', e.message) }
    setSavingId(null)
    setEditingId(null)
  }

  // ── Delete transaction ───────────────────────────────────────────────
  const handleDelete = async (tx) => {
    if (!window.confirm(`Delete "${tx.desc}"?`)) return
    try {
      await axios.delete(`${API}/transactions/${tx.id}`)
      onUpdate(transactions.filter(t => t.id !== tx.id))
      setHistory(prev => [...prev, { type:'delete', desc:tx.desc, timestamp:new Date().toISOString() }])
    } catch (e) { console.error('Delete tx failed:', e.message) }
  }

  // ── Toggle reconciled ────────────────────────────────────────────────
  const toggleReconciled = async (tx) => {
    const newVal = !tx.reconciled
    try {
      await axios.patch(`${API}/transactions/${tx.id}`, { reconciled: newVal })
      onUpdate(transactions.map(t => t.id===tx.id ? { ...t, reconciled:newVal } : t))
    } catch { onUpdate(transactions.map(t => t.id===tx.id ? { ...t, reconciled:newVal } : t)) }
  }

  // ── Split ────────────────────────────────────────────────────────────
  const handleSplit = (tx, splits) => {
    const newTxs = splits.map((sp,i) => ({
      ...tx, id:`${tx.id}_split${i}`, amount:-(sp.amount),
      account:sp.account, category:sp.category, splitNote:sp.note,
      isSplit:true, splitOf:tx.id,
    }))
    onUpdate([...transactions.filter(t=>t.id!==tx.id), ...newTxs])
    setHistory(prev => [...prev, { type:'split', desc:tx.desc, parts:splits.length, timestamp:new Date().toISOString() }])
    setSplitModal(null)
  }

  // ── Filter ───────────────────────────────────────────────────────────
  const { from: rangeFrom, to: rangeTo } = getDateRange(dateRange, customFrom, customTo)

  const filtered = transactions.filter(t => {
    if (filterAccount !== 'all' && t.account !== filterAccount) return false
    if (filterCat     !== 'all' && t.category !== filterCat)   return false
    if (search && !t.desc?.toLowerCase().includes(search.toLowerCase()) && !t.note?.toLowerCase().includes(search.toLowerCase())) return false
    if (!showReconciled && t.reconciled) return false
    if (rangeFrom && t.date < rangeFrom) return false
    if (rangeTo   && t.date > rangeTo)   return false
    return true
  }).sort((a,b) => b.date.localeCompare(a.date))

  // Running balance (only when single account selected, sorted oldest→newest)
  const withBalance = (() => {
    if (filterAccount === 'all') return filtered.map(t => ({ ...t, runningBalance: null }))
    const sorted = [...filtered].sort((a,b) => a.date.localeCompare(b.date))
    let bal = 0
    const withBal = sorted.map(t => { bal += t.amount; return { ...t, runningBalance: bal } })
    // reverse back to newest-first for display
    return withBal.reverse()
  })()

  // Summary stats
  const totalIn  = filtered.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0)
  const totalOut = filtered.filter(t=>t.amount<0).reduce((s,t)=>s+t.amount,0)
  const net      = totalIn + totalOut
  const cats     = [...new Set(transactions.map(t=>t.category))].sort()

  return (
    <div>
      {/* Tabs */}
      <div style={{ display:'flex', gap:8, marginBottom:20, borderBottom:'0.5px solid var(--border)', paddingBottom:12 }}>
        {[['register','ti-table','Register'],['rules','ti-git-branch','Auto-Transfer Rules'],['history','ti-history','History']].map(([id,ico,lbl])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{ fontSize:13,padding:'7px 14px',background:tab===id?'var(--blue-light)':'var(--bg-card)',color:tab===id?'var(--blue)':'var(--text-secondary)',borderColor:tab===id?'var(--blue)':'var(--border)',display:'flex',alignItems:'center',gap:6 }}>
            <i className={`ti ${ico}`} style={{ fontSize:14 }} aria-hidden="true"/>{lbl}
          </button>
        ))}
        {tab==='register' && (
          <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
            <button onClick={applyAllRules} style={{ fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)' }}>
              <i className="ti ti-player-play" aria-hidden="true"/> Apply rules
            </button>
            <button onClick={()=>{ setAddingNew(true); setEditingId(null) }}
              style={{ fontSize:12,background:'var(--blue)',color:'#fff',border:'none',borderRadius:'var(--radius-md)',padding:'7px 14px',cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontWeight:500 }}>
              <i className="ti ti-plus" aria-hidden="true"/> Add transaction
            </button>
          </div>
        )}
      </div>

      {/* Register tab */}
      {tab==='register' && (
        <div>
          {/* Filters toolbar */}
          <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search description or note..."
              style={{ fontSize:12,padding:'6px 10px',flex:1,minWidth:180 }}/>
            <select value={filterAccount} onChange={e=>setFilterAccount(e.target.value)} style={{ fontSize:12,padding:'6px 8px' }}>
              <option value="all">All accounts</option>
              <optgroup label="Bank / Credit">
                {accounts.filter(a=>['bank','credit','personal','business'].includes(a.type)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </optgroup>
              <optgroup label="Properties">
                {PROPERTIES.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </optgroup>
            </select>
            <select value={filterCat} onChange={e=>setFilterCat(e.target.value)} style={{ fontSize:12,padding:'6px 8px' }}>
              <option value="all">All categories</option>
              {cats.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <select value={dateRange} onChange={e=>setDateRange(e.target.value)} style={{ fontSize:12,padding:'6px 8px' }}>
              {DATE_RANGES.map(d=><option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            {dateRange==='custom' && (
              <>
                <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)} style={{ fontSize:12,padding:'5px 8px' }}/>
                <span style={{ fontSize:12,color:'var(--text-muted)' }}>–</span>
                <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)} style={{ fontSize:12,padding:'5px 8px' }}/>
              </>
            )}
            <label style={{ display:'flex',alignItems:'center',gap:5,fontSize:12,color:'var(--text-secondary)',cursor:'pointer',whiteSpace:'nowrap' }}>
              <input type="checkbox" checked={showReconciled} onChange={e=>setShowReconciled(e.target.checked)}/>
              Show reconciled
            </label>
          </div>

          {/* Summary bar */}
          <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:14 }}>
            {[
              ['Deposits',   fd(totalIn),   'var(--teal)', 'ti-arrow-down-left'],
              ['Payments',   fd(Math.abs(totalOut)), 'var(--coral)', 'ti-arrow-up-right'],
              ['Net',        fd(net),        net>=0?'var(--teal)':'var(--coral)', 'ti-scale'],
              ['Transactions', filtered.length, 'var(--blue)', 'ti-list'],
            ].map(([lbl,val,color,icon])=>(
              <div key={lbl} style={{ background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',padding:'10px 14px',display:'flex',alignItems:'center',gap:10 }}>
                <i className={`ti ${icon}`} style={{ fontSize:18,color,flexShrink:0 }} aria-hidden="true"/>
                <div>
                  <p style={{ fontSize:10,color:'var(--text-secondary)',margin:'0 0 2px',textTransform:'uppercase',letterSpacing:'0.5px' }}>{lbl}</p>
                  <p style={{ fontSize:16,fontWeight:500,margin:0,color }}>{val}</p>
                </div>
              </div>
            ))}
          </div>

          {/* New transaction inline form */}
          {addingNew && (
            <TxRowForm
              accounts={accounts} isNew={true}
              onSave={handleAdd}
              onCancel={()=>setAddingNew(false)}
            />
          )}

          {/* Register table */}
          {transactions.length === 0 ? (
            <div style={{ textAlign:'center',padding:'3rem',background:'var(--bg-card)',borderRadius:'var(--radius-lg)',border:'0.5px solid var(--border)' }}>
              <i className="ti ti-table" style={{ fontSize:44,color:'var(--text-muted)',display:'block',marginBottom:12 }} aria-hidden="true"/>
              <p style={{ fontSize:15,fontWeight:500,margin:'0 0 6px' }}>No transactions loaded</p>
              <p style={{ fontSize:13,color:'var(--text-secondary)',margin:0 }}>Connect a bank via Plaid or upload a CSV in Connections.</p>
            </div>
          ) : (
            <div style={{ background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
              {/* Header */}
              <div style={{ display:'grid',gridTemplateColumns:'28px 120px 1fr 140px 160px 100px 100px 110px 72px',gap:0,padding:'8px 14px',background:'var(--bg-secondary)',borderBottom:'0.5px solid var(--border)',fontSize:11,color:'var(--text-secondary)',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.5px' }}>
                <span title="Reconciled">R</span>
                <span>Date</span>
                <span>Description</span>
                <span>Account</span>
                <span>Category</span>
                <span style={{ textAlign:'right' }}>Payment</span>
                <span style={{ textAlign:'right' }}>Deposit</span>
                <span style={{ textAlign:'right' }}>{filterAccount!=='all'?'Balance':'Amount'}</span>
                <span/>
              </div>

              {withBalance.length === 0 && (
                <p style={{ textAlign:'center',padding:'24px',color:'var(--text-secondary)',fontSize:13 }}>No transactions match your filters.</p>
              )}

              {withBalance.map((t,i) => {
                const acct = accounts.find(a=>a.id===t.account)
                const ico  = CAT_ICONS[t.category]||'ti-dots'
                const isEditing = editingId === t.id
                const payment = t.amount < 0 ? Math.abs(t.amount) : null
                const deposit = t.amount > 0 ? t.amount : null

                if (isEditing) {
                  return (
                    <div key={t.id} style={{ padding:'8px 14px', borderBottom:'0.5px solid var(--border)' }}>
                      <TxRowForm
                        initial={t} accounts={accounts} isNew={false}
                        onSave={form => handleEdit(t, form)}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                  )
                }

                return (
                  <div key={t.id}
                    style={{ display:'grid',gridTemplateColumns:'28px 120px 1fr 140px 160px 100px 100px 110px 72px',gap:0,padding:'8px 14px',borderBottom:i<withBalance.length-1?'0.5px solid var(--border)':'none',alignItems:'center',opacity:savingId===t.id?0.5:1 }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--bg-secondary)'}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>

                    {/* Reconciled */}
                    <button onClick={()=>toggleReconciled(t)} title={t.reconciled?'Reconciled — click to unmark':'Mark as reconciled'}
                      style={{ background:'none',border:'none',padding:0,cursor:'pointer',color:t.reconciled?'var(--teal)':'var(--border)',fontSize:15,display:'flex',alignItems:'center' }}>
                      <i className={`ti ${t.reconciled?'ti-circle-check':'ti-circle'}`} aria-hidden="true"/>
                    </button>

                    {/* Date */}
                    <span style={{ fontSize:12,color:'var(--text-secondary)' }}>{t.date}</span>

                    {/* Description */}
                    <div style={{ minWidth:0 }}>
                      <p style={{ fontSize:13,fontWeight:500,margin:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{t.desc}</p>
                      <div style={{ display:'flex',alignItems:'center',gap:5,marginTop:1 }}>
                        {t.note && <span style={{ fontSize:10,color:'var(--text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{t.note}</span>}
                        {t.isSplit && <span style={{ fontSize:9,padding:'1px 5px',background:'var(--purple-light)',color:'var(--purple)',borderRadius:4,flexShrink:0 }}>Split</span>}
                        {t.ruleApplied && <span style={{ fontSize:9,padding:'1px 5px',background:'var(--teal-light)',color:'var(--teal)',borderRadius:4,flexShrink:0 }}>Rule</span>}
                        {t.source==='manual' && <span style={{ fontSize:9,padding:'1px 5px',background:'var(--amber-light)',color:'var(--amber)',borderRadius:4,flexShrink:0 }}>Manual</span>}
                      </div>
                    </div>

                    {/* Account */}
                    <div style={{ display:'flex',alignItems:'center',gap:5,minWidth:0 }}>
                      <i className={`ti ${acct?.icon||'ti-wallet'}`} style={{ fontSize:12,color:acct?.color||'var(--text-secondary)',flexShrink:0 }} aria-hidden="true"/>
                      <span style={{ fontSize:12,color:'var(--text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{acct?.name||t.account||'—'}</span>
                    </div>

                    {/* Category */}
                    <div style={{ display:'flex',alignItems:'center',gap:5 }}>
                      <i className={`ti ${ico}`} style={{ fontSize:12,color:'var(--text-secondary)' }} aria-hidden="true"/>
                      <span style={{ fontSize:12,color:'var(--text-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{t.category}</span>
                    </div>

                    {/* Payment */}
                    <span style={{ fontSize:13,fontWeight:500,textAlign:'right',color:'var(--coral)' }}>
                      {payment ? fd(payment) : ''}
                    </span>

                    {/* Deposit */}
                    <span style={{ fontSize:13,fontWeight:500,textAlign:'right',color:'var(--teal)' }}>
                      {deposit ? fd(deposit) : ''}
                    </span>

                    {/* Balance or amount */}
                    <span style={{ fontSize:13,fontWeight:500,textAlign:'right',color:t.runningBalance!==null?(t.runningBalance>=0?'var(--teal)':'var(--coral)'):(t.amount>=0?'var(--teal)':'var(--coral)') }}>
                      {t.runningBalance !== null ? fd(t.runningBalance) : fd(t.amount)}
                    </span>

                    {/* Actions */}
                    <div style={{ display:'flex',gap:3,justifyContent:'flex-end' }}>
                      <button onClick={()=>{ setEditingId(t.id); setAddingNew(false) }}
                        title="Edit" style={{ fontSize:11,padding:'3px 6px',background:'none',border:'1px solid var(--border)',borderRadius:4,cursor:'pointer',color:'var(--text-muted)' }}>
                        <i className="ti ti-pencil" aria-hidden="true"/>
                      </button>
                      <button onClick={()=>setSplitModal(t)}
                        title="Split" style={{ fontSize:11,padding:'3px 6px',background:'none',border:'1px solid var(--border)',borderRadius:4,cursor:'pointer',color:'var(--text-muted)' }}>
                        <i className="ti ti-scissors" aria-hidden="true"/>
                      </button>
                      <button onClick={()=>handleDelete(t)}
                        title="Delete" style={{ fontSize:11,padding:'3px 6px',background:'none',border:'1px solid var(--border)',borderRadius:4,cursor:'pointer',color:'var(--coral)' }}>
                        <i className="ti ti-trash" aria-hidden="true"/>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Rules tab */}
      {tab==='rules' && (
        <div>
          <div style={{ background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',padding:'12px 14px',marginBottom:16,display:'flex',gap:10,alignItems:'flex-start' }}>
            <i className="ti ti-info-circle" style={{ fontSize:16,color:'var(--blue)',flexShrink:0,marginTop:1 }} aria-hidden="true"/>
            <p style={{ fontSize:12,color:'var(--text-secondary)',margin:0,lineHeight:1.6 }}>
              Rules automatically reclassify transactions when you click "Apply rules". Example: any transaction containing "Home Depot" from Chase → move to Bay Hill under Repairs & Maintenance.
            </p>
          </div>
          <RuleBuilder rules={rules} accounts={accounts} onSave={saveRule} onDelete={deleteRule}/>
        </div>
      )}

      {/* History tab */}
      {tab==='history' && (
        <div>
          {history.length === 0 ? (
            <div style={{ textAlign:'center',padding:'2rem',background:'var(--bg-card)',borderRadius:'var(--radius-lg)',border:'0.5px solid var(--border)',fontSize:13,color:'var(--text-secondary)' }}>
              No activity yet. Add, edit, split, or apply rules to see history here.
            </div>
          ) : (
            <div style={{ background:'var(--bg-card)',border:'0.5px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
              {[...history].reverse().map((h,i)=>(
                <div key={i} style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 16px',borderBottom:i<history.length-1?'0.5px solid var(--border)':'none' }}>
                  <i className={`ti ${h.type==='split'?'ti-scissors':h.type==='bulk_rule'?'ti-player-play':h.type==='add'?'ti-plus':h.type==='edit'?'ti-pencil':h.type==='delete'?'ti-trash':'ti-arrows-exchange'}`} style={{ fontSize:15,color:'var(--blue)',flexShrink:0 }} aria-hidden="true"/>
                  <div style={{ flex:1 }}>
                    {h.type==='add'       && <p style={{ fontSize:13,margin:0 }}>Added <strong>{h.desc}</strong></p>}
                    {h.type==='edit'      && <p style={{ fontSize:13,margin:0 }}>Edited <strong>{h.desc}</strong></p>}
                    {h.type==='delete'    && <p style={{ fontSize:13,margin:0 }}>Deleted <strong>{h.desc}</strong></p>}
                    {h.type==='split'     && <p style={{ fontSize:13,margin:0 }}><strong>{h.desc}</strong> split into {h.parts} transactions</p>}
                    {h.type==='bulk_rule' && <p style={{ fontSize:13,margin:0 }}>Rules applied — {h.count} transactions updated</p>}
                    <p style={{ fontSize:11,color:'var(--text-secondary)',margin:'2px 0 0' }}>{new Date(h.timestamp).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {splitModal && (
        <SplitModal tx={splitModal} accounts={accounts}
          onConfirm={splits=>handleSplit(splitModal,splits)}
          onClose={()=>setSplitModal(null)}/>
      )}
    </div>
  )
}
