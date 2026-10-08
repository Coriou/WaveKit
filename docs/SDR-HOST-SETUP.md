# SDR Host Setup Guide

This guide covers deploying `wavekit-sdr-host` on a Raspberry Pi or other Linux host with an RTL-SDR dongle.

## Prerequisites

- Raspberry Pi 3/4/5 (or x86_64 Linux host)
- RTL-SDR dongle (RTL2838UHIDIR recommended)
- Docker and Docker Compose installed (managed option handles this)
- Network connectivity to WaveKit container

## Deployment

Choose **one** of the two options below.

### Option A — Managed (Recommended)

The WaveKit host manager handles Docker install, USB prep, compose setup, updates, and restarts.
Run this on the SDR host (Pi), not your build machine.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host

~/.local/bin/wavekit-sdr-host install
~/.local/bin/wavekit-sdr-host update
```

To update the manager script later:

```bash
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host
```

This creates `~/.config/wavekit-sdr-host/` with a `docker-compose.yml` and `.env`.

Edit `.env` to customize gain, sample rate, ports, or image tag.

From the repo, `make sdr-host-install` and `make sdr-host-update` run the same pipeline.

The installer will offer to blacklist DVB drivers and recommend a reboot.

### Option B — DIY (Manual)

Run these steps on the SDR host (Pi), not your build machine.
Do these steps yourself (this is what the scripts automate):

1. **Install Docker + Compose** (and add your user to the `docker` group).
2. **Blacklist DVB drivers** so the dongle is free:

   ```bash
   echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
   sudo reboot
   ```

3. **Verify dongle detection**:

   ```bash
   lsusb | grep RTL
   ```

4. **Create a compose file**:

```yaml
services:
  wavekit-sdr-host:
    image: ghcr.io/coriou/wavekit-sdr-host:latest
    network_mode: host
    volumes:
      - /dev/bus/usb:/dev/bus/usb:rw
    device_cgroup_rules:
      - "c 189:* rmw"
    environment:
      SDR_HOST_RTL_TCP__SAMPLE_RATE: "2048000"
      SDR_HOST_RTL_TCP__FREQUENCY: "446524920"
      SDR_HOST_RTL_TCP__BUFFER: "15"
      SDR_HOST_RTL_TCP__AGC: "false"
      SDR_HOST_RTL_TCP__GAIN: "49"
      SDR_HOST_RTLMUX__PORT: "5555"
```

5. **Start the container**:

```bash
docker compose up -d
```

To enable AGC:

```bash
SDR_HOST_RTL_TCP__AGC=true
```

To use a different manual gain (AGC off):

```bash
SDR_HOST_RTL_TCP__GAIN=42.5
```

Legacy parity (old systemd setup):

```bash
SDR_HOST_RTL_TCP__FREQUENCY=446524920
SDR_HOST_RTL_TCP__BUFFER=15
```

## Configure WaveKit

In WaveKit's `config/custom.yaml`:

```yaml
sources:
  - id: "pi-sdr"
    type: "rtl_tcp"
    host: "192.168.1.50" # IP of sdr-host
    port: 5555
    caps:
      kind: "iq"
      sampleRate: 2048000
      format: "U8_IQ"
```

## Status Page

On newly built WaveKit SD images, open `http://<pi-host>/` as soon as the Pi
joins your network. A small host service starts independently of cloud-init,
Docker and the receiver, so the page can show setup before package installation
finishes. It reports waiting, installation, completion, failure and interruption
after a reboot. Before the first progress record appears, it reports that it is
waiting; it does not infer that cloud-init succeeded. Network configuration must
work before any browser can reach the Pi.

The setup page opens the full receiver page automatically once installation
finishes and that page responds. If installation fails or Docker is unavailable,
the entry page stays reachable. Port 80 serves only bundled assets and sanitized
setup state, with no account settings, raw logs, file browsing or control routes.
It runs as a restricted dynamic system user; existing Imager account and sudo
choices are preserved. The automatic link uses the image's default API port
8080; if you customize that port, open your chosen receiver URL directly.

Open `http://<pi-host>:8080/` from a phone or computer on the same network. The
page is served by the Pi itself and works without WaveKit running on your
computer. It is read-only.

- **Upstream sample flow** leads: "Sampling" appears only when rtlmux's count of
  bytes read from the dongle keeps growing. A detected dongle and running
  processes alone never count. The plot shows the last five minutes against the
  expected rate (2 bytes per sample); gaps mean no measurement, not zero.
- **Receiver chain** shows presence of the dongle, `rtl_tcp`, `rtlmux` and
  downstream clients. No clients means delivery is idle; sampling continues.
  "Dropping" means rtlmux skipped data for a client that fell over 4 MiB behind
  (slow client or network); it is not loss at the antenna.
- **Power**: under-voltage now (from the kernel's `rpi_volt` sensor) is shown
  separately from dips observed since the receiver service started. Throttling
  flags need `vcgencmd`, which the container is deliberately not given, so they
  are shown as not measurable rather than guessed.
- **Pi host**: CPU, memory, storage backing Docker, SoC temperature, network and
  uptime. Every value is marked stale or unavailable when it cannot be read.
- **First-boot setup** appears on images whose first boot writes
  `/var/lib/wavekit/status/setup.json`; compose mounts only that directory,
  read-only. The boot partition is never mounted into the container.

The same data is available as JSON: `GET /api/status` (receiver, `sampling`,
`delivery`) and `GET /api/host` (host telemetry). The API no longer allows
cross-origin browser reads by default; set `SDR_HOST_API__CORS_ORIGINS` to a
comma-separated list of origins if another web app must read it.

### Wi-Fi power saving on dedicated images

The image embeds `/etc/NetworkManager/conf.d/90-wavekit-wifi-powersave.conf`
with `[connection]` and `wifi.powersave=2` before the first network activation.
This disables power saving by default, including after reboot; an explicitly
configured per-connection power-save choice still takes precedence. No network
restart is needed during first-boot installation. These are the documented
[NetworkManager default-setting semantics](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/NetworkManager.conf.html)
and [Wi-Fi power-save values](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/settings-802-11-wireless.html).

Verify on the freshly flashed Pi, then after a reboot:

```bash
iw dev wlan0 get power_save
systemctl status wavekit-boot-status wavekit-firstboot
curl -fsS http://localhost/api/setup
curl -fsS http://localhost:8080/
```

Replace `wlan0` if the Wi-Fi interface has a different name. Disabling power
saving is a latency policy, not evidence that undervoltage or IQ loss is fixed.
Image-content checks, clean-card setup, patched-runtime checks and sustained
streaming acceptance remain separate results.

## Troubleshooting

### DVB Driver Conflict

**Symptom**: "device busy" error

**Check**:

```bash
lsmod | grep dvb
```

**Fix**:

```bash
sudo rmmod dvb_usb_rtl28xxu
```

### Dongle Not Detected

**Check**:

```bash
curl http://localhost:8080/api/status
```

**Fix**: Check USB connection, try different port.

### Get Fix Commands

```bash
curl http://localhost:8080/api/fix
```

Make shortcuts (from repo root):

```bash
make sdr-host-health
make sdr-host-logs
```

## Maintenance

Preferred (from repo root):

```bash
make sdr-host-clean
```

Free disk space on the host directly:

```bash
bash ./packages/sdr-host/scripts/docker-cleanup.sh --aggressive --volumes
```

### Stats Endpoint Not Reachable

rtlmux binds its stats server on an IPv6 socket. If your host is configured
for IPv6-only sockets (`net.ipv6.bindv6only=1`), IPv4 clients won't be able
to reach `http://localhost:5556/stats.json`.

Fix (recommended):

```bash
sudo sysctl -w net.ipv6.bindv6only=0
echo "net.ipv6.bindv6only=0" | sudo tee /etc/sysctl.d/99-wavekit.conf
```

Then restart the container:

```bash
docker compose -f packages/sdr-host/docker-compose.yml up -d --force-recreate
```

## Architecture

```
┌──────────────────────────────────────────────┐
│  Raspberry Pi (wavekit-sdr-host)             │
│                                               │
│  USB RTL-SDR → rtl_tcp (127.0.0.1:1234)      │
│                   ↓                           │
│              rtlmux (0.0.0.0:5555)           │
│                   ↓                           │
│              Status API (:8080)              │
└──────────────────────────────────────────────┘
                    │ IQ stream
                    ↓
┌──────────────────────────────────────────────┐
│  WaveKit Container                            │
│  SourceManager → FanoutManager → Decoders    │
└──────────────────────────────────────────────┘
```
