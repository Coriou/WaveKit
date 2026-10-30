# Mock API

Serves the canvas's mock data over the core's real routes so the web app runs without a receiver.
Start it with `pnpm --filter @wavekit/web mock`, then `pnpm --filter @wavekit/web dev`.

- API and `/ws` on `127.0.0.1:3101` (`WAVEKIT_MOCK_PORT`, `WAVEKIT_MOCK_HOST`); synthetic live
  audio on port + 1 (`WAVEKIT_MOCK_AUDIO_PORT`, advertised as `WAVEKIT_MOCK_AUDIO_ORIGIN`,
  default `http://localhost:3102`) at `/stream.wav` and `/stream`.
- Load tests: `WAVEKIT_MOCK_LOAD=<n>` multiplies the fleets (aircraft, vessels, APRS, mesh) by `n`
  with seeded copies, and the decoder message rate by `n` (`load` in `buildMockServer()`).
  `WAVEKIT_MOCK_ADSB_RATE=<r>` sends `r` `aircraft:update` per aircraft per second, as a core on
  SBS output does (one per decoded message; `adsbRate`).
- Spectrum limits: `GET /api/spectrum` serves `limits.bins.max` 2048, like the shipped config.
  `WAVEKIT_MOCK_SPECTRUM_BINS=<n>` (512–8192) raises the summary budget (`spectrumSummaryBins`), so
  Settings › FFT size offers 4096 and 8192 (`spectrumBins` in `buildMockServer()`).
- Retune latency: `WAVEKIT_MOCK_RETUNE_MS=<ms>` delays each `POST /api/tuner/:sourceId/frequency`
  before it takes effect and answers (`retuneMs`), to try dragging the spectrum past the capture
  as on a real receiver (about 300 ms to the first frame at the new centre, ROADMAP §8).
- Retune sweep: `WAVEKIT_MOCK_RETUNE_SWEEP=1` (`retuneSweep` in `buildMockServer()`, `retune-sweep.ts`)
  retunes, from the first spectrum subscription, through 1090, 131, 136, 119.7, 144.6, 98, 438.9,
  446.1, 466.1, 868.9, 162 and 155 MHz every 1.5 s, then parks at 466.078 MHz at 1.024 MS/s. Each window
  has its own steady signals and discoveries, a saved frequency sits at 434.502 MHz, and frames follow
  the tuner's sample rate. Parked, only four signals may be labelled in the plot.
- Legacy core: `GET /api/access/bootstrap` is not mounted (404).
- Exception: operator data (`operator-data.ts`) is served as a protected core serves it, so the
  saved frequencies show: `GET /api/operator-data`, saved-frequency create / replace / delete with
  the revision token and core's error bodies, preference patches, `operator-data:snapshot` on subscribe and
  `operator-data:updated` after each change. Seeds are `MOCK_SAVED_FREQUENCIES` in `data.ts`.
  A real legacy core answers 404 there; the web app then says saved frequencies are unavailable.
- Exception: the Settings routes (`settings.ts`, registered from one marked block in `server.ts`)
  are mounted as a protected core mounts them, so the Settings drawer can be exercised. A real
  legacy core serves `GET /api/station` only (no PATCH, `writable` absent or false), answers
  `GET /api/decoders/:id/settings` with the route 404 (`NOT_FOUND`) and `PATCH /api/decoders/:id`
  with 501 `DECODER_CONFIG_UPDATE_UNSUPPORTED`, and does not mount `GET /api/config/export`.
  Mocked: `GET` / `PATCH /api/station` (`writable: true`, revision as If-Match, country pinned
  by YAML, core's validation order and bodies, `changed`, `appliesOnRestart: ["readsb"]` on a
  move, `coverageCleared` beyond 1 km); `GET /api/decoders/types` with the core's option
  descriptors and patch allowlist (`decoder-options.ts`, a snapshot of `src/decoders/options`);
  `GET /api/decoders/:id/settings` and the WG8 merge patch `PATCH /api/decoders/:id` (If-Match,
  `DECODER_OPTIONS_INVALID` issues with core's rule text, `DECODER_OPTION_NOT_PATCHABLE`,
  `pendingRestart` until a start or restart; `mode` auto / always / off applied at once, with
  `DecoderInfo.mode` / `modeSource` on every status); `POST /api/decoders/:id/{start,stop,restart}` with
  `DECODER_ALREADY_RUNNING` / `DECODER_NOT_RUNNING`; `GET /api/decoders/:id/log?lines=` (synthetic
  lines); `GET /api/storage` (every area, activity retention, filesystem); `GET /api/config/export`
  (redacted YAML); `GET /api/status` (`version`, `uptime`). Preferences:
  `PATCH /api/operator-data/preferences` (`patch-preferences` `set` / `reset`) in
  `operator-data.ts`.
- `/stream` sends the core's `X-Audio-Format` / `X-Sample-Rate` / `X-Channels` headers and, like a
  legacy core since WG7, `Access-Control-Allow-Origin: *` on every answer and a 204 preflight on the
  stream paths: the page fetches it cross-origin directly. While live audio is stopped the connection
  is dropped, as the core's audio server is then not listening.
- Matched against a real core (lot C7): frames cover only the usable 80 % of the capture (`binCount`
  below the bins asked for, track edges on the summary bin grid), error bodies are the core's
  (`{ error, code, message, correlationId }`, `VALIDATION_ERROR` with `details`, route 404
  `NOT_FOUND`), identify answers `starting` and sends `waiting-for-signal` before the job turns
  `running`, and `dataRate` is KiB/s.
- Spectrum subscriptions honour `backfillMs` like the core (WG1): up to 64 recent frames of the
  current epoch, oldest first, `backfill: true`, counted in the ack's `backfillFrames`.
- Scanner (`scanner.ts`, registered from `server.ts`): the core's `/api/scanner` routes with their
  schemas and error codes: status, settings (GET / PATCH with provenance and bounds), the EU
  bandplans (plus a `pager-466` plan), plan previews from a port of the core's planner (hops,
  sweep period, poi, estimates, impact naming the running mock decoders, lockouts, issues), jobs
  (create with takeover consent, pause / resume / cancel / delete, live PATCH with `range-locked`,
  hits) and discoveries (seeded from `DISCOVERY_SEEDS`, the core's filters, sort, cursor, operator
  PATCH, delete, observations, listen). A passive in-window job is always present; a sweep steps the
  mock tuner hop by hop (origin `scanner`), holds on active mock signals (`holdingOn` is a track id, as in the core; a PATCH whose exclusions
  cover the held frequency ends the hold) and emits `scanner:job`,
  `scanner:progress` (2 Hz), `scanner:discovery`, `scanner:activity` and `scanner:status` through a
  per-key limiter like the core's. Operator tuner writes pause it `preempted-operator` until
  `resumeAt` (60 s after the last write by default); identify results update their discovery.
  Not mocked: decoded-elsewhere and band-plan skip layers, probes, recordings, evidence, captures
  (an empty list), monitor jobs.
- `data.ts` holds the canvas data (signals, band plan, decoders, messages, identify plans),
  `spectrum.ts` the frame synthesis, `audio.ts` the audio server, `server.ts` the routes and
  `buildMockServer()` (used by `web/tests/mock`).
- Receiver controls live in `receiver.ts` (registered from one marked block in `server.ts`): the tuner
  setting routes and `PATCH /api/tuner/:id/config` with the core's validation codes and messages,
  `GET /api/receiver-capabilities[/:id]` for an RTL-SDR with an R820T (29-step gain table, rate
  presets, 15 controls) and `GET /api/tuner-relay` (port 1234, exclusive). Writes emit
  `tuner:command-sent` then `tuner:state-changed`; a new sample rate bumps the spectrum epoch (the
  synthetic frames keep their 2.4 MS/s span). `WAVEKIT_MOCK_RELAY_CLIENT=1` starts with an SDR++
  client holding the tuner (`TUNER_CONTROL_EXTERNAL` until the panel takes control back).
  `POST /api/tuner/:id/gain` takes `{ "gain" }` (tenths of a dB) or the deprecated `{ "tenthsDb" }`,
  and two different values answer 400 as on the core. `GET`/`PUT /api/tuner-band-gain` serve the
  core's default per-band gain table in memory with its PUT rules and 400 body (`BAND_GAIN_INVALID`).
- Overload hint: `WAVEKIT_MOCK_OVERLOAD_HINT=1` (`overloadHint` in `buildMockServer()`, or
  `server.scanner.overloadHint(percent | null)`) adds the scanner engine's `overloadHint` at the
  tuner's manual gain (absent in AGC, as on the core).
- Activity records: `GET /api/activity/:eventId` returns the message's full decoded JSON as
  `decodedData` (`MockMessage.data`), so the message card can humanise what the core's fields leave
  out (rtl_433 extras, APRS weather, an unknown `Generic-Remote` model). Entity keys follow the
  core's formats (`talkgroup:`, `capcode:`, `callsign:`, `sensor:<model>-<id>`, `reg:`, `node:`,
  `icao:`, `mmsi:`), and AFR1234 and F4ABC-9 sit where the Map's fleets put them.
- Activity floods (`activity-floods.ts`, `activityFloods` in `buildMockServer()`, on for `pnpm mock`,
  off with `WAVEKIT_MOCK_ACTIVITY_FLOODS=0`, off by default in tests): the repeats a live receiver
  makes, so Activity's folding can be seen. A synthetic aircraft (ICAO `ABC123`, callsign `WKT101`
  every 10th decode, presence-only rows otherwise) at 2.5 decodes/s, a POCSAG tone-only beacon
  (capcode `0042001`, `Message type: unknown`) every 45 s ± 3 s, and a DMR call on TG 99 every
  3 min: 12 overs from radio 4242, each a `call_start` (no duration; the first with no radio yet)
  and a `call_end` 2.4 s later carrying the duration, as dsd-fme sends them. The history holds
  30 min of beacons and calls and the last 3 min of aircraft; live, they follow the same schedule of absolute time while a WebSocket
  client is connected. The mock keeps its newest 2 000 Activity rows (about 13 min of floods).

The settings mock also serves `GET`/`PUT /api/decoders/efficiency/budget`: Auto resolves to
4 cores from 8 CPUs, and numeric budgets accept values greater than 0 and up to 64.
Its `source` starts as `default` and becomes `saved` after a successful `PUT`, so the Settings
row shows its saved-override note.
`GET /api/decoders/efficiency` includes the resolved `budget` and illustrative per-source
core usage (0.25 cores per running, unpaused decoder).

`GET /api/decoders/summary` gives each decoder the core's verdict (`decoder-summary.ts`, the same
codes, wording and actions as the core). Tuned within 200 kHz of 1090 MHz while the budget is
still the default Auto, ADS-B pauses as `efficiency-budget` ("ADS-B paused: CPU budget full",
first action `raise-budget`); saving any budget, or starting ADS-B yourself, lets it run again.
