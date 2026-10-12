# Signal discovery scanner

The scanner finds and characterises RF activity on a source, confirms it with a real decode where a decoder exists, records it, and reports each distinct emitter once as a _discovery_ with evidence. It runs inside the core and is driven over REST/WS (`/api/scanner`, channel `scanner`); its activity layer is the core spectrum service (`/api/spectrum`, channel `spectrum`), which also feeds CLI and web waterfalls. The CLI's `6 Scan` view is one client.

Design: [scanner spec](superpowers/specs/2026-10-09-signal-discovery-scanner-design.md). Endpoint and message reference: [API.md, Scanner and Spectrum](API.md#scanner). Component view: [ARCHITECTURE.md, Scanner](ARCHITECTURE.md#scanner).

## What it does and does not do

- Finds energy in the window a source is tuned to (in-window) or across wider ranges by retuning an rtl_tcp source (sweep).
- Classifies emissions from their spectrum (bandwidth, shape, TDMA envelope) and confirms them with dsd-fme, multimon-ng or direwolf.
- Never decrypts and never handles keys. Encrypted traffic is reported as `encrypted: true` and no audio is kept.
- Confidence is honest: `activity` (energy only) → `candidate` (spectral hypothesis) → `classified` (channel features; after the channelizer) → `decoded` (the confirm rule of the protocol was met: for DMR, the same colour code on two CRC-clean link lines). `decoded` means the first **accepted** identity, not any identity-bearing evidence.
- Before the channelizer: one confirm probe at a time (each costs about half a core), no analog characterisation, no listen-scan, ISM only through configured rtl_433 decoders (ambient evidence).

## Modes

### In-window

The job watches the current window of the source and never sends tuner commands. If an operator or an SDR++ relay client retunes, the job follows the new window: open observations end with `retune` and detection resumes after the settle time.

### Sweep

The job takes the source's tuner lease and steps through a hop plan (ascending centres, about 80 % of the sample rate each, overlapping by the widest channel). On each hop it settles (test-mode markers, or a timer when markers are not available), dwells, and either moves on or holds to confirm a track. Revisits favour busy hops: after every `round(1 / revisit.share)` coarse hops (share 0.3), the hop with the highest activity × time since the last visit is inserted again.

Worked example: 400–470 MHz at 2.048 Msps is 44 hops. With markers (about 30 ms counter run + 5 ms PLL settle) and 50 ms blocks, a hop dwells about 185 ms, so a coarse sweep takes about 8 s (about 11.6 s with revisits). With a 1 s timer settle (markers do not pass, typically over Wi-Fi) a hop costs about 1.15 s and a sweep about 51 s. These are assumptions; `POST /api/scanner/plan` reports the real numbers for your source (`sweepPeriodMs`, measured settle once known).

### Passive job

One per eligible source (`passive-<sourceId>`): in-window, all protocols, lowest priority. It is on by default and can be disabled per source at runtime. Before the channelizer it confirms only through ambient evidence, unless `scanner.passive.offsetProbes: true`. On hosts where the spectrum engine costs more than 25 % of a core (a Pi 4), passive scanning switches itself off and the status says why (`engines[].passive.disabledReason`).

## Jobs

`POST /api/scanner/jobs` takes a `ScanJobSpec`. Every field is optional; the normalised spec (`job.spec`) carries a `provenance` per field: `operator` (set in the spec), `bandplan`, `measured`, `config` (an explicit setting, today only `fftSize`) or `default`.

| Field              | Default                                                  | Meaning                                                                            |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `name`             | none                                                     | Label                                                                              |
| `sourceId`         | the default source                                       | Source to scan                                                                     |
| `mode`             | `auto`                                                   | `in-window`, `sweep`, or `auto` (in-window when the scope fits the current window) |
| `kind`             | `discover`                                               | `monitor` (listen-scan) needs the channelizer; `identify` only via `/identify`     |
| `ranges`           | the current window                                       | `[{startHz, endHz, rasters?, obwHz?, protocols?}]`                                 |
| `bandplans`        | none                                                     | Built-in bandplan ids, expanded into ranges                                        |
| `exclusions`       | none                                                     | `[{startHz, endHz, reason?}]`                                                      |
| `protocols`        | covering ranges per frequency, else all                  | Priors for classification and the protocols to confirm                             |
| `sensitivity`      | `scanner.detection.sensitivity` (`normal`)               | Preset, see [Presets and bandplans](#presets-and-bandplans)                        |
| `thresholdDb`      | adaptive (CFAR)                                          | Fixed detection threshold over the floor, 0–40 dB                                  |
| `fftSize`          | `auto` (by sample rate)                                  | 512–16384, power of two                                                            |
| `integrationMs`    | 50 (100 with `high`)                                     | Detection block length                                                             |
| `dwellMs`          | settle + (`minSurfaceBlocks` + 1) blocks                 | Sweep dwell per hop                                                                |
| `settleMs`         | marker run + `pllSettleMs`, or measured/configured timer | Sweep settle per hop                                                               |
| `hold`             | `{policy: "hold", maxHoldMs: 60000, hangMs: 2000}`       | `hold`, `confirm` or `never`; `confirmHoldMs` per class (1.5–10 s)                 |
| `revisit`          | `{share: 0.3, maxIntervalMs: null}`                      | Share of revisits in a sweep                                                       |
| `record`           | `{voice: true, analog: true, data: true}`                | What to record                                                                     |
| `evidence`         | `{psd: true, iq: false}`                                 | Evidence to keep per discovery                                                     |
| `tuner`            | unchanged                                                | Sweep only: `sampleRateHz`, `gainTenthsDb`, `agc`, `overload: flag \| reduce-gain` |
| `stop`             | none                                                     | `afterSweeps`, `afterMs` (≥ 1000), `onFirstDecoded`                                |
| `priority`         | 50                                                       | 0–100, among scanner jobs only                                                     |
| `takeover`         | `false`                                                  | Consent to disturb other consumers (sweep)                                         |
| `resume`           | `{autoAfterIdleMs: 60000, onBoot: false}`                | Auto-resume after preemption; resume after a core restart                          |
| `txDurationHintMs` | 5000                                                     | Transmission length used for the probability-of-intercept warnings                 |
| `capture`          | `{enabled: false}`                                       | Burst IQ capture, see [Burst IQ capture](#burst-iq-capture-fixtures)               |

The API converts two § 5.1 shorthands before planning: a range's `spacingHz` with optional `firstChannelHz` (default `startHz + spacingHz / 2`) becomes one raster, and an exclusion `{frequencyHz, widthHz}` becomes `{startHz, endHz}` centred on the frequency.

Three ready-to-send examples:

1. DMR in PMR446, in-window: `{ "ranges": [{"startHz":446000000,"endHz":446200000}], "protocols": ["dmr"] }`.
2. 400–470 MHz sweep with takeover and recording: `{ "mode": "sweep", "bandplans": ["pmr446","uhf-land-mobile"], "takeover": true, "record": {"voice": true} }`.
3. A one-hop "move there and watch" job: `{ "mode": "sweep", "ranges": [{"startHz":145750000,"endHz":145850000}], "stop": {"afterMs": 600000} }`.

### Lifecycle

```
pending ─► starting ─► running ⇄ holding
               │           │  ▲
               │           ▼  │
               │         paused(reason) ──► running (resume / auto-resume)
               ▼           │
   failed ◄── any non-terminal ──► cancelled        running/holding ──► completed (stop condition)
```

`completed`, `cancelled` and `failed` (`source-removed`, `tuner-unavailable`, `invalid`) are terminal; only terminal jobs can be deleted. Pause reasons:

- `operator`: paused by `POST …/pause`; probes stop, the lease and the decoder hold are kept until an operator or relay write takes the tuner, which drops both (the job stays `paused(operator)`, it never auto-resumes).
- `preempted-operator`: a REST tuner write (`origin: "rest"`) on the leased source; the lease is lost and never restored over.
- `preempted-relay`: an SDR++ relay client took control (`control-mode-changed` → `external`).
- `preempted-job`: a higher-priority scanner job took the lease (it keeps the original snapshot). The waiting job keeps its decoder hold while that job holds the tuner; when an operator or relay write takes it, the waiter releases the decoders too, and holds them again when the lease comes back.
- `source-down`: the source disconnected; the job resumes on the next payload with a new epoch.
- `core-restart`: the job was running when the core stopped; it resumes only with `resume.onBoot` (passive jobs always do).
- `resume-blocked`: auto-resume found more to disturb than was consented.

Auto-resume: once the preemptor leaves (relay control back to `user`, and no REST tuner write for `resume.autoAfterIdleMs`, 60 s by default) the job re-checks its impact. If it is not larger than what was consented, it re-takes the lease and resumes at the same hop; otherwise it goes to `paused(resume-blocked)` and needs `resume` with `takeover: true`. An explicit `resume` from `paused(preempted-*)` arbitrates at once; `takeover` is not required (sending it records the current impact as consented for later auto-resumes). It answers 409 `SCANNER_SOURCE_BUSY` while another job holds the lease or a better waiter exists.

Automatic resume is held by active identify trials on that source and, when an `OperatorActivityPort` is injected, by operator audio or recording. The default composition injects live audio only: it counts while a client listens through a gating squelch (manual threshold below 0, or auto) on the job's source; recording activity is not reported yet. Audio adds a 3-second hang; the full idle interval starts after activity/hang ends. Job REST and `scanner:job` views expose `resumeAt` (ISO deadline or null) and `resumeHeldBy` (`audio`, `identify`, `recording`, or null). Without an operator port, no external audio/recording activity is inferred. `POST …/pause` on `paused(preempted-*)` means **Stay here**: it becomes `paused(operator)` without acquiring the lease and remains explicitly paused across restart, even with `onBoot` set.

When job-level `protocols` is omitted, runtime probes and preview use the union of the ranges covering that signal/hop. A neighbouring range's DMR preference does not apply to a Marine VHF signal. Explicit job-level protocols, including an explicit empty list (all), override range preferences.

Explicit `resume` in the other cases:

- `paused(operator)` with the lease: resumes at the same hop.
- `paused(operator)` after an operator or relay write took the lease: re-acquires it. With a grown impact and no `takeover` it answers 409 `SCANNER_TAKEOVER_REQUIRED` (the job stays paused); while a job of equal or higher priority holds the lease it answers 409 `SCANNER_SOURCE_BUSY` and moves to `paused(resume-blocked)` (taking the lease from a lower-priority job needs consent like a takeover).
- `paused(core-restart)`: re-acquires the lease, re-opens the engine and restarts the sweep from its first hop.

Every 409 `SCANNER_SOURCE_BUSY` carries `details.reason`: `releasing`, `recovery-pending` and `holder-starting` clear by themselves (retry); `relay` and `held` last until the relay or the holding job lets go.

### Takeover and impact

A sweep that would disturb something answers 409 `SCANNER_TAKEOVER_REQUIRED` with `details.impact`: `liveAudioClients`, `digitalVoiceListeners`, `runningDecoders`, `pinnedDecoders` (started by hand), `scannerJobs` (other non-passive jobs on the source) and `unrestorable` tuner fields. Resending with `takeover: true` consents. Decoders on the source are held (`suspension.reasonCode: "tuner-scanning"`) for the whole sweep and resume afterwards; a manual start of a held decoder answers 409 `SOURCE_HELD_BY_SCANNER`. Live-audio listeners hear the sweep. Relay clients (SDR++) holding the tuner make sweeps impossible (`SCANNER_SOURCE_BUSY`).

### Tuner restore

At the end of a sweep the scanner writes back only the fields it changed, and only those whose previous value was known; others are listed as `unrestorable`. A restore that cannot be written (the source is disconnected, or the first retune failed half-way) is kept and runs on the source's first data after the reconnect, also when the job was deleted in between. A lease lost to an operator or relay is never restored over. After a crash the previous tuning is restored on the source's first data. The spectrum engine runs with the lease holder's FFT size, integration and threshold, and returns to the defaults when no sweep holds the source. On shutdown the scanner hook runs before decoders, channelizer, fanout and sources stop, so the restore (bounded at 2 s) still reaches the rtl_tcp socket.

## Presets and bandplans

`GET /api/scanner/bandplans` lists the plans for the effective region (`region` config; EU, or US/CA → US):

| Id                | Region | Range (MHz)       | Rasters               | OBW classes (kHz) | Protocols                             |
| ----------------- | ------ | ----------------- | --------------------- | ----------------- | ------------------------------------- |
| `pmr446`          | EU     | 446.0–446.2       | 12.5 kHz              | 9, 11             | analog-fm, dmr, dpmr                  |
| `dpmr446`         | EU     | 446.1–446.2       | 6.25 kHz              | 4.5               | dpmr, nxdn48                          |
| `uhf-land-mobile` | all    | 400–470           | 12.5 and 6.25 kHz     | 9, 11, 4.5        | dmr, analog-fm, p25p1, nxdn48, nxdn96 |
| `vhf-land-mobile` | all    | 136–174           | 12.5 and 6.25 kHz     | 9, 11, 4.5        | as UHF, plus pocsag                   |
| `amateur-2m`      | EU/US  | 144–146 / 144–148 | 12.5 / 15 and 20 kHz  | 11, 16            | analog-fm, aprs, dstar, dmr, ysf      |
| `amateur-70cm`    | EU/US  | 430–440 / 420–450 | 12.5 and 25 kHz       | 9, 11, 16         | analog-fm, dstar, dmr, ysf, p25p1     |
| `aprs`            | EU/US  | 144.800 / 144.390 | one channel           | 16                | aprs                                  |
| `ism-433`         | EU     | 433.05–434.79     | none                  | none              | ism                                   |
| `ism-868`         | EU     | 863–870           | none                  | none              | ism                                   |
| `pager-vhf`       | all    | 137–174           | 12.5 kHz              | 12                | pocsag, flex                          |
| `marine-vhf`      | all    | 156.0–162.0125    | 25 kHz (AIS excluded) | 16                | analog-fm                             |

Sensitivity presets: `low` (false-alarm target 0.25 /MHz/min, 50 ms blocks), `normal` (`detection.faTargetPerMhzMin`, 1.0, 50 ms), `high` (2.0, 100 ms).

## Settings

The `scanner:` section of `config/default.yaml` holds the defaults. "Runtime" marks the keys `PATCH /api/scanner/settings` accepts; they are persisted in `settings.json` and win over the config file. `GET /api/scanner/settings` reports the provenance of every key (`config`, `runtime`, `default`).

| Key                                                                                               | Default                               | Runtime |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| `enabled`                                                                                         | `true`                                |         |
| `passive.enabled`, `passive.offsetProbes`                                                         | `true`, `false`                       |         |
| passive per source (`passive.<sourceId>` in PATCH)                                                | `sources[i].scanner.passive` (`true`) | yes     |
| `cpuBudgetCores`                                                                                  | 1.0                                   | yes     |
| `cpuGuardPercent`                                                                                 | 90                                    |         |
| `maxProbes.offset`, `maxProbes.channel`                                                           | 1, 4                                  | yes     |
| `ringSeconds`                                                                                     | 3                                     |         |
| `detection.fftSize`                                                                               | `auto`                                |         |
| `detection.integrationMs`, `sensitivity`, `faTargetPerMhzMin`, `hysteresisDb`, `minSurfaceBlocks` | 50, `normal`, 1.0, 3, 2               | yes     |
| `detection.dcGuardHz`, `ppmMargin`, `clipFraction`                                                | 1500, 2, 0.001                        |         |
| `detection.shortIntegrationMs`, `overlap`                                                         | 5, 0                                  |         |
| `sweep.markers`, `markerTimeoutMs`, `pllSettleMs`                                                 | `true`, 2000, 5                       |         |
| `sweep.settleMs.local`, `.network`, `sweep.revisitShare`                                          | 300, 1000, 0.3                        |         |
| `hold.maxHoldMs`, `hangMs`, `preRollMs`                                                           | 60000, 2000, 300                      |         |
| `storage.dir`                                                                                     | `<stateDir>/scanner`                  |         |
| `storage.maxRecordingsMb`, `maxEvidenceMb`, `maxJournalMb`                                        | 512, 64, 64                           | yes     |
| `storage.maxAgeDays`, `discoveryMaxAgeDays`, `minFreeDiskMb`, `maxDiscoveries`                    | 30, 180, 2048, 10000                  | yes     |
| `storage.maxCapturesMb`                                                                           | 256                                   | yes     |
| `ws.maxMessagesPerSecond`, `spectrumHz`, `spectrumBins`                                           | 10, 10, 512                           | yes     |
| `ws.spectrumSummaryBins`, `spectrumMaxProfiles`                                                   | 2048, 4                               |         |

Env overrides: `WAVEKIT_SCANNER__CPU_BUDGET_CORES=0.5`, `WAVEKIT_SCANNER__PASSIVE__ENABLED=false`. Per source: `sources[i].scanner: { role: shared | dedicated, passive: true }`; dedicated receivers never get unsourced decoders. Example PATCH: `{"passive": {"rtl": false}, "maxProbes": {"offset": 0}}`.

## Discoveries, evidence and storage

One discovery per emitter: same frequency key, protocol family and identity. Two DMR networks on one channel are two discoveries, cross-linked as co-channel. An observation surfaces as a discovery only when (a) it lasted at least `minSurfaceBlocks` blocks, (b) in a sweep, one block was at least 6 dB over the threshold, (c) a channel-tier classification or a decode is attached (the spectral tier alone never surfaces), or (d) it repeated three times as single blocks. Observations are kept per transmission with signal statistics and the decode evidence.

Storage layout under `scanner.storage.dir`:

- `discoveries.json` (snapshot), `journal/` (daily observation journals), `jobs.json`, `settings.json`;
- `engine/` (per-source detector state) with `engine/occupancy/` (occupancy history);
- `recordings/dv/<discoveryId>/` (digital voice WAVs), `evidence/<discoveryId>/` (`psd.json`, `iq-*.cu8`);
- `captures/` (burst IQ captures).

Retention: the `storage.max*Mb` caps, `maxAgeDays` (recordings, evidence and journal files), `discoveryMaxAgeDays` (discoveries not marked `keep`) and `maxDiscoveries`. When free disk drops below `minFreeDiskMb` the status reports `disk: "disk-low"`: recording and evidence stop; discoveries keep updating. Privacy: identifiers (talkgroups, radio ids, callsigns, capcodes) stay on the host; nothing is uploaded.

## Listening

`POST /api/scanner/discoveries/:id/listen` retunes live audio's `offsetHz` to the discovery when it is in the current window (409 `OUT_OF_WINDOW` otherwise). Probe audio is on the digital voice server at `/decoders/<probeId>/stream`.

**Identify** (`POST /api/scanner/identify`, spec § 10.8): click a signal on the waterfall and every plausible decoder tries it, in the current window and never retuning (409 `OUT_OF_WINDOW` outside it; 409 `SCANNER_SOURCE_BUSY` while a sweep holds the tuner). A click on the DC spike, a spur or comb tooth, or an IQ image is answered at once with `artefact` and no trial; broadband RFI is the answer only when nothing transmits within `timeoutMs` (15 s). Before the channelizer the trials run one at a time as offset probes with 300 ms pre-roll, each for its hold, and preempt passive probes; after it they run in parallel. The result (`identified`, `candidate` or `unidentified`) always carries the measurements and the per-protocol trial list, and the observation lands in the discovery store like any other. If the window moves off the target, the result carries `ended: "window-moved"` and open trials are `cancelled`. Identify jobs cannot be paused or edited and are not kept across restarts.

## Honesty and limits

- Detection is measured on one strong DMR capture; false-alarm control adapts per range (CFAR), but a fresh dongle needs minutes to learn its spurs.
- A sweep can miss short transmissions: the preview reports probability of intercept per hop for `txDurationHintMs`.
- P25, NXDN, D-STAR, dPMR and DMR repeater rules are unvalidated until captures exist; those results stay `candidate` unless dsd-fme decodes them.
- Marker settle needs the RTL2832 test mode to reach the core; over some rtlmux/Wi-Fi paths it does not, and timer settle makes sweeps about 6× slower.
- Before the channelizer, one confirm probe runs at a time; on a Pi 4 even that may exceed the CPU budget.

### Known limitations

- Relay and live audio default to the first non-dedicated source. Explicit source selection routes that source's IQ, capabilities and controls together. If every source is dedicated, implicit selection is rejected; select a source explicitly. Legacy live-demod callers supplying a fixed fanout cannot switch radios at runtime without supplying the source router.
- A dedicated source added at runtime (`POST /api/sources`) is not excluded from the default-source choice until the core restarts. This matters only when no shared source existed at boot.
- An enabled relay without an explicit source cannot start when there are no configured shared sources (including an empty source list). The core exits during startup; configure a shared source, select a source explicitly, or disable the relay.
- After a fatal spectrum worker failure, passive discovery can remain failed until a source reconnect, capability change or settings update rebuilds it. `passive.enabled` describes the configured job's presence, not successful scanning. Inspect its job state and the spectrum engine error.
- Spectrum-only clients receive no automatic profile notification for that fatal failure. Consult `scanner:status` or `GET /api/spectrum` when frames stop; re-subscribe after cleanup to request a fresh engine. Automatic bounded passive recovery and direct display failure notification remain follow-up work.
- The CLI contract (`docs/CLI-COORDINATION.md`) was implemented without a CLI acknowledgement (user decision, 2026-10-10); later CLI requests become follow-up tasks.
- Accepted deviation (Task 34a): the capture store has no separate `CaptureExtras` type; it uses `ScannerCapture` directly, so each name has one definition.

### Rules as implemented (spec wording notes)

These are the rules the code follows where the spec text still differs (a spec amendment is pending):

- `decoded` is reached by the first accepted identity (the protocol's confirm rule), not by any identity-bearing evidence.
- The spectrum worker emits a block summary for every block except alarm (`untracked-retune`) blocks, so an alarm block produces no `spectrum:frame`.
- Impulse blanking (spec § 4.9, R6): a frame is blanked when it is at least 6 dB over the previous block's integrated mean power per bin on at least 50 % of the usable bins; the first block of an epoch is judged against its own per-bin median ÷ ln 2. Periodic RFI is active after at least 3 impulse events (blanked frames within 2 N samples count as one) whose last two intervals agree within ± 10 %; the period is their mean. (The spec says "over the per-bin floor" and "3 blanked frames"; the floor reference would blank steady wideband occupants.)
- IQ image match (spec § 4.9, R7): the −6 dB OBWs agree within `max(30 % of A, 2 RBW)`. (The spec says "± 30 %"; the 2 RBW term is needed for 1-RBW tones.)

## Spectrum and waterfall

The `spectrum` WS channel carries `spectrum:frame` messages from the core spectrum service: `{sourceId, profile, epoch, tuningTrust, centerHz, sampleRateHz, binHz, nativeBinHz, startHz, binCount, bins, binEncoding: "u8-halfdb-127.5", floorDbfs, thresholdDb, tracks: [{startHz, endHz, flags: {burst, iqImage, edge}}], masks: {dcHz, dcGuardHz, spurRanges}, snapshot?, at}`, max-hold over the frame interval (restarted when the epoch changes, so a frame never mixes two centres during a sweep). Decoding `bins` (base64 → bytes, dBFS = v / 2 − 127.5):

```js
// frame = msg.data of a "spectrum:frame" message
const bytes = Uint8Array.from(atob(frame.bins), c => c.charCodeAt(0))
const dbfs = Array.from(bytes, v => v / 2 - 127.5)
const hzOf = i => frame.startHz + (i + 0.5) * frame.binHz
// draw dbfs[i] at hzOf(i); grey the axis when frame.tuningTrust === "unverified"
// never merge rows across a change of sourceId, epoch, profile, binHz or startHz
```

**Selection.** `{"type":"subscribe","channels":["spectrum"]}` without options gets the default profile (`scanner.ws.spectrumHz` 10 × `scanner.ws.spectrumBins` 512, both runtime-PATCHable) on every eligible source. `"options":{"spectrum":{"sourceId":"rtl","hz":25,"bins":2048}}` selects one source and one profile for that client: `hz` is snapped to 0.5 and clamped to 0.5–25, `bins` rounded and clamped to 128–2048, omitted fields take the default's values. Subscribing again switches without a gap; subscribing without options returns to the default selection; `unsubscribe` or a disconnect releases the demand. Rapid re-subscribes coalesce: only the latest is answered.

**`spectrum:profile`** is sent to that client only, as the ack to a subscribe or as a notice after a permanent source removal or a default-profile change that remapped it: `{selection: "none" | "default" | "source", sourceId, profile: {key, hz, bins} | null, effectiveHz, outcome: "default" | "exact" | "nearest" | "rejected" | "removed", adjusted: ("hz" | "bins" | "profile-limit")[], removedSourceId?, code?, message?}`. `selection: "none"` means no frames. A `rejected` request (`SPECTRUM_OPTIONS_INVALID`, `SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`, `SPECTRUM_ENGINE_ERROR`) keeps the previous selection.

**Limits.** The server serves the nearest admissible profile and never rejects a request for its size. Above `scanner.ws.spectrumMaxProfiles` (4 distinct non-default profiles over all sources; config-only, 1–16) a request maps to an active profile on that source (preferring one not larger than the request) or to the default, with `outcome: "nearest"` and `adjusted: ["profile-limit"]`. `GET /api/spectrum` reports `limits`.

**Cadence and resolution.** One frame per `ceil(blockHz / hz)` block summaries, with `blockHz = 1000 / integrationMs` (20 at the default): 25 Hz gives 20 Hz, 10 or 15 Hz gives 10 Hz. `effectiveHz` is that cadence while blocks flow and an upper bound across sweep settles and gaps. `binCount ≤ bins` (never upsampled) and `binHz` is the true width; `nativeBinHz` is `fs / fftSize`, so `binHz / nativeBinHz` is the total max-hold factor. The engine's summary budget `scanner.ws.spectrumSummaryBins` (2048, config-only, 512–2048) caps the detail any profile can get; it is not a client setting.

**Ordering and client rules.** A `spectrum` subscriber gets the current state on subscribe (ack, then one snapshot per source of the current epoch, then live frames). This is not a replay of missed messages. A snapshot frame has `snapshot: true` and is the latest block of the current epoch at the client's profile (none while a retune settles). Reset the waterfall on every `spectrum:profile`, except that an `outcome: "removed"` notice with `selection: "default"` drops only `removedSourceId`'s waterfall. Compare epochs for equality only; they restart with the engine. Spectrum messages bypass the scanner limiter and do not count toward `ws.maxMessagesPerSecond`.

Engines run while a job or a `spectrum` client needs them, also with `scanner.enabled: false`. `tuningTrust` on frames: `unverified` frames have an untrusted frequency axis (grey it out). Status warnings (`GET /api/spectrum` `sources[].warnings`): `untracked-retune` (the scene moved without a command the core saw; the shift is reported when it can be estimated) and `host-centre-mismatch` (the receiver reports another centre than the core's caps). `GET /api/spectrum/occupancy` returns hourly duty per 12.5 kHz bucket for the last 7 days.

**Cursor tuning:** inside the window `PATCH /api/live-audio/config {"offsetHz": …}`; outside it `POST /api/tuner/:sourceId/frequency {"hz": …}`, which preempts a running sweep (`paused(preempted-operator)`).

## Burst IQ capture (fixtures)

The job option `capture: {enabled, mode: "wideband" | "channel", preMs: 1000, postMs: 500, onlyDecoded: true, maxPerHour: 6}` (defaults shown; `enabled` is required, `preMs` 0–5000, `postMs` 0–10000, `maxPerHour` 1–60) records the IQ of a transmission with pre-roll from the engine's ring. By default only transmissions that decode are kept, at most `maxPerHour` per job. `PATCH /api/scanner/jobs/:id` can change `capture`.

- **Modes:** `wideband` keeps the whole source window at the source rate (a `channelizer-golden` fixture when it decoded with payload fields at ≥ 2.048 Msps); `channel` keeps a 48 kHz cu8 channel centred on the target (`tail-golden`).
- **Files** under `scanner.storage.dir/captures/`: `<id>.cu8` (IQ), `<id>.json` (exactly a fixtures manifest v2 entry: `role`, `decoder`, `decoder_options`, `sha256`, `sample_rate`, `center_hz`, `duration_s`, `expected` payloads from the decode) and `<id>.scanner.json` (the `ScannerCapture` record: job, observation, discovery, epoch, sample range, pre-roll clipping). `storage.maxCapturesMb` (256) caps the folder; the oldest captures go first.
- **REST:** `GET /api/scanner/captures` (newest first), `GET /api/scanner/captures/<id>.cu8` or `<id>.json`, `DELETE /api/scanner/captures/:id`.
- **Promote a capture to a fixture:** copy the `.cu8` into `fixtures/raw/`, append the `.json` entry to `fixtures/manifest.yaml` under `fixtures:`, and run the fixture checks. Never commit the IQ.
- **Privacy:** payloads in `expected` carry identifiers (talkgroups, radio ids, callsigns); entries are `license: "private"` with `fetch.kind: "private"`.

## Troubleshooting

- **`settleMode: "timer"`** in `GET /api/scanner` `engines[]`: test-mode markers do not reach the core (rtlmux or the network path drops them). Sweeps still work, about 6× slower; check `markerSupported` and the measured `settleMs`.
- **`stuckTestMode: true`**: the receiver stayed in RTL2832 test mode. Send any tuner command (for example the same frequency) and check the rtlmux version.
- **`floorOccupied: true`**: a wideband emitter fills the window, so the floor estimate is high and weak signals hide under it. Tune away or narrow the range.
- **`overload: true`**: the ADC clips. Lower the gain, or use `tuner.overload: "reduce-gain"` on sweeps.
- **No probes start**: probes wait for the CPU budget (`cpuBudgetCores`), the CPU guard (`cpuGuardPercent`, see `cpuGuard.percent`) and `maxProbes.offset`; compare `budgets` in `GET /api/scanner`. Discoveries that never got a probe report `undecodedReason: "budget"`. Passive jobs get no offset probes unless `passive.offsetProbes` is on.
- **`disk: "disk-low"`**: free disk is below `storage.minFreeDiskMb`; recordings, evidence and captures stop until space returns.
- **503 `SCANNER_STATE_UNAVAILABLE`**: the scanner could not read its jobs or settings at boot. It runs without them (in-window jobs and the spectrum feed still work) and never overwrites the unread files; fix the files under `storage.dir` and restart.
