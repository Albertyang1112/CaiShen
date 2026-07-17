/**
 * server/dev/dev-log.js — in-memory ring buffer of recent backend activity.
 *
 * LOCALHOST-ONLY DEV TOOL. This is the "what did the backend just see/do" memory
 * that the Dev Assistant (server/dev/dev-chat.js) reads to answer questions like
 * "what files did you receive when I batch-uploaded that folder?".
 *
 * It is a process-global singleton (not per-user) on purpose: it's a developer
 * debugging aid for a single local machine, not user data. Nothing here is ever
 * persisted to disk and it is only ever populated on localhost (see dev-capture.js).
 *
 * Events are plain objects. Two kinds are pushed today:
 *   • { kind:'http', method, path, status, ms, reqBody, files, resBody, user }
 *       — emitted automatically for every /api call by dev-capture.js
 *   • { kind:'event', label, detail }
 *       — emitted on demand by feature code that calls push() directly
 */

const MAX = 250;          // keep the last N events; oldest fall off the front
const BUF = [];

function push(evt) {
  BUF.push({ t: new Date().toISOString(), ...evt });
  if (BUF.length > MAX) BUF.splice(0, BUF.length - MAX);
  return evt;
}

// Most-recent-last slice of up to n events.
function recent(n = 60) {
  return BUF.slice(-Math.max(0, n));
}

function clear() {
  const had = BUF.length;
  BUF.length = 0;
  return had;
}

module.exports = { push, recent, clear, MAX };
