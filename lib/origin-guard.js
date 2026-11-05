// Origin guard for the plugin's HTTP routes.
//
// The routes live on the DSH web server (usually 127.0.0.1:<port>). Some of them write:
// `/watchkeeper/watch/prompt` sends text into a session, and a session's agent can run
// shell commands. Reflecting any `Origin` in CORS headers would let any web page the user
// opens drive those routes from the browser. So:
//
//   · the request Host must be a literal loopback address;
//   · requests without an `Origin` header (curl, server-side callers) are allowed under that Host restriction,
//     unless the browser marks them `Sec-Fetch-Site: cross-site`;
//   · browser requests are allowed only from the loopback DSH web UI's own origin
//     or the known DSH desktop shell origins (`dsh://host`, `dsh-app://app`)
//     or from an origin listed in
//     `WATCHKEEPER_ALLOWED_ORIGINS` (comma-separated, exact match, e.g. `http://127.0.0.1:5173`);
//   · everything else gets 403 and no CORS headers.
import { timingSafeEqual } from 'node:crypto'

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

function allowList() {
  return String(process.env.WATCHKEEPER_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export function originAllowed(req) {
  let target
  try { target = new URL(`http://${req?.headers?.host || ''}`) } catch { return false }
  if (!LOOPBACK.has(target.hostname.toLowerCase()) || target.username || target.password) return false
  const origin = req?.headers?.origin
  if (!origin) return String(req?.headers?.['sec-fetch-site'] || '').toLowerCase() !== 'cross-site'
  const normalized = String(origin).replace(/\/+$/, '')
  if (normalized === 'null') return false
  let parsed
  try { parsed = new URL(normalized) } catch { return false }
  if (parsed.username || parsed.password) return false
  if (normalized === 'dsh://host' || normalized === 'dsh-app://app') return true
  if (allowList().includes(normalized) && ['http:', 'https:'].includes(parsed.protocol)) return true
  return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname.toLowerCase()) && parsed.host.toLowerCase() === target.host.toLowerCase()
}

/** Control writes are disabled until the operator configures a separate bearer token. */
export function controlAuthorized(req) {
  const configured = process.env.WATCHKEEPER_CONTROL_TOKEN
  const supplied = req?.headers?.['x-watchkeeper-control-token']
  if (!configured || typeof supplied !== 'string') return false
  const a = Buffer.from(configured)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Sets CORS headers only for allowed origins. Returns whether the request may proceed. */
export function applyCors(req, res) {
  const allowed = originAllowed(req)
  try {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('vary', 'Origin')
    if (allowed && req?.headers?.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin)
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
    }
  } catch { /* response may already be sent */ }
  return allowed
}

/** Ends the request with 403 when the origin is not allowed. Returns true when it did. */
export function rejectForeignOrigin(req, res) {
  if (applyCors(req, res)) return false
  try {
    res.statusCode = 403
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }))
  } catch { /* ignore */ }
  return true
}
