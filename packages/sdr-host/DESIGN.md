---
name: WaveKit Receiver
description: Read-only operator page served by the Pi, built as a bench instrument front panel.
colors:
  bezel: "#d9dbd5"
  bezel-raised: "#e4e6e0"
  ink: "#1c201e"
  ink-2: "#4a524e"
  rule: "#a7ada6"
  ok-ink: "#1d7347"
  warn-ink: "#855600"
  fault-ink: "#b02a1f"
  bezel-night: "#1b1e1d"
  bezel-raised-night: "#222625"
  ink-night: "#e3e7e2"
  ink-2-night: "#9ba49f"
  rule-night: "#3b423f"
  ok-ink-night: "#5fd39a"
  fault-ink-night: "#ff8073"
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
  annunciator-active:
    backgroundColor: "{colors.fault}"
    textColor: "#1a0a08"
    rounded: "{rounded.window}"
    padding: "10px 12px"
  readout:
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    padding: "12px 12px 14px 0"
  lamp:
    backgroundColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    size: "10px"
---

# Design System: WaveKit Receiver

## Overview

**Creative North Star: "The Bench Instrument Front Panel"**

The page is a piece of test equipment, not a dashboard. A painted bezel carries silk-screened legends and hairline rules; set into it is one always-dark display screen with a fine graticule, plotting measured flow as a single amber trace against a dashed expected line. Everything else (the receiver chain, power annunciators, host readouts) is printed or mounted on the bezel around that screen, the way legends and lamps surround a scope's CRT.

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
- **Raised Enamel** (bezel-raised, bezel-raised-night): the face of annunciator windows only.
- **Panel Ink** (ink, ink-night): primary text and filled meter bars.
- **Legend Ink** (ink-2, ink-2-night): legends, secondary facts, units, stale and unavailable values.
- **Silkscreen Rule** (rule, rule-night): every hairline, window border and meter tick.
- **Display Black** (screen): the screen surface in both themes.
- **Phosphor White / Dim Phosphor** (screen-ink, screen-ink-2): screen text; dim phosphor also draws stale traces and inactive figures.
- **Graticule Sage** (expected): the dashed expected-rate line and its key.

### Status

- **Lamp Green / Amber / Red** (ok, warn, fault): lamp fills, the verdict dot, the active annunciator face.
- **Status Inks** (ok-ink, warn-ink, fault-ink and night variants): the same states as text on the bezel, darkened (day) or lifted (night) to hold contrast.
- **Dark Lamp** (lamp-off, lamp-off-night): the hollow ring of an unlit or unknown lamp.
- **Focus Blue** (focus, focus-night): focus outlines only; the one hue outside the instrument palette, kept so focus never reads as a status.

### Named Rules

**The One Trace Rule.** Amber on the screen means a fresh measurement. A reading the page cannot confirm is redrawn in dim phosphor at reduced opacity, never amber.

**The Theme-Proof Screen Rule.** The bezel follows `prefers-color-scheme`; the screen and its inks never do.

## Typography

**Display Font:** Barlow 500/600 (with ui-sans-serif, system-ui)
**Label Font:** Barlow Semi Condensed 600 (with Barlow)

**Character:** Barlow is the engraved-instrument grotesque for figures and sentences; its semi-condensed cut, set in spaced capitals, is the silkscreen voice. Both are self-hosted woff2; no other faces.

### Hierarchy

- **Display** (500, 2.25rem, 1): the live rate on the screen; unit set at 0.9375rem in dim phosphor.
- **Headline** (600, 1.625rem, 1.1): the one-line verdict; 1.5rem on phones.
- **Title** (500, 1.375rem, 1.1): host readout values; drops to body size in Legend Ink when stale or unavailable.
- **Body** (500, 1rem, 1.4): stage state words (0.9375rem, 600), verdict detail (max 46ch), setup line.
- **Body-sm** (500, 0.8125rem): facts beneath values, notes, footer, marker readout.
- **Label** (Semi Condensed 600, 0.75rem, 0.09em, uppercase): section legends and stage names; 0.8125rem for pill, annunciator and disclosure labels.
- **Label-sm** (Semi Condensed 600, 0.6875rem, 0.08em, uppercase): plot axis, readout names, table heads.

### Named Rules

**The Tabular Figures Rule.** `font-variant-numeric: tabular-nums` is set on the body; numbers never jitter as they update.

**The Silkscreen Voice Rule.** Uppercase spaced condensed type is reserved for printed panel labels naming a real section, stage, window or axis. It never decorates a headline or carries a value.

## Layout

A single centred panel (max 1180px, 16px gutters honouring safe-area insets). Sections stack with a 28px rhythm. At 900px and up the panel splits into two columns at 8fr / 4fr with a 40px gap: the screen, chain and setup on the left; power and host on the right; diagnostics spans both. Below 900px the column wrappers dissolve (`display: contents`) and source order is re-sequenced so the phone reads flow, power, host, then setup.

The screen grid puts verdict top-left and rate top-right, plot full width beneath; under 420px everything stacks and the rate goes left-aligned. The plot height is `clamp(150px, 34vw, 260px)`. Under 560px the plot axis wraps its scale onto its own centred row.

The receiver chain is four equal columns joined by a horizontal rule through the lamps; under 560px it turns vertical with the rule running down a fixed 5.5rem name column. Annunciators are full-width rows except between 560 and 899px, where they sit three across. Host readouts are two across (three in the mid band), separated by hairlines.

## Elevation & Depth

The bezel is flat: no drop shadows anywhere. Depth exists in exactly one place, the screen, which is recessed into the bezel with an inset shadow and a faint inner edge. Layering on the bezel is tonal (raised enamel for annunciator windows) and linear (hairline rules).

### Shadow Vocabulary

- **Screen recess** (`box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.04), inset 0 2px 10px rgb(0 0 0 / 0.5)`): the display screen only.
- **Lamp knockout** (`box-shadow: 0 0 0 4px var(--bezel)`): a bezel-coloured ring that cuts the chain rule around each stage lamp. A mask, not elevation.

### Named Rules

**The Recessed Screen Rule.** Nothing rises off the panel. The only depth cue is the screen sinking into it.

## Shapes

Shapes come from the hardware. The screen has a softly rounded CRT bezel (14px). Annunciator windows and the marker readout are gently radiused rectangles (6px). The link status is a full pill. Lamps are 10px circles drawn as 2px rings. Rules are 1px hairlines; meters are a 4px ruled scale with ticks every 10%. The disclosure chevron is drawn from two 1.5px borders, not a glyph.

## Components

### Status Pill (nameplate link)

- **Shape:** full pill, 1px rule border, 8px 12px padding.
- **Content:** lamp plus a label-voice word (Live, Stale, Reconnecting, Lost · 16 s ago); text takes the matching status ink. Connecting and reconnecting lamps blink at 1.2s in two steps.

### Lamp

- **Style:** 10px circle, 2px border in its hue. Lit states fill; unknown, off and idle stay a hollow ring. Always paired with a word; never the sole carrier of state.

### Screen (signature)

- **Corner / background:** 14px radius, Display Black, recessed shadow.
- **Content:** verdict with its own 12px status dot, detail line, amber rate with expected percentage, graticule plot with major/minor lines at 0.2 / 0.09 alpha, amber 2px trace, dashed 1.25px expected line, axis legend.
- **Marker:** touch or hover drops a phosphor hairline and a hollow amber dot on a real sample with a small readout (time ago, rate). Missing samples leave the trace broken; nothing is interpolated.

### Annunciator Window

- **Clear:** raised enamel, 1px rule border, 6px radius, label in Legend Ink, value right-aligned.
- **Unknown:** transparent with a dashed border.
- **Latched:** border and value in warn ink.
- **Active:** solid fault red face with near-black text; the only filled status surface on the bezel.

### Readout

- **Style:** label-sm name, title-size value, body-sm sub-fact, optional bar meter (ink fill scaling from the left, 0.25s ease-out); warn and fault recolour value and fill; stale and unavailable dim to Legend Ink.

### Diagnostics Disclosure

- **Style:** native `details` between two rules, 44px summary in label voice with a CSS chevron rotating 90° on open; hover lifts to Panel Ink. Holds a ruled clients table (right-aligned numeric columns) and fact lists.

### Focus

- 2px Focus Blue outline, 3px offset, on every focusable element including the plot.

## Do's and Don'ts

### Do:

- **Do** pair every lamp with a word, and draw unknown as a hollow lamp or dashed window.
- **Do** keep amber for fresh measurement only; redraw stale readings in dim phosphor.
- **Do** leave gaps in a trace blank where samples are missing.
- **Do** name sections with a silk-screened legend whose hairline runs to the edge.
- **Do** keep the screen dark in both themes and the bezel following the system theme.
- **Do** honour `prefers-reduced-motion` by stopping blink and transitions.

### Don't:

- **Don't** build an equal-card metrics wall; host values are ruled readouts printed on the bezel, not tiles.
- **Don't** add drop shadows to anything on the bezel; the screen recess is the only depth.
- **Don't** introduce a second accent hue on the screen or a third typeface.
- **Don't** use glyph or emoji icons; lamps, rules and CSS-drawn marks carry the visual signals.
- **Don't** show a stale, missing or unmeasurable value in healthy colour.
