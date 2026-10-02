#!/bin/bash
# Install the ReefGauge boot screen. Needs root: it writes a Plymouth theme,
# rebuilds the initramfs, and turns off the firmware's rainbow square.
#
#   sudo ./install-splash.sh
#
# Reversible: sudo plymouth-set-default-theme -R pix ; remove disable_splash.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

# Plymouth is not on Raspberry Pi OS Lite. It arrives with the desktop image,
# which is why this script never had to ask for it - and on Lite it would have
# died on plymouth-set-default-theme with a bare "command not found", about a
# package nobody mentioned.
if ! command -v plymouth-set-default-theme > /dev/null 2>&1; then
  echo "==> Plymouth is not installed (normal on Lite) - installing it"
  # Wait for the dpkg lock rather than racing it.
  #
  # During a golden-image build this runs minutes after a long apt session, and
  # apt-daily is not masked until the factory step - so the lock was still held
  # and this failed with "Could not get lock /var/lib/dpkg/lock-frontend". The
  # unit then had no splash, and because the failure exited 0 the build reported
  # "plymouth theme installed" and went on. verify caught it; nothing else would
  # have.
  apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
      plymouth plymouth-themes \
    || { echo "!! could not install plymouth. The unit will boot showing console"
         echo "   text instead of the splash. Everything else still works."
         exit 1; }
fi

# The theme assets live beside this script. They are copied to /opt/reefgauge
# along with it, because sudo grants root to a PATH and that path must not be
# one the application can rewrite - so looking for them in the checkout would
# defeat the move. This broke when the scripts moved to /opt and the assets did
# not follow: $HERE became /opt/reefgauge and the install failed on a glob that
# matched nothing.
ASSETS="$HERE/plymouth/reefgauge"
[ -d "$ASSETS" ] || ASSETS="$HERE/../plymouth/reefgauge"
if [ ! -d "$ASSETS" ]; then
  echo "!! cannot find the theme assets (looked beside $HERE)"; exit 1
fi

THEME=/usr/share/plymouth/themes/reefgauge
install -d "$THEME"
install -m 644 "$ASSETS"/* "$THEME"/
plymouth-set-default-theme -R reefgauge

# Say it only if it is so. "exit 0 on failure" was there to keep a development
# checkout from being blocked by a cosmetic step, but it also let a build print
# "plymouth theme installed, cmdline updated" over a unit that had neither.
if [ ! -f /usr/share/plymouth/themes/reefgauge/reefgauge.plymouth ]; then
  echo "!! the reefgauge theme is not in place"
  exit 1
fi

# /boot/firmware is mounted read-only on a sealed unit, so take it rw for the
# two lines below and put it back. Doing nothing here would leave the firmware's
# rainbow square on screen before the splash, on a unit somebody is unboxing.
BOOT_WAS_RO=0
if findmnt -no OPTIONS /boot/firmware 2>/dev/null | grep -q '^ro'; then
  mount -o remount,rw /boot/firmware && BOOT_WAS_RO=1
fi

CFG=/boot/firmware/config.txt
grep -q '^disable_splash=1' "$CFG" || echo 'disable_splash=1' >> "$CFG"

# Added, not suggested. This used to print a NOTE telling somebody to edit
# cmdline.txt by hand - which is a manual step in a factory process, i.e. a step
# that gets forgotten, and the symptom is a wall of boot text on a customer's
# first power-on.
CMDLINE=/boot/firmware/cmdline.txt
for opt in quiet splash plymouth.ignore-serial-consoles; do
  grep -qw -- "$opt" "$CMDLINE" || sed -i "1s|\$| $opt|" "$CMDLINE"
done

[ "$BOOT_WAS_RO" -eq 1 ] && mount -o remount,ro /boot/firmware

echo "ReefGauge boot screen installed - shows on the next boot"
