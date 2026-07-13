#!/usr/bin/env bash
# Launches the Family Calendar in a fullscreen Chromium kiosk once the app server
# is up. Wired to run on login by setup-kiosk.sh (XDG autostart).
set -u
URL="http://localhost:3000"

# Wait for the app server to answer (systemd starts it independently).
for _ in $(seq 1 60); do
  if curl -sf "$URL/api/config" >/dev/null 2>&1; then break; fi
  sleep 2
done

# Keep the screen awake on X11 sessions (Wayland is handled via raspi-config).
xset s off        2>/dev/null || true
xset -dpms        2>/dev/null || true
xset s noblank    2>/dev/null || true

# Hide the mouse cursor when idle (X11 helper; harmless if absent).
command -v unclutter >/dev/null 2>&1 && unclutter -idle 0.5 -root &

# Use whichever Chromium binary this Pi OS ships.
CHROME="$(command -v chromium-browser || command -v chromium || echo chromium-browser)"

exec "$CHROME" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --incognito \
  "$URL"
