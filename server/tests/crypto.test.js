'use strict';
/**
 * crypto.test.js — parity tests for the JS cost-basis engine (server/crypto-engine.js).
 *
 * These mirror the Python reference suite (crypto-tax-tool/tests/test_cryptotax.py) assertion
 * for assertion, plus an end-to-end run over the documented sample data that reproduces the
 * README yearly table and the $15,888 portfolio cost basis. Money is compared at cent precision.
 */

const engine = require('../crypto-engine');
const reports = require('../crypto-reports');

const { TxKind, D, parseDt, isLongTerm, addYears, utcParts, LotPool, makeLot } = engine;

// Deterministic, offline price source (mirrors the Python FakePrices).
class FakePrices {
  constructor(flat = {}, dated = {}) {
    this.flat = {};
    for (const [k, v] of Object.entries(flat)) this.flat[k.toUpperCase()] = D(v);
    this.dated = {};
    for (const [k, m] of Object.entries(dated)) {
      this.dated[k.toUpperCase()] = {};
      for (const [d, v] of Object.entries(m)) this.dated[k.toUpperCase()][d] = D(v);
    }
    this.warnings = [];
  }
  historical(asset, when) {
    const a = (asset || '').toUpperCase();
    if (a === 'USD') return 1;
    const key = engine.fmtDateISO(when);
    if (this.dated[a] && this.dated[a][key] !== undefined) return this.dated[a][key];
    return this.flat[a] !== undefined ? this.flat[a] : null;
  }
  current(asset) {
    const a = (asset || '').toUpperCase();
    if (a === 'USD') return 1;
    return this.flat[a] !== undefined ? this.flat[a] : null;
  }
}

const dt = (s) => parseDt(s);
const tx = (id, kind, when, kw = {}) => engine.makeTx({ id, kind, timestamp: when, ...kw });
const run = (txns, prices, opt = {}) => engine.run(txns, prices || new FakePrices(), opt);
// money rounded to cents, as a Number, for exact comparison
const m = (x) => Number(reports.money(x));

// --------------------------------------------------------------------- //
// date / holding-period rules
// --------------------------------------------------------------------- //
describe('holding period', () => {
  test('exactly one year is short', () => {
    expect(isLongTerm(dt('2022-01-01'), dt('2023-01-01'))).toBe(false);
  });
  test('one year plus a day is long', () => {
    expect(isLongTerm(dt('2022-01-01'), dt('2023-01-02'))).toBe(true);
  });
  test('leap-day acquisition clamps to Feb 28', () => {
    const p = addYears(utcParts(dt('2020-02-29')), 1);
    expect([p.y, p.m, p.d]).toEqual([2021, 2, 28]);
    expect(isLongTerm(dt('2020-02-29'), dt('2021-03-01'))).toBe(true);
  });
});

// --------------------------------------------------------------------- //
// lot selection methods
// --------------------------------------------------------------------- //
describe('lot methods', () => {
  const pool = (method) => {
    const p = new LotPool(method);
    p.add(makeLot({ asset: 'BTC', amount: 1, unit_basis: 100, acquired_at: dt('2021-01-01') }));
    p.add(makeLot({ asset: 'BTC', amount: 1, unit_basis: 300, acquired_at: dt('2021-02-01') }));
    p.add(makeLot({ asset: 'BTC', amount: 1, unit_basis: 200, acquired_at: dt('2021-03-01') }));
    return p;
  };
  test('fifo takes earliest', () => {
    const [slices, short] = pool('fifo').consume('BTC', 1);
    expect(short).toBe(0);
    expect(slices[0][1].unit_basis).toBe(100);
  });
  test('lifo takes latest', () => {
    const [slices] = pool('lifo').consume('BTC', 1);
    expect(slices[0][1].unit_basis).toBe(200);
  });
  test('hifo takes highest cost', () => {
    const [slices] = pool('hifo').consume('BTC', 1);
    expect(slices[0][1].unit_basis).toBe(300);
  });
  test('specid takes the named lot first', () => {
    const p = new LotPool('specid');
    p.add(makeLot({ asset: 'BTC', amount: 1, unit_basis: 100, acquired_at: dt('2021-01-01'), lot_id: 'A' }));
    p.add(makeLot({ asset: 'BTC', amount: 1, unit_basis: 300, acquired_at: dt('2021-02-01'), lot_id: 'B' }));
    const [slices] = p.consume('BTC', 1, 'B');
    expect(slices[0][1].unit_basis).toBe(300);
  });
  test('shortfall reported', () => {
    const [, short] = pool('fifo').consume('BTC', 10);
    expect(short).toBeCloseTo(7, 9);
  });
});

// --------------------------------------------------------------------- //
// buy / sell with fees
// --------------------------------------------------------------------- //
describe('buy/sell', () => {
  test('fee folds into basis and reduces proceeds', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000, fee_asset: 'USD', fee_amount: 100, fee_value_usd: 100 }),
      tx('s', TxKind.SELL, '2023-06-01', { send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 20000, recv_value_usd: 20000, fee_asset: 'USD', fee_amount: 200, fee_value_usd: 200 }),
    ];
    const res = run(txns);
    expect(res.disposals.length).toBe(1);
    const d = res.disposals[0];
    expect(m(d.cost_basis)).toBe(10100);
    expect(m(d.proceeds)).toBe(19800);
    expect(m(d.gain)).toBe(9700);
    expect(d.term).toBe('long');
  });
  test('short-term classification', () => {
    const txns = [
      tx('b', TxKind.BUY, '2023-01-01', { recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 1000, send_value_usd: 1000 }),
      tx('s', TxKind.SELL, '2023-06-01', { send_asset: 'ETH', send_amount: 1, recv_asset: 'USD', recv_amount: 1500, recv_value_usd: 1500 }),
    ];
    const d = run(txns).disposals[0];
    expect(d.term).toBe('short');
    expect(m(d.gain)).toBe(500);
  });
  test('partial sale splits one lot', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { recv_asset: 'BTC', recv_amount: 2, send_asset: 'USD', send_amount: 20000, send_value_usd: 20000 }),
      tx('s', TxKind.SELL, '2023-01-01', { send_asset: 'BTC', send_amount: '0.5', recv_asset: 'USD', recv_amount: 8000, recv_value_usd: 8000 }),
    ];
    const res = run(txns);
    const d = res.disposals[0];
    expect(m(d.cost_basis)).toBe(5000);
    expect(m(d.gain)).toBe(3000);
    expect(res.pool.total('BTC')).toBeCloseTo(1.5, 9);
  });
});

// --------------------------------------------------------------------- //
// crypto-to-crypto trade
// --------------------------------------------------------------------- //
describe('trade', () => {
  test('disposes and reacquires at FMV', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 1000, send_value_usd: 1000 }),
      tx('t', TxKind.TRADE, '2023-01-01', { send_asset: 'ETH', send_amount: 1, recv_asset: 'SOL', recv_amount: 10, send_value_usd: 2000 }),
      tx('s', TxKind.SELL, '2023-02-01', { send_asset: 'SOL', send_amount: 10, recv_asset: 'USD', recv_amount: 2500, recv_value_usd: 2500 }),
    ];
    const res = run(txns);
    expect(res.disposals.length).toBe(2);
    const byAsset = {};
    for (const d of res.disposals) byAsset[d.asset] = d;
    expect(m(byAsset.ETH.gain)).toBe(1000);
    expect(m(byAsset.SOL.cost_basis)).toBe(2000);
    expect(m(byAsset.SOL.gain)).toBe(500);
  });
});

// --------------------------------------------------------------------- //
// ordinary income at FMV becomes cost basis
// --------------------------------------------------------------------- //
describe('income', () => {
  test('income value becomes basis', () => {
    const txns = [
      tx('i', TxKind.STAKING, '2023-01-01', { recv_asset: 'ETH', recv_amount: '0.5', recv_value_usd: 750 }),
      tx('s', TxKind.SELL, '2023-03-01', { send_asset: 'ETH', send_amount: '0.5', recv_asset: 'USD', recv_amount: 800, recv_value_usd: 800 }),
    ];
    const res = run(txns);
    expect(res.income.length).toBe(1);
    expect(m(res.income[0].value_usd)).toBe(750);
    expect(m(res.disposals[0].cost_basis)).toBe(750);
    expect(m(res.disposals[0].gain)).toBe(50);
  });
  test('income priced at FMV when value absent', () => {
    const prices = new FakePrices({}, { ETH: { '2023-07-01': 1900 } });
    const txns = [tx('i', TxKind.STAKING, '2023-07-01', { recv_asset: 'ETH', recv_amount: '0.02' })];
    const res = run(txns, prices);
    expect(m(res.income[0].value_usd)).toBe(38);
  });
});

// --------------------------------------------------------------------- //
// transfers
// --------------------------------------------------------------------- //
describe('transfers', () => {
  test('matched transfer preserves basis', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01', { account: 'coinbase', send_asset: 'BTC', send_amount: 1, transfer_id: 'x' }),
      tx('in', TxKind.TRANSFER_IN, '2021-02-01', { account: 'kraken', recv_asset: 'BTC', recv_amount: 1, transfer_id: 'x' }),
      tx('s', TxKind.SELL, '2022-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 15000, recv_value_usd: 15000 }),
    ];
    const res = run(txns);
    expect(res.unmatched_transfers.length).toBe(0);
    expect(res.disposals.length).toBe(1);
    expect(m(res.disposals[0].cost_basis)).toBe(10000);
    expect(m(res.disposals[0].gain)).toBe(5000);
  });
  test('heuristic match without transfer_id', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01T10:00:00Z', { account: 'coinbase', send_asset: 'BTC', send_amount: 1 }),
      tx('in', TxKind.TRANSFER_IN, '2021-02-01T12:00:00Z', { account: 'kraken', recv_asset: 'BTC', recv_amount: '0.999' }),
    ];
    const res = run(txns);
    expect(res.unmatched_transfers.length).toBe(0);
  });
  test('unmatched withdrawal is flagged, not disposed', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01', { account: 'coinbase', send_asset: 'BTC', send_amount: 1 }),
    ];
    const res = run(txns);
    expect(res.unmatched_transfers.length).toBe(1);
    expect(res.disposals.length).toBe(0);
    expect(res.warnings.some((w) => w.includes('unmatched withdrawal'))).toBe(true);
  });
});

// --------------------------------------------------------------------- //
// bankrupt-platform lifecycle
// --------------------------------------------------------------------- //
describe('bankruptcy lifecycle', () => {
  test('frozen is account-scoped and excluded from sale', () => {
    const txns = [
      tx('b1', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 1000, send_value_usd: 1000 }),
      tx('b2', TxKind.BUY, '2021-02-01', { account: 'celsius', recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 2000, send_value_usd: 2000 }),
      tx('f', TxKind.FROZEN, '2022-01-01', { account: 'celsius', send_asset: 'ETH', send_amount: 1 }),
      tx('s', TxKind.SELL, '2022-06-01', { account: 'coinbase', send_asset: 'ETH', send_amount: 1, recv_asset: 'USD', recv_amount: 3000, recv_value_usd: 3000 }),
    ];
    const res = run(txns);
    expect(res.disposals.length).toBe(1);
    expect(m(res.disposals[0].cost_basis)).toBe(1000);
    expect(m(res.disposals[0].gain)).toBe(2000);
    expect(res.pool.total('ETH', false)).toBeCloseTo(0, 9);
    expect(res.pool.total('ETH', true)).toBeCloseTo(1, 9);
  });
  test('write-off realizes a capital loss with no code', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'celsius', recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 2500, send_value_usd: 2500 }),
      tx('f', TxKind.FROZEN, '2022-06-12', { account: 'celsius', send_asset: 'ETH', send_amount: 1 }),
      tx('w', TxKind.WRITE_OFF, '2024-01-31', { account: 'celsius', send_asset: 'ETH', send_amount: 1 }),
    ];
    const res = run(txns);
    expect(res.disposals.length).toBe(1);
    const d = res.disposals[0];
    expect(m(d.proceeds)).toBe(0);
    expect(m(d.cost_basis)).toBe(2500);
    expect(m(d.gain)).toBe(-2500);
    expect(d.term).toBe('long');
    expect(d.code).toBe('');
  });
  test('lost removes coins without a deductible loss', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('l', TxKind.LOST, '2023-01-01', { send_asset: 'BTC', send_amount: 1 }),
    ];
    const res = run(txns);
    expect(res.disposals.length).toBe(0);
    expect(res.pool.total('BTC')).toBeCloseTo(0, 9);
    expect(res.warnings.some((w) => w.includes('nondeductible'))).toBe(true);
  });
  test('recovery acquires at FMV', () => {
    const txns = [
      tx('r', TxKind.RECOVERY, '2024-01-31', { account: 'celsius', recv_asset: 'ETH', recv_amount: '0.3', recv_value_usd: 690 }),
    ];
    const res = run(txns);
    expect(res.pool.total('ETH')).toBeCloseTo(0.3, 9);
    const lot = res.pool.openLots().next().value;
    expect(m(engine.lotBasis(lot))).toBe(690);
  });
});

// --------------------------------------------------------------------- //
// missing acquisition -> $0 basis + warning
// --------------------------------------------------------------------- //
describe('missing basis', () => {
  test('sell with no acquisition books zero basis', () => {
    const txns = [
      tx('s', TxKind.SELL, '2023-01-01', { send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 20000, recv_value_usd: 20000 }),
    ];
    const res = run(txns);
    expect(m(res.disposals[0].cost_basis)).toBe(0);
    expect(m(res.disposals[0].proceeds)).toBe(20000);
    expect(res.warnings.some((w) => w.includes('no acquisition'))).toBe(true);
  });
});

// --------------------------------------------------------------------- //
// portfolio unrealized P&L
// --------------------------------------------------------------------- //
describe('portfolio', () => {
  test('unrealized P&L', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
    ];
    const res = run(txns);
    const holdings = engine.portfolioBuild(res.pool, new FakePrices({ BTC: 25000 }));
    expect(holdings.length).toBe(1);
    expect(m(holdings[0].cost_basis)).toBe(10000);
    expect(m(holdings[0].market_value)).toBe(25000);
    expect(m(holdings[0].unrealized)).toBe(15000);
  });
});

// --------------------------------------------------------------------- //
// fee applied exactly once (Subtotal semantics, engine level)
// --------------------------------------------------------------------- //
describe('fee applied once (Coinbase Subtotal semantics)', () => {
  test('basis = subtotal + fee, proceeds = subtotal - fee', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-02-10T10:00:00Z', { recv_asset: 'BTC', recv_amount: '0.5', send_asset: 'USD', send_amount: '20000.00', send_value_usd: '20000.00', fee_asset: 'USD', fee_amount: '100.00', fee_value_usd: '100.00' }),
      tx('s', TxKind.SELL, '2024-02-01T10:00:00Z', { send_asset: 'BTC', send_amount: '0.5', recv_asset: 'USD', recv_amount: '35000.00', recv_value_usd: '35000.00', fee_asset: 'USD', fee_amount: '350.00', fee_value_usd: '350.00' }),
    ];
    const res = run(txns);
    const d = res.disposals[0];
    expect(m(d.cost_basis)).toBe(20100);
    expect(m(d.proceeds)).toBe(34650);
    expect(m(d.gain)).toBe(14550);
  });
});

// --------------------------------------------------------------------- //
// per-account pooling (IRS Rev. Proc. 2024-28 default from 2025)
// --------------------------------------------------------------------- //
describe('per-account pooling', () => {
  const twoAccounts = () => [
    tx('b1', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
    tx('b2', TxKind.BUY, '2023-01-01', { account: 'kraken', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 50000, send_value_usd: 50000 }),
    tx('s', TxKind.SELL, '2023-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 60000, recv_value_usd: 60000 }),
  ];
  test('universal draws oldest lot globally', () => {
    const d = run(twoAccounts(), null, { pooling: 'universal' }).disposals[0];
    expect(m(d.cost_basis)).toBe(10000);
    expect(m(d.gain)).toBe(50000);
    expect(d.term).toBe('long');
  });
  test('per_account draws only from selling account', () => {
    const d = run(twoAccounts(), null, { pooling: 'per_account' }).disposals[0];
    expect(m(d.cost_basis)).toBe(50000);
    expect(m(d.gain)).toBe(10000);
    expect(d.term).toBe('short');
  });
  test('universal and per_account diverge', () => {
    const u = run(twoAccounts(), null, { pooling: 'universal' }).disposals[0];
    const p = run(twoAccounts(), null, { pooling: 'per_account' }).disposals[0];
    expect(u.gain).not.toBe(p.gain);
  });
  test('self-transfer moves basis and holding period', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01', { account: 'coinbase', send_asset: 'BTC', send_amount: 1, transfer_id: 'x' }),
      tx('in', TxKind.TRANSFER_IN, '2021-02-01', { account: 'kraken', recv_asset: 'BTC', recv_amount: 1, transfer_id: 'x' }),
      tx('s', TxKind.SELL, '2023-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 15000, recv_value_usd: 15000 }),
    ];
    const res = run(txns, null, { pooling: 'per_account' });
    expect(res.unmatched_transfers.length).toBe(0);
    expect(res.disposals.length).toBe(1);
    const d = res.disposals[0];
    expect(m(d.cost_basis)).toBe(10000);
    expect(m(d.gain)).toBe(5000);
    expect(d.term).toBe('long');
    expect(res.pool.total('BTC')).toBeCloseTo(0, 9);
  });
  test('self-transfer move works without transfer_id', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01T10:00:00Z', { account: 'coinbase', send_asset: 'BTC', send_amount: 1 }),
      tx('in', TxKind.TRANSFER_IN, '2021-02-01T12:00:00Z', { account: 'kraken', recv_asset: 'BTC', recv_amount: '0.999' }),
      tx('s', TxKind.SELL, '2023-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 15000, recv_value_usd: 15000 }),
    ];
    const res = run(txns, null, { pooling: 'per_account' });
    expect(res.unmatched_transfers.length).toBe(0);
    expect(m(res.disposals[0].cost_basis)).toBe(10000);
  });
  test('sale in account without lots books zero basis', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('s', TxKind.SELL, '2023-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 15000, recv_value_usd: 15000 }),
    ];
    const res = run(txns, null, { pooling: 'per_account' });
    const d = res.disposals[0];
    expect(m(d.cost_basis)).toBe(0);
    expect(m(d.proceeds)).toBe(15000);
    expect(res.warnings.some((w) => w.includes('no acquisition'))).toBe(true);
    expect(res.pool.total('BTC')).toBeCloseTo(1, 9);
  });
  test('universal default keeps a matched transfer a no-op', () => {
    const txns = [
      tx('b', TxKind.BUY, '2021-01-01', { account: 'coinbase', recv_asset: 'BTC', recv_amount: 1, send_asset: 'USD', send_amount: 10000, send_value_usd: 10000 }),
      tx('out', TxKind.TRANSFER_OUT, '2021-02-01', { account: 'coinbase', send_asset: 'BTC', send_amount: 1, transfer_id: 'x' }),
      tx('in', TxKind.TRANSFER_IN, '2021-02-01', { account: 'kraken', recv_asset: 'BTC', recv_amount: 1, transfer_id: 'x' }),
      tx('s', TxKind.SELL, '2023-06-01', { account: 'kraken', send_asset: 'BTC', send_amount: 1, recv_asset: 'USD', recv_amount: 15000, recv_value_usd: 15000 }),
    ];
    const d = run(txns).disposals[0];
    expect(m(d.cost_basis)).toBe(10000);
    expect(m(d.gain)).toBe(5000);
  });
});

// --------------------------------------------------------------------- //
// end-to-end: the documented sample reproduces the README yearly table
// and the $15,888 portfolio cost basis.
// --------------------------------------------------------------------- //
describe('end-to-end sample (README parity)', () => {
  const sample = () => [
    // Coinbase
    tx('cb_buy_btc', TxKind.BUY, '2021-02-10', { account: 'coinbase', recv_asset: 'BTC', recv_amount: '0.5', send_asset: 'USD', send_amount: 20000, send_value_usd: 20000, fee_asset: 'USD', fee_amount: 100, fee_value_usd: 100 }),
    tx('cb_buy_eth', TxKind.BUY, '2021-03-15', { account: 'coinbase', recv_asset: 'ETH', recv_amount: 2, send_asset: 'USD', send_amount: 4000, send_value_usd: 4000, fee_asset: 'USD', fee_amount: 40, fee_value_usd: 40 }),
    tx('cb_stake_eth', TxKind.STAKING, '2021-05-01', { account: 'coinbase', recv_asset: 'ETH', recv_amount: '0.05', recv_value_usd: 100 }),
    tx('cb_send_btc', TxKind.TRANSFER_OUT, '2021-10-01', { account: 'coinbase', send_asset: 'BTC', send_amount: '0.5', transfer_id: 'cb_kraken_btc' }),
    tx('cb_convert', TxKind.TRADE, '2022-03-15', { account: 'coinbase', send_asset: 'ETH', send_amount: 1, recv_asset: 'BTC', recv_amount: '0.05', send_value_usd: 3000 }),
    tx('cb_sell_eth', TxKind.SELL, '2024-02-01', { account: 'coinbase', send_asset: 'ETH', send_amount: 1, recv_asset: 'USD', recv_amount: 3500, recv_value_usd: 3500, fee_asset: 'USD', fee_amount: 35, fee_value_usd: 35 }),
    // Kraken
    tx('kr_deposit_btc', TxKind.TRANSFER_IN, '2021-10-01', { account: 'kraken', recv_asset: 'BTC', recv_amount: '0.5', transfer_id: 'cb_kraken_btc' }),
    tx('kr_trade_btc', TxKind.SELL, '2022-05-01', { account: 'kraken', send_asset: 'BTC', send_amount: '0.2', recv_asset: 'USD', recv_amount: 6000, recv_value_usd: 6000, fee_asset: 'USD', fee_amount: 12, fee_value_usd: 12 }),
    tx('kr_stake_eth', TxKind.STAKING, '2023-07-01', { account: 'kraken', recv_asset: 'ETH', recv_amount: '0.02' }),
    // Celsius
    tx('ce_buy_eth', TxKind.BUY, '2021-04-01', { account: 'celsius', recv_asset: 'ETH', recv_amount: 1, send_asset: 'USD', send_amount: 2500, send_value_usd: 2500 }),
    tx('ce_interest', TxKind.INTEREST, '2021-07-01', { account: 'celsius', recv_asset: 'ETH', recv_amount: '0.01', recv_value_usd: 25 }),
    tx('ce_frozen', TxKind.FROZEN, '2022-06-12', { account: 'celsius', send_asset: 'ETH', send_amount: '1.01' }),
    tx('ce_recovery', TxKind.RECOVERY, '2024-01-31', { account: 'celsius', recv_asset: 'ETH', recv_amount: '0.3', recv_value_usd: 690 }),
    tx('ce_writeoff', TxKind.WRITE_OFF, '2024-01-31', { account: 'celsius', send_asset: 'ETH', send_amount: '1.01' }),
  ];

  const prices = () => new FakePrices(
    { BTC: 65000, ETH: 3500 },
    { ETH: { '2023-07-01': 1900 } }
  );

  const byYear = (disposals, year) =>
    reports.scheduleDTotals(disposals.filter((d) => d.disposed_at.getUTCFullYear() === year));
  const incomeYear = (income, year) =>
    reports.incomeTotal(income.filter((i) => i.received_at.getUTCFullYear() === year));

  test('2022 capital gains: ST +980, LT -2052', () => {
    const res = run(sample(), prices());
    const t = byYear(res.disposals, 2022);
    expect(m(t.short_term.gain)).toBe(980);
    expect(m(t.long_term.gain)).toBe(-2052);
  });

  test('2024 capital gains: LT -1080', () => {
    const res = run(sample(), prices());
    const t = byYear(res.disposals, 2024);
    expect(m(t.short_term.gain)).toBe(0);
    expect(m(t.long_term.gain)).toBe(-1080);
  });

  test('ordinary income: 2021 = $125, 2023 = $38, total $163', () => {
    const res = run(sample(), prices());
    expect(m(incomeYear(res.income, 2021))).toBe(125);
    expect(m(incomeYear(res.income, 2023))).toBe(38);
    expect(m(reports.incomeTotal(res.income))).toBe(163);
  });

  test('portfolio cost basis = $15,888', () => {
    const res = run(sample(), prices());
    const holdings = engine.portfolioBuild(res.pool, prices());
    const totalBasis = holdings.reduce((s, h) => s + h.cost_basis, 0);
    expect(m(totalBasis)).toBe(15888);
  });

  test('matched BTC self-transfer is recognized (no unmatched transfers)', () => {
    const res = run(sample(), prices());
    expect(res.unmatched_transfers.length).toBe(0);
  });
});

// --------------------------------------------------------------------- //
// HTTP router: GET /api/crypto/report and /report/download (server/crypto.js)
// Proves the read-only endpoint is wired correctly — adaptRow turns the tab's
// flat crypto_txns rows into engine transactions, the engine runs, and the
// report JSON/CSV comes back. Mounted on a minimal app exactly the way
// index.js mounts it, but in isolation so the suite never depends on the full
// server booting (it currently can't here: index.js requires ./bank-scraper,
// a module not present in this checkout — pre-existing, unrelated to crypto).
// --------------------------------------------------------------------- //
describe('report router (HTTP)', () => {
  const requestLib = require('supertest');
  const express = require('express');
  const cryptoRouter = require('../crypto');

  // The Crypto tab stores flat rows: { id, type, date, asset, quantity,
  // pricePerUnit, fees, exchange, notes }. Three rows, all on coinbase:
  //   buy 1 BTC @10000 (+100 fee) -> lot basis 10100  (2021-01-01)
  //   buy 1 BTC @12000            -> lot basis 12000  (2021-02-01)
  //   sell 1 BTC @20000 (-200 fee)-> proceeds 19800   (2023-06-01)
  // FIFO consumes the 10100 lot -> long-term gain 9700; the 12000 lot remains.
  const ROWS = [
    { id: 'r1', type: 'buy',  date: '2021-01-01', asset: 'btc', quantity: '1', pricePerUnit: '10000', fees: '100', exchange: 'coinbase' },
    { id: 'r2', type: 'buy',  date: '2021-02-01', asset: 'BTC', quantity: '1', pricePerUnit: '12000', fees: '0',   exchange: 'coinbase' },
    { id: 'r3', type: 'sell', date: '2023-06-01', asset: 'BTC', quantity: '1', pricePerUnit: '20000', fees: '200', exchange: 'coinbase' },
  ];

  const makeApp = (rows) => {
    const mockIO = (_uid) => ({
      read: (key) => (key === 'crypto_txns.json' ? rows.slice() : null),
      write: () => true,
    });
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'u1' }; next(); });
    app.use('/api/crypto', cryptoRouter(mockIO));
    return app;
  };

  test('GET /report returns Schedule D long-term gain 9700 (all years)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report');
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('fifo');
    expect(res.body.pooling).toBe('universal');
    expect(res.body.scheduleD.long_term.proceeds).toBe('19800.00');
    expect(res.body.scheduleD.long_term.cost_basis).toBe('10100.00');
    expect(res.body.scheduleD.long_term.gain).toBe('9700.00');
    expect(res.body.scheduleD.long_term.count).toBe(1);
    expect(res.body.scheduleD.short_term.count).toBe(0);
    expect(res.body.scheduleD.net_gain).toBe('9700.00');
    expect(res.body.disclaimer).toMatch(/NOT tax advice/);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.length).toBe(0);
  });

  test('GET /report form8949 has one long-term row (Part II, Box F)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report');
    expect(res.body.form8949.length).toBe(1);
    const r = res.body.form8949[0];
    expect(r.part).toBe('II');
    expect(r.box).toBe('F');
    expect(r.description).toBe('1 BTC');
    expect(r.proceeds).toBe('19800.00');
    expect(r.cost_basis).toBe('10100.00');
    expect(r.gain).toBe('9700.00');
  });

  test('GET /report portfolio shows the remaining 12000-basis lot (offline: null price)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report');
    expect(res.body.portfolio.length).toBe(1);
    const h = res.body.portfolio[0];
    expect(h.asset).toBe('BTC');
    expect(Number(h.amount)).toBeCloseTo(1, 9);
    expect(h.cost_basis).toBe('12000.00');
    expect(h.price).toBe('');
    expect(h.market_value).toBe('');
    expect(h.unrealized).toBe('');
  });

  test('income section is empty (tab rows carry no staking/interest kinds yet)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report');
    expect(res.body.income.total).toBe('0.00');
    expect(res.body.income.rows).toEqual([]);
    expect(res.body.income.by_kind).toEqual({});
  });

  test('GET /report?year=2022 excludes the 2023 disposal (net 0)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report?year=2022');
    expect(res.body.year).toBe(2022);
    expect(res.body.scheduleD.net_gain).toBe('0.00');
    expect(res.body.form8949).toEqual([]);
  });

  test('GET /report honors method + pooling query params (hifo sells the 12000 lot)', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report?method=hifo&pooling=per_account');
    expect(res.body.method).toBe('hifo');
    expect(res.body.pooling).toBe('per_account');
    expect(res.body.scheduleD.long_term.cost_basis).toBe('12000.00');
    expect(res.body.scheduleD.long_term.gain).toBe('7800.00');
  });

  test('GET /report/download?which=form8949 returns a CSV attachment', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report/download?which=form8949');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('crypto-form8949-all.csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe(reports.FORM_8949_FIELDS.join(','));
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('BTC');
  });

  test('GET /report/download rejects an unknown report with 400', async () => {
    const res = await requestLib(makeApp(ROWS)).get('/api/crypto/report/download?which=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid report/);
  });
});

// --------------------------------------------------------------------- //
// quantity formatting — must not leak binary-float noise onto a tax form
// (e.g. a 0.4 remainder rendering as "0.400000000000000022 ETH").
// --------------------------------------------------------------------- //
describe('quantity formatting', () => {
  test('clears binary-float noise from fractional remainders', () => {
    expect(engine.fmtQty(1 - 0.6)).toBe('0.4');
    expect(engine.fmtQty(0.1 + 0.2)).toBe('0.3');
    expect(engine.fmtQty(0.4)).toBe('0.4');
  });
  test('keeps whole numbers and trims trailing zeros', () => {
    expect(engine.fmtQty(1)).toBe('1');
    expect(engine.fmtQty(100)).toBe('100');
    expect(engine.fmtQty(1.5)).toBe('1.5');
  });
  test('preserves satoshi/wei-scale amounts without scientific notation', () => {
    expect(engine.fmtQty(0.00000001)).toBe('0.00000001');
    expect(engine.fmtQty(0.000000000000000001)).toBe('0.000000000000000001');
  });
});
