#!/usr/bin/env python3
"""Reads the Sensirion SCD41 over I2C and POSTs readings to the ReefGauge server.

Runs as a systemd service (see pi/co2-daemon.service). Requires I2C enabled
via raspi-config and the packages in requirements.txt installed in a venv.
"""

import os
import sys
import time

import adafruit_scd4x
import board
import requests

# journald gets these as they happen rather than in 8KB blocks — a daemon whose
# log only appears once it dies is no use for working out why it died.
sys.stdout.reconfigure(line_buffering=True)

SERVER_URL = os.environ.get("SERVER_URL", "http://127.0.0.1:8080")
INTERVAL_SECONDS = int(os.environ.get("INTERVAL_SECONDS", "60"))

# The SCD41 sits in a warm enclosure next to the display, so it reads above the
# room. The chip's own offset is the right correction rather than subtracting a
# couple of degrees after the fact: relative humidity is derived from the same
# temperature, so an uncorrected sensor reports the room drier than it is too.
#
# 4 °C is the factory default. The real value belongs to the room the terminal
# hangs in, so it lives in the server's config (environment.tempOffsetC) and is
# re-read every cycle — POST /api/environment/calibrate works it out from a
# thermostat reading and the daemon picks it up on the next pass, no restart.
DEFAULT_TEMP_OFFSET_C = 4.0
# Used only when the server can't be reached at all (it is normally the source).
FALLBACK_TEMP_OFFSET_C = float(os.environ.get("TEMP_OFFSET_C", DEFAULT_TEMP_OFFSET_C))
# The chip clamps its own offset; refuse obvious nonsense before sending it.
MAX_TEMP_OFFSET_C = 20.0


def configured_offset(previous):
    """The offset the server wants, or `previous` when it can't be asked."""
    try:
        res = requests.get(f"{SERVER_URL}/api/environment/config", timeout=5)
        res.raise_for_status()
        value = float(res.json().get("tempOffsetC", DEFAULT_TEMP_OFFSET_C))
    except (requests.RequestException, TypeError, ValueError) as err:
        print(f"could not read the temperature offset ({err}) — keeping {previous:.2f} C")
        return previous
    if not 0.0 <= value <= MAX_TEMP_OFFSET_C:
        print(f"ignoring out-of-range temperature offset {value} C")
        return previous
    return value


def start_measuring(scd):
    """Begin measuring, and throw the first sample away.

    The first reading after a start is unreliable by design — the chip has just
    powered its heater. Publishing it is enough to spike the graph and trip the
    high-CO2 alert, which is exactly what a service restart used to do.
    """
    scd.start_periodic_measurement()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if scd.data_ready:
            _ = (scd.CO2, scd.temperature, scd.relative_humidity)
            print("discarded the first sample after start")
            return
        time.sleep(1)
    print("no first sample within 30s - carrying on")


def apply_offset(scd, offset):
    """Write the offset to the chip. Only settable while it is idle."""
    scd.stop_periodic_measurement()
    scd.temperature_offset = offset
    print(f"temperature offset set to {offset:.2f} C")
    start_measuring(scd)


def main():
    i2c = board.I2C()
    scd = adafruit_scd4x.SCD4X(i2c)

    # Kept in RAM, not persisted to the sensor's EEPROM: it is re-applied on
    # every start, and EEPROM writes are a finite resource.
    applied_offset = configured_offset(FALLBACK_TEMP_OFFSET_C)
    scd.temperature_offset = applied_offset
    print(f"temperature offset set to {applied_offset:.2f} C")

    print("SCD41 started, waiting for first measurement...")
    start_measuring(scd)

    while True:
        if scd.data_ready:
            reading = {
                "co2_ppm": scd.CO2,
                "temp_c": round(scd.temperature, 2),
                "humidity_pct": round(scd.relative_humidity, 1),
            }
            try:
                requests.post(f"{SERVER_URL}/api/environment", json=reading, timeout=10)
                print(f"posted {reading}")
            except requests.RequestException as err:
                print(f"post failed: {err}")

            # Picking a new offset up here means calibrating from the terminal
            # takes effect within a minute, without anyone restarting a service.
            wanted = configured_offset(applied_offset)
            if abs(wanted - applied_offset) >= 0.01:
                apply_offset(scd, wanted)
                applied_offset = wanted

            time.sleep(INTERVAL_SECONDS)
        else:
            time.sleep(5)


if __name__ == "__main__":
    main()
