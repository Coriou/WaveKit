# Signal discovery scanner

The scanner finds and characterises RF activity on a source, confirms it with a real decode where a decoder exists, records it, and reports each distinct emitter once as a _discovery_ with evidence. In the web app it is the **Scanner** drawer ([web app guide](WEB-APP.md#drawers)): watch the band in view or plan a scan, see the signals found, skip the ones you do not care about. The CLI's `6 Scan` view is a second client. The scanner runs inside the core and is driven over REST/WS (`/api/scanner`, channel `scanner`); its activity layer is the core spectrum service (`/api/spectrum`, channel `spectrum`), which also feeds the web and CLI waterfalls.

Design: [scanner spec](superpowers/specs/2026-10-09-signal-discovery-scanner-design.md). Endpoint and message reference: [API.md, Scanner and Spectrum](API.md#scanner). Component view: [ARCHITECTURE.md, Scanner](ARCHITECTURE.md#scanner).

## What it does and does not do

- Finds energy in the window a source is tuned to (in-window) or across wider ranges by retuning an rtl_tcp source (sweep).
- Classifies emissions from their spectrum (bandwidth, shape, TDMA envelope) and confirms them with dsd-fme, multimon-ng or direwolf.
- Never decrypts and never handles keys. Encrypted traffic is reported as `encrypted: true` and no audio is kept.
- Confidence is honest: `activity` (energy only) → `candidate` (spectral hypothesis) → `classified` (channel features; after the channelizer) → `decoded` (the confirm rule of the protocol was met: for DMR, the same colour code on two content-verified bursts or checked voice link-control lines). `decoded` means the first **accepted** identity, not any identity-bearing evidence.
- Before the channelizer: one confirm probe at a time (each costs about half a core), analog replay characterisation when IQ capture is enabled, no listen-scan, ISM only through configured rtl_433 decoders (ambient evidence).

## Modes

### In-window

The job watches the current window of the source and never sends tuner commands. If an operator or an SDR++ relay client retunes, the job follows the new window: open observations end with `retune` and detection resumes after the settle time. Operator (non-scanner) retunes use their own 150 ms display settle and stale-content cap; spectrum frames published before `scanner.sweep.settleMs.network` has elapsed after such a retune are labelled `unverified`. The scanner's own hops keep their settle; a hop also commands the sample rate (the job's, else the declared one) when the rate is only declared or was not written on the current connection, so its epoch is `commanded` under the strict trust rule.

### Sweep

The job takes the source's tuner lease and steps through a hop plan (ascending centres, about 80 % of the sample rate each, overlapping by the widest channel). On each hop it settles (test-mode markers, or a timer when markers are not available), dwells, and either moves on or holds to confirm a track. Revisits favour busy hops: after every `round(1 / revisit.share)` coarse hops (share 0.3), the hop with the highest activity × time since the last visit is inserted again.

Worked example: 400–470 MHz at 2.048 Msps is 44 hops. With markers (about 30 ms counter run + 5 ms PLL settle) and 50 ms blocks, a hop dwells about 185 ms, so a coarse sweep takes about 8 s (about 11.6 s with revisits). With a 1 s timer settle (markers do not pass, typically over Wi-Fi) a hop costs about 1.15 s and a sweep about 51 s. These are assumptions; `POST /api/scanner/plan` reports the real numbers for your source (`sweepPeriodMs`, measured settle once known).

### Passive job

One per eligible source (`passive-<sourceId>`): in-window, all protocols, lowest priority. It is on by default and can be disabled per source at runtime. Before the channelizer it confirms only through ambient evidence, unless `scanner.passive.offsetProbes: true`. On hosts where passive scanning costs more than 25 % of a core (a Pi 4), passive switches itself off and the status says why (`engines[].passive.disabledReason`). The limit is `scanner.passive.maxEngineUtilization` (config only, 0.05 to 1, absent = 0.25). The guard first judges 60 s after the engine opened, then every 5 min, each time over the window since its previous check (not the engine's whole life).

- **Passive alone on the engine** (a headless receiver): the whole engine cost is judged against the limit (`engine-cpu N % of a core`).
- **Engine shared with the waterfall or another job**: only what passive adds is judged. The guard pauses passive for one minute to measure the engine without it (status `measuring baseline`, at most once per 30 min), then judges the difference against the limit (`passive-cpu N % of a core`). A shared engine at 95 % of a core or more is saturated and passive is switched off at once (`engine-cpu`). The baseline is measured again when the waterfall or another job joins or leaves, the engine's worker restarts, or it is 30 min old.
- **Coming back**: a disabled source whose engine (without passive) runs at or below 80 % of the limit comes back; with the waterfall still open, passive is tried again every 15 min for one minute and stays on if its own cost is within the limit. A disabled source whose engine closed is put on probation after 15 min: passive is re-enabled and the next engine open is judged again.

## Jobs

`POST /api/scanner/jobs` takes a `ScanJobSpec`. Every field is optional; the normalised spec (`job.spec`) carries a `provenance` per field: `operator` (set in the spec), `bandplan`, `measured`, `config` (an explicit setting, today only `fftSize`) or `default`.

| Field              | Default                                                  | Meaning                                                                                                                                    |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`             | none                                                     | Label                                                                                                                                      |
| `sourceId`         | the default source                                       | Source to scan                                                                                                                             |
| `mode`             | `auto`                                                   | `in-window`, `sweep`, or `auto` (in-window when the scope fits the current window)                                                         |
| `kind`             | `discover`                                               | `monitor` (listen-scan) needs the channelizer; `identify` only via `/identify`                                                             |
| `ranges`           | the current window                                       | `[{startHz, endHz, rasters?, obwHz?, protocols?, enabled?, name?, dwellMs?, sensitivity?}]`, see [Per-range settings](#per-range-settings) |
| `bandplans`        | none                                                     | Built-in bandplan ids, expanded into ranges                                                                                                |
| `exclusions`       | none                                                     | `[{startHz, endHz, reason?}]`                                                                                                              |
| `protocols`        | covering ranges per frequency, else all                  | Priors for classification and the protocols to confirm                                                                                     |
| `sensitivity`      | `scanner.detection.sensitivity` (`normal`)               | Preset, see [Presets and bandplans](#presets-and-bandplans)                                                                                |
| `thresholdDb`      | adaptive (CFAR)                                          | Fixed detection threshold over the floor, 0–40 dB                                                                                          |
| `fftSize`          | `auto` (by sample rate)                                  | 512–16384, power of two                                                                                                                    |
| `integrationMs`    | 50 (100 with `high`)                                     | Detection block length                                                                                                                     |
| `dwellMs`          | settle + (`minSurfaceBlocks` + 1) blocks                 | Sweep dwell per hop                                                                                                                        |
| `settleMs`         | marker run + `pllSettleMs`, or measured/configured timer | Sweep settle per hop                                                                                                                       |
| `hold`             | `{policy: "hold", maxHoldMs: 60000, hangMs: 2000}`       | `hold`, `confirm` or `never`; `confirmHoldMs` per class (1.5–10 s)                                                                         |
| `revisit`          | `{share: 0.3, maxIntervalMs: null}`                      | Share of revisits in a sweep                                                                                                               |
| `record`           | `{voice: true, analog: true, data: true}`                | What to record                                                                                                                             |
| `evidence`         | `{psd: true, iq: false}`                                 | Evidence to keep per discovery                                                                                                             |
| `tuner`            | unchanged                                                | Sweep only: `sampleRateHz`, `gainTenthsDb`, `agc`, `overload: flag \| reduce-gain`                                                         |
| `stop`             | none                                                     | `afterSweeps`, `afterMs` (≥ 1000), `onFirstDecoded`                                                                                        |
| `priority`         | 50                                                       | 0–100, among scanner jobs only                                                                                                             |
| `takeover`         | `false`                                                  | Consent to disturb other consumers (sweep)                                                                                                 |
| `resume`           | `{autoAfterIdleMs: 60000, onBoot: false}`                | Auto-resume after preemption; resume after a core restart                                                                                  |
| `txDurationHintMs` | 5000                                                     | Transmission length used for the probability-of-intercept warnings                                                                         |
| `capture`          | `{enabled: false}`                                       | Burst IQ capture, see [Burst IQ capture](#burst-iq-capture-fixtures)                                                                       |
| `signalsOnly`      | `false`                                                  | Discover jobs: find signals, never start decoders, see [Signals only](#signals-only)                                                       |

The API converts two § 5.1 shorthands before planning: a range's `spacingHz` with optional `firstChannelHz` (default `startHz + spacingHz / 2`) becomes one raster, and an exclusion `{frequencyHz, widthHz}` becomes `{startHz, endHz}` centred on the frequency.

### Per-range settings

Each range can carry its own settings; a range without them behaves as before.

- `enabled: false` keeps the range in the job (same position, same fields) but skips it: it is not swept, masked or used to pick protocols. A job needs at least one enabled range (`range-empty` otherwise).
- `name` labels the range (1 to 100 characters).
- `dwellMs` lengthens or shortens the dwell of the hops that overlap the range. A hop that overlaps several enabled ranges uses the longest of their dwells (a range without one counts at the job's `dwellMs`); the plan shows it as `hop.dwellMs`, and the sweep period adds up the hop dwells. The preview's probability of intercept (detection and decode) for such a hop uses its own dwell; hops without one use the job's `dwellMs`, so plans without per-range dwell are unchanged.
- `sensitivity` (`low`, `normal`, `high`) sets the detector's false-alarm target inside the range. Integration time stays job-wide, set by the job's `sensitivity`.

### Editing a running job's ranges

`PATCH /api/scanner/jobs/:id` with `ranges` edits a job while it runs. Send back the job's whole `spec.ranges` list (operator ranges first, then bandplan ranges) with the changes; the count and order must match. You can switch ranges on and off and change their `protocols`, `name`, `dwellMs` and `sensitivity`; leaving one of these out of a range clears it. Edges, channel spacing (`rasters`), `obwHz` and the bandplan a range came from are fixed while the job exists: changing them answers 400 `SCANNER_PLAN_INVALID` with a `range-locked` issue naming the range and the fields. Stop the job and create a new one to change them. The hop plan changes at the next hop; masks, protocol matching and probes follow as soon as the PATCH returns. Edits are saved with the job, survive a restart, and are kept by later patches of other keys. If the job's band plan changes under it, an edit applies only to the range it was made for (same position and edges); edits that no longer match are dropped once, with a `range-locked` warning in that PATCH's answer, and never block a PATCH. A `ranges` PATCH whose own edit would no longer land because the band plan changed since the job was read is refused instead (`range-locked`, `reason: "range-plan-changed"`), leaving the job unchanged; read the job again and resend. Before SF1 a `ranges` key in a PATCH was ignored; a client that sends its create body back now gets `range-locked`, so leave `ranges` out unless you mean to edit them.

### Signals only

`signalsOnly: true` makes a discover job find and classify signals without starting decoder trials of its own: no confirm or follow probes. Detection, classification, discoveries, evidence and burst captures work as usual, and identities decoded by configured (ambient) decoders or by other jobs on the same frequency are still attached. A signals-only job never widens the protocols other jobs probe. Use it to map activity without spending CPU on decoders. Monitor jobs cannot use it (`signals-only-unsupported`). It can be switched on and off with a PATCH, effective as soon as the PATCH returns; a probe already holding a signal finishes its hold.

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

Automatic resume after operator or relay preemption is held by active identify trials on that source and, when an `OperatorActivityPort` is injected, by operator audio or recording. The default composition injects live audio only: it counts while a client listens through a gating squelch (manual threshold below 0, or auto) on the job's source; recording activity is not reported yet. Audio adds a 3-second hang; the full idle interval starts after activity/hang ends. Job REST and `scanner:job` views expose `resumeAt` (ISO deadline or null) and `resumeHeldBy` (`audio`, `identify`, `recording`, or null). An elapsed `resumeAt` reads as the time it was first seen elapsed and stays fixed while resume is pending. Job-to-job lease hand-back is unaffected by these activity holds. Without an operator port, no external audio/recording activity is inferred. `POST …/pause` on `paused(preempted-*)` means **Stay here**: it becomes `paused(operator)` without acquiring the lease and remains explicitly paused across restart, even with `onBoot` set.

A job in `paused(preempted-job)` shows `preemptedBy: { jobId, name }`, the job that holds its tuner now (`name` null when that job has none). It is absent in every other state and when no job holds the lease, and the paused job's `scanner:job` event is sent again when the holder changes.

When job-level `protocols` is omitted, runtime probes and preview use the union of the enabled ranges covering that signal/hop. A neighbouring range's DMR preference does not apply to a Marine VHF signal. Explicit job-level protocols, including an explicit empty list (all), override range preferences.

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

Stored band plans use a writer lock in the state directory. After an unclean stop it is reclaimed automatically ([After a crash or power cut](DOCKER-SETUP.md#after-a-crash-or-power-cut)); a lock held by another live core is never taken.

`GET /api/scanner/bandplans` lists the effective plans. Under the default band-plan stack these are the built-in plans for the effective region (`region` config; EU, or US/CA → US):

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

The band-plan stack under `/api/bandplans` (see [API.md](API.md#band-plans))
selects which built-in plans the scanner uses: each enabled built-in pack, in
stack order, contributes its region's plans above, minus bands hidden with a
`hidden: true` edit; a plan id already contributed is not repeated. Imported
packs, operator bands, `skip` and other edits are display-only and change no
scan range. Job plan ids and the host ranges that operator ranges inherit
rasters from resolve against this list; a plan that is not in it is
`range-empty`. A change applies at the next job create, patch or preview; a
running sweep and a resumed job (explicit, automatic or after a restart) keep
the plans they were admitted with, while a patch re-checks the job's plan ids.
Identify priors follow the same list, so hiding a built-in band also drops its
identify priors. Until the
band-plan service opens, or if it fails, the scanner uses the built-in list.
Scan presets only produce job bodies: `GET /api/bandplans/presets/:presetId/job`
returns a `spec` that a client posts to `POST /api/scanner/jobs`; preset
`applicable` and `issues` are checked against the effective list.

Sensitivity presets: `low` (false-alarm target 0.25 /MHz/min, 50 ms blocks), `normal` (`detection.faTargetPerMhzMin`, 1.0, 50 ms), `high` (2.0, 100 ms).

## Settings

The `scanner:` section of `config/default.yaml` holds the defaults. "Runtime" marks the keys `PATCH /api/scanner/settings` accepts; they are persisted in `settings.json` and win over the config file. `GET /api/scanner/settings` reports the provenance of every key (`config`, `runtime`, `default`).

| Key                                                                                               | Default                               | Runtime |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| `enabled`                                                                                         | `true`                                |         |
| `passive.enabled`, `passive.offsetProbes`                                                         | `true`, `false`                       |         |
| `passive.maxEngineUtilization`                                                                    | absent (= 0.25)                       |         |
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
| `ws.spectrumBinsCap` (`auto`, 2048, 4096, 8192)                                                   | absent (= `auto`)                     |         |
| `iqCapture.enabled`, `maxTotalMb`, `maxCaptureMs`, `preRollMs`, `binaryPath` (protected)          | absent (on); `true`, 256, 4000, 500   |         |

Env overrides: `WAVEKIT_SCANNER__CPU_BUDGET_CORES=0.5`, `WAVEKIT_SCANNER__PASSIVE__ENABLED=false`. Per source: `sources[i].scanner: { role: shared | dedicated, passive: true }`; dedicated receivers never get unsourced decoders. Example PATCH: `{"passive": {"rtl": false}, "maxProbes": {"offset": 0}}`.

## Discoveries, evidence and storage

One discovery per emitter: same frequency key, protocol family and identity. Two DMR networks on one channel are two discoveries, cross-linked as co-channel. An observation surfaces after its channel gate passes, or after an accepted identity decode places a short burst. Observations are kept per transmission with signal statistics and the decode evidence.

### Detection quality: admission, association and data bursts

A discovery means something transmitted there. These rules keep intermod products, noise and pager bursts out of the list and keep one emitter on one record. Full rules, fixtures and measurements: [detection quality spec](specs/detection-quality/requirements.md).

**Admission.** An observation that no decode proves creates a discovery only with evidence of a signal:

- a channel SNR of at least 18 dB, or at least 25 dB when the front end was overloaded (`overload` flag; intermod products of a clipping carrier stay below it);
- otherwise (not overloaded, under 18 dB) it is held as pending, not stored or shown. It is promoted when a later sighting reaches 18 dB, or when 3 distinct observations within 10 min of the first have a median SNR of at least 15 dB. Overloaded weak sightings never enter pending;
- a signal that stays on is promoted by duration: one sighting whose channel SNR has a median of at least 12 dB over at least 3 s, with no reading under 9 dB and no gap over 2.5 s between readings, creates a discovery. This is how a broadcast FM station or a steady carrier at 10 to 17 dB gets a record, since it is one long sighting rather than several short ones. Noise does not stay at 12 dB for 3 s;
- push-to-talk use adds up: when separate transmissions on one channel (for example 2 to 10 s airband overs) each last past their first second, their airtime is pooled for 60 s, and the channel gets a record once the pooled airtime reaches 3 s with a median of at least 12 dB. Adjacent 8.33 kHz channels pool separately, and any new record on the channel, however it was created, clears its pooled airtime;
- a short burst (under 1 s) needs its own signal level, not just its strongest channel reading, to reach 15 dB before it creates a record at once; a weaker one waits for more sightings like any weak signal, so a single weak data burst does not leave a one-sighting record;
- the detector looks at 95 % of the tuned span (±486.4 kHz at 1.024 Msps), but signals beyond the usable 80 % (±409.6 kHz) are flagged `edge` on their observations: such a signal passes the same channel gate, needs its own signal level at 15 dB to create a record at once however long it lasts, shows as class `unknown`, and is never held to confirm, IQ-captured, burst-captured by a capture job, given PSD evidence or given an automatic analog trial there. An IQ or burst capture whose signal turns `edge` after it started is discarded, never replayed or kept (a replay already running then has its result dropped: no identity, no trial memory) (probes and analog trials keep their whole channel inside the usable 80 %). Retune to put it inside the 80 % to identify it;
- a signal is judged in a bandwidth that matches its own width: a signal wider than one channel by its strongest channel, and a narrow carrier by its own few kHz rather than diluted across a whole 8.33 or 25 kHz channel;
- an observation with a missing or non-finite centre or SNR is dropped.

A decoded observation is admitted as before. The channel gate counts only blocks at least 3 dB over the floor toward its minimum on-time (300 ms, 100 ms for a burst). On airband, the gate measures 8.33 kHz channels, so an AM voice carrier is judged in its own channel and not diluted by a 25 kHz one (about 4.8 dB better). In a band plan range that lists AM (airband, CB), a carrier that shows speech sidebands (a -20 dB width of 6 to 12.5 kHz) gets the class `analog-am` (AM voice) and is tried with AM first, not labelled a steady carrier. A plain carrier is still a carrier, and a very weak AM carrier whose sidebands are lost in the noise still looks like one.

**One signal, one segment.** Before signals become tracks, each spectrum block is cut into signals:

- at a dip of 6 dB or more below the peaks on both sides, when the dip also reaches the lower half of the weaker side's height above the noise floor (so the two tones of one FSK pager are not split);
- at the channel edges of the band plans that cover the tuned window, also while only the background (passive) scan runs; each band plan's channels apply inside its own range only;
- pieces that join without a 6 dB dip never cross a channel edge of the band plan's widest channel spacing (25 kHz on airband, 12.5 kHz on land mobile), so a crowded band splits into one signal per channel. A piece more than 10 dB weaker than a neighbour peaking within 31.25 kHz (AM sidebands, splatter) stays with that neighbour, and two peaks closer than 0.8 of a channel stay one signal;
- without a band plan (FM broadcast, for example) only the dip rule applies, so a broadcast station stays one signal.

A track's reported bandwidth never exceeds its widest single block, so a weak track that drifts does not grow into its neighbours.

**One channel, one record.** During the background scan, a discovery on a band with a channel plan is placed on its channel (the finest channel spacing of the band plan that is at least half the signal's width: 8.33 kHz for an airband voice carrier, 25 kHz for a wider data burst): sightings whose measured centre wanders inside one channel join one record, adjacent channels stay separate records, and such a signal is never labelled `wideband`. A sighting creates no record when it does not stand at least 6 dB above the neighbouring 12.5 kHz on each side (a raised stretch of busy channels or splatter), or when its nearer edge sits within 12.5 kHz of the tuned centre, where the receiver's own DC pedestal shows. A decode still creates a record in both cases.

**Association.** One record per emitter:

- a sighting of the same family as a record joins it within the usual frequency tolerance;
- a sighting within 1 kHz of a record on the same source joins it whatever family the classifier gave it, when its occupied bandwidth lies between a third of the narrowest and three times the widest of the record's last 64 sightings (half and twice for a record that decoded or carries an identity). So a DMR signal classed analog-fm one time and fsk4 the next, or a transmitter whose measured width swings from 13 to 39 kHz, stays one discovery from its first sighting on; a plain carrier joins its own record the same way;
- for association, a record's family counts only when it decoded, carries an identity or has proof (a decode, heard analog audio or carrier-only evidence). A protocol guess alone (a candidate pocsag, dmr or analog-fm label) counts as unknown, so it never keeps records apart; the label you see is unchanged;
- a sighting decoded as one protocol never joins a record decoded as another (DMR and P25, POCSAG and FLEX);
- a record lists at most 8 co-channel partners, nearest first; partners that no longer exist or have drifted out of tolerance are dropped on both sides;
- a DMR, P25 or YSF talker id decoded on a record 6 to 30 kHz from the record that already holds it, at the same time and at least 10 dB weaker, is an adjacent-channel copy and stays on the stronger record.

**Duplicate records are folded together.** Two records on the same source whose median centres are within 1 kHz, each with a median bandwidth inside the other's bandwidth range (above) and not split by the level rule below, are one emitter and are merged, unless they carry different identities (two DMR colour codes), are two different confirmed families (a proven analog record and its decoded digital twin), are both decoded as different protocols (DMR and P25 included), or either has an operator label, note, Ignore or Keep. The oldest record survives (a decoded one first); counts, airtime, evidence and recordings move to it and the merged-away id becomes one of its aliases, like any other merge (its own URL then answers 404). This runs once at every core start, before scanning resumes, on at most the 32 records nearest each candidate (a group holds at most 16 records; anything left over is folded at the next start), and again whenever a sighting joins a record that has such a duplicate next to it. A start that is interrupted while folding finishes the same groups at the next start (`consolidation-plan.json` in the scanner state directory, removed once a snapshot covers the result).

**Fragments of one channel.** WaveKit folds the fragments older versions left beside or inside one channel, and retires stale ones. Before it removes a record it confirms that no evidence folder, digital voice or analog recording folder, burst capture (finished or still being written), evidence write in progress or remembered replay trial exists for it or any of its aliases; a folder it cannot check (for example a permission error) counts as present, so the record is kept. Every 5 minutes, with the inactive prune:

- records on one channel of the band plan's channel grid (the finest channel raster at that frequency, within half a channel spacing of the channel centre, and no wider than two channels) are merged into that channel's record, even when they are more than 1 kHz apart; two records merge only when they also share a channel of the finest grid at either of them, so a wide record never swallows a neighbouring narrow channel;
- the channel record is the one with an operator label, note, Ignore or Keep, else one with a decode or evidence, else the one with the most sightings (then the oldest). A record with an operator label, note, Ignore or Keep, a decode, decoded data (talkgroups, capcodes, callsigns, an identity), recordings, PSD or IQ evidence, proof, a kept recording, or any evidence the check finds, is never merged away or retired;
- merges follow the same rules as above (identity, confirmed family, decoded protocol and level split keep records apart), move sightings, airtime, first and last seen and metadata to the channel record, and the merged-away id resolves to it; a merge that would give a record more than 64 aliases is refused;
- a record with at most 2 sightings, never classified or decoded and not seen for 72 hours retires (it is deleted, like an inactive prune);
- one pass looks at up to 512 records, merges at most 32 groups of at most 16 records (it stops looking once 32 formed), retires at most 256 records and runs the evidence check at most 1 024 times; the next pass continues where it stopped. N records holding G groups of fragments and R stale records are all handled within N / 512 + G / 32 + R / 256 passes (each rounded up); the worst case for a 10 000-record store, 5 000 two-record fragments, is 20 + 157 = 177 passes (about 15 hours), while real stores, where a few per cent of records are fragments, clear in a few passes. Each merge and retirement is an ordinary journaled merge or delete, so an older WaveKit reading the store afterwards sees the result and nothing new.

**Strong overs next to ambient carriers.** A sighting at least 20 dB stronger or weaker than a record and at least 1.5 times wider or narrower does not attach to it; it gets its own record. Both differences are needed, so a fading mobile or a noise record whose width swings stays one record. With 3 or more observations the record's medians are compared; a younger record is compared sighting by sighting. This applies to every merge path. An overloaded sighting never raises a record's best level, and a record's class is the majority of its last 64 observations, not the latest one.

**Pager data is not voice.** A closed live-audio transmission is not stored as an analog voice (`analog-transmission`) Activity row when Activity accepted a paging or APRS decode from the same source within 1 250 Hz of its frequency, during the transmission or up to 1 s before or after it, on a channel whose tuning WaveKit commands or relays. The pager decode is the record of that burst, and identify attaches no analog proof for it (no `analog-fm` candidate). The decision waits 1 s after the final close is published, so voice rows are stored one second later than before: an ordinary squelch close is already final only after the 1.5 s merge gap, so its row appears about 2.5 s after the audio ends. The `live-audio:transmission` WebSocket events are unchanged. When anything is unknown (no provenance, unverified tuning, more than 8 closes waiting) or at shutdown, the transmission is stored as voice, as before.

**Decodes reach the discovery.** A protocol that confirms on two matching decodes (a POCSAG or FLEX capcode, an APRS address, an rtl_433 device, a DMR colour code, an AIS, ACARS or VDL2 identity) pairs them across every probe and configured decoder on the same discovery (or, before it has one, the same observation): one decode in each of two short probes confirms. The two decodes must be at least 2 s and at most 5 min apart, so one transmission heard by two decoders at once counts once; a repeat within 5 min refreshes the window. At most 4096 identities are remembered; the oldest go first. A replayed IQ capture still pairs only within its own replay. A configured decoder's decode names tracks by occupied-span containment with a small placement tolerance (see Ambient identification below). Ambiguous signals receive no identity. Activity rows from scanner probes carry the probe's channel frequency, rtl_433 rows its own `freq` estimate when it lies in 24 to 1766 MHz and within the usable 80 % of the input it heard (0.8 × sample rate / 2 of its channel, ±409.6 kHz at 1.024 Msps), else its channel frequency (also when the input rate is unknown), and readsb rows 1090 MHz.

To find discoveries by what a decoder reported, `GET /api/scanner/discoveries?identity=<kind>:<value>` (for example `identity=dmr-cc:1` or `identity=pocsag-capcode:1234567`) keeps those whose identity has that kind and value, ignoring case and surrounding spaces. The free-text `q` matches the operator label or the identity value; talkgroups, callsigns and other metadata are not searched. See [API.md](API.md#get-apiscannerdiscoveries).

Discoveries read through `GET /api/scanner/discoveries` carry `coverage` when decoder status is known: up to 3 decoders whose placements cover the discovery's frequency on one of its sources, with their state (`running`, `suspended` with its reason, or `stopped`). A channel placement covers its channel centre plus or minus half the channel width the decoder is placed with (`channelWidthHz` on the decoder status placement), or 12.5 kHz when it reports none. See [API.md](API.md#discovery-coverage).

Storage layout under `scanner.storage.dir`:

- `discoveries.json` (snapshot), `journal/` (daily observation journals), `jobs.json`, `settings.json`;
- `engine/` (per-source detector state) with `engine/occupancy/` (occupancy history);
- `recordings/dv/<discoveryId>/` (digital voice WAVs), `evidence/<discoveryId>/` (`psd.json`, `iq-*.cu8`);
- `captures/` (burst IQ captures);
- `iq-captures/` (protected mode with `iqCapture.enabled` only: short narrowband captures waiting for replay, deleted at their result; see [IQ capture on detection](#iq-capture-on-detection)).

**Downgrading after the `analog-am` class.** This version stores AM voice discoveries with class `analog-am`. An older WaveKit does not know that class: it rejects the whole `discoveries.json` snapshot (moved aside as invalid) and every journal mutation that names it, so its AM records are lost and the rest is rebuilt from the journal alone. Before upgrading a host you may need to roll back, stop WaveKit and back up `scanner.storage.dir`; to downgrade, stop the newer version and restore that backup before starting the older one. Anything discovered since the backup is not kept.

Retention: the `storage.max*Mb` caps, `maxAgeDays` (recordings, evidence and journal files), `discoveryMaxAgeDays` (discoveries not marked `keep`) and `maxDiscoveries`. When free disk drops below `minFreeDiskMb` the status reports `disk: "disk-low"`: recording and evidence stop; discoveries keep updating. Privacy: identifiers (talkgroups, radio ids, callsigns, capcodes) stay on the host; nothing is uploaded.

Store CPU: a wide sweep no longer saturates the main thread in the discovery store. Sticky association searches a per-source, per-family index ordered by each discovery's cached median centre (recomputed only when its observations change) instead of scanning every discovery; per-job counts by confidence are kept incrementally; change detection uses revision counters instead of whole-record clones and string compares; and the `discoveries.json` snapshot is written by a worker thread from a mirror fed by the journal, with the old main-thread path as the fallback (the same bytes either way). Measured at 10 000 discoveries and 50 000 observations: 41.5 µs per ingest, 1.1 µs per progress count build and 1.71 ms of main-thread time per steady snapshot; the first snapshot after boot, a mirror reset or a worker restart still runs on the main thread (about 1.2 s at that size). The worker heap limit scales with host memory (256 to 2048 MB); a host under about 6 GB writes very large snapshots on the main thread. A snapshot text above V8's maximum string length (about 512 MiB, roughly 10 000 discoveries with 256 observations each) cannot be built on either path.

Merges and evictions: when a merge drops a discovery into a survivor, the dropped discovery's folders stay in place and become the survivor's aliases (persisted, at most 64 per discovery; past that the oldest becomes an orphan, warned as a count). Retention, `recordingPath`, Keep and removal treat alias folders as the survivor's, and removing the survivor removes them too, file by file through the keep decision. A `maxDiscoveries` eviction removes the evicted discovery's folders like an age prune and sends `scanner:discovery` `deleted`; a discovery holding a kept recording is never evicted. A scanner digital voice recording can be deleted with `DELETE /api/recordings/:id` in protected mode (see [API.md](API.md#put-and-delete-apirecordingsidkeep-delete-apirecordingsid)).

### Ignore skips sweeps

Marking a discovery Ignore (`PATCH /api/scanner/discoveries/:id` with `lockout: true`) stops its probes, blocks listen and takes its frequency out of sweeps on the sources it was heard on. Each lockout becomes a runtime exclusion of width max(the discovery's bandwidth, the narrowest raster step of the ranges holding it, 1 kHz) centred on it and clipped to the job's enabled ranges. The sweep's hops no longer list that channel; a hop whose channels are all locked out is dropped. In-window jobs are unchanged. Rules: at most 256 lockout exclusions apply per job (lowest frequency first, the rest are listed unapplied); lockouts never empty a plan (if they would, none applies and all are listed unapplied); they are never written into the job's spec; while a lockout stays set, a PATCH or a restart plans with it again. Clearing or deleting the lockout restores the coverage. A locked-out discovery is never evicted at `maxDiscoveries` or pruned by `discoveryMaxAgeDays` (sweeps no longer hear it, so its last-seen time stops moving); delete it to drop it. Setting, clearing or deleting a lockout replans the affected sweep jobs at once. The plan preview and the job show them as `lockoutExclusions` with `applied`.

### Hit statistics

Each job counts its hits: one per observation attributed to a discovery, per discovery with first and last hit time and whether the job first saw it. `GET /api/scanner/jobs/:id/hits` lists them (most recent first); the job's `progress.hitStats`, `scanner:progress` (`hits`, `newDiscoveries`) and `scanner:discovery` (`jobHits`) carry them too. In memory only: reset when a job starts (not on resume), dropped with the job, empty after a restart. Bounds: 2,000 discoveries tracked per job (later ones count in the totals only) and a 4,096-observation dedupe memory; past either bound the stats say `truncated: true` and are best-effort.

## Listening

`POST /api/scanner/discoveries/:id/listen` retunes live audio's `offsetHz` to the discovery when it is in the current window (409 `OUT_OF_WINDOW` otherwise). Probe audio is on the digital voice server at `/decoders/<probeId>/stream`.

**Identify** (`POST /api/scanner/identify`, spec § 10.8): click a signal on the waterfall and every plausible decoder tries it, in the current window and never retuning (409 `OUT_OF_WINDOW` outside it; 409 `SCANNER_SOURCE_BUSY` while a sweep holds the tuner). A click on the DC spike, a spur or comb tooth, or an IQ image is answered at once with `artefact` and no trial; broadband RFI is the answer only when nothing transmits within `timeoutMs` (15 s). Before the channelizer the trials run one at a time as offset probes with 300 ms pre-roll, each for its hold, and preempt passive probes; after it they run in parallel. The result (`identified`, `candidate` or `unidentified`) always carries the measurements and the per-protocol trial list, and the observation lands in the discovery store like any other. If the window moves off the target, the result carries `ended: "window-moved"` and open trials are `cancelled`. Identify jobs cannot be paused or edited and are not kept across restarts.

**Identify for analog voice.** There is no probe decoder for analog FM or AM: the `analog-fm` and `analog-am` trials read the live demodulator's squelch-delimited transmissions (decoder `live-audio`, the latest 32 kept) on the job's source within the target's tolerance, back to 30 s before the job started. A CTCSS or DCS tone on a `commanded` or `relay` frequency makes the target `identified` (`classified`), anything else that matches `candidate`; the tone is only ever the one the transmission tracker reported. Identify never starts or retunes live audio, so the trials end `unsupported`/`no-live-audio` when live audio was not on the target for the whole window, and `no-sync` when it was but nothing keyed up. A digital decode keeps priority. Probe decoders whose program cannot run are listed in `result.decodersUnavailable` and are not respawned for 300 s. Details in [API.md](API.md#post-apiscanneridentify).

**Heard versus decoded.** An analog trial ends `decoded` only when the matching transmission carried a CTCSS tone or a DCS code; a squelch opening without either ends `heard` (it was heard, nothing was decoded). The verdict rule is unchanged: `identified` still needs a tone or code on a `commanded` or `relay` frequency. A live-audio analog match does not stop the digital trials (a successful analog replay does stop the remaining replay trials): it ends only the other analog trials, and every probe and ambient trial runs to its own end, so a digital signal heard through live audio still gets its digital decoders (an identify job with analog evidence can take until its digital trials end).

**Narrow digital trials.** When the target lies in a band-plan range with a channel raster of 6.25 kHz or less (PMR446, land mobile), identify also tries `nxdn48`, `dpmr` and `dstar` even when the track's width suggests 12.5 kHz, scored at least 0.3 before the band priors (a prior of 0 still removes them). For an analog-looking track at 446 MHz the last narrow run ends about 10.6 s in, within the default 15 s.

**Known protocol first.** A discovery that decoded keeps its protocol as the known protocol: identify (and replay, below) try that decoder first, then every other plausible trial in the usual order, so nothing is skipped when the known one fails. The memory decays safely: a known trial that ran its full hold on a transmission and decoded nothing counts a miss, any accepted decode resets the count, and after 2 consecutive misses the discovery is planned like an undecoded signal until it decodes again. Misses are kept in memory only and never change the stored protocol or confidence. Scan job probes count misses the same way, except sweep probes (a hop cut cannot be told from an expired hold) and a protocol only a probe's last mode covers (`nxdn96`), which only identify can decay.

## IQ capture on detection

On by default in protected access mode (`scanner.iqCapture.enabled: true`; in legacy mode it is not started and one info line says so). It exists so a transmission can be identified after it ended, when no decoder was running in time. The flow is fixed: **capture → queue → replay trials → result → discard**.

1. **Capture.** A native tool (`wavekit-iqcap`, shipped next to `wavekit-chan`) keeps a 2 s full-rate ring of the source's IQ from the spectrum engine's tap. When a track surfaces and its discovery has no confirmed result for this transmission (not decoded yet, or a known protocol not yet confirmed live on it), and it is not a spur or an image, the scanner asks for a capture: the channel shifted and decimated to 48 kHz complex float32 (96 kHz for an ISM band or an OOK burst, see below), from the pre-roll (500 ms by default) to the track's close or 4 s. At most 6 per source per minute and 2 at once; at most 256 MiB on disk.
2. **Queue.** A finished capture joins one first-in, first-out replay queue. An identify job near it takes it over instead (at most 2, newest first) and replays it after its live runs.
3. **Replay trials.** Up to 8 trials: the known protocol first, then the probe modes the captured track scores (narrow digital included). They run one at a time through the `replay` probe transport (dsd-fme, multimon-ng, direwolf, rtl_433), faster than real time, at 0.15 cores of the probe budget, below identify and above passive. They do not need a live spectrum engine, so the queue drains even after the passive guard closed the engine.
4. **Result.** The first accepted decode is the result and ends the remaining trials; otherwise "no decode". A replay decode is accepted by the same rule as a live probe, except ACARS: one CRC-clean acarsdec block is enough on a replay, where a live decode needs two (see below). The result lands on the capture's observation like a live decode and feeds the known-protocol memory.

5. **Discard.** The capture is deleted as soon as its result exists, or unreplayed when a live decode came first. One that never got a result is deleted 10 min after it finished. A capture across an epoch change, with a bad file or a failed process is never replayed. Nothing survives a restart; the startup sweep removes only files that are provably captures.

**Pagers come first in paging ranges.** In the EU the band plans include the French paging band (466.025 to 466.230 MHz on 12.5 kHz channels, plus the single pager channel at 446.5325 MHz), and the scanner also treats the wider 466 MHz paging range (465.975 to 466.550 MHz) as pager territory. A signal there that looks like 2-level FSK, narrow 4-level FSK or narrow FM is tried with the POCSAG/FLEX decoder before DMR and before the analog trial, so an analog "heard" never skips the pager decoder, even when the analog trial worked on that signal before. A 2-tone FSK signal with about 9 kHz between its tones (POCSAG and FLEX at 1200 or 2400 baud) is treated as a pager signal, never as digital voice.

**The scanner remembers what worked.** Every replay trial's outcome is kept per discovery (which decoder, how it ended, when, how often it ran) and survives a restart (`trial-memory.json` in the scanner storage directory; a damaged file is ignored and the memory starts empty). The next capture of that signal is tried in this order: decoders that decoded it before, the known protocol, decoders that ran without failing, untried decoders, then decoders that failed. A decoder that failed k times in a row waits 1, 2, 4 … minutes (at most 1 hour) before it is tried again, unless nothing else is left. At most 16 decoders per discovery and 2 048 discoveries are remembered; the oldest go first. The memory is not shown in the API yet.

**More decoders, when they can replay.** The replay plan also names rtl_433 for ISM signals (a band plan that lists ISM at the capture, an OOK burst, or a known ISM discovery, whose trial then runs first), acarsdec for ACARS (a known ACARS discovery's trial runs first), dumpvdl2 for VDL2, AIS-catcher for AIS, the LoRa decoder for LoRa and readsb at 1090 MHz. rtl_433 reads the capture as it is, with every built-in protocol, and a sensor that repeats its frame in one burst is identified from that one capture (two matching checksummed decodes). 48 kHz is not enough for every OOK sensor: rtl_433 decodes 500 µs pulses at 48 kHz, but merges pulses of about 220 µs and decodes nothing (a recorded weather sensor with 229 µs pulses and a synthetic 220/408 µs frame both decode at 96 and 192 kHz and not at 48 kHz). So a capture where the band plan lists ISM, or of an OOK burst, is made at 96 kHz with the same 47.4 kHz passband; every other decoder and the analog trial get it brought down to 48 kHz. FSK sensors whose deviation reaches past ±23.7 kHz do not fit the capture's passband and are identified only live. dumpvdl2, AIS-catcher, the LoRa decoder and readsb cannot read a replay capture yet, so their trials are skipped (never run) until they can; they still decode live as configured decoders. LoRa needs a capture passband of 125 or 250 kHz, and every capture keeps a 47.4 kHz passband whatever its rate. dumpvdl2 needs a multiple of 105 kHz, which no capture rate is, and the image's dumpvdl2 build accepted only 8-bit IQ (U8) in our offline test. acarsdec does replay: the capture filtered to its 25 kHz channel, AM-demodulated at 48 kHz and resampled to 12 kHz audio. Because a replay pairs identities only within itself and a capture holds at most 4 s, ONE ACARS block with acarsdec `error` 0 (valid framing, parity and CRC-16, no bit corrected) is the decode of that replay, named by its registration at the capture's channel. Live and configured acarsdec decodes keep the two-decode rule.

**The first transmission is captured too.** A signal that passed the channel gate gets a capture even before it has become a discovery, at most 2 per source per minute (leaving at least 4 of the 6 for discoveries). When its replay decodes, the signal becomes a discovery with that decode. A replay that ends after the signal has left the scanner's short recent list (about 10 s) still lands when exactly one stored discovery of that source sits within 6.25 kHz (half a 12.5 kHz channel) of the captured frequency and can take that decode; with none, two or more, or one already decoded as another protocol, it is dropped.

**A live decoder does not skip the capture yet.** Every signal that passed the channel gate is captured within the limits above, even on a channel a paging or digital-voice decoder already listens to: the scanner cannot yet tell exactly when a signal started relative to when that decoder started (it would need the time each sample arrived), so it never assumes the decoder heard the start.

**Capture size.** A capture is complex float32: 8 bytes per sample, so a full 4 s capture is 48 000 × 4 × 8 = 1 536 000 bytes (about 1.5 MB) at 48 kHz and 3 072 000 bytes at 96 kHz. The 256 MiB cap holds about 174 full 48 kHz captures or 87 at 96 kHz; a capture that would pass it is refused. At 6 captures per source per minute that is at most about 9.2 MB per source per minute at 48 kHz and 18.4 MB if every one is at 96 kHz.

**Decodes from busy-channel decoders land on their channel.** A paging or digital-voice decoder that the planner moved to a band-plan channel reports its decodes at that channel, so they land on that channel's discovery (not at the tuned centre). Each such channel confirms its own identities: a colour code or capcode heard on one channel never confirms a decode on another.

**Busy channels get the decoders.** Paging (POCSAG/FLEX) and digital-voice (DMR and similar) decoders can only run on a few channels of a band at once. The scanner ranks every channel those decoders could use by recent activity, and the decoder planner puts its spare channel slots on the busiest ones instead of only the ones nearest the tuned centre:

- a channel with signal energy in the latest spectrum block (no older than 1 s) always ranks first; an overloaded block shows no energy, and 10 s of overloaded blocks count as no fresh spectrum;
- energy in the last 2 minutes, or an accepted decode (timed by when it was decoded, not by later activity) or successful replay in the last 15 minutes, makes it hot; energy or a gated signal in the last 15 minutes, or a decode in the last 6 hours, makes it warm; nothing newer makes it cold again, so no channel stays busy forever;
- long-term occupancy only nudges the order, it never makes a channel busy on its own;
- a replay that ran on the whole capture and decoded nothing pushes the channel down for a minute; a replay that was cut short, cancelled or skipped for CPU counts for nothing;
- a signal is credited to the nearest channel within half a channel width; a signal halfway between two channels is credited to neither.

When the spectrum has no fresh block for 10 s, while the receiver retunes, or when it stops, the ranking is not used and the planner falls back to the nearest-first order. Updates reach the planner at most 250 ms late. The ranking costs about 2 µs of main-thread time per spectrum block on the reference Mac.

Cost on the reference Mac: about 0.06 to 0.14 cores for the tool with 2 captures active (0.0002 with the ring only), about 11.4 MB of memory per source outside the file cap, and no measurable event-loop cost for the tap feed. Details and bounds in [API.md](API.md#iq-capture-on-detection).

## Honesty and limits

- Detection is measured on one strong DMR capture; false-alarm control adapts per range (CFAR), but a fresh dongle needs minutes to learn its spurs.
- A sweep can miss short transmissions: the preview reports probability of intercept per hop for `txDurationHintMs`, with each hop's own dwell.
- `scanner:progress` reaches WS clients at up to 2 Hz per job (one per 500 ms); every other scanner message keeps one per key per second, and all share the `ws.maxMessagesPerSecond` budget.
- That budget is shared with `scanner:activity`: when slots are scarce the limiter sends state messages first, then progress, then activity, so faster progress can delay activity updates (each still gets its latest state eventually).
- P25, NXDN, D-STAR, dPMR and DMR repeater rules are unvalidated until captures exist; those results stay `candidate` unless dsd-fme decodes them.
- Marker settle needs the RTL2832 test mode to reach the core; over some rtlmux/Wi-Fi paths it does not, and timer settle makes sweeps about 6× slower.
- Before the channelizer, one confirm probe runs at a time; on a Pi 4 even that may exceed the CPU budget.

### Why a DMR band scan found only Heard signals

A sweep decides whether to probe a track at the end of its hop dwell, about 150 ms (3 blocks) after the settle. A track that young carries no TDMA signature yet: the envelope autocorrelation needs at least 300 ms and the first track update that has it comes after 1 s. The spectral classifier labels a track of up to 4 blocks an OOK burst unless the band's ISM prior is below 1, and in a sweep the classifier saw no band prior when no job range at that frequency named protocols (a 135 to 174 MHz range is enclosed by no single built-in plan). So every young land-mobile track became an ISM burst, which has no probe mode: no probe, no deferral, no decode, and the discovery stayed `activity` or `candidate`. Identify was not affected because it uses the band-plan priors. Fixed: a sweep over a range that names no protocols takes the band plan's ISM prior at that frequency, except inside the OOK short-range-device allocations (314 to 316, 433.05 to 434.79, 863 to 870 and 902 to 928 MHz), where a short burst stays an OOK burst. A second cause: the dsd-fme `auto` (DMR) mode held for 600 ms, below a DMR late entry (about 1.8 s); its hold is now 1 800 ms (which also lengthens P25 and other `auto` probes). Ruled out: hop dwell and the probe budget. Still conditional: the CPU guard defers probes when the container runs above 90 % of its CPU quota, and such deferrals are recorded as `budget`.

### Known limitations

- Relay and live audio default to the first non-dedicated source. Explicit source selection routes that source's IQ, capabilities and controls together. If every source is dedicated, implicit selection is rejected; select a source explicitly. Legacy live-demod callers supplying a fixed fanout cannot switch radios at runtime without supplying the source router.
- A dedicated source added at runtime (`POST /api/sources`) is not excluded from the default-source choice until the core restarts. This matters only when no shared source existed at boot.
- An enabled relay without an explicit source cannot start when there are no configured shared sources (including an empty source list). The core exits during startup; configure a shared source, select a source explicitly, or disable the relay.
- After a fatal spectrum worker failure, passive discovery can remain failed until a source reconnect, capability change or settings update rebuilds it. `passive.enabled` describes the configured job's presence, not successful scanning. Inspect its job state and the spectrum engine error.
- Spectrum-only clients receive no automatic profile notification for that fatal failure. Consult `scanner:status` or `GET /api/spectrum` when frames stop; re-subscribe after cleanup to request a fresh engine. Automatic bounded passive recovery and direct display failure notification remain follow-up work.
- The CLI's `6 Scan` view ignores scanner fields it does not know yet (newer track fields, for example); the web app's Scanner drawer shows them.
- Per-range `sensitivity` changes only the detector's false-alarm target in that range; integration time stays job-wide. Ranges with identical edges share one target (the most sensitive one set; a range without one counts at the detector's current target). Where ranges overlap only partly, the detector uses the first matching range; overlaps are not split.
- Per-range `dwellMs` applies to whole hops: a hop that also covers a neighbouring range dwells as long as the longest of them.

### Rules as implemented (spec wording notes)

These are the rules the code follows where the design spec's wording differs:

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

**`spectrum:profile`** is sent to that client only, as the ack to a subscribe or as a notice after a permanent source removal or a default-profile change that remapped it: `{selection: "none" | "default" | "source", sourceId, profile: {key, hz, bins} | null, effectiveHz, outcome: "default" | "exact" | "nearest" | "rejected" | "removed", adjusted: ("hz" | "bins" | "profile-limit" | "averaging" | "backfillMs")[], backfillFrames?, removedSourceId?, code?, message?}`. `selection: "none"` means no frames. A `rejected` request (`SPECTRUM_OPTIONS_INVALID`, `SPECTRUM_SOURCE_NOT_FOUND`, `SPECTRUM_SOURCE_NOT_IQ`, `SPECTRUM_SOURCE_REMOVED`, `SPECTRUM_ENGINE_ERROR`) keeps the previous selection.

**Limits.** The server serves the nearest admissible profile and never rejects a request for its size. Above `scanner.ws.spectrumMaxProfiles` (4 distinct non-default profiles over all sources; config-only, 1–16) a request maps to an active profile on that source (preferring one not larger than the request) or to the default, with `outcome: "nearest"` and `adjusted: ["profile-limit"]`. Averaged profiles count against the same limit; an averaged request maps to the nearest profile with the same averaging, else to averaging off (the default always qualifies), adding `"averaging"` to `adjusted` when the averaging changed. `GET /api/spectrum` reports `limits` (also `averaging` 1–32 and `backfill` bounds).

**Averaging and backfill (opt-in, per client).** `options.spectrum.averaging` (1–32, default 1 = off) gives an exponential average over n frames per bin in dBFS after each frame's max-hold (`avg += (frame − avg) / n`, seeded with the first frame, restarted on a new epoch, stream or bin layout). It is part of the profile: the key becomes `<hz>:<bins>:a<n>` and `profile.averaging` is set only when n > 1; clients that never send `averaging` never get an averaged profile. `options.spectrum.backfillMs` (0–10000, default 0 = none) replays recent frames of the current stream and epoch after the ack; the ack's `backfillFrames` says how many follow. Without either option a client gets plain max-hold frames and no backfill.

**Cadence and resolution.** One frame per `ceil(blockHz / hz)` block summaries, with `blockHz = 1000 / integrationMs` (20 at the default): 25 Hz gives 20 Hz, 10 or 15 Hz gives 10 Hz. `effectiveHz` is that cadence while blocks flow and an upper bound across sweep settles and gaps. `binCount ≤ bins` (never upsampled) and `binHz` is the true width; `nativeBinHz` is `fs / fftSize`, so `binHz / nativeBinHz` is the total max-hold factor. The engine's summary budget `scanner.ws.spectrumSummaryBins` (2048, config-only, 512–8192) caps the detail any profile can get; it is not a client setting. Clients get at most min(host bins cap, summary budget) bins: `scanner.ws.spectrumBinsCap` (`auto`, the default when absent, measures the host once at startup; or a fixed 2048, 4096 or 8192) sets the cap and `limits.binsCap` reports it. The default profile keeps 128–2048; detail above 2048 bins also needs `detection.fftSize` ≥ 4096 at 2.048 Msps.

**Ordering and client rules.** A `spectrum` subscriber gets the current state on subscribe (ack, then one snapshot per source of the current epoch, then live frames). The snapshot is not a replay of missed messages. With `backfillMs` the ack is followed by up to 64 `backfill: true` frames (oldest first, at most 512 KiB of message JSON) before the snapshot; a backfill frame has no `snapshot`, its `at` is the arrival of its newest block, and the snapshot's block is not replayed. Backfill covers only the current epoch, so it never spans a retune. A snapshot frame has `snapshot: true` and is the latest block of the current epoch at the client's profile (none while a retune settles). Reset the waterfall on every `spectrum:profile`, except that an `outcome: "removed"` notice with `selection: "default"` drops only `removedSourceId`'s waterfall. Compare epochs for equality only; they restart with the engine. Spectrum messages bypass the scanner limiter and do not count toward `ws.maxMessagesPerSecond`.

Engines run while a job or a `spectrum` client needs them, also with `scanner.enabled: false`. `tuningTrust` on frames: `unverified` frames have an untrusted frequency axis (grey it out). Status warnings (`GET /api/spectrum` `sources[].warnings`): `untracked-retune` (the scene moved without a command the core saw; the shift is reported when it can be estimated) and `host-centre-mismatch` (the receiver reports another centre than the core's caps). `GET /api/spectrum/occupancy` returns hourly duty per 12.5 kHz bucket for the last 7 days.

**Stable tracks.** A frame track the tracker associated with an open track also carries `trackId`, `snrDb` (lifetime mean), `peakDbfs` (lifetime max), `blocks`, `ageMs` (first seen ≈ `at` − `ageMs`), `surfaced` (recomputed every block, not sticky), `flags.spur` and, when the scanner has a discovery for it, `scanner: {discoveryId, protocol, confidence}`. Key tracks by `sourceId` and `trackId`; the id survives the tracker's 120 s rollover. A track grows by at most 260 bytes of JSON. See [API.md](API.md#spectrumframe).

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
- **Passive disabled on a slow host**: `engines[].passive.disabledReason` names the cost: `engine-cpu` (the whole engine, passive alone or saturated) or `passive-cpu` (what passive adds to a shared engine). When a waterfall or another job shares the engine, the guard judges only what passive adds over a baseline it measures with passive briefly off (`measuring baseline`: a one-minute pause, at most once per 30 min, not a fault); a shared engine at 95 % of a core or more turns passive off whatever the baseline. Raise `scanner.passive.maxEngineUtilization` in the config if the host can afford it; a shared engine retries passive every 15 min.
- **No probes start**: probes wait for the CPU budget (`cpuBudgetCores`), the CPU guard (`cpuGuardPercent`, see `cpuGuard.percent`) and `maxProbes.offset`; compare `budgets` in `GET /api/scanner`. Discoveries that never got a probe report `undecodedReason: "budget"`. Passive jobs get no offset probes unless `passive.offsetProbes` is on.
- **`disk: "disk-low"`**: free disk is below `storage.minFreeDiskMb`; recordings, evidence and captures stop until space returns.
- **503 `SCANNER_STATE_UNAVAILABLE`**: the scanner could not read its jobs or settings at boot. It runs without them (in-window jobs and the spectrum feed still work) and never overwrites the unread files; fix the files under `storage.dir` and restart.

## Channel-gated discovery and replay

A fitting one-hop sweep parks after settling: it stays tuned and keeps the epoch
and track ids. Sweeps are counted from received samples covering the dwell,
not elapsed wall time; `sweepPeriodMs` is null while parked. Resuming at the same
verified centre, rate and gain skips the tuner write. Multi-hop revisits that
choose the same centre likewise avoid an unnecessary retune.

The channel-matched gate integrates power and floor across the channel width
(from occupied bandwidth, raster, or the default), rather than judging one bin.
Its threshold `kCh` adapts to false alarms per range: runs ending without a pass
count toward adaptation. That adaptation persists across epochs, while slot runs
reset. Defaults require 300 ms at 6 dB channel SNR, or 100 ms at 9 dB for bursts.
Only passed tracks create discoveries, with one exception: an accepted identity
decode places a short burst even before its gate passes (for example AIS, VDL2
or LoRa), retaining the original observation close.

Labels now come only from evidence. Spectral classes and band priors order trials;
they do not name protocols. Show `proof.summary`, with these forms:

- `DMR decoded (CC1, TG 9)`; decoded identities, talkgroup and encryption are
  included when present.
- `Analog FM voice, CTCSS 88.5` or `Analog FM voice, DCS 023N` (`I` for inverted);
  without voice, omit `voice`; AM uses `Analog AM`.
- `Analog FM voice` or `Analog AM voice` without a tone.
- `Digital, not decoded (tried DMR, dPMR, NXDN)`; unavailable programs are named,
  for example `Digital, not decoded (tried dPMR; dsd-fme unavailable)`.
  With none tried: `Digital, not decoded (no decoder available)`.
- `Carrier only`.

Proofs belong to individual transmissions. A discovery selects its strongest
proof, newest on ties: decoded, analog tone, analog voice, digital undecoded,
carrier only. Summaries are at most 160 characters, abbreviating long trial lists
with `+<n> more`. `evidence=proven` lists proofs; `weak` lists unproven activity;
`all` is the default. Trial, analog and unavailable evidence is in memory only.
After restart, only persisted decode evidence rebuilds proofs; other discoveries
read `weak` until new evidence arrives.

A weak discovery (no proof) reads `unknown` / `activity`, whatever an older
guess stored on the record said; the stored fields are kept. It may carry a
display-only `hint`: `lora` (a short 100 to 150 kHz burst inside an EU LoRa
slot), `ism-device` (a short or OOK burst up to 25 kHz wide in an ISM band; try
rtl_433), `analog-voice` (a longer signal within 3 kHz of the LPD433 25 kHz
raster, 433.075 to 434.775 MHz), otherwise its spectral class. A hint is never
a protocol label. Band-plan priors come from the narrowest covering range that
lists protocols. Inside the EU `ism-433` band the scanner also treats
433.075–434.775 MHz (LPD433, 25 kHz channels, analog FM and ISM) as a narrower
range for trial order and hints, so there analog FM is tried before DMR; it is
not a separate band-plan entry.

Capture starts at gate pass. Scans replay captured IQ before taking a live hold.
Every planned trial is recorded as `pending` first, so skipped or unavailable
work remains visible. A known protocol runs first; otherwise one analog trial
precedes digital probes. Qualified CTCSS or DCS produces `decoded`; voice without
a tone is `heard`. FM requires at least 8 dB discriminator quieting in at least
half the frames; AM requires at least 6 dB quieting. Data clustering is checked
before voice. Outcomes also include `data-like`, `carrier-only` and `no-sync`.
An analog decode or heard voice ends that capture's remaining digital replay;
data-like and carrier-only outcomes still allow digital trials. GMSK can currently
read carrier-only; real-corpus calibration remains open.

Replay and identify share one analog admission slot and the probe pool's core
budget, reserving 0.05 core per analog trial. Measured analyze cost was 14–22 ms
per capture, with 21–33 ms for the sliced tone pass and about 2 ms event-loop p99:
about 0.03 core total in that benchmark. This is not a live-host
capacity guarantee; a Rust tone pass remains a follow-up.

“Decode here” uses `waitUntilSignal: true` with optional `waitMs` (default five
minutes, at most ten). A gate-passed transmission already on air qualifies;
an older nearest track cannot hide a newer eligible one. The trial timeout starts
at the transmission start. No signal ends honestly with `ended: "no-signal"`.
Progress reports settling, holding, trialing, replaying, capturing or watching,
with the current hold/trial and replay queue depth; see [API details](API.md#scanner-evidence-and-activity).
Capture is on by default, and runs only in protected
access mode (`scanner.iqCapture.allowLegacy` is reserved for legacy mode later).

## Identification from running decoders

Configured, running decoders identify scanner discoveries without starting a
probe: readsb (ADS-B), acarsdec (ACARS), dumpvdl2 (VDL2), AIS-catcher (AIS),
rtl_433 (ISM), direwolf and multimon-ng AFSK1200 (APRS), multimon-ng
(POCSAG/FLEX), dsd-fme (digital voice), and Meshtastic LoRa. Their output must
come from the discovery's source with commanded or relay tuning trust. ACARS,
VDL2 and LoRa output with a missing or zero frequency uses the actual channel
placement (tuner centre plus channelizer offset), or the single configured target
when unplaced. Multiple configured targets without a decoder frequency give no
placement; a configured target is never a band default. Ambient evidence from
every decoder also needs trusted tuning: it stops after an external SDR++ retune
until the tuning is trusted again.
Malformed or out-of-channel frequencies prove nothing.

An ambient identity needs two checksum-valid decodes at least two seconds apart
and no more than five minutes apart (ADS-B is the exception: two CRC-valid Mode S
frames confirm with no minimum spacing; aircraft records need advancing message
evidence 2 s to 5 min apart). When the DTO includes content, their logical
message identities must also differ. Reception level, noise, RSSI/SNR, errors,
frequency, channel and timestamps never create a new message. ACARS uses aircraft
registration/flight plus the three-character message number (acarsdec's trailing
block letter is removed; dumpvdl2 already separates `msg_num` and `msg_num_seq`),
so different blocks of one message count
once (without a message number, aircraft, label and text are used). VDL2 uses source
and destination addresses plus embedded ACARS identity, or raw message text;
non-ACARS frames without text use spacing alone. rtl_433 uses model/device ID and
decoded sensor fields; AIS uses vessel content; Meshtastic uses packet ID and
payload; paging with message content uses protocol, capcode, function and text;
empty or tone-only pages use spacing alone. Direwolf APRS uses source, destination
and the information field, excluding digipeater paths and other routing fields.
DSD uses protocol and
link fields (colour/access code, talkgroup, source, slot or callsign). Repeated
identical content does not confirm. Address-only APRS output from multimon and
other DTOs without content use spacing alone. ADS-B retains
its local CRC/address checks and raw-frame duplicate rejection for Beast output.
For SBS output, the adapter emits one aircraft record per `MSG` line: `messageCount: 1`
is a per-line count, not a single-message aircraft snapshot. Confirmation relies on
readsb's own decoding and two independent messages of the same six-digit ICAO,
at least 2 s and at most 5 min apart in readsb's own time, with different full-line
content identities. The adapter carries the generated date/time (SBS fields 7–8),
or logged date/time (9–10) only when both generated fields are absent. Calendar and
clock values are validated; missing or malformed source time cannot confirm.
SBS has no timezone; the adapter normalizes its wall clock to UTC for intervals.
Receipt time and receipt delays never advance SBS confirmation. JSON records carry
`readsbFormat: "json"`; they need a cumulative count greater than one and a later
increasing count, with the same spacing measured in source time (`jsonSourceTimestamp`, derived from numeric
`now` epoch seconds minus nonnegative `seen` age). JSON snapshots without valid
source epoch/age cannot confirm. State is bounded to
4096 addresses per decoder/source epoch.
SBS/JSON inherit readsb's message validation policy. We could not verify offline
the CRC-correction/address-confirmation policy of the pinned readsb build
(`b499ecbd18dc4a2ec6098c31de31508017fa6190`); these records do not prove an
uncorrected CRC or independent address confirmation. The two-message guard above
does not establish those upstream guarantees.
Only configured local decoders with trusted receiver tuning count. For raw readsb
placements without a channel or configured frequencies, its protocol declaration
supplies the 1090 MHz target; the provenance index still requires an observed source
centre/rate covering that target (within 0.45 × sample rate), unchanged since decoder
start. Unknown or merely configured tuning and external-input decoders fail closed. Accepted ambient
identities reset known-protocol misses and record successful trial memory;
untrusted evidence does neither. Edge tracks use these same strict checks.

Point association requires the decode frequency inside the track's occupied
span, widened by a 2.5 kHz placement tolerance: reach = max(1.5 kHz, occupied
bandwidth / 2) + 2.5 kHz, with an exclusive boundary. The tolerance budgets
1 kHz decoder/raster agreement plus 1.5 kHz measured-centre error; 2.5 kHz is
less than half the tightest 12.5 kHz raster (6.25 kHz). Even with the minimum
half-span, reach extends at most 4 kHz beyond the measured half-width. This applies to paging,
APRS, digital voice, 25 kHz AIS/ACARS/VDL2 and wide LoRa alike: channel width
alone cannot attach a decode to a narrow neighbouring signal. A merged wide
track can contain several channels. ADS-B retains its separate nominal-frequency
centre tolerance of 500 kHz, inclusive.
The observation lifetime must include the decode time, with two seconds of
pairing margin on either side.

rtl_433 uses its placed channel or capture span. A usable JSON frequency
estimate narrows matches to 60 kHz plus half the track's occupied bandwidth.
Near the capture edge the estimate is unreliable, so the whole detection span
is used. Activity rows also retain the estimate in Hz: JSON `freq` is MHz,
or `(freq1 + freq2) / 2` for FSK. Values must be finite numbers in the
usable tuner window (centre ± 0.8 × sample rate / 2); malformed or out-of-window
values fall back to the placed target.

When reaching candidates belong to different discoveries, a channel fragment
nested inside every other reaching track span takes precedence. Thus a merged
wide track covering two ACARS channels yields to each channel's own fragment;
without that fragment it receives the decode itself. A fragment on the other
channel does not reach the decode unless its measured occupied span already
covers it. ADS-B instead keeps nearest-wins: the
nearest reaching track is named, and tracks of different discoveries tied
within 1 Hz of that distance receive nothing. Other point multi-discovery
cases receive no decode. Point ambiguity is logged at most once
per decode, after interpretation; shared-confirmation lookups do not log.
Multiple observations of one discovery can receive point evidence. rtl_433
requires exactly one qualifying observation. Ambiguous evidence cannot prime
shared confirmation.

Ambient observation lookups use a per-source sorted frequency index:
O(log n + k) per decode for n indexed observations and k candidates in the
queried frequency span, followed by O(k) time/source/ambiguity checks.
Track insertion, movement and removal update the index; sorted-array updates
can cost O(n). Closed observations remain indexed through the pairing
retention period, and merges use their current discovery IDs.

### Digital voice identity checks

A dsd-fme sync alone is a protocol hint. DMR VC\*/VC1–VC6, IDLE,
unlabelled bursts and R12U never confirm a color-code identity, even when
hundreds of bursts repeat it. They appear as DMR-like digital sync, not decoded,
and remain weak evidence. The most frequent sync-only color code may appear in
the summary as `CC 3 (unverified)`; it is never a `dmr-cc` identity.

DMR needs two matching content-verified occurrences: a clean PI, VLC, TLC,
CSBK, MBCH, DATA or USBD burst, or checked voice link control carrying
both target and source. Voice link control uses the latest CC from its own BS
slot, or from the single MS channel, in its current burst sequence. Unknown CC,
sync loss, protocol changes and sequence timeout clear that association. Header and voice-LC
verification waits until the next DMR sync closes the burst (normally one burst
of latency); a non-DMR sync or any continuation CRC/FEC error rejects it.
Stop or silence timeout flushes unfinished headers and voice LC as unverified,
without TG/SRC evidence. A Key-line error also rejects the burst: voice LC can
print before a Key line and the later burst CRC result (`dmr_flco.c:403,778`,
`dmr_dburst.c:627`). Call start/end and talkgroup display still process LC
immediately. CRC/FEC
errors and `-RAS` output do not count. MBCC continuation bursts have no own
CRC and never confirm CC (dsd-fme ed1d1d6 `dmr_dburst.c:115–119,627`);
only the completed block is CRC-checked by `dmr_block.c`. MS prints CC before
slot-type decoding (`dmr_ms.c:676–686`), so header confirmation also requires
the closing DMR sync to print the same CC. Voice LC never borrows a CC from
a still-pending MS header; its checked TG/SRC remain usable with CC unknown.
`Sync: no sync` discards pending
headers, voice LC and CC context but does not split an active call by itself.
Checked voice LC with paired TG/SRC but no known slot CC remains weak
`digital-undecoded` evidence, with summary `DMR voice, TG/SRC verified, CC unknown`
and a `DMR` tag. It cannot become decoded/proven without a CC identity.
Later sync-only hints cannot replace this checked TG/SRC result; newer checked
TG/SRC evidence may replace it.
The interpreter retains at most 256 scoped TG/SRC voice-LC pairs, evicting oldest.
CACH/burst FEC errors
produce no evidence. Near the tuner centre, within the existing DC admission
guard, digital voice additionally needs paired checked voice link control with
both talkgroup and source before it can be decoded.

The same conservative rule applies to other dsd-fme protocols: P25 NAC and NAC/CC
remain unverified even beside a recognized frame type. In dsd-fme,
`dsd_frame.c:34–36` prints cached state, and `390–396` updates NAC/CC only
when BCH corrects the NAC. No supported output binds the printed NAC to the
current checked NID, so P25 identity stays unverified. NXDN accepts current RAN
on CRC-checked
FACCH2/UDCH output, including the exact ` RAN 03  FACCH2` spacing
(ed1d1d6 `nxdn_deperm.c:1390–1437`). CRC failure prints eight spaces instead
of RAN, so it supplies no identity. SACCH/CAC print cached RAN
(`nxdn_deperm.c:466,564,762`) and remain unverified. YSF FICH sync, unchecked
D-STAR MY headers and dPMR's cached channel code do not establish identities.
Unknown output formats default to unverified.

Persisted dsd-fme evidence requires explicit `contentVerified: true` provenance
in snapshots and journal replay before a restored identity can be decoded/proven. Legacy rows without it retain
only digital sync evidence and an unverified DMR color-code hint. Historical
stored discovery identities remain association history so restarting cannot join
previously separate families; they are not decode proof. Published identities and
saved call metadata require checked content: either the discovery’s persisted
verification flag or a retained checked decode proving its current protocol and
identity, including co-channel observations. Observation evidence sets the flag
so verification survives retention. A verified merge survivor adopts another record’s
identity only when that record has checked content for its identity. Merges preserve checked metadata and discard
unchecked call metadata and encryption flags before transferring provenance; identity, search and
encryption filters match the published values. Stored discoveries retain an internal
`contentVerified` flag for checked evidence whose observation was never retained or
has since been trimmed; this flag alone grants no decoded/proven observation proof.
Live evidence and restored evidence use the same normalization, so new snapshots
and journal replay reproduce the live store exactly. Replay uses the
original source epoch's tuner centre retained by the scanner, rather than the
narrow capture's channel centre. The capture index stores source and epoch but
not tuner centre; if that epoch's centre is no longer known (including bounded
history eviction), the DC guard conservatively requires checked voice LC.
