#!/bin/sh
# Enable Antigravity's local debugging port (--remote-debugging-port=0).
#
# Antigravity 2.3x deletes DevToolsActivePort unless the app is started with
# the switch, which disables CDP-based plugins such as agy-usage.
#
# Usage:
#   ./scripts/enable-cdp.sh             # create the launcher (macOS) / print the command
#   ./scripts/enable-cdp.sh --relaunch  # quit Antigravity and reopen it with the switch
#   ./scripts/enable-cdp.sh --undo      # remove the launcher
set -eu

LAUNCHER="$HOME/Applications/Antigravity-CDP.app"

create_launcher() {
  mkdir -p "$LAUNCHER/Contents/MacOS" "$LAUNCHER/Contents/Resources"
  cat > "$LAUNCHER/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>local.agy-usage.antigravity-cdp</string>
  <key>CFBundleName</key><string>Antigravity-CDP</string>
  <key>CFBundleDisplayName</key><string>Antigravity-CDP</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
  cat > "$LAUNCHER/Contents/MacOS/launcher" <<'SH'
#!/bin/sh
open -b com.google.antigravity --args --remote-debugging-port=0 2>/dev/null ||
  open -a "Antigravity" --args --remote-debugging-port=0
SH
  chmod +x "$LAUNCHER/Contents/MacOS/launcher"
  for icon in icon.icns electron.icns app.icns; do
    if [ -f "/Applications/Antigravity.app/Contents/Resources/$icon" ]; then
      cp "/Applications/Antigravity.app/Contents/Resources/$icon" "$LAUNCHER/Contents/Resources/AppIcon.icns" || true
      break
    fi
  done
  touch "$LAUNCHER"
  /usr/bin/codesign --force --sign - "$LAUNCHER" >/dev/null 2>&1 || true
  echo "Created $LAUNCHER"
  echo "Quit Antigravity (Cmd+Q) and open it from this launcher from now on."
}

relaunch() {
  osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
  i=0
  while pgrep -x Antigravity >/dev/null 2>&1 && [ "$i" -lt 60 ]; do
    sleep 0.25
    i=$((i + 1))
  done
  if pgrep -x Antigravity >/dev/null 2>&1; then
    echo "Antigravity is still running; quit it manually and open the launcher." >&2
    exit 1
  fi
  open -b com.google.antigravity --args --remote-debugging-port=0 2>/dev/null ||
    open -a "Antigravity" --args --remote-debugging-port=0
  sleep 1
  cat "$HOME/Library/Application Support/Antigravity/DevToolsActivePort" 2>/dev/null | head -1 ||
    echo "DevToolsActivePort not written yet; give it a couple of seconds." >&2
}

case "$(uname -s)" in
  Darwin)
    case "${1:-}" in
      --undo) rm -rf "$LAUNCHER"; echo "Removed $LAUNCHER" ;;
      --relaunch) create_launcher; relaunch ;;
      *) create_launcher ;;
    esac
    ;;
  Linux)
    echo "Run Antigravity with: antigravity --remote-debugging-port=0"
    echo "Port file: \${XDG_CONFIG_HOME:-~/.config}/Antigravity/DevToolsActivePort"
    ;;
  *)
    echo "Use the Antigravity shortcut with --remote-debugging-port=0 appended to the target." >&2
    exit 1
    ;;
esac
