#!/usr/bin/env bash
# uninstall.sh — remove the DeepSeek V4 peak/off-peak plugin from a local
# deepseek-harness clone. Idempotent: removes what it can, leaves the
# rest alone, and tells you which wire-up points you still need to
# touch by hand (the harness's strict monorepo gates don't love sed
# edits to patches at scale).
#
# Usage:
#   ./uninstall.sh /path/to/deepseek-harness

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <harness-root>" >&2
  exit 2
fi

HARNESS_ROOT="$1"
PLUGIN_DST="$HARNESS_ROOT/packages/client/ui-peak-hours"

if [[ -d "$PLUGIN_DST" ]]; then
  echo "==> removing $PLUGIN_DST"
  rm -rf "$PLUGIN_DST"
else
  echo "==> $PLUGIN_DST not present, skipping"
fi

# Note: we don't try to roll back the cordis.patch.yml / package.json /
# tsconfig edits — those touch the user's local harness tree and a
# blind sed could clobber unrelated lines. The wire-up entries are
# small and easy to delete by hand if you want a clean revert:
#
#   packages/bundle/web-app/cordis.patch.yml :
#     remove the - id: ui-peak-hours block (4 lines including the comment)
#
#   packages/bundle/web-app/package.json :
#     remove "@deepseek-ai/dsh-client-ui-peak-hours": "workspace:^"
#
#   tsconfig.client.json :
#     remove { "path": "./packages/client/ui-peak-hours" }
#
#   tsconfig.base.json :
#     remove "@deepseek-ai/dsh-client-ui-peak-hours": ["./packages/client/ui-peak-hours/src"]
#
# Then run: pnpm install && pnpm run build

echo
echo "==> done. to fully revert, manually remove the 4 wire-up entries listed in this script."
