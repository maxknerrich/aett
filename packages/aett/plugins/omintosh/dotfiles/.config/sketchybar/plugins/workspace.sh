#!/bin/bash
set -o errexit
set -o nounset
set -o pipefail


RIFT_CLI=/opt/homebrew/bin/rift-cli
SKETCHYBAR=sketchybar
JQ=jq
ACTIVE_BACKGROUND=0x448b949e
ACTIVE_BORDER=0x998b949e
ACTIVE_TEXT=0xffe6edf3
INACTIVE_TEXT=0xff8b949e
# BSP returns membership order, not visual order. Prefer the leftmost tiled window.
workspaces="$("$RIFT_CLI" query workspaces)" || exit 0
while IFS=$'\t' read -r index active count app; do
  item="workspace.$((index + 1))"
  if [[ "$active" == true ]]; then
    background=(background.drawing=on "background.color=$ACTIVE_BACKGROUND" \
      "background.border_color=$ACTIVE_BORDER" background.border_width=1 \
      "icon.color=$ACTIVE_TEXT")
  else
    background=(background.drawing=off background.color=0x00000000 \
      background.border_width=0 "icon.color=$INACTIVE_TEXT")
  fi

  if ((count > 0)) && [[ -n "$app" ]]; then
    "$SKETCHYBAR" --set "$item" "${background[@]}" icon.drawing=off \
      "background.image=app.$app" background.image.scale=0.6 \
      background.image.padding_left=5 background.image.drawing=on background.drawing=on
  else
    "$SKETCHYBAR" --set "$item" "${background[@]}" \
      "icon=$((index + 1))" icon.drawing=on background.image.drawing=off
  fi
done < <(printf '%s\n' "$workspaces" | "$JQ" -r \
  '.[] | [.index, .is_active, .window_count, (.windows | sort_by([.is_floating, .frame.origin.x, .frame.origin.y]) | .[0].bundle_id // .[0].app_name // "")] | @tsv')


