import { useState, useEffect, useMemo } from 'react'
import axios from 'axios'

const API = 'http://localhost:3001/api'

const COINS = {
  BTC:   { name: 'Bitcoin',    id: 'bitcoin',       color: 'var(--amber)' },
  ETH:   { name: 'Ethereum',   id: 'ethereum',      color: 'var(--blue)' },
  SOL:   { name: 'Solana',     id: 'solana',        color: 'var(--purple)' },
  ADA:   { name: 'Cardano',    id: 'cardano',       color: 'var(--teal)' },
  DOT:   { name: 'Polkadot',   id: 'polkadot',      color: 'var(--pink)' },
  AVAX:  { name: 'Avalanche',  id: 'avalanche-2',   color: 'var(--coral)' },
  MATIC: { name: 'Polygon',    id: 'matic-network', color: 'var(--purple)' },
  LINK:  { name: 'Chainlink',  id: 'chainlink',     color: 'var(--blue)' },
  UNI:   { name: 'Uniswap',    id: 'uniswap',       color: 'var(--pink)' },
  USDC:  { name: 'USD Coin',   id: 'usd-coin',      color: 'var(--green)' },
  USDT:  { name: 'Tether',     id: 'tether',        color: 'var(--green)' },
  XRP:   { name: 'XRP',        id: 'ripple',        color: 'var(--blue)' },
  BNB:   { name: 'BNB',        id: 'binancecoin',   color: 'var(--amber)' },
  DOGE:  { name: 'Dogecoin',   id: 'dogecoin',      color: 'var(--amber)' },
  LTC:   { name: 'Litecoin',   id: 'litecoin',      color: 'var(--text-secondary)' },
}

const TX_TYPES = {
  buy:          { label: 'Buy',          color: 'var(--teal)',   icon: 'ti-arrow-down-circle' },
  sell:         { label: 'Sell',         color: 'var(--coral)',  icon: 'ti-arrow-up-circle' },
  receive:      { label: 'Receive',      color: 'var(--green)',  icon: 'ti-arrow-down' },
  send:         { label: 'Send',         color: 'var(--amber)',  icon: 'ti-arrow-up' },
  transfer_in:  { label: 'Transfer In',  color: 'var(--blue)',   icon: 'ti-arrow-right-circle' },
  transfer_out: { label: 'Transfer Out', color: 'var(--purple)', icon: 'ti-arrow-left-circle' },
}

const WALLET_TYPES = {
  bitcoin:  { label: 'Bitcoin Wallet',   icon: 'ti-currency-bitcoin',  color: 'var(--amber)' },
  ethereum: { label: 'Ethereum Wallet',  icon: 'ti-currency-ethereum', color: 'var(--blue)' },
  exchange: { label: 'Exchange',         icon: 'ti-building-bank',     color: 'var(--teal)' },
  hardware: { label: 'Hardware Wallet',  icon: 'ti-usb',               color: 'var(--purple)' },
  other:    { label: 'Other',            icon: 'ti-wallet',            color: 'var(--text-secondary)' },
}

const fd = (n, d = 2) => {
  if (Math.abs(n) >= 1e6) return (n < 0 ? '-$' : '$') + (Math.abs(n) / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e3) return (n < 0 ? '-$' : '$') + (Math.abs(n) / 1e3).toFixed(1) + 'K'
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(d)
}
const fp = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

// ── FIFO cost basis engine ────────────────────────────────────────────
function computePortfolio(txns) {
  const lots = {}     // asset -> [{date, qty, costPerUnit}]
  const realized = [] // {asset, date, qty, proceeds, costBasis, gainLoss, isLongTerm}

  for (const tx of [...txns].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    const asset = (tx.asset || '').toUpperCase()
    if (!asset) continue
    if (!lots[asset]) lots[asset] = []

    const qty  = parseFloat(tx.quantity) || 0
    const price = parseFloat(tx.pricePerUnit) || 0
    const fees  = parseFloat(tx.fees) || 0

    if (tx.type === 'buy' || tx.type === 'receive' || tx.type === 'transfer_in') {
      if (qty > 0) lots[asset].push({ date: tx.date, qty, costPerUnit: price + (qty > 0 ? fees / qty : 0) })
    } else if (tx.type === 'sell') {
      const proceeds = price * qty - fees
      let remaining = qty
      const txDate = new Date(tx.date)
      while (remaining > 1e-9 && lots[asset]?.length > 0) {
        const lot = lots[asset][0]
        const consume = Math.min(lot.qty, remaining)
        const isLong = txDate - new Date(lot.date) >= 365 * 24 * 3600 * 1000
        realized.push({
          asset, date: tx.date,
          qty: consume,
          proceeds: (consume / qty) * proceeds,
          costBasis: consume * lot.costPerUnit,
          gainLoss: (consume / qty) * proceeds - consume * lot.costPerUnit,
          isLongTerm: isLong,
        })
        lot.qty -= consume
        remaining -= consume
        if (lot.qty < 1e-9) lots[asset].shift()
      }
    } else if (tx.type === 'send' || tx.type === 'transfer_out') {
      let remaining = qty
      while (remaining > 1e-9 && lots[asset]?.length > 0) {
        const lot = lots[asset][0]
        const consume = Math.min(lot.qty, remaining)
        lot.qty -= consume
        remaining -= consume
        if (lot.qty < 1e-9) lots[asset].shift()
      }
    }
  }

  const holdings = {}
  for (const [asset, assetLots] of Object.entries(lots)) {
    for (const lot of assetLots) {
      if (!holdings[asset]) holdings[asset] = { asset, quantity: 0, costBasis: 0 }
      holdings[asset].quantity += lot.qty
      holdings[asset].costBasis += lot.qty * lot.costPerUnit
    }
  }
  for (const asset of Object.keys(holdings)) {
    if (holdings[asset].quantity < 1e-9) delete holdings[asset]
  }

  return { holdings: Object.values(holdings), realized }
}

const EXPLORER_TX   = { BTC: 'https://blockstream.info/tx/', ETH: 'https://etherscan.io/tx/', SOL: 'https://solscan.io/tx/', LTC: 'https://blockchair.com/litecoin/transaction/', DOGE: 'https://blockchair.com/dogecoin/transaction/' }
const EXPLORER_ADDR = { BTC: 'https://blockstream.info/address/', ETH: 'https://etherscan.io/address/', SOL: 'https://solscan.io/account/', LTC: 'https://blockchair.com/litecoin/address/', DOGE: 'https://blockchair.com/dogecoin/address/' }
const CHAIN_ASSET   = { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', LTC: 'LTC', DOGE: 'DOGE' }

// ── On-chain data panel (used by wallet cards and quick lookup) ───────
function OnChainPanel({ data, prices }) {
  const { chain, address, balance, transactions = [] } = data
  const asset    = CHAIN_ASSET[chain]
  const price    = asset ? (prices[asset] || 0) : 0
  const usdVal   = price > 0 ? balance * price : null
  const explorerTx   = EXPLORER_TX[chain]
  const explorerAddr = EXPLORER_ADDR[chain]

  return (
    <div style={{ marginTop: 12 }}>
      {/* Balance summary */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Balance</p>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{balance?.toFixed(8)} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)' }}>{chain}</span></p>
          {usdVal !== null && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 0' }}>${usdVal.toLocaleString('en-US', { maximumFractionDigits: 2 })} USD</p>}
        </div>
        <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Chain</p>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--amber)' }}>{chain}</p>
          {explorerAddr && (
            <a href={explorerAddr + address} target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--blue)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              Block explorer <i className="ti ti-external-link" style={{ fontSize: 11 }} aria-hidden="true" />
            </a>
          )}
        </div>
        <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '0.5px solid var(--border)' }}>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Transactions</p>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{transactions.length}</p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' }}>last {transactions.length} shown</p>
        </div>
      </div>

      {/* Transaction list */}
      {transactions.length > 0 && (
        <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 110px 70px', gap: 8, padding: '7px 12px', background: 'var(--bg-secondary)', borderBottom: '0.5px solid var(--border)' }}>
            {['Date', 'Transaction Hash', 'Amount', 'Status'].map(h => (
              <span key={h} style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</span>
            ))}
          </div>
          {transactions.map((tx, i) => {
            const isPositive = tx.amount === null ? null : tx.amount >= 0
            return (
              <div key={tx.hash || i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 110px 70px', gap: 8, padding: '7px 12px', borderBottom: i < transactions.length - 1 ? '0.5px solid var(--border)' : 'none', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{tx.date || '—'}</span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {explorerTx ? (
                    <a href={explorerTx + tx.hash} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)', textDecoration: 'none' }}>
                      {tx.hash?.slice(0, 12)}…{tx.hash?.slice(-6)}
                    </a>
                  ) : (
                    <>{tx.hash?.slice(0, 12)}…{tx.hash?.slice(-6)}</>
                  )}
                </span>
                <span style={{ fontSize: 12, fontWeight: 500, color: tx.amount === null ? 'var(--text-muted)' : isPositive ? 'var(--teal)' : 'var(--coral)' }}>
                  {tx.amount === null ? '—' : `${isPositive ? '+' : ''}${tx.amount?.toFixed(chain === 'ETH' ? 6 : 8)} ${chain}`}
                </span>
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 8, textAlign: 'center', background: tx.confirmed ? 'var(--teal-light)' : 'var(--amber-light)', color: tx.confirmed ? 'var(--teal)' : 'var(--amber)' }}>
                  {tx.confirmed ? 'Confirmed' : 'Pending'}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {transactions.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>No transactions found</p>
      )}
    </div>
  )
}

const emptyForm = () => ({
  type: 'buy', date: new Date().toISOString().slice(0, 10),
  asset: 'BTC', quantity: '', pricePerUnit: '', fees: '', exchange: '', notes: '',
})
const emptyWallet = () => ({ name: '', type: 'bitcoin', address: '', exchange: '', notes: '' })

export default function Crypto() {
  const [tab, setTab]             = useState('portfolio')
  const [txns, setTxns]           = useState([])
  const [wallets, setWallets]     = useState([])
  const [prices, setPrices]       = useState({})
  const [pricesLoading, setPricesLoading] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [addingTx, setAddingTx]   = useState(false)
  const [addingWallet, setAddingWallet] = useState(false)
  const [form, setForm]           = useState(emptyForm())
  const [walletForm, setWalletForm] = useState(emptyWallet())
  const [error, setError]         = useState('')
  const [walletData, setWalletData]     = useState({}) // { [id]: {loading,chain,balance,transactions,error,ts} }
  const [expandedWallet, setExpandedWallet] = useState(null)
  const [lookupAddr, setLookupAddr]     = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError]   = useState(null)

  useEffect(() => {
    Promise.all([
      axios.get(`${API}/crypto/transactions`),
      axios.get(`${API}/wallets`),
    ]).then(([txRes, wRes]) => {
      setTxns(txRes.data || [])
      setWallets(wRes.data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  // Fetch live prices from CoinGecko for held assets
  useEffect(() => {
    if (loading || !txns.length) return
    const { holdings } = computePortfolio(txns)
    const ids = [...new Set(holdings.map(h => COINS[h.asset]?.id).filter(Boolean))].join(',')
    if (!ids) return
    setPricesLoading(true)
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
      .then(r => r.json())
      .then(data => {
        const map = {}
        for (const [sym, info] of Object.entries(COINS)) {
          if (data[info.id]?.usd) map[sym] = data[info.id].usd
        }
        setPrices(map)
      })
      .catch(() => {})
      .finally(() => setPricesLoading(false))
  }, [txns, loading])

  const { holdings, realized } = useMemo(() => computePortfolio(txns), [txns])

  const portfolioStats = useMemo(() => {
    let totalValue = 0, totalCost = 0
    for (const h of holdings) {
      totalValue += h.quantity * (prices[h.asset] || 0)
      totalCost  += h.costBasis
    }
    return { totalValue, totalCost, unrealized: totalValue - totalCost }
  }, [holdings, prices])

  const taxSummary = useMemo(() => {
    const yr = String(new Date().getFullYear())
    let stAll = 0, ltAll = 0, stYTD = 0, ltYTD = 0
    for (const r of realized) {
      if (r.isLongTerm) ltAll += r.gainLoss; else stAll += r.gainLoss
      if (r.date?.startsWith(yr)) {
        if (r.isLongTerm) ltYTD += r.gainLoss; else stYTD += r.gainLoss
      }
    }
    return { stAll, ltAll, totalAll: stAll + ltAll, stYTD, ltYTD, totalYTD: stYTD + ltYTD }
  }, [realized])

  const addTx = async () => {
    if (!form.asset || !form.quantity || !form.date) { setError('Asset, quantity, and date are required'); return }
    setError('')
    try {
      const res = await axios.post(`${API}/crypto/transactions`, form)
      setTxns(prev => [...prev, res.data])
      setForm(emptyForm())
      setAddingTx(false)
    } catch (e) { setError(e.response?.data?.error || e.message) }
  }

  const deleteTx = async (id) => {
    if (!window.confirm('Delete this transaction?')) return
    await axios.delete(`${API}/crypto/transactions/${id}`)
    setTxns(prev => prev.filter(t => t.id !== id))
  }

  const addWallet = async () => {
    if (!walletForm.name) { setError('Wallet name is required'); return }
    setError('')
    try {
      const res = await axios.post(`${API}/wallets`, walletForm)
      setWallets(prev => [...prev, res.data])
      setWalletForm(emptyWallet())
      setAddingWallet(false)
    } catch (e) { setError(e.response?.data?.error || e.message) }
  }

  const deleteWallet = async (id) => {
    if (!window.confirm('Remove this wallet?')) return
    await axios.delete(`${API}/wallets/${id}`)
    setWallets(prev => prev.filter(w => w.id !== id))
  }

  const fetchWalletData = async (wallet) => {
    if (!wallet.address) return
    setWalletData(prev => ({ ...prev, [wallet.id]: { ...(prev[wallet.id] || {}), loading: true, error: null } }))
    setExpandedWallet(wallet.id)
    try {
      const res = await axios.get(`${API}/wallet-lookup?address=${encodeURIComponent(wallet.address)}`)
      setWalletData(prev => ({ ...prev, [wallet.id]: { ...res.data, loading: false, ts: Date.now() } }))
    } catch (e) {
      setWalletData(prev => ({ ...prev, [wallet.id]: { loading: false, error: e.response?.data?.error || e.message } }))
    }
  }

  const lookupAddress = async () => {
    if (!lookupAddr.trim()) return
    setLookupLoading(true); setLookupError(null); setLookupResult(null)
    try {
      const res = await axios.get(`${API}/wallet-lookup?address=${encodeURIComponent(lookupAddr.trim())}`)
      setLookupResult(res.data)
    } catch (e) {
      setLookupError(e.response?.data?.error || e.message)
    }
    setLookupLoading(false)
  }

  const exportCSV = () => {
    const rows = [
      ['Date', 'Type', 'Asset', 'Quantity', 'Price/Unit', 'Total', 'Fees', 'Exchange', 'Notes'],
      ...[...txns].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(t => [
        t.date, t.type, t.asset, t.quantity,
        t.pricePerUnit,
        ((parseFloat(t.quantity) || 0) * (parseFloat(t.pricePerUnit) || 0)).toFixed(2),
        t.fees, t.exchange, t.notes,
      ]),
    ]
    const csv = rows.map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n')
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `crypto-transactions-${Date.now()}.csv`,
    })
    a.click()
  }

  const TABS = [
    { id: 'portfolio',    label: 'Portfolio',    icon: 'ti-chart-pie' },
    { id: 'transactions', label: 'Transactions', icon: 'ti-list' },
    { id: 'tax',          label: 'Tax Report',   icon: 'ti-receipt-tax' },
    { id: 'wallets',      label: 'Wallets',      icon: 'ti-wallet' },
  ]

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60, color: 'var(--text-muted)', fontSize: 13 }}>
      <i className="ti ti-loader-2 spin" style={{ marginRight: 8 }} aria-hidden="true" /> Loading crypto data…
    </div>
  )

  return (
    <div>
      {/* Tab nav */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '0.5px solid var(--border)', paddingBottom: 12 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ fontSize: 13, padding: '7px 14px', background: tab === t.id ? 'var(--amber-light)' : 'var(--bg-card)', color: tab === t.id ? 'var(--amber)' : 'var(--text-secondary)', borderColor: tab === t.id ? 'var(--amber)' : 'var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 14 }} aria-hidden="true" />
            {t.label}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {pricesLoading && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-loader-2 spin" aria-hidden="true" /> prices
            </span>
          )}
          <button onClick={exportCSV} style={{ fontSize: 12 }}>
            <i className="ti ti-download" aria-hidden="true" /> Export CSV
          </button>
          <button onClick={() => setAddingTx(true)}
            style={{ fontSize: 12, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)' }}>
            <i className="ti ti-plus" aria-hidden="true" /> Add Transaction
          </button>
        </div>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--coral-light)', borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--coral)', border: '0.5px solid var(--coral)', marginBottom: 12 }}>
          <i className="ti ti-alert-circle" aria-hidden="true" /> {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--coral)', padding: 0, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* ── Add Transaction Modal ── */}
      {addingTx && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={e => e.target === e.currentTarget && setAddingTx(false)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: 24, width: 500, border: '0.5px solid var(--border)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <p style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>Add Transaction</p>
              <button onClick={() => setAddingTx(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, padding: 0, cursor: 'pointer' }}>✕</button>
            </div>

            {/* Type selector */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
              {Object.entries(TX_TYPES).map(([k, v]) => (
                <button key={k} onClick={() => setForm(f => ({ ...f, type: k }))}
                  style={{ fontSize: 12, padding: '5px 10px', background: form.type === k ? v.color.replace(')', '-light)').replace('var(--', 'var(--') : 'var(--bg-secondary)', color: form.type === k ? v.color : 'var(--text-secondary)', borderColor: form.type === k ? v.color : 'var(--border)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className={`ti ${v.icon}`} aria-hidden="true" /> {v.label}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { label: 'Date *',          field: 'date',         type: 'date',   placeholder: '' },
                { label: 'Asset *',         field: 'asset',        type: 'select', options: Object.keys(COINS) },
                { label: 'Quantity *',      field: 'quantity',     type: 'number', placeholder: '0.00000000' },
                { label: 'Price per unit ($)', field: 'pricePerUnit', type: 'number', placeholder: '0.00' },
                { label: 'Fees ($)',        field: 'fees',         type: 'number', placeholder: '0.00' },
                { label: 'Exchange / Source', field: 'exchange',   type: 'text',   placeholder: 'Coinbase, Kraken…' },
              ].map(({ label, field, type, placeholder, options }) => (
                <div key={field}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{label}</label>
                  {type === 'select' ? (
                    <select value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} style={{ width: '100%' }}>
                      {options.map(k => <option key={k} value={k}>{k} — {COINS[k].name}</option>)}
                      <option value="OTHER">Other</option>
                    </select>
                  ) : (
                    <input type={type} step="any" placeholder={placeholder} value={form[field]}
                      onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} style={{ width: '100%' }} />
                  )}
                </div>
              ))}
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Notes</label>
                <input type="text" placeholder="Optional" value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ width: '100%' }}
                  onKeyDown={e => e.key === 'Enter' && addTx()} />
              </div>
            </div>

            {form.quantity && form.pricePerUnit && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--text-secondary)' }}>
                Total: <strong style={{ color: 'var(--text-primary)' }}>{fd((parseFloat(form.quantity) || 0) * (parseFloat(form.pricePerUnit) || 0))}</strong>
                {form.fees && <span> · Fees: <strong>{fd(parseFloat(form.fees) || 0)}</strong></span>}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={() => setAddingTx(false)}>Cancel</button>
              <button onClick={addTx}
                style={{ fontSize: 13, background: 'var(--amber)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', padding: '9px 16px', fontWeight: 500, cursor: 'pointer' }}>
                Add Transaction
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PORTFOLIO TAB ── */}
      {tab === 'portfolio' && (
        <div>
          {holdings.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <i className="ti ti-currency-bitcoin" style={{ fontSize: 40, color: 'var(--text-muted)' }} aria-hidden="true" />
              <p style={{ fontSize: 16, fontWeight: 500, margin: '14px 0 6px' }}>No holdings yet</p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Add buy transactions to track your portfolio and cost basis</p>
              <button onClick={() => setAddingTx(true)}
                style={{ fontSize: 13, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                <i className="ti ti-plus" aria-hidden="true" /> Add first transaction
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
                {[
                  ['Portfolio Value', fd(portfolioStats.totalValue), 'var(--amber)', 'ti-wallet'],
                  ['Total Cost Basis', fd(portfolioStats.totalCost), 'var(--text-secondary)', 'ti-shopping-cart'],
                  ['Unrealized P&L', (portfolioStats.unrealized >= 0 ? '+' : '') + fd(portfolioStats.unrealized), portfolioStats.unrealized >= 0 ? 'var(--teal)' : 'var(--coral)', 'ti-trending-up'],
                  ['Holdings', holdings.length, 'var(--blue)', 'ti-coins'],
                ].map(([l, v, c, ico]) => (
                  <div key={l} className="metric-card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{l}</span>
                      <i className={`ti ${ico}`} style={{ fontSize: 16, color: c }} aria-hidden="true" />
                    </div>
                    <p style={{ fontSize: 20, fontWeight: 500, margin: 0, color: c }}>{v}</p>
                    {l === 'Unrealized P&L' && portfolioStats.totalCost > 0 && (
                      <p style={{ fontSize: 11, margin: '2px 0 0', color: c }}>
                        {fp((portfolioStats.unrealized / portfolioStats.totalCost) * 100)} return
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>Holdings</p>
                  {!pricesLoading && Object.keys(prices).length === 0 && (
                    <span style={{ fontSize: 11, color: 'var(--amber)' }}>⚠ Prices unavailable (CoinGecko rate limit)</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 110px 90px 100px 110px 110px 80px', gap: 8, padding: '8px 0', borderBottom: '0.5px solid var(--border)', marginBottom: 4 }}>
                  {['', 'Asset', 'Quantity', 'Avg Cost', 'Price', 'Value', 'P&L', 'Return'].map(h => (
                    <span key={h} style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</span>
                  ))}
                </div>
                {holdings.map(h => {
                  const coin    = COINS[h.asset] || { name: h.asset, color: 'var(--text-secondary)' }
                  const price   = prices[h.asset] || 0
                  const value   = h.quantity * price
                  const avgCost = h.quantity > 1e-9 ? h.costBasis / h.quantity : 0
                  const pnl     = value - h.costBasis
                  const pnlPct  = h.costBasis > 1e-9 ? (pnl / h.costBasis) * 100 : 0
                  const bgColor = (coin.color || 'var(--amber)').replace(')', '-light)').replace('var(--', 'var(--')
                  return (
                    <div key={h.asset} style={{ display: 'grid', gridTemplateColumns: '44px 1fr 110px 90px 100px 110px 110px 80px', gap: 8, padding: '10px 0', borderBottom: '0.5px solid var(--border)', alignItems: 'center' }}>
                      <div style={{ width: 34, height: 34, borderRadius: 8, background: bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <i className="ti ti-currency-bitcoin" style={{ fontSize: 15, color: coin.color }} aria-hidden="true" />
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{h.asset}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>{coin.name}</p>
                      </div>
                      <span style={{ fontSize: 12 }}>{h.quantity < 0.01 ? h.quantity.toFixed(8) : h.quantity.toFixed(4)}</span>
                      <span style={{ fontSize: 12 }}>${avgCost.toFixed(2)}</span>
                      <span style={{ fontSize: 12 }}>{price > 0 ? '$' + price.toLocaleString() : '—'}</span>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{price > 0 ? fd(value) : '—'}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: pnl >= 0 ? 'var(--teal)' : 'var(--coral)' }}>{price > 0 ? (pnl >= 0 ? '+' : '') + fd(pnl) : '—'}</span>
                      <span style={{ fontSize: 12, color: pnlPct >= 0 ? 'var(--teal)' : 'var(--coral)' }}>{price > 0 ? fp(pnlPct) : '—'}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── TRANSACTIONS TAB ── */}
      {tab === 'transactions' && (
        <div>
          {txns.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <i className="ti ti-list" style={{ fontSize: 40, color: 'var(--text-muted)' }} aria-hidden="true" />
              <p style={{ fontSize: 16, fontWeight: 500, margin: '14px 0 6px' }}>No transactions yet</p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>Add your first transaction to start tracking cost basis</p>
              <button onClick={() => setAddingTx(true)}
                style={{ fontSize: 13, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                <i className="ti ti-plus" aria-hidden="true" /> Add transaction
              </button>
            </div>
          ) : (
            <div className="card" style={{ overflowX: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '90px 80px 70px 90px 90px 90px 70px 1fr 36px', gap: 8, padding: '8px 0', borderBottom: '0.5px solid var(--border)', marginBottom: 4, minWidth: 700 }}>
                {['Date', 'Type', 'Asset', 'Qty', 'Price', 'Total', 'Fees', 'Exchange / Notes', ''].map(h => (
                  <span key={h} style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</span>
                ))}
              </div>
              {[...txns].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(tx => {
                const tt    = TX_TYPES[tx.type] || TX_TYPES.buy
                const qty   = parseFloat(tx.quantity) || 0
                const price = parseFloat(tx.pricePerUnit) || 0
                const total = qty * price
                return (
                  <div key={tx.id} style={{ display: 'grid', gridTemplateColumns: '90px 80px 70px 90px 90px 90px 70px 1fr 36px', gap: 8, padding: '9px 0', borderBottom: '0.5px solid var(--border)', alignItems: 'center', minWidth: 700 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tx.date}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className={`ti ${tt.icon}`} style={{ fontSize: 12, color: tt.color }} aria-hidden="true" />
                      <span style={{ fontSize: 12, color: tt.color, fontWeight: 500 }}>{tt.label}</span>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{tx.asset}</span>
                    <span style={{ fontSize: 12 }}>{qty < 0.01 ? qty.toFixed(8) : qty.toFixed(4)}</span>
                    <span style={{ fontSize: 12 }}>{price > 0 ? '$' + price.toLocaleString() : '—'}</span>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{price > 0 ? fd(total) : '—'}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tx.fees ? fd(parseFloat(tx.fees)) : '—'}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.exchange || tx.notes || '—'}</span>
                    <button onClick={() => deleteTx(tx.id)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px', fontSize: 13 }}>
                      <i className="ti ti-trash" aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── TAX REPORT TAB ── */}
      {tab === 'tax' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Left column: YTD realized events */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 14px' }}>{new Date().getFullYear()} YTD Summary</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                {[
                  ['Short-Term Gains', fd(taxSummary.stYTD), taxSummary.stYTD >= 0 ? 'var(--teal)' : 'var(--coral)'],
                  ['Long-Term Gains', fd(taxSummary.ltYTD), taxSummary.ltYTD >= 0 ? 'var(--teal)' : 'var(--coral)'],
                  ['Total Realized', fd(taxSummary.totalYTD), taxSummary.totalYTD >= 0 ? 'var(--teal)' : 'var(--coral)'],
                  ['Est. Tax (ST @ 37%)', fd(Math.max(0, taxSummary.stYTD) * 0.37), 'var(--amber)'],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 4px', fontWeight: 500 }}>{l}</p>
                    <p style={{ fontSize: 16, fontWeight: 500, margin: 0, color: c }}>{v}</p>
                  </div>
                ))}
              </div>

              {/* YTD realized events */}
              {(() => {
                const yr = String(new Date().getFullYear())
                const ytd = realized.filter(r => r.date?.startsWith(yr))
                if (!ytd.length) return (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                    No realized gains/losses this year
                  </p>
                )
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '78px 50px 80px 80px 80px 54px', gap: 6, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
                      {['Date', 'Asset', 'Proceeds', 'Cost', 'Gain/Loss', 'Term'].map(h => (
                        <span key={h} style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, textTransform: 'uppercase' }}>{h}</span>
                      ))}
                    </div>
                    {ytd.map((r, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '78px 50px 80px 80px 80px 54px', gap: 6, padding: '6px 0', borderBottom: '0.5px solid var(--border)', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{r.date}</span>
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{r.asset}</span>
                        <span style={{ fontSize: 11 }}>{fd(r.proceeds)}</span>
                        <span style={{ fontSize: 11 }}>{fd(r.costBasis)}</span>
                        <span style={{ fontSize: 12, fontWeight: 500, color: r.gainLoss >= 0 ? 'var(--teal)' : 'var(--coral)' }}>
                          {(r.gainLoss >= 0 ? '+' : '') + fd(r.gainLoss)}
                        </span>
                        <span style={{ fontSize: 10, padding: '2px 5px', borderRadius: 10, textAlign: 'center', background: r.isLongTerm ? 'var(--teal-light)' : 'var(--amber-light)', color: r.isLongTerm ? 'var(--teal)' : 'var(--amber)' }}>
                          {r.isLongTerm ? 'LT' : 'ST'}
                        </span>
                      </div>
                    ))}
                  </>
                )
              })()}
            </div>
          </div>

          {/* Right column: all-time summary + tips */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 14px' }}>All-Time Summary</p>
              {[
                ['Short-term gains', fd(taxSummary.stAll), taxSummary.stAll >= 0 ? 'var(--teal)' : 'var(--coral)'],
                ['Long-term gains', fd(taxSummary.ltAll), taxSummary.ltAll >= 0 ? 'var(--teal)' : 'var(--coral)'],
                ['Total realized', fd(taxSummary.totalAll), taxSummary.totalAll >= 0 ? 'var(--teal)' : 'var(--coral)'],
                ['Unrealized P&L', (portfolioStats.unrealized >= 0 ? '+' : '') + fd(portfolioStats.unrealized), portfolioStats.unrealized >= 0 ? 'var(--teal)' : 'var(--coral)'],
              ].map(([l, v, c]) => (
                <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '0.5px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{l}</span>
                  <span style={{ fontWeight: 500, color: c }}>{v}</span>
                </div>
              ))}
            </div>

            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 12px' }}>Tax optimization</p>
              {taxSummary.stYTD > 10000 && (
                <div style={{ padding: '10px 12px', background: 'var(--amber-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--amber)', marginBottom: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--amber)', margin: '0 0 3px' }}>Short-term gains hit as ordinary income</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    {fd(taxSummary.stYTD)} in ST gains taxed at up to 37%. Holding 12+ months flips remaining positions to LTCG rates (0–20%).
                  </p>
                </div>
              )}
              {portfolioStats.unrealized < -5000 && (
                <div style={{ padding: '10px 12px', background: 'var(--blue-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--blue)', marginBottom: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--blue)', margin: '0 0 3px' }}>Tax-loss harvesting opportunity</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    {fd(Math.abs(portfolioStats.unrealized))} in unrealized losses. Selling offsets gains; excess deducts up to $3K/yr from ordinary income. Repurchase after 30 days (wash-sale rule).
                  </p>
                </div>
              )}
              {taxSummary.ltYTD < 0 && (
                <div style={{ padding: '10px 12px', background: 'var(--teal-light)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--teal)', marginBottom: 8 }}>
                  <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--teal)', margin: '0 0 3px' }}>LT losses can offset other capital gains</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    {fd(Math.abs(taxSummary.ltYTD))} in LT losses available. Apply against RE sale gains, stock gains, or carry forward indefinitely.
                  </p>
                </div>
              )}
              {taxSummary.stYTD <= 0 && portfolioStats.unrealized >= 0 && taxSummary.ltYTD >= 0 && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                  No urgent crypto tax concerns this year.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── WALLETS TAB ── */}
      {tab === 'wallets' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Quick address lookup */}
          <div className="card">
            <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 10px' }}>
              <i className="ti ti-search" style={{ marginRight: 6, color: 'var(--amber)' }} aria-hidden="true" />
              Look up any address
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="Paste a BTC, ETH, SOL, LTC, or DOGE address…"
                value={lookupAddr}
                onChange={e => { setLookupAddr(e.target.value); setLookupResult(null); setLookupError(null) }}
                onKeyDown={e => e.key === 'Enter' && lookupAddress()}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
              />
              <button onClick={lookupAddress} disabled={lookupLoading || !lookupAddr.trim()}
                style={{ background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)', fontSize: 12, whiteSpace: 'nowrap' }}>
                {lookupLoading ? <><i className="ti ti-loader-2 spin" aria-hidden="true" /> Looking up…</> : <><i className="ti ti-search" aria-hidden="true" /> Fetch</>}
              </button>
            </div>
            {lookupError && <p style={{ fontSize: 12, color: 'var(--coral)', margin: '8px 0 0' }}>{lookupError}</p>}
            {lookupResult && <OnChainPanel data={lookupResult} prices={prices} />}
          </div>

          {/* Add wallet form */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => setAddingWallet(v => !v)}
              style={{ fontSize: 13, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)' }}>
              <i className={`ti ${addingWallet ? 'ti-x' : 'ti-plus'}`} aria-hidden="true" /> {addingWallet ? 'Cancel' : 'Add Wallet / Exchange'}
            </button>
          </div>

          {addingWallet && (
            <div className="card">
              <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 14px' }}>Add Wallet or Exchange</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Name *</label>
                  <input type="text" placeholder="My Bitcoin Wallet" value={walletForm.name}
                    onChange={e => setWalletForm(f => ({ ...f, name: e.target.value }))} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Type</label>
                  <select value={walletForm.type} onChange={e => setWalletForm(f => ({ ...f, type: e.target.value }))} style={{ width: '100%' }}>
                    {Object.entries(WALLET_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                    Public Address <span style={{ color: 'var(--text-muted)' }}>(paste your public key — never your private key)</span>
                  </label>
                  <input type="text" placeholder="0x… or bc1… or 1A… or solana address" value={walletForm.address}
                    onChange={e => setWalletForm(f => ({ ...f, address: e.target.value }))}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Exchange</label>
                  <input type="text" placeholder="Coinbase, Binance, Kraken…" value={walletForm.exchange}
                    onChange={e => setWalletForm(f => ({ ...f, exchange: e.target.value }))} style={{ width: '100%' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Notes</label>
                  <input type="text" placeholder="Optional" value={walletForm.notes}
                    onChange={e => setWalletForm(f => ({ ...f, notes: e.target.value }))} style={{ width: '100%' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={() => setAddingWallet(false)}>Cancel</button>
                <button onClick={addWallet}
                  style={{ fontSize: 13, background: 'var(--amber)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', padding: '9px 16px', fontWeight: 500, cursor: 'pointer' }}>
                  Save
                </button>
              </div>
            </div>
          )}

          {wallets.length === 0 && !addingWallet ? (
            <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
              <i className="ti ti-wallet" style={{ fontSize: 40, color: 'var(--text-muted)' }} aria-hidden="true" />
              <p style={{ fontSize: 16, fontWeight: 500, margin: '14px 0 6px' }}>No wallets tracked</p>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                Add a wallet address to sync live on-chain balance and transaction history.
              </p>
              <button onClick={() => setAddingWallet(true)}
                style={{ fontSize: 13, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)' }}>
                <i className="ti ti-plus" aria-hidden="true" /> Add wallet
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {wallets.map(w => {
                const wt   = WALLET_TYPES[w.type] || WALLET_TYPES.other
                const bg   = wt.color.replace(')', '-light)').replace('var(--', 'var(--')
                const wd   = walletData[w.id]
                const isExpanded = expandedWallet === w.id
                const asset = wd?.chain ? CHAIN_ASSET[wd.chain] : null
                const usdPrice = asset ? (prices[asset] || 0) : 0
                return (
                  <div key={w.id} className="card" style={{ padding: '14px 16px' }}>
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 38, height: 38, borderRadius: 'var(--radius-md)', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className={`ti ${wt.icon}`} style={{ fontSize: 18, color: wt.color }} aria-hidden="true" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 1px' }}>{w.name}</p>
                        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>
                          {wt.label}{w.exchange ? ` — ${w.exchange}` : ''}
                          {wd?.chain && <span style={{ marginLeft: 6, padding: '1px 5px', background: 'var(--amber-light)', color: 'var(--amber)', borderRadius: 8, fontSize: 10, fontWeight: 600 }}>{wd.chain}</span>}
                        </p>
                      </div>
                      {/* Balance summary if fetched */}
                      {wd && !wd.loading && !wd.error && (
                        <div style={{ textAlign: 'right', marginRight: 8 }}>
                          <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                            {wd.balance?.toFixed(6)} {wd.chain}
                          </p>
                          {usdPrice > 0 && (
                            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>
                              ≈ ${(wd.balance * usdPrice).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                            </p>
                          )}
                        </div>
                      )}
                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {w.address && (
                          <button
                            onClick={() => isExpanded && wd ? setExpandedWallet(null) : fetchWalletData(w)}
                            disabled={wd?.loading}
                            style={{ fontSize: 11, background: 'var(--amber-light)', color: 'var(--amber)', borderColor: 'var(--amber)', padding: '4px 8px' }}>
                            {wd?.loading
                              ? <><i className="ti ti-loader-2 spin" aria-hidden="true" /> Fetching…</>
                              : isExpanded
                                ? <><i className="ti ti-chevron-up" aria-hidden="true" /> Hide</>
                                : <><i className="ti ti-refresh" aria-hidden="true" /> {wd ? 'Refresh' : 'Sync on-chain'}</>
                            }
                          </button>
                        )}
                        <button onClick={() => deleteWallet(w.id)}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '2px 4px' }}>
                          <i className="ti ti-trash" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {/* Address display */}
                    {w.address && (
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {w.address}
                        </span>
                        {wd?.chain && EXPLORER_ADDR[wd.chain] && (
                          <a href={EXPLORER_ADDR[wd.chain] + w.address} target="_blank" rel="noreferrer"
                            style={{ fontSize: 10, color: 'var(--blue)', textDecoration: 'none', flexShrink: 0 }}>
                            View on explorer <i className="ti ti-external-link" style={{ fontSize: 10 }} aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    )}
                    {w.notes && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>{w.notes}</p>}

                    {/* Expanded on-chain data */}
                    {isExpanded && wd && (
                      <div style={{ marginTop: 12, borderTop: '0.5px solid var(--border)', paddingTop: 12 }}>
                        {wd.error ? (
                          <p style={{ fontSize: 12, color: 'var(--coral)' }}>{wd.error}</p>
                        ) : (
                          <OnChainPanel data={wd} prices={prices} />
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
