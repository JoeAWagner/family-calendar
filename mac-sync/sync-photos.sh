#!/usr/bin/env bash
# Family Calendar — Mac photo sync
#
# Runs ON YOUR MAC (not the Pi). Exports an iCloud Shared Album from this Mac's
# Photos library and pushes the images to the wall's photos/shared/ folder, so
# the screensaver stays in sync even though iOS 27 removed "Public Website".
#
# Setup lives in README.md. Quick version:
#   1) brew install osxphotos   (or: pipx install osxphotos)
#   2) Give your Terminal "Full Disk Access" so it can read the Photos library.
#   3) ssh-copy-id "$PI_HOST"   so rsync can log in without a password.
#   4) Edit the config below, then run ./sync-photos.sh once to test.
#   5) Schedule it with the included launchd job (see README).
set -euo pipefail

# ---- Config — edit these ---------------------------------------------------
# Exact Shared Album name as it appears in Photos. List names with:  osxphotos albums
ALBUM="${FAMILYCAL_ALBUM:-Family Calendar}"
# The Pi's ssh target and the repo's photos folder on it.
PI_HOST="${FAMILYCAL_PI:-joe@10.0.0.118}"
PI_PHOTOS_DIR="${FAMILYCAL_PI_DIR:-family-calendar/photos}"
# Local staging folder the album is exported into before syncing.
STAGE="${FAMILYCAL_STAGE:-$HOME/.familycal-photos}"
# ---------------------------------------------------------------------------

log() { echo "[$(date '+%H:%M:%S')] $*"; }

command -v osxphotos >/dev/null 2>&1 || {
  echo "osxphotos not found. Install it with one of:"
  echo "   brew install osxphotos"
  echo "   pipx install osxphotos"
  echo "   pip3 install --user osxphotos"
  exit 1
}

mkdir -p "$STAGE"

log "Exporting album \"$ALBUM\" from Photos…"
# --update + --cleanup: incremental, and remove files whose photos left the album.
# --convert-to-jpeg: Chromium on the Pi can't render HEIC, so normalize to JPEG.
# --download-missing: pull any originals Photos hasn't cached locally yet.
# Flat export (no subfolders) so the Pi sees them directly.
osxphotos export "$STAGE" \
  --album "$ALBUM" \
  --update --cleanup \
  --convert-to-jpeg --jpeg-quality 0.9 \
  --download-missing \
  --skip-original-if-edited \
  --retry 2

count=$(find "$STAGE" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | wc -l | tr -d ' ')
log "Exported $count image(s). Syncing to $PI_HOST:$PI_PHOTOS_DIR/shared/ …"

# Mirror the staging folder into photos/shared/ on the Pi. --delete keeps it in
# sync with the album; it only touches shared/, so photos you drop elsewhere in
# photos/ by hand are left alone. --mkpath creates shared/ on first run
# (rsync 3.2.3+); if your rsync is older, create it once: ssh "$PI_HOST" 'mkdir -p family-calendar/photos/shared'.
rsync -az --delete --exclude='.*' --mkpath -e ssh \
  "$STAGE/" "$PI_HOST:$PI_PHOTOS_DIR/shared/" 2>/dev/null \
  || rsync -az --delete --exclude='.*' -e ssh "$STAGE/" "$PI_HOST:$PI_PHOTOS_DIR/shared/"

log "Done. The wall picks up changes on its next photo refresh (within ~30 min)."
