# WaveKit

**TypeScript-based SDR stream processing framework**

WaveKit connects to Software Defined Radio (SDR) sources and decodes multiple signal types in parallel. Connect an SDR (RTL-SDR, Airspy, HackRF) via TCP, and WaveKit automatically processes the stream through 8 specialized decoders—capturing aircraft (ADS-B), ships (AIS), aircraft datalinks (VDL2/ACARS), amateur radio (APRS), pager signals, and IoT sensors. Decoded data flows to applications via REST API and WebSocket, with audio playback available over TCP.

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

## What It Does

1. **Receives SDR data** over TCP from rtl_tcp, SDR++ network sink, or recorded files
2. **Multiplexes streams** to multiple decoders in parallel with independent buffering
3. **Decodes signals** using 8 specialized external programs (all implemented)
4. **Streams output** via REST API and WebSocket to applications
5. **Manages lifecycle** with auto-reconnect, health monitoring, and graceful degradation

## Quick Start

### Local Development

```bash
git clone https://github.com/coriou/wavekit.git
cd wavekit
npm install

# Start dev server with hot reload
npm run dev

# In another terminal, start your SDR source
rtl_tcp -a 127.0.0.1 -p 1234

# View logs and API at http://localhost:3000
```

### Using Docker

```bash
# Build the image locally
docker build -t wavekit:latest .

# Run it (connects to rtl_tcp on host machine)
docker run -p 3000:3000 -p 8080:8080 \
  -e WAVEKIT_SOURCES_0_HOST=host.docker.internal \
  -e WAVEKIT_SOURCES_0_PORT=1234 \
  wavekit:latest
```

## CLI Dashboard (Main UI)

WaveKit includes an interactive terminal dashboard (Ink/React) that connects **only** via the same REST API + WebSocket server that the future web UI will use.

- Run: `make dev-dashboard`
- Keys: `1-5` switch tabs, `r` reconnect, `q` quit
- Configure endpoints (optional): `WAVEKIT_WS_URLS`, `WAVEKIT_WS_URL`, `WAVEKIT_API_URL`

Notes:

- The dashboard is implemented in `cli/`.
- For best results, run the WaveKit dev container first (`make dev-up`) so the dashboard can connect to `ws://localhost:9000/ws` / `ws://localhost:4713/ws`.

## How It Works

```
┌──────────────────┐
│  SDR Source      │  rtl_tcp, SDR++ network sink, or recording file
│  (TCP Input)     │
└────────┬─────────┘
         │
         ▼ Raw audio/IQ data
┌──────────────────────────────────────┐
│   WaveKit Application (TypeScript)   │
│                                      │
│  • SourceManager: Connects, reconnects, metrics
│  • FanoutManager: Copies stream to all decoders
│  • Format Converter: Audio format transforms
│  • 8 Decoder Processes (running in parallel):
│    - dsd-fme (DMR/P25/YSF/D-Star)
│    - multimon-ng (POCSAG/FLEX pagers)
│    - rtl_433 (IoT sensors)
│    - readsb (ADS-B aircraft)
│    - dumpvdl2 (VDL2 aviation datalink)
│    - acarsdec (ACARS aircraft)
│    - AIS-catcher (Maritime AIS)
│    - direwolf (APRS amateur radio)
│  • Fastify API Server with WebSocket
│                                      │
└──────────┬──────────────┬───────────┘
           │              │
      Decoded events    Audio stream
           │              │
           ▼              ▼
    WebSocket clients   TCP audio output
    REST API clients    (sox, ffplay, etc)
```

## Decoders (All 8 Implemented)

| Decoder         | Signals                               | Output            | Integration      |
| --------------- | ------------------------------------- | ----------------- | ---------------- |
| **dsd-fme**     | DMR, P25, YSF, D-Star, NXDN, ProVoice | Audio + metadata  | Process spawning |
| **multimon-ng** | POCSAG, FLEX, EAS, DTMF               | Text/metadata     | Process spawning |
| **rtl_433**     | ISM band sensors, weather stations    | JSON/text         | Process spawning |
| **readsb**      | ADS-B aircraft radar                  | JSON (beast/json) | Network sink     |
| **dumpvdl2**    | VDL2 aviation datalinks               | JSON/text         | Process spawning |
| **acarsdec**    | ACARS aircraft datalink               | JSON/text         | Process spawning |
| **AIS-catcher** | Maritime AIS transponders             | JSON/NMEA         | Network sink     |
| **direwolf**    | APRS amateur radio packets            | Frames            | Beacon mode      |

## API Endpoints

All endpoints on `http://localhost:3000`:

### Health & Status

```bash
# Liveness probe (200 OK or 503)
curl http://localhost:3000/health

# Readiness probe (includes component status)
curl http://localhost:3000/health/ready

# Full system status (sources, decoders, metrics)
curl http://localhost:3000/api/status
```

### Sources

```bash
# List all configured sources
curl http://localhost:3000/api/sources

# Add a new source
curl -X POST http://localhost:3000/api/sources \
  -H "Content-Type: application/json" \
  -d '{
    "id": "rtl_pi",
    "type": "rtl_tcp",
    "host": "192.168.1.100",
    "port": 1234,
    "caps": {
      "kind": "audio_pcm",
      "sampleRate": 48000,
      "format": "S16LE",
      "exclusive": false
    }
  }'

# Remove a source
curl -X DELETE http://localhost:3000/api/sources/rtl_pi
```

### Decoders

```bash
# List all decoders and their status
curl http://localhost:3000/api/decoders

# Start a decoder
curl -X POST http://localhost:3000/api/decoders/readsb/start

# Stop a decoder
curl -X POST http://localhost:3000/api/decoders/readsb/stop

# Update decoder config
curl -X PATCH http://localhost:3000/api/decoders/readsb \
  -H "Content-Type: application/json" \
  -d '{ "args": ["--json-dir", "/tmp/adsb"] }'
```

### WebSocket Events

Connect to `ws://localhost:3000/ws` and subscribe to channels:

```javascript
const ws = new WebSocket("ws://localhost:3000/ws")

// Subscribe to decoder output events
ws.send(
	JSON.stringify({
		type: "subscribe",
		channels: ["decoders", "sources", "metrics", "health"],
	}),
)

ws.onmessage = event => {
	const msg = JSON.parse(event.data)
	// msg.type: 'decoder:output', 'source:connected', 'metrics', 'decoder:health', etc
	// msg.channel: 'decoders' | 'sources' | 'metrics' | 'health'
	// msg.data: event data
}
```

Channels:

- **decoders**: Decoder output, started/stopped/error events
- **sources**: Source connected/disconnected events
- **metrics**: Stream data rate metrics (~5s intervals)
- **health**: Decoder health state changes (running/idle/faulted)

## Configuration

Configuration is YAML in `config/default.yaml`. Override with environment variables prefixed `WAVEKIT_`:

```yaml
# API server
api:
  host: 0.0.0.0
  port: 3000

# Audio output TCP server
audio:
  format: S16LE # S16LE or FLOAT32LE
  sampleRate: 48000 # Hz
  tcpPort: 8080 # TCP port for sox/ffplay

# Log level
log:
  level: info # trace, debug, info, warn, error

# SDR sources (connect via TCP)
sources: []
# Example:
# - id: rtl_pi
#   type: rtl_tcp
#   host: 192.168.1.100
#   port: 1234
#   caps:
#     kind: audio_pcm
#     sampleRate: 48000
#     format: S16LE
#     exclusive: false

# Decoders to run
decoders:
  dsd_fme:
    enabled: true
    args: ["-i", "stdin", "-o", "stdout"]
  readsb:
    enabled: true
    args: ["--json-dir", "/tmp/adsb"]
  # ... others
```

Environment variable examples:

```bash
WAVEKIT_API_PORT=3000
WAVEKIT_AUDIO_SAMPLE_RATE=48000
WAVEKIT_LOG_LEVEL=debug
WAVEKIT_SOURCES_0_HOST=192.168.1.100
WAVEKIT_SOURCES_0_PORT=1234
```

## RTL-SDR Tuner Setup

For optimal signal reception with RTL-SDR dongles:

### Recommended rtl_tcp Settings

```bash
# Enable AGC mode (-g 0) for automatic gain control
rtl_tcp -a 0.0.0.0 -p 1234 -f 446524920 -s 2048000 -g 0

# Parameters:
#   -a 0.0.0.0    Listen on all interfaces
#   -p 1234       Port (use 1235 for rtlmux)
#   -f 446524920  Center frequency (Hz)
#   -s 2048000    Sample rate: 2.048 Msps (not 2.4!)
#   -g 0          AGC mode (critical for weak signals)
```

> [!IMPORTANT]
> **Use AGC mode (`-g 0`)** instead of fixed gain. Fixed maximum gain (`-g 49.6`) can result in weak signals using only 6-7% of the ADC dynamic range, causing FM demodulation to fail.

### Sample Rate

WaveKit uses **2.048 Msps** (2,048,000 samples/second), not 2.4 Msps. This affects:

- Filter bandwidth calculations
- Decimation factors in the csdr pipeline
- Audio sample rate after demodulation

### systemd Service (Linux/Pi)

```ini
# /etc/systemd/system/rtl_tcp.service
[Unit]
Description=RTL-SDR TCP Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/rtl_tcp -a 0.0.0.0 -p 1234 -f 446524920 -s 2048000 -g 0
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Using with rtlmux

For multiple clients (e.g., SDR++ and WaveKit simultaneously), use [rtlmux](https://github.com/alexander-sholohov/rtlmux):

```bash
# rtlmux forwards rtl_tcp (port 1234) to multiple clients on port 1235
rtlmux -s 192.168.1.69:1234 -l 0.0.0.0:1235
```

## Development

### Project Structure

```
src/
├── index.ts              # Entry point, wires components
├── config.ts             # Config loading and validation (Zod)
├── bootstrap.ts          # Environment setup
│
├── core/                 # Stream processing
│   ├── source-manager.ts   # TCP client for SDR sources
│   ├── fanout-manager.ts   # Stream multiplexer
│   ├── format-converter.ts # Audio format transforms
│   └── audio-output.ts     # TCP server for audio playback
│
├── decoders/             # Decoder plugin system
│   ├── types.ts           # Decoder interfaces
│   ├── base-decoder.ts    # Abstract base class for decoders
│   ├── manager.ts         # Manages decoder lifecycle
│   ├── registry.ts        # Registers decoders
│   └── builtin/           # 8 built-in decoders
│       ├── dsd-fme.ts
│       ├── readsb.ts
│       ├── acarsdec.ts
│       ├── ais-catcher.ts
│       ├── dumpvdl2.ts
│       ├── direwolf.ts
│       ├── multimon-ng.ts
│       └── rtl433.ts
│
├── api/                  # Fastify REST/WebSocket server
│   ├── server.ts         # Fastify setup, plugins, error handling
│   ├── routes/
│   │   ├── health.ts     # Health check endpoints
│   │   ├── sources.ts    # Source management
│   │   └── decoders.ts   # Decoder management
│   └── websocket/
│       └── events.ts     # WebSocket event broadcaster
│
└── utils/
    ├── logger.ts         # Pino structured logging
    ├── errors.ts         # Custom error classes
    ├── health-check.ts   # Health monitoring
    ├── version.ts        # Decoder version validation
    └── graceful-shutdown.ts  # SIGTERM handling
```

### Code Style

- **Tabs** for indentation (see `.editorconfig`)
- **No semicolons**
- **Strict TypeScript** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **Type imports**: `import type { Foo } from 'bar'`
- **ESLint + Prettier** configured and enforced

### Common Tasks

```bash
# Development with hot reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Formatting
npm run format

# Build
npm run build-file ./src/index.ts
npm start

# Tests
npm test
npm run test:watch
npm run test:coverage
```

### Adding a New Decoder

1. Create `src/decoders/builtin/my-decoder.ts` extending `BaseDecoder`
2. Implement `Decoder` interface and parsing logic
3. Register in `src/decoders/index.ts`
4. Add to `config/default.yaml` with default args
5. Add tests in `tests/unit/decoders/builtin/`

Example decoder:

```typescript
import { BaseDecoder } from "../base-decoder.js"
import type { DecoderCaps, DecoderOutput } from "../types.js"

export const MY_DECODER_CAPS: DecoderCaps = {
	input: "audio_pcm",
	output: "jsonl",
	wantsExclusiveSource: false,
	preferredSampleRates: [48000],
	integrationPattern: "pure_consumer",
}

export class MyDecoder extends BaseDecoder {
	protected program = "my-decoder"
	protected args = ["-i", "stdin", "-o", "stdout"]

	protected parseOutput(line: string): DecoderOutput | null {
		try {
			return JSON.parse(line) as DecoderOutput
		} catch {
			return null
		}
	}
}
```

## Docker Build

Three build targets:

```bash
# Full: SDR++ + all decoders + API
docker build --target=final -t wavekit:full .

# Core: Just decoders + API (for remote SDR sources)
docker build --target=final-core -t wavekit:core .

# SDR++ only (for dedicated SDR host)
docker build --target=final-sdrpp -t wavekit:sdrpp .
```

## Make Commands

Run `make help` to see all available commands. Key commands organized by workflow:

### Development Workflow (Recommended)

```bash
make dev-up        # Build + start container in one command
make dev-decoders  # Live decoder status dashboard (refreshes 2s)
make dev-logs      # Tail logs with pretty JSON formatting
make dev-decoded   # Show only decoded signals (filtered)
make dev-stop      # Stop the dev container
```

### Container Management

| Command            | Description                                   |
| ------------------ | --------------------------------------------- |
| `make dev-build`   | Build core mode image (`wavekit:latest-core`) |
| `make dev-start`   | Start container (auto-stops existing)         |
| `make dev-stop`    | Stop container                                |
| `make dev-restart` | Stop + start container                        |
| `make dev-up`      | Build + start in one command                  |

### Monitoring & Debugging

| Command                | Description                                |
| ---------------------- | ------------------------------------------ |
| `make dev-status`      | Container status + health check            |
| `make dev-decoders`    | Live decoder status (running/idle/faulted) |
| `make dev-logs`        | Tail all logs (pretty JSON)                |
| `make dev-logs-raw`    | Tail raw logs                              |
| `make dev-decoded`     | Show decoded signals only                  |
| `make dev-decoded-raw` | Show decoded signals (raw JSON)            |
| `make dev-shell`       | Open shell in container                    |
| `make dev-audio`       | Listen to decoded audio (requires sox)     |

### Docker Compose

| Command                    | Description                     |
| -------------------------- | ------------------------------- |
| `make docker-dev`          | Start dev environment (compose) |
| `make docker-prod`         | Start production environment    |
| `make docker-compose-down` | Stop compose                    |
| `make docker-clean`        | Remove containers and volumes   |

### Build Targets

| Command                   | Description                          |
| ------------------------- | ------------------------------------ |
| `make docker-build`       | Build all images (full, core, sdrpp) |
| `make docker-build-full`  | Build full mode image                |
| `make docker-build-core`  | Build core mode image                |
| `make docker-build-sdrpp` | Build SDR++ only image               |

## Debugging & Troubleshooting

If decoders aren't producing output, see the comprehensive debugging guides:

- **[DEBUGGING-DECODERS.md](docs/DEBUGGING-DECODERS.md)** - Practical manual testing procedures and common issues
- **[ARCHITECTURE-DECODER-FIXES.md](docs/ARCHITECTURE-DECODER-FIXES.md)** - Technical deep dive into pipeline architecture
- **[SESSION-SUMMARY-DECODER-FIXES.md](docs/SESSION-SUMMARY-DECODER-FIXES.md)** - Recent decoder fixes and verification checklist

### Quick Diagnostic

```bash
# Check if decoders are running
docker-compose ps

# View real-time logs
make dev-logs

# Check for pipeline errors
make dev-logs-raw 2>&1 | grep -i "error\|pipeline\|decoder"

# Test csdr pipeline manually
make dev-shell
# Then inside container, run test commands from DEBUGGING-DECODERS.md
```

### Weak Signal Troubleshooting

If signals are received but not decoding:

1. **Check AGC mode**: Ensure rtl_tcp uses `-g 0` (AGC), not fixed gain
2. **Verify sample rate**: Must be 2.048 Msps, not 2.4 Msps
3. **Check dynamic range**: Signals should use >20% of ADC range

```bash
# Analyze IQ capture dynamic range
docker compose -f docker-compose.demod-test.yml run --rm demod-test \
    python3 /scripts/compare-dynamic-range.py
```

### Demod-Test Container

A standalone container for testing IQ demodulation:

```bash
# Build and enter the test container
docker compose -f docker-compose.demod-test.yml build
docker compose -f docker-compose.demod-test.yml run --rm demod-test bash

# Capture IQ on signal detection
python3 /scripts/auto-capture.py --host 192.168.1.69 --port 1235 --threshold 1.5

# Demodulate and decode POCSAG
bash /scripts/demod-test.sh /output/iq_capture_*.u8
```

## Architecture Notes

- **Streams**: Node.js streams with backpressure handling throughout
- **Events**: EventEmitter-based communication between components
- **Decoders**: Spawned as child processes, communicate via stdin/stdout
- **Resilience**: Auto-reconnect with exponential backoff, auto-restart on crash
- **Health**: Tracks state (running/degraded/faulted) and reports via API
- **Logging**: Structured JSON with Pino, per-component loggers

## Known Limitations

- Single source attachment (fanning to multiple decoders, but only one source)
- Decoders run as separate OS processes (not in-process libraries)
- No persistent storage of decoded messages (only real-time streaming)
- No Web UI (API and WebSocket only)

## Contributing

1. Follow code style: `npm run format && npm run lint`
2. Add tests for new features
3. Ensure TypeScript strict mode: `npm run typecheck`
4. Submit a pull request

## License

ISC
