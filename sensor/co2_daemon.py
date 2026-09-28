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


# A forced recalibration only works if the sensor has been measuring in stable
# air for more than three minutes (datasheet 3.8.1); asked sooner, the chip
# returns 0xffff and the attempt is simply wasted. So a request that arrives too
# early is left outstanding rather than failed - it will be picked up again on
# the next pass, by which time it can actually succeed.
FRC_MIN_MEASURING_SECONDS = 200
MEASURING_SINCE = None


def server_config(previous):
    """What the server wants: {"offset": float, "frc": dict|None}.

    Keeps `previous` as the offset when the server can't be asked - a daemon
    that reverted to the factory default every time a restart raced it would
    make the room jump 4 C for no reason anyone could see.
    """
    try:
        res = requests.get(f"{SERVER_URL}/api/environment/config", timeout=5)
        res.raise_for_status()
        body = res.json()
        value = float(body.get("tempOffsetC", DEFAULT_TEMP_OFFSET_C))
    except (requests.RequestException, TypeError, ValueError) as err:
        print(f"could not read the temperature offset ({err}) — keeping {previous:.2f} C")
        return {"offset": previous, "frc": None}
    if not 0.0 <= value <= MAX_TEMP_OFFSET_C:
        print(f"ignoring out-of-range temperature offset {value} C")
        value = previous
    frc = body.get("frc")
    if not (isinstance(frc, dict) and frc.get("id") and frc.get("ppm") is not None):
        frc = None
    return {"offset": value, "frc": frc}


def acknowledge_frc(ack):
    """Tell the server how the recalibration went, and insist a little.

    The server clears the request only on this acknowledgement, deliberately: a
    sensor that dies mid-recalibration has not silently swallowed the
    instruction. The flip side is that losing this message means being asked
    again, and forced recalibration writes the sensor's EEPROM - so it is worth
    more than one attempt.
    """
    for attempt in range(3):
        try:
            requests.post(f"{SERVER_URL}/api/environment/frc/ack", json=ack, timeout=10)
            return
        except requests.RequestException as err:
            print(f"could not acknowledge the recalibration ({err})")
            time.sleep(2 * (attempt + 1))
    print("giving up acknowledging - the terminal may ask for it again")


def run_frc(scd, request):
    """Recalibrate CO2 against a known concentration the terminal supplied."""
    ppm = int(float(request["ppm"]))
    ack = {"location": "display", "id": request["id"]}
    try:
        correction = scd.force_calibration(ppm)
        ack["ok"] = True
        ack["correctionPpm"] = correction
        print(f"recalibrated to {ppm} ppm — the sensor was out by {correction:+d} ppm")
    except Exception as err:  # noqa: BLE001 - an I2C fault must not kill the daemon
        ack["ok"] = False
        ack["error"] = str(err)
        print(f"recalibration to {ppm} ppm failed: {err}")
    finally:
        # force_calibration stops periodic measurement as a side-effect and does
        # not restart it, whether it succeeded or not. Without this the daemon
        # stays alive, logs nothing wrong, and never posts another reading.
        start_measuring(scd)
    acknowledge_frc(ack)


def start_measuring(scd):
    """Begin measuring, and throw the first sample away.

    The first reading after a start is unreliable by design — the chip has just
    powered its heater. Publishing it is enough to spike the graph and trip the
    high-CO2 alert, which is exactly what a service restart used to do.
    """
    global MEASURING_SINCE
    scd.start_periodic_measurement()
    MEASURING_SINCE = time.monotonic()
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
    applied_offset = server_config(FALLBACK_TEMP_OFFSET_C)["offset"]
    scd.temperature_offset = applied_offset
    print(f"temperature offset set to {applied_offset:.2f} C")

    # Worth one line in the log. This sensor leaves automatic self-calibration
    # on, which is right for a room that sees fresh air when the house is
    # empty - and is exactly what the cabinet puck must not do. Which of the two
    # a sensor is doing decides whether its CO2 can be trusted as a reference
    # for the other, so it should not be a matter of reading the source.
    try:
        print(f"automatic self-calibration is {'on' if scd.self_calibration_enabled else 'off'}")
    except Exception as err:  # noqa: BLE001
        print(f"could not read the self-calibration setting: {err}")

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
            wanted = server_config(applied_offset)
            if abs(wanted["offset"] - applied_offset) >= 0.01:
                apply_offset(scd, wanted["offset"])
                applied_offset = wanted["offset"]

            if wanted["frc"]:
                measuring_for = time.monotonic() - (MEASURING_SINCE or time.monotonic())
                if measuring_for < FRC_MIN_MEASURING_SECONDS:
                    print(
                        f"recalibration requested, but the sensor has only been measuring for "
                        f"{measuring_for:.0f}s — waiting for {FRC_MIN_MEASURING_SECONDS}s"
                    )
                else:
                    run_frc(scd, wanted["frc"])

            time.sleep(INTERVAL_SECONDS)
        else:
            time.sleep(5)


if __name__ == "__main__":
    main()
