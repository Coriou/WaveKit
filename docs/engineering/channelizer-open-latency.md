# Channelizer open-path latency

This lane starts from `ccc319fe828a991cdd3a060486a81959e071168d` and targets the
core process, including the local-dongle path. Measurements here use synthetic
IQ on macOS; they establish neither Pi timing nor live RF acceptance. The
channelizer remains opt-in. The existing golden, marginal-frame and digital
voice acceptance rules remain in force.

The native-only landing gate described below is historical. The later scoped Node
candidate at `624625361abc44438adec952c496e9614461518a` implements busy recovery and
terminal ownership; its combined exact review and remaining consumer adoption
are recorded in the final section. Earlier timing evidence remains explicitly
at its original production SHA, not relabeled as a new benchmark.

## Problem and decision criteria

`Runtime::open` calls `ChannelDsp::new`, which calls `plan_chain`. Planning builds
and verifies each Kaiser prototype, including rejected split candidates, on the
same thread that converts and processes incoming IQ for all installed channels.
Repeated cold construction can therefore consume input slack on every channel.

A cache alone cannot remove the cold-open stall. A worker must have bounded task,
result and retained-plan storage, preserve input-thread event/sample authority,
and avoid replacing filter work with socket/queue allocation stalls. No filter
history, NCO phase or output schedule may be shared between channel instances.
The existing RF admission checks do not constitute a CPU/channel-count budget.

## Lifecycle contract to verify

- The runtime admits requests and owns active and pending ID uniqueness.
- Each task has a process-local serial; cancellation invalidates that serial's
  installation authority. Reusing an ID never revives an earlier completion.
- Only the runtime binds sockets and emits `opened`, after successful preparation
  and listening. The sample origin is the byte position at installation, with no
  replay of IQ consumed while planning was pending.
- Existing channels consume all input while planning runs. Gap markers retain
  their existing byte-position and per-channel reset authority.
- Closing a pending open cancels its preparation and emits `closed: requested`;
  no socket exists yet. Canceled work retains its reservation until reclaimed.
- EOF, control EOF and shutdown cancel pending work and prevent later installs.
  Source rate/centre changes already replace the whole process generation.
- Node serializes opens per source and sends `close` on its five-second timeout.
  Version-1 fields and TypeScript types remain unchanged.

## Chosen bounds and compatibility gate

One planner thread owns an eight-entry LRU cache with at most 131,072 retained
prototype taps (512 KiB coefficient payload, plus vector/plan metadata). Keys are
exact input/output rates and the bit patterns of bandwidth and transition. Offset,
gain and format are applied to a fresh DSP instance, so they do not key a filter
plan. No mutable DSP state is cached. Cache eviction never rejects a request.

There are four physical preparation reservations, including queued work, running
work, completed results and canceled work until disposal. Requested pending queue
capacity totals at most 64 MiB. The worker allocates the output queue as well as
DSP state. Canceled queued/results payloads are disposed by the worker; cancellation
of running work is cooperative. Runtime submission never waits for queue space or
joins the planner. Completion installation is limited to one per loop turn;
continuous IQ therefore neither waits for planning nor starves prepared results.
While requests are pending, idle completion polling has a five-millisecond wait.

Worker-only computational limits: 16,384 taps per prototype including halfbands;
16,384 phases per rational stage; at most 32,768 padded phase coefficients per
stage; one million factor trial steps across the two factorizations; 65,536
examined candidate pairs; 4,096 retained candidates; 128 actual prototype build
attempts per request; 64 growth/verification rounds per build. These bound work
and allocations, not universal completion time. Each stage retains its original
numerical design and verification sample order. Unsupported/effective-zero widths,
checked-overflow failures and verification exhaustion fail closed.

These are intentional new computational admission conditions. Existing rational
prototypes already had a tap acceptance cap; halfbands did not. The synchronous
reference's release-only fallback could return an unverified filter after growth
exhaustion; the worker refuses it. Newly rejected pathological configurations are
reported explicitly. No installed-channel CPU/count admission budget is added.

**Integration gate:** a typed internal `SubmitError::PlannerBusy` distinguishes
transient saturation from invalid configuration. In this isolated native candidate
only, v1 uses `rejected`, `channel-request-invalid`, exact detail `planner busy`.
The wire schema and TypeScript types are unchanged. This encoding must not land
as a permanent invalid-configuration suspension: separately allocated Node
reconciliation/retry work is required. RF admission agreement does not cover this
new overload condition or computational resource failures.

The smallest proposed Node change belongs at `ChannelizerManager.open`: recognize
only that exact busy reply, keep the logical operation pending, retry sequentially
under the original absolute deadline with bounded backoff/count, re-check process
generation and cancellation before each send, and map exhausted busy recovery to
`channelizer-unavailable`. Never retry genuine invalid/design-resource failures.
The manager currently serializes whole request/open operations per source. It
increments `s.pending` through reply and socket attachment, retires an idle process
only when both channels and pending are empty, and on a five-second timeout deletes
the waiter and sends `close`. Source invalidation resolves waiters as superseded
and retires the process generation; retries occur once against fresh caps.

The wire carries ID and generation but no per-open serial. Already-emitted replies
can still reach a new waiter after timeout/ID reuse; native serials only prevent
installation after a close the runtime has observed. Node reconciliation must
settle close/timeout ownership before resending/reusing an ID, or retire that
process generation when cancellation cannot be proven. This gate requires tests
of timeout-close-late-reply ordering, supersession, destroy and stable ID reuse;
no shared consumer edits are allocated to this lane.

## Local baseline

Twelve observations per representative rate, release build on this Mac. No
warmup observations discarded; this is cold channel construction, not cold OS
caches. `Runtime::open` median/maximum: 48 kHz 2.346/3.589 ms; 384 kHz
2.358/3.915 ms; 1 MHz 15.198/18.082 ms; 1.05 MHz 14.273/19.187 ms.
`RationalFir` state construction median: 0.006, 0.004, 0.015 and 0.015 ms,
respectively. Prototype planning dominates. The historical approximately 34 ms
measurement is not reused as a current result.

## Candidate measurements and evidence

Production measurements below used `d4372ccb81e2092f239ddc85d419c1a4022d2b90`.
The strengthened native candidate is
`fc35a974a902f624022e4412db21339496350c83`: its Rust changes after `d4372cc`
are exclusively `cfg(test)`; the additional process comparison and corrected
measurement-window accounting are standalone benchmark drivers. Final rebuilt
binary SHA256 is `3d8fa0e0af85ba166b8cca721e626597ff1a9813b98935c4031bf948ea1c4e34`.
The saved unmodified baseline binary at `ccc319f` has SHA256
`d4b95c06628100f823c06faf34650f1c232c079c891fa769ea5c35da6bf3bb04`.
Documentation is committed separately from these native commits.

Host: Intel x86_64 macOS Darwin 24.6.0, i5-1038NG7 at 2 GHz, four physical/eight
logical cores, Homebrew rustc 1.98.1. Other agents were working on this host; these
are sequential bounded runs, not quiet-host or Pi benchmarks. Release builds and
Rust checks used one compiler job. Twelve observations per rate, no discarded
warmups; complete per-observation distributions remain in the JSONL artifacts.

The Rust example separates submission from preparation completion (observed with
a one-millisecond polling sleep). Every cold observation creates a fresh runtime;
identical, offset, format and gain variants then reuse its immutable plan cache.
All entries below are median/maximum milliseconds.

| Output rate | Cold enqueue | Cold observed opened | Warm identical observed opened |
| --- | ---: | ---: | ---: |
| 48 kHz | 0.0022 / 0.0108 | 3.328 / 3.497 | 1.777 / 1.866 |
| 384 kHz | 0.0025 / 0.0068 | 3.281 / 5.373 | 1.833 / 1.932 |
| 1 MHz | 0.0029 / 0.0039 | 14.370 / 16.184 | 1.754 / 1.986 |
| 1.05 MHz | 0.0027 / 0.0035 | 13.349 / 15.173 | 1.757 / 1.872 |

Warm offset/format/gain completion medians were about 1.7–1.84 ms. Cold enqueue
removes filter design from the caller, while cold completion still pays for the
same verified filter. Enqueue timing alone does not prove IQ progress.

The process probe provides that separate evidence: it paces intact 4,096-sample
CU8 blocks at nominal 2.048 Msps, drains an existing pass-through channel, and
opens a filtered channel in a fresh process. The reported silence is the largest
consecutive socket-receive silence **clipped to request-send through opened**.
The full overlapping receive gap is retained separately; it can extend into the
subsequent close/join and must not be called an open-path stall. Receive timing
also includes OS scheduling and delivery, so it is not a direct CPU timer.

| Output rate | Baseline open median/max | Candidate open median/max | Baseline clipped silence median/max | Candidate clipped silence median/max |
| --- | ---: | ---: | ---: | ---: |
| 48 kHz | 3.560 / 4.436 | 5.793 / 20.985 | 3.443 / 4.230 | 2.317 / 16.542 |
| 384 kHz | 3.626 / 6.570 | 4.528 / 19.341 | 3.459 / 6.570 | 2.764 / 16.224 |
| 1 MHz | 19.484 / 28.587 | 17.725 / 55.991 | 19.109 / 28.273 | 2.693 / 12.324 |
| 1.05 MHz | 17.417 / 25.062 | 16.584 / 28.011 | 17.224 / 25.062 | 2.787 / 12.311 |

The wide-rate median progress interruption falls substantially. Completion latency
and noisy maxima remain; this does not establish a universal deadline. All 48
candidate single-open observations delivered 33,132,544 existing-channel samples,
with zero unreceived samples, reported gaps or queue drops. The corresponding
baseline delivered 32,874,496 with the same zero-loss result. Candidate output
was received inside every open window; deterministic worker-barrier tests
separately prove runtime input processing while preparation is blocked.

Actual short-run feed medians were approximately 2.05 Msps, with candidate minima
as low as 1.68 Msps. The probe is backpressured through stdin and does not reproduce
production fanout overflow. It supports local open headroom, not sustained
multi-channel capacity or absence of live RF gaps.

A further 48 mixed-process observations submitted same-plan/different-plan cold
work plus immediate cancellation, followed by identical/offset/format/gain warm
requests. All 39,034,880 existing samples arrived, zero reported gaps/drops, zero
canceled `opened` events, and successful exits. Whole burst-through-warm completion
medians were 80–84 ms; maximum 174 ms. These intervals include close/join handling
and must not be interpreted as pure planning time. Deterministic unit barriers
cover duplicate pending IDs, physical saturation, canceled queued/running/results
reservations, reclamation, recovery, and no completion starvation. Process tests
cover rapid close/reopen and shutdown during cold work. Source rate changes retire
the whole process generation; later Node integration must prove wire-event
ownership across that retirement, reconnect and timeout.

## Bounds, memory and intentional new rejection

The saturation process probe submits 16 cold requests with 16 MiB output queues:
four accepted, twelve exact `planner busy` replies, then successful recovery without
retry, no remaining sockets, exit zero. Burst-through-recovery took 74.137 ms.
RSS snapshots at ready/after burst/after close/recovery were 852/1,052/1,248/1,272 KiB.
These are sparse `ps` snapshots, not peak RSS; reserved queue capacity does not
eagerly touch every page. The 64 MiB bound is requested pending queue capacity,
not a measured resident-memory ceiling. Installed channels are outside that
aggregate bound, and no new active-channel capacity claim is made.

The allocation bounds cover all prototypes, including halfbands, not only cached
rational filters. Each prototype has at most 16,384 floats; each stage has at most
16,384 phase headers and 32,768 padded phase coefficients, plus two finite history
rings. A u64 rate permits at most 63 halving stages plus two rational stages, so a
conservative prototype-payload bound per plan is 65 × 16,384 × 4 bytes (4.063 MiB).
The verified normal matrix uses far fewer stages/taps. Design scratch is bounded
by the prototype limit (raw f64 taps and returned f32 taps); candidate storage is
bounded to 4,096 records. Cache coefficient payload is at most 512 KiB with eight
plan metadata records; a returned immutable clone and fresh DSP state can coexist.
Four completed preparation payloads remain covered by the physical reservations
and queue budget. Phase/vector headers, history, temporary copies and allocator
overhead are additional bounded allocations, so coefficient/cache bounds alone
are not presented as total process memory. Checked length/phase arithmetic avoids
wrapping the intended allocation limits.

A concrete previously accepted pathological request was tested on both binaries:
input 2.048 Msps, output 48 kHz, bandwidth 40 kHz, transition
`2.2250738585072014e-308` Hz (`f64::MIN_POSITIVE`), centre 162 MHz, CF32,
queue 4,096 bytes. Baseline release emitted `opened` with 94 taps and group delay
9.0078125 input samples. Candidate rejected with `channel-request-invalid`, detail
`invalid effective transition 0`. The effective transition rounds to zero during
planning; the old unchecked release design is not a verified acceptance contract.
Other new bounds can reject computationally extreme requests formerly attempted
without bounds; exhaustive enumeration of all such inputs was not performed.
There were no new rejections in the 28-case normal accepted rate matrix.

## Exact DSP and lifecycle verification

`open_equivalence.py` compares the saved **pre-change executable**, avoiding
common-mode agreement between refactored reference and worker code. Twenty-eight
cases cover 2.048/2.4 Msps input, 24/48/250/384 kHz, 1/1.05 MHz and pass-through
output, each in CU8 and CF32, offset 31,250 Hz, CU8 gain 1.7. Input contains
65,537 deterministic bytes submitted in 333-byte writes, including an odd final
byte; buffered writes do not guarantee native read boundaries. All encoded-output
lengths, SHA256, FNV64, tap counts and group-delay bits matched. The driver compares
hashes and lengths, not retained raw buffers directly. This is synthetic DSP equivalence, not a decoder golden/voice RF gate.

Baseline-derived output/tap/group-delay unit goldens are restricted to Intel macOS
because transcendental bit patterns may vary by platform. Universal coefficient
bit comparisons, independent stage references and proptest split/order checks
remain enabled on other hosts. A deterministic test cancels after three executed
response points inside a filter verification sweep; it does not depend on elapsed
time. Existing marker/gap reset and sample schedules remain tested. Planner
barriers test cancellation while queued/running/completed and reservation cleanup.

Validation results:

- Full native suite at `d4372cc`: 92 library, seven DSP property and six process
  tests passed (105). Strengthened `fc35a97` library run: 94 passed. Together these
  cover 107 native tests; the unchanged property/process suites were not broadly
  rerun merely to increase counts.
- `cargo fmt --check`, `cargo check --offline --locked -j1`, and
  `cargo clippy --offline --locked -j1 --all-targets -- -D warnings` passed.
- Final release binary/examples build passed, offline/locked with one job.
- Required `pnpm run typecheck` passed; `pnpm run lint` passed with 59 existing
  warnings and zero errors. Initially absent dependency links caused missing-tool
  failures; reversible ignored links to existing dependencies resolved them,
  without any dependency installation.
- Related manager/protocol/voice-IQ unit tests: 58 passed across three files.
- Final real-binary integration at `fc35a97`: six passed, including random ordinary
  admission cases and isolation of a stalled output channel. This does not cover
  the new overload contract or replace later Node reconciliation tests.
- Final rebuilt `fc35a97` binary compared with the saved baseline: all 28 output
  hash/length/metadata comparisons passed again, exit zero.

## Independent review and remaining landing gate

Astra MEDIUM architecture review raised physical accounting, cache/design bounds,
cancellation/lost wakeup, unverified stopband fallback and transient busy mapping.
The native implementation incorporates bounded work and allocation, cancellation
under the waiter mutex, reservation release after disposal and fail-closed design.
Main explicitly approved the candidate bounds and interim native wire encoding.

Independent Astra MEDIUM exact review of `d4372cc` found the native candidate
acceptable for review, with no additional native blocker. Its nonblocking requests
for pre-change output anchors and executing-design cancellation evidence produced
`fc35a97`. The bounded failure-path caveat remains: socket bind failure disposes a
prepared DSP/queue on the IQ thread; successful planning work is off-thread, but
not every possible failure-path deallocation is removed. No claim of universal
latency or aggregate active-channel CPU capacity follows from these bounds.
Fresh independent Astra MEDIUM exact review of `fc35a974a902f624022e4412db21339496350c83`
accepted the native candidate with no new native blocker and retained the Node
landing gate. It verified the baseline-derived constants against all 28 saved
records and the in-response checkpoint. Its proof-wording finding is resolved
here: the binary driver compares output hashes/lengths rather than raw buffers,
and 333-byte buffered writes do not guarantee process read splits. Existing
universal stage/property tests provide split-independence coverage. Real-binary
integration completed after the review's log inspection (six passed); the
reviewer did not run builds or claim integration completion.

**Final landing remains gated on separately allocated Node reconciliation.**
The unchanged consumer forwards `planner busy` as invalid, and decoder reconciliation
can retain an invalid suspension under unchanged capabilities. Retry must recognize
only the exact busy encoding, preserve one absolute five-second deadline, and
return unavailable on exhaustion. Timed-out/canceled IDs must not be replayed.
Generation/cancellation checks before send are necessary but insufficient when an
old wire reply lacks a serial. Confirm terminal/close ownership, use safely distinct
IDs, or retire the generation before ambiguous ID reuse. Deterministic delayed-open,
delayed-reject, timeout, cancel, reconnect, supersession and existing-channel tests
belong to that later allocation. No consumer or public protocol types were edited.

Pi timing, live RF/local-dongle reception, recorded decoder golden/voice-container
acceptance, and combined scanner plus audio gates remain unverified by this lane.
The application was not deployed, retuned or restarted; no default enablement,
buffer inflation, Docker build, dependency installation or new crate dependency.

## Reproduction and retained local artifacts

Run from this worktree, sequentially (baseline executable must be saved from the
exact base before modifying sources):

```sh
cargo run --manifest-path native/wavekit-chan/Cargo.toml --offline --locked -j1 --release --example open_latency
python3 native/wavekit-chan/examples/open_progress.py /tmp/wavekit-chan-open-baseline --samples 12 --scenario single
python3 native/wavekit-chan/examples/open_progress.py native/wavekit-chan/target/release/wavekit-chan --samples 12 --scenario single
python3 native/wavekit-chan/examples/open_progress.py native/wavekit-chan/target/release/wavekit-chan --samples 12 --scenario mixed
python3 native/wavekit-chan/examples/open_saturation.py native/wavekit-chan/target/release/wavekit-chan
python3 native/wavekit-chan/examples/open_equivalence.py /tmp/wavekit-chan-open-baseline native/wavekit-chan/target/release/wavekit-chan
WAVEKIT_CHAN_BIN="$PWD/native/wavekit-chan/target/release/wavekit-chan" pnpm exec vitest run tests/integration/wavekit-chan-binary.test.ts --maxWorkers=1
```

Local-only artifacts, not repository fixtures: `/tmp/wavekit-open-latency-baseline.jsonl`,
`/tmp/wavekit-open-candidate-latency.jsonl`, `/tmp/wavekit-open-window-baseline.jsonl`,
`/tmp/wavekit-open-window-candidate.jsonl`, `/tmp/wavekit-open-candidate-mixed.jsonl`,
`/tmp/wavekit-open-candidate-saturation.jsonl`, `/tmp/wavekit-open-equivalence.jsonl`,
`/tmp/wavekit-open-final-equivalence.jsonl`.
The older `progress` artifact uses full overlapping gaps and is superseded by the
`window` files for open-only interruption claims. Checks have separate
`/tmp/wavekit-open-{rust-tests,rust-strengthened,check,clippy,final-build,typecheck,lint-final,root-contract-tests,binary-integration}.log`
files; command and baseline environment provenance is retained separately.

Artifact SHA256 checksums (local files, to identify the exact retained evidence):

| Artifact | SHA256 |
| --- | --- |
| `wavekit-open-window-baseline.jsonl` | `7daa71d16f0ac2731e1dffde564eeb2178ff688ff4f78108bca6e2e72eedccd7` |
| `wavekit-open-window-candidate.jsonl` | `b2615619fc869cb2fa50f01481a99df8afc930c68c9bb622aa4b955e14db68b8` |
| `wavekit-open-candidate-latency.jsonl` | `2adad0284c17f2418e4b549c0ed3acc86a9028d54129c6c5b106927d7296e097` |
| `wavekit-open-candidate-mixed.jsonl` | `1df3443c755bfc1fef7541accea55a9878135c77e7406562a8439bd1f45e40b7` |
| `wavekit-open-candidate-saturation.jsonl` | `21847b72968b1e30f244d2c365ee3e0161d2b1dc5018d59803cdb684a6d27c64` |
| `wavekit-open-final-equivalence.jsonl` | `d83ba20a85dd8d3ef7fbb1f3d965fdcd4bd7bd81bfc3bf018f986d48cc856efd` |

## Node acquisition and terminal ownership candidate

The lane rebased cleanly onto `d452b0a66eff76fa2864d2d2d5cdbbce9412d336`.
The prior production/test/report patches are unchanged by rebase:
`d4372cc → 99c353ca1db3919452292abfd0093c191ecf7079`,
`fc35a97 → 4f74e3b11c47ac4e435f2506693f24e1222a742c`,
`66053e9 → 0f9ae6a14cc5047db6f09bc2f21008d4aabf68e2`.
Combined native/Node implementation is `e1a57400b490b0a7e2f511bce4ec297ae0c85ae2`;
test-fixture binding cleanup is `624625361abc44438adec952c496e9614461518a`.
The latter is the exact candidate submitted for independent combined review.

`ChannelizerManager` alone retries `channel-request-invalid` with exact detail
`planner busy`. Near matches, RF rejection and genuine design/resource failures
remain nonretryable. Five sequential backoffs (25, 50, 100, 200, 400 ms) permit
at most six **total** native open sends per logical acquisition, including the
existing single generation-supersession retry. Exhausted busy returns
`channelizer-unavailable`, not persistent invalid configuration.

One monotonic five-second deadline starts when the serialized logical acquisition
begins, excluding time queued behind another acquisition. It covers startup,
close-barrier waiting, replies, backoff and socket connection, and never resets
on busy or supersession. This is deliberately stricter than the old timeout,
which began after startup and did not bound socket attachment. All acquisition
timers use the remaining budget. Production uses `performance.now()`; the
crash-loop clock remains separate. Actual OS scheduling can delay timer dispatch;
the deadline prevents additional sends/adoption after expiry, not a universal
wall-clock return-time guarantee.

The core `ChannelProvider.requestChannel` accepts an optional fifth `AbortSignal`
without changing wire fields or public protocol types. Pre-grant IDs are not an
API: callers cancel pending acquisition with the signal. Queued cancellation
settles promptly and leaves a no-op queue callback; running cancellation wakes
acquisition waits, prevents resends/late grants, and performs bounded cleanup.
Failure details are manager-authored (`channel request cancelled`,
`channel request timed out after 5000 ms`, or unavailable); signal reasons are
neither propagated nor logged. Acquisition abort ownership ends at grant.
After grant, the caller synchronously stops accepting samples/evidence and calls
`releaseChannel` with the opaque granted ID, awaiting its settlement promise.

Stable IDs are retained. A closing record is installed before sending close or
destroying sockets. Repeated releases share that promise. A replacement using
the same ID waits for matching current-process/current-generation terminal
ownership. A rejected event can settle cancellation only while that particular
native open is still pending; after an opened event, rejection is not proof of
closure. Ownership state changes synchronously during event dispatch, including
multiple events before promise continuations. Late opened during closing never
connects or installs. Acquisition retains its ownership record through connection:
a terminal close during attachment refuses the grant rather than adopting a dead
channel. Late custom connection completion destroys only the returned socket,
without an ID-only close that could damage a replacement. The default connector
also destroys a socket still connecting when cancellation/deadline interrupts it.

Close settlement waits at most 250 ms, additionally bounded by the acquisition's
remaining deadline. Unknown native close emits no reply; if ownership cannot be
confirmed, the manager **retires the entire process generation**. At an expired
acquisition deadline it sends close and retires immediately unless a terminal
reply already settled ownership. Retirement synchronously invalidates remaining
grants once and destroys delivery, then stops the process; it is disruptive,
not a successful close or preservation of unrelated channels. It never starts a
replacement itself. Only an eligible uncanceled acquisition can consume its
existing one-time supersession allowance, still under the original deadline and
send cap. `channel-invalidated` retains its first three core arguments and adds
an optional fourth cause, so consumers can distinguish collateral retirement
from ordinary source or channel loss. Decoder/scanner consumers were not edited.

Independent Astra design advice identified a further native reuse prerequisite:
the writer formerly unlinked its socket immediately after accept, before checking
closing. A writer delayed beyond the bounded join could unlink a replacement's
same-ID path. `install_writer_connection` now guards unlink and connection
publication with the same mutex used to revoke the writer during close. Once
closing is set, an old writer cannot touch the replacement path. A deterministic
regression accepts the old connection, simulates close/rebind state, then resumes
the installation helper and verifies the replacement remains connectable. It does
not execute an actual timed-out runtime join. DSP arithmetic
and planning are unaffected.

Candidate validation:

- 27 touched Rust runtime tests passed, including deterministic same-path reuse;
  six native process tests passed; offline/locked one-job strict all-target Clippy,
  format check and rebuilt release binary passed.
- Rebuilt native binary SHA256:
  `0f6f85a9d664047de046e0690222c6a64baefc85851873ca22ba9e5390040206`.
  All 28 baseline output-hash/length/metadata comparisons passed again.
- 141 targeted root tests across seven files passed: existing manager (35),
  deterministic lifecycle (23), default connection cleanup (3), protocol (6),
  transport/process (10), decoder channelizer integration (47), voice IQ (17).
  Six real-binary integration tests also passed.
- The deterministic cases cover exact busy versus near-match/invalid, six sends
  including supersession, deadline across busy/rate change, queued/inflight/
  backoff/postreply/connect cancellation, late startup/connect cleanup, release
  repetition, same-ID barriers, late opened/rejected/closed ordering, close during
  attachment, destroy/source loss/reconnect and collateral retirement. Tests
  verify no acquisition timers remain after teardown, without timing thresholds.
- Final required root typecheck passed; lint passed with zero errors and 59
  existing warnings; the 23 affected lifecycle fixture tests passed again.
  Initial expected invalidation-argument assertions
  and a fixture typing/binding error were corrected; no skipped check is claimed.

Independent Astra final review accepted exact source candidate
`624625361abc44438adec952c496e9614461518a` against the stated base, with no blocking
findings. Its two nonblocking report corrections are incorporated above: completed
validation results and the precise simulated-state scope of the native regression.
The reviewer inspected retained evidence and ran no builds or tests. This approval
covers the scoped candidate, not consumer integration or Main's final assembly.
FIFO terminal-event ordering remains an assumption.

Optional signal support does
not establish end-to-end cancellation for existing consumers that omit it.
Scanner S2 owns post-grant intake fencing/evidence drain and direct-provider signal
adoption; decoder consumers keep their existing ephemeral-removal contract.
Those consumer acceptance gates, Main's exact assembly, Pi/live RF and combined
scanner/audio acceptance remain separate. No defaults or aggregate CPU/channel
admission budget changed, and no timing benchmark was repeated or relabeled.

The core invalidation event identifies exact source, generation and opaque channel
IDs, with an optional cause; it does not identify the decoder bound to each grant.
A grant can be installed and invalidated before the acquisition caller resumes.
The generation accessor records the last spawn and is not a liveness assertion:
retirement alone does not advance it. Decoder consumers therefore need exact
binding/invalidation coverage established before acquisition, and must refuse an
already invalidated or destroyed grant before publishing decoder creation. Mapping
opaque IDs by parsing, inferring capability or cutting the whole source is not a
substitute. That separately allocated consumer change remains a landing gate.

New local evidence files: `/tmp/wavekit-node-native-runtime-tests.log`,
`/tmp/wavekit-node-native-process-tests.log`, `/tmp/wavekit-node-native-clippy.log`,
`/tmp/wavekit-node-native-release-build.log`, `/tmp/wavekit-node-final-touched-tests.log`,
`/tmp/wavekit-node-binary-integration.log`, `/tmp/wavekit-node-final-equivalence.jsonl`,
`/tmp/wavekit-node-final-{typecheck,lint,fixture-tests}.log`.


A further optional disposal-witness implementation is being authored on top of
`f81b759fdb1fb50b045fcf9cbc2e59abc537ad97`. Its bounded local validation is complete; independent implementation
review is pending. The earlier measurements and approvals above
remain evidence for their exact earlier candidates only.

Logical release alone does not prove that a canceled planner reservation, prepared
payload, writer or connector has been physically disposed. The optional witness
uses a separate bounded local socket with process authentication during startup,
exact per-send tokens, and completion only after the corresponding native owners
have dropped their resources. Process cache and residual resources remain charged
until exact child closure. Default protocol parsing, configured four-argument
callers and DSP arithmetic remain compatibility requirements.

The Node observer separates a 128-credit receipt pool from one 128-unit ownership
pool shared by provider, process and send/local owners, plus 64 queued metadata
slots. Six receipts and twelve ownership units are reserved atomically at dequeue
with the applicable resource envelopes. Unknown cleanup retains ownership. An
absent eligible profile denies observed acquisition before effects; identity and
cleanup ownership do not require a fabricated resource budget.

Authored validation includes bounded transport/authentication and candidate cleanup
schedules, cancellation/startup ownership, exact non-FIFO proof reconciliation,
default compatibility, and native disposal progress with silent input/control.
A manager-to-native lifecycle test will also check repeated observed-channel
turnover while a configured channel keeps the same process alive. Its accounting
values are synthetic test fixtures, not a calibrated capacity profile. The lifecycle tests pass locally. Combined consumer acceptance, calibration,
Pi timing and live RF remain separate acceptance gates.


The released local validation ran serially, with one compiler job and one test
worker. Native coverage passed 106 library tests, seven DSP properties, six process
tests, three opt-in/default compatibility tests and four disposal tests. The seven
Node files passed 117 tests, including actual manager-to-native repeated turnover
while a configured channel kept the same process alive. The actual binary used was
this worktree's debug build; the test accounting envelopes were synthetic.

The first Rust check exposed a missing test type annotation. The first new disposal
run exposed macOS inheritance of nonblocking mode on the accepted test-reader
socket; the fixture now explicitly uses a blocking read with its bounded timeout.
Only that four-test disposal file was rerun. Root typecheck exposed narrow emitter
signatures and incomplete fixture caps; the owned types were corrected and the four
affected Node files passed 82 tests on rerun. Lint exposed five multiline union
indentation errors after formatting; named interfaces resolved them without a
runtime change. All first failure logs were retained. Final root typecheck, strict
Clippy, formatting and diff checks passed. Root lint passed with zero errors and
59 existing warnings. No timing benchmark or broad root suite was repeated.

Validation logs are retained under `/tmp/wavekit-r14-validation/`. Per-attempt
physical disposal and idle progress in these synthetic local tests do not establish
numeric CPU/memory calibration, an OS shutdown-time bound or consumer integration
acceptance. Process residual/cache charges remain until exact child closure;
unknown cleanup still retains ownership. The implementation review and Main's
assembly/adoption remain pending.
