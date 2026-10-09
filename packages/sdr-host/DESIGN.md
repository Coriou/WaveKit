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
  grat: "rgb(123 236 199 / 0.06)"
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
    lineHeight: 0.95
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
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  bar: "2px"
  focus: "2px"
  control: "8px"
  screen: "12px"
  pill: "999px"
spacing:
  row: "11px"
  legend-gap: "12px"
  gutter: "16px"
  screen: "20px"
  section: "28px"
  column: "36px"
components:
  link-pill:
    textColor: "{colors.ok}"
    typography: "{typography.legend}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  screen:
    backgroundColor: "{colors.well}"
    textColor: "{colors.paper}"
    rounded: "{rounded.screen}"
    padding: "20px 20px 14px"
  verdict:
    textColor: "{colors.paper}"
    typography: "{typography.verdict}"
  rate:
    textColor: "{colors.phosphor}"
    typography: "{typography.rate}"
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
    backgroundColor: "{colors.well}"
    textColor: "{colors.paper}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  endpoint:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.paper}"
    typography: "{typography.mono}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  endpoint-copy:
    textColor: "{colors.phosphor}"
    typography: "{typography.legend}"
    height: "44px"
    padding: "0 14px"
  row:
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    padding: "11px 0"
  lamp:
    backgroundColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    size: "10px"
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

The two pages served by the Pi are WaveKit brand surfaces in the kit's dark theme (v1.0, vendored unchanged in `ui/brand/`). The page is a dark green-black ink field with paper-coloured text. One recessed well, the screen, carries the verdict, the headline rate and a scope of small multiples that all share one five-minute time base. Phosphor, the brand's signal colour, marks live measured signal and healthy state, and nothing else. Everything the operator might act on sits beside the screen as ruled rows. Developer detail is folded into a single disclosure.

The status page (`index.html`, served at `/`) answers one question first: are samples flowing from the dongle at the rate expected? The verdict answers in words. The rate gives the figure. The flow trace shows the last five minutes, and CPU, Memory, SoC temperature and Power dips are drawn underneath on the same time base, so a single cursor reads every channel at one moment. The first-boot setup page (`boot.html`, which loads `app.css` plus `boot.css`) uses the same nameplate and screen, cut down to a verdict and a three-step track.

The page is dark only. The palette has no light variant, and `color-scheme: dark` is declared both in CSS and in a meta tag.

Before the first status reading arrives, `body[data-empty="true"]` hides the rate, the scope, the side column and the diagnostics, so only the nameplate and the verdict ("Waiting for data") show. The page shows no placeholder figures before it has a reading.

**Key Characteristics:**

- Brand kit applied directly: vendored wordmark, favicon, D-DIN Condensed and Noto Sans, and the dark-theme colour values.
- One ink field plus one recessed well (the screen). There are no other surfaces apart from the endpoint field.
- Phosphor means live, measured and healthy. Amber and red are semantic hues kept outside the brand palette.
- Small multiples on one shared time base, read by one cursor.
- State is given by a word, and by a lamp or trace colour as well. Stale data dims and is never shown in a healthy colour.

## Colors

The palette is the brand dark theme: green-black inks, green-tinted paper greys and a single phosphor green. Two status hues sit alongside it.

### Primary

- **Phosphor** (phosphor, `#7becc7`): the flow trace and its wash, the headline rate when fresh and healthy, filled ok lamps, done and current step bars, the drawn done-check, the Copy button text, the focus outline, text selection, and the "Open receiver status" button face. `ok` is an alias of phosphor: a healthy state is drawn as live signal.

### Neutral

- **Ink** (ink, `#111c19`): page background, `theme-color`, and text on phosphor fills.
- **Well** (well, `#0b1512`): the screen's surface. The cursor readout sits on the same colour at 0.94 alpha.
- **Surface** (surface, `#192b24`): the endpoint field only.
- **Rule** (rule, `#2c443b`): every hairline, the screen border, row separators, unlit Wi-Fi bars and the pending step bar.
- **Rule Strong** (rule-strong, `#8ba598`): the dashed expected-rate line.
- **Paper** (paper, `#f4f7f5`): primary text, channel values, lit Wi-Fi bars, the cursor hairline.
- **Paper 2** (paper-2, `#b9cac1`): legends, channel and row names, verdict detail, sub-lines, the rate unit, host traces, and the rate figure when it is not fresh-and-ok.
- **Paper 3** (paper-3, `#8ba598`): tertiary text such as the host name, axis labels, labels on the plot, the flow scale, pending steps, the receiver-start marker, and dimmed stale traces. It shares its value with rule-strong. The two tokens are kept separate because one is used for text and the other for a drawn line.
- **Graticule** (grat, grat-major): phosphor at 0.06 and 0.16 alpha. Minor grid lines use grat. The bottom row line and the event-lane baseline use grat-major.

### Status

- **Warn Amber** (warn, `#f2b84b`) and **Fault Red** (fault, `#ff7a6b`): not brand colours. They are tuned to sit beside phosphor on ink. They recolour lamps, the verdict dot, traces, values, row text, the dips ticks, and the warn/fault step bars.
- **Dark Lamp** (lamp-off, `#52645d`): the hollow ring of an unlit, unknown or stale lamp.

### Named Rules

**The Phosphor Means Live Rule.** Phosphor marks a fresh measurement or a healthy state. When the screen is not fresh (`data-fresh="false"`), traces and dips ticks are redrawn in paper-3 at 0.5 opacity, the phosphor wash is removed, and the rate falls back to paper-2.

**The Verdict Colours the Trace Rule.** The flow trace, its wash and the rate take the screen's verdict hue: phosphor when ok, amber when warn, red when fault. A host channel recolours its own trace and value from its own state.

**The Focus Is Phosphor Rule.** Every focusable element gets a 2px phosphor outline with a 3px offset. On the scope the offset is 6px.

## Typography

**Display Font:** D-DIN Condensed 400/700 (fallback: metric-matched "D-DIN Condensed Repli" over Arial Narrow, then Noto Sans)
**Body Font:** Noto Sans 400 (fallback: metric-matched "Noto Sans Repli" over Arial, then -apple-system, Segoe UI)
**Mono:** the system monospace stack, used only for the endpoint address.

**Character:** D-DIN Condensed sets words: verdicts, section legends, names and short uppercase labels. Noto Sans sets running text and every live number, because D-DIN has no tabular figures. The Repli faces use `size-adjust` and ascent/descent overrides so the layout does not shift while the woff2 files load (`font-display: fallback`). `font-synthesis: none` stops browsers from inventing bold or italic styles. The status page preloads D-DIN Bold and Noto Sans. The setup page preloads only D-DIN Bold.

### Hierarchy

- **Verdict** (D-DIN 700, 2rem/1, 0.01em, balanced wrap): the one-line answer on both pages, 1.75rem below 560px. It is preceded by a 12px status dot.
- **Rate** (Noto 400, 2.5rem/0.95, -0.01em): the measured MB/s figure. Its unit is D-DIN 400 at 1.25rem in paper-2.
- **Nameplate** (D-DIN 700, 1.25rem, 0.06em, uppercase): the page name beside the wordmark ("Receiver", "Setup").
- **Step** (D-DIN 700, 1.0625rem/1.2, 0.06em, uppercase): setup step names, 0.9375rem below 560px.
- **Legend** (D-DIN 700, 0.9375rem, 0.08em, uppercase): section legends, the diagnostics summary, the link pill, and the Copy button. The setup button uses 1rem.
- **Label** (D-DIN 400, 0.9375rem, 0.06em, uppercase): channel names and row names (`dt`).
- **Axis** (D-DIN 400, 0.8125rem, 0.06em, uppercase): the scope's "5 min ago / now" axis.
- **Value** (Noto 400, 1.0625rem/1.3): host channel values.
- **Body** (Noto 400, 1rem/1.45): row values and client addresses.
- **Body-sm** (Noto 400, 0.875rem): host name, rate sub-line, flow scale, diagnostics facts, and the setup step word and clock caption. Verdict detail uses 0.9375rem (54ch). The setup note also uses 0.9375rem (60ch).
- **Caption** (Noto 400, 0.8125rem): row and client sub-lines and the cursor readout. Labels drawn on the plot use 0.75rem.
- **Mono** (0.9375rem/1.3): the endpoint address.

### Named Rules

**The Numbers in Noto Rule.** Any figure that updates live is set in Noto Sans with `font-variant-numeric: tabular-nums`, which is set on the body. D-DIN never sets a live number.

**The Condensed Voice Rule.** Uppercase spaced D-DIN is used for short names only: the page name, section legends, channel and row names, the axis, step names, and button and pill words. It never sets a sentence or a measurement.

## Layout

The layout is a single centred panel (max 1180px) with a 16px gutter that honours safe-area insets. The setup page narrows it to 720px. The nameplate sits above a 1px rule.

- **960px and up:** two columns, `minmax(0, 1fr) 360px` with a 36px gap. The screen is on the left and the side column on the right. Diagnostics spans both columns, and its body splits into two fact lists.
- **640–959px:** one column. The side sections sit two across with a 28px gap, and the setup section, when shown, spans both.
- **Below 640px:** everything is one column, stacked with a 28px rhythm.
- **Below 560px:** the nameplate becomes two rows, with the wordmark (at 120px) and contact pill on the first and the page name and host on the second. The screen stacks verdict, rate and scope, and the rate sits left-aligned with its sub-line wrapping beside it. Each channel puts its name and value on one line above a full-width trace, and the axis loses its name-column indent.

Inside the scope, each channel is a grid with a 6.5rem name column (name above value) and the plot beside it. The flow plot is `clamp(128px, 17vw, 176px)` tall. Host strips are 38px and the dips lane is 16px. Every plot has 10 vertical divisions (30 s each over the five-minute window). The flow plot has 5 horizontal rows and each host strip has 2.

The side column holds, in order: First-boot setup (only while setup is running, failed or interrupted; once complete it moves to diagnostics), IQ stream, and This Pi. Rows are a 5.25rem name column plus a value with a sub-line, separated by hairlines.

The setup page has the nameplate, then the screen (verdict, three-column step track, optional clock line), then the note and, when ready, the button beneath the screen.

## Elevation & Depth

The build has no shadows. Depth is tonal and linear: the screen is a well a step darker than the ink field, bounded by a 1px rule and a 12px radius. The endpoint field is the only raised tone (surface). The cursor readout floats over the scope as a 0.94-alpha well panel with a rule border. On the flow plot, a vertical SVG gradient wash (phosphor at 0.16 alpha to 0, or the verdict hue) sits beneath the trace. It is a glow on the display, not elevation, and it disappears when data is stale.

### Shadow Vocabulary

None. `box-shadow` does not appear in `app.css` or `boot.css`.

### Named Rules

**The Darker Well Rule.** Depth goes down, never up. The screen is set into the field by tone and a hairline. Nothing casts a shadow.

## Shapes

- 12px for the screen.
- 8px for controls and floating panels: the endpoint field, the cursor readout and the setup button.
- A full pill for the link status.
- 2px for step bars and the focus ring. Wi-Fi bars use 1px.
- Lamps are 10px circles drawn as 2px rings, filled when lit. The verdict dot is 12px.
- Rules are 1px hairlines. Plot strokes use `vector-effect: non-scaling-stroke`.
- The disclosure chevron and the done-check are drawn from two borders each, not glyphs.

## Components

### Nameplate

- **Structure:** the vendored wordmark-on-dark SVG (132px wide, 120px below 560px, never retyped), a 1px rule, the page name in nameplate type, then the host name in paper-3, then the link pill. The baseline lockup is not used because these headers are narrower than its 320px minimum. The favicon is the vendored `favicon.svg`.

### Link Pill

- **Shape:** full pill, 1px rule border, 8px 12px padding, legend type.
- **Content:** a lamp and a word (Connecting, Live, Stale, Reconnecting, Lost after N s, Paused when the tab is hidden). Live is phosphor, stale and reconnecting are amber, offline is red. Connecting and reconnecting lamps blink.
- **Escalation:** both pages use the same rule. After 10 s without contact the pill turns red and says how long it has been.

### Lamp

- A 10px circle with a 2px ring in its hue. Ok, warn and fault fill. Unknown and stale stay hollow lamp-off. A lamp is always next to a word.

### Screen (signature)

- **Surface:** well, 1px rule border, 12px radius, 20px padding. The status variant uses a grid with "verdict rate" above "scope scope".
- **Verdict:** verdict type with a 12px dot in the state hue (hollow while unknown) and a paper-2 detail line.
- **Rate:** measured MB/s. Phosphor when fresh and ok, amber when fresh and warn, otherwise paper-2. The sub-line gives the configured MS/s and the percentage of expected ("2.048 MS/s · 99% of expected"). When a client set the rate, it reads "≈x MS/s derived · set by a client".

### Scope

- **Sample flow:** the tall channel. Its value slot gives the full scale ("0–5 MB/s"), which is a round figure (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten) with 10% headroom over both the expected rate and the peak. The 2px trace is a 10 s trailing mean that never averages across a missing sample, so gaps stay blank. A dashed (6 5) expected line in rule-strong is labelled at its left end ("Expected 4.10 MB/s"). When the receiver's uptime is shorter than the window, a dotted paper-3 line marks "Receiver started N ago", with the label flipping to the left side late in the window; while that marker sits in the left part, the expected label moves to the right end.
- **CPU, Memory, SoC temp.:** 38px strips with a 1.5px paper-2 trace. CPU and Memory are scaled 0–100%, and temperature 20–90 °C. Each value is shown in value type and coloured by its state.
- **Power dips:** a 16px event lane. Each interval that had under-voltage rising edges gets a 2px amber tick (red while under-voltage is active), above a grat-major baseline. The value is the count in the window, or "None".
- **Cursor:** pointer move or press, touch, or the arrow keys (2% per step, 10% with Shift) drop one 1px paper hairline across every channel. A readout lists the time ago, flow, CPU, memory, SoC and dips at that moment, or "no data". It flips to the left near the right edge and hides on mouse leave and on blur.
- **Axis:** "5 min ago" and "now" in axis type, indented to the plot column.

### IQ Stream

- **Endpoint:** the `tcp://` address in mono on surface, with a Copy button (phosphor legend type, 44px minimum height, separated by a rule). On click it says "Copied", or "Select to copy" when the clipboard is unavailable over plain http.
- **Rows:** Dongle (lamp and state), Tuning, and Clients. Each client has a lamp and an address, and a sub-line with its rate, "keeping up" or "Falling behind · N dropped in the last minute" (amber), and how long it has been connected. With no clients the row reads "None connected" with a hint.

### This Pi

- **Power:** reported as one fact. "Fine", "Fine now" with "N dips in the last 5 min" (warn), or "Under-voltage now" (fault). It reads "Not measurable" when unavailable.
- **Network:** for Wi-Fi, four rising bars mapped from dBm (at least -55 is 4, at least -67 is 3, at least -75 is 2 and warn, below that is 1 and warn), with the dBm kept in the sub-line. Ethernet shows no bars.
- **Storage, Uptime:** plain rows. On images, Uptime's sub-line names an unexpected restart ("Unexpected restart · last log before it 8 min ago · under-voltage since this boot"), in warn for the first day of uptime; Diagnostics always carries the last reboot line.
- Stale rows prefix their sub-line with "Last known" and dim their text. Stale bars drop to 0.4 opacity.

### Diagnostics Disclosure

- A native `details` element between two rules, with a 44px summary in legend type and a CSS chevron that rotates over 0.2s. Hover lifts the summary to paper. Inside are two fact lists in body-sm: receiver facts (process ids, bytes read, last sample, dropped bytes, counter resets, fan-out counters, first-boot setup, throttling, which reads "not measurable" when it cannot be measured) and measurement sources (where each host reading comes from, and its freshness).

### Setup Step Track (setup page)

- **Bars:** three equal columns (Pi settings, Receiver, Finish), each with a 4px bar above its name. The bar is phosphor and the name has a drawn check when the step is done. The current step is half phosphor, half rule, and pulses (opacity to 0.45, 1.6s alternate). Pending steps are rule-coloured with a paper-3 name. Failed is red and interrupted is amber. When a failure does not name its stage, every unfinished step reads unknown.
- **State word:** every step has one (Done, In progress, Waiting, Stopped, Interrupted) for screen readers. It is visible only on the current, failed or interrupted step.
- **Clock line:** an elapsed figure (1.25rem paper) plus its caption ("in this stage" and so on). It is shown only when the Pi reports an age, and it advances locally between polls.
- **Note:** one advisory line under the screen, shown while setup is running, waiting or interrupted.
- **Open receiver status:** a phosphor-filled 44px button with ink text in legend type, shown only once the receiver page is ready.

## Do's and Don'ts

### Do:

- **Do** use the vendored wordmark SVG at 120px or wider, and keep the brand files in `ui/brand/` byte-identical to `packages/brand`.
- **Do** set live figures in Noto Sans with tabular figures. D-DIN is for names and verdicts.
- **Do** keep phosphor for live, healthy signal, and redraw stale data in paper-3 at half opacity.
- **Do** put every trend on the one shared five-minute time base, so one cursor reads them all.
- **Do** label a reference line or marker where it is drawn.
- **Do** leave gaps in a trace blank. Smoothing never spans a missing sample.
- **Do** keep developer detail (pids, counters, measurement sources) in the diagnostics disclosure.
- **Do** honour `prefers-reduced-motion`, which turns off every animation and transition.

### Don't:

- **Don't** add a light theme, another typeface, or Barlow back.
- **Don't** add shadows. The well's darker tone and its hairline are the only depth.
- **Don't** use amber or red decoratively. They are semantic status hues and not part of the brand palette.
- **Don't** show a stale, missing or unmeasurable value in phosphor or another healthy colour.
- **Don't** split power into several indicators. It is one fact with a sub-line.
- **Don't** reintroduce tiles with meters, annunciator windows, a stage lamp chain or an always-visible clients table. Host trends belong in the scope, and facts belong in rows.
- **Don't** use glyph or emoji icons. Lamps, bars, the chevron and the check are drawn in CSS.
