# Web dashboard — design log

Living record of the web dashboard design phase. The design itself lives on the
canvas; this file holds the why, the open questions and the core gaps, so every
session and every machine can pick the work up.

- **Canvas:** https://claude.ai/artifact/Mr2W34vvZxc8tGFCdMvZHE (private to the owner until shared)
- **Status:** design phase, nothing implemented. The old local web dashboard was discarded.
- **Started:** 2026-10-10

## How we work

- All design work lives on the **`design/web-dashboard`** branch, pushed to GitHub.
  Merge `origin/main` in at the start of each session (and whenever core lands
  something relevant) so the design tracks the real core:
  `git fetch origin && git merge origin/main`.
- The core team reads [CORE-GAPS.md](CORE-GAPS.md) on this branch and picks items
  into `docs/ROADMAP.md`.
- One topic per design session. Start with "continue the web design: <topic>";
  the agent reads this file and the relevant canvas boards first.
- Feedback between sessions goes in canvas comments; the next session reads them.
- At the end of a session, update the decision log, open questions and core gaps here.
- A board is **frozen** only when the owner says so; frozen boards are not redesigned
  without an explicit ask.
- The canvas boards (`*.dc.html`) are interactive references, not production code.
- After every canvas update, the boards are copied to [canvas/](canvas/) and committed
  with the docs, so the design has history and a backup. The canvas stays the source of
  truth; the copies are read-only snapshots.

## Goal

An SDR++-class receiver in the browser (and later a mobile app) with a far more
refined UI, plus everything WaveKit decodes: listen to the air, see emissions,
and read what was decoded. Full screen on desktop, clutter free, inspired by the
Pi image UI, using the brand in `packages/brand` (ink/phosphor palette, D-DIN
Condensed + Noto Sans, Tabler-based icons).

## Canvas map

| Board | What it is | State |
| --- | --- | --- |
| A · Instrument, B · Console | Earlier shell directions | Rejected, kept for reference |
| C · Immersive | **Chosen shell.** Full-bleed spectrum, floating glass islands | Active |
| Spectrum + waterfall | Live mock with every decoded signal type at a realistic frequency: zoom, pan, retune past the capture edge, drag VFO / band edges, saved-frequency tags, squelch line | Active |
| Tuned-signal card | What is on the tuned frequency: one anatomy for every signal type | Active, reworked |
| Tuned card, every signal type | Gallery of the card for all 18 mocked signals (voice, fleets, messages, sensors, audio only, unknown) | Active |
| Tuner island | Digit tuning, typed entry with suggestions, mode, bandwidth, step, saved frequencies | Active |
| Receiver island | Sample rate, gain table, AGC, bias-T, PPM, advanced (direct sampling, DC removal, IQ correction) | Active |
| Listen island | Listen, squelch meter with auto/off, volume, analog vs decoded voice, AGC, filters, record | Active |
| Decoded messages + Decode card | One card anatomy for every decoder; JSON fallback for unknown rtl_433 models | Active |
| JSON viewer | Syntax colours, wrap, copy pretty / one line | Active |
| Activity | Search with typed chips, multi-column, detail pane, audio replay, transcripts, live feed | Active, polished once |
| Map | Everything with a position around the station on a real Brittany coastline: layer rail, overlays and legend, collision-free labels, cluster chooser, location setup, last-hour replay chip, tile source. Wired into C (Map in the dock) | Active, second pass |
| Recordings | What you kept: day-grouped list, rows that open in place with waveform + trim (or an IQ thumbnail), name and note, transcript, download / copy link; shared player; IQ "play as source"; storage line; live manual recording. Wired into C (Recordings in the dock); Keep (S) added to Activity | Active, first pass |
| Command palette (⌘K) | Tune, change any setting, act on Activity; nested scopes, live preview, frecency, undo. Wired into C (⌘K in the dock) | Active, first pass |
| Orange "CORE GAPS" sticky | Visual copy of CORE-GAPS.md | Mirror |

## Decision log

- **Shell: direction C (Immersive).** The spectrum is the app; chrome floats over it
  as "liquid glass" islands (translucent, heavy blur + saturation, light top edge).
  Tuner top-left, Receiver top-right, Listen bottom-left, nav dock bottom-centre,
  tuned card or Activity on the right. Only one island panel open at a time.
  *Why:* closest to "SDR++ but beautiful"; keeps the signal visible at all times.
- **Audio follows tuning, like SDR++.** No pinned second channel. *Why:* one tuner,
  and it matches operator expectations.
- **Spectrum interaction.** Click tunes and snaps to the nearest signal; plain scroll
  steps; ⌘/pinch zooms around the cursor; drag pans and retunes the hardware at the
  capture edge; tuning outside the capture recentres. Band edges are draggable once
  zoomed in. *Why:* the band was too thin to grab at full span, and the operator must
  be able to move anywhere without leaving the spectrum.
- **Frequency entry.** Digits step by place value (click top/bottom half, scroll,
  arrows); typing opens assisted entry that accepts MHz, kHz, GHz, relative steps
  (`+25k`), channels (`ch 16`, `pmr 3`, `ais`) and saved names, with band and mode hints.
- **Saved frequencies are first-class** and stored in core, shared by every client.
- **All operator settings live in core** and sync across clients, including the
  planned mobile app: Activity columns, pinned searches, recording preferences, saved
  frequencies.
- **Squelch UX.** Signal level and threshold on one bar; drag the line above the
  noise; Auto keeps it 6 dB over the floor. Also drawn as a dashed line on the spectrum.
- **Analog and digital audio.** "What you hear: Auto / Analog / Decoded voice";
  Auto plays decoded voice when present, demodulated audio otherwise.
- **Decoded messages.** One card anatomy (protocol, time, title, optional text,
  fields, map, audio, transcript, JSON). Unknown JSON is humanised automatically
  (`temperature_C` → "18.4 °C"). *Why:* rtl_433 alone has hundreds of models.
- **Activity is the central panel.** One search field with typed suggestion chips
  (talkgroup, capcode, MMSI, frequency, name, anywhere), category chips, "With audio";
  columns are pinned searches; detail pane with related items and "Play
  conversation"; replay of auto-recorded audio with a player (speed, auto-next; live
  audio pauses while replaying); transcript slot ready for future auto transcription;
  pause with "N new" count; keyboard navigation.
- **Search is allowed in Activity.** The early "no text filters" rule applies to the
  rest of the UI; Activity search is explicitly wanted.
- **Mock spectrum covers every decoder.** Realistic EU/Brittany frequencies:
  FM broadcast 88–105 MHz (audio only), airband AM voice 118.1 (carrier only while
  keyed) and continuous ATIS, ACARS 131.525/.725/.825, VDL2 136.725–136.975, APRS
  144.800, 2 m voice, marine ch 16/12, POCSAG 160.450, NFM, DMR 161.150, AIS A/B,
  P25 163.0875 (encrypted), LPD 433.075, ISM 433.92, PMR446 ch 1/3/8, an undecoded
  pager network at 466.025, LoRaWAN 868.1, ISM 868.3, wM-Bus 868.95, Meshtastic
  869.525, ADS-B 1090 (dense 2 MHz pulses). The Tuner and palette know these
  channels (`acars`, `vdl2`, `tower`, `guard`, `wmbus`, `p25`, `fm`). *Why:* test the
  UI against every kind of emission, not just a few VHF signals.
- **Tuned card reworked (one anatomy for every signal type).** The old card was tall,
  repeated the Listen meter, buried the useful bit in a box inside the card, had no
  frequency and no actions. Now:
  header (type icon, protocol + mode, live state with call timer, frequency, 5-bar
  signal glyph; level, SNR and decoder in its tooltip) → a "now" block whose content
  depends on the kind → up to two earlier items (four in the panel variant), with
  inline play for recordings → actions (Play last / Replay, Map for fleets and APRS,
  Activity, Save, Pin; Identify for unknown signals).
  Kinds: *call* (talkgroup, radio, live transcript, encrypted state with a lock and
  no play), *tx* (analog voice: live timer and level, or the last transmission with
  its transcript), *count* (AIS, ADS-B: number in range, latest or nearest, message
  rate sparkline), *msg* (pager, ACARS, VDL2, APRS, Meshtastic, sensors: who/what in
  bold, the message in full up to 3 lines, readings as chips), *audio* (broadcast FM,
  no decoder), *unknown*. The card is a fixed 320 px wide and grows to fit its
  content, never past three lines of message text, so it works for every type; anything wider (maps, tables) stays in
  Map or Activity.
- **Card and Activity refinements (owner review).** Card: no more "Talkgroup / TG
  2081 / → TG 2081" triple; the talkgroup is the title, the radio the line below. The
  call timer lives in the state line, not as a red number (red read as an error).
  Earlier rows are shorter and no longer truncate. Actions sit on one row (primary +
  Activity + icon-only Save and Pin). The inner box has no border; the level bars are
  solid. Activity: the play button's focus ring sits on the circle, filter chips wrap
  in the drawer instead of running off the edge, the player bar wraps its speed /
  auto-next / close group so the time no longer overlaps, and "Recording all audio" is
  a quiet pill with a red dot instead of a red outline.
- **CTCSS and DCS tones are first-class for analog voice.** Shown as a chip on the tuned
  card (`CTCSS 88.5 Hz`, `CTCSS 77.0 Hz · code 4` on PMR446, `DCS 023 normal`), in the
  Activity row subtitle, in the spectrum labels, and in the raw event (`ctcssHz`, `dcs`).
  Activity search understands `88.5`, `ctcss 88.5`, `dcs 023` as typed filters. Listen
  shows "Tone squelch · CTCSS 88.5 Hz detected" with a switch to open only on that tone.
  Mock: NFM 160.625 (88.5), PMR446 ch 1 (77.0), NFM 161.425 (DCS 023N), 2 m repeater
  145.6375 (123.0). *Why:* owner request; tones identify users sharing a channel.
- **Map board, first pass.** The canvas cannot run MapLibre or fetch tiles, so the board
  draws a live 2D mock in the intended style with a simplified Brittany / Channel
  coastline (illustrative geometry, not survey data). Drawn:
  - *Layers* chip island at the top (Aircraft, Vessels incl. aids to navigation, APRS,
    Mesh, ACARS position reports) with counts; *Overlays* menu: range rings, coverage
    (furthest reception per bearing, ADS-B and AIS), trails, labels, mesh links by SNR.
  - *Glyphs:* aircraft as plane shapes rotated by track and coloured by altitude
    (amber → phosphor → white, legend bottom right); vessels as hulls rotated by course,
    a dot when moored; AtoN diamonds; APRS dots, weather stations as squares; mesh
    hexagons with dashed links; ACARS/ADS-C reports as dashed amber diamonds labelled
    with their age. Positions move by dead reckoning; trails fade.
  - *Interaction:* drag to pan, scroll or double-click to zoom around the cursor,
    hover tooltip, click to select. The selection panel (right) shows fields, distance and
    bearing from the station, source decoder and freshness, Follow and Activity.
  - *Station:* pulsing marker; approximate state (tweak `location`) shows a dashed
    amber area and a "Station location is approximate · Set it" chip. The location
    panel offers pick on the map, browser location, coordinates or a Maidenhead
    locator, with a live parse and the privacy note.
  - *Replay:* timeline island with a last-hour histogram; scrubbing moves everything
    back in time; "Back to live".
  - *Tiles:* footer says which source is in use (tweak `tiles`: offline extract,
    online OpenFreeMap with "Download for offline", or downloading with progress) plus
    © OpenStreetMap.
  In C · Immersive, Map replaces the spectrum backdrop; Tuner, Receiver and Listen stay,
  the tuned card hides.
- **Map: decisions before design (owner, 2026-10-10).**
  - *Station location:* core has none today (no lat/lon in config, readsb runs without
    `--lat/--lon`, no GPS on the Pi). Order of sources: a location set once and stored
    in core (pick on the map, type coordinates or a Maidenhead locator, or "use this
    browser's location"; also asked on the Pi first-boot page) → an estimate from what
    is received (centroid of decoded positions, shown as approximate) → USB GPS via
    gpsd later for the portable receiver. Never sent anywhere; readsb gets it too.
  - *Backend:* MapLibre GL JS with our own style (vector tiles, WebGL). Tiles both ways:
    a regional Protomaps PMTiles extract served by core (works offline, no provider sees
    the location) and OpenFreeMap online until the extract is downloaded, with the UI
    saying which is in use. Glyphs generated from D-DIN and Noto Sans, served by core.
    OSM attribution kept, discreet.
  - *Look:* minimal, the spectrum's language: ink land, darker sea, thin phosphor
    coastlines, faint graticule, few labels; the data dominates.
  - *Content:* everything that has a position: ADS-B aircraft, AIS vessels and aids to
    navigation, APRS stations, weather and balloons, Meshtastic nodes and links, ACARS
    and ADS-C position reports; range rings, real coverage, trails, replay of the last
    hour.
- **Map refinement (second pass, 2026-10-10).**
  - *Mocks stay in Brittany.* The station is really in Toulouse, but the owner keeps
    the Roscoff mock on purpose: it exercises vessels and AIS, which Toulouse cannot.
    The complaint about the first pass was the invented geometry, so the coastline is
    now real: Natural Earth 10m (public domain) for the wide area and OSM coastline
    (ODbL) simplified to ~50 m in a box around Roscoff (Île de Batz, Bay of Morlaix,
    Bloscon). Place names sit at their real coordinates. Every vessel position and
    every point of its past hour was checked against that coastline: ferries and the
    Batz shuttle leave from a real berth and sit there before departing, and nothing
    crosses land during replay. The other boards keep their Brittany data.
  - *Controls respect the islands.* Layers moved from a top chip bar (which collided
    with the Tuner) into a rail on the right, under Receiver: labelled rows with counts
    and the altitude ramp, collapsing to icons under 1100 px. Overlays and a full
    legend open beside the rail. Zoom and recentre sit below it. Selection and station
    location panels open to the left of the rail.
  - *Timeline is a chip until used.* Bottom right: "Live" with a small activity
    sparkline. Opening it shows the hour histogram, scrubber and a play button (replay
    at 120×). While replaying the chip turns amber with the time and "Back to live".
  - *Labels never overlap.* Greedy placement by priority: selected and hovered, then
    traffic (nearest aircraft first), ring distances, places by rank, sea names. Each
    label tries six positions around its marker, avoids other markers, the shell's
    islands and the map's own controls, stays inside the frame, or is dropped. Ring
    distances move along their ring to a free spot.
  - *Dense spots.* Hover says "+N nearby"; a click on a cluster opens a small chooser
    instead of guessing. Touch uses a larger hit radius.
  - *Keyboard and touch.* The map is focusable: arrows pan (Shift for more), +/−
    zoom, 0 recentres, N / Shift-N walk through items nearest the centre, F follows,
    Escape clears. Pinch zooms around the fingers. A scale bar sits above the chip.
  - *Altitude ramp.* Five stepped colours that differ in lightness as well as hue
    (ground, 10 000 ft, FL200, FL300, FL400+), labels show FL or feet.
  - *Performance (mock).* Land, graticule, coverage and rings render into a cached
    bitmap with a 256 px margin and are only redrawn when the view leaves the margin or
    the zoom changes; the land is one path with per-ring culling; trails are three
    fading segments instead of a gradient each; text widths are cached; ~30 fps when
    idle, full rate while interacting, nothing while the tab is hidden. *Real build:*
    MapLibre gives GPU layers, tile cache and symbol collision for map labels; we still
    own interpolation between reports, the traffic label priority, hit testing for
    clusters and the trail buffers (a GeoJSON or custom layer fed from them).
- **Spectrum tags and narrow windows.** Signal tags no longer overlap: the tuned
  signal and the strongest signals place first, others move up a row, drop their
  detail, or hide (the signal stays clickable). Band names yield to saved-frequency
  tags. The hover readout moved into the frequency axis, out of the tags' way. Below
  1100 px Activity opens full width instead of disappearing (it was hidden with the
  tuned card), and below 1180 px the dock goes icon-only and sits right of Listen.
- **Command palette (⌘K), first pass.** One field that understands intent, not just
  command names:
  - *Tune:* the Tuner's parser (MHz, kHz, `+25k`, channels, saved names); bare digits
    also offer the talkgroup, 7 digits a capcode, 9 digits an MMSI.
  - *Tune is visible and paste-friendly:* "Tune to a frequency… (T)" is the first
    suggestion and opens a Tune scope (recent tunes, saved). Pasted text is
    understood: `161.150.000`, `161 150 000`, `446,00625 MHz`, `161150000` (Hz),
    `Freq: 118.700 MHz AM` (mode applied), a trailing bandwidth (`12.5 kHz`). The
    tune row shows the frequency large. Command words (`gain 30`, `step 6.25k`) are
    never read as frequencies. *Why:* owner feedback — setting a frequency is the
    most common thing to do, so it must be obvious, not just possible.
  - *Set with a value:* `gain 30` (snaps to the nearest step in the gain table),
    `sq 90` (read as −90 dB), `bw 25k` (checked against the mode's range), `vol 60`,
    `rate 2.048`, `step 6.25k`, `am`, `amber`.
  - *Act:* "Play the last call on TG 2081" opens Activity on that talkgroup and plays
    the newest finished recording; show capcode / MMSI / frequency; search Activity
    for anything as the last row.
  - *Nested scopes:* Mode, Bandwidth, Step, Gain, Sample rate, Squelch, Volume, What you
    hear, Level control, Direct sampling, Waterfall palette, Saved, Save, Go to,
    Decoders, Shortcuts. The scope shows as a chip in the field; Tab or Enter opens it,
    Backspace or Esc goes back. The cursor starts on the current value. Deep search
    finds scope values from the root ("amber" → Waterfall palette › Amber).
  - *Live preview:* the highlighted choice is applied to the real view (spectrum,
    islands, waterfall) under a light scrim; Enter keeps it, Esc reverts. Effect bar
    shows `Gain 28.0 dB → 32.8 dB`. Anything with hardware or stream side effects is
    "On Enter" only, never previewed: Bias-T (with a warning), sample rate (clients
    reconnect), direct sampling, listen, record, save.
  - *Ranking:* empty field shows Suggested (context: save this frequency, play the
    talkgroup heard here, everything on this frequency), Recent (frecency), Saved, then
    All commands. Typed results are grouped Tune / Commands / Activity, groups ordered by
    best match; exact intents always win; usage boosts the score.
  - *After running:* the palette closes and a toast confirms with Undo (patch-based
    commands). Copy frequency and copy deep link are commands too.
  - *Shortcuts shown on rows:* `[` `]` step, `M` mode, `S` save, `B` saved, `L` listen,
    `R` record, `Q` squelch, `/` search Activity, `G` then a letter for views
    (S, A, M, C scanner, R), `?` shortcuts. Single keys only when no field has focus.
  *Why:* the operator's fastest path to everything, and the one place every setting is
  reachable by name. Previewing makes trying gains, squelch levels or palettes a
  matter of arrowing through them.

- **Recordings, first pass (2026-10-10).** Owner brief: very important, super refined,
  super simple, clutter free. Settled with the owner before drawing:
  - *What it is:* Activity is **what happened** (every call, auto-recorded, expires after
    the retention period); Recordings is **what you kept**. Three ways in: **Keep** a call
    in Activity (star in the detail header, `S` on the focused list; a small star marks
    kept rows), **Record** in Listen, and **IQ capture**. Kept items never expire.
  - *IQ captures are designed now, built later:* a kept item kind with its own row (amber
    `IQ` tag, centre frequency and span) and a thumbnail where time runs left to right and
    frequency bottom to top, so trim works the same as on audio. Playing one is **play as
    source**: the spectrum retunes to the capture, an amber "Playing capture · name · time ·
    Back to live" chip sits at the top centre of the shell, and audio and decoders run on
    the capture. The player bar turns amber and swaps close for "Back to live". Amber is
    the shell's "not live" colour, shared with Map replay.
  - *Placement:* the right drawer, same slot and width (420 px) as Activity, spectrum
    visible behind; full width below 1100 px and on a phone.
  - *Anatomy:* header (title, count, close), one search field (Activity's typed-chip
    model, scoped to kept items: Talkgroup, Frequency, Kind "IQ captures", Anywhere; it
    also matches names and notes), one list grouped by day, the shared player, one footer
    line. No toolbar, no filter chips. Rows reuse the Activity / tuned-card anatomy: type
    tile, name (or the automatic title), time, frequency + mode line, one line of note or
    transcript, play circle with the kept duration.
  - *Open in place, no second pane:* clicking a row opens it inside the list: waveform with
    two trim handles (drag, arrow keys, or `I` / `O` at the playhead; non-destructive,
    "Keeping 0:12 of 0:42 · Reset"), transcript or "Decoded in this capture" chips for IQ,
    Name and Note fields (the name's placeholder is the automatic title), then one action
    row: Play (shows the kept length when trimmed) / Play as source, Download, Copy link,
    and `⋯` (Tune to, Show in Activity, Remove / Delete). Arrows move a cursor; if a row is
    open the next one opens instead, so reading through is one key.
  - *Remove vs delete:* a kept call is *removed* (it goes back to Activity and expires
    normally); a manual recording or IQ capture is *deleted*. Both have Undo in a toast.
  - *Download:* audio as Opus (default) or WAV; IQ as SigMF (opens in SDR++ and GNU Radio)
    or the tuned channel's audio. Downloads are the trimmed part and say so.
  - *Storage:* one quiet footer line, "Kept 1.1 GB · calls expire after 7 days · 212 GB
    free"; when space is short it turns amber ("4.1 GB free · calls now expire after 2 days
    instead of 7"). It links to Settings › Storage. Tweak `storage` shows both.
  - *Live recording:* while Listen › Record is on, a red row at the top shows the
    frequency, a timer and Stop; the recording lands at the top of Today, highlighted,
    with "Transcribing…".
  - *Empty state:* one line on how to keep something, with "Open Activity" (tweak `view`).
  - *Keyboard (list focused):* ↑↓ move, Enter open/close, Space play, J / L ±5 s, K
    pause, I / O trim, Delete remove, Esc close.

## Open questions and next topics

- Auto band map: remember what was decoded where and keep it labelled on the
  spectrum (active / seen recently / saved), user-configurable. Owner unsure;
  leaning yes. Not drawn yet.
- Activity follow-ups: unread state and watched talkgroups/capcodes, real time-range
  picker and jump-to-time, bulk actions (export, copy, audio clip).
- Right-click menus on signals (Listen, Decode as…, Save). Should reuse palette
  commands so both stay in sync.
- Tuned card placement. Proposal (not drawn yet): no free drag. The card snaps to a
  few anchors (bottom-right default, top-right under Receiver, bottom-left above
  Listen), remembered per client. **Pin** detaches a card that keeps showing *its*
  frequency while you tune elsewhere; pinned cards stack in one column (max 3,
  collapsible to the header line), so watching AIS or a talkgroup while scanning
  works. Owner to confirm before it is designed.
- Palette follow-ups: should tuning previews retune the hardware (as drawn) or show a
  ghost VFO only? Owner to judge after trying it. Palette on mobile (bottom sheet?).
  Single-key shortcuts and `G` chords need a design pass with the full keymap.
- Recordings follow-ups: where "Capture IQ" starts (palette command and Receiver island
  are the candidates; not drawn), capture length / size limits, and whether a running
  capture shows in the shell like the red recording row. Playlists or folders are out on
  purpose; revisit only if search plus day grouping stops being enough. `S` means *keep*
  in a focused Activity list but *save frequency* in the palette keymap: settle in the
  keymap pass. Recordings at phone width needs a look on a real phone layout.
- Map view, Scanner, Settings.
- Island panels on smaller laptop screens; mobile layout.
- Design-system pass: tokens, type scale, spacing, motion, shadcn mapping.

## Core gaps

Kept in [CORE-GAPS.md](CORE-GAPS.md), the file the core team watches.

## Next session

Recordings first pass is drawn and waits for the owner's review on the canvas (board
"Recordings", and the dock in C · Immersive: open Recordings, play the "Harbour band" IQ
capture to see the shell's capture state, turn on Record in Listen to see the live row).
Pick the next topic from the open questions; Scanner and Settings are the remaining
screens behind the dock.

## Handoff to the dev team (later)

1. Extract the design system: tokens into `packages/brand`, Tailwind/shadcn theme,
   component inventory mapping each canvas component to shadcn or custom (the
   spectrum is a custom GPU component).
2. One spec per area (shell, tuner, receiver, listen, activity, messages) under
   `docs/superpowers/specs/`, each linking its canvas board; board interactions are
   the acceptance criteria.
3. Data contracts plus a mock data server serving the same fake data as the canvas
   (like the Pi UI preview), so the front end can be built alongside core.
4. Implementation plans from the specs, then build.
