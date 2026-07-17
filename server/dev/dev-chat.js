/**
 * server/dev/dev-chat.js — the Dev Assistant chat endpoint.
 *
 * LOCALHOST-ONLY (mounted behind localhostOnly in index.js). A debugging chatbot
 * that answers two kinds of questions for the developer:
 *   1. "What can you see on this page right now?"  — answered from the FRONTEND
 *      snapshot the widget sends with each message (current nav, URL, visible text,
 *      and any structured state a page chose to expose via window.__caishenDev).
 *   2. "What did the backend just see/do when I did X?" — answered from the recent
 *      backend activity captured in dev-log (HTTP req/res summaries + dev events).
 *
 * Uses Groq (the same GROQ_API_KEY + GROQ_MODEL the vault sorter uses) via its
 * OpenAI-compatible streaming endpoint. Offline-safe: if GROQ_API_KEY is absent it
 * reports unconfigured instead of crashing.
 */

const express = require('express');
const axios   = require('axios');
const devLog  = require('./dev-log');

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
// Dedicated override so this never changes the vault's GROQ_MODEL. The free tier
// caps tokens-per-minute (8k for gpt-oss-120b) — see the budgets below, which keep
// a request well under that. Point DEV_CHAT_MODEL at a higher-TPM model if you have one.
const GROQ_MODEL = process.env.DEV_CHAT_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MAX_TOKENS = parseInt(process.env.DEV_CHAT_MAX_TOKENS, 10) || 1200;   // counts toward TPM, so keep modest

module.exports = function() {
  const router = express.Router();

  const keyOk = () => {
    const k = process.env.GROQ_API_KEY;
    return !!(k && k !== 'your_groq_api_key_here');
  };
  if (keyOk()) console.log(`✓ Dev Assistant initialized (localhost-only, Groq ${GROQ_MODEL})`);

  // Hard budgets so a request stays under Groq's free-tier TPM cap (8k tokens/min
  // for gpt-oss-120b; max_tokens counts toward it too). ~3 chars/token, so these
  // keep the prompt near ~3k tokens — leaving headroom for the reply + the limit.
  const LOG_BUDGET    = 4000;   // chars of backend-activity log (newest kept)
  const SYSTEM_BUDGET = 9000;   // chars of the whole system prompt (~3k tokens)
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(truncated ${s.length - n} chars)` : s);

  // Render one log event to a compact string (per-field JSON capped so a single
  // huge response can't eat the whole budget on its own).
  function fmtEvent(e) {
    const cap = (label, v) => `  ${label}: ${clip(JSON.stringify(v), 1500)}`;
    if (e.kind === 'http') {
      const bits = [`${e.t}  ${e.method} ${e.path} → ${e.status} (${e.ms}ms)`];
      if (e.files)   bits.push(cap('files', e.files));
      if (e.reqBody) bits.push(cap('req', e.reqBody));
      if (e.query)   bits.push(cap('query', e.query));
      if (e.resBody) bits.push(cap('res', e.resBody));
      return bits.join('\n');
    }
    return `${e.t}  EVENT ${e.label}${e.detail ? ': ' + clip(JSON.stringify(e.detail), 1500) : ''}`;
  }

  // Render the recent backend activity, newest-first into a fixed char budget so
  // only the most relevant (latest) entries are kept when the log is large.
  function backendLogBlock(n) {
    const events = devLog.recent(n);
    if (!events.length) return '(no backend activity recorded yet — perform an action, then ask)';
    const out = [];
    let used = 0;
    for (let i = events.length - 1; i >= 0; i--) {   // newest → oldest
      const line = fmtEvent(events[i]);
      if (used + line.length > LOG_BUDGET) { out.unshift(`…(${i + 1} older event(s) omitted to fit budget)`); break; }
      out.unshift(line);
      used += line.length + 1;
    }
    return out.join('\n');
  }

  // Render the frontend snapshot the widget sent (best-effort; all fields optional).
  function frontendBlock(pageContext) {
    if (!pageContext || typeof pageContext !== 'object') return '(no frontend snapshot provided)';
    const { nav, url, title, visibleText, state } = pageContext;
    const parts = [];
    if (nav)   parts.push(`Current page (nav): ${nav}`);
    if (url)   parts.push(`URL: ${url}`);
    if (title) parts.push(`Document title: ${title}`);
    if (state !== undefined) parts.push(`Page-exposed state (window.__caishenDev.snapshot()):\n${JSON.stringify(state, null, 2)}`);
    if (visibleText) parts.push(`Visible page text (rendered DOM, truncated):\n"""\n${visibleText}\n"""`);
    return parts.join('\n\n') || '(empty frontend snapshot)';
  }

  function buildSystem(pageContext, n) {
    const sys = `You are the CaiShen Dev Assistant — a localhost-only debugging helper embedded in CaiShen, a local personal-finance app (Node/Express backend on :3001, React/Vite frontend). You are talking to Albert, the developer, while he inspects the running app.

Your job: tell him precisely what the app "sees" — both on the page he's currently viewing and on the backend after an action he performed. Be concise, technical, and concrete. Quote real values (file names, sizes, counts, status codes, paths, JSON fields) from the data below. NEVER invent data that isn't present in the snapshot or log — if something isn't captured, say so and suggest what action would make it appear.

When he asks about an action (e.g. "what did you see when I batch-uploaded that folder?"), find the relevant entries in the BACKEND ACTIVITY log (e.g. POST /api/vault/upload with a files[] list, and any follow-up /api/vault/auto-organize call) and describe what the server received and returned.

============================================================
FRONTEND SNAPSHOT (what is on screen right now)
============================================================
${frontendBlock(pageContext)}

============================================================
BACKEND ACTIVITY (most recent last, newest = what just happened)
============================================================
${backendLogBlock(n)}
============================================================

If the backend log is empty or stale relative to his question, tell him to use the "Clear log" control, perform the action, then ask again — that isolates exactly what that action did.`;
    return clip(sys, SYSTEM_BUDGET);
  }

  router.get('/status', (_req, res) => res.json({ configured: keyOk() }));

  // Raw log access for the widget's "view backend log" panel.
  router.get('/log', (req, res) => res.json({ events: devLog.recent(Number(req.query.n) || 60) }));
  router.post('/log/clear', (_req, res) => res.json({ cleared: devLog.clear() }));

  router.post('/chat', async (req, res) => {
    if (!keyOk()) return res.status(400).json({ error: 'Dev Assistant not configured. Add GROQ_API_KEY to .env and restart.' });
    const { messages, pageContext, logCount } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const system = buildSystem(pageContext, Math.min(Number(logCount) || 40, devLog.MAX));
      // Groq is OpenAI-compatible: system role + the chat turns, streamed as SSE.
      // reasoning_effort:'low' keeps gpt-oss reasoning tokens (which count toward the
      // TPM cap and eat max_tokens) small so the actual answer isn't starved.
      const groqRes = await axios.post(GROQ_URL, {
        model: GROQ_MODEL, temperature: 0.2, max_tokens: MAX_TOKENS, stream: true, reasoning_effort: 'low',
        messages: [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      }, {
        headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
        responseType: 'stream', timeout: 60000,
      });

      // Parse Groq's SSE: lines of `data: {choices:[{delta:{content}}]}`, ending `data: [DONE]`.
      let buf = '';
      groqRes.data.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
            if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          } catch { /* skip keep-alive / partial frames */ }
        }
      });
      groqRes.data.on('end', () => { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); });
      groqRes.data.on('error', e => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); });
    } catch (e) {
      // With responseType:'stream', a non-2xx error body is itself a stream — read
      // it so the user sees Groq's actual message (e.g. the TPM-limit explanation)
      // instead of a bare "Request failed with status code 413".
      let detail = e.message;
      try {
        if (e.response?.data && typeof e.response.data.on === 'function') {
          let body = '';
          for await (const c of e.response.data) body += c;
          detail = JSON.parse(body)?.error?.message || body || detail;
        } else if (e.response?.data?.error?.message) {
          detail = e.response.data.error.message;
        }
      } catch { /* fall back to e.message */ }
      console.error('[DevChat] error:', detail);
      res.write(`data: ${JSON.stringify({ error: detail })}\n\n`);
      res.end();
    }
  });

  return router;
};
