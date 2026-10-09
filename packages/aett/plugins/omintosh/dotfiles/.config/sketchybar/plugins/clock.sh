#!/bin/bash
sketchybar --set "${NAME:-clock}" "label=$(/bin/date '+%a %d %b  %H:%M')"
