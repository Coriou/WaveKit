---
name: WaveKit Receiver
description: Read-only operator pages served by the Pi (receiver status and first-boot setup), built on the WaveKit UI kit (design system v1, dark theme, phosphor accent) as a phosphor scope on an ink field.
kit: "ui/brand/ui.css (byte copy of packages/brand/tokens/ui.css)"
colors:
  field: "var(--wk-surface) #111c19"
  well: "var(--wk-well) #0b1512"
  raised: "var(--wk-fill) #192b24"
  track: "var(--wk-track) #2c443b"
  text: "var(--wk-text) #f4f7f5"
  text-2: "var(--wk-text-2) #b9cac1"
  text-3: "var(--wk-text-3) #8ba598"
  lamp-off: "var(--wk-text-5) #52645d"
  accent: "var(--wk-accent) #7becc7"
  grat: "var(--wk-line-08)"
  grat-major: "var(--wk-line-14)"
  ok: "var(--wk-accent)"
  warn: "var(--wk-amber) #f2b84b"
  fault: "var(--wk-danger) #ff7a6b"
  focus: "var(--wk-focus)"
typography:
  verdict:
    fontFamily: "var(--wk-font-head)"
    fontSize: "var(--wk-fs-display-2) 32px; var(--wk-fs-display-1) 26px below 560px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.02em"
  rate:
    fontFamily: "var(--wk-font-ui)"
    fontSize: "var(--pi-fs-rate) 40px (Pi-specific)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  nameplate:
    fontFamily: "var(--wk-font-head)"
    fontSize: "var(--wk-fs-2xl) 20px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.1em"
  step:
    fontFamily: "var(--wk-font-head)"
    fontSize: "var(--wk-fs-xl) 16px; var(--wk-fs-lg) below 560px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
  legend: ".wk-label[data-strong] (13px, 700, 0.1em, text-3)"
  label: ".wk-label (12px, 400, 0.1em, text-3)"
  name:
    fontFamily: "var(--wk-font-head)"
    fontSize: "var(--wk-fs-lg) 14px"
    fontWeight: 400
    letterSpacing: "0.1em"
  value:
    fontFamily: "var(--wk-font-ui)"
    fontSize: "var(--wk-fs-xl) 16px"
    fontWeight: 400
    lineHeight: 1.3
    fontFeature: "tnum"
  body:
    fontFamily: "var(--wk-font-ui)"
    fontSize: "var(--wk-fs-xl) 16px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  body-sm:
    fontFamily: "var(--wk-font-ui)"
    fontSize: "var(--wk-fs-lg) 14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  caption:
    fontFamily: "var(--wk-font-ui)"
    fontSize: "var(--wk-fs-md) 13px"
    fontWeight: 400
    lineHeight: 1.35
    fontFeature: "tnum"
  mono:
    fontFamily: "var(--wk-font-mono)"
    fontSize: "var(--wk-fs-lg) 14px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  bar: "var(--wk-r-1) 2px"
  control: "var(--wk-r-3) 6px (kit buttons), var(--wk-r-4) 8px (field)"
  screen: "var(--wk-r-5) 12px"
  pill: "var(--wk-r-pill)"
spacing:
  scale: "var(--wk-sp-1..9): 2, 4, 6, 8, 10, 12, 16, 20, 24"
  gap-group: "var(--pi-gap-group) 32px"
  gap-section: "var(--pi-gap-section) 40px"
  gap-page: "var(--pi-gap-page) 48px"
  names: "6.5rem"
  row-name: "5.25rem"
  glyph: "14px"
  rate-col: "12rem"
  slot: "2.75rem"
components:
  endpoint: ".wk-field holding the address (mono) and a .wk-btn[data-variant=tonal][data-size=lg], 5.5rem wide"
  scope-readout: ".wk-tip"
  meter: ".wk-meter / .wk-meter-fill (--wk-level), 40px wide"
  boot-open: ".wk-btn[data-variant=primary][data-size=lg], 44px tall"
  section-legend: ".wk-label[data-strong]"
  group-title: ".wk-label"
  scope-axis: ".wk-label"
  contact: ".wk-label[data-strong], 10.5rem box, state colour"
  screen: "local: var(--wk-well), var(--wk-r-5), 24px 24px 16px padding"
  verdict: "local"
  rate: "local, 12rem column"
  lamp: "local: 10px ring, filled when lit; pulses with wk-pulse while connecting"
  row: "local dl grid (name, glyph, value, reserved sub-line)"
  client-row: "local, 2.75rem"
  spark: "local, 64 x 16"
  step-bar: "local, 4px, var(--wk-r-1)"
---

# Design System: WaveKit Receiver

> **On the kit (2026-10-17):** both pages load the WaveKit UI kit (`ui/brand/ui.css`, a byte
> copy of `packages/brand/tokens/ui.css`, checked by `tests/unit/operator-page-assets.test.ts`)
> and set `data-wk-theme="dark"` on `<html>`, default ground and accent. Colours, type, space,
> radii, focus, selection and reduced motion come from the kit; Pi-specific parts (the
> instrument and the page layout) are local and use kit tokens only. Mapping and reasons:
> `docs/superpowers/specs/2026-10-17-pi-pages-kit-design.md`. Ground and accent are the owner's
> defaults for now; switching ground or accent is one attribute on `<html>`.

## Overview

**Creative North Star: "The Phosphor Scope on an Ink Field"**

The two pages served by the Pi are WaveKit surfaces on the UI kit's dark theme (kit and brand files vendored unchanged in `ui/brand/`). The page is a dark green-black ink field with text in the kit's light greys. One recessed well, the screen, carries the verdict, the headline rate and a scope of small multiples that all share one five-minute time base. Phosphor, the brand's signal colour, marks live measured signal and healthy state, and nothing else. Everything the operator might act on sits beside the screen as rows grouped by space. Developer detail sits open and quiet at the foot of the page.

The status page (`index.html`, served at `/`) answers one question first: are samples flowing from the dongle at the rate expected? The verdict answers in words. The rate gives the figure. The flow trace shows the last five minutes, and CPU, Memory, SoC temperature and Power dips are drawn underneath on the same time base, so a single cursor reads every channel at one moment. The first-boot setup page (`boot.html`, which loads `brand/ui.css`, `app.css` and `boot.css`) uses the same nameplate and screen, cut down to a verdict, a three-step track and a clock.

The page is dark only: `data-wk-theme="dark"`, no theme switcher and no Paper. The kit sets `color-scheme: dark`, and a meta tag declares it too.

These pages are also the seed of the WaveKit web dashboard's design language. The four rules that carry over unchanged are the border policy (The Line Must Mean Something), the no-jump principle (The Still Page), the mini-chart vocabulary and the measure rules. They are written to be reusable, not specific to the Pi.

**Key Characteristics:**

- UI kit applied directly: vendored `ui.css`, wordmark, favicon, D-DIN Condensed and Noto Sans. Kit recipes where they fit (labels, buttons, field, meter, tooltip); the instrument stays local on kit tokens.
- One ink field (`--wk-surface`) plus one recessed well (`--wk-well`, the screen). Kit recipes bring their own materials: the endpoint field and the cursor readout (`.wk-tip`).
- Grouping by space, alignment and tone. A drawn line is kept only where it carries meaning.
- Nothing moves when data changes. Every block exists from the first paint; readings swap text inside boxes of fixed size. The one allowed reflow is a client joining or leaving.
- Phosphor means live, measured and healthy. Amber and danger are the kit's status hues, kept outside the brand palette.
- Small multiples on one shared time base, read by one cursor; mini-charts only where they add a fact.
- State is given by a word, and by a lamp or trace colour as well. Stale data dims and is never shown in a healthy colour.

## The Still Page (no-jump principle)

**Layout never shifts as data arrives, changes, goes stale or disappears.** An operator holding a phone beside the Pi, or glancing at a laptop beside WaveKit, must find each fact where it was a second ago. This is a design rule, not an optimisation, and it is measured (see Verification).

How the pages keep still:

1. **Draw everything from the first paint.** There is no empty-state collapse. Before the first reading, every section is drawn with "—" values in text-3 and empty plots; the first reading fills the page in place. An unreachable Pi shows the whole instrument, dark, rather than one lonely card.
2. **Reserve lines, do not add them.** The verdict detail always holds two lines (three below 560px). The rate always holds its figure and two short lines under it. Every row is exactly two lines: value, then a sub-line that is reserved even when empty. The setup page keeps the step word line, the clock line and the slot under the screen in every state.
3. **Lists show what is there; membership is the one allowed reflow.** Clients connect and disconnect rarely, so the client list renders exactly as many rows as there are clients rather than reserving empty slots: a client joining or leaving may move what follows. Each client row is a fixed 2.75rem, so its per-poll values (rate, sparkline, health) never move anything. The list is capped at three rows: with more clients, those falling behind come first and the last row summarises the rest ("2 more · All keeping up"). Nobody connected: one hint row stands in for the list.
4. **Swap content, never insert blocks.** States change words, attributes and drawn paths; blocks are not added or removed (client rows, above, are the only exception). The diagnostics panel always lists the same terms. A done-check on a setup step is drawn after the name, so the name never moves.
5. **Fixed boxes for changing text.** Live figures use tabular numerals in boxes sized in `em` (the rate figure is `min-width: 2.3em`, four Noto figures), so a font swap cannot resize them. Right-set text is set inside a box that spans its column (`text-align: right` on a stretched block), never by shrink-wrapping and aligning the box: a shorter word then changes text, not geometry. The contact word fills its box with its lamp at the right edge; the rate's lines span the rate column.
6. **One line for text that changes on a poll.** Values that update are `white-space: nowrap` with an ellipsis and the full text in `title`; copy is written short enough that the ellipsis is a safety net, not a habit. Only static text may wrap (the explanations under Diagnostics, the setup note), and it sits where nothing follows it.
7. **Intrinsic sizes cannot leak.** Grid tracks that hold changing content are `minmax(0, 1fr)`; a column whose width would follow content (`max-content`) holds only static terms. The freshness column in Diagnostics is a fixed 6.5rem because its word changes.

### Verification

`/live/` in the preview tours every receiver state in a 240 s loop. A `PerformanceObserver` for `layout-shift` plus a once-a-second comparison of the bounding boxes of every block, row and fact, over a full loop at 1440, 1024 and 390 px wide, must report no movement after the first reading except at the moments the client list changes membership (the preview's own switcher is excluded). Per-poll value changes never move anything. The setup page is checked the same way on `/boot-live/boot.html`, with no exceptions.

## Colors

Every colour is a kit token (`ui/brand/ui.css`, dark theme, default ground and accent). The Pi's old names map one to one onto kit tokens with the same values; the table is in the spec. No colour is defined locally.

### Primary

- **Accent** (`--wk-accent`, `#7becc7`, phosphor): the flow trace and its wash, the headline rate when fresh and healthy, filled ok lamps, a healthy client's sparkline, the storage meter fill when ok, done and current step bars, the drawn done-check, the Copy button text (kit tonal button), and the "Open receiver status" button face (kit primary button). `ok` is the accent: a healthy state is drawn as live signal.

### Neutral

- **Field** (`--wk-surface`, `#111c19`): page background and `theme-color`; text on accent fills (`--wk-on-accent`).
- **Well** (`--wk-well`, `#0b1512`): the screen's surface.
- **Fill** (`--wk-fill`, `#192b24`): behind the kit's tooltip (`.wk-tip`, the cursor readout, at 92%).
- **Track** (`--wk-track`, `#2c443b`): unlit Wi-Fi bars and the pending step bar. The kit meter uses its own `--wk-line-solid` track.
- **Text** (`--wk-text`, `#f4f7f5`): primary text, channel values, lit Wi-Fi bars, the cursor hairline, the rate's comparison line.
- **Text 2** (`--wk-text-2`, `#b9cac1`): channel and row names, verdict detail, sub-lines, the rate unit, host traces, and the rate figure when it is fresh but neither ok nor warn.
- **Text 3** (`--wk-text-3`, `#8ba598`): kit labels (section legends, group titles, axis), the host name, labels on the plot, the flow scale, the rate's basis line, notes, placeholders ("—"), pending steps, the receiver-start marker, the dashed expected line, and dimmed stale traces.
- **Text 5** (`--wk-text-5`, `#52645d`): the hollow ring of an unlit, unknown or stale lamp. Never text.
- **Graticule** (`--wk-line-08`, `--wk-line-14`): the minute lines and the flow plot's full-scale line use line-08; each channel's zero line, the event-lane baseline and the sparkline baseline use line-14.

### Status

- **Amber** (`--wk-amber`, `#f2b84b`) and **Danger** (`--wk-danger`, `#ff7a6b`): the kit's status hues, not brand colours. They recolour lamps, the verdict dot, traces, values, row text, sparklines, the meter fill, the dips ticks, and the warn/fault step bars. A source read from a stale reading says "Stale" (or "Last known" once the page has lost contact) in amber.

### Named Rules

**The Phosphor Means Live Rule.** The accent marks a fresh measurement or a healthy state. When the screen is not fresh (`data-fresh="false"`), traces and dips ticks are redrawn in text-3 at 0.5 opacity, the wash is removed, and the rate falls back to text-3. Rows, client slots and measurement sources say "Last known"; a stale meter drops to text-3 at 0.4 opacity.

**The Verdict Colours the Trace Rule.** The flow trace, its wash and the rate take the screen's verdict hue: accent when ok, amber when warn, danger when fault. A host channel recolours its own trace and value from its own state; a client's sparkline takes the client's state.

**The Kit's Focus Rule.** Focus is the kit's: a 1.5px `--wk-focus` outline (text at 0.55) with a 2px offset, on `:focus-visible` only. On the scope the offset is 6px.

## Typography

**Display Font:** D-DIN Condensed 400/700 (`--wk-font-head`)
**Body Font:** Noto Sans 400/700 (`--wk-font-ui`)
**Mono:** `--wk-font-mono`, used only for the endpoint address.

**Character:** D-DIN Condensed sets words: verdicts, kit labels, names and short uppercase words. Noto Sans sets running text, buttons and every live number, because D-DIN has no tabular figures. The Pi scope adds the brand's metric-matched Repli faces to the kit's two families (`size-adjust` and ascent/descent overrides over Arial Narrow and Arial) so the layout does not shift while the woff2 files load (`font-display: fallback`). `font-synthesis: none` stops browsers from inventing bold or italic styles. The status page preloads D-DIN Bold and Noto Sans; the setup page preloads only D-DIN Bold. Noto Sans Bold is fetched only when a kit button is drawn.

Sizes are the kit's scale (`--wk-fs-*`, px), snapped by design system §4.1. Uppercase labels use `.1em`, headings `.02em`.

### Hierarchy

- **Verdict** (D-DIN 700, `--wk-fs-display-2` 32px, `.02em`, balanced wrap): the one-line answer on both pages, `--wk-fs-display-1` (26px) below 560px. It is preceded by a 12px status dot.
- **Rate** (Noto 400, `--pi-fs-rate` 40px, -0.01em): the measured MB/s figure, the one size outside the kit scale, read at arm's length from a phone. Its unit is D-DIN 400 at `--wk-fs-2xl` in text-2.
- **Nameplate** (D-DIN 700, `--wk-fs-2xl`, `.1em`, uppercase): the page name beside the wordmark ("Receiver", "Setup").
- **Step** (D-DIN 700, `--wk-fs-xl`, `.1em`, uppercase): setup step names, `--wk-fs-lg` below 560px.
- **Legend** (`.wk-label[data-strong]`: D-DIN 700 13px, `.1em`, text-3): section legends and the contact word (which takes its state colour).
- **Label** (`.wk-label`: D-DIN 400 12px, `.1em`, text-3): Diagnostics group titles and the scope's "5 min ago / now" axis.
- **Name** (D-DIN 400, `--wk-fs-lg`, `.1em`, uppercase, text-2): channel names and row names (`dt`).
- **Value and body** (Noto 400, `--wk-fs-xl` 16px): channel values, row values, client addresses and rates, the setup note.
- **Body-sm** (Noto 400, `--wk-fs-lg` 14px): verdict detail (kept at 14 so it fits its reserved lines), host name, the rate's two lines, flow scale, diagnostics facts, the setup step word and clock caption.
- **Caption** (Noto 400, `--wk-fs-md` 13px): row and client sub-lines, the empty-clients hint, Diagnostics notes. Labels drawn on the plot use `--wk-fs-xs`; the cursor readout is the kit tooltip's `--wk-fs-sm`.
- **Buttons** (kit `.wk-btn`, Noto 700): Copy (`--wk-fs-md`, tonal) and Open receiver status (primary).
- **Mono** (`--wk-fs-lg`/1.4): the endpoint address.

### Measure and Wrapping

Line breaks are decided, not left to whatever `max-width` happens to be set.

- **Measure comes from the layout.** Text takes the width of the column it sits in. A cap is added only where the column runs past a comfortable line: the verdict detail stops at 68ch, Diagnostics notes at 80ch. No narrow caps that orphan a word ("…online / until it finishes."): the setup note runs the full 720px panel and fits one line on a laptop.
- **`text-wrap: balance`** for headings and short notes that may wrap (the verdict, the setup note on a phone), so two lines come out even. **`text-wrap: pretty`** for detail sentences, so the last line is never a lone word.
- **Reserve the lines the copy needs, then write copy to fit.** Detail copy is written to fit two lines at 560px and up and three below; row sub-lines to fit one line beside the row name on a 390px phone. When a sentence would not fit, it is shortened (the Wi-Fi row no longer carries the IP address; it moved to Diagnostics) rather than allowed to wrap.
- **File names never break at their hyphens.** Prose that names a log (`wavekit-setup.log`) sets the name in a `.file` span with `white-space: nowrap`.

### Named Rules

**The Numbers in Noto Rule.** Any figure that updates live is set in Noto Sans with `font-variant-numeric: tabular-nums`, which is set on the body. D-DIN never sets a live number.

**The Condensed Voice Rule.** Uppercase spaced D-DIN is used for short names only: the page name, section legends, channel and row names, the axis, step names, and button and contact words. It never sets a sentence or a measurement.

## Layout

The layout is a single centred panel (max 1180px) with a 16px gutter that honours safe-area insets. The setup page narrows it to 720px. Spacing inside groups is the kit's scale (`--wk-sp-*`, 2–24px): 4–8px inside a group, 12–16px between rows, 24px between a section's legend and its parts. Page rhythm beyond the kit's control spacing is three local tokens: `--pi-gap-group` 32px, `--pi-gap-section` 40px and `--pi-gap-page` 48px.

- **1200px and up:** two columns, `minmax(0, 1fr) 360px` with a 40px gap. The screen is on the left and the side column on the right. Diagnostics spans both columns with three groups across.
- **640–1199px:** one column, so the screen gets the full width (a 1024px laptop reads the scope at full width). The two side sections sit two across with a 32px gap. Diagnostics puts Receiver and This Pi side by side, measurement sources below.
- **Below 640px:** everything is one column.
- **Below 560px:** the nameplate becomes two rows, with the wordmark (at 120px) and contact on the first and the page name and host on the second. The screen stacks the title, then the rate (figure left, its two lines beside it), then the reserved detail lines, then the scope, so any spare detail line reads as space before the scope. Each channel puts its name and value on one line above a full-width trace, and the axis loses its name-column indent.

Inside the scope, each channel is a grid with a 6.5rem name column (name above value) and the plot beside it. The flow plot is `clamp(128px, 15vw, 208px)` tall. Host strips are 40px and the dips lane is 16px.

The side column holds IQ stream (endpoint, Dongle, Tuning, Clients, then one row per client, up to three) and This Pi (Power, Network, Storage, Uptime, Setup). Rows are a 5.25rem name column, a 14px glyph column (lamp, Wi-Fi bars or nothing) and a value; every value and sub-line starts on the same edge.

The setup page has the nameplate, then the screen (verdict, three-column step track, clock), then one slot beneath the screen that holds the note or the button.

## The Line Must Mean Something (border policy)

Groups are made by spacing, alignment and tone. A line is drawn only when it carries information.

**Kit recipes keep their own edges:** the endpoint is a kit field (`.wk-field`, a hairline `--wk-line-18` border marks it as something to copy from) and the cursor readout is a kit tooltip (`.wk-tip`). They are the only outlined elements, and both come from the kit unchanged.

**Kept, because each is data:** the scope's minute lines (one each minute, shared by every channel so the eye can run down the small multiples), each channel's zero line, the flow plot's full-scale line (its value slot names it), the dashed expected rate, the dotted receiver-start marker, the cursor hairline, the event-lane and sparkline baselines, and the step bars.

**Removed:** the screen's outline (the well's darker tone sets it into the field), the nameplate rule and the divider between wordmark and page name (space separates them), the contact pill's outline, the hairline after each legend, the rule under every row, the rules around Diagnostics, and the 30-second graticule and value rows in every strip.

When a dashboard surface wants a divider, it first tries a larger gap, a tone step or a shared edge.

## Elevation & Depth

Depth is tonal: the screen is a well a step darker than the field, with a 12px radius and no outline. On the flow plot, a vertical SVG gradient wash (accent at 0.16 alpha to 0, or the verdict hue) sits beneath the trace. It is a glow on the display, not elevation, and it disappears when data is stale.

### Shadow Vocabulary

One: the cursor readout is the kit tooltip and carries the kit's `--wk-e2`. `app.css` and `boot.css` declare no `box-shadow`, and no `backdrop-filter` (the kit's glass island is not used, so the Pi 3 never blurs).

### Named Rules

**The Darker Well Rule.** Depth goes down, never up. The screen is set into the field by tone alone.

## Shapes

- `--wk-r-5` 12px for the screen.
- Kit radii for kit recipes: the field `--wk-r-4` 8px, buttons and the tooltip `--wk-r-3` 6px.
- `--wk-r-1` 2px for step bars and the meter. Wi-Fi bars use 1px.
- Lamps are 10px circles drawn as 2px rings, filled when lit (8px with a 1.5px ring in Diagnostics). The verdict dot is 12px.
- Plot strokes use `vector-effect: non-scaling-stroke`.
- The done-check is drawn from two borders, not a glyph.

## Mini-charts

Small drawn charts are used where they add a fact the words beside them do not, and never as decoration. They share one vocabulary, drawn in plain SVG or CSS, no library:

- **Trace:** a line over time on the shared five-minute base (sample flow 2px, host strips 1.5px). Gaps stay blank; smoothing never spans a missing sample.
- **Lane:** event ticks on a baseline (power dips): 2px ticks, amber, red while the event is active.
- **Sparkline:** a client's delivered rate as this page has seen it over the last two minutes, 64 × 16, on the same full scale as the sample flow so a client below the upstream rate sits visibly lower. A missing reading breaks the line. It fills from the right as the page watches, like the scope after a receiver start; it is the page's own observation, not a server history.
- **Meter:** the kit meter (`.wk-meter`, 6px, fill scaled by `--wk-level`) at 40px wide, for a share of a whole (storage used), set before the sub-line that states the same figure.
- **Bars:** four rising bars for Wi-Fi signal, lit from the left.

Shared rules: no axes or tick labels (the figure beside the chart gives the value); the state hue colours the mark (accent ok, amber warn, danger fault, text-2 neutral); stale marks drop to text-3 at half opacity or 0.4 opacity; a chart always sits beside the words or figure that state its value.

## Components

### Nameplate

- **Structure:** the vendored wordmark-on-dark SVG (132px wide, 120px below 560px, never retyped), the page name in nameplate type, the host name in text-3, then contact at the right. No rules. The baseline lockup is not used because these headers are narrower than its 320px minimum. The favicon is the vendored `favicon.svg`.

### Contact

- **Shape:** a word and its lamp, right-set in a 10.5rem box, no outline. The word fills the box and sets right, so changing word never moves the lamp or anything else.
- **Content:** Connecting, Live, Stale, Reconnecting, Lost · N ago, Paused when the tab is hidden, Pi unreachable. Live is phosphor, stale and reconnecting are amber, offline is red. Connecting and reconnecting lamps pulse (kit `wk-pulse`, opacity only).
- **Escalation:** both pages use the same rule. After 10 s without contact it turns red and says how long it has been.

### Lamp

- A 10px circle with a 2px ring in its hue. Ok, warn and fault fill. Unknown and stale stay hollow lamp-off. A lamp is always next to a word.

### Screen (signature)

- **Surface:** well, no outline, 12px radius, 24px padding (16px at the foot). The status variant uses a grid with "verdict rate" above "scope scope"; the rate column is a fixed 12rem.
- **Verdict:** verdict type with a 12px dot in the state hue (hollow while unknown), and a text-2 detail with two lines reserved.
- **Rate:** measured MB/s in a fixed box, then two short lines: how it compares (text: "99% of expected", "≈2.16 MS/s derived", "No current reading") and what it is set to (text-3: "2.048 MS/s configured", "Rate set by a client"). Phosphor when fresh and ok, amber when fresh and warn, text-2 when fresh otherwise, text-3 without a current reading ("—").

### Scope

- **Sample flow:** the tall channel. Its value slot gives the full scale ("0–5 MB/s"), a round figure (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten) with 10% headroom over both the expected rate and the peak. The 2px trace is a 10 s trailing mean that never averages across a missing sample. A dashed (6 5) expected line in text-3 is labelled at its left end ("Expected 4.10 MB/s"). When the receiver's uptime is shorter than the window, a dotted text-3 line marks "Receiver started N ago", with the label flipping to the left side late in the window; while that marker sits in the left part, the expected label moves to the right end.
- **CPU, Memory, SoC temp.:** 40px strips with a 1.5px text-2 trace. CPU and Memory are scaled 0–100%, and temperature 20–90 °C. Each value is shown in value type and coloured by its state.
- **Power dips:** a 16px event lane, always drawn ("—" when the receiver reports no history). Each interval that had under-voltage rising edges gets a 2px amber tick (red while under-voltage is active). The value is the count in the window, or "None".
- **Graticule:** a grat line each minute, shared by every channel; each channel's zero in grat-major; the flow plot's full scale in grat.
- **Cursor:** pointer move or press, touch, or the arrow keys (2% per step, 10% with Shift) drop one 1px text-colour hairline across every channel. A readout (`.wk-tip`) lists the time ago, flow, CPU, memory, SoC and dips at that moment, or "no data". It flips to the left near the right edge and hides on mouse leave and on blur.
- **Axis:** "5 min ago" and "now" in axis type, indented to the plot column.

### IQ Stream

- **Endpoint:** a kit field (`.wk-field`, 44px) holding the `tcp://` address in mono, one line, and a tonal kit button (`.wk-btn[data-variant="tonal"][data-size="lg"]`, fixed 5.5rem so the word never moves the field). On click it says "Copied", or "Selected" when the clipboard is unavailable over plain http and the address has been selected instead.
- **Rows:** Dongle (lamp and product), Tuning (the frequency; sample rate and gain below), Clients (count; "All keeping up", "1 falling behind", "Delivery is idle" below).
- **Client rows:** one fixed 2.75rem row per connected client, added and removed as clients come and go. Each: lamp, address, sparkline, rate; below, "Keeping up · connected 58 min" or "Falling behind · 2.10 MB dropped in 60 s" (amber). More than three: the clients falling behind first, the last row reads "N more" with their health. None: a single hint row, "The Pi keeps reading the dongle while nobody is connected. Point WaveKit at the address above to start receiving."

### This Pi

- **Power:** reported as one fact. "Fine" ("No dips in 2 h 40 min"; "3 dips in 1 h · last 2 min ago"), "Fine now" with "2 dips in 5 min · 240 in 7 h" (warn), or "Under-voltage now" (fault). It reads "Not measurable" when unavailable.
- **Network:** for Wi-Fi, four rising bars in the glyph column mapped from dBm (at least -55 is 4, at least -67 is 3, at least -75 is 2 and warn, below that is 1 and warn), with the dBm and outbound rate in the sub-line. Ethernet leaves the glyph column empty.
- **Storage:** free space, with a meter of the share used beside its sub-line.
- **Uptime:** host uptime; the sub-line names the receiver service, or an unexpected restart ("Unexpected restart · under-voltage"), in warn for the first day.
- **Setup:** first-boot setup as a permanent row: Complete ("Finished 24 h ago"), In progress ("Installing the receiver for 2 min"), Interrupted, Failed (exit N), or Not reported.
- Stale rows prefix their sub-line with "Last known" and dim to text-3. Stale bars and meters drop to 0.4 opacity.

### Diagnostics

- Always open at the foot of the page, under a legend like the other sections, in body-sm. Three fixed groups, each titled in small text-3 label type: **Receiver** (rtl_tcp and rtlmux process state, bytes read from the dongle, last sample, dropped for clients, counter resets, fan-out counters), **This Pi** (last reboot, last log before it, address, load average with cores, memory free, receiver service uptime, receiver container, throttling) and **Measurement sources** (each host reading, where it comes from, and a lamp-and-word freshness: Fresh, Stale, Last known, Unavailable, No reading).
- Each group shares its columns through `subgrid`: terms take the width of the longest term (static), values one line each, the freshness column a fixed 6.5rem.
- Static explanations (why throttling or the container cannot be measured) are gathered as notes after the groups, in caption type, where they can wrap without moving anything.

### Setup Step Track (setup page)

- **Bars:** three equal columns (Pi settings, Receiver, Finish), each with a 4px bar above its name. The bar is phosphor and the name is followed by a drawn check when the step is done. The current step is half phosphor, half track, and pulses with the kit's `wk-pulse` (opacity to 0.35, 1.6s). Pending steps are track-coloured with a text-3 name. Failed is red and interrupted is amber. When a failure does not name its stage, every unfinished step reads unknown.
- **State word:** every step has one (Done, In progress, Waiting, Stopped, Interrupted, Unknown) for screen readers. Its line is always kept; it is visible only on the current, failed or interrupted step.
- **Clock:** the elapsed figure (`--wk-fs-2xl`, text) above its caption ("in this stage", "since setup finished", or "No progress yet" / "No current reading" with "—"). Always drawn; it advances locally between polls.
- **After the screen:** one slot holding either the note ("Setup usually takes several minutes. Keep the Pi powered and online until it finishes.", balanced, shown while setup is running, waiting or interrupted) or the "Open receiver status" button (kit primary `.wk-btn`, 44px tall) once the receiver page is ready.

## Do's and Don'ts

### Do:

- **Do** use the vendored wordmark SVG at 120px or wider, and keep the kit and brand files in `ui/brand/` byte-identical to `packages/brand` (the asset test fails otherwise).
- **Do** reach for a kit token or recipe first; add a local rule only for the instrument or the page layout, using kit tokens.
- **Do** set live figures in Noto Sans with tabular figures, in boxes that do not change size. D-DIN is for names and verdicts.
- **Do** keep phosphor for live, healthy signal, and redraw stale data in text-3 at half opacity.
- **Do** put every trend on the one shared five-minute time base, so one cursor reads them all.
- **Do** label a reference line or marker where it is drawn.
- **Do** leave gaps in a trace blank. Smoothing never spans a missing sample.
- **Do** reserve the space a state needs before the state arrives, and measure `/live/` for layout shift after any layout change.
- **Do** group with space and tone first; add a line only when it is data.
- **Do** keep developer detail (pids, counters, measurement sources) in Diagnostics, at the foot of the page.
- **Do** honour `prefers-reduced-motion`; the kit's base layer stops every animation and transition.

### Don't:

- **Don't** add a light theme or theme switcher, another typeface, or Barlow back; don't define colours locally.
- **Don't** use `backdrop-filter` or the kit's glass island, or animate anything infinitely except opacity or transform: a Pi 3 serves these pages.
- **Don't** add shadows or outlines around panels. The well's darker tone is the only depth; the kit tooltip's shadow and the kit field's hairline are the exceptions.
- **Don't** use amber or red decoratively. They are semantic status hues and not part of the brand palette.
- **Don't** show a stale, missing or unmeasurable value in phosphor or another healthy colour.
- **Don't** split power into several indicators. It is one fact with a sub-line.
- **Don't** insert or remove blocks when data changes (client rows joining or leaving are the one exception), hide a section until data arrives, or let a value wrap onto a new line on a poll.
- **Don't** reintroduce tiles, annunciator windows, a stage lamp chain or an uncapped clients table. Host trends belong in the scope, facts in rows, clients in at most three rows.
- **Don't** draw a chart that repeats its neighbour without adding a fact.
- **Don't** use glyph or emoji icons. Lamps, bars, meters and the check are drawn in CSS or SVG.
