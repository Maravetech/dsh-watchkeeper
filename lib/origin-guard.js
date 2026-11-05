// Origin guard for the plugin's HTTP routes.
//
// The routes live on the DSH web server (usually 127.0.0.1:<port>). Some of them write:
// `/watchkeeper/watch/prompt` sends text into a session, and a session's agent can run
// shell commands. Reflecting any `Origin` in CORS headers would let any web page the user
// opens drive those routes from the browser. So:
//
//   · requests without an `Origin` header (curl, server-side callers) are allowed;
//   · browser requests are allowed only from the DSH web UI's own origin
//     (the `Origin` host equals the request `Host`), or from an origin listed in
//     `WATCHKEEPER_ALLOWED_ORIGINS` (comma-separated, exact match, e.g. `http://127.0.0.1:5173`);
//   · everything else gets 403 and no CORS headers.

function allowList() {
  return String(process.env.WATCHKEEPER_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

export function originAllowed(req) {
  const origin = req?.headers?.origin
  if (!origin) return true
  const normalized = String(origin).replace(/\/+$/, '')
  if (allowList().includes(normalized)) return true
  let parsed
  try { parsed = new URL(normalized) } catch { return false }
  const host = String(req?.headers?.host || '').toLowerCase()
  return Boolean(host) && parsed.host.toLowerCase() === host
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
