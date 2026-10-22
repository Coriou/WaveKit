# Web dashboard — core gaps

Features the web dashboard design relies on that WaveKit core does not provide yet.
Maintained on the `design/web-dashboard` branch alongside [DESIGN.md](DESIGN.md) and
the design canvas. Core team: pick items into `docs/ROADMAP.md`; when one lands,
note it here (or tell the design session) so the item can be ticked.

Format: `- [ ] item` — tick (`- [x]`) once it is in core on `main`. "Partly:" says what
already exists, so only the rest is the gap. Items are grouped into work packages where
several screens hang off one core change.

**Audited 2026-10-11 (late)** item by item against `origin/main@b2b4473`: scanner S1
accepted (S2 integrated, disabled), channelizer merged but off, operator data, access
bootstrap and device list mounted. One fact behind several lines: `config/default.yaml`
runs `access.mode: legacy`, where operator data is not mounted; anything marked
*protected mode only* is unreachable in a default deployment.
Re-checked 2026-10-12 (Scanner UX review) against `origin/main@7743665`: nothing to tick; the
new planner sheet needs no new core item (plan preview, impact and `scanner:progress` cover it;
ranges on/off mid-scan is already listed).
Re-audited 2026-10-12 (Scanner second pass) item by item against `origin/main@7743665`: nothing new
landed; one tick withdrawn (per-hop protocols, below) and seven "Partly" texts corrected (the
regional and receiver-capabilities foundations have no routes yet).
Re-checked 2026-10-12 (band plans session) against `origin/main@6b4e5dc`: the regional display
registry (`/api/regional/families`, `/channels`, `/resolve`) and receiver capabilities
(`/api/receiver-capabilities`, `/:sourceId`) are now mounted, read-only, in protected and legacy
composition; the two "Partly" texts below are updated. Nothing to tick.
Re-audited 2026-10-16 item by item against `origin/main@b3d75c9` (web-gaps batches 1–3, band plans
batches 1–2, scanner follow-ups batch 1, browser access batch 1): 19 ticked, 15 now partly, 4 "Partly"
texts rewritten, 27 still open with no core work; both owner decisions are settled; a new section at
the end lists what core now provides that the canvas does not draw. Default deployment still runs
`access.mode: legacy`, so band-plan writes, operator presets and operator data stay *protected mode only*.
Re-checked 2026-10-17 (evening) against `origin/main@2c7f0a3`: since `221c0a3` main only added the
urgent coordination note on the session CSRF token, now applied in the web app (Access, below). Nothing to
tick: the recording id on events, map tiles from core and batched `aircraft` frames are still open.
Re-checked 2026-10-17 (night) against `origin/main@a1558f6`: main added the second web note (audio
credentials, applied) and a scanner persistence backlog bound (heap fix). Nothing to tick.

**Owner to decide first** (core specs on main lock these; the web design differs)
- Resolved 2026-10-12: activity categories. The decode-envelope spec was amended (req 4.4) to
  the eight brand categories plus `other` (`aircraft, marine, aviation-data, voice, paging, aprs,
  sensors, mesh, other`) with an entity key and an optional position; `src/core/activity/envelope.ts`.
- Landed (WG2 §11): device names. The access spec was amended; remembered devices carry `name`,
  `kind` (operator-chosen) and `lastSeenAt` (start of a UTC hour), set with
  `POST /api/access/devices/label`.
- Labels for talkgroups, radio IDs, capcodes and MMSIs (TG 2081 → "Fire dispatch"), stored
  in operator data and shown wherever the number is. No board draws this yet; scanner
  discoveries have a label per emitter, not per talkgroup.

**Spectrum**
- [x] FFT stream for spectrum and waterfall: `spectrum` WS channel, per-client profile
  (0.5–25 Hz, 128–2048 bins), snapshot on join, DC and spur masks, tuning trust.
- [ ] Zoom: a real higher-resolution FFT of the viewed slice (cropping published bins is not
  zoom). Designed on main (`docs/specs/viewed-slice-spectrum/`, feasibility gates), not built.
- [ ] Per-client `fftSize` up to 16384 in the `spectrum` subscribe options (Display › FFT size).
  Partly: per-client `averaging` landed (1–32 frames of exponential averaging, WG1 §2,
  `src/core/spectrum/subscribe-options.ts`). Still the gap: bins stop at 2048. (Profiles:
  default 4 per server, `scanner.ws.spectrumMaxProfiles` configurable 1–16.)
- [x] Waterfall backfill: `backfillMs` on a `spectrum` subscribe (≤10 s, ≤64 frames, ≤512 KiB)
  sends recent frames marked as backfill before live frames (WG1 §1, `spectrum-backfill.ts`).
- [ ] Low-latency tuner control over WebSocket (`ClientMessage` is still subscribe/unsubscribe
  only) for drag-to-pan. Depends on the ROADMAP §8 measurement of coalesced REST drag-to-tune.
  Owner, 2026-10-17: navigating the spectrum must be fluid. The web app now retunes *during* a
  drag (latest wins, at most one request in flight, a few per second) and slides the old frames
  until frames at the new centre arrive. What core should provide: (1) that measurement on the
  Pi receiver for a burst of retunes 50–500 kHz apart; (2) a retune path that drops superseded
  requests instead of queueing them, keeps tuner arbitration and scanner preemption, and says in
  the reply (or on the next frame) which centre the frame is for; (2b) an option on that retune to
  keep the live-audio channel on its absolute frequency (move the offset in the same step), since
  two requests today let the tuned readout jump between them; (3) a frame-level `centreHz`
  that is exact the moment the hardware has moved, so the client can place each frame without
  guessing (today `tuning trust` marks old-centre blocks `unverified`).
- [ ] Wide-band panorama: an operator-started sweep that hops one source across a frequency
  range (say 88–470 MHz) and returns one stitched power spectrum, each segment with its own
  capture time, like `rtl_power`. Owner, 2026-10-17: the spectrum must let the operator go
  anywhere in the band, beyond the visible capture, without inventing IQ: the panorama shows
  what was really measured, dated. Partly: scanner sweeps already hop and measure per hop
  (`src/core/scanner/job-runner.ts`) and the web Band ruler shows the last 24 h of scanner
  occupancy; still the gap: a route or WS channel that returns the per-hop FFT bins themselves
  (not only discoveries), a bin count per segment the client can ask for, takeover and
  resume semantics like scanner sweeps (the source's decoders pause), and tests on the
  stitching (overlap, DC spike and edge roll-off trimmed per segment).

**Band plans and presets** (one package: Spectrum labels, typed entry, ⌘K, Scanner).
Owner, 2026-10-12: band plans adapt to the user, configurable in core and in the UI, and WaveKit
ships strong defaults for popular countries. Labels must be right per country: in France "PMR"
means PMR446, so "PMR / land mobile 136–174 MHz" (today's canvas and core naming) is wrong there.
Plans like https://github.com/Arrin-KN1E/SDR-Band-Plans (CC0; SDR++ JSON, SDR# XML, Gqrx CSV;
US, France, International) must import cleanly. Drawn 2026-10-12 (canvas v82, DESIGN.md › Decision log ›
Band plans). Owner decisions that shape the core side: country from the station location with an
override (coarse region as fallback); packs seeded from community CC0 files then corrected against
regulator documents, per-band verified / community; WaveKit's fixed display groups (an open set,
unknown → Other; imported colours only a hint); import by file or by URL fetched once by core, with a
manual "Check for update" showing a diff (no auto-update); an ordered stack of active plans under the
user's edits; a full band editor with channels; provenance shown only in Settings; the regional
registry stays the verified layer that plan bands and channels link to.
Landed 2026-10-13/15 (BP1, BP2, `docs/specs/band-plans/`): `/api/bandplans` (stack, resolved view,
packs, presets; writes protected mode only), the `bandplans` WS channel and revision tokens.
- [ ] Configurable band plans in core, layered and resolved user edits > imports > built-in:
  built-in country packs (a CEPT / EU baseline and France first; then UK, DE, IT, ES, NL / BE, US,
  CA, AU, JP), imported plans (SDR++ JSON first, then SDR# XML, which carries mode and step, and
  Gqrx CSV) with provenance, and operator overrides kept as a layer over a plan so pack updates
  still apply. Partly: the layered resolver (operator layer, then the ordered stack of packs), a
  built-in pack per region projected read-only from the scanner plans (`builtin-eu`, …, citations
  as provenance), SDR++ JSON file import with preview and provenance "community-unverified",
  operator edits and operator bands (BP1 §2–6). Still the gap: country packs (built-ins are
  per region, with no tuning hints or channels by design, BP1 1.3), SDR# XML and Gqrx CSV import,
  import by URL, and scan hints on imported bands (their `scan` is null). Display groups are a
  closed enum of nine (`other` as fallback), not an open set.
- [ ] Station country picks the default pack and is derived from the station location (reverse
  lookup on a bundled country boundary set, offline), overridable, falling back to `region`.
  Partly: `station.country` (ISO 3166-1 alpha-2) in config and `WAVEKIT_COUNTRY`, served with
  provenance by `GET /api/station` and as `effectiveCountry` in the band-plan context. Still the
  gap: BP1 1.4 forbids inferring country from coordinates (ROADMAP: "gated"), the default pack
  follows `region`, not country, and there is no way to set it from the UI.
- [ ] Band plan model shared with the scanner: bands with name, edges, display group, default
  mode, bandwidth, step and protocols to try; named channels with aliases (marine ch 16 / 12,
  PMR446 ch 1–16, AIS A/B, airband guard, ACARS, VDL2). Partly: the band-plan `Band` has name,
  edges, display group (`marine, air, ism-srd, pagers, personal-radio, amateur, land-mobile,
  broadcast, other`), mode / bandwidth / step hints, skip with reason, up to 128 channels with
  aliases, a parent and a registry reference (`packages/api-types/src/bandplans.ts`); the
  scanner list follows the stack (BP2 §11). The regional registry (`/api/regional/*`) still has
  only US FRS with `dataset: null`. Still the gap: built-in bands ship no channels or tuning hints,
  EU registry families (marine VHF, PMR446, airband, AIS / ACARS / VDL2 channels), and the scanner's
  `Bandplan` is still the source the packs project from, not a projection of the plans.
- [ ] Missing or wrong plans in `src/core/scanner/bandplan/builtin.ts`: EU pagers 466.0–466.25 MHz
  (France: e*Message 466.025–466.230); 380–400 MHz (TETRA / INPT, encrypted) as skip by default.
  Partly: cited corrections landed for airband (8.33 / 25 kHz), `pmr446` 446.0–446.2 (12.5 and
  6.25 kHz rasters), `dpmr446` widened to 446.0–446.2, CB (40 CEPT channels), `ism-169` metering
  split out of `pager-vhf`, `vhf-land-mobile` no longer named PMR, and a combined built-in preset
  "ISM / SRD" (433 + 868 + 169). The 466 MHz plan waits for a citable primary source (ROADMAP).
- [ ] Band plan store details the canvas (v83) relies on: "Check for update" on an imported URL
  or a pack returning bands changed / added / removed, applied by hand; per band a link to the
  decoder that covers a channel. Partly: stack order and on/off (`PUT/DELETE /api/bandplans/stack`),
  field-level edits with `editedFields`, reset per band and per pack (`/edits`), orphaned edits
  reported, import preview without commit with a group-mapping report and `colourHint` kept,
  channels with aliases per band, `WAVEKIT_COUNTRY` (BP1 §4–6, BP2 11.7).
- [ ] Band plans feed the scanner: bands skipped by default (with their reason) and channels
  covered by a running decoder become automatic exclusions; the fixed-channel list (AIS, ACARS,
  VDL2, APRS, Meshtastic) comes from plan channels, not a hard-coded table. Partly: the scanner
  uses the effective built-in plans of the stack and drops hidden bands (BP2 11.1–11.4); scan
  presets carry protocols and rasters per range. Still the gap: `skip`, imported and operator bands
  do not reach the scanner (BP2 11.1), and decoder-covered channels are not excluded.
- [ ] Scanner follow hits (canvas v85): the demodulator follows a hit inside the current window or
  hop without retuning the hardware and returns after a hang time (today Listen only moves
  `offsetHz` on request via `/discoveries/:id/listen`); a per-job Follow hits option with a per-band
  default from the plan (voice on, data off); hits named from the plan (nearest named channel, else
  the range's raster point); `POST /api/scanner/plan` states one-hop plans explicitly (centre,
  channel count) so clients say "watching", not "sweeping".
- [x] Scan presets in core, shared by every client: built-in presets per region (one per plan plus
  combinations), read-only; operator presets with create / replace / delete
  (`/api/bandplans/presets`, `/:presetId`), and `GET …/presets/:id/job` turns one into a job spec
  (BP1 §7). Writes are protected mode only.
- [ ] Scan presets keep the whole plan (web app, 2026-10-17): the closed preset job has no range
  names (the app names a saved range after the band it lies in, else its edges), no Hold, Record,
  Stop after, "Just find signals" or "Skip what decodes elsewhere", and no per-range dwell or
  sensitivity, so "Save as preset" drops them. Wanted: `name` on preset ranges and those options in
  the job (null = default), still closed and validated.

**Tuner**
- [ ] `GET /api/tuner/:sourceId/capabilities`: `gainsTenthsDb[]` (or `null` with
  provenance), `sampleRatePresets[]`, `tuningRangeHz` (with and without direct sampling),
  `supports: {offsetTuning, biasTee, directSampling}`, unknown values reported as unknown.
  Today `TunerInfo` has `tunerType` and `gainCount` only (ROADMAP §2). Partly (main@7743665):
  the receiver-capabilities spec, a core provider (`src/core/tuner-capabilities/`) and DTOs
  (`packages/api-types/src/receiver-capabilities.ts`), mounted read-only at `GET
  /api/receiver-capabilities` and `/:sourceId` (main@6b4e5dc): per control command
  availability, transport applicability and physical support, peer `tunerType` / `gainCount`. The
  REST command policy (`TUNER_REST_COMMAND_POLICY`) is live in the tuner routes. The spec forbids inferring a gain
  table, rate presets or tuning range from the tuner type, so those three stay the gap: they
  need a reviewed per-tuner data source or a hardware readback.
- [ ] DC removal (`iqDcBlock` is deprecated and ignored), IQ correction, IQ swap. The
  spectrum masks the DC spike and spurs for display and detection; nothing corrects samples.

**Audio**
- [ ] One WebSocket audio stream with analog and decoded voice auto-routed, a clean 48 kHz
  rate and its pipeline latency (Listen "Latency ≈ 180 ms"). Today: HTTP 8081 analog, HTTP
  8082 digital, clients dropped on rate change (ROADMAP §5b).
- [x] `live-audio:level` on WS at 10 Hz (configurable 10–20) while running: `channelPowerDbfs`,
  `noiseFloorDbfs`, `squelchOpen`, `thresholdDbfs` (`LiveAudioLevel`).
- [x] `squelchMode: noise` (WG7, NFM and WFM), with `manual | auto` and `autoMarginDb`.
- [x] Configurable AGC (`agc: off | slow | fast`, WG4). Still the gap: real noise reduction
  (Listen's switch sends `noiseReduction: voice`), noise blanker, notch, CW BFO, real DSB.
- [ ] Decoded voice routed per channel: Listen › What you hear plays a dsd-fme decoder's stream
  (`GET /api/digital-voice/status`, `decoders[].httpUrl`) when one of its `targetFrequenciesHz`
  sits in the tuned channel. The core has no dsd-fme on the live channel itself, so tuning to a
  digital channel no decoder watches plays analog only.

**Analog transmissions** (one package: a squelch-delimited event carries all of these)
- [x] Analog transmission events (start, end, duration, frequency) from squelch:
  `live-audio:transmission` and the `analog-transmission` Activity kind (WG1 §3–4).
- [x] Analog vs digital detected per transmission on shared channels (ROADMAP §5b), so
  "What you hear: Auto" switches per transmission and the event carries the mode.
  Done in core (WG12: a proof per observation). Wired: Auto plays decoded voice during a call, the analog
  audio when a tone is heard live, otherwise follows the channel's latest observation proof
  (`features/listen/sound.ts` `transmissionKind`).
- [x] Tone on live status while a transmission is open (Listen offers the tone of the last
  closed transmission). Done: tone squelch (`toneSquelch`, WG7, NFM; Listen offers it), DCS on
  closed transmissions (WG6). Partly: CTCSS (50 standard tones) on each closed
  transmission as `tone.ctcssHz`, stored and searchable as text (WG2 §7); saved frequencies
  store a tone (ctcss, dcs code + polarity); scanner discoveries carry `ctcssHz` (S2, disabled).
  Done in core (WG12 `LiveAudioStatus.tone`). Wired: Listen offers the live tone and shows it in the head
  while the squelch is open; older cores still get the last closed tone from Activity.
- [x] DTMF on the tuned analog channel: digits on each closed transmission as `tone.dtmf` (up to
  32 symbols, WG2 §7), one per transmission, rather than a separate `audio:dtmf` event.
- [ ] The recording id on the event (see Recordings).

**Activity and events**
- [x] Common decode envelope, published live and stored: `/api/activity`, `/:eventId`, the
  `activity` WS channel, on by default (WG1 §7), with the eight categories, entity key, optional
  position and tone (WG2 §1). The recording id is listed under Recordings.
- [ ] Persistent event store: typed filters for CTCSS / DCS, with audio and kept; full text
  including transcripts; jump to time; the same store searching kept recordings and IQ captures.
  Partly: SQLite with FTS5 (`src/core/activity/storage/`), filters by kind, source, decoder,
  protocol, category, entity key (talkgroup, capcode, MMSI, callsign), refs, frequency range, time
  range and plain text, newest-first paging with a snapshot; fair-share retention (WG3 §1).
- [ ] Facet counts for "With audio". Partly: `POST /api/activity/facets` counts category,
  protocol, decoder, source and kind for the current query and time range (≤32 values each).
  Until the recording id is on the event, the web app's "With audio" keeps the voice category
  (transmissions and calls), recorded or not (2026-10-17).
- [ ] Digital call metadata: DMR tier, talker alias and error rate. Partly: `colourCode`, `nac`,
  `ran` and `algorithmId` on digital voice calls (WG2 §10); P25 phase is the protocol value.
- [x] Message rate history per decoder: `decoderStatus.rateHistory` (messages per minute, last 15,
  every decoder base).
- [ ] Auto band map for spectrum labels: per frequency bucket, the protocols decoded (by every
  decoder, not only `ScannerProtocol` ones), identity, last seen, active now. Partly:
  `/api/spectrum/occupancy` (7 days, hourly duty per 12.5 kHz) and ambient discoveries from
  the passive job (on by default, off on Pi 4-class hosts); ADS-B, AIS, ACARS, VDL2 and LoRa
  decodes never become discoveries. Activity rows now carry frequency and provenance, but no
  per-bucket summary exists.
- [x] Stable signal tracks on spectrum frames (web app, 2026-10-17): `spectrum:frame.tracks` are the
  block's raw segments (`pipeline.ts`, `segs.map`): no id, no level, no age, so every flicker of
  noise is a new "signal" and the app cannot keep a label on the same emission from one frame to
  the next. The tracker already knows all of it (`TrackSnapshot`). Wanted per frame track: the
  tracker's `trackId` (stable while the emission lasts, including across burst gaps), `snrDb` and
  `peakDbfs` against the core's own floor and threshold, `firstSeenAt` (or `blocks`) and whether
  the track has *surfaced* (passed the tracker's confirmation rules); `spur` alongside `iqImage`;
  and, when the scanner has one, its identity (discovery id, best protocol and confidence level).
  The app then labels the tuned and named signals, plus surfaced unknowns above a level, without
  guessing from one frame (today it filters on its own: about 10 dB over the floor for about 1 s).
  Done in core (WG11, 2026-10-18; WG12 adds `gate` and `channelSnrDb`): wired on the web branch, the label
  gate follows (`sourceId`, `trackId`), trusts `surfaced`, drops spurs and names a chip from `scanner`.

**Event contract** (one replay contract, ROADMAP §4)
- [ ] Live push with replay from a cursor for scanner events (scanner WS has none; clients
  refetch over REST). Partly: `activity:subscribe` takes a replay cursor and resets with a reason
  (`cursor-gap`, `cursor-expired`, `store-changed`, `query-changed`, `invalid-cursor`,
  `reader-failed`); holes in the store are reported (WG3 §3–4); band plans carry `revision`.
- [x] `scanner:progress` at up to 2 Hz per job (500 ms per key; WG1 §8, `scanner-broadcast.ts`).

**Access**
- [x] Public capability bootstrap: `GET/HEAD /api/access/bootstrap` (origins, session and
  pairing availability, analog / digital audio and operator data availability).
- [x] Remembered devices list: `GET/HEAD /api/access/devices` (id, created, renewed, expires,
  current); needs a browser session.
- [ ] Browser access end to end: client consumption of the onboarding and renewal flow, live TLS /
  proxy deployment acceptance (task 14), and a default deployment where operator data is available
  (default stays `legacy`). Must land before browser controls touch the receiver (ROADMAP §4).
  Partly (browser access batch 1, `docs/specs/core-access-policy/browser-access-batch1.md`):
  server-side pairing to renewal and revocation, `access.exposure: tls-termination`, an opt-in Caddy
  TLS compose profile, `make dev-protected`, machine-credential device list and revoke.
  Web app (2026-10-17): reads `GET /api/access/session` at start, pairs with a one-time code from the
  connection chip, renews at half the time left, keeps the CSRF token in memory and drops it on a 401;
  checked against `make dev-protected` (pair 201, a preferences PATCH 200 with the token after a reload).
  Still the gap: TLS / proxy acceptance and a default deployment with operator data.
- [ ] Serve the web app (2026-10-17, PWA batch): the core, or the Caddy TLS profile, serves the
  `web/dist` build at `/` beside `/api` and `/ws`, over HTTPS. `sw.js`, `index.html` and
  `manifest.webmanifest` go out with `Cache-Control: no-cache` (the worker finds new builds),
  `assets/*` as `immutable` (hashed names), the manifest as `application/manifest+json`. Without
  HTTPS (plain `http://pi.local:…`) Chrome will not install the app, and the service worker and the
  AudioWorklet do not run; `localhost` is exempt.
- [x] Device `name` / `kind` and `lastSeenAt` (hour resolution), set with
  `POST /api/access/devices/label` (WG2 §11).
- [ ] A read-only access role (view spectrum, activity and scanner results; no receiver
  control).

**Scanner** (S1 on main: discoveries, identify, sweeps with takeover, occupancy, listen)
- [ ] **Auto-resume that never cuts off a call**: a manual recording also holds the resume.
  Partly (2026-10-12 batch): the idle timer is held while the operator's squelch is open (3 s
  hang) and while an identify trial runs; jobs carry `resumeAt` and `resumeHeldBy`
  (`audio | identify | recording | null`); "Stay here" (`POST …/pause` on `paused(preempted-*)`
  → `paused(operator)`). Still the gap: no recorder reports activity, so `recording` never holds
  (`src/core/live-demod-activity.ts`).
- [x] Search discoveries by identity: `identity=<kind>:<value>`, and `q` matching identity values
  as well as labels (SF1 §5).
- [ ] `ScannerProtocol` values for what the composer offers: `ais`, `acars`, `vdl2`, `lora`
  (Meshtastic); CTCSS/DCS as a searchable feature, not a protocol. DSC has no decoder at all.
- [ ] Exclusions per range. Partly: per range `enabled`, `name`, `dwellMs` and `sensitivity` with
  `ranges[i].…` provenance (SF1 §2), plus rasters, `obwHz`, `protocols` and `bandplanId`;
  exclusions stay per job.
- [x] A job-level `signalsOnly` flag (no decoder trials) for "Find signals, don't decode" (SF1 §3).
- [x] Edit ranges in a running job: `PATCH /api/scanner/jobs/:id` accepts `ranges` with live
  `enabled`, `protocols`, `name`, `dwellMs`, `sensitivity`, applied at the next hop; edges, rasters,
  OBW and plan id are locked (`range-locked`) (SF1 §1).
- [x] Ignore also skips the frequency in sweeps: lockouts become runtime `lockoutExclusions` on
  sweep jobs (WG2 §12).
- [ ] Plan preview marks ranges covered by running decoders (`decodedElsewhere[]`) with an
  optional `skipDecodedElsewhere` default. Partly: `GET /api/decoders` exposes
  `targetFrequenciesHz` and band ranges.
- [ ] Per-job hit stats: `lastDurationMs` for the live hit log. Partly: `GET
  /api/scanner/jobs/:id/hits` (hits, first and last hit, `firstSeenInJob`), `jobHits` on
  `scanner:discovery` and `hitStats` on progress (WG2 §13); global `airtimeMs` exists.
- [ ] Watch here protocols: a persisted per-source `passive.protocols` setting (the passive
  job tries every protocol today; `passiveBySource` is on/off only).
- [x] `preemptedBy: {jobId, name}` on `paused(preempted-job)` (SF1 §4).
- [ ] Optional `discoveryId` on saved frequencies; the discovery DTO lists
  `savedFrequencyIds`.
- [x] Identify until a transmission (web app, 2026-10-17): an open wait for a signal on
  `POST /api/scanner/identify` (`timeoutMs: null` or `waitUntilSignal: true`, ended by
  `DELETE` or a retune), and an explicit `result.ended: "no-signal"` when the wait ran out with
  nothing heard. Today `timeoutMs` stops at 120 s, so the tuned card's "Wait until a
  transmission" chains 120 s jobs and reads "nothing heard" from an `unidentified` result with
  no trials and spectrum measurements (`web/src/data/identify-store.ts`); each round leaves a
  job in the scanner history.
  Done in core (WG12 `waitUntilSignal`, `waitMs` up to 10 min, `result.ended: "no-signal"`): wired, the
  web app asks for the open wait and falls back to 120 s jobs on an older core.
- [ ] S2 enabled (parallel identify trials, "Likely", CTCSS, analog recordings) and S3
  listen-scan ("Scan a list") for the later Scanner mode.
- [x] Decoder IDs in a sweep's impact (`Impact.runningDecoders`, `pinnedDecoders`); the UI
  maps IDs to display names.
- [x] Per-range protocols honoured per hop: without job-level `protocols`, a signal or hop uses the
  union of the enabled ranges covering it; job-level `protocols` overrides (SF1 2.6; reopened
  2026-10-12, landed with the 2026-10-12 batch).

**Recordings** (one package with the event store)
- [ ] Auto-record all audio (analog transmissions and digital calls), global retention and
  size cap, playback by id with seek (ROADMAP §5c). Only digital per-call WAV and scanner
  evidence WAVs exist (plain download, no catalog). Partly for analog: the S2 analog recorder
  is integrated but disabled.
- [ ] Recording state on every event: recorded (with id), recording now, not recorded
  (auto-record off), no audio (encrypted); plus the live global mode (all / digital calls /
  off) for the "Recording all audio" pill.
- [ ] Keep (star) a recording: exempt from retention, synced to every client; un-keeping
  returns it to normal retention (discovery `keep` protects an emitter's evidence, not one
  recording).
- [ ] Manual recordings (Listen › Record) with name, note and a non-destructive trim (in/out
  points stored on the item, applied on play and download). Today Listen › Record audio keeps
  what the browser plays and saves a WAV in its downloads; nothing reaches the Recordings drawer.
- [ ] Operator IQ capture of the viewed span (8-bit IQ, ~4.8 MB/s at 2.4 MS/s): start and stop
  with a maximum length, live elapsed time and size, what was decoded during it; playback as a
  source with seek and "back to live" (spectrum, audio and every decoder run on it); export
  as SigMF or .cu8. Partly: scanner burst captures and a config-only file `recording` source.
- [ ] Waveform peaks for every audio recording and a spectrogram thumbnail for every IQ
  capture, computed once by core.
- [ ] `GET /api/storage`: kept, automatic and other bytes, free, effective retention, the
  low-space policy. Partly: scanner status `disk-low` and scanner storage caps; Activity
  retention per share in `GET /api/activity/status` (WG3 §2).
- [ ] Stable `GET /api/recordings/:id` and `…/download?format=opus|wav&trim=1`.
- [ ] Transcription pipeline (future): per-recording transcript and status.

**Map**
- [x] Current state for fleets other than aircraft: AIS vessels (`/api/vessels`, class, static and
  voyage data, `navStatus`), APRS stations, objects and items (`/api/aprs/stations`; path, weather),
  Meshtastic nodes (`/api/mesh/nodes`; role, SNR/RSSI, hops), with stats routes and `vessels`,
  `aprs`, `mesh` WS channels (WG1 §5–6, WG2 §3–6).
- [x] Meshtastic links with SNR: `neighbours` from NEIGHBORINFO reports, up to 32 per node (WG3 §8).
- [ ] Position history for aircraft, vessels, APRS and mesh nodes (trails, last-hour replay)
  with a time cursor, plus per-minute activity counts for the timeline (depends on the event
  store; ADS-B trails are in memory only; vessel, APRS and mesh trackers keep no history).
- [x] Coverage: maximum range per 1° bearing over 24 h for ADS-B and AIS (`GET /api/coverage`,
  WG3 §7; needs a station location; in memory only).
- [ ] Map tiles: a regional PMTiles extract (200 / 400 / 800 km with size, download and update
  from Settings with progress) plus glyphs and the style; online OpenFreeMap fallback.
- [ ] Position extraction from ACARS / VDL2 (ADS-C, `POS` reports) into the common envelope.
  Partly: AIS aids to navigation (type 21) are tracked as vessel class `aton` with position.
- [ ] Optional: aircraft route and military flag (enrichment has registration, type, operator).
- [ ] Which fleets this core tracks, in one place (bootstrap or a capabilities route). Today each
  fleet route is mounted only with its tracker, so the web app reads a 404 as "not tracked here"
  and cannot tell a tracker that is off from a core too old to have it.
- [ ] Optional: batched or rate-limited `aircraft` frames for busy airspace (the channel sends
  every update, one frame per aircraft per message); the web app coalesces into one render per
  250 ms meanwhile.
- Web app lot 6 (2026-10-17) uses what is ticked above. Meanwhile, in the browser: ADS-B trails come
  from `trackHistory`, other trails only from positions seen since the page opened; the timeline
  chip shows Live only (no replay); an unset station location is estimated from the positions
  heard and shown as approximate (coverage stays off until it is set); tiles are OpenFreeMap online
  and, when they cannot load, the map shows data on a plain sea ("Basemap unavailable · data
  only"); ACARS sits in the layers rail as unavailable.

**Settings and station**
- [ ] Station identity: set from the UI, passed to the other decoders (direwolf `callsign` parsed,
  never used; lora-meshtastic's second `region`), approximate location estimated from received
  positions when unset; gpsd later for the portable receiver. Partly: `station.{name, lat, lon,
  altM, callsign, country}` in config and env with provenance (default / yaml / env), read-only
  `GET /api/station`; readsb takes `--lat/--lon` from it and coverage uses it.
- [ ] Settings store in core: a persisted layer over the YAML (in `stateDir`), validated writes
  over the API, live push of every change to all clients, each value reporting its source
  (default, YAML, environment, UI) so the UI can lock what env or YAML pins. Partly: decoder
  band overrides, scanner settings (the model: provenance, bounds, PATCH), band-plan stack and
  operator preferences persist. Decide whether operator preferences (below) live in this store.
- [ ] Operator settings synced to every client including mobile. Partly (protected mode only):
  preferences `units, timeFormat, waterfallPalette, showSavedFrequencyLabels` and command
  usage for tune, identify, listen and open-saved. Missing: Activity columns and pinned
  searches (order, names, each column's search), whether a drawer's attached pane is open
  (Activity's columns pane reopens as you left it), usage for every palette command, scope
  and value (frecency ranks them all).
- [ ] One settings schema for core and every decoder: Zod plus UI hints (label, help, group,
  essential or More, effect: live / restarts X / reconnects / hardware, aliases, widget,
  unit), served as JSON Schema so a new decoder needs no UI work.
- [ ] Decoder options validated at the boundary (only lora-meshtastic does today) and editable
  at runtime (`PATCH /api/decoders/:id` returns 501); batched apply that restarts only what
  changed.
- [ ] Settings with no other owner in this file: language, runtime log level, map labels, audio
  download format. (FFT size, squelch margin, recording, storage, offline area and trails are
  listed under their own sections.)
- [x] `GET /api/decoders/:id/log?lines=200` (bounded stdout/stderr ring) for "Show log".
  Decoder status itself has landed (health, uptime, version, events out, last output, error).
- [ ] The sdr-host version on `/api/resources/sdr-hosts` (startup rate and gain are there).
- [ ] Configuration export and import (YAML), update check.

**New in core, not on the canvas yet** (2026-10-16)
- [ ] Activity storage health: retention policy (fair-share) and per-share usage, coalesced
  positions and `floodCopies` from `GET /api/activity/status` (WG3 §1–2), in a storage / health view.
- [x] Activity read states: a replay `reset` with its reason (`cursor-gap`, `cursor-expired`,
  `store-changed`, `query-changed`, `invalid-cursor`, `reader-failed`), holes in the store (WG3 §4)
  and the overflow close `activity:closed`, each as a visible state of the Activity list. Web app
  lot 2 (2026-10-17): a reset reloads the snapshot and says why, ingestion gaps are quiet rows,
  `activity:closed` resumes from the cursors without a notice.
- [x] Reception provenance in row detail: `sourceId`, `frequency.hz` and `tuningTrust`
  (`commanded | relay | unverified`) per reception (WG3 §5); ACARS frequency absent when the
  decoder omits it. Shown in the Activity detail (web app lot 2).
- [ ] Meshtastic flood copies: `duplicateCopies` per node and copies kept out of Activity (WG3 §6).
- [ ] Mesh node telemetry: battery % (or powered), voltage, channel and air utilisation, uptime
  (float32 values, round for display) on the node card (WG3 §8).
- [ ] Coverage layer on the map, per protocol, with the "no station location" state (WG3 §7).
- [ ] APRS weather, digipeater path, objects and items (with kill), `digipeatedCopies` (WG2 §3).
- [ ] Vessel class (A, B, base station, aid to navigation, SAR aircraft), voyage data and
  `navStatus` on the vessel card (WG1 §5).
- [ ] Map and list updates for vessels, APRS and mesh arrive at most every 2 s per entity (WG2 §9);
  the UI should not imply faster freshness.
- [ ] Band-plan editing conflicts: `storeId` / `revision` on every write, 428 when the token is
  missing and 409 `BANDPLANS_CONFLICT` when stale, refetch on `bandplans:changed`.
- [ ] Band-plan views: per preset `applicable` and `issues`, orphaned edits after a re-import,
  shadowed and hidden bands, and a band's remaining `segments` when a higher layer names part
  of it.
- [ ] "Unknown" states from the regional registry (`dataset: null`) and receiver capabilities
  (`state: "unknown"`), drawn as unknown rather than empty.
- [ ] Lost-browser recovery: the machine credential lists and revokes remembered browsers
  (`/api/access/machine/devices`, `…/revoke`, `…/revoke-all`), so Settings › Devices should
  point to it.

**Found by the web app against a real core** (2026-10-16, main@23388b9, legacy mode, fake rtl_tcp;
re-checked 2026-10-17 on the branch after merging main 1da448e1)

- [x] Live audio has no `Access-Control-Allow-Origin` (`src/core/audio-stream-server.ts:59-67`), so a
  page on the API origin cannot fetch the stream on the audio port. Fixed on main by 88bfc6b7 (WG7
  req 8.1-8.3): legacy answers `Access-Control-Allow-Origin: *` on every response and a 204 GET/OPTIONS
  preflight on stream paths (`src/core/audio-stream-server.ts:468-492`); checked with curl and the
  browser. The web dev server's audio proxy is removed.
- [x] `status.httpUrl` is hard-coded to `http://localhost:<port>` (`src/core/live-demodulator.ts:464`),
  wrong for a remote browser. Protected mode advertises `access.publicOrigins.analogAudio` on main
  (16d6df7e, `src/index.ts:814`); legacy fixed by 01d796a1: optional `liveDemod.publicOrigin`
  (`WAVEKIT_LIVE_DEMOD__PUBLIC_ORIGIN`, canonical origin, config only). Unset it stays localhost; the
  web app then swaps a loopback stream host for the page's host when the page is not on loopback.
  Digital voice streams in legacy mode still advertise localhost; `docs/API.md` does not list the key yet.
- [ ] The noise floor restarts from the first block after a retune (`src/core/live-demodulator.ts:768`,
  `:623`): tuning onto a carrier already up sets the floor to the carrier, so auto squelch stays closed.
  Still so on main. Workaround on WG7 cores: `squelchMode: "noise"` (NFM, WFM), offered by the web app.
- [ ] `PATCH /api/live-audio/config` out-of-range offset 400 has no `code`
  (`src/api/routes/live-audio.ts:389-395`); while stopped the same PATCH is accepted and the next start
  fails with `CHANNEL_OFFSET_OUT_OF_RANGE`. Both still so on main (checked with curl).
- [x] Identify reports decoders whose binary is missing as `no-sync` (`src/core/scanner/identify.ts:461`,
  `job-runner.ts:229`); one job went `candidate` then back to `trying` (`identify.ts:1384`). The first
  is still so on main (every dsd-fme trial "No sync" here); the bounce did not recur in the re-check.
  Fixed in core (WG12: `unsupported` with reason `decoder-unavailable`, listed in `proof.unavailable`).
- [ ] "Decode as…" (web app) is Identify with `protocols: [one]`, but the core keeps only protocols a
  compatible class lists (`identifyScores`, `src/core/scanner/identify.ts:279`) and never probes AIS, ACARS,
  VDL2 or LoRa. So the operator cannot force a decoder the classifier rules out: the card says "It does not
  look like DMR, so nothing was tried". Wanted: a `force` flag that runs the asked protocol's probe anyway.
- [ ] With passive scanning off, a new spectrum subscriber gets no snapshot or backfill. Still so: with
  `scanner.passive.enabled: false` and nothing else using the source the engine is idle, the ack says
  `backfillFrames: 0` and the first live frame follows about 170 ms later.

**Found by the web app, main screen pass** (2026-10-17, branch `claude/project-thread-afdtom` after merging
main f0b71383; read from the core source, not yet re-run against a live core)

- [ ] Saved frequencies (operator data) are only mounted in protected mode (`src/index.ts:1568`), so a
  default legacy core answers 404 and the web app shows "saved frequencies unavailable". The design wants
  them shared by every client whatever the access mode.
- [ ] No order field or reorder route for saved frequencies; the web app sorts by frequency.
- [ ] `PATCH /api/tuner/:sourceId/config` skips a setting equal to the placeholder value even when it is
  listed in `unknownFields` (only frequency and sample rate count as unproven), so the web app uses the
  single-setting POST routes.
- [ ] Tuner state does not say who released control (relay client or operator); the web app infers it from
  `/api/tuner-relay`. Receiver capabilities carry no `owner` / `controlMode`, and physical support for
  bias-T and direct sampling is always `unknown`.
- [ ] No read-only signal for the access role: a protected core only answers 401/403 (`AUTH_REQUIRED`,
  `CSRF_REQUIRED`) after a write is tried.
- [ ] Receiver board items with no data: dropped-samples counter, "Remove DC spike" and "IQ correction" as
  tuner settings (`liveDemod.iqDcBlock` is the nearest).

**Found by the web app, Activity pass** (2026-10-17, branch `claude/project-thread-afdtom`; read from the
core source and run against the mock, not yet against a live core)

- [ ] Typed Activity filters by field: the web app turns "TG 2081", "capcode 1234567", "MMSI …", "CTCSS
  88.5" into a plain-text term narrowed by category, because `entityKey` formats are not documented per
  decoder and there is no `field = value` filter. It can match the same number in another field.
- [ ] Text search matches whole words only (`src/core/activity/query/fts.ts`): "12345" does not find
  capcode 1234567 and "F4AB" does not find F4ABC-9. A prefix match on the last word would serve
  search-as-you-type.
- [ ] Ingestion-gap summaries carry the reason only inside the title (`Ingestion gap (rate-limited)`);
  the web app parses it. A `reason` field (and the decoder ids) on the summary would avoid that.
- [ ] No audio behind Activity rows: analog transmissions and calls carry no recording id, so the list
  has no play button and no "Play conversation" (see Recordings, "The recording id on the event").
- [ ] Pinned searches are kept per browser (localStorage) until operator preferences hold them (see
  Settings, "Activity columns and pinned searches").

**Found by the web app, Scanner pass** (2026-10-17, branch `claude/project-thread-afdtom`; read from the
core source and run against the mock, not yet against a live core)

- [x] `scanner:discovery` with `change: "merged"` names only the surviving discovery, and the absorbed one's
  `deleted` is never sent (it is emitted after the record is gone). The web app guesses the absorbed entry
  from the merge key; a `mergedIds[]` on the event would make it exact.
  Done in core (WG12 `mergedIds`): wired, the guess stays for older cores.
- [x] `progress.holdingOn` is the scheduler's hold track id, not a discovery id or a frequency. The Tuner hold
  row finds the held signal from probe targets or `scanner:activity`; a `holding: {discoveryId?, frequencyHz}`
  on progress would name the hit at once ("Hearing DMR · CC 1").
  Done in core (WG12 `progress.holding`, plus `phase` and `trial`): the plan footer and the hold row say
  the phase; the hold row still finds the held discovery as before.
- [ ] Discovery queries take one value per filter (one `protocol`, one `identity`): the search cannot ask for
  "DMR or P25", so a second chip of the same kind replaces the first.
- [ ] A discovery's own 24 h history (hourly airtime or last transmissions) for the activity strip of the
  opened row. Partly: `/discoveries/:id/observations` (paged) and `/api/spectrum/occupancy` (per 12.5 kHz bin).
- [ ] Deleting a discovery cannot be undone (no restore), so the web app asks first instead of offering Undo.

**Found by the web app, Recordings pass** (2026-10-17, branch `claude/project-thread-afdtom`; read from the
core source and run against the mock, not yet against a live core)

- [ ] The inventory (`GET /api/recordings`, WG8) and Keep / delete (WG9) mount only in protected mode, so a
  default legacy core shows "Recordings need access protection".
- [ ] No event when a recording appears, is kept or is deleted: the drawer re-reads the list every 20 s
  while it is open, and another client's Keep shows up only then.
- [ ] The file route answers without ranges (`Accept-Ranges: none`): the web app fetches the whole WAV once
  to play and seek it, and draws the waveform from the same file (no core peaks yet).
- [ ] Inventory items carry no protocol, frequency (for calls), channel or slot, and no link to the Activity
  event: the drawer names calls by talkgroup and shows "Show in Activity" as a talkgroup search.
- [ ] Scanner recordings cannot be deleted one by one (`RECORDING_DELETE_UNSUPPORTED`); the drawer points to
  deleting the discovery. Delete has no restore, so Undo holds the request for 6 s before sending it.
- [ ] `GET /api/storage` reports `kept: null`; the footer sums the kept items' sizes itself. The
  report gives no retention age for call recordings, so the drawer cannot say when calls expire.

**Found by the web app, waterfall clearing** (2026-10-17, branch `claude/project-thread-afdtom`; read from the
core source, reported against a live core)

- [ ] docs/API.md tells clients to reset the waterfall on every epoch change and every `spectrum:profile`.
  The core opens a new epoch without moving the frequency axis (gain change, same-centre hop, untracked-retune
  alarm on an unverified tuner, `src/core/spectrum/pipeline.ts` `startUntrackedEpoch`), and a reconnect acks
  the same profile again, so following the rule wiped the waterfall every few seconds. The web app now keeps
  rows while sourceId, profile, binHz, startHz and binCount hold, and drops backfill rows it already has. The
  API rule should say the same for display, and how often untracked-retune alarms fire on an unverified tuner
  is worth a look (each one also closes every track).

**Found by the web app, display preferences** (2026-10-17, branch `claude/project-thread-afdtom`; read from
`packages/api-types/src/operator-data.ts`)

- [ ] `waterfallPalette` is `phosphor | amber | mono`, but the design (DESIGN.md "Waterfall colours") offers
  Match accent, Amber, Mono and Classic, and "Phosphor" is gone (Match accent with the phosphor accent is the
  same ramp). The web app keeps Waterfall colours per browser, as DESIGN.md's "On this device" says, and does
  not read or write the core preference. To sync it, the enum would become `match | amber | mono | classic`.
  `units` and `timeFormat` are used as they are (protected mode; in open mode each browser keeps its own).

**Found by the web app, Identify on its own** (2026-10-18, branch `claude/project-thread-afdtom`; read from
`src/core/scanner/identify.ts` and `scanner-service.ts`)

- [x] The core identifies only on request (`POST /api/scanner/identify`), so a transmission on the frequency
  you sit on is never named unless you ask. The web app now asks by itself (Settings › Identify on its own,
  on by default, `web/src/features/tuned/auto-identify.ts`): when the live-audio squelch opens on a frequency
  no decoder follows, once per visit, while that browser is listening. A core-side option (identify a
  transmission on the live-audio channel when nothing decodes it) would cover the times no browser listens
  and would not depend on the squelch.
  Done in core (WG12: the live-audio channel's closed transmissions attach analog evidence to the
  matching discovery). The web app's own Identify on its own stays for digital channels.
- [x] What Identify named is kept by the web app for the session only (the card keeps "DMR · CC 0" after
  the banner is dismissed). The discovery holds it, but nothing answers "what is known at 446.925 MHz" in one
  call; a lookup by frequency (`GET /api/scanner/discoveries?nearHz=&toleranceHz=`) would let the card name a
  frequency identified before, from any browser.
  Done in core (WG12 `nearHz` / `toleranceHz`). Wired: the card names the nearest proven discovery
  (`data/near-discovery-store.ts`), or says its proof summary when it names no protocol; older cores keep
  the session answer.
- [ ] An identified digital channel is not decoded afterwards: Identify's probe stops, and no decoder follows
  the frequency, so the card says "No decoder runs on this frequency". A "Decode here" action (start the
  protocol's decoder on that channel, or follow the live-audio channel) would turn an answer into traffic.
  Partly (decoder enablement, 2026-10-21/22): built-in decoders get placements from the tuned frequency, their
  band and the band plans (`placements[]`, shown in Settings › Decoders › Runs on); nothing yet starts the
  identified protocol's decoder on that channel.
