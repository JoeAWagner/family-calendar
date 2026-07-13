#!/usr/bin/env bash
# One-shot installer for a Raspberry Pi: runs the Family Calendar server as a
# systemd service and launches it fullscreen in Chromium on boot.
#
# Usage (from the project folder on the Pi):   ./setup-kiosk.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE=/etc/systemd/system/familycal.service

# The real login user, even when this script is run under sudo.
TARGET_USER="${SUDO_USER:-$USER}"
USER_HOME="$(eval echo "~$TARGET_USER")"

echo "== Family Calendar kiosk setup =="
echo "   app dir : $APP_DIR"
echo "   user    : $TARGET_USER"
echo ""

command -v systemctl >/dev/null 2>&1 || { echo "!! Needs a systemd Linux (Raspberry Pi OS). Aborting."; exit 1; }

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "!! Node.js not found. Install Node 18+ first (see README section 3)."; exit 1; }

if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No .env found in $APP_DIR."
  echo "   Copy .env.example to .env and fill it in (and copy token.json from wherever"
  echo "   you first ran 'Connect Google') before starting the kiosk. Continuing anyway…"
  echo ""
fi

echo "==> Installing packages (chromium, emoji font, unclutter)…"
sudo apt-get update -qq
sudo apt-get install -y chromium-browser unclutter fonts-noto-color-emoji curl >/dev/null
fc-cache -f >/dev/null 2>&1 || true

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "==> Installing app dependencies (npm install)…"
  ( cd "$APP_DIR" && npm install --omit=dev )
fi

echo "==> Writing systemd service $SERVICE…"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=Family Calendar server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now familycal.service

echo "==> Disabling screen blanking…"
sudo raspi-config nonint do_blanking 1 2>/dev/null || echo "   (raspi-config missing; kiosk.sh falls back to xset)"

echo "==> Installing kiosk autostart entry…"
chmod +x "$APP_DIR/kiosk.sh"
AUTOSTART_DIR="$USER_HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat > "$AUTOSTART_DIR/familycal-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Calendar Kiosk
Exec=$APP_DIR/kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
sudo chown -R "$TARGET_USER":"$TARGET_USER" "$AUTOSTART_DIR" 2>/dev/null || true

echo ""
echo "== Done =="
echo "  Server:   sudo systemctl status familycal   (logs: journalctl -u familycal -f)"
echo "  Kiosk:    reboot to launch it  ->  sudo reboot"
echo ""
echo "  If Google isn't connected yet, open http://localhost:3000 once (keyboard"
echo "  attached) and tap 'Connect Google', or copy token.json from your PC into"
echo "  $APP_DIR."
