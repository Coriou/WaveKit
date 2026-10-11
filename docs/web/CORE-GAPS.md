# Web dashboard — core gaps

Features the web dashboard design relies on that WaveKit core does not provide yet.
Maintained on the `design/web-dashboard` branch alongside [DESIGN.md](DESIGN.md) and
the design canvas. Core team: pick items into `docs/ROADMAP.md`; when one lands,
note it here (or tell the design session) so the item can be ticked.

Format: `- [ ] item` — tick (`- [x]`) once it is in core on `main`. "Partly:" says what
already exists, so only the rest is the gap.

**Audited 2026-10-11** against `origin/main` (scanner S1 accepted, channelizer merged
but off, operator data and the protected access runtime mounted). One fact behind several
lines: `config/default.yaml` runs `access.mode: legacy`, where operator data is not
mounted; anything marked *protected mode only* is unreachable in a default deployment.

**Spectrum**
- [x] FFT stream for spectrum and waterfall: `spectrum` WS channel, per-client profile
  (0.5–25 Hz, 128–2048 bins), snapshot on join, DC and spur masks, tuning trust.
- [ ] Zoom: a real higher-resolution FFT of the viewed slice (cropping the published bins
  is not zoom), plus FFT size up to 16384 and averaging per client (Display › FFT size,
  Averaging); profiles stop at 2048 bins today and the server allows 4 profiles in all.
- [ ] Waterfall backfill: the last few seconds of rows on subscribe, so the waterfall is
  not empty on open or reconnect (today a join gets one snapshot frame).
- [ ] Low-latency tuner control over WebSocket (REST only today); drag-to-pan retunes the
  centre. Core first measures coalesced REST drag-to-tune (ROADMAP §8).
- [ ] One regional band plan for display, served by core and shared with the scanner:
  band names and edges, default mode, bandwidth and step per band, named channels with
  aliases (marine ch 16 / 12, PMR446 ch 1–16, AIS A/B, airband guard, `acars`, `vdl2`),
  so typed entry, the palette and spectrum band labels agree. `/api/scanner/bandplans`
  has scan ranges and rasters only.

**Tuner**
- [ ] Tuner capabilities: gain table in dB (only `gainCount` and an index today),
  sample-rate presets (only range validation today), tuning range ("This receiver tunes
  24 MHz to 1.9 GHz"; HF only with direct sampling), and which controls apply to this
  tuner (offset tuning on E4000 only, bias-T).
- [ ] DC removal (the old flag is ignored), IQ correction, IQ swap. The spectrum already
  masks the DC spike and spurs for display and detection, but nothing corrects the samples.

**Audio**
- [ ] One WebSocket audio stream with analog and decoded voice auto-routed, a clean
  48 kHz rate and its pipeline latency (Listen "Latency ≈ 180 ms"). Today: HTTP 8081
  analog, HTTP 8082 digital, clients dropped on rate change.
- [ ] Live level and squelch state over WebSocket at meter rate: channel power, noise
  floor, open or closed, the threshold in use (including Auto's). Today `channelPowerDbfs`
  and `squelchOpen` exist only in REST `GET /api/live-audio/status`.
- [ ] Auto squelch (client can derive it), noise squelch; non-threshold changes restart
  the pipeline.
- [ ] Configurable AGC (off/slow/fast, and any AGC on FM), real noise reduction, noise
  blanker, notch, CW BFO, real DSB.
- [ ] Live analog audio recording (Listen › Record and auto-record). Partly: the scanner's
  S2 analog recorder exists but is disabled; digital per-call WAV exists.
- [ ] Analog vs digital detected per transmission on shared channels (ROADMAP §5b), so
  "What you hear: Auto" switches per transmission and the event carries the mode.
- [ ] CTCSS and DCS detection on analog channels (sub-audible tone below 300 Hz, DCS
  code at 134.4 bit/s): report the tone on transmission events and live status, and offer
  tone squelch (open only on the detected tone). Partly: saved frequencies store a tone;
  scanner discoveries carry `ctcssHz` (S2, disabled) but DCS is presence only.
- [ ] DTMF on the tuned analog channel: one event per transmission with all its digits
  and the frequency (multimon-ng DTMF exists, but only on its own input).

**Data and Activity**
- [x] Saved frequencies stored in core, shared by all clients: operator data (name,
  frequency, mode, bandwidth, tone, group; max 256; live on the `operator-data` channel).
  *Protected mode only* — see Access.
- [ ] Operator settings in core, synced to every client including mobile. Partly
  (protected mode only): preferences (units, time format, waterfall palette, saved-
  frequency tags) and command usage for tune, identify, listen and open-saved. Missing:
  Activity columns and pinned searches, usage for every palette command, scope and value
  (frecency ranks them all), language, download format.
- [ ] Auto band map: what was decoded where (protocol, identity, last seen, active now)
  for spectrum labels. Partly: `/api/spectrum/occupancy` (7 days, hourly duty per
  12.5 kHz) and scanner discoveries; confirm discoveries are kept from ambient decodes
  without a scan job.
- [ ] Common decode envelope, published live and stored. Partly: an unmounted helper in
  `src/core/activity/envelope.ts`. The UI also needs the eight Activity categories (voice,
  aircraft, marine, aviation data, paging, APRS, sensors, mesh; core has five), an entity
  key (ICAO, MMSI, callsign, node id, capcode, talkgroup + radio), an optional position,
  the tone (`ctcssHz`, `dcs`) and the recording id.
- [ ] Persistent event store: typed filters (category, talkgroup, radio, capcode, MMSI,
  callsign or name, frequency ± channel width, CTCSS/DCS, with audio, kept), full text
  including transcripts, time range and jump to time, newest-first paging. Serves
  Activity search, the tuned card's recent items, "Play the last call on TG …" and "Play
  conversation". Design and SQLite qualification only today.
- [ ] Facet counts for the current search and time range (per category, "With audio").
- [ ] Live event push with replay from a cursor, so paused or reconnecting clients catch
  up (only operator data has a revision contract; scanner WS has no replay).
- [ ] Recording state on every event: recorded (with its id), recording now, not recorded
  (auto-record off), no audio (encrypted); plus the live global mode (all / digital
  calls / off) for the "Recording all audio" pill.
- [ ] Auto-record all audio (analog transmissions and digital calls), retention, playback
  by id with seek. Only digital per-call WAV and scanner evidence WAVs exist (plain
  download, no catalog).
- [ ] Analog transmission events (start, end, duration) from squelch.
- [ ] Transcription pipeline (future): per-recording transcript and status.
- [ ] Digital call metadata: DMR tier, colour code, talker alias and error rate; P25 phase
  and NAC; encryption algorithm. Calls carry talkgroup, source, slot, encrypted and
  start/end only; dsd-fme parses colour code and NAC internally.
- [ ] Message rate history per decoder (per minute, last ~15 min) for the tuned-card
  sparkline and decoder pages; today only running counters.

**Access**
- [ ] Browser access. Partly: the protected runtime landed (pairing, 30-day sessions,
  origins on REST/WS/audio, device revoke), opt-in. Missing for the web: browser
  onboarding and renewal, a public bootstrap / capability endpoint (`getAccessBootstrap()`
  is internal), TLS/proxy acceptance, and a default where operator data is available.
  Must land before browser controls touch the receiver (ROADMAP §4).
- [ ] List signed-in devices (name, kind, last seen, this device); only revoke exists.

**Recordings**
- [ ] Keep (star) a recording: exempt from retention, synced to every client; un-keeping
  returns it to normal retention. (Scanner discovery `keep` protects all of an emitter's
  evidence at once; not per recording.)
- [ ] Manual recordings (Listen › Record) with name, note and a non-destructive trim
  (in/out points stored on the item, applied on play and download).
- [ ] Operator IQ capture of the viewed span (8-bit IQ, ~4.8 MB/s at 2.4 MS/s): start and
  stop (palette, Receiver) with a maximum length, live elapsed time and size, a summary of
  what was decoded during it; playback as a source with seek and "back to live"
  (spectrum, audio and every decoder run on it); export as SigMF or .cu8. Partly: scanner
  burst captures (owned by scanner jobs) and a config-only file `recording` source.
- [ ] Waveform peaks for every audio recording and a spectrogram thumbnail for every IQ
  capture, computed once by core.
- [ ] Search over kept items (manual recordings and IQ captures, not only events): name,
  note, transcript, talkgroup, frequency, kind.
- [ ] Storage endpoint: kept, automatic, other files, free, current retention (and whether
  it was shortened because space is low), the low-space policy. Partly: scanner status
  says `disk-low` and scanner storage caps exist.
- [ ] Recording deep links (open one recording in any client) and download with Opus / WAV
  transcode of the trimmed part.

**Map**
- [ ] Station location in core config (lat, lon, altitude; set from the UI), passed to
  readsb as `--lat/--lon`; approximate location estimated from received positions when
  unset; gpsd support later for the portable receiver. (ROADMAP: can ship early.)
- [ ] Current state for fleets other than aircraft (only ADS-B has a tracker): AIS vessels
  (position merged with static and voyage data), APRS stations (path, weather, altitude),
  Meshtastic nodes (name, role, SNR/RSSI, hops), with counts, latest and last heard.
- [ ] Meshtastic links with SNR (neighbour info, relays).
- [ ] Position history for aircraft, vessels, APRS and mesh nodes (trails, last-hour
  replay), served with a time cursor, plus per-minute activity counts for the timeline.
- [ ] Coverage: maximum range per bearing over 24 h for ADS-B and AIS.
- [ ] Map tiles: serve a regional PMTiles extract (area choices 200 / 400 / 800 km with
  size, download and update from Settings with progress) plus glyphs and the style;
  online OpenFreeMap fallback.
- [ ] Position extraction from ACARS / VDL2 (ADS-C, `POS` reports) and AIS aids to
  navigation (type 21) into the common envelope.
- [ ] Optional: aircraft route and military flag (enrichment has registration, type,
  operator).

**Settings**
- [ ] Settings store in core: a persisted layer over the YAML (in `stateDir`), validated
  writes over the API, live push of every change to all clients. Each value reports its
  source (default, YAML, environment variable, UI) so the UI can lock what env or YAML pins.
  Today only decoder band overrides, scanner settings and operator preferences persist;
  the scanner settings API (provenance, bounds, PATCH) is the model to generalise.
- [ ] One settings schema for core and every decoder: Zod plus UI hints (label, help,
  group, essential or More, effect: live / restarts X / reconnects / hardware, aliases,
  widget, unit), served to clients as JSON Schema so a new decoder needs no UI work.
- [ ] Decoder options validated at the boundary (only lora-meshtastic does today) and
  editable at runtime (`PATCH /api/decoders/:id` returns 501); batched apply that restarts
  only what changed.
- [ ] Station identity owned by core (name, location, altitude, region, callsign) and passed
  to decoders, replacing readsb `lat`/`lon`, direwolf `callsign` (parsed, never used) and the
  second `region` in lora-meshtastic.
- [ ] New settings the design adds: language, FFT size and averaging, spectrum range,
  auto-squelch margin, record automatically (all / digital / off), global recording
  retention and size cap (today only dsd-fme per-call and scanner limits), behaviour when
  space is low, audio download format, IQ maximum length and format, trail length, record
  coverage, map labels, offline area, runtime log level. (Units and time format landed as
  operator preferences.)
- [ ] Decoder log tail (last N lines of output or stderr) for "Show log". Decoder status
  itself has landed (health, uptime, version, events out, last output, last error).
- [ ] Pi host details: sdr-host version, its startup rate and gain.
- [ ] Configuration export and import (YAML), update check.

**Owner to decide first**
- Labels for talkgroups, radio IDs, capcodes and MMSIs (TG 2081 → "Fire dispatch"),
  stored in operator data and shown wherever the number is. No board draws this yet;
  scanner discoveries have a label per emitter, not per talkgroup.
