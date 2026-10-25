# Core reference: API, tuner, relay, live audio and configuration

Quick reference for the WaveKit core: the most used API calls, tuner control, the RTL-TCP
relay, live audio and configuration. The web app does all of this from the browser; this page
is for scripts and for running the core by hand. For the full REST and WebSocket contract, see
[API.md](API.md); for the Docker runtime, see [DOCKER-RUNTIME.md](DOCKER-RUNTIME.md).

The examples use port 9000, the API port in the shipped configurations, and a source named
`rtl-pi`; use your own source id (`GET /api/sources` lists them).

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
- `digital-voice` — Digital voice stream status and calls
- `resources` — Container, SDR host, and backpressure metrics
- `tuner` — RTL-TCP tuner state/command events
- `scanner` — Scanner jobs, discoveries and identification
- `spectrum` — Spectrum and waterfall frames (opt-in, with per-client options)
- `bandplans` — Band plan change notices
- `aircraft`, `vessels`, `aprs`, `mesh` — Tracked aircraft, ships, APRS stations and
  Meshtastic nodes
- `operator-data` — Shared saved frequencies and preferences (protected mode)

Activity has its own replayable subscription (`activity:subscribe`); see
[API.md](API.md#websocket-api) for every channel's messages.

### Audio Streaming

For listening, use the [live audio HTTP stream](#live-demodulator-http-audio) below. The raw
TCP audio port (8080) carries the audio of decoders that produce it, as headerless PCM in the
`audio.format` and `audio.sampleRate` of the configuration:

```bash
# Play with sox
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Play with ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -
```

### Tuner Control (WaveKit)

WaveKit controls `rtl_tcp` sources directly: frequency, gain, sample rate and the other
dongle settings. The web app tunes from the spectrum (see [Using the web app](WEB-APP.md));
scripts use the REST API below, and the [CLI dashboard](CLI.md) has a Tuner tab.

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

# Release control to an external RTL-TCP client (for example SDR++ on the relay)
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"external"}'

# Reclaim control
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"internal"}'
```

### RTL-TCP relay

Optional. Expose the receiver's IQ stream as an RTL-TCP compatible endpoint, so another
RTL-TCP client (SDR++, GQRX, SDR# and others) can watch and tune the same dongle WaveKit uses.
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
2. In your client (in SDR++: the **RTL-TCP** source), connect to `<wavekit-host>:1234`.
3. Tune as usual — the client's commands are forwarded to the upstream `rtl_tcp`/`rtlmux`.

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

When a relay client changes the sample rate, WaveKit automatically:

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
# Sources: an rtl_tcp or rtlmux receiver, such as the Pi SDR host
sources:
  - id: "rtl-pi"
    type: "rtl_tcp"
    host: "<pi-address>"
    port: 5555
    caps:
      kind: "iq"
      format: "U8_IQ"
      sampleRate: 2048000

# Decoders: see config/default.yaml for every type and its options
decoders: []

# API
api:
  host: "0.0.0.0"
  port: 3000

# Audio output
audio:
  tcpPort: 8080
  format: "S16LE"
  sampleRate: 48000

# Tuner relay (RTL-TCP): needs an rtl_tcp source with U8_IQ IQ, like the one above
tunerRelay:
  enabled: true
  host: "0.0.0.0"
  port: 1234
  sourceId: "rtl-pi"
  controlPolicy: "exclusive"
```

**Environment overrides:** `WAVEKIT_` plus the key path, with `__` between nested keys and
`_<index>_` for list entries. A few common keys also have short aliases (`WAVEKIT_API_PORT`,
`WAVEKIT_API_HOST`, `WAVEKIT_LOG_LEVEL`, `WAVEKIT_STATE_DIR`).

```bash
WAVEKIT_API__PORT=9000
WAVEKIT_LOG_LEVEL=debug
WAVEKIT_SOURCES_0_HOST="<pi-address>"
WAVEKIT_TUNER_RELAY__ENABLED=true
WAVEKIT_TUNER_RELAY__PORT=1234
```

`WAVEKIT_SOURCES_<index>_...` and `WAVEKIT_DECODERS_<index>_...` only change an entry that the
YAML file already defines; they cannot add one. Startup fails if the index does not exist.

## RTL-SDR Setup

WaveKit reads IQ from `rtl_tcp` (or rtlmux in front of it). On a Raspberry Pi, the
[fresh-card Pi setup](../packages/sdr-host/README.md) installs and supervises all of this for
you. By hand:

```bash
# On the machine with the dongle: serve it on the network
rtl_tcp -a 0.0.0.0 -p 1234 -s 2048000 -g 0

#   -g 0        tuner AGC; set a manual gain later from WaveKit
#   -s 2048000  2.048 Msps; WaveKit changes the rate when a decoder needs it
#               (ADS-B at 1090 MHz uses 2.4 Msps)
```

With the dongle plugged into the machine that runs WaveKit, see the USB setup in
[Docker runtime](DOCKER-RUNTIME.md) and [native development](LOCAL-SETUP.md).

For multiple clients, use [rtlmux](https://github.com/slepp/rtlmux):

```bash
rtlmux -a 0.0.0.0 -p 5555 -s 5556 127.0.0.1 1234
```

## Docker

`docker/bake.hcl` defines the images. `make docker-build` builds the default group (the first
three rows); the demod tooling image is a separate `demod` group.

| Image                                 | Bake target   | Contents                                  | Use                                                         |
| ------------------------------------- | ------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `ghcr.io/coriou/wavekit:latest-core`  | `final-core`  | Core, API and every decoder               | The usual image, with an `rtl_tcp` receiver or a USB dongle |
| `ghcr.io/coriou/wavekit:latest`       | `final`       | The same, plus SDR++                      | Optional: SDR++ in the same container                       |
| `ghcr.io/coriou/wavekit:latest-sdrpp` | `final-sdrpp` | SDR++ only                                | Optional: a standalone SDR++ server                         |
| `ghcr.io/coriou/wavekit:latest-demod` | `final-demod` | dsd-fme, multimon-ng, csdr, rtl-sdr tools | Interactive demodulation tooling                            |

The registry and tag come from the `REGISTRY` and `TAG` variables in `docker/bake.hcl`.

```bash
# Build the default group
make docker-build

# Single-arch local build (skip multi-arch when you don't need it)
docker buildx bake --file docker/bake.hcl default --set "*.platform=linux/amd64" --load
```

`make app-up` builds and runs the core image with Docker Compose; that is the easiest start,
described in [Docker runtime](DOCKER-RUNTIME.md). To run the core image by hand against a
network receiver, write a config file with a complete source entry. The image's built-in
configuration has no sources, and environment overrides cannot add one. Save this as
`wavekit.yaml`, replacing `<pi-address>` with the address of the machine running `rtl_tcp` or
rtlmux (an IP address is safest; `.local` names may not resolve inside a container):

```yaml
sources:
  - id: "rtl-pi"
    type: "rtl_tcp"
    host: "<pi-address>"
    port: 5555
    caps:
      kind: "iq"
      format: "U8_IQ"
      sampleRate: 2048000
decoders: []
api:
  host: "0.0.0.0"
  port: 9000
```

Then mount it and point `WAVEKIT_CONFIG` at it:

```bash
docker run -p 127.0.0.1:9000:9000 \
  -v "$PWD/wavekit.yaml:/config/wavekit.yaml:ro" \
  -e WAVEKIT_CONFIG=/config/wavekit.yaml \
  ghcr.io/coriou/wavekit:latest-core
```

`WAVEKIT_CONFIG` selects that one file instead of `/app/config/default.yaml`; settings it
leaves out take their schema defaults. Publishing the port on `127.0.0.1` keeps the API on
your machine; to open it to your network, use protected mode
([Docker setup](DOCKER-SETUP.md#protected-mode-in-docker-without-a-forwarder)).

WaveKit can also take audio from an SDR++ network sink (`type: "sdrpp-network"`), but an
`rtl_tcp` IQ source is what the spectrum, scanner, tuner and relay need.

See [DOCKER-SETUP.md](DOCKER-SETUP.md) for the compose profiles (`app`, `protected`, `dev`,
`prod-single-host`, `prod-distributed`, `demod-test`) and the GHCR-backed registry cache.
