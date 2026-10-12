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
metering). Still open from that list: noise squelch, recording activity as a resume
hold and an EU 466 MHz pager plan without a citable primary source.

Order of the remaining core gaps, by what they unblock in the dashboard:

1. **Event foundation**: envelope publication, a persistent event store with
   search and facets, and replay from a cursor for activity and scanner events
   (Activity, Recordings, map history; §4, §4a, §5c).
2. **Browser access end to end** before browser controls touch the receiver
   (onboarding, renewal, TLS/proxy acceptance, operator data in the default
   deployment; §4). Read-only views and a mock data server do not wait for it.
3. **Band plans and settings**: the layered band-plan model fed to the scanner and
   spectrum labels, a persisted settings store with provenance, and core scan
   presets.
4. **Scanner and listening follow-ups**: running-range edits, identity search,
   recording activity, then S2/S3 acceptance (§5, §5b).

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
   implemented. Browser onboarding/renewal consumption, trusted canonical delivery
   and TLS/proxy acceptance remain open.
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
Open follow-ups include the ~0.75 s squelch noise tail, a DMR call ending by
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
- [ ] Expose per-tuner gain values and sample-rate presets through core capability
      discovery. Core already supports gain in tenths dB and gain index, and
      validates RTL sample-rate ranges; CLI presets are currently client-local.
      Reuse that foundation, report table provenance/unknown values honestly,
      and share presets with both clients.
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
is no general durable event replay contract or SSE endpoint. Operator data has
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

The [decode envelope spec](specs/decode-envelope/design.md) defines the
next unmounted foundation: caller-owned reception IDs, separate producer/ingestion
clocks, explicit unknown RF context and complete bounded decoded JSON. Public
publication and Activity persistence remain separate checkpoints; parser fallback
frequencies cannot establish event-time RF provenance.

- [ ] Add a common decode envelope with stable identity, category, title, fields,
      actual channel frequency, source/decoder/job provenance and raw JSON.
      Preserve existing decoder payloads; source centre alone cannot locate an
      offset probe's decode.
- [ ] Provide persistent, searchable events with paging and full-text indexing,
      including transcripts when available. Link discoveries, observations and
      recordings without making scanner recovery journals a public event API.
- [ ] Define live event replay from a cursor with snapshot ordering, duplicate
      handling, restart/retention gaps and filtered subscriptions. Separate
      durable Activity events from replaceable spectrum/status telemetry.
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
- [ ] Add automatic floor-based and noise squelch, and update controls without
      unnecessary pipeline restarts. Preserve current threshold/hang behavior
      and fix the observed noise tail.
- [ ] Expose AGC off/slow/fast where supported, including FM; implement real noise
      reduction, audio noise blanker, notch, CW BFO and DSB demodulation.
      Current filter presets and AM-based CW/DSB do not fulfill these controls.
- [ ] Detect CTCSS and decode DCS code/polarity; expose tones on live status and
      transmission events, saved frequencies and tone squelch. Reuse scanner
      Task 41 channel features; its DCS presence boolean is not a decoded code.
- [ ] Emit analog transmission start/end/duration events from squelch with stable
      identity and recording links. Detector tracks and squelch transmissions
      have different boundaries; reconcile them explicitly.
- [ ] Expose DMR talker alias and a defined error-rate measure after verifying
      pinned dsd-fme output. Existing CRC/FEC counts and internal bad-signal
      ratio do not establish voice BER or an alias parser.

## 5c. Recording catalog, capture and playback

Reuse digital per-call WAVs, scanner evidence retention and the planned S2
analog recorder. A shared catalog links each recording to its provenance;
existing IDs need a compatibility strategy. Every deletion owner must honor
retention and Keep. Discovery Keep protects an emitter's evidence collectively;
recording Keep protects one recording independently.

- [ ] Record analog transmissions and digital calls automatically across supported
      live and scanner paths; expose bounded retention and playback by ID with
      seek. Scanner WAV download alone does not provide seek or all-call coverage.
- [ ] Keep/star individual recordings across clients; un-keeping restores normal
      retention. Define disk reserve/low-space behavior and coordinate the
      digital WAV pruner with scanner/catalog retention before enabling this.
- [ ] Support manual recording with name/note and non-destructive in/out trim;
      apply trim to playback and exported downloads.
- [ ] Capture the viewed IQ span and export SigMF; play captures as a source for
      spectrum, audio and compatible decoders, then restore live ownership.
      Reuse paced IQ file sources and scanner Task 34a capture/decimation rather
      than implementing another playback engine. Reconcile recording-source
      capability metadata and spectrum/live-audio eligibility.
- [ ] Expose storage totals: kept bytes, automatic-recording bytes, free space,
      configured/effective retention and reasons for any shortened retention.
      Existing evidence low-disk guards stop writes; do not claim automatic
      retention shortening until it is implemented.
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
      CLI. Late-joining clients get a matching snapshot. Scanner Task 37a owns
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
      `wavekit-chan` already reads the full CU8 stream per source.
- [ ] A stale `caps.centerFreq` (a retune from SDR++ that bypasses the relay)
      puts the frequency axis and every emission centre on the wrong RF. Fix it
      or show it as untrusted.

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
- [ ] Measure coalesced REST drag-to-tune and accepted-state latency; then decide
  WS tuning. Any transport reuses authorization, ordering, scanner preemption
  and tuner origin semantics.
- [ ] Implement source/channel DC removal, IQ correction and IQ swap as measured
  sample-processing controls. Existing DC/image/spur masks only affect detection
  and display; the ignored legacy IQ DC-block flag must not imply correction.

## 8b. Positions, maps and coverage

Extend existing ADS-B state and bounded in-memory trails. Durable cross-protocol
position history belongs with §4a's event foundation; map reception coverage is
separate from scanner RF sweep coverage.

- [ ] Store station latitude/longitude/altitude with provenance, configurable by
      clients, and pass location to readsb independently of the current
      `enableMlat` option gate. When unset, derive a visibly approximate location
      from received positions; do not use that estimate as authoritative station
      coordinates for coverage. gpsd is a later extension.
- [ ] Serve aircraft, vessel, APRS and mesh position trails with persistent
      last-hour replay and a time cursor; reuse existing ADS-B tracking.
- [ ] Aggregate 24-hour maximum received range per bearing for ADS-B and AIS,
      based on explicit station location and valid timestamped positions.
- [ ] Serve regional PMTiles, glyphs and style with bounded download/update and
      storage accounting; support the design's online fallback. Offline asset
      hosting follows the basic map and shared settings.
- [ ] Extract positions from ACARS/VDL2 ADS-C/POS and AIS type 21 into the common
      envelope, with fixtures, validity and entity provenance. Generic AIS JSON
      lat/lon and current NMEA types 1/2/3 are only partial foundations.

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
