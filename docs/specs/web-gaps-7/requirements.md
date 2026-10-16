# Web gaps 7 requirements (WG7)

Status: frozen for implementation (spec and contract committed; lanes AMB, SQ, GT, BX, HW and
MIN pending). See [design](design.md) and [tasks](tasks.md).

## Scope

The seventh batch of core features the planned web dashboard needs, driven by the founding use
case (see a signal on the waterfall, and WaveKit says what it is): identify names AIS, ACARS,
VDL2 and LoRa (Meshtastic) emissions from the decoders that already run; an opt-in noise
squelch and a CTCSS/DCS tone squelch gate on the live demodulator, plus the fix of the observed
squelch noise tail; suggested tuner gain tables on receiver capabilities; opt-in band-plan skip
exclusions on scanner plans and a debounced refresh of decoded-elsewhere ranges when decoders
start or stop; cross-origin access to the audio streams in legacy mode; bounded numeric decoder
options; and a set of WG5/WG6 minors.

Out of scope: CLI and web UI features (the CLI and the web session get a coordination note
only); new scanner probes (no probe is spawned for AIS, ACARS, VDL2 or LoRa); per-tuner tuning
ranges (no cited per-tuner table exists that the rtl_tcp header could be matched against, see
5.6); decoder PATCH, a settings store and a recordings inventory (WG8); FFT sizes above 2 048
bins (WG8, measured on the Raspberry Pi first); tuner control over WebSocket; scanner defaults
(`skipBandPlanSkips` and `skipDecodedElsewhere` absent mean today's plans); squelch defaults
(`squelchMode` absent means `manual`, as today; no tone squelch unless configured); the
channelizer (stays off) and S2 (stays disabled); any change to the Activity caps, admission
limits, retention, coalescing windows or `activity.enabled`; the access default (`legacy`);
the files pinned by the band-plans spec (`src/decoders/band-region.ts`,
`src/decoders/band-defaults.ts`, `src/core/scanner/bandplan/index.ts`,
`src/core/scanner/bandplan/builtin.ts`); new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research (tests use synthetic audio, injected clocks,
fake decoders and self-written fixtures; no test opens a socket to anything but 127.0.0.1),
load runs. Real-RF acceptance of the squelch modes and the noise tail happens in one supervised
RF window after WG7 (task MA.4 prepares it; nothing runs on the receiver without the user's
go). CPU figures measured on the Raspberry Pi are open gaps, not acceptance criteria.

Every hot-path item states its CPU budget and its pipeline position in the design; every new
bound states its arithmetic and has a test at the bound.

## 1. Ambient identify for AIS, ACARS, VDL2 and LoRa

As a web user who sees an AIS, ACARS, VDL2 or Meshtastic burst on the waterfall and clicks
identify, I want WaveKit to name it from the decoder that already listens there.

1.1 `ScannerProtocol` gains `ais`, `acars`, `vdl2` and `lora`; `IdentityKind` gains `ais-mmsi`,
`acars-reg`, `vdl2-addr` and `lora-node`. Every protocol list that must be complete (store and
route schemas, `BANDPLAN_SCANNER_PROTOCOLS`, the protocol-keyed maps) lists them; the new
protocols have no probe decoder (`PROTOCOL_DECODER` null), so scan plans and cost estimates are
unchanged.
1.2 Ambient evidence: the `ais-catcher`, `acarsdec`, `dumpvdl2` and `lora-meshtastic` decoders
that already run (config owner) feed interpreters in `src/core/scanner/probes/confirm/` with
origin `ambient`, exactly like the four existing ambient types. No probe is spawned, no decoder
is started, stopped or retuned by identify or by ambient evidence.
1.3 **Trust rule.** An ambient decode becomes evidence only when all hold: the decoder is
running, owned by the config, not suspended and not an external-input decoder (its own device
hears another antenna); it reads the same WaveKit source as the observation; its reception
`tuningTrust` for the decode's frequency is `commanded` or `relay` (never `unverified`, and
absent trust counts as `unverified`); the decode carries a frequency that is one of the
decoder's own target frequencies (within 1 kHz); the message is CRC-clean (ACARS `error` 0;
dumpvdl2 frames as emitted; AIS sentences that passed the checksum; Meshtastic packets
decoded from RF, never `viaMqtt: true`); and an identity is attached only on its second
CRC-clean occurrence within one engine epoch (H2 double match). AIS maps channel `A` to
161 975 000 Hz and `B` to 162 025 000 Hz; a message without a channel is no evidence. ACARS
without a frequency is evidence only when the decoder has exactly one target. A VDL2 frequency
of 0 or non-finite is no evidence. Anything unknown, missing, malformed or throwing is no
evidence.
1.4 Evidence pairs with observations exactly as today (same source, `|centre − hz| ≤ max(1 500,
OBW/2)`, within ±2 s, `AMBIENT_PAIR_MS`); the four existing ambient types behave exactly as
before for every input (their interpreters and targets are unchanged).
1.5 Identify: for a target whose tolerance contains a target frequency of a running ambient
decoder that passes the decoder part of 1.3, the job plans one trial per such protocol with
`decoder` = the decoder type, `mode` = the decoder type, `transport: "ambient"` and no probe.
The trial is `decoded` when ambient evidence with an accepted identity for that protocol pairs
with the target's resolved observation during the job; it is `timeout` at the deadline and
`not-needed` or `cancelled` as other trials. A protocol the request lists explicitly without a
covering decoder is `unsupported` with reason `no-ambient-decoder`. Ambient trials never delay
or preempt probe trials and need no probe budget.
1.6 An identity accepted by an ambient trial makes the verdict `identified` (same rule as a
probe trial: the discovery must not be capped below `decoded`); the result names the protocol
and identity. Without ambient trials identify results are exactly as before.
1.7 `IDENTIFY_PROTOCOLS` lists the four protocols; a request may name them in `protocols`.
The `SCANNER_SOURCE_BUSY` and out-of-window rules are unchanged.
1.8 Bounds: one interpreter state per decoder per epoch (existing), each with the existing
`DoubleMatch` bounds (256 values per key, 4 096 accepted); at most 8 ambient trials per target
(`IDENTIFY_AMBIENT_MAX_TRIALS`).

## 2. Noise squelch

As a web user listening to NFM I want a squelch that opens on a carrier by how quiet the
demodulated audio becomes, so it works without finding a power threshold.

2.1 `squelchMode` gains `noise` (config, `PATCH /api/live-audio/config`, status and the
transmission DTOs); `manual` stays the default when the key is absent; `manual` and `auto`
behave exactly as before for every input.
2.2 In `noise` mode the gate opens when the high-frequency noise of the FM discriminator
output over a 10 ms block is at least `noiseQuietingDb` below the noise-only reference
(`LIVE_AUDIO_NOISE_QUIETING_DB` default 6, range 1–30 dB), with the existing 250 ms hang and a
2 dB hysteresis, and closes otherwise. The reference is the discriminator noise of a channel
with no carrier, derived from the channel bandwidth and rate (no calibration step, no
persistence).
2.3 `noise` mode is valid only with `nfm` or `wfm` modulation; config validation and the PATCH
route refuse it with any other modulation (400, as every invalid live-audio config), and a PATCH that
changes the modulation of a `noise`-mode config to a non-FM one is refused the same way.
2.4 Noise squelch is a gating squelch for the analog transmission tracker (transmissions open
and close on it); `live-audio:transmission` events carry `squelchMode: "noise"` and the
`noiseQuietingDb` in effect; `thresholdDbfs` keeps the configured `squelch` value.
2.5 On synthetic channels (Gaussian noise at the channel rate, with and without an FM carrier
carrying speech-like audio) at the default level: noise alone never opens the gate in at least
10 minutes of audio; a carrier at 12 dB carrier-to-noise ratio in the channel bandwidth opens
it within 50 ms; the gate closes within hang + 20 ms after the carrier stops.
2.6 CPU: at most 50 ns per channel IQ sample on the Mac for the noise measurement (1.25 ms per
second at 25 kHz NFM), measured and reported; no allocation per block.

## 3. Tone squelch gate

As a web user I want to hear only the transmissions carrying my CTCSS tone or DCS code.

3.1 `LiveAudioConfig.toneSquelch` (config, PATCH, status) takes the saved-frequency tone shape
(`{ kind: "none" }`, `{ kind: "ctcss", frequencyTenthsHz }` or `{ kind: "dcs", code,
polarity }`); absent or `none` means no tone gate (today). It is valid only with `nfm`
(400 otherwise, as every invalid live-audio config) and a CTCSS value must be one of the 50 standard
tones, a DCS code one of `DCS_STANDARD_CODES`.
3.2 With a tone set, the audio written to stream clients is muted (zero samples, stream timing
kept) until the squelch is open AND the tone is present: for CTCSS the existing 50-tone bank's
winner is the configured tone in 2 consecutive analysis blocks; for DCS the configured code
(or its inverted twin, which is the same bit stream) is decoded in 2 consecutive words. The
gate closes when the tone is absent for 2 consecutive analysis blocks (CTCSS) or 2 word
periods without a matching word (DCS), and at once when the squelch closes.
3.3 The tone gate mutes audio only: transmission events, Activity rows, tone results
(`tone.ctcssHz`, `tone.dcs`) and the level events are unchanged, so other users' transmissions
on the channel are still recorded.
3.4 `LiveAudioStatus.toneSquelch` reports `{ state: "off" | "waiting" | "open" }` while running.
3.5 Latency and false opens, synthetic: the gate opens within 1.0 s of carrier for CTCSS and
within 1.0 s for DCS; on the WG6 no-DCS corpora and on CTCSS tones one standard step away from
the configured one it never opens.
3.6 CPU: at most 5 ms per second of audio for the tone gate (one 8 kHz decimation shared with
the tone detector where possible), measured and reported; no allocation per block.

## 4. Squelch noise tail

As a listener I want the squelch to close without a burst of noise after each transmission.

4.1 The lane reproduces the reported ~0.75 s noise tail in a synthetic pipeline test (carrier
off → audio no longer muted), names its cause with evidence, and fixes it so that in `manual`
and `auto` mode at the defaults the unmuted noise after carrier loss lasts at most the 250 ms
hang + one 10 ms block + the back-chain delay the lane measures (stated in the report).
4.2 The fix keeps the threshold, hysteresis, hang and auto floor semantics (ROADMAP: "Preserve
current threshold/hang behavior"); transmission start and end times are unchanged except
where they were caused by the tail (then the change is stated).
4.3 If the cause lies outside the Node process (csdr buffering), the lane documents it with
the measurement and the fix stays within the Node pipeline; the RF window (MA.4) re-measures.

## 5. Suggested tuner gain tables

As a web user I want the gains my RTL-SDR tuner offers, to show a gain slider with real steps.

5.1 `ReceiverCapabilities.gainTable` is `{ state: "suggested", provenance:
"librtlsdr-tuner-gains", tuner, valuesTenthsDb }` when the current session's peer header is
`advertised`, its `tunerType` is in `RTL_TUNER_GAIN_TABLES` and its `gainCount` equals that
table's length; else `{ state: "unknown", reason }` with `header-not-advertised`,
`unlisted-tuner-type`, `gain-count-mismatch` or `no-gain-table` (FC2580 and unknown tuners,
whose librtlsdr list is the single placeholder 0); and `{ state: "not-applicable", reason:
"non-rtl-transport" }` on other transports. WG7 cores always send it.
5.2 `RTL_TUNER_GAIN_TABLES` is a cited constant (librtlsdr `rtlsdr_get_tuner_gains`, tenths of
dB, ascending): E4000 (type 1, 14 values), FC0012 (2, 5), FC0013 (3, 23), R820T (5, 29) and
R828D (6, 29, the same R82xx list); FC2580 (4) and unknown (0) have no table.
`RTL_TUNER_NAMES` maps types 0–6 to `unknown`, `E4000`, `FC0012`, `FC0013`, `FC2580`, `R820T`,
`R828D`.
5.3 The table is a suggestion matched on two advertised integers, not receiver evidence: it
claims nothing about the device, the gain command's validation is unchanged, and each value's
index is the `gainIndex` the same librtlsdr would use. Values outside the gain command's
validated range are still listed (the command rejects them as today); the lane states how many
fall outside.
5.4 Item and page byte bounds still hold (the largest table adds about 200 bytes).
5.5 This amends [receiver-capabilities requirement 1.3](../receiver-capabilities/requirements.md)
(no table inference): a cited gain table may accompany an rtl_tcp item when both advertised
integers match it.
5.6 Tuning ranges are not added: librtlsdr has no per-tuner range table the header could be
matched against (ranges in the wild are PLL-limit lore that varies by fork and dongle); a later
batch may add them with a cited source.

## 6. Band-plan skips on scanner plans

As an operator who marked bands `skip` in my band plans, I want a scan to leave them out when I
ask for it.

6.1 `ScanJobSpec.skipBandPlanSkips` (boolean, optional, absent = false, live-editable) makes the
skip-marked band-plan ranges exclusions of a sweep plan. With the flag absent or false the hops
equal today's hops for every spec.
6.2 Sources: every band of the resolved band-plan view (`ResolvedBandPlanView.bands`, operator
layer and every enabled pack, built-in or imported) whose effective `skip` is not null
contributes its resolved segments (the parts no higher layer names); hidden and shadowed bands
contribute nothing. At most 1 024 segments are examined (`BANDPLAN_SKIP_MAX_SOURCES`, in view
order).
6.3 `PlanPreview.bandPlanSkips` (and `ScanJob.bandPlanSkips`, runtime only) lists
`BandPlanSkipRange` entries (`startHz`, `endHz`, `bandKeys` sorted and unique, `applied`),
clipped to the job's enabled ranges, merged (overlapping or touching become one), sorted by
`startHz`, at most 256 (`BANDPLAN_SKIP_MAX_RANGES`); the key is absent when there is no entry.
Sweep and in-window jobs both report them; only sweep jobs with the flag apply them.
6.4 Applying: skips join the lockout exclusions before decoded-elsewhere ranges (an operator's
explicit plan marks first); if applying the skips would leave no hop, none apply and one
`warning` issue `bandplan-skips-not-applied` says so. Past a bound, one `warning`
`bandplan-skips-truncated` (only when at least one entry is reported).
6.5 Skips are evaluated when a plan is computed (preview, create, PATCH, restore and any replan
the service performs); a band-plan edit itself never replans or changes a running job (band-plans
requirement 1.2 holds), and the documentation says a new skip applies at the job's next plan.
6.6 A missing, throwing or malformed band-plan view yields no entries and plans exactly as
without it.
6.7 This amends [band-plans requirement 11.1](../band-plans/requirements.md): `skip` still does
not change the effective scanner list; it reaches a scan plan only through a job's own opt-in
`skipBandPlanSkips`.

## 7. Decoded elsewhere refreshed on decoder changes

As a web user I want a scan's decoded-elsewhere ranges to follow decoders that start, stop or
fail, without the scan restarting for nothing.

7.1 After a decoder is created, started, stopped, faulted, restarted or removed, or its health
or status changes, the scanner recomputes the decoded-elsewhere ranges of every job: trailing
debounce `DECODED_ELSEWHERE_REFRESH_DEBOUNCE_MS` (2 000 ms after the last change) and at most
one refresh per `DECODED_ELSEWHERE_REFRESH_MIN_INTERVAL_MS` (30 000 ms; a change inside the
interval refreshes at its end).
7.2 A refresh does nothing when the fingerprint of the coverage views (the fields the WG6 trust
rule reads) is unchanged; otherwise it uses the existing replan path, which emits only when a
job's list changed with an identical plan and replans only when the plan itself changed (a
job with `skipDecodedElsewhere`).
7.3 Timers are injectable; disposing the scanner clears them; a throwing view behaves as WG6
(no coverage). The WG6 documentation "plan-time only" is replaced by this rule.

## 8. Audio streams across origins

As the web app (served from another origin) I want to `fetch()` the live audio stream.

8.1 In legacy access mode every response of the audio HTTP servers (live demodulator and
digital voice: `/stream`, `/stream.wav`, `/decoders/<id>/stream[.wav]`, and their 404 and 503
answers) carries `Access-Control-Allow-Origin: *` beside the existing
`Access-Control-Expose-Headers`, and never `Access-Control-Allow-Credentials`.
8.2 In legacy mode `OPTIONS` on a stream path answers 204 with `Access-Control-Allow-Origin:
*`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Range` and
`Access-Control-Max-Age: 600`; other paths stay 404.
8.3 In protected mode nothing changes: the access layer answers preflights and sets
`Access-Control-Allow-Origin` only to an allowed origin with credentials, like REST; `*` is
never sent. Tests prove an allowed origin is echoed, a disallowed one is refused without the
header, and no protected response carries `*`.

## 9. Bounded numeric decoder options

As an operator I want a mistyped option to fall back or clamp, never to hang a decoder or reach
a shell.

9.1 Every numeric option a built-in adapter reads into argv, a loop, a timer, a buffer size or
a shell string is read through one helper that coerces numeric text as the option schema
does, treats non-finite or non-numeric values as absent (the adapter default), clamps
out-of-range values to the option's bounds by meaning, and logs one warning per decoder and key
without the value.
9.2 multimon-ng `verbosity` is an integer 0–10 (one `-v` per step).
9.3 Arrays that become argv entries are bounded (frequencies, rtl_433 `protocols`); the bound
per adapter is stated with its reason (the decoder's own channel limit where it has one).
9.4 No option value reaches a shell command line unless it is a finite number formatted by the
helper (the csdr `gain` stage of the audio-demod base); every `sh -c` interpolation of option
values is audited.
9.5 For every decoder in `config/*.yaml` and the test fixtures the argv and pipeline commands
are byte-identical to today's; option schemas gain the bounds the adapters now enforce, and
their descriptors agree.

## 10. Minors

10.1 `bandPlanImportUrlSchema` refuses an explicit port (also `:443`) and any `#` (also an empty
fragment) in the raw URL string, as the fetcher does.
10.2 A URL import committed with group overrides stores them in the provenance
(`importedProvenanceSchema.groupOverrides`, optional, at most 64); the update check applies them
to the fresh file; packs stored before WG7 load unchanged and check without overrides.
10.3 Config export: the keys outside decoder options that the sensitive-name pattern
over-redacts are exported when the schema types them as numbers and their meaning is a margin,
target count, limit or frequency (a reviewed exact-path list, each with its reason); nothing
else changes.
10.4 `APP_VERSION` is the root `package.json` version, injected at build time; tests and
unbundled runs use the same value.
10.5 The SDR# importer's character-reference bound is exactly 12 characters including `&` and
`;` (one off today).
10.6 The AIS vessel tracker reuses its per-vessel class-field and aid-to-navigation objects
instead of allocating per message.
10.7 A trail position row with duplicate JSON keys is read the same way by the SQLite probe and
by the parser (both refuse it, or both take the same value), with a test that inserts such a
row.
10.8 The relay-disconnect `tuningTrust` label: the lane reproduces the WG5 report (a `relay`
label left or turned `commanded` after the relay client disconnects) with a test; if it
reproduces, receptions after the disconnect are labelled by the rule of WG5 req 6; if not, the
lane shows the test and nothing changes.

## 11. E2 decided

11.1 E2 (config export policy) is decided 2026-10-16: keep as shipped (protected only, fail
closed by meaning). Web-gaps-6 requirement 7.3 and the `config-export.ts` comments say numbers
in decoder options are kept only from the reviewed numeric allowlist when their option schema
accepts them.

## 12. Main items

12.1 Main wires: the ambient targets, tuning trust and identify hook in the scanner service;
the band-plan skip view and the decoded-elsewhere refresh in the scanner service and
`src/index.ts`; the storage report's decoder list refreshed per scan from the decoder manager.
12.2 docs/API.md, ROADMAP and the coordination note (also addressed to the web session)
describe every new field, option and rule.
12.3 Main prepares the post-WG7 RF window (checklist and scripts) without touching the receiver.

## 13. Verification

13.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
13.2 The root suite, typecheck and lint pass at every merge.
