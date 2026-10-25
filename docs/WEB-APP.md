# Using the web app

The web app is WaveKit's main interface. It runs in any recent browser, on a desktop or a phone,
and talks to the core over its REST API and WebSocket. The code lives in [`web/`](../web/).

![The spectrum view: live spectrum and waterfall over marine VHF, decoded DMR and AIS signals labelled on their peaks, and the tuned DMR channel's card with its recent calls](assets/screenshots/spectrum-dark.png)

## Open it

- **Without a radio:** `pnpm --filter @wavekit/web mock`, then `pnpm --filter @wavekit/web dev`,
  and open <http://localhost:5173>. The mock plays a station with aircraft, ships, pagers, DMR and
  more ([`web/mock/README.md`](../web/mock/README.md)).
- **With your core:** `WAVEKIT_WEB_API=http://<core-host>:9000 pnpm --filter @wavekit/web dev`.
  When the core runs on another machine, set its `liveDemod.publicOrigin`
  (`WAVEKIT_LIVE_DEMOD__PUBLIC_ORIGIN`) so live audio reaches your browser
  ([core reference](CORE-REFERENCE.md)).
- **Protected core:** the first visit shows a **Pair this browser** chip. Pair once, and the
  browser stays signed in. Signed-in devices are listed in the ⌘K palette.

## The screen

The app has three views, picked from the dock at the bottom: **Spectrum**, **Map** and
**Messages**. Drawers open on the right on top of the view: **Activity**, **Scanner**,
**Recordings** and **Settings**. On a phone, the ⌘K palette (the search button) is the way around.

### Spectrum and waterfall

- Drag the spectrum to tune, or click a peak. Drag past the edge of the capture to retune the
  receiver.
- The band ruler under the spectrum shows the band plan and your saved frequencies. Zoom with its
  `−` `+` buttons.
- Labels on the peaks say what WaveKit identified there (`DMR · CC 1`, `AIS · MMSI …`). Settings ›
  Spectrum › Signal labels chooses how many you see.
- Right-click a signal for its menu, which includes **Decode as…** to try a decoder on it.

### The tuned card

The card on the left follows the frequency you are tuned to: what is heard there, the last
transmissions, decoded content, and the actions (Activity, save, Identify, Open message).

### Listen

The bar under the tuned card plays the demodulated audio in the browser: analog modes with squelch
and tone squelch, and decoded digital voice. **Record** saves a WAV file from the browser.

On NFM with auto squelch, a carrier alone does not open the audio: the core waits for evidence
that someone is talking (voice, or a CTCSS or DCS tone) and the bar says what opened it, for example
**Open on CTCSS**. The `autoSquelch` field of
[`GET /api/live-audio/status`](API.md#get-apilive-audiostatus) reports the gate.

## Drawers

![Activity: a searchable log of decoded events, with category filters along the top](assets/screenshots/activity.png)

- **Activity:** everything WaveKit heard, newest first. Search by talkgroup, capcode, MMSI, ICAO,
  callsign or frequency, filter by category and time range, show a list or cards, choose columns.
- **Scanner:** watch the band in view or plan a scan, see the signals found, skip the ones you do
  not care about, save presets.
- **Recordings:** recordings kept by the core, to play, search and keep.
- **Settings:** station, receiver, decoders (each one starts **auto**, **always** or **off**), band
  plans, spectrum and waterfall, map, units and time, theme, density and motion.

## Map and Messages

![Map: aircraft, vessels and APRS stations around the station, with their trails and the receiver's coverage](assets/screenshots/map.png)

The **Map** shows aircraft, vessels, APRS stations and mesh nodes around your station, with their
trails and the station's coverage. **Messages** shows decoded messages as cards; open one to see its
full content or its position on the map.

## Keyboard

| Key                  | Action                            |
| -------------------- | --------------------------------- |
| ⌘K / Ctrl K          | Command palette                   |
| ⌘, / Ctrl ,          | Settings                          |
| `T`                  | Tune to a frequency               |
| `M`                  | Mode                              |
| `Q`                  | Squelch                           |
| `[` `]`              | Step down / up                    |
| `L`                  | Listen                            |
| `B` / `S`            | Saved frequencies / save this one |
| `/`                  | Search Activity                   |
| `G` then `S` `M` `D` | Spectrum, Map, Messages           |
| `G` then `A` `C` `R` | Activity, Scanner, Recordings     |
| `?`                  | All shortcuts                     |
| `Esc`                | Close the top drawer or sheet     |

## Links

The address bar names what is on screen, so a link reopens it: `#/map`, `#/activity/<eventId>`,
`#/scanner/<discoveryId>`, `#/settings/<settingId>`.

## Install it

WaveKit is a PWA: use **Install WaveKit** in the ⌘K palette, or your browser's install button.
Browsers only install from HTTPS or `localhost`.

## For contributors

- Design system and decisions: [`docs/web/DESIGN.md`](web/DESIGN.md), tokens in
  [`docs/web/THEME-TOKENS.md`](web/THEME-TOKENS.md).
- What the web app still needs from the core: [`docs/web/CORE-GAPS.md`](web/CORE-GAPS.md).
- Screenshots on this page and in the README come from `pnpm --filter @wavekit/web docs:shots`
  (the built app against the mock, so the data is the same on every run).
