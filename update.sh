#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the service if anything changed.
# Run by the familycal-update systemd timer (installed by setup-kiosk.sh), or
# manually:  ./update.sh
set -euo pipefail
cd "$(dirname "$0")"

# Need an 'origin' remote to update from.
git remote get-url origin >/dev/null 2>&1 || { echo "No 'origin' remote set; nothing to update from."; exit 0; }

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# The setup scripts chmod +x things, which Git otherwise reports as a local
# change and which would block every future fast-forward. Ignore exec-bit churn.
git config core.fileMode false

before="$(git rev-parse HEAD)"
git fetch --quiet origin
branch="$(git rev-parse --abbrev-ref HEAD)"

# Fast-forward only — never clobber local changes or create merge commits.
if ! git merge --ff-only "origin/$branch" >/dev/null 2>&1; then
  echo "Can't fast-forward — skipping auto-update. Local changes:"
  git status --short
  echo ""
  echo "If those are unwanted, discard them and retry:  git checkout -- . && ./update.sh"
  exit 0
fi

after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  echo "Already up to date ($after)."
  exit 0
fi

echo "Updated ${before:0:7} -> ${after:0:7}"
# Refresh dependencies only if the lockfile changed.
if ! git diff --quiet "$before" "$after" -- package-lock.json package.json; then
  echo "Dependencies changed — running npm install…"
  npm install --omit=dev --no-audit --no-fund
fi
$SUDO systemctl restart familycal
echo "Restarted familycal. The kiosk browser will reload itself shortly."
# Also restart the radar service if it's installed, so radar.py changes take effect.
if systemctl list-unit-files familycal-radar.service >/dev/null 2>&1; then
  $SUDO systemctl restart familycal-radar && echo "Restarted familycal-radar."
fi
