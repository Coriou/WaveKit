# SDR Host Setup Guide

This guide covers deploying `wavekit-sdr-host` on a Raspberry Pi or other Linux host with an RTL-SDR dongle.

## Prerequisites

- Raspberry Pi 4/5 (or x86_64 Linux host)
- RTL-SDR dongle (RTL2838UHIDIR recommended)
- Docker and Docker Compose installed (see install script below)
- Network connectivity to WaveKit container

## Deployment

### 1. Install Docker (if needed)

Run the WaveKit installer on the host:

```bash
bash ./packages/sdr-host/scripts/install-docker.sh
```

Or via curl once published:

```bash
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/install-docker.sh | bash
```

### 2. Blacklist DVB Driver

The Linux kernel's DVB driver claims RTL-SDR devices by default. Blacklist it:

```bash
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
sudo reboot
```

### 3. Verify Dongle Detection

```bash
lsusb | grep RTL
# Should show: Bus 001 Device 004: ID 0bda:2838 Realtek Semiconductor Corp.
```

### 4. Deploy Container

Create `docker-compose.yml`:

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
      SDR_HOST_RTL_TCP__AGC: "false"
      SDR_HOST_RTL_TCP__GAIN: "49"
      SDR_HOST_RTLMUX__PORT: "5555"
```

Start:

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

### 5. Configure WaveKit

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
