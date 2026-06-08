'use strict';
/**
 * crypto-engine.js — cost-basis tax engine (JS port of the Python `cryptotax` engine).
 *
 * Faithful reimplementation of cryptotax/models.py + engine/{costbasis,ledger,process,portfolio}.py.
 * The Python unittest suite (tests/test_cryptotax.py) is the parity oracle; the Jest
 * suite in server/tests/crypto.test.js reproduces those assertions against this module.
 *
 * Money is a JS Number here (the website already uses Numbers for crypto math) rather than a
 * Decimal type — no new dependency. Values are rounded to cents only at report boundaries
 * (see crypto-reports.js `money()`), and parity tests compare cent-rounded figures.
 *
 * NOT tax advice. The frozen / write-off / lost / recovery handling encodes *a* defensible
 * treatment, flagged for the user to confirm with a CPA.
 */

// Float residue guard: lot/disposal quantities are snapped to 0 below this.
// 1e-9 of any coin is sub-dust, so this never discards a meaningful amount.
const EPS = 1e-9;

// ── Money / quantity parsing ─────────────────────────────────────────
// Parse anything money-ish into a Number. Blank/null/garbage -> 0.
function D(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = String(value).trim().replace(/,/g, '').replace(/\$/g, '');
  if (s === '') return 0;
  const low = s.toLowerCase();
  if (low === 'nan' || low === 'none' || low === 'null') return 0;
  // Parenthesised negatives, e.g. "(1.23)" -> "-1.23"
  if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ── Timestamp parsing — ALWAYS yields a UTC Date ─────────────────────
// JS parses "YYYY-MM-DD HH:MM:SS" and "...T..." without a zone as *local* time, which would
// make holding-period math machine-dependent. We parse components explicitly into UTC.
function parseDt(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) throw new Error('invalid Date');
    return value;
  }
  const s = String(value).trim();
  if (s === '') throw new Error('empty timestamp');

  // epoch seconds
  if (/^\d{9,}$/.test(s)) return new Date(parseInt(s, 10) * 1000);

  // explicit zone (Z or ±HH:MM / ±HHMM) — native parse is unambiguous
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    if (!isNaN(d.getTime())) return d;
  }

  let m;
  // YYYY-MM-DD[ T]HH:MM[:SS]
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/))) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  }
  // YYYY/MM/DD HH:MM:SS
  if ((m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/))) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  }
  // M/D/YYYY [HH:MM[:SS]]
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/))) {
    return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  }
  // DD-MM-YYYY HH:MM:SS
  if ((m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/))) {
    return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)));
  }
  // date-only YYYY-MM-DD (native parses this as UTC midnight, but be explicit)
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }

  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t);
  throw new Error('unrecognized timestamp: ' + value);
}

// UTC date helpers (holding period works on calendar dates, never on wall-clock time)
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

function utcParts(d) {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// Add calendar years, clamping Feb 29 -> Feb 28 when the target year isn't a leap year.
function addYears(parts, years) {
  const y = parts.y + years;
  let day = parts.d;
  if (parts.m === 2 && parts.d === 29 && !isLeap(y)) day = 28;
  return { y, m: parts.m, d: day };
}

function cmpParts(a, b) {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

// US rule: long-term if held MORE than one year. Buy 1/1, sell next-year 1/1 -> short; +1 day -> long.
function isLongTerm(acquired, disposed) {
  return cmpParts(utcParts(disposed), addYears(utcParts(acquired), 1)) > 0;
}

// ISO date (YYYY-MM-DD) in UTC, for warning text (mirrors Python `ts.date()`).
function fmtDateISO(d) {
  const p = utcParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ── Transaction kinds ────────────────────────────────────────────────
const TxKind = Object.freeze({
  BUY: 'buy',
  SELL: 'sell',
  TRADE: 'trade',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
  SPEND: 'spend',
  STAKING: 'staking',
  MINING: 'mining',
  INTEREST: 'interest',
  REWARD: 'reward',
  AIRDROP: 'airdrop',
  FORK: 'fork',
  GIFT_RECEIVED: 'gift_received',
  GIFT_SENT: 'gift_sent',
  FROZEN: 'frozen',
  RECOVERY: 'recovery',
  WRITE_OFF: 'write_off',
  LOST: 'lost',
  FEE: 'fee',
});

const INCOME_KINDS = new Set([
  TxKind.STAKING, TxKind.MINING, TxKind.INTEREST,
  TxKind.REWARD, TxKind.AIRDROP, TxKind.FORK,
]);
const ACQUIRE_KINDS = new Set([
  TxKind.BUY, TxKind.TRANSFER_IN, TxKind.GIFT_RECEIVED, TxKind.RECOVERY,
  ...INCOME_KINDS,
]);
const DISPOSE_KINDS = new Set([
  TxKind.SELL, TxKind.SPEND, TxKind.TRANSFER_OUT,
  TxKind.GIFT_SENT, TxKind.WRITE_OFF, TxKind.LOST,
]);

const FIAT = new Set(['USD']);
const USD_STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'GUSD', 'BUSD', 'USDP', 'PYUSD', 'TUSD']);

const TRANSFER_WINDOW_HOURS = 36;
const TRANSFER_AMOUNT_TOLERANCE = '0.02'; // 2%

// ── Transaction factory (mirrors Transaction.__post_init__) ──────────
// `*_value_usd` stay null when not supplied (the engine distinguishes "unknown" from "$0").
function makeTx(o) {
  const up = (a) => (a ? String(a).trim().toUpperCase() : a == null ? null : a);
  const v = (x) => (x === undefined || x === null ? null : D(x));
  return {
    id: o.id,
    timestamp: parseDt(o.timestamp),
    kind: o.kind,
    account: o.account || '',
    recv_asset: o.recv_asset != null ? up(o.recv_asset) : null,
    recv_amount: D(o.recv_amount),
    send_asset: o.send_asset != null ? up(o.send_asset) : null,
    send_amount: D(o.send_amount),
    fee_asset: o.fee_asset != null ? up(o.fee_asset) : null,
    fee_amount: D(o.fee_amount),
    recv_value_usd: v(o.recv_value_usd),
    send_value_usd: v(o.send_value_usd),
    fee_value_usd: v(o.fee_value_usd),
    txhash: o.txhash || null,
    transfer_id: o.transfer_id || null,
    lot_id: o.lot_id || null,
    notes: o.notes || '',
    source: o.source || '',
  };
}

function makeLot(o) {
  return {
    asset: o.asset,
    amount: o.amount,
    unit_basis: o.unit_basis,
    acquired_at: o.acquired_at,
    account: o.account || '',
    lot_id: o.lot_id || '',
    source_tx_id: o.source_tx_id || '',
    kind: o.kind || 'buy',
    is_income: !!o.is_income,
    frozen: !!o.frozen,
    note: o.note || '',
  };
}

function lotBasis(lot) { return lot.amount * lot.unit_basis; }

// ── LotPool: open acquisition lots per asset, consumed by disposals ──
class LotPool {
  constructor(method = 'fifo') {
    this.method = String(method).toLowerCase();
    this.lots = new Map(); // asset -> Lot[]
  }

  _bucket(asset) {
    let b = this.lots.get(asset);
    if (!b) { b = []; this.lots.set(asset, b); }
    return b;
  }

  add(lot) {
    if (lot.amount > 0) this._bucket(lot.asset).push(lot);
  }

  total(asset, includeFrozen = false) {
    const b = this.lots.get(asset) || [];
    let s = 0;
    for (const l of b) if (includeFrozen || !l.frozen) s += l.amount;
    return s;
  }

  holdings(includeFrozen = true) {
    const out = {};
    for (const [asset, lots] of this.lots) {
      let amt = 0;
      for (const l of lots) if (includeFrozen || !l.frozen) amt += l.amount;
      if (amt > 0) out[asset] = amt;
    }
    return out;
  }

  *openLots() {
    for (const lots of this.lots.values()) {
      for (const l of lots) if (l.amount > 0) yield l;
    }
  }

  _order(asset, lotId = null, includeFrozen = false, account = null) {
    const lots = (this.lots.get(asset) || []).filter(
      (l) => l.amount > 0 && (includeFrozen || !l.frozen) &&
             (account === null || l.account === account)
    );
    const m = this.method;
    if (m === 'lifo') {
      lots.sort((a, b) => b.acquired_at.getTime() - a.acquired_at.getTime());
    } else if (m === 'hifo') {
      lots.sort((a, b) => b.unit_basis - a.unit_basis);
    } else if (m === 'specid' && lotId) {
      const chosen = lots.filter((l) => l.lot_id === lotId);
      const rest = lots.filter((l) => l.lot_id !== lotId)
        .sort((a, b) => a.acquired_at.getTime() - b.acquired_at.getTime());
      return chosen.concat(rest);
    } else { // fifo (and specid with no lot_id)
      lots.sort((a, b) => a.acquired_at.getTime() - b.acquired_at.getTime());
    }
    return lots;
  }

  // Take `amount` of `asset` from open lots in method order.
  // Returns [slices, shortfall] where slices is [[takenAmount, lot], ...].
  consume(asset, amount, lotId = null, includeFrozen = false, account = null) {
    const order = this._order(asset, lotId, includeFrozen, account);
    const slices = [];
    let remaining = amount;
    for (const lot of order) {
      if (remaining <= EPS) break;
      const take = lot.amount < remaining ? lot.amount : remaining;
      slices.push([take, lot]);
      lot.amount -= take;
      if (Math.abs(lot.amount) < EPS) lot.amount = 0;
      remaining -= take;
      if (Math.abs(remaining) < EPS) remaining = 0;
    }
    return [slices, remaining > EPS ? remaining : 0];
  }

  // Mark `amount` of `asset` (on `account`) as frozen, splitting a lot if needed.
  freeze(asset, amount, account = null) {
    const order = this._order(asset, null, false, account);
    let remaining = amount;
    let frozen = 0;
    for (const lot of order) {
      if (remaining <= EPS) break;
      const take = lot.amount < remaining ? lot.amount : remaining;
      if (take >= lot.amount - EPS) {
        lot.frozen = true;
      } else {
        lot.amount -= take;
        if (Math.abs(lot.amount) < EPS) lot.amount = 0;
        this._bucket(asset).push(makeLot({
          asset, amount: take, unit_basis: lot.unit_basis,
          acquired_at: lot.acquired_at, account: account || lot.account,
          lot_id: lot.lot_id, source_tx_id: lot.source_tx_id, kind: lot.kind,
          is_income: lot.is_income, frozen: true, note: 'frozen',
        }));
      }
      remaining -= take;
      if (Math.abs(remaining) < EPS) remaining = 0;
      frozen += take;
    }
    return [frozen, remaining > EPS ? remaining : 0];
  }
}


// ── Exports ──────────────────────────────────────────────────────────
module.exports = { EPS, D, parseDt, isLeap, utcParts, addYears, cmpParts, isLongTerm, fmtDateISO, TxKind, INCOME_KINDS, ACQUIRE_KINDS, DISPOSE_KINDS, FIAT, USD_STABLECOINS, TRANSFER_WINDOW_HOURS, TRANSFER_AMOUNT_TOLERANCE, makeTx, makeLot, lotBasis, LotPool };
