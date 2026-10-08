# Sample-rate policy and core channelizer design

Status: proposed implementation contract, 2026-10-08. No capability policy or
channelizer is implemented by this document. Review the contract before changing
shared API types. See the [research review](../../REVIEW-2026-10-08-CHANNELIZER.md)
for corrections to the exploratory measurements and proposed algorithms.

## Outcome and order

A source-rate change should tell the operator which configured decoders can
continue, suspend incompatible decoders without crash loops, and resume eligible
decoders when the rate becomes usable. The same declarations should later drive
one shared channelizer per source. A directly attached dongle and a remote SDR
host are equal source configurations; the first channelizer runs on the core.

1. Establish explicit rate domains and a pure compatibility resolver, initially
   reporting verdicts without changing decoder lifecycle.
2. Add reversible manager suspension and shared REST/WebSocket contracts, then
   integrate the CLI through its owning team.
3. Validate a core-side channelizer prototype against corrected baselines and
   real IQ fixtures before selecting an algorithm or replacing pipelines.
4. Consider optional SDR-host channel delivery only after the core contract and
   stable-power hardware measurements pass.

The bounded CSDR buffer patch and source reconnect corrections can proceed
independently. They provide a more credible baseline for step 3. Existing
hardware acceptance remains a separate track.

## Three rate domains

Keep these separate in names, validation and UI:

- **Capture:** source IQ rate and usable RF span before adaptation.
- **Frontend:** translated/filtered IQ rate supplied to an IQ decoder or audio
  demodulator. Resampling can change sample count, but cannot recover RF content
  missing from the capture.
- **Decoder stdin:** final IQ or PCM rate and format actually consumed by the
  external program. For multimon-ng this is audio; for readsb it is IQ.

Existing `preferredSampleRates` mixes domains: audio decoders advertise audio
rates while their shared source supplies IQ. Preserve the legacy field for
compatibility, but do not infer a capture minimum or suspension policy from it.
The new declarations must distinguish an implementation limit from an RF limit
or a fixture-verified operating point.

## Proposed declarations and resolution

Use one shared public definition in `@wavekit/api-types`, reused by internal
decoder and source compatibility code. Resolve requirements per configured
instance, not solely by registry type: LoRa bandwidth and oversampling, decoder
input mode, selected channels and custom arguments can change them.

The following is a proposed shape; field names can be refined in contract review:

```ts
type RateSet =
  | { kind: "discrete"; valuesHz: number[] }
  | { kind: "range"; minHz: number; maxHz?: number; stepHz?: number };

interface DecoderRateRequirements {
  version: 1;
  sourceKind: "iq" | "audio_pcm" | "external";
  capture?: {
    accepted: RateSet[];
    preferredHz: number[];
    minimum?: {
      hz: number;
      basis: "implementation" | "verified-rf";
      evidence: string; // Stable reference, not a user-provided explanation.
    };
  };
  frontendIq?: { preferredHz: number; accepted: RateSet[] };
  decoderInput: {
    kind: "iq" | "audio_pcm" | "external";
    format?: string;
    preferredHz?: number;
    accepted?: RateSet[];
  };
}

interface ResolvedRatePlan {
  verdict: "best" | "acceptable" | "unusable" | "unknown";
  sourceRateHz?: number;
  frontendRateHz?: number;
  decoderInputRateHz?: number;
  adaptation?: "none" | "integer-decimation" | "resample";
  reasonCode?:
    | "insufficient-sample-rate"
    | "unsupported-sample-rate"
    | "unsupported-input-format"
    | "unknown-requirements"
    | "source-rate-unknown";
  requiredMinimumHz?: number;
  requirementBasis?: "implementation" | "verified-rf";
}
```

All rates must be finite positive numbers with an explicit unit. Reject malformed
declarations when registering/configuring the decoder. An absent declaration is
`unknown`, preserving existing custom decoder behavior; it is not `unusable`.
Audio-source configurations resolve against their audio input contract and must
not inherit a wideband IQ minimum. External-device paths are not suspended due
to an unrelated core source rate.

`best` means the source and the existing adapter satisfy a declared preferred
plan; it does not mean strongest RF reception or confirmed decoding. `acceptable`
means a supported alternative can be adapted without violating the declaration.
`unusable` requires an explicit incompatible requirement. Rate compatibility is
separate from source freshness, branch drops, process health and decoded events.

Resolve the actual adapter output, including integer-decimation rounding. Never
claim an exact frontend rate merely because it was requested. Use current
stateful paired-IQ resampling for exact-rate consumers until a replacement passes
equivalent integrity tests.

### Initial built-in evidence to collect

| Decoder family | Current behavior to represent | Evidence needed before a hard capture limit |
|---|---|---|
| readsb passive | Adapt source to fixed 2.4 Msps IQ stdin | Validate the proposed 2.0 Msps capture floor with pinned decoder and recorded signals; do not confuse stdin rate with captured bandwidth |
| dumpvdl2 | Current frontend chooses 1.05 Msps, with `--oversample` matching 105 kHz multiples | Pinned upstream supports multiples of 105 kHz; establish supported multiplier/filter/channel-span limits before labeling 1.05 Msps a minimum |
| AIS-catcher | Current frontend supplies exactly 384 ksps IQ | Verify configured AIS channel span and pinned decoder input modes; 384 ksps is an adapter target, not automatically a source minimum |
| rtl_433 | Integer decimation and actual resulting rate | Account for selected protocols and options; avoid one universal RF minimum for all devices |
| LoRa/Meshtastic | Frontend target is configured bandwidth times oversampling | Validate capture passband/transition margin separately from oversampled output rate |
| Audio demodulators | Per-instance IQ demodulation rate followed by PCM adaptation | Verify existing FIR decimation and audio-source paths; a blanket 250 ksps capture floor would reject existing lower-rate fixtures |

Until each minimum is supported, publish known adaptation facts and mark unknown
compatibility honestly. A conservative implementation restriction is allowed if
explicitly labeled and justified by the actual adapter; do not manufacture one
from a preferred rate.

## Manager lifecycle

Maintain operator intent separately from process state and rate eligibility.
The relevant state is desired-running, assigned source, latest rate plan,
suspension reason, and operation generation. It is not enough to check whether
the process happens to be running at the instant caps change.

- Resolve before initial spawn, explicit start and every relevant caps/options
  change. On incompatibility, stop the process tree and detach its delivery
  branch; retain its source selection and logical ownership reservation.
- A rate suspension does not consume restart budget, trigger failure backoff,
  change the configured enabled flag, or report a decoder crash.
- On return to a usable plan, resume only an instance still desired-running.
  An explicit stop, disable, removal or destroy invalidates pending restarts and
  remains effective across later caps changes.
- Serialize transitions with the existing tuning-restart machinery. Recheck the
  latest generation/plan after asynchronous stops and before spawns. Repeated
  identical caps changes are no-ops. A newer rate change supersedes older work.
- Revalidate on source removal/reassignment and reconnect. Do not reassign a
  suspended decoder to a different radio automatically.
- Publish one coherent status after each transition, including the current
  resolved plan and suspension reason. Keep process health and sampling activity
  distinct from this eligibility state.

REST status and the `decoders` WebSocket channel use the same serialized fields.
Update Fastify schemas and DTO mapping as well as TypeScript types; otherwise
serialization can strip the new fields. The registry endpoint can expose type
defaults, but instance status is authoritative for configured requirements.
No event replay/order guarantee is implied by this additive change.

## Source rate choices and tuner ownership

Expose device-supported rate ranges separately from suggested presets and
measured delivery capacity. A rate accepted by hardware is not a guarantee that
the link or decoder set can sustain it. Report estimated payload using the
actual sample format (CU8 is two bytes per complex sample).

The existing API and SDR++ relay continue to share the tuner controller and
control policy. This milestone never lowers a radio's rate automatically to cure
loss. A requested rate can be previewed through the resolver before it is set.

Reconnect synchronization should restore the last accepted desired tuner state
under the existing ownership policy. rtl_tcp command writes have no positive
hardware acknowledgement, so status must not imply independent readback.
SDR-host default restoration on last-client departure is a separate policy:
serialize it against arriving clients, count internal monitor/channelizer clients
correctly, and avoid fighting a reconnecting core. Test this with fake relay and
command transports before touching hardware.

## Core channelizer prototype contract

Build one supervised standalone process per source, initially opt-in. Rust is a
reasonable candidate, not the performance requirement. Preserve raw fanout for
recordings, readsb, tuner relay and existing demodulation clients. Do not replace
the TypeScript orchestrator or move decoders onto the SDR host.

The first prototype translates and filters IQ only; keep decoder-specific AGC,
AM/FM demodulation and audio conversion in existing tails until measured fixture
equivalence supports moving them. Make each request explicit about source ID,
absolute channel center, occupied bandwidth, transition margin, exact output
rate and IQ format. Resolve offsets against a capture generation.

Admission requires the entire passband and filter margin to fit inside the
usable capture, not merely `abs(offset) < fs/2`. Channel requests outside the
window are rejected/suspended with a reason; creating a channel never retunes
other consumers implicitly. Shared conversion is valid; sharing an initial
decimator is valid only when its passband contains all requested channels.

For the initial local prototype, stop/restart the channelizer and affected
consumers on a source rate/center change, with a new generation and discarded
old queues. This is simpler to verify than atomic live reconfiguration. A later
framed transport should carry stream/generation ID, monotonically increasing
sample index, format/rate metadata and discontinuity flags. Retunes and drops
reset phase/filter history or explicitly mark invalid transient samples; joining
discontinuous data silently is unacceptable.

Use bounded per-channel queues with a declared byte and latency budget. One slow
decoder must not stall raw relay clients or other channels. On overflow, preserve
whole complex samples, count discarded data and report/reset that channel's DSP
continuity. Source-branch loss invalidates every channel derived from it. Account
for partial reads/writes, EINTR, EOF tails, cancellation and process crashes.

Compare a direct frequency-translating FIR/resampler implementation with an
overlap-save implementation only after establishing equivalent output quality.
Choose FFT block/overlap sizes using filter support, latency and all required
rational rates; an integer bin count alone does not prove correct reconstruction.
Do not assume FFT channel cost is flat: per-channel filtering, inverse transforms,
resampling and output delivery still cost work.

## Acceptance and implementation batches

1. **Declarations/resolver:** focused tests for finite/invalid rates, exact versus
   integer adaptation, configured LoRa, audio/external paths, unknown extensions,
   source presets and truthful serialization. No runtime gating yet.
2. **Suspension:** fake-source/fake-decoder tests for low-rate start, usable →
   unusable → usable, repeated events, racing changes, failed stop/start,
   manual stop/disable/remove during transition, ownership and reconnect.
3. **Fixture baseline:** deterministic file hashes, known rate/format/center,
   expected decoded payloads and counts, license/provenance and negative cases.
   Separate IQ end-to-end tests from parser transcripts and audio-only tests.
4. **DSP prototype:** tones at positive/negative offsets, passband amplitude and
   phase, alias rejection, rate/count accuracy, arbitrary byte chunk splits,
   EOF, retunes, injected gaps and slow readers; then golden RF fixtures.
   Compare numeric outputs with defined tolerances, not bit equality across
   different DSP algorithms. Run all migrated protocols before defaulting on.
5. **Capacity gate:** repeatable paced and unpaced 1/4/8-channel workloads at
   2.048 and 2.4 Msps, including channels spread across the capture. Record CPU
   user/system time, RSS/PSS, latency, queue high-water marks and drops against
   the corrected CSDR baseline. Require loss-free software delivery at target
   load, bounded memory/latency and identical expected decoded messages.
6. **Optional host placement:** separate stable-power Pi measurements, transport
   contract, access policy and raw-consumer accounting. Avoid automatic fallback
   to a raw stream already known to exceed link capacity. Channel-count limits
   need a rate/filter/CPU budget, not just a static integer by Pi model.

Protocol-aware scanning follows channel ownership, correctness and capacity.
Power estimates are activity evidence, not protocol confirmation. Wide-area
scans still retune the receiver and need explicit ownership and pause/resume.
