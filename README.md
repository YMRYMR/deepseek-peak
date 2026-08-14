# deepseek-peak

A small live widget that shows whether the **DeepSeek V4 API** is currently
in **peak (2×)** or **off-peak** pricing, with a countdown to the next
phase change.

> Source of truth: [`api-docs.deepseek.com/quick_start/pricing/`](https://api-docs.deepseek.com/quick_start/pricing/)
>
> Peak hours: **01:00–04:00 UTC** and **06:00–10:00 UTC** (everything else
> is off-peak). Effective **2026-08-16 16:00 UTC**. Peak rates are 2× the
> off-peak baseline.

This repo ships two things:

1. **`harness-plugin/`** — a `dsh-plugin` Cordis client package for the
   [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
   web UI. Renders a compact status pill in the session header (left of
   the Session log button). This is the real integration.

2. **`widget.html`** + **`serve.js`** — a self-contained browser widget
   you can pin as a tab in any browser, no harness required. Useful as a
   fallback or for users who don't run the harness.

The standalone widget is the simpler thing; the harness plugin is the
"always visible inside the harness UI" experience.

## Install (harness plugin)

Requires:
- A checked-out `deepseek-harness` working tree (any recent commit)
- `node` ≥ 22.19
- `pnpm` ≥ 11 (install once with `npm i -g pnpm`)

```sh
# Clone this repo
git clone https://github.com/YMRYMR/deepseek-peak.git
cd deepseek-peak

# One-liner installer: takes your harness clone as the argument
./install.sh /path/to/deepseek-harness
```

What the installer does (each step is idempotent and skipped if already done):

1. Copies `harness-plugin/` → `<harness>/packages/client/ui-peak-hours/`
2. Adds the `ui-peak-hours` row to `packages/bundle/web-app/cordis.patch.yml`
3. Adds the workspace dep to `packages/bundle/web-app/package.json`
4. Adds the project reference to `tsconfig.client.json`
5. Adds the path mapping to `tsconfig.base.json`
6. Runs `pnpm install` in the harness
7. Runs `pnpm run build:lib:host` (required for the generated Typert contracts)
8. Runs `pnpm --filter @deepseek-ai/dsh-client-ui-peak-hours run bundle`
9. Runs the harness verification gates (warnings only)

Then start the harness:
```sh
cd /path/to/deepseek-harness
pnpm dsh web
```

Open `http://127.0.0.1:3080/`. The pill appears in the top-right of the
session header, **left of the Session log button**.

Hard-refresh the browser (Ctrl+Shift+R) the first time so the new
`__DSH_BOOT__` roster loads.

### What you should see

`● OFF-PEAK pre-cutover 51h 44m → live`

- A compact pill, ~180 px wide
- Green when off-peak, red when peak
- The `pre-cutover` badge stays for the ~52 hours before 2026-08-16
  16:00 UTC, then disappears when the new pricing actually kicks in
- The countdown ticks down once per second
- Hover the pill for a tooltip with the full schedule detail

### Uninstall

```sh
./uninstall.sh /path/to/deepseek-harness
```

The script removes the plugin directory and prints the four small
wire-up entries you need to delete by hand (one line each in
`cordis.patch.yml`, `package.json`, and the two tsconfig files).

## Install (standalone widget)

No harness needed. Just a Node server that serves a static HTML page.

```sh
cd deepseek-peak
node serve.js
```

Opens `http://127.0.0.1:3737/` in your default browser. Pin the tab.
Press Ctrl+C in the terminal to stop.

The standalone widget includes a 24-hour timeline of peak windows, a
V4-Flash / V4-Pro model selector, and the actual $/1M-token rate for
each tier. Useful on a screen that doesn't have the harness open.

## Why a plugin AND a standalone

The harness pill is the right answer inside the harness. The standalone
is the right answer everywhere else (a second monitor, a tablet, a
phone browser). Both compute the same numbers from the same
authoritative schedule, so they never disagree.

## Verified

The plugin passes every harness gate I could run on a Windows dev tree:

| Check | Result |
| --- | --- |
| `pnpm run constraints` | 220/220 packages conform |
| `pnpm run verify-cordis-config` | 120/120 config files passed |
| `pnpm run verify-package-invariants` | 220/220 hand-owned companions conform |
| `tsc -b tsconfig.client.json` | clean |
| `pnpm --filter ... run bundle` | 8.6 kB `client.js` |
| `pnpm run build` (host + client + web) | clean |
| Live runtime smoke (curl `/plugins/.../client.js`) | 200, 8.6 kB, slot registered |

## What the source layout looks like

```
deepseek-peak/
├── README.md               # this file
├── LICENSE                 # MIT
├── .gitignore
├── install.sh              # one-line installer for the harness plugin
├── uninstall.sh            # rollback helper
├── package.json            # standalone-widget package
├── serve.js                # standalone-widget Node server
├── smoke.js                # standalone-widget self-test (5/5 passes)
├── widget.html             # the standalone widget
└── harness-plugin/         # the in-harness plugin (copied to a harness
                            #   clone by install.sh)
    ├── package.json
    ├── tsconfig.json
    ├── tsdown.config.ts
    ├── README.md
    └── src/
        ├── index.ts
        ├── invariant.ts
        ├── css-modules.d.ts
        └── client/
            ├── index.ts                # browser apply() — registers the pill
            ├── domain.ts               # pure peak/off-peak math
            ├── PeakHoursPill.tsx       # the React component
            ├── PeakHoursPill.module.css
            ├── PeakHoursDock.tsx       # legacy input.dock variant, kept for
            │                            #   reference; the current pill lives
            │                            #   in the session header instead
            └── PeakHoursDock.module.css
```

## Notes

- The schedule is fixed in `src/client/domain.ts`. If DeepSeek changes
  the windows or the cutover date, edit the constants there and
  re-bundle.
- All times are computed in UTC; only the display is localized to
  the browser's IANA zone.
- The pill trusts the browser clock against the baked-in UTC
  schedule. A user with a mis-set system clock will see a misleading
  status. A future iteration can sanity-check via
  `worldtimeapi.org`.

## License

MIT. See [LICENSE](./LICENSE).
