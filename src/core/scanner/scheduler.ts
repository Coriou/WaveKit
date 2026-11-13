// src/core/scanner/scheduler.ts
/**
 * Sweep scheduler (spec § 10.2): ascending coarse hops, dwell measured in samples from the settled
 * epoch start, holds for confirmation and following, activity-weighted revisits, per-hop gain
 * memory, and re-plans applied at hop boundaries. Pure: the job runner feeds events and executes
 * the returned actions.
 *
 * Fair holds: every frequency is held like any signal (a confirm probe on each visit, analog voice
 * followed on air) until a hold shows positive carrier evidence for it; only then is it held under
 * the carrier rules (a retry budget and holds of at most one coarse sweep). See FrequencyMemory.
 *
 * Qualification: a dwell is short (minSurfaceBlocks + 1 blocks) and only a hop with energy the
 * channel gate has not answered yet listens on, within a bound derived from that gate (onCandidate,
 * qualifyBlocks). An empty hop pays nothing.
 */
import {
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MIN_DURATION_MS,
	CLASS_SETTLE_BLOCKS,
} from "./scanner-redesign-contract.js"
import { WaveKitError } from "../../utils/errors.js"
import {
	WIDEBAND_VOICE_ANSWER_MS,
	WIDEBAND_VOICE_JUDGE_MS,
} from "./channel/wideband-analog-recorder.js"
import type { Hop, HopPlan, NormalisedJobSpec } from "./types.js"
import type { TrackSnapshot } from "../spectrum/types.js"

// Single-line variants: prettier would align them with spaces after tabs (no-mixed-spaces-and-tabs).
// prettier-ignore
export type SchedulerAction =
	| { type: "tune"; hopIndex: number; centreHz: number; gainTenthsDb: number | null }
	| { type: "start-probe"; trackId: string; holdMs: number }
	| { type: "stop-probes" }
	| { type: "sweep-complete"; sweepIndex: number }

const ACTIVITY_HALF_LIFE_MS = 10 * 60_000
const SWEEP_PERIOD_ALPHA = 0.3
const GAIN_STEP_TENTHS = 60
const CLEAN_VISITS_TO_RAISE = 3
const CANDIDATE_BOOST = 2
/**
 * Two sightings are the same frequency within half a 12.5 kHz channel, or half the wider track's
 * occupied bandwidth when that is larger (a wideband emitter's centroid wanders more).
 */
const SAME_FREQUENCY_FLOOR_HZ = 6_250
/**
 * Bin width of the frequency memory index: one 12.5 kHz channel (twice SAME_FREQUENCY_FLOOR_HZ). A
 * lookup reads the bins within the widest same-frequency tolerance of the memory, so it compares a
 * few entries (at most MAX_FREQUENCY_MEMORY per hop of a bin's width can sit in a bin) instead of
 * every remembered frequency.
 */
const MEMORY_BIN_HZ = 2 * SAME_FREQUENCY_FLOOR_HZ
/**
 * Frequencies remembered per hop of the plan. A hop spans at most 3.2 Msps × 0.8 = 2.56 MHz, which
 * is 205 12.5 kHz channels; 256 per hop covers every channel of the widest plan, so a full band
 * never evicts a frequency it hears (frequencies missed longest go first).
 */
const MAX_FREQUENCY_MEMORY = 256
/**
 * Full visits in a row that did not hear a frequency before it is forgotten (its evidence with
 * it). Counted in visits that could have heard it, never in clock time: time held on another hop
 * or a source outage forgets nothing.
 */
const FORGET_MISSES = 10
/**
 * Off-air time that proves traffic. A reopening's gap is read on air (gapOnAirMs), from the closed
 * track's last block to the reopening's first: the engine's close comes about 500 ms after that last
 * block and a gate passes the reopening up to 350 ms after its first, and neither counts. A block
 * that is on air for part of its length counts as on, so in 50 ms blocks a gap of g ms spans whole
 * off blocks of more than g − 100 and at most g ms; one block is added, so it reads more than g − 50
 * and at most g + 50: a QSO turnaround (1 s or more) reads 1000 ms or more, a carrier flapping with
 * gaps of up to 0.9 s reads at most 950 (between the two, either). A close and reopen read less than
 * this apart is a flap: carrier evidence. A close with no reopening is read from the close to the end
 * of the visit (noteHeardGaps), since a reopening may still wait for its gate when the visit ends.
 */
const TRAFFIC_GAP_MS = 1_000
/**
 * N: a hold that watched a frequency not known as traffic (its onset unseen) on air without a break
 * for this long is positive carrier evidence, and a hold of a frequency not known is cut here (one
 * whose onset was seen is then followed on after a coarse sweep, see CALL_RUN_MS).
 * Arithmetic: a 3-hop plan of 1150 ms hops sweeps in 3450 ms, so a new carrier keeps the other
 * hops waiting at most 8000 + 1050 ms (a hang classing a gap) more than a sweep; a 60-hop plan
 * (69 000 ms sweep) with five such carriers on air from its start gets 5 × 9050 = 45 250 ms of
 * holds in its first sweep (not 5 × maxHoldMs). A confirm probe that needs longer still runs its
 * class window (confirmEnd). Long enough to hear a turnaround in about a third of the 5 to 30 s
 * overs of a QSO already on air (8000 / 19 500 ms on average), short of the 28 s of an ID.
 */
const CARRIER_WATCH_MS = 8_000
/**
 * Longest call a frequency not known as traffic, whose onset a visit saw, is held to its end: a 28 s
 * ID (from its first sighting, two blocks after it went on air) and 2 s of margin. Its first hold
 * watches it CARRIER_WATCH_MS; once every hop had a coarse visit, the next hold follows it until its
 * run (no close heard, no full visit missing it) lasts this long, which is carrier evidence. So the
 * other hops wait at most CARRIER_WATCH_MS, then one coarse sweep, then at most
 * CALL_RUN_MS − CARRIER_WATCH_MS − one sweep (3 hops of 1150 ms: 8000, then 30 000 − 8000 − 3450 =
 * 18 550 ms) for such a frequency, never `hold.maxHoldMs`.
 */
const CALL_RUN_MS = 30_000
/** Length of an ID a long follow on another hop must not hide (the 28 s of CALL_RUN_MS). */
const ID_MS = 28_000
/** Margin of the long follow cap (longFollowMs) for an ID detected late in a follow. */
const LONG_FOLLOW_MARGIN_MS = 5_000
/**
 * Blocks added to a qualification's answer: the first block of a track, which its gate may not be
 * able to measure yet (the track's channel is known from it), and the one off block a gate run
 * tolerates (measured through the real pipeline: a tone passes a 300 ms gate at its 6th block,
 * synthetic and captured FM voice by its 7th).
 */
const QUALIFY_MARGIN_BLOCKS = 2
/** Re-check period of a hold kept for a recording (Hold mode `record`): 5 blocks of 50 ms. */
const RECORD_RECHECK_MS = 250
/**
 * What the recording check (`recordingActive`) reports for the tuned window: false, nothing is
 * recorded (or the recorded transmission's squelch closed); true, a recording runs (the hop is kept
 * within L, keepForRecording), e.g. a carrier or a repeater hang after a voiced over; VoiceOnAir,
 * voice is on air in the recorded transmission now (classed analog, voiced, heard within the
 * recorder's last 2 s, WIDEBAND_VOICE_ON_AIR_MS): the hop is kept until that transmission ends,
 * up to `hold.maxHoldMs` ("record whole voice", so a 28 s ID is recorded whole). The voice hold
 * belongs to the transmission named when it starts (VoiceOnAir.voice): it is spent (Visit.voice)
 * by the first answer that is not voice or names another transmission (a turnaround), never by
 * how long the check went unasked, so a stalled event loop does not end it. A full coarse sweep
 * then follows the visit before the hop gets another (longHoldLock). "judging": a classed session
 * of the window has started and its voice answer is still to come (WIDEBAND_VOICE_JUDGE_MS): the
 * hop is kept for that answer, once per visit, so a landing is not split by leaving just before it.
 */
export type RecordingActivity =
	| boolean
	| VoiceOnAir
	| RecordedSession
	| "judging"

/**
 * A recording runs (as `true`) of a session the recorder classed analog FM and that sounded like
 * voice, with no voice on air at this moment (a pause, the hang or a line after the voice), and
 * the recorder says more about it than `true` does.
 */
export interface RecordedSession {
	readonly recording: true
	/**
	 * That session's frequency, given only once the store admitted a file operation of it: its
	 * verified voice history (FrequencyMemory.voiced), as VoiceOnAir.recordedHz. Absent: none.
	 */
	readonly recordedHz?: number
	/**
	 * The voiced transmission ended: its voice lies before the squelch last closed and reopened, so
	 * the open track is another transmission not voiced yet (a reply joined by the recorder's
	 * `hangMs`, or a kerchunk). That ends the visit's voice hold as a squelch close does, whatever
	 * the frequency's voice history: the hop is not kept and owes its forced coarse sweep (askRecording).
	 * Absent: the open track is still the voiced transmission's (a pause, the hang after it).
	 */
	readonly voiceEnded?: true
	/**
	 * Frequency (Hz) the session whose voiced transmission ended demodulates (its `targetHz`), given
	 * with `voiceEnded`: with no transmission remembered by the visit, only a `voiceEnded` in the held
	 * track's band (heldBandOffset) ends the hold; a neighbour's turnaround, or one of no known
	 * frequency (absent or not finite), is no end of it (askRecording).
	 */
	readonly targetHz?: number
	/** Every voiced transmission still on air in the window (VoiceOnAir.transmissions). */
	readonly transmissions?: Transmissions
	/**
	 * No session of the window records: the answer only carries the list, whose transmissions are
	 * all "unrecorded", and `bare` is what it reads as for any transmission not listed (false, or
	 * "judging"). Absent: the answer is a recording's.
	 */
	readonly bare?: false | "judging"
}

/**
 * Every voiced transmission still on air in the recorded window, by name (VoiceOnAir.voice): its
 * own voice answer while voice is on air in it, "quiet" while its track is still open with no voice
 * that recent (a pause, a carrier after the voice), "unrecorded" while its track is still open but
 * its session gave its slot up (the recorder evicted it for another candidate): on air, no longer
 * metered, so neither its voice nor its quiet is known. A transmission not listed has ended (its
 * squelch closed, or it was turned around). The recorder gives it when the window holds more than
 * one voiced session (two channels), whose answers would hide each other, or any unrecorded one:
 * the answer names only the first voiced one, so another channel's voice, or an eviction, is no
 * end of the transmission a hold heard (askRecording judges that one by its own entry). Absent:
 * the answer is the only session's own.
 */
export type Transmissions = Readonly<
	Record<string, VoiceOnAir | "quiet" | "unrecorded">
>

/** Voice on air in a recorded transmission (RecordingActivity). */
export interface VoiceOnAir {
	/**
	 * Identity of the voiced transmission (the recorder's open observation id): the same over
	 * answers the same identity, a new over (after a turnaround) another.
	 */
	readonly voice: string
	/**
	 * Longest quiet in the judged audio since the last answer, ms, the one still running included
	 * (past VOICE_QUIET_PAST_L_MS, a hold past L ends). Judged, not wall clock, so a stalled event
	 * loop adds nothing, and a quiet that ended between two answers still reads. Absent: none.
	 */
	readonly quietMs?: number
	/**
	 * Frequency (Hz) of the session that answered, given only by a recorder that recorded it: a
	 * session it classed analog FM that sounded like voice in a file the store admitted. It is
	 * that frequency's verified voice history (FrequencyMemory.voiced), which carrier evidence never
	 * caps. Absent: a bare voice answer, no history (it cannot lift a carrier's cap).
	 */
	readonly recordedHz?: number
	/**
	 * Frequency (Hz) the answering session demodulates (its `targetHz`), voiced or not, recorded or
	 * not: what names a transmission to the hold of a track (heldVoiceOf), never its voice history.
	 * Absent or not finite: the transmission is of no known frequency, so it names no held track.
	 */
	readonly targetHz?: number
	/** Every voiced transmission still on air in the window, this one among them (Transmissions). */
	readonly transmissions?: Transmissions
}

/**
 * The answer as the transmission named `id` sees it (Transmissions): the answer itself when it
 * names `id` or lists no transmissions; that transmission's own voice answer, or true while it is
 * quiet; null when the list shows it ended. Unrecorded (on air, its session evicted): still voice
 * of it, with no quiet known (the transmission the visit remembers was voiced in it, and only its
 * track's close or `hold.maxHoldMs` ends a voice hold on it). With no remembered transmission
 * (`id` null): the answer itself, or what it reads as when only unrecorded transmissions carry it
 * (RecordedSession.bare): the ordinary rules, an evicted transmission no visit heard keeps nothing.
 */
function answerOf(
	answer: RecordingActivity,
	id: string | null,
): RecordingActivity | null {
	if (typeof answer !== "object" || answer.transmissions === undefined)
		return answer
	if (id === null)
		return "bare" in answer && answer.bare !== undefined ? answer.bare : answer
	if (isVoiceOnAir(answer) && answer.voice === id) return answer
	const own = answer.transmissions[id]
	if (own === undefined) return null
	// Evicted from its recorder slot while still on air: no file is being made of it, so it holds
	// like any recording that is not voice, within L, never to hold.maxHoldMs; but it has not ended.
	if (own === "unrecorded") return true
	return own === "quiet" ? true : own
}

/**
 * Quiet a voice hold that reached L may still answer: 1000 ms. Before L the recorder's 2 s limit
 * (WIDEBAND_VOICE_ON_AIR_MS) carries a hold through a speaker's pauses, and under a repeater's hang
 * through a turnaround too, since the track never closes. Past L a hold must be continuous voice, so
 * the hold of one over does not run on into the next. The recorder knows the quiet, the scheduler L,
 * so the answer carries the quiet and the scheduler applies this. The recorder's voice windows slide
 * by one 100 ms block, so a quiet that has ended reads in 100 ms steps (the first that ends a hold
 * is 1100); one still running grows with the judged audio, in the source's chunks (25 ms in the
 * scene tests), so it may first read just over 1000. A pause of p ms reads about p − 300 (p less the voiced window's tail, plus the time the next window
 * takes to read voiced: synthetic voice, pauses of 600 to 2000 ms, each read exactly p − 300), so
 * the shortest pause that ends a hold is about 1100 + 300 = 1400 ms. Synthetic speakers of 3 to 5.5
 * syllables a second with breaths of 0.25 to 1.2 s read up to 900, under the limit. No quiet
 * threshold separates a speaker's long pauses from a turnaround under a hang: a pause of 1.4 to
 * 1.9 s reads 1100 to 1600, and a 1.5 s turnaround (a reply keyed at the hang's end) reads 1100 to
 * 1600 as well, so some of each fall on either side of any limit in that range. The limit sits at
 * the bottom of that overlap because the two errors cost differently: a long pause past L read as a
 * turnaround ends the hold, and the rest of that transmission is a second file when the sweep comes
 * back while it is still on air (a split file; the ID itself was heard from the catch to L, about
 * 26 s on a large plan), while a turnaround read as a pause holds the hop on into the reply, up to
 * `hold.maxHoldMs` with nobody new heard, and other hops' IDs are lost. Arithmetic: judged audio
 * runs 1000 ms behind the air and a voiced window ends up to 500 ms after the last word; the first
 * leaving reading, 1100 at most, and the 250 ms re-check: past L the hold falls back at most
 * 1000 + 500 + 1100 + 250 = 2850 ms after the last word (before L, 2 s of quiet: 3750 ms), or at
 * the re-check after the reply's first voiced window.
 */
export const VOICE_QUIET_PAST_L_MS = 1_000

/**
 * How far past its held track's occupied band (centre ± obw / 2) a voiced session's `targetHz` may
 * sit and still be that track's transmission (heldVoiceOf): 3000 Hz. The session hears ±8 kHz
 * around `targetHz` (the recorder's CHANNEL_CUTOFF_HZ) and an NFM voice deviates up to ±5 kHz, so a
 * voice it still hears has its centre within 8000 − 5000 = 3000 Hz of `targetHz`. A 12 kHz voice
 * track then names sessions within 6000 + 3000 = 9000 Hz of its centre: never one on the next
 * 12.5 kHz channel, nor one 25 kHz away unless the track reads over 2 × (25 000 − 3000) = 44 kHz.
 */
export const HELD_VOICE_TOLERANCE_HZ = 3_000

/**
 * Least half-band a held track is matched with (heldVoiceOf), whatever its occupied bandwidth
 * reads: 2000 Hz. The recorder joins a track to a session whose `targetHz` lies within
 * WIDEBAND_JOIN_TOLERANCE_HZ (5000 Hz) of the track's centre, so a narrow track (obw under
 * 4 kHz, e.g. a voice read early or a weak one) may be recorded by a session up to 5000 Hz off it;
 * 5000 − HELD_VOICE_TOLERANCE_HZ = 2000 Hz makes the reach of any track at least that join
 * tolerance (2000 + 3000 = 5000 Hz), while a narrow track still names nothing on the next 12.5 kHz
 * channel (5000 < 12 500).
 */
export const HELD_VOICE_FLOOR_HZ = 2_000

/**
 * The voiced transmission of the held track's band (`centreHz` ± max(`obwHz` / 2,
 * HELD_VOICE_FLOOR_HZ), plus HELD_VOICE_TOLERANCE_HZ) among a voice answer and the transmissions it
 * lists; of several there (a wide merged track, 19 kHz or more, reaches the next 12.5 kHz channel),
 * the one closest to the track's centre (the answer's own first on a tie, then the list's order);
 * null when none lies there. The recorder names the first voiced session of the window (an older
 * one first), so a neighbour voiced at a follow's landing is named before the held one: a hold
 * names the transmission on its own frequency, never the window's first. Unknown or malformed (a
 * non-finite frequency or band, a negative width, an entry that is not voice): no match, so a
 * neighbour is never adopted for want of a frequency.
 */
export function heldVoiceOf(
	answer: VoiceOnAir,
	band: { readonly centreHz: number; readonly obwHz: number },
): VoiceOnAir | null {
	let best: VoiceOnAir | null = null
	let bestOff = Infinity
	const consider = (a: VoiceOnAir): void => {
		if (typeof a.voice !== "string") return
		const off = heldBandOffset(a.targetHz, band)
		if (off !== null && off < bestOff) {
			best = a
			bestOff = off
		}
	}
	consider(answer)
	for (const entry of Object.values(answer.transmissions ?? {}))
		if (typeof entry === "object" && entry !== null) consider(entry)
	return best
}

/**
 * How far (Hz) a session's `targetHz` lies from the held track's centre when it lies in that
 * track's band (`centreHz` ± max(`obwHz` / 2, HELD_VOICE_FLOOR_HZ), plus HELD_VOICE_TOLERANCE_HZ),
 * else null: what heldVoiceOf names a transmission by, and what tells a recorder's `voiceEnded`
 * (RecordedSession.targetHz) of the held track from a neighbour's (askRecording). Unknown or
 * malformed (a frequency that is absent or not finite, a non-finite band or a negative width): null,
 * never a match.
 */
export function heldBandOffset(
	hz: number | undefined,
	band: { readonly centreHz: number; readonly obwHz: number },
): number | null {
	if (
		typeof hz !== "number" ||
		!Number.isFinite(hz) ||
		!Number.isFinite(band.centreHz) ||
		!Number.isFinite(band.obwHz) ||
		band.obwHz < 0
	)
		return null
	const reach =
		Math.max(band.obwHz / 2, HELD_VOICE_FLOOR_HZ) + HELD_VOICE_TOLERANCE_HZ
	const off = Math.abs(hz - band.centreHz)
	return off <= reach ? off : null
}

/**
 * Centres this far apart or more are never one signal read as two tracks (bandsOverlap): 10 000 Hz,
 * a 12.5 kHz raster step less a fifth of it (2500 Hz) for the error of the two centres' readings.
 * Tracks on adjacent 12.5 kHz channels read about 12 500 Hz apart, so their bands never count as
 * joined however wide they read (a 16 kHz ID and an 11 kHz neighbour a step apart overlap by
 * 8000 + 5500 − 12 500 = 1000 Hz); a voice whose merged track took in a line beside it reads 9800 Hz
 * from the line (the joined-line case) and is joined.
 */
export const JOINED_TRACKS_BELOW_HZ = 10_000

/**
 * Whether two tracks read as one signal's (a voice whose track took in a line beside it): their
 * occupied bands (`centreHz` ± `obwHz` / 2) overlap or touch, the distance between their centres
 * at most the sum of their half widths, and their centres lie under JOINED_TRACKS_BELOW_HZ
 * (10 000 Hz) apart, so tracks one 12.5 kHz raster step apart are never joined. A 16 kHz voice track
 * whose centre lies 9800 Hz from a 7 kHz line's is joined (8000 + 3500 = 11 500 Hz ≥ 9800 Hz, and
 * 9800 < 10 000). Two 11 kHz tracks 12.5 kHz apart are not (5500 + 5500 = 11 000 Hz < 12 500 Hz),
 * nor a 16 kHz and an 11 kHz track 12.5 kHz apart (bands overlapping, 12 500 ≥ 10 000). Non-finite
 * centres or widths, or a negative width: false.
 */
export function bandsOverlap(
	a: { readonly centreHz: number; readonly obwHz: number },
	b: { readonly centreHz: number; readonly obwHz: number },
): boolean {
	if (
		!Number.isFinite(a.centreHz) ||
		!Number.isFinite(a.obwHz) ||
		!Number.isFinite(b.centreHz) ||
		!Number.isFinite(b.obwHz) ||
		a.obwHz < 0 ||
		b.obwHz < 0
	)
		return false
	const apart = Math.abs(a.centreHz - b.centreHz)
	return apart < JOINED_TRACKS_BELOW_HZ && apart <= a.obwHz / 2 + b.obwHz / 2
}

/** The visit's voice commitment (Visit.voiceTrackId) is dropped, firm or tentative. */
function releaseCommitment(v: {
	voiceTrackId: string | null
	voiceTrackVoiced: boolean
	voiceTentative: boolean
}): void {
	v.voiceTrackId = null
	v.voiceTrackVoiced = false
	v.voiceTentative = false
}

/** Whether a recording check answered voice on air (RecordingActivity). */
export function isVoiceOnAir(a: RecordingActivity): a is VoiceOnAir {
	return typeof a === "object" && "voice" in a
}
/**
 * Retry budget of a frequency with carrier evidence: after a hold of d ms it rests K × d × f ms,
 * f spread over [0.5, 1.5) (spread) so retries do not lock to the period of regular overs, with K
 * RETRY_REST_FACTOR (2), KNOWN_CALL_REST_FACTOR (1) for a frequency known as a call, and
 * FLAP_REST_FACTOR (20) for a carrier that flapped (flapPairMs). At most one carrier hold runs
 * per coarse sweep (retryLock), and it spends the follow budget (followBudgetMs). On average a
 * carrier takes d / (d + K × d) of the time: 1/3, 1/2 for a known call, and 1/21 when it flapped.
 *
 * Why 2: a QSO already on air when the job starts can show carrier evidence (an over heard for
 * CARRIER_WATCH_MS without a break). It is traffic again only once a hold hears a turnaround, which
 * a hold of d ms catches with a chance of about d / P for overs of period P, so turnarounds are
 * found at a rate of about (carrier time share) / P whatever d is. 45 s overs with 1 s gaps
 * (P = 46 s) are found in about 46 / (1/3) = 138 s on average; then the QSO is followed as
 * traffic for most of the rest. With K = 5 (1/6 of the time) it takes about 276 s, longer than
 * the QSO is heard by one confirm probe per visit. A flap never comes from a QSO (a turnaround
 * reads 1 s or more), so a flapping carrier rests ten times longer.
 */
const RETRY_REST_FACTOR = 2
const FLAP_REST_FACTOR = 20
/**
 * Rest factor of a carrier that was traffic before, or whose onset a visit saw: a tail-bridged
 * repeater (a minute or more on air without a break, then a turnaround and an ID) is no steady
 * carrier, so it takes half of the time instead of a third.
 */
const KNOWN_CALL_REST_FACTOR = 1

/**
 * Confirm window a visit always allows, however short its coarse sweep: the longest built-in class
 * confirm hold (10 000 ms, `ook-burst`) plus 2 000 ms of decoder start latency the job runner adds
 * to it. A confirm hold starting within a visit's first coarse sweep may run CONFIRM_FLOOR_MS +
 * probe start, never past `hold.maxHoldMs` (see confirmEnd): a two-hop plan of 185 ms dwells (a
 * 370 ms sweep) still confirms a 10 s burst class, and a 60 s operator confirm hold is cut to
 * 12 000 + probe start.
 */
export const CONFIRM_FLOOR_MS = 12_000

/**
 * What the holds have shown about a frequency. Evidence is per frequency (shared by every hop whose
 * span holds it, and kept across re-plans), and kept while visits keep hearing it.
 *
 * - `unknown`: held like any signal, on every visit, and watched at most CARRIER_WATCH_MS from
 *   the start of the hold, after its probe if it has one. On air without a break that long, it is a
 *   carrier, unless a full visit of the hop missed it before it appeared (onsetSeen: it may be a
 *   call longer than a watch). Then every hop gets a coarse visit (watchAfter), the next hold of
 *   analog voice follows it to CALL_RUN_MS of its run (a 28 s ID is heard to its end), later ones
 *   watch it again, and it is a carrier once its run lasts `hold.maxHoldMs`.
 * - `traffic`: a gap of TRAFFIC_GAP_MS or more was heard on it (a close and a reopen, a close and
 *   the end of the visit, a late open, or a visit that listened that long without it), or a decoder
 *   confirmed it. Held on every visit; voice followed to `hold.maxHoldMs`.
 * - `carrier`: positive carrier evidence. A hold heard it on air without a break for
 *   CARRIER_WATCH_MS (a traffic frequency: `hold.maxHoldMs`, with no decode), or heard it close and
 *   reopen less than TRAFFIC_GAP_MS apart (a flap). Held only when its retry budget has refilled
 *   (restUntil; not for a suspect one, missed by a full visit since), one carrier hold per coarse
 *   sweep, each at most one coarse sweep and at most CARRIER_WATCH_MS; a recording of it at most
 *   L and never the voice hold, unless it has verified voice history (FrequencyMemory.voiced). A
 *   dwell that misses one that
 *   never flapped while its retry is due listens on for a gap (listenForGap). Traffic evidence
 *   makes it traffic again.
 */
type Evidence = "unknown" | "traffic" | "carrier"

interface FrequencyMemory {
	centreHz: number
	halfWidthHz: number
	/** Insertion serial: of two entries a sighting matches, the older one is its frequency. */
	order: number
	evidence: Evidence
	/**
	 * It flapped (a close and reopen less than TRAFFIC_GAP_MS apart): it is no suspect and no dwell
	 * listens on for its gap.
	 */
	flaps: boolean
	/** FLAP_REST_FACTOR applies (flapPairMs: a second flap in time, or one flap of an emitter never known as a call). */
	flapRest: boolean
	/** Clock of the last flap heard since the last traffic evidence (flapPairMs). */
	flapAt: number | null
	/** Ms of visits of its hops (from the tune) ended since flapAt (noteFlapListening). */
	flapListenMs: number
	/** It was traffic at some time: KNOWN_CALL_REST_FACTOR applies when it is a carrier. */
	wasTraffic: boolean
	/**
	 * Verified voice history: the recorder recorded a classed, voiced session on it, in a file the
	 * store admitted (an answer naming it, VoiceOnAir.recordedHz, RecordedSession.recordedHz). It
	 * lifts the carrier cap on a recording of a voiced transmission only: the end of that
	 * transmission (RecordedSession.voiceEnded) still ends the hold and owes the coarse sweep. A
	 * decode on the frequency leaves it: the decode makes the frequency traffic (markTraffic), where
	 * no carrier cap applies, and a mixed analog and digital channel keeps its analog history.
	 * Carrier evidence never caps a frequency with it (recordedTrack): a repeater that earned carrier evidence (a kerchunk, a fade, its idle carrier)
	 * still has its ID recorded whole, on the first catch since too. Kept across visits and
	 * re-plans with the entry, and only with it: forgetting the frequency (FORGET_MISSES visits
	 * missing it, or eviction past MAX_FREQUENCY_MEMORY) clears its evidence and this together, so a
	 * frequency heard again is unknown with no history, and no carrier keeps an exemption it earned
	 * before an absence (the next verified session earns it again).
	 */
	voiced: boolean
	/** A full visit of a hop holding it missed it before this sighting: its onset was seen. */
	onsetSeen: boolean
	/** Retry budget of a carrier: not held again before this clock. */
	restUntil: number
	/**
	 * Carrier evidence from a hold that heard it on air without a break, but a full visit missed it
	 * since: it goes off air, so it is no steady carrier. Its retry budget does not apply (one
	 * carrier hold per coarse sweep still does), so a QSO of long overs taken for a carrier has its
	 * turnarounds heard soon. A flap or a heard gap settles it.
	 */
	suspect: boolean
	/**
	 * Clock of the first sighting of its current run on air: since then no close was heard and no
	 * full visit missed it (a frequency whose onset was seen is a carrier once this run lasts
	 * `hold.maxHoldMs`).
	 */
	runFrom: number
	/**
	 * A watch of it (its onset seen, not known) reached its cap with it on air: it is not held again
	 * before this many coarse visits ended, so every hop gets a coarse visit first (revisits too
	 * only dwell on it).
	 */
	watchAfter: number
	/** Visit (serial across the job) of the last sighting. */
	seenVisit: number
	/**
	 * Visit of the last sighting of a candidate on it that was real on air (onCandidate: as long and
	 * as strong as one that may qualify), though the channel gate did not answer in that visit, so
	 * that visit did not miss it (heardOn). It brings no evidence.
	 */
	candidateVisit: number
	/** Full visits in a row, of hops whose span holds it, that did not hear it. */
	misses: number
	/**
	 * Its last track closed with no other track of the visit on it: visit, block count and clock
	 * of the close, and the end of that track's last block on air. A sighting in the same block is
	 * a rollover of the same transmission.
	 */
	closedAt: {
		visit: number
		block: number
		at: number
		lastSample: number
	} | null
}

interface HopState {
	activityScore: number
	scoreAt: number | null
	lastVisit: number | null
	gainTenthsDb: number | null
	cleanVisits: number
	boost: boolean
	/** Full visits so far (minSurfaceBlocks + 1 blocks or more): each would have heard a frequency on air. */
	fullVisits: number
	/** Accounting (job progress, fairness tests): visits, ms from tune to leave, ms held. */
	visits: number
	timeMs: number
	holdMs: number
	/** Accounting only: ended visits' measured phases of `timeMs` (hopPhaseStats). */
	phases: PhaseTotals
	/**
	 * Ms this hop has waited since its last visit for other hops' visits that watched, held past one
	 * coarse sweep or spent the follow budget (Visit.watched, longFollow, budgeted): they share L
	 * (followBudgetMs), so no hop waits more than L for them between two of its visits.
	 */
	waitMs: number
	/**
	 * The hops (indices in the plan in force) that still owe a coarse visit before a voiced recording
	 * may keep this hop again: every other hop when a visit's voice hold ends (Visit.voice), or a
	 * visit leaves a voiced transmission its analog hold heard and could have held
	 * (Visit.heardVoiceId, heardVoiceHoldable; else revisitLock), so the
	 * sweep's return to this hop may hold the next transmission. No activity revisit comes back here
	 * meanwhile (pickRevisit). Per hop: a long hold elsewhere never takes a transmission's voice hold
	 * away. Named hops, not a count: a plan change has to know which of them were paid
	 * (carryVoiceLocks).
	 */
	voiceLock: HopBits
	/**
	 * The hops that still owe a coarse visit before an activity revisit may come back here
	 * (pickRevisit), with no bar on a voice hold: every other hop when a visit barred from a voice
	 * hold (Visit.heardVoiceHoldable false) leaves a voiced transmission it heard still on air. The
	 * hop's next coarse landing may hold that transmission, as it recorded none of it; a revisit
	 * would only give the hop more of a transmission's time before the sweep. Carried across a plan
	 * change as voiceLock is.
	 */
	revisitLock: HopBits
}

/** Measured ms per phase of a visit (or of a hop's ended visits). Never read by a decision. */
interface PhaseTotals {
	settleMs: number
	staleMs: number
	dwellMs: number
	qualifyMs: number
}

/**
 * Phase of a visit the accounting clock is in. `command`: a tune not answered yet (overhead). `hold`:
 * the visit's existing hold clock counts it (holdStartedAt, accountedHeldMs), this clock adds nothing.
 */
type PhaseKind = "command" | "settle" | "dwell" | "qualify" | "hold"

/**
 * Read-only accounting of one visit: which phase it is in since `at`, and the totals of its closed
 * phases. `heardMs` is the sample time of the blocks heard since `at`: a dwell or a qualification
 * counts only that, so wall time no block accounts for (a late or stalled stream) stays overhead.
 */
interface VisitClock extends PhaseTotals {
	kind: PhaseKind
	at: number
	heardMs: number
}

const emptyPhases = (): PhaseTotals => ({
	settleMs: 0,
	staleMs: 0,
	dwellMs: 0,
	qualifyMs: 0,
})

/** Adds the running phase of `c`, up to `at`, to `into` (`c` itself when the phase closes). */
function addRunningPhase(into: PhaseTotals, c: VisitClock, at: number): void {
	const wall = Math.max(0, at - c.at)
	if (c.kind === "settle") into.settleMs += wall
	else if (c.kind === "dwell") into.dwellMs += Math.min(wall, c.heardMs)
	else if (c.kind === "qualify") into.qualifyMs += Math.min(wall, c.heardMs)
}

function addPhases(into: PhaseTotals, from: PhaseTotals): void {
	into.settleMs += from.settleMs
	into.staleMs += from.staleMs
	into.dwellMs += from.dwellMs
	into.qualifyMs += from.qualifyMs
}

interface TrackInfo {
	snrDb: number
	centreHz: number
	obwHz: number
	needsConfirm: boolean
	confirmHoldMs: number
	/** Analog voice: a hold follows it while it stays on air (bounded by `hold.maxHoldMs`). */
	followOnAir: boolean
	/** Too young to be labelled, with the spectrum of analog voice (TrackHints.voiceLater). */
	voiceLater: boolean
	/** Truncated, image or spur: never held, no activity. */
	flagged: boolean
	open: boolean
	tried: boolean
	/** Blocks this track was open during the visit (activity). */
	openBlocks: number
	/** Blocks of the track (its age for the classifier). */
	ageBlocks: number
	/** The track was a candidate of this visit before its gate passed (awaitsClass). */
	qualified: boolean
	/** End of its last block on air, from its latest snapshot (the closing one at a close). */
	lastSample: number
}

/** Energy on the hop the channel gate has not answered yet (onCandidate): no observation yet. */
interface CandidateInfo {
	centreHz: number
	obwHz: number
	/** On-air blocks of the track when last sighted: under minSurfaceBlocks it may be noise. */
	blocks: number
	/** Visit block count (Visit.blocks) the track's age counts from. */
	onsetBlock: number
	/** The longest its gate can take to pass it, in blocks (qualifyBlocks). */
	answerBlocks: number
	/**
	 * Highest channel reading of its sightings in this epoch (channelReadingDb). The tracker publishes
	 * at blocks 1, 2, 5 and 20 only and the gate's hysteresis carries a run across a low block, so
	 * the last reading is no answer: only the gate's refusal, a close or the bound end a wait.
	 */
	levelDb: number
}

interface Visit {
	hopIndex: number
	revisit: boolean
	dwellEnd: number | null
	blocks: number
	overloaded: boolean
	tracks: Map<string, TrackInfo>
	/** Clock the holds of the current epoch started (null before any hold of it). */
	holdStartedAt: number | null
	/**
	 * Ms the visit held in its earlier epochs (restartVisit): its holds count from holdOrigin, so a
	 * restart keeps the hold budget spent before it (L, `hold.maxHoldMs`, one coarse sweep).
	 */
	heldBeforeMs: number
	/** Gain the visit was tuned with. A continued visit (no tune) needs the same gain. */
	gainTenthsDb: number | null
	/** Clock at the tune (or at the continue). */
	startedAt: number
	/** Serial of this visit across the job (FrequencyMemory.seenVisit). */
	serial: number
	/**
	 * `blocks` when the current epoch started. Listening (late opens) counts from it: before a
	 * restart (outage, preemption, resume) the visit heard nothing of what happened in between.
	 */
	epochBlock: number
	/** The dwell was lengthened once for a track too young to be labelled (CLASS_SETTLE_BLOCKS). */
	classWait: boolean
	/** The dwell was lengthened once to listen to a carrier's frequency it missed (listenForGap). */
	gapWait: boolean
	/** Energy the channel gate has not answered yet in this epoch of the visit (onCandidate). */
	candidates: Map<string, CandidateInfo>
	/** The dwell was lengthened for the gate's answer: at most once per epoch (qualify). */
	qualifyWait: boolean
	/** Blocks this epoch's answers (qualify, waitForClass) added to the dwell (extendForAnswer). */
	answerWaitBlocks: number
	/** A follow (not decoded), a watch or a recording hold of this visit was allowed past one coarse sweep (capFor). */
	longFollow: boolean
	/** A decoded follow of this visit was allowed past one coarse sweep (capFor). */
	longDecoded: boolean
	/** A hold of this visit spent the follow budget (FollowCap.budget, a recording hold). */
	budgeted: boolean
	/** A hold of this visit was a watch (FollowCap.watch): the other hops wait for it (HopState.waitMs). */
	watched: boolean
	/**
	 * Set when the visit kept its hop for a recording (keepForRecording): the end of the L budget
	 * that hold had, in ms from holdOrigin. Every later hold of the visit (a probe, a follow, a
	 * hang, another recording hold) ends by then too (maxHoldDeadline), so they share that window,
	 * across restarts too.
	 */
	recordEndMs: number | null
	/**
	 * Voice hold of the visit ("record whole voice"): "on" while a `record` hold runs with the
	 * voice cap (the recorder answered voice on air in the current transmission, VoiceOnAir);
	 * "spent" once an answer is not voice of that transmission (its squelch closed, a carrier or
	 * hang without voice followed it, or another transmission is voiced): a later voice answer of
	 * the visit counts as true (L only).
	 * Not "no" at the visit's end: every hop gets a coarse visit before the next long follow or
	 * recording hold (longHoldLock), so the next over of a QSO gets a voice hold only after it.
	 */
	voice: "no" | "on" | "spent"
	/** The voiced transmission the voice hold belongs to (VoiceOnAir.voice) while Visit.voice is "on". */
	voiceId: string | null
	/** Clock the recording check was last asked while Visit.voice was "on" (sampleVoice's pace only). */
	voiceAskedAt: number | null
	/**
	 * The voiced transmission (VoiceOnAir.voice) the recorder named while an analog hold that is
	 * not a voice hold ran (a probe, follow or hang of analog voice, sampleVoice): one transmission,
	 * then the sweep. Its end (the squelch closed, the recorder's `voiceEnded`, or voice named
	 * otherwise) spends the visit's voice hold as a voice hold's end does (askRecording), so a reply
	 * never gets a voice hold of its own before the forced coarse sweep. Kept for the visit: a visit
	 * that leaves with it still on air (a hold cut at L) owes the sweep too (endVisit, voiceLock),
	 * when the visit could have held it (Visit.heardVoiceHoldable); else only activity revisits
	 * wait for the sweep (HopState.revisitLock).
	 * Named only in the band the visit names voice by (voiceBandOf): with a commitment
	 * (Visit.voiceTrackId), the committed track's. A committed track that closed with no successor
	 * on its frequency (committedTrack: null) names nothing, so no transmission is heard meanwhile,
	 * not even the held track's own, until the committed track reopens or the commitment is dropped.
	 */
	heardVoiceId: string | null
	/**
	 * Whether a voice hold of the transmission named Visit.heardVoiceId was allowed while the
	 * recorder named it (mayHoldVoice): no voice lock on the hop, no revisit of the hop that set the
	 * long-hold lock, the voice hold not spent or barred, and a track the recording can be of
	 * (recordedTrack). A visit barred from that hold (the revisit right after a carrier watch of the
	 * hop, say) recorded nothing of the transmission and owes no sweep for it: the hop's next
	 * landing may hold it.
	 */
	heardVoiceHoldable: boolean
	/**
	 * The track the visit committed its voice to (voiceBandOf), null until then. Made
	 * (commitVoiceTrack) at the visit's first recording check answering voice on air in the window
	 * (an analog hold's check, askDuringFollow; the keep of the hop for its recording,
	 * keepForRecording; a `record` hold's re-check, recheckRecording), to the track whose band the
	 * hold named voice by then: the voice is its own or a neighbour's beside it (a closed track
	 * only for its own). A check answering no voice commits to nothing, so a first track that
	 * never voices is no commitment.
	 * Kept whatever track a later hold sits on: a `record` hold's re-check probes a neighbour that
	 * qualified meanwhile (nextCandidate), and that probe holds the neighbour's track, but the hop
	 * is still kept for the committed track's transmission. So a neighbour voiced while the
	 * committed track's transmission is not named yet (its session refused a slot, or not voiced
	 * yet) is never the visit's transmission, and its end never ends the committed track's hold.
	 * Kept too while the committed track is closed (a fade: its id survives a reopening, onTrack),
	 * naming nothing meanwhile (committedTrack), and moved to its successor on its frequency.
	 * Dropped only when the visit's voice hold is spent (spendVoice), the track is flagged (onTrack:
	 * sticky) or the visit's tracks are cleared (a new epoch).
	 * Tentative (voiceTentative) when it may still pass to the voice's own track.
	 */
	voiceTrackId: string | null
	/**
	 * A recording check named voice in the committed track's own band (heldVoiceOf) during this
	 * visit (or the commitment was made for its own voice): the commitment is firm from then on.
	 */
	voiceTrackVoiced: boolean
	/**
	 * The commitment, made for a neighbour's voice (not the committed track's own), may pass to that
	 * voice's own track (settleCommitment): its track is held (a probe, follow or hang, never a
	 * `record` hold) and a check names voice in its band while the committed track has never
	 * voiced in the visit. Set when the committed track is shown to be no voice of its own: its
	 * hold was a carrier watch (endHold: a watch of a frequency with carrier evidence and no
	 * verified voice, or of one not known, its onset unseen, on air without a break for
	 * CARRIER_WATCH_MS, the reading endHold takes for carrier evidence, voice on air aside), or the
	 * commitment was made at a re-check of the wait for a voice answer (judging), whose band was
	 * the window's, never a held track's. A commitment made during any other hold (a follow, probe
	 * or recording of voice that showed no carrier) is firm: the MJ-1 ID case, where the neighbour
	 * talks first and the ID voices only after the hold moved to the neighbour.
	 */
	voiceTentative: boolean
	/** Clock the recording check was last asked during an analog hold (sampleVoice's pace only). */
	followAskedAt: number | null
	/** The recording check answered anything but false during this visit: the recorder has a session. */
	sessionSeen: boolean
	/**
	 * An analog follow heard its track's squelch close while the recorder had no session to name
	 * the transmission (sessionSeen false): no voice hold for the rest of the visit, and the hop
	 * owes every other hop its coarse visit before its next voice hold (HopState.voiceLock), as
	 * after a voice hold. Unlike a voice hold it locks no long follow elsewhere (longHoldLock).
	 */
	voiceBarred: boolean
	/** The visit's one keep for a voice answer still to come (RecordingActivity "judging") was used. */
	judged: boolean
	/** A carrier on air since before any visit saw it start showed itself: the hop's past score was it. */
	newlyQuiet: boolean
	/** Read-only phase accounting (hopPhaseStats). */
	clock: VisitClock
}

/** Per-hop accounting: share of time, holds and the age of the last visit. */
export interface HopStat {
	hopIndex: number
	visits: number
	timeMs: number
	holdMs: number
	lastVisitAgeMs: number | null
}

/**
 * HopStat with the phases of `timeMs`, in whole ms. `measuredSettleMs + measuredStaleMs +
 * measuredDwellMs + measuredQualifyMs + holdMs + overheadMs === timeMs`: overhead is the rest, and
 * each measured phase is rounded down so it cannot go negative. "measured" sets them apart from the
 * planned `spec.settleMs`, `spec.dwellMs` and `plan.hops[i].dwellMs`.
 */
export interface HopPhaseStat extends HopStat {
	/** From the tune's answer to the first block of its epoch, that block's own length left out. */
	measuredSettleMs: number
	/** Blocks of the previous hop's IQ the engine discarded after settling (onStale). */
	measuredStaleMs: number
	/** Heard blocks of the dwell the plan asked for, at most the wall time they took. */
	measuredDwellMs: number
	/** Heard blocks past that dwell: a gate's or a class's answer, a carrier's gap (decide). */
	measuredQualifyMs: number
	/** The rest: tune command and action queue latency, a dwell's stream arriving late. */
	overheadMs: number
}

/** Options for one track update. */
export interface TrackHints {
	/** Analog voice (`analog-fm`, `analog-am`): follow it on air under `hold.policy: "hold"`. */
	followOnAir?: boolean
	/**
	 * Not analog voice yet only because it is too young to be labelled (a burst), while its
	 * spectrum reads as analog voice: the dwell may wait once for its label (CLASS_SETTLE_BLOCKS).
	 */
	voiceLater?: boolean
}

interface Hold {
	/** Held track; for a `record` hold the recorded track (recordedTrack), "" when none is open. */
	trackId: string
	/**
	 * `record`: the track whose band names its voice hold (voiceBandOf at the keep: the track the
	 * visit committed to, else the track held then, which may differ from `trackId`), "" when
	 * none. Its re-checks name voice by it.
	 */
	bandId?: string
	/**
	 * `record`: no probe and no follow; the hop is kept while the window is being recorded
	 * (recordingActive), re-checked every RECORD_RECHECK_MS, up to `cap` (keepForRecording).
	 */
	mode: "confirm" | "follow" | "hang" | "record"
	deadline: number
	/** Last clock a follow (and its hang and reopenings) may run to (see capFor). */
	cap: number
	/** The cap is a watch for carrier evidence (CARRIER_WATCH_MS), not a follow of traffic. */
	watch: boolean
	/** A decoder confirmed the held transmission (onConfirmed). */
	decoded: boolean
	/** Clock this hold of its frequency started (the retry budget charge). */
	from: number
	/** Start of the unbroken on-air run this hold heard (its start, or the last reopening). */
	runFrom: number
	/**
	 * `record` kept for a voice answer still to come ("judging", keepForRecording): the visit's
	 * Visit.recordEndMs before that wait, which set it to the wait's own end (3000 ms and a
	 * re-check). A track that qualifies meanwhile is held under the bounds it had without the wait
	 * (recheckRecording), not under the wait's: the wait keeps the hop longer, it never shortens
	 * another hold.
	 */
	beforeJudging?: number | null
}

type Phase = "idle" | "tuning" | "dwell" | "hold"

/**
 * A follow's bound (capFor): its last clock, whether it is a watch, whether it is a long follow,
 * and whether it spends the follow budget (followBudgetMs: voice on traffic).
 */
interface FollowCap {
	cap: number
	watch: boolean
	long: boolean
	budget?: boolean
}

interface Candidate {
	id: string
	t: TrackInfo
	kind: "confirm" | "follow"
}

/** This snapshot's channel reading; a track the gate cannot measure reads as −Infinity. */
function channelReadingDb(track: TrackSnapshot): number {
	const snr = track.channelSnrDb
	return snr !== undefined && Number.isFinite(snr)
		? snr
		: Number.NEGATIVE_INFINITY
}

/** Whether `outer` holds all of `inner`. */
function spanHolds(outer: Hop["covered"], inner: Hop["covered"]): boolean {
	return outer.startHz <= inner.startHz && inner.endHz <= outer.endHz
}

/**
 * Whether two hops are the same window for a voice lock: they share more than half of the narrower
 * span. Neighbouring hops overlap by a sliver and are not; the parts of a split hop, a wider hop over
 * it and a small shift of its centre are.
 */
function spansShare(a: Hop["covered"], b: Hop["covered"]): boolean {
	const shared = Math.min(a.endHz, b.endHz) - Math.max(a.startHz, b.startHz)
	const narrower = Math.min(a.endHz - a.startHz, b.endHz - b.startHz)
	return shared > narrower / 2
}

/**
 * The hop of `plan` nearest a frequency, the lowest hop index among the nearest: sorted centres and a
 * binary search. A re-plan makes one lookup per hop, so it costs (old + new) × log2(old) comparisons,
 * not old × new.
 */
export function nearestHopIn(plan: HopPlan): (centreHz: number) => number {
	const sorted = plan.hops
		.map((hop, i) => ({ hz: hop.centreHz, i }))
		.sort((a, b) => a.hz - b.hz || a.i - b.i)
	const centres = sorted.filter((c, at) => c.hz !== sorted[at - 1]?.hz)
	return centreHz => {
		let lo = 0
		let hi = centres.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if ((centres[mid]?.hz ?? Number.POSITIVE_INFINITY) < centreHz)
				lo = mid + 1
			else hi = mid
		}
		const above = centres[lo]
		const below = centres[lo - 1]
		if (below === undefined) return above?.i ?? 0
		if (above === undefined) return below.i
		const toBelow = centreHz - below.hz
		const toAbove = above.hz - centreHz
		if (toBelow !== toAbove) return toBelow < toAbove ? below.i : above.i
		return Math.min(below.i, above.i)
	}
}

function bitsSet(word: number): number {
	let w = word - ((word >>> 1) & 0x55555555)
	w = (w & 0x33333333) + ((w >>> 2) & 0x33333333)
	return Math.imul((w + (w >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24
}

/**
 * The hops a voice lock still owes: one bit per hop index of the plan in force. On N hops a lock is
 * ceil(N / 32) words, so 1,025 hops all locked take 1,025 × 33 × 4 B = 135 KB, and adding a lock to
 * another is ceil(N / 32) word operations where a Set takes one insert per hop.
 */
export class HopBits {
	private count = 0

	constructor(private readonly words: Uint32Array) {
		for (const word of words) this.count += bitsSet(word)
	}

	/** Every hop of a plan of `hopCount` hops but `hopIndex`. */
	static allBut(hopCount: number, hopIndex: number): HopBits {
		const words = new Uint32Array(Math.ceil(hopCount / 32))
		words.fill(0xffffffff)
		if (hopCount % 32 !== 0) words[words.length - 1] = 2 ** (hopCount % 32) - 1
		const bits = new HopBits(words)
		bits.delete(hopIndex)
		return bits
	}

	get size(): number {
		return this.count
	}

	has(hopIndex: number): boolean {
		return (((this.words[hopIndex >>> 5] ?? 0) >>> hopIndex) & 1) === 1
	}

	delete(hopIndex: number): void {
		if (!this.has(hopIndex)) return
		const at = hopIndex >>> 5
		this.words[at] = (this.words[at] ?? 0) & ~(1 << hopIndex)
		this.count--
	}
}

/** Nothing owed; shared by every hop without a lock, since a lock is only ever replaced or shrunk. */
const NO_HOPS = new HopBits(new Uint32Array(0))

/**
 * Carries what the voice holds still owe into a new plan. A new hop is locked when it takes over a
 * locked old hop's window (spansShare; several can, after a split, and it can be one nearestHopIn
 * mapped to another old hop). It owes every other new hop, except one whose whole span a paid old hop
 * covered: that span was heard since the hold ended. Whatever the new plan added, or the locked hop's
 * own window under a new centre, is owed, so one coarse sweep of the new plan pays it all: the coarse
 * order reaches every other hop within one cycle, and a locked hop's visit pays its sibling's lock
 * like any other. A locked old hop whose window the new plan drops leaves no lock. An unchanged plan
 * whose hops neither hold nor share each other's windows keeps its locks as they are, the same
 * objects: this rule gives exactly them.
 *
 * Cost, on a re-plan only and only when a lock is outstanding, for N old hops, M new hops and L
 * locked old hops. Both plans are sorted by start and swept once: (N + M) log2(N + M) comparisons,
 * then P tests of overlapping pairs. All hops of a plan have one width (hop-planner) and it advances
 * by at least that width less the widest channel, so a new hop meets a few old hops, not N: at most
 * 4 on a tiled plan, itself, its neighbours and the one it drops. P is N × M only if every old span
 * overlaps every new one. Then, per lock with an heir, one read per new hop and per old hop holding
 * it, and ceil(M / 32) word operations per heir: L × (M + holders) + L × heirs × ceil(M / 32). On
 * 1,025 tiled hops all locked and new hops of half the width on the same centres (one holder, one
 * heir): 4 × 1,025 + 1,024 × (2 × 1,025 + 33) = 2.1 M operations on typed arrays and 135 KB, against
 * 1,025 × 1,025 span tests and up to 1,024 × 1,024 Set inserts when each lock was a Set. An unchanged
 * plan stops after the sweep.
 * `ops` counts the pairs tested, bit reads and word operations.
 */
export function carryVoiceLocks(
	oldSpans: readonly Hop["covered"][],
	oldLocks: readonly HopBits[],
	nextSpans: readonly Hop["covered"][],
): { locks: HopBits[]; ops: number } {
	if (oldLocks.every(lock => lock.size === 0))
		return { locks: nextSpans.map(() => NO_HOPS), ops: 0 }
	const byStart = (spans: readonly Hop["covered"][]) =>
		spans
			.map((span, i) => ({ span, i }))
			.sort((a, b) => a.span.startHz - b.span.startHz)
	const olds = byStart(oldSpans)
	/** Per new hop, the old hops that hold its whole span. */
	const holders: number[][] = nextSpans.map(() => [])
	/** Per old hop, the new hops over its window. */
	const heirs: number[][] = oldSpans.map(() => [])
	let ops = 0
	let admitted = 0
	const active: typeof olds = []
	for (const { span, i: k } of byStart(nextSpans)) {
		for (
			let o = olds[admitted];
			o !== undefined && o.span.startHz <= span.endHz;
			o = olds[++admitted]
		)
			active.push(o)
		let kept = 0
		for (const o of active) {
			ops++
			// Past this hop's start: past every later hop's too.
			if (o.span.endHz < span.startHz) continue
			active[kept++] = o
			if (spanHolds(o.span, span)) holders[k]?.push(o.i)
			if (spansShare(span, o.span)) heirs[o.i]?.push(k)
		}
		active.length = kept
	}
	const onlyItself = (found: readonly number[], i: number): boolean =>
		found.length === 1 && found[0] === i
	if (
		oldSpans.length === nextSpans.length &&
		oldSpans.every((span, i) => {
			const next = nextSpans[i]
			return next?.startHz === span.startHz && next.endHz === span.endHz
		}) &&
		holders.every(onlyItself) &&
		heirs.every(onlyItself)
	)
		return { locks: [...oldLocks], ops }
	const wordCount = Math.ceil(nextSpans.length / 32)
	const owed = new Uint32Array(wordCount)
	const carried = new Map<number, Uint32Array>()
	for (const [l, lock] of oldLocks.entries()) {
		const heirsOfLock = heirs[l] ?? []
		if (lock.size === 0 || heirsOfLock.length === 0) continue
		owed.fill(0)
		for (let k = 0; k < holders.length; k++) {
			const found = holders[k] ?? []
			let paid = false
			ops++
			for (let at = 0; at < found.length && !paid; at++) {
				const i = found[at] ?? l
				paid = i !== l && !lock.has(i)
				ops++
			}
			if (!paid) owed[k >>> 5] = (owed[k >>> 5] ?? 0) | (1 << k)
		}
		for (const j of heirsOfLock) {
			let words = carried.get(j)
			if (words === undefined) {
				words = new Uint32Array(wordCount)
				carried.set(j, words)
			}
			for (let w = 0; w < wordCount; w++)
				words[w] = (words[w] ?? 0) | (owed[w] ?? 0)
			ops += wordCount
		}
	}
	return {
		locks: nextSpans.map((_, j) => {
			const words = carried.get(j)
			if (words === undefined) return NO_HOPS
			const lock = new HopBits(words)
			lock.delete(j)
			return lock
		}),
		ops,
	}
}

/**
 * Deterministic value in [0, 1) from an integer (a 32-bit integer hash). Spreads carrier retries
 * so their start does not lock to the period of a QSO whose overs keep the same length.
 */
function spread(n: number): number {
	let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
	h ^= h >>> 13
	h = Math.imul(h, 0xc2b2ae35)
	h ^= h >>> 16
	return (h >>> 0) / 2 ** 32
}

function sameFrequency(
	a: { centreHz: number; halfWidthHz: number },
	centreHz: number,
	halfWidthHz: number,
): boolean {
	return Math.abs(a.centreHz - centreHz) <= Math.max(a.halfWidthHz, halfWidthHz)
}

export class SweepScheduler {
	private plan: HopPlan
	private spec: NormalisedJobSpec
	private blockSamples: number
	private sampleRateHz: number
	private readonly now: () => number
	private readonly probeStartMs: number
	private readonly minSurfaceBlocks: number
	private readonly activitySeed: ((hop: Hop) => number) | undefined
	private readonly recordingActive: (() => RecordingActivity) | undefined
	private hops: HopState[]
	private pendingReplan: { plan: HopPlan; spec: NormalisedJobSpec } | null =
		null
	private phase: Phase = "idle"
	private visit: Visit | null = null
	private hold: Hold | null = null
	/** Current coarse hop while on a coarse visit; the next coarse hop otherwise. */
	private coarseIndex = 0
	private coarseSinceRevisit = 0
	private sweepIndex = 0
	private sweepStartedAt = 0
	private sweepPeriodMs: number | null = null
	private visited = new Set<number>()
	private lastCoverage: number | null = null
	/** True once a one-hop plan's first visit has settled (R 1.1). */
	private parkedVisit = false
	/** Received samples toward the next parked sweep; gaps contribute at most one block. */
	private parkedSweepSamples = 0
	/** End sample of the last block seen on the current stream; continued visits dwell from it. */
	private lastBlockEnd: number | null = null
	/**
	 * Clock of the last block or tick the scheduler received. A restart counts the holds of the old
	 * epoch up to here (restartVisit). A pause stops both (the job runner drives neither while
	 * paused), so a pause is never counted. During a source outage the service still ticks, so the
	 * outage is counted as hold time: the other hops wait less, never more.
	 */
	private heardAt: number | null = null
	/**
	 * Coarse visits still to end before another follow may outlast one coarse sweep: after such a
	 * long hold every hop gets its dwell first (set to the hop count, one less per coarse visit).
	 */
	private longHoldLock = 0
	/**
	 * The last askRecording answer showed the voiced transmission ended with another on air (the
	 * recorder's `voiceEnded`, or voice named otherwise than Visit.heardVoiceId): an analog hold
	 * that is no voice hold ends at once (askDuringFollow).
	 */
	private askEnded = false
	/**
	 * A track close whose recording check waits for the next block (onBlock): the tracker reports a
	 * max-duration rollover as a close and its successor's open in the same block, both before the
	 * block's summary, and the recorder names the transmission again only once the successor opened.
	 * Asked at the close itself, the check would read the rollover as the transmission's end. A
	 * squelch close is seen one block later than at the close, and a tick asks it if no block came
	 * within one block's time. Null: none.
	 */
	private closeAsk: { visit: Visit; trackId: string; at: number } | null = null
	/**
	 * Hop whose long hold set the long-hold lock. While the lock holds, voice on traffic there is
	 * probed, not followed (capFor): a busy hop is visited again before the lock clears (its own
	 * coarse visit, and revisits), and a follow of one coarse sweep on each of those visits (8050
	 * ms on 7 hops of 1150 ms) would keep the other hops waiting past a 28 s ID after the follow.
	 * Nor does an activity revisit of it meanwhile keep it for voice (keepForRecording): the voice
	 * hold would come before the others had their coarse visit.
	 */
	private lockHop: number | null = null
	/**
	 * Coarse visits still to end before another carrier hold: at most one per coarse sweep (set to
	 * the hop count when one starts, one less per coarse visit).
	 */
	private retryLock = 0
	/** Coarse visits ended so far (FrequencyMemory.watchAfter). */
	private coarseVisits = 0
	/** Frequency memory of the job, by frequency (FrequencyMemory). */
	private memory: FrequencyMemory[] = []
	/** The memory by MEMORY_BIN_HZ bin of its centre (memoryAt). */
	private memoryBins = new Map<number, FrequencyMemory[]>()
	/** Widest half width any entry ever had: the reach of a lookup beyond its own tolerance. */
	private memoryReachHz = SAME_FREQUENCY_FLOOR_HZ
	private memoryOrder = 0
	/** Entries compared by memory lookups so far (accounting: memoryComparisons). */
	private memoryOps = 0
	/** Visits so far, across hops (Visit.serial). */
	private visitSerial = 0

	constructor(
		plan: HopPlan,
		spec: NormalisedJobSpec,
		opts: {
			blockSamples: number
			sampleRateHz: number
			now: () => number
			probeStartMs: number
			minSurfaceBlocks?: number
			activitySeed?: (hop: Hop) => number
			/**
			 * True (or VoiceOnAir) while the window the scheduler is tuned to is being recorded (the
			 * job runner's `recordingActive` dependency): an unforced leave keeps the hop instead
			 * (Hold mode `record`, keepForRecording; RecordingActivity). Absent: never.
			 */
			recordingActive?: () => RecordingActivity
		},
	) {
		if (plan.hops.length === 0)
			throw new WaveKitError(
				"A sweep needs at least one hop",
				"SCANNER_EMPTY_PLAN",
			)
		this.plan = plan
		this.spec = spec
		this.blockSamples = opts.blockSamples
		this.sampleRateHz = opts.sampleRateHz
		this.now = opts.now
		this.probeStartMs = opts.probeStartMs
		this.minSurfaceBlocks = opts.minSurfaceBlocks ?? 2
		this.activitySeed = opts.activitySeed
		this.recordingActive = opts.recordingActive
		this.hops = plan.hops.map(hop => this.freshHop(hop))
	}

	/** One-hop plan whose first visit has settled. Stays true across same-centre replans. */
	get parked(): boolean {
		return this.parkedVisit
	}

	start(): SchedulerAction[] {
		if (this.phase !== "idle") return []
		this.sweepStartedAt = this.now()
		this.coarseIndex = 0
		return this.tuneTo(0, false)
	}

	/**
	 * A new own epoch started at `startSample` (the first settled sample of the current hop). In
	 * `tuning` this opens the dwell; in `dwell`/`hold` the hop was re-sent (source-up,
	 * preemptor-idle, resume) and the visit restarts (see restartVisit).
	 */
	onEpochStarted(startSample: number): SchedulerAction[] {
		return this.restartVisit(startSample)
	}

	/**
	 * Restarts the current visit from `startSample`: `dwellEnd = startSample + dwell`, the visit's
	 * tracks are dropped (they belong to the old epoch) and any hold ends with `stop-probes`. A new
	 * stream restarts sample indices at 0 and a resumed stream has run past the old `dwellEnd`, so
	 * the old absolute `dwellEnd` is meaningless either way (§ 10.2 dwell in samples). Task 35's
	 * `resendHop` retunes; the re-sent hop's own epoch reaches this through `onEpochStarted` with its
	 * start sample. No-op while idle.
	 */
	restartVisit(startSample: number): SchedulerAction[] {
		const v = this.visit
		if (v === null || this.phase === "idle") return []
		// The epoch opened before the tune's answer (a timer-settled epoch can): the two cannot be
		// told apart, and the engine was settling, so it all counts as settle. Settle runs on until the
		// first block: a timer-settled epoch is announced ahead of its first settled sample (onBlock).
		if (v.clock.kind === "command") v.clock.kind = "settle"
		this.enterPhase(v, "settle")
		const heldAtRestart = this.heldAccountingFloorMs
		const actions: SchedulerAction[] =
			this.phase === "hold" ? [{ type: "stop-probes" }] : []
		this.endHold(false)
		this.lastBlockEnd = startSample
		v.dwellEnd = startSample + this.dwellSamples(this.parkedVisit)
		v.tracks.clear()
		releaseCommitment(v)
		// A new epoch: the gate starts over and what it heard is gone, so it may be waited for again.
		v.candidates.clear()
		v.qualifyWait = false
		v.classWait = false
		v.answerWaitBlocks = 0
		this.forgetGapEvidence(v)
		// The holds already run still count (holdOrigin): a restart is no fresh budget. They ran
		// until the last block or tick heard (heardAt), not until now: a pause before the restart
		// (no blocks, no ticks) spends no hold time. An outage is ticked, so it is counted (the
		// safe direction: the other hops wait less).
		if (v.holdStartedAt !== null)
			v.heldBeforeMs += Math.max(
				0,
				Math.min(this.now(), this.heardAt ?? v.holdStartedAt) - v.holdStartedAt,
			)
		v.holdStartedAt = null
		// Scheduling budgets use the last received tick; cost statistics keep exactly what was held
		// when the pause began: not less (a pause between ticks, heldBeforeMs short of it), and not
		// more (a tick during or after the pause, heldBeforeMs counting paused time that timeMs
		// leaves out, so the phases would sum past timeMs).
		this.heldAccountingFloorMs = null
		if (heldAtRestart !== null)
			this.heldAccountingOffsetMs +=
				heldAtRestart - this.accountedHeldMs(v, this.now())
		this.phase = "dwell"
		// A re-sent window starts fresh: time without data is no dwell.
		this.parkedSweepSamples = 0
		this.parkIfOneHop()
		return actions
	}

	/**
	 * Nothing was heard between the old epoch and the new one: a close heard on this visit before
	 * it is no off-air gap (the frequency may have come back at once), and late opens count
	 * listening from the new epoch only.
	 */
	private forgetGapEvidence(v: Visit): void {
		v.epochBlock = v.blocks
		for (const m of this.memory)
			if (m.closedAt !== null && m.closedAt.visit === v.serial)
				m.closedAt = null
	}

	/**
	 * A skipped tune has no new epoch. Restart even during dwell/hold, anchoring the resumed
	 * dwell to the next received block because the stream may have advanced while paused.
	 */
	onTuneSkipped(): SchedulerAction[] {
		this.parkedSweepSamples = 0
		const actions = this.restartVisit(0)
		this.lastBlockEnd = null
		if (this.visit !== null && this.phase !== "idle") this.visit.dwellEnd = null
		return actions
	}

	onBlock(endSample: number): SchedulerAction[] {
		const left = this.runCloseAsk(this.now())
		if (left !== null) return left
		const v = this.visit
		if (v === null || (this.phase !== "dwell" && this.phase !== "hold"))
			return []
		const samples = Math.max(
			0,
			Math.min(
				this.blockSamples,
				endSample - (this.lastBlockEnd ?? endSample - this.blockSamples),
			),
		)
		this.noteHeard(v, samples)
		if (v.dwellEnd === null)
			v.dwellEnd = endSample - samples + this.dwellSamples(true)
		this.lastBlockEnd = endSample
		this.heardAt = this.now()
		const actions: SchedulerAction[] = []
		if (this.parkedVisit) {
			this.parkedSweepSamples += samples
			const dwell = (this.currentDwellMs() * this.sampleRateHz) / 1000
			if (dwell > 0) {
				const due = Math.floor(this.parkedSweepSamples / dwell)
				this.parkedSweepSamples -= due * dwell
				for (let i = 0; i < due; i++)
					actions.push({
						type: "sweep-complete",
						sweepIndex: this.sweepIndex++,
					})
			}
		}
		v.blocks++
		for (const t of v.tracks.values()) if (t.open) t.openBlocks++
		if (this.phase === "dwell" && v.dwellEnd !== null) {
			// Every answer the visit waits for came early: the wait ends with this block.
			if (endSample < v.dwellEnd && this.waitAnswered(v)) v.dwellEnd = endSample
			if (endSample >= v.dwellEnd) return [...actions, ...this.decide()]
		}
		return actions
	}

	/**
	 * Blocks the current dwell still needs before the scheduler decides (the block that reaches the
	 * dwell end included); null outside an unparked dwell with a known dwell end. Simulation fast
	 * path (sweep-sim.ts), with onBlocks.
	 */
	dwellBlocksLeft(): number | null {
		const v = this.visit
		if (
			v === null ||
			this.phase !== "dwell" ||
			this.parkedVisit ||
			v.dwellEnd === null ||
			this.lastBlockEnd === null ||
			this.blockSamples <= 0
		)
			return null
		return Math.max(
			0,
			Math.ceil((v.dwellEnd - this.lastBlockEnd) / this.blockSamples),
		)
	}

	/**
	 * `count` consecutive blocks of `blockSamples` ending at `endSample` with no track event between
	 * them: the same as `count` onBlock calls, in one step when they all fall in an unparked dwell
	 * before its last block (the last one goes through onBlock).
	 */
	onBlocks(endSample: number, count: number): SchedulerAction[] {
		const v = this.visit
		const before = endSample - this.blockSamples
		if (
			count < 2 ||
			v === null ||
			this.phase !== "dwell" ||
			this.parkedVisit ||
			v.dwellEnd === null ||
			this.lastBlockEnd === null ||
			before >= v.dwellEnd
		) {
			const out: SchedulerAction[] = []
			for (let i = Math.max(1, count) - 1; i >= 0; i--)
				out.push(...this.onBlock(endSample - i * this.blockSamples))
			return out
		}
		v.blocks += count - 1
		v.clock.heardMs +=
			((count - 1) * this.blockSamples * 1000) / this.sampleRateHz
		for (const t of v.tracks.values()) if (t.open) t.openBlocks += count - 1
		this.lastBlockEnd = before
		return this.onBlock(endSample)
	}

	onStale(blocks: number): void {
		if (
			this.phase === "dwell" &&
			this.visit !== null &&
			this.visit.dwellEnd !== null
		) {
			this.visit.dwellEnd += blocks * this.blockSamples
			this.noteStale(this.visit, blocks)
		}
	}

	/**
	 * Accounting of a heard block: one addition per block, no allocation. The first block after a
	 * settle ends it: its own length is dwell, the wall time before that was settle.
	 */
	private noteHeard(v: Visit, samples: number): void {
		const c = v.clock
		const heardMs = (samples * 1000) / this.sampleRateHz
		if (c.kind !== "settle") {
			c.heardMs += heardMs
			return
		}
		const at = this.accountingPausedAt ?? this.now()
		const block = Math.min(heardMs, Math.max(0, at - c.at))
		this.closePhase(v, at)
		c.settleMs -= block
		c.at -= block
		c.heardMs = heardMs
		c.kind = "dwell"
	}

	/**
	 * Wall time since the discarded blocks' predecessor counts as stale IQ up to their length; a dwell
	 * keeps the blocks it heard before them, and the excess stays overhead (dwell) or settle.
	 */
	private noteStale(v: Visit, blocks: number): void {
		const c = v.clock
		if (c.kind !== "settle" && c.kind !== "dwell" && c.kind !== "qualify")
			return
		const at = this.accountingPausedAt ?? this.now()
		const wall = Math.max(0, at - c.at)
		const heard = c.kind === "settle" ? 0 : Math.min(wall, c.heardMs)
		const lengthMs = (blocks * this.blockSamples * 1000) / this.sampleRateHz
		const stale = Math.min(wall - heard, lengthMs)
		this.closePhase(v, at)
		if (c.kind === "settle") c.settleMs -= stale
		c.staleMs += stale
	}

	onTrack(
		track: TrackSnapshot,
		needsConfirm: boolean,
		confirmHoldMs: number,
		hints: TrackHints = {},
	): SchedulerAction[] {
		const v = this.visit
		if (v === null || (this.phase !== "dwell" && this.phase !== "hold"))
			return []
		// truncated, iqImage and spur are sticky and may first appear on a later track-update: never probed (§ 4.9)
		const flagged =
			track.flags.truncated || track.flags.iqImage || track.flags.spur
		const known = v.tracks.get(track.trackId)
		const qualified = v.candidates.delete(track.trackId)
		this.remember(v, track, known === undefined, flagged)
		const followOnAir = hints.followOnAir === true && !flagged
		const voiceLater = hints.voiceLater === true && !flagged
		if (known === undefined) {
			v.tracks.set(track.trackId, {
				snrDb: track.snrDb,
				centreHz: track.centreHz,
				obwHz: track.obwHz,
				needsConfirm: needsConfirm && !flagged,
				confirmHoldMs,
				followOnAir,
				voiceLater,
				flagged,
				open: true,
				tried: false,
				openBlocks: 0,
				ageBlocks: track.blocks,
				qualified,
				lastSample: track.lastSample,
			})
		} else {
			known.lastSample = track.lastSample
			known.snrDb = track.snrDb
			known.centreHz = track.centreHz
			known.obwHz = track.obwHz
			known.open = true
			if (flagged) known.needsConfirm = false
			else known.needsConfirm ||= needsConfirm
			known.followOnAir = followOnAir
			known.voiceLater = voiceLater
			known.flagged ||= flagged
			// A committed track flagged (truncated, an image or a spur: sticky) is released.
			if (known.flagged && v.voiceTrackId === track.trackId)
				releaseCommitment(v)
			known.ageBlocks = Math.max(known.ageBlocks, track.blocks)
			known.confirmHoldMs = Math.max(known.confirmHoldMs, confirmHoldMs)
			known.qualified ||= qualified
		}
		// the held track turned out truncated or an image: drop its probe and hold
		if (
			flagged &&
			this.phase === "hold" &&
			this.hold?.trackId === track.trackId &&
			this.hold.mode !== "record"
		)
			return this.afterProbe()
		this.followReopened(track.trackId)
		return []
	}

	/**
	 * Energy on the hop that the channel gate has not answered yet: it has no observation, so it is no
	 * track of the visit (onTrack), yet the visit should not end before its gate can answer. Brings
	 * no evidence, and marks its known frequency as on air only when it is as long and as strong as
	 * one that may qualify: a weaker sighting must not keep a carrier's memory or hide its gap.
	 * `gateMinDurationMs` is the longest its gate rule can take to pass it. Told on the track's open
	 * and updates (blocks 1, 2, 5, 20, ...).
	 */
	onCandidate(track: TrackSnapshot, gateMinDurationMs: number): void {
		const v = this.visit
		if (v === null || (this.phase !== "dwell" && this.phase !== "hold")) return
		if (track.flags.truncated || track.flags.iqImage || track.flags.spur) {
			v.candidates.delete(track.trackId)
			return
		}
		const onsetBlock = v.blocks - track.blocks + 1
		const was = v.candidates.get(track.trackId)
		const candidate: CandidateInfo = {
			centreHz: track.centreHz,
			obwHz: track.obwHz,
			blocks: track.blocks,
			onsetBlock: Math.min(was?.onsetBlock ?? onsetBlock, onsetBlock),
			answerBlocks: this.qualifyBlocks(gateMinDurationMs),
			levelDb: Math.max(
				was?.levelDb ?? Number.NEGATIVE_INFINITY,
				channelReadingDb(track),
			),
		}
		v.candidates.set(track.trackId, candidate)
		if (this.realOnAir(candidate)) {
			const known = this.memoryAt(track.centreHz, track.obwHz)
			if (known !== undefined) known.candidateVisit = v.serial
		}
	}

	/** A candidate closed without passing its gate: refused, the hop is released at once (onBlock). */
	onCandidateClosed(track: TrackSnapshot): void {
		this.visit?.candidates.delete(track.trackId)
	}

	/**
	 * Blocks from a track's first block until its qualification is answered: its gate's minimum
	 * duration or the class settle, whichever is later (both count from the track's first block),
	 * and QUALIFY_MARGIN_BLOCKS. 50 ms blocks: a 300 ms gate max(6, 5) + 2 = 8 blocks (400 ms), a
	 * 100 ms gate max(2, 5) + 2 = 7 blocks (350 ms).
	 */
	private qualifyBlocks(gateMinDurationMs: number): number {
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		return (
			Math.max(Math.ceil(gateMinDurationMs / blockMs), CLASS_SETTLE_BLOCKS) +
			QUALIFY_MARGIN_BLOCKS
		)
	}

	/**
	 * Real on air, as far as a candidate can tell: on air for minSurfaceBlocks blocks (a single block
	 * may be noise) and read at or over the lowest threshold a gate run can stay on at, in any
	 * sighting of this epoch. A track the gate cannot measure, or that never read that high, has no
	 * run to pass; this leaves out the noise and quantisation lines a hop shows (3 dB or less in
	 * their channel).
	 */
	private realOnAir(c: CandidateInfo): boolean {
		return c.blocks >= this.minSurfaceBlocks && c.levelDb >= CHANNEL_GATE_K_DB
	}

	/**
	 * Candidates the dwell may wait for: real on air (on a next visit a signal still on air is
	 * caught), on a frequency that may be held. A frequency with carrier evidence therefore qualifies
	 * only when its retry is due, as the sweep's one carrier hold (mayHoldFrequency). Nothing else is
	 * remembered against a frequency: a failed or unheld qualification costs its hop this wait again
	 * on its next visit, since any memory of it can skip a real call on that frequency.
	 */
	private mayQualify(c: CandidateInfo): boolean {
		if (!this.realOnAir(c)) return false
		const m = this.memoryAt(c.centreHz, c.obwHz)
		return m === undefined || this.mayHoldFrequency(m)
	}

	/**
	 * Lengthens the dwell for its candidates' gate answer: once per epoch, until the youngest of them
	 * could have had it (qualifyBlocks). The wait ends as soon as none is left to answer (onBlock).
	 * A candidate has at least minSurfaceBlocks blocks when the dwell ends, so the wait is at most
	 * 8 − 2 = 6 blocks (300 ms at 50 ms) per epoch, 5 blocks (250 ms) for a signal on air on arrival:
	 * its visit listens 400 ms. A later candidate waits only for what is left of it. A parked hop is
	 * never left and needs no wait. A job that does not hold waits too: without the answer no
	 * observation exists at all.
	 */
	private qualify(v: Visit): boolean {
		if (this.parkedVisit || v.qualifyWait) return false
		let need = 0
		for (const c of v.candidates.values())
			if (this.mayQualify(c))
				need = Math.max(need, c.answerBlocks - (v.blocks - c.onsetBlock))
		if (!this.extendForAnswer(v, need)) return false
		v.qualifyWait = true
		return true
	}

	/**
	 * Lengthens the dwell by `need` blocks for an answer, within what is left of the epoch's cap: the
	 * longest qualification: a standard gate's answer for a candidate of minSurfaceBlocks when the
	 * dwell ends (8 − 2 = 6 blocks, 300 ms, at 50 ms; a longer block's class settle takes more, 5 of
	 * 100 ms). A qualification and a class wait share it, however many candidates the hop has, so one
	 * epoch never adds more: without it a young burst pass (3 blocks) and then a candidate opening at
	 * its end (6) would add 9.
	 */
	private extendForAnswer(v: Visit, need: number): boolean {
		const cap =
			this.qualifyBlocks(CHANNEL_GATE_MIN_DURATION_MS) - this.minSurfaceBlocks
		const blocks = Math.min(need, cap - v.answerWaitBlocks)
		if (blocks <= 0 || v.dwellEnd === null) return false
		v.answerWaitBlocks += blocks
		v.dwellEnd += blocks * this.blockSamples
		return true
	}

	/**
	 * The dwell waits for an answer (the gate's, or a young track's class) and none is left to come.
	 * A wait to hear a carrier's gap (Visit.gapWait) is no answer: it runs its length.
	 */
	private waitAnswered(v: Visit): boolean {
		if ((!v.qualifyWait && !v.classWait) || v.gapWait) return false
		for (const c of v.candidates.values()) if (this.mayQualify(c)) return false
		for (const t of v.tracks.values()) if (this.awaitsClass(t)) return false
		return true
	}

	/**
	 * The followed transmission ended and a new one opened on the same frequency during the hang (a
	 * repeater or a reply): the hold follows the new one, still bounded by the follow's cap.
	 */
	private followReopened(trackId: string): void {
		const hold = this.hold
		const v = this.visit
		if (
			this.phase !== "hold" ||
			hold === null ||
			hold.mode !== "hang" ||
			hold.trackId === trackId ||
			v === null
		)
			return
		const t = v.tracks.get(trackId)
		const held = v.tracks.get(hold.trackId)
		if (
			t === undefined ||
			held === undefined ||
			!t.open ||
			t.tried ||
			t.flagged ||
			(!t.followOnAir && !hold.watch) ||
			!sameFrequency(
				{ centreHz: held.centreHz, halfWidthHz: held.obwHz / 2 },
				t.centreHz,
				Math.max(SAME_FREQUENCY_FLOOR_HZ, t.obwHz / 2),
			)
		)
			return
		t.tried = true
		hold.trackId = trackId
		hold.mode = "follow"
		hold.deadline = hold.cap
		hold.runFrom = this.now()
	}

	/**
	 * A decoder confirmed the held track: a decode proves a transmission, its frequency is traffic.
	 * With a follow the hold runs to `hold.maxHoldMs` from the start of the visit's holds (capFor),
	 * only the long-hold lock cuts it to one coarse sweep. A decode without a follow (policy
	 * `confirm`, voice not recorded) ends the probe: the call is probed again on the next visit,
	 * so a new call after a turnaround is identified too.
	 */
	onConfirmed(trackId: string, follow: boolean): SchedulerAction[] {
		if (
			this.phase !== "hold" ||
			this.hold?.trackId !== trackId ||
			this.hold.mode === "record"
		)
			return []
		const t = this.visit?.tracks.get(trackId)
		const memory = t === undefined ? undefined : this.memoryOf(t)
		if (memory !== undefined) this.markTraffic(memory)
		if (follow && this.spec.hold.policy === "hold" && t !== undefined) {
			const hold = this.hold
			const c = this.capFor(t, memory, true)
			if (c.long && this.visit !== null) this.visit.longDecoded = true
			hold.decoded = true
			hold.watch = false
			hold.cap = c.cap
			hold.mode = t.open ? "follow" : "hang"
			hold.deadline = t.open ? c.cap : this.hangDeadline(c.cap)
			return []
		}
		return this.afterProbe()
	}

	onTrackClosed(trackId: string): SchedulerAction[] {
		const v = this.visit
		const t = v?.tracks.get(trackId)
		if (v !== null && t !== undefined && t.open) {
			t.open = false
			this.noteClosed(v, t)
		}
		// A close may be the voiced transmission's: it is checked at the next block (closeAsk), once
		// a max-duration rollover's successor, reported in the same block, has opened.
		// Of several closes in a block, the analog hold's own is the one kept.
		const own = this.hold?.trackId === trackId && this.holdsAnalog()
		if (
			v !== null &&
			(v.voice === "on" || own) &&
			(own ||
				this.closeAsk === null ||
				this.closeAsk.visit !== v ||
				this.closeAsk.trackId !== this.hold?.trackId)
		)
			this.closeAsk = { visit: v, trackId, at: this.now() }
		if (
			this.phase === "hold" &&
			this.hold?.trackId === trackId &&
			this.hold.mode === "follow"
		) {
			this.hold.mode = "hang"
			this.hold.deadline = this.hangDeadline(this.hold.cap)
		}
		return []
	}

	/**
	 * The recording check a track close waits for (closeAsk), at the next block: while the visit's
	 * voice hold is on and another hold runs (a `record` hold re-checks on its own), the voice hold
	 * is checked; else, when the analog hold's own track closed, the squelch close of the
	 * transmission it heard (Visit.heardVoiceId) is seen now rather than at the next re-check. With
	 * no recorder session to name it, the close alone owes the sweep before any later voice hold
	 * (Visit.voiceBarred): a reply in the hang is never a voice hold of its own. Null: the hop is
	 * kept; else the actions that leave it.
	 */
	private runCloseAsk(now: number): SchedulerAction[] | null {
		const ask = this.closeAsk
		this.closeAsk = null
		const v = this.visit
		if (ask === null || v === null || ask.visit !== v) return null
		if (v.voice === "on") {
			if (this.phase !== "hold" || this.hold?.mode !== "record")
				this.askRecording(now)
			return null
		}
		if (this.hold?.trackId !== ask.trackId || !this.holdsAnalog()) return null
		if (this.askDuringFollow(v, now))
			return this.leaveHop([{ type: "stop-probes" }])
		if (!v.sessionSeen && this.recordingActive !== undefined)
			v.voiceBarred = true
		return null
	}

	/**
	 * End of a hang starting now: `hold.hangMs`, cut at the follow's cap, but never shorter than
	 * TRAFFIC_GAP_MS plus one block on a frequency not known as traffic, so the gap that just
	 * started is classed (a reopening within TRAFFIC_GAP_MS is a flap, a longer gap is traffic): a
	 * hold runs past its cap by at most TRAFFIC_GAP_MS + one block (1050 ms in 50 ms blocks), never
	 * past `hold.maxHoldMs`. A carrier hold spends L (capFor), so its hang never runs past what L
	 * has left (budgetLeftMs) either: a gap it cannot class there is classed by a later visit.
	 * 7 hops (L = 11 500 ms): a recording hold of 8000 ms leaves a carrier hold 3500 ms; a close
	 * 50 ms before that cap hangs to the cap, not 1000 ms past it, so the other hops wait
	 * 8000 + 3500 = L.
	 */
	private hangDeadline(cap: number): number {
		const now = this.now()
		const held =
			this.hold === null ? undefined : this.visit?.tracks.get(this.hold.trackId)
		const memory = held === undefined ? undefined : this.memoryOf(held)
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		const classify =
			memory !== undefined && memory.evidence !== "traffic"
				? TRAFFIC_GAP_MS + blockMs
				: 0
		const room =
			memory?.evidence === "carrier" ? now + this.budgetLeftMs() : Infinity
		return Math.min(
			this.maxHoldDeadline(),
			room,
			Math.max(Math.min(now + this.spec.hold.hangMs, cap), now + classify),
		)
	}

	onOverload(hopIndex: number): void {
		if (this.visit !== null && this.visit.hopIndex === hopIndex)
			this.visit.overloaded = true
	}

	setBoost(hopIndex: number, on: boolean): void {
		const hop = this.hops[hopIndex]
		if (hop !== undefined) hop.boost = on
	}

	/**
	 * decide() may already have opened a confirm hold for a track queued before
	 * signalsOnly became true. The probe has not started; leave the hop instead.
	 */
	abandonUnstartedConfirm(): SchedulerAction[] {
		if (this.phase !== "hold" || this.hold?.mode !== "confirm") return []
		return this.leaveHop([{ type: "stop-probes" }])
	}

	tick(now: number): SchedulerAction[] {
		this.heardAt = now
		// No block came within one block's time of the close (a stalled source): asked now.
		if (
			this.closeAsk !== null &&
			now - this.closeAsk.at >= (this.blockSamples * 1000) / this.sampleRateHz
		) {
			const left = this.runCloseAsk(now)
			if (left !== null) return left
		}
		// The voiced transmission an analog hold heard ended and another is on air: the hold ends
		// and the hop owes its coarse sweep (Visit.voice spent). Not while a close waits for its
		// block (closeAsk): that ask stands for this one, after the successor of a rollover opened.
		if (this.closeAsk === null && this.sampleVoice(now))
			return this.leaveHop([{ type: "stop-probes" }])
		if (this.phase !== "hold" || this.hold === null) return []
		// Forced: `hold.maxHoldMs` from the start of the visit's holds, a recording too.
		if (now >= this.maxHoldDeadline())
			return this.leaveHop([{ type: "stop-probes" }])
		if (now < this.hold.deadline) return []
		if (this.hold.mode === "record")
			return this.recheckRecording(this.hold, now)
		if (this.hold.mode === "confirm") return this.confirmTimedOut()
		// The hang ran out, or the follow reached its cap with the track still on air.
		return this.leaveOrRecord([{ type: "stop-probes" }])
	}

	/**
	 * A `record` hold's re-check: the recording ended or the hold reached its cap, leave; a track
	 * of the window to probe or follow (nextCandidate), hold it (its own bounds apply, and its end
	 * may keep the hop for the recording again); otherwise re-check RECORD_RECHECK_MS later.
	 */
	private recheckRecording(hold: Hold, now: number): SchedulerAction[] {
		const active = this.askRecording(now)
		const v = this.visit
		// A hop kept within L whose recording then voices (a pause at the keep, a late verdict): the
		// transmission gets its voice hold now, as if it had answered voice at the keep, so under the
		// same guard: a recording only of frequencies with carrier evidence stays within L.
		// Named by the band of the track held when the hop was kept (Hold.bandId, voiceBandOf), not
		// by the track the recording reports now: a neighbour voiced first in the window is no voice
		// of this hold, which waits, within L, for its own transmission (holdVoiceOf).
		const recorded = this.recordedTrack(hold.trackId)
		// A `record` hold holds no track of its own: a tentative commitment only firms up here
		// (settleCommitment), it never passes.
		if (v !== null && isVoiceOnAir(active))
			this.settleCommitment(v, undefined, active)
		const bandId =
			v === null ? "" : this.voiceBandOf(v, hold.bandId ?? hold.trackId)
		const named =
			v !== null && isVoiceOnAir(active)
				? this.holdVoiceOf(v, active, bandId === "" ? undefined : bandId)
				: null
		if (v !== null && isVoiceOnAir(active)) {
			// Its own voice: an answer in the band's own channel (heldVoiceOf, as askDuringFollow
			// tells it), not merely the transmission the visit remembers. At a re-check of the wait
			// for a voice answer (Hold.beforeJudging) a neighbour's voice commits tentatively: the
			// wait's band is the window's (the hold sat on no track of its own), so a track qualifying
			// in this very re-check, whose voice it may be, is held next and takes the commitment
			// over by its own voice (settleCommitment).
			const band = v.tracks.get(bandId)
			const own = band !== undefined && heldVoiceOf(active, band) !== null
			this.commitVoiceTrack(
				v,
				bandId,
				active,
				own,
				hold.beforeJudging !== undefined,
			)
		}
		if (
			v !== null &&
			named !== null &&
			v.voice === "no" &&
			!v.voiceBarred &&
			!this.voiceLocked(v) &&
			recorded !== null
		) {
			this.startVoiceHold(v, named, now)
			hold.cap = this.holdOrigin() + this.spec.hold.maxHoldMs
			v.recordEndMs = this.spec.hold.maxHoldMs
		}
		// A recording not voice (or whose voice hold is spent) keeps only what L has left
		// (keepForRecording's non-voice cap).
		if (
			active === true ||
			((isVoiceOnAir(active) || active === "judging") &&
				(v?.voice === "spent" || v?.voiceBarred === true))
		)
			hold.cap = Math.min(hold.cap, this.holdOrigin() + this.followBudgetMs())
		if (now >= hold.cap || active === false) return this.leaveHop([])
		const next = this.nextCandidate()
		if (next !== null) {
			// The wait for a voice answer ends here: the track is held within the visit's own window
			// (Hold.beforeJudging), L and `hold.maxHoldMs` from the start of its holds, not within the
			// wait's 3 s, unless a voice hold started meanwhile (its own window, above), or started
			// and was spent (spendVoice cut the window to what L has left: restoring the wait's
			// earlier bound would lift that cut).
			if (v !== null && hold.beforeJudging !== undefined && v.voice === "no")
				v.recordEndMs = hold.beforeJudging
			this.endHold(false)
			return this.startHold(next)
		}
		hold.deadline = Math.min(hold.cap, now + RECORD_RECHECK_MS)
		return []
	}

	/**
	 * An unforced leave (decide with nothing to hold, a follow's cap or hang end, a probe done):
	 * the hop is kept for a recording when keepForRecording allows, else left. Forced leaves
	 * (`hold.maxHoldMs`, abandonUnstartedConfirm) call leaveHop directly.
	 */
	private leaveOrRecord(prefix: SchedulerAction[]): SchedulerAction[] {
		return this.keepForRecording() ? prefix : this.leaveHop(prefix)
	}

	/**
	 * Keeps the hop while its window is being recorded (recordingActive), as a long follow: up to
	 * what L has left (followBudgetMs) and never past `hold.maxHoldMs` from the start of the visit's
	 * holds (every later hold of the visit ends by then too: Visit.recordEndMs), which
	 * starts now if no hold ran. A recording with voice on air (VoiceOnAir) is kept until the answer
	 * is no longer voice of that transmission (it ended, no voice for 2 s, or another transmission
	 * is voiced), up to `hold.maxHoldMs`
	 * whatever L has left, so a 28 s ID is recorded whole; the visit's voice hold is then spent
	 * (Visit.voice: a later voice answer of the visit keeps L only) and every hop gets a coarse visit
	 * before the hop is followed or kept again (endVisit, longHoldLock, HopState.voiceLock). A
	 * recording that is not voice (true) keeps L, and not while the long-hold lock holds: that lock
	 * bars voice only on a hop whose own voice hold set it (voiceLock), so a transmission caught while
	 * another hop's watch or voice hold holds the lock is still kept to its end. Not while parked (a
	 * parked hop is never left), on a one-hop plan, for a signals-only job or under
	 * `hold.policy: "never"`. A hold that ran past one coarse sweep locks the next long follow out
	 * (endVisit). The held
	 * frequency's evidence is charged as on any leave; the `record` hold itself brings none. Never
	 * when every frequency the recording can be of has carrier evidence and no verified voice
	 * history (recordedTrack). A session
	 * whose voice answer is still to come ("judging") keeps the hop for that answer as voice does, at
	 * most WIDEBAND_VOICE_JUDGE_MS (3000 ms) and once per visit, spending L as a recording hold does;
	 * then the answer rules (recheckRecording).
	 */
	private keepForRecording(): boolean {
		const v = this.visit
		if (
			this.recordingActive === undefined ||
			v === null ||
			this.parkedVisit ||
			this.plan.hops.length < 2 ||
			this.spec.signalsOnly === true ||
			this.spec.hold.policy === "never"
		)
			return false
		const now = this.now()
		const start = this.holdOrigin()
		const active = this.askRecording(now)
		if (active === false) return false
		const judging = active === "judging"
		if (judging && (v.voice !== "no" || v.judged || v.voiceBarred)) return false
		// Voice on air in the window, and the visit's voice hold not spent yet (nor barred by a
		// follow that heard a squelch close with no session to name it).
		const onAir = isVoiceOnAir(active) && v.voice !== "spent" && !v.voiceBarred
		const heldId = this.hold?.trackId
		// A tentative commitment passes to the held track by its own voice (settleCommitment).
		if (isVoiceOnAir(active))
			this.settleCommitment(
				v,
				this.hold?.mode === "record" ? undefined : heldId,
				active,
			)
		// The voice hold is for the held track's own transmission (holdVoiceOf): the band of the
		// held track (voiceBandOf), whatever track the hold will report. A neighbour voiced first in
		// the window names no voice hold; the hop is kept as for a recording that is not voice,
		// within L, and a re-check gives the voice hold once the held track's own transmission
		// voices (recheckRecording).
		const bandId = this.voiceBandOf(v, heldId)
		const named =
			onAir && isVoiceOnAir(active)
				? this.holdVoiceOf(v, active, bandId === "" ? undefined : bandId)
				: null
		const voice = named !== null
		// An unbroken watch is no carrier evidence while voice is on air in the window, named or not:
		// the held track's own transmission may have no session yet (refused a slot while a
		// neighbour's overs hold both), and that is no evidence of a carrier (a 28 s ID caught
		// mid-way, its onset unseen, would be cut at the watch and refused its voice holds after).
		// So voice on air that names no voice hold ends the hold that way on every exit below too
		// (the long-hold lock, the cap of what L has left), not only when the hop is kept.
		const unnamed = onAir && !voice
		const leave = (): false => {
			if (unnamed) this.endHold(true, true)
			return false
		}
		// A revisit of the hop whose long hold set the long-hold lock (an 8 s watch, say) holds no
		// voice either: the others have not had the coarse visit that hold owes them yet.
		if (
			voice || judging
				? this.voiceLocked(v) || (v.revisit && this.lockedOut(v.hopIndex))
				: this.longHoldLock > 0
		)
			return leave()
		const longest = start + this.spec.hold.maxHoldMs
		const cap = voice
			? longest
			: judging
				? Math.min(longest, now + WIDEBAND_VOICE_JUDGE_MS)
				: Math.min(longest, start + this.followBudgetMs())
		if (now >= cap) return leave()
		// Charged first, so a hold that just heard a carrier counts, unless voice is on air (onAir, as
		// above). A recording only of frequencies with carrier evidence is held under the carrier
		// rules only: keeping its hop for it would hold them on every visit again.
		this.endHold(true, onAir)
		const trackId = this.recordedTrack(heldId)
		if (trackId === null) return false
		// Closed at `now`, where the hold's own clock starts: the recording check may take time, and
		// blocks heard meanwhile would count in both the dwell and the hold.
		if (v.holdStartedAt === null) this.enterPhase(v, "hold", now)
		v.holdStartedAt ??= now
		v.budgeted = true
		if (named !== null) this.startVoiceHold(v, named, now)
		if (isVoiceOnAir(active)) this.commitVoiceTrack(v, bandId, active, voice)
		if (judging) v.judged = true
		const beforeJudging = v.recordEndMs
		// A judging hold's cap is a re-check, not a forced leave: voice answered since the last one
		// still gets its hold at the cap.
		v.recordEndMs = cap - start + (judging ? RECORD_RECHECK_MS : 0)
		this.noteLong({
			cap,
			watch: false,
			long: !judging && cap > start + this.chainBudgetMs(),
		})
		this.hold = {
			trackId,
			bandId,
			mode: "record",
			deadline: Math.min(cap, now + RECORD_RECHECK_MS),
			cap,
			watch: false,
			decoded: false,
			from: now,
			runFrom: now,
			...(judging ? { beforeJudging } : {}),
		}
		this.phase = "hold"
		return true
	}

	/**
	 * Track whose band names a hold's voice hold (holdVoiceOf), "" when there is none: with a
	 * commitment (Visit.voiceTrackId), the committed track (committedTrack: while it or its
	 * successor is open; "" while neither is, so no other track's voice is named meanwhile),
	 * whatever track the hold sits on now (a neighbour a `record` hold's re-check probes), until a
	 * tentative commitment passes to the held track (settleCommitment, before a check reads this);
	 * else the held track `heldId` whenever it is a track of the visit, open or not, carrier evidence or not (its
	 * frequency is what the hold is for). Only when it is not (no track was held, a keep after a
	 * probe ended its hold, or the id names no track of this visit) does the hold take the track
	 * recordedTrack reports, the one the recording moved to; none open (or each with carrier
	 * evidence), `heldId` itself. Never a neighbour recordedTrack prefers because the held track is
	 * not followed on air or has carrier evidence: that neighbour's voice is no voice of this hold.
	 */
	private voiceBandOf(v: Visit, heldId: string | undefined): string {
		if (v.voiceTrackId !== null) return this.committedTrack(v) ?? ""
		if (heldId !== undefined && heldId !== "" && v.tracks.has(heldId))
			return heldId
		const moved = this.recordedTrack(heldId)
		return moved === null || moved === "" ? (heldId ?? "") : moved
	}

	/**
	 * The track the visit committed to (Visit.voiceTrackId) that names voice now, null when none
	 * does: that track while open and not flagged; closed, an open unflagged track within
	 * SAME_FREQUENCY_FLOOR_HZ (6250 Hz, half a 12.5 kHz channel) of its centre (a max-duration
	 * rollover's successor), which the commitment moves to. Not its band's reach (heldBandOffset):
	 * a wide merged track (19 kHz or more) reaches the next 12.5 kHz channel, a neighbour. None
	 * open there: null, the commitment kept (a fade's reopening keeps the track id, onTrack, and
	 * names voice again). Side-effect free but for that move: the commitment is never dropped
	 * here, nor moved to a track off its frequency.
	 */
	private committedTrack(v: Visit): string | null {
		const id = v.voiceTrackId
		if (id === null) return null
		const t = v.tracks.get(id)
		if (t === undefined) return null
		if (t.open && !t.flagged) return id
		if (t.flagged) return null
		for (const [other, o] of v.tracks)
			if (
				other !== id &&
				o.open &&
				!o.flagged &&
				Math.abs(o.centreHz - t.centreHz) <= SAME_FREQUENCY_FLOOR_HZ
			) {
				v.voiceTrackId = other
				return other
			}
		return null
	}

	/**
	 * Commits the visit's voice to track `bandId` (Visit.voiceTrackId) at a recording check that
	 * answered voice on air (VoiceOnAir) while a hold of the visit named voice by that track's band
	 * (voiceBandOf: the held track, the visit not committed yet): the voice is the track's own
	 * (heldVoiceOf), or a neighbour's beside it, which is then known to be no transmission of the
	 * held track. A check answering a recording that is no voice (or "judging") commits to nothing:
	 * no voice was heard to tell the held track's transmission from a neighbour's, so a first track
	 * that never voices is never committed to, and a later hold of another track names its own
	 * voice. A closed track only for its own voice (`own`: the answer names voice in its band):
	 * a neighbour's voice heard after the track closed lies beside no transmission of it, and may
	 * be a new transmission the visit holds. Nor for a neighbour's voice that is another open,
	 * unflagged track's own (heldVoiceOf: in its band) when that track's band overlaps the held
	 * track's (bandsOverlap): it took in the held track (a voice keyed beside a steady line joins
	 * the line's track, which reads wider and centred between them, while the line may read on as
	 * its own track), so the voice is that track's transmission, not a neighbour beside the held
	 * track's, and the check commits to nothing; a hold of that track commits to it by its own
	 * voice. A neighbour on another channel (bands apart) still commits to the held track. Never
	 * over an existing commitment, nor to a flagged track or an id that names no track of the visit.
	 * Made for the track's own voice, the commitment is firm (Visit.voiceTrackVoiced); for a
	 * neighbour's, `tentative` (the wait for a voice answer: Visit.voiceTentative) or firm until
	 * the committed track's hold proves a carrier watch (endHold).
	 */
	private commitVoiceTrack(
		v: Visit,
		bandId: string,
		active: VoiceOnAir,
		own: boolean,
		tentative = false,
	): void {
		if (v.voiceTrackId !== null) return
		const t = v.tracks.get(bandId)
		if (t === undefined || t.flagged || !(t.open || own)) return
		if (!own)
			for (const [id, o] of v.tracks)
				if (
					id !== bandId &&
					o.open &&
					!o.flagged &&
					bandsOverlap(o, t) &&
					heldVoiceOf(active, o) !== null
				)
					return
		v.voiceTrackId = bandId
		v.voiceTrackVoiced = own
		v.voiceTentative = !own && tentative
	}

	/**
	 * At a recording check answering voice on air: the visit's commitment (Visit.voiceTrackId) is
	 * firm once the committed track's own voice is named (heldVoiceOf in its band:
	 * Visit.voiceTrackVoiced); a tentative one (Visit.voiceTentative) whose track has never voiced
	 * passes to the held track `heldId` (a probe, follow or hang, never a `record` hold: undefined
	 * there) when the answer names voice in that track's band, open and unflagged: the voice the
	 * commitment was made for, or a new one, is that track's own, and the committed track showed
	 * none of its own. The commitment then is firm. True when it passed.
	 */
	private settleCommitment(
		v: Visit,
		heldId: string | undefined,
		active: VoiceOnAir,
	): boolean {
		if (v.voiceTrackId === null || v.voiceTrackVoiced) return false
		const id = this.committedTrack(v) ?? v.voiceTrackId
		const committed = v.tracks.get(id)
		if (committed !== undefined && heldVoiceOf(active, committed) !== null) {
			v.voiceTrackVoiced = true
			v.voiceTentative = false
			return false
		}
		if (!v.voiceTentative || heldId === undefined || heldId === id) return false
		const held = v.tracks.get(heldId)
		if (
			held === undefined ||
			!held.open ||
			held.flagged ||
			heldVoiceOf(active, held) === null
		)
			return false
		v.voiceTrackId = heldId
		v.voiceTrackVoiced = true
		v.voiceTentative = false
		return true
	}

	/** Whether the hop's own last voice hold still owes the sweep its coarse visits. */
	private voiceLocked(v: Visit): boolean {
		return (this.hops[v.hopIndex]?.voiceLock.size ?? 0) > 0
	}

	/**
	 * The voice answer a hold may start its voice hold for (startVoiceHold, Visit.voiceId): the
	 * transmission the visit already remembers (its voice hold's, or the one a follow heard: it was
	 * matched to its band then, and askRecording answers as it sees it), else the voiced
	 * transmission of the band of track `trackId` (heldVoiceOf), never the window's first voiced
	 * session; null when none lies there or `trackId` names no track of the visit. A visit that
	 * knows no track at all (the recording's track never surfaced in it) has no band to tell a
	 * neighbour by: the answer itself, as the recorder names it.
	 */
	private holdVoiceOf(
		v: Visit,
		active: VoiceOnAir,
		trackId: string | undefined,
	): VoiceOnAir | null {
		const known = v.voice === "on" ? v.voiceId : v.heardVoiceId
		if (known !== null) return active.voice === known ? active : null
		if (v.tracks.size === 0) return active
		const track = trackId === undefined ? undefined : v.tracks.get(trackId)
		return track === undefined ? null : heldVoiceOf(active, track)
	}

	private startVoiceHold(v: Visit, active: VoiceOnAir, now: number): void {
		v.voice = "on"
		v.voiceId = active.voice
		v.voiceAskedAt = now
	}

	/**
	 * Asks the recording check (false without one). While the visit's voice hold is on
	 * (Visit.voice), any answer that is not voice of the transmission the hold started for
	 * (Visit.voiceId) spends it (spendVoice), whatever hold runs: a non-voice answer, or voice of
	 * another transmission (a turnaround passed, even one the check never saw because the event
	 * loop stalled meanwhile), and once the hold reached L an answer quiet for over
	 * VOICE_QUIET_PAST_L_MS. How long the check went unasked never spends it.
	 */
	private askRecording(now: number): RecordingActivity {
		const raw = this.recordingActive?.() ?? false
		if (typeof raw === "object" && raw.recordedHz !== undefined)
			this.noteVoiced(raw.recordedHz)
		const v = this.visit
		this.askEnded = false
		if (v !== null && raw !== false) v.sessionSeen = true
		// The transmission the visit remembers (its voice hold's, or the one an analog hold heard)
		// is judged by its own state when the recorder lists the window's transmissions
		// (Transmissions): a neighbouring channel's voice named first is no end of it. Listed as
		// ended: its end, with another transmission on air.
		const id = v === null ? null : v.voice === "on" ? v.voiceId : v.heardVoiceId
		const own = answerOf(raw, id)
		if (own === null && v !== null) {
			this.spendVoice(v)
			this.askEnded = true
			return false
		}
		const answer = own ?? raw
		if (
			answer !== raw &&
			isVoiceOnAir(answer) &&
			answer.recordedHz !== undefined
		)
			this.noteVoiced(answer.recordedHz)
		// The voiced transmission ended (its squelch closed and another track opened): as the end of
		// a voice hold, whether or not one ran, and whatever the frequency's voice history. The hop
		// is not kept for what follows (a reply, a kerchunk) and owes every hop its coarse visit
		// (Visit.voice, endVisit): history only lifts the carrier cap on a recording of that
		// transmission (recordedTrack), never a hold across its turnaround. With no transmission
		// remembered, only a `voiceEnded` of the held band (endsHeldBand): a neighbour's turnaround
		// (its session the window's only voiced one, the held track's own refused a slot or not
		// voiced yet) is read as a recording that is not voice, kept within L at most.
		if (
			typeof answer === "object" &&
			!isVoiceOnAir(answer) &&
			answer.voiceEnded === true &&
			(id !== null || this.endsHeldBand(v, answer.targetHz))
		) {
			if (v !== null) this.spendVoice(v)
			this.askEnded = true
			return false
		}
		// A voiced transmission an analog hold heard without its voice hold (Visit.heardVoiceId)
		// ends as a voice hold's does: at its squelch close (false), or once another transmission is
		// voiced (a reply the event loop or the pace hid the turnaround of). The visit's voice hold is
		// spent and the reply is no recording to keep the hop for.
		if (v !== null && v.voice !== "on" && v.heardVoiceId !== null) {
			if (answer === false) this.spendVoice(v)
			else if (isVoiceOnAir(answer) && answer.voice !== v.heardVoiceId) {
				this.spendVoice(v)
				this.askEnded = true
				return false
			}
		}
		// A recorded session with no voice on air now is a recording that is not voice.
		const active =
			typeof answer === "object" && !isVoiceOnAir(answer) ? true : answer
		if (v === null || v.voice !== "on") return active
		if (
			!isVoiceOnAir(active) ||
			active.voice !== v.voiceId ||
			((active.quietMs ?? 0) > VOICE_QUIET_PAST_L_MS &&
				now >= this.holdOrigin() + this.lockAfterMs())
		)
			this.spendVoice(v)
		else v.voiceAskedAt = now
		return active
	}

	/**
	 * Whether a recorder's `voiceEnded` of a session demodulating `hz` (RecordedSession.targetHz)
	 * ends the visit's hold when the visit remembers no transmission: `hz` lies in the band of the
	 * held track (voiceBandOf of the hold's band or track, as holdVoiceOf names voice, so a record
	 * hold is judged by the band it was kept for). A visit that knows no track (or no visit) has no
	 * band to tell a neighbour by: the answer as the recorder names it, as before. A held band that
	 * names no track of the visit, or `hz` absent or not finite: no end. Ignoring is the safe error:
	 * ending early on a neighbour's turnaround loses the held ID and voice-locks the hop for a full
	 * coarse sweep, while a turnaround of the held track read as a recording that is not voice keeps
	 * the hop only within its existing bound (what L has left, or the follow's own cap), never longer.
	 */
	private endsHeldBand(v: Visit | null, hz: number | undefined): boolean {
		if (v === null || v.tracks.size === 0) return true
		const bandId = this.voiceBandOf(v, this.hold?.bandId ?? this.hold?.trackId)
		const track = bandId === "" ? undefined : v.tracks.get(bandId)
		return track !== undefined && heldBandOffset(hz, track) !== null
	}

	/**
	 * The recorder recorded a classed, voiced session at `hz`: verified voice history of the
	 * frequency there (FrequencyMemory.voiced), and of every open track of the visit whose occupied
	 * band holds `hz` (the recording is of that track: a voice whose track took in a line beside it
	 * reads centred between them, while the line's frequency is remembered at the line). Never of a
	 * frequency not remembered, nor of a track beside the session that does not reach it.
	 */
	private noteVoiced(hz: number): void {
		const m = this.memoryAt(hz, 0)
		if (m !== undefined) m.voiced = true
		for (const t of this.visit?.tracks.values() ?? []) {
			if (!t.open || t.flagged) continue
			if (
				Math.abs(t.centreHz - hz) >
				Math.max(SAME_FREQUENCY_FLOOR_HZ, t.obwHz / 2)
			)
				continue
			const own = this.memoryOf(t)
			if (own !== undefined) own.voiced = true
		}
	}

	/**
	 * The visit's voice hold ends (its transmission ended, voice stopped, or another transmission
	 * is voiced): a later voice answer of the visit counts as true, and every hold of the visit shares
	 * what L has left from the start of its holds (Visit.recordEndMs, maxHoldDeadline), not the
	 * voice cap; a `record` hold's cap is cut at its next re-check (recheckRecording).
	 */
	private spendVoice(v: Visit): void {
		v.voice = "spent"
		v.voiceId = null
		releaseCommitment(v)
		v.voiceAskedAt = null
		if (v.recordEndMs !== null)
			v.recordEndMs = Math.min(v.recordEndMs, this.followBudgetMs())
	}

	/**
	 * A tick while the visit's voice hold is on and no `record` hold runs (a probe, a follow or a
	 * hang started from it, or a restart's dwell): the recording check is asked at most every
	 * RECORD_RECHECK_MS, so the voice hold's end is seen whatever hold runs. A `record` hold asks
	 * at its own re-checks.
	 */
	private sampleVoice(now: number): boolean {
		const v = this.visit
		if (v === null) return false
		if (this.phase === "hold" && this.hold?.mode === "record") return false
		if (v.voice === "on") {
			if (v.voiceAskedAt !== null && now - v.voiceAskedAt < RECORD_RECHECK_MS)
				return false
			this.askRecording(now)
			return false
		}
		if (!this.holdsAnalog()) return false
		if (v.followAskedAt !== null && now - v.followAskedAt < RECORD_RECHECK_MS)
			return false
		return this.askDuringFollow(v, now)
	}

	/**
	 * Whether the current hold probes, follows or hangs on analog voice (TrackInfo.followOnAir)
	 * that no decoder confirmed: the holds sampleVoice asks the recorder during when no voice
	 * hold is on.
	 */
	private holdsAnalog(): boolean {
		const hold = this.hold
		if (this.phase !== "hold" || hold === null || hold.decoded) return false
		if (hold.mode === "record") return false
		return this.visit?.tracks.get(hold.trackId)?.followOnAir === true
	}

	/**
	 * Asks the recorder during an analog hold that is no voice hold (holdsAnalog): the first voiced
	 * transmission on the held track's own frequency (heldVoiceOf: its band, not the window's first
	 * voiced session, which may be a neighbour already talking at the landing) is the one the visit
	 * heard (Visit.heardVoiceId); none there, none is remembered yet. True when the hold
	 * must end now, the hop owing its coarse sweep: that transmission ended and another is on air
	 * (the recorder's `voiceEnded`, a reply joined by its hang, or voice named otherwise). Its
	 * squelch close alone spends the voice hold (askRecording) and leaves the hold to its hang.
	 */
	private askDuringFollow(v: Visit, now: number): boolean {
		v.followAskedAt = now
		// Named by the track the visit committed to (Visit.voiceTrackId), else the held track,
		// which the first check answering voice commits to (commitVoiceTrack).
		let bandId = this.voiceBandOf(v, this.hold?.trackId)
		const active = this.askRecording(now)
		if (this.askEnded) return true
		if (isVoiceOnAir(active)) {
			// A tentative commitment passes to the held track by its own voice (settleCommitment).
			if (this.settleCommitment(v, this.hold?.trackId, active))
				bandId = this.hold?.trackId ?? bandId
			const track = v.tracks.get(bandId)
			const own = track === undefined ? null : heldVoiceOf(active, track)
			this.commitVoiceTrack(v, bandId, active, own !== null)
			if (v.heardVoiceId === null) {
				if (own !== null) {
					v.heardVoiceId = own.voice
					v.heardVoiceHoldable ||= this.mayHoldVoice(v)
				}
			} else if (active.voice === v.heardVoiceId)
				v.heardVoiceHoldable ||= this.mayHoldVoice(v)
		}
		return false
	}

	/**
	 * Whether the visit may still give voice on air its voice hold (keepForRecording's bars, the
	 * cap aside): its voice hold is neither spent nor barred, the hop owes no sweep for its last
	 * voice hold (voiceLocked), the visit is no revisit of the hop whose long hold set the long-hold
	 * lock (lockedOut), and the recording can be of a track with no carrier evidence
	 * (recordedTrack).
	 */
	private mayHoldVoice(v: Visit): boolean {
		return (
			v.voice !== "spent" &&
			!v.voiceBarred &&
			!this.voiceLocked(v) &&
			!(v.revisit && this.lockedOut(v.hopIndex)) &&
			this.recordedTrack(this.hold?.trackId) !== null
		)
	}

	/**
	 * Track a `record` hold reports (progress `holdingOn`), or null when the recording can only be of
	 * frequencies with carrier evidence and no verified voice history (FrequencyMemory.voiced). Width
	 * is no exception: a voice whose track took in a line beside it reads wider, and so may the line
	 * itself (noise, drift, a merged neighbour), so a frequency with carrier evidence gets at most L
	 * for a recording and never the voice hold until the recorder verifies voice on it.
	 * recordingActive names the window, not the frequency, so every open analog voice of the visit is a candidate: null when each has carrier evidence, else
	 * the track just held if it is one without, else the strongest without. With no open analog
	 * voice: the track just held if it is still open, else the visit's strongest open track (null
	 * when it has carrier evidence); "" when none is open.
	 */
	private recordedTrack(heldId: string | undefined): string | null {
		const v = this.visit
		if (v === null) return ""
		const carrier = (t: TrackInfo): boolean => {
			const m = this.memoryOf(t)
			return m?.evidence === "carrier" && !m.voiced
		}
		let voice = false
		let best: { id: string; t: TrackInfo } | null = null
		for (const [id, t] of v.tracks) {
			if (!t.open || t.flagged || !t.followOnAir) continue
			voice = true
			if (carrier(t)) continue
			if (id === heldId) return id
			if (best === null || t.snrDb > best.t.snrDb) best = { id, t }
		}
		if (voice) return best?.id ?? null
		const held = heldId === undefined ? undefined : v.tracks.get(heldId)
		if (heldId !== undefined && held?.open === true)
			return carrier(held) ? null : heldId
		for (const [id, t] of v.tracks) {
			if (!t.open || t.flagged) continue
			if (best === null || t.snrDb > best.t.snrDb) best = { id, t }
		}
		if (best === null) return ""
		return carrier(best.t) ? null : best.id
	}

	/**
	 * The engine was reconfigured (another lease holder's or the defaults' integration, FFT size or
	 * rate; S1-B final review, finding 2). The next own epoch's `restartVisit` sizes the dwell with it.
	 */
	setBlockGeometry(blockSamples: number, sampleRateHz: number): void {
		this.blockSamples = blockSamples
		this.sampleRateHz = sampleRateHz
	}

	blockGeometry(): { blockSamples: number; sampleRateHz: number } {
		return { blockSamples: this.blockSamples, sampleRateHz: this.sampleRateHz }
	}

	/**
	 * Swaps the plan. A multi-hop or unparked plan swaps at the next hop boundary (returns no
	 * action). While parked (R 1.1): a one-hop plan at the same centre, rate and gain keeps the
	 * park, the visit and any open hold; a one-hop plan that moves ends an open hold and returns
	 * exactly one tune; a multi-hop plan leaves the park and swaps at the boundary.
	 */
	replan(plan: HopPlan, spec: NormalisedJobSpec): SchedulerAction[] {
		if (plan.hops.length === 0)
			throw new WaveKitError(
				"A sweep needs at least one hop",
				"SCANNER_EMPTY_PLAN",
			)
		if (this.parkedVisit && plan.hops.length === 1) {
			if (this.keepsPark(plan, spec)) {
				this.plan = plan
				this.spec = spec
				return []
			}
			return this.leaveParkFor(plan, spec)
		}
		if (this.parkedVisit) this.unpark()
		this.pendingReplan = { plan, spec }
		// The plan still swaps at the hop boundary. signalsOnly is a track decision,
		// so the next confirm sees it before that boundary.
		if (spec.signalsOnly !== undefined) this.spec.signalsOnly = spec.signalsOnly
		else delete this.spec.signalsOnly
		if (this.phase === "idle") this.applyReplan()
		return []
	}

	private accountingPausedAt: number | null = null
	private visitPausedMs = 0
	private heldAccountingFloorMs: number | null = null
	private heldAccountingOffsetMs = 0

	/** Freeze statistics without changing the visit's scheduling or hold policy. */
	setAccountingActive(active: boolean): void {
		if (active && this.accountingPausedAt !== null) {
			// A visit started during the pause (paused replan) only excludes the pause since its start.
			const pausedSince = Math.max(
				this.accountingPausedAt,
				this.visit?.startedAt ?? this.accountingPausedAt,
			)
			this.visitPausedMs += Math.max(0, this.now() - pausedSince)
			this.accountingPausedAt = null
			if (this.visit !== null) {
				this.visit.clock.at = this.now()
				this.visit.clock.heardMs = 0
			}
		} else if (!active && this.accountingPausedAt === null) {
			this.accountingPausedAt = this.now()
			if (this.visit !== null)
				this.closePhase(this.visit, this.accountingPausedAt)
			this.heldAccountingFloorMs =
				this.visit === null
					? null
					: this.accountedHeldMs(this.visit, this.accountingPausedAt)
		}
	}

	private accountedHeldMs(v: Visit, now: number): number {
		return (
			this.heldAccountingFloorMs ??
			Math.max(0, this.heldMs(v, now) + this.heldAccountingOffsetMs)
		)
	}

	/** Closes the running phase at `at`; the clock runs on from there in the same phase. */
	private closePhase(v: Visit, at: number): void {
		const c = v.clock
		addRunningPhase(c, c, at)
		c.heardMs = 0
		c.at = Math.max(c.at, at)
	}

	private enterPhase(v: Visit, kind: PhaseKind, at = this.now()): void {
		this.closePhase(v, this.accountingPausedAt ?? at)
		v.clock.kind = kind
	}

	/**
	 * The job runner sends the visit's tune (again, for a re-send). Accounting only. A hold whose clock
	 * still runs (no pause since it started) keeps counting: it counts until the restart.
	 */
	noteTuneStarted(hopIndex: number): void {
		const v = this.visit
		if (
			v === null ||
			v.hopIndex !== hopIndex ||
			(v.holdStartedAt !== null && this.heldAccountingFloorMs === null)
		)
			return
		this.enterPhase(v, "command")
	}

	/** The tune was answered: what follows until its epoch opens is settle. Accounting only. */
	noteTuneAnswered(hopIndex: number): void {
		const v = this.visit
		if (v !== null && v.hopIndex === hopIndex && v.clock.kind === "command")
			this.enterPhase(v, "settle")
	}

	/**
	 * hopStats with the phases of `timeMs` (HopPhaseStat). A pause counts in none of them: the running
	 * phase closes where the pause began and its clock restarts when the pause ends, as timeMs does.
	 * Cost: one object per hop per job view read; `scanner:progress` carries no hops and never asks.
	 */
	hopPhaseStats(): HopPhaseStat[] {
		const now = this.now()
		const at = this.accountingPausedAt ?? now
		const v = this.visit
		return this.hopStats(now).map((stat, i) => {
			const sum = emptyPhases()
			const ended = this.hops[i]?.phases
			if (ended !== undefined) addPhases(sum, ended)
			if (v !== null && v.hopIndex === i) {
				addPhases(sum, v.clock)
				addRunningPhase(sum, v.clock, at)
			}
			const measuredSettleMs = Math.floor(sum.settleMs)
			const measuredStaleMs = Math.floor(sum.staleMs)
			const measuredDwellMs = Math.floor(sum.dwellMs)
			const measuredQualifyMs = Math.floor(sum.qualifyMs)
			return {
				...stat,
				measuredSettleMs,
				measuredStaleMs,
				measuredDwellMs,
				measuredQualifyMs,
				overheadMs: Math.max(
					0,
					stat.timeMs -
						measuredSettleMs -
						measuredStaleMs -
						measuredDwellMs -
						measuredQualifyMs -
						stat.holdMs,
				),
			}
		})
	}

	/** Per-hop totals, excluding pauses; last-visit age uses the wall clock. */
	hopStats(now = this.now()): HopStat[] {
		const v = this.visit
		return this.hops.map((hop, hopIndex) => {
			const current = v !== null && v.hopIndex === hopIndex
			const at = this.accountingPausedAt ?? now
			const held = current ? this.accountedHeldMs(v, at) : 0
			return {
				hopIndex,
				visits: hop.visits + (current ? 1 : 0),
				timeMs:
					hop.timeMs +
					(current ? Math.max(0, at - v.startedAt - this.visitPausedMs) : 0),
				holdMs: hop.holdMs + held,
				lastVisitAgeMs: current
					? now - at
					: hop.lastVisit === null
						? null
						: now - hop.lastVisit,
			}
		})
	}

	progress(): {
		sweepIndex: number
		hopIndex: number
		hopCount: number
		sweepPeriodMs: number | null
		holdingOn: string | null
		coverage: number
	} {
		if (this.parkedVisit)
			return {
				sweepIndex: this.sweepIndex,
				hopIndex: 0,
				hopCount: 1,
				sweepPeriodMs: null,
				holdingOn: this.holdingOn(),
				coverage: 1,
			}
		return {
			sweepIndex: this.sweepIndex,
			hopIndex:
				this.visit?.hopIndex ??
				Math.min(this.coarseIndex, this.plan.hops.length - 1),
			hopCount: this.plan.hops.length,
			sweepPeriodMs: this.sweepPeriodMs,
			holdingOn: this.holdingOn(),
			coverage: this.lastCoverage ?? this.visited.size / this.plan.hops.length,
		}
	}

	// ── internals ────────────────────────────────────────────────────────

	/** Track held now (a `record` hold with no open track: null). */
	private holdingOn(): string | null {
		if (this.phase !== "hold" || this.hold === null) return null
		return this.hold.trackId === "" ? null : this.hold.trackId
	}

	/** A hop never visited under this plan; an optional seed (occupancy history) primes its activityScore. */
	private freshHop(hop: Hop | undefined): HopState {
		const seed =
			hop === undefined || this.activitySeed === undefined
				? 0
				: this.activitySeed(hop)
		const seeded = Number.isFinite(seed) && seed > 0
		return {
			activityScore: seeded ? Math.min(1, seed) : 0,
			scoreAt: seeded ? this.now() : null,
			lastVisit: null,
			gainTenthsDb: this.spec.tuner.gainTenthsDb,
			cleanVisits: 0,
			boost: false,
			fullVisits: 0,
			visits: 0,
			timeMs: 0,
			holdMs: 0,
			phases: emptyPhases(),
			waitMs: 0,
			voiceLock: NO_HOPS,
			revisitLock: NO_HOPS,
		}
	}

	/**
	 * Entries compared by frequency memory lookups since the job started (accounting: a lookup reads
	 * the entries of the index bins within reach, never the whole memory).
	 */
	memoryComparisons(): number {
		return this.memoryOps
	}

	/**
	 * Same-frequency entry of a track or sighting: the oldest entry within tolerance. Reads only the
	 * index bins within max(own tolerance, widest entry) of `centreHz`.
	 */
	private memoryAt(
		centreHz: number,
		obwHz: number,
	): FrequencyMemory | undefined {
		const halfWidthHz = Math.max(SAME_FREQUENCY_FLOOR_HZ, obwHz / 2)
		const reach = Math.max(halfWidthHz, this.memoryReachHz)
		let best: FrequencyMemory | undefined
		const last = Math.floor((centreHz + reach) / MEMORY_BIN_HZ)
		for (let b = Math.floor((centreHz - reach) / MEMORY_BIN_HZ); b <= last; b++)
			for (const m of this.memoryBins.get(b) ?? []) {
				this.memoryOps++
				if (
					sameFrequency(m, centreHz, halfWidthHz) &&
					(best === undefined || m.order < best.order)
				)
					best = m
			}
		return best
	}

	private indexMemory(m: FrequencyMemory): void {
		const bin = Math.floor(m.centreHz / MEMORY_BIN_HZ)
		const list = this.memoryBins.get(bin)
		if (list === undefined) this.memoryBins.set(bin, [m])
		else list.push(m)
		this.memoryReachHz = Math.max(this.memoryReachHz, m.halfWidthHz)
	}

	private unindexMemory(m: FrequencyMemory): void {
		const bin = Math.floor(m.centreHz / MEMORY_BIN_HZ)
		const list = this.memoryBins.get(bin)
		if (list === undefined) return
		const i = list.indexOf(m)
		if (i >= 0) list.splice(i, 1)
		if (list.length === 0) this.memoryBins.delete(bin)
	}

	private memoryOf(t: TrackInfo): FrequencyMemory | undefined {
		return this.memoryAt(t.centreHz, t.obwHz)
	}

	/**
	 * Records a sighting and the traffic or carrier evidence it brings: the reopening of a close this
	 * visit heard (TRAFFIC_GAP_MS or more apart: traffic, less: a flap), or a late open after that
	 * much listening (traffic). A flagged track only marks its frequency heard.
	 */
	private remember(
		v: Visit,
		track: TrackSnapshot,
		isNew: boolean,
		flagged: boolean,
	): void {
		const now = this.now()
		const halfWidthHz = Math.max(SAME_FREQUENCY_FLOOR_HZ, track.obwHz / 2)
		let entry = this.memoryAt(track.centreHz, track.obwHz)
		if (entry === undefined) {
			if (flagged) return
			entry = {
				centreHz: track.centreHz,
				halfWidthHz,
				order: this.memoryOrder++,
				evidence: "unknown",
				flaps: false,
				flapRest: false,
				flapAt: null,
				flapListenMs: 0,
				wasTraffic: false,
				voiced: false,
				// New on a hop that already had a full visit: that visit missed it.
				onsetSeen: (this.hops[v.hopIndex]?.fullVisits ?? 0) >= 1,
				restUntil: 0,
				suspect: false,
				runFrom: now,
				watchAfter: 0,
				seenVisit: v.serial,
				candidateVisit: 0,
				misses: 0,
				closedAt: null,
			}
			this.memory.push(entry)
			this.indexMemory(entry)
			this.boundMemory()
			if (this.lateOpen(v, isNew)) this.markTraffic(entry)
			return
		}
		entry.halfWidthHz = Math.max(entry.halfWidthHz, halfWidthHz)
		this.memoryReachHz = Math.max(this.memoryReachHz, entry.halfWidthHz)
		if (flagged) {
			entry.seenVisit = v.serial
			return
		}
		const closed = entry.closedAt
		if (closed !== null && closed.visit === v.serial) {
			if (closed.block !== v.blocks) {
				entry.runFrom = now
				entry.watchAfter = 0
				if (this.gapOnAirMs(closed.lastSample, track) >= TRAFFIC_GAP_MS)
					this.markTraffic(entry)
				else {
					// flapPairMs: a known call flaps for its rest only twice in time.
					const since =
						entry.flapAt === null
							? null
							: entry.flapListenMs + now - Math.max(v.startedAt, entry.flapAt)
					const pair = since !== null && since <= this.flapPairMs()
					entry.flapAt = now
					entry.flapListenMs = 0
					if (pair || !(entry.wasTraffic || entry.onsetSeen))
						entry.flapRest = true
					this.markCarrier(entry, true)
				}
			}
		} else if (isNew && entry.seenVisit !== v.serial) {
			if (this.lateOpen(v, isNew)) this.markTraffic(entry)
			// The last full visit missed it: it went off air, and this run started since.
			if (entry.misses > 0) {
				entry.runFrom = now
				entry.watchAfter = 0
				if (entry.evidence === "unknown") entry.onsetSeen = true
				else if (entry.evidence === "carrier" && !entry.flaps)
					entry.suspect = true
			}
		}
		entry.closedAt = null
		entry.seenVisit = v.serial
	}

	/**
	 * A new track opened after the visit listened at least TRAFFIC_GAP_MS without it: a heard gap
	 * (listenedMs; the track event comes before its block's, so this reads one block short).
	 */
	private lateOpen(v: Visit, isNew: boolean): boolean {
		return isNew && this.listenedMs(v) >= TRAFFIC_GAP_MS
	}

	/**
	 * Ms of this visit's epoch before a track opening now went on air (it surfaced minSurfaceBlocks
	 * later).
	 */
	private listenedMs(v: Visit): number {
		return (
			((v.blocks - v.epochBlock - this.minSurfaceBlocks) *
				this.blockSamples *
				1000) /
			this.sampleRateHz
		)
	}

	/**
	 * Traffic evidence: a gap of at least TRAFFIC_GAP_MS heard, or a decode. A follow of it in
	 * progress may now run as traffic does (capFor).
	 */
	private markTraffic(m: FrequencyMemory): void {
		if (m.evidence === "traffic") return
		m.evidence = "traffic"
		m.wasTraffic = true
		m.flaps = false
		m.flapRest = false
		m.flapAt = null
		m.suspect = false
		m.restUntil = 0
		this.recapHold(m)
	}

	/**
	 * Positive carrier evidence (a flap, or a hold that heard it on air without a break): from now
	 * on it is held only under the carrier rules, and a follow of it in progress is cut to them.
	 */
	private markCarrier(m: FrequencyMemory, flap: boolean): void {
		if (m.evidence !== "carrier" && !m.onsetSeen && this.visit !== null)
			this.visit.newlyQuiet = true
		m.evidence = "carrier"
		m.flaps ||= flap
		if (flap) m.suspect = false
		this.recapHold(m)
	}

	/** The evidence of the held frequency changed: its follow runs to the cap that now applies. */
	private recapHold(m: FrequencyMemory): void {
		const hold = this.hold
		const v = this.visit
		const t = hold === null ? undefined : v?.tracks.get(hold.trackId)
		// A `record` hold's cap is L from the shared window (keepForRecording), whatever the evidence.
		if (
			hold === null ||
			hold.mode === "record" ||
			hold.decoded ||
			t === undefined ||
			this.memoryOf(t) !== m
		)
			return
		const c = this.capFor(t, m)
		this.noteLong(c)
		if (c.budget === true && v !== null) v.budgeted = true
		hold.watch = c.watch
		hold.cap = c.cap
		if (hold.mode === "follow") hold.deadline = c.cap
	}

	/**
	 * Keeps the memory within MAX_FREQUENCY_MEMORY per hop: the frequency missed longest goes first
	 * (most misses, then the oldest last sighting, then the oldest entry). One sort and one slice,
	 * O(n log n), whatever the number of entries dropped (a replan to fewer hops drops many).
	 */
	private boundMemory(): void {
		const limit = MAX_FREQUENCY_MEMORY * Math.max(1, this.plan.hops.length)
		if (this.memory.length <= limit) return
		const ranked = [...this.memory].sort(
			(a, b) =>
				b.misses - a.misses || a.seenVisit - b.seenVisit || a.order - b.order,
		)
		const gone = new Set(ranked.slice(0, this.memory.length - limit))
		for (const m of gone) this.unindexMemory(m)
		this.memory = this.memory.filter(m => !gone.has(m))
	}

	/** A track closed: its frequency went off air unless another open track of the visit is on it. */
	private noteClosed(v: Visit, t: TrackInfo): void {
		const memory = this.memoryOf(t)
		if (memory === undefined) return
		for (const other of v.tracks.values())
			if (other.open && this.memoryOf(other) === memory) return
		memory.closedAt = {
			visit: v.serial,
			block: v.blocks,
			at: this.now(),
			lastSample: t.lastSample,
		}
	}

	/**
	 * The on-air gap between a closed track and a track that opened since, as TRAFFIC_GAP_MS reads it:
	 * from sample positions, so neither the close's lag nor the reopening's wait for its gate counts.
	 * The first block of the run is the earlier of the track's start and its on-air blocks back from
	 * its last sample (the sweep preview's snapshots start at their current block).
	 */
	private gapOnAirMs(closedLastSample: number, track: TrackSnapshot): number {
		const first = Math.min(
			track.startSample,
			track.lastSample - track.blocks * this.blockSamples,
		)
		return (
			((first - closedLastSample + this.blockSamples) * 1000) /
			this.sampleRateHz
		)
	}

	/** The visit heard it on air: as a track, or as a candidate its gate has not answered yet. */
	private heardOn(m: FrequencyMemory, v: Visit): boolean {
		return m.seenVisit === v.serial || m.candidateVisit === v.serial
	}

	/** Covered span of hop `hopIndex` holds `m`. */
	private covers(hopIndex: number, m: FrequencyMemory): boolean {
		const hop = this.plan.hops[hopIndex]
		return (
			hop !== undefined &&
			m.centreHz >= hop.covered.startHz &&
			m.centreHz <= hop.covered.endHz
		)
	}

	/** A new visit record of `hopIndex` (tuned or continued). */
	private newVisit(
		hopIndex: number,
		revisit: boolean,
		tracks: Map<string, TrackInfo>,
		gainTenthsDb: number | null,
	): Visit {
		const now = this.now()
		return {
			hopIndex,
			revisit,
			dwellEnd: null,
			blocks: 0,
			overloaded: false,
			tracks,
			holdStartedAt: null,
			heldBeforeMs: 0,
			gainTenthsDb,
			startedAt: now,
			serial: ++this.visitSerial,
			epochBlock: 0,
			classWait: false,
			gapWait: false,
			candidates: new Map(),
			qualifyWait: false,
			answerWaitBlocks: 0,
			longFollow: false,
			longDecoded: false,
			budgeted: false,
			watched: false,
			recordEndMs: null,
			voice: "no",
			voiceId: null,
			voiceAskedAt: null,
			heardVoiceId: null,
			heardVoiceHoldable: false,
			voiceTrackId: null,
			voiceTrackVoiced: false,
			voiceTentative: false,
			followAskedAt: null,
			sessionSeen: false,
			voiceBarred: false,
			judged: false,
			newlyQuiet: false,
			clock: { ...emptyPhases(), kind: "command", at: now, heardMs: 0 },
		}
	}

	/** `untuned`: a window that follows without a retune has no settle to leave out. */
	private dwellSamples(untuned = false): number {
		const blocks = (this.minSurfaceBlocks + 1) * this.blockSamples
		const dwellMs = this.currentDwellMs()
		const operator = Math.round(
			((dwellMs - (untuned ? 0 : this.spec.settleMs)) * this.sampleRateHz) /
				1000,
		)
		return Math.max(blocks, operator)
	}

	private tuneTo(hopIndex: number, revisit: boolean): SchedulerAction[] {
		const hop = this.plan.hops[hopIndex]
		if (hop === undefined)
			throw new WaveKitError(
				`Hop ${hopIndex} is outside the plan`,
				"SCANNER_HOP_RANGE",
			)
		const gainTenthsDb = this.gainOf(hopIndex)
		this.visit = this.newVisit(hopIndex, revisit, new Map(), gainTenthsDb)
		this.hold = null
		this.phase = "tuning"
		return [{ type: "tune", hopIndex, centreHz: hop.centreHz, gainTenthsDb }]
	}

	private decide(): SchedulerAction[] {
		const v = this.visit
		if (v === null) return []
		this.visited.add(v.hopIndex)
		if (this.spec.hold.policy !== "never") {
			const next = this.nextCandidate()
			if (next !== null) {
				this.enterPhase(v, "hold")
				v.holdStartedAt = this.now()
				return this.startHold(next)
			}
			if (this.waitForClass(v) || this.listenForGap(v)) {
				this.enterPhase(v, "qualify")
				return []
			}
		}
		if (this.qualify(v)) {
			this.enterPhase(v, "qualify")
			return []
		}
		return this.leaveOrRecord([])
	}

	/**
	 * A frequency with carrier evidence (no flap) whose retry is due, and which the dwell did not
	 * hear: it is off air now, which a steady carrier never is. The dwell listens on once until it
	 * heard TRAFFIC_GAP_MS since its epoch started (minSurfaceBlocks + TRAFFIC_GAP_MS of blocks,
	 * at most 1000 ms more than a dwell of minSurfaceBlocks + 1 blocks): a frequency still off by
	 * then is traffic (noteHeardGaps). This is the coarse sweep's carrier hold (retryLock), so a
	 * retry that falls in a turnaround of a QSO taken for a carrier listens to the turnaround
	 * instead of waiting for the next over to start.
	 */
	private listenForGap(v: Visit): boolean {
		if (
			v.gapWait ||
			v.dwellEnd === null ||
			this.retryLock > 0 ||
			this.spec.signalsOnly === true
		)
			return false
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		const need =
			v.epochBlock +
			this.minSurfaceBlocks +
			Math.ceil(TRAFFIC_GAP_MS / blockMs) -
			v.blocks
		if (need <= 0) return false
		const now = this.now()
		const due = this.memory.find(
			m =>
				m.evidence === "carrier" &&
				!m.flaps &&
				!this.heardOn(m, v) &&
				(m.suspect || now >= m.restUntil) &&
				this.covers(v.hopIndex, m),
		)
		if (due === undefined) return false
		due.suspect = true
		v.gapWait = true
		v.dwellEnd += need * this.blockSamples
		this.retryLock = this.plan.hops.length
		return true
	}

	/**
	 * A track younger than CLASS_SETTLE_BLOCKS cannot be labelled analog voice yet: with nothing
	 * else to hold, the dwell waits for it once (at most CLASS_SETTLE_BLOCKS − 1 blocks), so a
	 * label that arrives with its 5th block can still start a follow. A track whose spectrum reads
	 * as analog voice (`voiceLater`) is waited for, and one that just passed its gate as a candidate
	 * of this visit (TrackInfo.qualified: a burst gate passes at the 2nd or 3rd block, on a spectrum
	 * too young to read), so a voice call after a steady carrier gets its hold. A candidate opening
	 * at the dwell's 2nd block and passing at its 3rd waits to visit block 6: 3 blocks past the dwell
	 * (150 ms at 50 ms), at most, within the epoch's cap (extendForAnswer). Any other young burst
	 * leaves at the dwell.
	 */
	private waitForClass(v: Visit): boolean {
		if (
			v.classWait ||
			v.dwellEnd === null ||
			this.spec.hold.policy !== "hold" ||
			this.spec.signalsOnly === true
		)
			return false
		let need = 0
		for (const t of v.tracks.values())
			if (this.awaitsClass(t))
				need = Math.max(need, CLASS_SETTLE_BLOCKS - t.ageBlocks)
		if (!this.extendForAnswer(v, need)) return false
		v.classWait = true
		return true
	}

	private awaitsClass(t: TrackInfo): boolean {
		return (
			t.open &&
			!t.tried &&
			this.mayHold(t) &&
			!t.followOnAir &&
			(t.voiceLater || t.qualified) &&
			t.ageBlocks < CLASS_SETTLE_BLOCKS
		)
	}

	/**
	 * Not flagged, and, with carrier evidence, its retry budget has
	 * refilled and no other carrier hold ran in this coarse sweep.
	 */
	private mayHold(t: TrackInfo): boolean {
		if (t.flagged) return false
		const m = this.memoryOf(t)
		return m === undefined || this.mayHoldFrequency(m)
	}

	private mayHoldFrequency(m: FrequencyMemory): boolean {
		if (m.evidence === "unknown") return this.coarseVisits >= m.watchAfter
		return (
			m.evidence !== "carrier" ||
			(this.retryLock === 0 &&
				(m.suspect || this.now() >= m.restUntil) &&
				this.budgetLeftMs() > 0)
		)
	}

	/**
	 * The strongest open, untried track to confirm; else (policy `hold`) the strongest analog voice
	 * to follow on air. A carrier waits for its retry budget (mayHold).
	 */
	private nextCandidate(): Candidate | null {
		if (this.spec.signalsOnly === true) return null
		const v = this.visit
		if (v === null) return null
		let best: Candidate | null = null
		const follow = this.spec.hold.policy === "hold"
		for (const [id, t] of v.tracks) {
			if (!t.open || t.tried || !this.mayHold(t)) continue
			const kind = t.needsConfirm
				? "confirm"
				: follow && t.followOnAir
					? "follow"
					: null
			if (kind === null) continue
			if (
				best === null ||
				(kind === "confirm" && best.kind === "follow") ||
				(kind === best.kind &&
					(t.snrDb > best.t.snrDb ||
						(t.snrDb === best.t.snrDb && id < best.id)))
			)
				best = { id, t, kind }
		}
		return best
	}

	private startHold(c: Candidate): SchedulerAction[] {
		const m = this.memoryOf(c.t)
		if (m?.evidence === "carrier") {
			this.retryLock = this.plan.hops.length
			// A carrier hold keeps the other hops waiting as a follow does: it spends the budget.
			if (this.visit !== null) this.visit.budgeted = true
		}
		if (c.kind === "confirm") return this.startProbe(c.id, c.t)
		c.t.tried = true
		this.startFollow(c.id, c.t, this.capFor(c.t, m))
		this.phase = "hold"
		return []
	}

	/** Holds `trackId` in follow mode up to `c.cap`. */
	private startFollow(
		trackId: string,
		t: TrackInfo,
		c: FollowCap,
		from = this.now(),
	): void {
		this.noteLong(c)
		if (c.budget === true && this.visit !== null) this.visit.budgeted = true
		this.hold = {
			trackId,
			mode: t.open ? "follow" : "hang",
			deadline: c.cap,
			cap: c.cap,
			watch: c.watch,
			decoded: false,
			from,
			runFrom: from,
		}
		if (!t.open) this.hold.deadline = this.hangDeadline(c.cap)
	}

	/**
	 * A follow allowed past one coarse sweep, or a watch that may run past it (CARRIER_WATCH_MS,
	 * CALL_RUN_MS): if the visit's holds do outlast one sweep, every hop gets a coarse visit before
	 * the next long follow (longHoldLock). A follow that spends the budget (voice on traffic) locks
	 * only once a hop waited L for such holds (endVisit): an over that ends sooner leaves the rest of L
	 * to the window, and its hop is followed again on its next visit.
	 */
	private noteLong(c: FollowCap): void {
		const v = this.visit
		if (v === null) return
		const sweepEnd = this.holdOrigin() + this.chainBudgetMs()
		if (c.watch) v.watched = true
		if ((c.long && c.budget !== true) || (c.watch && c.cap > sweepEnd))
			v.longFollow = true
	}

	/**
	 * Last clock a hold of `t` may follow it to, counted from the start of the visit's holds (S: one
	 * coarse sweep, chainBudgetMs; M: `hold.maxHoldMs`; N: CARRIER_WATCH_MS):
	 * - decoded (`decoded`): M (a long follow), or S while the long-hold lock holds;
	 * - analog voice under policy `hold` on traffic: what L has left (the other hops' waits)
	 *   (followBudgetMs, at most M), spending it; while the long-hold lock holds at most S of it,
	 *   and on the hop that set the lock the probe only; never under WIDEBAND_VOICE_ANSWER_MS (1500
	 *   ms) unless the hop still owes a sweep for its last voice hold: one hold of L elsewhere zeroes
	 *   the budget until every hop was visited, and a landing that leaves before the recorder can
	 *   answer never gets the voice hold keepForRecording would give it;
	 * - carrier evidence: min(S, N, what L has left), a watch;
	 * - traffic that is not voice: not followed (the probe only);
	 * - analog voice not known, whose onset a visit saw, watched once already in its run (and every
	 *   hop had a coarse visit since): to CALL_RUN_MS of its run, a watch;
	 * - anything else not known: N, a watch; under any other policy than `hold`, the probe only.
	 * A one-hop plan has no other hop to wait: M.
	 */
	private capFor(
		t: TrackInfo,
		m: FrequencyMemory | undefined,
		decoded = false,
	): FollowCap {
		const now = this.now()
		const long = this.maxHoldDeadline()
		const v = this.visit
		if (v === null || this.plan.hops.length < 2)
			return { cap: long, watch: false, long: false }
		const start = this.holdOrigin()
		const sweep = Math.min(long, start + this.chainBudgetMs())
		const locked = { cap: sweep, watch: false, long: false }
		if (decoded)
			return this.longHoldLock > 0
				? locked
				: { cap: long, watch: false, long: long > sweep }
		const evidence = m?.evidence ?? "unknown"
		// A carrier hold spends L (startHold): it runs only within what the window left of it.
		if (evidence === "carrier")
			return {
				cap: Math.min(
					sweep,
					start + CARRIER_WATCH_MS,
					start + this.followBudgetMs(),
				),
				watch: true,
				long: false,
			}
		const voice = t.followOnAir && this.spec.hold.policy === "hold"
		if (voice && evidence === "traffic") {
			// Under the lock the hop whose long hold set it is probed, not followed (lockedOut);
			// another is followed one coarse sweep at most, within what L has left (a hop that
			// already waited L for the others is not kept waiting longer).
			const budget = start + this.followBudgetMs()
			const floor = this.voiceLocked(v)
				? start
				: start + WIDEBAND_VOICE_ANSWER_MS
			if (this.longHoldLock > 0)
				return this.lockedOut(v.hopIndex)
					? { cap: now, watch: false, long: false }
					: {
							cap: Math.min(long, Math.max(floor, Math.min(sweep, budget))),
							watch: false,
							long: false,
							budget: true,
						}
			const cap = Math.min(long, Math.max(floor, budget))
			return { cap, watch: false, long: cap > sweep, budget: true }
		}
		if (evidence === "traffic" || this.spec.hold.policy !== "hold")
			return { cap: now, watch: false, long: false }
		// A call whose onset a visit saw, watched once already this run: followed on to CALL_RUN_MS
		// of its run (by then a carrier).
		if (
			voice &&
			m !== undefined &&
			m.onsetSeen &&
			m.watchAfter > 0 &&
			now < m.runFrom + CALL_RUN_MS
		)
			return {
				cap: Math.min(long, Math.max(start, m.runFrom + CALL_RUN_MS)),
				watch: true,
				long: false,
			}
		return {
			cap: Math.min(long, start + CARRIER_WATCH_MS),
			watch: true,
			long: false,
		}
	}

	/**
	 * One nominal coarse sweep: the sum of the hop dwells (holds left out), at most
	 * `hold.maxHoldMs`. A visit chains further confirm holds only within it, and a follow outlasts
	 * it only as capFor allows, so the other hops wait at most one extra sweep for a hop except
	 * during a long follow (at most `hold.maxHoldMs`, then a full coarse sweep before the next one)
	 * or a watch of a frequency not known (CARRIER_WATCH_MS, or to CALL_RUN_MS of its run after a
	 * coarse sweep for a call whose onset a visit saw).
	 */
	private chainBudgetMs(): number {
		let sum = 0
		for (const hop of this.plan.hops) sum += hop.dwellMs ?? this.spec.dwellMs
		return Math.min(this.spec.hold.maxHoldMs, sum)
	}

	/**
	 * L: longest a follow of analog voice on traffic (or a hold kept for a recording) may run from
	 * the start of the visit's holds, so that a 28 s ID on another hop that starts as the follow
	 * starts is still detected and heard: L = max(S, ID_MS − away − LONG_FOLLOW_MARGIN_MS), with S
	 * one coarse sweep (chainBudgetMs) and away the sweep away from a hop and back: every other
	 * hop's dwell, one revisit per three coarse hops, the settle of the return and minSurfaceBlocks
	 * + 1 blocks, (hops − 1 + ⌈hops / 3⌉) × (S / hops) + settle + (minSurfaceBlocks + 1) blocks.
	 * 1150 ms hops (1000 ms settle, 50 ms blocks): 3 hops away = 3 × 1150 + 1000 + 150 = 4600 ms,
	 * L = 28 000 − 4600 − 5000 = 18 400 ms; 7 hops away = 9 × 1150 + 1150 = 11 500 ms, L = 11 500
	 * ms; 2 hops L = 28 000 − 3450 − 5000 = 19 550 ms. Never past `hold.maxHoldMs` (capFor).
	 * A decoded follow is not cut to L (it runs to `hold.maxHoldMs`, as before).
	 */
	private longFollowMs(): number {
		const n = this.plan.hops.length
		const sweep = this.chainBudgetMs()
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		const away =
			(n - 1 + Math.ceil(n / 3)) * (sweep / n) +
			this.spec.settleMs +
			(this.minSurfaceBlocks + 1) * blockMs
		return Math.max(sweep, ID_MS - away - LONG_FOLLOW_MARGIN_MS)
	}

	/**
	 * L less the longest wait of another hop (HopState.waitMs): a budgeted hold's length. A busy hop
	 * followed on its coarse visit and again on a revisit spends one L for every hop not visited in
	 * between, so no hop waits more than L of such holds between two of its visits.
	 */
	private followBudgetMs(): number {
		return Math.max(0, this.longFollowMs() - this.longestWaitMs())
	}

	/** Longest HopState.waitMs of a hop other than the visit's. */
	private longestWaitMs(): number {
		const here = this.visit?.hopIndex
		let most = 0
		for (const [i, hop] of this.hops.entries())
			if (i !== here) most = Math.max(most, hop.waitMs)
		return most
	}

	/** A decoded follow of the visit that ran this long locks the next long follow out (longHoldLock). */
	private lockAfterMs(): number {
		return Math.min(this.longFollowMs(), this.spec.hold.maxHoldMs)
	}

	private startProbe(trackId: string, t: TrackInfo): SchedulerAction[] {
		const now = this.now()
		const holdMs = Math.max(
			0,
			Math.min(t.confirmHoldMs + this.probeStartMs, this.confirmEnd(t) - now),
		)
		t.tried = true
		this.hold = {
			trackId,
			mode: "confirm",
			deadline: now + holdMs,
			cap: now + holdMs,
			watch: false,
			decoded: false,
			from: now,
			runFrom: now,
		}
		this.phase = "hold"
		return [{ type: "start-probe", trackId, holdMs }]
	}

	/**
	 * Last clock a confirm hold of `t` starting now may run to: the end of one coarse sweep S
	 * (chainBudgetMs) from the start of the visit's holds, or the track's confirm window up to
	 * CONFIRM_FLOOR_MS (F) from now, whichever is later, and never past `hold.maxHoldMs` from the
	 * start of the holds. afterProbe chains a probe only within S, so a visit's confirm holds end
	 * at most S + F + probe start after they started (one probe: max(S, F + probe start)). A
	 * decoder that needs a longer window is probed again on the hop's later visits. Only analog
	 * voice that may be followed long (capFor) is probed past that, up to its follow cap; that hold
	 * is a long follow (it locks the next long follow out until every hop had a visit). A one-hop
	 * plan: up to `hold.maxHoldMs`.
	 */
	private confirmEnd(t: TrackInfo): number {
		const now = this.now()
		const long = this.maxHoldDeadline()
		const v = this.visit
		if (v === null || this.plan.hops.length < 2) return long
		const window =
			Math.min(t.confirmHoldMs, CONFIRM_FLOOR_MS) + this.probeStartMs
		const start = this.holdOrigin()
		const room =
			this.memoryOf(t)?.evidence === "carrier"
				? start + this.followBudgetMs()
				: Infinity
		const short = Math.min(
			long,
			room,
			Math.max(start + this.chainBudgetMs(), now + window),
		)
		if (
			now + t.confirmHoldMs + this.probeStartMs <= short ||
			!t.followOnAir ||
			this.spec.hold.policy !== "hold" ||
			this.spec.signalsOnly === true
		)
			return short
		const follow = this.capFor(t, this.memoryOf(t))
		if (!follow.long) return short
		if (follow.budget === true) v.budgeted = true
		else v.longFollow = true
		return follow.cap
	}

	/** A probe finished (confirmed without following, or timed out): next queued track or leave. */
	private afterProbe(): SchedulerAction[] {
		this.endHold(true)
		const stop: SchedulerAction[] = [{ type: "stop-probes" }]
		const next = this.nextCandidate()
		const now = this.now()
		const started = this.holdOrigin()
		if (
			next !== null &&
			now < this.maxHoldDeadline() &&
			now - started < this.chainBudgetMs()
		)
			return [...stop, ...this.startHold(next)]
		return this.leaveOrRecord(stop)
	}

	/**
	 * The confirm hold ran out without a decode. Analog voice still on air is followed (it has no
	 * decoder to confirm it), and a frequency not known as traffic is watched for carrier evidence
	 * (capFor); anything else ends like any probe.
	 */
	private confirmTimedOut(): SchedulerAction[] {
		const hold = this.hold
		const v = this.visit
		const probed = hold === null ? undefined : v?.tracks.get(hold.trackId)
		// The probed track, or a reopening of its frequency if it closed during the probe (a
		// repeater's next over).
		let id = hold?.trackId
		let t = probed
		if (v !== null && probed !== undefined && !probed.open)
			for (const [otherId, other] of v.tracks)
				if (
					other.open &&
					!other.tried &&
					!other.flagged &&
					sameFrequency(
						{ centreHz: probed.centreHz, halfWidthHz: probed.obwHz / 2 },
						other.centreHz,
						Math.max(SAME_FREQUENCY_FLOOR_HZ, other.obwHz / 2),
					)
				) {
					id = otherId
					t = other
					break
				}
		// A probe as short as its unlabelled class's, ended before the label could come: wait for it
		// once, as a dwell does (waitForClass), so a voice just passed is followed, not left.
		if (
			hold !== null &&
			v !== null &&
			t !== undefined &&
			this.classComing(v, t)
		) {
			const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
			v.classWait = true
			hold.cap = Math.min(
				this.maxHoldDeadline(),
				this.now() + (CLASS_SETTLE_BLOCKS - t.ageBlocks) * blockMs,
			)
			hold.deadline = hold.cap
			return []
		}
		// A probed track that closed during the probe, with no reopening yet, is held in its hang
		// (on a frequency not known as traffic, long enough to class the gap).
		if (
			hold !== null &&
			id !== undefined &&
			t !== undefined &&
			!t.flagged &&
			this.spec.signalsOnly !== true
		) {
			const c = this.capFor(t, this.memoryOf(t))
			if ((c.watch || t.followOnAir) && c.cap > this.now()) {
				t.tried = true
				this.startFollow(id, t, c, hold.from)
				return [{ type: "stop-probes" }]
			}
		}
		return this.afterProbe()
	}

	/**
	 * A probed track too young to be labelled that may yet read as analog voice (awaitsClass but for
	 * being tried), and the visit has not waited for a class: at most CLASS_SETTLE_BLOCKS − 1 blocks.
	 */
	private classComing(v: Visit, t: TrackInfo): boolean {
		return (
			!v.classWait &&
			t.open &&
			!t.flagged &&
			!t.followOnAir &&
			(t.voiceLater || t.qualified) &&
			t.ageBlocks < CLASS_SETTLE_BLOCKS &&
			this.spec.hold.policy === "hold" &&
			this.spec.signalsOnly !== true
		)
	}

	/**
	 * The hold ends. With `evidence`, what it heard counts: on air at its end without a break since
	 * it started (or since the last reopening) for CARRIER_WATCH_MS on a watch, or for
	 * `hold.maxHoldMs` on a follow that no decoder confirmed, is carrier evidence. A carrier's
	 * retry budget is charged RETRY_REST_FACTOR times the hold. With `voiceOnAir` the recording check
	 * just answered voice: the run is speech, so it marks no carrier, and a watch at its cap waits for
	 * a coarse sweep as a call's does.
	 */
	private endHold(evidence: boolean, voiceOnAir = false): void {
		const hold = this.hold
		this.hold = null
		// A recording hold brings no carrier evidence and charges no retry budget.
		if (hold === null || hold.mode === "record") return
		const now = this.now()
		const t = this.visit?.tracks.get(hold.trackId)
		const m = t === undefined ? undefined : this.memoryOf(t)
		if (m === undefined || t === undefined) return
		if (evidence && t.open && !hold.decoded) {
			// Traffic: a follow that heard it `hold.maxHoldMs` without a break. Not known, its onset
			// seen: it may be a call longer than a watch (a 28 s ID), so it is a carrier once its run
			// (heard by this and earlier holds and visits, with no close heard and no full visit
			// missing it) lasts `hold.maxHoldMs`. Anything else (not known, on air since before any
			// visit saw it, or a carrier): any hold, a watch or a long confirm probe, that heard it
			// CARRIER_WATCH_MS without a break.
			const sampled = m.evidence === "unknown" && m.onsetSeen
			const from = sampled ? Math.min(m.runFrom, hold.runFrom) : hold.runFrom
			const unbroken =
				m.evidence === "traffic" || sampled
					? this.spec.hold.maxHoldMs
					: CARRIER_WATCH_MS
			if (now - from >= unbroken && !voiceOnAir) this.markCarrier(m, false)
			else if ((sampled || voiceOnAir) && hold.watch && now >= hold.cap) {
				// Every hop gets a coarse visit before it is held again; no carrier hold lengthens
				// that sweep (a carrier's retry waits one sweep more).
				m.watchAfter = this.coarseVisits + this.plan.hops.length
				this.retryLock = Math.max(this.retryLock, this.plan.hops.length)
			}
		}
		// The committed track, voiced in none of the visit's checks, was held as a carrier watch: a
		// watch (FollowCap.watch) no decoder confirmed that ends with it on air, of a frequency with
		// carrier evidence and no verified voice history, or of one not known, its onset unseen, on
		// air without a break for CARRIER_WATCH_MS (the reading above, voice on air aside: a voice
		// heard beside it is what kept it from carrier evidence). A frequency whose onset a visit saw
		// keyed up like a call and is no carrier watch. The commitment, made for a neighbour's voice,
		// is tentative (Visit.voiceTentative).
		const v = this.visit
		if (
			v !== null &&
			v.voiceTrackId === hold.trackId &&
			!v.voiceTrackVoiced &&
			hold.watch &&
			!hold.decoded &&
			t.open &&
			((m.evidence === "carrier" && !m.voiced) ||
				(m.evidence === "unknown" &&
					!m.onsetSeen &&
					now - hold.runFrom >= CARRIER_WATCH_MS))
		)
			v.voiceTentative = true
		if (m.evidence === "carrier")
			m.restUntil = Math.max(
				m.restUntil,
				now +
					this.restFactor(m) *
						Math.max(0, now - hold.from) *
						(0.5 + spread(this.visitSerial)),
			)
	}

	/** K of a carrier's retry budget (RETRY_REST_FACTOR). */
	private restFactor(m: FrequencyMemory): number {
		if (m.flapRest) return FLAP_REST_FACTOR
		return m.wasTraffic || m.onsetSeen
			? KNOWN_CALL_REST_FACTOR
			: RETRY_REST_FACTOR
	}

	/**
	 * Last clock any hold of the visit may run to: `hold.maxHoldMs` from the start of its holds,
	 * and, once the visit kept its hop for a recording, the end of that hold's L budget
	 * (Visit.recordEndMs): a probe or follow started from a recording hold shares its window.
	 */
	private maxHoldDeadline(): number {
		const origin = this.holdOrigin()
		const end = this.visit?.recordEndMs ?? null
		return origin + Math.min(this.spec.hold.maxHoldMs, end ?? Infinity)
	}

	/**
	 * Clock the visit's holds count from: the start of the current epoch's holds (now if none ran
	 * yet) less what its earlier epochs held (Visit.heldBeforeMs).
	 */
	private holdOrigin(): number {
		const v = this.visit
		return (v?.holdStartedAt ?? this.now()) - (v?.heldBeforeMs ?? 0)
	}

	/** Ms the visit held up to `now`, across its epochs. */
	private heldMs(v: Visit, now: number): number {
		const current =
			v.holdStartedAt === null ? 0 : Math.max(0, now - v.holdStartedAt)
		return v.heldBeforeMs + current
	}

	/**
	 * Ms of L a hold starting now may still spend (followBudgetMs from the start of the visit's
	 * holds, less what they ran already): a carrier hold runs only within it.
	 */
	private budgetLeftMs(): number {
		return this.holdOrigin() + this.followBudgetMs() - this.now()
	}

	private leaveHop(prefix: SchedulerAction[]): SchedulerAction[] {
		const now = this.now()
		// Parked one-hop (R 1.1, 1.3): no tune, the sweep counts received samples.
		if (this.parkedVisit) return this.continueParked(prefix, now)
		const v = this.visit
		const wasRevisit = v?.revisit ?? false
		// Read before applyReplan: the centre this visit is tuned to under the plan it was tuned for.
		const fromCentre =
			v === null ? undefined : this.plan.hops[v.hopIndex]?.centreHz
		const carried = this.openTracks()
		const base = this.continuedBase()
		this.endVisit(now)
		this.applyReplan()
		const actions = [...prefix]
		if (!wasRevisit) {
			this.coarseIndex++
			this.coarseSinceRevisit++
		}
		if (this.coarseIndex >= this.plan.hops.length) {
			actions.push({ type: "sweep-complete", sweepIndex: this.sweepIndex })
			const period = now - this.sweepStartedAt
			this.sweepPeriodMs =
				this.sweepPeriodMs === null
					? period
					: (1 - SWEEP_PERIOD_ALPHA) * this.sweepPeriodMs +
						SWEEP_PERIOD_ALPHA * period
			this.lastCoverage = this.visited.size / this.plan.hops.length
			this.visited.clear()
			this.sweepIndex++
			this.coarseIndex = 0
			this.sweepStartedAt = now
		}
		const revisit = this.pickRevisit(now, wasRevisit)
		if (revisit !== null) this.coarseSinceRevisit = 0
		const target = revisit ?? this.coarseIndex
		// R 1.4: the picked hop is the one being visited (same centre, same gain): continue the
		// visit instead of re-tuning it.
		if (
			v !== null &&
			fromCentre !== undefined &&
			this.plan.hops[target]?.centreHz === fromCentre &&
			this.gainOf(target) === v.gainTenthsDb
		) {
			this.continueVisit(target, revisit !== null, carried, base, v)
			if (this.plan.hops.length === 1) this.parkIfOneHop()
			return actions
		}
		return [...actions, ...this.tuneTo(target, revisit !== null)]
	}

	private gainOf(hopIndex: number): number | null {
		return this.hops[hopIndex]?.gainTenthsDb ?? this.spec.tuner.gainTenthsDb
	}

	private currentDwellMs(): number {
		const current = this.visit?.hopIndex ?? 0
		return this.plan.hops[current]?.dwellMs ?? this.spec.dwellMs
	}

	/** Open tracks of the visit, with their tried flags: a continued window keeps them (R 1.4, 1.5). */
	private openTracks(): Map<string, TrackInfo> {
		const out = new Map<string, TrackInfo>()
		for (const [id, t] of this.visit?.tracks ?? []) if (t.open) out.set(id, t)
		return out
	}

	/** Sample a continued visit's next dwell is measured from. */
	private continuedBase(): number {
		return Math.max(this.visit?.dwellEnd ?? 0, this.lastBlockEnd ?? 0)
	}

	/** A new visit record on the tuned window, without a tune action. */
	private continueVisit(
		hopIndex: number,
		revisit: boolean,
		tracks: Map<string, TrackInfo>,
		base: number,
		from: Visit,
	): void {
		for (const t of tracks.values()) t.openBlocks = 0
		this.visit = this.newVisit(hopIndex, revisit, tracks, from.gainTenthsDb)
		this.visit.dwellEnd = base + this.dwellSamples(true)
		// No tune, no settle: the window was already listening.
		this.visit.clock.kind = "dwell"
		this.hold = null
		this.phase = "dwell"
	}

	/** Parks when the visit settled on a one-hop plan with no replan pending (R 1.1). */
	private parkIfOneHop(): void {
		if (
			this.parkedVisit ||
			this.plan.hops.length !== 1 ||
			this.pendingReplan !== null
		)
			return
		this.parkedVisit = true
		this.parkedSweepSamples = 0
		this.sweepPeriodMs = null
	}

	/** Leaves the park without a tune; sweep timing restarts (the park had no sweep period). */
	private unpark(): void {
		this.parkedVisit = false
		this.parkedSweepSamples = 0
		this.sweepPeriodMs = null
		this.sweepStartedAt = this.now()
		this.lastCoverage = null
		this.visited.clear()
	}

	/** Same centre, sample rate and gain: the parked window stays as it is. */
	private keepsPark(plan: HopPlan, spec: NormalisedJobSpec): boolean {
		const v = this.visit
		if (v === null || this.phase === "idle" || this.phase === "tuning")
			return false
		return (
			plan.hops[0]?.centreHz === this.plan.hops[v.hopIndex]?.centreHz &&
			spec.tuner.sampleRateHz === this.spec.tuner.sampleRateHz &&
			spec.tuner.gainTenthsDb === this.spec.tuner.gainTenthsDb
		)
	}

	/** A parked one-hop plan moved. Ends an open hold, leaves the park, and tunes once. */
	private leaveParkFor(
		plan: HopPlan,
		spec: NormalisedJobSpec,
	): SchedulerAction[] {
		const prefix: SchedulerAction[] =
			this.phase === "hold" ? [{ type: "stop-probes" }] : []
		this.endVisit(this.now())
		this.unpark()
		this.pendingReplan = null
		this.plan = plan
		this.spec = spec
		this.hops = [this.freshHop(plan.hops[0])]
		this.coarseIndex = 0
		this.coarseSinceRevisit = 0
		return [...prefix, ...this.tuneTo(0, false)]
	}

	/**
	 * Parked leave: ends the visit's accounting and continues on hop 0 without a tune.
	 * Sweep counts come from received blocks. A gain the overload
	 * rule changed must reach the tuner, so that case re-tunes (today's write path).
	 */
	private continueParked(
		prefix: SchedulerAction[],
		now: number,
	): SchedulerAction[] {
		const v = this.visit
		const carried = this.openTracks()
		const base = this.continuedBase()
		this.endVisit(now)
		const actions = [...prefix]
		this.coarseIndex = 0
		if (v === null || this.gainOf(0) !== v.gainTenthsDb)
			return [...actions, ...this.tuneTo(0, false)]
		this.continueVisit(0, false, carried, base, v)
		return actions
	}

	private endVisit(now: number): void {
		const accountedAt = this.accountingPausedAt ?? now
		const v = this.visit
		this.endHold(true)
		if (v === null) return
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		// Paused time is neither heard nor held: the evidence below stops where the pause began.
		this.noteHeardGaps(v, accountedAt)
		this.noteFlapListening(v, accountedAt)
		hop.visits++
		hop.timeMs += Math.max(0, accountedAt - v.startedAt - this.visitPausedMs)
		this.closePhase(v, accountedAt)
		addPhases(hop.phases, v.clock)
		const heldMs = this.heldMs(v, accountedAt)
		hop.holdMs += this.accountedHeldMs(v, accountedAt)
		// The other hops waited for this visit's long or budgeted holds (followBudgetMs); this hop
		// was visited.
		if (v.budgeted || v.longFollow || v.watched)
			for (const [i, other] of this.hops.entries())
				if (i !== v.hopIndex) other.waitMs += heldMs
		hop.waitMs = 0
		if (!v.revisit)
			for (const h of this.hops) {
				h.voiceLock.delete(v.hopIndex)
				h.revisitLock.delete(v.hopIndex)
			}
		const voiceHeld = v.voice !== "no"
		// A follow that heard a squelch close with no session to name it owes the same visits
		// before the hop's next voice hold (Visit.voiceBarred), without the long-hold lock. So does
		// a visit that leaves while the voiced transmission an analog hold heard is still on air
		// (Visit.heardVoiceId with no voice hold: its end would have spent one), say a hold cut at L
		// with that transmission evicted from its recorder slot: one transmission, then the sweep,
		// with no activity revisit holding it again meanwhile (pickRevisit). Only when the visit
		// could have held it (Visit.heardVoiceHoldable): a visit barred from that voice hold (the
		// revisit right after a carrier watch of the hop, a kerchunk before an ID) recorded none of
		// it, so the hop's next coarse landing may hold it whole; only activity revisits wait for the
		// sweep (HopState.revisitLock).
		if (
			voiceHeld ||
			v.voiceBarred ||
			(v.heardVoiceId !== null && v.heardVoiceHoldable)
		) {
			hop.voiceLock = HopBits.allBut(this.plan.hops.length, v.hopIndex)
		} else if (v.heardVoiceId !== null)
			hop.revisitLock = HopBits.allBut(this.plan.hops.length, v.hopIndex)
		// A long hold that used more than one coarse sweep, a decoded follow that ran to L, or
		// budgeted holds that kept a hop waiting L (lockAfterMs), or a voice hold (Visit.voice):
		// every hop gets a coarse visit before the next long follow, and the hop is probed, not
		// followed, until then (capFor). A decoded call that ended sooner locks nothing.
		if (
			(v.longFollow && heldMs > this.chainBudgetMs()) ||
			(v.longDecoded && heldMs >= this.lockAfterMs()) ||
			(v.budgeted && this.longestWaitMs() >= this.lockAfterMs()) ||
			voiceHeld
		) {
			// A voice hold owes the other hops their visits (HopState.voiceLock); any other long hold
			// locks the hop's next coarse visit too.
			this.longHoldLock = this.plan.hops.length - (voiceHeld ? 1 : 0)
			this.lockHop = v.hopIndex
			// No carrier hold lengthens the sweep after it either (as after a watch, endHold).
			this.retryLock = Math.max(this.retryLock, this.plan.hops.length)
		} else if (!v.revisit && this.longHoldLock > 0) this.longHoldLock--
		if (!v.revisit && this.retryLock > 0) this.retryLock--
		if (!v.revisit) this.coarseVisits++
		// Spurs, and carriers on air since before any visit saw them start, are no activity: they never need a revisit.
		let openBlocks = 0
		for (const t of v.tracks.values()) {
			if (t.flagged) continue
			const m = this.memoryOf(t)
			if (m?.evidence === "carrier" && !m.onsetSeen) continue
			openBlocks = Math.max(openBlocks, t.openBlocks)
		}
		// A full dwell hears everything on air for minSurfaceBlocks blocks: misses are counted in
		// such visits only. A frequency they keep missing is forgotten, its evidence and retry
		// budget with it: a carrier resting is still heard by the visits it rests through.
		if (v.blocks >= this.minSurfaceBlocks + 1) {
			hop.fullVisits++
			let forgotten = false
			for (const m of this.memory)
				if (this.covers(v.hopIndex, m)) {
					m.misses = this.heardOn(m, v) ? 0 : m.misses + 1
					if (m.misses >= FORGET_MISSES) {
						this.unindexMemory(m)
						forgotten = true
					}
				}
			if (forgotten)
				this.memory = this.memory.filter(m => m.misses < FORGET_MISSES)
		}
		const active = v.blocks > 0 ? Math.min(1, openBlocks / v.blocks) : 0
		// A carrier that showed itself on this visit explained the hop's past score: restart it.
		if (hop.scoreAt === null || v.newlyQuiet) hop.activityScore = active
		else {
			const keep = 2 ** (-(now - hop.scoreAt) / ACTIVITY_HALF_LIFE_MS)
			hop.activityScore = keep * hop.activityScore + (1 - keep) * active
		}
		hop.scoreAt = now
		hop.lastVisit = now
		const jobGain = this.spec.tuner.gainTenthsDb
		if (
			this.spec.tuner.overload === "reduce-gain" &&
			jobGain !== null &&
			hop.gainTenthsDb !== null
		) {
			if (v.overloaded) {
				hop.gainTenthsDb = Math.max(0, hop.gainTenthsDb - GAIN_STEP_TENTHS)
				hop.cleanVisits = 0
			} else if (hop.gainTenthsDb < jobGain) {
				hop.cleanVisits++
				if (hop.cleanVisits >= CLEAN_VISITS_TO_RAISE) {
					hop.gainTenthsDb = Math.min(
						jobGain,
						hop.gainTenthsDb + GAIN_STEP_TENTHS,
					)
					hop.cleanVisits = 0
				}
			}
		}
		this.visit = null
		this.visitPausedMs = 0
		this.heldAccountingFloorMs = null
		this.heldAccountingOffsetMs = 0
	}

	/**
	 * Gaps of TRAFFIC_GAP_MS the visit heard without a reopening: a frequency of the hop that closed
	 * and stayed off that long up to the end of the visit, or that the visit did not hear at all
	 * while it listened that long, is traffic.
	 */
	private noteHeardGaps(v: Visit, now: number): void {
		const listened = this.listenedMs(v) >= TRAFFIC_GAP_MS
		for (const m of this.memory) {
			if (m.evidence === "traffic" || !this.covers(v.hopIndex, m)) continue
			const closed = m.closedAt
			if (
				(closed !== null &&
					closed.visit === v.serial &&
					now - closed.at >= TRAFFIC_GAP_MS) ||
				(!this.heardOn(m, v) && listened)
			)
				this.markTraffic(m)
		}
	}

	/**
	 * Adds the visit's held time (from the start of its holds, or the flap) to each flapped
	 * frequency of its hop (flapPairMs). Dwells without a hold add nothing.
	 */
	private noteFlapListening(v: Visit, now: number): void {
		if (v.holdStartedAt === null) return
		const from = v.holdStartedAt
		for (const m of this.memory)
			if (m.flapAt !== null && this.covers(v.hopIndex, m))
				m.flapListenMs += Math.max(0, now - Math.max(from, m.flapAt))
	}

	/**
	 * A short reopening (a close and reopen less than TRAFFIC_GAP_MS apart) is a flap: carrier
	 * evidence. On a frequency known as a call (it was traffic, or a visit saw its onset) it earns
	 * FLAP_REST_FACTOR only when another flap was heard at most this long before, with no
	 * turnaround heard in between (traffic evidence forgets the earlier flap). The time counted is
	 * the held time of the earlier visits of its hops since that flap (noteFlapListening) and the
	 * current visit from its tune. A carrier flapping with a period P shorter than its holds (P <
	 * H = min(one coarse sweep, CARRIER_WATCH_MS)) flaps in every hold: after the flap of one hold,
	 * that hold listens less than P (plus a hang classing a gap, TRAFFIC_GAP_MS + one block) before
	 * it ends, and its next hold hears the next flap less than P after the dwell (spec.dwellMs, plus
	 * a wait of CLASS_SETTLE_BLOCKS blocks for its class) that starts it. So the window is 2 H +
	 * TRAFFIC_GAP_MS + (1 + CLASS_SETTLE_BLOCKS) blocks + spec.dwellMs: such a carrier earns the
	 * rest from its second flap (1150 ms hops, 50 ms blocks: 3 hops 2 × 3450 + 1300 + 1150 = 9350
	 * ms, 7 hops 2 × 8000 + 1300 + 1150 = 18 450 ms), while a QSO with one quick turnaround (0.3
	 * to 0.9 s) rests KNOWN_CALL_REST_FACTOR, not twenty times its hold. An emitter never known as
	 * a call (on air since before any visit saw it start, no turnaround heard) earns it from its
	 * first flap.
	 */
	private flapPairMs(): number {
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		const held = Math.min(this.chainBudgetMs(), CARRIER_WATCH_MS)
		return (
			2 * held +
			TRAFFIC_GAP_MS +
			(1 + CLASS_SETTLE_BLOCKS) * blockMs +
			this.spec.dwellMs
		)
	}

	private pickRevisit(now: number, lastWasRevisit: boolean): number | null {
		if (this.plan.hops.length < 2) return null
		const next = this.coarseIndex
		const maxInterval = this.spec.revisit.maxIntervalMs
		if (maxInterval !== null && !lastWasRevisit) {
			let overdue: number | null = null
			let overdueAge = maxInterval
			for (const [i, hop] of this.hops.entries()) {
				if (i === next || hop.lastVisit === null) continue
				const age = now - hop.lastVisit
				if (age > overdueAge) {
					overdue = i
					overdueAge = age
				}
			}
			if (overdue !== null) return overdue
		}
		const share = this.spec.revisit.share
		if (
			share <= 0 ||
			this.coarseSinceRevisit < Math.max(1, Math.round(1 / share))
		)
			return null
		let best: number | null = null
		let bestScore = 0
		for (const [i, hop] of this.hops.entries()) {
			if (
				i === next ||
				hop.lastVisit === null ||
				hop.voiceLock.size > 0 ||
				hop.revisitLock.size > 0
			)
				continue
			const score =
				hop.activityScore *
				(hop.boost ? CANDIDATE_BOOST : 1) *
				(now - hop.lastVisit)
			if (score > bestScore) {
				best = i
				bestScore = score
			}
		}
		return best
	}

	/** The hop whose long hold set the long-hold lock, while it holds (lockHop). */
	private lockedOut(hopIndex: number): boolean {
		return this.longHoldLock > 0 && this.lockHop === hopIndex
	}

	private applyReplan(): void {
		const pending = this.pendingReplan
		if (pending === null) return
		this.pendingReplan = null
		const old = this.plan
		const oldCoarseCentre =
			old.hops[Math.min(this.coarseIndex, old.hops.length - 1)]?.centreHz ?? 0
		// An old hop's accounting (visits, time, holds) moves to the first new hop mapped to it; a
		// second one starts at zero so totals are not counted twice. Frequency memory is kept by
		// frequency, whatever the hops.
		const accounted = new Set<number>()
		const nearestOld = nearestHopIn(old)
		const nearestNew = nearestHopIn(pending.plan)
		const mapped = pending.plan.hops.map((hop): HopState | null => {
			const i = nearestOld(hop.centreHz)
			const prev = this.hops[i]
			const near =
				Math.abs((old.hops[i]?.centreHz ?? Number.NaN) - hop.centreHz) <=
				pending.plan.usableHalfSpanHz
			if (prev === undefined || !near) return null
			const first = !accounted.has(i)
			accounted.add(i)
			return {
				...prev,
				visits: first ? prev.visits : 0,
				timeMs: first ? prev.timeMs : 0,
				holdMs: first ? prev.holdMs : 0,
				phases: first ? prev.phases : emptyPhases(),
			}
		})
		const visited = new Set<number>()
		for (const i of this.visited) {
			const centre = old.hops[i]?.centreHz
			if (centre !== undefined) visited.add(nearestNew(centre))
		}
		const oldHops = this.hops
		this.plan = pending.plan
		this.spec = pending.spec
		this.hops = mapped.map(
			(state, i) => state ?? this.freshHop(pending.plan.hops[i]),
		)
		const spans = old.hops.map(hop => hop.covered)
		const nextSpans = pending.plan.hops.map(hop => hop.covered)
		const { locks } = carryVoiceLocks(
			spans,
			oldHops.map(hop => hop.voiceLock),
			nextSpans,
		)
		const { locks: revisitLocks } = carryVoiceLocks(
			spans,
			oldHops.map(hop => hop.revisitLock),
			nextSpans,
		)
		for (const [i, hop] of this.hops.entries()) {
			hop.voiceLock = locks[i] ?? NO_HOPS
			hop.revisitLock = revisitLocks[i] ?? NO_HOPS
		}
		this.visited = visited
		this.lockHop = null
		this.coarseIndex = nearestNew(oldCoarseCentre)
		this.boundMemory()
	}
}
