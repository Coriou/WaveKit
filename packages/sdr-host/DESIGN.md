---
name: WaveKit Receiver
description: Read-only operator pages served by the Pi (receiver status and first-boot setup), set in the WaveKit brand kit v1.0 dark theme as a phosphor scope on an ink field.
colors:
  ink: "#111c19"
  well: "#0b1512"
  surface: "#192b24"
  rule: "#2c443b"
  rule-strong: "#8ba598"
  paper: "#f4f7f5"
  paper-2: "#b9cac1"
  paper-3: "#8ba598"
  phosphor: "#7becc7"
  grat: "rgb(123 236 199 / 0.07)"
  grat-major: "rgb(123 236 199 / 0.16)"
  ok: "#7becc7"
  warn: "#f2b84b"
  fault: "#ff7a6b"
  lamp-off: "#52645d"
typography:
  verdict:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  rate:
    fontFamily: "Noto Sans, Noto Sans Repli, -apple-system, Segoe UI, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  nameplate:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  step:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.06em"
  legend:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.08em"
  label:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.06em"
  axis:
    fontFamily: "D-DIN Condensed, D-DIN Condensed Repli, Noto Sans, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.06em"
  value:
    fontFamily: "Noto Sans, Noto Sans Repli, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.3
    fontFeature: "tnum"
  body:
    fontFamily: "Noto Sans, Noto Sans Repli, -apple-system, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  body-sm:
    fontFamily: "Noto Sans, Noto Sans Repli, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  caption:
    fontFamily: "Noto Sans, Noto Sans Repli, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.35
    fontFeature: "tnum"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  bar: "2px"
  focus: "2px"
  control: "8px"
  screen: "12px"
  pill: "999px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "24px"
  space-6: "32px"
  space-7: "48px"
  gutter: "16px"
  column: "40px"
  names: "6.5rem"
  row-name: "5.25rem"
  glyph: "14px"
  rate-col: "12rem"
  slot: "2.75rem"
components:
  link:
    textColor: "{colors.ok}"
    typography: "{typography.legend}"
    width: "10.5rem"
  screen:
    backgroundColor: "{colors.well}"
    textColor: "{colors.paper}"
    rounded: "{rounded.screen}"
    padding: "24px 24px 16px"
  verdict:
    textColor: "{colors.paper}"
    typography: "{typography.verdict}"
  rate:
    textColor: "{colors.phosphor}"
    typography: "{typography.rate}"
    width: "{spacing.rate-col}"
  channel-name:
    textColor: "{colors.paper-2}"
    typography: "{typography.label}"
  channel-value:
    textColor: "{colors.paper}"
    typography: "{typography.value}"
  plot-label:
    textColor: "{colors.paper-3}"
    typography: "{typography.caption}"
  scope-readout:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  endpoint:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "12px 12px 12px 14px"
  endpoint-copy:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.phosphor}"
    typography: "{typography.legend}"
    width: "5.5rem"
    height: "44px"
  row:
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    height: "2.75rem"
  client-row:
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    height: "{spacing.slot}"
  lamp:
    backgroundColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    size: "10px"
  meter:
    backgroundColor: "{colors.rule}"
    rounded: "{rounded.bar}"
    width: "40px"
    height: "4px"
  spark:
    textColor: "{colors.phosphor}"
    width: "64px"
    height: "16px"
  step-bar:
    backgroundColor: "{colors.phosphor}"
    rounded: "{rounded.bar}"
    height: "4px"
  boot-open:
    backgroundColor: "{colors.phosphor}"
    textColor: "{colors.ink}"
    typography: "{typography.legend}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "44px"
---

# Design System: WaveKit Receiver

## Overview

**Creative North Star: "The Phosphor Scope on an Ink Field"**

The two pages served by the Pi are WaveKit brand surfaces in the kit's dark theme (v1.0, vendored unchanged in `ui/brand/`). The page is a dark green-black ink field with paper-coloured text. One recessed well, the screen, carries the verdict, the headline rate and a scope of small multiples that all share one five-minute time base. Phosphor, the brand's signal colour, marks live measured signal and healthy state, and nothing else. Everything the operator might act on sits beside the screen as rows grouped by space. Developer detail sits open and quiet at the foot of the page.

The status page (`index.html`, served at `/`) answers one question first: are samples flowing from the dongle at the rate expected? The verdict answers in words. The rate gives the figure. The flow trace shows the last five minutes, and CPU, Memory, SoC temperature and Power dips are drawn underneath on the same time base, so a single cursor reads every channel at one moment. The first-boot setup page (`boot.html`, which loads `app.css` plus `boot.css`) uses the same nameplate and screen, cut down to a verdict, a three-step track and a clock.

The page is dark only. The palette has no light variant, and `color-scheme: dark` is declared both in CSS and in a meta tag.

These pages are also the seed of the WaveKit web dashboard's design language. The four rules that carry over unchanged are the border policy (The Line Must Mean Something), the no-jump principle (The Still Page), the mini-chart vocabulary and the measure rules. They are written to be reusable, not specific to the Pi.

**Key Characteristics:**

- Brand kit applied directly: vendored wordmark, favicon, D-DIN Condensed and Noto Sans, and the dark-theme colour values.
- One ink field plus one recessed well (the screen). The only raised tone is surface, used for the endpoint field and the cursor readout.
- Grouping by space, alignment and tone. A drawn line is kept only where it carries meaning.
- Nothing moves when data changes. Every block exists from the first paint; readings swap text inside boxes of fixed size. The one allowed reflow is a client joining or leaving.
- Phosphor means live, measured and healthy. Amber and red are semantic hues kept outside the brand palette.
- Small multiples on one shared time base, read by one cursor; mini-charts only where they add a fact.
- State is given by a word, and by a lamp or trace colour as well. Stale data dims and is never shown in a healthy colour.

## The Still Page (no-jump principle)

**Layout never shifts as data arrives, changes, goes stale or disappears.** An operator holding a phone beside the Pi, or glancing at a laptop beside WaveKit, must find each fact where it was a second ago. This is a design rule, not an optimisation, and it is measured (see Verification).

How the pages keep still:

1. **Draw everything from the first paint.** There is no empty-state collapse. Before the first reading, every section is drawn with "—" values in paper-3 and empty plots; the first reading fills the page in place. An unreachable Pi shows the whole instrument, dark, rather than one lonely card.
2. **Reserve lines, do not add them.** The verdict detail always holds two lines (three below 560px). The rate always holds its figure and two short lines under it. Every row is exactly two lines: value, then a sub-line that is reserved even when empty. The setup page keeps the step word line, the clock line and the slot under the screen in every state.
3. **Lists show what is there; membership is the one allowed reflow.** Clients connect and disconnect rarely, so the client list renders exactly as many rows as there are clients rather than reserving empty slots: a client joining or leaving may move what follows. Each client row is a fixed 2.75rem, so its per-poll values (rate, sparkline, health) never move anything. The list is capped at three rows: with more clients, those falling behind come first and the last row summarises the rest ("2 more · All keeping up"). Nobody connected: one hint row stands in for the list.
4. **Swap content, never insert blocks.** States change words, attributes and drawn paths; blocks are not added or removed (client rows, above, are the only exception). The diagnostics panel always lists the same terms. A done-check on a setup step is drawn after the name, so the name never moves.
5. **Fixed boxes for changing text.** Live figures use tabular numerals in boxes sized in `em` (the rate figure is `min-width: 2.3em`, four Noto figures), so a font swap cannot resize them. Right-set text is set inside a box that spans its column (`text-align: right` on a stretched block), never by shrink-wrapping and aligning the box: a shorter word then changes text, not geometry. The contact word fills its box with its lamp at the right edge; the rate's lines span the rate column.
6. **One line for text that changes on a poll.** Values that update are `white-space: nowrap` with an ellipsis and the full text in `title`; copy is written short enough that the ellipsis is a safety net, not a habit. Only static text may wrap (the explanations under Diagnostics, the setup note), and it sits where nothing follows it.
7. **Intrinsic sizes cannot leak.** Grid tracks that hold changing content are `minmax(0, 1fr)`; a column whose width would follow content (`max-content`) holds only static terms. The freshness column in Diagnostics is a fixed 6.5rem because its word changes.

### Verification

`/live/` in the preview tours every receiver state in a 240 s loop. A `PerformanceObserver` for `layout-shift` plus a once-a-second comparison of the bounding boxes of every block, row and fact, over a full loop at 1440, 1024 and 390 px wide, must report no movement after the first reading except at the moments the client list changes membership (the preview's own switcher is excluded). Per-poll value changes never move anything. The setup page is checked the same way on `/boot-live/boot.html`, with no exceptions.

## Colors

The palette is the brand dark theme: green-black inks, green-tinted paper greys and a single phosphor green. Two status hues sit alongside it.

### Primary

- **Phosphor** (phosphor, `#7becc7`): the flow trace and its wash, the headline rate when fresh and healthy, filled ok lamps, a healthy client's sparkline, done and current step bars, the drawn done-check, the Copy button text, the focus outline, text selection, and the "Open receiver status" button face. `ok` is an alias of phosphor: a healthy state is drawn as live signal.

### Neutral

- **Ink** (ink, `#111c19`): page background, `theme-color`, and text on phosphor fills.
- **Well** (well, `#0b1512`): the screen's surface.
- **Surface** (surface, `#192b24`): the one raised tone: the endpoint field and its Copy button (two tones of surface split by 2px of ink) and the cursor readout.
- **Rule** (rule, `#2c443b`): unlit Wi-Fi bars, the meter track and the pending step bar. It is no longer a border colour; see The Line Must Mean Something.
- **Rule Strong** (rule-strong, `#8ba598`): the dashed expected-rate line.
- **Paper** (paper, `#f4f7f5`): primary text, channel values, lit Wi-Fi bars, the cursor hairline, the rate's comparison line.
- **Paper 2** (paper-2, `#b9cac1`): legends, channel and row names, verdict detail, sub-lines, the rate unit, host traces, the storage meter fill, and the rate figure when it is fresh but neither ok nor warn.
- **Paper 3** (paper-3, `#8ba598`): tertiary text such as the host name, axis labels, labels on the plot, the flow scale, the rate's basis line, group titles in Diagnostics, notes, placeholders ("—"), pending steps, the receiver-start marker, and dimmed stale traces. It shares its value with rule-strong. The two tokens are kept separate because one is used for text and the other for a drawn line.
- **Graticule** (grat, grat-major): phosphor at 0.07 and 0.16 alpha. The minute lines and the flow plot's full-scale line use grat; each channel's zero line, the event-lane baseline and the sparkline baseline use grat-major.

### Status

- **Warn Amber** (warn, `#f2b84b`) and **Fault Red** (fault, `#ff7a6b`): not brand colours. They are tuned to sit beside phosphor on ink. They recolour lamps, the verdict dot, traces, values, row text, sparklines, the meter fill, the dips ticks, and the warn/fault step bars. A source read from a stale reading says "Stale" (or "Last known" once the page has lost contact) in amber.
- **Dark Lamp** (lamp-off, `#52645d`): the hollow ring of an unlit, unknown or stale lamp.

### Named Rules

**The Phosphor Means Live Rule.** Phosphor marks a fresh measurement or a healthy state. When the screen is not fresh (`data-fresh="false"`), traces and dips ticks are redrawn in paper-3 at 0.5 opacity, the phosphor wash is removed, and the rate falls back to paper-3. Rows, client slots and measurement sources say "Last known".

**The Verdict Colours the Trace Rule.** The flow trace, its wash and the rate take the screen's verdict hue: phosphor when ok, amber when warn, red when fault. A host channel recolours its own trace and value from its own state; a client's sparkline takes the client's state.

**The Focus Is Phosphor Rule.** Every focusable element gets a 2px phosphor outline with a 3px offset. On the scope the offset is 6px.

## Typography

**Display Font:** D-DIN Condensed 400/700 (fallback: metric-matched "D-DIN Condensed Repli" over Arial Narrow, then Noto Sans)
**Body Font:** Noto Sans 400 (fallback: metric-matched "Noto Sans Repli" over Arial, then -apple-system, Segoe UI)
**Mono:** the system monospace stack, used only for the endpoint address.

**Character:** D-DIN Condensed sets words: verdicts, section legends, names and short uppercase labels. Noto Sans sets running text and every live number, because D-DIN has no tabular figures. The Repli faces use `size-adjust` and ascent/descent overrides so the layout does not shift while the woff2 files load (`font-display: fallback`). `font-synthesis: none` stops browsers from inventing bold or italic styles. The status page preloads D-DIN Bold and Noto Sans. The setup page preloads only D-DIN Bold.

### Hierarchy

- **Verdict** (D-DIN 700, 2rem/1, 0.01em, balanced wrap): the one-line answer on both pages, 1.75rem below 560px. It is preceded by a 12px status dot.
- **Rate** (Noto 400, 2.5rem/1, -0.01em): the measured MB/s figure. Its unit is D-DIN 400 at 1.25rem in paper-2.
- **Nameplate** (D-DIN 700, 1.25rem, 0.06em, uppercase): the page name beside the wordmark ("Receiver", "Setup").
- **Step** (D-DIN 700, 1.0625rem/1.2, 0.06em, uppercase): setup step names, 0.9375rem below 560px.
- **Legend** (D-DIN 700, 0.9375rem, 0.08em, uppercase): section legends, the contact word, and the Copy button. The setup button uses 1rem.
- **Label** (D-DIN 400, 0.9375rem, 0.06em, uppercase): channel names and row names (`dt`). Diagnostics group titles use 0.8125rem, 0.08em, in paper-3.
- **Axis** (D-DIN 400, 0.8125rem, 0.06em, uppercase): the scope's "5 min ago / now" axis.
- **Value** (Noto 400, 1.0625rem/1.3): host channel values.
- **Body** (Noto 400, 1rem/1.5): row values; client addresses and rates use 0.9375rem.
- **Body-sm** (Noto 400, 0.875rem): host name, the rate's two lines, flow scale, diagnostics facts, the setup step word and clock caption. Verdict detail and the setup note use 0.9375rem.
- **Caption** (Noto 400, 0.8125rem/1.35): row and client sub-lines, the empty-clients hint, Diagnostics notes and the cursor readout. Labels drawn on the plot use 0.75rem.
- **Mono** (0.875rem/1.4): the endpoint address.

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

The layout is a single centred panel (max 1180px) with a 16px gutter that honours safe-area insets. The setup page narrows it to 720px. Spacing is one 4px scale (`--space-1` 4px to `--space-7` 48px): 4–8px inside a group, 12–16px between rows, 24–32px between a section's legend and its parts, 40–48px between sections.

- **1200px and up:** two columns, `minmax(0, 1fr) 360px` with a 40px gap. The screen is on the left and the side column on the right. Diagnostics spans both columns with three groups across.
- **640–1199px:** one column, so the screen gets the full width (a 1024px laptop reads the scope at full width). The two side sections sit two across with a 32px gap. Diagnostics puts Receiver and This Pi side by side, measurement sources below.
- **Below 640px:** everything is one column.
- **Below 560px:** the nameplate becomes two rows, with the wordmark (at 120px) and contact on the first and the page name and host on the second. The screen stacks the title, then the rate (figure left, its two lines beside it), then the reserved detail lines, then the scope, so any spare detail line reads as space before the scope. Each channel puts its name and value on one line above a full-width trace, and the axis loses its name-column indent.

Inside the scope, each channel is a grid with a 6.5rem name column (name above value) and the plot beside it. The flow plot is `clamp(128px, 15vw, 208px)` tall. Host strips are 40px and the dips lane is 16px.

The side column holds IQ stream (endpoint, Dongle, Tuning, Clients, then one row per client, up to three) and This Pi (Power, Network, Storage, Uptime, Setup). Rows are a 5.25rem name column, a 14px glyph column (lamp, Wi-Fi bars or nothing) and a value; every value and sub-line starts on the same edge.

The setup page has the nameplate, then the screen (verdict, three-column step track, clock), then one slot beneath the screen that holds the note or the button.

## The Line Must Mean Something (border policy)

Groups are made by spacing, alignment and tone. A line is drawn only when it carries information.

**Kept, because each is data:** the scope's minute lines (one each minute, shared by every channel so the eye can run down the small multiples), each channel's zero line, the flow plot's full-scale line (its value slot names it), the dashed expected rate, the dotted receiver-start marker, the cursor hairline, the event-lane and sparkline baselines, and the step bars.

**Removed:** the screen's outline (the well's darker tone sets it into the field), the nameplate rule and the divider between wordmark and page name (space separates them), the contact pill's outline, the hairline after each legend, the rule under every row, the rules around Diagnostics, the endpoint's border and the rule between field and Copy button (two tones of surface split by 2px of ink), the cursor readout's border (it sits on surface), and the 30-second graticule and value rows in every strip.

When a dashboard surface wants a divider, it first tries a larger gap, a tone step or a shared edge.

## Elevation & Depth

The build has no shadows. Depth is tonal: the screen is a well a step darker than the ink field, with a 12px radius and no outline. Surface is the only raised tone (endpoint field and Copy button, cursor readout). On the flow plot, a vertical SVG gradient wash (phosphor at 0.16 alpha to 0, or the verdict hue) sits beneath the trace. It is a glow on the display, not elevation, and it disappears when data is stale.

### Shadow Vocabulary

None. `box-shadow` does not appear in `app.css` or `boot.css`.

### Named Rules

**The Darker Well Rule.** Depth goes down, never up. The screen is set into the field by tone alone. Nothing casts a shadow.

## Shapes

- 12px for the screen.
- 8px for controls and floating panels: the endpoint field, the cursor readout and the setup button.
- 2px for step bars, meters and the focus ring. Wi-Fi bars use 1px.
- Lamps are 10px circles drawn as 2px rings, filled when lit (8px with a 1.5px ring in Diagnostics). The verdict dot is 12px.
- Plot strokes use `vector-effect: non-scaling-stroke`.
- The done-check is drawn from two borders, not a glyph.

## Mini-charts

Small drawn charts are used where they add a fact the words beside them do not, and never as decoration. They share one vocabulary, drawn in plain SVG or CSS, no library:

- **Trace:** a line over time on the shared five-minute base (sample flow 2px, host strips 1.5px). Gaps stay blank; smoothing never spans a missing sample.
- **Lane:** event ticks on a baseline (power dips): 2px ticks, amber, red while the event is active.
- **Sparkline:** a client's delivered rate as this page has seen it over the last two minutes, 64 × 16, on the same full scale as the sample flow so a client below the upstream rate sits visibly lower. A missing reading breaks the line. It fills from the right as the page watches, like the scope after a receiver start; it is the page's own observation, not a server history.
- **Meter:** a 40 × 4 track with a fill for a share of a whole (storage used), set before the sub-line that states the same figure.
- **Bars:** four rising bars for Wi-Fi signal, lit from the left.

Shared rules: no axes or tick labels (the figure beside the chart gives the value); the state hue colours the mark (phosphor ok, amber warn, red fault, paper-2 neutral); stale marks drop to paper-3 at half opacity or 0.4 opacity; a chart always sits beside the words or figure that state its value.

## Components

### Nameplate

- **Structure:** the vendored wordmark-on-dark SVG (132px wide, 120px below 560px, never retyped), the page name in nameplate type, the host name in paper-3, then contact at the right. No rules. The baseline lockup is not used because these headers are narrower than its 320px minimum. The favicon is the vendored `favicon.svg`.

### Contact

- **Shape:** a word and its lamp, right-set in a 10.5rem box, no outline. The word fills the box and sets right, so changing word never moves the lamp or anything else.
- **Content:** Connecting, Live, Stale, Reconnecting, Lost · N ago, Paused when the tab is hidden, Pi unreachable. Live is phosphor, stale and reconnecting are amber, offline is red. Connecting and reconnecting lamps blink.
- **Escalation:** both pages use the same rule. After 10 s without contact it turns red and says how long it has been.

### Lamp

- A 10px circle with a 2px ring in its hue. Ok, warn and fault fill. Unknown and stale stay hollow lamp-off. A lamp is always next to a word.

### Screen (signature)

- **Surface:** well, no outline, 12px radius, 24px padding (16px at the foot). The status variant uses a grid with "verdict rate" above "scope scope"; the rate column is a fixed 12rem.
- **Verdict:** verdict type with a 12px dot in the state hue (hollow while unknown), and a paper-2 detail with two lines reserved.
- **Rate:** measured MB/s in a fixed box, then two short lines: how it compares (paper: "99% of expected", "≈2.16 MS/s derived", "No current reading") and what it is set to (paper-3: "2.048 MS/s configured", "Rate set by a client"). Phosphor when fresh and ok, amber when fresh and warn, paper-2 when fresh otherwise, paper-3 without a current reading ("—").

### Scope

- **Sample flow:** the tall channel. Its value slot gives the full scale ("0–5 MB/s"), a round figure (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten) with 10% headroom over both the expected rate and the peak. The 2px trace is a 10 s trailing mean that never averages across a missing sample. A dashed (6 5) expected line in rule-strong is labelled at its left end ("Expected 4.10 MB/s"). When the receiver's uptime is shorter than the window, a dotted paper-3 line marks "Receiver started N ago", with the label flipping to the left side late in the window; while that marker sits in the left part, the expected label moves to the right end.
- **CPU, Memory, SoC temp.:** 40px strips with a 1.5px paper-2 trace. CPU and Memory are scaled 0–100%, and temperature 20–90 °C. Each value is shown in value type and coloured by its state.
- **Power dips:** a 16px event lane, always drawn ("—" when the receiver reports no history). Each interval that had under-voltage rising edges gets a 2px amber tick (red while under-voltage is active). The value is the count in the window, or "None".
- **Graticule:** a grat line each minute, shared by every channel; each channel's zero in grat-major; the flow plot's full scale in grat.
- **Cursor:** pointer move or press, touch, or the arrow keys (2% per step, 10% with Shift) drop one 1px paper hairline across every channel. A readout on surface lists the time ago, flow, CPU, memory, SoC and dips at that moment, or "no data". It flips to the left near the right edge and hides on mouse leave and on blur.
- **Axis:** "5 min ago" and "now" in axis type, indented to the plot column.

### IQ Stream

- **Endpoint:** the `tcp://` address in mono on surface, one line, with a Copy button on surface beside it, split by 2px of ink (phosphor legend type, fixed 5.5rem, 44px tall). On click it says "Copied", or "Selected" when the clipboard is unavailable over plain http and the address has been selected instead.
- **Rows:** Dongle (lamp and product), Tuning (the frequency; sample rate and gain below), Clients (count; "All keeping up", "1 falling behind", "Delivery is idle" below).
- **Client rows:** one fixed 2.75rem row per connected client, added and removed as clients come and go. Each: lamp, address, sparkline, rate; below, "Keeping up · connected 58 min" or "Falling behind · 2.10 MB dropped in 60 s" (amber). More than three: the clients falling behind first, the last row reads "N more" with their health. None: a single hint row, "The Pi keeps reading the dongle while nobody is connected. Point WaveKit at the address above to start receiving."

### This Pi

- **Power:** reported as one fact. "Fine" ("No dips in 2 h 40 min"; "3 dips in 1 h · last 2 min ago"), "Fine now" with "2 dips in 5 min · 240 in 7 h" (warn), or "Under-voltage now" (fault). It reads "Not measurable" when unavailable.
- **Network:** for Wi-Fi, four rising bars in the glyph column mapped from dBm (at least -55 is 4, at least -67 is 3, at least -75 is 2 and warn, below that is 1 and warn), with the dBm and outbound rate in the sub-line. Ethernet leaves the glyph column empty.
- **Storage:** free space, with a meter of the share used beside its sub-line.
- **Uptime:** host uptime; the sub-line names the receiver service, or an unexpected restart ("Unexpected restart · under-voltage"), in warn for the first day.
- **Setup:** first-boot setup as a permanent row: Complete ("Finished 24 h ago"), In progress ("Installing the receiver for 2 min"), Interrupted, Failed (exit N), or Not reported.
- Stale rows prefix their sub-line with "Last known" and dim to paper-3. Stale bars and meters drop to 0.4 opacity.

### Diagnostics

- Always open at the foot of the page, under a legend like the other sections, in body-sm. Three fixed groups, each titled in small paper-3 label type: **Receiver** (rtl_tcp and rtlmux process state, bytes read from the dongle, last sample, dropped for clients, counter resets, fan-out counters), **This Pi** (last reboot, last log before it, address, load average with cores, memory free, receiver service uptime, receiver container, throttling) and **Measurement sources** (each host reading, where it comes from, and a lamp-and-word freshness: Fresh, Stale, Last known, Unavailable, No reading).
- Each group shares its columns through `subgrid`: terms take the width of the longest term (static), values one line each, the freshness column a fixed 6.5rem.
- Static explanations (why throttling or the container cannot be measured) are gathered as notes after the groups, in caption type, where they can wrap without moving anything.

### Setup Step Track (setup page)

- **Bars:** three equal columns (Pi settings, Receiver, Finish), each with a 4px bar above its name. The bar is phosphor and the name is followed by a drawn check when the step is done. The current step is half phosphor, half rule, and pulses (opacity to 0.45, 1.6s alternate). Pending steps are rule-coloured with a paper-3 name. Failed is red and interrupted is amber. When a failure does not name its stage, every unfinished step reads unknown.
- **State word:** every step has one (Done, In progress, Waiting, Stopped, Interrupted, Unknown) for screen readers. Its line is always kept; it is visible only on the current, failed or interrupted step.
- **Clock:** the elapsed figure (1.25rem paper) above its caption ("in this stage", "since setup finished", or "No progress yet" / "No current reading" with "—"). Always drawn; it advances locally between polls.
- **After the screen:** one slot holding either the note ("Setup usually takes several minutes. Keep the Pi powered and online until it finishes.", balanced, shown while setup is running, waiting or interrupted) or the phosphor-filled 44px "Open receiver status" button once the receiver page is ready.

## Do's and Don'ts

### Do:

- **Do** use the vendored wordmark SVG at 120px or wider, and keep the brand files in `ui/brand/` byte-identical to `packages/brand`.
- **Do** set live figures in Noto Sans with tabular figures, in boxes that do not change size. D-DIN is for names and verdicts.
- **Do** keep phosphor for live, healthy signal, and redraw stale data in paper-3 at half opacity.
- **Do** put every trend on the one shared five-minute time base, so one cursor reads them all.
- **Do** label a reference line or marker where it is drawn.
- **Do** leave gaps in a trace blank. Smoothing never spans a missing sample.
- **Do** reserve the space a state needs before the state arrives, and measure `/live/` for layout shift after any layout change.
- **Do** group with space and tone first; add a line only when it is data.
- **Do** keep developer detail (pids, counters, measurement sources) in Diagnostics, at the foot of the page.
- **Do** honour `prefers-reduced-motion`, which turns off every animation and transition.

### Don't:

- **Don't** add a light theme, another typeface, or Barlow back.
- **Don't** add shadows or outlines around panels. The well's darker tone is the only depth.
- **Don't** use amber or red decoratively. They are semantic status hues and not part of the brand palette.
- **Don't** show a stale, missing or unmeasurable value in phosphor or another healthy colour.
- **Don't** split power into several indicators. It is one fact with a sub-line.
- **Don't** insert or remove blocks when data changes (client rows joining or leaving are the one exception), hide a section until data arrives, or let a value wrap onto a new line on a poll.
- **Don't** reintroduce tiles, annunciator windows, a stage lamp chain or an uncapped clients table. Host trends belong in the scope, facts in rows, clients in at most three rows.
- **Don't** draw a chart that repeats its neighbour without adding a fact.
- **Don't** use glyph or emoji icons. Lamps, bars, meters and the check are drawn in CSS or SVG.
