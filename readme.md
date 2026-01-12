# WaveKit

**Multi-protocol SDR signal decoder with real-time streaming**

WaveKit connects to Software Defined Radio sources and decodes multiple signal types simultaneously. Aircraft tracking, ship positions, pager messages, digital voice, weather sensors—all decoded in parallel and streamed via WebSocket.
It can also expose the internal IQ stream as an RTL-TCP endpoint so SDR++ can tune locally without opening a second upstream connection.

```
┌─────────────────┐     ┌──────────────────────────────────────┐     ┌─────────────────┐
│  RTL-SDR        │     │  WaveKit Container                   │     │  Your Apps      │
│  on Raspberry Pi│────▶│                                      │────▶│                 │
│  rtl_tcp :1234  │ IQ  │  8 Decoders running in parallel:     │ WS  │  CLI Dashboard  │
│                 │     │  ✈️ ADS-B  🚢 AIS  📟 Pagers  📻 DMR │     │  Web UI         │
└─────────────────┘     └──────────────────────────────────────┘     └─────────────────┘
```

## Quick Start

```bash
# Clone and build
git clone https://github.com/coriou/wavekit.git && cd wavekit
make dev-up

# Open the interactive dashboard
make dev-dashboard
```

The dashboard shows decoder health, live decoded messages, backpressure status, and source connections—all in your terminal.

## CLI Dashboard

WaveKit's primary interface is an interactive terminal dashboard built with Ink/React:

```
┌─ WaveKit Dashboard ─────────────────────────────────────────────────────────┐
│ [1] Dashboard  [2] Decoders  [3] Output  [4] Backpressure  [5] Sources  [6] Live Audio │
├─────────────────────────────────────────────────────────────────────────────┤
│ DECODERS                                                                    │
│ Running: 5/8    Healthy: 5/5    Total Events: 12,847                        │
│ ● dsd-fme       ● multimon-ng       ● readsb       ● ais-catcher            │
│                                                                             │
│ BACKPRESSURE                                                                │
│ Status: All flowing    Drop Rate: 0 B/s    Flowed: 847 MB    Dropped: 0 B   │
│                                                                             │
│ SOURCES                                                                     │
│ Connected: 1/1    Fanout Consumers: 5                                       │
│ ● sdrpp-main @ tcp://192.168.1.69:5555                                      │
│                                                                             │
│ RECENT MESSAGES                                                             │
│ 14:23:45 [readsb]    aircraft  ICAO:A4B2C1 ALT:35000 SPD:450                │
│ 14:23:44 [ais]       ship      MMSI:123456789 LAT:37.77 LON:-122.41         │
│ 14:23:43 [multimon]  message   POCSAG1200 ADDR:1234567 "Test message"       │
├─────────────────────────────────────────────────────────────────────────────┤
│ [q] Quit  [r] Reconnect  [1-6] Switch tabs                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Keyboard shortcuts:**

- `1-6` — Switch between tabs (Dashboard, Decoders, Output, Backpressure, Sources, Live Audio)
- `r` — Reconnect WebSocket
- `q` — Quit

**Environment variables:**

```bash
WAVEKIT_WS_URLS=ws://localhost:9000/ws   # WebSocket endpoints (comma-separated)
WAVEKIT_API_URL=http://localhost:9000    # REST API endpoint
```

## Supported Decoders

| Decoder         | Signals               | Use Case             |
| --------------- | --------------------- | -------------------- |
| **readsb**      | ADS-B 1090 MHz        | Aircraft tracking    |
| **AIS-catcher** | AIS 162 MHz           | Ship tracking        |
| **acarsdec**    | ACARS VHF             | Aircraft data link   |
| **dumpvdl2**    | VDL2 136 MHz          | Aviation data link   |
| **dsd-fme**     | DMR, P25, YSF, D-Star | Digital voice        |
| **multimon-ng** | POCSAG, FLEX, DTMF    | Pagers, tones        |
| **direwolf**    | APRS 144 MHz          | Amateur radio        |
| **rtl_433**     | ISM 433/915 MHz       | Weather sensors, IoT |

All decoders are pre-built in the Docker image. Enable/disable via configuration.

## Architecture

```
SDR Source (rtl_tcp/SDR++)
         │
         ▼
   SourceManager ──────────────────────────────────────────┐
         │                                                 │
         ▼                                                 │
   FanoutManager ─────┬─────┬─────┬─────┬─────┐           │
         │            │     │     │     │     │           │
         ▼            ▼     ▼     ▼     ▼     ▼           │
      dsd-fme    multimon readsb  ais  acars vdl2         │
         │            │     │     │     │     │           │
         └────────────┴─────┴─────┴─────┴─────┘           │
                            │                             │
                            ▼                             │
                    DecoderManager ◀──────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         REST API      WebSocket     Audio TCP     Tuner Relay
        :9000/api      :9000/ws       :8080        :1234
```

**Key components:**

- **SourceManager** — TCP connections to SDR sources with auto-reconnect
- **FanoutManager** — Multiplexes audio to all decoders with backpressure handling
- **DecoderManager** — Spawns/monitors decoder processes, handles restarts
- **API Server** — Fastify REST + WebSocket for control and real-time events
- **Tuner Relay** — Optional RTL-TCP server for local tuner clients (SDR++)

## API Reference

### REST Endpoints

```bash
# Health check
curl http://localhost:9000/health

# Full system status
curl http://localhost:9000/api/status

# List decoders
curl http://localhost:9000/api/decoders

# Start/stop a decoder
curl -X POST http://localhost:9000/api/decoders/readsb/start
curl -X POST http://localhost:9000/api/decoders/readsb/stop

# List sources
curl http://localhost:9000/api/sources
```

### WebSocket Events

Connect to `ws://localhost:9000/ws` and subscribe to channels:

```javascript
const ws = new WebSocket("ws://localhost:9000/ws")

ws.send(
	JSON.stringify({
		type: "subscribe",
		channels: [
			"decoders",
			"sources",
			"metrics",
			"health",
			"fanout",
			"live-audio",
		],
	}),
)

ws.onmessage = event => {
	const msg = JSON.parse(event.data)
	// msg.type: 'decoder:output', 'decoder:health', 'source:connected', etc.
	// msg.data: event payload
}
```

**Channels:**

- `decoders` — Decoder output, start/stop events
- `sources` — Source connection events
- `metrics` — Data rate metrics (~5s intervals)
- `health` — Decoder health state changes
- `fanout` — Backpressure snapshots
- `live-audio` — Live demod status/config events

### Audio Streaming

Decoded audio streams over TCP port 8080:

```bash
# Play with sox
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Play with ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -
```

### Tuner Relay (SDR++)

Expose the internal IQ stream as an RTL-TCP compatible endpoint for SDR++ (or any RTL-TCP client).
Control commands are forwarded upstream so you only keep a single connection to the remote RTL-SDR.

```yaml
tunerRelay:
  enabled: true
  host: "0.0.0.0"
  port: 1234
  sourceId: "rtl-pi"
  controlPolicy: "exclusive" # or "shared"
  commandHistoryLimit: 200 # 0 disables command history
```

**Usage:**

1. Start WaveKit with the relay enabled.
2. In SDR++, select **RTL-TCP** and connect to `tcp://<wavekit-host>:1234`.
3. Tune as usual — SDR++ commands are forwarded to the upstream `rtl_tcp`/`rtlmux`.

**Notes:**

- The relay expects an IQ source in `U8_IQ` format (standard RTL-TCP/rtlmux output).
- In `exclusive` mode, the first client gets control and others are read-only.
- The relay streams the primary source (first in `sources`), so set `sourceId` to match it.
- RTL-TCP commands are tracked and available via `GET /api/tuner-relay`.

### Live Demodulator (HTTP Audio)

Live demodulates IQ in real time and serves mono audio over HTTP.
Ideal for quick monitoring with ffplay/VLC without touching decoder configs.

**Quick start:**

```yaml
liveDemod:
  enabled: true
  sourceId: "rtl-pi"
  httpPort: 8081
  modulation: "nfm"
  bandwidth: 12500
  squelch: 0
  noiseReduction: "off"
  lowPass: 0
  highPass: 0
  gain: 10.0
  deEmphasis: false
  deEmphasisTau: 50
  audioFormat: "s16le"
  iqDcBlock: true
```

```bash
# Start demodulation (if not auto-started)
curl -X POST http://localhost:9000/api/live-audio/start

# Play the stream (use the effectiveSampleRate from /status)
ffplay -nodisp -autoexit -f s16le -ar 24976 -ch_layout mono http://localhost:8081/stream
```

**Configuration reference:**

- `sourceId` — IQ source to demodulate (defaults to first source)
- `modulation` — `nfm` | `wfm` | `am` | `usb` | `lsb` | `dsb` | `cw` | `raw`
- `bandwidth` — Target audio bandwidth in Hz (0 allowed only for `raw`)
- `squelch` — dBFS threshold (-160 to 0). `0` keeps squelch open
- `noiseReduction` — `off` | `voice` | `noaa-apt` | `narrow-band`
- `lowPass` / `highPass` — Optional audio filters in Hz
- `gain` — Audio gain multiplier (float)
- `deEmphasis` / `deEmphasisTau` — FM de-emphasis (50 or 75 microseconds)
- `audioFormat` — `s16le` or `f32le`
- `iqDcBlock` — Apply IQ DC blocking before decimation

**API examples:**

```bash
# Status
curl http://localhost:9000/api/live-audio/status

# Update modulation on the fly
curl -X PATCH http://localhost:9000/api/live-audio/config \
  -H "Content-Type: application/json" \
  -d '{"modulation":"am","bandwidth":10000}'

# Presets
curl http://localhost:9000/api/live-audio/presets
```

## Configuration

Configuration via YAML (`config/default.yaml`) or environment variables:

```yaml
# Sources
sources:
  - id: "sdrpp-main"
    type: "sdrpp-network"
    host: "192.168.1.69"
    port: 5555
    caps:
      kind: "audio_pcm"
      sampleRate: 48000
      format: "FLOAT32LE"

# Decoders
decoders:
  - id: "dsd"
    type: "dsd-fme"
    enabled: true
    sourceId: "sdrpp-main"
    options:
      mode: "auto"

# API
api:
  host: "0.0.0.0"
  port: 3000

# Audio output
audio:
  tcpPort: 8080
  format: "S16LE"
  sampleRate: 48000

# Tuner relay (RTL-TCP)
tunerRelay:
  enabled: true
  host: "0.0.0.0"
  port: 1234
  sourceId: "sdrpp-main"
  controlPolicy: "exclusive"
```

**Environment overrides:**

```bash
WAVEKIT_API_PORT=9000
WAVEKIT_LOG_LEVEL=debug
WAVEKIT_SOURCES_0_HOST=192.168.1.100
WAVEKIT_TUNER_RELAY__ENABLED=true
WAVEKIT_TUNER_RELAY__PORT=1234
```

## Development

### Prerequisites

- Node.js 20+ (see `.nvmrc`)
- Docker with BuildKit
- RTL-SDR dongle (or rtl_tcp server)

### Commands

```bash
# Development
make dev-up              # Build + start container
make dev-dashboard       # Interactive CLI dashboard
make dev-logs            # Tail logs (pretty JSON)
make dev-stop            # Stop container

# Testing
npm test                 # Run tests
npm run test:coverage    # With coverage
npm run typecheck        # Type checking

# Building
make docker-build-core   # Build core image
make docker-build-full   # Build full image (with SDR++)
```

### Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Zod schemas + config loading
├── core/                 # Stream infrastructure
│   ├── source-manager.ts    # TCP client for SDR sources
│   ├── fanout-manager.ts    # Stream multiplexer
│   └── audio-output.ts      # TCP server for audio
├── decoders/             # Decoder plugin system
│   ├── base-decoder.ts      # Abstract base class
│   ├── manager.ts           # Lifecycle orchestration
│   └── builtin/             # 8 decoder adapters
├── api/                  # Fastify REST/WebSocket
│   ├── server.ts
│   ├── routes/
│   └── websocket/
└── utils/                # Logger, errors, shutdown

cli/                      # CLI Dashboard (Ink/React)
├── source/
│   ├── app.tsx              # Main app component
│   ├── components/          # UI components
│   └── hooks/               # WebSocket, terminal size
```

### Adding a Decoder

1. Create `src/decoders/builtin/my-decoder.ts` extending `BaseDecoder`
2. Implement `getCommand()`, `getArgs()`, `parseOutput()`
3. Register in `src/decoders/registry.ts`
4. Add config schema to `src/config.ts`

See [docs/DECODER-GUIDE.md](docs/DECODER-GUIDE.md) for detailed instructions.

## Docker

Three build targets:

| Target                 | Contents               | Use Case           |
| ---------------------- | ---------------------- | ------------------ |
| `wavekit:latest`       | SDR++ + API + Decoders | All-in-one         |
| `wavekit:latest-core`  | API + Decoders         | External SDR++     |
| `wavekit:latest-sdrpp` | SDR++ only             | Dedicated SDR host |

```bash
# Build core (recommended for development)
make docker-build-core

# Run with external SDR++
docker run -p 9000:3000 -p 8080:8080 \
  -p 1234:1234 \
  -e WAVEKIT_SOURCES_0_HOST=192.168.1.69 \
  -e WAVEKIT_SOURCES_0_PORT=5555 \
  -e WAVEKIT_TUNER_RELAY__ENABLED=true \
  wavekit:latest-core
```

## RTL-SDR Setup

For optimal reception:

```bash
# On Raspberry Pi - start rtl_tcp with AGC
rtl_tcp -a 0.0.0.0 -p 1234 -f 446524920 -s 2048000 -g 0

# Key settings:
#   -g 0        AGC mode (critical for weak signals)
#   -s 2048000  Sample rate 2.048 Msps (not 2.4!)
```

For multiple clients, use [rtlmux](https://github.com/alexander-sholohov/rtlmux):

```bash
rtlmux -s 192.168.1.69:1234 -l 0.0.0.0:1235
```

## Documentation

- [API Reference](docs/API.md) — Full REST/WebSocket documentation
- [Docker Setup](docs/DOCKER-SETUP.md) — Container deployment guide
- [Decoder Guide](docs/DECODER-GUIDE.md) — Adding new decoders
- [Architecture](docs/ARCHITECTURE.md) — System design deep dive
- [Security](docs/SECURITY.md) — Version pinning, CVE tracking

## License

ISC
