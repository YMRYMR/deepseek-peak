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

## Historical usage on cold launch

The per-day usage chart reads from
`GET /api/peak-hours/usage?rangeDays=30`, also served by the host
face. The host walks `ctx.sessionPersistence` (the durable event log
every session is already flushed to) and aggregates the per-model
`assistant/message` events into the same `UsageSummary` shape the
client already understands. The browser tries the host endpoint
first, then falls back to its in-tab trajectory walk if the host
returns nothing (TUI build, transient network blip). The host
response is the source of truth, so the chart shows real data on
the first hover of a fresh harness launch.

```
Browser                          Host (this package's src/index.ts)
───────                          ─────────────────────────────────
hover the pill
  → fetch('/api/peak-hours/usage?rangeDays=30[&fresh=1]')
    ── HTTP GET (same-origin) ──►
                                  ctx.sessionPersistence.listSnapshots()
                                  for each session:
                                    ctx.sessionPersistence.inspect(id)
                                      filter assistant/message events
                                      bucket per-model per-day
                                  cache (5 min, keyed by rangeDays) → JSON
    ◄── JSON ──
  → render
```

`?fresh=1` bypasses the host's 5-min cache so a "new message landed"
tick in the browser can see fresh data within seconds. The cache is
keyed by `rangeDays` so a 7-day and a 30-day window do not shadow
each other.

The wire mirrors the client's `UsageSummary` shape:

```ts
type UsageEnvelope =
  | { ok: true;  summary: {
        rangeDays: number,
        rangeStartUtc: number,  // epoch ms
        rangeEndUtc: number,    // epoch ms
        models: Array<{
          model: string,
          daily: Record<string, { tokens: number, peakTokens: number,
                                  cost: number,    messages: number }>,
          totalTokens: number,
          totalCost: number,
          totalMessages: number,
        }>,
        totalTokens: number,
        totalCost: number,
        totalMessages: number,
        firstRecordMs: number | null,
        hadMissing: boolean,
    } }
  | { ok: false; error: { kind: 'unavailable' | 'invalid', message: string } }
```

The `daily` field is a `Record` (Maps don't survive `JSON.stringify`).
The client rehydrates each model's `daily` into a `Map` after the
fetch. `cost` is computed host-side from the same `costForUsage` the
client uses, so the per-day buckets and any future dollar total
agree on rates.

## Pause during peak

A small switch lives inside the pill, on the right. When ON and the
current UTC hour is inside a peak window (`01:00–04:00` or
`06:00–10:00`), the host's `llm/stream` gate holds every new chat
message in a FIFO and dispatches them strictly in arrival order the
moment the phase flips to off-peak. When OFF (or ON during off-peak),
messages pass through normally.

```
┌─ session header ───────────────────────────────────────────┐
│                                                            │
│  ● OFF-PEAK 02h 13m → PEAK 09:00  [⏸ pause]  [Session log] │
│         └─ on hover: chart + balance overlay               │
└────────────────────────────────────────────────────────────┘
```

The switch is the source-of-truth client for the host's `paused`
flag, which lives in the standard settings plane (namespace
`peak-hours`). It survives restarts. The browser polls
`GET /api/peak-hours/state` every 2 s; the POST on click is
optimistic so the visual state flips before the round-trip.

### Wire

```
Browser                          Host (this plugin's apply())
───────                          ────────────────────────────
hover / 1 Hz tick
  → fetch('/api/peak-hours/state')           every 2 s
        ◄── JSON { isPaused, phase, isBlockedNow, queueSize, ... }

click the switch
  → fetch('/api/peak-hours/state', { method: 'POST',
                                     body: { paused: true|false } })
        ◄── JSON { isPaused, phase, isBlockedNow, queueSize, ... }

click a queue row's send arrow
  → fetch('/api/peak-hours/queue/dispatch', { method: 'POST',
                                              body: { enqueuedAt } })
        ◄── JSON { ok: true, dispatched } | { ok: false, error }

user sends a chat message
  → ctx.llm.stream(options)  (in the host process)
        ── 'llm/stream' waterfall ──►
                            if isBlockedNow (paused && peak):
                              enqueue({ options, next })
                              return queuedStream(drainPromise)
                            else:
                              return next()  (immediate dispatch)

1 Hz host ticker
  → recompute phase from UTC clock
  → if phase just flipped peak→off-peak: drain queue in order
  → if phase just flipped off-peak→peak: no-op (next request queues)
```

### Queue semantics

- **Drain trigger**: phase flips peak→off-peak, the user toggles
  the switch OFF, or the user clicks a queue card's per-row send
  arrow. All three wake the same drainer; the queue empties in
  arrival order.
- **Per-item signal**: a caller's `AbortSignal` (a chat session the
  user closed, an agent preset cancelled, a tool timeout) is honoured
  while queued. The item is removed from the queue and the queued
  stream returns immediately, so the agent loop never holds a
  reference to a dead session.
- **Strictly serial**: the drainer awaits each item's `complete` (the
  queued stream's `finally` fires when the inner stream ends, errors,
  or the signal aborts) before pulling the next. Items never overlap
  on the wire even though every agent loop has its own consumer.
- **Process-local**: a harness restart loses the queue. The pause flag
  itself is persisted; the queue is not.

### Queue card

When the queue is non-empty, a second card appears below the chart
card on the same hover surface. It uses the chart card's color
recipe exactly (peak red / off-peak green, opaque base, dashed
border pre-cutover) so the two cards read as one element. Each
row is one line of the queued prompt; long prompts collapse to a
single line with an ellipsis, and the full text (multi-line
included) is on the row's `title` for the native hover tooltip.
The list is capped at 10 lines (`max-height: 160px`); a longer
queue scrolls with a `currentColor`-tinted scrollbar.

Each row carries a small right-pointing arrow on its right edge.
On the front (FIFO head) item it is a live button; on later items
it renders as a faded, disabled affordance so the layout stays
uniform without promising out-of-order dispatch.

```
┌─ on hover, below the chart card ──────────────────────────────┐
│  QUEUE                                              3          │
│  ──────────────────────────────────────────────────────────   │
│  Refactor the auth flow to use the new session...      →     │  ← live
│  Why is the chart failing to render? Add a deb...      →     │  ← ghost
│  A very long message that should overflow th...        →     │  ← ghost
└───────────────────────────────────────────────────────────────┘
```

### Manual dispatch

The per-row send arrow hits
`POST /api/peak-hours/queue/dispatch`:

```
Browser                          Host (this plugin's apply())
───────                          ────────────────────────────
click the front row's send arrow
  → fetch('/api/peak-hours/queue/dispatch',
          { method: 'POST', body: { enqueuedAt } })
        ◄── JSON { ok: true, dispatched: { prompt, enqueuedAt } }
        or  { ok: false, error: { kind: 'not-found' | 'not-front' | 'invalid' } }
```

The host finds the matching front item and releases it through
the same drainer path the natural end-of-peak transition uses.
The pause toggle is not changed. `not-front` is a defensive
error for the race where a sibling item was already dispatched;
the card UI handles it by refreshing its snapshot on the next
2 s poll. The card is hidden when `queueSize === 0`, so the
endpoint is only ever called with a row that was visible a moment
ago.

### State envelope

The host always answers `200 OK` with a JSON envelope, even on
malformed input, so the browser can always parse the body as
`StateResult`:

```ts
type StateResult =
  | { ok: true;  state: {
        isPaused: boolean,
        phase: 'peak' | 'off',
        preLaunch: boolean,
        isBlockedNow: boolean,        // isPaused && phase === 'peak'
        nextPhaseAt: number,          // epoch ms
        cutoverAt: number,            // epoch ms, -1 if already live
        queueSize: number,            // 0..9999, clamped for the wire
        queue: Array<{                // up to 100 items, FIFO order
          prompt: string,             // the user's last user-role text,
                                      // multi-line collapsed to '\n'
          enqueuedAt: number,         // epoch ms
        }>,
        queueOverflow: number,        // items past the wire cap of 100
        refreshedAt: number,          // epoch ms
    } }
  | { ok: false; error: { kind: 'invalid', message: string } }
```

`queue` is the live snapshot the queue card renders. Items appear
in arrival order, so the first row is the next item the drainer
will release. `queueSize` is the real in-memory queue depth and is
the source of truth for "is the queue card even visible" — when
it is 0 the card stays hidden even if a stale `queue` array
lingers.

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

The host face needs five services — `credentials`, `webServer`, `llm`,
`settings`, and `sessionPersistence` — all standard in the Web bundle.
If any is missing the affected surface degrades without throwing:
the balance row answers `unavailable`, the pause switch reads/writes
an in-process boolean instead of a persisted setting, the LLM gate
skips its hook, the usage route answers an `unavailable` envelope,
and the state route still answers a JSON envelope. The whole plugin
intentionally never crashes the harness on a missing service.

The overlay depends on the `sessions` Cordis service (the same one the
trajectory view uses), so the `inject` declaration in `src/client/index.ts`
lists `['slots', 'sessions']`.

## Data sources

| Source | Used for |
| ------ | -------- |
| `ctx.sessionPersistence.listSnapshots()` + `.inspect(id)` (host) | Per-session `assistant/message` event log. Source of truth for the chart; survives harness restarts. |
| `ctx.sessions.list` (browser, fallback) | Enumerate session ids for the in-tab trajectory walk when the host endpoint is unavailable. |
| `ctx.sessions.binding(id).session.getSnapshot().views.get('trajectory').eventNodes` (browser, fallback) | Per-session assistant-message nodes when the host endpoint is unavailable. Each carries `usage: { inputTokens, cacheReadTokens, outputTokens }` and `provenance.model`. |
| Browser clock | Phase determination. |
| Host `GET /api/peak-hours/balance` (this package's host face) | Live account balance. |
| Host `GET /api/peak-hours/usage` (this package's host face) | Historical usage rolled up from `ctx.sessionPersistence`. |
| `ctx.credentials.resolve('DEEPSEEK_API_KEY')` (host) | Server-side API key. Never reaches the browser. |
| `launchEnvironmentOf(ctx).get('DEEPSEEK_API_KEY')` (host, fallback) | Environment-variable fallback. Never reaches the browser. |

The chart prefers the host's `usage` endpoint; if it is unavailable
the browser falls back to the trajectory-view walk. Cost is computed
host-side from the same `costForUsage` the browser uses. Cache
invalidation re-fires on each `sessions.list` notification and on
every new assistant message (`?fresh=1` bypasses the host's 5-min
cache).

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
- **Host-side session walk** — the host's `usage` route walks every
  persisted session on a cache miss; for harnesses with thousands of
  sessions this is a measurable walk. The 5-min cache absorbs repeated
  hovers; a future iteration can add a rolling aggregate written
  alongside the persistence log.
- **Single-currency balance row** — the tooltip renders the first
  `balance_infos[]` entry. DeepSeek's response shape can carry more
  than one currency; a future iteration can show all of them in a
  small table without changing the wire.
- **No host-side snapshot service** — there is intentionally no
  `ctx.peakHours` service for cross-plugin use. The next iteration can
  add one if a session-event consumer or a non-React host view needs
  the same data.
