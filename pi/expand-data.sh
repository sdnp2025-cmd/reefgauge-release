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

# The stamp that stops this running again. Written HERE rather than by the
# unit's ExecStartPost, which fired whether or not anything worked - and because
# nothing in this script is fatal by design, one transient failure used to cap a
# customer's storage at the bench size permanently, silently, forever. Now a
# failure leaves no stamp and the next boot tries again; the retry is a findmnt
# and an awk, and it stops as soon as there is nothing left to claim.
done_already() { touch /data/.expanded 2>/dev/null || true; }

DATA_SRC="$(findmnt -no SOURCE /data 2>/dev/null)" || true
if [ -z "${DATA_SRC:-}" ]; then
  # No stamp: /data not being mounted yet is exactly the case worth retrying.
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
  log "only ${FREE_MB:-0} MiB unallocated - the partition already fills the card"
else
  log "growing $DATA_SRC into ${FREE_MB} MiB of free space"
  # sfdisk, not parted. parted refuses to resize a partition that is in use, and
  # /data is mounted by definition here - this script exists to grow the
  # filesystem the unit is running on. That refusal is why the first production
  # card came up with /data still 8 GiB and 15 GB of the card unallocated: the
  # same mistake, in the same words, as the root growth in the cloud-init bootcmd,
  # which was fixed and this was not.
  #
  # sfdisk --no-reread writes the table anyway; partx -u then updates the kernel's
  # view through BLKPG, which does work on a live disk. ",+" means "keep the
  # start, take everything that follows".
  before=$(blockdev --getsize64 "$DATA_SRC" 2>/dev/null || echo 0)
  if ! printf ',+\n' | sfdisk --no-reread --force -N "$PARTNUM" "$DISK" >> /dev/null 2>&1; then
    log "sfdisk could not resize the partition, trying parted"
    parted -s "$DISK" resizepart "$PARTNUM" 100% 2>&1 | sed 's/^/reefgauge-expand: /' || {
      log "could not resize the partition - will try again next boot"; exit 0; }
  fi
  # The kernel will not re-read a partition table for a disk with something
  # mounted on it, so partprobe alone is unreliable here. partx -u updates the
  # one partition through BLKPG, which does work on a live disk; partprobe is
  # the fallback. Without this, resize2fs grows the filesystem only to the size
  # the kernel still believes the partition is.
  partx -u "$DISK" 2>/dev/null || partprobe "$DISK" 2>/dev/null || true
  # Did the kernel actually take it? If not, every check below compares the OLD
  # size against itself, concludes there is nothing to do, and stamps - and the
  # stamp stops this ever running again. The table on disk is grown; the kernel
  # will read it at the next boot; this must be allowed to run then.
  after=$(blockdev --getsize64 "$DATA_SRC" 2>/dev/null || echo 0)
  if [ "$after" -le "$before" ]; then
    log "the kernel did not pick up the new partition size - not stamping, will finish next boot"
    exit 0
  fi
fi

# The filesystem, checked against its partition rather than against free space.
#
# These are two separate steps, and the second one used to be unreachable once
# it had failed: the partition had already grown, so every later boot found no
# unallocated space left, declared the job done and stamped it. The card then
# had a 27 GiB partition holding an 8 GiB filesystem, permanently.
#
# ext4 grows online, so /data does not have to be unmounted. A gigabyte of slack
# is the threshold because a large ext4's own metadata accounts for well under
# that, and a half-finished expansion is out by many times it.
PART_KB=$(( $(blockdev --getsize64 "$DATA_SRC" 2>/dev/null || echo 0) / 1024 ))
FS_KB=$(df -k "$DATA_SRC" 2>/dev/null | awk 'NR==2 {print $2}')
if [ "${PART_KB:-0}" -gt 0 ] && [ "${FS_KB:-0}" -gt 0 ] \
   && [ "$(( PART_KB - FS_KB ))" -gt 1048576 ]; then
  log "filesystem is $(( (PART_KB - FS_KB) / 1024 )) MiB smaller than its partition - growing it"
  resize2fs "$DATA_SRC" 2>&1 | sed 's/^/reefgauge-expand: /' || {
    log "resize2fs failed - will try again next boot"; exit 0; }
fi

log "done: /data is $(findmnt -no SIZE /data 2>/dev/null)"
done_already
exit 0
