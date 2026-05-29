/**
 * TaxCenter.jsx
 *
 * Displays a 1040-style tax worksheet organized into the standard sections
 * of a US federal return. All fields are editable. Data auto-saves on blur.
 *
 * Sections:
 *   1. Filing Information
 *   2. Income
 *   3. Adjustments to Income
 *   4. Deductions
 *   5. Tax Credits
 *   6. Other Taxes
 *   7. Payments & Withholding
 *   8. Summary (refund / amount due)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'

const API = '/api'

const fmtD = n => {
  if (n === '' || n === null || n === undefined) return ''
  const v = parseFloat(n)
  if (isNaN(v)) return ''
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i)

// ── Tax computation helpers ───────────────────────────────────────────

const FED_BRACKETS_2024 = {
  single: [
    [11600,  0.10], [47150,  0.12], [100525, 0.22],
    [191950, 0.24], [243725, 0.32], [609350, 0.35], [Infinity, 0.37],
  ],
  mfj: [
    [23200,  0.10], [94300,  0.12], [201050, 0.22],
    [383900, 0.24], [487450, 0.32], [731200, 0.35], [Infinity, 0.37],
  ],
  mfs: [
    [11600,  0.10], [47150,  0.12], [100525, 0.22],
    [191950, 0.24], [243725, 0.32], [365600, 0.35], [Infinity, 0.37],
  ],
  hoh: [
    [16550,  0.10], [63100,  0.12], [100500, 0.22],
    [191950, 0.24], [243700, 0.32], [609350, 0.35], [Infinity, 0.37],
  ],
  qss: [
    [23200,  0.10], [94300,  0.12], [201050, 0.22],
    [383900, 0.24], [487450, 0.32], [731200, 0.35], [Infinity, 0.37],
  ],
}

function calcFedTax(taxableIncome, filingStatus) {
  if (taxableIncome <= 0) return 0
  const brackets = FED_BRACKETS_2024[filingStatus] || FED_BRACKETS_2024.single
  let tax = 0, prev = 0
  for (const [threshold, rate] of brackets) {
    if (taxableIncome <= threshold) { tax += (taxableIncome - prev) * rate; break }
    tax += (threshold - prev) * rate
    prev = threshold
  }
  return Math.round(tax * 100) / 100
}

function computeSummary(ws, stdDeduction) {
  const inc = ws.income || {}
  const adj = ws.adjustments || {}
  const ded = ws.deductions || {}
  const crd = ws.credits || {}
  const oth = ws.otherTaxes || {}
  const pay = ws.payments || {}

  const totalIncome = Object.values(inc).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const totalAdj = Object.values(adj).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const agi = totalIncome - totalAdj

  let deductionAmt = stdDeduction || 14600
  if (ded.type === 'itemized') {
    const itemized = Object.values(ded.itemized || {}).reduce((s, v) => s + (parseFloat(v) || 0), 0)
    deductionAmt = Math.max(itemized, stdDeduction || 14600)
  }

  const taxableIncome = Math.max(0, agi - deductionAmt)
  const regularTax    = calcFedTax(taxableIncome, ws.filingStatus)

  const totalCredits = Object.values(crd).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const totalOtherTax = Object.values(oth).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const totalTax = Math.max(0, regularTax - totalCredits) + totalOtherTax

  const totalPayments = Object.values(pay).reduce((s, v) => s + (parseFloat(v) || 0), 0)

  const balance = totalTax - totalPayments // positive = owe, negative = refund

  return { totalIncome, totalAdj, agi, deductionAmt, taxableIncome, regularTax, totalCredits, totalOtherTax, totalTax, totalPayments, balance }
}

// ── Sub-components ────────────────────────────────────────────────────

function SectionHeader({ number, title, icon, color = 'var(--blue)' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{number}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <i className={`ti ${icon}`} style={{ fontSize: 15, color }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
      </div>
    </div>
  )
}

function FieldRow({ label, sublabel, fieldKey, section, value, onChange, readonly, highlight }) {
  const [raw, setRaw] = useState(value === 0 ? '' : String(value))
  const inputRef = useRef(null)

  useEffect(() => {
    // Only sync from outside if the input isn't focused
    if (document.activeElement !== inputRef.current) {
      setRaw(value === 0 ? '' : String(value))
    }
  }, [value])

  const handleBlur = () => {
    const num = parseFloat(raw) || 0
    setRaw(num === 0 ? '' : String(num))
    if (!readonly) onChange(section, fieldKey, num)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '7px 12px',
      background: highlight ? 'rgba(55,138,221,0.05)' : 'transparent',
      borderBottom: '0.5px solid var(--border-light)',
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{label}</span>
        {sublabel && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>{sublabel}</span>}
      </div>
      {readonly ? (
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', minWidth: 110, textAlign: 'right' }}>
          {fmtD(value)}
        </span>
      ) : (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
          <input
            ref={inputRef}
            type="number"
            step="0.01"
            value={raw}
            onChange={e => setRaw(e.target.value)}
            onBlur={handleBlur}
            placeholder="0"
            style={{
              width: 130, padding: '5px 8px 5px 18px', fontSize: 13,
              background: 'var(--bg-secondary)', border: '0.5px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
              textAlign: 'right', outline: 'none',
            }}
          />
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value, bold, color, indent }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: `6px ${indent ? '24px' : '12px'} 6px 12px`,
      borderBottom: '0.5px solid var(--border-light)',
    }}>
      <span style={{ fontSize: 13, fontWeight: bold ? 600 : 400, color: color || 'var(--text-primary)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: bold ? 600 : 400, color: color || 'var(--text-primary)' }}>{fmtD(value)}</span>
    </div>
  )
}

function DocBadge({ doc }) {
  const ext  = (doc.name || '').split('.').pop().toLowerCase()
  const icon = ext === 'pdf' ? 'ti-file-type-pdf' : ext === 'csv' ? 'ti-file-type-csv' : 'ti-file'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
      background: 'var(--bg-secondary)', border: '0.5px solid var(--border)',
      borderRadius: 'var(--radius-sm)', fontSize: 12,
    }}>
      <i className={`ti ${icon}`} style={{ fontSize: 14, color: 'var(--blue)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.name}</div>
        {doc.folderPath && <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 1 }}>{doc.folderPath}</div>}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

export default function TaxCenter() {
  const [year, setYear]           = useState(CURRENT_YEAR - 1)
  const [ws, setWs]               = useState(null)
  const [stdDed, setStdDed]       = useState(14600)
  const [statuses, setStatuses]   = useState([])
  const [docs, setDocs]           = useState([])
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState(null)
  const [activeSection, setSection] = useState('income')
  const saveTimer = useRef(null)

  // ── Fill from data ─────────────────────────────────────────────────
  const [fillLoading, setFillLoading] = useState(false)
  const [fillData, setFillData]       = useState(null)   // null = never fetched
  const [fillOpen, setFillOpen]       = useState(false)
  const [fillSel, setFillSel]         = useState({})     // fieldKey -> boolean

  // ── Import from docs ───────────────────────────────────────────────
  const [docsLoading,  setDocsLoading]  = useState(false)
  const [docsData,     setDocsData]     = useState(null)  // { forms, apiConfigured }
  const [docsOpen,     setDocsOpen]     = useState(false)
  const [docsSel,      setDocsSel]      = useState({})    // fileId -> boolean
  const [docsApiOk,    setDocsApiOk]    = useState(false)
  const [extractingId, setExtractingId] = useState(null)  // fileId currently being extracted

  const fetchEstimate = async () => {
    setFillLoading(true)
    try {
      const r = await axios.get(`${API}/tax-estimate?year=${year}`)
      const est = r.data.estimates
      setFillData(est)
      // Pre-select fields that have actual data (confidence !== 'none')
      const sel = {}
      if (est.w2?.confidence !== 'none')            sel.w2 = true
      if (est.capitalGains?.confidence !== 'none')  sel.capitalGains = true
      if (est.scheduleEIncome?.confidence !== 'none') sel.scheduleEIncome = true
      setFillSel(sel)
      setFillOpen(true)
    } catch { /* silently ignore */ }
    setFillLoading(false)
  }

  const applyFill = () => {
    if (!fillData) return
    if (fillSel.w2 && fillData.w2?.confidence !== 'none')
      handleChange('income', 'w2', fillData.w2.value)
    if (fillSel.capitalGains && fillData.capitalGains?.confidence !== 'none')
      handleChange('income', 'capitalGains', fillData.capitalGains.value)
    if (fillSel.scheduleEIncome && fillData.scheduleEIncome?.confidence !== 'none')
      handleChange('income', 'scheduleEIncome', fillData.scheduleEIncome.value)
    setFillOpen(false)
  }

  // ── Fetch list of tax forms in the vault for this year ────────────
  const fetchVaultForms = async () => {
    setDocsLoading(true)
    try {
      const r = await axios.get(`${API}/taxes/${year}/vault-forms`)
      setDocsData(r.data)
      setDocsApiOk(r.data.apiConfigured)
      // Pre-select forms that already have cached extraction data
      const sel = {}
      for (const f of r.data.forms || []) {
        if (f.taxFormData) sel[f.id] = true
      }
      setDocsSel(sel)
      setDocsOpen(true)
    } catch { /* silently ignore */ }
    setDocsLoading(false)
  }

  // ── Extract one form via Claude (updates docsData in place) ────────
  const extractForm = async (fileId) => {
    setExtractingId(fileId)
    try {
      const r = await axios.post(`${API}/vault/parse-tax-form/${fileId}`)
      // Merge extracted data back into the local docsData list
      setDocsData(prev => {
        if (!prev) return prev
        const forms = prev.forms.map(f =>
          f.id === fileId
            ? { ...f, taxFormData: r.data, extractedAt: new Date().toISOString() }
            : f
        )
        return { ...prev, forms }
      })
      // Auto-select the newly extracted form
      setDocsSel(prev => ({ ...prev, [fileId]: true }))
    } catch (e) {
      console.error('Tax form extraction failed:', e.response?.data?.error || e.message)
    }
    setExtractingId(null)
  }

  // ── Apply selected extracted forms to the worksheet ────────────────
  const applyDocs = async () => {
    if (!docsData) return
    const selectedForms = (docsData.forms || [])
      .filter(f => docsSel[f.id] && f.taxFormData)
      .map(f => f.taxFormData)
    if (!selectedForms.length) return

    // Import mapToWorksheetFields logic here (mirror of server-side)
    // We compute the delta client-side using the already-extracted box data
    const delta = { income: {}, payments: {}, adjustments: {} }
    const addD = (sec, key, val) => {
      const n = parseFloat(val) || 0
      if (n !== 0) delta[sec][key] = (delta[sec][key] || 0) + n
    }

    for (const form of selectedForms) {
      const t = (form.formType || '').toUpperCase().replace(/\s/g, '')
      const b = form.boxes || {}

      if (t === 'W-2' || t === 'W2') {
        addD('income',   'w2',                          b.box1)
        addD('payments', 'w2FederalWithholding',         b.box2)
        addD('payments', 'w2SocialSecurityWithholding',  b.box4)
        addD('payments', 'w2MedicareWithholding',         b.box6)
      } else if (t === '1099-INT' || t === '1099INT') {
        addD('income',   'taxableInterest',   b.box1)
        addD('income',   'taxExemptInterest', b.box8)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === '1099-DIV' || t === '1099DIV') {
        addD('income',   'ordinaryDividends',  b.box1a)
        addD('income',   'qualifiedDividends', b.box1b)
        addD('income',   'capitalGains',       b.box2a)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === '1099-B' || t === '1099B') {
        const net = parseFloat(b.netGainLoss) || 0
        if (net !== 0) addD('income', 'capitalGains', net)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === '1099-NEC' || t === '1099NEC') {
        addD('income',   'businessIncome', b.box1)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === '1099-MISC' || t === '1099MISC') {
        addD('income',   'otherIncome',    b.box3)
        addD('income',   'businessIncome', b.box7)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === '1099-R' || t === '1099R') {
        const taxable = parseFloat(b.box2a) || parseFloat(b.box1) || 0
        addD('income',   'iraDistributions', taxable)
        addD('payments', 'w2FederalWithholding', b.box4)
      } else if (t === 'SSA-1099' || t === 'SSA1099') {
        const raw = parseFloat(b.box5) || 0
        const taxable = Math.round(raw * 0.85 * 100) / 100
        if (taxable !== 0) addD('income', 'socialSecurity', taxable)
        addD('payments', 'w2FederalWithholding', b.box6)
      } else if (t === '1098') {
        addD('adjustments', '_1098_mortgageInterest', parseFloat(b.box1) || 0) // surfaced as hint
      } else if (t === '1098-E' || t === '1098E') {
        addD('adjustments', 'studentLoanInterest',
          parseFloat(b.box1) || parseFloat(b.interestOnStudentLoans) || 0)
      }
    }

    // Apply income fields
    for (const [key, val] of Object.entries(delta.income)) {
      handleChange('income', key, val)
    }
    // Apply payment fields
    for (const [key, val] of Object.entries(delta.payments)) {
      handleChange('payments', key, val)
    }
    // Apply student loan interest (if any)
    if (delta.adjustments.studentLoanInterest) {
      handleChange('adjustments', 'studentLoanInterest', delta.adjustments.studentLoanInterest)
    }
    setDocsOpen(false)
  }

  // Load data when year changes
  useEffect(() => {
    setLoading(true)
    setFillOpen(false)
    setFillData(null)
    setDocsOpen(false)
    setDocsData(null)
    Promise.all([
      axios.get(`${API}/taxes/${year}`),
      axios.get(`${API}/taxes/${year}/documents`),
    ]).then(([taxRes, docsRes]) => {
      setWs(taxRes.data.worksheet)
      setStdDed(taxRes.data.stdDeduction)
      setStatuses(taxRes.data.filingStatuses || [])
      setDocs(docsRes.data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [year])

  // Auto-save with debounce
  const scheduleSave = useCallback((updatedWs) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      try {
        const res = await axios.post(`${API}/taxes/${year}`, updatedWs)
        setStdDed(res.data.stdDeduction)
        setSaveMsg('Saved')
        setTimeout(() => setSaveMsg(null), 1500)
      } catch { setSaveMsg('Error saving') }
      setSaving(false)
    }, 800)
  }, [year])

  // Update a single field
  const handleChange = useCallback((section, key, value) => {
    setWs(prev => {
      const next = {
        ...prev,
        [section]: { ...prev[section], [key]: value },
      }
      scheduleSave(next)
      return next
    })
  }, [scheduleSave])

  const handleTopLevel = (key, value) => {
    setWs(prev => {
      const next = { ...prev, [key]: value }
      scheduleSave(next)
      return next
    })
  }

  if (loading || !ws) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300, gap: 10, color: 'var(--text-muted)' }}>
        <i className="ti ti-loader-2 spin" style={{ fontSize: 18 }} /> Loading tax data…
      </div>
    )
  }

  const summary = computeSummary(ws, stdDed)

  const SECTIONS = [
    { id: 'filing',      label: 'Filing Info',   icon: 'ti-user' },
    { id: 'income',      label: 'Income',        icon: 'ti-cash' },
    { id: 'adjustments', label: 'Adjustments',   icon: 'ti-adjustments' },
    { id: 'deductions',  label: 'Deductions',    icon: 'ti-discount' },
    { id: 'credits',     label: 'Credits',       icon: 'ti-star' },
    { id: 'othertaxes',  label: 'Other Taxes',   icon: 'ti-file-invoice' },
    { id: 'payments',    label: 'Payments',      icon: 'ti-credit-card' },
    { id: 'summary',     label: 'Summary',       icon: 'ti-calculator' },
  ]

  return (
    <div style={{ maxWidth: 900 }}>

      {/* ── Header bar ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Tax Center</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Federal return worksheet — for reference only, not a filed return
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Year selector */}
          <div style={{ display: 'flex', gap: 4 }}>
            {YEARS.map(y => (
              <button key={y} onClick={() => setYear(y)} style={{
                padding: '6px 12px', fontSize: 13, fontWeight: year === y ? 600 : 400,
                background: year === y ? 'var(--blue)' : 'var(--bg-secondary)',
                color: year === y ? '#fff' : 'var(--text-secondary)',
                border: `0.5px solid ${year === y ? 'var(--blue)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              }}>{y}</button>
            ))}
          </div>

          {/* Save indicator */}
          {saving && <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}><i className="ti ti-loader-2 spin" style={{ fontSize: 12 }} /> Saving…</span>}
          {saveMsg && !saving && <span style={{ fontSize: 12, color: 'var(--teal)' }}><i className="ti ti-check" style={{ fontSize: 12, marginRight: 3 }} />{saveMsg}</span>}

          {/* Generate button */}
          <button
            onClick={() => alert('PDF generation coming soon — this will produce a pre-filled 1040 draft.')}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 18px', fontSize: 13, fontWeight: 500,
              background: 'var(--blue)', color: '#fff', border: 'none',
              borderRadius: 'var(--radius-md)', cursor: 'pointer',
            }}>
            <i className="ti ti-file-download" style={{ fontSize: 15 }} />
            Generate Tax Form
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── Left nav ───────────────────────────────────────────── */}
        <div style={{ position: 'sticky', top: 16 }}>
          <div className="card" style={{ padding: '8px 0' }}>
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => setSection(s.id)} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                padding: '9px 14px', background: activeSection === s.id ? 'rgba(55,138,221,0.1)' : 'transparent',
                border: 'none', borderLeft: `3px solid ${activeSection === s.id ? 'var(--blue)' : 'transparent'}`,
                color: activeSection === s.id ? 'var(--blue)' : 'var(--text-secondary)',
                fontSize: 13, fontWeight: activeSection === s.id ? 600 : 400, cursor: 'pointer', textAlign: 'left',
              }}>
                <i className={`ti ${s.icon}`} style={{ fontSize: 14, flexShrink: 0 }} />
                {s.label}
              </button>
            ))}
          </div>

          {/* Tax documents */}
          {docs.length > 0 && (
            <div className="card" style={{ marginTop: 12, padding: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Tax Documents ({year})
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {docs.slice(0, 8).map(d => <DocBadge key={d.id} doc={d} />)}
                {docs.length > 8 && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>+{docs.length - 8} more in Data Vault</p>}
              </div>
            </div>
          )}
        </div>

        {/* ── Main content ───────────────────────────────────────── */}
        <div>

          {/* ── FILING INFO ──────────────────────────────────────── */}
          {activeSection === 'filing' && (
            <div className="card">
              <SectionHeader number="1" title="Filing Information" icon="ti-user" color="var(--blue)" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Filing Status</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {statuses.map(s => (
                      <button key={s.id} onClick={() => handleTopLevel('filingStatus', s.id)} style={{
                        padding: '7px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)',
                        background: ws.filingStatus === s.id ? 'var(--blue)' : 'var(--bg-secondary)',
                        color: ws.filingStatus === s.id ? '#fff' : 'var(--text-secondary)',
                        border: `0.5px solid ${ws.filingStatus === s.id ? 'var(--blue)' : 'var(--border)'}`,
                        fontWeight: ws.filingStatus === s.id ? 600 : 400, cursor: 'pointer',
                      }}>{s.label}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Dependents</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {[0,1,2,3,4,5].map(n => (
                      <button key={n} onClick={() => handleTopLevel('dependents', n)} style={{
                        width: 36, height: 36, borderRadius: '50%', fontSize: 13,
                        background: ws.dependents === n ? 'var(--blue)' : 'var(--bg-secondary)',
                        color: ws.dependents === n ? '#fff' : 'var(--text-secondary)',
                        border: `0.5px solid ${ws.dependents === n ? 'var(--blue)' : 'var(--border)'}`,
                        fontWeight: ws.dependents === n ? 600 : 400, cursor: 'pointer',
                      }}>{n}</button>
                    ))}
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>dependents</span>
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Standard Deduction for {year}</p>
                  <p style={{ margin: 0, fontSize: 20, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {fmtD(stdDed)}
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    Based on {statuses.find(s => s.id === ws.filingStatus)?.label || ws.filingStatus} filing status
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── INCOME ───────────────────────────────────────────── */}
          {activeSection === 'income' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                  <SectionHeader number="2" title="Income" icon="ti-cash" color="var(--teal)" />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={fetchEstimate}
                      disabled={fillLoading}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 12px', fontSize: 12, fontWeight: 500,
                        background: 'var(--teal-light)', color: 'var(--teal)',
                        border: '0.5px solid var(--teal)', borderRadius: 'var(--radius-sm)',
                        cursor: fillLoading ? 'default' : 'pointer', opacity: fillLoading ? 0.7 : 1,
                      }}>
                      {fillLoading
                        ? <><i className="ti ti-loader-2 spin" style={{ fontSize: 13 }} /> Scanning…</>
                        : <><i className="ti ti-database-import" style={{ fontSize: 13 }} /> Fill from data</>}
                    </button>
                    <button
                      onClick={fetchVaultForms}
                      disabled={docsLoading}
                      title="Import values from W-2s, 1099s, and other tax forms in your Data Vault"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '6px 12px', fontSize: 12, fontWeight: 500,
                        background: 'rgba(101,61,202,0.08)', color: 'var(--purple)',
                        border: '0.5px solid var(--purple)', borderRadius: 'var(--radius-sm)',
                        cursor: docsLoading ? 'default' : 'pointer', opacity: docsLoading ? 0.7 : 1,
                      }}>
                      {docsLoading
                        ? <><i className="ti ti-loader-2 spin" style={{ fontSize: 13 }} /> Scanning…</>
                        : <><i className="ti ti-file-import" style={{ fontSize: 13 }} /> Import from docs</>}
                    </button>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Enter amounts from your W-2s, 1099s, and other income documents.
                </p>
              </div>

              {/* ── Fill panel ──────────────────────────────────────── */}
              {fillOpen && fillData && (
                <div style={{ margin: '0 16px 14px', border: '0.5px solid var(--teal)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', background: 'var(--teal-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <i className="ti ti-sparkles" style={{ fontSize: 14, color: 'var(--teal)' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--teal)' }}>Data found for {year}</span>
                    </div>
                    <button onClick={() => setFillOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1 }}>×</button>
                  </div>

                  {/* Estimate rows */}
                  {[
                    {
                      key: 'w2', label: 'Wages / W-2', icon: 'ti-briefcase',
                      est: fillData.w2,
                      detail: fillData.w2?.txCount > 0
                        ? `${fillData.w2.txCount} payroll deposit${fillData.w2.txCount !== 1 ? 's' : ''} via Plaid`
                        : 'No payroll deposits found in Plaid',
                    },
                    {
                      key: 'capitalGains', label: 'Capital Gains', icon: 'ti-trending-up',
                      est: fillData.capitalGains,
                      detail: fillData.capitalGains?.txCount > 0
                        ? `ST: ${fmtD(fillData.capitalGains.stGains)}  ·  LT: ${fmtD(fillData.capitalGains.ltGains)}  ·  ${fillData.capitalGains.txCount} crypto sale${fillData.capitalGains.txCount !== 1 ? 's' : ''} (FIFO)`
                        : 'No crypto sells recorded',
                    },
                    {
                      key: 'scheduleEIncome', label: 'Rental Income (Sch. E)', icon: 'ti-building-estate',
                      est: fillData.scheduleEIncome,
                      detail: fillData.scheduleEIncome?.statements > 0
                        ? `${fillData.scheduleEIncome.statements} property statement${fillData.scheduleEIncome.statements !== 1 ? 's' : ''}  ·  Gross ${fmtD(fillData.scheduleEIncome.gross)} − Expenses ${fmtD(fillData.scheduleEIncome.expenses)}`
                        : fillData.scheduleEIncome?.txCount > 0
                          ? `${fillData.scheduleEIncome.txCount} rent deposit${fillData.scheduleEIncome.txCount !== 1 ? 's' : ''} via Plaid  ·  ${fillData.scheduleEIncome.source}`
                          : 'No rental deposits or property statements found',
                    },
                  ].map(({ key, label, icon, est, detail }) => (
                    <div key={key} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 14px', borderTop: '0.5px solid var(--border)',
                      background: est?.confidence === 'none' ? 'var(--bg-secondary)' : 'transparent',
                      opacity: est?.confidence === 'none' ? 0.6 : 1,
                    }}>
                      <input
                        type="checkbox"
                        checked={!!fillSel[key] && est?.confidence !== 'none'}
                        disabled={est?.confidence === 'none'}
                        onChange={e => setFillSel(p => ({ ...p, [key]: e.target.checked }))}
                        style={{ width: 15, height: 15, flexShrink: 0, cursor: est?.confidence === 'none' ? 'default' : 'pointer' }}
                      />
                      <i className={`ti ${icon}`} style={{ fontSize: 15, color: 'var(--teal)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{detail}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: est?.confidence === 'none' ? 'var(--text-muted)' : 'var(--teal)' }}>
                          {est?.confidence === 'none' ? '—' : fmtD(est?.value ?? 0)}
                        </div>
                        <div style={{ fontSize: 10, color: est?.confidence === 'high' ? 'var(--teal)' : 'var(--amber)', marginTop: 1, textTransform: 'uppercase', letterSpacing: '0.4px', fontWeight: 500 }}>
                          {est?.confidence === 'none' ? 'no data' : est?.confidence}
                        </div>
                      </div>
                    </div>
                  ))}

                  <div style={{ padding: '10px 14px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                      ⚠ Estimates only — verify against your actual tax documents before filing.
                    </p>
                    <button
                      onClick={applyFill}
                      disabled={!Object.values(fillSel).some(Boolean)}
                      style={{
                        flexShrink: 0, padding: '7px 16px', fontSize: 13, fontWeight: 600,
                        background: 'var(--teal)', color: '#fff', border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        cursor: Object.values(fillSel).some(Boolean) ? 'pointer' : 'default',
                        opacity: Object.values(fillSel).some(Boolean) ? 1 : 0.5,
                      }}>
                      Apply selected
                    </button>
                  </div>
                </div>
              )}

              {/* ── Import from docs panel ────────────────────────────── */}
              {docsOpen && docsData && (
                <div style={{ margin: '0 16px 14px', border: '0.5px solid var(--purple)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  {/* Panel header */}
                  <div style={{ padding: '10px 14px', background: 'rgba(101,61,202,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <i className="ti ti-file-import" style={{ fontSize: 14, color: 'var(--purple)' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--purple)' }}>
                        Tax Forms in Vault — {year}
                      </span>
                    </div>
                    <button onClick={() => setDocsOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1 }}>×</button>
                  </div>

                  {/* No API key warning */}
                  {!docsApiOk && (
                    <div style={{ padding: '10px 14px', background: 'rgba(180,120,20,0.06)', borderBottom: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize: 14, color: 'var(--amber)', flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        AI extraction requires an Anthropic API key. Add <code>ANTHROPIC_API_KEY</code> to your <code>.env</code> file then restart the server.
                      </span>
                    </div>
                  )}

                  {/* No forms found */}
                  {(docsData.forms || []).length === 0 && (
                    <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                      <i className="ti ti-file-off" style={{ fontSize: 22, display: 'block', marginBottom: 8 }} />
                      No tax forms found in your vault for {year}.<br />
                      <span style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
                        Upload your W-2s, 1099s, and other tax documents to the Data Vault — files with "W-2", "1099", or "1098" in the name are detected automatically.
                      </span>
                    </div>
                  )}

                  {/* Form list */}
                  {(docsData.forms || []).map(form => {
                    const isExtracting = extractingId === form.id
                    const hasData      = !!form.taxFormData
                    const isSelected   = !!docsSel[form.id]

                    return (
                      <div key={form.id} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 14px', borderTop: '0.5px solid var(--border)',
                        background: !hasData ? 'var(--bg-secondary)' : 'transparent',
                      }}>
                        <input
                          type="checkbox"
                          checked={isSelected && hasData}
                          disabled={!hasData}
                          onChange={e => setDocsSel(p => ({ ...p, [form.id]: e.target.checked }))}
                          style={{ width: 15, height: 15, flexShrink: 0, cursor: hasData ? 'pointer' : 'default' }}
                        />
                        <i className="ti ti-file-type-pdf" style={{ fontSize: 15, color: 'var(--purple)', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {form.name}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                            {form.formType ? <span style={{ color: 'var(--purple)', fontWeight: 500, marginRight: 6 }}>{form.formType}</span> : null}
                            {form.folderPath}
                          </div>
                          {hasData && form.taxFormData?.issuerName && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                              From: {form.taxFormData.issuerName}
                            </div>
                          )}
                        </div>

                        {/* Right side: extract button or extracted summary */}
                        {hasData ? (
                          <div style={{ textAlign: 'right', flexShrink: 0 }}>
                            <div style={{ fontSize: 11, color: 'var(--teal)', fontWeight: 500 }}>
                              <i className="ti ti-check" style={{ marginRight: 3 }} />Extracted
                            </div>
                            {form.taxFormData?.boxes && (() => {
                              const b = form.taxFormData.boxes
                              const t = (form.taxFormData.formType || '').toUpperCase().replace(/\s/g,'')
                              let preview = ''
                              if      (t==='W-2'||t==='W2')         preview = `Wages: ${fmtD(b.box1)}`
                              else if (t==='1099-INT'||t==='1099INT') preview = `Interest: ${fmtD(b.box1)}`
                              else if (t==='1099-DIV'||t==='1099DIV') preview = `Dividends: ${fmtD(b.box1a)}`
                              else if (t==='1099-NEC'||t==='1099NEC') preview = `NEC: ${fmtD(b.box1)}`
                              else if (t==='1099-R'||t==='1099R')    preview = `Dist: ${fmtD(b.box2a||b.box1)}`
                              else if (t==='SSA-1099'||t==='SSA1099') preview = `Benefits: ${fmtD(b.box5)}`
                              else if (t==='1098')                   preview = `Mortgage Int: ${fmtD(b.box1)}`
                              return preview ? <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{preview}</div> : null
                            })()}
                          </div>
                        ) : (
                          <button
                            onClick={() => extractForm(form.id)}
                            disabled={!docsApiOk || isExtracting}
                            title={!docsApiOk ? 'API key required' : 'Extract box values from this PDF using AI'}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 5,
                              padding: '5px 10px', fontSize: 11, fontWeight: 500, flexShrink: 0,
                              background: docsApiOk ? 'var(--purple)' : 'var(--bg-secondary)',
                              color: docsApiOk ? '#fff' : 'var(--text-muted)',
                              border: `0.5px solid ${docsApiOk ? 'var(--purple)' : 'var(--border)'}`,
                              borderRadius: 'var(--radius-sm)',
                              cursor: (!docsApiOk || isExtracting) ? 'default' : 'pointer',
                              opacity: isExtracting ? 0.7 : 1,
                            }}>
                            {isExtracting
                              ? <><i className="ti ti-loader-2 spin" style={{ fontSize: 11 }} /> Extracting…</>
                              : <><i className="ti ti-sparkles" style={{ fontSize: 11 }} /> Extract</>}
                          </button>
                        )}
                      </div>
                    )
                  })}

                  {/* Footer */}
                  {(docsData.forms || []).length > 0 && (
                    <div style={{ padding: '10px 14px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                        ✓ Applying will <strong>add</strong> extracted values to the worksheet fields — existing entries are not overwritten.
                      </p>
                      <button
                        onClick={applyDocs}
                        disabled={!(docsData.forms || []).some(f => docsSel[f.id] && f.taxFormData)}
                        style={{
                          flexShrink: 0, padding: '7px 16px', fontSize: 13, fontWeight: 600,
                          background: 'var(--purple)', color: '#fff', border: 'none',
                          borderRadius: 'var(--radius-sm)',
                          cursor: (docsData.forms || []).some(f => docsSel[f.id] && f.taxFormData) ? 'pointer' : 'default',
                          opacity: (docsData.forms || []).some(f => docsSel[f.id] && f.taxFormData) ? 1 : 0.5,
                        }}>
                        Apply selected
                      </button>
                    </div>
                  )}
                </div>
              )}

              <FieldRow label="Wages, Salaries, Tips" sublabel="W-2 Box 1 (total all employers)" section="income" fieldKey="w2" value={ws.income.w2} onChange={handleChange} />
              <FieldRow label="Taxable Interest" sublabel="1099-INT" section="income" fieldKey="taxableInterest" value={ws.income.taxableInterest} onChange={handleChange} />
              <FieldRow label="Tax-Exempt Interest" sublabel="1099-INT (municipal bonds)" section="income" fieldKey="taxExemptInterest" value={ws.income.taxExemptInterest} onChange={handleChange} />
              <FieldRow label="Ordinary Dividends" sublabel="1099-DIV Box 1a" section="income" fieldKey="ordinaryDividends" value={ws.income.ordinaryDividends} onChange={handleChange} />
              <FieldRow label="Qualified Dividends" sublabel="1099-DIV Box 1b (subset of ordinary)" section="income" fieldKey="qualifiedDividends" value={ws.income.qualifiedDividends} onChange={handleChange} />
              <FieldRow label="IRA Distributions (taxable)" sublabel="1099-R Box 2a" section="income" fieldKey="iraDistributions" value={ws.income.iraDistributions} onChange={handleChange} />
              <FieldRow label="Pensions & Annuities (taxable)" sublabel="1099-R / SSA-1099" section="income" fieldKey="pensionsAnnuities" value={ws.income.pensionsAnnuities} onChange={handleChange} />
              <FieldRow label="Social Security Benefits (taxable)" sublabel="SSA-1099 Box 5 × 85%" section="income" fieldKey="socialSecurity" value={ws.income.socialSecurity} onChange={handleChange} />
              <FieldRow label="Capital Gains / Losses" sublabel="Schedule D / 1099-B" section="income" fieldKey="capitalGains" value={ws.income.capitalGains} onChange={handleChange} />
              <FieldRow label="Rental / Royalty / Partnership" sublabel="Schedule E net income" section="income" fieldKey="scheduleEIncome" value={ws.income.scheduleEIncome} onChange={handleChange} />
              <FieldRow label="Business / Self-Employment Income" sublabel="Schedule C net profit" section="income" fieldKey="businessIncome" value={ws.income.businessIncome} onChange={handleChange} />
              <FieldRow label="Other Income" sublabel="Prizes, gambling, alimony received, etc." section="income" fieldKey="otherIncome" value={ws.income.otherIncome} onChange={handleChange} />
              <div style={{ padding: '10px 12px', background: 'rgba(4,126,87,0.05)', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total Income</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--teal)' }}>{fmtD(summary.totalIncome)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── ADJUSTMENTS ──────────────────────────────────────── */}
          {activeSection === 'adjustments' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <SectionHeader number="3" title="Adjustments to Income" icon="ti-adjustments" color="var(--purple)" />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Above-the-line deductions that reduce your Adjusted Gross Income (AGI).
                </p>
              </div>
              <FieldRow label="Student Loan Interest" sublabel="Up to $2,500" section="adjustments" fieldKey="studentLoanInterest" value={ws.adjustments.studentLoanInterest} onChange={handleChange} />
              <FieldRow label="Educator Expenses" sublabel="Up to $300" section="adjustments" fieldKey="educatorExpenses" value={ws.adjustments.educatorExpenses} onChange={handleChange} />
              <FieldRow label="HSA Deduction" sublabel="Form 8889" section="adjustments" fieldKey="hsaDeduction" value={ws.adjustments.hsaDeduction} onChange={handleChange} />
              <FieldRow label="Self-Employed Health Insurance" sublabel="Schedule 1 Line 17" section="adjustments" fieldKey="selfEmployedHealthInsurance" value={ws.adjustments.selfEmployedHealthInsurance} onChange={handleChange} />
              <FieldRow label="Deductible Self-Employment Tax" sublabel="50% of SE tax (Schedule SE)" section="adjustments" fieldKey="selfEmployedSEI" value={ws.adjustments.selfEmployedSEI} onChange={handleChange} />
              <FieldRow label="IRA / SEP / SIMPLE Contributions" sublabel="Traditional IRA, SEP-IRA deductible portion" section="adjustments" fieldKey="retirementContributions" value={ws.adjustments.retirementContributions} onChange={handleChange} />
              <FieldRow label="Alimony Paid" sublabel="Pre-2019 divorce agreements only" section="adjustments" fieldKey="alimonyPaid" value={ws.adjustments.alimonyPaid} onChange={handleChange} />
              <FieldRow label="Other Adjustments" sublabel="Schedule 1, Part II" section="adjustments" fieldKey="other" value={ws.adjustments.other} onChange={handleChange} />
              <div style={{ padding: '10px 12px', background: 'rgba(101,61,202,0.05)', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Adjusted Gross Income (AGI)</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--purple)' }}>{fmtD(summary.agi)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── DEDUCTIONS ───────────────────────────────────────── */}
          {activeSection === 'deductions' && (
            <div className="card">
              <SectionHeader number="4" title="Deductions" icon="ti-discount" color="var(--amber)" />
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {['standard', 'itemized'].map(t => (
                  <button key={t} onClick={() => handleTopLevel('deductions', { ...ws.deductions, type: t })} style={{
                    flex: 1, padding: '9px 14px', fontSize: 13, borderRadius: 'var(--radius-sm)',
                    background: ws.deductions.type === t ? 'var(--amber)' : 'var(--bg-secondary)',
                    color: ws.deductions.type === t ? '#fff' : 'var(--text-secondary)',
                    border: `0.5px solid ${ws.deductions.type === t ? 'var(--amber)' : 'var(--border)'}`,
                    fontWeight: ws.deductions.type === t ? 600 : 400, cursor: 'pointer',
                  }}>
                    {t === 'standard' ? `Standard — ${fmtD(stdDed)}` : 'Itemized (Schedule A)'}
                  </button>
                ))}
              </div>

              {ws.deductions.type === 'standard' ? (
                <div style={{ padding: 16, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                  <p style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--amber)' }}>{fmtD(stdDed)}</p>
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    Standard deduction for {statuses.find(s => s.id === ws.filingStatus)?.label || ws.filingStatus} ({year})
                  </p>
                </div>
              ) : (
                <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                  {[
                    ['State & Local Taxes (SALT)', 'Capped at $10,000', 'stateAndLocalTax'],
                    ['Mortgage Interest', '1098 — primary + one second home', 'mortgageInterest'],
                    ['Investment Interest', 'Form 4952', 'investmentInterest'],
                    ['Charitable Contributions', 'Cash + non-cash fair market value', 'charitableContributions'],
                    ['Medical & Dental Expenses', 'Amount exceeding 7.5% of AGI', 'medicalExpenses'],
                    ['Casualty & Theft Losses', 'Federally declared disaster only', 'casualtyLosses'],
                    ['Other Itemized Deductions', 'See Schedule A instructions', 'otherItemized'],
                  ].map(([label, sub, key]) => (
                    <FieldRow key={key} label={label} sublabel={sub} section="deductions_itemized"
                      fieldKey={key} value={ws.deductions.itemized?.[key] || 0}
                      onChange={(_, k, v) => {
                        const updated = { ...ws.deductions, itemized: { ...(ws.deductions.itemized || {}), [k]: v } }
                        setWs(prev => { const n = { ...prev, deductions: updated }; scheduleSave(n); return n })
                      }}
                    />
                  ))}
                  <div style={{ padding: '10px 12px', background: 'rgba(180,120,20,0.06)', borderTop: '0.5px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>Total Itemized</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--amber)' }}>{fmtD(Object.values(ws.deductions.itemized || {}).reduce((s, v) => s + (parseFloat(v) || 0), 0))}</span>
                    </div>
                    {summary.deductionAmt === stdDed && ws.deductions.type === 'itemized' && (
                      <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                        ℹ️ Your itemized total is less than the standard deduction — standard ({fmtD(stdDed)}) will be used.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── CREDITS ──────────────────────────────────────────── */}
          {activeSection === 'credits' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <SectionHeader number="5" title="Tax Credits" icon="ti-star" color="var(--teal)" />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  Credits reduce your tax dollar-for-dollar (unlike deductions which reduce taxable income).
                </p>
              </div>
              <FieldRow label="Child Tax Credit / Credit for Other Dependents" sublabel="Up to $2,000/child under 17" section="credits" fieldKey="childTaxCredit" value={ws.credits.childTaxCredit} onChange={handleChange} />
              <FieldRow label="Child & Dependent Care Credit" sublabel="Form 2441" section="credits" fieldKey="childCareCredit" value={ws.credits.childCareCredit} onChange={handleChange} />
              <FieldRow label="Education Credits" sublabel="American Opportunity / Lifetime Learning (Form 8863)" section="credits" fieldKey="educationCredits" value={ws.credits.educationCredits} onChange={handleChange} />
              <FieldRow label="Retirement Savings Contribution Credit" sublabel="Saver's Credit (Form 8880)" section="credits" fieldKey="retirementSaversCredit" value={ws.credits.retirementSaversCredit} onChange={handleChange} />
              <FieldRow label="Foreign Tax Credit" sublabel="Form 1116" section="credits" fieldKey="foreignTaxCredit" value={ws.credits.foreignTaxCredit} onChange={handleChange} />
              <FieldRow label="Residential Clean Energy / EV Credits" sublabel="Form 5695 / Form 8936" section="credits" fieldKey="energyCredits" value={ws.credits.energyCredits} onChange={handleChange} />
              <FieldRow label="Other Credits" sublabel="See Schedule 3" section="credits" fieldKey="otherCredits" value={ws.credits.otherCredits} onChange={handleChange} />
              <div style={{ padding: '10px 12px', background: 'rgba(4,126,87,0.05)', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total Credits</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--teal)' }}>{fmtD(summary.totalCredits)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── OTHER TAXES ──────────────────────────────────────── */}
          {activeSection === 'othertaxes' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <SectionHeader number="6" title="Other Taxes" icon="ti-file-invoice" color="var(--coral)" />
              </div>
              <FieldRow label="Self-Employment Tax" sublabel="Schedule SE — 15.3% on net SE income" section="otherTaxes" fieldKey="selfEmploymentTax" value={ws.otherTaxes.selfEmploymentTax} onChange={handleChange} />
              <FieldRow label="Net Investment Income Tax (NIIT)" sublabel="3.8% on investment income above threshold (Form 8960)" section="otherTaxes" fieldKey="netInvestmentIncomeTax" value={ws.otherTaxes.netInvestmentIncomeTax} onChange={handleChange} />
              <FieldRow label="Additional Medicare Tax" sublabel="0.9% on wages/SE income above $200k (Form 8959)" section="otherTaxes" fieldKey="additionalMedicareTax" value={ws.otherTaxes.additionalMedicareTax} onChange={handleChange} />
              <FieldRow label="Alternative Minimum Tax (AMT)" sublabel="Form 6251 — if triggered" section="otherTaxes" fieldKey="amt" value={ws.otherTaxes.amt} onChange={handleChange} />
              <FieldRow label="Other Taxes" sublabel="Recapture, household employment, etc." section="otherTaxes" fieldKey="otherTaxes" value={ws.otherTaxes.otherTaxes} onChange={handleChange} />
              <div style={{ padding: '10px 12px', background: 'rgba(185,28,28,0.05)', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total Other Taxes</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--coral)' }}>{fmtD(summary.totalOtherTax)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── PAYMENTS ─────────────────────────────────────────── */}
          {activeSection === 'payments' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <SectionHeader number="7" title="Payments & Withholding" icon="ti-credit-card" color="var(--blue)" />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                  All taxes already paid during the year.
                </p>
              </div>
              <FieldRow label="Federal Tax Withheld (W-2)" sublabel="W-2 Box 2 — total all employers" section="payments" fieldKey="w2FederalWithholding" value={ws.payments.w2FederalWithholding} onChange={handleChange} />
              <FieldRow label="Social Security Tax Withheld" sublabel="W-2 Box 4" section="payments" fieldKey="w2SocialSecurityWithholding" value={ws.payments.w2SocialSecurityWithholding} onChange={handleChange} />
              <FieldRow label="Medicare Tax Withheld" sublabel="W-2 Box 6" section="payments" fieldKey="w2MedicareWithholding" value={ws.payments.w2MedicareWithholding} onChange={handleChange} />
              <FieldRow label="Estimated Tax Payments (1040-ES)" sublabel="Q1–Q4 payments made during year" section="payments" fieldKey="estimatedTaxPayments" value={ws.payments.estimatedTaxPayments} onChange={handleChange} />
              <FieldRow label="Earned Income Credit (EIC)" sublabel="Refundable — Schedule EIC" section="payments" fieldKey="earnedIncomeCredit" value={ws.payments.earnedIncomeCredit} onChange={handleChange} />
              <FieldRow label="Refundable Child Tax Credit" sublabel="Additional CTC (Schedule 8812)" section="payments" fieldKey="childTaxCreditRefundable" value={ws.payments.childTaxCreditRefundable} onChange={handleChange} />
              <FieldRow label="Other Refundable Credits / Payments" sublabel="Form 4136 fuel, etc." section="payments" fieldKey="otherRefundableCredits" value={ws.payments.otherRefundableCredits} onChange={handleChange} />
              <div style={{ padding: '10px 12px', background: 'rgba(55,138,221,0.05)', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total Payments</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--blue)' }}>{fmtD(summary.totalPayments)}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── SUMMARY ──────────────────────────────────────────── */}
          {activeSection === 'summary' && (
            <div className="card">
              <SectionHeader number="8" title="Tax Summary" icon="ti-calculator" color="var(--blue)" />

              {/* Big refund/owe banner */}
              <div style={{
                textAlign: 'center', padding: '20px 16px', marginBottom: 20,
                background: summary.balance <= 0 ? 'rgba(4,126,87,0.07)' : 'rgba(185,28,28,0.07)',
                border: `0.5px solid ${summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)'}`,
                borderRadius: 'var(--radius-md)',
              }}>
                <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.6px', color: summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)' }}>
                  {summary.balance <= 0 ? 'Estimated Refund' : 'Estimated Amount Owed'}
                </p>
                <p style={{ margin: 0, fontSize: 36, fontWeight: 700, color: summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)' }}>
                  {fmtD(Math.abs(summary.balance))}
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                  Estimated federal tax only · Does not include state tax
                </p>
              </div>

              {/* Line-by-line breakdown */}
              <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <SummaryRow label="Total Income"             value={summary.totalIncome} />
                <SummaryRow label="Total Adjustments"        value={-summary.totalAdj}   indent />
                <SummaryRow label="Adjusted Gross Income (AGI)" value={summary.agi}      bold />
                <SummaryRow label={`${ws.deductions.type === 'itemized' ? 'Itemized' : 'Standard'} Deduction`} value={-summary.deductionAmt} indent />
                <SummaryRow label="Taxable Income"           value={summary.taxableIncome} bold />
                <SummaryRow label="Federal Income Tax"       value={summary.regularTax} />
                <SummaryRow label="Tax Credits"              value={-summary.totalCredits} indent color="var(--teal)" />
                <SummaryRow label="Other Taxes"              value={summary.totalOtherTax} />
                <SummaryRow label="Total Tax"                value={summary.totalTax}  bold />
                <SummaryRow label="Total Payments & Withholding" value={-summary.totalPayments} indent color="var(--blue)" />
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '12px 12px', background: summary.balance <= 0 ? 'rgba(4,126,87,0.06)' : 'rgba(185,28,28,0.06)',
                  borderTop: `1.5px solid ${summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)'}`,
                }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)' }}>
                    {summary.balance <= 0 ? 'REFUND' : 'AMOUNT OWED'}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: summary.balance <= 0 ? 'var(--teal)' : 'var(--coral)' }}>
                    {fmtD(Math.abs(summary.balance))}
                  </span>
                </div>
              </div>

              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '12px 0 0', lineHeight: 1.6 }}>
                ⚠ This is a rough estimate for planning purposes only. Federal income tax is computed using {year} brackets.
                State taxes, AMT, NIIT, and other adjustments may apply. Consult a tax professional before filing.
              </p>
            </div>
          )}

          {/* Notes (always visible at bottom) */}
          <div className="card" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Notes</p>
            <textarea
              value={ws.notes || ''}
              onChange={e => {
                const v = e.target.value
                setWs(prev => { const n = { ...prev, notes: v }; scheduleSave(n); return n })
              }}
              placeholder="Any notes about this year's return…"
              rows={3}
              style={{
                width: '100%', padding: '8px 10px', fontSize: 12, lineHeight: 1.7,
                background: 'var(--bg-secondary)', border: '0.5px solid var(--border)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                resize: 'vertical', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
