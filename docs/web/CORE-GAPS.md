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

**Owner to decide first** (core specs on main lock these; the web design differs)
- Activity categories: the decode-envelope spec on main (`docs/specs/decode-envelope/`,
  req 4.4) fixes five categories (`aircraft, voice, pager, data, other`); the web design and
  the brand use eight (Voice, Aircraft, Marine, Aviation data, Paging, APRS, Sensors, Mesh)
  and also need an entity key and an optional position on the envelope. Needs a spec
  amendment or a mapping decision.
- Device names: the access spec excludes labels, kind and last seen for remembered devices
  (`docs/specs/core-access-policy/requirements.md`); Settings › Devices draws them.
- Labels for talkgroups, radio IDs, capcodes and MMSIs (TG 2081 → "Fire dispatch"), stored
  in operator data and shown wherever the number is. No board draws this yet; scanner
  discoveries have a label per emitter, not per talkgroup.

**Spectrum**
- [x] FFT stream for spectrum and waterfall: `spectrum` WS channel, per-client profile
  (0.5–25 Hz, 128–2048 bins), snapshot on join, DC and spur masks, tuning trust.
- [ ] Zoom: a real higher-resolution FFT of the viewed slice (cropping published bins is not
  zoom). Designed on main (`docs/specs/viewed-slice-spectrum/`, feasibility gates), not built.
- [ ] Per-client `fftSize` up to 16384 and `averaging` (frames or time constant) in the
  `spectrum` subscribe options (Display › FFT size, Averaging). Not covered by the
  viewed-slice spec; bins stop at 2048 today. (Profiles: default 4 per server,
  `scanner.ws.spectrumMaxProfiles` configurable 1–16.)
- [ ] Waterfall backfill: on a `spectrum` subscribe, send the last N seconds (bounded, e.g.
  ≤10 s at the client's profile) of frames marked `backfill: true` before live frames, reset
  on epoch change. Today a join gets one snapshot frame (SCANNER.md: "not a replay").
- [ ] Low-latency tuner control over WebSocket (`ClientMessage` is subscribe/unsubscribe only)
  for drag-to-pan. Depends on the ROADMAP §8 measurement of coalesced REST drag-to-tune.

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
- [ ] Configurable band plans in core, layered and resolved user edits > imports > built-in:
  built-in country packs (a CEPT / EU baseline and France first; then UK, DE, IT, ES, NL / BE, US,
  CA, AU, JP), imported plans (SDR++ JSON first, then SDR# XML, which carries mode and step, and
  Gqrx CSV) with provenance (source file or URL, author, licence, imported at, shown as
  "community, unverified"), and operator overrides (rename, re-edge, hide, add) kept as a layer
  over a plan so pack updates still apply. Several plans can be active, in order. A band has
  name, edges, display group (an open set coloured by group; imported colours are hints), mode /
  bandwidth / step for tuning, scan hints (channel spacing, protocols, OBW, skip by default with
  a reason such as encrypted or already decoded), named channels with aliases and a nesting
  parent. Scan presets, spectrum lanes, Tuner suggestions and ⌘K all derive from the active
  plans; the scanner's `Bandplan` / `ScanRange` become a projection of them. CRUD, ordering and
  import endpoints; the choice of plans persisted in core. Import notes: SDR++ files put a colour
  in `type` (not a category) and lose mode / step; many rows are unnamed fillers; SDR++'s own
  plans are GPL-3.0 (compatible with AGPL-3.0, needs a notice) and uneven (its `france.json` has
  FM 80–108 and 70 cm 420–450). Prefer packs transcribed from regulator documents (ERC Report 25 /
  ECC Rec 70-03, ANFR TNRBF) and credit community files. Relation to the regional display
  registry (strict primary-source channel rows) is an open owner decision: keep it as the
  "verified" layer that plan channels reference, or extend it.
- [ ] Station country (ISO 3166) next to the coarse `region` enum (`EU|US|CA|AU|NZ|JP|CN`,
  `src/config.ts`), from config, the station location or the UI, with provenance; it picks the
  default pack. Owner, 2026-10-12: derived from the station location (reverse lookup on a bundled
  country boundary set, offline), overridable, falling back to `region` when no location is set.
  Today there is no country and no station lat / lon in core.
- [ ] Band plan model shared with the scanner (the original gap, now part of the layered model
  above): bands with
  name, edges, display group (Air, Marine, Amateur, Land mobile, PMR446, Pagers, ISM / SRD, named
  per country), default mode, bandwidth, step and protocols to try; named channels with aliases (marine ch 16 / 12,
  PMR446 ch 1–16, AIS A/B, airband guard, ACARS, VDL2). Today `/api/scanner/bandplans`
  returns `{id, region, name, ranges}` with scan ranges and rasters only. Partly (main@7743665):
  the regional display registry spec, a core registry (`src/core/regional/`) and DTOs
  (`packages/api-types/src/regional.ts`), mounted read-only at `/api/regional/families`, `/channels`,
  `/resolve` (main@6b4e5dc). The schema has sourced channel rows with scoped aliases,
  simplex / duplex and advisory mode / bandwidth / step hints, but no rows ship: the only family is
  US FRS with `dataset: null` (evidence-pending). Owner, 2026-10-12: the registry stays the
  verified layer; a plan band or channel that links to a registry row is what the UI marks
  "verified". Scanner band plans are unchanged. Still the gap: EU families (marine VHF, PMR446, airband,
  AIS / ACARS / VDL2 channels), band display groups, and one model shared with the scanner.
- [ ] Missing or wrong plans in `src/core/scanner/bandplan/builtin.ts`: Airband (118–137 MHz,
  8.33 kHz) and EU pagers 466.0–466.25 MHz (France: e*Message 466.025–466.230); 169.4–169.8 MHz
  split by use (France: 169.4–169.475 is mostly Wize, wM-Bus mode N meters, not paging; it sits
  inside `pager-vhf` 137–174 today, on the same raster); `vhf-land-mobile` 136–174 must not be
  labelled "PMR" in EU packs; `dpmr446` covers 446.1–446.2 (pre-2018 rule): PMR446 is 446.0–446.2,
  16 analogue channels at 12.5 kHz, digital at 6.25 kHz; CB 26.965–27.405 MHz (40 ch, AM / FM /
  SSB); 380–400 MHz (TETRA / INPT, encrypted) as skip by default, not a preset; a combined ISM
  433 / 868 preset if presets stay one per plan. Partly: `ism-433` (433.05–434.79) and `ism-868`
  (863–870) exist as separate EU plans.
- [ ] Band plan store details the canvas (v83) relies on: the plan stack's order and on/off as a
  synced operator setting; a per-band edit layer with field-level diff against the pack (so "Reset
  to France" and "3 edits" work, and pack updates still apply); import preview without committing,
  with a group-mapping report ("48 mapped, 13 to Other") and the imported colour kept as an
  off-by-default hint; "Check for update" on an imported URL or a pack returning bands changed /
  added / removed, applied by hand; per band a channel list with aliases and a link to the decoder
  that covers a channel. `WAVEKIT_COUNTRY` locks the country as `WAVEKIT_REGION` locks the region.
- [ ] Band plans feed the scanner: bands skipped by default (with their reason, hidden ones too)
  and channels covered by a running decoder become automatic exclusions; the fixed-channel list
  (AIS, ACARS, VDL2, APRS, Meshtastic) comes from plan channels, not a hard-coded table; a preset
  carries protocols and spacing per range (ISM 433 / 868, Pagers 169 + 466).
- [ ] Scanner follow hits (canvas v85): the demodulator follows a hit inside the current window or
  hop without retuning the hardware and returns after a hang time (today Listen only moves
  `offsetHz` on request via `/discoveries/:id/listen`); a per-job Follow hits option with a per-band
  default from the plan (voice on, data off); hits named from the plan (nearest named channel, else
  the range's raster point); `POST /api/scanner/plan` states one-hop plans explicitly (centre,
  channel count) so clients say "watching", not "sweeping".
- [ ] Scan presets in core, shared by every client: built-in presets per region from the
  band plans (name, ranges, protocols, step, dwell, sensitivity; read-only, "Save as new"),
  plus operator presets saved from the composer (name, ranges, skips, protocols, settings)
  with create / rename / update / delete.

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
- [ ] `live-audio:level` on WS at 10–20 Hz while running: `channelPowerDbfs`,
  `noiseFloorDbfs`, `squelchOpen`, `thresholdDbfs` (effective, including Auto). Partly:
  `live-audio:status` already carries `channelPowerDbfs` and `squelchOpen`, but only on
  start, stop, config change, connect and error.
- [ ] `squelchMode: manual | auto | noise` with `autoMarginDb`; threshold changes applied
  without a pipeline restart (non-threshold changes restart it today).
- [ ] Configurable AGC (off / slow / fast, and any AGC on FM; today `csdr agc -p fast` is
  hard-coded), real noise reduction, noise blanker, notch, CW BFO, real DSB.

**Analog transmissions** (one package: a squelch-delimited event carries all of these)
- [ ] Analog transmission events (start, end, duration, frequency) from squelch.
- [ ] Analog vs digital detected per transmission on shared channels (ROADMAP §5b), so
  "What you hear: Auto" switches per transmission and the event carries the mode.
- [ ] CTCSS and DCS detection on live analog audio (tone below 300 Hz; DCS code and polarity
  at 134.4 bit/s) on transmission events and live status, plus tone squelch. Partly: saved
  frequencies store a tone (ctcss, dcs code + polarity); scanner discoveries carry `ctcssHz`
  (S2, disabled).
- [ ] DTMF on the tuned analog channel: `audio:dtmf {digits, frequencyHz, startedAt,
  endedAt}`, one event per transmission (multimon-ng DTMF runs on its own input only).
- [ ] The recording id on the event (see Recordings).

**Activity and events**
- [ ] Common decode envelope, published live and stored. Partly: unmounted helper
  `src/core/activity/envelope.ts` per `docs/specs/decode-envelope/`. The web also needs the
  eight categories, an entity key (ICAO, MMSI, callsign, node id, capcode, talkgroup +
  radio), an optional position, the tone and the recording id (see "Owner to decide first").
- [ ] Persistent event store: typed filters (category, talkgroup, radio, capcode, MMSI,
  callsign or name, frequency ± channel width, CTCSS/DCS, with audio, kept), full text
  including transcripts, time range and jump to time, newest-first paging; the same store
  searches kept recordings and IQ captures. Serves Activity search, the tuned card's recent
  items, "Play the last call on TG …". Design (`docs/specs/activity-recording-catalog/`) and
  SQLite qualification only today.
- [ ] Facet counts for the current search and time range (per category, "With audio"); add
  to the catalog spec.
- [ ] Digital call metadata: DMR tier, colour code, talker alias and error rate; P25 phase and
  NAC; encryption algorithm. `DigitalVoiceCall` has protocol, talkgroup, source, slot,
  encrypted, active, start and end only; dsd-fme parses colour code and NAC internally.
- [ ] Message rate history per decoder: `decoderStatus.rateHistory` (messages per minute, last
  15) or `GET /api/decoders/:id/rate?window=15m`, for the tuned-card sparkline and decoder
  pages; today only the `eventsOut` counter.
- [ ] Auto band map for spectrum labels: per frequency bucket, the protocols decoded (by every
  decoder, not only `ScannerProtocol` ones), identity, last seen, active now. Partly:
  `/api/spectrum/occupancy` (7 days, hourly duty per 12.5 kHz) and ambient discoveries from
  the passive job (on by default, off on Pi 4-class hosts); ADS-B, AIS, ACARS, VDL2 and LoRa
  decodes never become discoveries.

**Event contract** (one replay contract, ROADMAP §4)
- [ ] Live push with a sequence number and replay from a cursor for activity events and
  scanner events, so paused or reconnecting clients catch up (only operator data has a
  revision contract; scanner WS has none, clients refetch over REST).
- [ ] `scanner:progress` at the 2 Hz the scanner spec promised (`scanner-broadcast.ts` limits
  to 1/s per job).

**Access**
- [x] Public capability bootstrap: `GET/HEAD /api/access/bootstrap` (origins, session and
  pairing availability, analog / digital audio and operator data availability).
- [x] Remembered devices list: `GET/HEAD /api/access/devices` (id, created, renewed, expires,
  current); needs a browser session.
- [ ] Browser access end to end: onboarding and renewal flow for the web client, TLS / proxy
  acceptance (`access.exposure: tls-termination` exists, not accepted), and a default
  deployment where operator data is available (default is `legacy`). Must land before browser
  controls touch the receiver (ROADMAP §4).
- [ ] Device `name` / `kind` and `lastSeenAt` (needs the access spec change, see "Owner to
  decide first").
- [ ] A read-only access role (view spectrum, activity and scanner results; no receiver
  control).

**Scanner** (S1 on main: discoveries, identify, sweeps with takeover, occupancy, listen)
- [ ] **Auto-resume that never cuts off a call** (owner, 2026-10-11: "core also waits", wants
  the best implementation; design: tuned card and Tuner island show "Scan resumes in 42 s ·
  Stay here"). Today `paused(preempted-operator)` resumes `resume.autoAfterIdleMs` (60 s) after
  the last REST tuner write, so a long call on the tuned frequency is cut off. Proposed:
  1. The idle timer measures *operator activity*, not only tuner writes: it is held while the
     operator's demodulator squelch is open (plus a short hang, e.g. 3 s after it closes),
     while an identify trial runs on the leased source, and while a manual recording runs; it
     restarts from full when the activity ends.
  2. Job status and `scanner:job` WS events carry `resumeAt` (ISO time, or `null` while held)
     and `resumeHeldBy` (`audio` | `identify` | `recording` | `null`), so every client shows
     the same countdown and "Scan waits while you listen".
  3. "Stay here": `POST …/pause` on a job in `paused(preempted-*)` turns it into
     `paused(operator)` (no auto-resume) without needing the lease back. Needs a new transition:
     today `pause` is accepted only from running or holding (`job-state.ts`).
- [ ] Search discoveries by identity: an `identity` (kind:value) filter, and `q` matching
  identity values as well as labels. Partly: `protocol`, frequency range, confidence and
  `minConfidence`, `encrypted`, `since`, `sourceId` and `jobId` filters exist; `q` matches the
  operator label only.
- [ ] `ScannerProtocol` values for what the composer offers: `ais`, `acars`, `vdl2`, `lora`
  (Meshtastic); CTCSS/DCS as a searchable feature, not a protocol. DSC has no decoder at all.
- [ ] Per range: a `name`, `dwellMs` and `sensitivity` with provenance keys
  (`ranges[i].…`), and exclusions per range (today rasters, `obwHz`, `protocols` and
  `bandplanId` are per range; dwell, sensitivity and exclusions per job). Partly: job provenance
  (`operator|bandplan|measured|config|default`) and the plan preview's derived numbers
  (`hops`, `sweepPeriodMs`, estimates) from `POST /api/scanner/plan` have landed.
- [ ] A job-level "signals only" flag (no decoder trials) for "Find signals, don't decode".
- [ ] Edit ranges in a running job: allow `ranges[i].enabled` and `ranges[i].protocols` in
  `PATCH /api/scanner/jobs/:id`, applied at the next hop like the other live keys. The running
  plan pane batches range on/off, per-range protocols and skips behind one Apply; edges and
  channel spacing stay locked while running ("Stop to change edges"). Partly: the PATCH
  live-edits `thresholdDb`, `sensitivity`, `exclusions` (skips), `hold`, `revisit`, `record`,
  `protocols` and `capture`, but `protocols` is job-wide and overrides every range; a `ranges` key
  passes validation and is silently dropped; `ranges[i].enabled` does not exist. Depends on per-hop
  protocols (next item). (requested 2026-10-11, widened 2026-10-12, needed for Scanner › running plan pane,
  priority normal)
- [ ] Ignore that also skips the frequency in sweeps (Ignore = this signal, always). Today a
  lockout stops probes, recordings and monitor audio, but the planner only honours job
  exclusions. Skip (this scan only) maps to a per-job exclusion.
- [ ] Plan preview marks ranges covered by running decoders (`decodedElsewhere[]`) with an
  optional `skipDecodedElsewhere` default. Partly: `GET /api/decoders` exposes
  `targetFrequenciesHz` and band ranges.
- [ ] Per-job hit stats for the live hit log: `hitsInJob`, `firstHeardInJob`,
  `lastDurationMs` (or a `jobId` filter on `/discoveries/:id/observations`), and
  `firstSeenInJob: boolean` on discovery events for the one-shot "new" pulse. Global
  `firstSeenAt`, `lastSeenAt`, `observationCount` and `airtimeMs` exist.
- [ ] Watch here protocols: a persisted per-source `passive.protocols` setting (the passive
  job tries every protocol today).
- [ ] `preemptedBy: {jobId, name}` on `paused(preempted-job)`.
- [ ] Optional `discoveryId` on saved frequencies; the discovery DTO lists
  `savedFrequencyIds`.
- [ ] S2 enabled (parallel identify trials, "Likely", CTCSS, analog recordings) and S3
  listen-scan ("Scan a list") for the later Scanner mode.
- [x] Decoder IDs in a sweep's impact (`Impact.runningDecoders`, `pinnedDecoders`); the UI
  maps IDs to display names.
- [ ] Per-range protocols honoured per hop: each hop tries the union of the protocols of the
  ranges covering it (so Marine VHF tries FM voice only while the PMR stretch around it tries DMR,
  P25, …), with job-level `protocols` as an explicit override; plus a test. The planner's range
  table and running pane show protocols per range. Partly: overlapping ranges are swept once
  (`rasterItems` dedupes channels by Hz, `hop-planner.ts`), but at runtime a job without
  `protocols` gets the union of every range's protocols job-wide (`plan-preview.ts`), and probes use
  that list (`job-runner.ts`); the per-hop branch of `hopProtocols` only feeds the preview
  estimate. (Ticked 2026-10-11 in error; reopened 2026-10-12, needed for Scanner › planner range
  table, priority normal)

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
  points stored on the item, applied on play and download).
- [ ] Operator IQ capture of the viewed span (8-bit IQ, ~4.8 MB/s at 2.4 MS/s): start and stop
  with a maximum length, live elapsed time and size, what was decoded during it; playback as a
  source with seek and "back to live" (spectrum, audio and every decoder run on it); export
  as SigMF or .cu8. Partly: scanner burst captures and a config-only file `recording` source.
- [ ] Waveform peaks for every audio recording and a spectrogram thumbnail for every IQ
  capture, computed once by core.
- [ ] `GET /api/storage`: kept, automatic and other bytes, free, effective retention, the
  low-space policy. Partly: scanner status `disk-low` and scanner storage caps.
- [ ] Stable `GET /api/recordings/:id` and `…/download?format=opus|wav&trim=1`.
- [ ] Transcription pipeline (future): per-recording transcript and status.

**Map**
- [ ] Current state for fleets other than aircraft (only ADS-B has a tracker): AIS vessels
  (position merged with static and voyage data), APRS stations (path, weather, altitude),
  Meshtastic nodes (name, role, SNR/RSSI, hops), with counts, latest and last heard.
- [ ] Meshtastic links with SNR (neighbour info, relays).
- [ ] Position history for aircraft, vessels, APRS and mesh nodes (trails, last-hour replay)
  with a time cursor, plus per-minute activity counts for the timeline (depends on the event
  store; ADS-B trails are in memory only).
- [ ] Coverage: maximum range per bearing over 24 h for ADS-B and AIS.
- [ ] Map tiles: a regional PMTiles extract (200 / 400 / 800 km with size, download and update
  from Settings with progress) plus glyphs and the style; online OpenFreeMap fallback.
- [ ] Position extraction from ACARS / VDL2 (ADS-C, `POS` reports) and AIS aids to navigation
  (type 21) into the common envelope.
- [ ] Optional: aircraft route and military flag (enrichment has registration, type, operator).

**Settings and station**
- [ ] Station identity in core config: `station.{name, lat, lon, altM, region, callsign}`
  with provenance, set from the UI, passed to decoders (readsb `--lat/--lon` today only under
  `enableMlat`; direwolf `callsign` parsed, never used; lora-meshtastic's second `region`);
  approximate location estimated from received positions when unset; gpsd later for the
  portable receiver. (ROADMAP: can ship early.)
- [ ] Settings store in core: a persisted layer over the YAML (in `stateDir`), validated writes
  over the API, live push of every change to all clients, each value reporting its source
  (default, YAML, environment, UI) so the UI can lock what env or YAML pins. Partly: decoder
  band overrides, scanner settings (the model: provenance, bounds, PATCH) and operator
  preferences persist. Decide whether operator preferences (below) live in this store.
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
- [ ] `GET /api/decoders/:id/log?lines=200` (bounded stdout/stderr ring) for "Show log".
  Decoder status itself has landed (health, uptime, version, events out, last output, error).
- [ ] The sdr-host version on `/api/resources/sdr-hosts` (startup rate and gain are there).
- [ ] Configuration export and import (YAML), update check.
