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
trajectory view and fetches the live balance from
`GET /user/balance` (no host round-trip needed for the pill itself).

## What you see

```
┌─ session header ───────────────────────────────────────────┐
│                                                            │
│  ● OFF-PEAK pre-cutover 51h 20m → live      [Session log ⤓] │
│         └─ on hover, anchored below the pill:              │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  BALANCE  $2.18 USD                       ↻          │  │
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

The balance line in the header is `GET https://api.deepseek.com/user/balance`
with the user's API key as `Authorization: Bearer <key>`. The key is
stored in `localStorage` only — never logged, never sent anywhere else.

The fetch happens in the browser. If `api.deepseek.com` does not return
the right CORS headers for the harness origin, the request fails and the
header degrades to a `—` with a "fetch failed" hint. The chart below
still works because it is local data.

To enter the key, hover the pill → click the ⚙ icon → paste the key → Save.

## Install

This package is part of the deepseek-harness tree. To use it locally:

```sh
cd C:\dev\deepseek-harness
pnpm install
pnpm --filter @deepseek-ai/dsh-client-ui-peak-hours run bundle
pnpm dsh web
```

To use it in a downstream deployment, install the package and add a
`dsh.client` row in your `cordis.patch.yml`:

```yaml
- insert:
    - id: ui-peak-hours
      name: '@deepseek-ai/dsh-client-ui-peak-hours'
```

The overlay depends on the `sessions` Cordis service (the same one the
trajectory view uses), so the `inject` declaration in `src/client/index.ts`
lists `['slots', 'sessions']`.

## Data sources

| Source | Used for |
| ------ | -------- |
| `ctx.sessions.list` | Enumerate all session ids. |
| `ctx.sessions.binding(id).session.getSnapshot().views.get('trajectory').eventNodes` | Per-session assistant-message nodes; each carries `usage: { inputTokens, cacheReadTokens, outputTokens }` and `provenance.model`. |
| Browser clock | Phase determination. |
| `fetch('https://api.deepseek.com/user/balance')` | Live account balance. |

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
- **CORS on `/user/balance`** — if `api.deepseek.com` does not return
  `Access-Control-Allow-Origin` for the harness origin, the balance line
  silently degrades to a `—` with a "fetch failed" hint. The chart still
  works because it is local data. A future iteration could add a small
  host-side Cordis service that proxies the balance fetch server-side,
  which would not need CORS.
- **Trajectory view load** — the aggregation depends on each session's
  trajectory view having been built. Sessions that have never been opened
  in the trajectory tab may have a `EMPTY_TRAJECTORY_SNAPSHOT` and
  contribute no records. The chart will show `partial` in the header if
  any session was unreachable.
- **No host-side snapshot service** — there is intentionally no
  `ctx.peakHours` service for cross-plugin use. The next iteration can
  add one if a session-event consumer or a non-React host view needs
  the same data.
