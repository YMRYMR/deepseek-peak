# `@deepseek-ai/dsh-client-ui-peak-hours`

Live DeepSeek V4 API peak/off-peak status pill in the session header
utilities row, with an on-hover overlay that shows per-model daily token
usage and the platform's current account balance.

| Phase    | Color  | What it means |
| -------- | ------ | ------------- |
| `PEAK`     | red    | 2× surcharge. 01:00–04:00 and 06:00–10:00 UTC. |
| `OFF-PEAK` | green  | 0.5× baseline. All other UTC hours. |

The pill is computed from the browser clock against the authoritative
UTC windows published at
[`api-docs.deepseek.com/quick_start/pricing/`](https://api-docs.deepseek.com/quick_start/pricing/).
The on-hover overlay pulls per-message token counts from each session's
trajectory view. The live balance is fetched server-side by the host
face; the browser never holds the API key.

## What you see

```
┌─ session header ───────────────────────────────────────────┐
│                                                            │
│  ● OFF-PEAK pre-cutover 51h 20m → live      [Session log ⤓] │
│         └─ on hover, anchored below the pill:              │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  BALANCE  $2.18 USD          granted $5.00 · peak   │  │
│  │  Spent ≈ $0.74 · 1,204 messages here                │  │
│  │  ────────────────────────────────────────────────    │  │
│  │  v4-flash                          1.2B  ·  $0.62   │  │
│  │  ┃┃┃ ┃┃ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁    │  │
│  │  7/16   7/26   8/4   8/14                           │  │
│  │  ────────────────────────────────────────────────    │  │
│  │  v4-pro                             482M  ·  $0.12  │  │
│  │  ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁ ▁    │  │
│  │  ────────────────────────────────────────────────    │  │
│  │  Last 30 days · UTC · since 2026-08-04              │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

The pill itself is unchanged. The overlay appears only on hover, in the
same dark surface and font as the pill so the two read as one element.

## Pricing model (per-model × per-phase)

The cost line in each chart card is computed from the per-message token
counts already on the trajectory view, using the published V4 rates:

| Model         | Off-peak (input cache hit / miss / output) | Peak (2× off-peak) |
| ------------- | ------------------------------------------- | ------------------ |
| `v4-flash` | $0.007 / $0.22 / $0.66  per 1M tokens | × 2 |
| `v4-pro`  | $0.022 / $0.66 / $1.98 per 1M tokens | × 2 |

The cost is computed per request using the phase that was in effect at
the request's timestamp, so historical records pay the right rate.
Before `2026-08-16 16:00 UTC` the API billed at a single flat rate; the
plugin applies that flat rate for any pre-cutover request in the same
code path (`pricing.ts`).

## Balance fetch

The balance line in the header is `GET /api/peak-hours/balance`, served
by this package's **host face** (`src/index.ts`). The browser never
sees the DeepSeek API key. The wire is:

```
Browser                          Host (this package's src/index.ts)
───────                          ─────────────────────────────────
hover the pill
  → fetch('/api/peak-hours/balance')
    ── HTTP GET (same-origin) ──►
                                  ctx.credentials.resolve('DEEPSEEK_API_KEY')
                                    ↳ inherited env (DEEPSEEK_API_KEY=… dsh)
                                    ↳ $DSH_HOME/.credentials.yaml
                                      (the Models settings page writes here)
                                    ↳ <cwd>/.env → $DSH_HOME/.env fallback
                                  fetch('https://api.deepseek.com/user/balance')
                                    ↳ bearer-auth GET, server-to-server, no CORS
                                  cache (5 min) → JSON response
    ◄── JSON ──
  → render
```

The user does not type the key into the browser. They configure it
once, the same way they configure every other DeepSeek call in the
harness — through the Models settings page, or by exporting
`DEEPSEEK_API_KEY` in the launching shell, or by writing
`.credentials.yaml`. The key never leaves the harness process; the
browser only ever sees a small JSON envelope with the balance total.

If `DEEPSEEK_API_KEY` is not configured, the balance row degrades to
`BALANCE — not configured` (with a tooltip explaining the cause) and
the rest of the surface keeps working. There is no settings form in
the browser to enter the key — by design, so a typo can never leak a
key the user did not intend to share with the page.

### Caching

Both halves cache the balance for 5 minutes:

- **Host**: a single in-memory slot, refreshed by a `setTimeout(5 min)`
  loop on every successful fetch. The first hover after a cold boot is
  not a 5-minute wait; the host kicks a refresh on demand and the
  browser sees the fresh result on the response.
- **Browser**: a `BalanceCache` in the `PeakHoursHost` closure, valid
  for 5 minutes. A hover storm in the same 5-min window costs at most
  one network round-trip per browser tab.

### Error envelope

The host always answers `200 OK` with a JSON envelope, even on failure,
so the browser can always parse the body as a `BalanceResult`:

```ts
type BalanceResult =
  | { ok: true;  balance: { entries: [...], isAvailable: boolean, refreshedAt: number } }
  | { ok: false; error: { kind: 'no-key' | 'network' | 'http' | 'parse' | 'unavailable',
                          status?: number, message: string } }
```

The browser's tooltip row maps these to a small set of stable strings:

| kind          | Row text           | Tooltip carries |
| ------------- | ------------------ | --------------- |
| `no-key`        | `not configured`     | `"DEEPSEEK_API_KEY is not configured on the host"` |
| `network`       | `fetch failed`       | the fetch error message |
| `http`          | `fetch failed`       | `"HTTP <status> <statusText>"` |
| `parse`         | `fetch failed`       | the JSON parse error message |
| `unavailable`   | `fetch failed`       | `"platform reports balance unavailable"` |

## Install

This package is part of the deepseek-harness tree. To use it locally:

```sh
cd C:\dev\deepseek-harness
pnpm install
pnpm --filter @deepseek-ai/dsh-client-ui-peak-hours run bundle
pnpm dsh web
```

To use it in a downstream deployment, install the package and add a
row in your `cordis.patch.yml`:

```yaml
- insert:
    - id: ui-peak-hours
      name: '@deepseek-ai/dsh-client-ui-peak-hours'
```

The same row covers both faces: the host face (`src/index.ts`) is
loaded as a cordis plugin by the row, and the browser face
(`src/client/`) is composed into `window.__DSH_BOOT__` by the modules
node half through the package's `dsh.client` declaration.

The host face needs two services — `credentials` and `webServer` —
both standard in the Web bundle. If either is missing, the route
still registers and answers a JSON `unavailable` error so the
balance row degrades gracefully.

The overlay depends on the `sessions` Cordis service (the same one the
trajectory view uses), so the `inject` declaration in `src/client/index.ts`
lists `['slots', 'sessions']`.

## Data sources

| Source | Used for |
| ------ | -------- |
| `ctx.sessions.list` | Enumerate all session ids. |
| `ctx.sessions.binding(id).session.getSnapshot().views.get('trajectory').eventNodes` | Per-session assistant-message nodes; each carries `usage: { inputTokens, cacheReadTokens, outputTokens }` and `provenance.model`. |
| Browser clock | Phase determination. |
| Host `GET /api/peak-hours/balance` (this package's host face) | Live account balance. |
| `ctx.credentials.resolve('DEEPSEEK_API_KEY')` (host) | Server-side API key. Never reaches the browser. |
| `launchEnvironmentOf(ctx).get('DEEPSEEK_API_KEY')` (host, fallback) | Environment-variable fallback. Never reaches the browser. |

The aggregation walks the trajectory view snapshot per session; cost is
computed lazily per record. Cache invalidation re-fires on each
`sessions.list` notification and on every new assistant message.

## Model Experience

### Request context and condition

#### What the model sees

None. The package contributes no model-facing tool, prompt section, or
session event. The widget and overlay render purely in the client's
React tree.

#### Token effect

Zero-direct token effect. The widget never appears in a model request.

#### KV Cache effect

Independent behavior. No shared prefix; the package is not part of the
assembled request.

## Known Limitations and Deferred Work

- **Browser-clock dependency** — the pill trusts the user's local
  system clock against UTC windows. A user with a mis-set clock will see
  a misleading status. A future iteration could expose a `useEffect`
  fetch of `worldtimeapi.org` for a sanity check.
- **Trajectory view load** — the aggregation depends on each session's
  trajectory view having been built. Sessions that have never been opened
  in the trajectory tab may have a `EMPTY_TRAJECTORY_SNAPSHOT` and
  contribute no records. The chart will show `partial` in the header if
  any session was unreachable.
- **Single-currency balance row** — the tooltip renders the first
  `balance_infos[]` entry. DeepSeek's response shape can carry more
  than one currency; a future iteration can show all of them in a
  small table without changing the wire.
- **No host-side snapshot service** — there is intentionally no
  `ctx.peakHours` service for cross-plugin use. The next iteration can
  add one if a session-event consumer or a non-React host view needs
  the same data.
