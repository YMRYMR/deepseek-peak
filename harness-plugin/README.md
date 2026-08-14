# `@deepseek-ai/dsh-client-ui-peak-hours`

Live DeepSeek V4 API peak/off-peak status card in the conversation input
dock strip. Pure client presentation: the phase is computed from the
browser clock against the authoritative UTC windows published at
[`api-docs.deepseek.com/quick_start/pricing/`](https://api-docs.deepseek.com/quick_start/pricing/).

| Phase    | Color  | What it means |
| -------- | ------ | ------------- |
| `PEAK`     | red    | 2× surcharge. 01:00–04:00 and 06:00–10:00 UTC. |
| `OFF-PEAK` | green  | 0.5× baseline. All other UTC hours. |
| `FLAT`     | amber  | Pre-cutover window before 2026-08-16 16:00 UTC. |

The card lives in `conversation.input.dock` at order 5, so it sits
above the composer and below the goal bar (order 10). The card updates
once per second; no host round-trip, no projection, no session event.

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

## Model Experience

### Request context and condition

#### What the model sees

None, as this package contributes no model-facing tool, prompt section, or
session event. The widget renders purely in the client's React tree.

#### Token effect

Zero-direct token effect. The widget never appears in a model request.

#### KV Cache effect

Independent behavior. No shared prefix; the package is not part of the
assembled request.

## Known Limitations and Deferred Work

- **Browser-clock dependency** — the widget trusts the user's local
  system clock against UTC windows. A user with a mis-set clock will see
  a misleading status. A future iteration could expose a `useEffect`
  fetch of `worldtimeapi.org` for a sanity check.
- **No host-side snapshot service** — there is intentionally no
  `ctx.peakHours` service for cross-plugin use. The next iteration can
  add one if a session-event consumer or a non-React host view needs
  the same data.
