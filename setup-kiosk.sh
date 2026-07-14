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

if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No .env found in $APP_DIR."
  echo "   Copy .env.example to .env and fill it in (and copy token.json from wherever"
  echo "   you first ran 'Connect Google') before starting the kiosk. Continuing anyway…"
  echo ""
fi

echo "==> Installing packages (chromium, emoji font, unclutter)…"
sudo apt-get update -qq
sudo apt-get install -y chromium-browser unclutter fonts-noto-color-emoji curl ca-certificates >/dev/null
fc-cache -f >/dev/null 2>&1 || true

# The app needs Node 18+ (global fetch). Raspberry Pi OS's apt Node is often far
# older, so install from NodeSource when it's missing or too old.
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "==> Installing Node 20 (found: ${NODE_MAJOR:-none}, need 18+)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "    node $(node -v) at $NODE_BIN"

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

echo "==> Installing daily auto-update timer…"
chmod +x "$APP_DIR/update.sh"
# Let the update job restart the service without a password prompt.
echo "$TARGET_USER ALL=(root) NOPASSWD: /bin/systemctl restart familycal, /usr/bin/systemctl restart familycal" \
  | sudo tee /etc/sudoers.d/familycal >/dev/null
sudo chmod 440 /etc/sudoers.d/familycal
sudo tee /etc/systemd/system/familycal-update.service >/dev/null <<EOF
[Unit]
Description=Family Calendar auto-update (git pull + restart)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$TARGET_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/update.sh
EOF
sudo tee /etc/systemd/system/familycal-update.timer >/dev/null <<EOF
[Unit]
Description=Run Family Calendar auto-update daily

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now familycal-update.timer

echo ""
echo "== Done =="
echo "  Server:   sudo systemctl status familycal   (logs: journalctl -u familycal -f)"
echo "  Kiosk:    reboot to launch it  ->  sudo reboot"
echo "  Update:   daily at 04:00 (only if this repo has a GitHub 'origin' remote)"
echo "            run now with:  ./update.sh"
echo ""
echo "  If Google isn't connected yet, open http://localhost:3000 once (keyboard"
echo "  attached) and tap 'Connect Google', or copy token.json from your PC into"
echo "  $APP_DIR."
