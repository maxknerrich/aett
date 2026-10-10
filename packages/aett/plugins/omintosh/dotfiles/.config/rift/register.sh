#!/bin/bash
set -o errexit
set -o nounset
set -o pipefail


RIFT_CLI=/opt/homebrew/bin/rift-cli
WORKSPACE_COMMAND="$HOME/.config/sketchybar/plugins/workspace.sh"
# v0.5.10 runs run_on_start before opening its CLI server. A display can
# temporarily have no active space; subscriptions must still be installed.
for ((attempt = 0; attempt < 40; attempt++)); do
  if "$RIFT_CLI" query workspaces >/dev/null 2>&1; then
    "$RIFT_CLI" subscribe cli --event workspace_changed --command "$WORKSPACE_COMMAND"
    "$RIFT_CLI" subscribe cli --event windows_changed --command "$WORKSPACE_COMMAND"
    "$WORKSPACE_COMMAND"
    exit 0
  fi
  /bin/sleep 0.5
done
echo 'Rift CLI/workspaces unavailable after 20s; workspace bar subscription not installed' >&2
exit 1


