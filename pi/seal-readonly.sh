#!/bin/bash
# Seal a working unit: everything writable moves to /data, the root goes ro.
#
# Run ON the Pi, once, during the golden-image build, AFTER pi/install.sh has
# produced a unit that works and BEFORE pi/install.sh --factory.
#
#   sudo bash pi/seal-readonly.sh          # do it
#   sudo bash pi/seal-readonly.sh --check   # say what it would do, change nothing
#
# WHY A HARD ro AND NOT THE raspi-config OVERLAY
#
# Under an overlay, writes to / succeed into a tmpfs and vanish at reboot. This
# codebase swallows write failures in about seven places, deliberately and
# reasonably - the API token mint, the alarm silences, the adopted Apex inputs,
# the Red Sea cache, coral photo deletes, lastBackupAt. Every one of those
# becomes a silent field failure under an overlay and a loud error on the bench
# under a hard ro.
#
# The argument that settles it is factory reset. Deleting a file that exists
# only in the overlay's lower layer writes a whiteout into RAM, so
# routes/setup.js would report { ok: true, restarting: true }, the unit would
# reboot, and a resold or RMA'd terminal would come back carrying the previous
# owner's Apex password, their photographs and their Wi-Fi PSK. A factory reset
# that un-does itself is a disclosure bug, not an inconvenience.
#
# A hard ro also makes the test trivial: `touch /etc/x` gets EROFS. Under an
# overlay it succeeds and tells you nothing.
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }
do_it() { if [ "$CHECK" -eq 1 ]; then printf '    would: %s\n' "$*"; else eval "$@"; fi; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -e /boot/firmware/config.txt ] || die "this does not look like a Raspberry Pi"
findmnt -no TARGET /data >/dev/null 2>&1 && die "/data is already mounted - this unit is already sealed"

RT_USER="${SUDO_USER:-$(id -un)}"
RT_HOME="$(getent passwd "$RT_USER" | cut -d: -f6)"
[ -d "$RT_HOME" ] || die "cannot find the home directory for '$RT_USER'"

# ------------------------------------------------------------- the card -----
ROOT_SRC="$(findmnt -no SOURCE /)"            # e.g. /dev/mmcblk0p2
DISK="$(lsblk -no PKNAME "$ROOT_SRC")"        # e.g. mmcblk0
[ -n "$DISK" ] || die "could not work out which disk / is on"
DISK="/dev/$DISK"

say "Card"
note "root is on $ROOT_SRC, disk $DISK"
FREE_MB=$(parted -sm "$DISK" unit MiB print free 2>/dev/null \
          | awk -F: '/free;/ {gsub("MiB","",$4); if ($4+0 > m) m = $4+0} END {print int(m)}')
note "largest free region: ${FREE_MB:-0} MiB"

# 8 GiB is the floor from the sizing work: the database is bounded by the 90-day
# retention in db.js, but photos are not, and a restore needs room for a 2 GB
# archive plus its unpacked contents at the same time.
[ "${FREE_MB:-0}" -ge 8192 ] \
  || die "only ${FREE_MB:-0} MiB free on $DISK - need at least 8192.
   The root partition has probably been auto-expanded to fill the card. Build
   the golden image on a card where it has not, or shrink the root first."

# -------------------------------------------------------- create /data ------
say "Creating the data partition"
do_it "parted -s '$DISK' --align optimal mkpart primary ext4 '-${FREE_MB}MiB' '100%'"
sleep 2 || true
if [ "$CHECK" -eq 1 ]; then
  # In check mode the partition was not created, so "the last partition on the
  # disk" is still the ROOT one - and printing "would: mkfs.ext4 /dev/mmcblk0p2"
  # is an alarming thing to read even when nothing will happen.
  DATA_DEV="<the new partition>"
else
  DATA_PART="$(lsblk -lno NAME,TYPE "$DISK" | awk '$2=="part"{p=$1} END{print p}')"
  DATA_DEV="/dev/${DATA_PART}"
  [ "$DATA_DEV" != "$ROOT_SRC" ] || die "partition detection returned the root device - refusing to format it"
fi
note "new partition: $DATA_DEV"
do_it "mkfs.ext4 -F -L REEFDATA '$DATA_DEV'"
do_it "mkdir -p /data"
do_it "mount '$DATA_DEV' /data"

# -------------------------------------------------- move the writable state --
say "Moving writable state onto /data"
do_it "install -d -o '$RT_USER' -g '$RT_USER' /data/reefgauge /data/tmp"
if [ -d "$RT_HOME/reef-terminal/server/data" ]; then
  do_it "cp -a '$RT_HOME/reef-terminal/server/data/.' /data/reefgauge/"
  ok "database and photos"
fi
if [ -f "$RT_HOME/reef-terminal/server/config.json" ]; then
  do_it "cp -a '$RT_HOME/reef-terminal/server/config.json' /data/reefgauge/config.json"
  ok "config.json"
fi

# Paths the OS fixes and the application cannot be told about. Each one is here
# because losing it costs the customer something specific:
#
#   system-connections  their Wi-Fi SSID and PSK. Written by nmcli during the
#                       wizard, and brought up immediately - so the unit works
#                       all day and only forgets at the next power cut.
#   NetworkManager      secret_key, which seeds the DHCP client identifier. Lost
#                       every boot means a new lease and a new address at every
#                       power cut, and an instant lockout on any network with a
#                       reserved address or a MAC filter.
#   timesync            no RTC on a Pi. server/src/clock.js documents what a
#                       twenty-hour clock step does to this product.
#   fake-hwclock.data   the same, and it fires first - before any network.
say "Binding OS-owned paths that must survive"
bind_one() {   # bind_one <real path>
  local real="$1" store="/data$1"
  do_it "install -d '$(dirname "$store")'"
  if [ -e "$real" ] && [ ! -e "$store" ]; then
    do_it "cp -a '$real' '$store'"
  else
    do_it "install -d '$store'"
  fi
  ok "$real"
}
for p in /etc/NetworkManager/system-connections /var/lib/NetworkManager /var/lib/systemd/timesync; do
  bind_one "$p"
done
if [ -f /etc/fake-hwclock.data ]; then
  do_it "install -d /data/etc"
  do_it "cp -a /etc/fake-hwclock.data /data/etc/fake-hwclock.data"
  ok "/etc/fake-hwclock.data"
fi

# ------------------------------------------------------------ fstab ---------
say "Writing /etc/fstab"
FSTAB_ADD=$(cat <<'FSTAB'

# --- ReefGauge: sealed unit ------------------------------------------------
# The root is read-only. Everything the product writes lives on /data, which is
# the only partition a power cut can damage - and a damaged /data is a restore,
# where a damaged / used to be a site visit.
LABEL=REEFDATA  /data  ext4  defaults,noatime,nodev,nosuid  0  2

# Bound out of /data because the OS fixes these paths and the application
# cannot be told to look elsewhere.
/data/etc/NetworkManager/system-connections  /etc/NetworkManager/system-connections  none  bind  0  0
/data/var/lib/NetworkManager                 /var/lib/NetworkManager                 none  bind  0  0
/data/var/lib/systemd/timesync               /var/lib/systemd/timesync               none  bind  0  0

# Small, and in RAM. These are the writes that wear a card out for no benefit:
# nothing here is worth keeping across a reboot.
tmpfs  /tmp      tmpfs  defaults,noatime,nosuid,nodev,size=64M   0  0
tmpfs  /var/tmp  tmpfs  defaults,noatime,nosuid,nodev,size=32M   0  0
tmpfs  /var/log  tmpfs  defaults,noatime,nosuid,nodev,size=32M   0  0
FSTAB
)
if grep -q 'ReefGauge: sealed unit' /etc/fstab 2>/dev/null; then
  note "fstab already has the sealed-unit block"
else
  do_it "cp /etc/fstab /etc/fstab.presealed"
  do_it "printf '%s\n' \"\$FSTAB_ADD\" >> /etc/fstab"
  ok "appended (original kept as /etc/fstab.presealed)"
fi

# The root's own line, and the boot partition's. Done with sed on the existing
# entries rather than rewritten, because their PARTUUIDs are this card's.
say "Mounting / and /boot/firmware read-only"
do_it "sed -i -E '/[[:space:]]\\/[[:space:]]+ext4/ s/(ext4[[:space:]]+)defaults/\\1ro,defaults/' /etc/fstab"
do_it "sed -i -E '/[[:space:]]\\/boot\\/firmware[[:space:]]/ s/(vfat[[:space:]]+)defaults/\\1ro,defaults/' /etc/fstab"

# fake-hwclock writes at shutdown, which a read-only root refuses; point it at
# the copy on /data.
if [ -f /etc/fake-hwclock.data ]; then
  do_it "ln -sfn /data/etc/fake-hwclock.data /etc/fake-hwclock.data"
fi

say "Done"
cat <<'NEXT'
    Reboot, then check:

      findmnt -no OPTIONS /          # starts with ro
      touch /etc/x                   # must fail: Read-only file system
      findmnt -no OPTIONS /data      # starts with rw
      systemctl status reef-server   # running, and answering on :8080

    If the unit comes up and the wizard appears, seal is good. Then run
    pi/install.sh --factory and shut down for imaging.

    To undo: mount -o remount,rw / && cp /etc/fstab.presealed /etc/fstab && reboot
NEXT
