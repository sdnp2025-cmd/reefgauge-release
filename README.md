# ReefGauge

The software each ReefGauge terminal runs. Units clone this repository and
update from it; development happens in a private repository and lands here as
releases.

**Version 0.2.0**

- `server/` — the terminal's own server: pollers for the Apex, Red Sea
  equipment and the weather, the alert engine, the chemistry log, diagnostics.
- `web/` — the dashboard the wall display draws.
- `sensor/` — the SCD41 room-air daemon, and how it is wired.
- `pi/` — systemd units, the kiosk, the boot screen, and the installer.
- `scripts/update.sh` — what runs when a terminal updates itself.

Installing on a Raspberry Pi: `pi/install.sh`. A terminal built from an SD
card runs it for you.

Issues and pull requests are welcome, but this repository is generated: fixes
land in the development repository and appear here in the next release.
