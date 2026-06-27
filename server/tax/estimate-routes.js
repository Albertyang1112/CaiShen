'use strict';
/**
 * tax/estimate-routes.js — extracted from index.js. GET /api/tax-estimate estimates income
 * fields (W-2 / Schedule E / capital gains) from Plaid transactions, vault PDF stats, and a
 * crypto FIFO pass. Mounted at /api. Faithful move: readData(file, uid) → makeIO(uid).read(file).
 */
const express = require('express');

// FIFO crypto gain computation (mirrors Crypto.jsx).
function computeCryptoGainsByYear(txns, targetYear) {
  const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));
  const lots = {}; // asset -> [{date, qty, costPerUnit}]
  let stGains = 0, ltGains = 0, stCount = 0, ltCount = 0;
  for (const tx of sorted) {
    const asset = (tx.asset || '').toUpperCase();
    if (!asset) continue;
    if (!lots[asset]) lots[asset] = [];
    const qty   = parseFloat(tx.quantity)    || 0;
    const price = parseFloat(tx.pricePerUnit) || 0;
    const fees  = parseFloat(tx.fees)         || 0;
    if (tx.type === 'buy' || tx.type === 'receive' || tx.type === 'transfer_in') {
      if (qty > 0) lots[asset].push({ date: tx.date, qty, costPerUnit: price + (qty > 0 ? fees / qty : 0) });
    } else if (tx.type === 'sell') {
      const txYear = (tx.date || '').slice(0, 4);
      let remaining = qty;
      while (remaining > 1e-9 && lots[asset]?.length > 0) {
        const lot  = lots[asset][0];
        const used = Math.min(lot.qty, remaining);
        const gain = used * price - used * lot.costPerUnit - (remaining === qty ? fees : 0);
        const days = (new Date(tx.date) - new Date(lot.date)) / 86400000;
        if (txYear === targetYear) {
          if (days >= 365) { ltGains += gain; ltCount++; }
          else             { stGains += gain; stCount++; }
        }
        lot.qty   -= used;
        remaining -= used;
        if (lot.qty < 1e-9) lots[asset].shift();
      }
    }
  }
  return { stGains: Math.round(stGains * 100) / 100, ltGains: Math.round(ltGains * 100) / 100, stCount, ltCount };
}

module.exports = function makeTaxEstimateRoutes(makeIO) {
  const router = express.Router();

  // GET /api/tax-estimate?year=YYYY
  router.get('/tax-estimate', (req, res) => {
    const io         = makeIO(req.user.id);
    const targetYear = (req.query.year || (new Date().getFullYear() - 1)).toString();

    const transactions = io.read('transactions.json') || [];
    const cryptoTxns   = io.read('crypto_txns.json')  || [];
    const vault        = io.read('vault.json')         || { files: [] };

    const yearTxs   = transactions.filter(t => (t.month || '').startsWith(targetYear));
    const incomeTxs = yearTxs.filter(t => t.amount > 0 && t.category === 'Income');

    // ── W-2: payroll-like Plaid income transactions ───────────────────
    const PAYROLL_KW = ['payroll', 'paycheck', 'direct dep', 'adp', 'paychex', 'gusto', 'salary', 'wages', 'employer'];
    const w2Txs  = incomeTxs.filter(t => PAYROLL_KW.some(kw => (t.desc || '').toLowerCase().includes(kw)));
    const w2Total = Math.round(w2Txs.reduce((s, t) => s + t.amount, 0) * 100) / 100;

    // ── Schedule E: vault property statement stats (property-tagged folders) ─
    const properties = io.read('properties.json') || [];
    const propNames  = properties.map(p => String(p.name || '').toLowerCase()).filter(Boolean);
    const PROP_IDS   = [...properties.map(p => String(p.id)), ...propNames];
    const propFiles = (vault.files || []).filter(f =>
      f.tags?.year === targetYear &&
      f.tags?.income !== undefined &&
      PROP_IDS.some(p => f.tags?.property === p || (f.folderPath || '').toLowerCase().includes(p))
    );
    const reGross    = propFiles.reduce((s, f) => s + (f.tags.income   || 0), 0);
    const reExpenses = propFiles.reduce((s, f) => s + Math.abs(f.tags.spending || 0), 0);
    const reNet      = Math.round((reGross - reExpenses) * 100) / 100;

    // ── Schedule E fallback: rent deposits in Plaid transactions ─────
    const RENTAL_KW  = ['rent', 'rental', 'lease', ...propNames];
    const rentalTxs  = incomeTxs.filter(t =>
      !w2Txs.includes(t) &&
      RENTAL_KW.some(kw => (t.desc || '').toLowerCase().includes(kw))
    );
    const rentalTotal = Math.round(rentalTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100;

    const reEstimate   = propFiles.length > 0 ? reNet : rentalTotal;
    const reSource     = propFiles.length > 0
      ? `${propFiles.length} property statement PDF${propFiles.length !== 1 ? 's' : ''} in vault`
      : rentalTxs.length > 0
        ? `${rentalTxs.length} rent deposit${rentalTxs.length !== 1 ? 's' : ''} via Plaid`
        : null;
    const reConfidence = propFiles.length > 0 ? 'medium' : rentalTxs.length > 0 ? 'low' : 'none';

    // ── Capital gains: crypto FIFO ────────────────────────────────────
    const { stGains, ltGains, stCount, ltCount } = computeCryptoGainsByYear(cryptoTxns, targetYear);
    const totalCapGains = Math.round((stGains + ltGains) * 100) / 100;

    res.json({
      year: targetYear,
      estimates: {
        w2: {
          value:    w2Total,
          txCount:  w2Txs.length,
          source:   'Plaid payroll deposits',
          confidence: w2Txs.length > 0 ? 'medium' : 'none',
        },
        capitalGains: {
          value:    totalCapGains,
          stGains,  ltGains,
          txCount:  stCount + ltCount,
          source:   'Crypto FIFO (exact)',
          confidence: (stCount + ltCount) > 0 ? 'high' : 'none',
        },
        scheduleEIncome: {
          value:      reEstimate,
          gross:      propFiles.length > 0 ? Math.round(reGross * 100) / 100 : rentalTotal,
          expenses:   propFiles.length > 0 ? Math.round(reExpenses * 100) / 100 : 0,
          statements: propFiles.length,
          txCount:    rentalTxs.length,
          source:     reSource || 'No rental data found',
          confidence: reConfidence,
        },
      },
    });
  });

  return router;
};

module.exports.computeCryptoGainsByYear = computeCryptoGainsByYear;
