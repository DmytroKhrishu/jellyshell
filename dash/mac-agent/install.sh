#!/bin/bash
# Build + sign + (re)install XboxDashAgent on the Mac. Run ON the Mac from this directory.
set -euo pipefail
cd "$(dirname "$0")"
APP="$HOME/Applications/XboxDashAgent.app"
LABEL="${LABEL:-app.jellyshell.dash-agent}" # launchd label + bundle id (override to keep an existing install's label)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
IDENTITY="${IDENTITY:--}" # ad-hoc: keychain is locked over SSH. NOTE: a rebuild changes the cdhash -> Calendar prompt again

swiftc -O -o XboxDashAgent main.swift
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
cp XboxDashAgent "$APP/Contents/MacOS/"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleName</key><string>Xbox Dash Agent</string>
  <key>CFBundleExecutable</key><string>XboxDashAgent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Shows your upcoming events and meeting alerts on the Xbox dashboard.</string>
</dict></plist>
EOF
codesign --force --sign "$IDENTITY" --identifier "$LABEL" "$APP"

mkdir -p "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/XboxDashAgent</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/xbox-dash-agent.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/xbox-dash-agent.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $APP, agent $LABEL loaded"
