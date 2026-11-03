#!/bin/bash
# Run the debug build as a real .app so lcu can attach, with the MCP bridge still on.
#   lcu-wrap.sh up [dev.log]   # after `pnpm dev:app` built once and was stopped
#   lcu-wrap.sh down           # quit the wrapper app and its vite, delete the wrapper
# Prints the .app path to pass to cua.getApp(). State lives in /tmp/oi-verify/lcu/.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
STATE=/tmp/oi-verify/lcu
APP="$HOME/Applications/OpenIDEA-verify-$(basename "$ROOT").app"
cmd=${1:-}

case "$cmd" in
up)
  LOG=${2:-/tmp/oi-dev.log}
  ID=$(grep -oE '"identifier": "[^"]+"' "$LOG" | head -1 | cut -d'"' -f4)
  URL=$(grep -oE '"devUrl": "[^"]+"' "$LOG" | head -1 | cut -d'"' -f4)
  PORT=$(echo "$URL" | grep -oE '[0-9]+/?$' | tr -d /)
  [ -n "$ID" ] && [ -n "$PORT" ] || { echo "no identifier/devUrl in $LOG; run pnpm dev:app first" >&2; exit 1; }
  BIN="$ROOT/target/debug/openidea"
  [ -x "$BIN" ] || BIN="$ROOT/src-tauri/target/debug/openidea"
  [ -x "$BIN" ] || { echo "no debug binary; run pnpm dev:app first" >&2; exit 1; }
  if pgrep -f "^$BIN" >/dev/null; then echo "pnpm dev:app is still running; stop it first (single instance)" >&2; exit 1; fi
  mkdir -p "$STATE" "$APP/Contents/MacOS"
  cp "$BIN" "$APP/Contents/MacOS/openidea"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$ID</string>
<key>CFBundleExecutable</key><string>openidea</string>
<key>CFBundleName</key><string>OpenIDEA verify</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
</dict></plist>
PLIST
  codesign --force --sign - "$APP" >/dev/null 2>&1
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
  echo "$PORT" > "$STATE/vite.port"
  (cd "$ROOT" && nohup pnpm exec vite --port "$PORT" --strictPort > "$STATE/vite.log" 2>&1 &)
  for _ in $(seq 60); do curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" | grep -q 200 && break; sleep 1; done
  open -n "$APP"
  echo "$APP"
  ;;
down)
  pkill -f "^$APP/Contents/MacOS/openidea" || true
  # pnpm re-execs, so the launch pid is gone; match the vite we started by its port.
  [ -f "$STATE/vite.port" ] && { pkill -f "vite --port $(cat "$STATE/vite.port") --strictPort" || true; rm -f "$STATE/vite.port"; }
  rm -rf "$APP"
  ;;
*) echo "usage: lcu-wrap.sh up [dev.log] | down" >&2; exit 2 ;;
esac
