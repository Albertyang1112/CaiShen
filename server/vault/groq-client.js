'use strict';
/**
 * vault/groq-client.js — ONE shared, rate-limit-aware gateway for every Groq call.
 *
 * Before this, ai-sort, ai-extract, and ai-review each had their own retry loop, and
 * nothing coordinated them — a multi-file upload could fire many calls at once and
 * collectively blow past Groq's free-tier limit, with each caller independently
 * retrying into the same wall. Now all Groq traffic flows through groqChat(), which:
 *
 *   • caps GLOBAL concurrency (default 2) so we never shove a burst at the API, and
 *   • on a 429/503, sets a SHARED cooldown (honoring Retry-After) that EVERY in-flight
 *     and queued call waits out — "give it a second to refresh" — before trying again.
 *
 * Tune with GROQ_MAX_CONCURRENT. The cooldown is capped so a stuck Retry-After can't
 * hang the app.
 */
const axios = require('axios');

const GROQ_URL       = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_CONCURRENT = parseInt(process.env.GROQ_MAX_CONCURRENT, 10) || 2;
const MAX_COOLDOWN   = 15000;   // never pause longer than this on a single hit
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let active = 0;
const waiters = [];
let pausedUntil = 0;            // shared "limited until this timestamp" across all callers

function acquire() {
  return new Promise(res => { if (active < MAX_CONCURRENT) { active++; res(); } else waiters.push(res); });
}
function release() {
  active = Math.max(0, active - 1);
  if (waiters.length && active < MAX_CONCURRENT) { active++; waiters.shift()(); }
}

/**
 * POST a chat-completion body to Groq, paced by the global gate + shared cooldown.
 * Retries 429/503 with backoff. Throws on a non-retryable error or after retries.
 * @param {object} body  OpenAI-style request body ({ model, messages, ... })
 */
async function groqChat(body, { timeout = 60000 } = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'your_groq_api_key_here') throw new Error('GROQ_API_KEY not configured');
  await acquire();
  try {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cooldown = pausedUntil - Date.now();
      if (cooldown > 0) await sleep(Math.min(cooldown, MAX_COOLDOWN));   // wait out a shared pause
      try {
        return await axios.post(GROQ_URL, body, { headers: { Authorization: 'Bearer ' + key }, timeout });
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if ((status === 429 || status === 503) && attempt < 5) {
          const ra = parseFloat(e.response?.headers?.['retry-after']);
          const backoff = (Number.isFinite(ra) ? ra : Math.pow(2, attempt)) * 1000 + 250;
          // Pause EVERY caller, not just this one — the limit is account-wide.
          pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(backoff, MAX_COOLDOWN));
          console.log(`[groq] ${status} — global cooldown ${Math.round(Math.min(backoff, MAX_COOLDOWN))}ms (attempt ${attempt + 1}/5)`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  } finally { release(); }
}

module.exports = { groqChat, GROQ_URL };
