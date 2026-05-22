import { useState, useEffect } from 'react'
import axios from 'axios'

const API = 'http://localhost:3001/api/accounting'

const PROPS = [
  { id:'haas',      name:'Haas'      },
  { id:'kobe',      name:'Kobe'      },
  { id:'bayhill',   name:'Bay Hill'  },
  { id:'muirfield', name:'Muirfield' },
  { id:'alcita',    name:'Alcita'    },
]

const TYPE_ORDER  = ['asset','liability','equity','income','expense']
const TYPE_LABELS = { asset:'Assets', liability:'Liabilities', equity:'Equity', income:'Income', expense:'Expenses' }
const TYPE_COLORS = { asset:'var(--blue)', liability:'var(--coral)', equity:'var(--teal)', income:'var(--green)', expense:'var(--amber)' }
const STATUS_STYLE = {
  draft:    { bg:'var(--bg-secondary)',  color:'var(--text-muted)',    label:'Draft'    },
  sent:     { bg:'var(--blue-light)',    color:'var(--blue)',          label:'Sent'     },
  paid:     { bg:'var(--teal-light)',    color:'var(--teal)',          label:'Paid'     },
  overdue:  { bg:'var(--coral-light)',   color:'var(--coral)',         label:'Overdue'  },
  cancelled:{ bg:'var(--bg-secondary)',  color:'var(--text-muted)',    label:'Cancelled'},
  unpaid:   { bg:'var(--amber-light)',   color:'var(--amber)',         label:'Unpaid'   },
}

const fd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })

function Badge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.unpaid
  return <span style={{ fontSize:11, padding:'2px 9px', borderRadius:10, background:s.bg, color:s.color, fontWeight:500 }}>{s.label}</span>
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg-card)', border:'0.5px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'24px', width:520, maxHeight:'80vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <p style={{ fontSize:15, fontWeight:500, margin:0 }}>{title}</p>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-muted)', padding:4, fontSize:16 }}>✕</button>
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

// ── Chart of Accounts ─────────────────────────────────────────────────
function ChartOfAccounts() {
  const [coa, setCoa]         = useState([])
  const [modal, setModal]     = useState(null) // null | 'add' | {edit account}
  const [form, setForm]       = useState({ number:'', name:'', type:'expense', subtype:'', active:true })

  useEffect(() => { axios.get(`${API}/coa`).then(r => setCoa(r.data)).catch(() => {}) }, [])

  const save = async () => {
    if (!form.name || !form.type) return
    try {
      if (modal === 'add') {
        const res = await axios.post(`${API}/coa`, form)
        setCoa(prev => [...prev, res.data])
      } else {
        const res = await axios.put(`${API}/coa/${modal.id}`, form)
        setCoa(prev => prev.map(a => a.id === modal.id ? res.data : a))
      }
      setModal(null)
    } catch {}
  }

  const del = async (id) => {
    if (!window.confirm('Delete this account?')) return
    await axios.delete(`${API}/coa/${id}`)
    setCoa(prev => prev.filter(a => a.id !== id))
  }

  const openEdit = (acct) => { setForm({ number:acct.number||'', name:acct.name, type:acct.type, subtype:acct.subtype||'', active:acct.active }); setModal(acct) }
  const openAdd  = () => { setForm({ number:'', name:'', type:'expense', subtype:'', active:true }); setModal('add') }

  const grouped = TYPE_ORDER.reduce((acc, t) => { acc[t] = coa.filter(a => a.type === t); return acc }, {})

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div>
          <p style={{ fontSize:14, fontWeight:500, margin:0 }}>Chart of Accounts</p>
          <p style={{ fontSize:11, color:'var(--text-muted)', margin:'2px 0 0' }}>{coa.filter(a=>a.active).length} active accounts across {Object.keys(grouped).filter(t=>grouped[t].length>0).length} types</p>
        </div>
        <button onClick={openAdd} style={{ fontSize:12, background:'var(--blue-light)', color:'var(--blue)', borderColor:'var(--blue)' }}>
          <i className="ti ti-plus" aria-hidden="true"/> Add account
        </button>
      </div>

      {TYPE_ORDER.map(type => {
        const accts = grouped[type]
        if (!accts.length) return null
        return (
          <div key={type} style={{ marginBottom:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
              <span style={{ width:10, height:10, borderRadius:2, background:TYPE_COLORS[type], display:'inline-block' }}/>
              <p style={{ fontSize:12, fontWeight:600, color:TYPE_COLORS[type], margin:0, textTransform:'uppercase', letterSpacing:'0.5px' }}>{TYPE_LABELS[type]}</p>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>{accts.length}</span>
            </div>
            <div style={{ border:'0.5px solid var(--border)', borderRadius:'var(--radius-md)', overflow:'hidden' }}>
              {accts.map((a, i) => (
                <div key={a.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderBottom: i < accts.length-1 ? '0.5px solid var(--border)' : 'none', background:'var(--bg-card)' }}>
                  <span style={{ fontSize:11, color:'var(--text-muted)', width:40, flexShrink:0 }}>{a.number}</span>
                  <span style={{ flex:1, fontSize:13, color: a.active ? 'var(--text-primary)' : 'var(--text-muted)' }}>{a.name}</span>
                  {a.subtype && <span style={{ fontSize:10, padding:'1px 6px', borderRadius:4, background:'var(--bg-secondary)', color:'var(--text-muted)' }}>{a.subtype}</span>}
                  {!a.active && <span style={{ fontSize:10, color:'var(--text-muted)' }}>inactive</span>}
                  <button onClick={() => openEdit(a)} style={{ fontSize:11, padding:'2px 8px', background:'none', border:'none', color:'var(--text-muted)' }}><i className="ti ti-edit" aria-hidden="true"/></button>
                  <button onClick={() => del(a.id)} style={{ fontSize:11, padding:'2px 6px', background:'none', border:'none', color:'var(--coral)' }}><i className="ti ti-trash" aria-hidden="true"/></button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {modal && (
        <Modal title={modal === 'add' ? 'Add Account' : 'Edit Account'} onClose={() => setModal(null)}>
          <Field label="Account number"><input value={form.number} onChange={e=>setForm(p=>({...p,number:e.target.value}))} placeholder="5000" style={{width:'100%'}}/></Field>
          <Field label="Account name *"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Repairs & Maintenance" style={{width:'100%'}}/></Field>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Type *">
              <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={{width:'100%'}}>
                {TYPE_ORDER.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
            <Field label="Subtype"><input value={form.subtype} onChange={e=>setForm(p=>({...p,subtype:e.target.value}))} placeholder="e.g. maintenance" style={{width:'100%'}}/></Field>
          </div>
          <Field label="Status">
            <select value={form.active ? 'active' : 'inactive'} onChange={e=>setForm(p=>({...p,active:e.target.value==='active'}))} style={{width:'100%'}}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </Field>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:4}}>
            <button onClick={()=>setModal(null)}>Cancel</button>
            <button onClick={save} style={{background:'var(--blue)',color:'#fff',border:'none'}}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── P&L Report ────────────────────────────────────────────────────────
function PLReport() {
  const thisYear = new Date().getFullYear()
  const [startDate, setStartDate] = useState(`${thisYear}-01-01`)
  const [endDate,   setEndDate]   = useState(new Date().toISOString().split('T')[0])
  const [propFilter, setPropFilter] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ startDate, endDate })
      if (propFilter) params.set('propertyId', propFilter)
      const res = await axios.get(`${API}/pl?${params}`)
      setData(res.data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div>
      <div style={{ display:'flex', gap:10, alignItems:'flex-end', marginBottom:20, flexWrap:'wrap' }}>
        <div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>From</label>
          <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{fontSize:12}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>To</label>
          <input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={{fontSize:12}}/>
        </div>
        <div>
          <label style={{fontSize:11,color:'var(--text-secondary)',display:'block',marginBottom:4}}>Property</label>
          <select value={propFilter} onChange={e=>setPropFilter(e.target.value)} style={{fontSize:12}}>
            <option value="">All properties</option>
            {PROPS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button onClick={load} disabled={loading} style={{fontSize:12,background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>
          <i className={`ti ${loading?'ti-loader-2 spin':'ti-refresh'}`} aria-hidden="true"/> Run report
        </button>
      </div>

      {data && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:20}}>
          {[['Total Income','var(--green)',data.income?.total],['Total Expenses','var(--coral)',data.expenses?.total],
            ['Net Income',data.netIncome>=0?'var(--teal)':'var(--coral)',data.netIncome],
            ['Properties',null,null]].map(([label,color,val],i) => (
            <div key={i} className="metric-card">
              <p style={{fontSize:11,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px',fontSize:10}}>{label}</p>
              {val !== null ? <p style={{fontSize:20,fontWeight:500,margin:0,color:color||'var(--text-primary)'}}>{fd(val||0)}</p>
                : <p style={{fontSize:13,color:'var(--text-muted)',margin:0}}>{data.propertyPL?.length} tracked</p>}
            </div>
          ))}
        </div>
      )}

      {data && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
          {/* Income */}
          <div className="card">
            <p style={{fontSize:13,fontWeight:500,color:'var(--green)',margin:'0 0 12px'}}>Income</p>
            {Object.entries(data.income?.byCategory || {}).sort((a,b)=>b[1]-a[1]).map(([cat,amt]) => (
              <div key={cat} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'0.5px solid var(--border)',fontSize:13}}>
                <span style={{color:'var(--text-secondary)'}}>{cat}</span>
                <span style={{color:'var(--green)',fontWeight:500}}>{fd(amt)}</span>
              </div>
            ))}
            {!Object.keys(data.income?.byCategory||{}).length && <p style={{fontSize:12,color:'var(--text-muted)'}}>No income in this period</p>}
            <div style={{display:'flex',justifyContent:'space-between',padding:'9px 0 0',fontSize:13,fontWeight:600}}>
              <span>Total Income</span><span style={{color:'var(--green)'}}>{fd(data.income?.total||0)}</span>
            </div>
          </div>

          {/* Expenses */}
          <div className="card">
            <p style={{fontSize:13,fontWeight:500,color:'var(--coral)',margin:'0 0 12px'}}>Expenses</p>
            {Object.entries(data.expenses?.byCategory || {}).sort((a,b)=>b[1]-a[1]).map(([cat,amt]) => (
              <div key={cat} style={{display:'flex',justifyContent:'space-between',padding:'7px 0',borderBottom:'0.5px solid var(--border)',fontSize:13}}>
                <span style={{color:'var(--text-secondary)'}}>{cat}</span>
                <span style={{color:'var(--coral)',fontWeight:500}}>{fd(amt)}</span>
              </div>
            ))}
            {!Object.keys(data.expenses?.byCategory||{}).length && <p style={{fontSize:12,color:'var(--text-muted)'}}>No expenses in this period</p>}
            <div style={{display:'flex',justifyContent:'space-between',padding:'9px 0 0',fontSize:13,fontWeight:600}}>
              <span>Total Expenses</span><span style={{color:'var(--coral)'}}>{fd(data.expenses?.total||0)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Property NOI */}
      {data?.propertyPL?.length > 0 && (
        <div className="card" style={{marginTop:16}}>
          <p style={{fontSize:13,fontWeight:500,margin:'0 0 12px'}}>Property Performance (annualized)</p>
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8}}>
            {data.propertyPL.map(p => (
              <div key={p.id} style={{background:'var(--bg-secondary)',borderRadius:'var(--radius-md)',padding:'10px 12px'}}>
                <p style={{fontSize:12,fontWeight:500,margin:'0 0 6px'}}>{p.name}</p>
                {[['Income',fd(p.rentalIncome),'var(--green)'],['Expenses',fd(p.expenses),'var(--coral)'],['NOI',fd(p.noi),p.noi>=0?'var(--teal)':'var(--coral)'],['ROI',p.roi+'%','var(--blue)']].map(([l,v,c])=>(
                  <div key={l} style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:2}}>
                    <span style={{color:'var(--text-muted)'}}>{l}</span>
                    <span style={{color:c,fontWeight:500}}>{v}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Balance Sheet ─────────────────────────────────────────────────────
function BalanceSheet() {
  const [data, setData] = useState(null)
  useEffect(() => { axios.get(`${API}/balance-sheet`).then(r=>setData(r.data)).catch(()=>{}) }, [])
  if (!data) return <div style={{color:'var(--text-muted)',fontSize:13}}>Loading…</div>
  const { assets, liabilities, equity } = data
  return (
    <div>
      <p style={{fontSize:12,color:'var(--text-muted)',marginBottom:16}}>As of {new Date(data.asOf).toLocaleDateString()}</p>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
        <div>
          <div className="card" style={{marginBottom:12,borderLeft:'3px solid var(--blue)'}}>
            <p style={{fontSize:13,fontWeight:600,color:'var(--blue)',margin:'0 0 12px'}}>ASSETS</p>
            {[
              ['Cash & Checking', assets.cash.total, assets.cash.accounts],
              ['Investments & Brokerage', assets.investments.total, assets.investments.accounts],
              ['Crypto', assets.crypto.total, assets.crypto.accounts],
            ].map(([label, total, accts]) => total > 0 && (
              <div key={label} style={{marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:500,marginBottom:5}}>
                  <span style={{color:'var(--text-secondary)'}}>{label}</span>
                  <span>{fd(total)}</span>
                </div>
                {accts?.map(a => (
                  <div key={a.id||a.name} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0 2px 12px',color:'var(--text-muted)'}}>
                    <span>{a.name}</span><span>{fd(a.balance||0)}</span>
                  </div>
                ))}
              </div>
            ))}
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:500,marginBottom:5}}>
                <span style={{color:'var(--text-secondary)'}}>Real Estate (equity)</span>
                <span>{fd(assets.realEstate.equity)}</span>
              </div>
              {assets.realEstate.properties?.map(p => (
                <div key={p.id||p.name} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0 2px 12px',color:'var(--text-muted)'}}>
                  <span>{p.name}</span><span>{fd((p.value||0)-(p.mortgage||0))}</span>
                </div>
              ))}
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:700,borderTop:'0.5px solid var(--border)',paddingTop:10}}>
              <span style={{color:'var(--blue)'}}>Total Assets</span><span style={{color:'var(--blue)'}}>{fd(assets.total)}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="card" style={{marginBottom:12,borderLeft:'3px solid var(--coral)'}}>
            <p style={{fontSize:13,fontWeight:600,color:'var(--coral)',margin:'0 0 12px'}}>LIABILITIES</p>
            <div style={{marginBottom:12}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:500,marginBottom:5}}>
                <span style={{color:'var(--text-secondary)'}}>Mortgages</span>
                <span>{fd(liabilities.mortgages.total)}</span>
              </div>
              {liabilities.mortgages.properties?.map(p => (
                <div key={p.name} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0 2px 12px',color:'var(--text-muted)'}}>
                  <span>{p.name}</span><span>{fd(p.balance||0)}</span>
                </div>
              ))}
            </div>
            {liabilities.creditCards.total > 0 && (
              <div style={{marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:500,marginBottom:5}}>
                  <span style={{color:'var(--text-secondary)'}}>Credit Cards</span>
                  <span>{fd(liabilities.creditCards.total)}</span>
                </div>
                {liabilities.creditCards.accounts?.map(a => (
                  <div key={a.id||a.name} style={{display:'flex',justifyContent:'space-between',fontSize:11,padding:'2px 0 2px 12px',color:'var(--text-muted)'}}>
                    <span>{a.name}</span><span>{fd(Math.abs(a.balance||0))}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{display:'flex',justifyContent:'space-between',fontSize:13,fontWeight:700,borderTop:'0.5px solid var(--border)',paddingTop:10}}>
              <span style={{color:'var(--coral)'}}>Total Liabilities</span><span style={{color:'var(--coral)'}}>{fd(liabilities.total)}</span>
            </div>
          </div>

          <div className="card" style={{borderLeft:'3px solid var(--teal)'}}>
            <p style={{fontSize:13,fontWeight:600,color:'var(--teal)',margin:'0 0 10px'}}>EQUITY</p>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:16,fontWeight:700}}>
              <span>Net Worth</span><span style={{color:equity>=0?'var(--teal)':'var(--coral)'}}>{fd(equity)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Invoices ──────────────────────────────────────────────────────────
function Invoices() {
  const [invoices, setInvoices] = useState([])
  const [modal, setModal]   = useState(false)
  const [form, setForm]     = useState({ propertyId:'haas', tenantName:'', amount:'', dueDate:'', issueDate:new Date().toISOString().split('T')[0], notes:'', recurring:false })

  const load = () => axios.get(`${API}/invoices`).then(r=>setInvoices(r.data)).catch(()=>{})
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.tenantName || !form.amount || !form.dueDate) return
    const inv = { ...form, amount: parseFloat(form.amount), items:[{description:'Monthly rent', amount:parseFloat(form.amount)}] }
    await axios.post(`${API}/invoices`, inv)
    setModal(false); load()
  }

  const updateStatus = async (id, status) => {
    await axios.put(`${API}/invoices/${id}`, { status, ...(status==='paid'?{paidDate:new Date().toISOString().split('T')[0]}:{}) })
    load()
  }

  const del = async (id) => {
    if (!window.confirm('Delete invoice?')) return
    await axios.delete(`${API}/invoices/${id}`); load()
  }

  const summary = { total: invoices.length, paid: invoices.filter(i=>i.status==='paid').length, overdue: invoices.filter(i=>i.status==='overdue').length, pending: invoices.filter(i=>['draft','sent'].includes(i.status)).length, totalDue: invoices.filter(i=>['sent','overdue'].includes(i.status)).reduce((s,i)=>s+i.amount,0) }

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:20}}>
        {[['Open Invoices',summary.pending,'var(--blue)'],['Overdue',summary.overdue,'var(--coral)'],['Paid',summary.paid,'var(--teal)'],['Amount Due',fd(summary.totalDue),'var(--amber)']].map(([l,v,c])=>(
          <div key={l} className="metric-card"><p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px'}}>{l}</p><p style={{fontSize:20,fontWeight:500,margin:0,color:c}}>{v}</p></div>
        ))}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Rent Roll & Invoices</p>
        <button onClick={()=>setModal(true)} style={{fontSize:12,background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> New invoice
        </button>
      </div>

      {invoices.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-file-invoice" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No invoices yet — create your first rent invoice</p>
        </div>
      ) : (
        <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',overflow:'hidden'}}>
          {invoices.map((inv, i) => (
            <div key={inv.id} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderBottom:i<invoices.length-1?'0.5px solid var(--border)':'none',background:'var(--bg-card)'}}>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                  <span style={{fontSize:13,fontWeight:500}}>{inv.tenantName || 'Tenant'}</span>
                  <Badge status={inv.status}/>
                  {PROPS.find(p=>p.id===inv.propertyId) && <span style={{fontSize:11,color:'var(--text-muted)'}}>{PROPS.find(p=>p.id===inv.propertyId)?.name}</span>}
                </div>
                <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>Due {inv.dueDate} {inv.recurring && '· Recurring'}</p>
              </div>
              <span style={{fontSize:15,fontWeight:500,color:'var(--teal)'}}>{fd(inv.amount)}</span>
              <div style={{display:'flex',gap:4}}>
                {inv.status === 'draft' && <button onClick={()=>updateStatus(inv.id,'sent')} style={{fontSize:11,padding:'3px 8px',background:'var(--blue-light)',color:'var(--blue)',borderColor:'var(--blue)'}}>Send</button>}
                {['sent','overdue'].includes(inv.status) && <button onClick={()=>updateStatus(inv.id,'paid')} style={{fontSize:11,padding:'3px 8px',background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>Mark paid</button>}
                <button onClick={()=>del(inv.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title="New Invoice" onClose={()=>setModal(false)}>
          <Field label="Property">
            <select value={form.propertyId} onChange={e=>setForm(p=>({...p,propertyId:e.target.value}))} style={{width:'100%'}}>
              {PROPS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Tenant name *"><input value={form.tenantName} onChange={e=>setForm(p=>({...p,tenantName:e.target.value}))} placeholder="John Doe" style={{width:'100%'}}/></Field>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Amount *"><input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="6500" style={{width:'100%'}}/></Field>
            <Field label="Due date *"><input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Issue date"><input type="date" value={form.issueDate} onChange={e=>setForm(p=>({...p,issueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} rows={2} style={{width:'100%'}}/></Field>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,marginBottom:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.recurring} onChange={e=>setForm(p=>({...p,recurring:e.target.checked}))}/> Recurring monthly invoice
          </label>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(false)}>Cancel</button>
            <button onClick={save} style={{background:'var(--teal)',color:'#fff',border:'none'}}>Create invoice</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Bills ─────────────────────────────────────────────────────────────
function Bills() {
  const [bills, setBills]   = useState([])
  const [vendors, setVendors] = useState([])
  const [modal, setModal]   = useState(false)
  const [form, setForm]     = useState({ vendorId:'', propertyId:'', amount:'', dueDate:'', category:'Mortgage Payment', notes:'', recurring:false, recurringPeriod:'monthly' })

  const load = () => {
    axios.get(`${API}/bills`).then(r=>setBills(r.data)).catch(()=>{})
    axios.get(`${API}/vendors`).then(r=>setVendors(r.data)).catch(()=>{})
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.amount || !form.dueDate) return
    await axios.post(`${API}/bills`, { ...form, amount: parseFloat(form.amount) })
    setModal(false); load()
  }

  const markPaid = async (id) => {
    await axios.put(`${API}/bills/${id}`, { status:'paid', paidDate: new Date().toISOString().split('T')[0] }); load()
  }
  const del = async (id) => { if (!window.confirm('Delete bill?')) return; await axios.delete(`${API}/bills/${id}`); load() }

  const totalDue = bills.filter(b=>['unpaid','overdue'].includes(b.status)).reduce((s,b)=>s+b.amount,0)

  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:20}}>
        {[['Unpaid Bills',bills.filter(b=>b.status==='unpaid').length,'var(--amber)'],['Overdue',bills.filter(b=>b.status==='overdue').length,'var(--coral)'],['Paid This Month',bills.filter(b=>b.status==='paid'&&b.paidDate>=new Date().toISOString().slice(0,7)).length,'var(--teal)'],['Total Due',fd(totalDue),'var(--coral)']].map(([l,v,c])=>(
          <div key={l} className="metric-card"><p style={{fontSize:10,color:'var(--text-secondary)',margin:'0 0 4px',textTransform:'uppercase',letterSpacing:'0.5px'}}>{l}</p><p style={{fontSize:20,fontWeight:500,margin:0,color:c}}>{v}</p></div>
        ))}
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Bills & Payables</p>
        <button onClick={()=>setModal(true)} style={{fontSize:12,background:'var(--amber-light)',color:'var(--amber)',borderColor:'var(--amber)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> New bill
        </button>
      </div>

      {bills.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-receipt" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No bills yet</p>
        </div>
      ) : (
        <div style={{border:'0.5px solid var(--border)',borderRadius:'var(--radius-md)',overflow:'hidden'}}>
          {bills.map((bill,i) => {
            const vendor = vendors.find(v=>v.id===bill.vendorId)
            const prop   = PROPS.find(p=>p.id===bill.propertyId)
            return (
              <div key={bill.id} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',borderBottom:i<bills.length-1?'0.5px solid var(--border)':'none',background:'var(--bg-card)'}}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                    <span style={{fontSize:13,fontWeight:500}}>{vendor?.name || bill.category}</span>
                    <Badge status={bill.status}/>
                    {prop && <span style={{fontSize:11,color:'var(--text-muted)'}}>{prop.name}</span>}
                  </div>
                  <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>Due {bill.dueDate} {bill.recurring&&'· '+bill.recurringPeriod}</p>
                </div>
                <span style={{fontSize:15,fontWeight:500,color:'var(--coral)'}}>{fd(bill.amount)}</span>
                <div style={{display:'flex',gap:4}}>
                  {['unpaid','overdue'].includes(bill.status) && <button onClick={()=>markPaid(bill.id)} style={{fontSize:11,padding:'3px 8px',background:'var(--teal-light)',color:'var(--teal)',borderColor:'var(--teal)'}}>Mark paid</button>}
                  <button onClick={()=>del(bill.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <Modal title="New Bill" onClose={()=>setModal(false)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Vendor">
              <select value={form.vendorId} onChange={e=>setForm(p=>({...p,vendorId:e.target.value}))} style={{width:'100%'}}>
                <option value="">No vendor</option>
                {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="Property">
              <select value={form.propertyId} onChange={e=>setForm(p=>({...p,propertyId:e.target.value}))} style={{width:'100%'}}>
                <option value="">General</option>
                {PROPS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Amount *"><input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="1200" style={{width:'100%'}}/></Field>
            <Field label="Due date *"><input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Category"><input value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} placeholder="Mortgage Payment" style={{width:'100%'}}/></Field>
          <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,marginBottom:16,cursor:'pointer'}}>
            <input type="checkbox" checked={form.recurring} onChange={e=>setForm(p=>({...p,recurring:e.target.checked}))}/>
            Recurring
            {form.recurring && <select value={form.recurringPeriod} onChange={e=>setForm(p=>({...p,recurringPeriod:e.target.value}))} style={{marginLeft:8,fontSize:12}}>
              <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annually">Annually</option>
            </select>}
          </label>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(false)}>Cancel</button>
            <button onClick={save} style={{background:'var(--amber)',color:'#fff',border:'none'}}>Create bill</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Vendors ───────────────────────────────────────────────────────────
function Vendors() {
  const [vendors, setVendors] = useState([])
  const [modal, setModal]     = useState(null)
  const [form, setForm]       = useState({ name:'', type:'contractor', email:'', phone:'', address:'', notes:'' })

  const load = () => axios.get(`${API}/vendors`).then(r=>setVendors(r.data)).catch(()=>{})
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.name) return
    if (modal === 'add') { await axios.post(`${API}/vendors`, form) }
    else { await axios.put(`${API}/vendors/${modal.id}`, form) }
    setModal(null); load()
  }
  const del = async (id) => { if (!window.confirm('Delete vendor?')) return; await axios.delete(`${API}/vendors/${id}`); load() }
  const openEdit = v => { setForm({ name:v.name, type:v.type||'contractor', email:v.email||'', phone:v.phone||'', address:v.address||'', notes:v.notes||'' }); setModal(v) }
  const openAdd  = () => { setForm({ name:'', type:'contractor', email:'', phone:'', address:'', notes:'' }); setModal('add') }

  const VENDOR_TYPES = ['contractor','lender','insurance','utility','service','other']

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <p style={{fontSize:14,fontWeight:500,margin:0}}>Vendors & Payees ({vendors.length})</p>
        <button onClick={openAdd} style={{fontSize:12,background:'var(--purple-light)',color:'var(--purple)',borderColor:'var(--purple)'}}>
          <i className="ti ti-plus" aria-hidden="true"/> Add vendor
        </button>
      </div>

      {vendors.length === 0 ? (
        <div className="card" style={{textAlign:'center',padding:'2.5rem',color:'var(--text-muted)'}}>
          <i className="ti ti-building-community" style={{fontSize:36,display:'block',marginBottom:12}} aria-hidden="true"/>
          <p style={{margin:0}}>No vendors yet — add your contractors, lenders, and service providers</p>
        </div>
      ) : (
        <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10}}>
          {vendors.map(v => (
            <div key={v.id} className="card" style={{display:'flex',alignItems:'flex-start',gap:12}}>
              <div style={{width:36,height:36,borderRadius:'var(--radius-md)',background:'var(--purple-light)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                <i className="ti ti-building" style={{fontSize:17,color:'var(--purple)'}} aria-hidden="true"/>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:13,fontWeight:500,margin:'0 0 3px'}}>{v.name}</p>
                <p style={{fontSize:11,color:'var(--text-muted)',margin:0}}>{v.type}{v.email&&` · ${v.email}`}</p>
              </div>
              <div style={{display:'flex',gap:4}}>
                <button onClick={()=>openEdit(v)} style={{fontSize:11,padding:'3px 8px',background:'none',borderColor:'var(--border-light)'}}><i className="ti ti-edit" aria-hidden="true"/></button>
                <button onClick={()=>del(v.id)} style={{fontSize:11,padding:'3px 6px',background:'none',border:'none',color:'var(--coral)'}}><i className="ti ti-trash" aria-hidden="true"/></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal==='add'?'Add Vendor':'Edit Vendor'} onClose={()=>setModal(null)}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Name *"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} placeholder="ABC Contractors" style={{width:'100%'}}/></Field>
            <Field label="Type">
              <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={{width:'100%'}}>
                {VENDOR_TYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
              </select>
            </Field>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Email"><input type="email" value={form.email} onChange={e=>setForm(p=>({...p,email:e.target.value}))} style={{width:'100%'}}/></Field>
            <Field label="Phone"><input value={form.phone} onChange={e=>setForm(p=>({...p,phone:e.target.value}))} style={{width:'100%'}}/></Field>
          </div>
          <Field label="Address"><input value={form.address} onChange={e=>setForm(p=>({...p,address:e.target.value}))} style={{width:'100%'}}/></Field>
          <Field label="Notes"><textarea value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} rows={2} style={{width:'100%'}}/></Field>
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModal(null)}>Cancel</button>
            <button onClick={save} style={{background:'var(--purple)',color:'#fff',border:'none'}}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Main Accounting Component ─────────────────────────────────────────
const TABS = [
  { id:'pl',       label:'P&L',             icon:'ti-chart-bar'           },
  { id:'bs',       label:'Balance Sheet',   icon:'ti-scale'               },
  { id:'invoices', label:'Invoices',         icon:'ti-file-invoice'        },
  { id:'bills',    label:'Bills',            icon:'ti-receipt'             },
  { id:'vendors',  label:'Vendors',          icon:'ti-building-community'  },
  { id:'coa',      label:'Chart of Accounts',icon:'ti-list-tree'           },
]

export default function Accounting() {
  const [tab, setTab] = useState('pl')
  return (
    <div>
      <div style={{display:'flex',gap:0,borderBottom:'0.5px solid var(--border)',marginBottom:20,flexWrap:'wrap'}}>
        {TABS.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{display:'flex',alignItems:'center',gap:7,padding:'10px 16px',background:'none',border:'none',
              borderBottom:`2px solid ${tab===t.id?'var(--blue)':'transparent'}`,
              color:tab===t.id?'var(--blue)':'var(--text-secondary)',
              fontWeight:tab===t.id?500:400,fontSize:13,cursor:'pointer',borderRadius:0,marginBottom:-1}}>
            <i className={`ti ${t.icon}`} aria-hidden="true"/> {t.label}
          </button>
        ))}
      </div>
      {tab === 'pl'       && <PLReport/>}
      {tab === 'bs'       && <BalanceSheet/>}
      {tab === 'invoices' && <Invoices/>}
      {tab === 'bills'    && <Bills/>}
      {tab === 'vendors'  && <Vendors/>}
      {tab === 'coa'      && <ChartOfAccounts/>}
    </div>
  )
}
