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
      SDR_HOST_RTL_TCP__BUFFER: "512"
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
SDR_HOST_RTL_TCP__BUFFER=512
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
