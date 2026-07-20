#!/usr/bin/env python3
"""
LD2450 mmWave presence -> Family Calendar wall.

States:
  empty    nobody detected for RADAR_EMPTY_AFTER_S   -> screen OFF
  present  someone detected beyond RADAR_NEAR_MM     -> screensaver
  engaged  someone lingering within RADAR_NEAR_MM    -> awake (agenda)

"Lingering" (dwell) is what separates someone standing at the wall from someone
walking past: a target must stay inside the near zone for RADAR_ENGAGE_DWELL_S.

Posts state changes to the app (/api/presence) and switches display power.
"""
import json
import math
import os
import subprocess
import time
import glob
import urllib.request

import serial

PORT = os.environ.get('RADAR_PORT', '')  # blank => auto-detect
BAUD = int(os.environ.get('RADAR_BAUD', '256000'))
APP = os.environ.get('APP_URL', 'http://localhost:3000')

NEAR_MM = int(os.environ.get('RADAR_NEAR_MM', '610'))            # 2 ft
NEAR_EXIT_MM = int(os.environ.get('RADAR_NEAR_EXIT_MM', '760'))  # hysteresis (2.5 ft)
ENGAGE_DWELL_S = float(os.environ.get('RADAR_ENGAGE_DWELL_S', '2.0'))
EMPTY_AFTER_S = float(os.environ.get('RADAR_EMPTY_AFTER_S', '45'))
HEARTBEAT_S = 1.0    # post presence (incl. live distance) at least this often
CONFIG_EVERY_S = 3.0  # re-read zone settings from the wall's Settings screen

HEADER = b'\xaa\xff\x03\x00'
TAIL = b'\x55\xcc'
FRAME_LEN = 30  # 4 header + 3 targets x 8 + 2 tail


def decode(raw):
    """LD2450 quirk: the MSB is a SIGN FLAG (1 = positive), not two's complement."""
    return (raw - 0x8000) if (raw & 0x8000) else -raw


def parse_targets(payload):
    """payload = 24 bytes (3 targets x 8). Returns only the occupied slots."""
    targets = []
    for i in range(3):
        b = payload[i * 8:(i + 1) * 8]
        x = decode(int.from_bytes(b[0:2], 'little'))      # mm
        y = decode(int.from_bytes(b[2:4], 'little'))      # mm
        speed = decode(int.from_bytes(b[4:6], 'little'))  # cm/s
        if x == 0 and y == 0:
            continue  # empty slot
        targets.append({'x': x, 'y': y, 'speed': speed, 'dist': math.hypot(x, y)})
    return targets


class Presence:
    """Turns a stream of radar targets into empty / present / engaged."""

    def __init__(self, near_mm=NEAR_MM, near_exit_mm=NEAR_EXIT_MM,
                 dwell_s=ENGAGE_DWELL_S, empty_after_s=EMPTY_AFTER_S):
        self.near_mm = near_mm
        self.near_exit_mm = near_exit_mm
        self.dwell_s = dwell_s
        self.empty_after_s = empty_after_s
        self.state = None
        self.last_seen = 0.0
        self.near_since = None

    def update(self, targets, now):
        """Returns (state, changed, nearest_mm)."""
        nearest = None
        if targets:
            self.last_seen = now
            nearest = min(t['dist'] for t in targets)

        if nearest is None:
            self.near_since = None
            if (now - self.last_seen) > self.empty_after_s:
                new = 'empty'
            else:
                # Grace period: brief dropouts shouldn't blank the screen.
                new = self.state if self.state in ('present', 'engaged') else 'present'
        else:
            # Hysteresis: once engaged, allow drifting a bit further before dropping.
            threshold = self.near_exit_mm if self.state == 'engaged' else self.near_mm
            if nearest <= threshold:
                if self.near_since is None:
                    self.near_since = now
                # The dwell requirement is what filters out people walking past.
                new = 'engaged' if (now - self.near_since) >= self.dwell_s else 'present'
            else:
                self.near_since = None
                new = 'present'

        changed = new != self.state
        self.state = new
        return new, changed, nearest


def fetch_config():
    """Pull the live zone settings the wall's Settings screen writes."""
    try:
        with urllib.request.urlopen(APP + '/api/radar/config', timeout=3) as r:
            return json.loads(r.read())
    except Exception:
        return None


def post_state(state, dist):
    body = json.dumps({
        'state': state,
        'distanceMm': None if dist is None else round(dist),
    }).encode()
    req = urllib.request.Request(
        APP + '/api/presence', data=body,
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception as e:  # the wall may still be booting — keep going
        print('post failed:', e, flush=True)


def _session_env():
    """Env a Wayland/X11 client needs when launched from a systemd service."""
    env = dict(os.environ)
    uid = os.getuid()
    xdg = env.get('XDG_RUNTIME_DIR') or f'/run/user/{uid}'
    env['XDG_RUNTIME_DIR'] = xdg
    if not env.get('WAYLAND_DISPLAY'):
        try:
            for f in sorted(os.listdir(xdg)):  # e.g. wayland-0 / wayland-1
                if f.startswith('wayland-') and not f.endswith('.lock'):
                    env['WAYLAND_DISPLAY'] = f
                    break
        except OSError:
            pass
    env.setdefault('DISPLAY', ':0')
    return env


def _wlr_outputs(env):
    """Output names from wlr-randr (labwc/wlroots), e.g. ['HDMI-A-1']."""
    try:
        out = subprocess.run(['wlr-randr'], capture_output=True, timeout=5,
                             text=True, env=env).stdout
        return [ln.split()[0] for ln in out.splitlines() if ln and not ln[0].isspace()]
    except Exception:
        return []


_dp_method = None  # remember what worked, so logs aren't noisy


def display_power(on):
    """Turn the display output on/off. On HDMI this makes the monitor sleep,
    which cuts its backlight — the app-blackout is only a last resort."""
    global _dp_method
    env = _session_env()
    word = 'on' if on else 'off'

    # 1) wlr-randr per output (the correct path on Pi 5 / Bookworm labwc).
    outs = _wlr_outputs(env)
    if outs:
        ok = True
        for name in outs:
            try:
                subprocess.run(['wlr-randr', '--output', name, '--' + word],
                               check=True, capture_output=True, timeout=5, env=env)
            except Exception:
                ok = False
        if ok:
            if _dp_method != 'wlr-randr':
                print(f"display {word} via wlr-randr {outs}", flush=True)
                _dp_method = 'wlr-randr'
            return True

    # 2) Fallbacks for other display stacks.
    for c in [['wlopm', '--' + word, '*'],
              ['vcgencmd', 'display_power', '1' if on else '0'],
              ['xset', 'dpms', 'force', word]]:
        try:
            subprocess.run(c, check=True, capture_output=True, timeout=5, env=env)
            if _dp_method != c[0]:
                print(f"display {word} via {c[0]}", flush=True)
                _dp_method = c[0]
            return True
        except Exception:
            continue

    print(f'WARN: no display-power method worked ({word}); app blacks out instead', flush=True)
    return False


def find_port():
    """Pick a serial port. Honour RADAR_PORT if it exists, else auto-detect —
    so swapping/replugging a USB-TTL adapter doesn't break the service."""
    if PORT and os.path.exists(PORT):
        return PORT
    if PORT:
        print(f'WARN: {PORT} not present — auto-detecting…', flush=True)
    # by-id paths are stable per adapter; prefer them, then plain nodes.
    for pattern in ('/dev/serial/by-id/*', '/dev/ttyUSB*', '/dev/ttyACM*', '/dev/serial0'):
        for p in sorted(glob.glob(pattern)):
            if os.path.exists(p):
                return p
    return None


def open_serial():
    """Block until a port is available and opens (survives unplug/replug)."""
    warned = False
    while True:
        p = find_port()
        if p:
            try:
                ser = serial.Serial(p, BAUD, timeout=1)
                print(f'LD2450 on {p} @ {BAUD}; near={NEAR_MM}mm dwell={ENGAGE_DWELL_S}s',
                      flush=True)
                return ser
            except Exception as e:
                print(f'WARN: could not open {p}: {e}', flush=True)
        elif not warned:
            print('WARN: no serial port found (checked /dev/serial/by-id, ttyUSB*, '
                  'ttyACM*, serial0). Is the USB-TTL adapter plugged in?', flush=True)
            warned = True
        time.sleep(3)


def main():
    ser = open_serial()

    buf = bytearray()
    presence = Presence()
    last_sent = 0.0

    # Diagnostics: a silent service is useless — say *why* nothing is happening.
    bytes_seen = 0
    last_data = time.time()
    last_frame = time.time()
    warned_nodata = False
    warned_noframe = False
    last_cfg = 0.0

    while True:
        try:
            chunk = ser.read(64)
        except Exception as e:  # adapter unplugged / port vanished — reopen
            print(f'WARN: serial read failed ({e}); reopening…', flush=True)
            try: ser.close()
            except Exception: pass
            ser = open_serial()
            buf.clear()
            continue
        now = time.time()

        # Live-tunable zones from the wall's Settings screen.
        if now - last_cfg > CONFIG_EVERY_S:
            last_cfg = now
            cfg = fetch_config()
            if cfg:
                presence.near_mm = cfg.get('nearMm', presence.near_mm)
                presence.near_exit_mm = cfg.get('nearExitMm', presence.near_exit_mm)
                presence.dwell_s = cfg.get('dwellS', presence.dwell_s)
                presence.empty_after_s = cfg.get('emptyAfterS', presence.empty_after_s)
        if chunk:
            buf.extend(chunk)
            bytes_seen += len(chunk)
            last_data = now
            warned_nodata = False
        if len(buf) > 4096:      # keep the buffer bounded
            del buf[:-1024]

        # Drain all complete frames; keep only the newest targets.
        targets = None
        while True:
            i = buf.find(HEADER)
            if i < 0 or len(buf) - i < FRAME_LEN:
                break
            frame = bytes(buf[i:i + FRAME_LEN])
            del buf[:i + FRAME_LEN]
            if frame[-2:] != TAIL:
                continue
            targets = parse_targets(frame[4:28])

        if targets is not None:
            last_frame = now
            warned_noframe = False
        else:
            if (now - last_data) > 5 and not warned_nodata:
                print(f'WARN: no bytes on {ser.port} for 5s. Check wiring: radar TX -> '
                      f'adapter RX (must cross over), radar RX -> adapter TX, and 5V power.',
                      flush=True)
                warned_nodata = True
            if bytes_seen and (now - last_frame) > 5 and not warned_noframe:
                sample = bytes(buf[:24]).hex(' ')
                print(f'WARN: got {bytes_seen} bytes but no valid LD2450 frames — wrong baud? '
                      f'(expect {BAUD}). Sample: {sample}', flush=True)
                warned_noframe = True
            continue  # no fresh frame yet

        state, changed, nearest = presence.update(targets, now)

        if changed:
            d = None if nearest is None else round(nearest)
            print(f'-> {state} (nearest={d}mm)', flush=True)
            post_state(state, nearest)
            display_power(state != 'empty')
            last_sent = now
        elif now - last_sent > HEARTBEAT_S:
            post_state(state, nearest)  # heartbeat: tells the app the radar is alive
            last_sent = now


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
