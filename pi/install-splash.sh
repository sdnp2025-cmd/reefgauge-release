#!/bin/bash
# Install the ReefGauge boot screen. Needs root: it writes a Plymouth theme,
# rebuilds the initramfs, and turns off the firmware's rainbow square.
#
#   sudo ./install-splash.sh
#
# Reversible: sudo plymouth-set-default-theme -R pix ; remove disable_splash.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
THEME=/usr/share/plymouth/themes/reefgauge
install -d "$THEME"
install -m 644 "$HERE"/plymouth/reefgauge/* "$THEME"/
plymouth-set-default-theme -R reefgauge
CFG=/boot/firmware/config.txt
grep -q '^disable_splash=1' "$CFG" || echo 'disable_splash=1' >> "$CFG"
grep -q 'splash' /boot/firmware/cmdline.txt || echo "NOTE: add 'quiet splash plymouth.ignore-serial-consoles' to cmdline.txt"
echo "ReefGauge boot screen installed - shows on the next boot"
