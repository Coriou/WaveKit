# @wavekit/sdr-host

RTL-SDR dongle host with rtlmux fanout and unified status API.

## Overview

`wavekit-sdr-host` is a Docker container that runs on the RTL-SDR dongle host (typically a Raspberry Pi), providing:

- **USB dongle management** via librtlsdr
- **Upstream IQ source** (`rtl_tcp` bound to localhost)
- **Fanout multiplexing** (`rtlmux` exposed to LAN)
- **Unified status API** for health, dongle info, and client stats

## Quick Start

Choose **one** of the two options below.

### Option A — Managed (Recommended)

Run this on the SDR host (Pi), not your build machine.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host

~/.local/bin/wavekit-sdr-host install
~/.local/bin/wavekit-sdr-host update
```

From the repo, `make sdr-host-install` and `make sdr-host-update` run the same pipeline.

The script stores config in `~/.config/wavekit-sdr-host/` and creates a `.env` file you can edit.

The installer will offer to blacklist DVB drivers and recommend a reboot.

To update the manager script later:

```bash
curl -fsSL https://raw.githubusercontent.com/coriou/wavekit/main/packages/sdr-host/scripts/sdr-host.sh -o ~/.local/bin/wavekit-sdr-host
chmod +x ~/.local/bin/wavekit-sdr-host
```

### Option B — DIY (Manual)

Run these steps on the SDR host (Pi), not your build machine.

Do these steps yourself (this is what the scripts automate):

1. Install Docker + Compose and add your user to the `docker` group.
2. Blacklist DVB drivers so the dongle is free.
3. Create a `docker-compose.yml` and run `docker compose up -d`.
4. Point WaveKit to `tcp://<this-host-ip>:5555`.

## Configuration

All configuration via environment variables with `SDR_HOST_` prefix:

| Variable                         | Default     | Description                    |
| -------------------------------- | ----------- | ------------------------------ |
| `SDR_HOST_RTL_TCP__SAMPLE_RATE`  | `2048000`   | Sample rate in Hz              |
| `SDR_HOST_RTL_TCP__FREQUENCY`    | `446524920` | Initial center frequency in Hz |
| `SDR_HOST_RTL_TCP__BUFFER`       | `512`       | rtl_tcp buffer size            |
| `SDR_HOST_RTL_TCP__AGC`          | `false`     | Enable tuner AGC               |
| `SDR_HOST_RTL_TCP__GAIN`         | `49`        | Manual gain in dB              |
| `SDR_HOST_RTL_TCP__PPM`          | `0`         | PPM correction                 |
| `SDR_HOST_RTL_TCP__DEVICE_INDEX` | `0`         | USB device index               |
| `SDR_HOST_RTLMUX__PORT`          | `5555`      | IQ stream port                 |
| `SDR_HOST_API__PORT`             | `8080`      | Status API port                |
| `SDR_HOST_LOGGING__LEVEL`        | `info`      | Log level                      |

AGC is off by default to match common RTL-SDR setups. When `SDR_HOST_RTL_TCP__AGC` is `true`, manual gain is ignored.
Defaults mirror the legacy Pi systemd service (gain 49 dB, 446.524920 MHz, buffer 512).

## Dev Workflow

Preferred (from repo root):

```bash
make sdr-host-build
make sdr-host-build-multi
```

### Note on GHCR "unknown/unknown"

When publishing multi-arch images, Docker Buildx/BuildKit can also push a **provenance attestation** alongside the real `linux/amd64` + `linux/arm64` images.
GitHub Container Registry may display this extra artifact as OS/Arch `unknown/unknown`.

In this repo, provenance is **disabled by default** for `make sdr-host-build-multi` to keep the GHCR UI to just `amd64` + `arm64`.
If you want provenance anyway:

```bash
WAVEKIT_PROVENANCE=true make sdr-host-build-multi
# or
bash ./packages/sdr-host/scripts/build-publish.sh --multi-arch --provenance
```

Build and publish a new image directly (handles buildx for multi-arch):

```bash
bash ./packages/sdr-host/scripts/build-publish.sh --multi-arch
```

Single-arch (Pi only):

```bash
bash ./packages/sdr-host/scripts/build-publish.sh --platform linux/arm64
```

To avoid repeating your GH owner, add this to a repo-local `.env` or `.env.local` (ignored by git):

```bash
WAVEKIT_GH_OWNER=coriou
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

Make shortcuts (from repo root):

```bash
make sdr-host-health
make sdr-host-logs
```
