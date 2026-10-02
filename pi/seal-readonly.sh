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
# Mounted is not the only "already done". A previous run that failed between
# mkpart and mount leaves a formatted REEFDATA partition unmounted - and this
# script, guarded only on the mount, would make a second 8 GiB partition with the
# same label beside it. Two partitions answering LABEL=REEFDATA is a unit that
# boots from whichever one the kernel lists first.
if blkid -L REEFDATA >/dev/null 2>&1; then
  die "a REEFDATA partition already exists ($(blkid -L REEFDATA)) but is not mounted.
   A previous seal got as far as formatting it. Mount it at /data and re-run, or
   delete that partition first - do not let this script create a second one."
fi

RT_USER="${SUDO_USER:-$(id -un)}"
RT_HOME="$(getent passwd "$RT_USER" | cut -d: -f6)"
[ -d "$RT_HOME" ] || die "cannot find the home directory for '$RT_USER'"

# Precondition, checked BEFORE the first destructive step. This used to run after
# /data had been created and the checkout moved - and then the script refused,
# and the mount guard above blocked the retry its own message asked for.
if grep -q '/opt/reefgauge/' /etc/sudoers.d/reef-terminal-ops 2>/dev/null; then
  ok "sudo grants point at /opt (read-only)"
else
  die "sudoers still grants scripts inside the checkout, which is about to become
   writable. That is a root escalation. Re-run pi/install.sh before sealing."
fi

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
DATA_MIB="${REEF_DATA_MIB:-8192}"
[ "${FREE_MB:-0}" -ge "$DATA_MIB" ] \
  || die "only ${FREE_MB:-0} MiB free on $DISK - need at least ${DATA_MIB}.
   The root partition has probably been auto-expanded to fill the card. That is
   Pi OS doing it on first boot, from a bare 'resize' token on the kernel
   command line; scripts/prepare-card.sh removes that token, so a card prepared
   with it will have the room. Re-flash and prepare the card, or set
   REEF_DATA_MIB lower if you know what you are trading away."

# -------------------------------------------------------- create /data ------
# Exactly DATA_MIB, immediately after the root partition, and NOT all the free
# space. Two reasons, and the second is the one that matters.
#
# The image captured from this card runs to the end of the last partition, so a
# /data that swallowed a 32 GB card would make a 30 GB master image: slow to
# write onto every unit of a production run, and impossible to write onto any
# card even slightly smaller than the one it was built on. Bounded, the whole
# image is about 16 GiB and fits any 32 GB card.
#
# Nothing is lost by it, because reefgauge-expand-data.service grows /data into
# whatever is left of the buyer's card on first boot. And if that ever fails,
# the unit still has the full 8 GiB floor rather than a sliver - which is why
# this is bounded at the floor and not at something smaller.
say "Creating the data partition"
LAST_END_MIB=$(parted -sm "$DISK" unit MiB print 2>/dev/null \
  | awk -F: '$1 ~ /^[0-9]+$/ { gsub("MiB","",$3); if ($3+0 > e) e = $3+0 } END { print int(e) + 1 }')
DISK_MIB=$(parted -sm "$DISK" unit MiB print 2>/dev/null \
  | awk -F: 'NR==2 { gsub("MiB","",$2); print int($2) }')
[ "${LAST_END_MIB:-0}" -gt 0 ] || die "could not find where the last partition ends"
DATA_END_MIB=$(( LAST_END_MIB + DATA_MIB ))
if [ "$DATA_END_MIB" -gt "${DISK_MIB:-0}" ]; then
  DATA_END_MIB="$DISK_MIB"
fi
note "/data: ${LAST_END_MIB}MiB to ${DATA_END_MIB}MiB ($(( DATA_END_MIB - LAST_END_MIB )) MiB)"
note "the rest of the card is left unallocated; first boot grows /data into it"
do_it "parted -s '$DISK' --align optimal mkpart primary ext4 '${LAST_END_MIB}MiB' '${DATA_END_MIB}MiB'"
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

# The application itself, because an update writes to it.
#
# An over-the-air update is `git pull`, then `npm install` twice, then a Vite
# build - all inside the checkout. On a read-only root none of that can happen,
# so a sealed unit with the app on / is a unit that can never be patched. The
# checkout moves to /data and a symlink is left behind, so every path that
# refers to it - the systemd units, update.sh, the support tooling - keeps
# working without knowing.
#
# This is exactly why the privileged scripts are granted at /opt/reefgauge and
# not here: sudo grants root to a path, and this path is now writable by the
# application. See pi/install.sh.
say "Moving the application onto /data"
if [ -d "$RT_HOME/reef-terminal" ] && [ ! -L "$RT_HOME/reef-terminal" ]; then
  do_it "install -d -o '$RT_USER' -g '$RT_USER' /data/app"
  do_it "cp -a '$RT_HOME/reef-terminal' /data/app/reef-terminal"
  do_it "rm -rf '$RT_HOME/reef-terminal'"
  do_it "ln -sfn /data/app/reef-terminal '$RT_HOME/reef-terminal'"
  do_it "chown -h '$RT_USER:$RT_USER' '$RT_HOME/reef-terminal'"
  ok "checkout now at /data/app/reef-terminal (symlinked from \$HOME)"
else
  note "already a symlink, or no checkout here - leaving it alone"
fi

# (sudoers precondition is checked at the top, before anything is created or moved)

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
# nofail: a dirty /data is a restore, not a brick. Without it, an fsck that cannot
# auto-repair sends a unit with no SSH and no console to emergency.target.
LABEL=REEFDATA  /data  ext4  defaults,noatime,nodev,nosuid,nofail,x-systemd.device-timeout=15  0  2

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
# udisks mounts a USB stick under /media/<user>/<label>, which it has to create.
# On a read-only root that mkdir fails and every USB backup and restore reports
# "no USB drive is plugged in".
tmpfs  /media    tmpfs  defaults,noatime,nosuid,nodev,size=1M    0  0
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

# DNS. NetworkManager writes /etc/resolv.conf directly unless it is a symlink into
# its own runtime directory, in which case it writes there (rc-manager=auto). On a
# read-only root the direct write fails silently and the file keeps whatever the
# factory bench's router handed out - which is invisible when the test network IS
# the bench network, and total DNS failure on a customer's.
do_it "ln -sfn /run/NetworkManager/resolv.conf /etc/resolv.conf"

say "Done"
cat <<'NEXT'
    DO NOT REBOOT THIS UNIT IF IT IS A GOLDEN-IMAGE BUILD.

    The next boot runs reefgauge-expand-data.service, which grows /data across
    the whole card and stamps /data/.expanded. That makes the captured image the
    size of the card instead of ~15 GiB, and - because the stamp is on /data and
    travels with it - stops every card written from that image from ever
    expanding. scripts/build-golden-image.sh powers the unit off for exactly this
    reason and never reboots it.

    The checks below are for a unit you are sealing BY HAND and intend to keep,
    not for one about to be imaged:

      findmnt -no OPTIONS /          # starts with ro
      touch /etc/x                   # must fail: Read-only file system
      findmnt -no OPTIONS /data      # starts with rw
      systemctl status reef-server   # running, and answering on :8080

    If the unit comes up and the wizard appears, seal is good. Then run
    pi/install.sh --factory and shut down for imaging.

    To undo: mount -o remount,rw / && cp /etc/fstab.presealed /etc/fstab && reboot
NEXT
