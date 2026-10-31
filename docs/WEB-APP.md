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
- Labels and tags always sit at their own frequency inside the visible span. After a retune or a
  sample-rate change, the labels from the previous window disappear at once; only signals heard in
  the new window are labelled.
- Right-click a signal for its menu, which includes **Decode as…** to try a decoder on it.
- Signals close together share one tag with a count (`DMR · CC 1 +2`). Click it for a list of the
  grouped signals; each row has a **Tune** button.
- When found signals lie outside the visible span, a marker at that edge shows how many, with an
  arrow (its tooltip reads `3 signals outside view →`). Clicking it asks "Tune to … MHz?" for the
  nearest of them first; it never retunes on its own.
- Click a tag to see what it is (see [Spectrum tags](#spectrum-tags)). A group lists each signal
  with its state, the protocol (`DMR` once verified; before that `Likely DMR`, `Maybe DMR` or
  `Heard`), a muted `likely <kind>` hint (for example `likely ISM device`) when nothing has been
  verified yet, the next step from the decoders that cover its frequency (for example "Listen to
  check", "Widen the capture so … fits" or "No decoder covers this frequency; run identify") and a
  **Tune** button. Clicking a tag never tunes by itself. The same `likely …` hint and next step
  appear beside unverified rows in the Scanner lists.

#### Spectrum tags

There are two kinds of label on the spectrum. The labels over the peaks follow what is on the air
now (a proven one waits between bursts, see below). The tags in the row under the band ruler are the scanner's **discoveries**: frequencies it
has heard and kept, with what it has learnt about each.

A tag is in one of three states:

- **Heard**: something transmits there and nothing has identified it. The tag stays grey and says
  what was measured, for example `Unidentified · 4FSK ~9 kHz`.
- **Likely**: the signal's shape suggests a protocol (`Likely DMR`, `Maybe FM voice`), but no
  decoder has checked it.
- **Proven**: a decoder checked it (`DMR · CC 1`), or an analog proof such as a CTCSS tone. The dot
  is filled and the tag has an outline while it is live.

A tag is bright while its discovery is live. A proven tag stays lit for 5 minutes after it was last
heard, and any other tag for 90 seconds, so a signal that only sends short bursts (a DMR control
channel, a pager) does not flash with every burst. A continuous carrier is on the air all the
time, so its tag never goes away. If nothing identifies it, it stays quiet and grey.

The labels over the peaks use the same evidence:

- A label on a proven discovery has a filled dot and an outline, like its tag. While that tag is
  lit, the label stays between bursts, so a DMR control channel shows one steady `DMR · CC 1`
  instead of flashing. Once the tag dims, the label goes the next time the signal is quiet.
- A label names a protocol only when its discovery is proven. A discovery marked decoded whose
  evidence says weak (or whose proof does not prove it) is not proven, so its label reads
  `Unidentified · …` instead of `DMR`.
- An unnamed peak near a likely discovery reads as its tag does, for example `Likely DMR`. Near
  a discovery that was only heard it says what was measured, for example
  `Unidentified · 4FSK ~9 kHz` with its frequency, and has a grey ring for a dot. Any other
  unnamed peak shows its frequency.
- A held proven label moves to a new burst only when that burst is the same signal: its centre
  within a quarter of the label's width (or the spectrum's resolution, if wider) and its width at
  most 1.5 times the label's or the other way round. A narrower neighbour one channel away gets
  its own label.
- Any other label stays a few seconds after its signal goes quiet, as before.
- Hover over a label that sits on a discovery to see how we know (the tag's first detail line).
  Clicking a label tunes there. For the full detail, click the tag in the row below.

Click a single tag for its detail:

- **How we know**: for example `DMR decoded: checked control bursts, colour code 7`, or
  `Not proven: heard on the air, not identified`. The core's own proof summary shows as a
  `Core:` line only when it says something the line above does not.
- **live** after the frequency means it was heard in the last 30 seconds. The tag itself stays
  lit longer (see above).
- **Evidence** (`Proven`, `Weak`, or `Not reported` by an older core), **First heard**, **Last
  heard** and **Airtime**.
- **Calls**: the scanner checks a channel by decoding it for a moment. When that check saw calls,
  the detail names them, for example `Talkgroup 1, source 12 seen by the scanner's check` (at most
  three of each, then `+n more`). Calls the scanner's check decoded are not Activity rows: Activity
  lists what the decoders heard, so it may have nothing on that frequency yet, and the detail says
  so. A proven digital voice channel with no call in it says `No calls heard yet — control
channel only`. **Last call** shows only when the core names the discovery's last Activity event,
  and opens it. Otherwise **Search Activity** opens Activity on that frequency.
- **Tune** and **Listen** go to the discovery's measured frequency, as the Scanner drawer does.
  **Listen** is the drawer's Listen: it tunes there, then starts live audio once the tune has
  landed. If the tune fails, nothing plays and a `Could not tune: …` warning says why. If the
  receiver is tuned elsewhere meanwhile, nothing plays here. The core's live audio is left
  running, because other browsers may be listening to it. Turning Listen off stops the core's
  live audio only when a fresh status shows no other listener on either stream.
  **Open in Scanner** opens the discovery in the Scanner drawer.

### The tuned card

The card on the left follows the frequency you are tuned to. From the top it says what the signal
is, then the frequency once, the mode and channel width, the decoders on its band, and the actions
(Activity, save, Identify, Open message).

The header names the signal from the most specific thing known: the protocol last heard, what
Identify or a proven discovery named, the decoder whose band holds the frequency, then the band
plan's band. A decoder whose channel only follows the tuner (the pager decoder listening to the
live audio, say) never names a frequency outside its band, and the card never says "Nothing decodes
this frequency" while a decoder's band holds it. On a data band (the band plan's mode is RAW, such
as ADS-B at 1090 MHz) or with the receiver set to RAW, the card shows **No audio (data band)**
instead of the demodulator and "Quiet".

**On this band** is a table of the decoders whose band holds the frequency (within 200 kHz of one
of their frequencies or of the span between them, or inside their band). The core decides which
those are: the card asks `GET /api/decoders/summary?hz=<Hz>` and lists the items with
`coversHz: true`, so an agent using the same endpoint sees the same list. Each decoder takes two
lines:

| Column      | Shows                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Decoder     | Its name and program, for example ADS-B over `readsb`                                                          |
| State       | A dot and one word: Decoding, Listening, Starting, Waiting, Paused, Failed or Off (filled dot while it runs)   |
| Last decode | How long ago it last decoded; opens Activity filtered to that kind of traffic. "Never" when it has not         |
| Detail      | The second line: the reason from the core's verdict ("CPU budget full"), or how much it decoded, full width    |
| Action      | At most one button, at the right of the detail line, only when the verdict suggests one the card can carry out |

Decoders that decode come first, then those starting, failed, paused, waiting and off. In a narrow
drawer or on a phone each decoder stacks: name, state and last decode, then the detail and its
button. One **Decoder settings** link at the foot opens Settings › Decoders (at a decoder that is
off, if there is one); rows never link to Settings.

| Suggestion                               | Button                                 | What it does                                                                                                              |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Start (a stopped decoder)                | Start                                  | Starts that decoder                                                                                                       |
| Restart (a failed decoder)               | Restart                                | Restarts that decoder                                                                                                     |
| Raise the CPU budget                     | Raise CPU budget                       | Adds one core to the decoder CPU budget, up to its maximum of 64 (Undo in the toast); Settings › Decoders keeps the value |
| Pause the scanner                        | Stop the scan                          | Ends the scan, which gives the tuner and the decoders back (a paused scan keeps them)                                     |
| Tune to its band                         | Tune to 1090.000                       | Tunes the receiver to the decoder's frequency                                                                             |
| Change the sample rate, check the source | Raise sample rate, Check the receiver… | Opens the Receiver, where you set it                                                                                      |

A decoder that is starting or waiting never offers Restart, and a failed decoder the core is
already restarting on its own reads "Restarting on its own" without a button. Suggestions that
belong in Settings (turn on, turn off others, install, channelizer) are left to the foot's link. When
the budget is already at its maximum, the next suggestion's button shows instead of Raise CPU
budget; the card reads the budget again each time it refreshes the verdicts, so a budget lowered
elsewhere offers the raise again. The raise and its Undo each change the budget only if nobody
changed it since the card read it (the core checks this as it saves); otherwise the toast says so,
names the value now set, and leaves it. Stop the scan shows while a scan holds the decoders: moving,
holding on a hit, or paused. A verdict this app does not know shows as plain text without a button.
With read-only access the buttons that change something are disabled; the links still work. A core
without `coversHz` is read from the decoders' own bands instead.

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
  If the core rate-limits a request, Activity retries by itself up to 3 times, unless the core asks
  for a wait over 10 s. Each wait is the one the core asked for (at least 0.25 s; 0.5, 1, then 2 s
  when it names none) plus up to 20 % random jitter, so a single wait can reach 12 s. If retrying
  stops, Activity shows `rate limited, retry in N s` (or `rate limited, retry later`).
  While the core is still opening its Activity store, the drawer says `Activity is starting…`; if
  an open failed and the core is retrying, it says `Activity store unavailable, retrying`. It checks
  again every 3 s and loads the list by itself once the store opens.
  Repeats fold into one row per thing going on (see [Activity folding](#activity-folding)).
- **Scanner:** watch the band in view or plan a scan, see the signals found, skip the ones you do
  not care about, save presets.
- **Recordings:** recordings kept by the core, to play, search and keep.
- **Settings:** station, receiver, decoders (each one starts **auto**, **always** or **off**), band
  plans, spectrum and waterfall, map, units and time, theme, density and motion. A paused decoder
  says why, for example `Paused · the capture is too narrow here` or `Paused · no channel selected yet`.
  Each decoder lists where it listens and why, for example `162.025 MHz (tuned)`, or
  `(activity)` for a paging or digital-voice channel chosen because it was active.
  **Decoders › Decoder CPU budget** shows the total cores used across sources against the budget,
  with its resolved source (for example `Auto (8 CPUs → 4 cores)` or `configured`). Enter **Auto**
  or a number greater than 0 and up to 64, including fractional cores; press Enter or leave the
  field to save immediately. Invalid values and save errors appear under the row. The control
  is disabled with read-only access or when the core denies settings writes; signing in again
  allows another save attempt. On deployments without settings writes, the row shows the current
  budget and a note to set `decoderPolicy.efficiency.cpuBudgetCores` in YAML config.
  A saved override adds “Saved setting overrides config”. On cores without the budget service,
  the row is disabled and says “Not available”.
  **Receiver › Per-band gain** lists the gain the core sets in each frequency range: scanner hops
  and jobs that tune into a listed band use its gain and give yours back after (also when you
  tune away from a running sweep), so a gain
  that suits one band does not overload the dongle in another (the defaults set 37.2 dB at 868 and
  915 MHz and keep the gain at 2 m, 70 cm and ADS-B). Edit a band's range in MHz and its gain in dB,
  or press **Keep** to leave the gain alone there; **Add band** and the `×` add and remove rows.
  **Save** sends the whole table and **Discard** drops your edits. Fields the core would refuse are
  marked before anything is sent (a range outside 24 to 1900 MHz, an end not above the start,
  ranges that overlap, ends included, a gain outside 0 to 50 dB, more than 32 bands), and the
  core's own message shows under the row if it refuses the save. **Per-band gain for my tuning**
  (off by default) saves at once: on, your own retunes also set the band's gain and give yours
  back outside the bands. See [Per-band gain](API.md#per-band-gain-get-and-put-apituner-band-gain).
- **Receiver** (the island at the top): under Gain, a quiet line says when the core confirms a
  band gain on the tuner, for example `Band gain 37.2 dB · 868 MHz ISM · while the
scanner tunes` (or `· for your tuning` with the switch on). It shows the gain the tuner really
  has (snapped to its gain step) and goes away as soon as you change the gain, the mode or the
  frequency; turning the switch on shows nothing until your next retune. When the scanner sees broadband
  blanking rise at a manual gain, the line `Front end may be overloaded at this gain (49.6 dB,
7.5 % of frames blanked)` suggests a lower gain; it is a hint, not a measurement.
- When samples are lost on the way from the receiver to WaveKit, a notice at the bottom says
  `Receiver link dropping samples — lower the sample rate`. It shows only for loss on the receiver
  link. Samples dropped inside WaveKit, or a link that has not yet shown it can carry the rate,
  raise no notice.

### Activity folding

Activity folds repeats into stacks, so one aircraft, one beacon or one call is one row. A stack
shows its newest decode as it was stored, with only who it is filled in from rows heard before it
(an aircraft's callsign when the newest decode is position only; by time, the latest value wins,
never a row heard after it even when stored earlier); a measurement such as a call's
duration, an altitude, a position or a signal level is always the newest decode's own, so a call
that has just started never shows the previous over's duration. The row also shows the count and
the span (`24 · 1 min`) and expands in place to the earlier rows. Counts are for the loaded list,
never totals: the list footer says `312 events in 41 rows, loaded so far.`, and the header counts
rows (its tooltip says `41 rows in the 312 loaded events`). Folding runs in the browser over the
rows already loaded (at most 5 000), and each live update folds again only the stacks its decodes
touched; with a short folded list, Activity loads up to 10 older pages of 100 by itself to fill the
view.

Each row gets a fold key from its own data: protocol and event kind, the core's entity
(`icao:`, `mmsi:`, `capcode:`, `talkgroup:`, `sensor:`, `callsign:`, `node:`; the title when there
is none), the channel to 1 kHz where an entity is only unique per channel, and, when the row
carries a message, its kind (tone only, numeric, alpha) and its exact text, so two different pages
never fold. Ingestion gaps never fold. Rows of one key are taken in the order they were heard, and
a silence longer than the family's gap between two of them ends a stack (a row stored late never
bridges one):

| Family                        | Gap    | Why                                                                                                                           |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Aircraft (ICAO, registration) | 2 min  | readsb sends 1-30 messages/s; the core stores a position update at most once a minute. Twice that tolerates one missed minute |
| Vessel (MMSI)                 | 10 min | AIS reports every 2 s to 3 min (at anchor); 3 missed anchor reports                                                           |
| Pager (capcode)               | 3 min  | Idle beacons repeat every 30-60 s; 3 × 60 s tolerates two missed beacons                                                      |
| Call (talkgroup and radio)    | 10 s   | Bursts are under 3 s apart; 2 × a 5 s hang time ends the call                                                                 |
| Sensor                        | 5 min  | 433/868 MHz sensors send every 16-60 s; 5 × 60 s                                                                              |
| APRS station (callsign)       | 15 min | Fixed stations beacon every 10 min; plus 50 % jitter                                                                          |
| Mesh node                     | 30 min | Meshtastic sends position every 15 min by default; twice that                                                                 |
| Anything else                 | 2 min  | One exchange on one channel (analog overs are seconds apart)                                                                  |

A talkgroup's calls are one stack per radio. A DMR `call_start` that arrives before its radio is
decoded joins the call that follows it on the same talkgroup and channel (or, with none within the
gap, the call before it) instead of becoming a stack of its own. A capcode is one stack per channel,
except that the same page (same capcode, kind and text) heard within 2 s of one of the stack's
decodes on another channel is a simulcast copy and joins the stack: the row lists the channels it
was heard on (`On 160.450 · 431.075 MHz`), and the detail shows the decode's own Frequency with the
stack's other channels under Also heard on (simulcast). The copies may arrive in either order: a
repeat whose first copy lands on the other channel joins the stack that already heard both channels,
so a beacon repeated on two channels stays one stack however its copies interleave. A channel stays
with the stack only while its copies keep arriving within 2 s of the others: a repeat heard later on
that channel alone is a stack of that channel again. The 2 s is one POCSAG batch at the slowest
rate (544 bits at 512 baud, 1.06 s), the most two decoders' timestamps of one page differ, plus the
network's launch skew between transmitters (under 1 s).

Stacks are ordered by their latest decode. At the top of the list, a stack that hears again moves
to the top and keeps its place in React and stays expanded (its key is kept while it shares a row
with the stack before, so older rows leaving the list or an older page loading do not reset it); while you are
scrolled down or Paused, new decodes wait behind the `N new` pill and nothing moves. The pill counts
rows (stacks), not decodes: one beacon heard five times while you were away is `1 new`, and its
tooltip says how many decodes are waiting. In the list, ↑ / ↓ move the cursor, → expands the stack
under it and ← collapses it (on an earlier row, ← collapses its stack and returns to it); where there
is nothing to expand or collapse, ← / → move between the columns. Reopening the drawer shows the
last list at once (with `Updating…`) while it reloads, also for a rolling range such as **Last hour**
whose start has moved on (rows now before its start are dropped); the fresh rows join the kept ones
when they overlap, else they replace them. Kept rows the store has since pruned, or that the fresh
rows' range no longer holds, are dropped, and loading older rows continues after the oldest kept
row rather than fetching the kept ones again (after a rolling range moved on, with the range it was
loaded for, keeping only rows inside the current one). If the core no longer takes that position
(it expired), loading starts again from the fresh rows and skips the pages of kept rows, at most one
page per 100 kept rows.

Before the first rows arrive, the list shows its shape in placeholder rows (`Loading what was
heard…` after a second). An empty list says which case it is: **Nothing heard yet** with **Find
signals** (opens the Scanner) when nothing narrows it, **Nothing matches yet** with **Clear
filters** and, for a time range, **Any time** when a search or range does, and **Nothing was heard
in this range** for a range that has ended.

An event's detail shows the event exactly as it was stored. Who rows of its stack heard before it
said it is (never a later row; the same rule as the list row), when this decode does not say it (a title, callsign, flight, registration or name), is a
separate **Latest known (from earlier rows)** block, each value with the time of the row that said
it. The detail says **What it is** as a guess from its stack, labelled as one: a tone-only
capcode repeating on a schedule reads `Likely a paging-network idle beacon (no content, repeats
about every 45 s)`; bursts of one talkgroup and radio read `Likely one call: 24 bursts over 55 s`.
A schedule needs at least 3 rows with every interval within 35 % of the median. The detail also
shows how often it was seen, the strength when the decoder sends it, **Open in Scanner** when a
discovery sits within 12.5 kHz, and up to 50 folded rows.

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

Activity pager details show the full stored message when the list presentation
was clipped. List previews and titles keep their compact limits. Multimon whitespace
markers and their raw control characters become spaces in pager titles and message bodies; other control markers are hidden and whitespace
is collapsed. The raw JSON retains the original payload. Empty function-zero pages
are labelled **tone only** and displayed as compact notices.

The band view labels a decode-anchored 1090 MHz discovery **ADS-B · N aircraft**,
where N counts distinct confirmed ICAOs in the last 60 seconds (up to 4096).
The label sits at its nominal channel, independently of nearby narrow carriers.
Its identification is proven by decodes; API spectrum fields contain unmeasured zero placeholders.
The drawer hides RF measurements and transmission history for anchors. Aircraft counts
update through live discovery events when confirmations expire, without a new decode. See [decode-anchored ADS-B](SCANNER.md#decode-anchored-ads-b).

Digital voice tags distinguish sync hints from decoded identities. DMR sync-only
activity is labelled `DMR?`; its detail summary says DMR-like sync, not decoded,
and may show the most frequent color code as `CC 3 (unverified)`. Repeating
Checked TG/SRC voice with unknown CC uses the tag `DMR` and detail
`DMR voice, TG/SRC verified, CC unknown`; this remains weak evidence.
VC/IDLE/MBCC sync never earns a proven tag or `DMR · CC n` identity. A decoded DMR
identity requires repeated checked content, with checked talkgroup/source voice
link control additionally required inside the tuner-centre DC guard. See
[Digital voice identity checks](SCANNER.md#digital-voice-identity-checks).
