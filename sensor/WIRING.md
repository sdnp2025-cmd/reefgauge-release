# Wiring the SCD41 room-air sensor

Four wires, I²C, 3.3 V. If the bus scan comes back empty this page is where to
start — an empty scan is nearly always power or a loose connector, not a dead
sensor.

## The connections

The breakout has four pads or pins. Names vary by maker: Adafruit STEMMA QT
prints `VIN GND SCL SDA`, SparkFun Qwiic prints `3V3 GND SCL SDA`, the generic
board in this build prints `VIN GND SCL SDA`.

| Sensor pin | Pi header pin | Pi name | Wire colour used here |
|---|---|---|---|
| VIN / 3V3 | **1** | 3V3 power | red |
| GND | **9** | Ground | black |
| SDA | **3** | GPIO 2 (SDA1) | blue |
| SCL | **5** | GPIO 3 (SCL1) | yellow |

```
       Raspberry Pi 40-pin header, looking at the board
       with the USB ports toward you, pin 1 top-left

        3V3  (1) (2)  5V
  SDA / GPIO2  (3) (4)  5V          (1) --- red ----- VIN
  SCL / GPIO3  (5) (6)  GND         (3) --- blue ---- SDA
       GPIO4  (7) (8)  GPIO14       (5) --- yellow -- SCL
         GND  (9) (10) GPIO15       (9) --- black --- GND
```

**3.3 V, not 5 V.** The SCD41 is a 3.3 V part. Some breakouts have a regulator
and survive 5 V on VIN; the one in this build does not. Pin 1, never pin 2 or 4.

**Do not swap SDA and SCL.** Crossed data and clock lines give exactly the same
symptom as no sensor at all: an empty scan, no error.

No pull-up resistors are needed — GPIO 2 and 3 have 1.8 kΩ pull-ups on the Pi
itself, which is why both pins read `hi` even with nothing attached.

## In the case

The sensor sits in a pocket in the housing's back, bottom right, cap toward the
room, held by the retainer strip (2 × M2.5). The Dupont housing passes through
a slot in that strip on its way into the case — which makes it the connection
most likely to be pulled loose when the panel is handled. Check it first.

Route the four wires along the bottom of the case, away from the Pi's fan and
the speaker leads. Keep them under about 300 mm; I²C at 100 kHz is tolerant,
but long unshielded runs next to a switching supply are not worth the risk.

## Checking it

On the Pi:

```bash
cd ~/reef-terminal/sensor && ./.venv/bin/python - <<'EOF'
import board, busio, time
i2c = busio.I2C(board.SCL, board.SDA)
while not i2c.try_lock(): time.sleep(0.1)
print([hex(a) for a in i2c.scan()])
i2c.unlock()
EOF
```

- `['0x62']` — the sensor is there. `0x62` is the SCD4x address and it is not
  configurable.
- `[]` — nothing on the bus at all. Power or wiring, in that order: measure
  3.3 V across the breakout's own VIN and GND pads (not the header), then
  reseat the Dupont housing, then confirm SDA is on pin 3 and SCL on pin 5.
- Other addresses but no `0x62` — the bus works and the sensor does not. Try it
  on a breadboard with short jumpers before replacing it.

`i2cdetect -y 1` does the same thing if `i2c-tools` is installed.

## The daemon

`co2-daemon.service` runs `co2_daemon.py`, which exits with
`ValueError: No I2C device at address: 0x62` when the sensor is missing and is
restarted by systemd every few seconds. That is deliberate: it means the sensor
can be reconnected without touching the Pi — the next restart picks it up and
the Room air card fills in within 30 seconds.

```bash
systemctl status co2-daemon.service          # activating (auto-restart) = no sensor
journalctl -u co2-daemon.service -n 20       # why it exited
```

The first reading after a start is discarded (the chip has just powered its
heater), so allow a minute before judging the numbers. Temperature runs warm
inside the case; the correction is `environment.tempOffsetC` in the server's
config, 4 °C by default, and `POST /api/environment/calibrate` works out the
right value from a thermostat reading without a restart.

## What the display does when it is missing

The Room air card greys out, drops its status chip for "No reading" and says
when the last reading was; the full Room Air view says the same at the top; the
ticker reads "CO2 — no reading"; and the server raises the `env:offline` alert
after 15 minutes without a row. Nothing pretends the last number is current.
