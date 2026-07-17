'use strict';
/**
 * banking/market-rates.js — live market mortgage rates for the Mortgage page.
 *
 * Source: Freddie Mac's Primary Mortgage Market Survey (the industry-standard weekly
 * average) via FRED's public CSV endpoint — no API key required:
 *   https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US
 *
 * Cached in-process and re-fetched once stale, so the UI always shows the latest
 * published number with no refresh button and no per-request round trip. The series
 * updates weekly (Thursdays); a 6-hour TTL picks new prints up the day they land.
 * Fetch failures serve the last good cache (or nulls) — never an error to the UI.
 */
const axios = require('axios');

const SERIES = { rate30: 'MORTGAGE30US', rate15: 'MORTGAGE15US' };
const TTL_MS = 6 * 60 * 60 * 1000;

let cache = { at: 0, data: null };

async function fetchSeries(id) {
  const r = await axios.get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,
    { timeout: 15000, responseType: 'text' });
  // CSV: header row, then "YYYY-MM-DD,value" ascending; the last numeric row is current.
  const lines = String(r.data).trim().split('\n');
  for (let i = lines.length - 1; i > 0; i--) {
    const [date, val] = lines[i].split(',');
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return { rate: n, asOf: date };
  }
  return null;
}

async function getMarketRates() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const [r30, r15] = await Promise.all([fetchSeries(SERIES.rate30), fetchSeries(SERIES.rate15)]);
    if (r30 || r15) {
      cache = { at: Date.now(), data: { rate30: r30, rate15: r15, fetchedAt: new Date().toISOString() } };
      return cache.data;
    }
  } catch (e) { console.error('[market-rates]', e.message); }
  return cache.data || { rate30: null, rate15: null, fetchedAt: null };
}

module.exports = { getMarketRates, _fetchSeries: fetchSeries };
