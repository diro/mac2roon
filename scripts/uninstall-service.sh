#!/usr/bin/env bash
# Stop and remove the mac2roon LaunchAgent.
set -euo pipefail
LABEL="com.diro.mac2roon"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed ${LABEL} and $PLIST"
