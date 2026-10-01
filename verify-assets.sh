#!/usr/bin/env bash
# Boot guard: make sure the critical front-end assets in public/ are present and
# sane before the familycal server starts. An unclean power-off has corrupted the
# Git object store on the Pi before (zero-byte blobs, incl. HEAD/master refs),
# which left public/style.css served as 0/305 bytes instead of its real size and
# booted the wall looking broken.
#
# This script re-fetches any missing or suspiciously small asset straight from
# GitHub raw, so the wall always boots looking correct even if Git corrupts again.
#
# It is wired as ExecStartPre on the familycal systemd service (see
# setup-kiosk.sh) and is safe to run by hand:   ./verify-assets.sh
#
# It is BEST-EFFORT by design and always exits 0: if the network is down at boot
# it must not block the server from starting with whatever assets are on disk.
set -u

cd "$(dirname "$0")"
PUBLIC_DIR="public"

# Critical assets, with a conservative minimum byte size. A healthy file is far
# larger than these floors; the floors only need to be above the junk sizes that
# corruption leaves behind (0 bytes, a 305-byte error page, a truncated blob).
# "path:minbytes"
ASSETS=(
  "index.html:1000"
  "style.css:2000"
  "app.js:5000"
)

# Derive owner/repo from the 'origin' remote so this keeps working if the repo is
# ever renamed or forked. Supports https and ssh remote URLs.
slug=""
if remote_url="$(git remote get-url origin 2>/dev/null)"; then
  slug="$remote_url"
  slug="${slug%.git}"
  slug="${slug#https://github.com/}"
  slug="${slug#git@github.com:}"
  slug="${slug#ssh://git@github.com/}"
fi
[ -n "$slug" ] || slug="JoeAWagner/family-calendar"

# Re-fetch from whatever branch this checkout tracks (the Pi runs 'master'), so
# the guard pulls the canonical version of the code that is deployed. Fall back
# to 'master' when the current branch isn't on GitHub (e.g. a local-only feature
# branch), so the guard still has somewhere healthy to pull from.
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[ -n "$branch" ] && [ "$branch" != "HEAD" ] || branch="master"

BRANCHES=("$branch")
[ "$branch" != "master" ] && BRANCHES+=("master")

RAW_HOST="https://raw.githubusercontent.com/${slug}"

# File size in bytes, or 0 if the file is missing/unreadable.
filesize() {
  if [ -f "$1" ]; then
    wc -c <"$1" 2>/dev/null | tr -d ' ' || echo 0
  else
    echo 0
  fi
}

log() { echo "[verify-assets] $*"; }

# Download $name into $dest (atomically) from the first candidate branch that
# serves a file of at least $min bytes. Returns 0 on success.
fetch_asset() {
  local name="$1" min="$2" dest="$3" b url tmp newsize
  for b in "${BRANCHES[@]}"; do
    url="${RAW_HOST}/${b}/${PUBLIC_DIR}/${name}"
    tmp="$(mktemp "${dest}.XXXXXX" 2>/dev/null || echo "${dest}.tmp.$$")"
    if curl -fsSL --retry 3 --retry-delay 2 --max-time 60 \
         -o "$tmp" "$url" 2>/dev/null; then
      newsize="$(filesize "$tmp")"
      if [ "$newsize" -ge "$min" ]; then
        # Atomic replace so a half-written download never becomes the live file.
        if mv -f "$tmp" "$dest" 2>/dev/null; then
          log "restored $dest ($newsize bytes) from $b"
          return 0
        fi
        log "could not replace $dest (left as-is)"
      else
        log "download from $b looked bad ($newsize bytes) — trying next source"
      fi
    else
      log "could not download $name from $b (missing/offline?) — trying next source"
    fi
    rm -f "$tmp" 2>/dev/null || true
  done
  return 1
}

fixed=0
broken=0
for entry in "${ASSETS[@]}"; do
  name="${entry%%:*}"
  min="${entry##*:}"
  dest="$PUBLIC_DIR/$name"
  size="$(filesize "$dest")"

  if [ "$size" -ge "$min" ]; then
    continue
  fi

  log "$dest is $size bytes (min $min) — attempting repair"
  if fetch_asset "$name" "$min" "$dest"; then
    fixed=$((fixed + 1))
  else
    log "could not repair $dest — leaving existing file for the server"
    broken=$((broken + 1))
  fi
done

if [ "$broken" -gt 0 ]; then
  log "repaired $fixed asset(s); $broken still unhealthy (server starting anyway)."
elif [ "$fixed" -gt 0 ]; then
  log "repaired $fixed asset(s)."
else
  log "all assets present and healthy."
fi

# Best-effort: never block the service from starting.
exit 0
