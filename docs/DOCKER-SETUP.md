# WaveKit Docker Setup

Production-ready Docker deployment with s6-overlay process supervision.

## Quick Start

```bash
# Build and run
make dev-up

# Open dashboard
make dev-dashboard

# View logs
make dev-logs
```

## Deployment Modes

### Core Mode (Recommended)

API + all decoders. Connect to external SDR++ or rtl_tcp.

```bash
docker run -d --name wavekit \
  -p 9000:3000 -p 8080:8080 -p 1234:1234 \
  -e WAVEKIT_SOURCES_0_HOST=192.168.1.69 \
  -e WAVEKIT_SOURCES_0_PORT=5555 \
  -e WAVEKIT_TUNER_RELAY__ENABLED=true \
  wavekit:latest-core
```

### Full Mode

Everything in one container: SDR++ + API + decoders.

```bash
docker run -d --name wavekit \
  -p 9000:3000 -p 8080:8080 -p 5259:5259 \
  -e RTL_TCP_HOST=192.168.1.100 \
  wavekit:latest
```

### SDR++ Only

Just SDR++ server for dedicated SDR host.

```bash
docker run -d --name sdrpp \
  -p 5259:5259 \
  -e RTL_TCP_HOST=192.168.1.100 \
  wavekit:latest-sdrpp
```

## Building Images

```bash
# Build all variants
make docker-build

# Build specific variant
make docker-build-core   # API + decoders
make docker-build-full   # SDR++ + API + decoders
make docker-build-sdrpp  # SDR++ only
```

## Configuration

### Environment Variables

| Variable                                     | Default | Description                       |
| -------------------------------------------- | ------- | --------------------------------- |
| `WAVEKIT_API_PORT`                           | 3000    | API server port                   |
| `WAVEKIT_LOG_LEVEL`                          | info    | Log level (debug/info/warn/error) |
| `WAVEKIT_SOURCES_0_HOST`                     | -       | First source hostname             |
| `WAVEKIT_SOURCES_0_PORT`                     | -       | First source port                 |
| `WAVEKIT_TUNER_RELAY__ENABLED`               | false   | Enable RTL-TCP tuner relay        |
| `WAVEKIT_TUNER_RELAY__PORT`                  | 1234    | Tuner relay port                  |
| `WAVEKIT_TUNER_RELAY__SOURCE_ID`             | -       | Source ID to expose               |
| `WAVEKIT_TUNER_RELAY__COMMAND_HISTORY_LIMIT` | 200     | Tuner relay command history size  |
| `RTL_TCP_HOST`                               | -       | rtl_tcp host (full mode)          |
| `RTL_TCP_PORT`                               | 1234    | rtl_tcp port (full mode)          |

### Mount Configuration

```bash
docker run -v ./my-config.yaml:/app/config/custom.yaml wavekit:latest-core
```

### Volumes

| Path                 | Purpose                  |
| -------------------- | ------------------------ |
| `/app/config`        | Configuration files      |
| `/var/log/wavekit`   | Log files                |
| `/app/decoded_calls` | Decoded audio recordings |

## Process Management

WaveKit uses s6-overlay for process supervision:

- Proper signal handling (SIGTERM → graceful shutdown)
- Auto-restart of crashed services
- Service dependencies (SDR++ starts before API)

### Service Status

```bash
# Check service status
docker exec wavekit s6-rc-status

# View service logs
docker exec wavekit cat /var/log/wavekit/wavekit.log
```

### Manual Service Control

```bash
# Restart API
docker exec wavekit s6-svc -r /run/service/wavekit-api

# Stop API (will auto-restart)
docker exec wavekit s6-svc -d /run/service/wavekit-api
```

## Health Checks

```bash
# Container health
docker inspect wavekit --format='{{.State.Health.Status}}'

# API health
curl http://localhost:9000/health

# Full status
curl http://localhost:9000/api/status
```

## Audio Streaming

```bash
# Play decoded audio
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Or with ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -
```

## Included Decoders

All 8 decoders are pre-built in the Docker image:

| Decoder     | Binary        | Signals               |
| ----------- | ------------- | --------------------- |
| dsd-fme     | `dsd-fme`     | DMR, P25, YSF, D-Star |
| multimon-ng | `multimon-ng` | POCSAG, FLEX, DTMF    |
| rtl_433     | `rtl_433`     | ISM sensors           |
| readsb      | `readsb`      | ADS-B 1090 MHz        |
| acarsdec    | `acarsdec`    | ACARS VHF             |
| dumpvdl2    | `dumpvdl2`    | VDL2 136 MHz          |
| AIS-catcher | `AIS-catcher` | AIS 162 MHz           |
| direwolf    | `direwolf`    | APRS 144 MHz          |

Verify installation:

```bash
docker exec wavekit which dsd-fme multimon-ng rtl_433 readsb acarsdec dumpvdl2 AIS-catcher direwolf
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs wavekit

# Interactive shell
docker run -it --rm wavekit:latest-core /bin/bash
```

### No decoder output

```bash
# Check decoder status
curl http://localhost:9000/api/decoders

# Check source connection
curl http://localhost:9000/api/sources
```

### Audio not playing

```bash
# Verify audio port is exposed
docker ps --format "{{.Ports}}" | grep 8080

# Test connection
nc -zv localhost 8080
```

## Docker Compose

### Development

```yaml
# docker-compose.dev.yml
services:
  wavekit:
    build:
      context: .
      target: final-core
    ports:
      - "9000:3000"
      - "8080:8080"
    environment:
      WAVEKIT_LOG_LEVEL: debug
    volumes:
      - ./config:/app/config
      - ./logs:/var/log/wavekit
```

### Production

```yaml
# docker-compose.prod.yml
services:
  wavekit:
    image: wavekit:latest-core
    restart: unless-stopped
    ports:
      - "9000:3000"
      - "8080:8080"
    environment:
      WAVEKIT_SOURCES_0_HOST: 192.168.1.69
      WAVEKIT_SOURCES_0_PORT: 5555
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 1G
```

## Multi-Platform Builds

Preferred (from repo root):

```bash
make install-buildx
```

```bash
# Enable buildx (docker-container driver supports multi-arch)
docker buildx create --name wavekit-builder --driver docker-container --use
docker buildx inspect wavekit-builder --bootstrap

# Build for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag wavekit:latest \
  --push .
```
