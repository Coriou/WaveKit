# Reliability and portable receiver roadmap

Updated 2026-10-09. The immediate software sequence is below; numbered sections
track related work and acceptance rather than blocking all work on hardware.
Software checks and hardware
acceptance are separate: a healthy process or passing unit suite does not prove
continuous IQ reception, correct RF decoding, or unattended installation.

## Immediate priorities (re-ordered 2026-10-09)

Done since 2026-10-08 (merged on main): Mac core deploy with tuner reconnect sync
and stall watchdog; trustworthy full suite; rate model B1–B4 (per-instance rates,
reversible suspension, `restarting`/crash-loop `faulted` health); bounded CSDR
rings default on (overnight soak: 0.0 % decoder loss, ~18 MiB vs ~5 GiB); the
2026-10-09 overnight follow-ups (rate-truth `rateMismatch`, band-aware
suspension, tuner `unknownFields`, persistent journal and boot report on the
Pi image); decoder band defaults with regions, persisted per-decoder band
overrides and operator-start pinning; `source:removed`; the signal-flat source
warning; the Pi operator page redesign on a single port 80 and the brand kit.

1. **Live audio follow-ups**. The live analog fixes and dsd-fme call segmentation
   were merged and verified over the air on 2026-10-09 (main 34f56e1). Evidence:
   `output/acceptance/voice-decode-2026-10-09.json`. Results: squelch silent when
   idle, clear NFM voice with `offsetHz`, and 2 PTT presses giving 2 DMR calls with
   0 CRC errors. Still open:
   - Latency: on 2026-10-09 most of the ~2-5 s lag was ffplay's own buffering.
     `curl | play --buffer 512` sounded almost instant (user). Measure the remaining
     stages (Pi queue, Wi-Fi, fanout, csdr rings, the 400 ms digital-voice jitter
     buffer) only if a real client needs lower latency.
   - A ~0.75 s noise tail when the squelch closes.
   - One of the two DMR calls ended by the 4 s fallback timeout because its TLC
     terminator was not decoded, so its duration stops at the last decoded line.
     The calls did not split. Call events now carry `startedAt`/`endedAt`
     ([DIGITAL-VOICE.md](DIGITAL-VOICE.md#call-duration-vs-event-timing-2026-10-09-anomaly)).
   - Lazy pipeline start when no client is connected (deferred).
   - `offsetHz` is set per decoder and is static; the channelizer replaces it.
   - Digital voice audio (§5b): merged and verified over the air (main 9ff133d,
     run10: 2 calls, CRC 0, FEC 0, 0.4 % muted, intelligible).
2. **Next Pi image acceptance** (candidate `operator-20261009`, software-verified
   only): clean-card flash on stable power, port 80 page, deliberate reboot with
   the clean-shutdown journal marker and boot report, dongle hotplug, Ethernet,
   Mac auto-reconnect and tuner replay. Waiting on the replacement power supply.
3. **Streaming stability on stable power**: 30-minute continuous baseline, then an
   overnight soak with decode counts and no external SDR++ client during it.
4. **CLI overhaul merge** (CLI team): done 2026-10-09, fast-forwarded on local
   `main` to `1baa845` (not pushed). Consumes the 2026-10-09 contracts up to
   87f9f06; only CLI paths changed. Rebuild `cli/dist` to pick it up.
5. **Core channelizer**: plan written 2026-10-09
   ([plan](superpowers/plans/2026-10-09-core-channelizer.md)); implement in a
   dedicated session after the CLI merge. Live evidence 2026-10-09 (loaded
   Mac, all nine decoders, 2.048 Msps): ~7.5 of 8 cores, every branch dropped
   8–36 %; four per-decoder `sox rate -h` resamplers cost ~1.5 cores. Band-aware
   suspension and pinning reduce load at a single tuned band in the meantime.
   In progress since 2026-10-09 on branch `feat/core-channelizer`. Fixture
   sourcing (user, 2026-10-09): synthetic IQ for AIS, POCSAG, APRS and ACARS;
   real captures for DMR and analog voice (operator's radio), rtl_433 sensors and
   aircraft; unlicensed public recordings may be used when fetched from their
   source and never redistributed.
6. **Spectrum and waterfall service** (§8): important, get it right. It feeds
   the CLI and web waterfalls and the scanner's discovery.
7. Later: API access/origin policy (prerequisite for host controls and a web
   UI); a stale `caps.centerFreq` after a retune that bypasses the relay can
   miss band suspensions. Also later: project license (§9) and agentic setup
   modernisation (§10).

The [channelizer research review](REVIEW-2026-10-08-CHANNELIZER.md) records the
buffer finding, corrected rate arithmetic, limits of the Pi benchmark and missing
fixture evidence. Exploratory research is not a final implementation spec.

### Status at end of 2026-10-08 (committed code; NOT yet deployed to the Mac app)

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
      connected/stale and never reconnected. Fix (stall watchdog) is merged but
      not yet deployed.

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
over Wi-Fi; a replacement supply is expected on 2026-10-09. Proceed with the
clean-card installer test on the current supply, recording any power events so
they are not confused with installer failures. Streaming stability acceptance
still requires stable power. Before erasing, verify the corrected payload and
identify the actual target disk again.

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
- [ ] Sample-rate model, WaveKit-wide: every decoder (including future ones)
      declares the input rate it works best at, the rates it accepts and the
      minimum below which it cannot work; the manager resolves each decoder
      against the source rate, suspends decoders with a machine-readable reason
      (`insufficient-sample-rate`) and resumes them when the rate rises; the
      per-decoder verdict (best / acceptable / unusable, with the reason) and the
      source's valid rate presets travel through REST/WebSocket/`api-types` so
      the CLI (and later web UI) can tell the user which rate suits which
      decoder. Keep capture requirements separate from adapter output and decoder
      stdin rates; unknown requirements remain explicit rather than disabling
      third-party decoders. The core already sets the upstream rate via
      `POST /api/tuner/:sourceId/sample-rate` and the SDR++ relay; keep both.
      A channelizer (`docs/RESEARCH-2026-10-08-CHANNELIZER.md`) gives each
      decoder an exact requested rate when supported, but cannot recover RF
      bandwidth absent from the capture. Passband/transition margins and source
      quality remain part of channel admission.
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
      merged; deploy and live re-test remain.
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

## 4. API and event foundation for multiple clients

The CLI is the first consumer; a future web interface must use the same public
contracts. Audit existing REST, WebSocket, SSE and binary/server streaming paths
before choosing extensions or promising compatibility.

REST routes have Fastify schemas and Swagger; `/ws` supports channel subscriptions
and caps incoming messages at 1 MiB. Outgoing payloads are now bounded per client
at 1 MiB/256 queued messages, with heartbeat and slow/dead-client cleanup. There
is still no sequence/replay or reconnect snapshot contract, and no SSE endpoint.
Authentication is absent from the
API layer and CORS reflects all origins with credentials enabled. Audio and IQ
use separate streaming servers; their per-client queues are now bounded. Prioritize
access/origin policy before exposing a browser UI.
These findings describe the current code, not completed API acceptance.

- [ ] Define typed, versioned schemas, capability discovery and consistent errors.
- [ ] Specify snapshot/event ordering, sequence IDs, reconnect/resume behavior,
      bounded replay and explicit gaps when history is unavailable.
- [ ] Provide filtered subscriptions, heartbeat/liveness and cancellation.
- [x] Bound WebSocket output queues, isolate slow clients and detect dead peers.
- [ ] Bound per-client buffers and define overload behavior independently for
      telemetry, decoder events, audio and IQ.
- [ ] Define authentication, origin policy, authorization and safe LAN exposure.
- [ ] Test simultaneous CLI/web clients, slow readers, reconnects, server restart,
      event ordering, resource cleanup and documented throughput limits.
- [ ] Publish examples and contract tests for REST, WebSocket, SSE and streaming.

## 5. Protocol-aware signal discovery and scanning

Study and prototype this as a major product feature once tuning, source ownership
and decoder lifecycle are reliable. A scanner should discover and characterize
activity, not merely stop on a strong signal.

- [ ] Scan an operator-selected frequency range or the receiver's supported tuning
      range with explicit steps, bandwidth, dwell time and exclusions.
- [ ] Offer protocol-specific searches, such as finding DMR activity, using suitable
      demodulators/decoders and distinguishing a candidate from a confirmed decode.
- [ ] Combine spectrum/activity detection with targeted decoding; report frequency,
      bandwidth, observed protocol, confidence, timestamps, signal measurements and
      available decoded metadata. Retain evidence and avoid duplicate discoveries.
- [ ] Schedule efficient coarse searches and focused revisits, with bounded CPU,
      memory and retuning overhead. Test weak, intermittent and overlapping signals
      using recorded fixtures and measured detection/false-positive rates.
- [ ] Define background scanning ownership: a single tuner cannot scan other bands
      while maintaining an unrelated live stream. Expose pause/resume, priorities,
      compatible in-window searches and additional-receiver options explicitly.
- [ ] Expose scan jobs, progress, cancellation and discovery reports through the
      shared API/events so CLI and future web clients have equivalent capabilities.
- [ ] Establish hardware/protocol limitations before promising whole-band coverage
      or identifying every signal. Treat encrypted/undecodable activity honestly.

## 5b. Digital voice audio

Requested by the user on 2026-10-09. Today dsd-fme runs with `output: "null"`: it reports
DMR call metadata (talkgroup, source, slot, color code, error counts), but nobody can
hear the decoded voice. Make digital voice a first-class audio stream, like live analog
audio.

- [x] Output decoded voice from dsd-fme (AMBE+2/IMBE via mbelib) for DMR first, then
      P25 phase 1/2, NXDN, dPMR, D-STAR and YSF where dsd-fme supports them. Stream it
      over the same HTTP/WS audio path as live demod, with per-call metadata
      (protocol, talkgroup, source, slot) attached. Done 2026-10-09: dsd-fme
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
showed the USB hotplug transition. A later visual polish of the status and
setup pages is committed but not yet in an image.

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

**Pi UI: one address for the user** (implemented 2026-10-09; ships
with the next image and its clean-card acceptance). Shape chosen: the port-80
service stays the owner and relays to the receiver after setup, instead of
handing the port over, so there is no gap and a stopped receiver falls back to
the setup page. Original request: Two ports (80 for
setup, 8080 for status) confuse operators. Goal: typing `http://<pi>/` always
shows the right page — the setup page while installing, the status page once
setup completes. Preferred shape: the status service takes over port 80 when
setup finishes (the early setup server releases it), with 8080 kept as a
compatibility alias or redirect; the early server's honest handoff check
(status page responds before switching) must survive. Ship in an image after
the 2026-10-08b candidate, with its own clean-card acceptance (setup → switch
→ reboot keeps port 80 on the status page).

## Delivery discipline

Review and publish coherent commits as each batch passes its relevant checks.
Keep credentials, SSH identities, local network settings, SD images, card backups
and raw diagnostic/session notes out of the public repository. Preserve local
artifacts while publishing only reusable examples and sanitized findings.
Record test results honestly, including skipped tests and hardware limitations.

## 7. CLI dashboard UI and UX overhaul

Run this as a dedicated design/implementation team alongside core reliability and
Pi operator-page work. Use Opus agents for implementation and review, with Fable
as a consultant for difficult product/design decisions and critical review.

Done 2026-10-09 (`1baa845`): user guide and validation in `docs/CLI.md`; rulings in
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
      Use half-block characters in true colour for two pixels per cell.

## 8. Spectrum and waterfall service, and activity detection

Important; get it right. Operators find activity today by watching SDR++'s
waterfall and waiting for an emitter to key up again. WaveKit should provide the
same view, and a program can do the watching more reliably than a person.

- [ ] A core spectrum service, independent of scanner jobs. It computes an
      averaged FFT of each source's IQ as a raw fanout consumer and publishes it
      on a general `spectrum` WebSocket channel. Rate and bins must suit a
      waterfall: 10 Hz or more and 1024 or more bins for the web; lower for the
      CLI. Late-joining clients get a snapshot.
- [ ] An activity detector on the full sample stream, not on display frames,
      so short TDMA or pager bursts are not missed. It keeps a per-bin noise
      floor and an N dB threshold, and merges adjacent bins into emissions with a
      centre, bandwidth, first and last seen times and a duty cycle. A persistent
      occupancy history keeps intermittent emitters known while they are idle.
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

## 9. Project license

Done 2026-10-09 (`df7e7ee`): split license. WaveKit is AGPL-3.0-or-later (root
`LICENSE`; core, `cli`, `shared`, `sdr-host`). `@wavekit/api-types` is MIT, so
client projects can import the API types and stay closed-source. The README
says that using WaveKit through its API does not put a program under the AGPL.
The bundled GPL decoders run as separate processes, so they are aggregated, not
linked. Open: `packages/brand` has no license field, because its fonts are OFL,
its icons are MIT, and brand assets are not relicensed silently. The
`wavekit-chan` crate is still marked ISC on `feat/core-channelizer` and will
move to AGPL there.

## 10. Agentic development setup modernisation

The repo has `.kiro/` (specs, steering), `.vscode/`, `CLAUDE.md`, private
memories and per-session handoffs, but no `AGENTS.md`. Replace this with one
cross-harness setup that has no duplication. It should heal itself when it drifts
from the code, and it should load only the context each task needs rather than
injecting every skill, rule and constraint into every model. Decide what stays
(`.kiro` specs or `docs/superpowers`), consolidate the conventions into one
source, and add checks so the instructions cannot rot silently.
