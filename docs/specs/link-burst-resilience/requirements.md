# Link burst resilience requirements

Status: design, not implemented (2026-10-22). See [design](design.md). A `tasks.md` follows
from the implementation plan.

## What changes for the user

- **A network receiver that delivers samples in clumps no longer makes decoders drop them.**
  When the link between a receiver and the core stalls for a moment and then delivers the
  backlog all at once (typical of Wi-Fi), the core holds the backlog in one per-source buffer
  and hands it to the decoders as fast as they take it. Up to two seconds of stall are absorbed
  by default, without adding any delay while the link is smooth.
- **Local receivers are unchanged.** A receiver on the same host (loopback) and recordings get
  no buffer, no added latency and no added memory.
- **The core says why samples went missing.** Every interval with lost samples is labelled with
  its most likely cause: the link, the host (the core's own CPU or event loop), one consumer
  (a single decoder too slow), or unknown. The decoder efficiency view and the link report show
  the label and the numbers behind it.
- **A link hiccup no longer costs a decoder its slot.** A decoder on probation is not suspended
  for a loss the link caused, and a link burst does not restart the 60 s clean wait before the
  next decoder is admitted. Losses the core cannot positively blame on the link are treated as
  today.
- **Sustained losses after start-up shed the newest built-in decoder.** When a host or consumer
  keeps dropping samples after every decoder finished probation (two of three 10 s windows),
  the newest built-in decoder that WaveKit started on its own on that source is paused with a
  retry and a growing backoff. Decoders you defined in YAML, decoders set to `always` and
  decoders you started yourself are never shed; losses from the link or of unknown cause only
  raise an alert.
- **A link report per source.** For every network source: the worst stall, the 99th percentile
  gap between arrivals, how many seconds were spent in bursts, bytes absorbed and bytes lost
  over the last 10 minutes, the receiver's upstream drops and, when the receiver host reports
  them, its radio signal, under-voltage and throttling. The link advisory and the
  `link-capacity` alert use the same facts.
- **Honest about what it cannot fix.** A buffer cures clumping, not a link too slow for the
  stream. ADS-B at 2.4 Msps over a Pi 3-class Wi-Fi link stays unsolved by design; the advisory
  and the report say so with numbers.

## Scope

Core-side resilience for any network IQ source (Pi receiver behind rtlmux, a plain LAN
`rtl_tcp`, several dongles), built on the stream pipeline (`src/core/source-manager.ts`,
`src/core/source-fanout-router.ts`, `src/core/fanout-manager.ts`), the efficiency gate of
[decoder-enablement](../decoder-enablement/requirements.md) (section 4) and its link advisory
(section 7). Background: [Wi-Fi IQ transport research](../../RESEARCH-2026-10-08-WIFI-IQ-TRANSPORT.md),
[receiver-side channelizer research](../../RESEARCH-2026-10-08-PI-CHANNELIZER.md),
[decoder-enablement capacity record](../../engineering/CAPACITY-2026-10-21-DECODER-ENABLEMENT.md)
(the open C+ clause) and [performance rules](../../PERFORMANCE.md).

Observed cause (2026-10-21/22): every fanout branch of a network source drops in the same
instant while the receiver reports no upstream drops and rtlmux's per-client queue is not
full. The receiver is on Ethernet; the path to the core crosses the core host's Wi-Fi hop.
Clumping therefore happens on the link after the receiver, and the samples arrive late, not
lost; each branch holds only about 110–130 ms (its mark plus stream and pipe buffers) at 2.048
to 2.4 Msps, so a longer stall followed by a catch-up burst overflows every branch at once.

Out of scope: the core's port-forwarder sidecar; sample compression or bit reduction;
decoders on the receiver host; automatic band time-sharing; any change to the 1090 MHz raise
or its Wi-Fi warning beyond feeding the advisory; the receiver-side channelizer itself (only its
contract hook, section 7); the CLI (the web UI is the consumer of the new DTOs).

**Defaults.** With the shipped config and no new key set, the deliberate changes are: network
IQ sources get a 2 s absorber (1.x); new optional DTO fields and one route (6.x, 8.x); the
efficiency gate's probation, clean window and post-graduation behaviour (4.x, 5.x); the
efficiency detail union gains `late-drops`. Loopback sources and recordings are byte-identical
to today in every route, frame and log line apart from the new optional fields.

## 1. Burst absorber

As an operator with a receiver on a jittery link I want late samples delivered instead of
dropped, without paying latency when the link is smooth.

1.1 Each IQ source whose transport is `network` (the link advisory's classification, decoder-
enablement 7.1) has one burst absorber between its source stream and its `FanoutManager`. A
`loopback` source, a recording and an audio source have none: their stream attaches to the
fanout exactly as today.
1.2 The absorber's capacity is configured per source in seconds of the source's byte rate
(`burstAbsorber.seconds`, 0 to 10; 0 disables). Absent, it is 2 s on a `network` source and 0
otherwise. Its storage is allocated once when the source's sample rate is known and reused;
a rate or format change flushes and resizes it.
1.3 While the absorber holds no bytes and no gating branch is congested, every chunk passes
to the fanout unchanged and synchronously (zero steady-state latency).
1.4 While any gating branch is congested, or bytes are already held, an arriving chunk is
appended to the absorber in arrival order. Held bytes are released to the fanout, oldest
first, whenever no gating branch is congested, in frame-aligned blocks of at most
`ABSORBER_RELEASE_BYTES`, until the absorber is empty or a gating branch congests again.
1.5 A gating branch is an active fanout branch that is not excluded. A branch is congested
while the fanout has it in backpressure or startup refusal. A branch is excluded (a laggard)
once it has been congested continuously for `ABSORBER_LAGGARD_MS` while at least one other
gating branch was seen uncongested in that time; it stops being excluded when it leaves
congestion. An excluded branch receives released chunks under today's drop-on-congestion rule.
1.6 Buffer, not hide: when an arriving chunk does not fit, the frame-aligned part that fits is
held and the rest is discarded and counted as absorber overflow (bytes and chunks). Overflow
appears in the source's drop counters read by the efficiency monitor as one extra per-source
counter, and is reported in the link report.
1.7 The absorber never pauses the source socket, never reorders or duplicates bytes, and never
changes `FanoutManager`'s per-branch backpressure, drop accounting or startup buffering.
1.8 A disconnect, reconnect, source removal or rate or format change discards held bytes; the
discard is counted separately (`flushedBytes`) and is not a drop.
1.9 Taps that read the source outside the fanout (spectrum, signal level, metrics) are not
delayed by the absorber.

## 2. Ingest instrumentation

As a maintainer I want the link's real behaviour measured before buffers are sized, and kept
measurable afterwards.

2.1 For every IQ source the core records, on the monotonic clock, the gap between consecutive
chunk arrivals at the source stream, the bytes received in the `CATCHUP_WINDOW_MS` after each
gap of at least `LINK_GAP_MS` beyond the nominal byte rate (catch-up bytes), and the chunk
sizes, in fixed preallocated histograms and 10 s slots covering `LINK_QUALITY_WINDOW_MS`
(10 min). Recording is allocation-free per chunk.
2.2 The core samples its event-loop delay with a native histogram and exposes, per efficiency
sample interval, its maximum and 99th percentile.
2.3 Instrumentation ships and runs first with the absorber's default capacity forced to 0, and
a measurement on the live Wi-Fi path is recorded under `docs/engineering/` before the
provisional constants of the design (`LINK_GAP_MS`, `ABSORBER_LAGGARD_MS`, the 2 s default) are
confirmed or changed in the same commit as the record.

## 3. Drop attribution

As an operator I want to know whether lost samples were the link's, the host's or one
decoder's fault, and I want the core to refuse to guess.

3.1 For every efficiency sample (2 s) and source, a pure function assigns one attribution:
`none`, `link`, `host`, `consumer` or `unknown`, from the per-branch drop deltas, the absorber
overflow delta, the ingest record (2.1), the event-loop delay (2.2), the normalised host CPU,
the received byte rate and the upstream drop delta.
3.2 `none`: every counter was read completely and no branch or absorber counter rose.
3.3 `consumer`: drops rose on a non-empty strict subset of the active branches and the absorber
did not overflow.
3.4 `link`: drops rose on every active branch or the absorber overflowed, and all of: (a) the
interval or the one before it contains an arrival gap whose part not explained by the
event-loop delay maximum (gap minus that maximum) is at least `LINK_GAP_MS`; (b) the received
byte rate over the link window shows no shortfall beyond `LINK_SHORTFALL_PERCENT` (samples
arrived late, not lost); (c) the upstream drop delta is 0 when the receiver reports it (an
unmeasured upstream does not block `link`; (b) stands in for it).
3.5 `host`: drops rose on every active branch or the absorber overflowed, 3.4 does not hold,
no upstream drop was measured in the interval, and the event-loop delay maximum was at least `HOST_LOOP_DELAY_MS` or the CPU was at or above
`cpuGuardPercent`.
3.6 `unknown`: anything else, including any incomplete or unreadable counter read, ingest,
event-loop or received-rate evidence missing where 3.4 or 3.5 needs it, and a positive upstream
drop delta with drops in the core (which is never `link`).
3.7 Attribution is the same function on every transport: a loopback source can be `host`,
`consumer` or `unknown`, and `link` only with the evidence of 3.4.
3.8 Each attributed interval with drops logs one info line with fixed fields (source id,
attribution, drop bytes, gap ms, loop delay ms, CPU percent); repeats of the same attribution
on a source are limited to one line per minute.

## 4. Efficiency gate during probation and the clean window

As an operator I want newcomers judged on what they cause, not on the weather of the link.

4.1 An interval attributed `link` neither condemns nor credits a probationer: its drops never
suspend one, and the interval is not credited probation coverage (it breaks the credited chain
as an incomplete read does).
4.2 An interval with positive drops attributed `consumer`, `host` or `unknown` keeps today's
rule: the newest probationer on the source is suspended (`efficiency-budget`, `drops`).
4.3 Missing evidence keeps today's rule (decoder-enablement 4.6): unknown evidence never
suspends and never credits, and closes the gate for newcomers.
4.4 Link-attributed drops do not count as the source's last drop for the admission term
(decoder-enablement 4.1 c): they neither close the 10 s drop term nor restart the 60 s clean
window. Every other positive drop does both, as today.
4.5 While the newest sample of a source is attributed `link`, admission on that source waits
with detail `unknown` (no rejection, no backoff) until the next sample.
4.6 The monitor computes attribution pull-based on its own monotonic sample clock; a clock
discontinuity discards the ingest window as it discards coverage today.

## 5. Late drops after graduation

As an operator I want the core to back off when decoders it chose keep losing samples after
start-up, but never to pull a decoder I asked for, and never for the link's sake.

5.1 A source is in late-drop state when it has no placement on probation. Its samples group
into consecutive 10 s windows (`EFFICIENCY_DROP_WINDOW_MS`); a window condemns when at least
one sample in it has positive drops attributed `consumer` or `host`.
5.2 When at least `LATE_SHED_HITS` (2) of the last `LATE_SHED_WINDOWS` (3) complete windows
condemn, the gate sheds one placement: the most recently admitted graduated placement on that
source that is a built-in (catalogue) decoder, not in mode `always`, and not started by the
operator. It is suspended with `efficiency-budget` and detail `late-drops`.
5.3 A shed placement is retried like a probation failure: after `EFFICIENCY_RETRY_MS`, doubling
on each further shed or probation failure up to `EFFICIENCY_RETRY_MAX_MS`; on retry it is
admitted through the gate and serves probation again.
5.4 After a shed, the source's window history is cleared and no further shed happens on it for
`LATE_SHED_COOLDOWN_MS`; at most one placement is shed per cooldown.
5.5 YAML (`config`) placements, `always` placements and operator-started placements are never
shed. When nothing is sheddable, or the condemning attribution is `link` or `unknown`, the
gate sheds nothing, logs one warning per minute and shows the state in the efficiency view.
5.6 Late shedding never retunes, changes a rate or writes to the receiver.

## 6. Link-quality reporting

As an operator I want the facts about each link in one place, and the advisory to use them.

6.1 `GET /api/resources/link-quality` returns one `SourceLinkQuality` per IQ source and
`GET /api/resources/link-quality/:sourceId` one source; the `resources` WebSocket channel
gains `resources:link-quality`, emitted on the aggregator's existing tick.
6.2 `SourceLinkQuality` carries: transport, absorber state (enabled, capacity in bytes and
seconds, held bytes now, peak held over 10 min, absorbed, overflowed and flushed bytes as
totals and over 10 min), arrival stats over 10 min (worst stall ms, gap p99 ms, burst seconds),
the last attribution and attribution counts over 10 min, upstream drop rate (null when
unmeasured), and receiver facts (interface kind, Wi-Fi signal dBm, under-voltage now,
throttled) from the receiver host's telemetry when it reports them, else null.
6.3 Burst seconds count each second in which the absorber held bytes or an arrival gap of at
least `LINK_GAP_MS` ended.
6.4 The link advisory (decoder-enablement 7.1) also becomes `dropping` while a `link`
attribution with drops occurred in the last `LINK_DROPPING_HOLD_MS`; `unproven` and `dropping`
keep their `link-capacity` alert severities (warning, critical). `LinkAdvisory` gains an
optional `burst` summary (worst stall, overflowed bytes over 10 min, burst seconds).
6.5 The report carries numbers and closed enums only; it never echoes host names, addresses,
SSIDs or other untrusted strings.
6.6 Bursts absorbed without loss never raise an alert; they are visible in the report only.

## 7. Receiver-side delivery hook (contract only)

As a maintainer I want the contract for a later receiver-side channelizer reserved now, so
the core and the receiver host can grow into it without a breaking change.

7.1 Source config gains `delivery: "raw" | "channels" | "auto"` (default `auto`). In this
version `auto` and `raw` both resolve to `raw`; `channels` fails config validation with a
`ConfigValidationError` naming this requirement.
7.2 `ReceiverCapabilities` gains optional `iqDelivery`: the modes the receiver host advertises
(`readonly ("raw" | "channels")[]`, or null when it does not advertise), the configured mode and
the resolved mode (`"raw"` in this version).
7.3 The receiver host's status API may advertise `iqDelivery.modes`; this version's receiver
host advertises `["raw"]`. No other behaviour of the hook is specified here; a later spec
designs channel delivery.

## 8. Contract, compatibility and observability

8.1 New optional DTO fields and types in `packages/api-types`: `SourceLinkQuality` and its
parts, `DropAttribution`, `LinkAdvisory.burst?`, `ReceiverCapabilities.iqDelivery?`,
`DecoderEfficiencyView` per-source `attribution?` and `lateDrops?`; widened unions:
`DecoderEfficiencyDetail` (`late-drops`), the `resources` channel event union
(`resources:link-quality`). Fastify response schemas accept them; the change is announced in
`docs/CLI-COORDINATION.md`.
8.2 Config keys are validated with Zod at startup: `sources[].burstAbsorber.seconds`,
`sources[].delivery`. Environment overrides follow the existing `WAVEKIT_` rules for arrays
and nesting.
8.3 Every shed, every absorber overflow episode (start and end, bytes) and every attribution
change logs one line with fixed fields; errors use `safeErrorFields`.

## 9. Acceptance

9.1 Fake link replay, in a scratch core whose fake `rtl_tcp` runs in a sibling container on a
private network (never the live receiver's bridge ports or the live API port): stalls injected
at intervals of 9, 1, 130, 50, 40, 71 and 161 s, each followed by a catch-up burst of the
withheld bytes, at 2.048 and 2.4 Msps. Stalls up to 1.8 s with the default absorber: every
branch drops 0.00 % of bytes over the run and the absorber does not overflow. Stalls of 2.5 s
and 4 s: overflow equals the withheld bytes beyond capacity within one release block, every
such interval is attributed `link`, no probationer is suspended and the clean window is not
restarted.
9.2 Attribution replay: a deliberately slow test consumer gives `consumer` with its siblings at
0.00 % drops and their added latency at most `ABSORBER_LAGGARD_MS` plus one chunk; CPU
contention on the scratch core with a smooth link gives `host`; a fake upstream drop gives
`unknown`.
9.3 Late-drop replay: with every placement graduated, sustained consumer drops shed the newest
eligible catalogue placement after two of three windows and nothing else for the cooldown;
YAML, `always` and operator-started placements are untouched; link-only bursts shed nothing.
9.4 CPU and memory are measured at 2.048 and 2.4 Msps on the desktop reference and on a Pi
4-class core host and recorded against the design's budget table; the event-loop delay p99
added by this design stays at or below 2 ms at 2.048 Msps.
9.5 Live soak on the current Wi-Fi path, at 2.048 Msps then 2.4 Msps, at least two hours each:
0.00 % branch drops for every burst within absorber capacity, every overflow attributed `link`,
no probationer suspended for a `link` interval; results in `docs/engineering/`.

## 10. Amendments to decoder-enablement

10.1 Decoder-enablement 4.1 (c), 4.4, 5.4 (the C+ clause) and its design's property 6 and
"Calls made" bullet on drops with no probationer are amended as set out in the design
("Amendments to decoder-enablement"). The amended criteria carry an in-place note linking
here; their numbers do not change.
