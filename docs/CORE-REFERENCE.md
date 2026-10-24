# Core reference: API, tuner, relay, live audio and configuration

This page gathers the reference material that used to live in the README. For the full
REST and WebSocket contract, see [API.md](API.md); for the Docker runtime, see
[DOCKER-RUNTIME.md](DOCKER-RUNTIME.md).

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

# List tuner states
curl http://localhost:9000/api/tuner

# Set tuner frequency
curl -X POST http://localhost:9000/api/tuner/rtl-pi/frequency \
  -H "Content-Type: application/json" -d '{"hz":144800000}'
```

### WebSocket Events

Connect to `ws://localhost:9000/ws` and subscribe to channels:

```javascript
const ws = new WebSocket("ws://localhost:9000/ws")

// Subscribe once the connection is open; sending earlier throws.
ws.onopen = () => {
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
}

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
- `resources` — Container, SDR host, and backpressure metrics
- `tuner` — RTL-TCP tuner state/command events

### Audio Streaming

Decoded audio streams over TCP port 8080:

```bash
# Play with sox
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Play with ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -
```

### Tuner Control (WaveKit)

WaveKit can directly control RTL-TCP sources without SDR++. Use the CLI Tuner tab
or the REST API to tune frequency, gain, and other settings.

**CLI keys (Tuner tab):**

- `up/down` — Tune frequency
- `left/right` — Change tuning step (also supports `[ ] , . /`)
- `g` — Toggle gain mode (AGC/manual)
- `+/-` — Adjust gain (manual only)
- `s` — Edit sample rate
- `p` — Edit PPM correction
- `a` — Toggle RTL AGC
- `b` — Toggle bias-tee
- `d` — Cycle direct sampling (off/I/Q)
- `o` — Toggle offset tuning
- `c` — Release/reclaim control (internal/external)

```bash
# List tuner states
curl http://localhost:9000/api/tuner

# Set frequency
curl -X POST http://localhost:9000/api/tuner/rtl-pi/frequency \
  -H "Content-Type: application/json" -d '{"hz":144800000}'

# Release control to SDR++
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"external"}'

# Reclaim control
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"internal"}'
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
- The relay streams the source named by `tunerRelay.sourceId`. Without it, the relay uses the
  default source: the first configured source whose `scanner.role` is `shared` (the default role).
- RTL-TCP commands are tracked and available via `GET /api/tuner-relay`.
- Relay commands update the internal tuner state and will switch control mode to
  `external` while a relay control client is active. When the relay becomes idle,
  control returns to `internal` unless you explicitly released control.

**Dynamic Sample Rate:**

When SDR++ changes the sample rate, WaveKit automatically:

- Updates source capabilities
- Restarts the LiveDemodulator with new decimation rates
- Restarts affected decoders to maintain optimal decoding
- Broadcasts `source:caps-changed` to WebSocket clients

This enables seamless tuning without manual reconfiguration.

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
  gain: 2.0
  deEmphasis: false
  deEmphasisTau: 50
  audioFormat: "s16le"
  offsetHz: 0
```

```bash
# Start demodulation (if not auto-started)
curl -X POST http://localhost:9000/api/live-audio/start

# Play the self-describing WAV stream (no format flags needed)
ffplay -nodisp -autoexit http://localhost:8081/stream.wav

# Or the raw stream: format and exact rate are in the X-Audio-Format and
# X-Sample-Rate response headers (round the rate for ffplay)
ffplay -nodisp -autoexit -f s16le -ar 24976 -ch_layout mono http://localhost:8081/stream
```

**Configuration reference:**

- `sourceId` — IQ source to demodulate (defaults to first source)
- `modulation` — `nfm` | `wfm` | `am` | `usb` | `lsb` | `dsb` | `cw` | `raw`
- `bandwidth` — Target audio bandwidth in Hz (0 allowed only for `raw`)
- `squelch` — channel power threshold before demodulation, dBFS (-160 to 0);
  `0` keeps squelch open. `channelPowerDbfs` in `/api/live-audio/status` shows the
  current level (noise is typically -55 to -65 dBFS, a nearby carrier -10 to -30)
- `noiseReduction` — `off` | `voice` | `noaa-apt` | `narrow-band`
- `lowPass` / `highPass` — Optional audio filters in Hz
- `gain` — Audio gain multiplier (default 2: ±5 kHz FM deviation at 0.8 full scale)
- `offsetHz` — Channel offset from the tuned centre; a carrier at centre + offsetHz
  is shifted to DC before filtering. Tune the dongle a few kHz off the carrier and
  set this, so the receiver's DC spike stays out of the channel
- `deEmphasis` / `deEmphasisTau` — FM de-emphasis (50 or 75 microseconds)
- `audioFormat` — `s16le` or `f32le`
- `iqDcBlock` — Deprecated and ignored (it corrupted I/Q); use `offsetHz`

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
    host: "<sdrpp-host>" # address of the machine running SDR++
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
WAVEKIT_SOURCES_0_HOST="<sdrpp-host>"
WAVEKIT_TUNER_RELAY__ENABLED=true
WAVEKIT_TUNER_RELAY__PORT=1234
```

`WAVEKIT_SOURCES_<index>_...` and `WAVEKIT_DECODERS_<index>_...` only change an entry that the
YAML file already defines; they cannot add one. Startup fails if the index does not exist.

## RTL-SDR Setup

For optimal reception:

```bash
# On Raspberry Pi - start rtl_tcp with AGC
rtl_tcp -a 0.0.0.0 -p 1234 -f 446524920 -s 2048000 -g 0

# Key settings:
#   -g 0        AGC mode (critical for weak signals)
#   -s 2048000  Sample rate 2.048 Msps (not 2.4!)
```

For multiple clients, use [rtlmux](https://github.com/slepp/rtlmux):

```bash
rtlmux -a 0.0.0.0 -p 5555 -s 5556 127.0.0.1 1234
```

## Docker

Three build targets, all produced by a single `docker buildx bake` invocation:

| Image                                 | Bake target   | Contents               | Use Case           |
| ------------------------------------- | ------------- | ---------------------- | ------------------ |
| `ghcr.io/coriou/wavekit:latest`       | `final`       | SDR++ + API + Decoders | All-in-one         |
| `ghcr.io/coriou/wavekit:latest-core`  | `final-core`  | API + Decoders         | External SDR++     |
| `ghcr.io/coriou/wavekit:latest-sdrpp` | `final-sdrpp` | SDR++ only             | Dedicated SDR host |

The registry and tag come from the `REGISTRY` and `TAG` variables in `docker/bake.hcl`.

```bash
# Build the default group (all three images)
make docker-build

# Single-arch local build (skip multi-arch when you don't need it)
docker buildx bake --file docker/bake.hcl default --set "*.platform=linux/amd64" --load
```

To run the core image against an external SDR++, write a config file with a complete source
entry. The image's built-in configuration has no sources, and environment overrides cannot
add one. Save this as `wavekit.yaml`, replacing `<sdrpp-host>` with the address of the machine
running SDR++ (an IP address is safest; `.local` names may not resolve inside a container):

```yaml
sources:
  - id: "sdrpp-main"
    type: "sdrpp-network"
    host: "<sdrpp-host>"
    port: 5555
    caps:
      kind: "audio_pcm"
      sampleRate: 48000
      format: "FLOAT32LE"
decoders: []
api:
  host: "0.0.0.0"
  port: 9000
audio:
  tcpPort: 8080
```

Then mount it and point `WAVEKIT_CONFIG` at it:

```bash
docker run -p 9000:9000 -p 8080:8080 \
  -v "$PWD/wavekit.yaml:/config/wavekit.yaml:ro" \
  -e WAVEKIT_CONFIG=/config/wavekit.yaml \
  ghcr.io/coriou/wavekit:latest-core
```

`WAVEKIT_CONFIG` selects that one file instead of `/app/config/default.yaml`; settings it
leaves out take their schema defaults. The tuner relay needs an `rtl_tcp` source with `U8_IQ`
IQ, so it is not enabled for this SDR++ audio source.

See [DOCKER-SETUP.md](DOCKER-SETUP.md) for the compose profiles (`dev`, `prod-single-host`, `prod-distributed`, `demod-test`) and the GHCR-backed registry cache.
