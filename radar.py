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
import urllib.request

import serial

PORT = os.environ.get('RADAR_PORT', '/dev/serial0')
BAUD = int(os.environ.get('RADAR_BAUD', '256000'))
APP = os.environ.get('APP_URL', 'http://localhost:3000')

NEAR_MM = int(os.environ.get('RADAR_NEAR_MM', '610'))            # 2 ft
NEAR_EXIT_MM = int(os.environ.get('RADAR_NEAR_EXIT_MM', '760'))  # hysteresis (2.5 ft)
ENGAGE_DWELL_S = float(os.environ.get('RADAR_ENGAGE_DWELL_S', '2.0'))
EMPTY_AFTER_S = float(os.environ.get('RADAR_EMPTY_AFTER_S', '45'))
HEARTBEAT_S = 5.0

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


def display_power(on):
    """Best-effort across the Pi display stacks (Wayland/labwc, legacy, X11)."""
    if on:
        cmds = [['wlopm', '--on', '*'], ['vcgencmd', 'display_power', '1'],
                ['xset', 'dpms', 'force', 'on']]
    else:
        cmds = [['wlopm', '--off', '*'], ['vcgencmd', 'display_power', '0'],
                ['xset', 'dpms', 'force', 'off']]
    for c in cmds:
        try:
            subprocess.run(c, check=True, capture_output=True, timeout=5)
            print(f"display {'on' if on else 'off'} via {c[0]}", flush=True)
            return True
        except Exception:
            continue
    # Not fatal: the app blacks itself out when state == empty.
    print('WARN: no display-power method worked; app will black out instead', flush=True)
    return False


def main():
    ser = serial.Serial(PORT, BAUD, timeout=1)
    print(f'LD2450 on {PORT} @ {BAUD}; near={NEAR_MM}mm dwell={ENGAGE_DWELL_S}s', flush=True)

    buf = bytearray()
    presence = Presence()
    last_sent = 0.0

    while True:
        chunk = ser.read(64)
        if chunk:
            buf.extend(chunk)
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

        if targets is None:
            continue  # no fresh frame yet

        now = time.time()
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
