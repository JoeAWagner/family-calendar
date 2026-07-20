#!/usr/bin/env bash
# Installs the LD2450 mmWave presence service (radar.py) on the Pi.
#
#   Wiring (LD2450 -> Pi):
#     VCC  -> 5V   (pin 2 or 4)
#     GND  -> GND  (pin 6)
#     TX   -> GPIO15 / RXD  (pin 10)
#     RX   -> GPIO14 / TXD  (pin 8)
#   (Or use a USB-TTL adapter and set RADAR_PORT=/dev/ttyUSB0 below.)
#
# Usage:  ./setup-radar.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE=/etc/systemd/system/familycal-radar.service
TARGET_USER="${SUDO_USER:-$USER}"

# Prefer a USB-TTL adapter if one is plugged in (safer + clearly labelled pins);
# otherwise fall back to the GPIO UART. Override with: RADAR_PORT=... ./setup-radar.sh
if [ -z "${RADAR_PORT:-}" ]; then
  if   [ -e /dev/ttyUSB0 ]; then RADAR_PORT=/dev/ttyUSB0
  elif [ -e /dev/ttyACM0 ]; then RADAR_PORT=/dev/ttyACM0
  else                           RADAR_PORT=/dev/serial0
  fi
fi
case "$RADAR_PORT" in /dev/ttyUSB*|/dev/ttyACM*) USING_USB=1 ;; *) USING_USB=0 ;; esac

echo "== Family Calendar radar setup =="
echo "   app dir : $APP_DIR"
echo "   user    : $TARGET_USER"
echo "   port    : $RADAR_PORT"
echo ""

echo "==> Installing pyserial + wlr-randr (for display power-off)…"
sudo apt-get update -qq
sudo apt-get install -y python3-serial wlr-randr >/dev/null

if [ "$USING_USB" -eq 1 ]; then
  echo "==> Using a USB-TTL adapter ($RADAR_PORT) — skipping GPIO UART setup."
else
  echo "==> Enabling the GPIO UART and freeing it from the serial console…"
  sudo raspi-config nonint do_serial_hw 0   2>/dev/null || true  # UART on
  sudo raspi-config nonint do_serial_cons 1 2>/dev/null || true  # console off
fi
sudo usermod -aG dialout "$TARGET_USER" || true   # needed for serial access either way

echo "==> Writing $SERVICE…"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=Family Calendar mmWave presence (LD2450)
After=familycal.service
Wants=familycal.service

[Service]
Type=simple
User=$TARGET_USER
SupplementaryGroups=dialout
WorkingDirectory=$APP_DIR
# Leave blank to auto-detect (survives swapping/replugging the USB adapter).
# Set a specific path here only if you have more than one serial device.
Environment=RADAR_PORT=
Environment=APP_URL=http://localhost:3000
# Zone tuning (mm / seconds)
Environment=RADAR_NEAR_MM=610
Environment=RADAR_NEAR_EXIT_MM=760
Environment=RADAR_ENGAGE_DWELL_S=2.0
Environment=RADAR_EMPTY_AFTER_S=45
# So the display-power tools can reach the Wayland/X11 session
Environment=DISPLAY=:0
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$TARGET_USER")
ExecStart=/usr/bin/python3 $APP_DIR/radar.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Let the app restart this service (for the Settings "Reconnect sensor" button).
echo "$TARGET_USER ALL=(root) NOPASSWD: /bin/systemctl restart familycal-radar, /usr/bin/systemctl restart familycal-radar" \
  | sudo tee /etc/sudoers.d/familycal-radar >/dev/null
sudo chmod 440 /etc/sudoers.d/familycal-radar

sudo systemctl daemon-reload
sudo systemctl enable familycal-radar.service
sudo systemctl restart familycal-radar.service

echo ""
echo "== Done =="
echo "  A REBOOT is required (UART + dialout group)."
echo "    sudo reboot"
echo ""
echo "  After reboot, watch it live:"
echo "    journalctl -u familycal-radar -f"
echo "  You should see lines like:  -> engaged (nearest=540mm)"
echo ""
echo "  Tune the zones by editing $SERVICE (then: sudo systemctl daemon-reload"
echo "  && sudo systemctl restart familycal-radar)."
