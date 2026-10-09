---
name: WaveKit Receiver
description: Read-only operator pages served by the Pi (receiver status and first-boot setup), built as a bench instrument front panel.
colors:
  bezel: "#d9dbd5"
  bezel-raised: "#e4e6e0"
  ink: "#1c201e"
  ink-2: "#4a524e"
  rule: "#a7ada6"
  ok-ink: "#1d7347"
  warn-ink: "#855600"
  fault-ink: "#b02a1f"
  fault-face: "#ecd3cc"
  bezel-night: "#1b1e1d"
  bezel-raised-night: "#222625"
  ink-night: "#e3e7e2"
  ink-2-night: "#9ba49f"
  rule-night: "#3b423f"
  ok-ink-night: "#5fd39a"
  fault-ink-night: "#ff8073"
  fault-face-night: "#34201d"
  screen: "#0d1210"
  screen-ink: "#dde5e0"
  screen-ink-2: "#8f9d96"
  trace: "#f2b33d"
  expected: "#7f9a8c"
  ok: "#3dbe7e"
  warn: "#f2b33d"
  fault: "#ef5b4c"
  lamp-off: "#9aa19c"
  lamp-off-night: "#5c6460"
  focus: "#2f6fd6"
  focus-night: "#7fb0ff"
typography:
  display:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  body:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "tnum"
  body-sm:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
    fontFeature: "tnum"
  nameplate:
    fontFamily: "Barlow Semi Condensed, Barlow, ui-sans-serif, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.08em"
  label:
    fontFamily: "Barlow Semi Condensed, Barlow, ui-sans-serif, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.09em"
  label-sm:
    fontFamily: "Barlow Semi Condensed, Barlow, ui-sans-serif, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  focus: "2px"
  window: "6px"
  screen: "14px"
  pill: "999px"
spacing:
  hairline-gap: "6px"
  legend-gap: "12px"
  gutter: "16px"
  section: "28px"
  column: "40px"
components:
  status-pill:
    textColor: "{colors.ok-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  screen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.screen-ink}"
    rounded: "{rounded.screen}"
    padding: "18px 18px 12px"
  annunciator-clear:
    backgroundColor: "{colors.bezel-raised}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.window}"
    padding: "10px 12px"
    height: "46px"
  annunciator-latched:
    backgroundColor: "{colors.bezel-raised}"
    textColor: "{colors.warn-ink}"
    rounded: "{rounded.window}"
    padding: "10px 12px"
    height: "46px"
  annunciator-active:
    backgroundColor: "{colors.fault-face}"
    textColor: "{colors.fault-ink}"
    rounded: "{rounded.window}"
    padding: "10px 12px"
    height: "46px"
  expected-label:
    textColor: "{colors.expected}"
    typography: "{typography.label-sm}"
  setup-clock:
    textColor: "{colors.screen-ink}"
    typography: "{typography.display}"
  readout:
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "12px 12px 14px 0"
  meter:
    backgroundColor: "{colors.rule}"
    height: "3px"
  lamp:
    backgroundColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    size: "10px"
---

# Design System: WaveKit Receiver

## Overview

**Creative North Star: "The Bench Instrument Front Panel"**

The page is a piece of test equipment, not a dashboard. A painted bezel carries silk-screened legends and hairline rules; set into it is one always-dark display screen with a fine graticule, plotting measured flow as a single amber trace against a dashed expected line. Everything else (the receiver chain, power annunciators, host readouts) is printed or mounted on the bezel around that screen, the way legends and lamps surround a scope's CRT.

The same instrument has two faces. The status page (served at `/`) is the full panel. The first-boot setup page (`boot.html`, served by the Pi before Docker starts, loading `app.css` plus `boot.css`) is the same panel cut down: the same nameplate and contact pill, the same screen carrying a verdict and an elapsed clock in place of the rate, and the same lamp chain naming the setup stages.

The bezel follows the system theme: lab-grey enamel by day, graphite at night. The screen does not; it stays dark in both. Density is instrument-like: small condensed capitals for labels, tabular figures everywhere, values large only where a glance needs them. State is spoken twice, by a lamp and by a word, and absence is drawn honestly: hollow lamps, dashed windows, blank gaps in the trace, stale ink instead of amber.

The world refuses the equal-card metrics wall. There is one screen, one trace, one accent.

**Key Characteristics:**

- Two materials: a theme-following bezel and an always-dark screen.
- One amber trace as the only chromatic accent; status hues live in lamps and state words.
- Silk-screened small-caps legends with a hairline running out to the edge.
- Lamps with words: filled when lit, hollow when dark or unknown.
- Flat bezel; the screen is the only recessed surface.

## Colors

A near-neutral green-grey instrument palette with one amber signal and three lamp hues.

### Primary

- **Trace Amber** (trace): the measured-flow trace, the headline rate figure, the marker ring and text selection. It means "live measurement" and nothing else on the screen. The warn lamp (warn) shares this amber.

### Neutral

- **Lab-Grey Enamel / Graphite** (bezel, bezel-night): page background, the instrument's body.
- **Raised Enamel** (bezel-raised, bezel-raised-night): the face of clear and latched annunciator windows only.
- **Panel Ink** (ink, ink-night): primary text and filled meter bars.
- **Legend Ink** (ink-2, ink-2-night): legends, secondary facts, units, stale and unavailable values.
- **Silkscreen Rule** (rule, rule-night): every hairline, window border and meter tick.
- **Display Black** (screen): the screen surface in both themes.
- **Phosphor White / Dim Phosphor** (screen-ink, screen-ink-2): screen text; dim phosphor also draws stale traces and inactive figures.
- **Graticule Sage** (expected): the dashed expected-rate line and the label printed at its left end.

### Status

- **Lamp Green / Amber / Red** (ok, warn, fault): lamp fills and the verdict dot. Lamp hues are lamps; they never fill a surface on the bezel.
- **Status Inks** (ok-ink, warn-ink, fault-ink and night variants): the same states as text on the bezel, darkened (day) or lifted (night) to hold contrast.
- **Fault Window Tint** (fault-face, fault-face-night): the face of an active under-voltage window, a low-chroma red tint that holds fault-ink text at contrast in both themes. The only tinted status surface on the bezel.
- **Dark Lamp** (lamp-off, lamp-off-night): the hollow ring of an unlit or unknown lamp.
- **Focus Blue** (focus, focus-night): focus outlines only; the one hue outside the instrument palette, kept so focus never reads as a status.

### Named Rules

**The One Trace Rule.** Amber on the screen means a fresh measurement. A reading the page cannot confirm is redrawn in dim phosphor at reduced opacity, never amber, and its amber wash is removed.

**The Theme-Proof Screen Rule.** The bezel follows `prefers-color-scheme`; the screen and its inks never do.

## Typography

**Display Font:** Barlow 500/600 (with ui-sans-serif, system-ui)
**Label Font:** Barlow Semi Condensed 600 (with Barlow)

**Character:** Barlow is the engraved-instrument grotesque for figures and sentences; its semi-condensed cut, set in spaced capitals, is the silkscreen voice. Both are self-hosted woff2; no other faces.

### Hierarchy

- **Display** (500, 2.25rem, 1): the live rate on the screen in Trace Amber; on the setup page, the elapsed clock (m:ss) in Phosphor White. Units set at 0.9375rem in dim phosphor.
- **Headline** (600, 1.625rem, 1.1): the one-line verdict on either page; 1.5rem on phones (under 420px).
- **Title** (500, 1.375rem, 1.1): host readout values; drops to body size in Legend Ink when stale or unavailable.
- **Body** (500, 1rem, 1.4): the base size for running text.
- **Body-sm** (500, 0.8125rem): stage facts, readout sub-facts, annunciator values, notes, footer, marker readout.
- **Label** (Semi Condensed 600, 0.75rem, 0.09em, uppercase): section legends and stage names; 0.8125rem for pill, annunciator and disclosure labels.
- **Label-sm** (Semi Condensed 600, 0.6875rem, 0.08em, uppercase): plot axis caption, the expected-line label, readout names, table heads.

Three fixed sizes sit off the ramp on purpose, each tied to one job:

- **Fact size** (0.875rem): the nameplate hostname, the rate and clock sub-line on the screen, diagnostics fact lists and the clients table.
- **Stage size** (0.9375rem): stage state words (600), verdict detail (max 46ch), the setup line, and the rate unit.
- **Phone verdict** (1.5rem): the headline under 420px.

### Named Rules

**The Tabular Figures Rule.** `font-variant-numeric: tabular-nums` is set on the body; numbers never jitter as they update.

**The Silkscreen Voice Rule.** Uppercase spaced condensed type is reserved for printed panel labels: a real section, stage, window or axis, the scale annotations an instrument prints on its graticule (time per division, the expected line), and the link pill's state word. It never decorates a headline or sets a live measurement.

## Layout

A single centred panel (max 1180px, 16px gutters honouring safe-area insets). Sections stack with a 28px rhythm. At 900px and up the panel splits into two columns at 8fr / 4fr with a 40px gap: the screen, chain and setup on the left; power and host on the right; diagnostics spans both. Below 900px the column wrappers dissolve (`display: contents`) and source order is re-sequenced so the phone reads flow, power, host, then setup. The setup section appears only while first-boot setup is running, failed or interrupted; once it completes, its line moves to the diagnostics "Receiver" facts.

The screen grid puts verdict top-left and rate top-right, plot full width beneath; under 420px everything stacks and the rate goes left-aligned. The plot height is `clamp(140px, 22vw, 200px)`. Under 560px the plot axis wraps its scale onto its own centred row.

The receiver chain is four equal columns joined by a horizontal rule through the lamps that runs from the first lamp and ends at the last; under 560px it turns vertical with the rule running down a fixed 5.5rem name column. Annunciators are full-width rows except between 560 and 899px, where they sit three across. Host readouts are two across (three in the mid band), separated by hairlines.

The setup page is a single narrower panel (max 760px): nameplate, one legend, the screen (verdict left, clock right, no plot; stacked under 420px), then the stage chain three across with its rule ending at the third lamp, vertical under 560px. One advisory note sits beneath, set off by a hairline, only while setup is running, waiting or interrupted.

## Elevation & Depth

The bezel is flat: no drop shadows anywhere. Depth exists in exactly one place, the screen, which is recessed into the bezel with an inset shadow and a faint inner edge. Layering on the bezel is tonal (raised enamel and the fault tint for annunciator windows) and linear (hairline rules). On the screen, the trace carries a faint amber wash beneath it (an SVG vertical gradient from 0.13 to 0 opacity of Trace Amber); it is a phosphor glow on the display, not elevation, and it disappears when the reading is stale.

### Shadow Vocabulary

- **Screen recess** (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 2px 10px rgb(0 0 0 / 0.5)`): the display screen only.
- **Lamp knockout** (`box-shadow: 0 0 0 4px var(--bezel)`): a bezel-coloured ring that cuts the chain rule around each stage lamp. A mask, not elevation.

### Named Rules

**The Recessed Screen Rule.** Nothing rises off the panel. The only depth cue is the screen sinking into it.

## Shapes

Shapes come from the hardware. The screen has a softly rounded CRT bezel (14px). Annunciator windows and the marker readout are gently radiused rectangles (6px). The link status is a full pill. Lamps are 10px circles drawn as 2px rings. Rules are 1px hairlines; meters are a plain 3px track in Silkscreen Rule with an ink fill. The disclosure chevron is drawn from two 1.5px borders, not a glyph.

## Components

### Status Pill (nameplate link)

- **Shape:** full pill, 1px rule border, 8px 12px padding.
- **Content:** lamp plus a label-voice word (Live, Stale, Reconnecting, Lost · 16 s ago); text takes the matching status ink. Connecting and reconnecting lamps blink at 1.2s in two steps.
- **Escalation:** both pages use the same rule: after 10 s without contact the pill turns red and says how long ("Lost · N s ago").

### Lamp

- **Style:** 10px circle, 2px border in its hue. Lit states fill; unknown, off and idle stay a hollow ring. Always paired with a word; never the sole carrier of state.

### Screen (signature)

- **Corner / background:** 14px radius, Display Black, recessed shadow.
- **Content:** verdict with its own 12px status dot, detail line, amber rate with a sub-line ("N% of expected", or "No current reading" when not fresh), and the plot.
- **Plot:** graticule of 10 vertical and 5 horizontal divisions, major/minor lines at 0.2 / 0.09 alpha. Full scale is 1.25x the expected rate, so the dashed 1.25px expected line sits on the fourth division. The amber 2px trace is a 10 s trailing mean (the same window as the headline rate) with the amber wash beneath it. The caption reads "30 s/div · 10 s average", adding "full scale" only when no expected rate is known.
- **Expected label:** printed directly at the left end of the dashed line ("Expected 4.10 MB/s", label-sm in Graticule Sage); no separate legend key. It hides while the marker readout is showing.
- **Marker:** touch or hover drops a phosphor hairline and a hollow amber dot on the smoothed trace with a small readout (time ago, rate). The average never spans a missing sample, so gaps stay blank; nothing is interpolated.

### Receiver Chain

- **Stages:** operator names (Dongle, IQ server, Fan-out, Clients) in label voice; a lamp and state word; a body-sm fact line beneath, which is where the daemon names (rtl_tcp, rtlmux) appear. Process ids belong in diagnostics, not on the chain.
- **Rule:** a hairline through the lamps, cut around each by the lamp knockout, ending at the last lamp.

### Setup Stage Chain (setup page)

- **Stages:** the same lamp chain with three stages, Pi settings / Receiver / Finish, each with a fact line. No step numbering.
- **States:** in progress is a filled ok lamp that blinks (1.2s, two steps; stopped by reduced motion); done is filled ok; waiting is hollow; interrupted is warn; failed is fault, or every unfinished stage reads "Unknown" when the failure names no stage.
- **Clock:** the screen's right side holds the elapsed time (m:ss, h:mm:ss past an hour) in display type and Phosphor White, captioned "in this stage", "since setup finished" or "since setup stopped". It counts from the Pi-measured age and advances locally between polls; with no age it shows a dash, dimmed to Dim Phosphor while the state is unknown.

### Setup Line (status page)

- **Style:** a lamp and a stage-size sentence. Running and complete are ok; interrupted and failed are fault (text in fault ink); unreported is a hollow lamp.

### Annunciator Window

- **Structure:** lamp, label-voice name, then body-sm value right-aligned. Every window has a lamp.
- **Clear:** raised enamel, 1px rule border, 6px radius, name in Legend Ink, filled ok lamp.
- **Unknown:** transparent with a dashed border and a hollow lamp.
- **Latched:** border and value in warn ink, filled warn lamp.
- **Active:** Fault Window Tint face, fault-ink border, value in fault ink at 600, filled fault lamp.

### Readout

- **Style:** label-sm name, title-size value, body-sm sub-fact, optional bar meter (a 3px rule-coloured track with an ink fill scaling from the left, 0.25s ease-out); warn and fault recolour value and fill; stale and unavailable dim to Legend Ink and fade the meter.

### Diagnostics Disclosure

- **Style:** native `details` between two rules, 44px summary in label voice with a CSS chevron rotating 90° on open; hover lifts to Panel Ink. Holds a ruled clients table (right-aligned numeric columns) and fact lists.

### Focus

- 2px Focus Blue outline, 3px offset, on every focusable element including the plot.

## Do's and Don'ts

### Do:

- **Do** pair every lamp with a word, and draw unknown as a hollow lamp or dashed window.
- **Do** keep amber for fresh measurement only; redraw stale readings in dim phosphor.
- **Do** leave gaps in a trace blank where samples are missing; smoothing never averages across a gap.
- **Do** name sections with a silk-screened legend whose hairline runs to the edge.
- **Do** keep the screen dark in both themes and the bezel following the system theme.
- **Do** label a reference line where it is drawn rather than in a separate key.
- **Do** give both pages the same nameplate, contact rule and lamp vocabulary.
- **Do** honour `prefers-reduced-motion` by stopping blink and transitions.

### Don't:

- **Don't** build an equal-card metrics wall; host values are ruled readouts printed on the bezel, not tiles.
- **Don't** add drop shadows to anything on the bezel; the screen recess is the only depth.
- **Don't** introduce a second accent hue on the screen or a third typeface.
- **Don't** use glyph or emoji icons; lamps, rules and CSS-drawn marks carry the visual signals.
- **Don't** show a stale, missing or unmeasurable value in healthy colour.
- **Don't** fill a bezel surface with a lamp hue; an alarm window is tinted (fault-face), never painted solid red.
