# Viewed-slice spectrum requirements

Status: design proposal only. Existing S1-B spectrum profiles are implemented; the
longer transform described here is not implemented or qualified. Design acceptance
releases no runtime changes or production limits.

## 1. Passive selection and compatibility

As a waterfall user, I want real spectral detail inside the currently captured window.

1.1 Omitted spectrum options and existing `sourceId`/`hz`/`bins` requests retain their
existing selection, normalization, profile acknowledgements and snapshots. The scanner
compatibility default remains 10 Hz / 512 bins unless existing settings change it.
1.2 An explicit viewed request selects exactly one eligible IQ source and finite absolute
RF interval `[startHz, endHz)`, wholly inside its current usable capture span. It specifies
maximum native bin spacing, output bin target and delivery rate. Invalid, unavailable,
unauthorized or out-of-window requests are rejected without retuning or losing the
previous selection. Requested resolution is never silently weakened.
1.3 Acknowledgements disclose requested and accepted selection, adjustments, canonical
DSP/output identities, actual resolution and cadence limits. Admission is atomic;
concurrent switches and source removal cannot resurrect superseded demand.
1.4 Equivalent DSP work is coalesced per source. Distinct DSP and output profiles,
subscribers, bytes and work have finite source and global caps. Every serialized
viewed message, including control and snapshots, is charged with bounded bursts and
queues; tentative/closing demand remains accounted. Joining clients consume
output capacity even when no additional transform is needed.

## 2. Physical spectral detail

As a user, I want resolution claims to describe acquired samples.

2.1 The baseline uses a separate longer transform of N contiguous raw complex samples
at actual Fs, then selects the viewed bins. Cropped existing summaries, padding and
interpolation do not satisfy viewed resolution.
2.2 Frames report Fs/N, periodic Hann ENBW, N/Fs, N, absolute sample support, capture
axis, stream, epoch, tuning trust, reduction width and transform/delivery cadence
separately. Detector resolution remains independent. Output bins cannot invent detail.
2.3 Translation with anti-alias decimation is deferred until separately measured and
reviewed; the baseline claims no free decimation or extra sample support.

## 3. Acquisition integrity

As a detector consumer, I need display work to preserve acquisition and detection.

3.1 Raw acquisition preserves detector conversion arithmetic. Borrowed data is consumed
synchronously or copied into bounded owned storage before return; reused windowed FFT
arrays cannot become asynchronous raw input.
3.2 Absolute sample intervals deduplicate overlap. Gaps, counter markers, settle,
stream/epoch/rate/layout/gain/trust changes reset partial assembly and cached frames.
No frame spans an invalid interval or combines different capture identities. A separate
continuity generation invalidates all pending results/cache/delivery at every seam,
including gaps that leave detector epoch unchanged.
3.3 Snapshots match current selection, profile, capture identity and access. Missing or
stale data produces a truthful waiting/suspended status, never a disguised legacy crop.

## 4. Independence and resource arbitration

As an operator, I need scanner, listen and recording to retain priority.

4.1 Passive requests never retune, preempt tuner leases, restart/reconfigure detection,
or change noise-floor, track, occupancy, recording or scanner outputs. Tuning consent
and access policy remain authoritative.
4.2 Display admission observes access and available budgets after scanner/listen,
recording and native work reservations. Exhaustion denies or drops display work without
upstream backpressure or loss caused to detector consumers.
4.3 Bounded fair scheduling prevents one source/client from monopolizing available
work. Disconnect, unsubscribe, replacement, revocation, source removal, worker failure
and shutdown release reservations, buffers and stale deliveries.

## 5. Measured release gates

As a maintainer, I need bounded limits backed by combined-workload evidence.

5.1 Proposed caps include memory, FFT size, transforms/s, profiles, copy/message bytes,
queues, latency and CPU ceilings with explicit accounting formulae. Every numerical
cap is provisional until sustained measurements qualify the target platform/workload.
5.2 Qualification must cover two-tone detail, simultaneous sources/spans, unchanged
detection, overlap/seams, saturation/fairness and cleanup/memory bounds. Historical
short summary measurements establish no zoom headroom.
5.3 Implementation requires separate shared-path allocation and serial validation;
production enablement requires measured limits and acceptance evidence. Unmet gates
remain explicit; completion of this spec alone satisfies neither gate.
