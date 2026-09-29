#!/bin/bash
# Advertise this terminal on the network as _reefgauge._tcp.
#
# Called by install.sh when a unit is built, and by scripts/update.sh on every
# update — because units already in customers' houses were built before this
# existed, and an over-the-air update is the only way they will ever get it.
# A unit that does not advertise cannot be found by a puck that has learned to
# look, so this has to reach the installed base, not just new cards.
#
# Idempotent: safe to run on every update, writes only when the content differs.
# Expects to be run as root (install.sh runs it under sudo; update.sh uses the
# sudoers entry install.sh grants for exactly this).
set -euo pipefail

FILE=/etc/avahi/services/reefgauge.service
WANT=$(cat <<'AVAHI'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">ReefGauge on %h</name>
  <service>
    <type>_reefgauge._tcp</type>
    <port>8080</port>
    <txt-record>v=1</txt-record>
  </service>
</service-group>
AVAHI
)

if [ -f "$FILE" ] && [ "$(cat "$FILE")" = "$WANT" ]; then
  exit 0
fi

mkdir -p /etc/avahi/services
printf '%s\n' "$WANT" > "$FILE"
# %h is re-expanded by avahi when the hostname changes, so a unit renamed by
# mDNS conflict resolution keeps advertising correctly with no maintenance.
systemctl reload avahi-daemon 2>/dev/null \
  || systemctl restart avahi-daemon 2>/dev/null \
  || echo "    (avahi-daemon not reloadable here - it will pick this up on reboot)"
echo "    advertising _reefgauge._tcp"
