#!/bin/bash
# Comment the taskbar out of the system session file. Root. Idempotent.
# install.sh does the same; this is the standalone for an already-installed
# unit. See install.sh for why the taskbar has to go at the source.
set -e
sudo sed -i 's|^/usr/bin/lwrespawn /usr/bin/wf-panel-pi|# ReefGauge: no taskbar on a kiosk\n# &|' /etc/xdg/labwc/autostart
grep -n 'panel' /etc/xdg/labwc/autostart
echo "taskbar removed from the session - takes effect on the next login/reboot"
