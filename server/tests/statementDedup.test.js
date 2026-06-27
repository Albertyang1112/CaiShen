'use strict';
// banking/statement-dedup.js — the re-upload decision (pure). Mirrors the vault fudge heuristic.
const { decide } = require('../banking/statement-dedup');

const SIX = [
  { date: '2026-05-01', amount: -10 }, { date: '2026-05-02', amount: -20 }, { date: '2026-05-03', amount: -30 },
  { date: '2026-05-04', amount: -40 }, { date: '2026-05-05', amount: -50 }, { date: '2026-05-06', amount: -60 },
];

test('new when there are no prior rows', () => {
  expect(decide(SIX, []).decision).toBe('new');
});

test('duplicate when every row already exists', () => {
  expect(decide(SIX, SIX).decision).toBe('duplicate');
});

test('changed for a small correction (1 of 6 date-matched differ → 0.17 < 0.20)', () => {
  const next = SIX.map((r, i) => (i === 0 ? { ...r, amount: -11 } : r));
  expect(decide(next, SIX).decision).toBe('changed');
});

test('fudge when ≥20% of date-matched rows differ by > $0.02', () => {
  const next = SIX.map((r, i) => (i < 2 ? { ...r, amount: r.amount - 5 } : r));   // 2/6 = 0.33
  const d = decide(next, SIX);
  expect(d.decision).toBe('fudge');
  expect(d.fudgeCount).toBe(2);
  expect(d.dateMatched).toBe(6);
});

test('sign of amount is ignored (abs compared)', () => {
  const prior = [{ date: '2026-05-01', amount: 10 }, { date: '2026-05-02', amount: 20 }];
  const next  = [{ date: '2026-05-01', amount: -10 }, { date: '2026-05-02', amount: -20 }];
  expect(decide(next, prior).decision).toBe('duplicate');
});
