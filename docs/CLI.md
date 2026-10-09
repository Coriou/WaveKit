# WaveKit CLI dashboard

`wavekit` is the terminal dashboard for a running WaveKit core. It reads the core's REST API and WebSocket feed. It shows the receive chain in the order an operator checks it:

1. Is the API reachable?
2. Is IQ arriving?
3. What is the receiver tuned to?
4. Which decoders are up, and which of them can hear the tuned window?
5. Is anything decoding?
6. How much IQ is being dropped right now?

The dashboard never gives its own verdict: it never prints "OK", "healthy" or "stable" as its judgement. Words the server sends are quoted and attributed, e.g. `reports "healthy"`. Every value is evidence with an age, and anything unknown is shown as `?`.

## Running

```bash
pnpm dashboard                                   # build and start
node cli/dist/cli.js                             # after a build (the package's wavekit bin)
node cli/dist/cli.js --view receiver             # open a view first (-v works too)
node cli/dist/cli.js --api http://192.0.2.10:9000
node cli/dist/cli.js --help
```

The views are `overview`, `decoders`, `messages`, `receiver` and `system`. The old view names still work as aliases: `dashboard`, `output`, `backpressure`, `sources`, `tuner`, `live-audio` and `resources`. An unknown view prints the valid names and exits with status 2.

| Variable                             | Meaning                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WAVEKIT_API_URL`                    | API base URL. The WebSocket URL is derived as `ws://host/ws`.                                                                                                                                       |
| `WAVEKIT_WS_URL` / `WAVEKIT_WS_URLS` | WebSocket URL (the first entry of a comma-separated list). The API base is derived from it.                                                                                                         |
| `NO_COLOR`                           | Turns off colour. Bold, dim and inverse are kept.                                                                                                                                                   |
| `WAVEKIT_ASCII=1`                    | Uses ASCII glyphs (`* o x ! ? - ... \|`) instead of `● ○ × ! ? — … ·`. ASCII is also used when `LC_ALL`, `LC_CTYPE` or `LANG` is set and does not name UTF-8; with none of them set, UTF-8 is used. |

Precedence is `--api`, then `WAVEKIT_API_URL`, then `WAVEKIT_WS_URL` / `WAVEKIT_WS_URLS`.

With nothing set, wavekit tries `http://127.0.0.1:9000`, then `http://127.0.0.1:3000`. It accepts a candidate only if it answers `/health` like a WaveKit core. A different service on the port does not count. If no candidate answers, wavekit tries again every 15 s, and the banner lists the addresses it tried.

`localhost` is read as `127.0.0.1`. Port 4713 is refused, because that is the RTL-TCP relay, not the API.

## Reading the screen

Row 1 is the **chain strip**, with one lane per link in the chain:

| Lane       | Examples                                                                                | Meaning                                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`      | `api ● 2s` · `api ws ● rest × 45s` · `api × 3m` · `api ○ connecting`                    | `●` appears only when the WebSocket is open **and** REST answered within 15 s. The age is the time since the last REST success.                                                                                                                                       |
| `iq`       | `iq ● streaming · 4.1 MB/s` · `iq × no samples 23s` · `iq ● receiving` · `iq ? unknown` | `streaming` appears only when core reports the source's activity state as `streaming` and that report is under 15 s old. Older cores show `connected`. `receiving` means only the WS byte-rate heartbeat is available. The rate is shown only while the lane is live. |
| `rx`       | `rx 445.971 MHz ±1.024 · external control`                                              | Centre frequency, half span, and who controls the tuner. If the sample rate is unknown, only the centre is shown.                                                                                                                                                     |
| `decoders` | `decoders 8/9 up · 1 failing · 1 restarting · 2 in window` · `dec 1 failing`            | `failing` (`×`) counts the `×` rows: faulted, down, crash-looping or a stuck stop. `restarting` (`!`, yellow) also counts a faulted retry. `in window` uses core's band assessment when core sends one, and the **nominal** band table otherwise (older cores).       |
| `drops`    | `drops !34%` · `drops ? · backpressure`                                                 | Share of offered IQ dropped over the last 10 s on decoder branches. `!` means a branch is in backpressure right now. `?` means the share cannot be computed. The strip is always current, so the figure has one spelling at every width.                              |

The clock sits at the right of the strip. Every glyph in the strip keeps a word beside it; nothing is abbreviated into glyph clusters. When the strip is short of room, every lane keeps its shortest worded form (`api ● 2s`, `iq ● streaming`, `iq × down`, `iq ○ no samples`, `rx 445.971`, `dec 1 failing`, `dec 1 restarting` or `dec 8/9 up`, `drops !34%`) and the clock goes first. If even those do not fit, whole lanes go in this order: `rx`, then drops, then decoders. Detail is added back as room allows: the REST age of a split api lane (`api ws ● rest × 45s`), `MHz` and the rx span, the full iq word, the decoder words and `in window`, the IQ rate, the tuner owner, then the clock.

When core flags a source's signal as flat, IQ still reads `streaming` (bytes are arriving) and the iq lane adds the warning in words: `iq ! flat` → `iq ● streaming · flat` → `iq ● streaming · signal flat −46 dBFS`. The Receiver SOURCE row adds `signal flat · −46.0 dBFS below −40 dBFS · since HH:MM:SS · check gain`, and its rate row shows the measured `level` when core reports one.

**Legend**

| Mark | Meaning                                         |
| ---- | ----------------------------------------------- |
| `●`  | live                                            |
| `○`  | idle or off                                     |
| `×`  | fault                                           |
| `!`  | attention (restarting, backpressure, emergency) |
| `?`  | unknown                                         |
| `—`  | not applicable                                  |

**How to read the values**

- **Dim text** is older than 15 s.
- **`now` and `lifetime`:** `now` figures cover the last 10 s, and `lifetime` figures are counters. The two are never mixed.
- **Ages:** seconds below a minute (`52s`), then whole minutes (`6m ago`), then hours and minutes (`1h 3m`), then days (`2d`).
- **Decodes:** the rate leads, then the age of the last decode when there is room (`2/min · 11s ago`). The rate is core's counter rate, else, while the live feed is open, the count in the message feed over the last minute; with the feed down only the age shows. A last decode older than a minute reads `none for 6m`; a decoder that never decoded reads `none for <uptime>`; a decoder that is not running reads `—`.
- **Bands:** the `band MHz` column shows core's target band when core sends one, else the _nominal_ band from WaveKit's built-in table. A band from the decoder's own configuration is marked `*` (the help screen explains the mark). The Decoders detail names the basis in parentheses, e.g. `1090.000 MHz (protocol)`.
- **Tuned decoders:** with an older core (no band assessment), `dsd-fme` and `multimon-ng` read `tuned` and count as in window. Current cores place them like any other decoder.

**Problems and cached data**

- **Banner:** when the API or the live feed has a problem, a one-line banner under the strip says what is wrong, why, when it will retry, and how old the shown data is (`data as of 18:07:40`). An unreachable API reads address first, with the error code in words: `! API unreachable · 127.0.0.1:9000 · connection refused (ECONNREFUSED) · retry in 4s · r now`. On a narrow screen the code stands alone.
- **Cached data** stays on screen, but dim.
- **Feed gaps:** while the WebSocket is down, the message feed shows a gap row. When the WebSocket reconnects, the row closes as `── gap 18:08:37–18:10:41 · 2m · not replayed ──`.

## Views

| Key | View     | Shows                                                                                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1` | Overview | Receiver summary, decoder table, latest messages                                                                                                                                                             |
| `2` | Decoders | Process state, restarts, errors, decodes, iq in, and drop now/lifetime per decoder. A detail pane adds identity, band and window, the last error, the last write's result, and a 30-minute decode sparkline. |
| `3` | Messages | Filterable, pausable feed with per-protocol summaries and a JSON detail. ADS-B rows, their detail and the filter add registration, type and operator from the aircraft list.                                 |
| `4` | Receiver | Source transport and activity, tuner (with edit mode), relay and its command history, fanout drops, upstream (Pi) drops                                                                                      |
| `5` | System   | Container CPU and memory, alerts, SDR host processes (and Pi sampling when core reports it), live audio, core version                                                                                        |

The detail pane sits to the right on wide terminals (160 columns or more) and below the list on tall ones (30 rows or more). Otherwise it covers the list. In the Decoders detail, rows that do not fit are marked `+N rows · PgDn` or `+N rows · PgUp`. The Messages detail shows `PgUp PgDn scroll` in the footer.

## Keys

| Key                            | Where                                                                           | Action                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`–`5`, `Tab`, `Shift-Tab`    | outside the filter, tuner edit, help and the confirm bar                        | Switch view                                                                                                                                                                                                                                                                                                                                  |
| `?`                            | outside the filter, tuner edit, help and the confirm bar                        | Help overlay (any key closes it)                                                                                                                                                                                                                                                                                                             |
| `q`, `Ctrl-C`                  | `Ctrl-C` anywhere; `q` outside the filter, tuner edit, help and the confirm bar | Quit and restore the terminal                                                                                                                                                                                                                                                                                                                |
| `r`                            | outside the filter, tuner edit, help and the confirm bar                        | Reconnect now and refetch everything                                                                                                                                                                                                                                                                                                         |
| `↑↓` `j k`, `PgUp PgDn`, `g G` | lists                                                                           | Move, page, jump to the top or the newest. In Messages (newest first) the first `↑` or `↓` selects the newest row and pauses the feed; `↑` past the newest row resumes it, like `G`.                                                                                                                                                         |
| `Enter` / `Esc`                | lists                                                                           | `Enter` opens the detail. On the Overview it opens that decoder in view 2. `Esc` closes the detail, then clears the selection. In Messages that step also resumes a paused feed, and further presses clear the filter text, then the preset. The Messages header names the next step (`paused · 0 new · 7 total · Esc resume`, `Esc clear`). |
| `PgUp PgDn`                    | detail pane                                                                     | Scroll the detail                                                                                                                                                                                                                                                                                                                            |
| `/`, `p`, `F`                  | Messages                                                                        | Filter, pause or resume, cycle presets (`all → aircraft → voice → pager → data`)                                                                                                                                                                                                                                                             |
| `y`                            | Messages detail                                                                 | Copy the JSON (OSC 52)                                                                                                                                                                                                                                                                                                                       |
| `s` `x` `R`                    | Decoders                                                                        | Start, stop or restart the selected decoder (asks for confirmation)                                                                                                                                                                                                                                                                          |
| `e`, `c`                       | Receiver                                                                        | Edit the tuner (WaveKit control only); take or release control (asks for confirmation)                                                                                                                                                                                                                                                       |
| `a`, `P`                       | System                                                                          | Start or stop live audio; apply an audio preset (asks for confirmation)                                                                                                                                                                                                                                                                      |
| `←→` / `↑↓`                    | tuner edit                                                                      | Move the digit cursor / change the digit                                                                                                                                                                                                                                                                                                     |
| `0`–`9`, `Backspace`           | tuner edit                                                                      | Type / delete a digit                                                                                                                                                                                                                                                                                                                        |
| `Tab`, `Space`                 | tuner edit                                                                      | Next field / toggle the field                                                                                                                                                                                                                                                                                                                |
| `Enter` / `Esc`                | tuner edit                                                                      | Review the change in the confirm bar / discard the edits                                                                                                                                                                                                                                                                                     |
| `y` / `n`, `Esc`               | confirm bar                                                                     | Send / cancel (`Enter` does not confirm)                                                                                                                                                                                                                                                                                                     |
| `P`                            | audio preset confirm                                                            | Cycle to the next preset                                                                                                                                                                                                                                                                                                                     |

The footer shows only the keys that do something on the current screen.

**Filter grammar**

- Words are AND-ed.
- A comma inside a word means OR (`readsb,ais`).
- `!emerg` keeps emergencies only. Inside a comma group it is one of the alternatives (`ais,!emerg`).

## Writes

Navigation never writes. Every write except audio start/stop goes through a confirm bar that names the target and what the write touches, for example `▶ restart readsb · up 51s · out of window · dropping 38%   y restart  n cancel`. A decoder confirm states whether it decodes the shared window, what it drops now, when it last decoded, and for a stopped decoder its last exit (`exit code 1 · 3m ago`). On a narrow bar the action and the window stay.

- **Confirming:** only `y` sends. `Enter` does not confirm.
- **Tuner edits:** nothing is sent until you confirm. The changes then go out one command at a time, and sending stops at the first command that fails or gets no reply.

Results are reported in the dashboard's own words, never in the server's success text. A decoder write's result shows in the footer while the detail is closed, and in the detail's `action` row while it is open. Audio results read the same way, e.g. `audio started · 0 clients`.

**Decoder write results**

| Result                                 | Example                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sent, waiting for a reply              | `restart sent 18:07:52`                                                                  |
| No reply within 10 s                   | `restart sent 18:07:52 · no reply in 10s`                                                |
| Still unconfirmed after a further 10 s | `restart sent 18:07:52 · no reply · not confirmed`                                       |
| Accepted, waiting for core to confirm  | `restart accepted 18:07:52 · 200`                                                        |
| Confirmed by core                      | `restarted 18:07:53`                                                                     |
| Failed                                 | `restart failed · 502 · "<server text>"` (server text is quoted; `?` when there is none) |

A result line clears 10 s after the write completes.

## Terminal requirements

- **Size:** at least 60×16. Smaller terminals show one line saying so, and the view comes back when the terminal grows.
- **Screen:** the dashboard uses the alternate screen. It restores your terminal on exit, Ctrl-C, SIGTERM and crashes.
- **Frame height:** the frame is one row shorter than the terminal, so the terminal never has to clear and scroll.
- **Copy:** OSC 52 copy works only where the terminal allows it (in tmux, `set -g set-clipboard on`). The CLI reports `copy sent (OSC 52)` because it cannot see whether the copy arrived. JSON over 100 KB is not sent: `copy not sent · <size> over 100 KB`.

## Development

```bash
pnpm --filter @wavekit/cli test                    # Ink render tests (cli/source/**/*.test.tsx)
pnpm exec vitest run tests/unit/cli                # pure logic + fast-check properties
node cli/source/test/mock-api/server.ts --port 9100 --scenario live   # mock core
WAVEKIT_API_URL=http://127.0.0.1:9100 node cli/dist/cli.js
cli/tools/validate/matrix.sh all                   # tmux matrix, resize, transitions, esc, perf
```

- **Writes:** the mock core is the only target for write actions. Never point write tests at a live core.
- **Pure code:** `cli/source/data`, `ui` and `view-models` must never import Ink, React or `.tsx`. Root tests compile them under the strictest flags.
- **Mock scenarios:** they live in `cli/tools/mock-api/scenarios/`. They use the real decoder wire shapes and documentation addresses only.

Pending API requests that would remove CLI fallbacks are tracked in `docs/CLI-COORDINATION.md`.
