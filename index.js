// dsh-watchkeeper — package entry (the profile Loader row points here).
//
// Cache-busting dynamic import of lib/host.js; the same query is forwarded through
// the whole dependency graph, including the vendored compat layer in lib/dsh-compat.
//
// One loader source: host half and client half ship in one package, one profile row.

export const name = 'dsh-watchkeeper'
export const inject = []

export async function apply(ctx, config = {}) {
  const url = new URL('./lib/host.js', import.meta.url)
  url.searchParams.set('v', String(Date.now()))
  const mod = await import(url.href)
  return mod.apply(ctx, config)
}
