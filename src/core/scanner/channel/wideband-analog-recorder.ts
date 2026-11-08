/**
 * Default-on analog voice recorder fed from the scanner's own wideband IQ ring. It needs no
 * channelizer and no channel tier. A clean narrow track (or a peaked one a neighbouring line
 * widens within a channel, startsWide) starts one session per channel, which
 * reads the engine ring from `hold.preRollMs` before the onset, demodulates NFM
 * (`WidebandNfmChain`) and writes 8 kHz WAV files through the evidence store's analog
 * operations (`recordings/analog/<discoveryId>/`, storage cap, disk-low and retention apply).
 * `TransmissionSegmenter` decides the files: one per transmission, a gap shorter than
 * `hold.hangMs` never splits. Work runs in bounded slices off the engine's tap callback, as many
 * a turn as fit WIDEBAND_TURN_BUDGET_MS, and more for the one session closest to falling out of
 * the ring (WIDEBAND_RING_MARGIN_MS, one grant a turn): a slow event loop delays a recording
 * instead of losing it.
 *
 * A session does not wait for the classifier: a clean, non-burst track in a range a band plan
 * lists for analog FM (or no band plan covers) starts a shadow session as soon as it appears.
 * Its audio stays in memory (no store operation, nothing on disk) until the observation is
 * classed analog-fm (any snapshot, the closing one included, or its own audio: speech over a
 * stable standard CTCSS tone, `classByTone` and tone-class.ts, a class of the recorder only) and
 * the file's audio sounds like voice (`VoiceActivityGate`); then the store operation begins and
 * the buffered audio is written. A session closed without that class, or given a definite other
 * class (the caller's `nonAnalog`: decoded or channel-tier, never a spectral class alone) before
 * a snapshot classed it analog-fm, is discarded. A file whose audio never sounds like voice (a
 * spur, an idle or CTCSS-only carrier) is never written and a session not voiced after
 * WIDEBAND_QUALIFY_MS of in-track audio ends. An unclassed shadow is not ended by time (a class
 * may arrive only at close): it is bounded by the 60 s buffer and gives its slot to any candidate
 * classed analog-fm (eviction). A shadow of a track with a spectral digital class has the lowest
 * slot priority and a bounded time to be classed (WIDEBAND_DIGITAL_QUALIFY_MS,
 * WIDEBAND_DIGITAL_CLASS_MS); a session classed by its own audio only keeps a low priority and
 * a bounded hold (WIDEBAND_TONE_ONLY_HOLD_FRAMES), and each of its files is checked again over
 * the whole file when it finishes.
 */
import type { TrackSnapshot, TuningTrust } from "../../spectrum/types.js"
import { safeErrorFields } from "../../../decoders/safe-error-fields.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import { CtcssBank } from "../../audio-tones/ctcss.js"
import { ulid } from "../ids.js"
import type {
	AnalogCut,
	AnalogGap,
	AnalogHandle,
	AnalogInput,
	AnalogReceipt,
} from "../store/analog-operations.js"
import {
	AnalogCutSchema,
	AnalogFailureSchema,
	ErrorSchema,
	MAX_ACTIVE_ANALOG_PER_SOURCE,
} from "../store/analog-operations.js"
import {
	RecordingBindingSchema,
	recordingEngineInstanceId,
	type RecordingBinding,
} from "../store/recording-operation.js"
import { ANALOG_AUDIO_RATE_HZ } from "./fm-audio.js"
import {
	TransmissionSegmenter,
	type SegmentEndCut,
	type SegmentEvent,
} from "./transmission-segmenter.js"
import { VoiceActivityGate, VoiceOnAirMeter } from "./voice-activity.js"
import { ToneClassEvidence } from "./tone-class.js"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmChain,
	widebandNfmSupported,
} from "./wideband-nfm.js"
import type { ProofAnalogInput } from "../scanner-redesign-contract.js"
import type {
	ScannerRecorderDecision,
	ScannerRecorderDiscovery,
	ScannerRecorderFlag,
	ScannerRecorderFlagDetail,
	ScannerRecorderFlagSource,
	ScannerRecorderSession,
	ScannerRecorderStatus,
} from "@wavekit/api-types"
import {
	VOICE_BLOCK_FRAMES,
	VOICE_MIN_FINAL_FRAMES,
	VOICE_WINDOW_BLOCKS,
} from "./voice-activity.js"
import { RecorderDecisions, type ReceiptDetail } from "./recorder-decisions.js"
import type { RecordingActivity } from "../scheduler.js"

/** Same bound as the channel-tier trigger: a 25 kHz NFM channel's occupied bandwidth. */
export const WIDEBAND_MAX_OBW_HZ = 16_000
/** A track this close to a recording channel joins it (under half a 12.5 kHz raster step). */
export const WIDEBAND_JOIN_TOLERANCE_HZ = 5_000
/**
 * How late a decision may be: the engine closes a track one 500 ms track hang after it went
 * quiet and reports opens a few 10 to 50 ms blocks late, so 1000 ms covers both with margin.
 * The voice gate and the CTCSS bank hear audio this late too (the spans are final by then).
 */
export const WIDEBAND_HOLDBACK_MS = 1_000
/** WAV and analog-operation bound: 960 000 frames = 120 s at 8 kHz (MAX_WAV_DURATION_SECONDS). */
export const WIDEBAND_MAX_FILE_MS = 120_000
/**
 * Audio one session holds in memory, over all its files not written yet: a shadow waiting for
 * its class, a file waiting for its slot or for the writer. 60 s (the default hold.maxHoldMs)
 * · 8000 frames/s = 480 000 frames · 2 B = 960 KB per session; at most
 * MAX_ACTIVE_ANALOG_PER_SOURCE (2) sessions per source: 1.92 MB. Past it the session is dropped
 * (no file): a transmission still unclassed after a minute is not kept, and a store that does
 * not take audio for a minute loses it.
 */
export const WIDEBAND_MAX_BUFFERED_MS = 60_000
export const WIDEBAND_MAX_BUFFERED_FRAMES =
	(WIDEBAND_MAX_BUFFERED_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * In-track audio a session may hear without its voice gate passing: 8 s = 64 000 frames. Past
 * it the session ends and its observations are refused (a steady or idle carrier holds no slot
 * and no CPU for longer). A voice qualifies on one 500 ms window, usually in the first second.
 */
export const WIDEBAND_QUALIFY_MS = 8_000
export const WIDEBAND_QUALIFY_FRAMES =
	(WIDEBAND_QUALIFY_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * A classed session not qualified after this much in-track audio (2 s = 16 000 frames, four
 * gate windows) may be evicted for a candidate classed analog-fm when every slot is held; a
 * younger one is not, so a voice that has not been heard for a full window yet is never
 * displaced. An unclassed session without a store operation may be evicted for such a
 * candidate at any age.
 */
export const WIDEBAND_EVICT_MIN_HEARD_FRAMES = 2 * ANALOG_AUDIO_RATE_HZ
/**
 * A shadow whose track has a spectral class other than analog FM (`spectralDigital`: a narrow
 * data signal, or a weak voice the spectrum misreads) must sound like voice within 3 s of
 * in-track audio (24 000 frames) and be classed (by a snapshot or classByTone) within 12 s
 * (96 000 frames), or it is discarded and frees its slot. 12 s: classByTone needs at least
 * 2.25 s of tone blocks and 2.5 s of speech frames (tone-class.ts), which the tests' synthetic
 * voices meet 3.6 s after their onset (judged 1 s late), the weak one (one pitched syllable in
 * six at 11.9 dB) at 20 % periodic frames against the 10 % needed. 12 s, 3.3× that, leaves an
 * over whose pitched frames reach the share only later (a lead-in, pauses, a weaker voice)
 * time to be classed. An expired observation starts no other shadow in the same visit (stream and
 * epoch: only a later analog-fm snapshot starts a recording for it then), so an unclassed data
 * track holds a slot once per visit, for at most 12 s of signal judged up to WIDEBAND_HOLDBACK_MS
 * late: 13 s. Two bounds keep it from holding one others wait for that long: its slot goes to
 * any waiting candidate once its current file can no longer pass the tone test
 * (ToneClassEvidence.toneCanHold: no standard tone within TONE_CLASS_MAX_GAP_BLOCKS, at the
 * earliest 2.5 s of in-track audio, 3.5 s judged late), and once WIDEBAND_EXPIRED_STALE visits
 * of the observation expired unclassed. A session classByTone classed holds a slot others wait
 * for for a bounded time too (WIDEBAND_TONE_ONLY_HOLD_FRAMES).
 */
export const WIDEBAND_DIGITAL_QUALIFY_MS = 3_000
export const WIDEBAND_DIGITAL_QUALIFY_FRAMES =
	(WIDEBAND_DIGITAL_QUALIFY_MS / 1000) * ANALOG_AUDIO_RATE_HZ
export const WIDEBAND_DIGITAL_CLASS_MS = 12_000
export const WIDEBAND_DIGITAL_CLASS_FRAMES =
	(WIDEBAND_DIGITAL_CLASS_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * Visits of one observation whose digital shadow expired unclassed (discarded:unclassed, or a
 * stale yield below) after which its later shadows give their slot to any waiting candidate,
 * whatever its class: 1. Its first visit gets the whole class window; from then on it is
 * recorded only while no other track waits, so over its remembered lifetime (MAX_REMEMBERED
 * observations) it keeps others out of a slot for at most one 13 s window, not 13 s every visit.
 * A stale shadow that yields is ended as an expiry of that visit (it may shadow again in the
 * next one, still stale).
 */
export const WIDEBAND_EXPIRED_STALE = 1
/**
 * A session classed by its own audio only (classByTone, `toneOnly`) keeps the lowest priority
 * among classed sessions. A candidate classed analog-fm takes its slot at any time. Any other
 * waiting candidate takes it once the session heard this much in-track audio while its voice is
 * not on air (a carrier, a hang, a pause; voiceOnAir: a voiced window within
 * WIDEBAND_VOICE_ON_AIR_MS of the newest judged audio, in an open track): 8 s = 64 000 frames.
 * Judged audio runs up to WIDEBAND_HOLDBACK_MS behind, so without voice on air it holds a slot
 * others wait for at most 8 + 1 = 9 s (plus the candidate's next snapshot and its yielded file's
 * finish). With no candidate waiting it keeps recording.
 */
export const WIDEBAND_TONE_ONLY_HOLD_MS = 8_000
export const WIDEBAND_TONE_ONLY_HOLD_FRAMES =
	(WIDEBAND_TONE_ONLY_HOLD_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * While its voice is on air, a tone-only session that is shielded keeps its slot from
 * candidates not classed analog-fm until it heard this much in-track audio: 60 s = 480 000
 * frames, the default hold.maxHoldMs (the longest a sweep holds one hop). Only cap − 1
 * tone-only sessions per source are shielded at a time, the oldest ones with voice on air
 * (WidebandAnalogRecorder.evict): keyed periodic data
 * over a tone (the disclosed limit of tone-class.ts) also reads as voice on air, so tone-only
 * sessions alone never keep every slot from a waiting candidate for longer than the 8 s hold:
 * with the default cap of 2, one is shielded and the other yields after 8 + 1 = 9 s (with a cap
 * of 1, none is shielded). A shielded session holds its slot
 * others wait for at most 60 + 1 = 61 s; a longer over, or one not shielded, may lose its slot to
 * a waiting carrier or data track (its file so far is kept).
 */
export const WIDEBAND_TONE_ONLY_ON_AIR_MS = 60_000
export const WIDEBAND_TONE_ONLY_ON_AIR_FRAMES =
	(WIDEBAND_TONE_ONLY_ON_AIR_MS / 1000) * ANALOG_AUDIO_RATE_HZ
/**
 * After a tone-only session yields (yieldToneOnly), its observations may start no new session
 * on that source until the candidate it yielded to started one, for at most this much stream
 * time: 3 s (the yielded file's finish and the candidate's next snapshot, a few 100 ms each), so
 * the freed slot goes to that candidate and not back to the session that gave it up.
 */
export const WIDEBAND_YIELD_RESERVE_MS = 3_000

/**
 * An unclassed shadow of a spectrally digital track after `inTrack` frames of in-track audio:
 * discarded unvoiced at WIDEBAND_DIGITAL_QUALIFY_FRAMES (not `qualified`), unclassed at
 * WIDEBAND_DIGITAL_CLASS_FRAMES, else null (still within its window).
 */
export function digitalExpiry(
	qualified: boolean,
	inTrack: number,
): "discarded:unvoiced" | "discarded:unclassed" | null {
	if (!qualified && inTrack >= WIDEBAND_DIGITAL_QUALIFY_FRAMES)
		return "discarded:unvoiced"
	if (inTrack >= WIDEBAND_DIGITAL_CLASS_FRAMES) return "discarded:unclassed"
	return null
}

/**
 * Whether a tone-only session that heard `inTrack` frames of in-track audio gives its slot to a
 * candidate of kind `by` (evict): one classed analog-fm always; any other once it heard
 * WIDEBAND_TONE_ONLY_HOLD_FRAMES unless it is `shielded` (its voice is on air and it is among the
 * cap − 1 oldest such tone-only sessions on its source), WIDEBAND_TONE_ONLY_ON_AIR_FRAMES if it is.
 */
export function toneOnlyYields(
	by: "analog" | "shadow" | "none",
	inTrack: number,
	shielded: boolean,
): boolean {
	return (
		by === "analog" ||
		inTrack >=
			(shielded
				? WIDEBAND_TONE_ONLY_ON_AIR_FRAMES
				: WIDEBAND_TONE_ONLY_HOLD_FRAMES)
	)
}
/**
 * A classed, voiced session whose snapshots turn unclean keeps recording when the flag is a
 * spur or an IQ image (an artefact flag that a strong neighbour or a spur line near the channel
 * can raise on some snapshots of a real voice) or a wide reading past a channel
 * (WIDEBAND_KEPT_WIDE_OBW_HZ), first seen after the session was classed and voiced, and on fewer
 * than this share of its snapshots so far: 0.5, flagged · 2 < snapshots (e.g. 49 of 100 is kept,
 * 50 of 100 is not). In-channel wide readings count in neither (always kept). Its files are
 * written but give no tone evidence. Any other flag, a flag seen before the class and the voice,
 * or one on half of the snapshots or more, discards the session as before.
 */
export const WIDEBAND_LATE_FLAG_MAX_SHARE = 0.5
/**
 * A session keeps recording over a wide reading up to this, on any share of its snapshots, before
 * its voice verdict and after it: one 25 kHz channel, the line above which the classifier calls a
 * signal `wideband` (classOf). WIDEBAND_MAX_OBW_HZ is a clean track's bound; a voice reads over it
 * when the -20 dB width of its mean spectrum runs one 1 kHz bin wider, or when a weak steady line
 * 6 to 10 kHz away (a spur, a neighbour's carrier) joins its track, which then reads 17 to 22 kHz
 * from the voice's first snapshot on. The demodulator hears the same ±8 kHz channel
 * (CHANNEL_CUTOFF_HZ) whatever the reading says. Such a reading with a peaked shape (FM voice's
 * hump, not a data signal's flat top or a line's narrow peak) may also start a session
 * (startsWide). What ends a signal kept this way that is not voice: a file is written only once
 * its audio sounds like voice (VoiceActivityGate), and a session not voiced after
 * WIDEBAND_QUALIFY_MS (8 s) of in-track audio, 3 s for a spectrally digital one, is discarded and
 * its observations refused (one slot for at most 8 + 1 s once per observation); the sweep keeps a
 * hop for its answer at most WIDEBAND_VOICE_JUDGE_MS once per visit, and for voice only while voice
 * is on air (WIDEBAND_VOICE_ON_AIR_MS), up to `hold.maxHoldMs`. A kept session gives no tone
 * evidence (publishTones). Past a channel the reading counts as a late flag (lateFlagKept), and an
 * unknown width too; any stricter flag on the same snapshot rules (uncleanFlag).
 */
export const WIDEBAND_KEPT_WIDE_OBW_HZ = 25_000

/** A wide reading within a channel (WIDEBAND_KEPT_WIDE_OBW_HZ), the track's only unclean flag. */
export function inChannelWide(track: TrackSnapshot): boolean {
	return (
		uncleanFlag(track) === "wide" &&
		Number.isFinite(track.obwHz) &&
		track.obwHz <= WIDEBAND_KEPT_WIDE_OBW_HZ
	)
}

/**
 * Whether a first snapshot that is unclean only for an in-channel wide reading starts a session
 * (WIDEBAND_KEPT_WIDE_OBW_HZ): its shape is peaked. A flat top (wideband data) or a narrow peak
 * (a line whose skirt or neighbour widens the reading) is refused at the start as before; a later
 * snapshot of the same observation may still start one.
 */
export function startsWide(track: TrackSnapshot): boolean {
	return inChannelWide(track) && track.spectralShape === "peaked"
}

/**
 * The first reason `track` is not clean (cleanTrack), or null when it is. Hardest to keep a session
 * over first (lateFlagKept), so that a lenient flag never hides a stricter one on the same snapshot.
 */
export function uncleanFlag(track: TrackSnapshot): ScannerRecorderFlag | null {
	if (!usableTrust(track.tuningTrust)) return "tuning"
	if (track.flags.truncated) return "truncated"
	if (track.flags.edge) return "edge"
	if (track.flags.iqImage) return "iq-image"
	if (track.flags.spur === true) return "spur"
	if (!Number.isFinite(track.obwHz) || track.obwHz > WIDEBAND_MAX_OBW_HZ)
		return "wide"
	return null
}

/**
 * Whether a session keeps recording over a snapshot flagged `flag` (WIDEBAND_LATE_FLAG_MAX_SHARE):
 * a spur, an IQ image or a wide reading past WIDEBAND_KEPT_WIDE_OBW_HZ (snapshotBar keeps one up
 * to it without asking), the session's first flag came after it was classed and voiced (`late`),
 * and `flagged` of its `snapshots` (this one included) is under the share.
 */
export function lateFlagKept(
	flag: ScannerRecorderFlag,
	late: boolean,
	flagged: number,
	snapshots: number,
): boolean {
	return (
		(flag === "spur" || flag === "iq-image" || flag === "wide") &&
		late &&
		flagged < WIDEBAND_LATE_FLAG_MAX_SHARE * snapshots
	)
}

/**
 * Voice is on air (recordingActive answers VoiceOnAir) while the newest in-track audio the session
 * judged is at most this far past the end of the last voiced 500 ms window heard in a track that
 * is still open (VoiceOnAirMeter): 2000 ms. A voiced window ends up to 500 ms after the last loud
 * syllable in it, so 1.5 to 2 s of silence between phrases keeps the hold. Judged audio runs
 * WIDEBAND_HOLDBACK_MS (1000 ms) behind the live edge, so a carrier or a repeater hang after the
 * last word answers true (the sweep keeps the hop within L only) at most 1000 + 2000 + 500 =
 * 3500 ms after that word, and the sweep sees it at its next 250 ms re-check: 3.75 s. A squelch
 * close answers false at once (the track's close, not the audio). In samples: 2000 × fs / 1000
 * (2 048 000 at 1.024 Msps). Each voice answer carries how long the judged audio has been quiet
 * (VoiceOnAir.quietMs, the longest since the last answer): once its hold reached L the sweep asks
 * for less (VOICE_QUIET_PAST_L_MS).
 */
export const WIDEBAND_VOICE_ON_AIR_MS = 2_000
/**
 * Earliest the recorder can answer voice for a session that started with its first block of voice:
 * its audio is judged WIDEBAND_HOLDBACK_MS behind the air, and the gate needs one window of it:
 * 1000 + 5 × 100 = 1500 ms. A sweep holds a voiced landing at least this long (capFor).
 */
export const WIDEBAND_VOICE_ANSWER_MS =
	WIDEBAND_HOLDBACK_MS +
	(VOICE_WINDOW_BLOCKS * VOICE_BLOCK_FRAMES * 1000) / ANALOG_AUDIO_RATE_HZ
/**
 * Latest a classed session still answers "judging" (RecordingActivity), counted from its first
 * in-track audio: four gate windows heard (WIDEBAND_EVICT_MIN_HEARD_FRAMES, 2 s), judged
 * WIDEBAND_HOLDBACK_MS behind the air: 2000 + 1000 = 3000 ms. A voice qualifies on one window,
 * usually in its first second; a session past this is a carrier or a pause to the sweep, whatever
 * its file gate says later.
 */
export const WIDEBAND_VOICE_JUDGE_MS =
	(WIDEBAND_EVICT_MIN_HEARD_FRAMES * 1000) / ANALOG_AUDIO_RATE_HZ +
	WIDEBAND_HOLDBACK_MS
/**
 * A file whose first readable sample is more than this (one 50 ms engine block) after its
 * planned start (onset − preRoll) lost its pre-roll or onset (the ring did not reach back):
 * it is kept as cut (`source-lost`) instead of complete.
 */
export const WIDEBAND_HEAD_CUT_TOLERANCE_MS = 50
/** One writer push: 4096 frames = 8 KB, under the WAV writer's 64 KB queue bound. */
const PUSH_FRAMES = 4_096
/**
 * IQ per drain slice: 25 ms of signal. At the measured cost below that is 25 · 59 / 1000 ≈ 1.5 ms
 * of main-thread work at 1.024 Msps and 25 · 71 / 1000 ≈ 1.8 ms at 2.4 Msps (the 2 ms rule).
 */
export const WIDEBAND_SLICE_MS = 25
/**
 * Main-thread time one drain turn may spend on slices (at least one slice runs): 2 ms, the
 * PERFORMANCE rule 2 budget, so one turn takes one or two slices (25 to 50 ms of IQ at the
 * measured 0.8 to 1.5 ms a slice). One slice a turn is not enough: an event-loop turn longer
 * than 25 ms (a congested core) then delivers more IQ than the session demodulates.
 */
export const WIDEBAND_TURN_BUDGET_MS = 2
/**
 * Unread IQ a session keeps out of the ring's oldest end: 1000 ms (at most half the ring). Once
 * its backlog (live edge − next sample) passes ring − margin, the turn may keep demodulating
 * past WIDEBAND_TURN_BUDGET_MS until the backlog is back under it, so a slow loop costs latency,
 * not the recording.
 *
 * This is an explicit exception to the 2 ms main-thread rule (docs/PERFORMANCE.md rule 2,
 * docs/SCANNER.md "Analog voice recordings"): losing the recording is worse than one long turn.
 * It is bounded per turn across all sessions: one catch-up grant a turn, to the session with
 * the least ring headroom (ring − backlog, in ms), of at most its margin of demodulated IQ
 * (the readable IQ past maxBacklog is at most the margin). Every other session stops at the
 * 2 ms budget that turn (it defers), so two sessions never stack. A catch-up turn is thus at
 * most the budget's slices plus 1 s of IQ: about 60 ms of main thread at the loaded 59 ms per
 * IQ second (1.024 Msps), 71 ms at 2.4 Msps, and only when a recording would otherwise lose
 * audio. A 3 s ring (the default ringSeconds) leaves a 2 s backlog.
 */
export const WIDEBAND_RING_MARGIN_MS = 1_000
/** The engine ring the margin is kept against when settings give none (the ringSeconds default). */
export const WIDEBAND_DEFAULT_RING_SECONDS = 3
/**
 * Measured chain cost per recording, CPU ms per second of IQ: 59 at 1.024 Msps and 71 at
 * 2.4 Msps on a shared Mac at load average 56 (33 and 49 at load average 7.5; docs/SCANNER.md
 * "Analog voice recordings"). The cap uses the loaded run, a linear fit:
 * fixed + slope · Msps = 50 + 9 · Msps (59.2 and 71.6).
 */
export const WIDEBAND_CPU_FIXED_MS = 50
export const WIDEBAND_CPU_MS_PER_MSPS = 9
/** Share of `cpuBudgetCores` concurrent recordings on one source may use. */
export const WIDEBAND_CPU_SHARE = 0.25
/**
 * Missing input longer than this, summed over consecutive unreadable slices (a ring overrun
 * reads as many 25 ms gaps), ends the file instead of inserting silence.
 */
export const WIDEBAND_MAX_SILENCE_GAP_MS = 1_000
/**
 * The voice gate only hears audio inside a joined track, trimmed by this at both ends: the
 * engine reports a track's last sample to the 10 to 50 ms block, so the squelch-open noise
 * after a carrier drops (which is loud and not a carrier's quieted audio) stays out.
 */
export const WIDEBAND_GATE_EDGE_TRIM_MS = 100
/**
 * Activity intervals kept per session (open tracks and closed ones not yet judged). Past it the
 * oldest closed span goes; when every one is open the new span is not kept (an older open span
 * covers it up to now). At most 64 entries of 3 numbers per session.
 */
export const WIDEBAND_MAX_ACTIVITY = 64
/** Gaps held for a file not admitted yet (the analog operation keeps 64 too). */
export const WIDEBAND_MAX_PENDING_GAPS = 64
/**
 * Files of one session waiting for a slot: a roll-over or a new transmission while the previous
 * file still settles, and one more behind it. Their audio counts in WIDEBAND_MAX_BUFFERED_FRAMES.
 */
export const MAX_WAITING_FILES = 2
/**
 * A shadow file a retune ended before its class arrived waits this long for the closing
 * snapshot (which may carry the first analog-fm class): 2 s of stream samples after the new
 * epoch's start (2 048 000 samples at 1.024 Msps), checked on every engine write. Past it, or
 * on a stream or engine change, it is discarded.
 */
export const WIDEBAND_PARK_MS = 2_000
/**
 * Retune-ended sessions waiting for their close per manager; past it the oldest is discarded.
 * Each holds at most WIDEBAND_MAX_BUFFERED_FRAMES (960 KB): 4 · 960 KB = 3.84 MB at most.
 */
export const WIDEBAND_MAX_PARKED = 4
/**
 * How far a session not voiced yet may sit from its own track's centre before it starts again there
 * (retarget): 2000 Hz. The demodulator hears ±8 kHz (CHANNEL_CUTOFF_HZ) around `targetHz`; an NFM
 * voice deviates up to ±5 kHz and a track's centre reads in 1 kHz bins at 1.024 Msps, so a voice
 * whose centre is within 8000 − 5000 − 1000 = 2000 Hz of the session stays inside the channel (at
 * 2.4 Msps, 1.17 kHz bins, its widest peaks may reach 8.2 kHz).
 */
export const WIDEBAND_RETARGET_HZ = 2_000
/**
 * Times one observation's session may start again, at a new centre (retarget) or after a reading
 * past a channel before its voice (wideRestart): 3, enough for a centroid that walks from a line onto
 * a voice 6 to 10 kHz away in steps of about 2 kHz a snapshot, or a key-up's one wide reading.
 * Each new session has its own WIDEBAND_QUALIFY_MS, so a track whose centre keeps wandering and
 * never sounds like voice holds a slot for at most (1 + 3) × (8 + 1) = 36 s of signal (each
 * judged 1 s late), once per observation (remembered like refusals, MAX_REMEMBERED), and once per
 * channel in any WIDEBAND_RESTART_WINDOW_MS, whatever observation its track is now
 * (WIDEBAND_RESTART_CHANNEL_HZ).
 */
export const WIDEBAND_MAX_RETARGETS = 3
/**
 * Window in which one channel shares the WIDEBAND_MAX_RETARGETS budget, in stream time: 240 000 ms.
 * A track rolls over to a successor observation every 120 s (the tracker's maxTrackMs), and with
 * it the per-observation budget would renew: a wandering carrier would restart 3 times per 120 s
 * for as long as it stays on air. A session restarts only before its voice, so an observation's
 * restarts lie within 36 s of its onset (WIDEBAND_MAX_RETARGETS); its successor's, within
 * 120 + 36 = 156 s of the predecessor's onset, inside 240 s, so a chain and its successor share one
 * budget of 3. A channel then spends at most 3 restarts in any 240 s, (1 + 3) × 9 = 36 s of slot
 * time on unvoiced sessions that start again, against 3 per 120 s before. A session of the channel
 * that voices clears it (forgetRestarts): the restarts found a voice, so the next transmission
 * beside the same line (the next over of a QSO) has its own 3.
 */
export const WIDEBAND_RESTART_WINDOW_MS = 240_000
/**
 * Restarts this close to a session's centre are of its channel: 12 500 Hz, half a 25 kHz channel.
 * A centroid that walks from a line onto a voice 6 to 10 kHz away moves the session's centre by at
 * most that much over its restarts, so they all stay one channel's.
 */
export const WIDEBAND_RESTART_CHANNEL_HZ = 12_500
/** Observations remembered as refused, and as retried once, per manager. */
const MAX_REMEMBERED = 1024
/** Remembered file ends per manager (pre-roll clamp of the next file on the same channel). */
const RECENT_ENDS = 32

/**
 * Concurrent recordings per source at `inputRateHz`:
 * floor(share · cpuBudgetCores · 1000 ms / (fixed + slope · rate in Msps)), at least 1 (a voice
 * is always kept) and at most MAX_ACTIVE_ANALOG_PER_SOURCE (the analog operations' own limit).
 * Default budget 1 core: floor(250 / 71.6) = 3 → 2 at 2.4 Msps, floor(250 / 59.2) = 4 → 2 at
 * 1.024 Msps; a 0.1-core budget gives floor(25 / 59.2) = 0 → 1.
 */
export function widebandRecordingCap(
	inputRateHz: number,
	cpuBudgetCores: number,
): number {
	if (!(inputRateHz > 0) || !Number.isFinite(cpuBudgetCores)) return 1
	const perRecordingMs =
		WIDEBAND_CPU_FIXED_MS + (WIDEBAND_CPU_MS_PER_MSPS * inputRateHz) / 1e6
	const budgetMs = WIDEBAND_CPU_SHARE * Math.max(0, cpuBudgetCores) * 1000
	return Math.max(
		1,
		Math.min(
			MAX_ACTIVE_ANALOG_PER_SOURCE,
			Math.floor(budgetMs / perRecordingMs),
		),
	)
}

/** A standard CTCSS tone heard over a finalized recording: analog-tone evidence (no voice claim). */
export function widebandToneEvidence(
	ctcssHz: number,
	at: number,
): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz, dcs: null },
		transport: "live",
		at,
	}
}

/**
 * Estimated cores of one recording session at `inputRateHz` (the chain cost above, CPU ms per
 * second / 1000): 0.0592 at 1.024 Msps, 0.0716 at 2.4 Msps. Reserved in the scanner's CPU
 * budget for as long as the session demodulates, shadow or not.
 */
export function widebandSessionCores(inputRateHz: number): number {
	const rate = inputRateHz > 0 ? inputRateHz : 0
	return (
		(WIDEBAND_CPU_FIXED_MS + (WIDEBAND_CPU_MS_PER_MSPS * rate) / 1e6) / 1000
	)
}

/** The engine surface the recorder reads (SpectrumEngine satisfies it). */
export interface WidebandEngineView {
	readonly format: string
	currentEpoch(): {
		stream: number
		epoch: number
		startSample: number | null
		centreHz: number
		sampleRateHz: number
		tuningTrust: TuningTrust
	}
	liveEdge(): number
	readRing(
		fromSample: number,
		toSample: number,
	): { startSample: number; bytes: Uint8Array } | null
	tap(listener: (startSample: number, bytes: Uint8Array) => void): () => void
}

export interface WidebandAnalogDeps {
	engine(sourceId: string): WidebandEngineView | undefined
	settings(): {
		preRollMs: number
		hangMs: number
		cpuBudgetCores: number
		/** The engine's IQ ring (scanner ringSeconds); default WIDEBAND_DEFAULT_RING_SECONDS. */
		ringSeconds?: number
	}
	beginAnalog(input: AnalogInput): AnalogHandle
	/** A standard CTCSS tone heard over a finalized file of this observation. */
	recordTone?(observationId: string, ctcssHz: number, at: number): void
	/**
	 * Reserves `cores` in the scanner's shared CPU budget (probes, live audio): a release, or
	 * null when the budget is full (the session does not start; the next snapshot retries).
	 */
	reserveCores?(cores: number): (() => void) | null
	logger: Logger
	now(): number
	/** Next-turn scheduler for drain slices; default setImmediate. */
	schedule?(run: () => void): void
	/** Monotonic milliseconds for the per-turn budget; default performance.now. */
	clock?(): number
}

export interface WidebandTrackInput {
	readonly observationId: string
	readonly discoveryId: string | null
	readonly sourceId: string
	readonly track: TrackSnapshot
	/** The observation is classed analog-fm in this snapshot. */
	readonly analogFm: boolean
	/**
	 * Classed as something definitely not analog FM: a class other than analog-fm backed by more
	 * than the spectrum (a verified decode, the channel tier). A spectral class alone is not.
	 */
	readonly nonAnalog?: boolean
	/** A band plan range at the track lists analog FM, or none covers it: a shadow may start. */
	readonly shadowAllowed?: boolean
	/**
	 * The snapshot's class is another class than analog FM on the spectrum alone (not
	 * `nonAnalog`): its shadow has the lowest slot priority (WIDEBAND_DIGITAL_CLASS_MS).
	 */
	readonly spectralDigital?: boolean
	readonly encrypted: boolean
	/** No covering job, or a covering job with record.analog. */
	readonly recordAllowed: boolean
	/** The channel-tier recorder owns this observation: stand down. */
	readonly channelOwned: boolean
}

/**
 * What the next track() or closed() call for a snapshot will say about its observation
 * (keepsOverArtefact): the recorder's vetoes besides the track's own flags.
 */
export interface WidebandArtefactInfo {
	readonly analogFm: boolean
	readonly nonAnalog?: boolean
	readonly encrypted: boolean
	readonly recordAllowed: boolean
}

/** What the closing snapshot says about the observation (its class may arrive only there). */
export interface WidebandCloseInfo {
	readonly analogFm: boolean
	readonly nonAnalog?: boolean
	readonly discoveryId: string | null
	/** Encrypted evidence arrived (possibly after the last update): the session is discarded. */
	readonly encrypted?: boolean
	/** False: no covering job records analog any more; the session is discarded. */
	readonly recordAllowed?: boolean
}

/** Demodulated audio and its tone-band twin, frame for frame; `tone` null: not for CTCSS. */
interface Frames {
	readonly pcm: Int16Array
	readonly tone: Int16Array | null
}

/** Audio not written yet, oldest first (views of the demodulated arrays, no copies). */
class PcmQueue {
	private readonly parts: Int16Array[] = []
	length = 0
	push(pcm: Int16Array): void {
		if (pcm.length === 0) return
		this.parts.push(pcm)
		this.length += pcm.length
	}
	/** Removes the oldest `n` frames (a copy only when parts are joined). */
	take(n: number): Int16Array {
		const want = Math.min(n, this.length)
		const head = this.parts[0]
		if (head && head.length >= want) {
			this.length -= want
			if (head.length === want) this.parts.shift()
			else this.parts[0] = head.subarray(want)
			return head.subarray(0, want)
		}
		const out = new Int16Array(want)
		let o = 0
		while (o < want) {
			// Whole head parts only: each take below is the single-part case.
			const part = this.take(Math.min(this.parts[0]!.length, want - o))
			out.set(part, o)
			o += part.length
		}
		return out
	}
	/** Removes the newest `n` frames, oldest first. */
	takeTail(n: number): Int16Array[] {
		const out: Int16Array[] = []
		let excess = Math.min(n, this.length)
		while (excess > 0) {
			const part = this.parts.at(-1)!
			if (part.length <= excess) {
				out.unshift(part)
				this.parts.pop()
				excess -= part.length
				this.length -= part.length
				continue
			}
			const cut = part.length - excess
			out.unshift(part.subarray(cut))
			this.parts[this.parts.length - 1] = part.subarray(0, cut)
			this.length -= excess
			excess = 0
		}
		return out
	}
}

interface FileState {
	readonly generation: number
	/** Null until admitted: classed, voiced, and the session's previous operation settled. */
	handle: AnalogHandle | null
	/** Gaps found before the operation began (replayed on begin). */
	readonly gaps: AnalogGap[]
	/** Input samples missing over consecutive unreadable slices, from `gapFrom`. */
	gapRun: number
	gapFrom: number
	/** Voice/activity check over the judged audio: a file that never qualifies is not written. */
	readonly gate: VoiceActivityGate
	/** This file's CTCSS input (inside the activity only); null once its tone was taken. */
	ctcss: CtcssBank | null
	/** The tone heard over this file (taken when it finished), reported once it is finalized. */
	toneHz: number | null
	/**
	 * The stricter evidence classByTone needs (tone-class.ts); null once the file finished, when
	 * its verdict is in `classTone`.
	 */
	toneClass: ToneClassEvidence | null
	/** The tone that classed this file's audio (ToneClassEvidence.result at its finish), or null. */
	classTone: number | null
	/** The start the segmenter planned (onset − preRoll, clamped): the head-cut reference. */
	readonly planned: number
	startSample: number
	endSample: number | null
	cut: AnalogCut
	/** The ring did not reach the planned start: the pre-roll or onset is missing. */
	headCut: boolean
	ready: boolean
	failed: boolean
	readonly queue: PcmQueue
	/** Produced frames the voice gate and the CTCSS bank have not heard yet, oldest first. */
	readonly unjudged: Frames[]
	/** Frames produced for this file (written + queued). */
	frames: number
	/** Frames heard by the gate and the bank (from the file's start). */
	judged: number
	/** In-track frames the voice gate heard in this file. */
	heard: number
	writing: boolean
	finishing: boolean
	/** The operation's finish was asked for: its own receipt is its terminal decision. */
	finishAsked: boolean
	/** A push of it was rejected: its receipt's decision is `discarded:write-failed`. */
	pushFailed: boolean
	/** This file's terminal decision was noted (each file gets exactly one; endFile). */
	decided: boolean
}

interface Session {
	readonly id: string
	readonly sourceId: string
	readonly engine: WidebandEngineView
	readonly stream: number
	readonly epoch: number
	readonly fs: number
	readonly captureCentreHz: number
	readonly targetHz: number
	readonly tuningTrust: "commanded" | "relay"
	readonly owner: string
	/** The owner's discovery; a shadow may start before it exists. */
	discoveryId: string | null
	/** Some snapshot of a joined observation was classed analog-fm, or its own audio (classByTone). */
	classed: boolean
	/**
	 * Classed by its own audio only (classByTone), no snapshot classed it analog-fm yet: a later
	 * definite other class (`nonAnalog`) still discards it, and no tone evidence is published.
	 */
	toneOnly: boolean
	/**
	 * The owner's latest snapshot has a spectral class other than analog FM (`spectralDigital`):
	 * the lowest slot priority, and a bounded time to be classed (WIDEBAND_DIGITAL_*_MS).
	 */
	digital: boolean
	/**
	 * Its owner's shadows expired unclassed in WIDEBAND_EXPIRED_STALE earlier visits: while
	 * unclassed it gives its slot to any waiting candidate (evict).
	 */
	stale: boolean
	/**
	 * Tone evidence of its finalized files (CTCSS Hz → when its file settled), published once the
	 * session ended and every file settled, only if no snapshot was unclean then (publishTones).
	 * One entry per standard tone: at most CTCSS_HZ.length.
	 */
	readonly pendingTones: Map<number, number>
	/** In-track frames heard over the session's files (voiced or not). */
	inTrack: number
	/** Snapshots of joined observations so far (its start, updates and closes). */
	snapshots: number
	/** Unclean ones among them. */
	flagged: number
	/** Of those, wide readings within WIDEBAND_KEPT_WIDE_OBW_HZ: outside any flag's share. */
	flaggedInChannel: number
	/**
	 * The session's first flag other than an in-channel wide reading came after it was classed and
	 * voiced.
	 */
	flagLate: boolean
	/**
	 * The unclean detail its decisions carry, with the counts above (null while every snapshot was
	 * clean): the first flag while the session is kept over it (lateFlagKept), the vetoing one
	 * otherwise. A kept session gives no tone evidence.
	 */
	unclean: ScannerRecorderFlagDetail | null
	/** Some file of this session sounded like voice. */
	qualified: boolean
	/** In-track frames the gate heard over the session's files. */
	heard: number
	/**
	 * Per-transmission voice check over the session's in-track audio once voiced (never
	 * latches). Before that, nothing can answer voice (recordingActive needs `qualified`), so
	 * only the file gate filters the audio, and its qualifying window sets `voiceAt`.
	 */
	readonly meter: VoiceOnAirMeter
	/**
	 * gateFrames' in-track mask, reused (grown to the longest judged chunk: at most
	 * MAX_SLICE_SAMPLES × 8000 / fs frames, 1024 at 1.024 Msps, 437 at 2.4 Msps).
	 */
	mask: Uint8Array
	/** Input sample past the last frame fed to `meter` (a later run that does not join resets it). */
	meterTo: number
	/** Input sample at the end of the last voiced meter window; null before any. */
	voiceAt: number | null
	/**
	 * Longest stretch between two voiced meter windows (input samples) since the last voice answer,
	 * so a quiet that ended between two answers still reads in the next one (VoiceOnAir.quietMs).
	 */
	quietGap: number
	/** Input sample past the newest frame the gate judged (in-track or not). */
	judgedTo: number
	/**
	 * The voiced transmission's name (recordingActive): the first voiced open track, kept while
	 * any overlapping track stays open (a track split or handoff is the same over), cleared once
	 * no track is open (the squelch closed: the next over gets a new name).
	 */
	voiceTx: string | null
	/**
	 * Start (input sample) of the latest track that opened while no track of the session was open
	 * (the squelch had closed and reopened, a turnaround: another transmission, joined by `hangMs`);
	 * null before any. A voice heard before it (`voiceAt` earlier) belongs to a transmission that has
	 * ended (RecordedSession.voiceEnded). A track split or handoff opens while another is open, so it
	 * never moves this.
	 */
	reopenAt: number | null
	/**
	 * The store admitted a file operation of this session (its `ready` resolved): only then is the
	 * session the frequency's verified voice history (recordedHz). Sticky for the session.
	 */
	admitted: boolean
	readonly observations: Set<string>
	/** Track spans per observation (open: still active), the voice gate's input window. */
	readonly activity: Map<string, { start: number; last: number; open: boolean }>
	readonly seg: TransmissionSegmenter
	readonly chain: WidebandNfmChain
	readonly onset: number
	/** Newest sample a joined track was reported on. */
	lastActive: number
	readonly groupDelay: number
	/** Next input sample to demodulate. */
	next: number
	/**
	 * Backlog (live edge − next, samples) past which a turn ignores WIDEBAND_TURN_BUDGET_MS:
	 * ring − WIDEBAND_RING_MARGIN_MS (at most half the ring).
	 */
	readonly maxBacklog: number
	/** Ring − maxBacklog (samples): the most IQ one catch-up grant demodulates. */
	readonly margin: number
	/** No sample at or past this is read (an epoch change). */
	limit: number
	/** Cut reason of the next non-quiet end (retune, stream change); null = completed. */
	endCut: AnalogCut | null
	file: FileState | null
	/** Files waiting, oldest first, for this session's previous operation to settle. */
	readonly waiting: FileState[]
	/** Every file of this session whose operation has not settled (or not begun) yet. */
	readonly files: Set<FileState>
	/** Operations of this session not settled yet. */
	ops: number
	/** A start event waiting for the current file to finish (roll-over or a new transmission). */
	pendingStart: number | null
	generation: number
	untap: () => void
	releaseCores: () => void
	scheduled: boolean
	done: boolean
	/** Retune-ended and waiting for its close: the stream sample past which it is discarded. */
	parkedUntil: number | null
}

/** What a snapshot says about an observation's class. */
interface ClassInfo {
	readonly analogFm: boolean
	readonly nonAnalog?: boolean | undefined
	readonly spectralDigital?: boolean | undefined
	readonly discoveryId: string | null
}

type Usable = "commanded" | "relay"

function usableTrust(trust: TuningTrust): trust is Usable {
	return trust === "commanded" || trust === "relay"
}

/** A track a recording may use: narrow, in the usable span, no image or spur, trusted tuning. */
function cleanTrack(track: TrackSnapshot): boolean {
	return uncleanFlag(track) === null
}

/** Why a snapshot bars a recording (encrypted, opted out, unclean track), or null when it does not. */
function barredSnapshot(
	encrypted: boolean,
	recordAllowed: boolean,
	clean: boolean,
): ScannerRecorderDecision | null {
	if (encrypted) return "refused:encrypted"
	if (!recordAllowed) return "refused:record-disabled"
	if (!clean) return "refused:unclean"
	return null
}

/** What counting one more snapshot does to a session (countSnapshot); snapshotBar commits it. */
interface SnapshotCount {
	readonly snapshots: number
	readonly flagged: number
	readonly flaggedInChannel: number
	readonly flagLate: boolean
	/** The snapshot's unclean flag when `barred` is refused:unclean, else null (nothing counted). */
	readonly flag: ScannerRecorderFlag | null
	/** What bars the session with this snapshot counted; null when it keeps recording. */
	readonly bar: ScannerRecorderDecision | null
}

/**
 * The session's counts with one more snapshot of it (`barred` as barredSnapshot says), and what
 * then bars it: `barred` as given, or null when the only bar is an unclean track the session keeps
 * recording over (an in-channel wide reading at any time, WIDEBAND_KEPT_WIDE_OBW_HZ, or a late
 * flag, lateFlagKept). Reads only: snapshotBar commits it, keepsOverArtefact asks it ahead.
 */
function countSnapshot(
	s: Session,
	track: TrackSnapshot,
	barred: ScannerRecorderDecision | null,
): SnapshotCount {
	const snapshots = s.snapshots + 1
	const flag = barred === "refused:unclean" ? uncleanFlag(track) : null
	if (flag === null)
		return {
			snapshots,
			flagged: s.flagged,
			flaggedInChannel: s.flaggedInChannel,
			flagLate: s.flagLate,
			flag: null,
			bar: barred,
		}
	// Before the voice verdict too: a neighbouring line can widen a voice's reading from its start.
	const inChannel = inChannelWide(track)
	const flagLate =
		!inChannel && s.flagged === s.flaggedInChannel
			? s.classed && s.qualified
			: s.flagLate
	const flagged = s.flagged + 1
	const flaggedInChannel = s.flaggedInChannel + (inChannel ? 1 : 0)
	const kept =
		inChannel ||
		lateFlagKept(flag, flagLate, flagged - flaggedInChannel, snapshots)
	return {
		snapshots,
		flagged,
		flaggedInChannel,
		flagLate,
		flag,
		bar: kept ? null : barred,
	}
}

/**
 * Whether a snapshot's class discards the session (classify): a definite other class (a verified
 * decode, the channel tier) while the session is a shadow or classed by its own audio only.
 */
function classVetoes(s: Session, info: ClassInfo): boolean {
	return !info.analogFm && (!s.classed || s.toneOnly) && info.nonAnalog === true
}

function bindingKey(binding: RecordingBinding): string {
	return JSON.stringify(
		Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : 1)),
	)
}

/** A visit of a channel: the engine stream and epoch (a retune or stream change is a new one). */
function visitKey(at: {
	readonly stream: number
	readonly epoch: number
}): string {
	return `${at.stream}:${at.epoch}`
}

/** A RecordedSession answer whose voiced transmission ended (RecordedSession.voiceEnded). */
function voiceEnded(a: RecordingActivity): boolean {
	return typeof a === "object" && "recording" in a && a.voiceEnded === true
}

/**
 * Whether any joined track of `s` is open, and the voiced one (voiceOnAir): the open span the
 * last voiced meter window lies in, judged at most WIDEBAND_VOICE_ON_AIR_MS ago; of several, the
 * one that started first. Null: voice is not on air. Reads only.
 */
function voicedSpan(s: Session): { open: boolean; voiced: string | null } {
	let open = false
	let voiced: string | null = null
	let voicedStart = Infinity
	const at = s.voiceAt
	const window = (WIDEBAND_VOICE_ON_AIR_MS * s.fs) / 1000
	for (const [id, a] of s.activity) {
		if (!a.open) continue
		open = true
		if (
			at !== null &&
			at >= a.start &&
			s.judgedTo - at <= window &&
			a.start < voicedStart
		) {
			voiced = id
			voicedStart = a.start
		}
	}
	return { open, voiced }
}

/**
 * An unclassed shadow that keeps others out for nothing (evict): stale (WIDEBAND_EXPIRED_STALE),
 * or a spectrally digital one whose current file can no longer pass the tone test, so
 * classByTone cannot class it in this file (a snapshot still could; the shadow yields only to a
 * waiting candidate). Reads only.
 */
function hopeless(s: Session): boolean {
	if (s.classed) return false
	if (s.stale) return true
	const evidence = s.file?.toneClass ?? null
	return s.digital && evidence !== null && !evidence.toneCanHold()
}

/** Which snapshot of `s` an update of `observationId` is (ScannerRecorderFlagSource). */
function raisedBy(
	s: Session,
	observationId: string,
): ScannerRecorderFlagSource {
	return observationId === s.owner ? "snapshot" : "joined"
}

/**
 * Grants `id` a waiver with its class provenance (`toneOnly`) in one bounded map: a grant is the
 * newest entry, and past `limit` (MAX_REMEMBERED) the oldest waiver goes with its provenance.
 */
export function rememberWaiver(
	map: Map<string, boolean>,
	id: string,
	toneOnly: boolean,
	limit = MAX_REMEMBERED,
): void {
	map.delete(id)
	map.set(id, toneOnly)
	if (map.size > limit) {
		const oldest = map.keys().next()
		if (oldest.done !== true) map.delete(oldest.value)
	}
}

/** Adds `id` to a bounded remembered set (the oldest entry goes past MAX_REMEMBERED). */
function remember(set: Set<string>, id: string): void {
	set.add(id)
	if (set.size > MAX_REMEMBERED) {
		const oldest = set.values().next()
		if (oldest.done !== true) set.delete(oldest.value)
	}
}

export class WidebandAnalogRecorder {
	private readonly log: Logger
	private readonly sessions = new Map<string, Session>()
	/** Retune-ended sessions whose voiced shadow files wait for the close (oldest first). */
	private readonly parked = new Map<string, Session>()
	/** observationId → session id. */
	private readonly byObservation = new Map<string, string>()
	/**
	 * Exact bindings (one per file: same channel id, distinct generation), each live until its
	 * own operation settles, so a finishing file keeps its binding while its continuation runs.
	 */
	private readonly bindings = new Set<string>()
	private readonly settling = new Set<Promise<unknown>>()
	/** Operations not settled yet per source (a finishing file still holds an analog slot). */
	private readonly unsettled = new Map<string, number>()
	private readonly refused = new Set<string>()
	/**
	 * Observations a classed, voiced recording keeps over a late spur or IQ-image flag
	 * (keepsOverArtefact), until a veto or refusal of their session revokes it (revokeWaivers) or
	 * they close (bounded by MAX_REMEMBERED, the oldest evicted), each with its class provenance:
	 * true while its session is classed by its own audio only (`toneOnly`), so a definite other
	 * class (classVetoes) still ends the waiver once the session itself is gone. A snapshot that
	 * classes the session analog-fm clears it (classedBySnapshot): the session was classed for
	 * real, and a later digital verdict no longer revokes what it recorded. One structure, so a
	 * waiver and its provenance are evicted together.
	 */
	private readonly waived = new Map<string, boolean>()
	/**
	 * Observations whose spectrally digital shadow expired (WIDEBAND_DIGITAL_CLASS_MS), with the
	 * visit (stream and epoch) it expired in: no other shadow starts for them in that visit
	 * (bounded by MAX_REMEMBERED); an analog-fm snapshot still may, and so may a snapshot of a
	 * later visit (a sweep back on the channel: the next over may be heard better).
	 */
	private readonly digitalExpired = new Map<
		string,
		{ visit: string; unclassed: number }
	>()
	/**
	 * Tone-only sessions that yielded their slot (yieldToneOnly) while a file of theirs is still
	 * being finished; each leaves when its last store operation settles (at most one per slot).
	 */
	private readonly yielding = new Set<Session>()
	/**
	 * Observations of a yielded tone-only session → the candidate it yielded to and the stream
	 * sample its reservation ends at (WIDEBAND_YIELD_RESERVE_MS; bounded by MAX_REMEMBERED).
	 */
	private readonly yieldedTo = new Map<
		string,
		{ sourceId: string; candidate: string; until: number }
	>()
	/** Observations whose store admission failed once: the next failure refuses them. */
	private readonly retried = new Set<string>()
	/** Sessions each observation started again (retarget, wideRestart), oldest first. */
	private readonly retargeted = new Map<string, number>()
	/**
	 * Restarts per channel, oldest first: where (the ended session's centre) and when (the
	 * snapshot's last sample, on its source's stream at its rate), pruned past
	 * WIDEBAND_RESTART_WINDOW_MS and at MAX_REMEMBERED.
	 */
	private readonly channelRestarts: {
		sourceId: string
		stream: number
		fs: number
		hz: number
		atSample: number
	}[] = []
	private readonly recentEnds: {
		sourceId: string
		stream: number
		epoch: number
		hz: number
		end: number
	}[] = []
	private readonly schedule: (run: () => void) => void
	private readonly clock: () => number
	/** Sessions woken for the next turn, in wake order: one scheduled turn drains them all. */
	private readonly pending = new Set<Session>()
	private turnScheduled = false
	/** The sessions the running turn drains (null between turns). */
	private turnDue: readonly Session[] | null = null
	/** The running turn's one catch-up grant (WIDEBAND_RING_MARGIN_MS); null until asked. */
	private grant: { session: Session; left: number } | null = null
	private stopped = false
	private warnedAt = Number.NEGATIVE_INFINITY
	private readonly decisions: RecorderDecisions

	constructor(private readonly deps: WidebandAnalogDeps) {
		this.log = createComponentLogger(deps.logger, "WidebandAnalogRecorder")
		this.decisions = new RecorderDecisions(this.log, () => deps.now())
		this.schedule = deps.schedule ?? (run => void setImmediate(run))
		this.clock = deps.clock ?? (() => performance.now())
	}

	/**
	 * Slots this recorder holds on `sourceId`: its unsettled operations (a finishing file still
	 * counts against the store's per-source limit) plus every live session holding none (a shadow
	 * or a session not admitted yet still demodulates).
	 */
	activeOn(sourceId: string): number {
		let n = this.unsettled.get(sourceId) ?? 0
		for (const s of this.sessions.values())
			if (s.sourceId === sourceId && !s.done && s.ops === 0) n++
		return n
	}

	owns(observationId: string): boolean {
		return this.byObservation.has(observationId)
	}

	/**
	 * Whether this recorder keeps `observationId`'s recording over `track`'s spur or IQ-image flag,
	 * asked before the snapshot reaches track() or closed() with what that call will be given
	 * (`info`), so the answer is the recorder's own for this snapshot after all its checks: a
	 * classed, voiced session holds the observation, the flag is the snapshot's only unclean one
	 * apart from a wide reading (uncleanFlag: never an edge or truncated track), no other veto
	 * applies (encrypted, record.analog lost, a verified other class on a session classed by its own
	 * audio: barredSnapshot, classVetoes), and snapshotBar keeps the session with this snapshot
	 * counted (countSnapshot: first raised after the class and the voice, on under half of its
	 * snapshots). Reads the session only; a true answer is remembered as the observation's waiver.
	 * The service then keeps the observation on its discovery (DiscoveryStore ingest
	 * `artefactWaived`), so the file still has its association when it settles.
	 *
	 * The waiver lasts while the recorder keeps the recording: any veto or refusal of the session
	 * (this answer false, a cancel, a failed file or receipt: revokeWaivers) ends it, so the next
	 * ingest retracts the observation. Once its session ended with its file finishing or finalized
	 * (no session holds the observation any more), the waiver stands for the rest of the track's
	 * spur or image snapshots that no other veto bars: the recording exists and no session counts
	 * its snapshots, so a later majority of flags no longer retracts it.
	 */
	keepsOverArtefact(
		observationId: string,
		track: TrackSnapshot,
		info: WidebandArtefactInfo,
	): boolean {
		const flag = uncleanFlag(track)
		if (flag !== "spur" && flag !== "iq-image") return false
		const barred = barredSnapshot(info.encrypted, info.recordAllowed, false)
		if (barred !== "refused:unclean") return this.revoke(observationId)
		const id = this.byObservation.get(observationId)
		const s = id === undefined ? undefined : this.sessions.get(id)
		if (!s || s.done) {
			const toneOnly = this.waived.get(observationId)
			if (toneOnly === undefined) return false
			// The session is gone, its class provenance is not: a verified other class still vetoes
			// a recording classed by its own audio only.
			if (toneOnly && !info.analogFm && info.nonAnalog === true)
				return this.revoke(observationId)
			return true
		}
		// The session's next call would refuse it (a flag before the class and the voice is never
		// late, countSnapshot): the artefact verdict.
		if (
			!s.classed ||
			!s.qualified ||
			countSnapshot(s, track, barred).bar !== null ||
			classVetoes(s, { ...info, discoveryId: null })
		)
			return this.revoke(observationId)
		rememberWaiver(this.waived, observationId, s.toneOnly)
		return true
	}

	/** Ends `observationId`'s waiver (keepsOverArtefact); false, the answer it then gives. */
	private revoke(observationId: string): false {
		this.waived.delete(observationId)
		return false
	}

	/**
	 * A snapshot classed `s` analog-fm after a class by its own audio only (`toneOnly` cleared): its
	 * waivers' provenance follows, so a later digital verdict cannot revoke them once `s` is gone.
	 */
	private classedBySnapshot(s: Session, observationId: string): void {
		for (const id of [observationId, ...s.observations])
			if (this.waived.get(id) === true) this.waived.set(id, false)
	}

	/** A veto, refusal or failed file of `s`: none of its observations keeps a waiver. */
	private revokeWaivers(s: Session): void {
		for (const id of s.observations) this.waived.delete(id)
	}

	/**
	 * A file of `s` will not be kept (failed, aborted, never admitted): its waivers end unless a
	 * later file of the live session still records (that one keeps the observation's association).
	 */
	private fileLost(s: Session): void {
		if (s.done || s.file === null) this.revokeWaivers(s)
	}

	/**
	 * The sweep-hold hook, per transmission: for a session on this source, stream and epoch that is
	 * classed analog-fm and has been voiced (`qualified`, sticky for its files), voice (`{ voice }`,
	 * named by that track's observation id: the same over keeps its name, the next over after a
	 * turnaround opens another track) while voice is on air in a track still open: the last voiced
	 * meter window lies inside an open track's span and the newest judged audio is at most
	 * WIDEBAND_VOICE_ON_AIR_MS past it (the scheduler may keep the hop up to `hold.maxHoldMs` while
	 * the name stays the same, RecordingActivity); a recording that is not voice while a track is
	 * open with no voice that recent (a carrier or a repeater hang after the voice, a stuck carrier:
	 * kept within L only), as true, or as a RecordedSession when it says more: `voiceEnded` when that
	 * voice lies before the squelch last closed and reopened (Session.reopenAt: the voiced
	 * transmission ended, the open track is another one; the sweep owes its coarse sweep and is not
	 * kept); false once no joined track is open (the over's squelch closed: the recorder's `hangMs`
	 * still joins the next over into the same file, the sweep does not wait for it). Either answer
	 * names the session's frequency as `recordedHz` (its verified voice history) only once the store
	 * admitted a file operation of the session (Session.admitted): a voiced session that was never
	 * admitted (no association, a refused store) records nothing and grants no history.
	 * "judging" while a classed session with an open track has not been voiced and has heard under
	 * WIDEBAND_EVICT_MIN_HEARD_FRAMES (WIDEBAND_VOICE_JUDGE_MS from its first audio): its answer is
	 * still to come, whichever way it goes. A shadow or one of another stream or an older epoch (the
	 * previous hop's window) answers false, so an unclassed shadow on a carrier costs a visit nothing.
	 */
	recordingActive(
		sourceId: string,
		at: { readonly stream: number; readonly epoch: number },
	): RecordingActivity {
		let answer: RecordingActivity = false
		for (const s of this.sessions.values()) {
			if (
				s.done ||
				s.sourceId !== sourceId ||
				s.stream !== at.stream ||
				s.epoch !== at.epoch ||
				!s.classed
			)
				continue
			if (!s.qualified) {
				if (s.heard < WIDEBAND_EVICT_MIN_HEARD_FRAMES && voicedSpan(s).open)
					answer = "judging"
				continue
			}
			const v = this.voiceOnAir(s)
			if (typeof v === "object" && "voice" in v) return v
			// A recording still running (true, or one not past its voice) outranks one whose voiced
			// transmission ended (voiceEnded): the window still records a transmission.
			if (
				answer === false ||
				(voiceEnded(answer) && v !== false && !voiceEnded(v))
			)
				answer = v
		}
		return answer
	}

	/**
	 * recordingActive for one classed, voiced session (see there). The voiced track is the open
	 * span the last voiced window lies in; of several (overlapping spans of one channel, e.g. a
	 * track split), the one that started first, so the name changes only once that span closes.
	 */
	private voiceOnAir(s: Session): RecordingActivity {
		const { open, voiced } = voicedSpan(s)
		if (!open) s.voiceTx = null
		// Classed and voiced (`qualified`) with a file the store admitted (`admitted`): the
		// frequency's verified voice history for the sweep, voice on air now or not
		// (RecordedSession, VoiceOnAir.recordedHz). Voiced but never admitted (no association, a
		// refused store): no history, the answer alone.
		const history = s.admitted ? { recordedHz: s.targetHz } : {}
		if (voiced === null) {
			if (!open) return false
			// The voice lies before the squelch last reopened: its transmission ended and the open
			// track is another one, not voiced yet (RecordedSession.voiceEnded).
			const ended =
				s.voiceAt !== null && s.reopenAt !== null && s.voiceAt < s.reopenAt
			if (!ended && !s.admitted) return true
			return {
				recording: true,
				...history,
				...(ended ? { voiceEnded: true as const } : {}),
			}
		}
		s.voiceTx ??= voiced
		const quiet = Math.max(s.quietGap, s.judgedTo - (s.voiceAt ?? s.judgedTo))
		s.quietGap = 0
		return {
			voice: s.voiceTx,
			quietMs: (quiet * 1000) / s.fs,
			...history,
		}
	}

	/** Status block (ScannerStatus.recorder): live sessions, parked ones and the decision log. */
	diagnostics(): ScannerRecorderStatus {
		const sessions: ScannerRecorderSession[] = []
		for (const s of this.sessions.values()) {
			if (s.done) continue
			let edge = s.next
			try {
				edge = Math.min(s.engine.liveEdge(), s.limit)
			} catch {
				// An engine closing under us: no backlog to report.
			}
			sessions.push({
				sourceId: s.sourceId,
				observationId: s.owner,
				discoveryId: s.discoveryId,
				state: !s.classed ? "shadow" : s.qualified ? "voiced" : "classed",
				writing: s.ops > 0,
				backlogMs: Math.max(0, Math.round(((edge - s.next) * 1000) / s.fs)),
			})
		}
		return { sessions, parked: this.parked.size, ...this.decisions.status() }
	}

	/** Discovery reads (Discovery.recorder): the decisions about its observations, or null. */
	discoveryDecisions(discoveryId: string): ScannerRecorderDiscovery | null {
		return this.decisions.forDiscovery(discoveryId)
	}

	/** The analog operations' liveness check for a binding this recorder issued. */
	bindingLive(binding: RecordingBinding): boolean {
		const parsed = RecordingBindingSchema.safeParse(binding)
		if (!parsed.success || parsed.data.channelId === null) return false
		return this.bindings.has(bindingKey(parsed.data))
	}

	/** A non-closing snapshot of a live observation. */
	track(input: WidebandTrackInput): void {
		if (this.stopped) return
		try {
			this.onTrack(input)
		} catch (err: unknown) {
			this.warn(err)
		}
	}

	/**
	 * The observation's track closed. `cut` null is a natural end (the hang applies). A retune
	 * (`epoch-changed`, a sweep hop) keeps the hang but never past the new epoch's start; any other
	 * cut (stream change, job end) ends the file at the track's last sample. `info` is what the
	 * closing snapshot says: its class may be the first analog-fm one; encrypted evidence or a
	 * lost record.analog discards every file of the session before any promotion. A shadow file a
	 * retune already ended waits (parked) for this call up to WIDEBAND_PARK_MS.
	 */
	closed(
		observationId: string,
		track: TrackSnapshot,
		cut: AnalogCut | null,
		info?: WidebandCloseInfo,
	): void {
		// Its closing ingest came first: the observation asks for no waiver any more.
		this.waived.delete(observationId)
		// An association first given at the close still names the observation's earlier decisions.
		if (info !== undefined && info.discoveryId !== null)
			this.decisions.bindDiscovery(observationId, info.discoveryId)
		const id = this.byObservation.get(observationId)
		if (id === undefined) {
			// Classed analog-fm with no recording running (its first and only snapshot is the close,
			// or every earlier one was refused): nothing can be recorded any more, but the
			// observation still gets a decision about its analog-fm class.
			if (info?.analogFm === true && !this.refused.has(observationId))
				this.decisions.note("refused:close-only", {
					sourceId: track.sourceId,
					observationId,
					discoveryId: info.discoveryId,
				})
			return
		}
		this.byObservation.delete(observationId)
		const parked = this.parked.get(id)
		if (parked) {
			this.updateParked(
				parked,
				observationId,
				info,
				this.snapshotBar(
					parked,
					track,
					barredSnapshot(
						info?.encrypted === true,
						info?.recordAllowed !== false,
						cleanTrack(track),
					),
					"close",
				),
				true,
			)
			return
		}
		const s = this.sessions.get(id)
		if (!s || s.done) return
		s.lastActive = Math.max(s.lastActive, track.lastSample)
		const span = s.activity.get(observationId)
		if (span) {
			span.last = Math.max(span.last, track.lastSample)
			span.open = false
		}
		if (![...s.activity.values()].some(a => a.open)) s.voiceTx = null
		const bar = this.snapshotBar(
			s,
			track,
			barredSnapshot(
				info?.encrypted === true,
				info?.recordAllowed !== false,
				cleanTrack(track),
			),
			"close",
		)
		if (bar !== null) {
			// Any contributing track turning edge, spur, unverified or encrypted (evidence that may
			// arrive after its last update), or losing record.analog, discards the recording; a
			// late minority spur or image flag or a wide reading on a classed, voiced one does not
			// (snapshotBar).
			this.refuse(s, bar, true)
			return
		}
		if (info !== undefined && !this.classify(s, observationId, info)) return
		s.observations.delete(observationId)
		if (s.observations.size === 0 && !s.classed) {
			// No class can arrive any more: a shadow is never written.
			this.discard(s, "discarded:unclassed")
			return
		}
		if (cut !== null) s.endCut ??= cut
		s.seg.close(
			observationId,
			track.lastSample,
			cut === null || cut === "epoch-changed",
		)
		this.wake(s)
	}

	/**
	 * Shutdown: finish open files (kept as cut when classed and voiced), let files waiting for a
	 * slot begin and finish, then wait for every operation to settle.
	 */
	async stop(): Promise<void> {
		this.stopped = true
		for (const s of [...this.parked.values()])
			this.dropParked(s, false, "discarded:park-expired")
		for (const s of [...this.sessions.values()]) this.endSession(s, "shutdown")
		await this.idle()
	}

	/** Resolves once every operation begun so far (and any continuation it admits) settled. */
	async idle(): Promise<void> {
		while (this.settling.size > 0) await Promise.all([...this.settling])
	}

	// === internals ===

	/**
	 * A snapshot's class for a joined observation: analog-fm classes the session (it stays
	 * classed); a definite other class before that discards a shadow, and so does one after a
	 * class by the session's own audio only (`toneOnly`): a verified decode or the channel tier
	 * outranks it, so every file not written yet is discarded and one being written is cancelled.
	 * False: discarded.
	 */
	private classify(
		s: Session,
		observationId: string,
		info: ClassInfo,
	): boolean {
		if (observationId === s.owner) {
			if (info.discoveryId !== null) {
				s.discoveryId ??= info.discoveryId
				this.decisions.bindDiscovery(s.owner, info.discoveryId)
			}
			s.digital = info.spectralDigital === true && !info.analogFm
		}
		if (info.analogFm) {
			if (s.toneOnly) this.classedBySnapshot(s, observationId)
			s.toneOnly = false
			if (!s.classed) {
				s.classed = true
				this.decide(s, "classed")
			}
		} else if ((!s.classed || s.toneOnly) && info.nonAnalog === true) {
			this.refuse(s, "discarded:not-analog", true)
			return false
		}
		if (s.classed) for (const f of [...s.files]) this.admit(s, f)
		return !s.done
	}

	private onTrack(input: WidebandTrackInput): void {
		const { track, observationId } = input
		// A refused observation may be associated only after its refusal: bind it on every snapshot.
		if (input.discoveryId !== null)
			this.decisions.bindDiscovery(observationId, input.discoveryId)
		// Encrypted, opted out or unclean: never recorded, and a file it contributes to is discarded.
		const barred = barredSnapshot(
			input.encrypted,
			input.recordAllowed,
			cleanTrack(track),
		)
		const joinedId = this.byObservation.get(observationId)
		if (joinedId !== undefined) {
			const p = this.parked.get(joinedId)
			if (p) {
				this.updateParked(
					p,
					observationId,
					input,
					this.snapshotBar(p, track, barred, raisedBy(p, observationId)),
					false,
				)
				return
			}
			const s = this.sessions.get(joinedId)
			if (!s) return
			if (!this.retarget(s, observationId, track)) {
				s.lastActive = Math.max(s.lastActive, track.lastSample)
				this.noteActivity(s, observationId, track)
				const bar = this.snapshotBar(
					s,
					track,
					barred,
					raisedBy(s, observationId),
				)
				if (bar === null) this.classify(s, observationId, input)
				else if (!this.wideRestart(s, observationId, track, bar))
					this.refuse(s, bar, true)
				return
			}
			// Retargeted: this snapshot may start the observation's session at its new centre.
		}
		if (this.refused.has(observationId)) return
		// An expired digital shadow already has its decision: only an analog-fm class restarts it.
		if (
			!input.analogFm &&
			this.digitalExpired.get(observationId)?.visit === visitKey(track)
		)
			return
		const ref = {
			sourceId: input.sourceId,
			observationId,
			discoveryId: input.discoveryId,
		}
		if (input.channelOwned) {
			this.decisions.note("refused:channel-owned", ref)
			return
		}
		const engine = this.deps.engine(input.sourceId)
		if (!engine || engine.format !== "U8_IQ") {
			this.decisions.note("refused:no-iq", ref)
			return
		}
		const epoch = engine.currentEpoch()
		if (
			epoch.stream !== track.stream ||
			epoch.epoch !== track.epoch ||
			!usableTrust(epoch.tuningTrust)
		) {
			this.decisions.note("refused:tuning", ref)
			return
		}
		// A continuation of a channel already recording joins whatever its classification.
		for (const s of this.sessions.values()) {
			if (
				s.done ||
				s.sourceId !== input.sourceId ||
				s.engine !== engine ||
				s.stream !== track.stream ||
				s.epoch !== track.epoch ||
				Math.abs(s.targetHz - track.centreHz) > WIDEBAND_JOIN_TOLERANCE_HZ
			)
				continue
			const bar = this.snapshotBar(s, track, barred, "joined")
			if (bar !== null) {
				// Its audio would land in this file (or its hang): discard the recording, as when a
				// joined track turns encrypted, opted out or unclean.
				s.observations.add(observationId)
				this.refuse(s, bar, true)
				return
			}
			const events = s.seg.open(observationId, track.startSample)
			s.observations.add(observationId)
			s.lastActive = Math.max(s.lastActive, track.lastSample)
			this.noteActivity(s, observationId, track)
			this.byObservation.set(observationId, s.id)
			this.applyEvents(s, events)
			if (this.classify(s, observationId, input)) this.wake(s)
			return
		}
		const wide = barred === "refused:unclean" && startsWide(track)
		if (barred !== null && !wide) {
			const flag = barred === "refused:unclean" ? uncleanFlag(track) : null
			this.decisions.note(
				barred,
				ref,
				false,
				flag === null
					? null
					: {
							flag,
							raisedBy: "snapshot",
							atMs: 0,
							flagged: 1,
							snapshots: 1,
							kept: false,
						},
			)
			return
		}
		// A shadow needs a clean, narrow (cleanTrack) or a peaked in-channel wide (startsWide),
		// non-burst track where analog FM may be.
		const shadow =
			input.shadowAllowed === true &&
			input.nonAnalog !== true &&
			!track.flags.burst
		if (!input.analogFm && !shadow) {
			this.decisions.note("refused:not-analog", ref)
			return
		}
		if (
			!widebandNfmSupported(epoch.sampleRateHz, track.centreHz - epoch.centreHz)
		) {
			// Structurally impossible (rate under 48 kHz, offset outside ±rate/2): nothing is
			// reserved, and this observation is not tried again (bounded by MAX_REMEMBERED).
			remember(this.refused, observationId)
			this.decisions.note("refused:unsupported", ref)
			return
		}
		const settings = this.deps.settings()
		const cap = widebandRecordingCap(
			epoch.sampleRateHz,
			settings.cpuBudgetCores,
		)
		// A yielded tone-only session's observations wait for the candidate it yielded to.
		const yielded = this.yieldedTo.get(observationId)
		if (yielded !== undefined) {
			if (
				yielded.sourceId === input.sourceId &&
				!this.byObservation.has(yielded.candidate) &&
				!this.refused.has(yielded.candidate) &&
				engine.liveEdge() < yielded.until
			) {
				this.decisions.note("refused:slots", ref)
				return
			}
			this.yieldedTo.delete(observationId)
		}
		// A candidate classed analog-fm takes an unclassed or tone-only session's slot; a shadow
		// whose track has no spectral digital class takes only a digital shadow's slot (the lowest
		// priority) or a tone-only session's past its window; a digital candidate only the latter.
		if (this.activeOn(input.sourceId) >= cap)
			this.evict(
				input.sourceId,
				input.analogFm
					? "analog"
					: input.spectralDigital === true
						? "none"
						: "shadow",
				cap,
				{
					observationId,
					until:
						engine.liveEdge() +
						Math.round((WIDEBAND_YIELD_RESERVE_MS * epoch.sampleRateHz) / 1000),
				},
			)
		// Still full: not refused, the next snapshot tries again.
		if (this.activeOn(input.sourceId) >= cap) {
			this.decisions.note("refused:slots", ref)
			return
		}
		const reserve = this.deps.reserveCores
		const release = reserve
			? reserve(widebandSessionCores(epoch.sampleRateHz))
			: () => undefined
		// The shared CPU budget is full (probes, live audio): not refused, retried next snapshot.
		if (release === null) {
			this.decisions.note("refused:cpu", ref)
			return
		}
		let released = false
		const releaseOnce = (): void => {
			if (released) return
			released = true
			release()
		}
		try {
			this.startSession(input, engine, epoch, settings, releaseOnce, wide)
		} catch (err: unknown) {
			// Any failure while starting gives the reservation back and refuses the observation
			// (no retry each snapshot): a started part is cancelled, nothing was admitted.
			const id = this.byObservation.get(observationId)
			const s = id === undefined ? undefined : this.sessions.get(id)
			releaseOnce()
			remember(this.refused, observationId)
			if (s) this.refuse(s, "refused:start-failed", true)
			else this.decisions.note("refused:start-failed", ref)
			this.warn(err)
		}
	}

	/**
	 * Every slot is held. A candidate classed analog-fm (`analog`): the oldest session without a
	 * store operation that is either unclassed (voiced or not: a data signal can pass the voice
	 * gate) or heard WIDEBAND_EVICT_MIN_HEARD_FRAMES of in-track audio without sounding like voice
	 * gives its slot up (and is refused), so neither a steady carrier nor an unclassed signal
	 * keeps a voice out; an unclassed shadow of a spectrally digital track goes first, then a
	 * session classed by its own audio only (`toneOnly`, store operation or not). A shadow
	 * candidate whose track has no spectral digital class (`shadow`) takes only such a digital
	 * shadow's slot, or a tone-only session's past its window. A digital candidate (`none`) takes
	 * only a tone-only session's slot past its window, or an unclassed shadow's that can no longer
	 * be classed by its audio (its current file fails ToneClassEvidence.toneCanHold) or is stale
	 * (WIDEBAND_EXPIRED_STALE); otherwise it waits for a digital shadow's bounded window
	 * (WIDEBAND_DIGITAL_CLASS_MS). Such a hopeless or stale shadow yields to any candidate before
	 * anything else does, and ends as an expiry of this visit (expireDigital), not refused for
	 * good. A tone-only session's window is WIDEBAND_TONE_ONLY_HOLD_FRAMES of in-track audio, or
	 * WIDEBAND_TONE_ONLY_ON_AIR_FRAMES for the `cap` − 1 oldest tone-only sessions with voice on
	 * air (shielded, toneOnlyYields); it yields keeping what it recorded (yieldToneOnly).
	 */
	private evict(
		sourceId: string,
		by: "analog" | "shadow" | "none",
		cap: number,
		candidate: { observationId: string; until: number },
	): void {
		// A yielded tone-only session's file is still finishing: its slot frees when it settles.
		for (const y of this.yielding) if (y.sourceId === sourceId) return
		let spent: Session | undefined
		let digital: Session | undefined
		let tone: Session | undefined
		let other: Session | undefined
		let shields = Math.max(0, cap - 1)
		for (const s of this.sessions.values()) {
			if (s.done || s.sourceId !== sourceId) continue
			if (s.classed && s.toneOnly) {
				// Oldest first (sessions keep their start order).
				const onAir = voicedSpan(s).voiced !== null
				const shielded = onAir && shields > 0
				if (shielded) shields--
				if (tone === undefined && toneOnlyYields(by, s.inTrack, shielded))
					tone = s
				continue
			}
			if (s.ops !== 0) continue
			if (spent === undefined && hopeless(s)) spent = s
			if (s.digital && !s.classed) {
				digital ??= s
				continue
			}
			if (
				by === "analog" &&
				other === undefined &&
				(!s.classed ||
					(!s.qualified && s.heard >= WIDEBAND_EVICT_MIN_HEARD_FRAMES))
			)
				other = s
		}
		if (spent) this.expireDigital(spent, "evicted")
		else if (by !== "none" && digital) this.refuse(digital, "evicted", true)
		else if (tone) this.yieldToneOnly(tone, candidate)
		else if (by === "analog" && other) this.refuse(other, "evicted", true)
	}

	/**
	 * A tone-only session gives its slot up (`evicted`) to `candidate`: its current file ends here
	 * and is kept (finishFile still checks the whole file). Its observations are not refused: once
	 * the candidate started (or WIDEBAND_YIELD_RESERVE_MS passed) a later snapshot of theirs is a
	 * new candidate like any other. The slot is free once that file's store operation settles; the
	 * candidate's next snapshot takes it.
	 */
	private yieldToneOnly(
		s: Session,
		candidate: { observationId: string; until: number },
	): void {
		for (const id of s.observations) {
			this.yieldedTo.delete(id)
			this.yieldedTo.set(id, {
				sourceId: s.sourceId,
				candidate: candidate.observationId,
				until: candidate.until,
			})
			if (this.yieldedTo.size > MAX_REMEMBERED) {
				const oldest = this.yieldedTo.keys().next()
				if (oldest.done !== true) this.yieldedTo.delete(oldest.value)
			}
		}
		this.decide(s, "evicted")
		this.endSession(s, "cancelled")
		if (s.ops > 0) this.yielding.add(s)
	}

	private startSession(
		input: WidebandTrackInput,
		engine: WidebandEngineView,
		epoch: ReturnType<WidebandEngineView["currentEpoch"]>,
		settings: { preRollMs: number; hangMs: number; ringSeconds?: number },
		releaseCores: () => void,
		wide: boolean,
	): void {
		const { track } = input
		const trust = epoch.tuningTrust
		if (!usableTrust(trust)) {
			releaseCores()
			return
		}
		const fs = epoch.sampleRateHz
		const perMs = fs / 1000
		const chain = new WidebandNfmChain({
			inputRateHz: fs,
			offsetHz: track.centreHz - epoch.centreHz,
		})
		const seg = new TransmissionSegmenter({
			preRollSamples: Math.round(Math.max(0, settings.preRollMs) * perMs),
			hangSamples: Math.round(Math.max(0, settings.hangMs) * perMs),
			holdbackSamples: Math.round(WIDEBAND_HOLDBACK_MS * perMs),
			maxSegmentSamples: Math.round(WIDEBAND_MAX_FILE_MS * perMs),
		})
		const floor = Math.max(
			epoch.startSample ?? 0,
			this.recentEnd(input.sourceId, track),
		)
		const ringSeconds = settings.ringSeconds ?? WIDEBAND_DEFAULT_RING_SECONDS
		const ring = Math.max(0, ringSeconds) * fs
		const margin = Math.min(WIDEBAND_RING_MARGIN_MS * perMs, ring / 2)
		const maxBacklog = Math.max(0, Math.floor(ring - margin))
		const s: Session = {
			id: ulid(this.deps.now()).toLowerCase(),
			sourceId: input.sourceId,
			engine,
			stream: epoch.stream,
			epoch: epoch.epoch,
			fs,
			captureCentreHz: epoch.centreHz,
			targetHz: track.centreHz,
			tuningTrust: trust,
			owner: input.observationId,
			discoveryId: input.discoveryId,
			classed: input.analogFm,
			toneOnly: false,
			digital: input.spectralDigital === true && !input.analogFm,
			stale:
				(this.digitalExpired.get(input.observationId)?.unclassed ?? 0) >=
				WIDEBAND_EXPIRED_STALE,
			pendingTones: new Map(),
			inTrack: 0,
			snapshots: 1,
			// Started on an in-channel wide reading (startsWide): kept over it from the start.
			flagged: wide ? 1 : 0,
			flaggedInChannel: wide ? 1 : 0,
			flagLate: false,
			unclean: wide
				? {
						flag: "wide",
						raisedBy: "snapshot",
						atMs: 0,
						flagged: 1,
						snapshots: 1,
						kept: true,
					}
				: null,
			qualified: false,
			heard: 0,
			meter: new VoiceOnAirMeter(),
			mask: new Uint8Array(0),
			meterTo: Number.NEGATIVE_INFINITY,
			voiceAt: null,
			quietGap: 0,
			voiceTx: null,
			reopenAt: null,
			admitted: false,
			judgedTo: Number.NEGATIVE_INFINITY,
			observations: new Set([input.observationId]),
			activity: new Map([
				[
					input.observationId,
					{ start: track.startSample, last: track.lastSample, open: true },
				],
			]),
			seg,
			chain,
			onset: track.startSample,
			lastActive: track.lastSample,
			groupDelay: chain.groupDelaySeconds(fs) * 48_000,
			next: 0,
			maxBacklog,
			margin: Math.ceil(ring - maxBacklog),
			limit: Number.POSITIVE_INFINITY,
			endCut: null,
			file: null,
			waiting: [],
			files: new Set(),
			ops: 0,
			pendingStart: null,
			generation: 0,
			untap: () => undefined,
			releaseCores,
			scheduled: false,
			done: false,
			parkedUntil: null,
		}
		this.sessions.set(s.id, s)
		this.byObservation.set(input.observationId, s.id)
		this.decide(s, s.classed ? "started" : "shadow")
		const events = seg.open(input.observationId, track.startSample, floor)
		this.applyEvents(s, events)
		if (!s.file) {
			this.decide(s, "discarded:empty")
			this.dispose(s)
			return
		}
		s.next = s.file.startSample
		s.untap = engine.tap(() => this.wake(s))
		this.wake(s)
	}

	private recentEnd(sourceId: string, track: TrackSnapshot): number {
		let end = Number.NEGATIVE_INFINITY
		for (const r of this.recentEnds)
			if (
				r.sourceId === sourceId &&
				r.stream === track.stream &&
				r.epoch === track.epoch &&
				Math.abs(r.hz - track.centreHz) <= WIDEBAND_JOIN_TOLERANCE_HZ
			)
				end = Math.max(end, r.end)
		return end
	}

	private applyEvents(s: Session, events: readonly SegmentEvent[]): void {
		for (const ev of events) {
			if (ev.kind === "end") {
				if (s.file && s.file.endSample === null) {
					s.file.endSample = ev.sample
					s.file.cut = this.cutOf(s, ev.cut ?? "completed")
				}
				continue
			}
			if (s.file) s.pendingStart = ev.sample
			else this.openFile(s, ev.sample)
		}
	}

	private cutOf(s: Session, cut: SegmentEndCut): AnalogCut {
		if (cut === "completed" || cut === "duration-limit") return cut
		return s.endCut ?? "track-ended"
	}

	/** A new file from `startSample`, held in memory until it is admitted (`admit`). */
	private openFile(s: Session, startSample: number): void {
		s.generation++
		const file: FileState = {
			generation: s.generation,
			handle: null,
			gaps: [],
			gapRun: 0,
			gapFrom: 0,
			gate: new VoiceActivityGate(),
			ctcss: new CtcssBank(),
			toneHz: null,
			toneClass: new ToneClassEvidence(),
			classTone: null,
			planned: startSample,
			startSample,
			endSample: null,
			cut: "completed",
			headCut: false,
			ready: false,
			failed: false,
			queue: new PcmQueue(),
			unjudged: [],
			frames: 0,
			judged: 0,
			heard: 0,
			writing: false,
			finishing: false,
			finishAsked: false,
			pushFailed: false,
			decided: false,
		}
		s.file = file
		s.files.add(file)
	}

	/**
	 * Begins the file's analog operation once the session is classed analog-fm, its discovery is
	 * known and the file sounded like voice: at once, or, while this session's previous operation
	 * has not settled (it still holds an analog slot), once that one settles. A continuation
	 * never needs a third slot.
	 */
	private admit(s: Session, file: FileState): void {
		if (
			file.failed ||
			file.handle !== null ||
			!s.classed ||
			s.discoveryId === null ||
			!file.gate.voiced ||
			s.waiting.includes(file) ||
			(s.done && !file.finishing)
		)
			return
		if (s.ops === 0) {
			this.beginOp(s, file)
			return
		}
		if (s.waiting.length >= MAX_WAITING_FILES) {
			// The store is not settling files: give up rather than hold more audio.
			file.failed = true
			s.files.delete(file)
			this.endFile(s, file, "discarded:store-backlog")
			if (s.file === file) this.refuse(s, "discarded:store-backlog")
			return
		}
		s.waiting.push(file)
	}

	private beginOp(s: Session, file: FileState): void {
		// A file that waited for a slot begins even during stop(): the store stays open until the
		// recorder's shutdown resolved, which waits for it (at most MAX_WAITING_FILES per session).
		if (file.failed || file.handle !== null || s.discoveryId === null) return
		const binding: RecordingBinding = Object.freeze({
			sourceId: s.sourceId,
			engineInstanceId: recordingEngineInstanceId(s.engine),
			stream: s.stream,
			epoch: s.epoch,
			channelId: `wideband-${s.id}`,
			channelGeneration: file.generation,
			inputFormat: "cf32" as const,
			inputSampleRateHz: 48_000,
			groupDelayInputSamples: Math.max(0, s.groupDelay),
			targetHz: s.targetHz,
			captureCentreHz: s.captureCentreHz,
			tuningTrust: s.tuningTrust,
		})
		const key = bindingKey(binding)
		this.bindings.add(key)
		let handle: AnalogHandle
		try {
			handle = this.deps.beginAnalog({
				discoveryId: s.discoveryId,
				observationId: s.owner,
				binding,
			})
		} catch (err: unknown) {
			this.bindings.delete(key)
			this.warn(err)
			s.files.delete(file)
			this.storeFailed(s, file)
			return
		}
		file.handle = handle
		for (const gap of file.gaps.splice(0)) handle.addGap(gap)
		s.ops++
		this.unsettled.set(s.sourceId, (this.unsettled.get(s.sourceId) ?? 0) + 1)
		const settled = handle.settled
			.then(receipt => this.onSettled(s, file, receipt))
			.catch(() => undefined)
			.finally(() => {
				this.bindings.delete(key)
				const left = (this.unsettled.get(s.sourceId) ?? 1) - 1
				if (left > 0) this.unsettled.set(s.sourceId, left)
				else this.unsettled.delete(s.sourceId)
				this.settling.delete(settled)
				s.files.delete(file)
				s.ops--
				// One at a time: the next waiting file begins when this session holds no slot.
				while (s.ops === 0 && s.waiting.length > 0)
					this.beginOp(s, s.waiting.shift()!)
				if (s.ops === 0) this.yielding.delete(s)
				this.publishTones(s)
			})
		this.settling.add(settled)
		handle.ready.then(
			() => {
				file.ready = true
				// Admitted by the store: a file of this session is written (Session.admitted).
				s.admitted = true
				if (file.finishing) this.completeFinish(s, file)
				else this.wake(s)
			},
			() => {
				// Storage cap, disk-low or a lost association: this transmission is not recorded
				// (the observation is tried once more from its next snapshot). A finishing or waiting
				// file gets its own refused:store; the store settles its operation.
				this.storeFailed(s, file)
			},
		)
	}

	private noteActivity(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
	): void {
		const span = s.activity.get(observationId)
		if (span) {
			span.last = Math.max(span.last, track.lastSample)
			return
		}
		// Opened while no track was: the squelch closed and reopened (Session.reopenAt).
		if (![...s.activity.values()].some(a => a.open))
			s.reopenAt = track.startSample
		s.activity.set(observationId, {
			start: track.startSample,
			last: track.lastSample,
			open: true,
		})
		if (s.activity.size <= WIDEBAND_MAX_ACTIVITY) return
		for (const [id, a] of s.activity)
			if (!a.open) {
				s.activity.delete(id)
				return
			}
		// Every span is open: an older open span already covers the new one up to now.
		s.activity.delete(observationId)
	}

	/**
	 * Per file: the tone heard over this file's own audio, once it is finalized, when a snapshot
	 * classed the session analog-fm (never for a class by its own audio only, `toneOnly`). It is
	 * held on the session (pendingTones) and published by publishTones.
	 */
	private onSettled(s: Session, file: FileState, receipt: AnalogReceipt): void {
		// A file this recorder cancelled already has its decision (refused, discarded).
		this.endFile(
			s,
			file,
			receipt.outcome === "finalized"
				? "finalized"
				: file.pushFailed
					? "discarded:write-failed"
					: "discarded:aborted",
			{
				outcome: receipt.outcome,
				errorCode: ErrorSchema.safeParse(receipt.errorCode).data ?? null,
				cutReason: AnalogCutSchema.safeParse(receipt.cutReason).data ?? null,
				failure: AnalogFailureSchema.safeParse(receipt.failure).data ?? null,
				operationId: file.handle?.operationId ?? receipt.operationId,
			},
		)
		if (receipt.outcome !== "finalized") this.fileLost(s)
		if (receipt.outcome !== "finalized" || this.deps.recordTone === undefined)
			return
		// A class of the recorder's own audio stays the recorder's: no discovery evidence from it.
		if (s.toneOnly || s.unclean !== null) return
		const hz = file.toneHz
		if (hz === null) return
		s.pendingTones.delete(hz)
		s.pendingTones.set(hz, this.deps.now())
	}

	/**
	 * Publishes the session's held tone evidence once nothing of it can change any more: the
	 * session ended (done, not parked) and every operation settled. A session that saw an unclean
	 * snapshot at any time (kept over a late flag or wide reading, snapshotBar, or vetoed) publishes
	 * none, so a 120 s roll-over finalized before a later flag gives no proof either. Called after
	 * each settle and each end.
	 */
	private publishTones(s: Session): void {
		if (!s.done || s.ops > 0 || this.parked.has(s.id)) return
		if (s.pendingTones.size === 0) return
		const tones = [...s.pendingTones]
		s.pendingTones.clear()
		if (s.unclean !== null || s.toneOnly) return
		const record = this.deps.recordTone
		if (record === undefined) return
		for (const [hz, at] of tones)
			try {
				record(s.owner, hz, at)
			} catch (err: unknown) {
				this.warn(err)
			}
	}

	/**
	 * Refused: drop the session and do not try its observations again. `everyFile` (an
	 * observation turned encrypted, opted out, unclean or not analog) also cancels the session's
	 * earlier files still finishing or waiting, a roll-over's first file among them; otherwise only
	 * the current file goes and an earlier complete file is still written.
	 */
	private refuse(
		s: Session,
		code: ScannerRecorderDecision,
		everyFile = false,
	): void {
		for (const id of s.observations) remember(this.refused, id)
		this.terminate(s, this.cancelSession(s, "cancelled", everyFile), code)
	}

	/**
	 * A store failure (admission refused or thrown, readiness rejected) of `file`. Every file gets
	 * its own refused:store whether or not it is the current one; only the current file's failure
	 * acts on the session: the first one per observation is retried on its next snapshot, the
	 * second refuses it. A finishing or waiting file's failure leaves the session alone.
	 */
	private storeFailed(s: Session, file: FileState): void {
		file.failed = true
		this.fileLost(s)
		if (s.file !== file || s.done) {
			const at = s.waiting.indexOf(file)
			if (at >= 0) s.waiting.splice(at, 1)
			this.endFile(s, file, "refused:store")
			return
		}
		const ids = [...s.observations]
		if (ids.length > 0 && ids.every(id => !this.retried.has(id))) {
			for (const id of ids) remember(this.retried, id)
			this.terminate(s, this.cancelSession(s, "cancelled"), "refused:store")
			return
		}
		this.refuse(s, "refused:store")
	}

	/**
	 * A session not voiced yet whose own track's centre moved more than WIDEBAND_RETARGET_HZ from the
	 * centre it demodulates (`targetHz`) ends without refusing its observations, so the snapshot
	 * starts a session at the new centre (true), at most WIDEBAND_MAX_RETARGETS times per
	 * observation and per channel in WIDEBAND_RESTART_WINDOW_MS. A steady line opens a track (and a session); a voice keying up 6 to 10 kHz away
	 * joins that track, whose power-weighted centre then walks from the line onto the voice over a
	 * few snapshots: demodulated where it started, the voice sits at or past the edge of the
	 * ±8 kHz channel and is not heard as voice, and the session would end unvoiced after
	 * WIDEBAND_QUALIFY_MS and refuse the voice's observation for good. Nothing was written (no store
	 * operation before the voice). The new session reads the ring back from the track's onset (the
	 * pre-roll; an onset older than the ring reads as `source-lost`).
	 */
	private retarget(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
	): boolean {
		if (
			Math.abs(track.centreHz - s.targetHz) <= WIDEBAND_RETARGET_HZ ||
			!this.restartable(s, observationId, track)
		)
			return false
		this.restart(s, observationId, track, "discarded:unvoiced")
		return true
	}

	/**
	 * A wide reading past a channel (or with no width) on the owner of a session not voiced yet, as
	 * `bar` (refused:unclean): the session ends, but its observation is not refused for good while
	 * it may still start again (restartable), so a later snapshot within a channel starts one (true).
	 * The onset of a voice beside a steady line reads 26 kHz or more on one snapshot (the line, the
	 * voice and its key-up transient in one track) and within a channel from the next one on; a
	 * signal that stays wider never starts again (startsWide), and one that keeps coming back
	 * shares the WIDEBAND_MAX_RETARGETS budget, so its slot time stays within that bound.
	 */
	private wideRestart(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
		bar: ScannerRecorderDecision,
	): boolean {
		if (
			bar !== "refused:unclean" ||
			uncleanFlag(track) !== "wide" ||
			!this.restartable(s, observationId, track)
		)
			return false
		this.restart(s, observationId, track, bar)
		return true
	}

	/**
	 * Whether the session of `observationId` (its owner, not voiced yet) may end and start again:
	 * under WIDEBAND_MAX_RETARGETS for the observation and for its channel over the window.
	 */
	private restartable(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
	): boolean {
		return (
			observationId === s.owner &&
			!s.qualified &&
			!s.done &&
			(this.retargeted.get(observationId) ?? 0) < WIDEBAND_MAX_RETARGETS &&
			this.channelRestartsOf(s, track.lastSample) < WIDEBAND_MAX_RETARGETS
		)
	}

	/**
	 * Restarts of `s`'s channel (same source, stream and rate, within WIDEBAND_RESTART_CHANNEL_HZ) in
	 * the WIDEBAND_RESTART_WINDOW_MS up to `atSample`, the bound included (240 000 × fs / 1000
	 * samples: 245 760 000 at 1.024 Msps); older entries of that clock, any channel, are dropped
	 * (another stream's samples are not this one's).
	 */
	private channelRestartsOf(s: Session, atSample: number): number {
		const window = (WIDEBAND_RESTART_WINDOW_MS * s.fs) / 1000
		const list = this.channelRestarts
		let kept = 0
		let n = 0
		for (const e of list) {
			const sameClock =
				e.sourceId === s.sourceId && e.stream === s.stream && e.fs === s.fs
			if (sameClock && atSample - e.atSample > window) continue
			list[kept++] = e
			if (
				sameClock &&
				Math.abs(e.hz - s.targetHz) <= WIDEBAND_RESTART_CHANNEL_HZ
			)
				n++
		}
		list.length = kept
		return n
	}

	/** A session of the channel voiced: its restarts found the voice, the channel's budget is whole. */
	private forgetRestarts(s: Session): void {
		const list = this.channelRestarts
		let kept = 0
		for (const e of list)
			if (
				e.sourceId !== s.sourceId ||
				e.stream !== s.stream ||
				e.fs !== s.fs ||
				Math.abs(e.hz - s.targetHz) > WIDEBAND_RESTART_CHANNEL_HZ
			)
				list[kept++] = e
		list.length = kept
	}

	/** Ends `s` as `code` without refusing its observations; one of its owner's restarts. */
	private restart(
		s: Session,
		observationId: string,
		track: TrackSnapshot,
		code: ScannerRecorderDecision,
	): void {
		this.channelRestarts.push({
			sourceId: s.sourceId,
			stream: s.stream,
			fs: s.fs,
			hz: s.targetHz,
			atSample: track.lastSample,
		})
		if (this.channelRestarts.length > MAX_REMEMBERED)
			this.channelRestarts.shift()
		const done = this.retargeted.get(observationId) ?? 0
		this.retargeted.delete(observationId)
		this.retargeted.set(observationId, done + 1)
		if (this.retargeted.size > MAX_REMEMBERED) {
			const oldest = this.retargeted.keys().next()
			if (oldest.done !== true) this.retargeted.delete(oldest.value)
		}
		const ids = [...s.observations]
		this.refuse(s, code, true)
		for (const id of ids) this.refused.delete(id)
	}

	/** A shadow whose class never came: nothing of it is kept, and its observations are done. */
	private discard(s: Session, code: ScannerRecorderDecision): void {
		this.refuse(s, code, true)
	}

	/** Notes a decision about the session's owner observation (RecorderDecisions). */
	private decide(
		s: Session,
		code: ScannerRecorderDecision,
		receipt?: ReceiptDetail,
	): void {
		this.decisions.note(
			code,
			{
				sourceId: s.sourceId,
				observationId: s.owner,
				discoveryId: s.discoveryId,
			},
			true,
			s.unclean === null
				? null
				: { ...s.unclean, flagged: s.flagged, snapshots: s.snapshots },
			receipt,
		)
	}

	/**
	 * Counts one snapshot of a joined observation of `s` (raised by `via`) and returns what bars
	 * the session: `barred` as given, or null when the only bar is an unclean track the session
	 * keeps recording over (an in-channel wide reading at any time, WIDEBAND_KEPT_WIDE_OBW_HZ, or a
	 * late flag, lateFlagKept). An unclean snapshot updates the session's detail.
	 */
	private snapshotBar(
		s: Session,
		track: TrackSnapshot,
		barred: ScannerRecorderDecision | null,
		via: ScannerRecorderFlagSource,
	): ScannerRecorderDecision | null {
		const c = countSnapshot(s, track, barred)
		s.snapshots = c.snapshots
		if (c.flag === null) return c.bar
		const flag = c.flag
		s.flagLate = c.flagLate
		s.flagged = c.flagged
		s.flaggedInChannel = c.flaggedInChannel
		const kept = c.bar === null
		const atMs = Math.max(
			0,
			Math.round(((track.lastSample - s.onset) * 1000) / s.fs),
		)
		const first = s.unclean === null
		// Counts are filled in at each decision (decide).
		if (!kept || first)
			s.unclean = {
				flag,
				raisedBy: via,
				atMs,
				flagged: s.flagged,
				snapshots: s.snapshots,
				kept,
			}
		if (!kept) return barred
		if (first)
			this.log.info(
				{
					observationId: s.owner,
					uncleanFlag: flag,
					uncleanRaisedBy: via,
					uncleanAtMs: atMs,
					uncleanFlagged: s.flagged,
					uncleanSnapshots: s.snapshots,
				},
				"Analog recorder keeps a session over an unclean reading",
			)
		return null
	}

	/** `file`'s terminal decision, noted once: a later failure or receipt of it notes nothing. */
	private endFile(
		s: Session,
		file: FileState,
		code: ScannerRecorderDecision,
		receipt?: ReceiptDetail,
	): void {
		if (file.decided) return
		file.decided = true
		this.decide(s, code, receipt)
	}

	/**
	 * One decision ending `files` (a refusal or discard of the session): noted once when it ends a
	 * file not decided yet, or when it ends no file at all (the session's own end). A file whose
	 * finish was already asked for is not ended by it: its receipt is its decision (onSettled).
	 */
	private terminate(
		s: Session,
		files: readonly FileState[],
		code: ScannerRecorderDecision,
	): void {
		let fresh = files.length === 0
		for (const f of files) {
			if (f.decided || f.finishAsked) continue
			f.decided = true
			fresh = true
		}
		if (fresh) this.decide(s, code)
	}

	private wake(s: Session): void {
		if (s.scheduled || s.done) return
		s.scheduled = true
		this.pending.add(s)
		if (this.turnScheduled) return
		this.turnScheduled = true
		this.schedule(() => this.runTurn())
	}

	/**
	 * One event-loop turn: drains every session woken before it (a session woken during it
	 * drains next turn). The turn is the unit of the catch-up grant (catchUp).
	 */
	private runTurn(): void {
		this.turnScheduled = false
		const due = [...this.pending]
		this.pending.clear()
		this.turnDue = due
		this.grant = null
		try {
			for (const s of due) {
				s.scheduled = false
				try {
					this.drain(s)
				} catch (err: unknown) {
					this.warn(err)
					this.terminate(
						s,
						this.cancelSession(s, "cancelled"),
						"discarded:error",
					)
				}
			}
		} finally {
			this.turnDue = null
			this.grant = null
		}
	}

	/** Ring headroom (ring − backlog) in ms; Infinity when the session is within maxBacklog. */
	private headroomMs(s: Session): number {
		if (s.done || !s.file) return Number.POSITIVE_INFINITY
		const backlog = Math.min(s.engine.liveEdge(), s.limit) - s.next
		if (backlog <= s.maxBacklog) return Number.POSITIVE_INFINITY
		return ((s.maxBacklog + s.margin - backlog) * 1000) / s.fs
	}

	/**
	 * Demodulated IQ (samples) `s` may still catch up past the turn budget this turn: the turn's
	 * one grant goes, at its first request, to the due session with the least ring headroom,
	 * for at most that session's margin; every other session gets 0 (it defers).
	 */
	private catchUp(s: Session): number {
		if (this.grant === null) {
			let best = s
			let least = this.headroomMs(s)
			for (const t of this.turnDue ?? []) {
				const h = this.headroomMs(t)
				if (h < least) {
					best = t
					least = h
				}
			}
			this.grant = { session: best, left: best.margin }
		}
		return this.grant.session === s ? this.grant.left : 0
	}

	private drain(s: Session): void {
		if (s.done) return
		const engine = this.deps.engine(s.sourceId)
		if (engine !== s.engine) {
			this.endSession(s, "stream-changed")
			return
		}
		const epoch = engine.currentEpoch()
		if (epoch.stream !== s.stream) {
			this.endSession(s, "stream-changed")
			return
		}
		if (epoch.epoch !== s.epoch && s.limit === Number.POSITIVE_INFINITY) {
			// A retune: nothing at or past the new epoch's start is this channel. The file ends
			// at the earlier of its own end target and that start; no later file follows. A
			// sweep that hops after the hang has a complete file.
			s.limit = epoch.startSample ?? s.next
			const target = s.seg.endTarget
			const end = Math.min(target ?? s.limit, s.limit)
			const cut: AnalogCut =
				target !== null && target <= s.limit
					? "completed"
					: (s.endCut ?? "epoch-changed")
			s.seg.abort()
			s.pendingStart = null
			if (s.file && s.file.endSample === null) {
				s.file.endSample = end
				s.file.cut = cut
			}
		}
		const edge = Math.min(engine.liveEdge(), s.limit)
		this.applyEvents(s, s.seg.advance(edge))
		const file = s.file
		if (!file) {
			this.dispose(s)
			return
		}
		// The target moves when a long input gap ends the file (gapTo).
		const target = (): number =>
			Math.min(edge, file.endSample ?? Number.POSITIVE_INFINITY)
		// Slices until caught up, for WIDEBAND_TURN_BUDGET_MS (at least one), and past it while
		// the backlog is within WIDEBAND_RING_MARGIN_MS of the ring's oldest end, if this
		// session holds the turn's catch-up grant (catchUp; the documented exception).
		const started = this.clock()
		let catching = false
		while (s.next < target()) {
			const demodulated = this.readSlice(s, file, engine, target())
			if (s.done || s.file !== file) return
			// A slice that read nothing cost no DSP: it spends neither the budget nor the grant.
			if (demodulated === 0) continue
			if (catching && this.grant !== null)
				this.grant.left = Math.max(0, this.grant.left - demodulated)
			if (this.clock() - started < WIDEBAND_TURN_BUDGET_MS) continue
			if (edge - s.next <= s.maxBacklog || this.catchUp(s) <= 0) break
			catching = true
		}
		const more = s.next < target()
		if (s.done || s.file !== file) return
		const until = Math.min(
			s.seg.writableUntil(edge),
			file.endSample ?? Number.POSITIVE_INFINITY,
		)
		this.judge(s, file, this.framesAt(s, file, until))
		if (s.done || s.file !== file) return
		this.flush(s, file, until)
		if (file.endSample !== null && s.next >= file.endSample && !file.finishing)
			this.finishFile(s, file)
		if (more) this.wake(s)
	}

	/**
	 * Demodulates one slice from `s.next` (at most WIDEBAND_SLICE_MS, not past `target`);
	 * returns the samples demodulated (0 for a slice with nothing readable).
	 */
	private readSlice(
		s: Session,
		file: FileState,
		engine: WidebandEngineView,
		target: number,
	): number {
		const to = Math.min(
			target,
			s.next + Math.max(1, Math.round((WIDEBAND_SLICE_MS * s.fs) / 1000)),
		)
		const r = engine.readRing(s.next, to)
		if (r === null) {
			// Nothing readable in this slice (overwritten, or a ring gap). The next slice is
			// tried in the same turn: a probe that reads nothing costs no DSP, so the turn
			// budget and catch-up grant do not slow it. Readability is not monotonic (the ring
			// keeps several gaps), so no probe may skip past IQ it did not read: only the slice
			// itself is missing. A file stops at WIDEBAND_MAX_SILENCE_GAP_MS of it (gapTo).
			this.gapTo(s, file, to)
			return 0
		}
		if (r.startSample > s.next) this.gapTo(s, file, r.startSample)
		if (s.done || s.file !== file) return 0
		for (let o = 0; o < r.bytes.length; o += MAX_SLICE_SAMPLES * 2) {
			const pcm = s.chain.process(
				r.bytes.subarray(
					o,
					Math.min(r.bytes.length, o + MAX_SLICE_SAMPLES * 2),
				),
			)
			this.enqueue(s, file, { pcm, tone: s.chain.toneAudio().slice() })
			if (s.done || s.file !== file) return r.bytes.length / 2
		}
		s.next = r.startSample + r.bytes.length / 2
		file.gapRun = 0
		return r.bytes.length / 2
	}

	/** Input [s.next, to) is missing: a short gap becomes silence, a long one ends the file. */
	private gapTo(s: Session, file: FileState, to: number): void {
		const missing = to - s.next
		if (missing <= 0) return
		if (file.frames === 0) {
			// Nothing produced yet: the pre-roll simply starts later (the ring did not reach). Past
			// one engine block the file lost audio it should hold: it is kept as cut.
			file.startSample = to
			s.next = to
			if (to - file.planned > (WIDEBAND_HEAD_CUT_TOLERANCE_MS * s.fs) / 1000)
				file.headCut = true
			return
		}
		const gap: AnalogGap = {
			cause: "input-gap",
			inputSampleIndex: s.next,
			droppedInputSamples: missing,
			outputFrameIndex: file.frames,
		}
		if (file.handle) file.handle.addGap(gap)
		else if (file.gaps.length < WIDEBAND_MAX_PENDING_GAPS) file.gaps.push(gap)
		if (file.gapRun === 0) file.gapFrom = s.next
		file.gapRun += missing
		if (file.gapRun > (WIDEBAND_MAX_SILENCE_GAP_MS * s.fs) / 1000) {
			// Frames already queued past `end` (silence of this run) are trimmed at the finish.
			const end = file.gapFrom
			s.next = to
			file.endSample = Math.min(file.endSample ?? end, end)
			file.cut = "source-lost"
			s.seg.abort()
			s.pendingStart = null
			return
		}
		const silence = new Int16Array(
			Math.round((missing * ANALOG_AUDIO_RATE_HZ) / s.fs),
		)
		this.enqueue(s, file, { pcm: silence, tone: silence })
		s.next = to
	}

	private framesAt(s: Session, file: FileState, sample: number): number {
		return Math.max(
			0,
			Math.round(((sample - file.startSample) * ANALOG_AUDIO_RATE_HZ) / s.fs),
		)
	}

	/** Frames this session holds in memory, over every file not written yet. */
	private buffered(s: Session): number {
		let n = 0
		for (const f of s.files) n += f.queue.length
		return n
	}

	private enqueue(s: Session, file: FileState, f: Frames): void {
		if (f.pcm.length === 0) return
		if (this.buffered(s) + f.pcm.length > WIDEBAND_MAX_BUFFERED_FRAMES) {
			// Unclassed for a minute, or the writer is not keeping up: this file is lost.
			this.refuse(s, "discarded:buffer-full")
			return
		}
		file.queue.push(f.pcm)
		file.unjudged.push(f)
		file.frames += f.pcm.length
	}

	/**
	 * The gate and the CTCSS bank hear the produced frames up to `until` (a frame index of the
	 * file), as soon as no late track report can change the spans there. A file that sounds like
	 * voice is admitted; a session never voiced that heard WIDEBAND_QUALIFY_FRAMES of in-track
	 * audio in a file without it ends and is refused.
	 */
	private judge(s: Session, file: FileState, until: number): void {
		while (file.judged < until && file.unjudged.length > 0) {
			const head = file.unjudged[0]!
			const n = Math.min(head.pcm.length, until - file.judged)
			if (n === head.pcm.length) file.unjudged.shift()
			else
				file.unjudged[0] = {
					pcm: head.pcm.subarray(n),
					tone: head.tone?.subarray(n) ?? null,
				}
			if (head.tone !== null)
				this.toneFrames(s, file, file.judged, head.tone.subarray(0, n))
			this.gateFrames(s, file, file.judged, head.pcm.subarray(0, n))
			file.judged += n
		}
		if (file.gate.voiced) {
			if (!s.qualified) {
				this.decide(s, "voiced")
				this.forgetRestarts(s)
			}
			s.qualified = true
			if (!s.classed) this.classByTone(s, file.toneClass?.result() ?? null)
			this.admit(s, file)
		} else if (
			!s.qualified &&
			file.heard >= WIDEBAND_QUALIFY_FRAMES &&
			!file.finishing
		) {
			// Not voice after 8 s in the track: a carrier, not a transmission worth a slot. A
			// session already voiced (a pause, or a 120 s roll-over) keeps its conversation.
			this.refuse(s, "discarded:unvoiced", true)
			return
		}
		if (s.done || s.classed || !s.digital || file.finishing) return
		const expired = digitalExpiry(s.qualified, s.inTrack)
		if (expired !== null) this.expireDigital(s, expired)
	}

	/**
	 * A spectrally digital shadow not voiced or not classed in its window (or a hopeless or stale
	 * one that yielded, `evicted`): discarded, and its observations start no other shadow in this
	 * visit (`digitalExpired`, which also counts the visits that ended unclassed for
	 * WIDEBAND_EXPIRED_STALE); a later snapshot classed analog-fm, or one of a later visit, still
	 * starts a recording for them.
	 */
	private expireDigital(s: Session, code: ScannerRecorderDecision): void {
		const ids = [...s.observations]
		this.refuse(s, code, true)
		const visit = visitKey(s)
		const unclassed = code === "discarded:unvoiced" ? 0 : 1
		for (const id of ids) {
			this.refused.delete(id)
			const before = this.digitalExpired.get(id)?.unclassed ?? 0
			this.digitalExpired.delete(id)
			this.digitalExpired.set(id, { visit, unclassed: before + unclassed })
			if (this.digitalExpired.size > MAX_REMEMBERED) {
				const oldest = this.digitalExpired.keys().next()
				if (oldest.done !== true) this.digitalExpired.delete(oldest.value)
			}
		}
	}

	/**
	 * A shadow's own audio classes it analog-fm, for this recorder only (`toneOnly`): voice (the
	 * gate passed) and `toneHz`, the file's ToneClassEvidence verdict (speech over a stable
	 * standard CTCSS tone at an encoder's level, tone-class.ts). The spectrum alone may read a
	 * weak or low-deviation NFM over as a narrow digital class (gmsk-narrow, fsk4-6k25,
	 * ook-burst) for its whole length. The class publishes no tone evidence (onSettled), and a
	 * later `nonAnalog` still discards the session (classify, updateParked). Called on every
	 * judged turn of a voiced, unclassed session (a 50-entry scan), so the class lands at most one
	 * judging step after the evidence holds.
	 */
	private classByTone(s: Session, toneHz: number | null): void {
		if (toneHz === null || s.classed || s.done) return
		s.classed = true
		s.toneOnly = true
		this.decide(s, "classed")
		for (const f of [...s.files]) this.admit(s, f)
	}

	/** CTCSS input: only frames inside the observed activity (no pre-roll, no hang noise). */
	private toneFrames(
		s: Session,
		file: FileState,
		first: number,
		tone: Int16Array,
	): void {
		const bank = file.ctcss
		if (bank === null) return
		const evidence = file.toneClass
		const perFrame = s.fs / ANALOG_AUDIO_RATE_HZ
		for (let i = 0; i < tone.length; i++) {
			const sample = file.startSample + (first + i) * perFrame
			if (sample >= s.onset && sample <= s.lastActive) {
				const t = tone[i]!
				bank.pushSample(t / 32_768)
				evidence?.tone(bank, t)
			}
		}
	}

	/**
	 * Voice gate input: the judged frames inside a joined track's span, trimmed by
	 * WIDEBAND_GATE_EDGE_TRIM_MS at both ends (an open track runs to now). Pre-roll, hang and the
	 * noise between joined transmissions stay out: squelch-open noise is not a carrier's audio.
	 * Once the session is voiced the same frames feed its VoiceOnAirMeter (the per-transmission
	 * voice signal of recordingActive) for as long as it runs; before, only the file gate filters
	 * them, and the end of its qualifying window is the first voiced window (`voiceAt`), so each
	 * frame runs through one voice filter chain only. No allocation per chunk: the mask is the
	 * session's, and runs are passed as ranges, not views.
	 */
	private gateFrames(
		s: Session,
		file: FileState,
		first: number,
		pcm: Int16Array,
	): void {
		const perFrame = s.fs / ANALOG_AUDIO_RATE_HZ
		const from = file.startSample + first * perFrame
		for (const [id, a] of s.activity)
			if (!a.open && a.last < from) s.activity.delete(id)
		if (pcm.length === 0) return
		s.judgedTo = Math.max(s.judgedTo, from + pcm.length * perFrame)
		const trim = (WIDEBAND_GATE_EDGE_TRIM_MS * s.fs) / 1000
		if (s.mask.length < pcm.length) s.mask = new Uint8Array(pcm.length)
		const mask = s.mask
		mask.fill(0, 0, pcm.length)
		for (const a of s.activity.values()) {
			const lo = Math.max(0, Math.ceil((a.start + trim - from) / perFrame))
			const hi = a.open
				? pcm.length
				: Math.min(
						pcm.length,
						Math.floor((a.last - trim - from) / perFrame) + 1,
					)
			if (hi > lo) mask.fill(1, lo, hi)
		}
		let i = 0
		while (i < pcm.length) {
			if (mask[i] === 0) {
				i++
				continue
			}
			let j = i
			while (j < pcm.length && mask[j] === 1) j++
			s.inTrack += j - i
			const evidence = file.toneClass
			if (evidence !== null && (!s.classed || s.toneOnly)) {
				// classByTone's speech test: the same in-track runs, a break resets its meter (also
				// once classed by it: the whole file is checked again when it finishes).
				const runFrom = from + i * perFrame
				evidence.speechRun(
					pcm,
					i,
					j,
					runFrom - evidence.speechTo > perFrame / 2,
				)
				evidence.speechTo = from + j * perFrame
			}
			let k = i
			if (!file.gate.voiced) {
				k += file.gate.push(pcm, i, j)
				file.heard += k - i
				s.heard += k - i
				// The first voiced window ends here (the gate latched at frame k).
				if (file.gate.voiced) s.voiceAt = from + k * perFrame
			}
			// A session voiced in an earlier file meters every frame (its new file's gate runs too,
			// until that file is voiced); otherwise the meter starts where the gate latched.
			const m = s.qualified ? i : k
			if ((s.qualified || file.gate.voiced) && m < j) {
				const runFrom = from + m * perFrame
				// A run that does not continue the last one (another track, after a gap or a trim,
				// or the first after the gate latched): no meter window joins the two.
				if (runFrom - s.meterTo > perFrame / 2) s.meter.reset()
				const voicedTo = s.meter.push(pcm, m, j)
				if (voicedTo > 0) {
					const at = from + voicedTo * perFrame
					s.quietGap = Math.max(s.quietGap, at - (s.voiceAt ?? at))
					s.voiceAt = at
				}
				s.meterTo = from + j * perFrame
			}
			i = j
		}
	}

	/** Pushes queued, judged frames older than `until` (a sample index), one bounded push at a time. */
	private flush(s: Session, file: FileState, until: number): void {
		if (!file.ready || file.writing || file.failed) return
		const written = file.frames - file.queue.length
		const allowed = Math.min(
			file.judged,
			this.framesAt(s, file, until),
			file.endSample === null
				? Number.POSITIVE_INFINITY
				: this.framesAt(s, file, file.endSample),
		)
		const budget = Math.min(PUSH_FRAMES, allowed - written)
		if (budget <= 0) return
		const handle = file.handle
		if (handle === null) return
		const chunk = file.queue.take(budget)
		file.writing = true
		handle.push(chunk).then(
			() => {
				file.writing = false
				if (s.file === file && !s.done) this.wake(s)
				else if (file.finishing) this.completeFinish(s, file)
			},
			() => {
				file.writing = false
				file.failed = true
				// Its decision comes with the receipt (onSettled): the push fails the same way whether the
				// disk failed or the store already cancelled the operation, which only the receipt tells.
				file.pushFailed = true
				if (s.file === file && !s.done) {
					for (const id of s.observations) remember(this.refused, id)
					this.cancelSession(s, "cancelled")
				}
				// A finishing file (finishFile cleared s.file): the session goes on.
				else handle.cancel("cancelled")
			},
		)
	}

	/** The file reached its end sample: judge and write what belongs to it, then finish it. */
	private finishFile(s: Session, file: FileState): void {
		file.finishing = true
		const endedAt = file.endSample ?? s.next
		const endFrames = this.framesAt(s, file, endedAt)
		this.judge(s, file, endFrames)
		if (file.failed) {
			this.revokeWaivers(s)
			if (s.file === file) s.file = null
			if (!s.done) this.dispose(s)
			return
		}
		// Frames past the end belong to the next file (roll-over or a new transmission) or go.
		const excess = Math.max(0, file.frames - endFrames)
		const carry = file.queue.takeTail(excess)
		file.frames -= carry.reduce((n, f) => n + f.length, 0)
		file.unjudged.length = 0
		if (
			file.headCut &&
			(file.cut === "completed" || file.cut === "duration-limit")
		)
			file.cut = "source-lost"
		file.toneHz = file.ctcss?.result() ?? null
		file.classTone = file.toneClass?.result() ?? null
		file.toneClass = null
		if (s.toneOnly && file.classTone === null && !file.failed) {
			// Classed by its audio only, and the whole file no longer holds the evidence (its
			// prefix did): discarded, a file being written is cancelled (completeFinish).
			this.endFile(s, file, "discarded:unclassed")
			file.failed = true
		}
		file.ctcss = null
		const next = s.pendingStart
		s.pendingStart = null
		s.file = null
		if (next !== null && !this.stopped) {
			this.openFile(s, next)
			const cont = s.file as FileState | null
			if (cont && next >= endedAt && next <= s.next) {
				// The carried frames are samples [endedAt, s.next): keep those from `next` on (not
				// for the CTCSS bank: their tone twin is gone).
				let skip = Math.round(((next - endedAt) * ANALOG_AUDIO_RATE_HZ) / s.fs)
				for (const part of carry) {
					if (skip >= part.length) {
						skip -= part.length
						continue
					}
					this.enqueue(s, cont, { pcm: part.subarray(skip), tone: null })
					skip = 0
				}
			} else if (cont) s.next = Math.max(s.next, next)
		}
		this.completeFinish(s, file)
		if (s.file) this.wake(s)
		else if (s.parkedUntil !== null && !s.done) this.park(s)
		else this.dispose(s)
	}

	/**
	 * A voiced shadow file a retune ended (cut epoch-changed) while some joined observation is
	 * still open: its close may bring the first analog-fm class, so it is kept, not discarded.
	 */
	private parkable(s: Session, file: FileState): boolean {
		return (
			!this.stopped &&
			!s.done &&
			file.cut === "epoch-changed" &&
			file.gate.voiced &&
			Number.isFinite(s.limit) &&
			s.observations.size > 0 &&
			(!s.classed || s.discoveryId === null)
		)
	}

	/**
	 * The session stops demodulating and gives its cores back; its parked files and observation
	 * mappings stay until the close, WIDEBAND_PARK_MS of stream past the epoch change, a stream
	 * or engine change, or WIDEBAND_MAX_PARKED newer parked sessions.
	 */
	private park(s: Session): void {
		const until = s.parkedUntil
		this.dispose(s, true)
		s.parkedUntil = until
		this.parked.set(s.id, s)
		if (this.parked.size > WIDEBAND_MAX_PARKED) {
			const oldest = this.parked.values().next()
			if (oldest.done !== true)
				this.dropParked(oldest.value, false, "discarded:park-expired")
		}
		if (!this.parked.has(s.id)) return
		s.untap = s.engine.tap(() => this.checkParked(s))
	}

	/** Engine write: a parked session past its time, or on a changed stream, is discarded. */
	private checkParked(s: Session): void {
		if (!this.parked.has(s.id)) return
		try {
			const engine = this.deps.engine(s.sourceId)
			if (
				engine !== s.engine ||
				engine.currentEpoch().stream !== s.stream ||
				engine.liveEdge() > (s.parkedUntil ?? Number.NEGATIVE_INFINITY)
			)
				this.dropParked(s, false, "discarded:park-expired")
		} catch (err: unknown) {
			this.warn(err)
			this.dropParked(s, false, "discarded:error")
		}
	}

	/**
	 * A snapshot (`closing`: the close) of a parked session's observation: barred (encrypted,
	 * opted out, unclean) or a definite other class discards every parked file; analog-fm with a
	 * discovery promotes them (written, cut epoch-changed); once every observation closed without
	 * that, they are discarded.
	 */
	private updateParked(
		s: Session,
		observationId: string,
		info: ClassInfo | undefined,
		barred: ScannerRecorderDecision | null,
		closing: boolean,
	): void {
		if (closing) s.observations.delete(observationId)
		if (barred !== null) {
			this.dropParked(s, true, barred)
			return
		}
		if (info !== undefined) {
			if (observationId === s.owner && info.discoveryId !== null) {
				s.discoveryId ??= info.discoveryId
				this.decisions.bindDiscovery(s.owner, info.discoveryId)
			}
			if (info.analogFm) {
				if (s.toneOnly) this.classedBySnapshot(s, observationId)
				s.toneOnly = false
				if (!s.classed) {
					s.classed = true
					this.decide(s, "classed")
				}
			} else if ((!s.classed || s.toneOnly) && info.nonAnalog === true) {
				this.dropParked(s, true, "discarded:not-analog")
				return
			}
		}
		// A voiced shadow parked before its audio was judged: a finished file's own evidence.
		if (!s.classed && s.qualified)
			for (const f of s.files)
				if (f.classTone !== null) {
					s.classed = true
					s.toneOnly = true
					this.decide(s, "classed")
					break
				}
		// Promote only once every contributing observation closed: an open one's close may still
		// carry an encrypted or opted-out veto (WIDEBAND_PARK_MS bounds the wait).
		if (s.observations.size > 0) return
		if (s.classed && s.discoveryId !== null) {
			this.unpark(s)
			for (const id of s.observations)
				if (this.byObservation.get(id) === s.id) this.byObservation.delete(id)
			for (const f of [...s.files]) this.admit(s, f)
			// Admission failures already have their decision (refused:store, store-backlog).
			for (const f of [...s.files])
				if (f.handle === null && !s.waiting.includes(f)) {
					f.failed = true
					s.files.delete(f)
					this.endFile(s, f, this.unwrittenCode(s, f))
				}
			return
		}
		this.dropParked(
			s,
			true,
			s.classed ? "discarded:no-discovery" : "discarded:unclassed",
		)
	}

	private unpark(s: Session): void {
		this.parked.delete(s.id)
		s.untap()
		s.untap = () => undefined
		s.parkedUntil = null
		this.publishTones(s)
	}

	/** Discards a parked session's files (nothing of them was written). */
	private dropParked(
		s: Session,
		refuse: boolean,
		code: ScannerRecorderDecision,
	): void {
		if (!this.parked.has(s.id)) return
		this.unpark(s)
		const dropped: FileState[] = []
		for (const f of [...s.files])
			if (f.handle === null) {
				f.failed = true
				s.files.delete(f)
				dropped.push(f)
			}
		this.terminate(s, dropped, code)
		s.waiting.length = 0
		this.revokeWaivers(s)
		for (const id of s.observations) {
			if (this.byObservation.get(id) === s.id) this.byObservation.delete(id)
			if (refuse) remember(this.refused, id)
		}
	}

	/** Writes the rest of a finishing file's queue, then finishes its operation. */
	private completeFinish(s: Session, file: FileState): void {
		if (file.failed) {
			this.fileLost(s)
			file.handle?.cancel("cancelled")
			s.files.delete(file)
			// Every failure notes its decision; this only guards a file that would end without one.
			if (file.handle === null) this.endFile(s, file, "discarded:aborted")
			return
		}
		if (file.handle === null) {
			// Never admitted: every frame was judged, so this is the last chance. A file too short
			// for one gate window is judged on all of it.
			if (file.gate.conclude()) {
				if (!s.qualified) {
					this.decide(s, "voiced")
					this.forgetRestarts(s)
				}
				s.qualified = true
			}
			this.admit(s, file)
			// A failed admission (refused:store, store-backlog) already noted the file's decision.
			if (file.failed) return
			if (file.handle === null && !s.waiting.includes(file)) {
				if (this.parkable(s, file)) {
					// A retune ended it before its class: kept for the close (finishFile parks).
					s.parkedUntil = s.limit + Math.round((WIDEBAND_PARK_MS * s.fs) / 1000)
					return
				}
				// Not voiced, never classed or no discovery: nothing was written, nothing is kept.
				file.failed = true
				this.fileLost(s)
				s.files.delete(file)
				const code = this.unwrittenCode(s, file)
				this.endFile(s, file, code)
				// A 120 s file without voice: the session ends (its continuation, if any, with it).
				if (file.cut === "duration-limit" && !s.done) this.refuse(s, code)
			}
			// Admitted: the readiness handler resumes the finish (or a failure cancels).
			return
		}
		// Not ready yet: the readiness handler resumes the finish (or a failure cancels).
		if (!file.ready) return
		if (file.writing) return
		if (file.queue.length > 0) {
			this.flush(s, file, Number.POSITIVE_INFINITY)
			return
		}
		file.finishAsked = true
		void file.handle.finish(file.cut).catch(() => undefined)
	}

	/** Why a finished file that was never admitted is dropped (completeFinish). */
	private unwrittenCode(s: Session, file: FileState): ScannerRecorderDecision {
		if (!file.gate.voiced) {
			if (file.cut === "source-lost") return "discarded:source-lost"
			return file.heard < VOICE_MIN_FINAL_FRAMES
				? "discarded:too-short"
				: "discarded:unvoiced"
		}
		if (!s.classed) return "discarded:unclassed"
		if (s.discoveryId === null) return "discarded:no-discovery"
		// Voiced, classed, with a discovery and still not admitted: the store did not take it.
		return "refused:store"
	}

	/** Ends every open file now (kept, cut), e.g. stream loss or shutdown. */
	private endSession(s: Session, cut: AnalogCut): void {
		const file = s.file
		s.pendingStart = null
		if (file && !file.finishing) {
			file.endSample = Math.min(file.endSample ?? s.next, s.next)
			file.cut = cut
			if (file.frames === 0) {
				file.failed = true
				s.file = null
				s.files.delete(file)
				file.handle?.cancel(cut)
				this.endFile(s, file, "discarded:empty")
			} else this.finishFile(s, file)
		}
		this.dispose(s)
	}

	/** Cancels the current file (every file with `everyFile`); returns the files it ended. */
	private cancelSession(
		s: Session,
		cut: AnalogCut,
		everyFile = false,
	): FileState[] {
		const file = s.file
		s.file = null
		s.pendingStart = null
		s.seg.abort()
		const files = everyFile ? [...s.files] : file ? [file] : []
		if (everyFile) s.waiting.length = 0
		else if (file) {
			const at = s.waiting.indexOf(file)
			if (at >= 0) s.waiting.splice(at, 1)
		}
		for (const f of files) {
			f.failed = true
			f.handle?.cancel(cut)
			if (f.handle === null) s.files.delete(f)
		}
		// Files never admitted hold nothing in the store: an unadmitted finishing one goes too.
		for (const f of [...s.files])
			if (f.handle === null && !s.waiting.includes(f)) {
				f.failed = true
				s.files.delete(f)
				files.push(f)
			}
		this.revokeWaivers(s)
		this.dispose(s)
		return files
	}

	/** `keepMappings`: parked, its open observations still map to it. */
	private dispose(s: Session, keepMappings = false): void {
		if (s.done) return
		s.done = true
		s.untap()
		s.untap = () => undefined
		s.releaseCores()
		this.sessions.delete(s.id)
		if (!keepMappings)
			for (const id of s.observations)
				if (this.byObservation.get(id) === s.id) this.byObservation.delete(id)
		const end = s.seg.previousEnd
		if (Number.isFinite(end)) {
			this.recentEnds.push({
				sourceId: s.sourceId,
				stream: s.stream,
				epoch: s.epoch,
				hz: s.targetHz,
				end,
			})
			if (this.recentEnds.length > RECENT_ENDS) this.recentEnds.shift()
		}
		if (!keepMappings) this.publishTones(s)
	}

	/** At most one warning a minute; never the error's untrusted text beyond safe fields. */
	private warn(err: unknown): void {
		const now = this.deps.now()
		if (now - this.warnedAt < 60_000) return
		this.warnedAt = now
		this.log.warn(safeErrorFields(err), "Wideband analog recording failed")
	}
}
