#!/bin/bash
# Over-the-air update, triggered by POST /api/system/update.
#
# The update is transactional: if any step fails, the checkout and the built
# dashboard are put back exactly as they were and the services restarted. A
# half-applied update used to leave a customer looking at a blank wall with no
# way to recover short of a site visit.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Persistent log. /tmp is wiped on reboot — and journald now runs in RAM — so
# the evidence from a failed update used to be gone before anyone could look.
LOG_DIR="$REPO_DIR/server/data"
mkdir -p "$LOG_DIR"
[ -f "$LOG_DIR/update.log" ] && mv -f "$LOG_DIR/update.log" "$LOG_DIR/update.log.1"
exec > >(tee -a "$LOG_DIR/update.log") 2>&1

echo "==> Updating ReefGauge $(date)"

if [ ! -d .git ]; then
  echo "!! No git checkout here — this unit was provisioned from an SD-card"
  echo "   bundle rather than a clone, so it cannot pull updates. Reflash or"
  echo "   convert it to a checkout; refusing to continue."
  exit 3
fi

PREV="$(git rev-parse HEAD)"
echo "==> Current revision $PREV"

# A previous `sudo bash pi/install.sh` built as root, so parts of web/dist can be
# root-owned and unremovable by this script - and the failure lands mid-way
# through the rollback's `rm -rf web/dist`, which deletes the dashboard and then
# cannot restore it. The wall goes blank for the one reason update.sh exists to
# prevent. install.sh no longer does that, but units built before it do not know.
if [ -n "$(find web/dist web/dist.prev -user root 2>/dev/null | head -1)" ]; then
  echo "==> Found root-owned build output from an older install; taking ownership"
  sudo -n chown -R "$(id -un):$(id -gn)" web/dist web/dist.prev 2>/dev/null \
    || { echo "!! web/dist is root-owned and cannot be reclaimed without a password."
         echo "   Run once, then update again:  sudo chown -R $(id -un) ~/reef-terminal/web"
         exit 4; }
fi

# Snapshot the built dashboard: it is what the customer actually sees, and a
# failed rebuild would otherwise leave it missing or half-written.
#
# But only if there is no snapshot already. dist.prev is removed on the success
# path at the end of this script, so one still present here means the previous
# run never finished - a power cut mid-build - and web/dist may be that run's
# broken output. Snapshotting it would promote a broken build to "known good",
# and the rollback this script exists to provide would then restore it.
if [ -d web/dist.prev ]; then
  echo "==> Keeping the dashboard snapshot left by an unfinished earlier update"
elif [ -d web/dist ]; then
  cp -a web/dist web/dist.prev
fi

rollback() {
  echo "!! Update failed — rolling back to $PREV"
  git reset --hard "$PREV" || true
  if [ -d web/dist.prev ]; then
    rm -rf web/dist
    mv web/dist.prev web/dist
  fi
  (cd server && npm install --omit=dev) || true
  sudo systemctl restart reef-server.service || true
  echo "!! Rolled back. The unit is running the previous version."
  exit 1
}
trap rollback ERR

echo "==> Fetching"
git pull --ff-only origin main

echo "==> Server dependencies"
(cd server && npm install --omit=dev)

echo "==> Rebuilding dashboard"
(cd web && npm install && npm run build)

# Look at what the build produced, do not just believe its exit code.
#
# This is not hypothetical. A brownout during a build once left index.html,
# the JS and the CSS all zero bytes, with vite exiting 0 - so the ERR trap
# never fired, the snapshot below was discarded, and the terminal served an
# empty page. The kiosk rendered a blank white screen, the alarms kept
# sounding, and the diagnostics said the display was fine, because the browser
# was indeed running. It was just drawing nothing.
#
# An exit code says the program thought it succeeded. The files say whether it
# did.
verify_dashboard() {
  local idx=web/dist/index.html
  [ -s "$idx" ] || { echo "!! $idx is missing or empty"; return 1; }
  [ "$(wc -c < "$idx")" -ge 200 ] || { echo "!! $idx is implausibly small"; return 1; }

  local asset
  asset=$(grep -oE '/assets/[^"]+\.js' "$idx" | head -1)
  [ -n "$asset" ] || { echo "!! $idx references no script"; return 1; }
  [ -s "web/dist$asset" ] || { echo "!! web/dist$asset is missing or empty"; return 1; }
  # A real bundle is hundreds of KB. Anything under 10 KB is a truncated write,
  # not a lean build.
  [ "$(wc -c < "web/dist$asset")" -ge 10240 ] || { echo "!! web/dist$asset is truncated"; return 1; }
  echo "    dashboard verified ($(wc -c < "web/dist$asset") bytes of script)"
}

verify_dashboard || rollback

# And does it actually run. The checks above confirm a build produced something
# of a plausible size; they cannot tell whether it works. A bundle can be
# perfectly well-formed and throw on the first render - JSX referencing a
# variable that was never destructured builds cleanly, passes every size check,
# and leaves the kiosk frozen on whatever it had last drawn.
#
# The server serves web/dist from disk, so it is already serving the new build
# by the time this runs - no restart needed to test it, and the snapshot below
# is still intact to go back to.
echo "==> Checking the dashboard renders"
if command -v chromium >/dev/null 2>&1; then
  node scripts/check-render.mjs "http://127.0.0.1:${REEF_PORT:-8080}/" || rollback
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM=chromium-browser node scripts/check-render.mjs "http://127.0.0.1:${REEF_PORT:-8080}/" || rollback
else
  # Not a footnote. This check is the only thing that catches a bundle which
  # built cleanly and throws on first paint, and it was added because a brownout
  # once shipped a zero-byte build that vite exited 0 on. A unit missing chromium
  # is a unit whose display is also broken - the kiosk has nothing to run - so
  # say both, loudly, rather than printing "skipped" and moving on.
  echo "!! chromium is not installed on this unit."
  echo "   The render check cannot run, so a broken dashboard would not be caught."
  echo "   The kiosk has nothing to run either, so the screen is blank."
  echo "   Fix: sudo apt-get install -y chromium   (then re-run pi/install.sh)"
fi

# Only now is the new build good; drop the snapshot and stop rolling back.
trap - ERR
rm -rf web/dist.prev

echo "==> Python deps (best effort)"
(cd sensor && .venv/bin/pip install -q -r requirements.txt) || true

# Units imaged before Sep 2026 had a voice daemon; it is gone, and a unit that
# keeps the old unit enabled would retry a missing script every five minutes.
sudo -n systemctl disable --now voice-daemon.service 2>/dev/null || true
sudo -n rm -f /etc/systemd/system/voice-daemon.service 2>/dev/null || true
sudo -n systemctl daemon-reload 2>/dev/null || true
# Units built before service discovery existed have no advertisement, and an
# update is the only way they will ever get one. Idempotent, so this costs a
# file comparison on every other update.
echo "==> Network advertisement"
# `sudo -n /opt/...`, not `sudo -n bash /opt/...`. sudoers grants a COMMAND, and
# the command in the second form is bash - so the grant never matched and this
# silently fell through to the unprivileged attempt every time.
if sudo -n /opt/reefgauge/mdns-service.sh 2>/dev/null; then
  :
elif sudo -n "$REPO_DIR/pi/mdns-service.sh" 2>/dev/null; then
  :   # a unit installed before the scripts moved to /opt
elif bash "$REPO_DIR/pi/mdns-service.sh" 2>/dev/null; then
  :   # already root, or the file is already correct and it exits 0
else
  # Name the command. "needs a re-run of install.sh" is true and useless at
  # 3am: the grant for this script arrives WITH install.sh, so a unit whose
  # sudoers predates it cannot install the advertisement from an update and
  # has no way to find that out except by reading this line.
  echo "    could not write the mDNS advertisement - this unit's sudoers predates it."
  echo "    The CO2 puck finds its terminal by that advertisement, so until this"
  echo "    is done a puck will fall back to resolving the hostname. To fix, once:"
  echo "        sudo bash $REPO_DIR/pi/install.sh"
fi

echo "==> Restarting services"
sudo systemctl restart co2-daemon.service 2>/dev/null || true
sudo systemctl restart reef-server.service

echo "==> Update complete: $(cat VERSION) ($(git rev-parse --short HEAD))"
