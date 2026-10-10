# Web dashboard — core gaps

Features the web dashboard design relies on that WaveKit core does not provide yet.
Maintained on the `design/web-dashboard` branch alongside [DESIGN.md](DESIGN.md) and
the design canvas. Core team: pick items into `docs/ROADMAP.md`; when one lands,
note it here (or tell the design session) so the item can be ticked.

Format: `- [ ] item` — tick (`- [x]`) once it is in core on `main`.

**Spectrum**
- [ ] FFT stream for spectrum and waterfall, including zoom (higher-resolution FFT of the
  viewed slice).
- [ ] Low-latency tuner control over WebSocket (REST only today); drag-to-pan retunes the centre.

**Tuner**
- [ ] Gain table per tuner (only an index is exposed) and a sample-rate presets list
  (only range validation today).
- [ ] DC removal (the old flag is ignored), IQ correction, IQ swap.

**Audio**
- [ ] One WebSocket audio stream with analog and decoded voice auto-routed (today: HTTP
  8081 analog, HTTP 8082 digital, clients dropped on rate change, rate not a clean 48 kHz).
- [ ] Auto squelch (client can derive it), noise squelch; non-threshold changes restart the pipeline.
- [ ] Configurable AGC (off/slow/fast, and any AGC on FM), real noise reduction, noise
  blanker, notch, CW BFO, real DSB.
- [ ] Analog audio recording (digital per-call WAV exists).
- [ ] CTCSS and DCS detection on analog channels (sub-audible tone below 300 Hz, DCS
  code at 134.4 bit/s): report the tone on transmission events and live status, store it
  with saved frequencies, and offer tone squelch (open only on the detected tone).

**Data and Activity**
- [ ] Saved frequencies stored in core, shared by all clients.
- [ ] Signal history per frequency (auto band map).
- [ ] Common decode envelope: category, title, fields, frequency, raw JSON.
- [ ] Persistent, searchable event store (full text including transcripts) with paging.
- [ ] Auto-record all audio (analog transmissions and digital calls), retention, playback by id with seek.
- [ ] Analog transmission events (start, end, duration) from squelch.
- [ ] Transcription pipeline (future): per-recording transcript and status.
- [ ] Operator settings in core, synced to every client including mobile (also command
  history for palette ranking).
- [ ] Live event push with replay from a cursor, so paused or reconnecting clients catch up.
- [ ] DMR talker alias and error rate in call events (verify what dsd-fme exposes).
- [ ] Authentication and origin policy before any browser UI ships (already on the roadmap).

**Map**
- [ ] Station location in core config (lat, lon, altitude; set from the UI), passed to
  readsb as `--lat/--lon`; approximate location estimated from received positions when
  unset; gpsd support later for the portable receiver.
- [ ] Position history for aircraft, vessels, APRS and mesh nodes (trails, last-hour
  replay), served with a time cursor.
- [ ] Coverage: maximum range per bearing over 24 h for ADS-B and AIS.
- [ ] Map tiles: serve a regional PMTiles extract (download and update from Settings)
  plus map glyphs (fonts) and the style; online OpenFreeMap fallback.
- [ ] Position extraction from ACARS / VDL2 (ADS-C, `POS` reports) and AIS aids to
  navigation (type 21) into the common envelope.

