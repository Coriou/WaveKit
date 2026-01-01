# WaveKit Docker Quick Reference

**Production-ready Docker setup with complete process management, multi-platform support, and three deployment modes.**

## 🚀 Quick Start (60 seconds)

```bash
# Initialize environment (first time only)
./docker/init.sh

# Build images
make docker-build

# Start development environment
make docker-dev

# View logs
make docker-logs

# Open API
curl http://localhost:9000/health
```

## 📦 Three Deployment Modes

| Mode           | Size  | Use Case                   | Contains             |
| -------------- | ----- | -------------------------- | -------------------- |
| **Full**       | 1.2GB | Single-host (Raspberry Pi) | SDR++, API, Decoders |
| **Core**       | 550MB | Distributed setup          | API, Decoders only   |
| **SDR++-only** | 450MB | Dedicated SDR host         | SDR++ server only    |

## 🎯 Build & Run

### Development (with hot reload)

```bash
make docker-dev          # Builds & starts dev environment
make docker-logs         # View logs in real-time
make docker-shell        # Open container shell
```

### Production (optimized)

```bash
make docker-build        # Build all three modes
make docker-prod         # Start production stack

# Or Docker only:
docker run -d -p 9000:9000 -p 8080:8080 wavekit:latest
```

### Full Mode (Pi Setup)

```bash
docker run -d \
  --name wavekit \
  -e RTL_TCP_HOST=192.168.1.100 \
  -p 9000:9000 -p 8080:8080 \
  wavekit:latest
```

## 📊 Services & Ports

| Service      | Port | Purpose                 |
| ------------ | ---- | ----------------------- |
| REST API     | 9000 | System control & status |
| WebSocket    | 4713 | Real-time events        |
| Audio Stream | 8080 | Decoded audio output    |
| SDR++ Server | 5259 | IQ stream provider      |

## 🔍 Monitoring

```bash
# Service status
make docker-status

# Container health
docker ps --format "table {{.Names}}\t{{.Status}}"

# Detailed logs
make docker-logs-api         # API logs
make docker-logs-sdrpp       # SDR++ logs
make docker-logs-decoders    # Decoder logs
```

## 🛠️ Available Make Targets

```bash
make help                    # Show all commands

# Build
make docker-build           # Build all modes
make docker-build-full      # Build full mode only
make docker-build-core      # Build core mode only
make docker-build-sdrpp     # Build SDR++ mode only

# Run
make docker-dev             # Start development
make docker-prod            # Start production
make docker-compose-down    # Stop all services

# Utilities
make docker-logs            # Tail logs
make docker-shell           # Open shell
make docker-clean           # Remove containers
make docker-prune           # Cleanup unused resources
make install-buildx         # Setup multi-platform builds
```

## 📋 Service Architecture

```
wavekit/
├── Dockerfile                 # Multi-stage, three targets
├── docker-compose.dev.yml     # Development setup
├── docker-compose.prod.yml    # Production setup
├── docker-compose.override.yml # Local overrides
├── Makefile                   # Quick commands
├── .dockerignore              # Build optimization
└── docker/
    ├── build.sh              # Build script
    ├── push.sh               # Push to registries
    ├── init.sh               # Environment setup
    ├── buildkit.toml         # BuildKit config
    ├── scripts/
    │   └── healthcheck.sh    # Health check
    └── overlay/
        └── s6-overlay/       # Service definitions
            └── s6-rc.d/
                ├── base/     # System initialization
                ├── sdrpp-server/     # SDR++ service
                └── wavekit-api/      # WaveKit API service
```

## 🔧 Configuration

### Environment Variables

```bash
# API
WAVEKIT_LOG_LEVEL=info      # Logging level
WAVEKIT_CONFIG_PATH=/app/config

# Sources
RTL_TCP_HOST=192.168.1.100  # RTL-TCP hostname
RTL_TCP_PORT=1234            # RTL-TCP port
SDR_SOURCE=tcp://host:5259   # External SDR++ (core mode)

# Runtime
NODE_ENV=production
```

### Volume Mounts

```yaml
volumes:
  - wavekit-config:/app/config # Configuration
  - wavekit-logs:/var/log/wavekit # Logs
  - recordings:/recordings # Audio files
```

## 🐛 Troubleshooting

### Check container health

```bash
docker inspect wavekit --format='{{.State.Health.Status}}'
```

### View service status

```bash
docker exec wavekit s6-rc-status
```

### Verify decoder installation

```bash
docker run wavekit:latest /bin/bash -c 'which dsd-fme multimon-ng rtl_433'
```

### Test API connectivity

```bash
curl -v http://localhost:9000/api/status
```

## 📚 Full Documentation

See [docs/DOCKER-SETUP.md](../DOCKER-SETUP.md) for comprehensive documentation including:

- Detailed deployment modes
- s6-overlay process management
- Multi-platform builds
- Performance tuning
- Security considerations
- Advanced customization

## 🚢 Multi-Platform Builds

```bash
# Setup buildx
make install-buildx

# Build for amd64, arm64, arm/v7
make docker-build BUILDKIT=1

# Push to registry
make docker-push REGISTRY=docker.io/myuser
```

## ✨ Key Features

✅ **Production-ready**: s6-overlay init system with proper signal handling  
✅ **Efficient**: Multi-stage builds, layer caching, minimal runtime  
✅ **Multi-platform**: amd64, arm64, arm/v7 support  
✅ **Flexible**: Three deployment modes (full/core/sdrpp-only)  
✅ **Observable**: Health checks, logging, service supervision  
✅ **Developer-friendly**: Hot reload, easy debugging, Makefile shortcuts
