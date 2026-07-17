/**
 * server/dev/dev-capture.js — Express middleware that records a summary of every
 * /api request + response into the dev-log ring buffer.
 *
 * LOCALHOST-ONLY: on any non-local host this is a no-op (it just calls next()), so
 * it never runs on mycaishen.ai / the Supabase prod box. Mount it AFTER the auth
 * middleware so req.user is populated, and after the body parser so req.body exists.
 *
 * The key trick: res.on('finish') fires AFTER the route handler (and any multer
 * upload parsing) completes, so by then req.files and req.body hold the fully
 * parsed multipart fields. That's how a batch folder upload's file list shows up
 * here with zero edits to the vault upload route.
 */

const devLog = require('./dev-log');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const REDACT = /pass(word)?|secret|token|authorization|code|otp|pin/i;
const MAX_STR = 1200;   // cap any single stringified value so the log stays light

// Shallow, redacted, length-capped view of an arbitrary value for the log.
function summarize(val, depth = 0) {
  if (val == null) return val;
  if (typeof val === 'string') return val.length > MAX_STR ? val.slice(0, MAX_STR) + `…(+${val.length - MAX_STR} chars)` : val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    const head = val.slice(0, 25).map(v => summarize(v, depth + 1));
    return val.length > 25 ? [...head, `…(+${val.length - 25} more)`] : head;
  }
  if (depth > 3) return '[object]';
  const out = {};
  for (const k of Object.keys(val).slice(0, 40)) {
    out[k] = REDACT.test(k) ? '«redacted»' : summarize(val[k], depth + 1);
  }
  return out;
}

// Multer file objects are large (include a buffer / stream); keep only the facts.
function summarizeFiles(files) {
  if (!Array.isArray(files) || !files.length) return undefined;
  const head = files.slice(0, 60).map(f => ({
    name: f.originalname,
    bytes: f.size,
    type: f.mimetype,
  }));
  return files.length > 60 ? [...head, { name: `…(+${files.length - 60} more)`, bytes: 0, type: '' }] : head;
}

module.exports = function devCapture(req, res, next) {
  if (!LOCAL_HOSTS.has(req.hostname)) return next();   // prod = no-op

  const start = Date.now();

  // Capture whatever the handler sends back (res.json is the common path; res.send
  // covers a few others). Streaming SSE endpoints never call res.json, so they just
  // record the request line + status, which is what we want.
  let captured;
  const origJson = res.json.bind(res);
  res.json = (body) => { captured = body; return origJson(body); };

  res.on('finish', () => {
    try {
      devLog.push({
        kind: 'http',
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
        user: req.user?.id,
        contentType: req.headers['content-type']?.split(';')[0],
        reqBody: req.body && Object.keys(req.body).length ? summarize(req.body) : undefined,
        query: req.query && Object.keys(req.query).length ? summarize(req.query) : undefined,
        files: summarizeFiles(req.files),
        resBody: captured !== undefined ? summarize(captured) : undefined,
      });
    } catch { /* logging must never break a request */ }
  });

  next();
};
