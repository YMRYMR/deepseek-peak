/**
 * Live balance fetch was removed in this revision.
 *
 * The original implementation called `GET /user/balance` with the user's
 * API key, stored the key in `localStorage`, and surfaced a settings
 * affordance in the hover card. It was removed because:
 *
 *   1. The DeepSeek credentials service (`ctx.credentials`) is host-only
 *      (depends on `node:fs`, `chokidar`, `yaml`) and cannot be reached
 *      from the browser, so a client-only plugin cannot read the
 *      harness's key.
 *   2. Asking the user to paste the API key into a browser-pinned
 *      `localStorage` is a UX anti-pattern: a second copy of the secret
 *      exists outside the harness's secure store, and any future
 *      exploit of the plugin's render path would expose it.
 *
 * The chart in `UsageTooltip` now shows the harness's own aggregation
 * of token usage, which is the honest local signal. If/when a
 * host-side bridge package is added (a `peakHoursHost` service that
 * resolves the API key server-side and exposes it to the client),
 * this file can be re-introduced.
 *
 * Kept as an empty stub so existing imports keep type-checking until
 * the file is removed in a follow-up cleanup.
 */
export {}
