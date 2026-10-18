# Reliability and portable receiver roadmap

Updated 2026-10-12. The immediate software sequence is below; numbered sections
track related work and acceptance rather than blocking all work on hardware.
Software checks and hardware
acceptance are separate: a healthy process or passing unit suite does not prove
continuous IQ reception, correct RF decoding, or unattended installation.

## Immediate priorities (re-ordered 2026-10-12)

Done since 2026-10-08 (merged on main): Mac core deploy with tuner reconnect sync
and stall watchdog; trustworthy full suite; rate model B1–B4 (per-instance rates,
reversible suspension, `restarting`/crash-loop `faulted` health); bounded CSDR
rings default on (overnight soak: 0.0 % decoder loss, ~18 MiB vs ~5 GiB); the
2026-10-09 overnight follow-ups (rate-truth `rateMismatch`, band-aware
suspension, tuner `unknownFields`, persistent journal and boot report on the
Pi image); decoder band defaults with regions, persisted per-decoder band
overrides and operator-start pinning; `source:removed`; the signal-flat source
warning; the Pi operator page redesign on a single port 80 and the brand kit.

The CLI overhaul and core channelizer are merged and included in the main push
at `63c9c49` (2026-10-10). Channelizer golden/voice gates passed for seven
adapters; `channelizer.enabled` remains false. The
[capacity report](CAPACITY-2026-10-10-CHANNELIZER.md) records N=1/4 passes and an
N=8 conditional pass: the shared input branch dropped 1.4–2 % under a four-CPU
quota, versus zero with six CPUs. Combined scanner/audio capacity and live RF
acceptance still need measurement.

The next connected web milestone is **spectrum → tune → identify → inspect →
listen**. The web dashboard is in design on `design/web-dashboard`; its
`docs/web/CORE-GAPS.md` (re-checked at `49aa3fe`, 2026-10-12, against main at
`6b4e5dc`) supplies the feature inventory mapped below. Since the previous audit it
adds a layered band-plan package (country packs, imports with provenance, operator
edits, station country), per-client FFT size and averaging, analog transmission
events and more precise scanner items. That design remains separately owned and in
progress; web UI implementation requires a separate decision.

Owner decisions on 2026-10-12: the decode envelope uses the eight web/brand
categories (aircraft, marine, aviation data, voice, paging, APRS, sensors, mesh,
plus `other`) with an entity key and an optional position; the regional registry
stays the verified layer that band plans link to; built-in scan band plans are
corrected from cited regulator documents.

Landed in the 2026-10-12 web-gap batch: station identity with provenance
(`GET /api/station`), the amended envelope spec and helper, `live-audio:level` and
manual/auto squelch without pipeline restarts, per-decoder `rateHistory` and a
bounded `GET /api/decoders/:id/log`, per-hop scanner protocols, automatic resume
held by identify and live listening (`resumeAt`, `resumeHeldBy`, Stay here), and
cited built-in band plan corrections (EU airband, PMR446/dPMR446, CB, 169 MHz
metering). Still open from that list: recording activity as a resume hold and an
EU 466 MHz pager plan without a citable primary source (noise squelch landed in WG7).

Landed in the 2026-10-13 web-gap batch 2 (WG2, core only, [spec](specs/web-gaps-2/requirements.md)):
Activity presentation (category, protocol, entity key, title, fields, position)
with APRS and Meshtastic position coalescing; APRS station/object/item and
Meshtastic node trackers with REST routes and `aprs`/`mesh` channels; a 2 s
per-entity throttle on vessel, APRS and mesh updates; CTCSS and DTMF on analog
transmissions; strict AIS NMEA checksums; DMR/P25/NXDN call metadata; device
names, kinds and coarse last-seen; Ignore (lockout) skips sweeps; per-job scanner
hit statistics; a Mic-E position fix (West longitudes were decoded as East, and
the speed/course offsets were missing). CLI changes: its credential reader accepts
the version 2 session snapshot, and APRS speed is labelled in knots. No web change.

Landed in the 2026-10-16 web-gap batch 4 (WG4, core only, [spec](specs/web-gaps-4/requirements.md)):
bulk position trails from Activity (`GET /api/activity/trails`); a visibly
approximate station location (`GET /api/station/estimate`, never authoritative);
a bounded storage report (`GET /api/storage`); a client-writable station identity
(`PATCH /api/station`, protected mode, persisted UI layer); live-audio AGC
off/slow/fast including FM; the AIS radio channel on ship output; Meshtastic GPS
fix time; the SDR host version; and the APRS repeated-digipeater `*` marker on
live direwolf paths. Open: csdr `-p slow` support awaits an image smoke test, and
the Pi CPU cost of trails and AGC is unmeasured. No CLI or web change.

Landed in the 2026-10-17 web-gap batch 10 (WG10, core only, [spec](specs/web-gaps-10/requirements.md)):
live audio that keeps playing through restarts (silence fill, clients kept) and
click-to-tune without a pipeline restart (front-stage swap; offset-change gap p90
1 039 ms → 23 ms in a loaded stand-in bench, zero disconnects); an auto squelch floor
that a strong FM carrier cannot seed; the first operator tune on a connection proves
the held sample rate, so trust labels turn `commanded`; untracked-retune root cause
work with `suspected` / `lastCommandAgeMs` warning fields and a rate-limited warn
log; identify for analog voice from live-audio transmissions (`result.analog`,
CTCSS/DCS) and `result.decodersUnavailable` with a 300 s unavailable-decoder memo;
no startup warning for a passive scanner job before its source connects; analog voice
activity hygiene (a deliberate behaviour change): squelch re-opens within 1.5 s merge
into one transmission, transmissions under 500 ms and nfm/wfm ones without FM-quieting
carrier evidence are not published (WS, Activity, identify), while live audio gating is
unchanged. No CLI or web change required.

Landed in the 2026-10-18 web-gap batch 11 (WG11, core only, [spec](specs/web-gaps-11/requirements.md)):

- **Identify quality.** A squelch opening without CTCSS or DCS is now `heard`, not
  `decoded` (new trial outcome); analog evidence no longer stops digital trials;
  `nxdn48`, `dpmr` and `dstar` are tried on 6.25 kHz rasters (last narrow run ends
  about 10.6 s in, inside the default 15 s); a discovery's known decoded protocol is
  tried first and forgotten after 2 full-hold misses; a cancel of an ended job is a
  200 no-op.
- **Band-scan DMR root cause** (see [SCANNER.md](SCANNER.md#why-a-dmr-band-scan-found-only-heard-signals-wg11)):
  young sweep tracks were classified as OOK bursts (no probe mode) because sweeps
  saw no band ISM prior; the dsd-fme `auto` hold was 600 ms, under a DMR late
  entry. Both fixed (band prior outside the OOK SRD allocations; 1 800 ms hold).
- **Passive CPU guard.** Configurable limit (`scanner.passive.maxEngineUtilization`,
  default 0.25), a windowed re-check every 5 min with an 80 % clear threshold, and
  a 15 min probation for a source whose engine closed.
- **Scanner store CPU** at 10 000 discoveries and 50 000 observations (budgets in
  brackets): ingest 41.5 µs (≤ 50; it did not finish in over 10 min before, and grew
  roughly with n³: 2 148 µs at 2 000 discoveries), progress counts 1.1 µs (O(1);
  65.5 ms at 3 000 before), steady snapshot 1.71 ms of main-thread time (≤ 5 ms; a
  worker writes it; 335.5 ms on the main thread at 3 000 before), event-loop p99
  2.9 ms. The first snapshot after boot or a reset still runs on the main thread
  (1.2 s at that size).
- **Configured gain on connect.** `sources[].tuner` (`gainMode`, `gainDb`,
  `agcMode`) is written on every new connection with tuner command origin `config`;
  values set through the API or the relay keep precedence. At most 3 commands per
  connection; without the key nothing changes.
- **Stable tracks on spectrum frames.** `trackId`, `snrDb`, `peakDbfs`, `blocks`,
  `ageMs`, `surfaced`, `flags.spur` and the scanner's discovery identity, stable
  across the tracker's 120 s rollover; at most 260 B more JSON per track (typically
  105 B, 217 B with the identity). Frame build plus stringify at 64 tracks went from
  182 to 637 µs in a loaded bench; the identity lookup reads the store without a
  clone.
- **IQ capture on detection** (protected mode, off by default): `wavekit-iqcap`
  keeps a 2 s ring per source and writes up to 4 s of 48 kHz cf32 per transmission
  (≤ 1.5 MB each, 256 MiB total); a FIFO queue replays it into dsd-fme, multimon-ng
  or direwolf after the transmission ended (68× to 384× real time), the result lands
  on the observation and the capture is deleted at once (orphans after 10 min).
  Tool cost 0.06 to 0.14 cores with 2 captures active at 2.048 / 2.4 Msps, about
  11.4 MB per source; the tap feed left the event-loop p99 unchanged (2.06 ms).

No CLI change: the CLI guards accept `heard` and `replay` and strip the new frame
track fields and the `config` origin. The web outcome-label map needs a `heard`
entry ([CLI-COORDINATION.md](CLI-COORDINATION.md)).

Open after WG11:

- IQ capture: the native tool and Node prove the capture directory chain before
  every create, link and remove, but a swap between the proof and the syscall is
  still possible; closing it needs directory-relative calls (`openat`, `unlinkat`)
  through a libc dependency in `wavekit-iqcap`. A protocol-violating `captured`
  event after the tool's own `aborted` for the same id leaves a stray file until the
  next startup sweep. The replay result carries no `crcClean` and is treated as a
  clean decode. A capture requested right after dropped samples can be refused.
  The tool's resident memory with a full ring is arithmetic (8.2 MB), not measured.
- Known protocol: a protocol covered only by a probe's last mode (`nxdn96` in
  dsd-fme `auto`) never takes a miss from a scan job (safe direction: it stays
  first, every other trial still runs); only identify decays it.
- Scanner store: `evictionVictim()` still scans every discovery for each new one
  once the store is full; a snapshot above V8's maximum string length (about
  10 000 discoveries × 256 observations) cannot be built at all.
- CLI: its guards strip the new frame track fields and the `config` tuner origin; a
  follow-up if the CLI wants to show them.
- Live acceptance: heard versus decoded on a PMR446 handheld with and without
  CTCSS, a 6.25 kHz digital identify, passive coming back in a container, gain
  after a receiver reconnect, and IQ capture identifying a short transmission
  after it ended.

### Performance and native DSP plan (2026-10-17)

A read-only performance audit of the core found that the cost is dominated by two
things: full-rate IQ copied into one csdr process chain per analog consumer (with
pipes and format conversion between stages), and the JavaScript FFT of the
detector spectrum. Node itself is not the bottleneck; the main thread mostly routes
buffers. The detector FFT (radix-2 in JS, N = fs/1000, so 2048 at 2.048 Msps, every
sample transformed) costs 6–8 % of a Mac core but saturates a Pi 3B core (0.99, §8).
On a Pi 3 four independent decoder chains need 5.37 cores where one shared front
end needs 0.99 ([Pi channelizer research](RESEARCH-2026-10-08-PI-CHANNELIZER.md)).

Direction: grow `wavekit-chan` into the single per-source Rust DSP engine. It
already reads each source's CU8 stream once and serves channels over Unix sockets.
It stays a child process (crash isolation, already built and tested in the image,
warm channel opens of a few milliseconds, no blocking of the Node event loop); an
N-API binding would only pay for small, frequent synchronous calls, which none of
these are. Spectrum frames get a small binary framed side channel; channel and
audio streams stay raw. Ideas and published algorithms are taken from SDR++ (one
front end and a splitter feeding every VFO and the FFT, retune by changing only the
NCO phase increment, re-tap without losing filter history, multistage power-of-two
decimation, peak-follower AGC, hysteresis squelch); no code is copied. The rules
every hot-path change follows are in [PERFORMANCE.md](PERFORMANCE.md). Web-UI
features come first; an optimisation is scheduled as a feature when it is the
cheapest way to ship one.

Now:

1. **Viewed-slice zoom as a `wavekit-chan` zoom output, plus an in-place `tune`
   request.** NCO and decimation to the viewed span with the existing channel
   chain, then a small windowed FFT (`rustfft`) at 5 transforms a second or less,
   framed to Node. A 128 kHz span at 2.048 Msps (÷16) with a 4096-point FFT gives
   31.25 Hz bins, the same resolution as a full-rate N 65 536 transform, for the
   cost of one decimating channel (about 0.1 Mac core in the capacity report) and
   no main-thread work. `tune` changes the NCO phase increment so the slice pans
   without a close and reopen. This replaces the JavaScript-worker zoom decision
   in §8. The truthful-axis contract of the viewed-slice design still holds: the
   output reports its own `Fs/N`, window, NCO and passband ripple, and resets at
   gaps and seams. Tests: a golden tone at a known offset (bin, `Fs/N`, ENBW),
   chunk-split invariance, and a comparison with the JS zoom bench.
2. **Quick wins.** Delete `src/core/format-converter.ts` (only its own unit test
   imports it). In the spectrum worker, keep the Zod parse for `init` and control
   messages but use a cheap structural guard on the hot `input` message (an
   internal, transferred boundary), and drop the extra `bytes.slice()` copy in
   `FrameSource.push` (the engine already pools transferred buffers). Measure
   both worker changes before and after.

WG12:

- **Rust live demodulator, phase A**: a `demod` channel kind in `wavekit-chan` for
  NFM and AM with in-place retune and bandwidth re-tap, power squelch with
  hysteresis plus the existing noise squelch, feeding the current HTTP live audio
  and then the planned 48 kHz WebSocket stream (§5b). It sits behind a config flag
  with the csdr chain as the fallback. It removes two shells and 4–9 processes per
  listener, the restart gap on bandwidth and mode changes (offset changes already
  swap only the front stage since WG10) and the csdr dependency that has no macOS
  build. Tests: synthetic FM/AM with SINAD bounds, phase continuity and no sample
  gap across a retune, A/B against csdr on fixtures, squelch latency goldens, and
  CTCSS surviving the chain.
- **Drag retune and a wide-band panorama** in the web dashboard, built on the Rust
  zoom output and `tune` (see the drag-to-tune measurement in §8).

Next:

- Rust demodulator phase B: WFM stereo, SSB/CW/DSB, AGC modes in the engine, noise
  blanker and notch (the §5b audio DSP item).
- A Rust detector frame engine (convert, window, FFT, power and block
  accumulation), with floor, detection and tracking kept in the TypeScript worker
  and the JS backend kept as the fallback. It must match the existing detector
  goldens across backends; it unblocks per-client `fftSize` up to 16 384 and
  higher bin caps on modest hosts.
- DC blocking, IQ swap and optional IQ imbalance correction once per source in the
  engine, opt-in per consumer (the §8 DC/IQ item); then remove the ignored
  `iqDcBlock` flag.

Later:

- Channelizer internals: reused scratch buffers instead of per-chunk
  allocations, an f32 NCO with block resync that vectorises, and more than one DSP
  thread (today one thread runs every channel's DSP, which limits headroom at
  N = 8 in the capacity report). Re-baseline the bit-exact properties deliberately.
- Channelizer on by default and csdr retired for IQ consumers (`IqDecimateDecoder`
  and `AudioDemodDecoder` read channels; analog decoders read `demod` audio). Ship
  the binary everywhere first: a missing binary must not suspend decoders.
- Scanner evidence and recorder DSP (the JS channel decimator and FM demodulator)
  moved to engine channels and demod outputs.
- An FFT fast-convolution filter bank, only if the channel count grows past
  about 16.
- Smaller JavaScript clean-ups while those paths remain: one preallocated block
  assembler for live-audio squelch instead of two re-blockers, `Float32Array` views
  instead of per-float reads, one reused buffer for muted blocks and for the paced
  PCM output, and an f32 radix-4 JS FFT as a stopgap fallback.

Not planned for Rust: tone detection (Goertzel banks), level tracking, the audio
client registry, the tuner relay, and the access and API paths.

Order of the remaining core gaps, by what they unblock in the dashboard:

1. **Event foundation**: envelope publication, a persistent event store with
   search and facets, and replay from a cursor for activity and scanner events
   (Activity, Recordings, map history; §4, §4a, §5c).
2. **Browser access end to end** before browser controls touch the receiver
   (onboarding, renewal, TLS/proxy acceptance, operator data in the default
   deployment; §4). Read-only views and a mock data server do not wait for it.
   Batch 1 landed server-side: browser-lifecycle acceptance tests, machine
   device administration, `make dev-protected` and an opt-in Caddy TLS compose
   profile. Live TLS/browser deployment acceptance remains.
3. **Band plans and settings**: the layered band-plan model fed to the scanner and
   spectrum labels, a persisted settings store with provenance, and core scan
   presets. Batch 1 landed server-side: the band-plan model, a layered resolver,
   a dedicated store with provenance, SDR++ JSON file import with preview,
   built-in and operator scan presets and the `/api/bandplans` REST routes.
   Batch 2 landed server-side: the scanner reads the effective
   built-in plans of the stack (hidden bands leave it), import commits bind a
   preview digest, a never-persisted legacy store reports `storeId: null`, and a
   `bandplans` WebSocket channel announces changes. WG5 added SDR# XML and Gqrx
   CSV import. WG6 added import by URL from an allowlisted host (protected
   mode, SSRF-hardened fetch) and a manual check for update. WG7 stores the
   committed group overrides so the update check applies them, aligns the URL
   schema with the fetcher, and lets a scan opt in to band-plan `skip` bands as
   exclusions (`skipBandPlanSkips`). Remaining: CLI and
   web consumption, verified packs
   (gated), a general
   settings store with YAML/env/UI provenance (WG8 landed the decoder-scope
   store: decoder options and `enabled`; station, scanner and live audio keep
   their own layers), and country from the station location (gated).
4. **Scanner and listening follow-ups**: scanner follow-ups batch 1 landed
   server-side: running-range edits (enable, protocols, name, dwell and
   sensitivity per range, applied at the next hop), signals-only jobs, the
   preempting job on a preempted job, and discovery identity search. CLI and web
   consumption is a follow-up. Remaining: recording activity, then S2/S3
   acceptance (§5, §5b).

Software, local-receiver acceptance and optional Pi acceptance have separate
gates. The detailed workstreams:

1. **Connect clients to the accepted S1 contracts** (§5, §8). S1-A and S1-B
   landed locally, including identification, bounded burst capture and shared
   spectrum profiles. The CLI now consumes them in `6 Scan`: source selection, spectrum/waterfall,
   discoveries, confirmed frequency-target identify submission and retained job
   inspection, with explicit recovery and bounded reads/history. Cursor tuning
   remains the next client action; web consumption and physical-terminal
   acceptance remain open. Preserve detector behavior independently of display
   preferences; genuine viewed-slice zoom remains a separate follow-up.
2. **Close browser access gaps and prepare spectrum foundations** (§4, §8). The initial access
   target is one operator on a local/LAN deployment, with authentication and
   explicit origins across REST, WS and audio. It must land before connecting
   browser controls to the live receiver. Protected pairing and session refresh
   and exact public bootstrap/capabilities plus session-only device inventory are
   implemented. Server-side browser lifecycle acceptance, machine device
   administration and a reference TLS profile landed in browser access batch 1;
   the shell's trust anchor is its configured API origin. Browser client
   consumption and live TLS/proxy acceptance remain open.
   Operator data is protected-only while the default deployment remains legacy;
   changing that default is a separate decision. Regional registry and
   receiver-capability read-only routes are implemented and software-validated in protected and legacy modes, including API drain,
   provider disposal and source teardown ordering.
   US FRS numeric data remains evidence-pending, and physical support/current
   values remain unknown. Preserve existing scanner ranges and defaults.
   The genuine higher-resolution viewed-slice FFT design is landed, with raw-seam,
   budget and transport feasibility gates before implementation; cropping existing
   display bins is insufficient. Measure coalesced REST drag-to-tune latency before
   choosing a WS tuning transport, preserving tuner arbitration either way.
3. **Complete S2 acceptance, then S3 listening** (§5, §5b). Reviewed channel
   settlement, scanner consumer and shutdown composition are integrated locally.
   The channel tier defaults off, the measured private profile is absent and
   production producer binding remains disabled. Guarded IQ capture is still
   required and incomplete; finalized analog cleanup without proof remains
   unknown, so successful physical reuse is deferred. Establish calibration,
   combined capacity and recording cleanup evidence before activation. CLI/web
   work can proceed against truthful capabilities without waiting for every Pi
   acceptance test. S3 monitoring and mixed-mode listening remain follow-ups.
4. **Shared Activity, operator data and recordings** (§4a, §5c). Design event
   identity/envelope, persistence, search and replay together; link scanner
   discoveries and observations rather than replacing their recovery stores.
   Establish recording catalog and deletion ownership before per-recording
   Keep, trims and downloads. Saved frequencies and shared settings use the
   same public contracts for CLI/web. Design may run alongside scanner; shared
   storage/audio integration follows settled S2/S3 contracts.
5. **Live identification and channelizer acceptance** (§3, §5). Close the loop
   with scanner captures promoted to decoder fixtures, S4 detection/false-alarm
   checks and live raw/channelizer A/B. Enable-by-default is a separate decision
   after the live evidence. On a Pi-class host, fix open-time filter design
   stalling input before enabling the channelizer there. The earlier no-code
   signal diagnostic is complete; artefact rejection remains part of identify.
   This acceptance proceeds independently of Activity/catalog implementation.
6. **Richer listening, recordings and maps** (§5b, §5c, §8b). Follow the shared
   foundations with tone squelch, audio DSP controls, manual recordings,
   viewed-span IQ capture/playback, durable position trails and coverage.
   Station location and basic existing-position display can ship earlier as
   bounded tasks. Full map/offline assets and transcription are later scopes.
7. **Parallel acceptance and release work**. The next Pi image candidate
   (`operator-20261009b`) still needs stable-power clean-card acceptance:
   deliberate reboot/boot report, hotplug, Ethernet, a 30-minute baseline and
   soak without an external SDR++ client. Coordinate receiver and Docker build
   windows. Diagnose the CI bake override and validate ARM64 without publishing
   before enabling automatic multiarch GHCR publication (§11). Agent setup
   consolidation (§10) remains a separate maintenance task.

Live-audio evidence from 2026-10-09 remains valid: silent idle squelch, clear
NFM at an offset, intelligible DMR and two PTT presses producing two calls.
Open follow-ups include real-RF acceptance of the WG7 squelch noise tail fix
(the ~0.75 s tail is fixed in a synthetic pipeline test), a DMR call ending by
fallback timeout when its terminator was missed, and lazy live-demod start.
Most measured playback lag was ffplay buffering; measure actual client stages
before changing buffer defaults. See [DIGITAL-VOICE.md](DIGITAL-VOICE.md).

The [channelizer research review](REVIEW-2026-10-08-CHANNELIZER.md) records the
buffer finding, corrected rate arithmetic, limits of the Pi benchmark and missing
fixture evidence. Exploratory research is not a final implementation spec.

### Historical status at end of 2026-10-08

This records the earlier checkpoint; the current landing status is above.

- CLI requests 1–4 are merged: `source:status` and `decoder:status` WebSocket
  events and additive `DecoderStatus` fields (`sourceId`, `targetFrequenciesHz`,
  `lastError`, `idleTimeoutMs`, `deviceSerial`). Configured `health.idleTimeout`
  and `checkInterval` now reach the decoder manager.
- Bounded CSDR rings are merged behind `csdr.boundedBuffers` (default **on** since 2026-10-09) for
  harness-validated stages only. Native outputs are byte-identical to upstream;
  the live app's CSDR ring memory was measured at about 5 GiB versus about
  9 MiB when bounded. A synthetic all-decoder run on a heavily loaded host was
  CPU-bound (most IQ dropped either way), so throughput is not established.
- Tuner reconnect synchronization and an rtl_tcp stall watchdog are merged: last accepted tuner state is replayed on the first payload of a new
  session (`tuner.reconnectPolicy: restore|reset`), rejected relay rates no
  longer change caps, and a silent connected rtl_tcp session reconnects after
  `stallTimeoutMs` (default 15 s). This fixes two observed live failures: stale
  rate metadata after a receiver reboot, and a half-open connection that never
  reconnected.
- The rate-model instance/suspension design is written and reviewed.

The Pi image/operator-page and CLI teams continue independently in their owned
files. No software milestone substitutes for hardware acceptance.

## 1. Reproducible SD-card installation

A flashable WaveKit SD image and dedicated Imager launcher are now built locally.
The intended onboarding is: select WaveKit in Imager, configure network/account/SSH,
write, boot. Physical clean-card acceptance and release distribution remain pending;
the older manual staging workflow is retained for development and recovery.
The operator-page candidate (early setup page, persistent Wi-Fi policy) was
written to a fresh card on 2026-10-08 and passed its own clean-card run on Wi-Fi
with no runtime patches: first boot, mDNS and key-based SSH, the early setup page
throughout installation (it reported the full page ready only once that page
answered), unattended installation in about six minutes, the full operator page,
Wi-Fi power saving off after the first boot and after a reboot, receiver reboot
recovery and physical USB hotplug recovery (sampling resumed about 8 s after
re-enumeration). Ethernet was not tested. Earlier patched-runtime hotplug evidence
and the earlier candidate's results remain separate claims.

- [x] Build a reproducible flashable WaveKit image from a pinned Pi OS base,
      embedding the verified receiver bundle and automatic first-boot setup.
- [x] Supply an Imager manifest with customization metadata so account, Wi-Fi
      and SSH setup work without post-write commands or preinstalled credentials.
- [ ] Validate the actual distributed image from a fresh write without manual
      payload staging or repairs on the Pi.

- [x] Provide a documented Imager → stage → eject → boot workflow for 64-bit Pi OS.
- [x] Stage optional SSH public-key access without copying private keys or requiring
      a manual SSH multiplex session. Normal receiver operation must not need SSH.
- [x] Preserve Imager accounts, Wi-Fi, SSH policy, and existing cloud-init commands.
- [x] Validate bundle integrity and platform before installation; retain explicit
      failed/running/complete status and actionable recovery logs.
- [x] Verify first-boot root installation with password-required sudo accounts.
- [ ] Repeat installation on a freshly written card: Wi-Fi, Ethernet, mDNS, direct
      SSH, Docker startup, dongle detection, reboot and receiver hotplug recovery.
      Wi-Fi path passed on the operator-page image (2026-10-08); Ethernet pending.
- [ ] Recover the laptop's IQ stream automatically after a receiver reboot or
      hotplug. Observed failure: the core kept a half-open connection marked
      connected/stale and never reconnected. Fix (stall watchdog) is merged and
      deployed to the Mac; repeat acceptance against the new image on stable power.

The 2026-10-08 Wi-Fi run passed unattended installation, direct key-based SSH,
receiver startup and reboot recovery. USB reattachment exposed a stale receiver
handle; a subsequent runtime fix passed a physical unplug/replug test with IQ
resuming automatically. That runtime test does not count as a pristine image
pass. The operator-page image later passed the clean-card Wi-Fi run described
above. Ethernet and sustained loss-free streaming remain unverified; that run
logged nine brief undervoltage episodes (including three right after the dongle
was re-plugged), a weak Wi-Fi link and substantial delivery loss at times.

Validate SD writing, unattended first boot and sustained streaming separately.
Current development hardware has repeated undervoltage and substantial IQ loss
over Wi-Fi in earlier runs. Confirm stable power before the next baseline
and soak; record power events separately from installer failures. The next
image candidate still needs its own clean-card acceptance. Before erasing,
verify the corrected payload and identify the actual target disk again.

## 2. Network performance and portability

Software policy and transport research may proceed while hardware acceptance is
pending. Coordinate any live receiver/network changes with the hardware session.

- [ ] Measure native and container delivery separately on Ethernet and Wi-Fi:
      generated/delivered/dropped bytes, stalls, latency, CPU, memory and power.
- [ ] Establish a 30-minute continuous baseline at the selected sample rate, then
      test multiple clients, slow clients, disconnections and automatic recovery.
- [ ] Investigate Wi-Fi power saving, interference, channel/link limits and sample
      rate choices; change one variable at a time and report bandwidth tradeoffs.
- [ ] Evaluate on-Pi processing, decimation and transport alternatives where useful.
      Research notes: `docs/RESEARCH-2026-10-08-CHANNELIZER.md` (one shared
      channelizer per source instead of per-decoder csdr pipelines; design,
      core-side measurements) and `docs/RESEARCH-2026-10-08-PI-CHANNELIZER.md`
      (placing it on the Pi: pros/cons, Pi 3 CPU measurements, optionality on
      weak hardware, keeping "decode anything" intact). WaveKit is not Pi
      centric: a dongle plugged straight into the computer is an equal first
      class setup, so the channelizer is built for the core first (it cuts
      per-decoder CPU there and enables several protocols from one capture)
      and only then offered on the SDR host as a transport optimisation.
- [x] Disable Wi-Fi power save persistently in the Pi image. The image embeds
      a NetworkManager `wifi.powersave=2` default before first network activation;
      verified off on a freshly written card after first boot and after reboot,
      with the Imager connection inheriting the default. Explicit per-connection
      operator choices retain precedence. (Not a cure for streaming loss.)
- [ ] Make the SDR host re-apply its configured gain and sample rate when the last
      rtlmux client disconnects, so a departing client cannot leave the receiver
      under-driven (observed: gain left at index 11, samples spanning 124–131).
- [x] Implement the decoder-instance sample-rate model: declared requirements,
      rate assessment, reversible suspension/resume and shared API reporting.
      Keep capture requirements separate from adapter output and stdin rates;
      unknown third-party requirements remain explicit. A channelizer cannot
      recover RF bandwidth absent from the capture. Hardware/live acceptance
      and source capability presets remain separate work.
- [x] Sample-rate presets through core capability discovery (WG6):
      `sampleRatePresets` on receiver capabilities suggests the CLI's 11 RTL
      rates on `rtl_tcp` sources (suggestions, not receiver evidence).
- [x] Expose per-tuner gain values through core capability discovery (WG7):
      `gainTable` on receiver capabilities is the cited librtlsdr list when the
      advertised tuner type and gain count match it, else `unknown` with a
      reason (a suggestion, not receiver evidence). Tuning ranges are open:
      librtlsdr has no per-tuner range table to cite.
- [ ] Decided 2026-10-08: no lossy bit reduction, no lossless-only compression
      (measured 0.68–0.86 at real gains), no decoders on the Pi for now. Details
      and measurements: `docs/RESEARCH-2026-10-08-WIFI-IQ-TRANSPORT.md`.
- [ ] Design an optional secured direct Wi-Fi connection for a laptop + battery +
      Pi setup, including provisioning, discovery, reconnect and LAN fallback.
- [ ] Support a direct Ethernet cable between the Pi and the operator's computer,
      powered by a battery, without a router. Evaluate automatic addressing,
      discovery, routing alongside the computer's internet connection, adapter/OS
      compatibility and recovery after cable removal. Measure sustained loss-free
      IQ and latency at supported rates rather than assuming Ethernet guarantees it.

Both direct Wi-Fi and direct Ethernet are portability targets: one laptop, one
Pi, one battery, with an Ethernet cable as the wired alternative. Router-based
Wi-Fi/Ethernet and direct links need separate acceptance tests.

## 3. Correctness and performance audit

- [x] Route stdin decoders through the explicitly selected source.
- [x] Enforce source exclusivity in both assignment orders.
- [ ] Manage complete decoder process trees and avoid unsafe shell interpolation.
      Shared-IQ pipelines now own POSIX process groups and quote decoder arguments
      and recording paths; native grandchild cleanup tests pass. Audit remaining
      external-device/custom pipeline paths before marking the whole item complete.
- [ ] Make resampling independent of input chunk boundaries; report actual rates.
      Exact paired-IQ conversion now supports passive readsb (2.4 Msps), AIS,
      VDL2 and LoRa. Actual SoX rate, complex-phase, filtering and odd-chunk
      tests pass; all-decoder RF fixture coverage remains pending.
- [ ] Synchronize tuner state on reconnection and propagate accepted changes.
      Accepted frequencies now update source/decoder metadata, and tuning-driven
      decoder restarts are serialized. Reconnect replay of the last accepted state
      (on first payload), caps reconciliation and an rtl_tcp stall watchdog are
      merged and deployed to the Mac; stable-power reboot/hotplug acceptance
      against the next Pi image remains.
- [x] Preserve arrays when applying indexed environment overrides.
- [x] Fix recording EOF cleanup (file/timers released, downstream EOF after
      buffered final data; read errors stop looping playback).
- [ ] Distinguish disconnected, waiting, stale, dropping and streaming states;
      display current activity separately from historical counters. Core REST now
      exposes payload freshness (waiting/streaming/stale/paused/disconnected/ended)
      independently of transport and assignment capacity. CLI snapshots expire
      after 15 seconds. The Pi SDR-host now derives upstream sampling evidence
      from fresh rtlmux byte counts (bounded non-overlapping polling, PID and
      counter resets, 10 s deadline), independent of USB, processes and clients;
      not yet deployed to the Pi. Combined core + Pi drop reporting remains pending.
- [ ] Exercise real decoder IQ fixtures, lifecycle failure cases, and memory limits.
      Channelizer golden gates cover seven adapters. Extend RF evidence with
      scanner captures and real voice/sensor/aircraft recordings; composed fixtures
      remain useful where live signals are unavailable. Keep private capture
      payloads out of the public repository.

## 4. API and event foundation for multiple clients

The CLI and the web dashboard under design are two consumers of the same public
contracts. Audit existing REST, WebSocket and binary/server streaming paths
before extending them. Announce shared contract changes in
`docs/CLI-COORDINATION.md` and inspect both clients before landing; web canvas
snapshots are design references, not production consumers yet.

REST routes have Fastify schemas and Swagger; `/ws` supports channel subscriptions
and caps incoming messages at 1 MiB. Outgoing payloads are now bounded per client
at 1 MiB/256 queued messages, with heartbeat and slow/dead-client cleanup. There
is no general durable event replay contract or SSE endpoint. Activity search,
when enabled, has its own cursor; see §4a. Operator data has
its own store-ID/revision snapshot contract; spectrum snapshots do not provide
durable Activity replay. Audio and IQ use separate bounded streaming servers.
Protected mode enforces authentication and explicit origins; legacy mode remains
a separate compatibility policy. External browser exposure still requires its
own acceptance.

Protected access runtime is on local main: private provisioning, pairing/session
services, renewable 30-day sessions, mounted REST/WS/audio adapters,
destination-bound CLI credentials and credential-free health probes. The setup
utility, scanner worker and main entry retain separate build outputs. Browser
onboarding/renewal consumption, trusted canonical bootstrap delivery and actual
TLS/proxy/container exposure acceptance remain open. Exact protected GET/HEAD
bootstrap now publishes configured origins and current mounted capability flags;
session-only GET/HEAD device inventory publishes committed ID/clocks/current metadata
without renewal or online-presence claims. See the
[access implementation checklist](specs/core-access-policy/tasks.md).

- [x] Device names, kinds and coarse last-seen (WG2, access amendment 4.9–4.12):
      operator labels via `POST /api/access/devices/label`, `lastSeenAt` as a UTC
      hour, at most 768 writes a day.
- [x] Decoder option schemas, report only (WG6): `optionIssues` on decoder
      status and option descriptors on `GET /api/decoders/types`; the
      prerequisite of a decoder `PATCH` (WG8 made it work in protected mode;
      legacy mode still answers 501).
- [x] Redacted config export (WG6, export half): `GET /api/config/export`,
      protected mode only, fail-closed redaction. Config import remains open.
      The redaction defaults (E2) were confirmed on 2026-10-16. WG7 exports six
      reviewed numeric paths that the sensitive-name pattern matched by
      accident.
- [x] Audio streams across origins (WG7): in legacy mode the live and
      digital-voice audio servers send `Access-Control-Allow-Origin: *`
      (no credentials) and answer `OPTIONS` preflights. Protected mode is
      unchanged (allowed origins only).
- [x] Bounded numeric decoder options (WG7): every adapter clamps or falls back
      by meaning and warns once per key without the value. Argv arrays are
      capped, and `extraArgs` is limited to 64 strings of at most 4 096 bytes
      (65 536 in total). Shell pipelines carry only formatted finite numbers.
      multimon-ng `verbosity` is 0–10. Configured argv is unchanged.
- [x] Decoder settings store and `PATCH /api/decoders/:id` (WG8, protected
      mode only): a persisted override layer (`decoder-settings.json`,
      override > YAML/env config > default) for `enabled` (autostart at boot)
      and the options whose descriptor says `patchable` (never paths, hosts,
      ports, devices, `extraArgs` or secrets); merge patch with `If-Match`,
      applied by rebuilding the adapter at its next start;
      `GET /api/decoders/:id/settings` shows each value's source. The config
      export stays YAML/env only. Open: applying a patch without a restart,
      rate-plan keys, config import.
- [ ] Define typed, versioned schemas, capability discovery and consistent errors.
- [ ] Specify snapshot/event ordering, sequence IDs, reconnect/resume behavior,
      bounded replay and explicit gaps when history is unavailable.
- [ ] Provide filtered subscriptions, heartbeat/liveness and cancellation.
- [x] Bound WebSocket output queues, isolate slow clients and detect dead peers.
- [ ] Bound per-client buffers and define overload behavior independently for
      telemetry, decoder events, audio and IQ.
- [ ] Implement single-operator local/LAN authentication and explicit origin
      policy before live browser controls. Cover REST, WS upgrades/commands,
      audio and recording downloads; preserve CLI access. Internet-facing
      accounts and multi-user roles are later scopes. CORS alone is insufficient.
- [ ] Test simultaneous CLI/web clients, slow readers, reconnects, server restart,
      event ordering, resource cleanup and documented throughput limits.
- [ ] Publish examples and contract tests for REST, WebSocket, SSE and streaming.

## 4a. Shared Activity and operator data

This extends §4 for the web Activity panel and shared CLI/web/mobile state.
The reviewed operator-data foundation provides durable presets/preferences/ranking
with a canonical snapshot and CAS conflicts. Protected REST and bounded WS
snapshot/update transport landed locally at `f0584a4`, including current-session
checks at enqueue/send and accepted-write drain before shutdown. The assembled
full root suite, typecheck, lint and build passed. Shipped client ordering,
conflict/uncertain-outcome recovery, trusted bootstrap delivery and external
browser/TLS acceptance remain open. Legacy mode does not mount operator data.
The [Activity/catalog design](specs/activity-recording-catalog/design.md)
landed at `c1e0293`; SQLite remains provisional until bounded runtime/storage
qualification. Recording integration still follows S2/S3 and deletion-owner gates.
Existing `DecoderOutput` has decoder/type/time/raw data; scanner recovery
journals, discovery search and settings are separate domain foundations.

The [decode envelope spec](specs/decode-envelope/design.md) defines
caller-owned reception IDs, separate producer/ingestion clocks, explicit
unknown RF context and complete bounded decoded JSON. Batch 1 publishes that
envelope into the activity store when Activity is enabled. Parser fallback
frequencies still cannot establish event-time RF provenance.

Event foundation batch 1 is mounted, and since WG1 Activity is on by default
with bounded retention and admission (250,000 rows, 256 MiB, 3 days; 50/s
burst 500 globally, 20/s burst 200 per decoder; an operator judgement for a
Pi-class SD card, not measured; `activity: { enabled: false }` turns it off).
Decoder output is published as a decode envelope, stored in
`<stateDir>/activity/activity.db` (on a volume in every compose profile; since
WG1 the prod profiles' `wavekit-state` volume also persists scanner jobs and
discoveries, band plans, operator data and API band overrides), and
served as search, facets and cursor replay. Telemetry outputs (`sync`,
`rates`, `stats`, `status`, `error`) are not stored. WG1 adds the
`analog-transmission` kind: each squelch-delimited live-demodulator
transmission, with event-time frequency. Still deferred: ingestion receipts,
other kinds, recordings and the catalog, CLI and web views, Docker image
verification of `node:sqlite` FTS5 in the Node 24 base (a failed probe leaves
Activity `unavailable` and the rest running), and measured retention.

- [x] Event foundation batch 1: envelope publication, the SQLite/FTS5 store,
      search, facets and cursor replay. On by default with bounded limits
      since WG1; `analog-transmission` records from the live demodulator.
      Receipts, other kinds, recordings/catalog, CLI/web views, image
      verification and measured retention remain open.
- [x] Activity presentation (WG2): decoder receptions carry category, protocol,
      entity key, title, fields and position from their own payload; APRS and
      Meshtastic positions join the 60 s coalescing. Rows stored before WG2 are
      not backfilled.
- [ ] Backfill presentation onto rows stored before WG2 (deferred; old rows keep
      category `other` and no entity key).
- [ ] Re-admit receptions coalesced behind a queued row whose write later fails
      (today they stay dropped, so a failed write can leave up to one 60 s window
      of that entity unstored).
- [x] Meshtastic flood copies are dropped in Activity (WG3): same `from`, `id`,
      `portnum` and payload within 30 s, on every port; copies take no tokens
      and are not losses.
- [x] Busy-station fair-share retention (WG3): `activity.retention.policy`
      `fair-share` (default) water-fills the row and byte caps across decoder
      feeds, so pages and a mesh keep their rows to the age cap beside a busy
      ADS-B feed; `oldest-first` keeps the pre-WG3 behaviour. Status reports
      per-share usage in `retention` and `floodCopies`.
- [ ] Add a common decode envelope with stable identity, category, title, fields,
      actual channel frequency, source/decoder/job provenance and raw JSON.
      Preserve existing decoder payloads; source centre alone cannot locate an
      offset probe's decode. Batch 1 publishes the envelope on the enabled
      path with unknown RF provenance (`sourceId` and `frequency` null).
- [x] Reception provenance (WG3): decoder receptions carry `sourceId` and the
      channel frequency from the decoder binding or the decoder's own payload
      frequency (`tuningTrust: "unverified"`).
- [x] AIS radio channel on ship output (WG4): `channel` A/B from NMEA field 4
      or AIS-catcher JSON, so a dual-channel AIS decoder's receptions store
      161.975 or 162.025 MHz. From WG5 `VesselState` carries it too.
- [x] Verified tuning trust (WG5): `tuningTrust` is `commanded` or `relay` when
      the observed tuner state proves the decoder hears its targets, else
      `unverified`. A retune of the dongle host that bypasses WaveKit and the
      relay is not observed.
- [ ] Event-time channel frequency for offset probes and source retunes (after a
      retune, trust stays `unverified` until the decoder restarts).
- [ ] Provide persistent, searchable events with paging and full-text indexing,
      including transcripts when available. Link discoveries, observations and
      recordings without making scanner recovery journals a public event API.
      Batch 1 stores and searches decoder receptions. Transcripts, discoveries,
      observations and recording links are not stored yet.
- [ ] Define live event replay from a cursor with snapshot ordering, duplicate
      handling, restart/retention gaps and filtered subscriptions. Separate
      durable Activity events from replaceable spectrum/status telemetry.
      Batch 1 replays Activity from a cursor and keeps telemetry off that log.
      General SSE and replay of every event kind remain open.
- [ ] Store saved frequencies in core: name, frequency, mode, bandwidth and tone
      settings, shared by all clients. Decoder band overrides and automatically
      observed discoveries remain distinct objects.
- [ ] Persist and synchronize operator settings, presentation preferences and
      command-history inputs for palette ranking. Reuse operational tuner/audio
      and scanner settings where they already exist; define update/conflict
      semantics rather than creating a second scanner settings store.

## 5. Protocol-aware signal discovery and scanning

Implementation follows the [scanner plan](superpowers/plans/2026-10-09-signal-discovery-scanner.md).
S1-A and S1-B landed locally at `da55b1e` after independent sequential reviews
and the recorded-IQ/full-suite checkpoint (not pushed). S2 adds channel probes and
analog recording; S3 adds monitor/listen; S4 supplies live acceptance. Preserve
that dependency order. A scanner should characterize activity and confirm a
protocol with decoding.

The reviewed S2 internal recording protocol, exact grant/settlement ownership,
consumer and protected composition are now integrated locally. This is a
disabled implementation checkpoint, not S2 completion: profile/calibration,
useful combined turnover, physical analog cleanup/reuse and guarded IQ remain
open. Missing proof retains ownership rather than admitting a successor.

- [x] Scan an operator-selected frequency range or the receiver's supported tuning
      range with explicit steps, bandwidth, dwell time and exclusions. (S1: docs/SCANNER.md)
- [x] Offer protocol-specific searches, such as finding DMR activity, using suitable
      demodulators/decoders and distinguishing a candidate from a confirmed decode. (S1: docs/SCANNER.md)
- [x] Combine spectrum/activity detection with targeted decoding; report frequency,
      bandwidth, observed protocol, confidence, timestamps, signal measurements and
      available decoded metadata. Retain evidence and avoid duplicate discoveries. (S1: docs/SCANNER.md)
- [ ] Schedule efficient coarse searches and focused revisits, with bounded CPU,
      memory and retuning overhead. Test weak, intermittent and overlapping signals
      using recorded fixtures and measured detection/false-positive rates. (measured rates and hardware limits: scanner plan S4, Tasks 47–50)
- [x] Define background scanning ownership: a single tuner cannot scan other bands
      while maintaining an unrelated live stream. Expose pause/resume, priorities,
      compatible in-window searches and additional-receiver options explicitly. (S1: docs/SCANNER.md)
- [x] Expose scan jobs, progress, cancellation and discovery reports through the
      shared API/events so CLI and future web clients have equivalent capabilities. (S1: docs/SCANNER.md)
- [x] Ignore (lockout) skips sweeps (WG2, D2): a locked discovery becomes a runtime
      exclusion on sweeps of its sources, at most 256 per job, never emptying a
      plan; probe, recording and monitor gating unchanged. (docs/SCANNER.md)
- [x] Per-job hit statistics (WG2): hits per discovery, `GET /api/scanner/jobs/:id/hits`,
      `hitStats` on progress and `jobHits` on discovery events; in memory,
      best-effort past 2,000 discoveries or 4,096 credited observations.
- [x] Decoded elsewhere and last hit duration (WG6): plans and jobs report the
      ranges running decoders on other sources provably cover
      (`decodedElsewhere`, fail-closed trust rule), skipped only with
      `skipDecodedElsewhere`; `lastDurationMs` per job hit. WG7 refreshes the
      ranges after decoder changes (2 s debounce, at most every 30 s, at most
      30 s late). Open: external-input decoders never contribute until their
      band check proves targets.
- [x] Band plans to scanner exclusions (WG7): `skipBandPlanSkips` turns
      `skip`-marked bands of the resolved band-plan view into sweep exclusions
      (`bandPlanSkips`, after lockouts and before decoded-elsewhere ranges,
      never emptying a plan). A band-plan edit applies at the job's next plan.
- [x] Ambient identify for AIS, ACARS, VDL2 and LoRa (WG7): identify names
      these from an already-running config-owned decoder on the same source
      (`transport: "ambient"`, no probe). Only `commanded`/`relay` tuning trust
      at the decoder's own target frequency counts, and the identity needs two
      clean decodes. Open: acceptance on real AIS, ACARS, VDL2 and LoRa traffic.
- [x] Identify for analog voice (WG10): `analog-fm` / `analog-am` trials read the
      live demodulator's transmissions near the target (decoder `live-audio`); a
      CTCSS or DCS tone on a `commanded`/`relay` frequency makes the target
      `identified`, otherwise `candidate`; `no-live-audio` when live audio was not on
      the target. `result.decodersUnavailable` names probe decoders that could not
      run (remembered 300 s, not respawned meanwhile). Open: analog identify needs
      live audio on the target (an in-process FM demodulator or a probe FM decoder
      would lift that); real-RF acceptance on PMR446 with CTCSS.
- [x] Identify quality (WG11): `heard` for a squelch opening without a tone or code,
      analog evidence no longer stops digital trials, narrow digital trials on
      6.25 kHz rasters, known protocol first with decay, clean cancel of an ended
      job, the band-scan DMR root cause fixed, the passive guard re-check, and
      scanner store CPU off the main thread (see the WG11 summary above). Open: the
      `nxdn96` last-mode miss in jobs and the `evictionVictim()` scan.
- [x] IQ capture on detection replayed into identify (WG11, protected mode, off by
      default): capture → queue → replay trials → result → discard. Open: the
      directory-relative syscall follow-up in `wavekit-iqcap`, the stray file after
      a protocol-violating tool event, and `crcClean` on the replay result.
- [ ] Establish hardware/protocol limitations before promising whole-band coverage
      or identifying every signal. Treat encrypted/undecodable activity honestly. (measured rates and hardware limits: scanner plan S4, Tasks 47–50)

## 5b. Digital voice audio

Digital voice landed and was verified over the air on 2026-10-09. Analog and
digital PCM currently use separate HTTP servers; WS channels carry metadata
and status. Shared browser audio and richer controls remain open.

- [x] Output decoded voice from dsd-fme (AMBE+2/IMBE via mbelib) for DMR first, then
      P25 phase 1/2, NXDN, dPMR, D-STAR and YSF where dsd-fme supports them. Stream it
      over HTTP with WS per-call metadata
      (protocol, talkgroup, source, slot). Done 2026-10-09: dsd-fme
      `-o udp` into a paced 8 kHz mono stream on port 8082, `digital-voice` WS
      channel, `/api/digital-voice/*`, on by default
      ([DIGITAL-VOICE.md](DIGITAL-VOICE.md)). YSF datagrams verified on the
      fixture; P25/NXDN/D-STAR unverified; dPMR not mapped.
- [ ] Per-slot/per-talkgroup selection and a short per-call recording buffer, with bounded
      memory and an explicit retention setting. Done: `voiceSlot` (`-V`) and
      per-call WAV files (`-7 <dir> -P`, default off) with size and age
      retention. Open: per-slot streams and talkgroup selection.
- [x] Mark encrypted calls as encrypted and never attempt to decode them. Silence
      plus `encrypted: true`; no key options are passed. (Licensing note waived
      by the user on 2026-10-09.)
- [ ] Mixed analog/digital channels, like a dual-mode handheld: detect per transmission whether a
      channel carries analog FM or a digital mode, and route it to live analog audio or digital
      voice automatically, with the detected mode in the call metadata. Observed 2026-10-09: an
      analog user shared PMR446 channel 8 with the DMR test.
- [x] Over-the-air acceptance with the lab handheld: DMR voice is intelligible, and a call
      is not split while PTT is held. Done 2026-10-09 (run10) after dropping `csdr dcblock`
      from the dsd-fme input chain (it muted the start of every TDMA burst; regression check
      `scripts/dsd-fme-voice-ab.mjs`). Evidence: `output/acceptance/voice-decode-2026-10-09.json`.

- [ ] Provide one bounded WS audio stream at a stable 48 kHz, auto-routing analog
      and decoded voice while retaining manual selection. Reuse scanner S3's
      routing and arbitration; its planned 8 kHz HTTP monitor is a foundation,
      not completion of this item. Avoid disconnecting clients on rate changes.
      WG10: the HTTP stream now keeps its clients through every restart that
      keeps the format (silence fill, at most 5 s) and swaps only the front stage
      on an offset change. Open: no silence during the 1-30 s failure-restart
      backoff; a rate or format change still reconnects; real-RF and Pi CPU checks.
- [x] Add automatic floor-based and noise squelch, and update controls without
      unnecessary pipeline restarts. Preserve current threshold/hang behavior
      and fix the observed noise tail. Auto squelch landed in the 2026-10-12
      batch; WG7 added the opt-in `squelchMode: "noise"` (FM quieting, NFM/WFM,
      `noiseQuietingDb` default 6 dB) and fixed the noise tail (noise blocks just
      below the threshold no longer hold the gate; about 260 ms of unmuted audio
      after carrier loss in the synthetic test). Synthetic evidence only:
      real-RF acceptance open (csdr back-chain delay, the 6 dB default at
      12 dB CNR, WFM pilot harmonics), Pi CPU unmeasured. WG10: in auto mode on
      NFM/WFM an FM-quieted block (a carrier) never seeds or raises the floor
      (observer 24-36 µs per 10 ms block); real-RF check on a nearby handheld open.
- [x] Live-audio AGC off/slow/fast including FM (WG4): `liveDemod.agc` and
      PATCH `agc` (null resets); absent keeps the per-modulation chain unchanged.
      Open: csdr `-p slow` at the pinned csdr is unverified until an image smoke
      test, and the Pi CPU cost of the extra NFM/WFM stage is unmeasured.
- [ ] Implement real noise reduction, audio noise blanker, notch, CW BFO and DSB
      demodulation. Current filter presets and AM-based CW/DSB do not fulfill
      these controls.
- [x] Detect CTCSS and DTMF on analog transmissions (WG2): `tone` on closed
      `live-audio:transmission` events and `analog-transmission` Activity rows.
- [x] Decode DCS code/polarity on closed analog transmissions (WG6): `tone.dcs`
      on `live-audio:transmission` and Activity rows, searchable under both twin
      spellings. Synthetic corpora only; real-RF acceptance and Pi CPU are open.
- [ ] Expose tones on live status, saved frequencies and tone squelch (deferred
      from WG2). Partly done: WG7 live tone squelch (`liveDemod.toneSquelch`,
      NFM only, standard CTCSS tones and DCS codes in the saved-frequency tone
      shape) mutes the live audio until the tone is heard, with
      `toneSquelch.state` on live status; events, rows and tone results are
      unchanged. Saved frequencies store a tone but do not apply it (operator
      data `capabilities.toneSquelch` is `false`), and the tone currently heard
      is not on live status. Real-RF acceptance and Pi CPU are open.
- [ ] Emit analog transmission start/end/duration events from squelch with stable
      identity and recording links. Detector tracks and squelch transmissions
      have different boundaries; reconcile them explicitly.
- [x] Digital call metadata (WG2): `colourCode`, `nac`, `ran`, `algorithmId`,
      `keyId` and CRC/FEC `errors` counts on `digital-voice:call` when dsd-fme
      reports them.
- [ ] Expose DMR talker alias and a defined error-rate measure after verifying
      pinned dsd-fme output (talker alias deferred from WG2). The CRC/FEC counts
      and internal bad-signal ratio do not establish voice BER or an alias parser.

## 5c. Recording catalog, capture and playback

Reuse digital per-call WAVs, scanner evidence retention and the planned S2
analog recorder. A shared catalog links each recording to its provenance;
existing IDs need a compatibility strategy. Every deletion owner must honor
retention and Keep. Discovery Keep protects an emitter's evidence collectively;
recording Keep protects one recording independently.

- [ ] Record analog transmissions and digital calls automatically across supported
      live and scanner paths; expose bounded retention and playback by ID with
      seek. Scanner WAV download alone does not provide seek or all-call coverage.
- [x] Read-only recordings inventory (WG8, protected mode only):
      `GET /api/recordings` lists the dsd-fme per-call and scanner WAVs with
      opaque ids, time, talkgroup, duration and size (frequency only when
      known), and `GET /api/recordings/:id/file` downloads the whole file (no
      `Range`). WaveKit changes no file; the catalog below stays open.
- [x] Keep individual recordings (WG9, protected mode only):
      `PUT`/`DELETE /api/recordings/:id/keep` and `DELETE /api/recordings/:id` for dsd-fme
      calls, behind one synchronous deletion decision that the dsd-fme pruner,
      scanner retention, discovery removal and analog retention consult (fail
      closed: an unusable keep store protects everything). Inventory items carry
      `kept`. Bounds 2 000 entries and 512 MiB kept.
- [x] Recording follow-ups (WG10, protected mode): delete scanner digital voice
      recordings (`scan:` ids) with the scanner bookkeeping updated; merge aliases
      keep a dropped discovery's folders protected and removable with the survivor;
      a capacity eviction removes the evicted folders; keep totals in the storage
      report (`kept`); a startup sweep of interrupted-delete directories (protected
      mode only); the capture store no longer warns about its staging directory.
      Downgrade note: merge `aliases` were added to the strict scanner snapshot and
      journal schemas without a file-version bump, so a pre-WG10 build started on
      scanner state written after any merge fails strict parsing and loads an
      empty scanner state. Back up the scanner state directory before rolling back.
- [ ] Recording follow-ups still open after WG10: analog scanner recordings cannot be
      deleted (409); merges and evictions made before WG10 keep their orphan
      folders; aliases are released only after the owner's removal succeeded (a
      failed removal keeps them for the retry), but a deleted or evicted owner's
      alias list is not journaled, so a crash before its removal finished can orphan
      alias folders (kept files stay protected by their keys); WG9-format delete leftovers
      (`recording` entries) are left and counted; deleting a recording of an owner
      already dropped but not yet fenced answers 404 rather than 409
      `RECORDING_BUSY` (nothing is touched); the scanner delete's lstat count is
      6 plus twice the directory depth, above the design's 6; a failed keep store stops all recording pruning,
      so the disk can fill until it is fixed; kept scanner recordings can block
      discovery capacity eviction, so new discoveries are refused while every
      evictable one holds a kept recording (one warn with a count). A symlinked
      configured recording root is resolved once at startup (WG9 R2), but a
      symlinked `recordings/` or `evidence/` folder inside the scanner storage
      root is still refused (not pruned), and the analog store's internal
      cleanup paths (abort and recovery cleanup) do not re-check the pinned
      root's identity, only the retention and discovery-removal entry points
      do. Accepted
      residual: Node has no `unlinkat`/`fstatat`, so a process of the same user that
      rebinds the private delete directory, or a retention folder, between the last
      identity check and the unlink can redirect that unlink; another user is
      refused by the shared-writable-directory check, and the same user could
      delete the file directly anyway. Disk reserve and low-space behaviour, and
      catalog ids, leases and the generation-fenced scanner handshake, stay open.
- [ ] Support manual recording with name/note and non-destructive in/out trim;
      apply trim to playback and exported downloads.
- [ ] Capture the viewed IQ span and export SigMF; play captures as a source for
      spectrum, audio and compatible decoders, then restore live ownership.
      Reuse paced IQ file sources and scanner Task 34a capture/decimation rather
      than implementing another playback engine. Reconcile recording-source
      capability metadata and spectrum/live-audio eligibility.
- [x] Storage report (WG4): `GET /api/storage` with bounded per-area sizes
      (automatic, state, other), caps, free space, Activity retention and the
      one low-space behaviour (scanner evidence stops writing), without paths.
- [ ] Report kept (Keep-protected) bytes (`kept` is null today) and reasons for
      any shortened retention. Existing evidence low-disk guards stop writes; do
      not claim automatic retention shortening until it is implemented.
- [ ] Provide stable recording links and trimmed WAV/Opus downloads. Deep-link
      navigation belongs to clients; IDs, access policy and export belong to core.
- [ ] Future: bounded transcription jobs with per-recording transcript/status,
      searchable through §4a. Depends on finalized audio and stable catalog IDs.

## 6. Lightweight Pi operator page

Provide an optional, uncluttered page served by the Pi itself, reachable from a
phone or computer on the local network without a cloud account. Keep it focused
on receiver operation and available without the laptop's WaveKit core running.

- [x] Show first-boot progress/failure, host uptime, CPU load, memory, disk space,
      temperature and network connection with clearly labelled fresh/stale data.
- [x] Distinguish active undervoltage/throttling from historical power events;
      report unavailable measurements honestly, without implying battery charge
      or power consumption can be measured on unsupported hardware.
- [x] List attached SDR dongles and receiver service state, separating USB presence
      from actual sample flow, throughput and dropped data.
- [x] Present a compact overview with optional diagnostic details, readable on
      mobile and inexpensive to serve on a Pi 3. Reuse the host API and shared
      telemetry contracts rather than creating a separate monitoring stack.
- [ ] Offer authenticated, explicitly confirmed shutdown (and optionally reboot),
      protected against cross-origin requests and limited to those host actions.
      Make pending shutdown and the expected loss of connectivity clear.
- [ ] Start with read-only status, then add host controls after access/origin policy
      is implemented. Test reconnects, setup failures, USB hotplug and stale data.

The read-only page is implemented in `packages/sdr-host` and served at
`http://<pi>:8080/`; `GET /api/host` and additive `/api/status` fields
(`sampling`, `delivery`, `samplingHistory`) carry the shared
`@wavekit/api-types` contracts. Each reading states its scope (Pi host,
receiver container, Docker storage filesystem, or observed by the service) and
its freshness; anything the unprivileged container cannot see is shown as
unavailable with a reason. The Pi CORS policy no longer reflects every origin.

Unit/integration tests cover stale counters, idle delivery with ongoing
sampling, header-only growth, rtlmux/rtl_tcp restarts, hung and malformed stats,
expiry, missing sysfs files, setup records and page logic. On hardware, the
operator-page image (2026-10-08) served the page from a fresh card: undervoltage
state (`rpi_volt`), the `cpu-thermal` zone and `/proc/net/wireless` link data
are visible to the receiver container; container memory accounting is not
visible from inside it, and throttling stays unavailable by design. The page
showed the USB hotplug transition. Later status/setup polish is included in
the next operator image candidate; that candidate still needs its own
stable-power clean-card acceptance.

Known limits: on current Raspberry Pi kernels the firmware's "since boot" power
bits are cleared by the kernel's own polling and throttling flags need
`vcgencmd`/`/dev/vcio`, so under-voltage history is "observed by the receiver
service since it started" and throttling is reported as not measurable. Setup
progress appears only on images whose first boot writes the sanitized
`/var/lib/wavekit/status/setup.json`. Updated images also serve an independent
early setup page on port 80 before Docker installation; once setup completes
and the full page responds, port 80 relays to it (8080 keeps serving it directly). Reboot/shutdown
controls remain deliberately absent until authentication, authorization and
origin/CSRF protection exist.

**Pi UI: one address for the user** (implemented 2026-10-09, included in the
next image candidate; clean-card acceptance pending). Port 80 owns the setup
page and relays to the receiver once the status page answers, with a setup
fallback if the receiver stops. Port 8080 remains a compatibility endpoint.
Verify setup → status → reboot on the candidate itself.

## Delivery discipline

Review and publish coherent commits as each batch passes its relevant checks.
Keep credentials, SSH identities, local network settings, SD images, card backups
and raw diagnostic/session notes out of the public repository. Preserve local
artifacts while publishing only reusable examples and sanitized findings.
Record test results honestly, including skipped tests and hardware limitations.

## 7. CLI dashboard UI and UX overhaul

Run this as a dedicated design/implementation team alongside core reliability and
Pi operator-page work. Use Sol for bounded implementation and audits, and Astra
for architectural review; retain other model expertise where the task needs it.

Merged 2026-10-09 (`1baa845`), included in the 2026-10-10 main push: user guide
and validation in `docs/CLI.md`; rulings in
`docs/superpowers/plans/2026-10-08-cli-dashboard-overhaul-decisions.md`. Open: CPU at
50 msg/s is 8.6–8.7 % against an 8 % budget; band-override editing is not in the CLI;
RF and hardware acceptance are outside what CLI tests can show.

- [x] Audit the current dashboard with realistic live, idle, disconnected, stale,
      dropping and partially failing receiver/decoder states; establish a clear
      information hierarchy and operator workflows before redesigning.
- [x] Improve layout, typography, spacing, navigation, keyboard interaction,
      discoverability and readable status/event presentation across terminal sizes.
- [x] Make tuning, source ownership, decoder activity and decoded results easy to
      understand; distinguish API connectivity, IQ freshness, decoder process
      health, successful decoding and historical counters.
- [x] Support useful detail views and filters without overwhelming the overview;
      handle empty states, reconnection, errors and unavailable measurements.
- [x] Validate with representative fixtures and real terminal sessions, including
      narrow terminals, resize, keyboard use, long text and sustained event flow.
      Document any terminal/accessibility limitations and check rendering cost.
- [x] Coordinate shared API/event changes with the core team. CLI team owns `cli/`;
      Pi team owns `packages/sdr-host/`; core team owns core/API/decoder changes.
      Agree on shared contracts before editing them, preserve concurrent work,
      and stage only each team's files. UI work must preserve the distinctions
      between clean-card acceptance, patched-runtime tests and streaming stability.
- [ ] Follow-up (user, 2026-10-09): the tuner controls are weak. Add a waterfall
      view on the §8 `spectrum` channel with cursor-based tuning: arrow keys move
      a cursor over the spectrum, Enter listens or decodes there, and a key zooms.
      Read-only `6 Scan` now provides the waterfall with truecolor half-blocks
      and ASCII/no-color fallback. Cursor tuning, listen/identify actions and true
      viewed-slice zoom remain open.

## 8. Spectrum and waterfall service, and activity detection

Founding use case (user, 2026-10-09): WaveKit was created so the operator could
find signals visually in SDR++ and have every decoder try to identify and decode
them. S1 discovery, identify and shared spectrum contracts are now on local main.
The new S2 observed-channel producer remains disabled; existing offset probes
retain their own behavior. rtl_tcp does not expose SDR++'s VFO. Detect emissions
across the window and confirm them through suitable decoders (identify mode, §5).

Important; get it right. Operators find activity today by watching SDR++'s
waterfall and waiting for an emitter to key up again. WaveKit should provide the
same view, and a program can do the watching more reliably than a person.

- [x] A core spectrum service, independent of scanner jobs. It computes an
      averaged FFT of each source's IQ as a raw fanout consumer and publishes it
      on a general `spectrum` WebSocket channel. Rate and bins must suit a
      waterfall: 10 Hz or more and 1024 or more bins for the web; lower for the
      CLI. Late-joining clients get a matching snapshot. WG1 adds opt-in
      per-client waterfall backfill (`backfillMs`, up to 10 s / 64 frames of
      the current epoch) and per-client exponential averaging (`averaging`
      1–32). WG8 lifts the 2048 bins cap where the host can afford it:
      `scanner.ws.spectrumBinsCap` (`auto` measures once at startup; up to
      8192, the Mac picks 8192, a Pi 3 stays at 2048), with a lossless int16
      worker wire; clients get at most min(cap, `spectrumSummaryBins`), so the
      shipped config and the default profile are unchanged. Viewed-slice zoom
      stays gated. Scanner Task 37a owns
      this service; support bounded simultaneous profiles and source selection
      without client preferences changing detector behavior. Preserve the planned scanner
      10 Hz / 512-bin default for subscriptions without options.
- [x] An activity detector on the full sample stream, not on display frames,
      so short TDMA or pager bursts are not missed. It keeps a per-bin noise
      floor and an N dB threshold, and merges adjacent bins into emissions with a
      centre, bandwidth, first and last seen times and a duty cycle. A persistent
      occupancy history keeps intermittent emitters known while they are idle.
      Reuse scanner occupancy/discovery histories for the per-frequency band map;
      Task 37a exposes occupancy rather than creating a second history store.
- [ ] Receiver artefact masking: the DC spike at the tuned centre, IQ mirror
      images (a weaker copy at −f), and learned always-on spurs.
- [ ] Hand-off to the scanner (§5): classification by bandwidth and band plan, a
      channel opened at the emission centre, likely decoders tried, and a decode
      as confirmation. Recording IQ around detected bursts also gives
      automatic fixture capture for decoder goldens.
- [ ] Keep the engine behind an interface so a native backend can take over.
      `wavekit-chan` already reads the full CU8 stream per source. A Rust detector
      frame engine with the JS backend as fallback is in the "Next" list of the
      performance plan above.
- [ ] A stale `caps.centerFreq` (a retune from SDR++ that bypasses the relay)
      puts the frequency axis and every emission centre on the wrong RF. Partly
      solved: decoder receptions carry the WG5 tuning trust (`unverified` unless
      the observed tuner state proves the tuning). The spectrum axis and
      `declaredStream.centerFrequencyHz` still come from config or core
      metadata. Fix those, or show them as untrusted.
      WG10 untracked-retune findings: in the core, a strong transmitter whose
      images and intermodulation lines end together raised the alarm with Δ null;
      it is now `signal-change` (no new epoch, labels kept). An I/Q byte slip in
      the core, a command epoch landing a block late and a reconnect were ruled
      out by tests; only a server-side byte drop upstream of the core could still
      mirror the spectrum, which U8 sources now detect (`iq-byte-slip`, one-byte
      re-align). Warnings carry `suspected` and `lastCommandAgeMs`. Open: a large
      Δ seen live is not reproduced; a retune that leaves two old positions
      covered could still read as `signal-change`.

### Spectrum contract amendment for scanner S1-B

Decision 2026-10-10: profiles now, genuine slice zoom next; WS tuning follows
latency measurement. Coordinate Tasks 24/25/37a in the scanner's owning session
before changing shared contracts. This sets scope; the exact DTO/config names
and measured limits belong to that session's delta/review.

- Preserve the planned scanner default display settings for compatibility. Separate
  the bounded worker summary-detail budget from a client's output bins; summary
  reduction currently discards detail before Task 37a receives it. Evaluate
  2048 summary bins as an initial bounded bridge, measuring worker traffic/CPU
  and reporting actual detail when the native FFT provides fewer bins.
- Add bounded per-client source/profile requests, share each source engine and
  build each requested profile once. Route matching frames/snapshots and release
  demand correctly on unsubscribe/disconnect. Limit distinct active profiles,
  rates and bins; do not turn display preferences into detector restarts.
- Preserve stream/epoch, capture axis, tuning trust, actual bin count/bin width
  and discoverable native/effective spectral resolution. Clear accumulation on
  epoch/layout changes; a snapshot must match its requested profile and epoch.
- Verify simultaneous CLI/web profiles, source selection, profile switching,
  late join/reconnect snapshots, retune boundaries and demand cleanup. Announce
  final contracts in `docs/CLI-COORDINATION.md` before landing.
- [ ] Follow-up: genuine higher-resolution FFT of the viewed slice, with bounded
      DSP work and unchanged full-stream detection. Magnifying/cropping published
      bins does not satisfy this item.
      Prepared Sol/Astra design: benchmark a separate longer raw-IQ FFT at bounded
      display cadence, then select the viewed bins from that new transform. Require
      real contiguous samples and report its own `Fs/N`, observation duration, window
      and sample support separately from detector resolution and delivery cadence.
      Preserve detector conversion arithmetic, deduplicate overlapping sample ranges
      and reset at gap/marker/settle/stream boundaries. Borrowed raw arrays must remain
      synchronous and display accumulation bounded. Translation/anti-alias decimation
      is a measured optimization if the simpler transform exceeds available headroom.
      Implementation waits for reviewed Task 37a contracts/summary measurements and
      the 35a/38 shared-file window; sustained zoom workload measurements then choose
      FFT, memory, rate and DSP-profile limits.
      WG9 measured the sustained zoom workload on the Mac (`scripts/bench/zoom-workload.ts`,
      2.048 Msps, 128 kHz span, 60 s cells, a loaded machine, so indicative only): the
      event-loop rule (+2 ms p99), not CPU, is the binding limit while the zoom FFT runs
      on the main thread. One transform takes about 2.3 ms at N 32 768, 7 ms at 65 536
      and 18 ms at 131 072, so above about N 16 384 almost any main-thread placement
      fails; incremental CPU alone would allow N 65 536 at 5/s with 1-2 slices (0.015 to
      0.058 core). Decision: the zoom transform belongs in a worker (the spectrum worker
      or its own). Proposed Mac caps in a worker: N ≤ 65 536 (31.25 Hz bins), at most
      5 transforms a second, at most 2 slices per source, 0.20 core in total; N 131 072
      and above fail CPU or memory. Until the Pi run (pending), the Pi proposal is
      N ≤ 32 768, 5/s, 1 slice per source and 2 in total, in a worker; Pi 3 N ≤ 16 384.
      Measured on a Raspberry Pi 3B with the same bench at 2.048 Msps: the JavaScript
      detector proxy alone saturates one core (0.99), so every zoom cell fails; one
      transform takes about 5 ms at N 8 192 up to 200 ms at N 131 072. Conclusion: zoom
      limits depend on the core host, not the receiver. A Pi-class core host needs the
      zoom FFT off the main thread, preferably in Rust (a `wavekit-chan` extension), and
      even then has no headroom while the JS detector runs; caps must come from a
      measurement on the host that runs the core.
      Superseded 2026-10-17: the zoom transform moves to a `wavekit-chan` zoom output
      (DDC to the viewed span plus a small Rust FFT, panned in place by `tune`) instead
      of a JavaScript worker; see "Performance and native DSP plan" above.
- [ ] Measure coalesced REST drag-to-tune and accepted-state latency; then decide
      WS tuning. Any transport reuses authorization, ordering, scanner preemption
      and tuner origin semantics. WG9 measured the operator retune to first frame at
      the new centre offline (fake rtl_tcp on loopback, 50 retunes per injected delay,
      network settle 1000 ms): p90 1148 ms before, 264 ms after at zero delay (280 ms
      at 100 ms, 383 ms at 250 ms, 611 ms at 500 ms, where some old-centre blocks show
      but are labelled `unverified`). The 150 ms operator display settle replaces the
      1 s network settle for display; frames stay `unverified` until the network
      settle. Revisit WS tuning with these numbers; a real-receiver measurement is
      open. Drag retune is planned for WG12 on top of the Rust zoom output and `tune`.
- [ ] Implement source/channel DC removal, IQ correction and IQ swap as measured
      sample-processing controls. Existing DC/image/spur masks only affect detection
      and display; the ignored legacy IQ DC-block flag must not imply correction.

## 8b. Positions, maps and coverage

Extend existing ADS-B state and bounded in-memory trails. Durable cross-protocol
position history belongs with §4a's event foundation; map reception coverage is
separate from scanner RF sweep coverage.

- [x] readsb receives `--lat`/`--lon` from `station` independently of
      `enableMlat`; a complete valid decoder-option coordinate pair wins (a
      single option coordinate falls back to the full station pair) (WG3).
- [x] Station identity writable by clients (WG4): `PATCH /api/station` in
      protected mode, persisted in `station.json`, precedence env > yaml > ui >
      default, provenance `ui`; coverage resets on a move over 1 km, readsb
      picks the location up at its next start.
- [x] Visibly approximate station location (WG4): `GET /api/station/estimate`,
      a weighted median of heard positions, never authoritative and never used
      by coverage or decoders.
- [ ] Station writes in legacy access mode (mounted only in protected mode
      today) and gpsd as a location source.
- [x] AIS vessel current state (WG1): an in-memory tracker of AIS reports
      (NMEA positions from types 1–3, 18, 19; static data from 5, 19, 24), `GET /api/vessels`, `/api/vessels/stats`,
      `/api/vessels/:mmsi` and the `vessels` WebSocket channel. No position
      history.
- [x] APRS and Meshtastic current state (WG2): in-memory trackers,
      `/api/aprs/*`, `/api/mesh/*` and the `aprs` and `mesh` channels.
- [x] Meshtastic device telemetry and neighbour links on nodes (WG3).
- [x] Meshtastic GPS time on nodes (WG4): `position.fixAt` from the sender's
      fix time, bounded to 7 days back and 60 s ahead.
- [x] APRS repeated-digipeater marker (WG4): live direwolf paths mark the last
      repeated digipeater with `*`, so direct and relayed stations differ.
- [x] Throttle `vessel:update`, `aprs:update` and `mesh:update` per entity, 2 s
      (WG2); identity changes and new/lost are immediate. Aircraft keep today's
      shape.
- [x] An absent `sourceId` and an explicit id for the same source no longer
      restart live demodulation or close a transmission as `config` (WG2 req 7.7).
- [x] AIS NMEA checksums are verified (WG2); the fixtures were regenerated with
      the test encoder.
- [x] Mic-E positions (WG2): West longitudes were decoded as East and the
      800 kn / 400° offsets were missing; fixed with spec vectors.
- [x] The CLI WebSocket client ignores a frame on an unknown channel instead of
      counting it as `ws:invalid` (WG3).
- [x] Bulk position trails (WG4, partial): `GET /api/activity/trails` serves
      aircraft, vessel, APRS and mesh trails from the Activity store over a
      window (default 1 h, at most 24 h) under fixed caps. The Pi CPU cost of
      the trails read is unmeasured. Mesh trails were empty until WG5, which
      gave Meshtastic POSITION receptions a position; new rows also carry
      `altM` (WG5; no backfill).
- [ ] A time cursor over trails and a Pi-measured trails budget.
- [x] Activity band map and timeline (WG5): `GET /api/activity/bandmap` counts
      stored rows per 12.5 kHz bucket by protocol with top entities, and
      `GET /api/activity/timeline` counts rows per epoch-aligned time bucket and
      category, both over a window of at most 72 h under the 250,000-row scan cap
      and a 600 ms budget, with `coveredFrom` marking how far back the counts are
      exact. Pi CPU cost unmeasured; the timeline is a first step towards a time
      cursor over trails.
- [x] Aggregate 24-hour maximum received range per bearing for ADS-B and AIS,
      based on explicit station location and valid timestamped positions
      (WG3, `GET /api/coverage`, in memory).
- [ ] Serve regional PMTiles, glyphs and style with bounded download/update and
      storage accounting; support the design's online fallback. Offline asset
      hosting follows the basic map and shared settings.
- [x] AIS types 4, 9 and 21 positions (WG5): base stations, SAR aircraft (with
      altitude) and aids to navigation (with aid type, virtual and off-position
      flags) decode to positions on the NMEA path; the JSON path is validated
      field by field. The AIS-catcher JSON key names for the new fields are not
      yet checked against a real sample.
- [ ] Extract positions from ACARS/VDL2 ADS-C/POS into the common envelope, with
      fixtures, validity and entity provenance.

## 9. Project license

Done 2026-10-09 (`df7e7ee`): split license. WaveKit is AGPL-3.0-or-later (root
`LICENSE`; core, `cli`, `shared`, `sdr-host`). `@wavekit/api-types` is MIT, so
client projects can import the API types and stay closed-source. The README
says that using WaveKit through its API does not put a program under the AGPL.
The bundled GPL decoders run as separate processes, so they are aggregated, not
linked. Open: `packages/brand` has no license field, because its fonts are OFL,
its icons are MIT, and brand assets are not relicensed silently. The
`wavekit-chan` crate is AGPL-3.0-or-later on main.

## 10. Agentic development setup modernisation

Landed locally at `cc3fd74`: `AGENTS.md` is the single instruction file; `CLAUDE.md`, `.kiro/steering/`,
`.github/instructions/` and the Kiro-only `.vscode/settings.json` are retired.
[`docs/AGENT-SETUP.md`](AGENT-SETUP.md) records which harnesses were tested loading it
natively (Codex, Claude Code, Grok CLI, omp) and the per-worktree shared-memory setup
(`node scripts/agents-setup.mjs`). Specs follow [`docs/specs/README.md`](specs/README.md).
`tests/unit/repo/` fails on drifted commands, paths, links, tool-enforced conventions,
competing instruction files and private-workspace exposure. The six legacy spec directories now live under `docs/specs/`, with contents and
numbering unchanged; the checker rejects tracked legacy specs. Historical coordination
entries retain their original paths. Remaining: verify VS Code chat if it becomes a used harness.

## 11. CI images and release validation

The main Docker workflow passes `CACHE_FROM_ONLY=false` through bake's target
`set` overrides; it is a bake variable and belongs in the step environment.
Fixing that wiring activates automatic image/cache publication on main pushes.

- [ ] Validate the channelizer/core ARM64 build in a nonpublishing build or PR,
      alongside AMD64, from a clean worktree and coordinated Docker window.
- [ ] Correct the bake variable wiring and check GHCR visibility/permissions
      before enabling multiarch publication. Publishing remains an explicit
      release step after architecture validation.
- [ ] Review Actions runtime/runner migrations separately from decoder correctness.

No release check substitutes for live RF or Pi clean-card acceptance.
