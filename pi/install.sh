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
echo "==> Installing for user '$RT_USER' ($RT_HOME)"

echo "==> Installing Node.js 22 (NodeSource) if needed"
if ! command -v node > /dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Installing server dependencies"
cd "$REPO_DIR/server"
npm install
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "    Created server/config.json — EDIT IT with your Apex IP and location."
fi

echo "==> Building the dashboard"
cd "$REPO_DIR/web"
npm install
npm run build

echo "==> Setting up the CO2 sensor daemon (Python venv)"
# Build prerequisites for the GPIO/audio Python packages (lgpio needs
# swig + liblgpio-dev to compile its wheel on Raspberry Pi OS)
# poppler-utils supplies pdftotext, which is how a lab's PDF becomes an ICP
# result. Pi OS ships it, but a minimal image does not — and without it the
# upload fails with a message telling the customer to paste instead, which is
# a worse product than one apt package.
sudo apt-get install -y python3-dev swig liblgpio-dev poppler-utils
cd "$REPO_DIR/sensor"
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

echo "==> Allowing the server to manage Wi-Fi and restart services (wizard + OTA updates)"
sudo tee /etc/sudoers.d/reef-terminal > /dev/null <<SUDOERS
$RT_USER ALL=(root) NOPASSWD: /usr/bin/nmcli
$RT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart reef-server.service, /usr/bin/systemctl restart co2-daemon.service
SUDOERS
sudo chmod 440 /etc/sudoers.d/reef-terminal
sudo rm -f /etc/sudoers.d/reef-terminal-nmcli

# Operations that must not stop for a password: the OTA updater reboots
# after a kernel update, the boot-screen installer writes a Plymouth theme,
# and a support session needs to bounce the unit. Specific commands only.
echo "==> Allowing reboot, power off and the boot-screen installer without a password"
sudo tee /etc/sudoers.d/reef-terminal-ops > /dev/null <<SUDOERS
$RT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/sbin/reboot, $RT_HOME/reef-terminal/pi/install-splash.sh, $RT_HOME/reef-terminal/pi/install.sh, /usr/bin/systemctl daemon-reload
SUDOERS
sudo chmod 440 /etc/sudoers.d/reef-terminal-ops
sudo visudo -c -q

echo "==> Installing systemd services"
render_unit() {  # render_unit <src> <dest>
  sed -e "s|__USER__|$RT_USER|g" -e "s|__HOME__|$RT_HOME|g" "$1" | sudo tee "$2" > /dev/null
}
render_unit "$REPO_DIR/pi/reef-server.service" /etc/systemd/system/reef-server.service
render_unit "$REPO_DIR/pi/co2-daemon.service" /etc/systemd/system/co2-daemon.service
sudo systemctl daemon-reload
sudo systemctl enable --now reef-server.service co2-daemon.service
# Units imaged before Sep 2026 had a voice daemon; it is gone, and a unit that
# keeps the old unit enabled would retry a missing script every five minutes.
sudo systemctl disable --now voice-daemon.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/voice-daemon.service 2>/dev/null || true
sudo systemctl daemon-reload 2>/dev/null || true

chmod +x "$REPO_DIR/pi/kiosk.sh"

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

  # Shell history and logs from the build bench.
  rm -f "$RT_HOME/.bash_history" "$RT_HOME/.python_history" 2>/dev/null || true
  sudo rm -rf /var/log/journal/* /tmp/* 2>/dev/null || true

  echo "==> Factory image ready. Change the login password before imaging if it"
  echo "    is still the build-bench default, then: sudo shutdown now"
fi

echo
echo "Done. Next steps:"
echo "  1. Edit server/config.json, then: sudo systemctl restart reef-server"
echo "  2. Enable I2C: sudo raspi-config -> Interface Options -> I2C"
echo "  3. Reboot to start the kiosk (installed as a user service)"
