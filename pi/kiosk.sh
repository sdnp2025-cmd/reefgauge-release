#!/bin/bash
# Launch Chromium full-screen pointed at the dashboard.
#
# Run by pi/reef-kiosk.service (a user service), which restarts it if Chromium
# dies. It is safe to start before the desktop is ready: this script waits for
# the compositor and the server rather than assuming either.

set -u

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR WAYLAND_DISPLAY

# Wait for the Wayland compositor. Without this the browser starts before the
# session exists, fails, and the unit restart-loops until it happens to win.
for _ in $(seq 1 120); do
  [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && break
  sleep 1
done

# Wait for the server to come up after boot.
until curl -sf http://localhost:8080/api/health > /dev/null; do
  sleep 2
done

# The glass is 1024x600, but the panel's EDID does not say so: the LCDwiki
# MPI1001 identifies itself as a 7" MPI7002 with 1920x1080 preferred and no
# 1024x600 mode at all, so KMS drives it at 1080p and the panel's scaler
# squashes the picture — soft text, and Chromium rendering 3.4x the pixels
# the screen can show. The panel accepts the native mode when asked for it.
# Done here rather than in cmdline.txt so it ships with the app, needs no root
# and follows the kiosk if the panel is ever swapped for one whose EDID is
# honest (a panel already at 1024x600 is left alone).
PANEL_W=1024
PANEL_H=600
if command -v wlr-randr > /dev/null; then
  if ! wlr-randr 2> /dev/null | grep -q "${PANEL_W}x${PANEL_H} px.*current"; then
    wlr-randr --output HDMI-A-1 --custom-mode "${PANEL_W}x${PANEL_H}@60" > /dev/null 2>&1 \
      || echo "kiosk: panel refused ${PANEL_W}x${PANEL_H}, leaving the EDID mode" >&2
  fi
fi

# Raspberry Pi OS wraps Chromium in a script that adds its own flags, one of
# which is --force-renderer-accessibility: a full accessibility tree rebuilt on
# every DOM change, which the gauges and charts trigger constantly. Nothing on
# a kiosk reads that tree. Run the binary directly where it is, keeping the
# two wrapper flags that do matter here; fall back to the wrapper elsewhere.
if [ -x /usr/lib/chromium/chromium ]; then
  CHROMIUM=/usr/lib/chromium/chromium
else
  CHROMIUM="$(command -v chromium-browser || command -v chromium)"
fi

# Keep the browser cache in RAM. On an SD-card product the cache is a constant
# write source and a leading cause of card wear (and therefore of RMAs); losing
# it on reboot costs nothing because the app is served from localhost.
CACHE_DIR="$XDG_RUNTIME_DIR/chromium-cache"
mkdir -p "$CACHE_DIR"

# The panel is a 10-point touchscreen and Chromium finds it — maxTouchPoints
# reports 10 — but it left the touch event API off, so every finger arrived as
# a mouse: taps worked, because a tap is a click, and nothing scrolled, because
# a mouse drag is not a pan. Forced on below.
exec "$CHROMIUM" \
  --kiosk \
  --touch-events=enabled \
  --enable-gpu-rasterization \
  --disable-dev-shm-usage \
  --no-default-browser-check \
  --ozone-platform=wayland \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --hide-scrollbars \
  --check-for-update-interval=604800 \
  --disk-cache-dir="$CACHE_DIR" \
  --disk-cache-size=33554432 \
  http://localhost:8080
