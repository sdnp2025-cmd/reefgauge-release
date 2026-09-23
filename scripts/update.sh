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

# Snapshot the built dashboard: it is what the customer actually sees, and a
# failed rebuild would otherwise leave it missing or half-written.
rm -rf web/dist.prev
[ -d web/dist ] && cp -a web/dist web/dist.prev

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
echo "==> Restarting services"
sudo systemctl restart co2-daemon.service 2>/dev/null || true
sudo systemctl restart reef-server.service

echo "==> Update complete: $(cat VERSION) ($(git rev-parse --short HEAD))"
