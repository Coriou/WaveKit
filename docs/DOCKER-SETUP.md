# WaveKit Docker Setup Guide

> **Status**: Production-ready, multi-platform (amd64/arm64/arm/v7)
> **Architecture**: s6-overlay service supervision, BuildKit optimization
> **Deployment Modes**: Full | Core | SDR++-only

## Quick Start

### Development (Full Mode)

```bash
# Build development images
./docker/build.sh full dev

# Run development environment
docker-compose -f docker-compose.dev.yml up

# Access services
curl http://localhost:9000/health        # API health
nc localhost 8080 | sox -t s16le ...    # Audio stream
wscat -c ws://localhost:4713            # WebSocket events
```

### Production (Optimized)

```bash
# Build production image
./docker/build.sh full latest

# Run with docker-compose
docker-compose -f docker-compose.prod.yml up -d

# Or with docker directly
docker run -d \
  -p 9000:9000 \
  -p 8080:8080 \
  -p 4713:4713 \
  -v wavekit-config:/app/config \
  -v recordings:/recordings \
  --restart unless-stopped \
  wavekit:latest
```

---

## Deployment Modes

### 🎯 Full Mode (Recommended for Pi)

Everything in one container. Simple, efficient, no networking overhead.

```mermaid
graph TB
    Pi["RTL-TCP<br/>on Pi"] -->|tcp:1234| Docker["wavekit:latest<br/>Full Mode"]
    Docker -->|tcp:8080| Host["Host<br/>Audio Player"]
    Docker -->|ws:4713| Browser["Browser<br/>Dashboard"]
```

**When to use:**

- Raspberry Pi with integrated setup
- Single-host deployments
- Simplest operational model

**Start:**

```bash
docker run -d \
  --name wavekit \
  -e RTL_TCP_HOST=192.168.1.100 \
  -p 9000:9000 -p 8080:8080 -p 4713:4713 \
  -v wavekit-logs:/var/log/wavekit \
  wavekit:latest
```

**Environment:**
| Variable | Default | Purpose |
|----------|---------|---------|
| WAVEKIT_LOG_LEVEL | info | Logging level (debug/info/warn/error) |
| WAVEKIT_CONFIG_PATH | /app/config | Configuration directory |
| RTL_TCP_HOST | 127.0.0.1 | RTL-TCP server hostname |
| RTL_TCP_PORT | 1234 | RTL-TCP server port |
| NODE_ENV | production | Node.js environment |

---

### 🔌 Core Mode (Distributed Setup)

API + decoders only. Connect to external SDR++ server.

**Advantages:**

- SDR++ on Pi or dedicated host
- Decoders on more powerful machine
- Independent scaling

```mermaid
graph TB
    Pi["Pi + RTL-SDR"] -->|tcp:5259| SdrApp["SDR++ Server<br/>wavekit:latest-sdrpp"]
    SdrApp -->|tcp| WaveKit["wavekit:latest-core<br/>API + Decoders"]
    WaveKit -->|tcp:8080| Host["Audio Stream"]
```

**Start SDR++ on Pi:**

```bash
docker run -d \
  --name wavekit-sdrpp \
  -p 5259:5259 \
  wavekit:latest-sdrpp
```

**Start WaveKit Core on main machine:**

```bash
docker run -d \
  --name wavekit \
  -e SDR_SOURCE=tcp://pi.local:5259 \
  -p 9000:9000 -p 8080:8080 -p 4713:4713 \
  wavekit:latest-core
```

---

### 🛰️ SDR++-Only Mode

Just SDR++ server. Useful for:

- Dedicated SDR hardware host
- Headless Pi setup
- Separating concerns

```bash
docker run -d \
  --name wavekit-sdrpp \
  -p 5259:5259 \
  wavekit:latest-sdrpp
```

---

## Process Management (s6-overlay)

WaveKit uses **s6-overlay** as PID 1, providing:

- ✅ Proper signal handling (SIGTERM → graceful shutdown)
- ✅ Auto-restart of failed services
- ✅ Dependency management (SDR++ before API)
- ✅ Process supervision with accurate status
- ✅ Logging aggregation

### Service Architecture

```
/run/service/
├── base           (oneshot: init system)
├── sdrpp-server   (depends: base)
└── wavekit-api    (depends: sdrpp-server)
```

### Checking Service Status

```bash
# Inside container
docker exec wavekit s6-svstat /run/service/wavekit-api

# From host (via healthcheck)
docker inspect wavekit --format='{{.State.Health.Status}}'
```

### Manual Service Control

```bash
# Stop API (s6-overlay auto-restarts it)
docker exec wavekit s6-svc -d /run/service/wavekit-api

# Stop & keep stopped
docker exec wavekit s6-svc -D /run/service/wavekit-api

# Restart
docker exec wavekit s6-svc -r /run/service/wavekit-api
```

---

## Multi-Platform Builds

### BuildKit Setup

Enable BuildKit for faster, more efficient builds:

```bash
export DOCKER_BUILDKIT=1
export BUILDKIT_PROGRESS=plain

# Or set in Docker daemon config
cat > ~/.docker/config.json <<EOF
{
  "buildkitVersion": "v0.11.0"
}
EOF
```

### Build for Multiple Platforms

```bash
# Build for amd64, arm64, arm/v7
./docker/build.sh full latest

# Or manually
docker buildx create --name wavekit-builder
docker buildx use wavekit-builder

docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  --tag wavekit:latest \
  --push .
```

### Push to Multiple Registries

```bash
./docker/push.sh latest docker.io ghcr.io

# Pushes to:
# - docker.io/wavekit:latest
# - ghcr.io/wavekit:latest
```

---

## Configuration

### Mount Configuration

```bash
docker run -v my-config.yaml:/app/config/custom.yaml wavekit:latest
```

### Configuration Hierarchy

1. `/app/config/default.yaml` (built-in defaults)
2. Environment variables (override)
3. `/app/config/custom.yaml` (mounted config)

### Example Custom Config

```yaml
# /app/config/custom.yaml
api:
  port: 9000
  host: 0.0.0.0

decoders:
  dsd-fme:
    enabled: true
    mode: auto
  multimon-ng:
    enabled: true
    modes: [POCSAG512, FLEX]
  rtl_433:
    enabled: true

sources:
  rtl-tcp:
    host: 192.168.1.100
    port: 1234
```

---

## Logging

### View Logs

```bash
# From host
docker logs -f wavekit

# Inside container
docker exec -it wavekit tail -f /var/log/wavekit/system.log

# All services
docker exec -it wavekit s6-rc-log list
```

### Log Locations

| Service  | Path                            |
| -------- | ------------------------------- |
| System   | `/var/log/wavekit/system.log`   |
| API      | `/var/log/wavekit/wavekit.log`  |
| Decoders | `/var/log/wavekit/decoders.log` |
| SDR++    | `/var/log/wavekit/sdrpp.log`    |

### Configure Logging

```bash
docker run -e WAVEKIT_LOG_LEVEL=debug wavekit:latest
```

---

## Health Checks

### Container Health

```bash
# Check status
docker ps --format "table {{.Names}}\t{{.Status}}"

# Inspect detailed health
docker inspect wavekit --format='{{json .State.Health}}' | jq .
```

### Service Health Endpoints

```bash
# API health
curl http://localhost:9000/health

# Full status
curl http://localhost:9000/api/status

# Decoder status
curl http://localhost:9000/api/decoders
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker logs wavekit

# Check s6-overlay errors
docker exec wavekit cat /var/log/s6-rc.log

# Interactive shell
docker run -it --rm wavekit:latest /bin/bash
```

### Services Not Starting

```bash
# Check service status
docker exec wavekit s6-rc-status

# View service logs
docker exec wavekit s6-rc-log list
docker exec wavekit s6-rc-log show wavekit-api
```

### SDR++ Connection Issues

```bash
# Test connectivity from container
docker exec wavekit bash -c \
  'timeout 2 nc -zv sdrpp-server 5259'

# Or verify in API logs
docker logs -f wavekit | grep -i "sdr\|connect"
```

### Performance Issues

```bash
# Check resource usage
docker stats wavekit

# Increase limits in docker-compose
cpu: "2"
memory: 1G

# or via docker run
--cpus 2 --memory 1g
```

---

## Volume Management

### Essential Volumes

| Path               | Purpose          | Persistence |
| ------------------ | ---------------- | ----------- |
| `/app/config`      | Configuration    | Recommended |
| `/var/log/wavekit` | Logs             | Optional    |
| `/recordings`      | Audio recordings | Required    |

### Create Named Volume

```bash
docker volume create wavekit-config
docker run -v wavekit-config:/app/config wavekit:latest
```

### Backup Configuration

```bash
docker run --rm \
  -v wavekit-config:/app/config \
  -v $(pwd):/backup \
  alpine tar czf /backup/wavekit-config.tar.gz -C / app/config
```

### Restore Configuration

```bash
docker run --rm \
  -v wavekit-config:/app/config \
  -v $(pwd):/backup \
  alpine tar xzf /backup/wavekit-config.tar.gz -C /
```

---

## Audio Streaming

### Connect to Audio Stream

```bash
# On host machine
nc localhost 8080 | sox -t s16le -r 48000 -c 1 -b 16 -e signed-integer - -d

# Or with ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -
```

### Audio Format

- **Format**: S16LE (16-bit signed, little-endian)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)
- **Bitrate**: 1.5 Mbps

---

## Security

### Network Security

```bash
# Don't expose all ports
docker run -p 9000:9000 wavekit:latest  # API only

# Use internal Docker network
docker network create wavekit-net
docker run --network wavekit-net wavekit:latest
```

### User Privileges

```bash
# Run as non-root (if decoder supports it)
docker run --user 1000:1000 wavekit:latest

# Or keep root (required for process management)
docker run --user 0:0 wavekit:latest
```

### Secrets

```bash
# Use Docker secrets (Swarm mode)
docker secret create wavekit-config my-config.yaml

# Or environment variables
docker run -e DATABASE_URL=... wavekit:latest
```

---

## Performance Tuning

### CPU & Memory

```yaml
# docker-compose.yml
services:
  wavekit:
    deploy:
      resources:
        limits:
          cpus: "2" # 2 CPU cores
          memory: 1G # 1 GB RAM
        reservations:
          cpus: "1" # Reserve 1 core
          memory: 512M # Reserve 512 MB
```

### Decoder Optimization

```bash
docker run -e DECODER_THREADS=4 wavekit:latest
```

### Storage

```bash
# Use local driver for performance
docker run -v wavekit-data:/recordings --volume-driver local wavekit:latest

# Or bind mount (even faster, but less portable)
docker run -v /fast/ssd/recordings:/recordings wavekit:latest
```

---

## Docker Compose Examples

### Minimal Setup (Pi with rtl_tcp)

```yaml
version: "3.9"
services:
  wavekit:
    image: wavekit:latest
    environment:
      RTL_TCP_HOST: 192.168.1.100
      RTL_TCP_PORT: 1234
    ports:
      - "9000:9000"
      - "8080:8080"
      - "4713:4713"
    restart: unless-stopped
```

### Full Stack (with monitoring)

```bash
docker-compose -f docker-compose.prod.yml up -d

# Monitoring available at:
# - Grafana: http://localhost:3000
# - Prometheus: http://localhost:9090
```

---

## Maintenance

### Update Image

```bash
# Pull latest
docker pull wavekit:latest

# Rebuild locally
./docker/build.sh full latest

# Stop old container & start new
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d
```

### Clean Up

```bash
# Remove unused images
docker image prune -a

# Remove stopped containers
docker container prune

# Remove unused volumes
docker volume prune
```

### Backup & Restore

```bash
# Backup
docker run --rm \
  -v wavekit-config:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/wavekit-backup.tar.gz -C / data

# Restore
docker volume create wavekit-config
docker run --rm \
  -v wavekit-config:/data \
  -v $(pwd):/backup \
  alpine tar xzf /backup/wavekit-backup.tar.gz -C /
```

---

## Supported Decoders

WaveKit includes **8 signal decoders** pre-built in the Docker image, covering digital voice, paging, aviation, maritime, and IoT protocols.

### Decoder Overview

| Decoder         | Binary        | Protocol/Signal                                       | Frequency Range     |
| --------------- | ------------- | ----------------------------------------------------- | ------------------- |
| **dsd-fme**     | `dsd-fme`     | Digital voice (DMR, P25, YSF, D-Star, NXDN, ProVoice) | VHF/UHF             |
| **multimon-ng** | `multimon-ng` | Pager protocols (POCSAG, FLEX, EAS, DTMF)             | VHF/UHF             |
| **rtl_433**     | `rtl_433`     | ISM band sensors, weather stations                    | 315/433/868/915 MHz |
| **acarsdec**    | `acarsdec`    | ACARS aircraft data link                              | 129-137 MHz         |
| **AIS-catcher** | `AIS-catcher` | Maritime AIS transponders                             | 161.975/162.025 MHz |
| **direwolf**    | `direwolf`    | APRS amateur radio packets                            | 144.39 MHz (NA)     |
| **dumpvdl2**    | `dumpvdl2`    | VDL Mode 2 aviation data link                         | 136.725-136.975 MHz |
| **readsb**      | `readsb`      | ADS-B aircraft transponders                           | 1090 MHz            |

### dsd-fme (Digital Voice)

**Purpose**: Decodes digital voice protocols used by public safety, commercial, and amateur radio systems.

**Supported Modes**:

- DMR (Digital Mobile Radio) - Tier I/II/III
- P25 Phase 1 & Phase 2
- YSF (Yaesu System Fusion)
- D-Star
- NXDN
- ProVoice

**Configuration**:

```yaml
decoders:
  dsd-fme:
    enabled: true
    mode: auto # auto, dmr, p25, ysf, dstar, nxdn
    outputFormat: wav # wav, raw
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__DSD_FME__ENABLED=true
WAVEKIT_DECODERS__DSD_FME__MODE=auto
```

**Command Line Options**:

```bash
# Inside container
dsd-fme -i - -o /dev/null -w decoded.wav
dsd-fme --version
```

**Troubleshooting dsd-fme**:

| Issue              | Cause             | Solution                                        |
| ------------------ | ----------------- | ----------------------------------------------- |
| No audio output    | Wrong sample rate | Ensure input is 48kHz S16LE mono                |
| Garbled audio      | Mode mismatch     | Try `mode: auto` or specify correct mode        |
| "mbelib not found" | Missing library   | Verify `/usr/local/lib/libmbe*` exists          |
| High CPU usage     | Complex signal    | Normal for P25 Phase 2; consider dedicated host |

### multimon-ng (Pager Protocols)

**Purpose**: Decodes pager and signaling protocols including POCSAG, FLEX, and emergency alerts.

**Supported Modes**:

- POCSAG (512/1200/2400 baud)
- FLEX
- EAS (Emergency Alert System)
- DTMF
- ZVEI
- SCOPE

**Configuration**:

```yaml
decoders:
  multimon-ng:
    enabled: true
    modes:
      - POCSAG512
      - POCSAG1200
      - POCSAG2400
      - FLEX
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__MULTIMON_NG__ENABLED=true
WAVEKIT_DECODERS__MULTIMON_NG__MODES=POCSAG512,POCSAG1200,FLEX
```

**Command Line Options**:

```bash
# Inside container
multimon-ng -a POCSAG512 -a POCSAG1200 -t raw -
multimon-ng -h  # Show all available modes
```

**Troubleshooting multimon-ng**:

| Issue            | Cause              | Solution                                            |
| ---------------- | ------------------ | --------------------------------------------------- |
| No decodes       | Wrong frequency    | Verify pager frequency (common: 152.48, 157.45 MHz) |
| Partial messages | Weak signal        | Improve antenna or reduce squelch                   |
| "Unknown format" | Wrong input format | Use `-t raw` for S16LE input                        |
| Missing modes    | Not compiled in    | All modes included in WaveKit build                 |

### rtl_433 (ISM Band Sensors)

**Purpose**: Decodes signals from wireless sensors, weather stations, tire pressure monitors, and IoT devices.

**Supported Devices**: 200+ device protocols including:

- Weather stations (Acurite, Oregon Scientific, LaCrosse)
- Temperature/humidity sensors
- Tire pressure monitors (TPMS)
- Smoke/CO detectors
- Door/window sensors
- Smart home devices

**Configuration**:

```yaml
decoders:
  rtl_433:
    enabled: true
    frequency: 433920000 # 433.92 MHz (default)
    protocols: [] # Empty = all protocols
    outputFormat: json
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__RTL_433__ENABLED=true
WAVEKIT_DECODERS__RTL_433__FREQUENCY=433920000
```

**Command Line Options**:

```bash
# Inside container
rtl_433 -F json -M time:utc -M level
rtl_433 -R 40 -R 41  # Specific protocols only
rtl_433 -V           # Version info
```

**Troubleshooting rtl_433**:

| Issue               | Cause                  | Solution                                      |
| ------------------- | ---------------------- | --------------------------------------------- |
| No devices detected | Wrong frequency        | Try 315 MHz (US) or 868 MHz (EU)              |
| Unknown device      | Protocol not supported | Check `rtl_433 -R help` for supported devices |
| Duplicate messages  | Normal behavior        | Use `-M level` to filter by signal strength   |
| High noise floor    | Interference           | Add bandpass filter or relocate antenna       |

### acarsdec (ACARS Aviation)

**Purpose**: Decodes ACARS (Aircraft Communications Addressing and Reporting System) messages from aircraft.

**Frequencies**: 129.125, 130.025, 130.425, 130.450, 131.125, 131.450, 131.525, 131.550, 131.725 MHz

**Configuration**:

```yaml
decoders:
  acarsdec:
    enabled: true
    frequencies:
      - 131550000 # Primary ACARS
      - 130025000 # Secondary
    gain: 40
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__ACARSDEC__ENABLED=true
WAVEKIT_DECODERS__ACARSDEC__FREQUENCIES=131550000,130025000
```

**Command Line Options**:

```bash
# Inside container
acarsdec -v -o 4 -j 127.0.0.1:5555 -r 0 131.550 130.025
acarsdec -h  # Help
```

**Troubleshooting acarsdec**:

| Issue           | Cause                | Solution                                 |
| --------------- | -------------------- | ---------------------------------------- |
| No messages     | No aircraft overhead | ACARS requires line-of-sight to aircraft |
| Partial decodes | Weak signal          | Increase gain, improve antenna           |
| "No RTL device" | Using audio input    | acarsdec expects RTL-SDR; use audio mode |
| Garbled output  | Wrong sample rate    | Ensure 12.5 kHz channel spacing          |

### AIS-catcher (Maritime AIS)

**Purpose**: Decodes AIS (Automatic Identification System) transponder signals from ships and vessels.

**Frequencies**: 161.975 MHz (Channel A), 162.025 MHz (Channel B)

**Configuration**:

```yaml
decoders:
  ais-catcher:
    enabled: true
    channels:
      - 161975000 # AIS Channel A
      - 162025000 # AIS Channel B
    outputFormat: json
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__AIS_CATCHER__ENABLED=true
WAVEKIT_DECODERS__AIS_CATCHER__CHANNELS=161975000,162025000
```

**Command Line Options**:

```bash
# Inside container
AIS-catcher -v 10 -gr RTLAGC on TUNER auto
AIS-catcher -h  # Help
```

**Troubleshooting AIS-catcher**:

| Issue             | Cause               | Solution                                  |
| ----------------- | ------------------- | ----------------------------------------- |
| No ships detected | Too far from water  | AIS requires proximity to shipping lanes  |
| Weak signals      | Poor antenna        | Use marine VHF antenna, outdoor placement |
| Missing messages  | Single channel      | Monitor both 161.975 and 162.025 MHz      |
| Duplicate vessels | Normal AIS behavior | Messages repeat every 2-10 seconds        |

### direwolf (APRS)

**Purpose**: Decodes APRS (Automatic Packet Reporting System) packets used by amateur radio operators.

**Frequencies**: 144.390 MHz (North America), 144.800 MHz (Europe)

**Configuration**:

```yaml
decoders:
  direwolf:
    enabled: true
    frequency: 144390000 # APRS NA
    callsign: N0CALL # Your callsign (receive-only OK)
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__DIREWOLF__ENABLED=true
WAVEKIT_DECODERS__DIREWOLF__FREQUENCY=144390000
```

**Command Line Options**:

```bash
# Inside container
direwolf -r 48000 -n 1 -b 16 -
direwolf -h  # Help
```

**Troubleshooting direwolf**:

| Issue                | Cause                | Solution                                |
| -------------------- | -------------------- | --------------------------------------- |
| No packets           | Wrong frequency      | Verify local APRS frequency             |
| CRC errors           | Weak signal          | Improve antenna, check for interference |
| "Audio device" error | Wrong input mode     | Use stdin mode with `-`                 |
| Slow decoding        | Sample rate mismatch | Ensure 48kHz input                      |

### dumpvdl2 (VDL2 Aviation)

**Purpose**: Decodes VDL Mode 2 (VHF Data Link) messages, a newer aviation data link protocol.

**Frequencies**: 136.725, 136.775, 136.800, 136.825, 136.875, 136.900, 136.925, 136.975 MHz

**Configuration**:

```yaml
decoders:
  dumpvdl2:
    enabled: true
    frequencies:
      - 136975000 # Primary VDL2
      - 136875000 # Secondary
    outputFormat: json
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__DUMPVDL2__ENABLED=true
WAVEKIT_DECODERS__DUMPVDL2__FREQUENCIES=136975000,136875000
```

**Command Line Options**:

```bash
# Inside container
dumpvdl2 --output decoded:json:file:path=/dev/stdout 136975000 136875000
dumpvdl2 --version
```

**Troubleshooting dumpvdl2**:

| Issue            | Cause                   | Solution                                    |
| ---------------- | ----------------------- | ------------------------------------------- |
| No messages      | Limited VDL2 coverage   | VDL2 less common than ACARS in some regions |
| "libacars" error | Missing library         | Verify `/usr/local/lib/libacars*` exists    |
| Partial decodes  | Multi-path interference | Improve antenna placement                   |
| High CPU         | Multiple frequencies    | Normal; consider dedicated host             |

### readsb (ADS-B)

**Purpose**: Decodes ADS-B (Automatic Dependent Surveillance-Broadcast) transponder signals from aircraft at 1090 MHz.

**Frequency**: 1090 MHz

**Configuration**:

```yaml
decoders:
  readsb:
    enabled: true
    gain: 49.6 # RTL-SDR gain
    ppm: 0 # Frequency correction
    outputFormat: json
```

**Environment Variables**:

```bash
WAVEKIT_DECODERS__READSB__ENABLED=true
WAVEKIT_DECODERS__READSB__GAIN=49.6
```

**Command Line Options**:

```bash
# Inside container
readsb --net --quiet --device-type rtlsdr
readsb --version
```

**Troubleshooting readsb**:

| Issue           | Cause             | Solution                                                 |
| --------------- | ----------------- | -------------------------------------------------------- |
| No aircraft     | Wrong antenna     | 1090 MHz requires specific antenna (not general purpose) |
| Low range       | Gain too high/low | Experiment with gain values (try 40-50)                  |
| Position errors | No MLAT           | Single receiver can't determine position without ADS-B   |
| "No RTL device" | Device in use     | Only one process can use RTL-SDR at a time               |

### Verifying Decoder Installation

```bash
# Check all decoders are installed
docker exec wavekit bash -c '
  echo "=== Decoder Verification ==="
  which dsd-fme && dsd-fme --version
  which multimon-ng && multimon-ng -h 2>&1 | head -1
  which rtl_433 && rtl_433 -V 2>&1 | head -1
  which acarsdec && echo "acarsdec: installed"
  which AIS-catcher && echo "AIS-catcher: installed"
  which direwolf && echo "direwolf: installed"
  which dumpvdl2 && dumpvdl2 --version 2>&1 | head -1
  which readsb && readsb --version 2>&1 | head -1
'
```

### Decoder Resource Requirements

| Decoder     | CPU (idle) | CPU (active) | Memory | Notes                     |
| ----------- | ---------- | ------------ | ------ | ------------------------- |
| dsd-fme     | ~1%        | 15-30%       | 50 MB  | Higher for P25 Phase 2    |
| multimon-ng | ~1%        | 5-10%        | 20 MB  | Low overhead              |
| rtl_433     | ~1%        | 5-15%        | 30 MB  | Depends on protocol count |
| acarsdec    | ~1%        | 10-20%       | 40 MB  | Per frequency monitored   |
| AIS-catcher | ~1%        | 10-20%       | 50 MB  | Dual channel monitoring   |
| direwolf    | ~1%        | 5-10%        | 30 MB  | Low overhead              |
| dumpvdl2    | ~1%        | 15-25%       | 60 MB  | Per frequency monitored   |
| readsb      | ~2%        | 10-20%       | 80 MB  | Depends on aircraft count |

---

## Architecture Decision Records

### Why s6-overlay?

| Aspect             | s6-overlay           | supervisord   | Docker multi-process |
| ------------------ | -------------------- | ------------- | -------------------- |
| PID 1 handling     | ✅ Native            | ❌ Delegate   | ⚠️ Manual            |
| Signal propagation | ✅ Proper SIGTERM    | ⚠️ Unreliable | ❌ Missed signals    |
| Dependency mgmt    | ✅ Built-in          | ⚠️ Complex    | ❌ None              |
| Container size     | ✅ 5MB               | ❌ 50MB       | ✅ Smallest          |
| Industry adoption  | ✅ Alpine, Baseimage | ❌ Legacy     | ⚠️ Discouraged       |

### Why Multi-Stage Builds?

- 🏗️ Separate build and runtime environments
- 📦 Only final dependencies in image
- 🚀 Faster builds with better caching
- 🔐 Reduced attack surface

### Why BuildKit?

- ⚡ Parallel stage building
- 💾 Persistent caching (`--mount=type=cache`)
- 📐 Better layer management
- 🔄 Improved incremental builds

---

## References

- [s6-overlay Documentation](https://skarnet.org/software/s6-overlay/)
- [Docker BuildKit](https://docs.docker.com/build/buildkit/)
- [Docker Compose](https://docs.docker.com/compose/)
- [WaveKit GitHub](https://github.com/your-org/wavekit)
