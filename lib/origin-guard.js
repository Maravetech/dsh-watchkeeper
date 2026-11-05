// Origin guard for the plugin's HTTP routes.
//
// The routes live on the DSH web server (usually 127.0.0.1:<port>). Some of them write:
// `/watchkeeper/watch/prompt` sends text into a session, and a session's agent can run
// shell commands. Reflecting any `Origin` in CORS headers would let any web page the user
// opens drive those routes from the browser. So:
//
//   · the request `Host` must name a loopback address (127.0.0.1, localhost, ::1) or a
//     host listed in `WATCHKEEPER_ALLOWED_HOSTS` (comma-separated `host` or `host:port`).
//     A DNS-rebinding page reaches us with its own name in `Host`, so a same-host check
//     alone is not enough — that page's `Origin` would equal its `Host`;
//   · requests without an `Origin` header (curl, server-side callers) are allowed, unless
//     the browser marks them `Sec-Fetch-Site: cross-site`;
//   · browser requests are allowed only from the DSH web UI's own origin
//     (http/https `Origin` whose host equals the loopback `Host`), the DSH desktop shell
//     (`dsh:` / `dsh-app:`), or an origin listed in `WATCHKEEPER_ALLOWED_ORIGINS`
//     (comma-separated, exact match, e.g. `http://127.0.0.1:5173`);
//   · `Origin: null` (sandboxed iframes, file pages) is always rejected;
//   · everything else gets 403 and no CORS headers.

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function envList(name) {
  return String(process.env[name] || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean)
}

function allowList() {
  return envList('WATCHKEEPER_ALLOWED_ORIGINS')
}

function hostnameOf(hostHeader) {
  try { return new URL(`http://${hostHeader}`).hostname.toLowerCase() } catch { return null }
}

/** Whether the request `Host` names this machine (or an explicitly allowed host). */
export function hostAllowed(req) {
  const raw = String(req?.headers?.host || '').trim().toLowerCase()
  if (!raw || /[\s/@?#]/.test(raw)) return false
  const extra = envList('WATCHKEEPER_ALLOWED_HOSTS')
  if (extra.includes(raw)) return true
  const name = hostnameOf(raw)
  if (!name) return false
  if (extra.includes(name)) return true
  if (LOOPBACK_NAMES.has(name)) return true
  return /^127(?:\.\d{1,3}){3}$/.test(name)
}

export function originAllowed(req) {
  const headers = req?.headers || {}
  const host = hostAllowed(req)
  if (!host) return false
  const origin = headers.origin
  const normalized = origin === undefined || origin === '' ? '' : String(origin).replace(/\/+$/, '').toLowerCase()
  if (normalized === 'null') return false
  if (normalized && allowList().includes(normalized)) return true
  if (!normalized) {
    return String(headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site'
  }
  let parsed
  try { parsed = new URL(normalized) } catch { return false }
  if (parsed.protocol === 'dsh:') return parsed.host === 'host'
  if (parsed.protocol === 'dsh-app:') return parsed.host === 'app'
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (host !== true) return false // a browser origin needs a loopback Host to compare with
  return parsed.host === String(headers.host).trim().toLowerCase()
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
