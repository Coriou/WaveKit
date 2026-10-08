# WaveKit CLI dashboard overhaul — design

Date: 2026-10-08 · ROADMAP §7 · Owner: CLI team (`cli/**`, `tests/unit/cli/**`, `docs/CLI.md`, `docs/CLI-COORDINATION.md`)

Inputs: the dashboard audit (30-40 % IQ drops reported as "2 dropping", idle decoders shown as warnings,
missing data shown as an all-clear, overflow corruption at 80×24 and below, full-screen clears 2-4×/s),
the design direction (instrument panel read along the signal chain) and the CLI decision pack. This spec
keeps all three and settles everything they left open. Mockups use documentation addresses (192.0.2.x)
and the audit fixture state: `pi-iq` streaming at 2.048 MS/s centred on 445.9707 MHz, acarsdec down after 13
restarts, 4 decoder branches in backpressure, 34 % of offered IQ dropped.

---

## 1. Goals and non-goals

**Goals**

1. One operator can answer, in this order and at a glance: is the API reachable, is IQ arriving, what is
   the receiver tuned to, which decoders are up, which of them can hear the tuned window, is anything
   decoding, and how much IQ is being dropped now.
2. Every value is evidence with an age. API connectivity, IQ freshness, decoder process state, decode
   activity, current drops and lifetime counters stay separate. No single item summarises another.
3. Unknown never reads as zero, empty or healthy. Cached data stays visible after a failure, marked as old.
4. Usable from 60×16 to 200×50 and beyond. Nothing overwrites, wraps by accident or disappears without a
   marker. Resizing keeps working.
5. One keyboard model that is discoverable (`?`, a footer generated from the keymap), with detail views and
   a filterable, pausable message feed.
6. Writes are deliberate. Plain navigation never writes. Tuner, decoder and audio-preset writes pass a
   confirm bar that names the target and what it affects.
7. Cheap to render. At most 5 frames/s, no full-screen clears in steady state, bounded memory under
   sustained event flow.

**Non-goals**

- Changing any shared contract. API gaps go to `docs/CLI-COORDINATION.md` (requests 1-7 are already filed)
  and the CLI ships fallbacks for each one.
- Verdicts. The CLI never shows "OK", "healthy", "stable", "receiver OK" or acceptance claims. It has no data
  for them.
- Causes. Drops are shown as measured, without blame ("slow decoder") or diagnosis ("overloaded").
- Persisted preferences, themes or config files (v1 writes no files).
- Polling the Pi directly. Pi data arrives only through core's `ResourceSnapshot`.
- A non-TUI `tail` mode. It is deferred to v1.1 (§16).
- New npm dependencies. Ink 5.2.1, React 18 and ws only.

## 2. Truth rules

These rules apply to every view. Correctness properties in §12 encode them.

| # | Rule |
|---|---|
| T1 | **API lane = WS and REST, separately.** `api ●` only when the WS is open **and** the last REST poll succeeded within the TTL. When they disagree the strip shows both: `api ws ● rest × 45s`. |
| T2 | **IQ wording follows the evidence.** `streaming` appears only when `source.activity.state === "streaming"` and the source snapshot is fresh. With no `activity` (older core) the transport word is used: `connected`/`disconnected`. With only the WS `metrics` heartbeat (REST down), the word is `receiving`, which means core reports a non-zero transport byte rate. |
| T3 | **Process ≠ decodes.** `health: "idle"` is a decode fact, not a process fact. It renders neutral (`none for 6m`) and never yellow or red. Red is reserved for faulted, down and crash-loop. |
| T4 | **Current ≠ lifetime.** Each drop figure is labelled `now` (windowed over 10 s) or `lifetime`. A rate that cannot be computed is `?`, never `0` and never a decaying number. |
| T5 | **Unknown ≠ zero.** `?` = should exist but is missing or not computable. `—` = not applicable. Neither is ever shown as `0`, `none` or an empty-but-healthy state. |
| T6 | **Old data stays visible and says so.** A lane older than its TTL (15 s) renders dim. The banner states `data as of HH:MM:SS`. "Now" values (drop now, rates) become `?`. Ages computed from absolute timestamps (for example `last decode 2m 40s ago`) keep ticking against the local clock, so they stay true. Durations reported relative to a snapshot (`up 52s`) stay frozen at that snapshot. |
| T7 | **Window membership is nominal and says so.** Whether a decoder can hear the tuned window is derived from the CLI's built-in nominal band table (§10.9). The column header says `nominal MHz` and the help legend explains it once. The day core exposes a target band (request 2), the API value replaces the table. |
| T8 | **Drops without blame.** Copy states amounts and states (`34% of offered IQ dropped now`, `4 of 9 in backpressure`). These words are banned anywhere drops are shown: slow, lagging, overloaded, bottleneck, unhealthy, failing (the last is allowed for decoder process state only). |
| T9 | **Every write is confirmed except audio start/stop.** Tuner changes, control takeover, decoder start, stop and restart, and audio presets go through the confirm bar. Audio start/stop only adds or removes a listener on shared IQ, so it reports its result without a confirm. |

## 3. Information architecture

Five views, numbered in the order the operator's questions arrive. Backpressure and Resources stop being
views and become sections.

| Key | View | Answers | Sections |
|---|---|---|---|
| `1` | **Overview** | Is anything arriving, what can hear it, is anything broken, what was decoded? | Receiver summary (2 rows), Decoders table, latest Messages |
| `2` | **Decoders** | Which processes are up, down or crash-looping? Which are decoding? Where is IQ lost per branch? | Full decoder table, detail pane with controls |
| `3` | **Messages** | What was decoded, by which decoder, when? | Filterable, pausable feed, detail pane |
| `4` | **Receiver** | What is the dongle tuned to, who controls it, is IQ arriving, where is it lost? | Source, Tuner (+ edit mode), Relay (+ command history), Fanout, Upstream |
| `5` | **System** | What do the container and the Pi report? Can I listen? | Container, alerts, SDR host (+ sampling slot), Audio, Core |

`--view` accepts the new names and every old name as an alias: `dashboard→overview`, `decoders→decoders`,
`output→messages`, `backpressure→decoders`, `sources→receiver`, `tuner→receiver`, `live-audio→system`,
`resources→system`. An invalid `--view` prints the valid names to stderr and exits 2. `--help` lists the
five views, the aliases, `--api <url>`, and the env vars `WAVEKIT_API_URL`, `WAVEKIT_WS_URL`,
`WAVEKIT_WS_URLS`, `NO_COLOR` and `WAVEKIT_ASCII`.

## 4. Chain strip

Row 1 of every view. It is one lane per link of the chain, in chain order: `api`, `iq`, `rx`, `decoders`,
`drops`, then a right-aligned clock. Lanes are separated by two spaces and sub-values by ` · `. Labels are
dim, values bold, and every state glyph is paired with a word.

### 4.1 Lanes and their variants

Each lane has one to three variants, from minimal to rich. Minimal variants are still plain words; nothing
is abbreviated into glyph clusters.

| Lane | Priority | Minimal | Mid | Rich |
|---|---|---|---|---|
| api | 1 (never dropped) | `api ● 2s` · `api ws ● rest × 45s` · `api × 3m` · `api ○ connecting` | — | — |
| iq | 2 | `iq ● streaming` · `iq × no samples 23s` · `iq ? unknown` | — | `iq ● streaming · 4.1 MB/s` |
| decoders | 3 | `decoders 9/9 up`, or `decoders 1 failing` when any are failing | `decoders 8/9 up · 1 failing` | `decoders 8/9 up · 1 failing · 2 in window` |
| drops | 4 | `drops 34%` · `drops ?` | — | `drops 34% now` |
| rx | 5 | `rx 445.971 MHz` | `rx 445.971 MHz ±1.024` | `rx 445.971 MHz ±1.024 · external control` |
| clock | 6 | `18:07` | — | — |

- `api` age = time since the last successful REST poll. `●` green, `×` red, `○` neutral.
- `iq`: one source shows its own state. Several sources show `iq ● 2/2 streaming`, using the worst state's
  glyph. The activity words are `streaming`, `connected · no samples` (state `waiting`), `no samples 23s`
  (state `stale`, red `×`), `paused`, `ended` and `disconnected`. The fallbacks from T2 are `connected` and
  `receiving`.
- `decoders`: `failing` counts processes that are faulted, down or crash-looping. `in window` counts
  decoders whose nominal band intersects their source's tuned window, including `tuned` decoders (T7).
- `drops`: the aggregate drop rate now, over decoder branches (§10.6), as a percentage of offered bytes.
  `!` and yellow when any decoder branch is in backpressure now. There are no thresholds.
- `rx`: centre frequency and half-span. `external control` or `wavekit control`.

### 4.2 Fitting and the per-width drop order

`fitGroups` (§5.2) works in two passes:

1. **Presence.** Start every lane at its minimal variant, then remove lanes in reverse priority order
   (clock, rx, drops, decoders, iq) until the strip fits.
2. **Richness.** Go through the remaining lanes in priority order and give each the richest variant that
   still fits.

A lane is dropped before any lane is shortened below its minimal words. For the fixture state:

| Width | Result |
|---|---|
| 200 | ` api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz ±1.024 · external control  decoders 8/9 up · 1 failing · 2 in window  drops 34% now … 18:07` |
| 120 | ` api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz  decoders 8/9 up · 1 failing · 2 in window  drops 34% now     18:07` |
| 80 | ` api ● 2s  iq ● streaming  rx 445.971 MHz  decoders 1 failing  drops 34%   18:07` |
| 60 | ` api ● 2s  iq ● streaming  decoders 1 failing  drops 34% now` (rx and clock dropped; rx stays in the Overview Receiver block) |

(The `…` in the 200 row stands for padding. The clock is right-aligned.)

## 5. Layout system

All layout is pure functions in `cli/source/ui/` over `(cols, rows, data)`. Ink components only render
lines that are already fitted.

### 5.1 Frame and regions

- **Frame height is `rows − 1`**, and the root `<Box height={rows-1} width={cols} overflow="hidden">`. Ink's
  full-clear path (`outputHeight >= rows`) therefore never triggers. The app also enters the alternate
  screen (`ESC[?1049h` on start; `ESC[?1049l` on exit, SIGINT, SIGTERM and uncaught exceptions), so an
  accidental clear cannot touch scrollback.
- **Height classes.** *Roomy* is ≥ 30 rows: strip, switcher row, blank row, content, footer (3 chrome rows +
  footer). *Compact* is 16-29 rows: strip, content, footer, with the switcher folded into the footer and no
  blank separator rows.
- **Width classes.** *Narrow* 60-79, *standard* 80-119, *wide* 120-159, *ultra* ≥ 160.
- **Banner.** At most one row, directly under the strip, present only while a connectivity problem exists
  (§9). It takes its row from content.
- **Too small.** Below 60 columns or 16 rows, the app renders exactly one line,
  `wavekit: terminal 50×12 is too small (minimum 60×16)`, and keeps polling. Growing the terminal restores
  the view on the next frame.
- **Detail placement** (Decoders and Messages):
  - Ultra: a right pane of `floor(cols × 0.43)` columns with a 2-column gutter.
  - Roomy: a bottom pane of `max(8, floor(content × 0.45))` rows.
  - Otherwise: a full-content overlay. Esc returns to the list.
- **Overview at ultra** uses two columns: Receiver and Decoders on the left (`cols − right − 2`), Messages
  on the right (`floor(cols × 0.43)`) using the full content height.
- `frameBudget(view, cols, rows, state)` returns the height of every region. Overview guarantees at least
  3 message rows. When the decoder table cannot fit every row, it shows as many decoder rows as fit minus one, plus a
  `+N more` marker row. No row is ever dropped without that marker.

### 5.2 Fitting primitives

- **`fitGroups(groups, width, sep)`** is the one fitter for the strip, banner, footer, key/value rows and
  message summaries. A group is `{ variants: Span[][] (minimal→rich), priority }`. It runs the two passes
  from §4.2. If even the priority-0 minimal variant overflows, the line is cut at `width − 1` and ends with
  `…`. Summaries that drop segments end with `  …`, so the operator knows the detail pane has more.
- **`layoutColumns(width, columns, gap)`** is for tables. A column is
  `{ id, min, pref, priority, align, flex? }`.
  1. Include every column, then remove the highest priority number (rightmost first on ties) until the
     sum of `min` widths plus gaps fits.
  2. Grow columns toward `pref` in priority order.
  3. Give leftover space to the `flex` column.
  Cells provide variants (`up 51s · 1 restart` → `up 51s`). A cell uses the richest variant that fits its
  column and truncates with `…` only as a last resort. Headers have variants too (`drop now` → `drop`).
- **`cellWidth(s)`** strips ANSI, counts combining marks as 0 and East-Asian wide characters as 2. It is
  exact for our own strings, which are ASCII plus the glyph set in §8. Payload strings are first passed
  through `sanitize()`: C0/C1 controls and ESC are stripped, tabs become spaces, and emoji become `?`. Ink's
  `wrap="truncate-end"` stays on every `<Text>` as a safety net, but correct output must never depend on it.

### 5.3 Table column specs

Overview decoders (`min/pref`, priority in brackets): glyph 1 [0] · decoder 12/16 [0] · process 6/18 [0] ·
decodes 8/16 [1] · drop now 4/8 [1] · window 6/6 [2] · nominal MHz 15/15 [3] · lifetime 8/8 [4].

Decoders view: the Overview columns plus restarts 8/8 [5] · errors 6/6 [5] · events 6/6 [6] · IQ in 8/9 [6].
At 120 columns, nominal MHz drops first and moves to the detail pane.

Messages: time 5/8 [0] (`HH:MM` below pref) · decoder 10/12 [0] · type 6/6 [3] · summary flex, min 10 [0].

## 6. Views

Mockups are normative for content, wording, order and which columns drop. Exact column widths come from
`layoutColumns`. Golden tests (§13.2) are generated from the implementation and reviewed against these
mockups.

### 6.1 Overview

**120 × 40, live** (39 frame rows). The blank rows under Messages are where the feed grows.

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz  decoders 8/9 up · 1 failing · 2 in window  drops 34% now     18:07
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

 RECEIVER  pi-iq · rtl_tcp 192.0.2.23:5555   ● streaming · sample age 4 ms   4.1 MB/s · 2.048 MS/s   relay 1 client
 window    444.947–446.995 MHz · centre 445.9707   external control · 192.0.2.1   last command 6m ago

   DECODERS          process             decodes           drop now  lifetime  nominal MHz      window
 ● dsd-fme           up 52s              2/min · 9s ago         12%       36%  tuned            in
 ● multimon-ng       up 51s              1/min · 21s ago        14%       39%  tuned            in
 ● rtl433            up 51s              none for 51s          !15%       41%  433.920          out
 ● readsb            up 51s              none for 51s          !38%       44%  1090.000         out
 × acarsdec          down · 13 restarts  —                        —         —  131.550–131.825  out
 ● ais-catcher       up 51s              none for 51s          !31%       36%  161.975/162.025  out
 ● dumpvdl2          up 50s              none for 50s          !40%       41%  136.650–136.975  out
 ● direwolf          up 50s              none for 50s           11%       35%  144.390/144.800  out
 ● lora-meshtastic   up 50s              none for 50s            9%       30%  869.525/906.875  out

 MESSAGES  3 in 60s · 7 total
 18:07:41  dsd-fme       DMR     TG 2350  SRC 2341234  slot 1  CC 1  8.4 s  quality 65%  7 err  encrypted
 18:07:20  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG STREET UNIT 4B - ZONE 3 SMOKE DETECTOR …
 18:07:02  dsd-fme       DMR     TG 2350  SRC 2340001  slot 2  CC 1  3.1 s  quality 88%
 18:05:44  multimon-ng   POCSAG  7654321  fn 0  numeric  0207 555 0101
 18:04:10  dsd-fme       DMR     TG 9  SRC 2341001  slot 1  CC 1  1.2 s  quality 91%
 18:03:58  multimon-ng   FLEX    1-2345678  ALN  TEST PAGE 03:58
 18:01:12  dsd-fme       DMR     TG 2350  SRC 2341234  slot 1  CC 1  12.0 s  quality 72%













 ↑↓ select decoder  Enter open  r reconnect  q quit  ? help
```

- Receiver row 1: source id · transport and address · activity + sample age · rate · sample rate ·
  relay clients. Row 2: window · centre · control owner · last command age. Groups drop by priority, with
  relay clients and centre first.
- Decoders: the section title sits in the column-header row. It has no summary line, because the strip
  already gives the counts. `!` in `drop now` marks branches in backpressure now. ↑↓ selects a row and
  Enter opens that decoder in view 2.
- Messages header: `N in 60s · M total`, plus `paused · K new` and `filter …` when they apply. Newest first.

**80 × 24, live** (compact: switcher folds into the footer, no separators, 8 message rows available).

```
 api ● 2s  iq ● streaming  rx 445.971 MHz  decoders 1 failing  drops 34%   18:07
 RECEIVER  pi-iq   ● streaming · sample age 4 ms   4.1 MB/s
 window    444.947–446.995 MHz   external control
   DECODERS          process             decodes           drop now  window
 ● dsd-fme           up 52s              2/min · 9s ago         12%  in
 ● multimon-ng       up 51s              1/min · 21s ago        14%  in
 ● rtl433            up 51s              none for 51s          !15%  out
 ● readsb            up 51s              none for 51s          !38%  out
 × acarsdec          down · 13 restarts  —                        —  out
 ● ais-catcher       up 51s              none for 51s          !31%  out
 ● dumpvdl2          up 50s              none for 50s          !40%  out
 ● direwolf          up 50s              none for 50s           11%  out
 ● lora-meshtastic   up 50s              none for 50s            9%  out
 MESSAGES  3 in 60s · 7 total
 18:07:41  dsd-fme       DMR     TG 2350  SRC 2341234  8.4 s  encrypted  …
 18:07:20  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG…
 18:07:02  dsd-fme       DMR     TG 2350  SRC 2340001  3.1 s  quality 88%  …
 18:05:44  multimon-ng   POCSAG  7654321  fn 0  numeric  0207 555 0101
 18:04:10  dsd-fme       DMR     TG 9  SRC 2341001  1.2 s  quality 91%  …
 18:03:58  multimon-ng   FLEX    1-2345678  ALN  TEST PAGE 03:58
 18:01:12  dsd-fme       DMR     TG 2350  SRC 2341234  12.0 s  quality 72%  …
 Overview · 1-5 views  ↑↓ select  Enter open  r reconnect  q quit  ? help
```

**60 × 20, live** (narrow: lifetime and nominal columns gone, cells use minimal variants, message type
column dropped).

```
 api ● 2s  iq ● streaming  decoders 1 failing  drops 34% now
 RECEIVER  pi-iq   ● streaming   4.1 MB/s
 window    444.947–446.995 MHz
   DECODERS         process     decodes       drop  window
 ● dsd-fme          up 52s      9s ago         12%  in
 ● multimon-ng      up 51s      21s ago        14%  in
 ● rtl433           up 51s      none for 51s  !15%  out
 ● readsb           up 51s      none for 51s  !38%  out
 × acarsdec         down        —                —  out
 ● ais-catcher      up 51s      none for 51s  !31%  out
 ● dumpvdl2         up 50s      none for 50s  !40%  out
 ● direwolf         up 50s      none for 50s   11%  out
 ● lora-meshtastic  up 50s      none for 50s    9%  out
 MESSAGES  3 in 60s · 7 total
 18:07  dsd-fme      TG 2350  SRC 2341234  8.4 s  …
 18:07  multimon-ng  1234567  fn 3  FIRE ALARM ACTIVATION -…
 18:07  dsd-fme      TG 2350  SRC 2340001  3.1 s  …
 Overview · 1-5 views  ↑↓ select  Enter open  q quit  ? help
```

**200 × 50, live** (ultra: two columns, Messages gets the full content height). Rows 1-16 of 49 are shown.
Rows 17-48 are empty in this state because only 7 messages are cached; row 49 is the footer
` ↑↓ select decoder  Enter open  r reconnect  q quit  ? help`.

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz ±1.024 · external control  decoders 8/9 up · 1 failing · 2 in window  drops 34% now                                                           18:07
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

 RECEIVER  pi-iq · rtl_tcp 192.0.2.23:5555   ● streaming · sample age 4 ms   4.1 MB/s · 2.048 MS/s              MESSAGES  3 in 60s · 7 total
 window    444.947–446.995 MHz · centre 445.9707   external control · 192.0.2.1   last command 6m ago           18:07:41  dsd-fme       DMR     TG 2350  SRC 2341234  8.4 s  encrypted  …
                                                                                                                18:07:20  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG STREE…
   DECODERS          process             decodes           drop now  lifetime  nominal MHz      window          18:07:02  dsd-fme       DMR     TG 2350  SRC 2340001  slot 2  3.1 s  quality 88%  …
 ● dsd-fme           up 52s              2/min · 9s ago         12%       36%  tuned            in              18:05:44  multimon-ng   POCSAG  7654321  fn 0  numeric  0207 555 0101
 ● multimon-ng       up 51s              1/min · 21s ago        14%       39%  tuned            in              18:04:10  dsd-fme       DMR     TG 9  SRC 2341001  slot 1  CC 1  1.2 s  quality 91%
 ● rtl433            up 51s              none for 51s          !15%       41%  433.920          out             18:03:58  multimon-ng   FLEX    1-2345678  ALN  TEST PAGE 03:58
 ● readsb            up 51s              none for 51s          !38%       44%  1090.000         out             18:01:12  dsd-fme       DMR     TG 2350  SRC 2341234  slot 1  12.0 s  quality 72%  …
 × acarsdec          down · 13 restarts  —                        —         —  131.550–131.825  out
 ● ais-catcher       up 51s              none for 51s          !31%       36%  161.975/162.025  out
 ● dumpvdl2          up 50s              none for 50s          !40%       41%  136.650–136.975  out
 ● direwolf          up 50s              none for 50s           11%       35%  144.390/144.800  out
 ● lora-meshtastic   up 50s              none for 50s            9%       30%  869.525/906.875  out
```

**80 × 24, API unreachable, cache from 2m 31s ago.** Everything below the banner is dim. Drops are `?`.
Decode ages keep ticking (T6). The open gap row sits at the top of the feed.

```
 api × 2m 31s  iq ? unknown  rx 445.971 MHz  decoders 1 failing  drops ?   18:10
 ! API unreachable · ECONNREFUSED · retry in 4s · data as of 18:07:40
 RECEIVER  pi-iq   ● streaming · sample age 4 ms   4.1 MB/s
 window    444.947–446.995 MHz   external control
   DECODERS          process             decodes           drop now  window
 ● dsd-fme           up 52s              2m 40s ago               ?  in
 ● multimon-ng       up 51s              2m 52s ago               ?  in
 ● rtl433            up 51s              none for 51s             ?  out
 ● readsb            up 51s              none for 51s             ?  out
 × acarsdec          down · 13 restarts  —                        —  out
 ● ais-catcher       up 51s              none for 51s             ?  out
 ● dumpvdl2          up 50s              none for 50s             ?  out
 ● direwolf          up 50s              none for 50s             ?  out
 ● lora-meshtastic   up 50s              none for 50s             ?  out
 MESSAGES  feed stopped 18:07:40 · 7 cached
 ── gap since 18:07:40 · 2m 31s ──
 18:07:41  dsd-fme       DMR     TG 2350  SRC 2341234  8.4 s  encrypted  …
 18:07:20  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG…
 18:07:02  dsd-fme       DMR     TG 2350  SRC 2340001  3.1 s  quality 88%  …
 18:05:44  multimon-ng   POCSAG  7654321  fn 0  numeric  0207 555 0101
 18:04:10  dsd-fme       DMR     TG 9  SRC 2341001  1.2 s  quality 91%  …
 Overview · 1-5 views  ↑↓ select  Enter open  r reconnect  q quit  ? help
```

With no cache (cold start, API down), sections render `no data · API unreachable` instead of rows, and the
decoders lane reads `decoders ?`.

**80 × 24, REST failing, WS live.** WS-fed values (drops, tuner window, `metrics`, messages) stay bright.
REST-fed cells (process, decode rate) are dim and their rates are dropped. The `iq` lane falls back to
`receiving` (T2).

```
 api ws ● rest × 45s  iq ● receiving  decoders 1 failing  drops 34%        18:09
 ! REST failing · timeout 2s · retry in 3s · REST data as of 18:08:20
 RECEIVER  pi-iq   ● receiving · 4.1 MB/s
 window    445.501–447.549 MHz   external control
   DECODERS          process             decodes           drop now  window
 ● dsd-fme           up 52s              9s ago                 12%  in
 ● multimon-ng       up 51s              21s ago                14%  in
 ● rtl433            up 51s              none for 51s          !15%  out
 ● readsb            up 51s              none for 51s          !38%  out
 × acarsdec          down · 13 restarts  —                        —  out
 ● ais-catcher       up 51s              none for 51s          !31%  out
 ● dumpvdl2          up 50s              none for 50s          !40%  out
 ● direwolf          up 50s              none for 50s           11%  out
 ● lora-meshtastic   up 50s              none for 50s            9%  out
 MESSAGES  3 in 60s · 7 total
 18:07:41  dsd-fme       DMR     TG 2350  SRC 2341234  8.4 s  encrypted  …
 18:07:20  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG…
 18:07:02  dsd-fme       DMR     TG 2350  SRC 2340001  3.1 s  quality 88%  …
 18:05:44  multimon-ng   POCSAG  7654321  fn 0  numeric  0207 555 0101
 18:04:10  dsd-fme       DMR     TG 9  SRC 2341001  1.2 s  quality 91%  …
 18:03:58  multimon-ng   FLEX    1-2345678  ALN  TEST PAGE 03:58
 Overview · 1-5 views  ↑↓ select  Enter open  r reconnect  q quit  ? help
```

### 6.2 Decoders

**120 × 40, readsb selected, detail as a bottom pane.** The selected row is inverse cyan on the glyph and name.

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz  decoders 8/9 up · 1 failing · 2 in window  drops 34% now     18:07
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

   DECODERS          process     restarts  errors  decodes          events     IQ in  drop now  lifetime  window
 ● dsd-fme           up 52s             0       0  2/min · 9s ago        3  831.5 MB       12%       36%  in
 ● multimon-ng       up 51s             0       0  1/min · 21s ago       2  761.1 MB       14%       39%  in
 ● rtl433            up 51s             0       0  none for 51s          0  625.9 MB      !15%       41%  out
 ● readsb            up 51s             0       6  none for 51s          0  570.6 MB      !38%       44%  out
 × acarsdec          down              13       0  —                     0   43.5 MB         —         —  out
 ● ais-catcher       up 51s             0       0  none for 51s          0  832.5 MB      !31%       36%  out
 ● dumpvdl2          up 50s             0       0  none for 50s          0  656.8 MB      !40%       41%  out
 ● direwolf          up 50s             0       0  none for 50s          0  750.7 MB       11%       35%  out
 ● lora-meshtastic   up 50s             0       0  none for 50s          0  116.4 MB        9%       30%  out

 readsb    ADS-B · network producer · IQ in, JSON lines out · pid 1531 · version —
 process   up 51s · 0 restarts · 6 errors · server health idle
 decodes   none since start (51s) · 0 events · last output —
 IQ        570.6 MB in · branch decoder-readsb · buffer 380 KB, high-water 256 KB · in backpressure 0.2s, 121× total
 drops     38% now · 44% lifetime · 166.5 MB in 3 357 chunks · last drain 0.3s ago
 band      1090.000 MHz nominal · window 444.947–446.995 MHz · out of window
 activity  ▁▁▁▁▁▁                         decodes/min since 18:01 (6 of 30 min observed)

















 ↑↓ select  Esc close  x stop  R restart  r reconnect  q quit  ? help
```

Detail rows: identity (type, integration pattern, input → output from `caps`, pid, version) · process
(uptime, restarts, errors, server health quoted as `server health <value>`) · decodes (since start,
events, last output) · IQ (bytes in, branch id, buffer vs high-water, backpressure state and count) ·
drops (now, lifetime, bytes and chunks, last drain) · band (nominal, window, in/out) · activity
sparkline. The sparkline holds 30 one-minute buckets of decode counts, taken from REST `eventsOut`
deltas. Buckets from before the CLI started observing are blank, not `▁`, and the label says how much was
observed.

Controls apply to the selected decoder. `s` start appears only when the decoder is not running, `x` stop
only when it is running, and `R` restart is always available. A control key replaces the footer with the
confirm bar:

```
 ▶ restart readsb · up 51s · pid 1531   y restart  n cancel
```

After `y`, the detail header shows `restart sent 18:07:52`. It then shows `restarted 18:07:53` when
`decoder:started` arrives, or `restart failed · 502 · <server message, truncated>`. The result line clears
after 10 s. A decoder this CLI stopped renders `○ stopped` (neutral) for the rest of the session. Any
other `running: false` renders `× down`.

### 6.3 Messages

**120 × 40, paused, filtered, detail open.** This mockup uses the mock server's synthetic `burst` fixture,
which deliberately mixes protocols.

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 1090.000 MHz  decoders 9/9 up · 1 in window  drops 0% now                 18:12
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

 MESSAGES  paused · 4 new · filter readsb,ais · 41 of 612
 18:12:10  readsb        ADS-B   4CA9D2  EI-DCL  RYR4KT  B738  FL370 ↓  451 kt  51.47,-0.45  SE  !7700
 18:12:04  ais-catcher   AIS     235012345  SEA PRINCESS OF THE NORTHERN WATERS  passenger  51.50,-0.12  12.1 kn
 18:11:58  readsb        ADS-B   4CA9D2  EI-DCL  RYR4KT  B738  FL375 ↓  449 kt  51.49,-0.47  SE  !7700
 18:11:31  readsb        ADS-B   3C6444  D-AIUE  DLH4XP  A320  FL120 ↑  312 kt  51.21,-0.31  NE
 18:11:30  ais-catcher   AIS     244660123  EEMS SPIRIT  cargo  51.44,0.21  8.4 kn
 18:11:02  readsb        ADS-B   4CA9D2  EI-DCL  RYR4KT  B738  FL380 ↓  447 kt  51.51,-0.49  SE  !7700
 ── gap 18:08:37–18:10:41 · 2m 04s · not replayed ──
 18:08:37  ais-catcher   AIS     235012345  SEA PRINCESS OF THE NORTHERN WATERS  passenger  51.50,-0.13  12.0 kn
 18:08:12  readsb        ADS-B   4CA9D2  EI-DCL  RYR4KT  B738  FL390 ↓  445 kt  51.53,-0.51  SE  !7700

 readsb · aircraft · 18:12:10.412
 icao 4CA9D2   reg EI-DCL   flight RYR4KT   type B738   squawk !7700 emergency
 alt 37 000 ft ↓ 1 216 ft/min   speed 451 kt   track 134° SE   position 51.4712, -0.4521   rssi -12.3 dBm
 seen 0.4s ago   messages 1 204
 {
   "hex": "4ca9d2", "flight": "RYR4KT ", "r": "EI-DCL", "t": "B738", "alt_baro": 37000, "baro_rate": -1216,
   "gs": 451.2, "track": 134.1, "lat": 51.4712, "lon": -0.4521, "squawk": "7700", "rssi": -12.3, "seen": 0.4,
   "messages": 1204
 }















 ↑↓ select  PgUp PgDn scroll  y copy JSON  Esc close  / filter  p resume  G newest  q quit  ? help
```

- **Filter.** `/` opens an input row under the header. Its footer carries the grammar, and that is the
  only place the grammar appears:

```
 / readsb,ais !emerg▏
 Enter apply  Esc cancel  space = and  , = or  !emerg = emergencies only
```

  Terms are separated by spaces and AND-ed. A comma inside a term means OR (`readsb,ais`). Each term
  matches the rendered row text case-insensitively, including the decoder id and type. `!emerg` keeps
  emergency squawks (7500/7600/7700) and messages flagged as emergency or alert only. Enter applies and
  Esc cancels the edit. When the input is closed, Esc clears the applied filter. `F` cycles the presets
  `all → aircraft → voice → pager → data` (by message and decoder type). A preset is AND-ed with the
  filter text and shown in the header as `preset aircraft`.
- **Pause.** `p` freezes the visible slice. Events keep entering the ring buffer, and the header counts
  `K new` among those that match the filter. Pressing ↑ while following newest auto-pauses, so the
  selected row cannot move. `G` or `p` resumes following newest. Rows evicted while paused disappear from
  the bottom of the frozen slice. No row is ever replaced in place.
- **Gaps.** When the WS is down, an open gap row `── gap since 18:07:40 · 2m 31s ──` sits at the top. On
  reconnect it closes as `── gap 18:08:37–18:10:41 · 2m 04s · not replayed ──` and stays at its place in
  the sequence.
- **Detail.** It shows the selected row's protocol fields as label/value lines, followed by pretty-printed
  JSON. PgUp/PgDn scroll the detail, and ↑↓ keep moving the selection while the detail follows it. `y`
  writes the JSON to the clipboard with OSC 52 and reports `copy sent (OSC 52)`. Whether the terminal
  accepts OSC 52 cannot be observed, so the copy says only what was done.
- **Empty states.** With the feed live and nothing received: `no decodes since 18:01 (6m) · 2 of 9
  decoders in window · rx 445.971 MHz`. With a filter that matches nothing: `0 of 612 match "readsb !emerg"`.
- **Aircraft enrichment.** readsb rows are enriched from the aircraft lane (registration, type) by ICAO.
  With the `aircraft` preset, the header adds `14 tracked · 9 with position` from `aircraft:stats`.

### 6.4 Receiver

**120 × 40, external control.**

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz  decoders 8/9 up · 1 failing · 2 in window  drops 34% now     18:07
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

 SOURCE    pi-iq · rtl_tcp 192.0.2.23:5555   ● connected   ● streaming · sample age 4 ms · timeout 10 s
 rate      4.1 MB/s (2.048 MS/s U8 IQ)   received 1.2 GB   reconnects 0   last error —   assigned 9 decoders

 TUNER     external control · relay client-3 192.0.2.1:59430 · 42 commands · last set-frequency 6m ago
 frequency 445 970 700 Hz   window 444.947–446.995 MHz   sample rate 2 048 000 S/s   ppm 0
 gain      manual · index 11 (R828D)   rtl agc off   bias-t off   direct sampling off   offset tuning off
 in window dsd-fme, multimon-ng (tuned)
 out       readsb, ais-catcher, acarsdec, dumpvdl2, direwolf, rtl433, lora-meshtastic

 RELAY     listening :4713 · 1 of 4 clients · 545.5 MB sent · exclusive control · last error —
 18:01:20  client-3 192.0.2.1:59430  set-frequency          445 970 700
 18:00:56  client-3 192.0.2.1:59430  set-frequency          446 860 476
 18:00:50  client-3 192.0.2.1:59430  set-tuner-gain-index            11
 18:00:38  client-3 192.0.2.1:59430  set-frequency          446 860 476
 18:00:20  client-3 192.0.2.1:59430  set-frequency          446 524 920

 FANOUT    decoder branches: 34% of offered IQ dropped now · 4 of 9 in backpressure · 4.1 MB/s offered each
 lifetime  1.9 GB offered per branch · 639.3 MB dropped across branches (33%) · relay branch 0 dropped
 upstream  Pi rtlmux → core: 3.5 MB dropped lifetime (0.29%) · 0 B/s now · checked 2s ago
















 c take control  r reconnect  q quit  ? help
```

- SOURCE shows transport and activity separately (`● connected   ● streaming · sample age 4 ms`). It
  includes `available` only when it is false (`no assignment capacity`), because `true` carries no
  information here. `last error` is quoted verbatim, sanitised and truncated.
- TUNER takes its values from `TunerState` (WS + REST). When `relay.lastFrequency` differs from
  `TunerState.frequency`, a third row appears: `relay last set 446 524 920 Hz 18:00:20`. The in/out
  window lists are given here once, in full. Elsewhere, membership lives in the decoders table.
- RELAY: listening address, clients of max, bytes sent, control policy and last error, then
  `commandHistory` newest first, filling the rows that remain (none at all in compact height if space is short).
- FANOUT: drop now over decoder branches, backpressure count and offered rate per branch, then lifetime
  totals. `offered` is the name for `totalBytesWritten`, which counts bytes offered before the drop check.
  It is never called "flowed" or "delivered". UPSTREAM shows Pi rtlmux → core drops from `sourceBackpressure`.
- Footer: `e edit tuner` appears only under `wavekit control`. Under external control the footer shows
  `c take control`, and `e` reports `controlled externally · c to take control`.

**Edit mode** (`e`). The TUNER block gets a magenta `EDIT` tag and a cursor field. Nothing is sent while
editing. The `affects` row is recomputed on every keystroke from the pending window (§10.9):

```
 TUNER     EDIT · wavekit control · nothing sent until confirmed
 frequency 446 0│00 000 Hz   window 444.976–447.024 MHz   sample rate 2 048 000 S/s   ppm 0
 gain      manual · 20.7 dB   rtl agc off   bias-t off   direct sampling off   offset tuning off
 pending   frequency 445 970 700 → 446 000 000 · gain 0.0 → 20.7 dB
 affects   dsd-fme, multimon-ng (tuned) · no decoder enters or leaves the window
```

Edit footer (one place for these hints):

```
 ←→ digit  ↑↓ change  0-9 type  Tab next field  Space toggle  Enter review  Esc discard
```

Fields: frequency (digit cursor, ↑↓ ± that digit, typing replaces) · sample rate (cycles the RTL-SDR
valid rates) · gain (0.1 dB steps, manual mode only) · ppm · toggles (gain mode, rtl agc, bias-t, direct
sampling off/i/q, offset tuning). Enter opens the review confirm:

```
 ▶ send 2 commands to pi-iq: frequency 446 000 000 Hz (+29.3 kHz), gain 20.7 dB   y send  n back
```

Commands are sent in field order, one POST each, and sending stops at the first failure. The result
replaces the `pending` row for 10 s: `sent · frequency ok 18:07:52 · gain ok` or
`frequency failed · 409 · "device busy" · gain not sent`. Turning bias-t on adds
`· bias-t supplies DC on the antenna port` to the confirm bar. Taking control always confirms:

```
 ▶ take tuner control from relay client-3 192.0.2.1? its next tuning command is refused   y take  n cancel
```

Releasing control (`c` under wavekit control) confirms with `▶ release tuner control to external
clients? y release  n cancel`.

### 6.5 System

**120 × 40.**

```
 api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz  decoders 8/9 up · 1 failing · 2 in window  drops 34% now     18:07
 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System

 CONTAINER cgroup v2 · as of 2s ago
 cpu       240%   throttled —   oom kills 0
 mem       1.94 GB · no limit
 alerts    ! container-cpu critical "High CPU usage: 273.5%" · 412× since 18:01 · last 1s ago

 SDR HOST  pi-iq · http://192.0.2.23:8080 · polled by core 2s ago · uptime 4m 51s
 rtl_tcp   ● running · pid 58 · 0 restarts
 rtlmux    ● running · pid 63 · 1 client · 4.2 MB/s · 1.2 GB sent · 0 restarts
 dongle    RTL-SDR Blog V4 · serial —

 AUDIO     ○ stopped · 0 clients · 127.0.0.1:8081/stream
 demod     pi-iq at 445.9707 MHz · nfm 12.5 kHz · squelch 0 · gain 10 · 48 kHz s16le

 CORE      v1.0.0 · uptime 7m 40s · reports degraded





















 a start audio  P preset  r reconnect  q quit  ? help
```

- CONTAINER: `cpu` is the raw container percentage with no bar and no verdict colour. Values above 100 %
  are normal on multi-core, and the API does not report a core count. `mem` reads `of <limit> (N %)` when a
  limit exists and `no limit` otherwise. `alerts` dedupes `resources:alert` by (type, sourceId, severity).
  It shows the server's severity word and message verbatim, with a count, the first time seen and the last
  age. Up to 3 alert rows; more become `+N more`.
- SDR HOST: one block per `sdrHosts[]` entry. It shows `polled by core <age>` from `lastFetchedAt`.
  `fetchError` becomes `× core cannot reach the Pi API · <fetchError>`, and the block's rows go dim.
  Warnings and errors are listed verbatim. **Sampling slot:** the guard `readHostSampling(host)` accepts an
  optional `sampling` field shaped like `SdrHostSampling` (type imported from `@wavekit/api-types`, read-only)
  on a host entry. When it is present and valid, a `sampling` row renders between `rtlmux` and `dongle`:

```
 sampling  ● streaming · sample age 0.2s · 4.1 MB/s upstream (nominal) · 0 resets
```

  When it is absent the row is omitted. Nothing is inferred, and the Pi is never polled directly. Request 6
  in `docs/CLI-COORDINATION.md` tracks core surfacing it.
- AUDIO: status, clients and the stream URL taken from `httpUrl`, followed by a demod row (source, the
  centre it demodulates, modulation, bandwidth, squelch, gain and output format). `a` starts and stops
  audio without a confirm and shows a result line: `audio started · 0 clients` or
  `audio start failed · 503 · source not connected`. `P` opens a confirm for the next preset
  (`▶ apply audio preset "<name>" (nfm 12.5 kHz)? y apply  n cancel  P next`), and `y` sends it as
  `PATCH /api/live-audio/config` with that preset's config.
- CORE: version, uptime and the overall `/api/status` value quoted as `reports <status>`. Below it, one row
  for each non-decoder component that the server reports with a message, quoted verbatim. Decoder
  components are left out because view 2 covers them.

### 6.6 Help overlay, too-small, error boundary

`?` replaces the content area with a centred 60-column box, the only bordered element. It lists the
current view's keys first, then the global keys, then the legend. Any key closes it. Decoders example:

```
┌─ keys · Decoders ────────────────────────────────────────┐
│ ↑↓ j k     select            Enter    open detail        │
│ s x R      start stop restart (asks to confirm)          │
│ Esc        close detail                                  │
│                                                          │
│ 1-5 Tab    views             r        reconnect + refetch│
│ ?          this help         q        quit               │
│                                                          │
│ ● live  ○ idle or off  × fault  ! now  ? unknown         │
│ dim  older than 15 s      — not applicable               │
│ nominal  band from WaveKit's built-in table, not the API │
└──────────────────────────────────────────────────────────┘
```

Too small: `wavekit: terminal 50×12 is too small (minimum 60×16)`. Error boundary (mounted at the root): `wavekit: render error · <message> ·
q quit`. The runtime keeps polling, and `r` remounts the tree.

## 7. Keyboard model

One root `useInput`. The pure `resolveKey(mode, view, ctx, key) → Action | undefined` walks modes from
highest priority: `confirm → help → input → edit → detail → list → global`. A key the active mode does not
handle falls through to the next one. No component registers its own `useInput`.

| Key | Mode / view | Action |
|---|---|---|
| `1`-`5` | global (not input/edit) | switch view |
| `Tab` / `Shift-Tab` | global (not input/edit) | next / previous view |
| `?` | global (not input/edit) | help overlay; any key closes |
| `q`, `Ctrl-C` | global (in input, `q` types; Ctrl-C always quits) | quit, restoring the screen |
| `r` | global | reconnect WS now, refetch all REST, reset backoff |
| `↑ ↓` `j k` | list, detail | move selection (the detail follows) |
| `PgUp PgDn` | list / detail | page the list / scroll the detail |
| `g` / `G` | list | top / newest (in Messages, `G` resumes follow) |
| `Enter` | list | open the detail (Overview: open in view 2) |
| `Esc` | detail → list → Messages filter | close detail, else clear selection, else clear filter |
| `/` | Messages | filter input |
| `p` | Messages | pause / resume |
| `F` | Messages | cycle preset |
| `y` | Messages detail | copy JSON (OSC 52) |
| `s` `x` `R` | Decoders, row selected | start / stop / restart → confirm |
| `e` | Receiver | tuner edit mode (wavekit control only) |
| `c` | Receiver | take / release control → confirm |
| `←→` `↑↓` `0-9` `Tab` `Space` `Backspace` | edit | digit cursor, change digit, type, next field, toggle, delete |
| `Enter` / `Esc` | edit | review → confirm / discard edits |
| `y` / `n`, `Esc` | confirm | confirm / cancel (Enter does not confirm) |
| `P` | confirm (audio preset) | next preset |
| `a` / `P` | System | audio start/stop / preset → confirm |

- **Keymap as data.** `ui/keymap.ts` exports a binding table
  `{ mode, views?, keys, action, hint?, when?(ctx) }`. Both `resolveKey` and `footerHints` read this one
  table, so a hint can never name a key that is not handled. The footer is a `fitGroups` line with this
  priority: `? help` [0], mode keys [1], switcher (compact) [2], `q quit` [3], `r reconnect` [4]. Hints
  appear in one place only. Section headers carry none.
- **Writes** are produced only by `confirm` actions (`y`). Navigation keys, digits outside edit mode, Tab,
  Enter and Esc can never produce a write action (property P20).
- Ink 5 parses keys per stdin chunk. If tmux validation shows Esc misread as Meta-x, a 20 ms escape buffer
  is added in `hooks/use-keys.ts` (§15).

## 8. Visual language

- **Glyphs** are BMP and one column wide, with no emoji: `●` live/up · `○` neutral (idle, off, starting,
  stopped) · `×` fault (down, crash-loop, unreachable) · `!` attention now (prefix: backpressure, emergency,
  alert) · `?` unknown · `—` not applicable · `…` truncated · `·` separator · `─` gap rule · `▁▂▃▄▅▆▇█`
  sparkline · `↑↓` vertical trend · `▶` confirm. `WAVEKIT_ASCII=1`, or a locale without UTF-8, swaps them
  for `* o x ! ? - ... | - >`.
- **Roles → 16-colour ANSI.** Accent `cyan` (selection, active view, focused field, filter text) · live
  `green` · attention `yellow` · fault `red` · edit/confirm `magenta` (tag and glyph only) · `dim` (labels,
  units, ages, help, old data) · default foreground for values. The only backgrounds are inverse for the
  selection, the active view name and the confirm bar. `NO_COLOR` (or a non-TTY stdout) drops all colours
  but keeps bold, dim and inverse. Every state already carries a glyph or word, so no state depends on colour.
- **Typography.** Bold: strip values, section titles, the selected row name. Dim: labels, units, ages. Never
  underline. No OSC 8 hyperlinks in v1.
- **Grid.** One leading space. Two spaces between strip lanes and table columns, three between key/value
  groups on a row, and ` · ` inside a group. Section titles are bold uppercase in a 10-column label gutter,
  followed by values on the same row. There are no borders except the help box.
- **Numbers.** SI units with a space (`4.1 MB/s`, `1.94 GB`, `2.048 MS/s`). Frequencies are
  `445.971 MHz` (3 decimals) in the strip and tables, `445.9707` (4) in the Receiver window row, and
  `445 970 700 Hz` in tuner fields and history. `dataRate` from core is KiB/s (fixture 3994 at 2.048 MS/s
  U8 = 4.096 MB/s); convert it before formatting. Percentages are integers. Rates are `3/min` below 60/min,
  else `1.2/s`. Ages are `<1s`, `9s`, `2m 40s` (under 10 min), `12m`, `2h 10m`, `3d`. Negative ages caused by
  clock skew render `<1s`. Absolute `HH:MM:SS` appears only in message rows, gap rows, results and `as of`.
- **Truncation.** Lists never wrap. Cells use variants first and `…` last. Free-text payloads (pager
  bodies, AIS names) are cut at the row end. Ids longer than their column end in `…`. The detail pane wraps.

## 9. States and copy

Exact copy. Each banner is one line, fitted with `fitGroups` (the leftmost group has the highest
priority). When several conditions hold, the banner shows the highest-priority one plus `· +N`.

| Situation | Where | Copy |
|---|---|---|
| Cold start | strip / sections | `api ○ connecting` / `fetching /api/decoders` (one row, no spinner) |
| API unreachable, no cache | banner / sections | `! API unreachable · ECONNREFUSED · retry in 4s · 127.0.0.1:9000` / `no data · API unreachable` |
| API unreachable, cache | banner | `! API unreachable · ECONNREFUSED · retry in 4s · data as of 18:07:40` |
| Discovery (no explicit URL) | banner | `! API unreachable · tried 127.0.0.1:9000, 127.0.0.1:3000 · retry in 4s` |
| WS down, REST up | strip / banner | `api ws × rest ● 2s` / `! live feed down · ws closed 1006 · REST every 5s · retry in 8s` |
| REST down, WS up | strip / banner | `api ws ● rest × 45s` / `! REST failing · timeout 2s · retry in 3s · REST data as of 18:08:20` |
| One endpoint failing | banner | `! GET /api/resources failing · 500 · other endpoints answering` |
| Lane older than 15 s | cells | dim; banner carries `data as of` |
| `activity` absent | iq lane | `iq ● connected` (never `streaming`) |
| Samples stopped | iq lane | `iq × no samples 23s` (state `stale`, age from `sampleAgeMs`) |
| Source disconnected | iq lane / Receiver | `iq × disconnected` / `last error ECONNREFUSED 192.0.2.23:5555 · reconnect #3` |
| No decoders configured (REST 200 `[]`) | Decoders | `no decoders configured` |
| Decoder up, no decodes | decodes cell | `none for 51s` (neutral) |
| Decoder starting (< 10 s, 0 events) | process | `○ starting 4s` |
| Decoder down | process | `× down · 13 restarts` / `× down` |
| Crash loop (≥ 2 restarts observed in 5 min) | process | `× crash-loop · 15 restarts` |
| Faulted | process | `× faulted` |
| Stopped by this CLI | process | `○ stopped` |
| Drop now not computable | drop cells / FANOUT | `?` / `drop now ? · needs 2 snapshots in 10s` |
| Feed paused | Messages header | `paused · 4 new` |
| Feed gap | list row | `── gap 18:08:37–18:10:41 · 2m 04s · not replayed ──` |
| Tuner under external control | Receiver on `e` | `controlled externally · c to take control` |
| Action pending / ok / failed | detail or block header | `restart sent 18:07:52` / `restarted 18:07:53` / `restart failed · 502 · <msg>` |
| Audio action | System | `audio started · 0 clients` / `audio start failed · 503 · source not connected` |
| Unknown value | any | `?`; not applicable `—` |

**Banned anywhere in rendered output** (a test enforces this, §13.2): `Waiting for`, `No … yet`, `Loading`,
`OK`, `healthy`, `stable`, `all good`, `receiver OK`, `Status:`, `n/a`, `N/A`, `unavailable` without a
reason, `successfully`, `please`, `!` at the end of a sentence, `360°`, `press N to view`, a bare
`Connected` with no subject, and the drop-blame words in T8. Emoji are banned too.

## 10. Architecture — data layer

Everything in `cli/source/data/` is plain TypeScript. It imports neither `ink` nor `react`, so root vitest
tests can import it, and it must compile under the root strict flags.

### 10.1 API base resolution (`config.ts`)

One resolver feeds REST, WS and actions alike.

- **Precedence:** `--api <url>`, then `WAVEKIT_API_URL` (WS URL derived as `ws(s)://host/ws`), then
  `WAVEKIT_WS_URL` or `WAVEKIT_WS_URLS` (HTTP base derived from it).
- **Discovery** (none set): try `http://127.0.0.1:9000`, then `http://127.0.0.1:3000`, with `GET /health`
  and a 2 s timeout each. The first one that answers becomes the base. Discovery reruns when the base has
  been unreachable for a whole backoff cycle.
- Never `localhost` (IPv6-first resolution), and **never port 4713** (the RTL-TCP relay).

### 10.2 REST client (`api-client.ts`)

- Every request uses `fetch` with `AbortSignal.timeout(2000)`.
- **Poll cycle every 5 s**, starting only when the previous cycle has finished. `Promise.allSettled` over:
  `/api/decoders`, `/api/sources`, `/api/tuner`, `/api/tuner-relay`, `/api/telemetry/fanout`,
  `/api/resources`, `/api/live-audio/status`, `/api/status`.
- **At start and after every reconnect:** `/api/live-audio/presets` and `/api/aircraft`.
- Each endpoint's outcome is independent. It becomes either `{ ok, value }` after its guard, or
  `{ error: { kind: "timeout" | "network" | "http" | "invalid", status?, message } }`.
- **Actions:** `POST /api/decoders/:id/{start|stop|restart}`, `POST /api/tuner/:sourceId/<setting>`,
  `POST /api/live-audio/{start|stop}`, `PATCH /api/live-audio/config`. Each returns a typed
  `ActionResult`, and an action triggers an immediate poll of the endpoint it affects. There is no fallback host.

### 10.3 WS client (`ws-client.ts`)

- On open, it subscribes to `decoders`, `health`, `sources`, `metrics`, `fanout`, `live-audio`,
  `resources`, `tuner` and `aircraft`.
- **Backoff:** 1, 2, 4, 8, then 15 s maximum, with ±20 % jitter. The banner counts down to the next
  attempt. `r` resets the backoff and connects immediately.
- Every socket has `error` and `close` handlers, and nothing is ever logged to the console. Close codes and
  messages land in the connection lane.
- Each frame goes through `JSON.parse` in a try block and then through `parseServerMessage` (guards). Bad
  frames increment `conn.invalidFrames`, which is shown in the help overlay's diagnostics line, and are dropped.

### 10.4 Guards (`guards.ts`)

Hand-written type guards, with no Zod and no new dependencies. There is one per DTO (`DecoderStatus`,
`SourceStatus`/`ExtendedSourceStatus`, `TunerState`, `TunerRelayStatus`, `FanoutSnapshot`/`BranchTelemetry`,
`ResourceSnapshot`/`SdrHostStatus`/`ContainerResources`/`SourceBackpressure`, `ResourceAlert`,
`LiveAudioStatus`, `DecoderOutput`, aircraft state/stats, `/api/status`, presets) plus `readHostSampling`.

- Required fields are checked by type. Optional fields are kept only when well-typed, and a malformed
  optional field is dropped, not fatal.
- Arrays are filtered element by element, keeping the valid ones and counting the rejects.
- Types come from `@wavekit/api-types` as `import type` only. The DTO files are read-only for the CLI team.

### 10.5 Runtime, single store and flush (`runtime.ts`, `store.ts`, `reducers.ts`)

The runtime is a non-React object created once in `cli.tsx`. It owns the resolver, the REST poller, the WS
client, an **inbound queue** (the ref buffer) and the **store**.

- **Single store, lanes as slices.** `AppState = { conn, sources, decoders, tuner, relay, fanout,
  resources, alerts, audio, status, messages, aircraft, actions, now }`. Each data slice is
  `Lane<T> = { value: T | undefined, receivedAt: number | null, origin: "rest" | "ws", error?: LaneError }`.
  Errors never clear `value`, and a success clears `error`.
- **Inbound.** WS events and REST results are both pushed onto the inbound queue as typed
  `Inbound` items. Nothing touches the store directly.
- **Flush tick: 200 ms** (unref'd interval).
  1. Drain the queue.
  2. Fold it through the pure `reduce(state, inbound[], tickNow)`.
  3. Advance `now` when a 1 s boundary has passed.
  4. Commit **once** with `store.set(next)`, only if anything changed.

  This gives at most 5 commits/s whatever the event rate. Ink 5 uses a legacy React root, which does not
  batch outside events, so one store with one commit per tick is the batching mechanism.
- **Mutable bulk structures.** The message ring and the aircraft map are mutated inside the reducer and
  exposed as `{ version, ring }` / `{ version, map }`. The version bumps when they change. Views derive
  their slices in memoised selectors keyed on `version`. No per-event copies of 1000-element arrays or
  aircraft maps.
- **React binding.** `hooks/use-store.ts` is `useSyncExternalStore(store.subscribe, () =>
  selector(store.get()))`. Selectors return primitives or values memoised on input identity
  (`memoOne` in `data/memo.ts`), so components whose slice did not change bail out.

**Inbound → lane effects.**

| Inbound | Effect |
|---|---|
| `rest:<endpoint>` ok / error | set the lane value and `receivedAt`, or set its error |
| `decoder:output` | append to the ring (seq++), set the per-decoder `lastWsOutputAt`; readsb rows enriched from aircraft |
| `decoder:started` / `stopped` | mark the decoder's pending action as resolved; schedule an immediate `/api/decoders` poll |
| `decoder:health` | patch the decoder's `health` (record `previousHealth` for the detail pane) |
| `decoder:error` | store `lastError` per decoder (session-only, detail pane) |
| `source:connected` / `disconnected` / `error` | patch the transport flag and `lastError`; schedule an immediate `/api/sources` poll |
| `metrics` | per-source `{ bytesReceived, dataRate, at }` heartbeat (the T2 `receiving` fallback) |
| `fanout:snapshot` | push into the fanout history (dedupe by `timestamp`) |
| `fanout:backpressure` / `drain` | patch that branch's `backpressureActive` and transition time between snapshots |
| `resources:snapshot` / `resources:alert` | set the lane / upsert the deduped alert |
| `tuner:state-changed` / `control-mode-changed` / `command-sent` / `error` | patch `TunerState` / control mode / last command / tuner action result |
| `live-audio:*` | patch the audio status and results |
| `aircraft:new` / `update` / `lost` / `stats` | mutate the map (merge identification) / delete / set stats |
| `ws:open` (`subscribed`) | close the open gap, clear the fanout and rate histories, enqueue a full REST poll and the aircraft resync |
| `ws:close` | open a gap at `lastEventAt ?? closeAt`; record the code and reason |

### 10.6 Rates (`rates.ts`)

- **Drop now, per branch.** Taken from the fanout history within the trailing 10 s, by server `timestamp`:
  `Δ droppedBytesTotal / Δ totalBytesWritten` between the oldest and newest samples.
  - It is unknown (`?`) when there are fewer than 2 samples, when Δt < 2 s, when Δ offered ≤ 0, when any
    counter decreases (reset), when `totalBytesWritten` is absent (older core), or when the history was
    cleared by a gap.
  - The aggregate is `Σ Δ dropped / Σ Δ offered` over branches with a `decoderId`. The relay branch is
    reported separately.
  - With the WS down, REST `/api/telemetry/fanout` keeps feeding the same history, so drop now stays
    computable at a 5 s cadence.
- **Decode rate.** Taken from REST `eventsOut` samples over the trailing 60 s: `Δ eventsOut / Δt`, shown
  once Δt ≥ 20 s. A counter decrease resets the history. REST is used rather than counting WS frames
  because core's WS server drops frames when a client falls behind.
- **Last decode** is the newer of REST `lastOutputAt` and the newest `decoder:output` for that decoder.
- **Sparkline.** Per decoder, `eventsOut` deltas are bucketed into 30 one-minute buckets. A bucket is
  `undefined` until it has been observed.

### 10.7 Decoder state derivation (`decoder-state.ts`)

The rules are evaluated in order. `restartIncrements5m` comes from a per-decoder history of
`restartCount` across REST polls.

| # | Condition | State | Glyph | Process cell (rich → minimal) |
|---|---|---|---|---|
| 1 | `health === "faulted"` | faulted | `×` red | `faulted · N restarts` → `faulted` |
| 2 | `restartIncrements5m ≥ 2` | crash-loop | `×` red | `crash-loop · N restarts` → `crash-loop` |
| 3 | `!running` and stopped by this CLI | stopped | `○` | `stopped` |
| 4 | `!running` | down | `×` red | `down · N restarts` → `down` |
| 5 | `uptime < 10` and `eventsOut === 0` | starting | `○` | `starting 4s` |
| 6 | otherwise | up | `●` green | `up 52s · N restarts` → `up 52s` (suffix only when N > 0) |

`health` never makes a decoder look worse unless it is `faulted`. `running: false` with `health: "running"`
(the audit's acarsdec) is `down`, and the detail pane prints `server health running` so the contradiction
stays visible. Decodes cell: not running → `—`; rate known and > 0 → `2/min · 9s ago` → `9s ago`; last
decode known → `6m ago`; `eventsOut === 0` with no last decode → `none for <uptime>` → `none <uptime>`;
`eventsOut > 0` with no time → `N total`.

### 10.8 Message ring and gaps (`ring-buffer.ts`)

- **Capacity 1000**, with a **per-decoder floor of 50**. When full, the oldest entry whose decoder holds
  more than 50 entries is evicted. If every decoder is at or below the floor, the overall oldest goes.
- Entries are `{ seq, decoderId, type, receivedAt, output, summary }`. `seq` is monotonic for the session
  and is the React key. The summary is computed once at ingest by `ui/messages` formatters, which are pure.
- **Gaps** are stored alongside, as `{ afterSeq, from, to | null }`, and use no capacity. Views interleave
  them by `afterSeq`. Gap rows older than the oldest retained entry are pruned.
- **Aircraft map.** Keyed by upper-case ICAO and merged on update (identification kept). Entries are
  deleted on `lost`, pruned when not updated for 300 s (core's WS can drop `lost` events), and replaced
  wholesale by the `/api/aircraft` resync after each reconnect.

### 10.9 Nominal bands and the tuned window (`nominal-bands.ts`, `window.ts`)

`nominal-bands.ts` is CLI-owned, keyed by decoder **type**. Every rendering says `nominal`.

| type | channels (MHz) | label |
|---|---|---|
| readsb | 1090.000 | `1090.000` |
| ais-catcher | 161.975, 162.025 | `161.975/162.025` |
| acarsdec | 131.550, 131.725, 131.825 | `131.550–131.825` |
| dumpvdl2 | 136.650, 136.700, 136.975 | `136.650–136.975` |
| direwolf | 144.390, 144.800 | `144.390/144.800` |
| rtl433 | 433.920 | `433.920` |
| lora-meshtastic | 869.525, 906.875 | `869.525/906.875` |
| dsd-fme, multimon-ng | tuned (decodes whatever the receiver is tuned to) | `tuned` |

In labels, `/` separates regional alternatives and `–` spans a channel set. Unknown types get `?`.

- **Window.** `centre ± sampleRate / 2`. The centre comes from `TunerState.frequency`, falling back to
  `source.caps.centerFreq`, then `relay.lastFrequency`. The sample rate comes from `TunerState.sampleRate`,
  falling back to `caps.sampleRate`.
- **Decoder → source** is the `assignments` entry. With none, the single source is used if exactly one
  exists. Otherwise the result is `?`.
- **`inWindow(decoder)`:**
  - `tuned` → `in`.
  - Any channel with `|c − centre| ≤ sampleRate / 2` → `in`.
  - Otherwise `out`.
  - Missing window or source → `?`.
  - Decoder not on a shared source (`caps.integrationPattern === "external_sdr"` with no assignment) → `—`.
- **`retuneImpact(decoders, from, to)`** returns `{ tuned: id[], enters: id[], leaves: id[] }` and feeds
  the edit-mode `affects` row and the confirm bar.

### 10.10 Freshness (`freshness.ts`)

- `laneAge(lane, now)`. `isOld(lane, now)` is true when the age exceeds 15 000 ms, the same TTL for every
  lane. A lane that has never been received is "no data", which is distinct from old.
- `conn` derives `wsState`, the REST aggregate (all failing / some failing / ok), `lastRestOkAt`, the
  backoff countdown and the discovery state, which the strip and banner use.
- The existing `utils/source-activity.ts` logic moves here. Its test moves to `tests/unit/cli/freshness.test.ts`,
  keeping its cases.

## 11. Architecture — UI layer and module layout

- **View-models are pure.** `view-models/<view>.ts` takes `(AppState slice, viewState, cols, rows)` and
  returns `Line[]` per region. A line is `Span[]`, and a span is `{ text, role }`, with
  `role ∈ label | value | live | neutral | fault | attention | unknown | old | accent | selected | edit`.
  All fitting happens here.
- **Components render spans.** They map roles to Ink props through `ui/theme.ts`, and contain no layout logic.
- **Lines are memoised** per region on (slice identity, view state, width, the `now` bucket). Ages are
  bucketed (§8), so most 1 s ticks produce identical strings. Ink skips writing an unchanged frame.

```
cli/
  package.json              build → tsc -p tsconfig.build.json; test → vitest run (cli config)
  tsconfig.json             unchanged (editor + typecheck incl. tests)
  tsconfig.build.json       NEW: extends tsconfig.json, excludes **/*.test.tsx and source/test/**,
                            tsBuildInfoFile ./dist/.tsbuildinfo (deleting dist forces a rebuild)
  vitest.config.ts          NEW: include source/**/*.test.tsx, environment node
  source/
    cli.tsx                 entry: args, alt screen, runtime, render, exit/cleanup
    app.tsx                 root: ErrorBoundary, size gate, frame, chrome, view switch, key dispatch
    args.ts                 flags, view aliases, help text (moved from utils/args.ts)
    data/                   (pure, no ink/react)
      types.ts              AppState, Lane, Inbound, MessageEntry, Gap, ActionResult, LaneError
      config.ts             API base resolution + discovery (§10.1)
      api-client.ts         fetch wrapper, endpoints, actions (§10.2)
      ws-client.ts          connection, backoff, subscribe (§10.3)
      guards.ts             DTO guards + readHostSampling (§10.4)
      store.ts              createStore<T>: get/set/subscribe
      runtime.ts            Runtime: poller, ws, inbound queue, flush tick, actions (§10.5)
      reducers.ts           reduce(state, inbound[], now) (§10.5 table)
      rates.ts              drop now, decode rate, sparkline buckets (§10.6)
      decoder-state.ts      process state + decodes cell inputs (§10.7)
      ring-buffer.ts        message ring + gaps + aircraft map helpers (§10.8)
      nominal-bands.ts      table (§10.9)
      window.ts             window, inWindow, retuneImpact (§10.9)
      freshness.ts          lane age/old, conn derivations (§10.10)
      memo.ts               memoOne
    ui/                     (pure, no ink/react)
      line.ts               Span, Role, Line, Group types
      text.ts               cellWidth, sanitize, truncate, pad
      format.ts             bytes, rates, freq, ages, percentages, counts (replaces utils/format.ts)
      fit.ts                fitGroups (§5.2)
      columns.ts            layoutColumns + cell variant choice (§5.2)
      frame.ts              height/width classes, frameBudget, detail placement (§5.1)
      strip.ts              chain strip lanes + variants (§4)
      banner.ts             banner selection + copy (§9)
      keymap.ts             binding table, resolveKey, footerHints (§7)
      actions.ts            Action union (navigation, view, edit, confirm, write intents)
      filter.ts             parse/print/apply filter, presets (§6.3)
      tuner-edit.ts         edit-mode state machine → pending commands (§6.4)
      theme.ts              glyph sets (UTF-8/ASCII), role → Ink props, NO_COLOR
      messages/             per-protocol formatters → { segments, fields }:
                            aircraft.ts call.ts pager.ts mesh.ts acars.ts ais.ts rtl433.ts generic.ts index.ts
    view-models/            (pure) overview.ts decoders.ts messages.ts receiver.ts system.ts help.ts
    hooks/
      use-store.ts          useSyncExternalStore + selector
      use-terminal-size.ts  50 ms debounce; one ESC[2J on shrink
      use-keys.ts           root useInput → resolveKey → dispatch
    components/             lines.tsx (Line renderer) chain-strip.tsx switcher.tsx footer.tsx banner.tsx
                            confirm-bar.tsx input-line.tsx help-overlay.tsx too-small.tsx error-boundary.tsx
    views/                  overview.tsx decoders.tsx messages.tsx receiver.tsx system.tsx
    test/                   harness.ts (fake stdout/stdin render), fixtures.ts (load mock scenarios)
    **/*.test.tsx           Ink render tests (cli vitest only)
  tools/
    tsconfig.json           noEmit, allowImportingTsExtensions; checked by the cli typecheck script
    mock-api/server.ts      node:http + ws mock core; run with `node cli/tools/mock-api/server.ts` (Node ≥ 22.18)
    mock-api/scenarios/     sanitised JSON per scenario (§13.3)
    validate/matrix.sh      tmux capture matrix, resize run, burst + perf run (§13.4)
tests/unit/cli/*.test.ts    pure-logic + property tests (root vitest)
docs/CLI.md                 NEW user doc: views, keys, env, terminal limits, measured validation results
```

**Removed:** every file under `components/` (old), `hooks/use-websocket.ts`, `hooks/index.ts`,
`components/index.ts`, `utils/*` (logic moved into `data/` and `ui/`), and `types.ts` (replaced by
`data/types.ts`). Per-protocol formatting moves out of `decoded-message.tsx` into `ui/messages/*.ts` as pure
functions, keeping its protocol coverage: aircraft, DMR/P25 call start and end, pager, Meshtastic, ACARS,
AIS and rtl_433.

**Import rule:** `data/`, `ui/` and `view-models/` never import `ink`, `react` or any `.tsx`. Root
tests import only these directories. `cli/tsconfig.json` keeps its relaxed flags, as the decision pack
requires, but the root typecheck compiles these directories under `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` through the root tests.

## 12. Correctness properties

Each property is tested in `tests/unit/cli/<file>.test.ts` with fast-check (`numRuns: 100`), except P22,
which is enumerated. Tests carry the header
`// Feature: cli-dashboard-overhaul, Property N: <name>` and `// Validates: <spec section>`.

| # | Property | Validates | Test file |
|---|---|---|---|
| P1 | `fitGroups` output `cellWidth ≤ width` for every input with width ≥ 1 | §5.2 | fit |
| P2 | `fitGroups` presence follows priority: a present group implies every higher-priority group is present; display order is preserved | §4.2 | fit |
| P3 | `fitGroups` presence is monotone in width (widening never removes a group) | §4.2 | fit |
| P4 | `layoutColumns`: Σwidths + gaps ≤ width; present columns form a priority prefix; each present column ≥ its min; presence monotone in width | §5.2 | columns |
| P5 | `frameBudget`: for cols ≥ 60 and rows ≥ 16, regions sum to ≤ rows − 1; Overview messages ≥ 3; shown decoder rows + overflow marker account for every decoder | §5.1 | frame |
| P6 | Formatters given `null`/`undefined`/`NaN` return `?` or `—`, never a numeric zero | T5 | format |
| P7 | `sanitize` output contains no C0, C1, ESC or DEL and is idempotent; `truncate(s, w)` has width ≤ w and ends in `…` iff the input was wider | §5.2 | text |
| P8 | `formatAge` never returns a negative or NaN string, and its output is non-decreasing in age across buckets | §8 | format |
| P9 | Ring: size ≤ 1000; seq strictly increasing in iteration; newest entry always present; a decoder that inserted k entries retains ≥ min(k, 50) of its newest when decoders × 50 ≤ 1000 | §10.8 | ring-buffer |
| P10 | Filter: result is an order-preserving subsequence; the empty filter is the identity; adding an AND term never grows the result; `parse(print(f)) = f` | §6.3 | filter |
| P11 | Pause: while paused, visible rows ⊆ the rows at pause time; `new` = matching appends since pause | §6.3 | messages-vm |
| P12 | Drop now ∈ [0, 1] or unknown; unknown under every §10.6 condition; equals Δd/Δo for two valid samples; never spans a gap | §10.6 | rates |
| P13 | Decode rate ≥ 0 or unknown; a counter decrease resets the history | §10.6 | rates |
| P14 | `inWindow`: `tuned` → in; a channel at the centre → in; `|c − centre| > rate/2` for all channels → out; missing window → `?` | §10.9 | window |
| P15 | `retuneImpact` is exactly tuned ∪ {decoders whose `inWindow` flips} and lists no others | §10.9 | window |
| P16 | Process state: red iff faulted, crash-loop or down; `health: "idle"` never yields red or attention; `running: false` never yields up or starting | T3, §10.7 | decoder-state |
| P17 | Freshness: old iff age > TTL; an error never clears a cached value; a success clears the error | T6, §10.10 | freshness |
| P18 | `reduce(s, batch)` equals folding `reduce` over single events; the runtime commits at most once per tick | §10.5 | reducers, runtime |
| P19 | Reconnect: exactly one gap per disconnect with `from ≤ to`; fanout and rate histories are empty after `ws:open`; aircraft keys equal the resync list | §10.5, §10.8 | reducers |
| P20 | Keymap: in input mode every printable key types; no navigation key resolves to a write in any mode; writes resolve only from confirm `y`; every footer hint resolves to an action in its mode | §7 | keymap |
| P21 | Strip honesty: `streaming` only when activity is streaming and fresh; `api ●` only when WS is open and REST fresh; lanes never contain banned words | T1, T2, §9 | strip |
| P22 | Render bound (enumerated): every view × scenario × size in §13.2 renders ≤ rows − 1 lines, each ≤ cols wide, with no banned word | §5.1, §9 | `cli/source/views/*.test.tsx` |

## 13. Testing and validation

### 13.1 Pure logic (root vitest)

`tests/unit/cli/{fit,columns,frame,format,text,ring-buffer,filter,messages-vm,rates,window,decoder-state,
freshness,reducers,runtime,keymap,strip,banner,guards,config,args,tuner-edit,messages-format}.test.ts`.

- Example tests come from the audit fixtures, imported as JSON from `cli/tools/mock-api/scenarios/`.
- Guards get a corpus test that feeds every fixture and every recorded WS sample.
- `config` tests cover precedence and discovery, plus the absence of 4713 and `localhost`.
- `runtime` tests use fake timers with stubbed fetch and ws.

### 13.2 Ink render tests (cli vitest)

- **Harness.** `source/test/harness.ts` provides `renderAt(element, { cols, rows })` returning
  `{ frame(): string[], press(seq), resize(c, r), unmount() }`. It is built on Ink's `render` with
  `debug: true`, `patchConsole: false` and `exitOnCtrlC: false`, a fake stdout (EventEmitter with
  `columns`/`rows`/`write`) and a fake stdin (`setRawMode`, `isTTY`, `read`, `ref`/`unref`). `frame()` is
  the last full frame with ANSI stripped.
- **Matrix.** Scenarios: `live`, `idle`, `api-down` (no cache), `api-down-cached`, `ws-only`,
  `rest-only`, `dropping`, `crash-loop`, `legacy` (no `activity`, no `totalBytesWritten`), `long-text`,
  `burst`. Sizes: 60×16, 60×20, 80×24, 120×40, 200×50. The test runs every view across the matrix and
  asserts P22.
- **Golden snapshots** (`toMatchSnapshot`) for Overview at 120×40, 80×24 and 60×20 (`live`), API-down
  80×24, REST-down 80×24, and each other view at 120×40. A reviewer compares them with §6.
- Test files import `describe`/`it`/`expect` from `vitest` explicitly (the cli config does not enable globals).
- **Interaction tests:**
  - view switching
  - filter typing (including `q` and digits typing in the input)
  - pause and `K new`
  - Esc chain
  - confirm flows asserting the mock action spy is called only after `y`
  - tuner edit asserting nothing is sent before confirm
  - `e` under external control
  - resize from 120×40 to 60×16 to 200×50, with selection kept by seq

### 13.3 Mock core (`cli/tools/mock-api/`)

- **Server.** `node:http` and `ws` on a configurable port (default 9100). It serves every REST endpoint
  in §10.2 and the WS subscribe protocol from the scenario JSON. The JSON is sanitised from the audit
  fixtures: LAN addresses become 192.0.2.x, and no hostnames or credentials remain.
- **Runtime control** (for tmux runs):
  - `POST /__mock/scenario {name}`
  - `POST /__mock/rest {mode: ok|fail|hang|500}`
  - `POST /__mock/ws {mode: up|drop|refuse}`
  - `POST /__mock/burst {perSecond, seconds}` (mixed protocols, long payloads, emoji, control characters)
  - `POST /__mock/fanout {dropPercent}`
- **Write endpoints** (decoder, tuner, audio) record each call in `GET /__mock/calls` and return the
  scenario's canned result. **Decoder, tuner and audio writes are exercised only against this mock, never
  against a live core.** A read-only attach of the CLI to the live Mac core is allowed for visual
  comparison: no keys that write, no restarts, no `make app-up`.

### 13.4 tmux validation and performance (`cli/tools/validate/matrix.sh`)

Captures go to `${WAVEKIT_VALIDATE_OUT:-$TMPDIR/wavekit-cli-validate}`, outside the repo.

1. **Matrix.** Every scenario × view at 60×16, 60×20, 80×24, 120×40, 200×50 with `capture-pane -p` and
   `-e`. The script checks that no line exceeds the width, the frame has ≤ rows − 1 lines, and no banned word appears.
2. **Resize.** 120×40 → 60×20 → 200×50 → 80×24 → 59×15 (too-small line) → 120×40, captured 0.3 s and 2 s
   after each step. No residue, and the view is restored.
3. **Transitions.** live → `ws drop` (gap opens, drop cells go to `?` within 15 s) → `ws up` (gap closes,
   drop cells come back after 2 snapshots) → `rest hang` (banner, dim cells) → `rest ok`.
4. **Sustained flow and cost.** `pipe-pane` the tty and sample `ps -o %cpu,rss` every second for 60 s, in
   four runs:
   - idle `live`
   - `burst` at 50/s
   - `burst` at 500/s
   - 500/s while paused on Messages

   | Measure | Budget |
   |---|---|
   | Frames/s | ≤ 5 |
   | `ESC[2J` | 0 outside resize-shrink |
   | CPU, idle | < 2 % |
   | CPU, 50/s | < 8 % |
   | CPU, 500/s | stays responsive (key-to-frame < 300 ms by stopwatch capture) |
   | RSS growth over 60 s | < 20 MB |

The measured numbers, including misses, go into `docs/CLI.md` under "Validation". Terminal limitations
found during the runs go into the same doc: OSC 52, ambiguous-width glyphs, tmux `escape-time`, and
16-colour themes.

## 14. Implementation phases and ownership

Three implementers (A, B, C). Within a phase, file ownership is disjoint. A phase starts when the previous
phase's files are merged and green (`pnpm run typecheck`, `pnpm test`, `pnpm --filter @wavekit/cli test`,
`pnpm --filter @wavekit/cli build`).

**Phase 0 — contracts and scaffolding (A alone; small).**
- `cli/tsconfig.build.json`, `cli/vitest.config.ts` and the `cli/package.json` scripts.
- `data/types.ts`, `data/store.ts`, `ui/line.ts`, `ui/actions.ts`, `ui/text.ts`, `ui/theme.ts`.
- `source/test/harness.ts` with one smoke test.
- Confirm the stale-dist fix: delete `dist`, build, then diff against a fresh compile.

**Phase 1 — logic, in parallel.**
- **A, data:** `data/{config,api-client,ws-client,guards,runtime,reducers,rates,decoder-state,ring-buffer,
  nominal-bands,window,freshness,memo}.ts` and `hooks/use-store.ts`. Tests:
  `tests/unit/cli/{config,guards,runtime,reducers,rates,decoder-state,ring-buffer,window,freshness}.test.ts`.
- **B, presentation logic:** `ui/{format,fit,columns,frame,strip,banner,keymap,filter}.ts`,
  `ui/messages/**` (ported from `decoded-message.tsx`), and `components/lines.tsx`. Tests:
  `tests/unit/cli/{format,fit,columns,frame,strip,banner,keymap,filter,messages-format,text}.test.ts`.
- **C, tooling and entry:** `cli/tools/**` (mock server, sanitised scenarios, matrix script),
  `source/args.ts`, `source/cli.tsx` (alt screen, cleanup, exit codes; it may stub `App` until phase 2),
  `ui/tuner-edit.ts`, and `source/test/fixtures.ts`. Tests:
  `tests/unit/cli/{args,tuner-edit}.test.ts`.

**Phase 2 — views, in parallel.** Each implementer owns its view-models, views and `.test.tsx` files.
- **A:** `app.tsx`, `hooks/{use-keys,use-terminal-size}.ts`,
  `components/{chain-strip,switcher,footer,banner,confirm-bar,help-overlay,too-small,error-boundary}.tsx`,
  `view-models/{overview,help}.ts`, `views/overview.tsx`.
- **B:** `view-models/{decoders,messages}.ts`, `views/{decoders,messages}.tsx`,
  `components/input-line.tsx`. Tests: `tests/unit/cli/messages-vm.test.ts`.
- **C:** `view-models/{receiver,system}.ts`, `views/{receiver,system}.tsx`.

Views are wired to the shell through a registry in `app.tsx` (A). Each view module exports
`{ id, title, render(props), keyContext(state) }`, where `keyContext` feeds the keymap's `when` predicates.
View-specific actions are dispatched by `app.tsx` to the runtime's action methods.

**Phase 3 — integration and validation.**
- **A:** add the P22 matrix test `cli/source/views/matrix.test.tsx`, delete the old files (§11), migrate `tests/unit/cli/source-activity.test.ts` into `freshness.test.ts`,
  and run the end-to-end typecheck, lint and build.
- **C:** run §13.4 and record the results.
- **B:** write `docs/CLI.md` and append a status line to `docs/CLI-COORDINATION.md`; audit the copy
  against §9 using the banned-word test output.

Commits stage explicit CLI paths only. Never `-A`, `.`, stash or reset. Never stage `docs/ROADMAP.md`,
`docs/HANDOFF-2026-10-08.md` or `docs/REVIEW-2026-10-08.md`.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Ink 5 rewrites the whole frame on each commit, so cost scales with frame size × commits | One commit per 200 ms tick at most; unchanged frames are not written; measured in §13.4. If ultra frames exceed the CPU budget, idle ticks drop to 2 Hz. |
| Esc split across stdin chunks is misread as Meta-x | tmux validation with `escape-time 0` and the default; add a 20 ms escape buffer in `use-keys.ts` if seen. |
| Alt screen left active after a crash | Restore on `exit`, `SIGINT`, `SIGTERM`, `uncaughtException` and `unhandledRejection`, plus Ink's `waitUntilExit`. |
| The nominal table is wrong for the operator's region or config | Labelled `nominal` everywhere, with regional alternatives listed; replaced by the API band (request 2). |
| Core and CLI clocks differ, giving negative or odd ages | Prefer server-relative ages (`sampleAgeMs`, fanout `timestamp` deltas); clamp negatives to `<1s`. |
| Core's WS drops frames when the client is slow (256-message queue) | Decode rates come from REST `eventsOut`; aircraft are pruned by age and resynced; gaps show only on disconnect, since no sequence numbers exist yet (request 7). |
| OSC 52 is unsupported or disabled (for example tmux without `set-clipboard`) | The copy says only `copy sent (OSC 52)`; the limitation is documented in `docs/CLI.md`. |
| Width-ambiguous glyphs (`●`, `○`, `▁`) render 2 wide in some CJK locales | `WAVEKIT_ASCII=1`; documented. |
| Root typecheck pulls CLI modules into strict mode | Import rule (§11); phase gates run `pnpm run typecheck`. |
| Node type stripping is needed for the mock server | Dev tooling only; `.nvmrc` pins 25.2.1; the matrix script checks `node --version`. |

## 16. Out of scope and follow-ups

- `wavekit tail`: a line-per-message stdout mode with the same formatters, filter grammar and `--json`. v1.1.
- When core lands requests 1-7 in `docs/CLI-COORDINATION.md`:
  - source status over WS removes the REST-only IQ path
  - target bands replace the nominal table
  - REST `lastError` and `idleTimeout` replace session-only and quoted health
  - a server-side drop rate replaces client deltas
  - `SdrHostSampling` in `ResourceSnapshot` fills the System sampling slot with no layout change
  - sequence numbers turn gap rows into exact missed counts
