'use strict';
/**
 * crypto.js — read-only crypto tax report endpoints (Phase 1).
 *
 * Mounted at /api/crypto AFTER the existing inline /api/crypto/transactions routes in index.js,
 * so it only adds NEW paths (/report, /report/download) and changes nothing the UI already uses.
 * The existing Crypto tab does NOT call these yet — this is the engine-parity surface we verify
 * against the Python reference before wiring any UI.
 *
 * It reads the same per-user `crypto_txns.json` the tab already writes, adapts those flat rows
 * into the cost-basis engine's transaction model, and returns Form 8949 / Schedule D / income /
 * portfolio figures. Fully offline (no price-server calls); market values are left null until a
 * later phase adds a hosted price source.
 *
 * NOT tax advice — every response carries a disclaimer for the user to confirm with a CPA.
 */

const express = require('express');
const engine = require('./crypto-engine');
const reports = require('./crypto-reports');

const { TxKind, D } = engine;

const METHODS = new Set(['fifo', 'lifo', 'hifo', 'specid']);
const POOLINGS = new Set(['universal', 'per_account']);
const DOWNLOADS = new Set(['form8949', 'schedule_d', 'income', 'gains', 'portfolio']);

// Offline price source: the flat rows already carry per-unit USD prices (folded into value_usd
// below), so historical lookups are rarely needed; current prices aren't available server-side.
const OFFLINE_PRICES = { historical: () => null, current: () => null, warnings: [] };

// ── Adapt a stored crypto_txns row into an engine transaction ────────
// The tab stores: { id, type, date, asset, quantity, pricePerUnit, fees, exchange, notes }.
// Mapping (cost basis = price*qty + fees, matching the tab's existing FIFO display):
//   buy          -> BUY            (USD -> crypto)
//   sell         -> SELL           (crypto -> USD)
//   receive      -> TRANSFER_IN    (deposit; basis = price*qty + fees)
//   transfer_in  -> TRANSFER_IN
//   send         -> TRANSFER_OUT   (withdrawal; fees not added to basis)
//   transfer_out -> TRANSFER_OUT
// receive/send map onto TRANSFER_* so the engine can recognize wallet-to-wallet self-transfers
// (a matched out+in pair is a non-taxable move, not a sale) — more correct than the tab's
// simple add/remove, and the one behavior difference worth flagging to the user.
function adaptRow(row) {
  const asset = (row.asset || '').trim().toUpperCase();
  const qty = D(row.quantity);
  if (!asset || qty <= 0 || !row.date) return null;
  const price = D(row.pricePerUnit);
  const fees = D(row.fees);
  const gross = qty * price;
  const account = row.exchange || '';
  const base = {
    id: row.id || `row_${Math.random().toString(36).slice(2)}`,
    timestamp: row.date,
    account,
    notes: row.notes || '',
    source: 'crypto_txns',
  };

  switch (row.type) {
    case 'buy':
      return engine.makeTx({
        ...base, kind: TxKind.BUY,
        recv_asset: asset, recv_amount: qty,
        send_asset: 'USD', send_amount: gross, send_value_usd: gross,
        fee_asset: 'USD', fee_amount: fees, fee_value_usd: fees,
      });
    case 'sell':
      return engine.makeTx({
        ...base, kind: TxKind.SELL,
        send_asset: asset, send_amount: qty,
        recv_asset: 'USD', recv_amount: gross, recv_value_usd: gross,
        fee_asset: 'USD', fee_amount: fees, fee_value_usd: fees,
      });
    case 'receive':
    case 'transfer_in':
      return engine.makeTx({
        ...base, kind: TxKind.TRANSFER_IN,
        recv_asset: asset, recv_amount: qty, recv_value_usd: gross + fees,
      });
    case 'send':
    case 'transfer_out':
      return engine.makeTx({
        ...base, kind: TxKind.TRANSFER_OUT,
        send_asset: asset, send_amount: qty,
      });
    default:
      return null;
  }
}

function parseYear(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const y = parseInt(raw, 10);
  if (isNaN(y) || y < 2000 || y > 2100) return null;
  return y;
}

function inYear(date, year) {
  return year === null || date.getUTCFullYear() === year;
}

// Run the engine over a user's stored transactions and slice to a year (or all-time).
function buildReport(uid, makeIO, { method, pooling, year }) {
  const io = makeIO(uid);
  const rows = io.read('crypto_txns.json') || [];
  const txns = [];
  for (const r of rows) {
    const t = adaptRow(r);
    if (t) txns.push(t);
  }

  const res = engine.run(txns, OFFLINE_PRICES, { method, pooling });
  const disposals = res.disposals.filter((d) => inYear(d.disposed_at, year));
  const income = res.income.filter((i) => inYear(i.received_at, year));
  const holdings = engine.portfolioBuild(res.pool, OFFLINE_PRICES);
  const label = year === null ? 'All years' : String(year);

  return { res, disposals, income, holdings, label };
}

module.exports = function (makeIO) {
  const router = express.Router();

  // ── GET /api/crypto/report?year=&method=&pooling= ──────────────────
  router.get('/report', (req, res) => {
    const method = METHODS.has(req.query.method) ? req.query.method : 'fifo';
    const pooling = POOLINGS.has(req.query.pooling) ? req.query.pooling : 'universal';
    const year = parseYear(req.query.year);

    const { res: result, disposals, income, holdings, label } =
      buildReport(req.user.id, makeIO, { method, pooling, year });

    const sd = reports.scheduleDTotals(disposals);
    res.json({
      year,
      method,
      pooling,
      summary: reports.buildSummary(label, disposals, income, result.warnings),
      form8949: reports.form8949Rows(disposals),
      scheduleD: {
        short_term: {
          proceeds: reports.money(sd.short_term.proceeds),
          cost_basis: reports.money(sd.short_term.cost_basis),
          gain: reports.money(sd.short_term.gain),
          count: sd.short_term.count,
        },
        long_term: {
          proceeds: reports.money(sd.long_term.proceeds),
          cost_basis: reports.money(sd.long_term.cost_basis),
          gain: reports.money(sd.long_term.gain),
          count: sd.long_term.count,
        },
        net_gain: reports.money(sd.net_gain),
      },
      income: {
        total: reports.money(reports.incomeTotal(income)),
        by_kind: Object.fromEntries(
          Object.entries(reports.incomeByKind(income)).map(([k, v]) => [k, reports.money(v)])
        ),
        rows: reports.incomeRows(income),
      },
      portfolio: reports.portfolioRows(holdings),
      warnings: result.warnings,
      unmatchedTransfers: result.unmatched_transfers.length,
      disclaimer: reports.DISCLAIMER,
    });
  });

  // ── GET /api/crypto/report/download?which=&year=&method=&pooling= ──
  router.get('/report/download', (req, res) => {
    const which = req.query.which;
    if (!DOWNLOADS.has(which)) {
      return res.status(400).json({ error: 'Invalid report. Use one of: ' + [...DOWNLOADS].join(', ') });
    }
    const method = METHODS.has(req.query.method) ? req.query.method : 'fifo';
    const pooling = POOLINGS.has(req.query.pooling) ? req.query.pooling : 'universal';
    const year = parseYear(req.query.year);

    const { disposals, income, holdings } =
      buildReport(req.user.id, makeIO, { method, pooling, year });

    let csv;
    if (which === 'form8949') csv = reports.toCsv(reports.FORM_8949_FIELDS, reports.form8949Rows(disposals));
    else if (which === 'schedule_d') csv = reports.toCsv(reports.SCHEDULE_D_FIELDS, reports.scheduleDRows(disposals));
    else if (which === 'income') csv = reports.toCsv(reports.INCOME_FIELDS, reports.incomeRows(income));
    else if (which === 'gains') csv = reports.toCsv(reports.GAIN_FIELDS, reports.gainsDetailRows(disposals));
    else csv = reports.toCsv(reports.PORTFOLIO_FIELDS, reports.portfolioRows(holdings));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="crypto-${which}-${year || 'all'}.csv"`);
    res.send(csv);
  });

  return router;
};
