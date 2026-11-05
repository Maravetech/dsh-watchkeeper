# dsh-compat (vendored)

Version adapter for DeepSeek Harness. It isolates the plugin from host API drift:

- service acquisition (`ctx.inject` → `ctx.get` → `ctx[name]`), with a low-frequency retry;
- lifecycle and timers (`ctx.effect` → `ctx.timer` → a registered `setInterval`);
- route registration (exact + prefix) with CORS helpers.

Vendored from a DSH plugin toolkit and trimmed for this project. It is a library,
not a plugin: it has no profile row and is never mounted on its own.
