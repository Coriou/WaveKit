# @wavekit/sdr-host

RTL-SDR dongle host with rtlmux fanout and unified status API.

## Overview

`wavekit-sdr-host` is a Docker container that runs on the RTL-SDR dongle host (typically a Raspberry Pi), providing:

- **USB dongle management** via librtlsdr
- **Upstream IQ source** (`rtl_tcp` bound to localhost)
- **Fanout multiplexing** (`rtlmux` exposed to LAN)
- **Unified status API** for health, dongle info, and client stats

## Quick Start

1. **Install Docker (if needed)**:

   ```bash
   bash ./scripts/install-docker.sh
   ```

   From the repo root:

   ```bash
   bash ./packages/sdr-host/scripts/install-docker.sh
   ```

2. **Blacklist DVB driver** (one-time on host):

   ```bash
   echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf
   sudo reboot
   ```

3. **Plug in RTL-SDR dongle**

4. **Start the container**:

   ```bash
   docker compose up -d
   ```

5. **Point WaveKit** to `tcp://<this-host-ip>:5555`

## Configuration

All configuration via environment variables with `SDR_HOST_` prefix:

| Variable                         | Default   | Description       |
| -------------------------------- | --------- | ----------------- |
| `SDR_HOST_RTL_TCP__SAMPLE_RATE`  | `2048000` | Sample rate in Hz |
| `SDR_HOST_RTL_TCP__AGC`          | `false`   | Enable tuner AGC  |
| `SDR_HOST_RTL_TCP__GAIN`         | `49`      | Manual gain in dB |
| `SDR_HOST_RTL_TCP__PPM`          | `0`       | PPM correction    |
| `SDR_HOST_RTL_TCP__DEVICE_INDEX` | `0`       | USB device index  |
| `SDR_HOST_RTLMUX__PORT`          | `5555`    | IQ stream port    |
| `SDR_HOST_RTLMUX__BIND`          | `0.0.0.0` | Bind address      |
| `SDR_HOST_API__PORT`             | `8080`    | Status API port   |
| `SDR_HOST_LOGGING__LEVEL`        | `info`    | Log level         |

AGC is off by default to match common RTL-SDR setups. When `SDR_HOST_RTL_TCP__AGC` is `true`, manual gain is ignored.

## API Endpoints

### GET /health

Returns service health status (200 OK or 503 Service Unavailable).

### GET /api/status

Returns complete system status including dongle info, process states, and rtlmux stats.

### GET /api/fix

Returns copy-paste fix commands when issues are detected.

## Ports

| Port | Service | Description                            |
| ---- | ------- | -------------------------------------- |
| 5555 | rtlmux  | IQ data stream (WaveKit connects here) |
| 5556 | rtlmux  | Stats HTTP endpoint                    |
| 8080 | API     | Health and status API                  |

## Troubleshooting

```bash
# Check health
curl http://localhost:8080/health

# Get full status
curl http://localhost:8080/api/status

# View rtlmux stats
curl http://localhost:5556/stats.json

# View logs
docker compose logs -f
```
