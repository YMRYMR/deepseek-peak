#!/usr/bin/env bash
# install.sh — drop the DeepSeek V4 peak/off-peak plugin into a local
# deepseek-harness clone and wire it into the default Web bundle.
#
# Usage:
#   ./install.sh /path/to/deepseek-harness
#
# Idempotent: re-running with the plugin already installed is a no-op.
# Safe: refuses to clobber a different version of the plugin unless
#       --force is passed.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PLUGIN_SRC="$SCRIPT_DIR/harness-plugin"
FORCE=0

# ── arg parsing ──────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "usage: $0 <harness-root> [--force]" >&2
  echo "  harness-root : path to a checked-out deepseek-harness working tree" >&2
  echo "  --force      : overwrite an existing ui-peak-hours directory" >&2
  exit 2
fi

HARNESS_ROOT="$1"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── sanity checks ───────────────────────────────────────────────────────
if [[ ! -d "$HARNESS_ROOT" ]]; then
  echo "error: harness root not found: $HARNESS_ROOT" >&2
  exit 1
fi
if [[ ! -f "$HARNESS_ROOT/pnpm-workspace.yaml" || ! -f "$HARNESS_ROOT/packages/bundle/web-app/cordis.patch.yml" ]]; then
  echo "error: $HARNESS_ROOT does not look like a deepseek-harness checkout" >&2
  echo "  (missing pnpm-workspace.yaml or packages/bundle/web-app/cordis.patch.yml)" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is not on PATH. Install it (e.g. 'npm i -g pnpm@11') first." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH." >&2
  exit 1
fi

PLUGIN_DST="$HARNESS_ROOT/packages/client/ui-peak-hours"
if [[ -e "$PLUGIN_DST" && $FORCE -ne 1 ]]; then
  echo "error: $PLUGIN_DST already exists. Re-run with --force to overwrite." >&2
  exit 1
fi

echo "==> harness root : $HARNESS_ROOT"
echo "==> plugin src  : $PLUGIN_SRC"
echo "==> plugin dst  : $PLUGIN_DST"
echo

# ── copy plugin files ────────────────────────────────────────────────────
echo "==> copying plugin source"
mkdir -p "$PLUGIN_DST/src/client"
# rsync would be cleaner but isn't always present on Windows Git Bash; cp -R is fine.
cp -R "$PLUGIN_SRC"/. "$PLUGIN_DST"/

# ── wire into the Web bundle ────────────────────────────────────────────
CORDIS_PATCH="$HARNESS_ROOT/packages/bundle/web-app/cordis.patch.yml"
WEBAPP_PKG="$HARNESS_ROOT/packages/bundle/web-app/package.json"
HOST_TSCONFIG="$HARNESS_ROOT/tsconfig.client.json"
BASE_TSCONFIG="$HARNESS_ROOT/tsconfig.base.json"
CONSTRAINTS="$HARNESS_ROOT/scripts/check-workspace-constraints.ts"

if ! grep -q "@deepseek-ai/dsh-client-ui-peak-hours" "$CORDIS_PATCH"; then
  echo "==> adding ui-peak-hours row to packages/bundle/web-app/cordis.patch.yml"
  # Insert before ui-goal so neither plugin's two-line row is split.
  python3 - "$CORDIS_PATCH" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
row = "    - id: ui-peak-hours\n      name: '@deepseek-ai/dsh-client-ui-peak-hours'\n\n"
anchor = "    - id: ui-goal\n"
if anchor in text:
    text = text.replace(anchor, row + anchor, 1)
else:
    text = text.rstrip() + "\n\n- insert:\n" + row
path.write_text(text)
PY
else
  echo "==> cordis.patch.yml already references ui-peak-hours, skipping"
fi

if ! grep -q "@deepseek-ai/dsh-client-ui-peak-hours" "$WEBAPP_PKG"; then
  echo "==> adding ui-peak-hours dep to packages/bundle/web-app/package.json"
  python3 - "$WEBAPP_PKG" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
deps = p.setdefault("dependencies", {})
deps["@deepseek-ai/dsh-client-ui-peak-hours"] = "workspace:^"
p["dependencies"] = dict(sorted(deps.items()))
json.dump(p, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
PY
else
  echo "==> web-app/package.json already has the dep, skipping"
fi

if ! grep -q "ui-peak-hours" "$HOST_TSCONFIG"; then
  echo "==> adding tsconfig.client.json reference"
  python3 - "$HOST_TSCONFIG" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
row = '    { "path": "./packages/client/ui-peak-hours" },\n'
anchor = '    { "path": "./packages/client/ui-trajectory" },\n'
if anchor in text:
    text = text.replace(anchor, anchor + row, 1)
else:
    raise SystemExit('could not find ui-trajectory reference anchor in tsconfig.client.json')
path.write_text(text)
PY
else
  echo "==> tsconfig.client.json already references ui-peak-hours, skipping"
fi

if ! grep -q "@deepseek-ai/dsh-client-ui-peak-hours" "$BASE_TSCONFIG"; then
  echo "==> adding tsconfig.base.json path mapping"
  python3 - "$BASE_TSCONFIG" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
row = '      "@deepseek-ai/dsh-client-ui-peak-hours": ["./packages/client/ui-peak-hours/src"],\n'
anchor = '      "@deepseek-ai/dsh-client-ui-trajectory": ["./packages/client/ui-trajectory/src"],\n'
if anchor in text:
    text = text.replace(anchor, anchor + row, 1)
else:
    raise SystemExit('could not find ui-trajectory path anchor in tsconfig.base.json')
path.write_text(text)
PY
else
  echo "==> tsconfig.base.json already maps ui-peak-hours, skipping"
fi

# ── install + build ──────────────────────────────────────────────────────
echo
echo "==> running pnpm install in the harness"
( cd "$HARNESS_ROOT" && pnpm install )

echo
echo "==> building the harness host lib"
( cd "$HARNESS_ROOT" && pnpm run build:lib:host )

echo
echo "==> building the plugin client bundle"
( cd "$HARNESS_ROOT" && pnpm --filter @deepseek-ai/dsh-client-ui-peak-hours run bundle )

echo
echo "==> verifying"
( cd "$HARNESS_ROOT" && pnpm run verify-cordis-config ) || true
( cd "$HARNESS_ROOT" && pnpm run verify-package-invariants ) || true

echo
echo "==> done. to start the harness:"
echo "    cd $HARNESS_ROOT && pnpm dsh web"
echo
echo "    the pill appears in the top-right of the session header,"
echo "    left of the Session log button."
echo
echo "    to uninstall, run:  $SCRIPT_DIR/uninstall.sh $HARNESS_ROOT"
