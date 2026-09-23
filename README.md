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

## License

Copyright (c) 2026 Scott Deyo. All rights reserved. See `LICENSE`.

This repository is public so that ReefGauge terminals can update themselves,
not as an offer of permission. If you own a ReefGauge, your terminal is
licensed and this is where its updates come from. Anything else — running it
on your own hardware, reusing the code, building a device from it — needs
written permission: Admin@reefgauge.com.

REEFGAUGE and the ReefGauge logo are trademarks. The brand files here are
present because a terminal displays them; they are not licensed for use.

This repository is generated, so pull requests cannot be accepted here. Bug
reports are genuinely welcome — open an issue, or write to the address above.
