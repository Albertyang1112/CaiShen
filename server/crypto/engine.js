'use strict';
/**
 * crypto/engine.js — FIFO/LIFO/HIFO cost-basis engine (run, acquire, dispose,
 * portfolioBuild, transfer matching). Pure date/decimal helpers, the tx/lot model,
 * and LotPool live in ./engine-lib; this file imports and re-exports them so the
 * public API (consumed by ./reports and tests/crypto.test.js) is unchanged.
 */
const {
  EPS, D, parseDt, isLeap, utcParts, addYears, cmpParts, isLongTerm, fmtDateISO, TxKind, INCOME_KINDS, ACQUIRE_KINDS, DISPOSE_KINDS, FIAT, USD_STABLECOINS, TRANSFER_WINDOW_HOURS, TRANSFER_AMOUNT_TOLERANCE, makeTx, makeLot, lotBasis, LotPool
} = require('./engine-lib');

function matchTransfers(txns, windowHours, tolerance) {
  const tol = D(tolerance);
  const matched = new Set();
  const pairs = {};
  const pair = (o, i) => {
    matched.add(o.id); matched.add(i.id);
    pairs[o.id] = i.id; pairs[i.id] = o.id;
  };

  // 1. explicit pairing via transfer_id
  const groups = new Map();
  for (const t of txns) {
    if (t.transfer_id) {
      if (!groups.has(t.transfer_id)) groups.set(t.transfer_id, []);
      groups.get(t.transfer_id).push(t);
    }
  }
  for (const group of groups.values()) {
    const outs = group.filter((t) => t.kind === TxKind.TRANSFER_OUT);
    const ins = group.filter((t) => t.kind === TxKind.TRANSFER_IN);
    const n = Math.min(outs.length, ins.length);
    for (let j = 0; j < n; j++) pair(outs[j], ins[j]);
  }

  // 2. heuristic pairing for the rest
  const windowSec = windowHours * 3600;
  const outs = txns.filter((t) => t.kind === TxKind.TRANSFER_OUT && !matched.has(t.id))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const ins = txns.filter((t) => t.kind === TxKind.TRANSFER_IN && !matched.has(t.id))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const used = new Set();
  for (const o of outs) {
    for (const i of ins) {
      if (used.has(i.id) || i.recv_asset !== o.send_asset) continue;
      if (Math.abs((i.timestamp.getTime() - o.timestamp.getTime()) / 1000) > windowSec) continue;
      if (o.send_amount <= 0) continue;
      if (Math.abs(o.send_amount - i.recv_amount) / o.send_amount <= tol) {
        pair(o, i);
        used.add(i.id);
        break;
      }
    }
  }
  return [matched, pairs];
}

// ── Options ──────────────────────────────────────────────────────────
function Options(o = {}) {
  return {
    method: o.method || 'fifo',
    unmatched_in_basis: o.unmatched_in_basis || 'zero',
    transfer_window_hours: o.transfer_window_hours != null ? o.transfer_window_hours : TRANSFER_WINDOW_HOURS,
    transfer_tolerance: o.transfer_tolerance != null ? o.transfer_tolerance : TRANSFER_AMOUNT_TOLERANCE,
    pooling: o.pooling || 'universal',
  };
}

// ── Pricing helpers ──────────────────────────────────────────────────
function grossUsd(value, asset, amount, prices, ts, warns, label) {
  if (value !== null && value !== undefined) return value;
  if (FIAT.has(asset)) return amount;
  const p = prices.historical(asset, ts);
  if (p === null || p === undefined) {
    warns.push(`${fmtDateISO(ts)} ${label}: no price for ${asset}; valued at $0 (set a manual price)`);
    return 0;
  }
  return amount * p;
}

function feeUsd(tx, prices) {
  if (tx.fee_value_usd !== null && tx.fee_value_usd !== undefined) return tx.fee_value_usd;
  if (!tx.fee_asset || tx.fee_amount === 0) return 0;
  if (FIAT.has(tx.fee_asset)) return tx.fee_amount;
  const p = prices.historical(tx.fee_asset, tx.timestamp);
  if (p === null || p === undefined) return 0;
  return tx.fee_amount * p;
}

// ── The engine ───────────────────────────────────────────────────────
function run(transactions, prices, options) {
  const opt = Options(options || {});
  const res = {
    disposals: [],
    income: [],
    pool: new LotPool(opt.method),
    warnings: [],
    unmatched_transfers: [],
  };
  const pool = res.pool;
  const warns = res.warnings;

  const [matched, pairs] = matchTransfers(transactions, opt.transfer_window_hours, opt.transfer_tolerance);
  const txns = transactions.slice().sort((a, b) => {
    const d = a.timestamp.getTime() - b.timestamp.getTime();
    if (d) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byId = {};
  for (const t of transactions) byId[t.id] = t;
  const handledMoves = new Set();
  const perAccount = opt.pooling === 'per_account';

  for (const tx of txns) {
    const k = tx.kind;
    const dispAccount = perAccount ? tx.account : null;

    // ---- acquisitions ----
    if (k === TxKind.BUY) {
      const cost = grossUsd(tx.send_value_usd, tx.send_asset, tx.send_amount, prices, tx.timestamp, warns, 'buy cost');
      const fee = feeUsd(tx, prices);
      acquire(pool, tx.recv_asset, tx.recv_amount, cost + fee, tx, 'buy', false);

    } else if (INCOME_KINDS.has(k)) {
      const value = grossUsd(tx.recv_value_usd, tx.recv_asset, tx.recv_amount, prices, tx.timestamp, warns, `${k} income`);
      res.income.push({
        asset: tx.recv_asset, amount: tx.recv_amount, value_usd: value,
        received_at: tx.timestamp, kind: k, account: tx.account,
        tx_id: tx.id, note: tx.notes,
      });
      acquire(pool, tx.recv_asset, tx.recv_amount, value, tx, k, true);

    } else if (k === TxKind.TRADE) {
      let fmv = tx.send_value_usd;
      if (fmv === null || fmv === undefined) fmv = tx.recv_value_usd;
      if (fmv === null || fmv === undefined) {
        fmv = grossUsd(null, tx.send_asset, tx.send_amount, prices, tx.timestamp, warns, 'trade value');
      }
      const fee = feeUsd(tx, prices);
      dispose(pool, tx.send_asset, tx.send_amount, fmv, tx, opt, res, false, dispAccount, '', '');
      acquire(pool, tx.recv_asset, tx.recv_amount, fmv + fee, tx, 'trade', false);

    } else if (k === TxKind.GIFT_RECEIVED) {
      const basis = tx.recv_value_usd !== null && tx.recv_value_usd !== undefined ? tx.recv_value_usd : 0;
      if (tx.recv_value_usd === null || tx.recv_value_usd === undefined) {
        warns.push(`${fmtDateISO(tx.timestamp)} gift received ${tx.recv_asset}: unknown donor basis -> used $0 (set recv_value_usd)`);
      }
      acquire(pool, tx.recv_asset, tx.recv_amount, basis, tx, 'gift', false);

    } else if (k === TxKind.RECOVERY) {
      if (tx.recv_asset && !FIAT.has(tx.recv_asset)) {
        const value = grossUsd(tx.recv_value_usd, tx.recv_asset, tx.recv_amount, prices, tx.timestamp, warns, 'recovery');
        acquire(pool, tx.recv_asset, tx.recv_amount, value, tx, 'recovery', false);
        warns.push(`${fmtDateISO(tx.timestamp)} bankruptcy recovery of ${fmtQty(tx.recv_amount)} ${tx.recv_asset}: basis set to FMV $${value.toFixed(2)} — confirm treatment with a CPA`);
      } else {
        warns.push(`${fmtDateISO(tx.timestamp)} cash recovery $${fmtQty(tx.recv_amount)}: recorded as a note only; pair it against your written-off lots manually (confirm with a CPA)`);
      }

    // ---- disposals ----
    } else if (k === TxKind.SELL) {
      const gross = grossUsd(tx.recv_value_usd, tx.recv_asset, tx.recv_amount, prices, tx.timestamp, warns, 'sale proceeds');
      const fee = feeUsd(tx, prices);
      dispose(pool, tx.send_asset, tx.send_amount, gross - fee, tx, opt, res, false, dispAccount, '', '');

    } else if (k === TxKind.SPEND) {
      const gross = grossUsd(tx.send_value_usd, tx.send_asset, tx.send_amount, prices, tx.timestamp, warns, 'spend value');
      const fee = feeUsd(tx, prices);
      dispose(pool, tx.send_asset, tx.send_amount, gross - fee, tx, opt, res, false, dispAccount, '', '');

    } else if (k === TxKind.WRITE_OFF) {
      dispose(pool, tx.send_asset, tx.send_amount, 0, tx, opt, res, true, tx.account || null, '', 'write-off/abandonment — confirm with CPA');
      warns.push(`${fmtDateISO(tx.timestamp)} write-off of ${fmtQty(tx.send_amount)} ${tx.send_asset}: realized as a capital loss (proceeds $0) — confirm treatment & timing with a CPA`);

    } else if (k === TxKind.LOST) {
      const [, short] = pool.consume(tx.send_asset, tx.send_amount, null, true, tx.account || null);
      if (short > 0) warns.push(`${fmtDateISO(tx.timestamp)} lost ${tx.send_asset}: ${fmtQty(short)} more than on record`);
      warns.push(`${fmtDateISO(tx.timestamp)} lost ${fmtQty(tx.send_amount)} ${tx.send_asset}: removed with NO deductible loss (personal theft/casualty losses generally nondeductible 2018-2025) — confirm with a CPA`);

    } else if (k === TxKind.GIFT_SENT) {
      const [, short] = pool.consume(tx.send_asset, tx.send_amount);
      if (short > 0) warns.push(`${fmtDateISO(tx.timestamp)} gift sent ${tx.send_asset}: ${fmtQty(short)} more than on record`);
      warns.push(`${fmtDateISO(tx.timestamp)} gift sent ${fmtQty(tx.send_amount)} ${tx.send_asset}: no gain/loss; if over the annual exclusion you may owe a gift-tax filing (Form 709)`);

    } else if (k === TxKind.FROZEN) {
      const asset = tx.send_asset || tx.recv_asset;
      const amount = tx.send_amount || tx.recv_amount;
      const [frozen, notEnough] = pool.freeze(asset, amount, tx.account);
      warns.push(`${fmtDateISO(tx.timestamp)} froze ${fmtQty(frozen)} ${asset} (locked on a defunct platform); excluded from sales until written off/recovered`);
      if (notEnough > 0) warns.push(`  (couldn't freeze ${fmtQty(notEnough)}: more than on record)`);

    // ---- transfers ----
    } else if (k === TxKind.TRANSFER_IN || k === TxKind.TRANSFER_OUT) {
      if (matched.has(tx.id)) {
        if (perAccount && !handledMoves.has(tx.id)) {
          const partner = byId[pairs[tx.id]];
          if (partner) {
            const outTx = k === TxKind.TRANSFER_OUT ? tx : partner;
            const inTx = k === TxKind.TRANSFER_OUT ? partner : tx;
            moveLots(pool, outTx.send_asset, outTx.send_amount, outTx.account, inTx.account, tx, res);
            handledMoves.add(outTx.id);
            handledMoves.add(inTx.id);
          }
        }
        continue;
      }
      res.unmatched_transfers.push(tx);
      if (k === TxKind.TRANSFER_IN) {
        let basis;
        if (opt.unmatched_in_basis === 'fmv') {
          basis = grossUsd(tx.recv_value_usd, tx.recv_asset, tx.recv_amount, prices, tx.timestamp, warns, 'transfer-in basis');
        } else {
          basis = tx.recv_value_usd !== null && tx.recv_value_usd !== undefined ? tx.recv_value_usd : 0;
        }
        acquire(pool, tx.recv_asset, tx.recv_amount, basis, tx, 'transfer_in', false);
        warns.push(`${fmtDateISO(tx.timestamp)} unmatched deposit ${fmtQty(tx.recv_amount)} ${tx.recv_asset}: basis $${basis.toFixed(2)} (${opt.unmatched_in_basis}); set a real basis or import the source wallet`);
      } else {
        warns.push(`${fmtDateISO(tx.timestamp)} unmatched withdrawal ${fmtQty(tx.send_amount)} ${tx.send_asset}: left in holdings as a move to an un-imported wallet; if it was a sale/gift, reclassify`);
      }

    } else if (k === TxKind.FEE) {
      const fee = feeUsd(tx, prices);
      if (fee) warns.push(`${fmtDateISO(tx.timestamp)} standalone fee $${fee.toFixed(2)} not attached to a trade; ignored for basis`);
    }
  }

  if (Array.isArray(prices.warnings)) res.warnings.push(...prices.warnings);
  return res;
}

function acquire(pool, asset, amount, totalBasis, tx, kind = 'buy', isIncome = false) {
  if (!asset || amount <= 0) return;
  const unit = amount ? totalBasis / amount : 0;
  pool.add(makeLot({
    asset, amount, unit_basis: unit, acquired_at: tx.timestamp,
    account: tx.account, lot_id: tx.lot_id || '', source_tx_id: tx.id,
    kind, is_income: isIncome, note: tx.notes,
  }));
}

// Per-account pooling: a matched self-transfer relocates specific lots (basis + acquisition
// date intact, so the holding period keeps running) from one account's pool to another.
function moveLots(pool, asset, amount, fromAccount, toAccount, tx, res) {
  if (!asset || amount <= 0) return;
  const [slices, short] = pool.consume(asset, amount, null, false, fromAccount);
  for (const [taken, lot] of slices) {
    pool.add(makeLot({
      asset, amount: taken, unit_basis: lot.unit_basis,
      acquired_at: lot.acquired_at, account: toAccount || '',
      lot_id: lot.lot_id, source_tx_id: lot.source_tx_id,
      kind: lot.kind, is_income: lot.is_income, frozen: false, note: lot.note,
    }));
  }
  if (short > 0) {
    pool.add(makeLot({
      asset, amount: short, unit_basis: 0, acquired_at: tx.timestamp,
      account: toAccount || '', kind: 'transfer_in', note: 'moved with missing basis',
    }));
    res.warnings.push(`${fmtDateISO(tx.timestamp)} self-transfer of ${fmtQty(amount)} ${asset} '${fromAccount || '?'}' -> '${toAccount || '?'}': ${fmtQty(short)} had no basis on record in the source account; moved at $0 basis (import that account's history). Confirm with a CPA.`);
  }
}

function dispose(pool, asset, amount, netProceeds, tx, opt, res, includeFrozen = false, account = null, code = '', note = '') {
  if (!asset || amount <= 0) return;
  const [slices, short] = pool.consume(asset, amount, tx.lot_id || null, includeFrozen, account);
  if (short > 0) {
    slices.push([short, makeLot({
      asset, amount: 0, unit_basis: 0, acquired_at: tx.timestamp,
      account: tx.account, kind: 'missing-basis', note: 'missing basis',
    })]);
    res.warnings.push(`${fmtDateISO(tx.timestamp)} sold ${fmtQty(short)} ${asset} with no acquisition on record: basis $0 (add the missing buy/transfer)`);
  }
  for (const [taken, lot] of slices) {
    const frac = amount ? taken / amount : 0;
    const proceeds = netProceeds * frac;
    const basis = taken * lot.unit_basis;
    const term = isLongTerm(lot.acquired_at, tx.timestamp) ? 'long' : 'short';
    res.disposals.push({
      asset, amount: taken, proceeds, cost_basis: basis,
      acquired_at: lot.acquired_at, disposed_at: tx.timestamp, method: opt.method,
      account: tx.account, disposal_tx_id: tx.id, lot_id: lot.lot_id, term,
      code, note: note || lot.note,
      gain: proceeds - basis,
    });
  }
}

// ── Portfolio: holdings + unrealized P&L from open lots ──────────────
function portfolioBuild(pool, prices) {
  const byAsset = new Map();
  for (const lot of pool.openLots()) {
    if (!byAsset.has(lot.asset)) byAsset.set(lot.asset, []);
    byAsset.get(lot.asset).push(lot);
  }
  const holdings = [];
  for (const [asset, lots] of byAsset) {
    let amount = 0, basis = 0, frozen = 0;
    for (const l of lots) {
      amount += l.amount;
      basis += lotBasis(l);
      if (l.frozen) frozen += l.amount;
    }
    const price = prices.current(asset);
    const hasPrice = price !== null && price !== undefined;
    const mv = hasPrice ? amount * price : null;
    const unreal = mv !== null ? mv - basis : null;
    holdings.push({
      asset, amount, cost_basis: basis, frozen_amount: frozen,
      price: hasPrice ? price : null, market_value: mv, unrealized: unreal,
      unit_cost: amount ? basis / amount : 0,
    });
  }
  holdings.sort((a, b) => (b.market_value || 0) - (a.market_value || 0));
  return holdings;
}

// ── Quantity formatting (no scientific notation / trailing-zero noise) ──
function fmtQty(x) {
  if (x === null || x === undefined || x === '') return '';
  let n = Number(x);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0';
  // Clear binary-float noise (a true 0.4 is stored as 0.4000000000000000222…)
  // by formatting to 15 significant digits — below the ~16-digit double-precision
  // floor — then strip trailing zeros (and a bare decimal point). Re-converting to
  // Number and using toFixed would reintroduce the noise, so render from the string.
  let s = n.toPrecision(15);
  if (/[eE]/.test(s)) s = Number(s).toFixed(18); // expand the rare exponent form
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

module.exports = {
  EPS,
  D,
  parseDt,
  isLeap,
  addYears,
  utcParts,
  isLongTerm,
  fmtDateISO,
  fmtQty,
  TxKind,
  INCOME_KINDS,
  ACQUIRE_KINDS,
  DISPOSE_KINDS,
  FIAT,
  USD_STABLECOINS,
  TRANSFER_WINDOW_HOURS,
  TRANSFER_AMOUNT_TOLERANCE,
  makeTx,
  makeLot,
  lotBasis,
  LotPool,
  matchTransfers,
  Options,
  run,
  portfolioBuild,
};
