#!/usr/bin/env bash
# Install mac2roon as a per-user LaunchAgent.
# Run this from Terminal AFTER you've granted the Automation (Music.app) prompt
# once via `npm start`, so launchd inherits the permission.
set -euo pipefail

LABEL="com.diro.mac2roon"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Make sure ffmpeg/sox (Homebrew) are on PATH for the agent.
BREW_BIN="$(dirname "$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)")"
# iTunes storefront for the artwork fallback (override: ITUNES_COUNTRY=TW ./install-service.sh)
ITUNES_COUNTRY="${ITUNES_COUNTRY:-US}"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH"; exit 1; fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${PROJECT_DIR}/src/index.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${BREW_BIN}:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>LOG_LEVEL</key>
        <string>info</string>
        <key>ITUNES_COUNTRY</key>
        <string>${ITUNES_COUNTRY}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/mac2roon.out</string>
    <key>StandardErrorPath</key>
    <string>/tmp/mac2roon.err</string>
</dict>
</plist>
PLISTEOF

echo "Wrote $PLIST"
# bootout first (ignore errors), then bootstrap for a clean reload.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
echo "Loaded ${LABEL}. Logs: /tmp/mac2roon.out  /tmp/mac2roon.err"
echo "Check: launchctl list | grep mac2roon"
