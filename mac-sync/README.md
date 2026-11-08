# Mac photo sync for the Family Calendar wall

iOS 27 rebuilt Shared Albums and **removed the "Public Website" option** the wall
used to read photos from. This replaces it: a Mac that's subscribed to the shared
album exports the photos from its Photos library and pushes them to the wall over
your home network. No Apple public website, no cloud scraping — just your Mac → the Pi.

Photos land in `photos/shared/` on the Pi. The screensaver shows everything under
`photos/` (now read **recursively**), so anything you drop into `photos/` by hand
still shows too — the sync only manages the `shared/` subfolder.

## One-time setup (on the Mac)

### 1. Install osxphotos
It reads the Photos library and exports album photos. osxphotos is a Python tool
(there is no Homebrew formula for it), so install it with pipx:
```bash
brew install pipx
pipx ensurepath
# open a NEW Terminal window so PATH updates, then:
pipx install osxphotos
osxphotos --version        # confirm it installed
```
Alternatives: `uv tool install osxphotos` if you use uv, or a standalone macOS
build from https://github.com/RhetTbull/osxphotos/releases

### 2. Give Terminal "Full Disk Access"
osxphotos needs to read the Photos library.
**System Settings → Privacy & Security → Full Disk Access → turn on Terminal**
(or iTerm, whichever you use). Quit and reopen Terminal afterward.

### 3. Find the exact album name
```bash
osxphotos albums
```
Copy the shared album's name exactly (it's case-sensitive).

### 4. Let the Mac log in to the Pi without a password
```bash
ssh-keygen -t ed25519      # only if you don't already have a key (press Enter through prompts)
ssh-copy-id joe@10.0.0.118 # use your Pi's user@IP
ssh joe@10.0.0.118 'echo ok && mkdir -p family-calendar/photos/shared'   # should print "ok"
```

### 5. Configure and test the script
Edit the config block at the top of `sync-photos.sh`:
- `ALBUM` — the album name from step 3
- `PI_HOST` — e.g. `joe@10.0.0.118`

Then run it once:
```bash
chmod +x sync-photos.sh
./sync-photos.sh
```
Verify from any computer:
```bash
curl -s http://10.0.0.118:3000/api/photos
```
You should see `/photos/shared/...` entries. The wall picks them up on its next
refresh (within ~30 min), or reboot it to see them immediately.

> If `osxphotos albums` doesn't list your shared album, it may not be fully
> downloaded on this Mac yet — open Photos, click the album so it loads, then
> retry. Shared-album photos export at the resolution Apple keeps (~2048px),
> which is plenty for a wall display.

## Schedule it (so it stays in sync automatically)

> **Put `sync-photos.sh` outside `~/Documents`, `~/Desktop`, and `~/Downloads`.**
> Those are privacy-protected folders. A manual run works from them, but launchd
> (a background daemon) is blocked from reading scripts there and fails with
> `Bootstrap failed: 5: Input/output error`. A plain folder like `~/familycal/`
> works fine.

1. Edit `com.familycal.photosync.plist` — the only thing to change is the
   **ProgramArguments** path, to the full path of your `sync-photos.sh`.
   (Find it with: `find ~ -name sync-photos.sh -path '*mac-sync*'`.)
2. Install and start it (use `bootstrap`/`bootout`; the old `load`/`unload` is
   deprecated and gives cryptic "Input/output error" messages):
   ```bash
   cp com.familycal.photosync.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.familycal.photosync.plist
   launchctl list | grep familycal      # confirm it's loaded
   ```
   It runs at login and every hour. Watch the log:
   ```bash
   tail -f /tmp/familycal-photosync.log
   ```

To stop it:
```bash
launchctl bootout gui/$(id -u)/com.familycal.photosync
```

## Notes

- The Mac must be awake for a scheduled run to fire. A desktop Mac (or a laptop
  that's often open on Wi-Fi) works best; `StartInterval` jobs that are missed
  while asleep run once after waking.
- Removing a photo from the album removes it from the wall on the next sync
  (the sync mirrors the album into `photos/shared/`). Photos you add directly to
  `photos/` on the Pi are never touched.
- If the manual run works but the scheduled one doesn't, macOS may need Full Disk
  Access granted to `/bin/bash` as well — add it in the same Privacy settings pane.
