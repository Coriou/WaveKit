# Channelizer research review and software priorities

Reviewed 2026-10-08 against the current source, Docker pins and the three research
notes. These are design findings, not new benchmark or RF acceptance results.
The [implementation proposal](superpowers/specs/2026-10-08-sample-rate-and-channelizer-design.md)
turns them into bounded milestones.

## Priorities supported by the evidence

Keep the source/decoder rate model first in the architectural sequence. It makes
lower capture rates understandable and provides channelizer requests later.
In parallel, fix the concrete CSDR buffering cost and source reconnect behavior;
measure again before attributing all overload to pipes or choosing a rewrite.
Then prototype one standalone core channelizer, preserving the raw path. Optional
SDR-host placement and protocol-aware scanning follow separate acceptance gates.

Hardware clean-card/reboot/hotplug and stable-power transport acceptance continue
in their owning session. They must not block independent software development,
nor be marked passed by local tests or running decoder processes.

## A lower-risk capacity correction exists

Pinned CSDR `1f15b8c5177cb348602da19e82bf0d62426ab8eb` uses a default ring
capacity of 10,485,760 elements and multiplies this by ten for `firdecimate`.
`runModule` allocates that ring for its input type. For complex float input,
104,857,600 × 8 bytes is **800 MiB of backing capacity per FIR**, mapped twice
for wraparound; the two mappings are aliases, not two independent physical
allocations. Actual resident memory depends on touched pages. This is directly
visible in the pinned [command definitions](https://github.com/jketterl/csdr/blob/1f15b8c5177cb348602da19e82bf0d62426ab8eb/src/apps/csdr/commands.hpp),
[module runner](https://github.com/jketterl/csdr/blob/1f15b8c5177cb348602da19e82bf0d62426ab8eb/src/apps/csdr/commands.cpp)
and [ring implementation](https://github.com/jketterl/csdr/blob/1f15b8c5177cb348602da19e82bf0d62426ab8eb/src/lib/ringbuffer.cpp).

The runner reads at most 1,024 elements per iteration. The ring's writable count
does not track unread reader distance, so enabling asynchronous mode is not a
safe substitute for sizing synchronous buffers. Preserve the upstream default
for general commands, opt in only reviewed streaming chains, and verify filter
lookahead/minimum capacity. Handle partial writes and interrupted I/O before
considering larger processing batches. These are separate changes with separate
integrity checks.

## Corrections to the exploratory notes

1. **Consumer count and channel centers.** The shared-channelizer note says six
   consumers but lists four audio and four IQ frontend consumers, plus readsb.
   The base frontend has no general frequency translator, but “every decoder
   decodes the center” is too broad: dumpvdl2 accepts channel frequencies and
   capture center and can decode multiple offsets internally. The pinned
   [dumpvdl2 README](https://github.com/szpajder/dumpvdl2/blob/3f583da4957d6c74668eb174e6ecd8c1435fb25b/README.md#processing-recorded-iq-data-from-file)
   documents IQ rates at multiples of 105 kHz and explains center/channel tuning.
   WaveKit's current 1.05 Msps output is therefore not proof of a protocol-wide
   1.05 Msps minimum. Audit each decoder's existing internal channelization.

2. **Rate arithmetic.** From the note's own `outputRate = fs × M / N` equation,
   `fs=2,400,000`, `N=32,000` gives integer M for 12,000 (160) and 22,050 (294).
   At `fs=2,048,000`, `N=1,024`, 12,000 also fits (M=6); 22,050 requires N to
   be a multiple of 40,960. Thus the claim that neither audio rate fits either
   source is incorrect. Keeping a small audio resampler can still simplify the
   design. Bin arithmetic alone does not establish overlap/filter correctness.

3. **Pi shared-frontend experiment.** Experiment G first decimates the entire
   capture by eight, then shifts four channels within the remaining band. It
   demonstrates sharing for clustered channels, not four independent channels
   anywhere in the original approximately 2 MHz capture. Reproduce the workload
   with offsets spanning the original capture before claiming general capacity.

4. **Performance confidence.** The recorded short runs are useful leads, but
   user CPU time also depends on hardware/compiler/vectorization and is not
   portable as a fixed number. Large rings, page faults, VM pressure, pipe batch
   sizes and output integrity must be controlled before assigning system time
   entirely to pipes. Retain scripts and exact revisions/configuration in the
   next measurement. Current live runtime uses OrbStack; verify the research
   note's “Docker Desktop” label rather than copying it as an established fact.

5. **Fast convolution and implementation size.** A shared forward transform
   still leaves per-channel inverse transforms, filters, resampling and delivery.
   It is not flat-cost channel growth or exact rates “for free.” A robust process
   with control protocol, discontinuities and lifecycle is larger than the DSP
   kernel; estimates of a few hundred lines are not delivery commitments. Compare
   implementations after specifying quality and latency, not just FFT timings.

6. **Available fixtures.** `fixtures/manifest.yaml` contains duplicate
   `sigid_vdlm2` IDs, unknown/estimated rates and an explicitly audio-only VDL2
   reference. Parser outputs and process startup tests are not IQ decode goldens.
   Repair metadata and acquire/verify actual IQ fixtures before treating the
   proposed golden suite as available coverage.

7. **Captured bandwidth.** A larger resampled output rate does not restore a
   signal outside the capture. Check occupied bandwidth plus transition margin,
   not only center offset. A blanket 250 ksps audio-decoder capture minimum is
   also unsupported by the existing narrower recorded fixtures. Distinguish
   documented implementation constraints from measured RF limits.

8. **Remote transport totals and fallback.** Channel-only delivery helps only
   when no remote raw consumer still requires the whole stream. Count unique
   remote raw streams plus channel streams; running both can increase traffic.
   A host CPU overload must not automatically fall back to a raw mode already
   known to exceed link capacity. Plan bounded admission/suspension with reasons.
   The research's “under 3 Mbit/s” example covers three 48 ksps CU8 channels,
   not the full listed decoder set.

9. **Placement and ABI.** A standalone process is a useful crash boundary and
   shell-testable artifact. Node version churn is not the right general objection
   to a Node-API addon: [Node-API guarantees ABI stability](https://nodejs.org/api/n-api.html#node-api)
   when only its supported interface is used. Platform packaging and native crash
   risk remain reasons to prefer a process here. Selecting Rust does not by
   itself change architecture or remove obligations attached to reused code;
   record actual dependency licenses without treating process separation as a
   blanket licensing conclusion.

## Evidence gates

The immediate software gate is deterministic synthetic/recorded input with zero
unexpected sample loss, bounded queues/memory and preserved output. The RF gate
is expected messages from known captures for each decoder, including weak and
off-center signals. The capacity gate is repeatable 1/4/8-channel CPU, memory,
latency and drop measurements against the corrected baseline. The hardware gate
is a separate stable-power installation/streaming/recovery run. Passing one gate
does not imply the others passed.
