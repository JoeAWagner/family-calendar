# Family Calendar

A wall-mounted touchscreen family calendar that syncs with Google Calendar.
Add/remove events at the device, plus a doodle board and a photo screensaver on idle.

Runs as a local web app that the Raspberry Pi shows fullscreen in Chromium (kiosk mode).

---

## Why Raspberry Pi (not ESP32)

For a 15"+ touchscreen with Google OAuth, a rich touch UI, a drawing canvas, and a
photo slideshow, a Pi is the right tool. An ESP32 can't drive a large HDMI panel,
run Chromium, or handle OAuth token refresh. Use the ESP32 for small TFT dashboards,
not this.

---

## Parts list

### Recommended build (~$180–260 depending on screen)

| Part | Notes | Approx. |
|------|-------|---------|
| **Raspberry Pi 4 Model B (4GB)** | The brain. Pi 5 also works; Pi 4 is lower-power and plenty. Avoid Pi Zero — Chromium at 1080p is sluggish. | $55 |
| **15.6" IPS touchscreen** | USB-C or HDMI + USB touch, 1920×1080, capacitive multitouch. Search "15.6 portable monitor touchscreen". Larger (21.5" touch monitor) works too. | $110–180 |
| **Official Pi USB-C power supply (5V/3A)** | Clean power avoids under-voltage. | $8 |
| **microSD card 32GB (A1/A2)** | For Raspberry Pi OS. | $8 |
| **HDMI + USB cables** | Often included with the monitor. Get a short HDMI if not. | $6 |
| **PIR motion sensor (HC-SR501)** *(optional)* | Wire to a GPIO to wake the screen when someone walks up — big power saver. | $3 |
| **Wall mount / frame** | VESA mount, a shadow-box picture frame, or a 3D-printed bezel. | varies |

### Power / "low power" notes
- Pi 4 idles around **3–4 W**; a 15.6" panel is **~8–12 W** — that's your main draw.
- Blank or dim the screen on idle (see kiosk setup) and/or wake on the PIR sensor.
- Total running cost is a few dollars a year. Leave it plugged in 24/7.

---

## 1. Google Cloud setup (one time, ~5 min)

1. Go to <https://console.cloud.google.com/> → create a project.
2. **APIs & Services → Library → enable "Google Calendar API".**
3. **APIs & Services → OAuth consent screen:** choose *External*, add your Google
   account as a **Test user** (this avoids the app-verification requirement).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/api/auth/callback`
5. Copy the **Client ID** and **Client secret**.

> Using a shared family calendar? In Google Calendar → the calendar's Settings →
> "Integrate calendar" → copy the **Calendar ID** and put it in `.env`.

---

## 2. App setup

```bash
# On the Pi (or your PC to test first)
cd "Family Calendar"
cp .env.example .env      # then edit .env with your Client ID/secret
npm install
npm start
```

Open `http://localhost:3000`, tap **Connect Google**, approve, done. The token is
saved to `token.json` and refreshes automatically — you only sign in once.

Drop `.jpg/.png` files into a `photos/` folder next to `server.js` for the screensaver.

---

## 3. Raspberry Pi kiosk setup

Install Raspberry Pi OS (64-bit). Then install Chromium and a **modern Node**:

```bash
# NOTE: fonts-noto-color-emoji is REQUIRED — the UI's icons are emoji, and a
# fresh Pi OS ships without a color-emoji font (they'd show as blank boxes).
sudo apt update && sudo apt install -y chromium-browser unclutter fonts-noto-color-emoji
fc-cache -f   # then restart Chromium / reboot so the emoji font is picked up

# This app needs Node 18+ (it uses global fetch). Do NOT rely on `apt install
# nodejs` — on Pi OS it can be a very old version. Use NodeSource instead:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should print v20.x (or at least v18)
```

> **On a Pi 3B (1 GB RAM):** prefer Raspberry Pi OS **Lite** + a minimal session
> (labwc/X) over the full desktop, run the panel at 1080p, and add zram swap. See
> the performance notes we discussed — the app is light; Chromium is the load.

### Run the app on boot (systemd)

Create `/etc/systemd/system/familycal.service`:

```ini
[Unit]
Description=Family Calendar server
After=network-online.target

[Service]
WorkingDirectory=/home/pi/family-calendar
ExecStart=/usr/bin/node server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now familycal
```

### Launch Chromium fullscreen on boot

Add to `~/.config/lxsession/LXDE-pi/autostart` (Bookworm: use a `~/.config/autostart/*.desktop` entry or `labwc` autostart):

```
@xset s off
@xset -dpms
@unclutter -idle 0.1
@chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito http://localhost:3000
```

### Screen power saving (recommended)
Instead of `xset -dpms`, let the screen sleep and wake it on motion. Simple version —
blank after 5 min of no input:

```
@xset s off
@xset +dpms
@xset dpms 0 0 300
```

For the PIR sensor wake, run a small Python script that calls
`xset dpms force on` when GPIO goes high. Ask me and I'll add `motion-wake.py`.

**Brightness schedule:** the app includes a built-in *software* dimmer that darkens
the screen in the evening/overnight (a subtle overlay — no config needed). For true
**backlight** control on a DSI/official touchscreen, install `rpi-backlight` and have
a cron job set the brightness by time of day; that dims the actual LEDs (more power
saving) rather than overlaying black.

---

## Features / how it works

- **Agenda + Week + Month views** — synced from Google, refreshed every 2 min.
  Bright, family-friendly theme with big touch targets.
- **Color-coded events** — each event gets a stable pastel color from its title,
  so recurring items keep the same color across all views.
- **Weather** — current conditions in the header, plus a **per-day forecast** shown
  on the Agenda day headers and Week columns (7-day, via Open-Meteo — free, no API
  key). Set `WEATHER_LAT` / `WEATHER_LON` / `TEMP_UNIT` in `.env`. Cached 15 min.
- **Add / edit / delete** — tap ＋ Add, or tap any event. Writes straight to Google.
- **Reminders lists (Shopping, Costco, …)** — shared **Apple Reminders** lists via
  iCloud CalDAV, with a chip selector to switch between them. Tap to check off or add
  items; changes sync back to everyone's phones. Set `ICLOUD_APPLE_ID` (list owner),
  an app-specific password `ICLOUD_APP_PASSWORD` (from appleid.apple.com), and a
  comma-separated `REMINDERS_LISTS=Shopping,Costco` in `.env`. Apple has no public
  Reminders API — CalDAV is the supported path, and works most reliably when you
  connect with the Apple ID that *owns* the lists.
- **On-screen keyboard** — a built-in touch keyboard (kiosk Chromium has no native
  one) that pops up for any text field, so you can type at the wall without hardware.
- **Doodle board** — finger-paint canvas with colors + eraser.
- **Photo screensaver** — after `IDLE_MINUTES` of no touch, cycles photos with a
  clock, current weather, next event, and a mini forecast. Any touch dismisses it;
  the 💤 button opens it on demand. Photos come from local files in `./photos`
  **and/or an iCloud Shared Album**: in Apple Photos, open the shared album → People
  tab → enable **Public Website**, copy the link, and put it in `ICLOUD_ALBUM`.
  New photos anyone adds appear automatically (refreshed every 30 min).

## Roadmap ideas
- Per-person color coding (multiple overlaid Google calendars)
- Chore/reward stars, shared shopping list
- Persist doodles / send doodle to a phone
- PIR motion wake script

---

## Files
- `server.js` — Express server: Google OAuth, events API, photos.
- `public/index.html` / `style.css` / `app.js` — the touch UI.
- `.env` — your secrets (never commit it).
- `token.json` — saved Google token (auto-created; never commit it).
