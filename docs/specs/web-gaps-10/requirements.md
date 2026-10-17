# Web gaps 10 requirements (WG10)

Status: frozen for implementation. See [design](design.md) and [tasks](tasks.md).

## Scope

The tenth batch of core work the web dashboard needs, driven by a live session on the WG9 base:
recording follow-ups (scanner recording deletion with discovery bookkeeping, protection of the
folders a discovery merge or eviction leaves behind, kept totals in the storage report, a safe
sweep of crash leftovers of a delete); smooth live audio (a click-to-tune inside the band no
longer interrupts the stream, clients stay attached across every pipeline restart, the auto
squelch floor cannot be seeded by the carrier it should open on, the operator's first frequency
command proves the sample rate, and the untracked-retune trust warning is root-caused); and an
identify that answers for analog voice, the traffic users click most, and says clearly when the
probe decoders cannot run on this core.

Out of scope: web UI and CLI features (coordination note only); trim, export, SigMF, rename or
any recording write other than Keep and delete; analog (`analog-<uuid>.wav`) scanner recording
deletion (S2 stays disabled; refused as today); moving recording files between discovery
folders; the catalog's stable ids, generation-fenced scanner Keep handshake, file leases, delete
intents and per-filesystem reserve; a new identify `outcome` or `state` value; a new probe
decoder or an in-process FM demodulator for identify; identify retuning live audio; WebSocket
tuner control; the channelizer (stays off) and S2 (stays disabled); scanner defaults including
`scanner.sweep.settleMs.network` (1 000 ms); the Activity caps, admission limits, retention,
coalescing windows and `activity.enabled`; the access default (`legacy`),
`STATION_WRITE_REQUIRES_ACCESS` and `RECORDING_KEEPS_REQUIRES_ACCESS` (stay true); the files
pinned by the band-plans spec; new npm dependencies.

Hard gates (no lane may do these): RF, tuning, receiver or Raspberry Pi work, deploys, Docker
builds or runs, network access or data research. Tests use fake decoders, fake child processes
or local stand-in processes, a fake rtl_tcp server on 127.0.0.1, temporary directories,
synthetic IQ and injected clocks; no test opens a socket to anything but 127.0.0.1.

Defaults stay byte-identical except where a requirement here changes them on purpose (2.1 to
2.4 live audio continuity, 2.6 auto floor seeding, 2.8 operator rate write, 2.9 warning fields
and rate limit, 3.x identify analog evidence and unavailable memo, 1.x deletion paths, 4.1 and
4.2 startup log levels). Each lane proves the rest against goldens recorded from the frozen code
and lists every golden it changes with the requirement that changes it. Every hot-path item
states its CPU budget and pipeline position in the design; every new bound states its arithmetic
and has a test at the bound.

Background (generic): on a receiver with a strong handheld transmitter a few metres away, every
click-to-tune inside the band restarted the whole live demodulation pipeline (about twenty times
in six minutes) and the web player showed "Connecting…" each time; the auto squelch reported a
floor about 20 dB below a -2 dBFS carrier; the spectrum engine raised repeated "untracked-retune"
trust warnings (delta about -273 kHz, sometimes null) while no other client was connected to the
receiver; the "Frequencies unverified" badge never cleared because the web commands only the
frequency; and Identify on analog PMR voice (no digital decoder there, and no probe decoders
installed on that core) said nothing useful. Two startup warnings were also seen on every boot
(section 4).

## 1. Recording follow-ups

As an operator I want to delete a scanner recording I do not need, keep the protection of
recordings whose discovery was merged or evicted, see what my keeps cost, and never lose or leak
a file because a delete was interrupted.

1.1 `DELETE /api/recordings/:id` accepts a `scan:` id of a scanner digital voice recording
(`recordings/dv/<discovery>/<file>`), with the same rules as a dsd-fme delete (protected mode
only, authorize first, kept → 409 `RECORDING_KEPT`, Keep and delete of one key serialised, the
loser 409 `RECORDING_BUSY`, verified open, unlink only of the same file by device and inode, a
vanished file 404 `RECORDING_NOT_FOUND`, the inventory listing invalidated). An analog scanner
recording (`analog-<uuid>.wav`), a scanner without a deleter wired, or a file the scanner does
not own answers 409 `RECORDING_DELETE_UNSUPPORTED` as today.
1.2 The scanner bookkeeping follows the delete through the coordinator: the deleted id leaves
the owning observation's `recordingIds` and the discovery's `evidence.recordings` drops by one
(never below zero), journaled like every other discovery change, and a `discovery` event
`updated` is emitted. The file is unlinked first and the bookkeeping written after; a
bookkeeping failure after the unlink leaves a dangling id that resolves to no file (logged as a
count, answered 200: the file is gone). A delete of a recording whose discovery is being removed
answers 409 `RECORDING_BUSY`.
1.3 The scanner side never deletes outside its own storage root, never follows a symbolic link
(any ancestor included) and runs the deletion decision in the same synchronous turn as the
unlink (WG9 2.5). A discovery folder swapped between verification and unlink deletes nothing.
1.4 Logs and bodies name no path, file name, directory, key or id (counts, codes, fixed text).
1.5 **Merge keeps the dropped folder's meaning.** When a discovery merge drops discovery D into
survivor S, D's recording and evidence folders stay where they are and S adopts them as an alias
(persisted with S, at most `DISCOVERY_RECORDING_ALIASES_MAX` = 64 aliases per discovery; beyond
that the oldest alias is released and its folder becomes an orphan, warned as a count). For an
alias folder: retention treats its files as S's (S's operator `keep` protects them),
`recordingPath` resolves its ids, `discoveryHoldsKept(S)` is true when any alias holds a kept
key, and deleting or pruning S removes the alias folders with S (refused 409 when any holds a
kept recording). Keep keys never change (no file moves, no rekey).
1.6 **Eviction removes what it evicts.** A capacity eviction removes the evicted discovery's
folders (and its aliases) exactly as an inactive prune does; eviction keeps skipping a
discovery that holds kept recordings (WG9 2.6), and the removal consults the deletion decision
per file.
1.7 An orphan folder (no live discovery, no alias owner, no pending removal) keeps today's
retention behaviour: its kept files stay protected by their keys and the rest follow the age and
size caps. Merges and evictions made before this batch keep their orphans (recorded gap).
1.8 **Storage report kept totals.** `StorageReport.kept` reports the keep store: in state
`ready` the number of kept recordings, their bytes (each counted at its size when kept) and the
two bounds; `failed` or `loading` without counts; `null` when no keep service is wired (legacy
mode). No filesystem access is added to the report for it.
1.9 **Crash leftovers of a delete.** A delete moves the recording into a private directory
before its final check. The delete records its progress in the private directory by name: the
moved entry keeps the recording's own file name until the identity check passed, and is renamed
to the fixed name `verified` before its unlink. At startup (before any pruner or retention
runs), a sweep inspects the private directories in the recording directories it knows (every
dsd-fme recording directory and its `WAV` and `wav` folders (one directory listed once),
every scanner `recordings/dv/<discovery>`
folder), bounded, and acts only on a directory that is provably ours: name
`.wavekit-delete-` plus the six `mkdtemp` characters, a real directory (no symbolic link
anywhere on the way), owned by this process's uid, mode exactly 0700, inside a configured
root. In such a directory: only `verified` (a regular file) → unlinked (it passed the identity
check and was not kept when it did; it is never listed, so no Keep can name it since) while the
keep store is `ready`, else left; only one entry named like a recording (unverified) → restored
under that name in the parent without replacing anything (taken name → left); empty →
removed; anything else (several entries, symbolic links, other names, WG9-format `recording`
entries) → left in place and counted. One info line with counts per sweep; never a name or
path. Unknown uid (no `process.getuid`) → nothing is swept.
1.10 The capture store's startup cleanup never removes or recurses into a directory: the
staging directory `captures/.tmp` is not a torn write (the warn "Path is a directory" on every
boot disappears), entries inside it that are not regular files are left and counted, and a
`.tmp` that is a symbolic link or not a directory is not swept (fixed-text warn).
1.11 With no keep service, the legacy mode and the shipped config, every pruner, retention run,
route and log line is byte-identical to the WG10 base except 1.5 (merge aliases are recorded
and honoured in legacy mode too; amended at Main merge), 1.6 (evicted folders now removed) and
1.10 (no EISDIR warn). The 1.9 startup sweep runs in protected mode only.

## 2. Smooth live audio, squelch and tuning trust

As a listener I want audio that keeps playing while I click around the band, a squelch that
opens on a strong nearby signal, and frequency labels that become trusted once I tune.

2.1 **Clients survive restarts.** No live-audio HTTP client is disconnected by a pipeline
restart, an offset change, a squelch change or a source caps change unless the stream's sample
rate or sample format changes (then today's close-and-reconnect stays).
2.2 **Silence fill.** While a restart keeps the stream format and the new pipeline has not
produced audio yet, attached clients receive silence in the stream format at the stream rate in
chunks of `LIVE_AUDIO_SILENCE_CHUNK_MS` (20 ms), for at most `LIVE_AUDIO_SILENCE_FILL_MAX_MS`
(5 000 ms) per restart; the fill stops at the first real audio chunk, at a stop or failure, or at
the bound. Silence is never emitted on the `pcm` event (tone detection, transmissions and
recordings never see it) and is not counted as a transmission.
2.3 **Offset change without a pipeline restart.** A reconfigure whose only pipeline-relevant
change is `offsetHz` (same channel rate, same back stages) keeps the back process, its stdin and
every client: a new front process is started with the new offset, the branch feeds both fronts
until the new one produces its first channel IQ, the squelch input switches to the new front at a
whole complex sample (the partial sample of the old front is dropped), and the old front is
stopped. If the new front produces nothing within `LIVE_AUDIO_FRONT_SWAP_TIMEOUT_MS` (2 000 ms)
or fails, the reconfigure falls back to the full restart with silence fill (2.2). The squelch
floor handling is the retune handling (WG9 5.6). A config change of any other pipeline key
still restarts both processes (clients attached, 2.1 and 2.2).
2.4 **Measured.** The lane measures, with local stand-in processes for the two csdr stages
(not csdr) and a fake IQ branch, the audio gap a client sees on an offset change and on a full
restart, before and after (bytes missing against real time, p50/p90/max over at least 20
changes, load average); budget: zero client disconnects; offset change gap p90 at most 50 ms;
full restart gap fully covered by silence.
2.5 Defaults byte-identical otherwise: the planned argv of both stages, the logs of a start,
stop and full restart (one added debug line at most), the status DTO and the stream headers.
2.6 **Auto floor not seeded by a carrier.** In auto squelch mode on `nfm` or `wfm`, a 10 ms
block whose FM quieting is at least `LIVE_AUDIO_NOISE_QUIETING_DB.default` (a carrier is present)
never seeds the floor and never raises it; until the first block without quieting seeds the
floor, the gate follows the quieting decision (as noise mode) so a carrier already present at
start or after a retune is heard at once. Falls still apply. `am`, `usb`, `lsb`, `dsb`, `cw`
and `raw`, and the manual and noise modes, are byte-identical. The WG9 5.6 re-seed stays.
Overload (a channel power within 3 dB of full scale) is verified not to open, hold or close the
gate differently in manual mode; any defect found is fixed and listed.
2.7 The status and level `noiseFloorDbfs` stays absent until a floor exists (as today on cold
start).
2.8 **Operator frequency proves the rate (deliberate behaviour change).** A `POST
/api/tuner/:sourceId/frequency` and a `PUT` tuner update that sets the frequency without a sample
rate, in internal control mode, first write the sample rate the core already holds, once per
connection, when that rate is declared only or not written on the current connection
(`tuningWrittenOnConnection` false), and never when the rate is unknown (a placeholder), when
the source is under external or relay control, or when the rate is already proven on this
connection. The value never changes; the write is a command of origin `rest`, so the trust label
becomes `commanded` after the first operator tune. A failed rate write fails the request with
today's tuner error and no frequency write. The scanner path (WG9 hop rule) is unchanged.
2.9 **Untracked-retune root cause.** The lane determines from code and synthetic reproduction
whether the core itself can raise "untracked-retune" with no external client: at least an IQ
byte slip (a dropped odd byte count swaps I and Q, which mirrors the spectrum: Δ = -2 × the
feature offset from centre), a strong transmitter with its images and intermodulation products
that end together, a core command whose epoch boundary lands in the wrong block (live audio,
scanner, relay replay, the 2.8 rate write), and a source reconnect. Every in-core cause found is
fixed with a regression test. The alarm keeps firing on a genuine untracked retune (golden), and
each warning carries `suspected` (`iq-byte-slip` when the vanished features reappear mirrored
about the centre, `signal-change` when they vanished without a common shift and a strong
transmission ended, `external-control` otherwise) and `lastCommandAgeMs` (time since this core's
last command on the source; null when none). The warn log is rate-limited to one line per source
per `SPECTRUM_WARNING_LOG_INTERVAL_MS` (60 000 ms) with a suppressed count; the warning list
keeps every warning.
As landed (R1): a U8 mirror no longer re-aligns the stream; `iq-byte-slip` is a `suspected`
label only. `signal-change` needs a closed strong track and width-matched survivors (at least 2):
a survivor's centre lies within `max(1 bin, width/4)` of the feature and its width within
`[width/2 - 2 bins, 2*width + 2 bins]`. The decision can wait up to the track hang plus 2 blocks.
2.10 Nothing in 2.x changes the spectrum frame, transmission or WebSocket shapes beyond the
optional warning fields; trust label values change only by 2.8.

## 3. Identify for analog voice

As a web user clicking an analog FM voice signal I want Identify to tell me it is analog voice
and its sub-audible tone, and to tell me when this core cannot run the digital decoders.

3.1 **Analog evidence.** Identify consults the live demodulator's closed analog transmissions
(WG1 tracker, tone from WG2 and WG6): a transmission is evidence for a target when its
frequency is not null, lies within the target's tolerance (`max(1 kHz, bandwidth/2)`), and it
ended no earlier than `IDENTIFY_ANALOG_LOOKBACK_MS` (30 000 ms) before the identify job started
and before the job ended. At most `IDENTIFY_ANALOG_MAX_TRANSMISSIONS` (32) recent transmissions
are kept in total (oldest dropped). Absent port: today's behaviour byte-identical.
3.2 The `analog-fm` and `analog-am` trials (today `unsupported`/`no-decoder`) become ambient
trials of decoder `live-audio` (mode: the live-audio modulation) when the port is wired: outcome
`decoded` once a matching closed transmission exists, `timeout` when only a matching open one is
present at the deadline, `no-sync` when live audio was on the target during the window but no
transmission matched, `unsupported` with reason `no-live-audio` when live audio was not running
or not tuned within the tolerance for the whole window. A matching `nfm`/`wfm` transmission
answers the `analog-fm` trial and an `am`/`dsb` one the `analog-am` trial; other modulations are
no evidence. The outcome list and the identify state list are unchanged.
3.3 A matching analog trial is a stop like an accepted identity unless `exhaustive`. A digital
decode keeps priority over analog evidence.
3.4 **Verdict and result.** Without a digital decode, a matching transmission with a CTCSS tone
or a DCS code and trust `commanded` or `relay` makes the target `identified` with protocol
`analog-fm` (or `analog-am`), confidence `classified`, `result.analog` filled and
`result.metadata.ctcssHz` set when a CTCSS tone was heard; without a tone, or with trust
`unverified`, the target is at least `candidate` with the same protocol and `result.analog`.
`result.analog` carries the source (`live-audio`), modulation, number of matching transmissions,
the latest transmission id, its CTCSS tone or null, its DCS code or null and its tuning trust.
Never a tone the tracker did not report. As landed (R1): a classified digital discovery keeps its
protocol; analog evidence never replaces it and stays supplementary in `result.analog`.
3.5 **Unavailable decoders said clearly.** `result.decodersUnavailable` lists the probe decoder
types (sorted, unique) whose program could not run during this job (WG9 `decoder-unavailable`).
The probe pool remembers a decoder type found unavailable for `PROBE_UNAVAILABLE_MEMO_MS`
(300 000 ms); while remembered, identify plans that type's trials as `unsupported` with reason
`decoder-unavailable` without spawning, and lists the type. A successful start of that type
clears it. A genuine `no-sync` (the decoder ran and heard nothing) stays `no-sync`.
3.6 The CLI identify guard keeps parsing every new payload (outcome and state unchanged; `decoder`
and `reason` free text; new result fields stripped); the lane runs the guard check.

## 4. Startup log minors

4.1 The capture store staging warn (1.10).
4.2 A passive spectrum or scanner start for a source that has not connected yet (no caps) is not
a warning: the passive job is not attempted until the source's first `connected` (the existing
retry path), logged at debug; a spectrum subscriber before connect is answered as today and its
engine start failure for that reason logs at debug. A source that connected and is genuinely not
IQ keeps today's warn. The recovery path on `connected` is verified by a test.

## 5. Main items

5.1 Main wires: the scanner recording deleter into the keep service and the scanner service
(the lanes' exact diffs to `src/core/scanner/scanner-service.ts` and
`src/core/scanner/store/**`), the delete leftover sweep at startup, the keep totals into the
storage report, the analog evidence port from the transmission tracker into identify, and the
passive pre-connect change.
5.2 docs/API.md, ROADMAP, SCANNER and the coordination note (for the CLI and the web session)
describe every new route behaviour, field, bound and rule; the CLI guards are checked.

## 6. Verification

6.1 Each property in the design has a fast-check test with `numRuns >= 100` and the trace
comment.
6.2 The root suite, typecheck and lint pass at every merge.
