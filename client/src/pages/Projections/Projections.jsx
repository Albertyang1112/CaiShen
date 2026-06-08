import { useState, useMemo, useEffect, useCallback } from 'react'
import axios from 'axios'

const API = 'http://localhost:3001/api'

// ── Tax calculation helpers ───────────────────────────────────────────
function calcFederalTax(taxableIncome) {
  const brackets = [
    [11600, 0.10], [47150, 0.12], [100525, 0.22],
    [191950, 0.24], [243725, 0.32], [609350, 0.35], [Infinity, 0.37]
  ]
  let tax = 0, prev = 0
  for (const [limit, rate] of brackets) {
    if (taxableIncome <= prev) break
    tax += (Math.min(taxableIncome, limit) - prev) * rate
    prev = limit
  }
  return Math.round(tax)
}

function calcLTCG(gains, ordinaryIncome) {
  if (gains <= 0) return 0
  const total = ordinaryIncome + gains
  if (total <= 89250) return 0
  if (total <= 553850) return Math.round(gains * 0.15)
  return Math.round(gains * 0.20)
}

function calcAMT(income, isoExercise) {
  const amtIncome = income + isoExercise
  const amtExemption = Math.max(0, 126500 - (amtIncome - 1156300) * 0.25)
  const amtBase = Math.max(0, amtIncome - amtExemption)
  const amt = amtBase <= 232600 ? amtBase * 0.26 : 232600 * 0.26 + (amtBase - 232600) * 0.28
  return Math.round(amt)
}

function getMarginalBracket(ti) {
  if (ti > 609350) return 37
  if (ti > 243725) return 35
  if (ti > 191950) return 32
  if (ti > 100525) return 24
  if (ti > 47150) return 22
  if (ti > 11600) return 12
  return 10
}

const fd = (n, d=0) => {
  if (Math.abs(n) >= 1e6) return (n < 0 ? '-$' : '$') + (Math.abs(n)/1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return (n < 0 ? '-$' : '$') + (Math.abs(n)/1e3).toFixed(0) + 'K'
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(d)
}
const fp = n => (n >= 0 ? '+' : '') + n.toFixed(1) + '%'

// ── Mini bar chart ────────────────────────────────────────────────────
function BarChart({ data, height = 120 }) {
  const max = Math.max(...data.map(d => d.value))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height, padding: '0 4px' }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fd(d.value)}</span>
          <div style={{ width: '100%', height: Math.max(4, (d.value / max) * (height - 28)), background: d.color || 'var(--blue)', borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}

// ── Slider input ──────────────────────────────────────────────────────
function SliderRow({ label, value, setValue, min, max, step = 5, prefix = '$', suffix = 'K', color }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {color && <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />}
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{prefix}{value}{suffix}</span>
        </div>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => setValue(Number(e.target.value))}
        style={{ width: '100%', accentColor: color || 'var(--blue)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
        <span>{prefix}{min}{suffix}</span><span>{prefix}{max}{suffix}</span>
      </div>
    </div>
  )
}

// ── Scenario card ─────────────────────────────────────────────────────
function ScenarioCard({ label, income, tax, rate, afterTax, highlight }) {
  return (
    <div style={{ background: highlight ? 'var(--blue-light)' : 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '12px 14px', border: highlight ? '0.5px solid var(--blue)' : '0.5px solid var(--border)' }}>
      <p style={{ fontSize: 12, color: highlight ? 'var(--blue)' : 'var(--text-secondary)', margin: '0 0 8px', fontWeight: 500 }}>{label}</p>
      {[['Gross income', fd(income)], ['Federal tax', fd(tax)], ['Eff. rate', rate.toFixed(1) + '%'], ['After-tax', fd(afterTax)]].map(([l, v]) => (
        <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: '0.5px solid var(--border)' }}>
          <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
          <span style={{ fontWeight: 500 }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

// ── Net worth projection ──────────────────────────────────────────────
function NetWorthProjection({ currentNW, annualSavings, reAppreciation, portfolioReturn, years }) {
  const data = []
  let nw = currentNW
  const reValue = 6885000
  const investValue = currentNW - reValue
  for (let y = 0; y <= years; y++) {
    if (y > 0) {
      nw = nw + annualSavings * 1000
        + (reValue * Math.pow(1 + reAppreciation / 100, y) - reValue * Math.pow(1 + reAppreciation / 100, y - 1))
        + (investValue * Math.pow(1 + portfolioReturn / 100, y) - investValue * Math.pow(1 + portfolioReturn / 100, y - 1))
    }
    data.push({ year: new Date().getFullYear() + y, value: Math.round(nw) })
  }
  return data
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────
export default function Projections() {
  const [tab, setTab] = useState('tax')

  // Tax scenario inputs
  const [w2, setW2] = useState(320)
  const [rsu, setRsu] = useState(85)
  const [cryptoGain, setCryptoGain] = useState(42)
  const [reIncome, setReIncome] = useState(252)
  const [ltcg, setLtcg] = useState(0)
  const [isoExercise, setIsoExercise] = useState(0)
  const [deductions, setDeductions] = useState(89)
  const [stateRate, setStateRate] = useState(13.3)

  // Baseline year (prior year actuals)
  const [savedYears, setSavedYears]   = useState([])
  const [baseline, setBaseline]       = useState(null)   // loaded prior year record
  const [saveMsg, setSaveMsg]         = useState('')

  useEffect(() => {
    axios.get(`${API}/tax-years`)
      .then(r => {
        const years = r.data || []
        setSavedYears(years)
        // Auto-load most recent prior year as baseline
        const thisYear = new Date().getFullYear()
        const prior = years.find(y => y.year === thisYear - 1) || years[0]
        if (prior) setBaseline(prior)
      })
      .catch(() => {})
  }, [])

  const loadBaseline = useCallback((year) => {
    if (!year) return
    setW2(year.w2 ?? w2)
    setRsu(year.rsu ?? rsu)
    setCryptoGain(year.cryptoGain ?? cryptoGain)
    setReIncome(year.reIncome ?? reIncome)
    setLtcg(year.ltcg ?? ltcg)
    setIsoExercise(year.isoExercise ?? isoExercise)
    setDeductions(year.deductions ?? deductions)
    if (year.stateRate) setStateRate(year.stateRate)
    setSaveMsg(`Loaded ${year.year} actuals as starting point`)
    setTimeout(() => setSaveMsg(''), 3000)
  }, [w2, rsu, cryptoGain, reIncome, ltcg, isoExercise, deductions])

  const saveThisYear = async () => {
    const thisYear = new Date().getFullYear()
    const entry = { year: thisYear, w2, rsu, cryptoGain, reIncome, ltcg, isoExercise, deductions, stateRate }
    try {
      await axios.post(`${API}/tax-years`, entry)
      setSavedYears(prev => {
        const idx = prev.findIndex(y => y.year === thisYear)
        if (idx >= 0) { const u = [...prev]; u[idx] = entry; return u }
        return [entry, ...prev].sort((a, b) => b.year - a.year)
      })
      setSaveMsg(`${thisYear} actuals saved — available as baseline next year`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) { setSaveMsg('Save failed: ' + e.message); setTimeout(() => setSaveMsg(''), 3000) }
  }

  // Net worth inputs
  const [annualSavings, setAnnualSavings] = useState(150)
  const [reAppreciation, setReAppreciation] = useState(5)
  const [portfolioReturn, setPortfolioReturn] = useState(8)
  const [projectionYears, setProjectionYears] = useState(10)

  // Property sale scenario
  const [saleProperty, setSaleProperty] = useState('muirfield')
  const [salePriceAdj, setSalePriceAdj] = useState(0)
  const [yearsHeld, setYearsHeld] = useState(9)

  const PROPS = [
    { id: 'haas', name: 'Haas', value: 1250000, basis: 820000, mortgage: 780000 },
    { id: 'kobe', name: 'Kobe', value: 980000, basis: 650000, mortgage: 610000 },
    { id: 'bayhill', name: 'Bay Hill', value: 1680000, basis: 1100000, mortgage: 1050000 },
    { id: 'muirfield', name: 'Muirfield', value: 2100000, basis: 1380000, mortgage: 1320000 },
    { id: 'alcita', name: 'Alcita', value: 875000, basis: 580000, mortgage: 540000 },
  ]

  // ── Tax calculations ─────────────────────────────────────────────────
  const taxCalc = useMemo(() => {
    const grossIncome = (w2 + rsu + cryptoGain + reIncome) * 1000
    const stdDeduction = 29200
    const itemizedDeduction = deductions * 1000
    const deductionUsed = Math.max(stdDeduction, itemizedDeduction)
    const ordinaryIncome = (w2 + rsu + reIncome) * 1000
    const taxableOrdinary = Math.max(0, ordinaryIncome - deductionUsed)
    const federalTax = calcFederalTax(taxableOrdinary)
    const ltcgTax = calcLTCG(ltcg * 1000, taxableOrdinary)
    const cryptoTax = calcFederalTax(Math.max(0, taxableOrdinary + cryptoGain * 1000)) - federalTax
    const amtLiability = calcAMT(taxableOrdinary, isoExercise * 1000)
    const amtAdditional = Math.max(0, amtLiability - federalTax)
    const totalFederal = federalTax + ltcgTax + cryptoTax + amtAdditional
    const stateTax = Math.round(grossIncome * (stateRate / 100))
    const totalTax = totalFederal + stateTax
    const effectiveRate = grossIncome > 0 ? (totalTax / grossIncome * 100) : 0
    const marginalRate = getMarginalBracket(taxableOrdinary)
    const afterTax = grossIncome - totalTax
    const niit = grossIncome > 200000 ? Math.round((ltcg * 1000 + cryptoGain * 1000) * 0.038) : 0

    // Quarterly estimates
    const quarterly = Math.round(totalTax / 4)

    return {
      grossIncome, taxableOrdinary, federalTax, ltcgTax, cryptoTax,
      amtLiability, amtAdditional, stateTax, totalTax, effectiveRate,
      marginalRate, afterTax, niit, quarterly, deductionUsed
    }
  }, [w2, rsu, cryptoGain, reIncome, ltcg, isoExercise, deductions, stateRate])

  // ── Comparison scenarios ──────────────────────────────────────────────
  const scenarios = useMemo(() => {
    const base = { w2: w2*1000, rsu: rsu*1000, crypto: cryptoGain*1000, re: reIncome*1000 }
    const calc = (inc) => {
      const td = Math.max(0, inc - Math.max(29200, deductions*1000))
      const fed = calcFederalTax(td)
      const rate = inc > 0 ? (fed/inc*100) : 0
      return { income: inc, tax: fed, rate, afterTax: inc - fed }
    }
    return [
      calc((base.w2 + base.re) / 1000 * 1000),
      calc(base.w2 + base.rsu + base.re),
      calc(base.w2 + base.rsu + base.crypto + base.re),
      calc(base.w2 + base.rsu + base.crypto + base.re + ltcg*1000),
    ]
  }, [w2, rsu, cryptoGain, reIncome, ltcg, deductions])

  // ── Property sale scenario ────────────────────────────────────────────
  const saleCalc = useMemo(() => {
    const prop = PROPS.find(p => p.id === saleProperty)
    if (!prop) return null
    const salePrice = prop.value + salePriceAdj * 1000
    const closingCosts = Math.round(salePrice * 0.06)
    const netProceeds = salePrice - prop.mortgage - closingCosts
    const gain = salePrice - prop.basis - closingCosts
    const deprecRecapture = Math.round(prop.basis * 0.03636 * yearsHeld)
    const taxableGain = Math.max(0, gain - deprecRecapture)
    const ltcgTaxOnSale = yearsHeld >= 1 ? calcLTCG(taxableGain, (w2+rsu+reIncome)*1000) : calcFederalTax(taxableGain)
    const deprecTax = Math.round(deprecRecapture * 0.25)
    const niit = Math.round(taxableGain * 0.038)
    const totalTaxOnSale = ltcgTaxOnSale + deprecTax + niit
    const netAfterTax = netProceeds - totalTaxOnSale
    return { salePrice, closingCosts, netProceeds, gain, deprecRecapture, taxableGain, ltcgTaxOnSale, deprecTax, niit, totalTaxOnSale, netAfterTax, prop }
  }, [saleProperty, salePriceAdj, yearsHeld, w2, rsu, reIncome])

  // ── Net worth projection ──────────────────────────────────────────────
  const nwData = useMemo(() => NetWorthProjection({
    currentNW: 4180000, annualSavings, reAppreciation, portfolioReturn, years: projectionYears
  }), [annualSavings, reAppreciation, portfolioReturn, projectionYears])

  // ── AI Tax Advisor recommendations ───────────────────────────────────
  const taxTips = useMemo(() => {
    const tips = []
    const { grossIncome, totalTax, effectiveRate, marginalRate, amtAdditional,
            amtLiability, federalTax, stateTax, niit, quarterly, taxableOrdinary, deductionUsed } = taxCalc
    const itemized = deductions * 1000

    if (amtAdditional > 0)
      tips.push({ priority: 'high', color: 'var(--coral)', icon: 'ti-alert-triangle',
        title: 'AMT triggered — reduce ISO exercise',
        body: `Exercising ${isoExercise}K of ISOs adds ${fd(amtAdditional)} in AMT on top of regular tax. Reduce exercise to under ${Math.max(0, isoExercise - Math.ceil(isoExercise * 0.3))}K to stay below the AMT crossover point. Consider spreading ISOs across multiple tax years.` })

    if (itemized < 29200)
      tips.push({ priority: 'medium', color: 'var(--amber)', icon: 'ti-coin',
        title: 'Standard deduction beats your itemized',
        body: `Your itemized deductions (${fd(itemized)}) are below the standard deduction ($29,200). Consider bunching 2 years of charitable donations into one year via a Donor-Advised Fund to clear the standard deduction threshold and itemize in alternating years.` })

    if (marginalRate >= 35 && ltcg === 0)
      tips.push({ priority: 'medium', color: 'var(--amber)', icon: 'ti-trending-up',
        title: 'Shift income to long-term capital gains',
        body: `Your marginal rate is ${marginalRate}%. LTCG rates cap at 20% for your income level — a ${(marginalRate - 20)}% advantage per dollar. Consider repositioning appreciated assets from ordinary-income strategies to buy-and-hold to reduce your effective rate.` })

    if (reIncome * 1000 > 50000 && itemized > 29200)
      tips.push({ priority: 'medium', color: 'var(--blue)', icon: 'ti-building-estate',
        title: 'Maximize RE deductions (depreciation, cost seg)',
        body: `With ${fd(reIncome * 1000)} in RE net income, a cost segregation study on any recently acquired property could accelerate depreciation and generate a large paper loss to offset ordinary income this year.` })

    if (rsu > 0 && marginalRate >= 32)
      tips.push({ priority: 'medium', color: 'var(--purple)', icon: 'ti-gift',
        title: `RSU vesting adds ${fd(rsu * 1000)} at ${marginalRate}% ordinary rate`,
        body: `RSUs vest as ordinary income. If you have flexibility, deferring vest into a lower-income year could save ${fd(rsu * 1000 * 0.05)} if your rate drops by 5%. Alternatively, contribute the vest to a 401(k) or Mega Backdoor Roth to recapture some of the tax.` })

    if (grossIncome > 200000 && (ltcg + cryptoGain) > 0)
      tips.push({ priority: 'low', color: 'var(--pink)', icon: 'ti-wave-sine',
        title: '3.8% NIIT applies to your investment income',
        body: `Net Investment Income Tax adds ${fd(niit)} to your bill. To reduce NIIT exposure, shift investments into tax-exempt municipal bonds or maximize real estate professional status to reclassify passive RE income as active.` })

    if (quarterly > 30000)
      tips.push({ priority: 'low', color: 'var(--teal)', icon: 'ti-calendar',
        title: `Quarterly estimates: ${fd(quarterly)} due each period`,
        body: `With ~${fd(totalTax)} in projected tax, your safe-harbor quarterly payment is ${fd(quarterly)} (due Apr 15, Jun 15, Sep 15, Jan 15). Pay via EFTPS to avoid underpayment penalties. California also requires quarterly payments to FTB.` })

    if (w2 * 1000 > 100000)
      tips.push({ priority: 'low', color: 'var(--teal)', icon: 'ti-building-bank',
        title: 'Maximize pre-tax retirement contributions',
        body: `401(k) contributions reduce your taxable income at ${marginalRate}% marginal rate. Max 2025 contribution is $23,500 ($31,000 if 50+). If your employer offers a Mega Backdoor Roth, you can shelter up to $70,000 total — significant at your bracket.` })

    return tips
  }, [taxCalc, isoExercise, w2, rsu, cryptoGain, reIncome, ltcg, deductions])

  const tabs = [
    { id: 'tax', label: 'Tax Projections', icon: 'ti-receipt-tax' },
    { id: 'sale', label: 'Property Sale', icon: 'ti-building-estate' },
    { id: 'networth', label: 'Net Worth', icon: 'ti-trending-up' },
    { id: 'rsu', label: 'RSU & ISO', icon: 'ti-gift' },
  ]

  return (
    <div>
      {/* Tab nav */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '0.5px solid var(--border)', paddingBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ fontSize: 13, padding: '7px 14px', background: tab === t.id ? 'var(--blue-light)' : 'var(--bg-card)', color: tab === t.id ? 'var(--blue)' : 'var(--text-secondary)', borderColor: tab === t.id ? 'var(--blue)' : 'var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 14 }} aria-hidden="true" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── TAX PROJECTIONS ── */}
      {tab === 'tax' && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
          <div>
            {/* Baseline year controls */}
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>Year baseline</p>
                <button onClick={saveThisYear}
                  style={{ fontSize: 11, padding: '4px 10px', background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>
                  <i className="ti ti-device-floppy" aria-hidden="true" /> Save {new Date().getFullYear()}
                </button>
              </div>
              {saveMsg && (
                <div style={{ fontSize: 11, color: 'var(--teal)', padding: '5px 8px', background: 'var(--teal-light)', borderRadius: 'var(--radius-sm)', marginBottom: 8, lineHeight: 1.4 }}>
                  {saveMsg}
                </div>
              )}
              {savedYears.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {savedYears.slice(0, 3).map(y => (
                    <div key={y.year} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>{y.year} actuals</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fd((y.w2 || 0) + (y.rsu || 0) + (y.reIncome || 0))}K income</span>
                      <button onClick={() => loadBaseline(y)}
                        style={{ fontSize: 11, padding: '3px 8px', background: 'var(--blue-light)', color: 'var(--blue)', borderColor: 'var(--blue)' }}>
                        Load
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                  Save this year's actuals after filing and they'll appear here as a baseline for next year's projections.
                </p>
              )}
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>Income inputs</p>
                {baseline && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    {new Date().getFullYear()} projection
                  </span>
                )}
              </div>
              <SliderRow label="W-2 Income" value={w2} setValue={setW2} min={100} max={800} color="var(--blue)" />
              <SliderRow label="RSU Vesting" value={rsu} setValue={setRsu} min={0} max={500} color="var(--purple)" />
              <SliderRow label="Crypto Gains (ST)" value={cryptoGain} setValue={setCryptoGain} min={0} max={300} color="var(--amber)" />
              <SliderRow label="RE Net Income" value={reIncome} setValue={setReIncome} min={0} max={400} color="var(--teal)" />
              <SliderRow label="Long-term Cap Gains" value={ltcg} setValue={setLtcg} min={0} max={500} color="var(--green)" />
              <SliderRow label="ISO Exercise Spread" value={isoExercise} setValue={setIsoExercise} min={0} max={500} color="var(--coral)" />
            </div>
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 16px' }}>Deductions &amp; rates</p>
              <SliderRow label="Itemized Deductions" value={deductions} setValue={setDeductions} min={29} max={200} color="var(--green)" />
              <SliderRow label="CA State Tax Rate" value={stateRate} setValue={setStateRate} min={1} max={13.3} step={0.1} prefix="" suffix="%" color="var(--coral)" />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
              {[
                ['Gross Income', fd(taxCalc.grossIncome), 'var(--text-secondary)', 'ti-cash'],
                ['Total Tax', fd(taxCalc.totalTax), 'var(--coral)', 'ti-receipt-tax'],
                ['Effective Rate', taxCalc.effectiveRate.toFixed(1) + '%', 'var(--amber)', 'ti-percentage'],
                ['After-Tax', fd(taxCalc.afterTax), 'var(--teal)', 'ti-wallet'],
              ].map(([l, v, c, ico]) => (
                <div key={l} className="metric-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{l}</span>
                    <i className={`ti ${ico}`} style={{ fontSize: 16, color: c }} aria-hidden="true" />
                  </div>
                  <p style={{ fontSize: 20, fontWeight: 500, margin: 0, color: c }}>{v}</p>
                </div>
              ))}
            </div>

            {/* Tax breakdown */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="card">
                <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Tax breakdown</p>
                {[
                  ['Federal ordinary income', taxCalc.federalTax, 'var(--coral)'],
                  ['Capital gains (LTCG)', taxCalc.ltcgTax, 'var(--amber)'],
                  ['Crypto (short-term)', taxCalc.cryptoTax, 'var(--amber)'],
                  ['AMT additional', taxCalc.amtAdditional, 'var(--purple)'],
                  ['NIIT (3.8%)', taxCalc.niit, 'var(--pink)'],
                  ['CA State tax', taxCalc.stateTax, 'var(--blue)'],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                    <span style={{ fontWeight: 500, color: v > 0 ? c : 'var(--text-muted)' }}>{fd(v)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: 13 }}>
                  <span style={{ fontWeight: 500 }}>Total</span>
                  <span style={{ fontWeight: 500, color: 'var(--coral)' }}>{fd(taxCalc.totalTax)}</span>
                </div>
              </div>

              <div className="card">
                <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Key metrics</p>
                {[
                  ['Marginal bracket', taxCalc.marginalRate + '%'],
                  ['Taxable income', fd(taxCalc.taxableOrdinary)],
                  ['Deduction used', fd(taxCalc.deductionUsed)],
                  ['AMT liability', fd(taxCalc.amtLiability)],
                  ['Quarterly est. payment', fd(taxCalc.quarterly)],
                ].map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                    <span style={{ fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
                {taxCalc.amtAdditional > 0 && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--purple-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--purple)' }}>
                    <p style={{ fontSize: 11, color: 'var(--purple)', margin: 0, lineHeight: 1.5 }}>⚠ AMT triggered. Consider reducing ISO exercise to {fd(Math.max(0, isoExercise - 50))}K to avoid AMT.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Income scenarios comparison */}
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Scenario comparison — income stacking effect</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
                {[
                  ['W-2 + RE only', ...Object.values(scenarios[0]).slice(1)],
                  ['+ RSU vest', ...Object.values(scenarios[1]).slice(1)],
                  ['+ Crypto gains', ...Object.values(scenarios[2]).slice(1)],
                  ['+ LTCG', ...Object.values(scenarios[3]).slice(1)],
                ].map(([label, tax, rate, afterTax], i) => (
                  <ScenarioCard key={i} label={label} income={scenarios[i].income} tax={tax} rate={rate} afterTax={afterTax} highlight={i === 2} />
                ))}
              </div>
            </div>

            {/* AI Tax Advisor */}
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--purple-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <i className="ti ti-brain" style={{ fontSize: 16, color: 'var(--purple)' }} aria-hidden="true" />
                </div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>Tax advisor recommendations</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '1px 0 0' }}>
                    Based on your current projection — {taxTips.length} item{taxTips.length !== 1 ? 's' : ''} flagged
                  </p>
                </div>
              </div>
              {taxTips.length === 0 ? (
                <div style={{ padding: '12px 14px', background: 'var(--teal-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--teal)' }}>
                  <p style={{ fontSize: 12, color: 'var(--teal)', fontWeight: 500, margin: '0 0 3px' }}>Your tax position looks clean</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    No urgent optimization flags at your current income levels. Adjust the sliders to model different scenarios.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {taxTips.map((tip, i) => (
                    <div key={i} style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${tip.color}` }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                        <i className={`ti ${tip.icon}`} style={{ fontSize: 13, color: tip.color, flexShrink: 0 }} aria-hidden="true" />
                        <p style={{ fontSize: 12, fontWeight: 500, margin: 0, color: tip.color }}>{tip.title}</p>
                        <span style={{ marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 10, background: tip.color.replace(')', '-light)').replace('var(--', 'var(--'), color: tip.color, textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>{tip.priority}</span>
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>{tip.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── PROPERTY SALE ── */}
      {tab === 'sale' && saleCalc && (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Select property</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {PROPS.map(p => (
                  <button key={p.id} onClick={() => setSaleProperty(p.id)}
                    style={{ justifyContent: 'flex-start', background: saleProperty === p.id ? 'var(--blue-light)' : 'var(--bg-secondary)', borderColor: saleProperty === p.id ? 'var(--blue)' : 'var(--border)', color: saleProperty === p.id ? 'var(--blue)' : 'var(--text-secondary)', fontSize: 13 }}>
                    <i className="ti ti-building-estate" style={{ fontSize: 14 }} aria-hidden="true" />
                    {p.name} — {fd(p.value)}
                  </button>
                ))}
              </div>
            </div>
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 14px' }}>Sale inputs</p>
              <SliderRow label="Price adjustment" value={salePriceAdj} setValue={setSalePriceAdj} min={-200} max={500} prefix="$" suffix="K" color="var(--teal)" />
              <SliderRow label="Years held" value={yearsHeld} setValue={setYearsHeld} min={1} max={30} step={1} prefix="" suffix=" yrs" color="var(--purple)" />
              <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginTop: 8 }}>
                <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px' }}>Current inputs</p>
                {[
                  ['List price', fd(saleCalc.salePrice)],
                  ['Cost basis', fd(saleCalc.prop.basis)],
                  ['Years held', yearsHeld + ' yrs'],
                  ['LTCG rate', yearsHeld >= 1 ? '15–20%' : 'Ordinary'],
                ].map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{l}</span>
                    <span style={{ fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Key metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
              {[
                ['Sale Price', fd(saleCalc.salePrice), 'var(--blue)'],
                ['Total Tax', fd(saleCalc.totalTaxOnSale), 'var(--coral)'],
                ['After-Tax Net', fd(saleCalc.netAfterTax), 'var(--teal)'],
                ['Effective Tax Rate', ((saleCalc.totalTaxOnSale / saleCalc.gain) * 100).toFixed(1) + '%', 'var(--amber)'],
              ].map(([l, v, c]) => (
                <div key={l} className="metric-card">
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{l}</p>
                  <p style={{ fontSize: 20, fontWeight: 500, margin: 0, color: c }}>{v}</p>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Proceeds breakdown */}
              <div className="card">
                <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Proceeds breakdown</p>
                {[
                  ['Sale price', fd(saleCalc.salePrice), false],
                  ['Mortgage payoff', '-' + fd(saleCalc.prop.mortgage), false],
                  ['Closing costs (6%)', '-' + fd(saleCalc.closingCosts), false],
                  ['Gross proceeds', fd(saleCalc.netProceeds), true],
                  ['LTCG tax', '-' + fd(saleCalc.ltcgTaxOnSale), false],
                  ['Depreciation tax', '-' + fd(saleCalc.deprecTax), false],
                  ['NIIT', '-' + fd(saleCalc.niit), false],
                  ['After-tax net', fd(saleCalc.netAfterTax), true],
                ].map(([l, v, bold]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12, fontWeight: bold ? 500 : 400 }}>
                    <span style={{ color: bold ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{l}</span>
                    <span style={{ color: bold ? 'var(--teal)' : 'var(--text-primary)' }}>{v}</span>
                  </div>
                ))}
              </div>

              {/* Tax breakdown */}
              <div className="card">
                <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Tax breakdown</p>
                {[
                  ['Total gain', fd(saleCalc.gain)],
                  ['Depreciation recapture', fd(saleCalc.deprecRecapture)],
                  ['Taxable LTCG', fd(saleCalc.taxableGain)],
                  ['LTCG tax (15–20%)', fd(saleCalc.ltcgTaxOnSale)],
                  ['Depreciation tax (25%)', fd(saleCalc.deprecTax)],
                  ['NIIT (3.8%)', fd(saleCalc.niit)],
                  ['Total tax on sale', fd(saleCalc.totalTaxOnSale)],
                ].map(([l, v]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                    <span style={{ fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── TAX-OPTIMAL PRICING ── */}
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 4px' }}>Tax-optimal price finder</p>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 14px' }}>
                After-tax net proceeds across a range of sale prices. The optimal price maximizes what you keep after all taxes.
              </p>
              {(() => {
                const prop = saleCalc.prop
                const baseIncome = (w2 + rsu + reIncome) * 1000
                const steps = 12
                const minPrice = prop.value - 200000
                const maxPrice = prop.value + 500000
                const stepSize = (maxPrice - minPrice) / steps
                const points = Array.from({ length: steps + 1 }, (_, i) => {
                  const sp = Math.round(minPrice + i * stepSize)
                  const cc = Math.round(sp * 0.06)
                  const np = sp - prop.mortgage - cc
                  const gain = sp - prop.basis - cc
                  const dr = Math.round(prop.basis * 0.03636 * yearsHeld)
                  const tg = Math.max(0, gain - dr)
                  const ltcgT = yearsHeld >= 1 ? calcLTCG(tg, baseIncome) : calcFederalTax(tg)
                  const dTax = Math.round(dr * 0.25)
                  const niitT = sp + baseIncome > 200000 ? Math.round(tg * 0.038) : 0
                  const totalT = ltcgT + dTax + niitT
                  const net = np - totalT
                  const effRate = gain > 0 ? (totalT / gain * 100) : 0
                  return { sp, net, totalT, effRate, np }
                })
                const optimal = points.reduce((best, p) => p.net > best.net ? p : best, points[0])
                const maxNet = Math.max(...points.map(p => p.net))
                const minNet = Math.min(...points.map(p => p.net))
                const range = maxNet - minNet

                // Bracket thresholds
                const totalOrdinary = baseIncome
                const ltcg15Threshold = Math.max(0, 553850 - totalOrdinary)
                const niitThreshold = Math.max(0, 200000 - totalOrdinary)

                return (
                  <div>
                    {/* Optimal price callout */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                      <div style={{ background: 'var(--teal-light)', borderRadius: 'var(--radius-md)', padding: '10px 12px', border: '0.5px solid var(--teal)' }}>
                        <p style={{ fontSize: 11, color: 'var(--teal)', margin: '0 0 4px', fontWeight: 500 }}>OPTIMAL SALE PRICE</p>
                        <p style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>{fd(optimal.sp)}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '3px 0 0' }}>Max after-tax: {fd(optimal.net)}</p>
                      </div>
                      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500 }}>YOUR CURRENT PRICE</p>
                        <p style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>{fd(saleCalc.salePrice)}</p>
                        <p style={{ fontSize: 11, color: saleCalc.netAfterTax >= optimal.net ? 'var(--teal)' : 'var(--coral)', margin: '3px 0 0' }}>
                          {saleCalc.netAfterTax >= optimal.net ? '✓ At optimal' : fd(optimal.net - saleCalc.netAfterTax) + ' left on table'}
                        </p>
                      </div>
                      <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500 }}>20% LTCG THRESHOLD</p>
                        <p style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>{ltcg15Threshold > 0 ? fd(ltcg15Threshold) : 'Already over'}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '3px 0 0' }}>gain before 20% rate kicks in</p>
                      </div>
                    </div>

                    {/* Price curve visualization */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 100, marginBottom: 8 }}>
                      {points.map((p, i) => {
                        const h = range > 0 ? Math.max(4, ((p.net - minNet) / range) * 88) : 44
                        const isOptimal = p.sp === optimal.sp
                        const isCurrent = Math.abs(p.sp - saleCalc.salePrice) < stepSize / 2
                        return (
                          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                            {isOptimal && <span style={{ fontSize: 9, color: 'var(--teal)', fontWeight: 500 }}>BEST</span>}
                            {!isOptimal && isCurrent && <span style={{ fontSize: 9, color: 'var(--blue)' }}>YOU</span>}
                            {!isOptimal && !isCurrent && <span style={{ fontSize: 9, color: 'transparent' }}>·</span>}
                            <div style={{ width: '100%', height: h, background: isOptimal ? 'var(--teal)' : isCurrent ? 'var(--blue)' : 'var(--border-light)', borderRadius: '2px 2px 0 0', opacity: isOptimal || isCurrent ? 1 : 0.6 }} />
                          </div>
                        )
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 14 }}>
                      <span>{fd(minPrice)}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>← After-tax proceeds across price range →</span>
                      <span>{fd(maxPrice)}</span>
                    </div>

                    {/* Bracket warnings */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p style={{ fontSize: 12, fontWeight: 500, margin: 0 }}>Tax bracket thresholds to watch</p>
                      {[
                        {
                          label: 'LTCG rate jumps from 15% → 20%',
                          threshold: ltcg15Threshold,
                          color: ltcg15Threshold < 100000 ? 'var(--coral)' : 'var(--amber)',
                          note: ltcg15Threshold > 0 ? `Your gain can reach ${fd(ltcg15Threshold)} before the 20% rate applies` : 'Your income already puts you in the 20% LTCG bracket'
                        },
                        {
                          label: 'NIIT 3.8% surcharge',
                          threshold: niitThreshold,
                          color: niitThreshold < 50000 ? 'var(--coral)' : 'var(--teal)',
                          note: niitThreshold > 0 ? `${fd(niitThreshold)} below NIIT trigger` : 'NIIT applies to your investment gains at 3.8%'
                        },
                        {
                          label: '1031 exchange breakeven',
                          threshold: saleCalc.totalTaxOnSale,
                          color: 'var(--purple)',
                          note: `Deferring ${fd(saleCalc.totalTaxOnSale)} in tax via 1031 lets you reinvest ${fd(saleCalc.netProceeds)} instead of ${fd(saleCalc.netAfterTax)}`
                        },
                      ].map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${item.color}` }}>
                          <div style={{ flex: 1 }}>
                            <p style={{ fontSize: 12, fontWeight: 500, margin: '0 0 2px', color: item.color }}>{item.label}</p>
                            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{item.note}</p>
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 500, color: item.color, flexShrink: 0 }}>{fd(item.threshold)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── NET WORTH PROJECTION ── */}
      {tab === 'networth' && (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
          <div className="card">
            <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 16px' }}>Projection inputs</p>
            <SliderRow label="Annual savings" value={annualSavings} setValue={setAnnualSavings} min={0} max={500} color="var(--teal)" />
            <SliderRow label="RE appreciation" value={reAppreciation} setValue={setReAppreciation} min={0} max={15} step={0.5} prefix="" suffix="%" color="var(--blue)" />
            <SliderRow label="Portfolio return" value={portfolioReturn} setValue={setPortfolioReturn} min={0} max={20} step={0.5} prefix="" suffix="%" color="var(--purple)" />
            <SliderRow label="Years to project" value={projectionYears} setValue={setProjectionYears} min={5} max={30} step={1} prefix="" suffix=" yrs" color="var(--amber)" />
            <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Current net worth</span>
                <span style={{ fontWeight: 500 }}>{fd(4180000)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Projected in {projectionYears}yr</span>
                <span style={{ fontWeight: 500, color: 'var(--teal)' }}>{fd(nwData[nwData.length - 1]?.value || 0)}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {[
                ['Current', fd(4180000), 'var(--text-primary)'],
                [projectionYears / 2 + 'yr projection', fd(nwData[Math.floor(nwData.length / 2)]?.value || 0), 'var(--blue)'],
                [projectionYears + 'yr projection', fd(nwData[nwData.length - 1]?.value || 0), 'var(--teal)'],
              ].map(([l, v, c]) => (
                <div key={l} className="metric-card">
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{l}</p>
                  <p style={{ fontSize: 22, fontWeight: 500, margin: 0, color: c }}>{v}</p>
                </div>
              ))}
            </div>

            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 16px' }}>Net worth trajectory</p>
              <BarChart
                data={nwData.filter((_, i) => i % Math.max(1, Math.floor(nwData.length / 10)) === 0).map(d => ({
                  label: "'" + String(d.year).slice(2),
                  value: d.value,
                  color: 'var(--teal)'
                }))}
                height={160}
              />
            </div>

            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Year by year</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6 }}>
                {nwData.filter((_, i) => i % Math.max(1, Math.floor(nwData.length / 10)) === 0 || i === nwData.length - 1).map((d, i) => (
                  <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{d.year}</p>
                    <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: 'var(--teal)' }}>{fd(d.value)}</p>
                    <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '2px 0 0' }}>+{fd(d.value - 4180000)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── RSU & ISO ── */}
      {tab === 'rsu' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card">
            <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 4px' }}>RSU Vesting tax impact</p>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>RSUs are taxed as ordinary income at vest. Adjust to see tax impact.</p>
            <SliderRow label="RSU shares vesting" value={rsu} setValue={setRsu} min={0} max={500} color="var(--purple)" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {[
                ['Gross RSU value', fd(rsu * 1000)],
                ['Federal tax on vest', fd(calcFederalTax(Math.max(0, rsu * 1000 - 29200)) - calcFederalTax(0))],
                ['Marginal rate at vest', taxCalc.marginalRate + '%'],
                ['After-tax value', fd(rsu * 1000 - Math.round(rsu * 1000 * taxCalc.marginalRate / 100))],
                ['Effective shares kept', Math.round(rsu * (1 - taxCalc.marginalRate / 100)) + ' of ' + rsu],
              ].map(([l, v]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                  <span style={{ fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--purple-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--purple)' }}>
              <p style={{ fontSize: 12, color: 'var(--purple)', margin: 0, lineHeight: 1.6, fontWeight: 500 }}>RSU strategy tip</p>
              <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                If your marginal rate is {taxCalc.marginalRate}%, consider selling vested shares immediately to avoid additional capital gains exposure. Holding only makes sense if you expect {'>'}15% price appreciation to justify the risk.
              </p>
            </div>
          </div>

          <div className="card">
            <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 4px' }}>ISO exercise planner</p>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>ISOs trigger AMT at exercise. Find your safe exercise amount.</p>
            <SliderRow label="ISO spread at exercise" value={isoExercise} setValue={setIsoExercise} min={0} max={500} color="var(--coral)" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {[
                ['ISO spread amount', fd(isoExercise * 1000)],
                ['AMT liability', fd(taxCalc.amtLiability)],
                ['Regular tax', fd(taxCalc.federalTax)],
                ['AMT additional owed', fd(taxCalc.amtAdditional)],
                ['AMT triggered?', taxCalc.amtAdditional > 0 ? '⚠ Yes' : '✓ No'],
              ].map(([l, v]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                  <span style={{ fontWeight: 500, color: l === 'AMT triggered?' ? (taxCalc.amtAdditional > 0 ? 'var(--coral)' : 'var(--teal)') : 'var(--text-primary)' }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, padding: '10px 12px', background: taxCalc.amtAdditional > 0 ? 'var(--coral-light)' : 'var(--teal-light)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${taxCalc.amtAdditional > 0 ? 'var(--coral)' : 'var(--teal)'}` }}>
              <p style={{ fontSize: 12, color: taxCalc.amtAdditional > 0 ? 'var(--coral)' : 'var(--teal)', margin: 0, lineHeight: 1.6, fontWeight: 500 }}>
                {taxCalc.amtAdditional > 0 ? 'AMT Warning' : 'Safe to exercise'}
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                {taxCalc.amtAdditional > 0
                  ? `Exercising ${isoExercise}K of ISOs triggers ${fd(taxCalc.amtAdditional)} in AMT. Reduce exercise to under ${Math.max(0, isoExercise - 50)}K to avoid AMT this year.`
                  : `Exercising ${isoExercise}K of ISOs is within your AMT safe zone. You can exercise up to ${isoExercise + 50}K before AMT is triggered.`
                }
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}