#!/bin/bash
# Grow /data to fill the card. Runs once, on the first boot of a cloned image.
#
# A master image is cut from one card and written to another, so /data arrives
# the size it was on the build bench - which on a 32 GB production card would
# leave most of it unused, and on a unit that fills up would look like a
# customer problem rather than an imaging one.
#
# Raspberry Pi OS does this for the ROOT partition and only the root partition.
# A sealed unit's root is fixed and read-only; the partition that has to grow is
# the last one, which is /data.
#
# Deliberately never fatal. A unit that cannot grow its data partition is a unit
# with less space than it should have; a unit that refuses to boot because of it
# is a brick. Every failure here logs and exits 0.
set -uo pipefail

log() { echo "reefgauge-expand: $*"; }

DATA_SRC="$(findmnt -no SOURCE /data 2>/dev/null)" || true
if [ -z "${DATA_SRC:-}" ]; then
  log "/data is not mounted - nothing to grow"; exit 0
fi

DISK="/dev/$(lsblk -no PKNAME "$DATA_SRC" 2>/dev/null)"
PARTNUM="$(echo "$DATA_SRC" | grep -oE '[0-9]+$')"
[ -b "$DISK" ] && [ -n "$PARTNUM" ] || { log "could not identify the disk - skipping"; exit 0; }

# Only bother for something worth having. Growing by a few MB churns the
# partition table on every boot for nothing.
FREE_MB=$(parted -sm "$DISK" unit MiB print free 2>/dev/null \
          | awk -F: '/free;/ {gsub("MiB","",$4); if ($4+0 > m) m = $4+0} END {print int(m)}')
if [ "${FREE_MB:-0}" -lt 512 ]; then
  log "only ${FREE_MB:-0} MiB unallocated - already the size of the card"; exit 0
fi

log "growing $DATA_SRC into ${FREE_MB} MiB of free space"
parted -s "$DISK" resizepart "$PARTNUM" 100% 2>&1 | sed 's/^/reefgauge-expand: /' || {
  log "parted could not resize the partition - leaving it alone"; exit 0; }
partprobe "$DISK" 2>/dev/null || true
# ext4 grows online, so /data does not have to be unmounted for this.
resize2fs "$DATA_SRC" 2>&1 | sed 's/^/reefgauge-expand: /' || {
  log "resize2fs failed - the partition grew but the filesystem did not"; exit 0; }
log "done: $(findmnt -no SIZE /data 2>/dev/null)"
exit 0
