#!/bin/bash
# One-time setup on the Raspberry Pi. Run from the repo root:
#   cd ~/reef-terminal && bash pi/install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# The account the terminal runs as. Raspberry Pi OS images no longer ship a
# "pi" user, so nothing here may assume one — a wrong User= in a unit file
# fails on a customer's device with no obvious cause.
RT_USER="${SUDO_USER:-$(id -un)}"
RT_HOME="$(getent passwd "$RT_USER" | cut -d: -f6)"

# Anything that writes into the checkout runs as the OWNER of the checkout, even
# when this script is running as root.
#
# This script is granted NOPASSWD in sudoers, so it is legitimately run as root -
# and then npm and vite wrote their output as root. The next unattended update,
# running as the user, could not remove web/dist to replace it: the rollback
# aborted halfway through deleting it, the dashboard 404'd, and the wall went
# blank. Which is exactly the failure that update.sh's verify/rollback machinery
# exists to prevent, arriving by the one route it does not cover.
as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "$RT_USER" != root ]; then
    sudo -u "$RT_USER" -H "$@"
  else
    "$@"
  fi
}
echo "==> Installing for user '$RT_USER' ($RT_HOME)"

echo "==> Installing Node.js 22 (NodeSource) if needed"
if ! command -v node > /dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing server dependencies"
cd "$REPO_DIR/server"
as_user npm install
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "    Created server/config.json — EDIT IT with your Apex IP and location."
fi

echo "==> Building the dashboard"
cd "$REPO_DIR/web"
as_user npm install
as_user npm run build

echo "==> Setting up the CO2 sensor daemon (Python venv)"
# Build prerequisites for the GPIO/audio Python packages (lgpio needs
# swig + liblgpio-dev to compile its wheel on Raspberry Pi OS)
# poppler-utils supplies pdftotext, which is how a lab's PDF becomes an ICP
# result. Pi OS ships it, but a minimal image does not — and without it the
# upload fails with a message telling the customer to paste instead, which is
# a worse product than one apt package.
sudo apt-get install -y python3-dev swig liblgpio-dev poppler-utils
cd "$REPO_DIR/sensor"
as_user python3 -m venv .venv
as_user .venv/bin/pip install -r requirements.txt

echo "==> Allowing the server to manage Wi-Fi and restart services (wizard + OTA updates)"
sudo tee /etc/sudoers.d/reef-terminal > /dev/null <<SUDOERS
$RT_USER ALL=(root) NOPASSWD: /usr/bin/nmcli
$RT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart reef-server.service, /usr/bin/systemctl restart co2-daemon.service, /usr/bin/systemctl restart reef-kiosk.service
SUDOERS
sudo chmod 440 /etc/sudoers.d/reef-terminal
sudo rm -f /etc/sudoers.d/reef-terminal-nmcli

# Operations that must not stop for a password: the OTA updater reboots
# after a kernel update, the boot-screen installer writes a Plymouth theme,
# and a support session needs to bounce the unit. Specific commands only.
echo "==> Allowing reboot, power off and the boot-screen installer without a password"
#
# The three scripts are granted at their /opt copies, NOT in the checkout.
#
# sudo grants root to a PATH, so the file at that path must be one the granted
# user cannot rewrite. On a sealed unit the checkout lives on the writable
# /data partition - so granting NOPASSWD to a script inside it would hand root
# to anything that could write a file there, which is the whole application.
# /opt/reefgauge is on the read-only root and is the only safe place for them.
sudo install -d -m 755 /opt/reefgauge
for script in install.sh install-splash.sh mdns-service.sh kiosk.sh expand-data.sh; do
  [ -f "$REPO_DIR/pi/$script" ] && sudo install -m 755 "$REPO_DIR/pi/$script" "/opt/reefgauge/$script"
done

sudo tee /etc/sudoers.d/reef-terminal-ops > /dev/null <<SUDOERS
$RT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/sbin/reboot, /opt/reefgauge/install-splash.sh, /opt/reefgauge/install.sh, /opt/reefgauge/mdns-service.sh, /usr/bin/systemctl daemon-reload
SUDOERS
sudo chmod 440 /etc/sudoers.d/reef-terminal-ops
sudo visudo -c -q

# Announce the terminal as a service, not just a hostname.
#
# The puck used to find its terminal by resolving a fixed name. That works until
# two terminals share a network: mDNS conflict resolution silently renames the
# second to reef-terminal-2.local, the name still resolves - to the *other*
# unit - and a puck starts reporting its cabinet CO2 to somebody else's tank,
# with nothing anywhere saying so.
#
# A service advertisement survives that rename, because it is published under
# whatever the host ends up called. %h expands to the current hostname and is
# re-expanded when it changes, so this needs no maintenance.
echo "==> Advertising the terminal on the network (mDNS)"
sudo bash "$(dirname "$0")/mdns-service.sh"

echo "==> Installing systemd services"
render_unit() {  # render_unit <src> <dest>
  sed -e "s|__USER__|$RT_USER|g" -e "s|__HOME__|$RT_HOME|g" "$1" | sudo tee "$2" > /dev/null
}
render_unit "$REPO_DIR/pi/reef-server.service" /etc/systemd/system/reef-server.service
render_unit "$REPO_DIR/pi/co2-daemon.service" /etc/systemd/system/co2-daemon.service

# A sealed unit keeps everything writable on its own partition, because the root
# filesystem is mounted read-only. A development checkout has no /data and is
# left exactly as it was - which is why this is a drop-in rather than a change
# to the units themselves.
if findmnt -no TARGET /data > /dev/null 2>&1; then
  echo "    /data is mounted - configuring this unit as sealed"
  render_unit "$REPO_DIR/pi/reefgauge-expand-data.service" /etc/systemd/system/reefgauge-expand-data.service
  sudo systemctl enable reefgauge-expand-data.service 2>/dev/null || true
  sudo install -d /etc/systemd/system/reef-server.service.d
  sudo tee /etc/systemd/system/reef-server.service.d/10-data.conf > /dev/null <<'DROPIN'
# Written by pi/install.sh on a unit with a /data partition.
[Unit]
# Without this the server can start before /data is mounted, create its
# database in the mount point on the read-only root, and then have it
# disappear under it when the real partition mounts on top.
RequiresMountsFor=/data

[Service]
Environment=REEFGAUGE_CONFIG=/data/reefgauge/config.json
Environment=REEFGAUGE_DATA=/data/reefgauge
# Backup and restore stage through the system temp directory: a backup holds a
# copy of the database AND every photo AND the tarball of both, and a restore
# accepts an archive up to 2 GB and then unpacks it. On a 2 GB Pi with a tmpfs
# /tmp, the customer's own backup is what takes the unit down - and the restore
# case does it at the exact moment they are recovering from a failure.
Environment=TMPDIR=/data/tmp
DROPIN
  sudo install -d -o "$RT_USER" -g "$RT_USER" /data/reefgauge /data/tmp
fi

sudo systemctl daemon-reload
sudo systemctl enable --now reef-server.service co2-daemon.service
# Units imaged before Sep 2026 had a voice daemon; it is gone, and a unit that
# keeps the old unit enabled would retry a missing script every five minutes.
sudo systemctl disable --now voice-daemon.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/voice-daemon.service 2>/dev/null || true
sudo systemctl daemon-reload 2>/dev/null || true

chmod +x "$REPO_DIR/pi/kiosk.sh"

# Is there a desktop to work with?
#
# Shipped units run Raspberry Pi OS Lite: no desktop, no labwc, no taskbar and
# no file manager. The bench unit still runs the desktop image, so this detects
# rather than assumes - and it detects by the presence of the very file the
# desktop branch edits, so it cannot be wrong about it.
#
# On Lite this script used to abort outright further down, where it sed-ed
# /etc/xdg/labwc/autostart under `set -euo pipefail`. That file ships with the
# desktop packages and does not exist on Lite, so the installer died there and
# left the unit half-built.
#
# Note how much of the desktop branch is the product hiding the desktop: the
# taskbar, the default-password prompt, the on-screen keyboard, the file
# manager's wallpaper. On Lite there is nothing to hide, and it all goes away.
#
# The branch bodies are NOT indented, deliberately. Several of them are heredocs
# and a heredoc terminator must sit at column 0 - indenting this block for looks
# is what makes `cat <<EOF` run to the end of the file.
HAS_DESKTOP=0
[ -f /etc/xdg/labwc/autostart ] && HAS_DESKTOP=1

if [ "$HAS_DESKTOP" -eq 0 ]; then
echo "==> Installing the kiosk (Lite: cage on tty1)"
# cage is compositor and launcher in one: a single fullscreen client, nothing
# else on the screen, nothing to alt-tab to.
#
# alsa-utils because the alarm is played with aplay (server/src/alarmSound.js)
# and Lite does not ship it - without this the product's only audible alarm is
# silent, and the spawn failure is swallowed so nothing reports it.
#
# udisks2 because the USB backup flow looks for a mounted drive and Lite mounts
# nothing on its own: without it, a stick physically in the port reads as
# "no USB drive is plugged in".
sudo apt-get install -y --no-install-recommends cage alsa-utils udisks2

sed -e "s|__USER__|$RT_USER|g" -e "s|__HOME__|$RT_HOME|g" \
  "$REPO_DIR/pi/reef-kiosk-cage.service" \
  | sudo tee /etc/systemd/system/reef-kiosk.service > /dev/null
sudo systemctl daemon-reload
# The login prompt and the kiosk cannot both own tty1.
sudo systemctl disable --now getty@tty1.service 2>/dev/null || true
sudo systemctl enable reef-kiosk.service
echo "    kiosk starts on tty1 at boot"

else
echo "==> Installing the kiosk as a restartable user service"
# A crashed browser used to leave a bare desktop until someone SSH'd in; as a
# user service it restarts itself. Replaces the old compositor autostart line.
install -d "$RT_HOME/.config/systemd/user"
install -m 644 "$REPO_DIR/pi/reef-kiosk.service" "$RT_HOME/.config/systemd/user/reef-kiosk.service"
# Touch goes to the panel, whatever the controller is called. The old file named
# one specific controller ("yldzkj USB2IIC_CTP_CONTROL"), so swapping the panel
# silently unmapped touch; with no deviceName labwc applies it to every touch
# device, which on a one-screen product is the only sensible answer.
# mouseEmulation stays off: the panel is a real touch device, and turning it
# into a fake mouse costs Chromium its native touch scrolling and adds a hop
# to every event. (The original ROADOM controller enumerated as a mouse, which
# is where the setting came from; it did nothing for that panel either.)
mkdir -p "$RT_HOME/.config/labwc"
cat > "$RT_HOME/.config/labwc/rc.xml" <<'EOF'
<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
	<touch mapToOutput="HDMI-A-1" mouseEmulation="no"/>
</openbox_config>
EOF
chown "$RT_USER:$RT_USER" "$RT_HOME/.config/labwc/rc.xml"

# Nobody should see an operating system. Between Plymouth and Chromium the
# desktop is on screen for a few seconds, so the desktop IS the boot frame:
# the same deep water and logo as the Plymouth theme and the in-app splash as
# the wallpaper, no icons, and the panel set to hide itself. Chromium's
# fullscreen window sits above the panel's layer, so it never shows after.
install -d "$RT_HOME/.config/pcmanfm/default" "$RT_HOME/.config/wf-panel-pi"
for n in 0 1; do
cat > "$RT_HOME/.config/pcmanfm/default/desktop-items-$n.conf" <<EOF
[*]
wallpaper_mode=fit
wallpaper_common=1
wallpaper=$RT_HOME/reef-terminal/pi/plymouth/boot-frame.png
desktop_bg=#070734346262
desktop_fg=#070734346262
desktop_shadow=#070734346262
desktop_font=Nunito Sans Light 12
show_wm_menu=0
sort=mtime;ascending;
show_documents=0
show_trash=0
show_mounts=0
EOF
done
# The taskbar (wf-panel-pi) is started from the SYSTEM session file, which
# labwc runs for every user alongside the user's own, so no per-user setting
# can keep it off the screen - and its network plugin pops "connected to
# Wi-Fi" over the boot frame. A kiosk has no use for a taskbar: comment it
# out of the system autostart. Idempotent - a commented line stays commented.
sudo sed -i 's|^/usr/bin/lwrespawn /usr/bin/wf-panel-pi|# ReefGauge: no taskbar on a kiosk\n# &|' /etc/xdg/labwc/autostart

# Two more stock autostart items that draw over a kiosk: the "still using the
# default password" prompt and the system on-screen keyboard (the app has its
# own). A same-named entry in the user's autostart with Hidden=true wins.
install -d "$RT_HOME/.config/autostart"
for entry in pprompt squeekboard; do
  printf '[Desktop Entry]\nType=Application\nName=%s\nHidden=true\n' "$entry" > "$RT_HOME/.config/autostart/$entry.desktop"
done

cat > "$RT_HOME/.config/wf-panel-pi/wf-panel-pi.ini" <<'EOF'
[panel]
autohide=true
autohide_duration=0
EOF
chown -R "$RT_USER:$RT_USER" "$RT_HOME/.config/pcmanfm" "$RT_HOME/.config/wf-panel-pi" "$RT_HOME/.config/autostart"

if [ -f "$RT_HOME/.config/labwc/autostart" ]; then
  sed -i '\|reef-terminal/pi/kiosk.sh|d' "$RT_HOME/.config/labwc/autostart"
fi
sudo loginctl enable-linger "$RT_USER" 2>/dev/null || true
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable reef-kiosk.service 2>/dev/null \
  || echo "    (enable manually once logged in: systemctl --user enable --now reef-kiosk)"
fi


echo "==> Hardening: watchdog and SD-card wear"
# Hardware watchdog: if the kernel or systemd wedges, the Pi resets itself
# rather than sitting dark until someone power-cycles it.
if [ -e /dev/watchdog ] && ! grep -q '^RuntimeWatchdogSec=' /etc/systemd/system.conf; then
  echo 'RuntimeWatchdogSec=15' | sudo tee -a /etc/systemd/system.conf > /dev/null
  echo 'RebootWatchdogSec=2min' | sudo tee -a /etc/systemd/system.conf > /dev/null
fi
# Journals in RAM. Continuous journal writes are a leading cause of SD-card
# death, and a dead card is a warranty return.
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/reef-terminal.conf > /dev/null <<'JOURNALD'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
JOURNALD
sudo systemctl restart systemd-journald || true

# NOTE: scripts/update.sh is committed with mode 755 — chmod-ing a tracked
# file here would dirty the worktree and make the next `git pull --ff-only`
# fail on every unit in the field.

# --factory: leave the unit in out-of-box state (setup wizard on first boot).
# Run this immediately before imaging the card. It clears the customer-specific
# state AND scrubs this machine's identity, because everything left behind here
# is cloned byte-for-byte onto every unit sold.
if [ "${1:-}" = "--factory" ]; then
  # Gate, not advice.
  #
  # This block used to end by *printing* a reminder to change the password. An
  # echo at the end of a long install is not a control: it scrolls past, and
  # what it was guarding gets stamped onto every card in the production run.
  # Anything that must be true of a shipped unit is checked here and refuses.
  EXPECTED_REMOTE="${REEF_RELEASE_REMOTE:-https://github.com/sdnp2025-cmd/reefgauge-release.git}"
  ACTUAL_REMOTE="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo none)"
  if [ "$ACTUAL_REMOTE" != "$EXPECTED_REMOTE" ]; then
    echo
    echo "!! REFUSING to prepare a factory image."
    echo "   This checkout's origin is:  $ACTUAL_REMOTE"
    echo "   A shipped unit's must be:   $EXPECTED_REMOTE"
    echo
    echo "   Two things go wrong if this is imaged. The .git directory carries"
    echo "   that repository's entire history onto every customer's card - and"
    echo "   for the private repo that means the patent disclosure, the case"
    echo "   designs, the relay server and the support tooling, readable in any"
    echo "   laptop. And origin then points somewhere no unit can authenticate"
    echo "   to, so every over-the-air update fails, for the whole fleet,"
    echo "   forever - with nothing revealing it until the first security fix."
    echo
    echo "   Re-clone from the release remote and run the install again."
    exit 1
  fi

  echo "==> Factory reset: clearing config and data (wizard will run on boot)"
  rm -f "$REPO_DIR/server/config.json"
  rm -rf "$REPO_DIR/server/data"

  echo "==> Scrubbing machine identity so clones are not siblings"
  # SSH host keys: cloned keys mean every unit presents the same host identity,
  # so any customer can silently impersonate any other and no client can tell
  # them apart. Regenerated on first boot by the ssh service.
  sudo rm -f /etc/ssh/ssh_host_*
  sudo systemctl enable regenerate_ssh_host_keys.service 2>/dev/null || true

  # machine-id seeds DHCP identifiers and systemd's boot IDs. Cloned, units
  # collide on the customer's router.
  sudo truncate -s 0 /etc/machine-id
  sudo rm -f /var/lib/dbus/machine-id
  sudo ln -sf /etc/machine-id /var/lib/dbus/machine-id

  # The factory bench's Wi-Fi credentials would otherwise ship inside every
  # image — readable by anyone who mounts the card.
  sudo rm -f /etc/NetworkManager/system-connections/*.nmconnection

  # The key that built this image. Left in place it is a permanent way into
  # every unit ever sold, and one leaked private key opens the whole fleet.
  # known_hosts and any stray private key go with it.
  sudo rm -rf "$RT_HOME/.ssh"

  # No password on a shipped unit - not a password to be remembered and
  # changed. A golden image is byte-identical, so it cannot carry a per-unit
  # password, and a shared one is the shipped default credential UK PSTI and
  # the EU CRA prohibit. Locking it means there is nothing to guess and nothing
  # to remember. Physical access still reaches the kiosk (as with any
  # appliance); remote access is the customer-initiated relay in
  # server/src/supportSession.js.
  sudo passwd --lock "$RT_USER" > /dev/null 2>&1 \
    || echo "    (could not lock $RT_USER - do NOT image this card)"
  sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' \
    /etc/ssh/sshd_config 2>/dev/null || true

  # Shell history and logs from the build bench.
  rm -f "$RT_HOME/.bash_history" "$RT_HOME/.python_history" 2>/dev/null || true
  sudo rm -rf /var/log/journal/* /tmp/* 2>/dev/null || true

  # Prove it rather than claim it - these are the two that cannot be undone
  # once a production run is stamped.
  FAILED=0
  [ -e "$RT_HOME/.ssh" ] && { echo "!! $RT_HOME/.ssh still present"; FAILED=1; }
  sudo passwd --status "$RT_USER" 2>/dev/null | grep -qE ' (L|LK) ' \
    || { echo "!! $RT_USER's password is not locked"; FAILED=1; }
  [ "$FAILED" -eq 0 ] || { echo "!! DO NOT image this card."; exit 1; }

  echo "==> Factory image verified: release remote, no password, no build key."
  echo "    Now: sudo shutdown now"
fi

echo
echo "Done. Next steps:"
echo "  1. Edit server/config.json, then: sudo systemctl restart reef-server"
echo "  2. Enable I2C: sudo raspi-config -> Interface Options -> I2C"
echo "  3. Reboot to start the kiosk (installed as a user service)"
