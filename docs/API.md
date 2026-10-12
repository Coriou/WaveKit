# WaveKit API Reference

WaveKit exposes a REST API and WebSocket endpoint for control and real-time monitoring.

## Base URL

- **REST API**: `http://localhost:9000`
- **WebSocket**: `ws://localhost:9000/ws`
- **Audio Stream**: `tcp://localhost:8080`
- **Live Audio Stream**: `http://localhost:8081/stream` (raw PCM) and `http://localhost:8081/stream.wav` (WAV-wrapped)

## Protected runtime (opt-in)

Legacy mode remains the default. Protected mode loads provisioned private access
state before creating listeners. It mounts one shared session and connection-lease
authority across the API, analog audio and digital audio boundaries. Missing,
malformed or busy private state fails startup; it never falls back to legacy mode.

A local HTTP configuration uses explicit loopback bindings and three distinct
ports. For example (merge these fields with your normal configuration):

```yaml
api: { host: "127.0.0.1", port: 9000 }
liveDemod: { httpPort: 8081 }
digitalVoice: { httpPort: 8082 }
access:
  mode: protected
  listenerScheme: http
  exposure: local-http
  allowedAuthorities: ["127.0.0.1:9000"]
  allowedOrigins: ["http://127.0.0.1:9000"]
  audio:
    analog:
      allowedAuthorities: ["127.0.0.1:8081"]
      bindHost: "127.0.0.1"
    digital:
      allowedAuthorities: ["127.0.0.1:8082"]
      bindHost: "127.0.0.1"
  publicOrigins:
    api: "http://127.0.0.1:9000"
    analogAudio: "http://127.0.0.1:8081"
    digitalAudio: "http://127.0.0.1:8082"
  healthProbe:
    target: "http://127.0.0.1:9000"
    host: "127.0.0.1:9000"
```

Supply the absolute private directory separately through
`WAVEKIT_ACCESS_PRIVATE_DIRECTORY`. It is not a public configuration field.
Provision it while the core is stopped with `pnpm access --help` (or
`node dist/access-command.js --help` for the complete command syntax). Setup
prints a public access plan; enabling runtime protection requires the explicit
configuration above. The normal build preserves `index.js`, `spectrum-worker.js`
and `access-command.js`.

Public/browser origins use one canonical hostname and scheme with canonical ports
(default port 80 or 443 is omitted).
Named audio authorities are independent of the API allowlist. Direct HTTP requires
matching loopback address families and configured ports; `localhost` requires
IPv4 backend bindings. LAN origins require `listenerScheme: https` and
`exposure: tls-termination`, with independently configured loopback HTTP backends.
The process does not implement TLS or infer proxy trust from forwarded headers.
See [protected deployment constraints](DOCKER-SETUP.md#protected-runtime-deployment)
for required proxy, private-volume and probe checks.

The root policy runs before routes, documentation and CORS plugins. Only the exact
credential-free `GET /health`, validated preflight and explicitly mounted exact
`GET`/`HEAD /api/access/bootstrap` are public; status, unknown
routes and documentation require admission. Machine clients use the canonical
Bearer credential. Browser pairing creates the shared host cookie, with allowed
Origin and CSRF proof required for unsafe cookie-authenticated requests. WS
adoption happens before subscriber registration. Passive WS/audio/download traffic
does not renew the rolling session deadline; refresh does so only after durable
persistence completes.

Protected analog PCM/WAV, digital voice and scanner recording/evidence/capture
streams admit before producers or streaming headers. Session expiry, revocation,
storage failure and transport closure release their leases and producer resources.
Async downloads recheck admission after lookup. Browser logout leaves machine
streams and RF jobs independent. Protected mode suppresses raw audio TCP and the
RTL-TCP relay; there is no raw-stream authentication exception. Independently,
enabled implicit relay configuration requires a configured shared source; an
explicit dedicated source remains supported in legacy mode.

Denials retain safe stable codes: 401 requests pairing or credential recovery,
403 requires correcting Origin/Host/CSRF context, 429 requires bounded retry using
`Retry-After` when present, and 503 indicates unavailable access/storage/service.
Malformed requests return 400. Protected root errors and request logs omit raw URLs,
credentials and validation payloads. Clients must reconcile uncertain mutation
outcomes rather than automatically replay RF operations.

Protected composition with configured canonical public mapping mounts explicit
`GET` and `HEAD /api/access/bootstrap`. The closed version-1 `AccessBootstrapDto`
contains `apiOrigin`, API-derived `webSocketUrl`, named `analogAudioOrigin` and
`digitalAudioOrigin`, `access` (protected mode, sessionAvailable, pairingAvailable),
and `capabilities` (analogAudioAvailable, digitalAudioAvailable,
operatorDataAvailable). These flags reflect current mounted/healthy services and
running audio independently; URLs describe configured destinations, not RF readiness
or reachability. Projection is an explicit allowlist with a 4096-byte JSON budget.
The internal `ApiServer.getAccessBootstrap()` remains its composition source.

This public read validates the original exact method/path, Host, Origin and raw
headers. Queries, normalized path variants, upgrades and ambiguous credentials are
rejected; an unambiguous invalid credential does not authenticate this read or
prevent discovery. It creates no principal, lease, cookie or renewal. Responses use
`Cache-Control: no-store` and the existing explicit-origin CORS boundary; preflight
remains separate. HEAD has the GET status/representation headers and no wire body.
Legacy mode leaves the route absent. Protected composition without public mapping
uses ordinary admission before an absent-route response; an installed unavailable,
stopping or faulty provider returns fixed `503 ACCESS_UNAVAILABLE`. A bootstrap
401 therefore cannot establish mounted pairing/session services or unlock controls.
`/health` contains no bootstrap metadata. Clients must trust the configured canonical
target before accepting these facts; real browser cookie/CORS/TLS/proxy recovery and
exposure acceptance remain separate gates.

`GET` and `HEAD /api/access/devices` require a current browser session. Machine
credentials are rejected with 403, including when accompanied by a session cookie;
missing/expired/revoked sessions return 401 and unavailable storage/clock authority
returns safe 503. The closed `AccessDevicesDto` is `{ devices: AccessDeviceDto[] }`:
each row contains only `deviceId`, `createdAt`, `renewedAt`, `expiresAt` (integer
milliseconds) and `current`. It lists unexpired remembered sessions, not online
presence, with exactly one current requester and at most the configured cap (maximum
32). Rows sort by creation time, then ASCII device ID. No names, credentials or private
session records are exposed.

The inventory reauthorizes the original request immediately before a synchronous,
one-clock committed-map snapshot and rechecks availability after the clock callback.
Pending create/refresh/revoke persistence remains invisible until commit. Reads do
not wait for the mutation queue, renew, prune, persist or migrate. Existing pairing,
refresh/logout/revoke permissions and bounded flow/drain ownership remain unchanged;
capacity denial returns 429. GET/HEAD use safe serializers, no-store and the existing
origin policy, with no HEAD wire body. Informational success grants no RF operation.

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

### Regional display registry

Read-only display metadata uses normal API admission in protected mode and is
also mounted by the standard legacy composition. It changes no scanner ranges,
decoder defaults or receiver controls. The initial production family is US FRS,
with `state: "unavailable"`, `reason: "evidence-pending"` and no numeric rows.
Current source bytes, effective-date evidence and the simplex frequency
representation remain unverified; this API confers no regulatory permission.

| GET endpoint             | Required query              | Optional query             |
| ------------------------ | --------------------------- | -------------------------- |
| `/api/regional/families` | `region`                    | none                       |
| `/api/regional/channels` | `region`, `family`          | `offset` (0), `limit` (64) |
| `/api/regional/resolve`  | `region`, `family`, `alias` | none                       |

Regions are `EU`, `US`, `CA`, `AU`, `NZ`, `JP`, `CN`. Explicit selection is
separate from national dataset applicability; no location or cross-region
fallback is inferred. US families returns one unavailable FRS manifest; US
channels/resolve returns unavailable. Other accepted regions return unsupported.
A syntactically valid unknown family returns 404 with a present provider.
An intentionally mounted null provider returns 503; an omitted dependency leaves
these routes unmounted. Empty verified data, unavailable data and infrastructure
failure are distinct states.

Query parsing rejects unknown/duplicate decoded keys, malformed escapes/UTF-8,
empty pairs and overflow; it decodes exactly once. Literal `+` means a space,
while `%2B` is a literal plus. Aliases are bounded printable ASCII, trimmed,
space-collapsed and ASCII-lowercased. Ambiguous aliases return all candidates.
Offset is 0–1024; limit is 1–128. Queries are bounded to 1024 ASCII bytes and four
pairs, and actual response bytes to 128 KiB. All local responses use `no-store`.

Exact-route HEAD/POST/PUT/PATCH/DELETE are denied with 405 and `Allow: GET`;
HEAD has no body. Accepted positive/noncanonical Content-Length or any
Transfer-Encoding is rejected with 400 before method denial, query parsing or
provider reads. Empty framing proceeds to method denial before required GET
query validation. Root admission, including unsafe-session CSRF/origin checks,
comes first. OPTIONS and unmatched paths retain existing root/CORS behavior.
Parser/router/transport failures outside the child route are not local errors.

Local errors have fixed `{error, code, message}` fields: 400
`REGIONAL_INVALID_REQUEST`, 404 `REGIONAL_FAMILY_NOT_FOUND`, 405
`REGIONAL_METHOD_NOT_ALLOWED`, or 503 `REGIONAL_UNAVAILABLE`. Root admission
keeps its existing code-only body and headers. Full contract and evidence gates:
[regional registry specification](specs/regional-display-registry/design.md).

### Station

#### GET /api/station

Read-only station identity from config (`station.*` in YAML, `WAVEKIT_STATION__*`
in the environment; `WAVEKIT_COUNTRY` sets `station.country`). Every field carries
`{ value, provenance }` with provenance `default`, `yaml` or `env`; unset values are
`null`. `country` is ISO 3166-1 alpha-2 (uppercase). `effectiveCountry` is the
configured country or `null`: it is never derived from the coordinates. `region` is
the existing coarse band region. `HEAD` returns the headers only. Mounted in protected
and legacy composition under the normal API admission. Not passed to decoders yet.

```json
{
	"name": { "value": "Home", "provenance": "yaml" },
	"lat": { "value": 48.85, "provenance": "yaml" },
	"lon": { "value": 2.35, "provenance": "yaml" },
	"altM": { "value": null, "provenance": "default" },
	"callsign": { "value": null, "provenance": "default" },
	"country": { "value": "FR", "provenance": "env" },
	"effectiveCountry": "FR",
	"region": "EU"
}
```

### Receiver capabilities

`GET /api/receiver-capabilities` lists a page; `GET
/api/receiver-capabilities/:sourceId` reads one source. Both use normal protected
admission and are mounted in the standard legacy composition. Absent, null or
disposed provider means admitted 503, never a successful empty fallback.
A valid provider with no sources returns an empty page.

The page query accepts only `after` and `limit` (default 8, range 1–16).
`after` is an exclusive UTF-8 lexical boundary, not a retained inventory cursor.
A removed cursor remains usable; membership may change between pages. Every
selected candidate, including lookahead, is validated before any row is returned;
an unrepresentable current source fails the whole list. No rows are silently
omitted. Successful items share one synchronous capture time/snapshot token.
Tokens distinguish observations within one SourceManager lifetime and are not
hardware identities or durable identities across restart.

Source IDs preserve exact case/Unicode and must be scalar strings with 1–256
UTF-8 bytes and at most 100 decoded UTF-16 code units, without controls or
`/`, `\`, `?`, `#`. Encode route IDs once; encoded slash/backslash is rejected.
Double-encoded percent text is not decoded twice. The root router's existing
100-unit parameter limit remains: longer paths do not match feature handlers,
whereas an invalid cursor receives a local 400 after admission. Receiver query
`+` is literal, unlike regional form-query decoding. Single-source requests
accept no nonempty query. Item/page/error byte limits are 16 KiB/256 KiB/256 bytes.

The DTO separates command implementation and admitted REST argument policy from
transport applicability, peer advertisement, effective stream declarations and
physical readback. All 15 controls have unknown physical support and unknown
current values. Numeric policy ranges are API acceptance rules, not RF bounds.
A current literal 12-byte RTL0 header reports only raw uint32 `tunerType` and
`gainCount`; it supplies no model, gain table, presets or bias-T support.
Gain is in tenths dB; gain index is dimensionless. Delivery waiting/streaming/
stale/paused is independent of header validity. SDR++ and recordings do not
become unsupported hardware merely because RTL peer metadata is inapplicable.
Reads add no commands, probes, files, connections, subscriptions or source consumers.

Matched HEAD/POST/PUT/PATCH/DELETE returns 405 with `Allow: GET` before feature
ID/query/framing validation; HEAD is bodyless. GET rejects accepted positive
Content-Length or any Transfer-Encoding before input validation and evidence
reads; absent framing or length zero is allowed. Root admission comes first.
OPTIONS, extra segments, overlong router parameters and pre-routing decode/HTTP
parser failures retain existing root behavior. No unframed arbitrary-stream or
late-abort rollback guarantee is offered. Local responses use `no-store`.

Fixed errors use `{error: "ReceiverCapabilitiesError", code, message}` and
`RECEIVER_CAPABILITIES_` suffixes: 400 `INVALID_REQUEST`, 404 `NOT_FOUND`, 405
`METHOD_NOT_ALLOWED`, 503 `UNAVAILABLE`, `FAILED`, `CONFLICT` or `LIMIT`.
Unexpected response encoding/serialization failure uses 500 `FAILED`.
Root denial envelopes and headers remain unchanged. Full contract:
[receiver capabilities specification](specs/receiver-capabilities/design.md).

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
	"sourceIqSampleRate": 2048000,
	"config": {
		"enabled": true,
		"sourceId": "rtl-pi",
		"httpPort": 8081,
		"modulation": "nfm",
		"bandwidth": 12500,
		"squelch": -40,
		"noiseReduction": "off",
		"lowPass": 0,
		"highPass": 0,
		"gain": 2,
		"deEmphasis": false,
		"deEmphasisTau": 50,
		"audioFormat": "s16le",
		"iqDcBlock": false,
		"offsetHz": 6000
	},
	"effectiveSampleRate": 24975.60975609756,
	"decimationFactor": 82,
	"httpUrl": "http://localhost:8081/stream",
	"wavUrl": "http://localhost:8081/stream.wav",
	"clientCount": 1,
	"bytesStreamed": 1234567,
	"pipelineHealth": "running",
	"pipelineRestarts": 0,
	"channelPowerDbfs": -61.3,
	"squelchOpen": false
}
```

Fields:

- `effectiveSampleRate` — demodulation and audio sample rate in Hz (source rate /
  `decimationFactor`; usually fractional).
- `wavUrl` — the audio stream behind a streaming WAV header.
- `pipelineHealth` — `running`, `starting`, `stopped` or `error`. A crashed CSDR
  pipeline restarts automatically with exponential backoff (1 s doubling to 30 s,
  10 consecutive attempts; a run of 30 s resets the count). `pipelineRestarts`
  counts automatic restarts since the last manual start; after the last attempt
  `lastError` says so and `POST /api/live-audio/start` restarts it.
- `channelPowerDbfs` — smoothed channel power before demodulation, relative to a
  full-scale IQ sample (present while the pipeline runs). This is the level the
  `squelch` threshold compares against.
- `squelchOpen` — squelch gate state while the pipeline runs (`true` with squelch
  off).
- `noiseFloorDbfs`, `thresholdDbfs` — the auto-squelch floor estimate and the
  threshold in effect (the manual `squelch`, or floor + `autoMarginDb` in auto mode).

Configuration notes:

- `squelchMode` — `manual` (default: `squelch` is the threshold) or `auto` (an
  estimate of the channel-power floor plus `autoMarginDb`, 0–40 dB, default 6). The
  floor is a constant-memory running lower envelope: falls are immediate; rises
  are limited to 1 dB/s while closed and 0.4 dB/s while open, measured in 10 ms
  stream-time blocks. With margin 6 dB, a sustained 20 dB noise step closes within
  60 s, while a signal 20 dB above a stable floor stays open for at least 20 s.
  Long continuous signals can eventually enter the floor estimate. Pipeline
  rebuilds, source capability changes (including retained-pipeline retunes), and
  mode changes reset the estimate. This is not calibrated noise measurement.
  There is no `noise` mode.
- `squelch` — dBFS threshold on `channelPowerDbfs`; `0` disables it. The gate opens
  at the threshold, stays open within 2 dB below it and closes 250 ms after the
  level drops further. While closed the stream carries silence at the nominal rate.
- `gain` — audio gain after demodulation (default 2, formerly 10; for FM, ±5 kHz
  deviation at 0.8 full scale at a 25 kHz demod rate). Modes without AGC follow the
  gain directly: `raw` is about 5× (14 dB) quieter than before unless `gain` is set
  explicitly. AM/SSB use an AGC whose reference dropped from 0.8 to 0.4, so with the
  default gain they peak around 0.8 instead of hard-clipping.
- `offsetHz` — channel offset from the tuned centre (default 0). A carrier at
  centre + `offsetHz` is shifted to DC before the channel filter, so the receiver's
  DC spike can be kept out of the channel by tuning a few kHz off the carrier.
  Values that put the channel outside the capture are rejected with 400.
- `iqDcBlock` — deprecated and ignored (it corrupted interleaved I/Q).
- Retuning the centre frequency does not restart the pipeline; a sample-rate or
  IQ-format change does, and disconnects stream clients so they reconnect with the
  new rate.

#### GET http://localhost:8081/stream and /stream.wav

The audio itself is served by the live demodulator's own HTTP server
(`config.httpPort`), not the API port. Mono, little-endian.

- `/stream` — raw PCM, `Content-Type: application/octet-stream`.
- `/stream.wav` — `Content-Type: audio/wav`: a 44-byte WAV header (PCM 16-bit for
  `s16le`, IEEE float 32-bit for `f32le`, sample rate rounded to an integer, RIFF
  and data sizes `0xFFFFFFFF`) followed by the same audio.

Both send:

| Header           | Example             | Meaning                              |
| ---------------- | ------------------- | ------------------------------------ |
| `X-Audio-Format` | `s16le`             | `s16le` or `f32le`                   |
| `X-Sample-Rate`  | `24975.60975609756` | exact rate in Hz (may be fractional) |
| `X-Channels`     | `1`                 | always mono                          |

When the rate or format changes (sample-rate change, `audioFormat` change) the
server ends existing streams; reconnect to get the new parameters. A client that
falls behind keeps at most about one second of queued audio (the oldest audio is
dropped); a client that accepts nothing for 30 s is disconnected.

```bash
# Self-describing: no format flags
ffplay -nodisp -autoexit http://localhost:8081/stream.wav

# Low latency: ffplay's default probing and buffering add several seconds
# (measured 2026-10-09: ~5 s with the defaults above, ~2 s end to end with these flags)
ffplay -nodisp -fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 \
  http://localhost:8081/stream.wav

# Raw: read X-Sample-Rate first, round it for ffplay
curl -sI http://localhost:8081/stream | grep -i x-sample-rate
ffplay -nodisp -autoexit -f s16le -ar 24976 -ch_layout mono http://localhost:8081/stream
```

#### POST /api/live-audio/start

Start live demodulation. If the stream server is already up but the pipeline has
died (for example after the automatic restarts gave up), this restarts the pipeline.

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

Update live demodulator configuration. DSP changes restart the pipeline; `squelch`,
`squelchMode` and `autoMarginDb` changes apply immediately without a restart; an `httpPort` change moves the stream
server (connected clients are disconnected). Invalid values (for example an
`offsetHz` outside the capture) return 400 and leave the running pipeline untouched.

```bash
curl -X PATCH http://localhost:9000/api/live-audio/config \
  -H "Content-Type: application/json" \
  -d '{
    "offsetHz": 6000,
    "squelch": -40
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
| `rateHistory`         | Messages per minute for the last 15 minutes, oldest first, including the current partial minute; empty minutes are 0. Kept across the instance's own process restarts.                                                                                                                                    |
| `sourceId`            | WaveKit source the decoder reads: the live assignment while wired, otherwise the configured `sourceId`. Absent for external-input decoders (they own their device) and for unwired decoders relying on the default source.                                                                                     |
| `deviceSerial`        | Configured device serial of an external-input decoder (`caps.input: "external"`). Never inferred; absent when not configured and always absent for stdin decoders (their serial options are ignored in stdin mode).                                                                                            |
| `targetFrequenciesHz` | Target frequencies declared in config: top-level `frequencies`, else `options.frequencies`, else `options.frequency`. Absent when the config declares none (the decoder then decodes whatever its source is tuned to, or a built-in default that is not reported).                                             |
| `lastError`           | `{ kind, message, at }` for the most recent failure. `kind: "error"` = emitted error or failed (re)start; `kind: "exit"` = process exited without being asked to stop. `message` ≤ 512 chars (truncated with `…`), `at` is ISO-8601. An `"error"` recorded during a run is kept rather than replaced by the generic exit that ends that run. Retained across automatic restarts; cleared only by an explicit start/restart, the same moment `restartCount` resets to 0. |
| `idleTimeoutMs`       | Milliseconds without output before `health` becomes `"idle"`: the configured `health.idleTimeout` (default 30000).                                                                                                                                                                                                                                       |
| `nextRestartAt`       | ISO-8601 time of the scheduled automatic restart. Present only while one is pending (`health` is `"restarting"`, or `"faulted"` during a crash loop that is still retrying).                                                                                                                                                                       |
| `owner`               | `"config"` or `"scanner"`: who created the instance. Scanner probes are `"scanner"`; their start/stop/restart and band routes answer 409 `DECODER_OWNED_BY_SCANNER`. Sent by current cores.                                                                                                                                                       |
| `scannerJobId`        | The scanner job that owns a probe; present only with `owner: "scanner"`.                                                                                                                                                                                                                                                                          |
| `ephemeral`           | `true` for runtime-only instances (scanner probes: not in config, never persisted, announced by `decoder:created` / `decoder:removed`). Hide or group them in decoder lists.                                                                                                                                                                       |

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
| `suspended`      | Wanted but held back because the source rate makes this instance `unusable` or the tuned band covers none of its targets, or a scanner sweep holds its source. The decoder keeps its source reservation and `sourceId` and is never moved to another source. |
| `suspension`     | `{ reasonCode, since }` (ISO-8601), present only while suspended. `reasonCode` is a rate reason, `"frequency-out-of-band"`, or `"tuner-scanning"` (a scanner sweep holds the source for its whole duration; a manual start answers 409 `SOURCE_HELD_BY_SCANNER`; the decoder resumes when the sweep ends). |
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

#### GET /api/decoders/:id/log

`?lines=N` (1–500, default 200) returns the newest captured lines of the decoder
process's stdout and stderr: `{ decoderId, lines: [{ stream: "stdout" | "stderr",
line }] }`, oldest first. Each decoder keeps at most 500 lines of 4096 characters.
These are raw decoder output and can contain decoded data; network frames from
producers such as readsb are not turned into log lines. 404 for an unknown id.

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

### Digital Voice

Decoded dsd-fme voice (DMR verified; P25, YSF, D-STAR, NXDN and ProVoice
unverified) as a continuous audio stream. See
[DIGITAL-VOICE.md](DIGITAL-VOICE.md) for the format, endpoints and limits.

Audio is served on `digitalVoice.httpPort` (default 8082), not on the API port:

- `GET /stream`, `GET /stream.wav`: the first dsd-fme decoder.
- `GET /decoders/<decoderId>/stream`, `GET /decoders/<decoderId>/stream.wav`:
  one decoder (URL-encode the id).

Mono s16le at 8000 Hz for the stream's life (`X-Audio-Format: s16le`,
`X-Sample-Rate: 8000`, `X-Channels: 1`). Exact silence between calls and during
encrypted calls; clients are never disconnected between calls. A slow client
keeps about one second of audio (older audio is dropped); a client that accepts
nothing for 30 s is disconnected.

```bash
ffplay -nodisp -fflags nobuffer -flags low_delay http://localhost:8082/stream.wav
```

#### GET /api/digital-voice/status

```bash
curl http://localhost:9000/api/digital-voice/status
```

**Response** (`DigitalVoiceStatus` in `@wavekit/api-types`):

```json
{
	"enabled": true,
	"running": true,
	"config": {
		"enabled": true,
		"httpPort": 8082,
		"voiceSlot": "both",
		"jitterBufferMs": 400,
		"maxBufferMs": 1000
	},
	"sampleRate": 8000,
	"audioFormat": "s16le",
	"channels": 1,
	"httpUrl": "http://localhost:8082/decoders/dsd-fme/stream",
	"wavUrl": "http://localhost:8082/decoders/dsd-fme/stream.wav",
	"clientCount": 1,
	"bytesStreamed": 160000,
	"decoders": [
		{
			"decoderId": "dsd-fme",
			"mode": "auto",
			"udpPort": 41234,
			"httpUrl": "http://localhost:8082/decoders/dsd-fme/stream",
			"wavUrl": "http://localhost:8082/decoders/dsd-fme/stream.wav",
			"clientCount": 1,
			"bytesStreamed": 160000,
			"datagramsReceived": 412,
			"datagramsRejected": 0,
			"encryptedDatagramsDropped": 0,
			"droppedSamples": 0,
			"underruns": 3,
			"bufferedMs": 60,
			"lastDatagramAt": "2026-10-09T13:38:45.120Z",
			"call": {
				"decoderId": "dsd-fme",
				"callId": "dsd-fme-mg1x2abc-2",
				"protocol": "dmr",
				"talkgroup": 9,
				"source": 2060945,
				"slot": 1,
				"encrypted": false,
				"active": true,
				"startedAt": "2026-10-09T13:38:38.413Z"
			}
		}
	],
	"call": {
		"decoderId": "dsd-fme",
		"callId": "dsd-fme-mg1x2abc-2",
		"protocol": "dmr",
		"talkgroup": 9,
		"source": 2060945,
		"slot": 1,
		"encrypted": false,
		"active": true,
		"startedAt": "2026-10-09T13:38:38.413Z"
	}
}
```

`call` is the first active call on any decoder (else `null`); each decoder also
reports `lastCall` once a call has ended. Counters are cumulative since startup.

#### POST /api/digital-voice/start

Starts the stream server. `409` (`DIGITAL_VOICE_UNAVAILABLE`) when no dsd-fme
decoder streams voice: digital voice was disabled at startup, or every dsd-fme
decoder sets its own `output`.

#### POST /api/digital-voice/stop

Stops the stream server and disconnects its clients. dsd-fme keeps decoding
call metadata.

### Scanner

Signal discovery scanner (operator guide: [SCANNER.md](SCANNER.md)). DTOs are in
`packages/api-types/src/scanner.ts`. Errors use the flat body of every other
route, `{ error, code, message, details? }`; the codes are listed under
[Error Responses](#scanner-and-spectrum-codes). A route answers 404
`SCANNER_NOT_FOUND` when the job, discovery, recording, evidence or capture in
its path does not exist; the service answers 404 `SCANNER_JOB_NOT_FOUND` or
`SCANNER_DISCOVERY_NOT_FOUND` for actions on a missing job or discovery.

#### GET /api/scanner

```bash
curl http://localhost:9000/api/scanner
```

**Response** (`ScannerStatus`):

```json
{
	"enabled": true,
	"channelizerAvailable": false,
	"engines": [
		{
			"sourceId": "rtl",
			"state": "running",
			"rbwHz": 1000,
			"fftSize": 2048,
			"kByRange": [
				{ "startHz": 445200000, "endHz": 446800000, "k": 9.2, "faPerMhzMin": 0.8 }
			],
			"floorDbfs": -92.5,
			"floorOccupied": false,
			"overload": false,
			"settleMode": "marker",
			"settleMs": 41,
			"settleMeasured": true,
			"markerSupported": true,
			"stuckTestMode": false,
			"staleAfterSettle": 0,
			"blankedFrames": 3,
			"broadbandRfi": null,
			"passive": { "enabled": true },
			"frequencyError": { "hz": -310, "ppm": -0.7, "discoveries": 6 }
		}
	],
	"budgets": {
		"cpuBudgetCores": 1,
		"cpuCoresInUse": 0.75,
		"maxProbes": { "offset": 1, "channel": 4 },
		"probesInUse": { "offset": 1, "channel": 0 }
	},
	"cpuGuard": { "percent": 41.5, "limitPercent": 90, "source": "os" },
	"disk": "ok",
	"jobs": { "active": 2, "total": 5 }
}
```

`blankedFrames` counts frames blanked as broadband impulses;
`broadbandRfi` is `{ periodMs }` while periodic broadband RFI is active.
`passive.disabledReason` explains a passive job switched off by the cost rule.

#### GET /api/scanner/settings

```bash
curl http://localhost:9000/api/scanner/settings
```

**Response** (`ScannerSettingsView`, abridged):

```json
{
	"effective": {
		"enabled": true,
		"cpuBudgetCores": 0.5,
		"maxProbes": { "offset": 1, "channel": 4 },
		"detection": { "integrationMs": 50, "sensitivity": "normal" },
		"ws": {
			"maxMessagesPerSecond": 10,
			"spectrumHz": 10,
			"spectrumBins": 512,
			"spectrumSummaryBins": 2048,
			"spectrumMaxProfiles": 4
		}
	},
	"passiveBySource": { "rtl": true, "rtl-dedicated": false },
	"provenance": {
		"cpuBudgetCores": "runtime",
		"detection.integrationMs": "default",
		"storage.dir": "config",
		"passiveBySource.rtl": "default",
		"passiveBySource.rtl-dedicated": "runtime"
	},
	"bounds": {
		"cpuBudgetCores": { "type": "number", "min": 0.1, "max": 64 },
		"detection.sensitivity": { "type": "string", "enum": ["low", "normal", "high"] },
		"passive.<sourceId>": { "type": "boolean" }
	}
}
```

`provenance` is keyed by the dotted leaf path; its values are `config` (set in
the config file or env), `runtime` (a PATCH, persisted in `settings.json`) and
`default`. Per-source passive is keyed `passiveBySource.<sourceId>` in
`provenance`, but `passive.<sourceId>` in `bounds` and in the PATCH body.

#### PATCH /api/scanner/settings

Runtime-safe keys only: `passive` per source, `cpuBudgetCores`, `maxProbes`,
`detection.integrationMs` / `sensitivity` / `faTargetPerMhzMin` /
`hysteresisDb` / `minSurfaceBlocks`, the `storage` caps (not `dir`) and
`ws.maxMessagesPerSecond` / `spectrumHz` / `spectrumBins`. The config-only
`ws.spectrumSummaryBins` and `ws.spectrumMaxProfiles` are rejected. The body
is merged into the persisted overrides; the response is the new settings view.

```bash
curl -X PATCH http://localhost:9000/api/scanner/settings \
  -H 'Content-Type: application/json' \
  -d '{"passive": {"rtl-dedicated": false}, "cpuBudgetCores": 0.5}'
```

**400** for an unknown key or a value out of bounds:

```json
{
	"error": "ValidationError",
	"code": "VALIDATION_ERROR",
	"message": "Configuration validation failed:\n  - cpuBudgetCores: Value is too small (minimum: 0.1)"
}
```

`500 SCANNER_SETTINGS_WRITE_FAILED`: `settings.json` could not be written;
nothing changed. `503 SCANNER_STATE_UNAVAILABLE`: the scanner could not read
its persisted jobs and settings at boot, so it refuses settings changes (and
sweeps) for this run rather than overwrite them.

#### GET /api/scanner/bandplans

Built-in bandplans for the effective region (see [SCANNER.md](SCANNER.md#presets-and-bandplans)).

```bash
curl http://localhost:9000/api/scanner/bandplans
```

```json
[
	{
		"id": "pmr446",
		"region": "EU",
		"name": "PMR446",
		"ranges": [
			{
				"startHz": 446000000,
				"endHz": 446200000,
				"rasters": [{ "spacingHz": 12500, "firstChannelHz": 446006250 }],
				"obwHz": [9000, 11000],
				"protocols": ["analog-fm", "dmr", "dpmr"],
				"bandplanId": "pmr446"
			}
		]
	}
]
```

#### POST /api/scanner/plan

Pure preview of a job spec (no side effects): the normalised spec with
`provenance` per field (`operator`, `bandplan`, `measured`, `config`,
`default`), the hop plan, `sweepPeriodMs`, probability of intercept per hop,
CPU/disk estimates, the impact and `issues` (`severity` `error` or
`warning`). Same body as `POST /api/scanner/jobs`.

```bash
curl -X POST http://localhost:9000/api/scanner/plan \
  -H 'Content-Type: application/json' \
  -d '{"mode": "sweep", "bandplans": ["uhf-land-mobile"]}'
```

```json
{
	"spec": { "sourceId": "rtl", "mode": "sweep", "fftSize": 2048, "dwellMs": 185, "provenance": { "ranges": "bandplan", "fftSize": "default" } },
	"plan": { "hops": [{ "index": 0, "centreHz": 400819200, "covered": { "startHz": 400000000, "endHz": 401638400 }, "channelCount": 131, "dcAdjacentChannelsHz": [], "excluded": [], "dcMinEdgeHz": 1500 }], "usableHalfSpanHz": 819200, "dcGuardHz": 1500, "ppmMarginHz": 940 },
	"sweepPeriodMs": 8140,
	"poi": [{ "hopIndex": 0, "detection": 0.61, "decode": 0.17 }],
	"estimates": { "cpuCores": 0.75, "diskMbPerHour": 57.6, "probes": 1 },
	"impact": { "liveAudioClients": 0, "digitalVoiceListeners": 0, "runningDecoders": ["dsd-fme"], "pinnedDecoders": [], "scannerJobs": [], "unrestorable": [] },
	"issues": [
		{
			"code": "poi-low",
			"severity": "warning",
			"message": "detection POI below 50 % for a 5000 ms transmission",
			"details": { "hops": [3, 4, 17], "txDurationHintMs": 5000 }
		}
	]
}
```

#### POST /api/scanner/jobs

Creates a job (`ScanJobSpec`, every field optional; defaults in
[SCANNER.md](SCANNER.md#jobs)). Two shorthands are converted before planning:

- a range `{startHz, endHz, spacingHz, firstChannelHz?}` becomes one raster
  `{spacingHz, firstChannelHz}`, with `firstChannelHz` defaulting to
  `startHz + spacingHz / 2`;
- an exclusion `{frequencyHz, widthHz}` becomes
  `{startHz: frequencyHz − widthHz / 2, endHz: frequencyHz + widthHz / 2}`.

```bash
curl -X POST http://localhost:9000/api/scanner/jobs \
  -H 'Content-Type: application/json' \
  -d '{"ranges": [{"startHz": 446000000, "endHz": 446200000, "spacingHz": 12500}], "exclusions": [{"frequencyHz": 446006250, "widthHz": 12500}], "protocols": ["dmr"]}'
```

**201**: the `ScanJob` (see the job detail below).

**400** `SCANNER_PLAN_INVALID` when the preview has errors:

```json
{
	"error": "ScannerApiError",
	"code": "SCANNER_PLAN_INVALID",
	"message": "The job spec has errors",
	"details": {
		"issues": [
			{ "code": "range-empty", "severity": "error", "message": "a sweep needs at least one range or bandplan" }
		]
	}
}
```

**409** `SCANNER_TAKEOVER_REQUIRED`: the sweep would disturb other consumers.
Resend with `"takeover": true` to consent.

```json
{
	"error": "ScannerApiError",
	"code": "SCANNER_TAKEOVER_REQUIRED",
	"message": "This sweep disturbs other consumers; resend with takeover",
	"details": {
		"impact": {
			"liveAudioClients": 1,
			"digitalVoiceListeners": 0,
			"runningDecoders": ["dsd-fme"],
			"pinnedDecoders": [],
			"scannerJobs": [],
			"unrestorable": []
		}
	}
}
```

Other answers: 409 `SCANNER_SOURCE_BUSY` (a relay client controls the tuner,
another job holds the lease, or the lease is "releasing" or in "recovery
pending"; the detail is in `message`; every one carries `details.reason`, see
the error table, plus `details.holderJobId` when a job holds the source, or
`details.issues` from the preview), 409
`SCANNER_NO_TUNER_CONTROL` (the source has no rtl_tcp tuner control), 400
`SCANNER_MONITOR_UNAVAILABLE` (`kind: "monitor"`, listen-scan needs the
channelizer), 400 `SCANNER_IDENTIFY_VIA_JOBS` (`kind: "identify"`; use
`/identify`), 503 `SCANNER_DISABLED`, 503 `SCANNER_STATE_UNAVAILABLE` (sweeps
only).

#### GET /api/scanner/jobs and GET /api/scanner/jobs/:id

```bash
curl http://localhost:9000/api/scanner/jobs/j_01JA2T6Q4M3XZ8R6V5W2NKD7QH
```

**Response** (`ScanJob`, abridged; the list returns an array of these):

```json
{
	"id": "j_01JA2T6Q4M3XZ8R6V5W2NKD7QH",
	"name": null,
	"state": "holding",
	"passive": false,
	"spec": { "sourceId": "rtl", "mode": "sweep", "kind": "discover", "priority": 50 },
	"plan": { "hops": [], "usableHalfSpanHz": 819200, "dcGuardHz": 1500, "ppmMarginHz": 940 },
	"issues": [],
	"impact": { "liveAudioClients": 0, "digitalVoiceListeners": 0, "runningDecoders": [], "pinnedDecoders": [], "scannerJobs": [], "unrestorable": [] },
	"unrestorable": [],
	"progress": {
		"sweepIndex": 3,
		"hopIndex": 17,
		"hopCount": 44,
		"sweepPeriodMs": 8420,
		"coverage": 0.94,
		"holdingOn": "t-41",
		"settleMode": "marker",
		"probes": [
			{
				"probeId": "scan-t6q4m3x-dmr-1",
				"decoderId": "scan-t6q4m3x-dmr-1",
				"trackId": "t-41",
				"targetHz": 446056250,
				"protocol": "dmr",
				"transport": "offset",
				"state": "confirming",
				"startedAt": "2026-10-10T14:02:11.120Z"
			}
		],
		"counts": {
			"observations": 120,
			"transients": 4,
			"discoveries": { "activity": 5, "candidate": 3, "classified": 0, "decoded": 2 }
		}
	},
	"createdAt": "2026-10-10T13:55:00.000Z",
	"updatedAt": "2026-10-10T14:02:11.120Z",
	"startedAt": "2026-10-10T13:55:00.400Z"
}
```

`reason` is set while `paused` (`operator`, `preempted-operator`,
`preempted-relay`, `preempted-job`, `source-down`, `core-restart`,
`resume-blocked`) or `failed` (`source-removed`, `tuner-unavailable`,
`invalid`). Passive jobs have ids `passive-<sourceId>`. Identify jobs also
carry `identify` (see `POST /api/scanner/identify`).

Startup is bounded to 15 seconds; identify uses the smaller of that cap and
`timeoutMs`. A source disconnect during startup fails the job with
`tuner-unavailable` and releases its resources. Deadlines are evaluated on the
service tick. A terminal REST state does not prove teardown has finished:
new admission may still return 409 with `details.reason: "releasing"` while
restore, decoder and probe cleanup completes. Terminal job WS publication
follows teardown.

`unrestorable` lists the tuner fields the job's end did not write back: fields
whose previous value was unknown, and fields whose restore could not be written
(for example while the source is disconnected). Those restores are re-queued
and run on the source's first data after it reconnects, even if the job is
deleted in between.

#### PATCH /api/scanner/jobs/:id

Live edit, applied at the next hop. Allowed keys: `thresholdDb`,
`sensitivity`, `exclusions`, `hold`, `revisit`, `record`, `protocols`,
`capture`; other keys are ignored. The keys are merged into the spec the job
was created with (only `sourceId` and `mode` are pinned), so derived fields
follow the edit and keep their provenance: `{"sensitivity": "high"}` gives
100 ms integration unless the job set `integrationMs` itself. While the job
holds the lease, the engine takes the new tuning at once. The edit is
previewed first; a preview with errors is rejected (400
`SCANNER_PLAN_INVALID`). Returns `{ job, plan, issues }`. 409 `SCANNER_JOB_TERMINAL` for an ended job, 409
`SCANNER_IDENTIFY_NOT_EDITABLE` for an identify job.

```bash
curl -X PATCH http://localhost:9000/api/scanner/jobs/j_01JA2T6Q4M3XZ8R6V5W2NKD7QH \
  -H 'Content-Type: application/json' -d '{"sensitivity": "high"}'
```

#### POST /api/scanner/jobs/:id/pause, /resume, /cancel

Each returns the `ScanJob`. `resume` takes an optional body
`{"takeover": true}`:

- from `paused(operator)` with the lease (no operator or relay write since
  the pause): resumes at the same hop;
- from `paused(operator)` after an operator or relay write took the lease:
  re-acquires it. 409 `SCANNER_TAKEOVER_REQUIRED` with `details.impact` when
  the impact grew beyond what was consented and `takeover` is not set (the
  job stays `paused(operator)`; taking the lease from a lower-priority job
  counts as a grown impact); 409 `SCANNER_SOURCE_BUSY` moves it to
  `paused(resume-blocked)` when a job of equal or higher priority holds the
  lease (a transient
  refusal, `details.reason` `releasing`, `recovery-pending` or
  `holder-starting`, leaves it `paused(operator)`);
- from `paused(core-restart)`: re-acquires the lease, re-opens the engine and
  restarts the sweep from its first hop (boot resumes with `resume.onBoot` do
  the same once the source's data starts);
- from `paused(resume-blocked)`: needs `takeover: true` (the impact grew
  beyond what was consented);
- from `paused(preempted-*)`: arbitrates at once; `takeover` is not required
  (sending it records the current impact as consented for later
  auto-resumes); 409
  `SCANNER_SOURCE_BUSY` while another job holds the lease
  (`details.holderJobId`) or a better-placed job waits for it
  (`details.waiter`).

`pause` on `paused(preempted-*)` is **Stay here**: the job becomes
`paused(operator)` without taking the lease back and no longer auto-resumes.

A `ScanJob` carries `resumeAt` (ISO time of the automatic resume, `null` when none is
scheduled or while held) and `resumeHeldBy` (`audio`, `identify`, `recording` or
`null`). The idle clock is held while an identify trial runs on the job's source and
while someone listens to live audio on that source through a gating squelch (manual
threshold below 0, or auto), plus 3 s after the squelch closes; it then restarts
from the full `resume.autoAfterIdleMs`. Recording activity does not hold it yet.

409 `SCANNER_INVALID_TRANSITION` when the action does not apply to the
current state, 409 `SCANNER_IDENTIFY_NOT_PAUSABLE` for pause/resume on an
identify job.

```bash
curl -X POST http://localhost:9000/api/scanner/jobs/j_01JA2T6Q4M3XZ8R6V5W2NKD7QH/resume \
  -H 'Content-Type: application/json' -d '{"takeover": true}'
```

#### DELETE /api/scanner/jobs/:id

Removes an ended job (`completed`, `cancelled`, `failed`); its discoveries
stay. **204**; 409 `SCANNER_JOB_NOT_TERMINAL` while the job runs or is paused.

#### GET /api/scanner/discoveries

Query parameters: `jobId`, `sourceId`, `protocol`, `minConfidence`
(`activity` | `candidate` | `classified` | `decoded`), `freqMinHz`,
`freqMaxHz`, `since` (ISO 8601), `encrypted` (boolean), `q` (label search,
≤ 100 chars), `sort` (`lastSeen` | `frequency` | `confidence`), `cursor`,
`limit` (1–500).

```bash
curl 'http://localhost:9000/api/scanner/discoveries?protocol=dmr&minConfidence=decoded&limit=50'
```

```json
{
	"items": [
		{
			"id": "d_01JA2T7B9S0KQ4M3XZ8R6V5W2N",
			"frequencyHz": 446056250,
			"frequencyKey": "r:446056250",
			"measuredOffsetHz": -280,
			"bandwidthHz": 9800,
			"protocol": "dmr",
			"family": "digital-voice",
			"class": "tdma-ms",
			"confidence": "decoded",
			"identity": { "kind": "dmr-cc", "value": "1" },
			"encrypted": false,
			"coChannel": [],
			"firstSeenAt": "2026-10-10T13:56:02.000Z",
			"lastSeenAt": "2026-10-10T14:02:15.000Z",
			"observationCount": 7,
			"airtimeMs": 41200,
			"signal": {
				"best": { "peakDbfs": -38.5, "meanDbfs": -41.0, "snrDb": 51.5, "floorDbfs": -92.5 },
				"last": { "peakDbfs": -40.0, "meanDbfs": -42.5, "snrDb": 50.0, "floorDbfs": -92.5 }
			},
			"metadata": { "talkgroups": ["9"], "sources": ["2060945"], "slots": [1], "callsigns": [], "capcodes": [], "ismModels": [] },
			"sourceIds": ["rtl"],
			"jobIds": ["j_01JA2T6Q4M3XZ8R6V5W2NKD7QH"],
			"tuningTrust": "commanded",
			"evidence": { "recordings": 3, "psd": true, "iq": false }
		}
	],
	"nextCursor": "eyJ0IjoxNzI4NTY4OTM1MDAwfQ"
}
```

Pass `nextCursor` as `cursor` for the next page; `null` ends the list.

#### GET /api/scanner/discoveries/:id

The `Discovery` (metadata, co-channel links, operator fields). 404
`SCANNER_NOT_FOUND`.

#### GET /api/scanner/discoveries/:id/observations

`{ items: Observation[], nextCursor }`; `cursor` and `limit` (1–500, default
100). Each observation has the sample range, centre, OBW, levels, duty,
hypotheses, the decode evidence and flags. 404 `SCANNER_DISCOVERY_NOT_FOUND`.

#### PATCH /api/scanner/discoveries/:id

Operator fields: `label` (≤ 100 chars), `notes` (≤ 2000), `lockout`
(boolean; stops its probes and blocks listen), `keep` (boolean; never pruned
by age). At least one key. Returns the `Discovery`.

```bash
curl -X PATCH http://localhost:9000/api/scanner/discoveries/d_01JA2T7B9S0KQ4M3XZ8R6V5W2N \
  -H 'Content-Type: application/json' -d '{"label": "Site A repeater", "keep": true}'
```

#### DELETE /api/scanner/discoveries/:id

Deletes the discovery with its evidence and recordings (`scanner:discovery`
`change: "deleted"`). **204**; 404 `SCANNER_NOT_FOUND`.

Success waits for accepted evidence writes and recording moves to drain and
for the discovery's evidence/recording folders to be removed. Live and recent
producer references are invalidated; later completions cannot recreate
downloadable evidence for the deleted ID. Downloads require an existing
discovery even if orphan files remain. Filesystem deletion failures reject the
request. This does not promise transactional power-loss durability or change
the separate capture-retention policy.

#### GET /api/scanner/recordings/:recordingId

Downloads a recording as `audio/wav` (ids come from observations'
`recordingIds`). 404 `SCANNER_NOT_FOUND`.

```bash
curl -o call.wav http://localhost:9000/api/scanner/recordings/<recordingId>
```

#### GET /api/scanner/discoveries/:id/evidence/psd and /evidence/iq

`psd`: the best power spectrum snapshot (`application/json`). `iq`: the latest
IQ snippet (`application/octet-stream`, cu8, ≤ 1 s at 48 kHz). 404
`SCANNER_NOT_FOUND` when none is stored.

#### POST /api/scanner/discoveries/:id/listen

Before the channelizer, points live audio at the discovery when it is in the
current window: sets `offsetHz` (restarting the live pipeline) and starts live
audio if it was idle.

```json
{
	"mode": "live-audio",
	"sourceId": "rtl",
	"frequencyHz": 446056250,
	"offsetHz": 55970,
	"httpUrl": "http://localhost:8081/stream",
	"wavUrl": "http://localhost:8081/stream.wav"
}
```

409 `OUT_OF_WINDOW` with `details` saying why:

- live audio runs on another source: `{ liveSourceId, sourceId }`;
- the source centre is unknown: `{ sourceId }`;
- the discovery is outside the current window: `{ offsetHz, usableHalfSpanHz }`;
- live audio refused the offset (`CHANNEL_OFFSET_OUT_OF_RANGE`; the previous
  offset is put back): `{ offsetHz }`.

Also 409 `LIVE_AUDIO_UNAVAILABLE` (live audio not configured), 409
`SCANNER_DISCOVERY_LOCKED_OUT`, 404 `SCANNER_DISCOVERY_NOT_FOUND`.

#### POST /api/scanner/identify

Identify a signal in the current window: every plausible decoder tries it,
without retuning. Body: `sourceId?`, `target` (exactly one of
`{frequencyHz, bandwidthHz?}` or `{all: true}`), `timeoutMs` (1000–120000,
default 15000; bounds only the wait for a signal), `protocols?`,
`exhaustive?` (default false: stop at the first accepted decode), `record?`
(default true). `bandwidthHz` (≤ 1 MHz) sets the match tolerance
`max(1 kHz, bw/2)`; send the waterfall's click width.

The signal-wait budget starts after usable IQ is admitted for the current
stream. Initial IQ admission has a separate `min(timeoutMs, 15000)` ms budget
from job creation. With no usable IQ, the job fails with `tuner-unavailable`;
a single target reports `unidentified`, empty trials and null nullable RF
statistics, while `all` reports no measured targets. A transmission found
within the signal-wait budget may finish its bounded decoder trials afterward;
`timeoutMs` is not an overall job-duration limit. An epoch change preserves an
established single-target deadline; collected `all` targets may receive a
bounded re-resolution wait. Disconnect during active identify ends it with
the results collected so far.

```bash
curl -X POST http://localhost:9000/api/scanner/identify \
  -H 'Content-Type: application/json' \
  -d '{"target": {"frequencyHz": 446056250, "bandwidthHz": 12500}}'

curl -X POST http://localhost:9000/api/scanner/identify \
  -H 'Content-Type: application/json' -d '{"target": {"all": true}, "timeoutMs": 30000}'
```

**201**: a `ScanJob` with `spec.kind: "identify"` and `identify`:

```json
{
	"id": "j_01JA2TB0Q7ZPM1V8C4X2N6R3TY",
	"name": "Identify 446.05625 MHz",
	"state": "running",
	"spec": { "kind": "identify", "mode": "in-window", "sourceId": "rtl", "priority": 100 },
	"identify": {
		"target": { "frequencyHz": 446056250, "bandwidthHz": 12500 },
		"timeoutMs": 15000,
		"protocols": [],
		"exhaustive": false,
		"record": true,
		"targets": [
			{
				"jobId": "j_01JA2TB0Q7ZPM1V8C4X2N6R3TY",
				"targetHz": 446056250,
				"state": "trying",
				"trials": [
					{ "protocol": "dmr", "decoder": "dsd-fme", "mode": "auto", "transport": "offset", "outcome": "running" },
					{ "protocol": "pocsag", "decoder": "multimon-ng", "mode": "multimon-ng", "transport": "offset", "outcome": "pending" },
					{ "protocol": "ism", "decoder": "rtl433", "mode": null, "transport": null, "outcome": "unsupported", "reason": "needs-channelizer" }
				]
			}
		]
	}
}
```

400 (schema validation) when both or neither of `frequencyHz` / `all` are
given, or a bound is broken:

```json
{
	"error": "ValidationError",
	"code": "VALIDATION_ERROR",
	"message": "body/target must match exactly one schema in oneOf",
	"details": [{ "instancePath": "/target", "keyword": "oneOf" }]
}
```

409 `OUT_OF_WINDOW` with `details.window`:

```json
{
	"error": "ScannerApiError",
	"code": "OUT_OF_WINDOW",
	"message": "The target is outside the tuned window; tune first",
	"details": { "window": { "startHz": 445180800, "endHz": 446819200 } }
}
```

409 `SCANNER_SOURCE_BUSY` while a sweep holds the source's tuner
(`details.reason: "held"`, `details.holderJobId`); 503 `SCANNER_DISABLED`. The job is listed,
cancellable and deletable once ended, but `pause`/`resume` answer 409
`SCANNER_IDENTIFY_NOT_PAUSABLE` and `PATCH` 409
`SCANNER_IDENTIFY_NOT_EDITABLE`. Identify jobs are not kept across a core
restart; the last 50 ended ones stay listed.

Each target ends `identified` (this job's own trials decoded an identity),
`candidate` (a classification, a spectral score ≥ 0.5, or an identity decoded
earlier) or `unidentified`, with `result`: `protocol?`, `confidence`,
`identity?`, `metadata`, `discoveryId?`, `observationId?`, `measurements`
(`source: "track" | "spectrum"`, `centreHz`, `obwHz`, `peakDbfs`, `snrDb`,
`floorDbfs`, `dutyCycle`, `acf30?`, `acf60?`, `class`), `artefact?` (`dc`,
`spur`, `image` at once with no trial; `rfi` only after the wait found no
signal) and `ended?: "window-moved"` (the window moved off the target; open
trials are `cancelled`).

#### GET /api/scanner/captures

Burst IQ captures (job option `capture`, [SCANNER.md](SCANNER.md#burst-iq-capture-fixtures)), newest first:

```json
[
	{
		"id": "cap_01ja2tc4j8k2m5n7p9q1r3s6tv",
		"createdAt": "2026-10-10T14:05:00.000Z",
		"jobId": "j_01JA2T6Q4M3XZ8R6V5W2NKD7QH",
		"sourceId": "rtl",
		"observationId": "o_01JA2TC3HZ5D7QW1N8R4T6Y0BK",
		"discoveryId": "d_01JA2T7B9S0KQ4M3XZ8R6V5W2N",
		"mode": "wideband",
		"role": "channelizer-golden",
		"protocol": "dmr",
		"identity": { "kind": "dmr-cc", "value": "1" },
		"decoded": true,
		"encrypted": false,
		"tuningTrust": "commanded",
		"sampleRateHz": 2048000,
		"centreHz": 446000000,
		"targetHz": 446056250,
		"stream": 1,
		"epoch": 12,
		"startSample": 81920000,
		"endSample": 92160000,
		"preRollClippedMs": 0,
		"postTruncated": false,
		"durationS": 5,
		"bytes": 20480000,
		"files": { "iq": "cap_01ja2tc4j8k2m5n7p9q1r3s6tv.cu8", "manifest": "cap_01ja2tc4j8k2m5n7p9q1r3s6tv.json" }
	}
]
```

#### GET /api/scanner/captures/:file

`<id>.cu8` (`application/octet-stream`) or `<id>.json`, the fixtures manifest
v2 entry (`application/json`). 404 `SCANNER_NOT_FOUND` for any other name.

```bash
curl -O http://localhost:9000/api/scanner/captures/cap_01ja2tc4j8k2m5n7p9q1r3s6tv.cu8
```

#### DELETE /api/scanner/captures/:id

**204**; 404 `SCANNER_NOT_FOUND`.

### Spectrum

Core spectrum service (waterfalls for the CLI, the web UI and the scanner).
DTOs in `packages/api-types/src/spectrum.ts`. Served whenever the core runs,
also with `scanner.enabled: false`.

#### GET /api/spectrum

```bash
curl http://localhost:9000/api/spectrum
```

**Response** (`SpectrumStatus`: `{defaultProfile, profiles, limits, subscribers, sources}`, abridged):

```json
{
	"defaultProfile": { "key": "10:512", "hz": 10, "bins": 512 },
	"profiles": [
		{
			"sourceId": "rtl",
			"key": "25:2048",
			"hz": 25,
			"bins": 2048,
			"isDefault": false,
			"clients": 1,
			"binCount": 1639,
			"binHz": 1000,
			"summariesPerFrame": 1,
			"effectiveHz": 20
		}
	],
	"limits": {
		"maxProfiles": 4,
		"hz": { "min": 0.5, "max": 25, "step": 0.5 },
		"bins": { "min": 128, "max": 2048 }
	},
	"subscribers": 2,
	"sources": [
		{
			"sourceId": "rtl",
			"eligible": true,
			"engine": "running",
			"consumers": 2,
			"rbwHz": 1000,
			"fftSize": 2048,
			"floorDbfs": -92.5,
			"floorOccupied": false,
			"kByRange": [],
			"settleMode": "marker",
			"tuningTrust": "commanded",
			"warnings": [],
			"summaryBinCount": 1639,
			"summaryBinHz": 1000,
			"summaryHz": 20,
			"latestFrame": null
		}
	]
}
```

`SpectrumActiveProfile` (`profiles[]`): the profile `key`, `hz`, `bins`,
`isDefault`, `clients`, and from the latest summary `binCount`, `binHz`,
`summariesPerFrame` and `effectiveHz` (null before one). `SpectrumLimits`:
`maxProfiles` (`scanner.ws.spectrumMaxProfiles`) and the `hz`/`bins` bounds.
`SpectrumSourceStatus` (`sources[]`): `eligible` and `reason?`
(`source-not-iq` | `source-removed`), the engine state and consumers, RBW,
floor, `k` per range, `settleMode`, `tuningTrust`, `warnings`
(`untracked-retune` | `host-centre-mismatch`, with `deltaHz`), the summary
budget actually delivered (`summaryBinCount`, `summaryBinHz`, `summaryHz`),
`latestFrame` (at the default profile) and `lastError?`.

An unexpected worker exit, fatal worker error or failed pipeline replacement
invalidates the engine and its cached live spectrum. Status reports
`engine: "error"` with `lastError`; stale summaries are not served as live.
Affected scanner jobs fail with `tuner-unavailable` and release resources
through normal teardown/recovery. Fresh demand waits for cleanup and can
acquire a new engine if the source still supports IQ; a now non-IQ source is
rejected. Existing clients may re-subscribe. There is no unlimited automatic
restart loop or general no-data watchdog.

#### GET /api/spectrum/occupancy

Hourly duty per 12.5 kHz bucket. Query: `sourceId`, `startHz`, `endHz`
(required; `endHz` above `startHz` by at most 2 GHz) and `sinceMs` (default
24 h, at most 168 h).

```bash
curl 'http://localhost:9000/api/spectrum/occupancy?sourceId=rtl&startHz=446000000&endHz=446200000&sinceMs=86400000'
```

```json
{
	"sourceId": "rtl",
	"bucketHz": 12500,
	"sinceMs": 86400000,
	"buckets": [
		{ "startHz": 446050000, "dutyByHour": [0.02, 0.11, null], "observedMs": 7200000, "activeMs": 468000 }
	],
	"top": [{ "startHz": 446050000, "duty": 0.065, "observedMs": 7200000, "activeMs": 468000 }]
}
```

400 `SPECTRUM_RANGE_INVALID` (`endHz` not above `startHz`, or the span above
2 GHz); 404 `SPECTRUM_SOURCE_NOT_FOUND` (no history for the source). Query
schema violations (a missing or unknown parameter, a negative Hz, `sinceMs`
below 1 or above 168 h) are rejected first with 400 `VALIDATION_ERROR`.

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
				"digital-voice",
				"resources",
				"tuner",
				"scanner",
				"spectrum",
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
		"digital-voice",
		"resources",
		"tuner",
		"scanner",
		"spectrum"
	]
}
```

Channels: `decoders`, `sources`, `metrics`, `health`, `fanout`, `live-audio`,
`digital-voice`, `resources`, `tuner`, `scanner` (signal discovery scanner,
[SCANNER.md](SCANNER.md)) and `spectrum` (core waterfall frames, opt-in).

`spectrum` takes optional per-client options on `subscribe`. Without options
the client gets the default profile (`scanner.ws.spectrumHz` ×
`scanner.ws.spectrumBins`, 10 Hz × 512) on every eligible source; with
`options.spectrum` it selects one source and one profile:

```json
{
	"type": "subscribe",
	"channels": ["spectrum"],
	"options": { "spectrum": { "sourceId": "rtl", "hz": 25, "bins": 2048 } }
}
```

- `hz` is snapped to 0.5 and clamped to 0.5–25; `bins` is rounded and
  clamped to 128–2048; omitted fields take the default's values.
- One source and one profile per client. Subscribing again switches without a
  gap; subscribing without options returns to the default selection.
  `unsubscribe` or a disconnect releases the demand.
- Rapid re-subscribes coalesce: only the latest request is answered; superseded
  ones get no reply.
- The answer is a `spectrum:profile` ack, then one `snapshot: true` frame per
  source (current state, not a replay of missed messages), then live frames.

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

##### dsd-fme calls (types: `call_start`, `call_end`)

Both carry `callId` (shared by the pair and by `digital-voice:call`) and
`startedAt` (ISO 8601, the call's first decoded line). `call_start` also carries
`encrypted`; `call_end` carries `endedAt` and `flags.encrypted`. `duration` is
exactly `endedAt - startedAt`. A call ended by the fallback timeout
(`flags.timeout: true`) has `endedAt` at its last decoded line, so the event is
published about `callTimeoutMs` (4 s) after `endedAt`: compare the fields, not
event arrival times.

```json
{
	"type": "call_end",
	"decoder": "dsd-fme",
	"timestamp": "2026-10-09T13:38:49.726Z",
	"data": {
		"callId": "dsd-fme-mg1x2abc-2",
		"startedAt": "2026-10-09T13:38:38.413Z",
		"endedAt": "2026-10-09T13:38:45.665Z",
		"protocol": "dmr",
		"talkgroup": 9,
		"source": 2060945,
		"slot": 1,
		"duration": 7252,
		"dmr": { "cc": 1 },
		"quality": { "crcErrs": 0, "fecErrs": 12 },
		"flags": {
			"encrypted": false,
			"timeout": true,
			"badSignal": false,
			"falsePositiveSuppressed": false
		}
	}
}
```

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

#### decoder:created

On the `decoders` channel when a decoder is added at runtime (scanner probes;
`owner: "scanner"`, `ephemeral: true`). `decoder` is the
`GET /api/decoders/:id` body. Add the row.

```json
{
	"type": "decoder:created",
	"channel": "decoders",
	"data": {
		"decoderId": "scan-t6q4m3x-dmr-1",
		"decoder": {
			"id": "scan-t6q4m3x-dmr-1",
			"type": "dsd-fme",
			"owner": "scanner",
			"scannerJobId": "j_01JA2T6Q4M3XZ8R6V5W2NKD7QH",
			"ephemeral": true
		}
	}
}
```

#### decoder:removed

On the `decoders` channel when a runtime decoder is removed. Drop the row and
any cached `decoder:status`.

```json
{
	"type": "decoder:removed",
	"channel": "decoders",
	"data": {
		"decoderId": "scan-t6q4m3x-dmr-1",
		"removedAt": "2026-10-10T14:02:20.000Z"
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
		"sourceId": "sdrpp-main"
	}
}
```

#### source:disconnected

```json
{
	"type": "source:disconnected",
	"channel": "sources",
	"data": {
		"sourceId": "sdrpp-main",
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

#### source:removed

Sent once on the `sources` channel when a source is removed (`DELETE
/api/sources/:id`). Clients drop the row and any cached `source:status`. No
further `source:status` or `source:disconnected` follows for that `sourceId`
(a later `POST /api/sources` with the same id starts a fresh lifecycle).
`removedAt` is an ISO 8601 timestamp. A reconnect or shutdown does not emit it.

```json
{
	"type": "source:removed",
	"channel": "sources",
	"data": {
		"sourceId": "rtl-pi",
		"removedAt": "2026-10-09T12:34:56.789Z"
	}
}
```

#### tuner:command-sent

On the `tuner` channel after a tuner command was written to an rtl_tcp source.
`origin` (optional) says who issued it: `"rest"` (the REST API), `"scanner"`
(a sweep through the scanner's lease) or `"replay"` (desired state re-sent on
reconnect). It is absent for writes whose origin is not tagged. Relay (SDR++)
commands do not pass through here.

```json
{
	"type": "tuner:command-sent",
	"channel": "tuner",
	"data": {
		"sourceId": "rtl",
		"command": "set-frequency",
		"value": 446000000,
		"origin": "scanner"
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

#### live-audio:level

On the `live-audio` channel while the live demodulator runs, published at
10 Hz. `channelPowerDbfs` and `noiseFloorDbfs` are `null` until the
first complete IQ block; `thresholdDbfs` is the threshold in effect.

```json
{
	"type": "live-audio:level",
	"channel": "live-audio",
	"data": {
		"sourceId": "rtl0",
		"channelPowerDbfs": -52.3,
		"noiseFloorDbfs": -61.8,
		"squelchOpen": true,
		"thresholdDbfs": -55.8
	}
}
```

#### digital-voice:call

On the `digital-voice` channel: a dsd-fme call started, turned out encrypted, or
ended (`DigitalVoiceCall`). Published in the same tick as the decoder's
`call_start` / `call_end` (same `callId`).

```json
{
	"type": "digital-voice:call",
	"channel": "digital-voice",
	"data": {
		"decoderId": "dsd-fme",
		"callId": "dsd-fme-mg1x2abc-2",
		"protocol": "dmr",
		"talkgroup": 9,
		"source": 2060945,
		"slot": 1,
		"encrypted": false,
		"active": false,
		"startedAt": "2026-10-09T13:38:38.413Z",
		"endedAt": "2026-10-09T13:38:45.665Z"
	}
}
```

#### digital-voice:status

On the `digital-voice` channel: the full `GET /api/digital-voice/status` body,
sent on start/stop, on client connect/disconnect and after every
`digital-voice:call`.

#### Scanner channel

All `scanner` messages pass one limiter: at most `scanner.ws.maxMessagesPerSecond`
(10) in any second, at most one per key per second, latest state per key wins,
and the latest state of every key is always delivered eventually. After a
reconnect, refetch over REST (`GET /api/scanner/jobs`, `/discoveries`); missed
messages are not replayed.

#### scanner:job

The full `ScanJob` (the `GET /api/scanner/jobs/:id` body) on create, on every
state change and after every edit.

```json
{ "type": "scanner:job", "channel": "scanner", "data": { "id": "j_01JA2T6Q4M3XZ8R6V5W2NKD7QH", "state": "paused", "reason": "preempted-operator" } }
```

#### scanner:progress

`{jobId, state, sweepIndex, hopIndex, hopCount, centerHz, holdingOn?, coverage, probes}`;
`probes` is a count (the probe list is in the job detail, `progress.probes[]`).
At most 1/s per job.

```json
{
	"type": "scanner:progress",
	"channel": "scanner",
	"data": {
		"jobId": "j_01JA2T6Q4M3XZ8R6V5W2NKD7QH",
		"state": "running",
		"sweepIndex": 3,
		"hopIndex": 18,
		"hopCount": 44,
		"centerHz": 428400000,
		"coverage": 0.94,
		"probes": 0
	}
}
```

#### scanner:discovery

`{change: "created" | "updated" | "upgraded" | "merged" | "deleted", discovery}`,
coalesced to at most 1/s per discovery (the latest change wins).

#### scanner:activity

`{sourceId, observationId, discoveryId?, jobIds, frequencyHz, active, peakDbfs, hypothesis?: {protocol, score}}`
when a transmission starts or ends. Activity is shed first under load (newest wins).

#### scanner:identify

One stream per identify target (`all: true` sends one per surfaced emission, with
`targetHz` its centre): `{jobId, targetHz, state, trials, result?}`. Coalesced to at
most 1/s per (job, target); the latest state is always delivered.

- `state`: `waiting-for-signal` → `trying` → `identified` | `candidate` | `unidentified`.
- `trials[]`: `{protocol, decoder, mode, transport, outcome, reason?}`. Outcomes:
  `pending`, `running`, `decoded`, `no-sync`, `crc-errors`, `timeout`,
  `skipped-budget`, `unsupported` (with `reason`: `no-decoder`,
  `needs-channelizer`, `unsupported-format`; `mode` and `transport` null),
  `not-needed` (an earlier trial decoded and `exhaustive` is false) and
  `cancelled`.
- `result`: see `POST /api/scanner/identify`, including `artefact?` and
  `ended?: "window-moved"`.

If `all: true` finds nothing within `timeoutMs`, no `scanner:identify` is sent;
the job completes with `identify.targets: []` (`scanner:job`).

```json
{
	"type": "scanner:identify",
	"channel": "scanner",
	"data": {
		"jobId": "j_01JA2TB0Q7ZPM1V8C4X2N6R3TY",
		"targetHz": 446056250,
		"state": "identified",
		"trials": [
			{ "protocol": "dmr", "decoder": "dsd-fme", "mode": "auto", "transport": "offset", "outcome": "decoded" },
			{ "protocol": "pocsag", "decoder": "multimon-ng", "mode": "multimon-ng", "transport": "offset", "outcome": "not-needed" }
		],
		"result": {
			"protocol": "dmr",
			"confidence": "decoded",
			"identity": { "kind": "dmr-cc", "value": "1" },
			"metadata": { "talkgroups": ["9"], "sources": ["2060945"], "slots": [1], "callsigns": [], "capcodes": [], "ismModels": [] },
			"discoveryId": "d_01JA2T7B9S0KQ4M3XZ8R6V5W2N",
			"measurements": { "source": "track", "centreHz": 446055970, "obwHz": 9800, "peakDbfs": -38.5, "snrDb": 51.5, "floorDbfs": -92.5, "dutyCycle": 0.5, "class": "tdma-ms" }
		}
	}
}
```

#### scanner:status

The `GET /api/scanner` body on change, at most 1/s (a settings
PATCH always sends one).

#### Spectrum channel

The `spectrum` channel is opt-in per client (see [Subscribe](#subscribe)). Its
messages go only to the clients whose selection they match, bypass the scanner
limiter and do not count toward `ws.maxMessagesPerSecond`.

#### spectrum:profile

Sent to one client only: the ack to a `spectrum` subscribe, or a notice after a
permanent source removal (`DELETE /api/sources/:id`) or a default-profile change
that remapped the client.

```json
{
	"type": "spectrum:profile",
	"channel": "spectrum",
	"data": {
		"selection": "source",
		"sourceId": "rtl",
		"profile": { "key": "25:2048", "hz": 25, "bins": 2048 },
		"effectiveHz": 20,
		"outcome": "exact",
		"adjusted": []
	}
}
```

- `selection`: `none` (no frames), `default` (the default profile on every
  eligible source) or `source`.
- `outcome`: `default` (no options), `exact`, `nearest` (see `adjusted`:
  `hz`, `bins`, `profile-limit`), `rejected` (the previous selection is kept;
  `code` and `message` say why) or `removed` (notice: `removedSourceId` was
  removed; a source selection becomes `selection: "none"`).
- `code`: `SPECTRUM_OPTIONS_INVALID`, `SPECTRUM_SOURCE_NOT_FOUND`,
  `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`, `SPECTRUM_ENGINE_ERROR`.
- Limits: the server serves the nearest admissible profile and never rejects a
  request for its size. Above `scanner.ws.spectrumMaxProfiles` (4 distinct
  non-default profiles over all sources; config-only, 1–16) a request maps to an
  active profile on that source (preferring one not larger than the request) or
  to the default.
- Reset the client's waterfalls on every `spectrum:profile`, except that an
  `outcome: "removed"` notice with `selection: "default"` drops only
  `removedSourceId`'s waterfall. A reconnect changes nothing; a source re-added
  with the same id is picked up by default subscribers on their next subscribe.

#### spectrum:frame

One frame per source and profile:

```json
{
	"type": "spectrum:frame",
	"channel": "spectrum",
	"data": {
		"sourceId": "rtl",
		"profile": "10:512",
		"epoch": 12,
		"tuningTrust": "commanded",
		"centerHz": 446000000,
		"sampleRateHz": 2048000,
		"binHz": 4000,
		"nativeBinHz": 1000,
		"startHz": 445180800,
		"binCount": 410,
		"bins": "AAECAwQF…",
		"binEncoding": "u8-halfdb-127.5",
		"floorDbfs": -92.5,
		"thresholdDb": 9.2,
		"tracks": [{ "startHz": 446051000, "endHz": 446061000, "flags": { "burst": false, "iqImage": false, "edge": false } }],
		"masks": { "dcHz": 446000000, "dcGuardHz": 1500, "spurRanges": [{ "startHz": 446249500, "endHz": 446250500 }] },
		"at": "2026-10-10T14:02:15.050Z"
	}
}
```

- `profile` is the key `<hz>:<bins>` (the default profile or the client's).
- `bins`: base64 of a `Uint8Array`, `u8-halfdb-127.5` encoding: byte `v` is
  `dBFS = v / 2 − 127.5` (0.5 dB steps), max-hold over the frame interval;
  bin `i` is centred at `startHz + (i + 0.5) × binHz`.
- `binCount ≤ bins`, never upsampled; `binHz` is the true width and
  `nativeBinHz` is `fs / fftSize` (`binHz / nativeBinHz` is the max-hold
  factor). The engine summary budget (`scanner.ws.spectrumSummaryBins`, 2048)
  caps the detail.
- Cadence: one frame per `ceil(blockHz / hz)` block summaries, with
  `blockHz = 1000 / integrationMs` (20 at the default): 25 Hz gives 20 Hz, 10 or
  15 Hz gives 10 Hz. `effectiveHz` is that cadence while blocks flow and an
  upper bound across sweep settles and gaps.
- The max-hold restarts when the epoch changes, so a frame never mixes two
  centres. `tuningTrust: "unverified"` means the frequency axis may be wrong
  (grey it out). `masks` are RF ranges: the DC spike (`dcHz ± dcGuardHz`) and
  every masked spur line.
- `snapshot: true` marks the current-state frame sent right after an ack (the
  latest block of the current epoch at the client's profile; none while a
  retune settles). It is not a replay.
- Client rules: never merge or accumulate rows across a change of `sourceId`,
  epoch, `profile`, `binHz` or `startHz`; each row carries its own axis. Compare
  epochs for equality only (they restart with the engine).

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

All error responses use a flat body: `error` (an error name), `code`,
`message` and, when there is more to say, `details`. The HTTP status carries
the status code.

```json
{
	"error": "NotFound",
	"code": "DECODER_NOT_FOUND",
	"message": "Decoder with id 'foo' not found"
}
```

```json
{
	"error": "ScannerApiError",
	"code": "SCANNER_TAKEOVER_REQUIRED",
	"message": "This sweep disturbs other consumers; resend with takeover",
	"details": { "impact": { "liveAudioClients": 1 } }
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
| `DECODER_OWNED_BY_SCANNER` | 409        | start/stop/restart or band edit on a scanner probe (`owner: "scanner"`) |
| `SOURCE_HELD_BY_SCANNER`  | 409         | start/restart of a decoder whose source a scanner sweep holds (`tuner-scanning`) |

### Scanner and spectrum codes

Scanner and spectrum routes answer with the flat body
`{ "error": "<name>", "code": "<CODE>", "message": "…", "details"?: {…} }`.

| Code                            | HTTP | When                                                                                                                                         |
| ------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`              | 400  | Request schema (body, params or query, e.g. occupancy query bounds), or a settings PATCH value out of bounds / unknown key                  |
| `SCANNER_PLAN_INVALID`          | 400  | The job preview has errors; `details.issues`                                                                                                 |
| `SCANNER_MONITOR_UNAVAILABLE`   | 400  | `kind: "monitor"` (listen-scan needs the channelizer)                                                                                        |
| `SCANNER_SETTINGS_INVALID`      | 400  | A settings patch that does not merge; `details.issues`                                                                                       |
| `SCANNER_IDENTIFY_VIA_JOBS`     | 400  | `kind: "identify"` on `POST /api/scanner/jobs`; use `/api/scanner/identify`                                                                  |
| `SPECTRUM_RANGE_INVALID`        | 400  | Occupancy query: `endHz` not above `startHz`, or the span above 2 GHz                                                                        |
| `SCANNER_NOT_FOUND`             | 404  | Route level: the job, discovery, recording, evidence or capture in the path does not exist                                                   |
| `SCANNER_JOB_NOT_FOUND`         | 404  | Service level: an action on a missing job                                                                                                    |
| `SCANNER_DISCOVERY_NOT_FOUND`   | 404  | Service level: an action on a missing discovery (observations, PATCH, listen)                                                                |
| `SPECTRUM_SOURCE_NOT_FOUND`     | 404  | Occupancy query: no history for the source                                                                                                  |
| `SCANNER_TAKEOVER_REQUIRED`     | 409  | The sweep (or the resume of a `paused(operator)` sweep that lost its lease) disturbs other consumers; `details.impact`; resend with `takeover: true` |
| `SCANNER_SOURCE_BUSY`           | 409  | The tuner is not available; the detail is in `message` (a relay client controls the tuner, "holder is starting", "releasing", "recovery pending", lease held by another job). `details.reason`: `"releasing"` (the previous lease is still restoring), `"recovery-pending"` (a crash or outage recovery waits for the source's data), `"holder-starting"` (the holder is still starting), `"relay"` (a relay client controls the tuner) or `"held"` (another scanner job holds the lease, or waits for it with a better claim). The first three clear by themselves within seconds; retry. `relay` and `held` last until the relay or the holder lets go. `details.holderJobId` when a job holds the source; `details.waiter` when a better-placed job waits; `details.issues` when the preview found it |
| `SCANNER_NO_TUNER_CONTROL`      | 409  | The source has no rtl_tcp tuner control (sweep)                                                                                              |
| `SCANNER_JOB_TERMINAL`          | 409  | Edit or action on an ended job                                                                                                               |
| `SCANNER_JOB_NOT_TERMINAL`      | 409  | `DELETE` of a job that has not ended                                                                                                         |
| `SCANNER_INVALID_TRANSITION`    | 409  | The lifecycle action does not apply to the current state                                                                                     |
| `SCANNER_DISCOVERY_LOCKED_OUT`  | 409  | `listen` on a locked-out discovery                                                                                                           |
| `OUT_OF_WINDOW`                 | 409  | `listen` or `identify` outside the tuned window; identify adds `details.window {startHz, endHz}`; listen adds `details` with `liveSourceId`/`sourceId`, `offsetHz`/`usableHalfSpanHz` or `offsetHz` (see listen) |
| `LIVE_AUDIO_UNAVAILABLE`        | 409  | `listen` without live audio                                                                                                                  |
| `SCANNER_IDENTIFY_NOT_PAUSABLE` | 409  | `pause` / `resume` on an identify job                                                                                                        |
| `SCANNER_IDENTIFY_NOT_EDITABLE` | 409  | `PATCH` on an identify job                                                                                                                   |
| `SCANNER_SETTINGS_WRITE_FAILED` | 500  | `settings.json` could not be written; nothing changed                                                                                        |
| `SCANNER_DISABLED`              | 503  | Job or identify creation with `scanner.enabled: false`                                                                                       |
| `SCANNER_STATE_UNAVAILABLE`     | 503  | The persisted jobs and settings could not be read at boot; sweeps, sweep resumes and settings changes are refused for this run               |

`spectrum:profile` codes (WS only): `SPECTRUM_OPTIONS_INVALID`,
`SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`,
`SPECTRUM_ENGINE_ERROR`.

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
