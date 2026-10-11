# Viewed-slice spectrum design

Status: proposed architecture; no implementation or measured capacity claim.
Read [requirements](requirements.md) and [tasks](tasks.md). This extends the
[scanner design](../../superpowers/specs/2026-10-09-signal-discovery-scanner-design.md),
[scanner plan](../../superpowers/plans/2026-10-09-signal-discovery-scanner.md) and
[S1-B delta](../../superpowers/plans/2026-10-09-signal-discovery-scanner-delta.md),
without replacing their numbering or accepted detector work. The
[roadmap §8 amendment](../../ROADMAP.md#spectrum-contract-amendment-for-scanner-s1-b)
requires genuine new sample support.

## 1. Existing seams and proposed ownership

`src/core/spectrum/pipeline.ts` produces max-hold reduced block summaries;
`src/core/spectrum/spectrum-service.ts` reduces those again per profile and serves
matching current snapshots. `packages/api-types/src/spectrum.ts` currently accepts
only source/rate/bins. `frame-source.ts` applies the Hann window and reuses callback
arrays; those arrays are not an unwindowed raw-IQ acquisition interface.
`worker-protocol.ts` currently constrains detector FFT size to 512..16384.
The new display transform must not enlarge that detector configuration or alter its
conversion arithmetic. Existing source engines and scanner ownership remain intact.

Proposed flow: seam-certified raw interval → bounded display ring → display worker
with independent FFT plans → slice/reduction → shared output profile → client.
A future read-only raw seam must certify valid intervals after marker/settle handling,
before detector windowing. It carries stream/epoch/sample counters, format, actual Fs,
center, gain and tuning trust. Marker detection may hold a bounded trailing candidate
streak; uncertain samples are withheld, never published speculatively. Overflow drops
display input and creates a display gap, while detector handling proceeds unchanged.
If this seam cannot be provided without changing detector results, implementation stops
at the ownership gate; concatenating detector callback frames is not a fallback.

Future affected seams, for allocation only: API DTOs and boundary Zod schemas; WS
subscription/broadcast and access lifecycle; spectrum service/engine/pipeline-host;
raw acquisition/frame-source seam; display worker protocol and worker entry/bundling;
config/status budgets; CLI/web capability consumption; tests/fixtures. Native
`wavekit-chan` integration is a deferred alternative, not a baseline requirement.
No runtime/native/client path is allocated by this document.

## 2. Request, acknowledgement and profile contracts

Proposed additive `view` field on explicit spectrum options:
`{startHz, endHz, maxNativeBinHz}`; existing `sourceId`, `hz`, `bins` remain.
Absence of `view` follows existing S1-B behavior exactly, including omitted options
selecting defaults across eligible sources. Presence requires all three finite view
fields, positive spacing and width, eligible exact source and access admission.
Unknown fields and nonfinite values are rejected at the boundary. No implicit source
fallback, view clipping, retune or nearest lower-resolution profile is allowed.

For current usable fraction u, require the interval within
`[centerHz-u*Fs/2, centerHz+u*Fs/2)` and supported by actual transform cells.
Fs/center/trust come from the capture identity, never just a requested tune.
Choose smallest power-of-two N at least 32768 with `Fs/N <= maxNativeBinHz` and
N <= 262144. Unsupported resolution is rejected. Delivery hz is clamped/snapped
0.5..5 in 0.5 steps for view mode; bins is rounded/clamped 128..2048, with explicit
`nearest` adjustment fields. Omitted hz/bins use existing defaults then disclose
view-mode adjustments. Client resolution must also survive output reduction: report
native spacing and effective output widths, even if requested bins coarsen the view.

DSP identity is `(source generation, stream, epoch, Fs, format, center, gain,
trust, N, periodic-Hann-v1, no-overlap-v1)`. Span/rate/bins are not DSP keys: different
spans at the same N share the full transform; different N do not. Output identity
adds exact requested span, selected native cell interval, reduction factor and accepted
rate. Numeric canonicalization uses finite validated numbers, normalizes negative zero,
and uses structured tuples, not lossy rounded RF keys. Identity is rebuilt on capture
changes; an output profile is never coalesced across sources or epochs.

Ack precedes frames and includes old outcome/adjusted conventions plus requested view,
accepted view, DSP/output keys, N, nativeBinHz, enbwHz, observationMs, output cell
boundaries, actual bin count/width and transform-rate ceiling. Names are proposed DTO
extensions requiring later owner review. Capacity, access, source or resolution errors
use `rejected` and preserve previous selection. No capacity-driven crop substitute.
Status distinguishes waiting-samples, suspended-out-of-window, suspended-budget,
suspended-unverified-axis, worker-error and removed; effective delivered rate may be
zero and is never promised solely by ack. Trust is preserved, never upgraded. For
unverified tuning trust, view admission is suspended until a trustworthy capture axis
exists; legacy display behavior is unchanged.

Subscribe validates and reserves before atomic swap; an operation generation prevents
late start/ack/frame after replacement or disconnect. Failed replacement releases only
its tentative reservation. Late join gets a current matching cached frame only after
ack; otherwise waits for fresh support. Reconnect is a new demand, no replay.
On retune/rate change, invalidate cache and revalidate fixed absolute RF view; if still
valid recompute N and reacquire reservations, otherwise suspend without following the
center silently. Source removal sends existing removal notice, clears demand, and does
not rebind on source ID reuse. Revocation stops frames and releases all demand.
Last client departure evicts its output; last DSP reference removes plans/ring use
immediately after in-flight cancellation acknowledgment. Shutdown/failure releases all
reservations; no display-only references keep detector consumers alive accidentally.

## 3. Transform and truthful axis

Use N new contiguous complex samples per transform, no display overlap initially.
Each result covers `[startSample, startSample+N)` in one immutable capture identity.
Periodic Hann `w[n]=0.5-0.5*cos(2*pi*n/N)` has sum N/2 and ENBW
`Fs*sum(w²)/sum(w)² = 1.5*Fs/N`. Tone normalization is
`|FFT(x*w)|²/(N/2)²`; it is tone-calibrated dBFS, not noise density.
Native spacing is Fs/N; ENBW is not a general two-tone resolution guarantee.
Observation duration is N/Fs. Cadence does not shorten observation time.
Example only: Fs=2.048 MHz, N=65536 gives 31.25 Hz spacing, 46.875 Hz ENBW,
32 ms support. These are mathematical values, not measured throughput.

After FFT shift, bin i is centered at `centerHz+(i-N/2)*Fs/N`; cell low edge
is half a native spacing below it. Select only complete cells inside the requested
interval and usable RF span. Reject views containing no complete cell. Return actual
start/end edges rather than implying exact request endpoints. Let M selected cells,
B accepted output target, d=max(1,ceil(M/B)); max-hold each group of d cells in linear
power before dB quantization. Actual count is ceil(M/d), never padding to B. Final
group may be narrower: disclose uniform full-group width and last-group width (or
explicit edges). Max-hold over time occurs only within one output/capture identity;
record each contributing sample interval, transform count, first/last support and
coverage fraction. Skipped intervals remain gaps; first-to-last span is not contiguous
support. No interpolation, padding or repeated old frame increases physical detail.

Frames add stream, capture generation, sample support, N, window, ENBW, native spacing,
output edges/reduction, observation duration, transform count/rate, freshness and
skipped-work counters. Legacy detector overlays retain their own source/epoch and
resolution metadata; attach only matching-identity overlays, otherwise omit with reason.
Do not reuse a detector floor as a calibrated zoom noise floor. Detector floor/threshold,
tracks and occupancy are unchanged and labelled detector-derived when displayed.

## 4. Acquisition, ownership and seams

Certified raw byte intervals are borrowed for the duration of the synchronous callback.
Copy once into a source-owned bounded raw ring before returning; no queued borrowed
view or transfer detaches detector storage. Convert only complete samples into owned
FFT scratch with the existing U8 `u/127.5-1`, S16 `s/32768`, float LE arithmetic,
then apply the display Hann once. Never unwindow/reassemble reused `re`/`im` arrays.
All interleaved partial-byte handling retains absolute sample identity; cap a trailing
partial sample to bps-1 bytes and discard it on any seam.

Track next accepted absolute sample in each identity. An entirely duplicate interval
is ignored; a matching overlapping prefix is skipped and only its new suffix copied.
No detector overlap frame is counted twice. Conflicting overlap bytes or regressing
identity/counter is a seam; discard partial assembly rather than guess continuity.
A forward gap resets support. Gap messages, counter marker runs (including an active
run), pending epoch/settle, new stream, format/layout/Fs/center/gain/trust changes and
worker drops all flush partial windows, temporal holds and snapshot cache. No output
during settling. Require N valid post-seam samples before resuming. Async results carry
capture, request and display continuity generations. The continuity generation is a
monotonic source-local token advanced synchronously on **every** listed seam, even
when source/stream/epoch/request are unchanged. Tag assembly, pending/in-flight work,
results, temporal holds, snapshots and queued frames with this token; discard mismatches
on worker return, cache insertion, snapshot selection and immediately before socket
handoff. Invalidating a seam clears unsent frames and forbids pre-seam work from
refilling the cache. Require N post-seam samples in the new token. Include the token
on the wire so clients distinguish continuity boundaries; bytes already handed to a
socket cannot be recalled, but no stale frame is newly handed off after invalidation.
This token never changes detector epoch or detector output. An active counter run
invalidates once on entry and keeps assembly blocked until certified valid samples
resume; further seams still advance the token.

## 5. Provisional admission and budgets

All numbers below are proposed ceilings, not measurements or production defaults.
The feature stays disabled pending qualification. MiB means 2^20 bytes; ceilings cover
all zoom allocations and serialized transport, not just FFT arrays.

| Resource | Per source | Global | Accounting |
| --- | --- | --- | --- |
| Active viewed sources | 1 identity/source | 2 | third source denied |
| Distinct DSP profiles | 2 | 4 | N plans, including idle pending work |
| Output profiles | 4 | 8 | span/rate/bins identities |
| Viewed subscribers | 8 | 16 | each client counts even if shared |
| FFT N | 32768..262144 | same | radix-2; reject larger demand |
| Transforms/s | 5 summed over DSP profiles | 10 | also <= Fs/N per profile |
| Owned zoom memory | 32 MiB | 64 MiB | buffers, plans, queues, cache, wire copies |
| Raw ring | 2*Nmax*bps <= 4 MiB | 8 MiB | max bps=8; shared by source |
| Raw copy traffic | 16 MiB/s | 32 MiB/s | accepted bytes copied, including worker copies |
| Input message | 256 KiB | same | split/drop oversized chunks within budget |
| Worker queue | 1 pending + 1 in-flight/source | 2 pending + 2 in-flight | total bytes in memory cap |
| Encoded frame | 16 KiB | same | bins base64 plus bounded metadata/support |
| Data egress | 640 KiB/s | 1280 KiB/s | periodic frames and snapshots per recipient |
| Control egress | 32 KiB/s | 64 KiB/s | all ack/status/rejection/removal envelopes |
| Total egress | 672 KiB/s | 1344 KiB/s | data + control; no uncharged viewed message |
| Egress burst | 160 KiB | 320 KiB | data 128/256 + control 32/64 KiB |
| Control message | 2 KiB | same | complete serialized envelope |
| Control operations | 2/s/client | 32/s | also constrained by source/global byte tokens |
| Pending client queue | 1 newest frame + 2 control messages | 16 frames + 32 controls | separate from transport buffering |
| CPU incremental | 0.10 core | 0.20 core | all copy/DSP/reduction/serialization overhead |
| Added detector p99 latency | <= 2 ms | same | compared to paired no-zoom workload |
| Display freshness target | <= 250 ms after support end | same | deadline drop; never block to meet it |

Memory estimate per plan: scratch complex 8N + window 4N + FFT twiddles 8N +
bit reversal 4N + power scratch 8N + dB scratch 4N = 36N bytes; reserve extra actual
allocator/worker overhead, ring, two messages, support descriptors and output caches.
At Nmax this is 9 MiB/plan, so two plans plus 4 MiB ring leave 10 MiB of the source
cap for remaining allocations. Admission uses measured allocation high-water estimates
and rejects if the full reservation does not fit. Worker/runtime overhead attributable
to zoom counts; no unaccounted unlimited worker-per-profile spawning.
Copy load is `sum(acceptedRawBytes * actualCopyCount)/elapsedSeconds`; for each source
full-rate CU8 at 2.048 Msps is 4.096 MB/s per copy, float IQ is 16.384 MB/s per copy
and may exceed the proposed source cap. Such a source is denied/throttled by selecting
fresh contiguous windows, not downsampled without filtering. Lost input resets assembly.
FFT work proxy is `sum(rate*N*log2(N))`, measured CPU is authoritative. Egress is
the actual sum of serialized bytes for **every** viewed message per recipient, including
outer envelopes, snapshots, acks, rejections, status and removal notices. Periodic
reservation is `sum(clientRate*maxSerializedFrameBytes)`; control has a separate
reserved allowance, so maximum periodic load does not consume control capacity.
Tentative switches reserve both old and new demand plus control before commit; closing
demand stays charged until queues/in-flight bytes are discarded or completed. If the
joint reservation does not fit, reject the switch without losing the previous selection.
Repeated tentative operations cannot escape subscriber, memory or byte accounting.

Use nonnegative token buckets: per-source data refill 640 KiB/s, burst 128 KiB;
global data 1280 KiB/s, burst 256 KiB; per-source control 32 KiB/s, burst 32 KiB;
global control 64 KiB/s, burst 64 KiB. Each client also has control refill 4 KiB/s,
burst 4 KiB and operation refill 2/s, burst 2. Data, including snapshots, consumes both
source and global data tokens; controls consume client/source/global control tokens.
Any interval t seconds therefore sends at most R*t+B bytes for each bucket and no
more than the sum for total traffic. Reconnects do not reset source/global buckets;
closing/replaced clients keep attributed traffic in those buckets. Requests for missing
sources use a global unassigned-control bucket drawn from the same global allowance.
All bucket storage is bounded by admitted/closing client limits; unknown new clients
are denied before allocating DSP state. Existing legacy traffic remains subject to its
existing behavior; these ceilings explicitly describe incremental viewed-mode traffic.

Before committing selection, reserve and enqueue its ack; frames/snapshots remain
blocked until that ack reaches socket handoff in order. At data exhaustion drop or
replace newest pending frame, including an optional late-join snapshot, and expose
counters. Do not defer a snapshot as a replay. Coalesce status to latest state within
the two-control pending limit; supersede unsent notices by a later ack carrying current
state. A request with no control/operation allowance is not admitted. If a rejection
cannot be sent within control allowance or an ordered control queue cannot fit, close
that viewed subscriber connection and release demand without an unbudgeted final
message. Removal/revocation cleans up immediately regardless of notice capacity;
suppress frames and either send a charged notice or close. No unbounded ack backlog.

The proposed application queue holds one newest unsent data frame and two bounded
controls/client. It is **not** the current broadcaster queue: existing spectrum wiring
bypasses scanner WsLimiter, and current transport byte/message bounds do not enforce
rate. A later allocated transport adapter must carry generations until socket handoff,
prevent multiple data frames accumulating behind the application queue, and account
serialized copies, transport queued bytes and socket bufferedAmount in zoom memory.
At most one 16 KiB data message and one 2 KiB control message/client may be in
transport handoff/buffering; otherwise drop data or close on control overload. If shared
transport cannot provide these isolation/accounting guarantees, implementation remains
gated rather than claiming the existing queue satisfies them. Support metadata
is bounded by at most 10 transforms per output frame (5/s at minimum 0.5 Hz); overflow
emits early or drops oldest with explicit coverage loss. Cadence is at most
min(acceptedHz, admittedTransformRate, Fs/N) for fresh results; a slow source is truthful.

Reserve scanner/listen/recording/native capacity first through the existing authority;
if no trustworthy residual budget exists, deny zoom. No tuner lease or native channel
is acquired. A display-only worker is lower priority; bounded callback copying must
meet the latency gate, else skip display capture. No source pause/drain wait, upstream
queue growth or detector drop is permitted for display demand.
Use source round-robin then DSP deficit scheduling, charging N*log2(N) tokens;
weights equal per source and per admitted DSP profile, independent of client count.
Keep at most one pending newest eligible window/source, replace stale work with a gap,
and never queue historical catch-up. Reserve each admitted profile a nonzero turn within
one second while budget exists; if not feasible deny it. Burst credits capped at one
transform; no arrival can evict an existing profile silently. Capacity changes suspend
least recently served work fairly, emit reason/counters, and reevaluate on real budget
or demand events. Access is checked before reserve and before delivery, including
policy changes; use existing policy semantics without broadening permissions.

## 6. Correctness properties

1. **Compatibility and atomic admission.** Legacy requests produce existing selections;
failed view/switch preserves old demand and generation guards prevent resurrection.
Validates: Requirements 1.1, 1.2, 1.3, 1.4.
2. **Physical support and reduction.** Every native bin derives from exactly N valid
contiguous samples; metadata/formulas and output edges agree, never padded detail.
Validates: Requirements 2.1, 2.2, 2.3.
3. **Ownership and seam isolation.** Borrowed reuse cannot change owned results;
interval unions deduplicate, every seam prevents mixed identity or invalid support.
Validates: Requirements 3.1, 3.2, 3.3.
4. **Passive detector equivalence.** Display request sequences change no detector/tuner
state or output for the same input and reservations; display failure is isolated.
Validates: Requirements 4.1, 4.2.
5. **Bounded fair lifecycle.** Arbitrary arrivals, removals, revocation and slow delivery
stay within all accounting caps and release demand; admitted work receives turns while
residual budget exists. Validates: Requirements 1.4, 4.2, 4.3, 5.1.
6. **Release evidence.** No enabled production limit exists without target/workload
measurement and acceptance receipts. Validates: Requirements 5.1, 5.2, 5.3.

## 7. Later acceptance and measurement plan

In a separately allocated serial window, use synthetic/offline IQ and paired baseline
runs before live RF. Two equal on-grid tones at Fs=2.048 MHz, N=65536, 250 Hz apart
with a 4096 Hz viewed span and >=128 output target must yield two peaks and a valley
>=6 dB below the weaker peak; old 2048 transform spacing is 1000 Hz and cannot meet
that same criterion. Repeat off-grid, unequal-power and noise cases; document failure
boundaries rather than claim universal resolution. Verify tone amplitude/ENBW and all
axis metadata for U8/S16/float, incomplete chunks and actual Fs changes.

Exercise two sources and four DSP profiles with differing spans, joins/switches,
retunes, unavailable/unverified axes, rejected admission and slow/disconnected clients.
Compare detector events, floors, tracks and occupancy exactly on identical offline
input, including overlap 0/0.5; transport scheduling timestamps may differ but sample
identity/results must not. Fuzz overlap, duplicates, gaps, counter runs, pending settle,
old worker results, rate/layout changes and source ID reuse (properties >=100 runs).
Specifically delay a pre-seam FFT across an ordinary same-epoch gap, active counter run
and display-worker drop with source/epoch/request unchanged: no late result may enter
holds/cache or socket handoff; resume only after N samples in the new continuity token.
At maximum periodic reservation add rapid resubscribe/reconnect, snapshots and control
notices; verify every envelope is charged, R*t+B bounds hold across connection churn,
ack-before-frame order survives throttling, tentative/closing reservations are bounded,
and overload closes/cleans up without uncharged notices or transport frame backlog.
Saturate every cap independently and together; prove bounded queue/memory and one-second
fair turns under admitted residual capacity. After final cleanup, require zero zoom
reservations/listeners/plans/caches and memory returning to measured steady baseline.

Proposed qualification duration: 30-minute combined scanner/listen/recording/native
workload per supported target, plus a two-hour worst-admitted-source/client cleanup
cycle. These are future experiments, not executed results. Record target CPU/OS/runtime,
source format/Fs, detector N/overlap, native and recording reservations, selected zoom
N/rates, incremental CPU, copy/worker/wire bytes, allocation/RSS high water, event-loop
and detector p50/p95/p99 latency, dropped work, freshness and fairness. Paired no-zoom
baseline must show zero additional detector loss, unchanged results and <=2 ms p99
latency increase. CPU, memory, traffic and freshness ceilings must all pass together.
Reduce caps and rerun failing cases; if no feasible caps preserve independence, retain
disabled state and separately evaluate translation/filter/decimation. The historical
one-second 2048-summary experiment cannot release any of these zoom limits.
