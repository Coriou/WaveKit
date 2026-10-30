# WaveKit Architecture

This document describes WaveKit's internal architecture, component design, and data flow.

## System Overview

WaveKit is a TypeScript-based SDR stream processing framework that:

1. Connects to an RTL-SDR over TCP (`rtl_tcp`, e.g. a Raspberry Pi running the SDR host or a local
   USB dongle behind `rtl_tcp`); an SDR++ network sink and recordings also work as sources
2. Multiplexes audio streams to multiple decoders in parallel
3. Manages decoder process lifecycles with auto-restart
4. Exposes decoded data via REST API and WebSocket
5. Streams decoded audio over TCP
6. Demodulates IQ to live audio over HTTP

The web app (`web/`) is the main user interface; the CLI dashboard (`cli/`) and your own scripts
use the same API.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WaveKit Container                               │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────────────┐ │
│  │   Source    │    │   Fanout    │    │        Decoder Manager          │ │
│  │   Manager   │───▶│   Manager   │───▶│                                 │ │
│  │             │    │             │    │  ┌─────┐ ┌─────┐ ┌─────┐       │ │
│  │ TCP Client  │    │ Multiplexer │    │  │dsd  │ │multi│ │readsb│ ...  │ │
│  │ Auto-reconn │    │ Backpressure│    │  └─────┘ └─────┘ └─────┘       │ │
│  └─────────────┘    └─────────────┘    └─────────────────────────────────┘ │
│         │              │      │                  │                         │
│         │              │      │                  ▼                         │
│         │              │      │     ┌─────────────────────────────────┐   │
│         │              │      │     │         API Server              │   │
│         │              │      │     │                                 │   │
│         │              │      │     │  REST /api/*    WebSocket /ws   │   │
│         │              │      │     └─────────────────────────────────┘   │
│         │              │      │                  │                         │
│         │              ▼      ▼                  ▼                         │
│         │       ┌──────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│         │       │LiveDemod │  │ Tuner Relay │  │        External         │ │
│         │       │HTTP :8081│  │  TCP :1234  │  │        Clients          │ │
│         │       └──────────┘  └─────────────┘  │  Web app, CLI, Players  │ │
│         │                                      └─────────────────────────┘ │
│         ▼                                                                   │
│  ┌─────────────┐                                                            │
│  │   Audio     │                                                            │
│  │   Output    │                                                            │
│  │  TCP :8080  │                                                            │
│  └─────────────┘                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### SourceManager

Manages TCP connections to SDR sources with automatic reconnection.

**Location**: `src/core/source-manager.ts`

**Responsibilities**:

- Establish TCP connections to rtl_tcp (or an SDR++ network sink), or read recording files
- Auto-reconnect with exponential backoff (2s → 4s → 8s → max 30s)
- Emit connection events and data rate metrics
- Track source capabilities (sample rate, format, exclusivity)

**Key interfaces**:

```typescript
interface SourceConfig {
	id: string
	type: "rtl_tcp" | "sdrpp-network" | "recording"
	host?: string
	port?: number
	filePath?: string // For recording sources
	caps: SourceCaps
}

interface SourceCaps {
	kind: "audio_pcm" | "iq" | "recording"
	sampleRate: number
	format: "S16LE" | "FLOAT32LE" | "U8_IQ" | "S16_IQ"
	exclusive: boolean
}
```

**Events emitted**:

- `connected` — Source connected successfully
- `disconnected` — Source disconnected (with error if applicable)
- `data` — Raw data received
- `metrics` — Data rate metrics (every 5s)
- `caps-changed` — Source capabilities updated (e.g., sample rate change via TunerRelay)

### FanoutManager

Multiplexes a single audio stream to multiple decoder consumers.

**Location**: `src/core/fanout-manager.ts`

**Responsibilities**:

- Accept source stream as input
- Create independent buffered branches for each decoder
- Handle backpressure without blocking the source
- Warn when a congested branch actually drops input (entering drop-mode alone is
  flow control: the burst absorber holds the next chunks until the branch drains)

**Key design decisions**:

- Each branch has independent buffering sized in milliseconds of signal: once the
  fanout knows its source byte rate (`setByteRate`), a branch without an explicit
  mark holds 250 ms per side (1 200 000 bytes at 2.4 Msps CU8, 512 000 at
  1.024 Msps), never less than 256 KiB. The live-demod branch and the channelizer
  input size themselves the same way from the source caps. The source router
  calls `setByteRate` when it learns a source's caps, and a rate change resizes
  the derived marks of existing branches (a soft mark in the fanout's congestion
  check; a stream's own mark is fixed at construction). Measurements:
  [PERFORMANCE.md, "Branch marks in signal time"](PERFORMANCE.md#branch-marks-in-signal-time-2026-10-30).
- Real-time priority: prefer dropping data over blocking source
- Data is copied to each branch (no shared buffers)

**Events emitted**:

- `backpressure` — Branch buffer is full
- `branch-added` — New branch created
- `branch-removed` — Branch removed

### Core channelizer (opt-in)

Cuts exact-rate channels out of a source's IQ in one native process instead of one csdr front end per decoder. Spec: [channelizer addendum](superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md).

**Location**: `src/core/channelizer/` (`ChannelizerManager`), `native/wavekit-chan/` (Rust)

- **Opt-in twice**: `channelizer.enabled: true` constructs the manager in `src/index.ts`, and each decoder instance opts in with `useChannelizer: true`. Both default to false; with either off the decoder reads its raw fanout branch exactly as before. A decoder with `useChannelizer` but no channel request (not yet migrated, addendum §7) also stays on raw fanout. readsb and lora-meshtastic are never channelised.
- **One `wavekit-chan` per source**, spawned lazily on the first channel request and stopped when its last channel is released. It reads raw CU8 (a live IQ source or a CU8 recording) from fanout branch `channelizer-<sourceId>` on stdin, takes JSON-line requests on fd 3 (`--control-fd 3`) and emits events on stdout. Each channel is a Unix socket `<channelizer.socketDir>/<sourceId>-g<generation>/<channelId>.sock`; the decoder gets a stream fed from it.
- **Admission failures are suspensions, not crashes**: `channel-outside-capture`, `channel-request-invalid`, `channelizer-unavailable` (core-internal; the status DTO shows `suspended: true` without a `suspension` object). `channelizer-unavailable` decoders are retried every 15 s; after 5 unexpected `wavekit-chan` exits within 60 s a source gets no respawn until the oldest exit leaves the window.
- **Shutdown**: the channelizer is destroyed after `decoderManager.destroy()` has released every channel.
- **Rate reporting**: a channelised decoder's rate plan (`src/core/channelizer/rate-plan.ts`) shows the channel rate as `frontendRateHz` and, when the decoder's own adapter still converts the channel (for example dumpvdl2 resampling a 512 kHz channel to 525 kHz), that adapter's rate and format as the decoder input; otherwise the decoder input is the channel itself.

**Known limitations**:

- **No decoder is gate-verified yet.** The golden gates (Property 15 raw-vs-channel equality per decoder, the dsd-fme voice A/B) and the capacity run are still pending, so `useChannelizer: true` on any decoder is an unverified prototype setting.
- **Channel open stalls input (Pi-class hosts)**: `wavekit-chan` designs a channel's filters on its input thread when the channel opens (about 34 ms worst measured on x86, for 2.048 → 1.05 Msps; wider or unusual rate splits cost more). While it runs no input is read, so every open (startup, a decoder restart, a re-request after invalidation) eats the input branch's slack, and an overrun drops bytes, which `mark-gap` turns into a discontinuity on every open channel. Before enabling the channelizer on a Pi-class host, either move filter design off the input path or measure the open stall there below 60 ms.
- **Eight channels under a CPU quota (capacity T36, ruling QH-16)**: all channel DSP runs on `wavekit-chan`'s single input thread, and its input branch then buffered only `channelizer.inputHighWaterMark` (262 144 bytes, about 64 ms at 2.048 Msps; since 2026-10-30 that value is a floor and the branch holds 250 ms of signal at the input rate). With 8 AIS channels under a 4-CPU container quota, throttling stalls dropped 1.4–2.0 % of input as `input-gap` discontinuities on every channel (none with 6 CPUs), and unpaced the process reaches only about 1.0× real time at N = 8 (i5-1038NG7). N = 8 is not recommended on a ≤4-core host or under a CPU quota until the default buffer is raised and/or the AVX2/FMA path or per-channel DSP threads land; see `docs/CAPACITY-2026-10-10-CHANNELIZER.md`.
- Every channel invalidation (caps change, source disconnect/remove, `wavekit-chan` exit, or one channel dying on its own: client gone or socket error) restarts the channelised decoder. dsd-fme's `stop()` emits `call_end`, so a PTT spanning a retune is split and the digital-voice stream (:8082) has a gap.
- An input-branch drop sends `mark-gap`, which resets the channel filter state without a restart; expect AMBE errors around branch drops.
- A stale `caps.centerFreq` (SDR++ retuning the Pi without going through the relay) puts every channel centre on the wrong RF. Rate-truth only warns.
- With the capture centre unknown, mixing a decoder pinned to an absolute frequency with a centre-relative one is order-dependent.
- There is no DC removal or AGC anywhere in the channel path (FIR, NCO, polyphase only). Keep it that way: an IIR high-pass or fast AGC chops TDMA bursts (the `9ff133d` dsd-fme lesson).

### DecoderManager

Orchestrates decoder process lifecycles.

**Location**: `src/decoders/manager.ts`

**Responsibilities**:

- Create decoder instances from registry
- Start/stop/restart decoder processes
- Handle auto-restart with exponential backoff
- Track decoder health (running/degraded/faulted)
- Assign decoders to sources

**Health states**:

- `running` — Decoder is running and producing output
- `degraded` — Running but no output for configured timeout (default 30s)
- `faulted` — Crashed and exceeded restart limits

### DecoderRegistry

Plugin system for registering decoder types.

**Location**: `src/decoders/registry.ts`

**Responsibilities**:

- Store decoder factory functions
- Store decoder capabilities
- Create decoder instances on demand
- Query decoders by capability

### BaseDecoder

Abstract base class for "pure consumer" decoders that receive audio via stdin.

**Location**: `src/decoders/base-decoder.ts`

**Template methods**:

```typescript
abstract class BaseDecoder {
	protected abstract getCommand(): string
	protected abstract getArgs(): string[]
	protected abstract parseOutput(line: string): DecoderOutput | null
}
```

**Built-in decoders extending BaseDecoder** (or `IqDecimateDecoder` — a `BaseDecoder` subclass that adds csdr-based IQ decimation):

- `DsdFmeDecoder` — Digital voice (DMR, P25, YSF, etc.)
- `MultimonDecoder` — Pager protocols (POCSAG, FLEX, etc.)
- `Rtl433Decoder` — ISM band sensors (extends `IqDecimateDecoder`)
- `LoraMeshtasticDecoder` — Meshtastic LoRa packets (extends `IqDecimateDecoder`; csdr → Python wrapper around `gnuradio.lora_sdr`)

### NetworkProducerDecoder

Base class for decoders that run as network services.

**Location**: `src/decoders/network-producer-decoder.ts`

**Pattern**: Decoder spawns as a process, WaveKit connects to its output port.

**Built-in decoders**:

- `ReadsbDecoder` — ADS-B (connects to SBS/Beast/JSON output)
- `AisCatcherDecoder` — AIS (connects to NMEA/JSON output)
- `DirewolfDecoder` — APRS (connects to KISS TCP port)

### ExternalSdrDecoder

Base class for decoders that manage their own SDR hardware.

**Location**: `src/decoders/external-sdr-decoder.ts`

**Pattern**: Decoder controls its own RTL-SDR dongle, WaveKit only parses output.

**Built-in decoders**:

- `AcarsdecDecoder` — ACARS
- `Dumpvdl2Decoder` — VDL2

### API Server

Fastify-based REST and WebSocket server.

**Location**: `src/api/server.ts`

**Responsibilities**:

- Expose REST endpoints for control and status
- Handle WebSocket connections for real-time events
- Broadcast decoder output to subscribed clients

### Read-only regional and receiver metadata

The API registers encapsulated regional and receiver plugins beneath normal
root access hooks in both protected and legacy compositions. They have no
bootstrap exception, write operation, WebSocket bus or receiver consumer.
Strict raw input validation and explicit closed output serialization preserve
root denials and keep feature errors bounded. Regional framing precedes method
denial; receiver matched method denial precedes feature framing/input checks.

`createRegionalRegistry(createRegionalRegistration())` supplies one immutable
FRS evidence-pending manifest with null data. Explicit query region, optional
coarse context and national applicability remain distinct. It imports no
scanner/decoder bandplan data; numeric publication still needs current evidence.

`createReceiverCapabilitiesProvider` reads the SourceManager's synchronous
coherent accessors and the shared admitted REST command-policy descriptor.
Source incarnation, attempt and snapshot tokens share one bounded lifetime
namespace; old socket/recording callbacks cannot revive successor evidence.
At most 17 page candidates are captured/projected, including validated
lookahead. Literal RTL0 advertisement never supplies physical RF limits or
readback; all control physical/current values remain unknown.

Index owns receiver-provider disposal immediately after construction; ApiServer
borrows it. Shutdown and startup-failure cleanup wait actual API drain before
idempotent disposal, including legacy mode and constructor/bind failures.
Source teardown follows that dependency even when a generic shutdown handler
times out. The pure regional provider retains no active lifecycle resources.
These backend boundaries do not qualify browser TLS/proxy exposure, live RF,
receiver platforms, deployment or scanner activation.

### AudioOutput

TCP server for streaming decoded audio.

**Location**: `src/core/audio-output.ts`

**Responsibilities**:

- Listen on configured TCP port (default 8080)
- Stream audio to all connected clients
- Handle client connect/disconnect gracefully

### TunerController

RTL-TCP tuner control used by the web app and the API (with an optional handoff to an external
client such as SDR++).

**Location**: `src/core/tuner-controller.ts`

**Responsibilities**:

- Maintain per-source tuner state (frequency, gain, PPM, etc.)
- Send RTL-TCP control commands upstream via `SourceManager.writeToSource()`
- Toggle control mode (internal/external) for an external tuner client
- Apply relay command updates so the API state stays in sync with relay clients
- Answer the per-band gain for a frequency (`bandGainFor`, from `BandGainSettingsService` in
  `src/core/band-gain.ts`, snapped to the tuner's gain steps). `TunerArbiter` writes it on
  scanner hops (never while the snapshot's gain or gain mode is unknown) and restores the
  leased snapshot, including a gain-only restore when an operator or relay write takes the
  lease; operator retunes apply it only with `tuner.bandGain.applyToMyTuning` (serialised per
  source, the pre-band gain persisted by `BandGainSettingsService`)

### TunerRelay

Optional RTL-TCP compatible server that exposes the internal IQ stream to local
tuner clients (e.g., SDR++). It forwards control commands upstream to the
configured `rtl_tcp`/`rtlmux` source.

**Location**: `src/core/tuner-relay.ts`

**Responsibilities**:

- Listen for RTL-TCP clients and stream IQ data
- Forward tuner control commands upstream
- Track control ownership and client connections
- Emit relay activity for control-mode sync

### LiveDemodulator

Real-time IQ demodulation with an embedded HTTP audio stream.

**Location**: `src/core/live-demodulator.ts`

**Responsibilities**:

- Attach an IQ branch from `FanoutManager`
- Run the demodulation engine: by default (`liveDemod.engine` omitted or `csdr`)
  the csdr pipeline below. Opt-in `engine: rust` runs one `wavekit-chan` demod
  channel for NFM and AM (`src/core/live-demod/`); WFM, SSB, CW, DSB and raw, a
  non-CU8 source, a missing or too-old binary, or a crash-looping process fall back
  to csdr with the reason logged once and reported as `engineFallback`.
- Serve demodulated audio via HTTP `/stream`
- Hot-reconfigure modulation and DSP parameters

**csdr DSP pipeline (high-level)**:

```
IQ (U8/S16) -> csdr convert -> (optional IQ dcblock) -> csdr firdecimate
-> modulation demod (FM/AM/SSB) -> (audio filters) -> gain/limit
-> (optional deemphasis) -> audio stream
```

### Scanner

Signal discovery: finds activity on a source, confirms it with a probe decode, and reports each emitter once as a discovery. Operator guide: [SCANNER.md](SCANNER.md); spec: [scanner design](superpowers/specs/2026-10-09-signal-discovery-scanner-design.md).

**Location**: `src/core/scanner/` (`ScannerService`), `src/core/spectrum/` (`SpectrumService`, `SpectrumEngine`, `spectrum-worker`)

**Responsibilities**:

- Run scan jobs (in-window, sweep, passive per source, identify) with a job state machine and persistence (`jobs.json`)
- Arbitrate the tuner per source (one lease, test-mode settle markers, origin-tagged preemption, restore on end and on boot)
- Classify tracks from the spectrum and confirm them with ephemeral probe decoders and ambient decoder evidence
- Keep discoveries, observations and evidence (`DiscoveryStore`, journal and snapshot, recordings, PSD/IQ evidence, burst IQ captures)
- Hold configured decoders on a swept source (suspension reason `tuner-scanning`) and release them afterwards
- Rank decoder channels by activity: one channel activity ranker per process (`src/core/scanner/channel-activity.ts`, built in `src/index.ts`), fed by the scanner with spectrum blocks, tracks, decodes and replay outcomes, and read by the `DecoderManager` planner on the same monotonic clock to choose which paging and digital-voice channels run ([DECODER-GUIDE.md](DECODER-GUIDE.md))
- Serve `/api/scanner` and the `scanner` WS channel

**Data path:** the fanout branch `scanner-<sourceId>` → `SpectrumEngine` (copy-once batches, absolute sample index including drops, IQ ring) → `spectrum-worker` thread (`SpectrumPipeline`: FFT, floor, detector, tracker) → track events → `ScannerService` (classifier, crediting to jobs, `DiscoveryStore`, persistence) → REST/WS.

**Control path:** `JobRunner` → `SweepScheduler` / `TunerArbiter` (leases, test-mode markers, origin-tagged preemption, restore) → `TunerController`. `ProbePool` → `DecoderManager.createEphemeralDecoder` (offset transport with pre-roll), `DigitalVoiceService.addChannel`.

**Build:** a second esbuild entry, `dist/spectrum-worker.js`.

**Spectrum service:** `src/core/spectrum/` is a core service the scanner consumes (it never imports the scanner). `SpectrumService` ref-counts one engine per source; scanner consumers (`job:<id>`) and display clients (`ws:<clientId>`) are separate sets, and only scanner consumers produce `stream`/`released` events. It builds `spectrum:frame` per profile, keeps the occupancy history, and serves `/api/spectrum`. A future `wavekit-chan` pipeline host can run the FFT behind the same `PipelineHost` protocol.

**Wiring** (`src/index.ts`, step 7b): the scanner is built after the decoders and digital voice and started before any source connects, so a persisted lease is restored on the source's first data. It is always constructed: with `scanner.enabled: false` it runs no jobs, but its `SpectrumService` still serves `spectrum` subscribers and `/api/spectrum`. An unreadable state directory is handled inside `start()` (the scanner runs without the unread files and never overwrites them).

**Paused feed:** `SourceManager.pause()` closes a network source's connection without reconnecting and keeps its registration; `resume()` makes one attempt and the normal reconnect path restores tuning. While the feed is not `live`, `isPaused()` is true and decoders on the source report `suspension.reasonCode: "source-paused"` (ahead of `tuner-scanning`); `feed-changed` re-evaluates them. Paused ids persist in `<stateDir>/source-feed.json` (`SourceFeedStore`), so a paused source registers at boot without connecting.

**Decoder hold:** while a sweep holds a source, every configured decoder on it reports `suspended: true` with `suspension.reasonCode: "tuner-scanning"`, ahead of rate and band checks, and a manual start answers 409 `SOURCE_HELD_BY_SCANNER`. Scanner probes are exempt and appear as `owner: "scanner"`, `ephemeral: true` decoders (`decoder:created` / `decoder:removed`).

### Dynamic Sample Rate Handling

Sample rate changes, whether made through the API (the web app) or by a TunerRelay client such
as SDR++, are propagated through the system automatically:

```
API / TunerRelay → SourceManager → caps-changed event
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            LiveDemodulator       DecoderManager         WebSocket
            (restart pipeline)   (restart decoders)     (broadcast)
```

**Key behaviors**:

- **TunerRelay** intercepts sample rate commands (cmd 0x02) and emits `sample-rate-changed`
- **SourceManager** updates source caps and emits `caps-changed`
- **LiveDemodulator** restarts its csdr pipeline with new decimation rates
- **DecoderManager** gracefully restarts affected decoders
- **WebSocket** broadcasts `source:caps-changed` to connected clients

## Data Flow

### Audio Pipeline

```
SDR Source (rtl_tcp)
       │
       │ TCP connection
       ▼
SourceManager
       │
       │ Node.js Readable stream
       ▼
FanoutManager
       │
       ├──────────────────┬──────────────────┐
       │                  │                  │
       ▼                  ▼                  ▼
   Branch 1           Branch 2           Branch N
   (PassThrough)      (PassThrough)      (PassThrough)
       │                  │                  │
       │                  │                  │
       ▼                  ▼                  ▼
   dsd-fme            multimon-ng        rtl_433
   (stdin)            (stdin)            (stdin)
       │                  │                  │
       │ stdout           │ stdout           │ stdout
       ▼                  ▼                  ▼
   Output Parser      Output Parser      Output Parser
       │                  │                  │
       └──────────────────┴──────────────────┘
                          │
                          ▼
                   DecoderManager
                          │
                          │ DecoderOutput events
                          ▼
                   WebSocket Broadcaster
                          │
                          ▼
                   Connected Clients
```

### Live Demodulation Pipeline

```
SDR Source (rtl_tcp)
       │
       ▼
SourceManager
       │
       ▼
FanoutManager
       │
       ▼
LiveDemodulator
       │
       ▼
HTTP /stream (audio)
       │
       ▼
Players (ffplay, VLC, browser)
```

### Scanner and Spectrum Pipeline

```
FanoutManager → branch scanner-<sourceId> → SpectrumEngine → spectrum-worker (FFT, floor, detector, tracker)
   → SpectrumService (spectrum:frame per profile, occupancy) → ScannerService (classify, probes, discoveries) → REST/WS
```

### Event Flow

```
Decoder Process
       │
       │ stdout line
       ▼
BaseDecoder.parseOutput()
       │
       │ DecoderOutput object
       ▼
DecoderManager
       │
       │ 'decoder:output' event
       ▼
WebSocketEventBroadcaster
       │
       │ JSON message
       ▼
Subscribed WebSocket Clients
```

When `activity.enabled` is true, that same decoder output is also published as
a decode envelope into `<stateDir>/activity/activity.db` (Node 24 `node:sqlite`
with FTS5). Output types `sync`, `rates`, `stats`, `status` and `error` are
not stored. Each envelope's frequency is a frequency the decoder reports in its
payload or else the decoder's single target from its provenance binding (source,
targets, tuning trust and, for a decoder on the whole capture, the observed input
rate, which bounds an rtl_433 frequency estimate to what that decoder can hear).
Search, facets and cursor replay are served on `/api/activity` and
the WebSocket `activity` channel. The store is off by default. A failed open
keeps the process running and those routes answer 503 `ACTIVITY_UNAVAILABLE`.

The store opens in the background (`src/core/activity/lifecycle.ts`), started
before the scanner loads its state, so neither waits for the other. The writer
answers the open after its indexed reads; the full-table retention seed scan
runs next on the writer thread, before its first write, so the open no longer
grows with the database (5 s budget). A failed open is retried after 5 s, 15 s
and 60 s, then every 5 minutes; a missing `node:sqlite` or a foreign schema is
not retried. Receptions and transmissions while the store is not open are
counted (`droppedWhileClosed`), not buffered. The writer is never opened twice,
and a timed-out writer is terminated, which frees its lock.

The scanner validates its `discoveries.json` snapshot and restores the store in
slices of 1,024 items with an event-loop turn between slices
(`src/core/scanner/store/slices.ts`), so a large store does not hold the main
thread for the whole load.

### Activity presentation

Pager Activity presentation converts multimon whitespace markers (LF, CR, HT,
VT, FF, RS and US) and their raw control characters to spaces, collapses whitespace,
and strips other control markers and C0/C1 controls while preserving decoded data.
Empty function-zero pages carry a `tone only` label; they remain stored events,
with compact notice presentation in the web app. Message presentation budgets
still apply to list fields and titles.

## Decoder Integration Patterns

WaveKit supports three decoder integration patterns:

### Pattern 1: Pure Consumer

Decoder receives audio via stdin, outputs to stdout.

```
FanoutManager → stdin → [Decoder Process] → stdout → Parser
```

**Examples**: dsd-fme, multimon-ng, rtl_433

**Pros**: Simple, standard Unix pattern
**Cons**: Requires audio format conversion

### Pattern 2: Network Producer

Decoder runs as a service, exposes network output.

```
[Decoder Process] ← WaveKit connects to output port
        ↓
   TCP/UDP output
        ↓
   Parser
```

**Examples**: readsb (SBS/Beast), AIS-catcher (NMEA), direwolf (KISS)

**Pros**: Decoder manages its own input, standard output formats
**Cons**: More complex lifecycle management

### Pattern 3: External SDR Owner

Decoder controls its own SDR hardware.

```
[Decoder Process] ← controls → [RTL-SDR dongle]
        ↓
   stdout/file output
        ↓
   Parser
```

**Examples**: acarsdec, dumpvdl2

**Pros**: Decoder has full tuner control
**Cons**: Requires dedicated SDR dongle per decoder

## Configuration System

Configuration is loaded from YAML files with environment variable overrides.

**Location**: `src/config.ts`

**Loading order**:

1. `config/default.yaml` — Built-in defaults
2. `config/custom.yaml` — User overrides (optional)
3. Environment variables — `WAVEKIT_*` prefix

**Environment variable mapping**:

```
WAVEKIT_API_PORT=9000           → api.port = 9000
WAVEKIT_LOG_LEVEL=debug         → logging.level = "debug"
WAVEKIT_SOURCES_0_HOST=1.2.3.4  → sources[0].host = "1.2.3.4"
WAVEKIT_STATE_DIR=data          → stateDir = "data"
WAVEKIT_ACTIVITY__ENABLED=true  → activity.enabled = true
```

Nested activity retention and admission keys use the same `__` form
(`WAVEKIT_ACTIVITY__RETENTION__MAX_ROWS`, and the matching admission names).
The activity database is `<stateDir>/activity/activity.db` and is created only
when Activity is enabled and the store opens.

**Validation**: All configuration is validated with Zod schemas at startup.

## Error Handling

### Custom Error Classes

**Location**: `src/utils/errors.ts`

```typescript
class WaveKitError extends Error {
  constructor(message: string, public code: string, public cause?: Error)
}

class SourceConnectionError extends WaveKitError { }
class DecoderSpawnError extends WaveKitError { }
class ConfigValidationError extends WaveKitError { }
```

### Error Recovery

| Error Type               | Recovery Strategy              |
| ------------------------ | ------------------------------ |
| Source connection failed | Retry with exponential backoff |
| Source connection lost   | Auto-reconnect                 |
| Decoder process crashed  | Auto-restart with backoff      |
| Decoder parse error      | Log warning, skip line         |
| Config validation error  | Fail fast, exit                |
| Stale state lock         | Reclaim after heartbeat check  |

## Logging

Structured JSON logging with Pino.

**Location**: `src/utils/logger.ts`

**Log levels**: trace, debug, info, warn, error

**Component loggers**:

```typescript
const log = createComponentLogger(parentLogger, "SourceManager")
log.info({ sourceId: "rtl-pi" }, "Connected to source")
```

**Output format**:

```json
{
	"level": 30,
	"time": 1704816225123,
	"pid": 1234,
	"hostname": "wavekit",
	"component": "SourceManager",
	"sourceId": "rtl-pi",
	"msg": "Connected to source"
}
```

## Graceful Shutdown

**Location**: `src/utils/graceful-shutdown.ts`

On SIGTERM/SIGINT:

1. Stop accepting new connections
2. Stop all decoders (SIGTERM → wait 5s → SIGKILL)
3. Close all source connections
4. Destroy all streams
5. Exit

Hooks run in reverse registration order. In `src/index.ts` that is: `audio-wiring`, `aircraft-tracking`, `resource-aggregator`, `api-server`, `scanner`, `audio-output`, `decoder-manager`, `channelizer` (only when enabled), `tuner-relay`, `digital-voice`, `live-demodulator`, `fanout-manager`, `source-manager`. The `scanner` hook runs after the API server stops taking requests and before the decoders, the channelizer, the fanout and the sources stop, so the tuner lease restore (bounded at 2 s) writes to a still-open rtl_tcp socket.

Timeout: 10 seconds, then force exit.

## Docker Architecture

### s6-overlay

WaveKit uses s6-overlay as PID 1 for proper process supervision.

**Service dependency graph**:

```
wavekit-init (oneshot)
       │
       ├── sdrpp-server (longrun, `final` and `final-sdrpp` only) ─┐
       │                               │
       └── wavekit-api (longrun) ──────┤
                                       │
                                       ▼
                                   services (bundle)
```

### Build Targets

| Target        | Contents                                       | Image Size |
| ------------- | ---------------------------------------------- | ---------- |
| `final-core`  | API + Decoders                                 | ~800 MB    |
| `final`       | `final-core` + SDR++ server (optional)         | ~1.5 GB    |
| `final-sdrpp` | SDR++ only                                     | ~450 MB    |
| `final-demod` | Interactive demod tools (opt-in `demod` group) | n/a        |

Targets and tags are defined in `docker/bake.hcl`; see [Docker setup](DOCKER-SETUP.md).

## Testing Strategy

### Unit Tests

- Mock child processes and network sockets
- Test individual components in isolation
- Located in `tests/unit/`

### Property-Based Tests

- Use fast-check for property-based testing
- Verify invariants across random inputs
- Located alongside unit tests

### Integration Tests

- Real processes, mock network
- Test component interactions
- Located in `tests/integration/`

### Test Fixtures

- Sample decoder output for parsing tests
- Located in `tests/mocks/fixtures/`

The offline IQ replay tool reuses the native rational polyphase FIR for decoder
clocks: 48/96/192 kHz captures can become exactly 105 kHz for VDL2, and a 192 kHz
capture can become 250 kHz for 125 kHz LoRa. Replay can emit U8 directly for these
decoders; audio consumers retain cf32. The output length is exactly
`ceil(inputSamples * outputRate / inputRate)`, without a filter tail. Capture at
192 kHz scales the narrow passband by four, capped at 150 kHz (125 kHz plus two
12.5 kHz guards), leaving a 42 kHz capture-filter transition. Its ready event must
acknowledge this wider passband before the core requests that rate.

The IQ replay CLI normalizes CU8 output by its largest absolute I/Q component:
gain = min(256, 10^(-6/20) / peak), leaving 6 dB headroom. All-zero or non-finite
input uses unity gain. CF32 output retains its original level. The rational
resampler checks its Kaiser length before allocation and caps the prototype,
including verification growth, at 131071 taps (131071 × 4 = 524284 bytes of f32
coefficients). A request beyond this cap fails with a tap-limit error.

### Wireless M-Bus activity

rtl_433 signal output with model `Wireless-MBus` is presented as protocol
`wmbus` in the sensors category, with mode, manufacturer and meter type fields.
The existing sensor entity key is retained. Activity frequency provenance uses
rtl_433's `freq` in MHz, or the midpoint `(freq1 + freq2) / 2` for FSK, validated
against the decoder's actual input centre and rate before conversion to Hz.
The mapper does not infer a frequency from a model name. See
[Wireless M-Bus setup](DECODER-GUIDE.md#wireless-m-bus-meters-86895-mhz).
