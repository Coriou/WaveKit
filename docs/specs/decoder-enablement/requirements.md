# Decoder enablement requirements (WG13)

Status: reviewed design, not implemented (2026-10-20). See [design](design.md) and
[tasks](tasks.md).

## What changes for the user

- **Every decoder the image ships is there without YAML.** ADS-B (readsb), AIS (AIS-catcher),
  ACARS (acarsdec), VDL2 (dumpvdl2), ISM sensors (rtl_433), pagers (multimon-ng), APRS
  (direwolf), digital voice (dsd-fme) and Meshtastic LoRa each appear once in the decoder list
  and in the settings view. A decoder you define in YAML replaces the built-in one of its type.
- **Each decoder has one switch with three positions.** `auto` (the default) runs it while its
  band is inside the tuner's current window and pauses it when you tune away. `always` keeps it
  running wherever you tune (it still pauses when the sample rate cannot work). `off` never runs
  it. The switch takes effect at once and survives a restart.
- **Decoders listen off-centre.** A running decoder hears its own channel anywhere in the window,
  not only at the tuned centre: AIS at 162 MHz keeps decoding when you tune to 161.5 MHz. This
  uses the core's channelizer, which turns itself on for these decoders once its capacity
  acceptance has passed on a desktop and on a Pi 4-class host.
- **Voice and pager decoders follow what you listen to.** dsd-fme and multimon-ng decode the
  frequency you are tuned to in Listen (your VFO) and any channels you configured or put in a
  band plan, at the same time, whether or not anyone is listening.
- **Tuning to 1090 MHz switches the radio to 2.4 Msps** so ADS-B decodes, and puts the previous
  rate back when you tune away. When the receiver is on a network link that has never carried
  that much (for example a Wi-Fi receiver host), you get a warning; if samples then go missing,
  the warning says so. A radio driven by SDR++ through the relay is never changed behind its
  back: you get the advice instead.
- **No decoder is started if it would make others drop samples.** Decoders are admitted in a
  fixed order (`always` first, then your configuration order) within a CPU budget, while the
  host CPU is below 90 % and no stream is dropping data. A decoder that does not fit is shown as
  paused with the reason "efficiency budget"; it is never crash-looped, never hidden and never
  pushes out a decoder that is already running.
- **WaveKit never moves your radio on its own.** There is no automatic band rotation; scanning
  between bands happens only in a scan job you start. The 1090 MHz rate switch is the one
  automatic radio write, and only after you tuned there yourself.
- **Identify works on any signal anywhere.** Band plans only change the order in which identify
  tries decoders; only a protocol list you typed yourself limits what is tried.
- **One dongle today, more later.** Everything works on one local USB dongle or one network
  receiver. The rules for several dongles are specified and tested with simulated sources; a
  decoder then runs on whichever radio covers its band.

## Scope

The WG13 decoder enablement batch: the end goal of all decoders running at once on one receiver,
gated on drop-free efficiency, built on the existing band suspension
([decoder band defaults](../../superpowers/specs/2026-10-09-decoder-band-defaults-and-override.md)),
the rate model ([rate model addendum](../../superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md)),
the decoder settings store ([web-gaps-8](../web-gaps-8/requirements.md) requirement 1) and the
core channelizer (`native/wavekit-chan`, `src/core/channelizer/`). A local USB dongle is the
reference setup; a Wi-Fi-linked receiver host is an optional layer (advice and measured link
facts only).

Out of scope: automatic band time-sharing of any kind; a general rate policy (the 1090 MHz
raise is the user's single named exception; the sample-rate design's rule "never lowers a
radio's rate automatically to cure loss" stands); LoRa on a channelizer channel (LoRa keeps its
centre path); new frequency data (band defaults, band plans and adapter defaults are used as
they are); the web UI and CLI beyond guard widening; editing `src/core/scanner/**` (owned by the
concurrent identify work; the scanner-side items of section 9 are dependent follow-ups);
`src/decoders/band-defaults.ts`, `src/decoders/band-region.ts`,
`src/core/scanner/bandplan/index.ts` and `src/core/scanner/bandplan/builtin.ts` stay
byte-identical (band-plans requirement 1.1); a second physical dongle in acceptance.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access. Tests use fake decoders and child processes, fake sources and a
fake rtl_tcp server on an ephemeral 127.0.0.1 port, fake channelizer transports, temporary
directories and injected clocks. Only Main runs the live acceptance steps.

**Defaults.** With the shipped config (`decoders: []`) and no new key set, every route, frame,
argv, log line and receiver write is byte-identical to the WG13 base except these deliberate
changes:

- 1.1: nine built-in decoder instances exist (ids equal to their type names): `GET /api/decoders`,
  `decoder:created` at boot, the settings views and the decoder logs list them.
- 3.x, 5.2: the built-in decoders that support channels read channelizer channels, and the
  channelizer starts for a source when one of them needs a channel there. The capacity
  acceptance (5.4) is recorded for x86-64 hosts
  ([capacity record](../../engineering/CAPACITY-2026-10-21-DECODER-ENABLEMENT.md)): there the
  channelizer starts only when a built-in channel placement needs it and stops after
  `CHANNELIZER_IDLE_STOP_MS` without a channel. On arm64 hosts, until a Pi 4-class host is
  measured, these decoders report `channelizer-unavailable` instead of running. readsb and
  lora-meshtastic run on their raw branch as today's YAML decoders do. A built-in decoder with
  no placement and no connected source waits (`source-rate-unknown`) instead of starting.
- An installed catalogue dsd-fme brings up the digital-voice service as a YAML dsd-fme does.
  When its binary is unavailable, no digital-voice socket or server is started.
  Availability is decided at boot: a dsd-fme installed while the core runs decodes after an
  operator start, but its digital-voice audio output needs a core restart.
- 4.x: every built-in (catalogue) decoder is admitted through the efficiency gate; the
  suspension reason union gains `efficiency-budget` and `decoder-unavailable`.
- 6.1: an operator retune (REST) that puts 1090 MHz inside readsb's reach while readsb is not
  `off` writes 2.4 Msps first when the rate is lower; retuning away restores the previous rate.
  The tuner command origin union gains `decoder-rate`; the `tuner` channel gains
  `tuner:rate-policy`.
- 7.x: a raise on a network source may emit a `link-capacity` resource alert; the resource alert
  type union gains `link-capacity`.
- 11.x: the new optional DTO fields of section 11 are sent.

Configurations that already define decoders in YAML see these further changes: an entry of a
catalogue type gains VFO and band-plan channels (3.4, 3.5) only when it sets `useChannelizer:
true` (the schema default is `false`, so absence and an explicit `false` both keep today's single
raw placement); the efficiency gate (4.x) does not admit, block or suspend YAML decoders, whatever
mode an operator sets for them in settings: they start and run as today, while their declared cost
is counted in the budget catalogue decoders are admitted against and they are listed in the
efficiency view as admitted with detail `configured` (4.9); `band.bandSuspension: false` reads as `mode: always`
and `enabled: false` as `mode: off` (2.3), with unchanged behaviour. A YAML decoder that reads the
raw branch today keeps reading it when the channelizer is unavailable (5.3).

Every hot-path item states its CPU budget and arithmetic in the design; every new bound has a
test at the bound and one past it. Background: the live acceptance of 2026-10-20 decoded POCSAG
and identified DMR on one receiver but ran almost no decoder continuously; the ROADMAP's first
open item asks for every shipped decoder in a supported default setup, gated on drop-free fanout,
with ADS-B needing 1090 MHz at 2.4 Msps.

## 1. Built-in decoder catalogue

As an operator I want every decoder the image ships to exist without writing YAML, so that
enabling one is a switch, not a configuration task.

1.1 At startup the core creates one implicit instance of each continuous type in catalogue
order: `readsb`, `ais-catcher`, `acarsdec`, `dumpvdl2`, `rtl433`, `direwolf`, `multimon-ng`,
`dsd-fme`, `lora-meshtastic`. The instance id equals the type name; its options are the
adapter's defaults plus the catalogue's frozen defaults (design, catalogue table).
1.2 A YAML entry wins: no implicit instance is created for a type when any YAML decoder has that
type, or when a YAML decoder's id equals the catalogue id (the YAML entry is then the only
instance with that id, whatever its type).
1.3 Implicit instances are configuration-owned in every respect (`owner: "config"`): they appear
in `GET /api/decoders`, the settings views (`GET /api/decoders/:id/settings`), `decoder:status`,
`decoder:created`, `/types`, `/log`, start, stop and restart, scanner holds and the scanner
sweep impact lists. Their status carries `origin: "catalogue"`.
1.4 The config export (`GET /api/config/export`) is unchanged: implicit instances are derived,
never written into the exported configuration.
1.5 `decoderPolicy.catalogue: false` creates no implicit instance (today's behaviour).
1.6 An implicit instance whose binary does not resolve at startup is listed, never spawned, and
reported suspended with reason `decoder-unavailable`; it is re-checked on an operator start and
on the next startup. A YAML decoder keeps today's spawn-error reporting. The scanner's own
unavailable memo is unchanged.
1.7 Every catalogue default configuration validates against its type's option schema with no
option issue (WG6 `optionIssues` empty).

## 2. Mode: auto, always, off

As an operator I want one per-decoder switch that says whether a decoder follows the band, runs
everywhere, or never runs, and I want it to apply now and stay applied.

2.1 Each configuration-owned decoder has a mode `auto | always | off`:
`auto` runs it while a placement (section 3) exists for it, and band-suspends it otherwise;
`always` is a durable band pin (the band check never suspends it; rate suspension, scanner holds,
health, crash-loop and `faulted` handling apply unchanged); `off` never runs it
(`desiredRunning` false).
2.2 Precedence: settings-store `mode` > settings-store `enabled` (false is `off`) > YAML `mode` >
YAML `enabled: false` (`off`) > YAML `band.bandSuspension: false` or an API band override with
`bandSuspension: false` (`always`) > `auto`.
2.3 The legacy fields keep working and keep their meaning: YAML `enabled`, `band.bandSuspension`,
the API band override and the REST start pin (`startMode: "operator"`, which still lasts until
the next stop). No field is removed or renamed.
2.4 The settings store entry gains an optional `mode`; the PATCH body gains
`mode?: "auto" | "always" | "off" | null` (null removes the override); the settings view gains
`mode: { value, source }`. Revision, `If-Match`, bounds and the protected-mode rule of web-gaps-8
section 2 are unchanged; YAML `mode` is the legacy-access-mode way to set it.
2.5 A mode change applies immediately, not at restart: `off` stops the decoder (as a REST stop);
leaving `off` starts it with `startMode: "auto"`; `auto` and `always` swap through the serial caps
worker re-evaluation of the band spec section 5.4. The PATCH answers `pendingRestart` only for
option changes, as today. Web-gaps-8 requirement 1.5 (`enabled` is boot-only) stays true for
`enabled`.
2.6 A REST stop of an `auto` or `always` decoder stops it until a start, a mode change or the next
startup; it does not change the stored mode.

## 3. Placement: where a decoder listens

As an operator I want a running decoder to hear its own channel anywhere in the window, and the
voice and pager decoders to follow what I am listening to.

3.1 A placement is one (decoder, source, channel) the decoder can decode now. The core computes
placements from the source windows, the decoder's band, its configured channels, the VFO and
the band-plan channels, and runs one decoder process per placement.
3.2 Reach decides whether a channel is decodable on a source:
`channel` reach (a channelizer channel at frequency `f`) fits when
`|f − c| + bandwidthHz/2 + transitionHz ≤ fs × usableFraction / 2`;
`raw` reach for readsb fits when `|1 090 MHz − c| ≤ READSB_REACH_HZ` (200 kHz);
`centre` reach for lora-meshtastic fits when its region slot lies inside its decimated passband
around the centre. Types that declare channel support use `channel` reach; readsb uses `raw`;
lora-meshtastic uses `centre`.
3.3 Channels per type: `ais-catcher` one 384 kHz channel at 162.000 MHz; `dumpvdl2` one channel
spanning its frequencies (adapter rule); `acarsdec` one channel per configured frequency
(adapter default 131.550 and 131.725 MHz); `rtl433` one channel per band-default range part
inside the window, centred on that part; `direwolf` one channel per band-default target in the
window; `dsd-fme` and `multimon-ng` per 3.4 to 3.6.
3.4 dsd-fme and multimon-ng decode, at once: (a) configured channels (`channelsHz`, `channelHz`
or `offsetHz` relative to the centre); (b) band-plan channels: `Band.channels` of the resolved
band-plan stack inside the window whose frequency lies in a scanner plan range listing one of
the decoder's protocols (dsd-fme: `dmr`, `p25p1`, `p25p2`, `ysf`, `dstar`, `nxdn48`, `nxdn96`,
`dpmr`; multimon-ng: `pocsag`, `flex`); (c) the VFO (3.5). Band-plan channels are capped at
`DECODER_MAX_BANDPLAN_CHANNELS` (4) per decoder per source, nearest the centre first.
3.5 The VFO is the live-audio channel (`liveDemod` source, centre + `offsetHz`), whether or not a
listener is connected. It is one extra channel for dsd-fme when it lies in dsd-fme's band
ranges, and for multimon-ng when it lies in a scanner plan range listing `pocsag` or `flex`. A
VFO change re-targets the channel after `VFO_SETTLE_MS` (1 000 ms) without changing the radio;
the decoder process is not restarted when the per-source engine can retune a channel in place
(5.5).
3.6 Identify covers every other signal; there is no continuous decoder per raster channel.
3.7 Placements are ordered per decoder: configured channels (configuration order), band targets
and ranges (ascending frequency), the VFO, band-plan channels (nearest the centre first). The
first placement is the decoder's primary: its process carries the decoder's `pid`, log, health
and `sourceId` exactly as today; further placements are internal processes reported in
`placements[]`, never as separate decoders.
3.8 Outputs of every placement carry the decoder's id and their placement frequency in the RF
provenance; Activity, trackers and receptions see one decoder.
3.9 An `always` decoder with no in-window placement runs one fallback placement: the VFO channel
for dsd-fme and multimon-ng, the centre channel for other channel types, the raw or centre path
for readsb and lora-meshtastic. Exception (3.20): catalogue acarsdec has no fallback.
3.10 Band-plan reads now select decoder channels: band-plans requirement 1.2 is amended so that a
band-plan read may add or remove a dsd-fme or multimon-ng placement; it still never tunes,
starts or stops audio, scan jobs or any other decoder.

## 4. Efficiency gate

As an operator I want as many decoders as the host can carry without any stream losing samples,
and I want to see which ones did not fit and why.

4.1 Every placement of a built-in (catalogue) decoder is admitted through one gate per core with
three terms, all required: (a) the declared cost of the running placements plus the newcomer is
at most `cpuBudgetCores`; (b) the normalised host CPU (the meter the scanner's CPU guard reads) is
at most `cpuGuardPercent` (90); (c) no fanout branch on the newcomer's source, including the
channelizer's input branch, dropped a byte in the last `EFFICIENCY_DROP_WINDOW_MS` (10 s), and
none for `EFFICIENCY_CLEAR_MS` (60 s) after the last drop.

**Amendment ([link-burst-resilience](../link-burst-resilience/requirements.md) 4.4, 4.5):** "dropped a byte" and "the last drop" exclude drops attributed `link`.

4.2 Admission order: operator-pinned, then `always`, then `auto`; within a class, YAML order,
then catalogue order; within a decoder, placement order (3.7).
4.3 A newcomer never evicts a running placement (except gated secondaries, 3.21). A placement that does not fit is suspended with
reason `efficiency-budget` and a detail (`budget`, `cpu`, `drops` or `unknown`), retried in order
whenever capacity frees and at least every `EFFICIENCY_RETRY_MS` (5 min, doubling to 30 min after
probation failures). `unknown` is no rejection and takes no backoff: the placement is re-evaluated
when its source earns the clear window (`EFFICIENCY_CLEAR_MS` after its clean run began).
4.4 Probation: for `EFFICIENCY_PROBATION_MS` (30 s) after admission a placement is on probation;
when drops (4.1 c) or CPU above the limit appear on its source during probation, the newest
probationer is suspended with `efficiency-budget` (`drops` or `cpu`). Only positive drop counts
observed after its admission count: unknown evidence never suspends a probationer. Probation is
earned: it ends only after `EFFICIENCY_PROBATION_MS` of credited evidence since admission. An
interval is credited only between two complete reads (every branch valid) on consecutive samples
at most 1.5 sample periods apart; unreadable or incomplete reads break the chain. Drops are judged
before graduation, up to and including the sample that completes the coverage: a placement with a
drop in that window never graduates. A clock discontinuity (time not strictly increasing)
discards all coverage, so every placement still on probation restarts from zero; drops already
seen still count. The view keeps showing the placement on probation until it graduates. Drops or CPU with no
probationer suspend nothing: they close the gate for newcomers, log one warning per minute and
show in the efficiency view.

**Amendment ([link-burst-resilience](../link-burst-resilience/requirements.md) 4.1, 4.2, 5):** probation is judged on drops attributed `consumer`, `host` or `unknown`; a `link` interval neither condemns nor credits. The sentence "Drops or CPU with no probationer suspend nothing" becomes: "Drops or CPU with no probationer close the gate for newcomers, log one warning per minute and show in the efficiency view; sustained `consumer` or `host` drops shed the newest eligible graduated placement (link-burst-resilience 5)."

4.5 Declared costs are per (type, reach) in reference cores with their basis (`measurement` or
`estimate`), plus the channelizer's per-source base and per-channel cost (design, cost table).
`cpuBudgetCores` defaults to 1.5 on x86-64 hosts and 0.75 on arm64 hosts with at most 4 cores.
4.6 Safe on unknown: unreadable, decreasing or reset fanout counters and removed branches close
the gate for that source (`unknown`). Drop evidence is per branch: a branch valid in two reads
whose counters did not decrease contributes its positive delta even across unreadable reads and
other branches' changes; a branch added since the last read (such as the channelizer's input
branch) is counted from zero and is no fault; a decrease or removal loses that branch only and
never erases drops seen on any branch. While unknown, the view
reports `drops: "unknown"`, never `ok`; a missing CPU reading leaves the decision to the
budget and drop terms and is reported as `cpu.percent: null`, never as a low value.
4.7 `GET /api/decoders/efficiency` returns the gate view per source: budget, cores in use,
CPU percent and limit, drop state and rate, and the ordered admitted and blocked placements.
4.8 The gate never retunes, changes a rate, or stops a decoder the operator started outside of
probation.
4.9 YAML decoders (origin `config`) are outside the gate whatever their mode: their placements
are admitted without a verdict and are never on probation, so drops, CPU or budget never block or
suspend them. Their declared cost still counts in 4.1 (a) for catalogue newcomers, and the view
lists them as admitted with `probation: false` and detail `configured`.

## 5. Channelizer routing and capacity gate

As an operator I want decoders to share one read of the IQ stream, and I want that turned on only
after it was proven not to drop samples.

5.1 Catalogue decoders of a channel-capable type (`ais-catcher`, `acarsdec`, `dumpvdl2`, `rtl433`,
`direwolf`, `dsd-fme`, `multimon-ng`) read channelizer channels; they never add a full-rate raw
branch (PERFORMANCE rule 6).
5.2 The channelizer starts for a source when a placement there needs a channel and
`channelizer.auto` is not false and `channelizerAutoAccepted(arch)` is true for the host
architecture (5.4); `channelizer.enabled:
true` keeps today's behaviour. The channelizer stops for a source when no decoder or scanner
channel remains there for 60 s.
5.3 Without a channelizer (binary missing, `channelizer.auto: false`, not yet accepted, or the
process unavailable) catalogue channel decoders are suspended with `channelizer-unavailable`; a
YAML decoder of a channel type keeps reading its raw branch at the centre as today.
5.4 Capacity acceptance (live) precedes accepting automatic composition for a host
architecture (`channelizerAutoAccepted`): at
2.048 and 2.4 Msps, with every placement the default budget admits in design "Worst windows" C
(three channels plus the LoRa raw branch) and A (three channels), every branch including the
channelizer input branch drops 0.00 % of bytes over 10 minutes, on the desktop reference and on
a Pi 4-class core host, unthrottled; and with the budget raised to admit window C+ (seven
channels), either no branch drops or the gate suspends the newest probationer before a second
drop window. Results go in `docs/engineering/` with the commit that changes the acceptance.
Status: accepted for x86-64 at the default budget on 2026-10-21 (windows A and C pass at both
rates; [capacity record](../../engineering/CAPACITY-2026-10-21-DECODER-ENABLEMENT.md)); arm64
stays unaccepted until a Pi 4-class host is measured. The C+ clause is open: drops that begin
after every placement has graduated (0.04 % at 2.048 Msps, 0.07 % at 2.4 Msps with seven
channels) are accepted for now and deferred to a later design for link- and host-burst
attribution; the gate is not changed for them.

**Amendment ([link-burst-resilience](../link-burst-resilience/requirements.md) 3 and 5):** the open C+ clause is resolved by link-burst-resilience 3 and 5: late drops are attributed, and sustained `consumer` or `host` late drops shed.

5.5 The per-source engine gains an in-place channel retune; a VFO change then moves a channel
without closing it or restarting its decoder. Until it lands, a VFO move closes and reopens the
channel and restarts the placement after `VFO_SETTLE_MS`.

## 6. 1090 MHz rate raise

As an operator I want ADS-B to decode when I tune to 1090 MHz, without managing the sample rate,
and my previous rate back when I leave.

6.1 When an accepted REST retune of a source in internal control puts 1 090 MHz inside readsb's
raw reach (3.2), readsb on that source is not `off` and not on its own device (`rtlTcpHost`), and
the source rate is below 2.4 Msps, the core writes 2 400 000 Hz (`READSB_SAMPLE_RATE`) through the
tuner controller before the frequency write, with origin `decoder-rate`, and records the previous
rate for that source.
6.2 When a later accepted REST retune leaves readsb's reach (or readsb becomes `off`) while a raise
is recorded, the core writes the recorded rate before the frequency write and clears the record.
6.3 An explicit operator sample-rate write clears the record (the operator's rate wins; nothing is
restored later). A core restart drops the record.
6.4 No raise when the rate is already 2.4 Msps or above (the rate is never lowered; readsb uses
its existing adaptation), when the source is in external control (a relay client owns the
radio), or for scanner hops, config and replay writes. In external control the core emits the
advice instead (`skipped`, `external-control`).
6.5 Each raise, restore and skip (external control, a rate above 2.4 Msps, a failed write; an
unchanged 2.4 Msps rate emits nothing) emits `tuner:rate-policy` with the source, action, from and to
rates, the skip reason and the link advisory (section 7); the tuner state carries
`ratePolicy?: { raisedFromHz, since }` while a raise is recorded.
6.6 A raise uses the existing rate-change consequences only (caps-change restarts, spectrum epoch
restart, live-audio decimation recompute). A failed rate write leaves the frequency write
unattempted and answers as today's tuner errors.

## 7. Link advisory

As an operator on a Wi-Fi receiver I want to be told when a rate change asks more of the link
than it has carried, without the core guessing what the link is.

7.1 The link advisory of a source is `none` for a loopback source (127.0.0.0/8, `::1`,
`localhost`); for any other network rtl_tcp source it is `unproven` when the new payload
(`fs × 2` bytes/s; 4 800 000 B/s at 2.4 Msps) exceeds the highest 10 s average this connection
delivered without shortfall, or when that is unknown; and `dropping` when, after the change, the
received rate falls short of the payload by more than 1 % over 10 s, or the upstream drop rate
exceeds the existing `upstream-drops` threshold (10 KB/s).
7.2 The advisory rides on `tuner:rate-policy` and, when `unproven` or `dropping`, emits a
`link-capacity` resource alert (`warning` for `unproven`, `critical` for `dropping`). It is
advisory: it never blocks or reverts a raise.
7.3 The advisory carries numbers only (payload, sustained rate or null, shortfall, upstream drop
rate or null); it never echoes host names or untrusted values.

## 8. Several sources

As an operator with more than one radio I want a decoder to run on whichever radio covers its
band, once, without configuring which.

8.1 A decoder with a YAML `sourceId` binds to that source only (today). Any other decoder may be
placed on every source except `dedicated` scanner sources and sources reserved exclusively by
another decoder.
8.2 At most one process per (decoder, source, channel); a channel inside the windows of two
sources runs on exactly one: the decoder's configured source, then the source with the smaller
`|f − c|`, then source configuration order.
8.3 A scanner hold on a source suspends its placements with `tuner-scanning` (today); a channel
also covered by another unheld source moves there at the next evaluation.
8.4 The tuner relay stays single-source; the relay source is placed like any other.
8.5 The build implements and accepts single-source behaviour; the multi-source rules are
implemented in the planner and tested with fake sources only.

## 9. Identify anywhere (dependent follow-ups)

As an operator I want identify to name any signal anywhere, whatever the band plan says.

9.1 Band-plan priors never exclude a trial: a prior is clamped above 0; a protocol list bounds
trials only when the user typed it (the identify request's list or a job range list the user set);
auto-filled and band-plan lists only order trials.
9.2 Identify may open a temporary channelizer probe of an ambient-only protocol (AIS, ACARS,
VDL2, LoRa) on a detected signal anywhere in the window, beside the running ambient decoders.
9.3 Both are scanner-side changes under `src/core/scanner/**`, delivered by the identify work or a
follow-up; this spec only verifies them (task ID-F).

## 10. No automatic time-sharing

10.1 No component of this spec writes a frequency. The only automatic radio write is 6.1/6.2,
and only after an operator retune.
10.2 Band rotation exists only as a scanner job the user starts; no default, mode or catalogue
entry starts one.

## 11. Contract, compatibility and observability

11.1 New DTO fields are optional in `packages/api-types`: `DecoderStatus.mode`, `modeSource`,
`origin`, `placements`, `efficiency`; `DecoderSettingsView.mode`; `DecoderSettingsUpdate.mode`;
`TunerState.ratePolicy`; `DecoderEfficiencyView`; `TunerRatePolicyEventData`; `LinkAdvisory`.
11.2 Widened unions: `DecoderSuspensionReasonCode` (`efficiency-budget`, `decoder-unavailable`),
`TunerCommandOrigin` (`decoder-rate`), `ResourceAlert.type` (`link-capacity`). Fastify response
schemas, the CLI guards and the CLI reason words accept them; Main announces them in
`docs/CLI-COORDINATION.md`.

**Amendment ([link-burst-resilience](../link-burst-resilience/requirements.md)):** `DecoderEfficiencyDetail` gains `late-drops`.

11.3 The decoder's top-level `suspended`/`suspension` reflect the primary placement; when no
placement exists the reason precedence is `tuner-scanning`, rate reasons,
`decoder-unavailable`, `channelizer-unavailable`, `frequency-out-of-band`, `efficiency-budget`.
11.4 Every gate decision, raise, restore and skip logs one info line with fixed fields (decoder
id, source id, reason code, numbers); errors use `safeErrorFields`.

## 12. Acceptance

12.1 Each task in [tasks](tasks.md) names its tests and its live step for Main: on the local USB
dongle, and on the current network receiver (rtl_tcp at 1.024 Msps over Wi-Fi).
12.2 End-to-end live acceptance on the local dongle at 2.4 Msps: ADS-B after a tune to 1090 MHz;
AIS at 161.5 MHz centre; rtl_433 at 433.92 MHz; POCSAG on a configured channel and on the VFO;
DMR on the VFO; every running decoder's branch at 0.00 % drops for 10 minutes; the efficiency view
matches the processes running.

## Configured VFO amendment — 2026-10-22

3.11 Configured narrowband audio decoders (`dsd-fme`, `multimon-ng`, `direwolf`,
`acarsdec`) with no explicit channel, offset or frequency option follow their source's
settled VFO, subject to the existing band and reach rules. Without a VFO they retain
capture-centre decoding. They use the channelizer when available and the existing
shift/decimate path otherwise. Explicit `channelHz`, `channelsHz`, `offsetHz`,
`frequency` or `frequencies` keeps the fixed configuration. AIS, VDL2 and rtl_433
retain their protocol-specific windows. Requirement 4.9 still applies: YAML decoders
are exempt from admission and shedding.

3.12 Status `targetFrequenciesHz` reflects placement channels (including raw VFO
fallbacks), or the source centre for centre reach. Parent status includes its worker
channels. Raw wideband decoders retain declared-frequency semantics. The field stays
optional when no target is known. VFO movement uses the existing settle and caps-work
debounce; channelizer VFO channels retune in place when supported.

## Suspension follows the band amendment — 2026-10-25

Found live: with the receiver at 1.024 Msps, rtl_433 stayed suspended with
`frequency-out-of-band` after a retune into the 433 MHz ISM band, while its own
`bandAssessment` read `in-band`. Two sources disagreed: the band assessment checks the
capture centre against the band, and the planner also needs the decoder's 1 MHz channel to
fit the usable window, which a 1.024 Msps capture (819 kHz usable) never allows. The
planner then reports its generic `frequency-out-of-band`, and the suspension keeps the
`since` of the first, genuine out-of-band suspension, so it reads as stuck since start.

As an operator I want a decoder's suspension to say what is true about the current tune, and
a decoder whose band I tune to to start, at any receiver rate the decoder can use.

3.13 **One verdict.** After every settled caps change (retune, rate change, source reconnect,
core restart), a wanted decoder's suspension is decided from the same caps its band assessment
uses, in the 11.3 precedence: a hold, a rate reason, `decoder-unavailable` or
`channelizer-unavailable` wins first; unknown caps give `source-rate-unknown`. When those pass,
band suspension is enabled and the decoder is `auto` without an operator start, it is
suspended with `frequency-out-of-band` exactly when the band assessment is `out-of-band`; when
`in-band` it is placed and running unless `capture-too-narrow` (3.14) or `efficiency-budget`
applies. With band suspension disabled, `always` or an operator start, the reason is never
`frequency-out-of-band`. This holds for every sequence of retunes (out, in, out, in) and for
every catalogue and YAML decoder kind.
3.14 **Honest reason.** When the band fits but no placement does (the decoder's channel or
centre slot cannot fit the usable window at the current rate), the reason is
`capture-too-narrow`, not `frequency-out-of-band`. `DecoderSuspensionReasonCode`, the Fastify
schemas, the CLI guards and the web reason words gain it; Main announces it in
`docs/CLI-COORDINATION.md`. Precedence (11.3) places it directly after `frequency-out-of-band`.
(2026-10-25, second amendment) When the band is in view but no channel is selected (no
VFO, no band-plan channel, so no candidate was tried) the reason is `no-channel-selected`,
not `capture-too-narrow`; it ranks with `capture-too-narrow`. When `always`, an operator start or a band
opt-out bypasses the band policy, a channelised decoder whose selected channel (configured,
VFO, band-plan or the fallback) was tried and does not fit reports `capture-too-narrow`
wherever that channel lies; raw-reach decoders report no reason. An unplaced decoder's band
reason never contradicts its band assessment: `frequency-out-of-band` only when the
assessment is `out-of-band`, judged on the pipeline's real window.
3.15 **Fresh `since`.** `suspension.since` is the start of the current uninterrupted
suspension with the current `reasonCode`. A change of reason code resets it; a re-evaluation
with the same reason while still suspended keeps it; suspend, run, suspend with the same
reason starts a new interval.
3.16 **rtl_433 sees the whole capture.** When the band overlaps the usable window and the
capture rate is 250 ksps to 2.4 Msps, the catalogue rtl_433 decoder reads the raw source stream
(reach `raw`, no channel, no resampling, `-s` = the capture rate, `-f` = the capture centre);
band plans enable and order it, never narrow what it hears. A moved capture centre restarts it
so `-f` stays current. Above 2.4 Msps its channel is the widest one that fits the usable window
around the band and window overlap, at most its 1 MHz target and at least 250 kHz; a changed
rate or a moved channel restarts the placement (no in-place retune, `-f` is the channel
centre). Below 250 ksps the reason is `capture-too-narrow`. Rationale: a sensor near the window
edge (about 0.93 of Nyquist) lies outside every channelizer channel and decodes only from the
raw stream.
3.17 **LoRa follows the regional band.** The catalogue LoRa decoder in an EU region declares both
EU slots (`EU_868` and `EU_433`, the region's default channel in each), and the planner places it
on whichever slot fits the usable window, passing the matching `--region` and frequency. An
explicit configured frequency or region keeps today's fixed placement.

Acceptance:

- With a fake source, a scripted retune sequence out, in, out, in of each decoder's band, the
  status after each settle shows `suspended` exactly when `bandAssessment.verdict` is
  `out-of-band` or a placement cannot fit (`capture-too-narrow`), for every decoder kind.
- The same holds after a fake source disconnect and reconnect at a new centre, and after a
  manager restart with the source already tuned in band.
- rtl_433 at 1.024 Msps centred at 434.44 MHz: one placement, running, `-s` within
  250 kHz to 1 MHz, bytes flowing within 5 s of the settle.
- A decoder moving from `frequency-out-of-band` to `capture-too-narrow` shows a new `since`.
- Live (Main): tune the receiver to a 433 MHz ISM centre at 1.024 Msps; rtl_433 runs and decodes
  a local sensor or remote; tune away and back twice; it suspends and resumes each time.

## Paging raster amendment — 2026-10-25

Found live: a capture centred off-raster in a UHF paging band, with pagers on several raster
channels (some on the 6.25 kHz offsets), and the configured multimon-ng with one VFO
placement and a 47 kHz channel decoded nothing. Demodulating the same bursts a few kHz off
their raster frequency, or on the neighbouring 6.25 kHz point, also gives nothing.

3.18 **A pager decoder hears the whole paging band in view.**

- _Band._ When every mode multimon-ng runs is a paging mode (`POCSAG512`, `POCSAG1200`,
  `POCSAG2400`, `FLEX`; absent, empty or all-invalid `modes` run the POCSAG default), its
  built-in band is its region's paging ranges: the band catalogue's ranges whose protocols
  are paging only (`pocsag`, `flex`), plus paging bands the catalogue lacks (EU:
  466.025–466.230 MHz, France). Out of view (1090 MHz, ISM, airband) it is then
  `frequency-out-of-band`. With any other mode enabled (`EAS`, `AFSK1200`, `FSK9600`, `DTMF`,
  alone or mixed with paging modes) the band stays unknown and it follows the VFO on every
  band (3.11). Overrides, `always` and operator starts work as in 3.13. The entry is a
  supplement to the built-in table in `src/decoders/enablement/paging-plan.ts`;
  `src/decoders/band-defaults.ts` stays byte-identical (band-plans requirement 1.1).
- _Channels._ With at least one paging mode enabled (a mixed set included), a channelizer
  and no `channelHz`, `channelsHz`, `offsetHz`, `frequency` or `frequencies`, config-origin and catalogue-origin multimon-ng place one channel on every
  raster frequency (the range's finest raster, exactly on it) of a paging range inside the
  usable window (`sampleRate × usableFraction`, not Nyquist) whose passband fits the window,
  origin `bandplan`, nearest the capture centre first, at most `MULTIMON_PAGING_MAX_CHANNELS`
  (33: the French band at 6.25 kHz). The VFO alone no longer selects the channel. A raster
  channel in the window that cannot fit is a fit failure (3.14). Explicit channels, and the
  case with no channelizer, keep 3.11. Catalogue band-plan channels (3.5) follow the raster channels.
- _Filter._ Each channel asks for 12 kHz bandwidth and 2.5 kHz transition at 48 kHz: flat
  to ±6 kHz (POCSAG1200 Carson width 2 × (4.5 + 1.2) = 11.4 kHz), 66 dB down from ±8.5 kHz,
  so a 12.5 kHz neighbour (tones at 8.0 and 17.0 kHz) is rejected. The old request was
  48 000 × (1 − 0.012) = 47 424 Hz.
- _Primary._ With the paging raster in view, the settled VFO counts only when it is one of
  the raster channels that fit the window; it is then the primary, origin `vfo`, on both the
  config and the catalogue path. Membership is checked before the cap: an on-raster VFO
  counts within `MULTIMON_PAGING_MAX_CHANNELS` however far it is from the centre, and the
  farthest other raster channel yields. An off-raster VFO is dropped. Otherwise the nearest
  raster channel is the primary; then the other raster channels, then catalogue band-plan
  channels. Raster channels in the window that all fail to fit are `capture-too-narrow`
  (3.14), never a fallback to an off-raster centre or VFO channel, also when `always`, an
  operator start or a band-suspension opt-out bypasses the band. With no raster channel in
  the window at all, a bypassed band keeps 3.11 (the VFO channel).
- _Admission._ Besides the primary, every other generated paging channel is
  marked `gated`: it goes through the efficiency gate and probation even for a YAML decoder
  (an exception to 4.9), and it is admitted after every other decoder's placements, so a wide
  paging band never starves them. The cap applies after the VFO, band-plan and raster
  channels are combined and deduplicated, keeping the higher-priority ones.
- _Cost._ At 1.024 Msps the window is 819.2 kHz: at most 129 fitting points at 6.25 kHz,
  65 at 12.5 kHz, hence the bound. Measured on a Mac (load average 9 to 15): wavekit-chan
  1.0 % of a core idle, 4.4 % with one 12 kHz channel, 29 % with 8, 83 % with 33 (about
  2.5 % per channel); multimon-ng with POCSAG512/1200/2400 and FLEX 1.8 % per channel, sox
  0.2 %. csdr was not measured. The planner's estimate (0.14 core per channel) makes the
  efficiency gate admit about ten channels within the 1.5-core budget.
- _Not changed._ dsd-fme, direwolf and acarsdec keep 3.11.

Acceptance: unit tests on the planner (in and out of the window, the bound after combining,
config-origin with and without channels, gated secondaries refused by a
closed gate) and a property test; with a synthetic POCSAG1200 burst on a 6.25 kHz offset
channel (`scripts/fixtures/pocsag-iq.mjs`) through wavekit-chan and multimon-ng's channel
command line, and through an independent reference filter, it decodes on that channel only.

3.19 **dumpvdl2 requests only the channel its targets need.** dumpvdl2 channelises
internally, so it asks for one channel centred on its target midpoint (or `channelHz`).

- _Passband._ 2 × (farthest target from the channel centre) + 50 kHz (one 25 kHz VDL2
  channel plus a 12.5 kHz guard each side), transition rate × 0.025, instead of the full
  rate × 0.95. It widens only past rate × 0.95 (transition shrunk so bw/2 + tr ≤ rate/2)
  and is invalid when it reaches the rate.
- _Channel rate._ A capture at or above `targetSampleRate` (default 1.05 MHz) gets the
  target, as before (2.048 and 2.4 Msps to 1.05 MHz plan natively). Below it the channelizer
  cannot upsample, and 105 kHz × N is no cheap ratio of the usual capture rates (factors 3
  and 7: 1.024 Msps to 945 kHz has no feasible native plan), so the channel is the capture
  divided by the largest integer D giving an integer rate of at least 105 kHz that holds
  the passband at rate × 0.95; with none, D = 1 (the capture itself). A capture below
  105 kHz is invalid.
- _Decoder rate._ dumpvdl2 runs at the smallest 105 kHz × N at or above the delivered rate,
  capped at the target, and `--oversample` is that N. Its existing SoX resample step (the
  raw path's) converts when the two differ; no new chain is added. A channelised instance's
  `rateAssessment` reports that rate as `decoderInputRateHz` (525 kHz for a 512 kHz
  channel) and the channel's realised rate as `frontendRateHz`.
- _followCenter._ The default passband stays, but it is still widened or rejected by the
  list span, as before this amendment.
- _Arithmetic._ The default EU list (325 kHz span) at 1.024 Msps needs 375 kHz: D = 3 gives
  a non-integer 341 333 Hz, D = 2 gives 512 kHz (375 kHz ≤ 486.4 kHz), transition 12.8 kHz,
  reach 187.5 + 12.8 = 200.3 kHz inside the ± 409.6 kHz window (0.8); SoX lifts 512 kHz to
  525 kHz (N = 5). The full 997.5 kHz passband at 1.05 MHz (reach 525 kHz, and above the
  capture rate) was `capture-too-narrow`. A centred span fits a 1.024 Msps window up to
  718 kHz (D = 1).
- _Cost._ The 512 to 525 kHz SoX step (`rate -h`) took 7 to 7.5 % of a core on a Mac (load
  average 7 to 10). Raspberry Pi figures are still to be measured.

Acceptance: unit tests through placement reach and channelizer admission at 1.024 and
2.4 Msps, at and just past the bound, a capture where no rate fits, off-midpoint
`channelHz` at the narrowing, widening and invalid bounds, the command line rate against
the request, and a property test that a placed request is admitted, lies in the window,
covers every target channel, and that every target set that fits is placed. An integration
test opens the request on the real wavekit-chan at 1.024, 2.048 and 2.4 Msps.

## Catalogue ACARS channels amendment — 2026-10-25

A narrow capture over the European ACARS channels placed the catalogue acarsdec on only
the two channels the catalogue listed, each one process with its own cost, so the budget
could suspend the second, and channels in use elsewhere in the window were never decoded.

3.20 **Catalogue acarsdec covers every listed ACARS channel in view.** It replaces 3.3's
"one channel per configured frequency" for the catalogue decoder only.

- _List._ EU: 131.525, 131.550, 131.725, 131.825 and 131.850 MHz (131.550 the worldwide
  primary, 131.725 the European primary, the others published European secondaries). The
  136.7–136.975 MHz channels are VDL Mode 2 (dumpvdl2) in Europe, not ACARS, and stay out.
  Other regions keep the adapter default (131.550, 131.725 MHz). Only the EU gains frequencies;
  the placement, ordering and gating below apply to catalogue acarsdec in every region.
- _Channels._ With a channelizer, catalogue acarsdec places one channel (one process) on
  each listed frequency inside the usable window (`sampleRate × usableFraction`) and its
  band whose passband fits the window, origin `bandplan`, nearest the capture centre first
  (ties: lower first), at most `ACARSDEC_CATALOGUE_MAX_CHANNELS` (5). Listed channels
  outside the window are not candidates. A listed channel in the window whose passband
  cannot fit is a fit failure (3.14) when nothing else places; there is no fallback to
  the capture centre, even when `always` or an operator start bypasses the band. With the
  band in view but no listed channel in the window the decoder is `no-channel-selected`.
- _Primary._ The settled VFO is primary when it is exactly one of the placed channels,
  origin `vfo`. Between two captures holding that channel at the same distance from their
  centres, the one on the VFO's source wins (a tie break for these generated channels only;
  it never overrides distance, and configured channels keep 3.3); otherwise the nearest channel is.
- _Swaps._ A channel is never decoded twice. A secondary worker survives a re-plan only
  while its channel is still a secondary; when the primary moves onto it (a VFO or centre
  change), that worker is removed before the decoder's own process moves there, and the
  former primary channel gets a new secondary. This holds for the 3.18 paging channels too.
- _Admission._ Every placement but the primary is `gated`, the 3.18 mechanism made
  generic: it goes through the efficiency gate and probation and is admitted after every
  other decoder's placements, so the ACARS secondaries never starve another decoder.
- _Bound._ The EU list spans 325 kHz. Each channel reaches bandwidth/2 + transition =
  6 + 6 = 12 kHz from its frequency, so at 1.024 Msps (window ± 409.6 kHz) all five fit
  while the capture centre lies within 409.6 − 12 − 162.5 = 235.1 kHz of the 131.6875 MHz
  midpoint. Each placement costs 0.05 + 0.11 = 0.16 core in the planner, five at most
  0.80 core; the primary alone is ungated.
- _Limitation._ A listed channel inside the window whose passband does not fit (at the
  window edge) is reported only when no channel places (`capture-too-narrow`). When other
  channels place, it is silently not covered: suspension reasons are per decoder, not per
  channel.
- _Not changed._ Configured (YAML) acarsdec with explicit frequencies keeps one ungated
  placement per frequency; configured acarsdec without them keeps 3.11.
- _Open._ The intended follow-up is one acarsdec process for every channel in view:
  acarsdec's sndfile input takes an interleaved N-channel stream (`channels=N`), fed by one
  wide channel request and N AM chains, costed once. It needs a 24 kHz-multiple channel
  rate (no integer divisor of 1.024 Msps gives one), the fan-out pipeline, and a channel
  index to frequency mapping for provenance.

Acceptance: unit tests on the planner (in and out of the window, the edge misfit without
fallback, the bound, ordering, VFO primary, config and catalogue paths, gated secondaries
admitted last) and a property test that every in-window channel that fits is placed, none that misfits is,
and a decoder with no placement carries a reason; manager tests where a closed gate refuses
the gated secondaries while the primary runs, and where moving the primary onto a running
secondary (acarsdec and paging multimon-ng) keeps one worker per channel and the cost
bound; the VFO primary across identical captures; each placement's channel request is on
its frequency.

## Secondaries yield amendment — 2026-10-26

The 3.18 and 3.20 promise that gated secondaries are "admitted after every other decoder's
placements" held only for the order of one planning pass. Admission was first come, first
served: a decoder's secondary workers can start inside a re-plan before other decoders'
placements, and every later retry raced on equal terms, so a capture holding a paging range
and a catalogue decoder's own band could fill the budget with paging secondaries and leave
the in-band decoder (AIS at 161.975 and 162.025 MHz inside the 137–174 MHz VHF paging
range) suspended with `efficiency-budget` (`budget`) for good.

3.21 **Gated secondaries yield to every ungated placement.** It amends 4.3 ("a newcomer
never evicts a running placement") for gated secondaries only.

- _Rule._ A placement is firm when it is not `gated`: a primary of any decoder, a catalogue
  placement of any origin (`band`, `bandplan`, `vfo`, `fallback`), and every YAML placement
  (4.9). A firm newcomer is judged on the firm placements alone: running and
  reconnect-retained gated secondaries count neither in its budget term 4.1 (a) nor as the
  source's single probationer (4.4). When it is admitted, the running gated secondaries
  that no longer fit beside the firm placements and the newcomer, kept oldest-admitted
  first, are suspended with `efficiency-budget` (`budget`) and retried with the normal
  4.3 backoff; so is a gated secondary on probation on the newcomer's source, whose
  evidence the newcomer would blur. The CPU (b) and drop (c) terms are unchanged: a
  firm newcomer the host cannot carry is refused and displaces nothing.
- _When._ Displacement follows only the final decision taken immediately before the
  start, after the channel is wired, never the preflight one: a newcomer refused there
  (CPU, drops, budget) or whose channel allocation fails displaces nothing. When the start
  is superseded or fails after displacement, the displaced secondaries lose their backoff
  and retry at the next evaluation. A catalogue newcomer starts only once every
  displaced secondary has stopped: one whose stop fails or is incomplete still holds its
  cost, so the newcomer is refused for `budget` and retried at the next sample, which
  asks for that stop again. A YAML newcomer starts regardless (4.9), so until that stop
  succeeds the declared cost may exceed the budget for a while. Displaced secondaries are
  stopped newest first. A newcomer stopped or removed while its process is starting
  returns their room the same way as a superseded start.
- _Reconnect._ A reconnecting placement's own reservation is replaced by it, never
  counted twice, and on that path too gated secondaries yield to a firm placement.
- _YAML placements._ A gate-exempt placement (4.9) still starts without a verdict and is
  never suspended; when it starts, the running gated secondaries that no longer fit the
  budget beside the firm placements are suspended the same way. 4.9 is otherwise
  unchanged: a YAML decoder that only follows the VFO keeps its exemption. Its declared
  cost still counts for catalogue newcomers, and on the default budgets it leaves room
  for an in-band catalogue decoder (arithmetic below).
- _Between secondaries._ A gated newcomer is judged on everything running, as before;
  gated secondaries never displace each other or a firm placement.
- _Arithmetic._ At 1.024 Msps the channelizer base is 0.22 core and each channel adds
  0.11. A YAML multimon-ng primary (0.03 + 0.11 = 0.14) and a YAML dsd-fme VFO channel
  (0.045 + 0.11 = 0.155) make 0.515 firm cores; catalogue ais-catcher on its channel
  (0.10 + 0.11 = 0.21) brings it to 0.725. On the 1.5-core x86-64 budget that leaves
  0.775 for paging secondaries at 0.14 each: 5 run (0.70), where 7 (0.98) filled the
  budget before AIS was admitted; the 2 newest yield. On the 0.75-core arm64 budget AIS
  fits (0.725) and no secondary does. AIS is refused only when the firm placements
  alone exceed the budget (0.725 > budget), when no displacement could make room.
- _Not changed._ Placement (3.18, 3.20), the gated mark, 4.2 ordering of a planning pass,
  probation verdicts and late-drop shedding.

Acceptance: manager tests with the real gate at 161.975 MHz and 1.024 Msps (YAML
multimon-ng with its paging raster, YAML dsd-fme on the VFO, catalogue ais-catcher):
AIS admitted in plan order; AIS admitted after secondaries filled the x86-64 budget,
with the newest yielding and the budget held; the arm64 budget; at and just past the
bound, with the surviving secondary's identity and stop count; the newest-first stop
order; a newcomer stopped while starting returns the room; CPU over the limit while
the channel is pending and a refused channel allocation displace nothing; a failed
secondary stop keeps the newcomer out until the stop succeeds; a gate test of the
reconnect path. A property test: across secondary counts and budgets, the in-band primary runs
exactly when it fits beside the firm placements, YAML placements are never displaced,
and the budget holds whenever it covers the YAML placements.
