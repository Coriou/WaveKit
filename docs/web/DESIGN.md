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
| Spectrum + waterfall | Live mock: zoom, pan, retune past the capture edge, drag VFO / band edges, saved-frequency tags, squelch line | Active |
| Tuned-signal panel | What is on the tuned frequency | Active |
| Tuner island | Digit tuning, typed entry with suggestions, mode, bandwidth, step, saved frequencies | Active |
| Receiver island | Sample rate, gain table, AGC, bias-T, PPM, advanced (direct sampling, DC removal, IQ correction) | Active |
| Listen island | Listen, squelch meter with auto/off, volume, analog vs decoded voice, AGC, filters, record | Active |
| Decoded messages + Decode card | One card anatomy for every decoder; JSON fallback for unknown rtl_433 models | Active |
| JSON viewer | Syntax colours, wrap, copy pretty / one line | Active |
| Activity | Search with typed chips, multi-column, detail pane, audio replay, transcripts, live feed | Active, polished once |
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

## Open questions and next topics

- Auto band map: remember what was decoded where and keep it labelled on the
  spectrum (active / seen recently / saved), user-configurable. Owner unsure;
  leaning yes. Not drawn yet.
- Activity follow-ups: unread state and watched talkgroups/capcodes, real time-range
  picker and jump-to-time, bulk actions (export, copy, audio clip).
- Right-click menus on signals (Listen, Decode as…, Save). Should reuse palette
  commands so both stay in sync.
- Palette follow-ups: should tuning previews retune the hardware (as drawn) or show a
  ghost VFO only? Owner to judge after trying it. Palette on mobile (bottom sheet?).
  Single-key shortcuts and `G` chords need a design pass with the full keymap.
- Map view, Scanner, Recordings, Settings.
- Island panels on smaller laptop screens; mobile layout.
- Design-system pass: tokens, type scale, spacing, motion, shadcn mapping.

## Core gaps

Kept in [CORE-GAPS.md](CORE-GAPS.md), the file the core team watches.

## Next session

**Topic: right-click menus on signals and markers.** Scope to explore:
- Right-click (and long-press) on a signal, a saved-frequency tag, the VFO, a band
  edge and an Activity row.
- Reuse the palette's command model so the menu and ⌘K offer the same actions
  (Listen, Decode as…, Save, Show in Activity, Copy link, Set bandwidth to signal).
- "Decode as…" for an unknown emission; what WaveKit can try on the fly.
- First, read the canvas comments on the Command palette board.

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
