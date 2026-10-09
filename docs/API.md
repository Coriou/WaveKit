# WaveKit API Reference

WaveKit exposes a REST API and WebSocket endpoint for control and real-time monitoring.

## Base URL

- **REST API**: `http://localhost:9000`
- **WebSocket**: `ws://localhost:9000/ws`
- **Audio Stream**: `tcp://localhost:8080`
- **Live Audio Stream**: `http://localhost:8081/stream`

## REST Endpoints

### Health & Status

#### GET /health

Quick liveness check.

```bash
curl http://localhost:9000/health
```

**Response** (200 OK):

```json
{
	"status": "ok",
	"uptime": 3600
}
```

**Response** (503 Service Unavailable):

```json
{
	"status": "unhealthy",
	"error": "No sources connected"
}
```

#### GET /health/ready

Readiness probe for orchestration systems.

```bash
curl http://localhost:9000/health/ready
```

**Response** (200 OK):

```json
{
	"ready": true,
	"components": {
		"api": "up",
		"sources": "up",
		"decoders": "up"
	}
}
```

#### GET /api/status

Full system status including sources, decoders, audio output, and tuner relay (if enabled).

```bash
curl http://localhost:9000/api/status
```

**Response**:

```json
{
	"uptime": 3600,
	"version": "1.0.0",
	"sources": [
		{
			"id": "sdrpp-main",
			"type": "sdrpp-network",
			"connected": true,
			"bytesReceived": 847000000,
			"dataRate": 192000,
			"reconnectAttempts": 0
		}
	],
	"decoders": [
		{
			"id": "dsd-main",
			"type": "dsd-fme",
			"running": true,
			"health": "running",
			"pid": 1234,
			"uptime": 3590,
			"stats": {
				"bytesIn": 423000000,
				"eventsOut": 847,
				"errors": 2
			}
		}
	],
	"audio": {
		"outputPort": 8080,
		"clientsConnected": 1,
		"format": "S16LE",
		"sampleRate": 48000
	},
	"tunerRelay": {
		"enabled": true,
		"listening": true,
		"host": "0.0.0.0",
		"port": 1234,
		"sourceId": "rtl-pi",
		"clientsConnected": 1,
		"controlPolicy": "exclusive",
		"bytesSent": 421000000,
		"bytesReceived": 120,
		"lastFrequency": 446524920,
		"lastSampleRate": 2048000,
		"lastCommand": "set-frequency",
		"lastCommandAt": "2024-05-21T03:12:01.123Z",
		"lastCommandValue": 446524920,
		"commandHistoryLimit": 200,
		"commandStats": [
			{
				"id": 1,
				"name": "set-frequency",
				"count": 6,
				"lastValue": 446524920,
				"lastSeenAt": "2024-05-21T03:12:01.123Z"
			}
		],
		"commandHistory": [
			{
				"id": 1,
				"name": "set-frequency",
				"value": 446524920,
				"at": "2024-05-21T03:12:01.123Z",
				"clientId": "client-1",
				"clientRemote": "192.168.1.50:50522"
			}
		]
	}
}
```

### Sources

#### GET /api/sources

List all configured sources.

```bash
curl http://localhost:9000/api/sources
```

**Response**:

```json
[
	{
		"id": "sdrpp-main",
		"type": "sdrpp-network",
		"host": "192.168.1.69",
		"port": 5555,
		"connected": true,
		"activity": {
			"state": "streaming",
			"lastSampleAt": "2026-10-08T12:00:00.000Z",
			"sampleAgeMs": 12,
			"timeoutMs": 10000
		},
		"bytesReceived": 847000000,
		"dataRate": 192000,
		"caps": {
			"kind": "audio_pcm",
			"sampleRate": 48000,
			"format": "FLOAT32LE",
			"exclusive": false
		}
	}
]
```

**Rate truth (network sources).** Every 5 s metrics interval compares the bytes
actually received with `caps.sampleRate` × bytes per sample (2 for `U8_IQ`, 4 for
`S16_IQ`, 2/4 × channels for `S16LE`/`FLOAT32LE`; `auto` is not checked). When
every trusted interval for at least 30 s deviates by more than 2 % in the same
direction (an interval with no bytes at all is a `waiting`/`stale` source, not a
rate, and is not trusted), the source gains
`rateMismatch: { declaredSampleRateHz, measuredSampleRateHz, deviation, since }`
(also on `source:status` and in `/api/status`) and core logs a warning; it
disappears after 30 s of agreement, on a caps rate/format change and on
disconnect. Caps are never corrected from it. A positive `deviation` means the
dongle runs faster than declared (an external tuner client changed its rate);
a negative one can also be loss upstream. Intervals that cannot be trusted are
skipped: the first after a (re)connect and any in which local backpressure
paused the socket. Recordings are not checked.

**Signal flat (IQ network sources).** The sibling of rate truth: the right rate
at a dead level (e.g. an external SDR++ client left the dongle at near-zero
gain) also decodes nothing. For `kind: "iq"` sources in `U8_IQ` (zero 127.5,
full scale 127.5) or `S16_IQ` (zero 0, full scale 32768), core reads one IQ
component every 1021 of the stream (about 4000 reads/s at 2 Msps) and computes
each 5 s interval's level as the RMS of the components about zero, in dBFS
(`20·log10(rms / fullScale)`, floored at −150). While measured, the source
carries `signalLevelDbfs` (latest interval, 0.1 dB). When every measured
interval for at least `health.signalFlatHoldMs` (default 30 s) is below
`health.signalFlatThresholdDbfs` (default −40 dBFS, about 1.3 LSB RMS in u8;
the incident measured about −46.5, a normal antenna noise floor sits at −33 or
higher), the source gains `signalFlat: { levelDbfs, thresholdDbfs, since }`
(also on `source:status` and in `/api/status`; `levelDbfs` is the latest
interval) and core logs a warning. It clears (info log) after the same hold at
threshold + 3 dB or more, so a level hovering at the threshold does not flap,
and on a caps rate/format/kind change, (re)connect and disconnect. An interval
with no bytes (`waiting`/`stale`) breaks a run and never raises it. Audio PCM,
`auto` formats and recordings are not measured (no `signalLevelDbfs`).

**Stall watchdog (rtl_tcp U8_IQ sources).** An rtl_tcp IQ stream never pauses while
it is healthy. After a session has delivered payload, a gap of `stallTimeoutMs`
(source config, default 15000, `0` disables) means the peer is dead or the
connection is half-open, e.g. a rebooted host that never sent FIN. Core then drops
the connection: `connected` becomes `false`, `lastError` reads
`No data from source for <n>ms (stall watchdog <timeout>ms); reconnecting`, and
the normal reconnect/backoff path runs. A successful reconnect clears `lastError`
and resets `reconnectAttempts`. Tuner sync runs on the new session's first payload
(not on connect), so nothing is written to an rtlmux whose upstream is still down.
Without this, such a source stayed `connected: true` with activity `stale`
indefinitely. TCP keepalive is enabled too, but it only detects a dead peer, not a
live rtlmux with a dead upstream. The watchdog does not apply to recordings,
`sdrpp-network` or audio sources, rtl_tcp sources with a format other than
`U8_IQ`, a session that has not streamed yet (it stays connected and reports
`stale`), or time spent `paused` by local backpressure. `POST /api/sources`
accepts `stallTimeoutMs` (integer, `0` or 1000–600000) and validates the whole
body with the config schema (`400 VALIDATION_ERROR` on failure).

### Tuner

#### GET /api/tuner

List tuner states for all RTL-TCP sources.

Relay-driven RTL-TCP commands (from SDR++ via the tuner relay) update these
states and will automatically switch control mode to `external` while the relay
has an active control client.

Tuner values are the last _commanded_ desired values, not hardware readback:
rtl_tcp has no positive acknowledgement. When an rtl_tcp source reconnects, the
`tuner.reconnectPolicy` config decides what happens. With `restore` (the default),
core re-sends the fields that were accepted through this API or the relay (never
config defaults) and counts them in `commandCount`/`lastCommandAt`; a failed
restore sets `lastError` and is retried on the next connection. Relay commands
received while the source is down become desired state and are sent on
reconnect. With `reset`, core sends nothing and returns tuner state and source
caps to the configured baseline. With either policy, source caps
(`sampleRate`/`centerFreq`) are reconciled to values backed by an accepted
command or the configured baseline (the `reset` baseline must mirror the
receiver's startup arguments). A relay rate the controller rejects never
changes source caps. Combine with the source `connected` flag to tell sent from
pending.

Reconciliation is not readback. After a core-only restart nothing has been
accepted, so nothing is written and caps show the configured baseline, while the
hardware may still be at relay-set values (rtlmux caches client commands and
replays them to rtl_tcp). Through an rtlmux host, test mode and direct sampling
commands are dropped, so those two tuner fields may over-claim.

**`unknownFields`** lists the fields whose value is only a placeholder: nothing
was commanded through this API, no relay client was seen commanding it, and
(for `frequency`/`sampleRate`) neither the tuner config nor the source caps
declare it. On a source whose gain was set on the SDR host this reads e.g.
`["gainMode", "gain", "ppm", …]`; render those fields as unknown instead of
"AGC 0.0 dB". A gain mode the relay path infers from a client's gain command
counts as observed (it is not replayed on reconnect). The field values keep
their types for older clients. A reset
reconnect makes them unknown again; the field is absent when everything is known.

```bash
curl http://localhost:9000/api/tuner
```

**Response**:

```json
[
	{
		"sourceId": "rtl-pi",
		"frequency": 144800000,
		"sampleRate": 2400000,
		"gainMode": "agc",
		"gain": 0,
		"ppm": 0,
		"agcMode": true,
		"biasTee": false,
		"directSampling": "off",
		"offsetTuning": false,
		"ifGain": 0,
		"tunerIfGain": null,
		"testMode": false,
		"controlMode": "internal",
		"commandCount": 12,
		"lastCommandAt": "2024-05-21T03:12:01.123Z",
		"unknownFields": ["ppm", "biasTee", "testMode"]
	}
]
```

#### GET /api/tuner/:sourceId

Get tuner state for a single source.

```bash
curl http://localhost:9000/api/tuner/rtl-pi
```

#### POST /api/tuner/:sourceId/frequency

Set center frequency.

```bash
curl -X POST http://localhost:9000/api/tuner/rtl-pi/frequency \
  -H "Content-Type: application/json" -d '{"hz":144800000}'
```

#### POST /api/tuner/:sourceId/control-mode

Release control to SDR++ (`external`) or reclaim (`internal`).

```bash
curl -X POST http://localhost:9000/api/tuner/rtl-pi/control-mode \
  -H "Content-Type: application/json" -d '{"mode":"external"}'
```

#### Additional tuner endpoints

- `POST /api/tuner/:sourceId/gain` — Set manual gain (`{ "tenthsDb": 400 }`)
- `POST /api/tuner/:sourceId/gain-mode` — `manual` or `agc`
- `POST /api/tuner/:sourceId/sample-rate` — Set sample rate
- `POST /api/tuner/:sourceId/ppm` — Set PPM correction
- `POST /api/tuner/:sourceId/agc` — RTL2832 AGC toggle
- `POST /api/tuner/:sourceId/bias-tee` — Bias-T power toggle
- `POST /api/tuner/:sourceId/direct-sampling` — `off` / `i` / `q`
- `POST /api/tuner/:sourceId/offset-tuning` — Offset tuning toggle
- `POST /api/tuner/:sourceId/if-gain` — IF gain value
- `POST /api/tuner/:sourceId/tuner-if-gain` — IF stage/gain pair
- `POST /api/tuner/:sourceId/test-mode` — Test mode toggle
- `POST /api/tuner/:sourceId/rtl-xtal` — RTL XTAL frequency
- `POST /api/tuner/:sourceId/tuner-xtal` — Tuner XTAL frequency
- `POST /api/tuner/:sourceId/tuner-gain-index` — Gain index value
- `PATCH /api/tuner/:sourceId/config` — Bulk update

### Tuner Relay

#### GET /api/tuner-relay

Get RTL-TCP tuner relay status and connection details.

```bash
curl http://localhost:9000/api/tuner-relay
```

**Response**:

```json
{
	"enabled": true,
	"listening": true,
	"host": "0.0.0.0",
	"port": 1234,
	"sourceId": "rtl-pi",
	"sourceConnected": true,
	"sourceKind": "iq",
	"sourceFormat": "U8_IQ",
	"compatibility": "ok",
	"clientsConnected": 1,
	"controlClientRemote": "192.168.1.50:50522",
	"controlPolicy": "exclusive",
	"bytesSent": 421000000,
	"bytesReceived": 120,
	"lastFrequency": 446524920,
	"lastSampleRate": 2048000,
	"lastCommand": "set-frequency",
	"lastCommandAt": "2024-05-21T03:12:01.123Z",
	"lastCommandValue": 446524920,
	"commandHistoryLimit": 200,
	"commandStats": [
		{
			"id": 1,
			"name": "set-frequency",
			"count": 6,
			"lastValue": 446524920,
			"lastSeenAt": "2024-05-21T03:12:01.123Z"
		}
	],
	"commandHistory": [
		{
			"id": 1,
			"name": "set-frequency",
			"value": 446524920,
			"at": "2024-05-21T03:12:01.123Z",
			"clientId": "client-1",
			"clientRemote": "192.168.1.50:50522"
		}
	]
}
```

### Live Audio

#### GET /api/live-audio/status

Get live demodulator status.

```bash
curl http://localhost:9000/api/live-audio/status
```

**Response**:

```json
{
	"enabled": true,
	"running": true,
	"sourceId": "rtl-pi",
	"sourceConnected": true,
	"sourceIqSampleRate": 2400000,
	"config": {
		"enabled": true,
		"sourceId": "rtl-pi",
		"httpPort": 8081,
		"modulation": "nfm",
		"bandwidth": 12500,
		"squelch": 0,
		"noiseReduction": "off",
		"lowPass": 0,
		"highPass": 0,
		"gain": 10,
		"deEmphasis": false,
		"deEmphasisTau": 50,
		"audioFormat": "s16le",
		"iqDcBlock": true
	},
	"effectiveSampleRate": 25000,
	"decimationFactor": 96,
	"httpUrl": "http://localhost:8081/stream",
	"clientCount": 1,
	"bytesStreamed": 1234567,
	"pipelineHealth": "running"
}
```

#### POST /api/live-audio/start

Start live demodulation.

```bash
curl -X POST http://localhost:9000/api/live-audio/start
```

**Response**:

```json
{ "success": true }
```

#### POST /api/live-audio/stop

Stop live demodulation.

```bash
curl -X POST http://localhost:9000/api/live-audio/stop
```

**Response**:

```json
{ "success": true }
```

#### PATCH /api/live-audio/config

Update live demodulator configuration (hot-restart pipeline).

```bash
curl -X PATCH http://localhost:9000/api/live-audio/config \
  -H "Content-Type: application/json" \
  -d '{
    "modulation": "am",
    "bandwidth": 10000,
    "gain": 8.0
  }'
```

**Response**:

Returns the updated status (same schema as `/api/live-audio/status`).

#### GET /api/live-audio/presets

Get recommended presets per modulation.

```bash
curl http://localhost:9000/api/live-audio/presets
```

**Response**:

```json
{
	"nfm": { "bandwidth": 12500, "deEmphasis": false },
	"wfm": { "bandwidth": 150000, "deEmphasis": true, "deEmphasisTau": 50 },
	"am": { "bandwidth": 10000, "deEmphasis": false },
	"usb": { "bandwidth": 2400, "deEmphasis": false },
	"lsb": { "bandwidth": 2400, "deEmphasis": false },
	"dsb": { "bandwidth": 6000, "deEmphasis": false },
	"cw": { "bandwidth": 500, "deEmphasis": false },
	"raw": { "bandwidth": 0, "deEmphasis": false }
}
```

#### POST /api/sources

Add a new source.

```bash
curl -X POST http://localhost:9000/api/sources \
  -H "Content-Type: application/json" \
  -d '{
    "id": "rtl-pi",
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
```

**Response** (201 Created):

```json
{
	"id": "rtl-pi",
	"type": "rtl_tcp",
	"connected": false,
	"message": "Source added, connecting..."
}
```

#### DELETE /api/sources/:id

Remove a source.

```bash
curl -X DELETE http://localhost:9000/api/sources/rtl-pi
```

**Response** (200 OK):

```json
{
	"id": "rtl-pi",
	"message": "Source removed"
}
```

### Decoders

#### GET /api/decoders

List all decoders and their status.

```bash
curl http://localhost:9000/api/decoders
```

**Response**:

```json
[
	{
		"id": "dsd-main",
		"type": "dsd-fme",
		"enabled": true,
		"running": true,
		"health": "running",
		"pid": 1234,
		"uptime": 3590,
		"sourceId": "sdrpp-main",
		"stats": {
			"bytesIn": 423000000,
			"eventsOut": 847,
			"errors": 2
		},
		"restartCount": 0,
		"version": "2.0.0",
		"idleTimeoutMs": 30000,
		"targetFrequenciesHz": [446525000],
		"lastError": {
			"kind": "exit",
			"message": "Process exited unexpectedly (code 1)",
			"at": "2026-10-08T12:00:00.000Z"
		}
	},
	{
		"id": "readsb",
		"type": "readsb",
		"enabled": true,
		"running": true,
		"health": "running",
		"pid": 1235,
		"uptime": 3585,
		"stats": {
			"bytesIn": 0,
			"eventsOut": 12847,
			"errors": 0
		},
		"restartCount": 0,
		"version": "3.14.1"
	}
]
```

**Optional status fields** (additive; also present on `/api/decoders/:id`, the
start/stop/restart `decoder` bodies, `/api/status` decoder entries and the
`decoder:status` WebSocket event):

| Field                 | Meaning                                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceId`            | WaveKit source the decoder reads: the live assignment while wired, otherwise the configured `sourceId`. Absent for external-input decoders (they own their device) and for unwired decoders relying on the default source.                                                                                     |
| `deviceSerial`        | Configured device serial of an external-input decoder (`caps.input: "external"`). Never inferred; absent when not configured and always absent for stdin decoders (their serial options are ignored in stdin mode).                                                                                            |
| `targetFrequenciesHz` | Target frequencies declared in config: top-level `frequencies`, else `options.frequencies`, else `options.frequency`. Absent when the config declares none (the decoder then decodes whatever its source is tuned to, or a built-in default that is not reported).                                             |
| `lastError`           | `{ kind, message, at }` for the most recent failure. `kind: "error"` = emitted error or failed (re)start; `kind: "exit"` = process exited without being asked to stop. `message` ≤ 512 chars (truncated with `…`), `at` is ISO-8601. An `"error"` recorded during a run is kept rather than replaced by the generic exit that ends that run. Retained across automatic restarts; cleared only by an explicit start/restart, the same moment `restartCount` resets to 0. |
| `idleTimeoutMs`       | Milliseconds without output before `health` becomes `"idle"`: the configured `health.idleTimeout` (default 30000).                                                                                                                                                                                                                                       |
| `nextRestartAt`       | ISO-8601 time of the scheduled automatic restart. Present only while one is pending (`health` is `"restarting"`, or `"faulted"` during a crash loop that is still retrying).                                                                                                                                                                       |

`health` after an unexpected exit:

- `"restarting"`: the process exited without being asked to stop and an
  automatic restart is scheduled at `nextRestartAt`. The restarted run reports
  `"running"` (then `"idle"` as usual).
- `"faulted"` with `nextRestartAt` (or with `running: true`): crash loop.
  `health.faultAfterFailures` (default 5) consecutive runs ended without output
  and before 30 s. Retries continue at the maximum backoff (30 s); a retry run
  stays `"faulted"` on probation until it produces output or stays up 30 s,
  then returns to `"running"`.
- `"faulted"` with `running: false` and no `nextRestartAt`: terminal. The
  restart budget (`maxRestarts`, unlimited by default) is exhausted, an explicit
  start failed, or the operator stopped a faulted decoder; an explicit
  start/restart is required.

An explicit stop cancels a pending restart; a `"restarting"` decoder then
reports `"running"` with `running: false` (a fault stays visible until the next
explicit start). Use `restartCount` and `lastError` to explain these states.

##### Rate plan and reversible suspension

`rateAssessment` is the decoder instance's plan for its source's current
sample rate: `verdict` (`best` | `acceptable` | `unusable` | `unknown`), the
observed `sourceRateHz`, `frontendRateHz` (IQ rate after the decoder's own
decimation/resampling) and `decoderInputRateHz` (what the program reads on
stdin), the `adaptation`, and for `unusable` the `reasonCode`,
`requiredMinimumHz` and `requirementBasis`. Built-in minimums are
implementation facts (`"implementation"`): the audio decoders need at least
their demod rate (48 kHz; 24 kHz for acarsdec), LoRa at least its bandwidth.
readsb, AIS-catcher, dumpvdl2 and rtl_433 report `unknown` with observed rates
until fixture-verified requirements exist; external-input decoders report
`external-input`.

| Field            | Meaning                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desiredRunning` | Operator intent: `true` after start/restart, `false` after stop.                                                                                                                |
| `suspended`      | Wanted but held back because the source rate makes this instance `unusable` or the tuned band covers none of its targets. The decoder keeps its source reservation and `sourceId` and is never moved to another source. |
| `suspension`     | `{ reasonCode, since }` (ISO-8601), present only while suspended. `reasonCode` is a rate reason or `"frequency-out-of-band"`.                                                  |
| `transition`     | `"suspending"` or `"resuming"`, present only during a transition. A lasting `"suspending"` means the stop failed and the process may still run (`running` stays truthful).     |
| `startMode`      | `"auto"` or `"operator"`, sent while `desiredRunning` is true. `"operator"` = started by hand via `POST /api/decoders/:id/start` (never band-suspended; a rate suspension still applies). Boot starts are `"auto"`. Stop clears it, restart keeps it, a core restart returns every decoder to `"auto"`. |

A decoder that is running is suspended when its source changes to an unusable
rate and resumed when the rate becomes usable again (or the source reconnects
with a usable rate). Suspension does not set `lastError` or count restarts,
and leaves `health` unchanged except that a pending automatic restart is
cancelled (`"restarting"` becomes `"running"`, as on an explicit stop). A removed source leaves a suspended decoder suspended and a
running decoder running. Render `suspended` ahead of `health`.

##### Band check and band suspension

`bandAssessment` says whether the source centre lets the instance receive its
band: `verdict` (`in-band` | `out-of-band` | `unknown`), `targetsHz` and/or
`rangesHz` (`[{ minHz, maxHz }]`), `basis`, `captureCenterHz` and
`windowHalfWidthHz`, plus `region` (`{ code, source }`, when a regional default
produced the band) and `overrideSource` (`"config"` | `"api"`, when `basis` is
`"override"`). The window half-width `h` is 0.8 of half the span the pipeline
really sees, i.e. the capture or, when narrower, the decoder's own frontend
(an audio demodulator keeps only about ±19 kHz at a 48 kHz demod rate,
acarsdec about ±9.6 kHz; a resampler never adds span). With `c` the capture
centre:

- a target `t` fits when `|t − c| ≤ h`;
- a range fits when `minHz − h ≤ c ≤ maxHz + h` (a range `{ t, t }` is target `t`);
- in band when any target or range fits. With neither: `unknown` /
  `no-target-frequency`; a missing centre or rate: `unknown` /
  `source-center-unknown`.

**Precedence** (first match wins; `basis` in parentheses):

1. The decoder reads its own SDR (readsb `rtlTcpHost`) → `unknown`.
2. API band override, `PUT /api/decoders/:id/band` (`override`, `overrideSource: "api"`).
3. Config band override, `decoders[].band` (`override`, `overrideSource: "config"`).
4. Configured `frequencies` / `options.frequencies` / `options.frequency` (`configured`).
5. The decoder picks its own channels (ais-catcher `-c…` in `extraArgs`) → `unknown`.
6. Built-in default for the decoder type and region (`region-default`).
7. The decoder's protocol or own default (`protocol` / `decoder-default`).

The API and config override layers merge field-wise (API wins per field): the
band (`rangesHz` + `targetsHz` as one unit), `region` and `bandSuspension`. An
override changes band admission only, never the process arguments.

| Decoder | Band without a configured frequency or override |
| --- | --- |
| acarsdec | 129–137 MHz (`region-default`) |
| dsd-fme | 136–174, 380–512, 764–941 MHz (`region-default`) |
| direwolf | APRS per region: EU 144.800, US/CA 144.390, AU 145.175, NZ 144.575, JP/CN 144.640 MHz, plus 145.825 MHz ISS (`region-default`) |
| rtl433 | ISM/SRD ranges per region, e.g. EU 433.05–434.79 and 863–870 MHz (`region-default`) |
| multimon-ng | none → `unknown` (paging plans are country specific) |
| readsb (stdin) | 1 090 MHz (`protocol`); rtlTcpHost mode is external |
| ais-catcher | 161.975 and 162.025 MHz (`protocol`) |
| dumpvdl2 | its channel list: configured, else the built-in default the process actually decodes (`decoder-default`) |
| dumpvdl2 `followCenter` | the configured list bounds the band it follows; no configured list → `unknown` |
| lora-meshtastic | configured `frequency` (`configured`) |
| lora-meshtastic `followCenter` | a top-level `frequencies` list bounds the band it follows (`configured`); without one, the Meshtastic firmware range of its `options.region` (`decoder-default`, e.g. EU_868 869.4–869.65 MHz) |

A `followCenter` decoder decodes the source centre itself, so it is in band
anywhere from its lowest to its highest declared frequency, widened by the
window, not only near one of them.

**Region.** `region` (YAML) or `WAVEKIT_REGION`: `EU`, `US`, `CA`, `AU`, `NZ`,
`JP`, `CN` (case-insensitive; codes name band plans: `EU` is CEPT / IARU
Region 1, incl. the UK, Switzerland, Norway). Unset, core guesses once at
startup from `TZ`, the system time zone, then `LC_ALL` / `LC_CTYPE` / `LANG`,
then the Intl locale, else `EU` (`source`: `configured`, `guessed:tz`,
`guessed:intl-timezone`, `guessed:locale-env`, `guessed:intl-locale`,
`default`). A decoder `band.region` gives that decoder `source: "decoder"`.
The effective region is logged at startup and always shown by
`GET /api/decoders/:id/band`, so a wrong guess is visible and fixable.

A wanted decoder whose band is out of band is suspended with reason
`"frequency-out-of-band"` (same semantics as a rate suspension) and resumes
when a retune brings it back. An unusable rate takes precedence as the
reason. `unknown` (no band, a source without `centerFreq`, external input)
never suspends. A decoder started by hand (`startMode: "operator"`) is never
band-suspended, and `band.bandSuspension: false` (config or API) is the
durable per-decoder opt-out. The check trusts `caps.centerFreq`, which only follows retunes made
through the tuner API or the relay; a client retuning the receiver some other
way leaves it stale (decoders then stay as they were, never newly suspended).
Centre changes are applied by the same debounced serial worker
as rate changes. `health.bandSuspension: false` keeps the assessment but never
suspends for band. The rate preview stays rate-only.

#### GET /api/decoders/:id/band

The decoder's band override layers, effective region and current assessment
(`DecoderBandSettings`):

```json
{
	"decoderId": "ism",
	"override": { "rangesHz": [{ "minHz": 433050000, "maxHz": 434790000 }], "bandSuspension": false },
	"configOverride": null,
	"region": { "code": "EU", "source": "guessed:tz" },
	"persisted": true,
	"bandAssessment": { "verdict": "in-band", "basis": "override", "overrideSource": "api", "...": "..." }
}
```

`override` is the API layer, `configOverride` the `decoders[].band` layer.
`persisted: false` means the API layer lives only in memory (the state file is
not writable, or was written by a newer core and is left untouched).

#### PUT /api/decoders/:id/band

Replaces the API layer. Body `{ rangesHz?, targetsHz?, region?,
bandSuspension? }` with at least one key (`rangesHz`: 1–32 ranges with
`minHz ≤ maxHz`; `targetsHz`: 1–64 positive Hz). Persisted by core to
`<stateDir>/decoder-band-overrides.json` and survives a restart. The band
plan is recomputed and published at once; a wanted decoder then suspends or
resumes through the serial worker (`decoder:status` again ≈300 ms later).

```bash
curl -X PUT http://localhost:9000/api/decoders/ism/band \
  -H "Content-Type: application/json" \
  -d '{ "rangesHz": [{ "minHz": 433050000, "maxHz": 434790000 }] }'
```

**Response** (200 OK): `DecoderBandSettings`. Errors: 400
`INVALID_BAND_OVERRIDE`, 404 `DECODER_NOT_FOUND`, 409
`DECODER_BAND_NOT_APPLICABLE` (external-input decoders own their device).

#### DELETE /api/decoders/:id/band

Removes the API layer (idempotent). **Response** (200 OK):
`DecoderBandSettings` with `override: null`. Same errors as PUT (no 400).

#### GET /api/decoders/rate-preview

Each decoder's `rateAssessment` for a source as if it ran at `sampleRateHz`.
Pure: nothing is tuned, no caps change, no decoder starts or stops.

```bash
curl 'http://localhost:9000/api/decoders/rate-preview?sourceId=rtl-pi&sampleRateHz=1024000'
```

**Response** (200 OK): `[{ "decoderId": "acars", "assessment": { "verdict": "acceptable", ... } }]`
for every decoder selecting that source. 404 for an unknown source; 400 for a
non-positive or non-integer rate and, for `rtl_tcp` sources, for rates
librtlsdr rejects (valid: 225001–300000 and 900001–3200000 Hz).

#### GET /api/decoders/:id

Get status of a specific decoder.

```bash
curl http://localhost:9000/api/decoders/dsd-main
```

**Response**:

```json
{
	"id": "dsd-main",
	"type": "dsd-fme",
	"enabled": true,
	"running": true,
	"health": "running",
	"pid": 1234,
	"uptime": 3590,
	"sourceId": "sdrpp-main",
	"stats": {
		"bytesIn": 423000000,
		"eventsOut": 847,
		"errors": 2
	},
	"lastOutput": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"decoder": "dsd-main",
		"type": "call",
		"data": {
			"talkgroup": 1234,
			"source": 5678,
			"mode": "DMR"
		}
	}
}
```

#### POST /api/decoders/:id/start

Start a decoder. Optional body `{ "pin": boolean }` (default `true`; no body
behaves as `pin: true`). A pinned start records `startMode: "operator"`: the
decoder runs wherever the source is tuned and is never band-suspended. On an
unusable source rate the start is recorded instead: 200 with the full status
(`suspended: true`, `suspension`, `rateAssessment`), never 409.

| Decoder state | No body | `{ "pin": true }` | `{ "pin": false }` |
| --- | --- | --- | --- |
| stopped | start as `"operator"` | same | start as `"auto"` (may band-suspend at once) |
| band-suspended | pin + resume ("run anyway") | same | 200 no-op, stays `"auto"` |
| rate-suspended | 200 no-op, pin recorded (holds when the rate recovers) | same | 200 no-op, mode `"auto"` |
| running | 409 `DECODER_ALREADY_RUNNING` | 200, mode → `"operator"` | 200, mode → `"auto"`; band re-evaluated, may suspend |

An invalid body is 400 `INVALID_START_REQUEST`. `/restart` keeps the current
mode; `/stop` clears it.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/start
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": true,
	"pid": 1234,
	"message": "Decoder started"
}
```

#### POST /api/decoders/:id/stop

Stop a decoder. Also accepted (200) for a decoder that is not running but
still wanted: suspended, waiting in restart backoff, or terminally faulted. 409 only when neither
running nor wanted. Stopping clears intent and any suspension and releases the
source reservation.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/stop
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": false,
	"message": "Decoder stopped"
}
```

#### POST /api/decoders/:id/restart

Restart a decoder.

```bash
curl -X POST http://localhost:9000/api/decoders/dsd-main/restart
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"running": true,
	"pid": 1235,
	"message": "Decoder restarted"
}
```

#### PATCH /api/decoders/:id

Update decoder configuration.

```bash
curl -X PATCH http://localhost:9000/api/decoders/dsd-main \
  -H "Content-Type: application/json" \
  -d '{
    "options": {
      "mode": "dmr"
    }
  }'
```

**Response** (200 OK):

```json
{
	"id": "dsd-main",
	"message": "Configuration updated, restart required"
}
```

## WebSocket API

Each connection has a 1 MiB outbound payload budget across the application queue
and WebSocket buffer, with at most 256 messages waiting in the application queue.
Messages remain FIFO. A client exceeding either limit, including with a single
oversized event, is terminated independently of other clients. Pending queues
are checked every 100 ms while connections exist; this is not a delivery deadline.

The server sends WebSocket protocol pings every 30 seconds and terminates a
connection that has not answered by its next heartbeat. Browsers and standard
WebSocket libraries normally answer protocol pings automatically. This does not
require a new JSON message type.

After disconnecting, reconnect and resubscribe, then refresh state through REST.
Events missed during disconnection are not replayed, and snapshot/event ordering
is not yet guaranteed. SSE and resumable event history are planned, not currently
implemented. See [the API roadmap](ROADMAP.md#4-api-and-event-foundation-for-multiple-clients).

### Connection

```javascript
const ws = new WebSocket("ws://localhost:9000/ws")

ws.onopen = () => {
	// Subscribe to channels
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
				"resources",
				"tuner",
			],
		}),
	)
}

ws.onmessage = event => {
	const msg = JSON.parse(event.data)
	console.log(msg.type, msg.data)
}
```

### Client Messages

#### Subscribe

```json
{
	"type": "subscribe",
	"channels": [
		"decoders",
		"sources",
		"metrics",
		"health",
		"fanout",
		"live-audio",
		"resources",
		"tuner"
	]
}
```

#### Unsubscribe

```json
{
	"type": "unsubscribe",
	"channels": ["metrics"]
}
```

### Server Messages

#### decoder:output

Emitted when a decoder produces output.

```json
{
	"type": "decoder:output",
	"channel": "decoders",
	"data": {
		"decoderId": "dsd-main",
		"output": {
			"timestamp": "2026-01-09T14:23:45.123Z",
			"decoder": "dsd-main",
			"type": "call",
			"data": {
				"talkgroup": 1234,
				"source": 5678,
				"mode": "DMR",
				"duration": 12.5
			}
		}
	}
}
```

The `output.type` field is the discriminator — switch on it to route per-decoder payloads. Known values include `call`, `call_start`, `call_end`, `signal`, `aircraft`, `ship`, `acars`, `vdl2`, `aprs`, `meshtastic`, plus generic `sync`, `decode`, `error`, `stats`.

##### Meshtastic packet (type: `meshtastic`)

Emitted by the `lora-meshtastic` decoder. `from`/`to`/`id` are 32-bit unsigned ints; `to === 0xFFFFFFFF` (4294967295) marks broadcast destinations. `payloadB64` is the AES-CTR-decrypted Meshtastic `Data.payload` (decode with the per-portnum protobuf — e.g. portnum `1` is `TEXT_MESSAGE_APP` UTF-8 text). `viaMqtt` and `priority` are present only when set on the originating frame.

```json
{
	"type": "decoder:output",
	"channel": "decoders",
	"data": {
		"decoderId": "meshtastic-eu",
		"output": {
			"timestamp": "2026-05-15T14:23:45.123Z",
			"decoder": "meshtastic-eu",
			"type": "meshtastic",
			"data": {
				"from": 3735928559,
				"to": 4294967295,
				"id": 1234567890,
				"channel": 8,
				"hopLimit": 2,
				"hopStart": 3,
				"wantAck": false,
				"portnum": 1,
				"payloadB64": "SGVsbG8gV29ybGQ=",
				"payloadLen": 11,
				"rxRssi": -97,
				"rxSnr": 6.5,
				"rxTime": "2026-05-15T14:23:45.012Z",
				"frequency": 869525000,
				"bw": 250000,
				"sf": 11,
				"cr": 5
			}
		}
	}
}
```

#### decoder:started

```json
{
	"type": "decoder:started",
	"channel": "decoders",
	"data": {
		"id": "dsd-main",
		"pid": 1234
	}
}
```

#### decoder:stopped

```json
{
	"type": "decoder:stopped",
	"channel": "decoders",
	"data": {
		"id": "dsd-main",
		"exitCode": 0
	}
}
```

#### decoder:status

Full decoder status whenever a decoder starts, stops, errors, changes health,
schedules a restart, or exhausts its restarts. `data` is byte-for-byte the
`GET /api/decoders/:id` body (including `caps`, `lastError`, `restartCount`,
`sourceId`, `targetFrequenciesHz`, `idleTimeoutMs`). Lifecycle-driven only — no
periodic cadence. After a stop or process exit, a final `decoder:status` is sent
once cleanup (unassigning the source) has finished, so the last message for a
stopped decoder carries the unwired state (e.g. no stale `sourceId`). Expect
more than one `decoder:status` per transition; always apply the latest.

```json
{
	"type": "decoder:status",
	"channel": "decoders",
	"data": {
		"id": "acars",
		"type": "acarsdec",
		"running": false,
		"health": "running",
		"uptime": 0,
		"stats": { "bytesIn": 0, "eventsOut": 0, "errors": 0 },
		"lastOutputAt": null,
		"restartCount": 8,
		"rateAssessment": { "verdict": "unknown", "reasonCode": "unknown-requirements" },
		"sourceId": "rtl-pi",
		"idleTimeoutMs": 30000,
		"lastError": {
			"kind": "exit",
			"message": "Process exited unexpectedly (code 1)",
			"at": "2026-10-08T12:00:00.000Z"
		},
		"caps": { "input": "iq", "output": "text", "integrationPattern": "pure_consumer" }
	}
}
```

#### decoder:health

```json
{
	"type": "decoder:health",
	"channel": "health",
	"data": {
		"id": "dsd-main",
		"health": "degraded",
		"previousHealth": "running",
		"reason": "No output for 30 seconds"
	}
}
```

#### source:connected

```json
{
	"type": "source:connected",
	"channel": "sources",
	"data": {
		"id": "sdrpp-main",
		"host": "192.168.1.69",
		"port": 5555
	}
}
```

#### source:disconnected

```json
{
	"type": "source:disconnected",
	"channel": "sources",
	"data": {
		"id": "sdrpp-main",
		"error": "Connection reset by peer"
	}
}
```

#### source:status

Full source status including `activity` (sample freshness). `data` is identical
to one `GET /api/sources` item. Cadence, per source:

- on a lifecycle event (`connected`, `disconnected`, `error`, `ended`,
  `caps-changed`, rate-truth or signal-flat flag raised/cleared) when the state
  actually changed (a drifting `rateMismatch.measuredSampleRateHz`,
  `signalFlat.levelDbfs` or `signalLevelDbfs` alone does not emit);
- within 1 s of a time-based state change (`connected`, `activity.state`,
  `lastError`, `reconnectAttempts`, `caps`, `available`, assignments) — changes
  in counters such as `bytesReceived` or `activity.sampleAgeMs` alone do not emit;
- a heartbeat every 10 s (0.1 msg/s per source) refreshing counters;
- nothing while no client subscribes to `sources`; whenever the subscriber
  count rises (first or additional client) the next publish sends a snapshot of
  every source (already-connected clients receive it too).

```json
{
	"type": "source:status",
	"channel": "sources",
	"data": {
		"id": "rtl-pi",
		"type": "rtl_tcp",
		"url": "192.168.1.50:1234",
		"connected": true,
		"activity": {
			"state": "stale",
			"lastSampleAt": "2026-10-08T12:00:00.000Z",
			"sampleAgeMs": 12400,
			"timeoutMs": 10000
		},
		"bytesReceived": 847000000,
		"dataRate": 4800,
		"reconnectAttempts": 0,
		"caps": { "kind": "iq", "sampleRate": 2400000, "format": "U8_IQ", "exclusive": false },
		"assignments": [{ "decoderId": "dmr", "sourceId": "rtl-pi", "assignedAt": "2026-10-08T11:00:00.000Z" }],
		"consumers": 2,
		"available": true
	}
}
```

#### source:caps-changed

Emitted when source capabilities change dynamically (e.g., sample rate changed via TunerRelay).

```json
{
	"type": "source:caps-changed",
	"channel": "sources",
	"data": {
		"sourceId": "rtl-pi",
		"caps": {
			"kind": "iq",
			"sampleRate": 2400000,
			"format": "U8_IQ",
			"exclusive": false
		}
	}
}
```

#### metrics

Emitted every ~5 seconds.

```json
{
	"type": "metrics",
	"channel": "metrics",
	"data": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"sources": {
			"sdrpp-main": {
				"bytesReceived": 847000000,
				"dataRate": 192000
			}
		},
		"decoders": {
			"dsd-main": {
				"bytesIn": 423000000,
				"eventsOut": 847
			}
		}
	}
}
```

#### fanout:snapshot

Backpressure status snapshot.

```json
{
	"type": "fanout:snapshot",
	"channel": "fanout",
	"data": {
		"timestamp": "2026-01-09T14:23:45.123Z",
		"totalBytesWritten": 847000000,
		"droppedBytesTotal": 0,
		"backpressureActiveCount": 0,
		"branches": [
			{
				"id": "dsd-main",
				"bufferedBytes": 1024,
				"droppedBytesTotal": 0,
				"backpressure": false
			}
		]
	}
}
```

#### subscribed

Confirmation of subscription.

```json
{
	"type": "subscribed",
	"data": {
		"channels": ["decoders", "sources", "metrics", "health", "fanout"]
	}
}
```

#### error

```json
{
	"type": "error",
	"data": {
		"message": "Invalid channel: foo"
	}
}
```

## Audio Streaming

Decoded audio is available via TCP on port 8080.

### Format

- **Encoding**: S16LE (16-bit signed, little-endian)
- **Sample Rate**: 48000 Hz
- **Channels**: 1 (mono)

### Playback Examples

```bash
# Using sox
nc localhost 8080 | play -t raw -r 48000 -e signed -b 16 -c 1 -

# Using ffplay
nc localhost 8080 | ffplay -f s16le -ar 48000 -ac 1 -nodisp -

# Using VLC
nc localhost 8080 | vlc --demux=rawaud --rawaud-channels=1 --rawaud-samplerate=48000 -

# Record to file
nc localhost 8080 | sox -t raw -r 48000 -e signed -b 16 -c 1 - output.wav
```

## Error Responses

All error responses follow this format:

```json
{
	"error": {
		"code": "DECODER_NOT_FOUND",
		"message": "Decoder 'foo' not found",
		"statusCode": 404
	}
}
```

### Error Codes

| Code                      | HTTP Status | Description                    |
| ------------------------- | ----------- | ------------------------------ |
| `DECODER_NOT_FOUND`       | 404         | Decoder ID doesn't exist       |
| `SOURCE_NOT_FOUND`        | 404         | Source ID doesn't exist        |
| `DECODER_ALREADY_RUNNING` | 409         | Decoder is already running     |
| `DECODER_NOT_RUNNING`     | 409         | Decoder is not running         |
| `INVALID_CONFIG`          | 400         | Invalid configuration provided |
| `SOURCE_CONNECTION_ERROR` | 503         | Cannot connect to source       |
| `INTERNAL_ERROR`          | 500         | Internal server error          |

## Rate Limiting

The API does not currently implement rate limiting. For production deployments, consider placing a reverse proxy (nginx, Caddy) in front of WaveKit.

## CORS

CORS is enabled by default, allowing requests from any origin. Configure via:

```yaml
api:
  cors:
    enabled: true
    origins: ["*"]
```
