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
 */
import { WaveKitError } from "../../utils/errors.js"
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
 * Off-air time that proves traffic. A gap is read from the close (the end of the first block off
 * air) to the sighting of the reopening (minSurfaceBlocks blocks after it went on air), so a gap of
 * g ms reads g + 50 ms ± one block in 50 ms blocks: a QSO turnaround (1 s or more) reads 1000 ms or
 * more, a carrier flapping with gaps of up to 0.9 s reads less. A close and reopen heard less than
 * this apart is a flap: carrier evidence.
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
/** Re-check period of a hold kept for a recording (Hold mode `record`): 5 blocks of 50 ms. */
const RECORD_RECHECK_MS = 250

/**
 * What the recording check (`recordingActive`) reports for the tuned window: false, nothing is
 * recorded; true, a recording runs (the hop is kept within L, keepForRecording); "voice", a
 * recording of analog voice that sounded like voice runs (classed analog, voiced, still open): the
 * hop is kept up to `hold.maxHoldMs`, like a decoded follow, so a 28 s ID is recorded whole.
 */
export type RecordingActivity = boolean | "voice"
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
 * A track of at most 4 blocks is classed as a burst whatever it is (classifySpectral), so analog
 * voice can only be labelled from its 5th block: a dwell that ends with a younger unlabelled track
 * whose spectrum reads as analog voice (TrackHints.voiceLater) waits for it once, at most
 * CLASS_SETTLE_BLOCKS − 1 = 4 more blocks (200 ms in 50 ms blocks).
 */
const CLASS_SETTLE_BLOCKS = 5
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
 *   sweep, each at most one coarse sweep and at most CARRIER_WATCH_MS. A dwell that misses one that
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
	/** Full visits in a row, of hops whose span holds it, that did not hear it. */
	misses: number
	/**
	 * Its last track closed with no other track of the visit on it: visit, block count and clock
	 * of the close. A sighting in the same block is a rollover of the same transmission.
	 */
	closedAt: { visit: number; block: number; at: number } | null
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
	/**
	 * Ms this hop has waited since its last visit for other hops' visits that watched, held past one
	 * coarse sweep or spent the follow budget (Visit.watched, longFollow, budgeted): they share L
	 * (followBudgetMs), so no hop waits more than L for them between two of its visits.
	 */
	waitMs: number
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
	/** A carrier on air since before any visit saw it start showed itself: the hop's past score was it. */
	newlyQuiet: boolean
}

/** Per-hop accounting: share of time, holds and the age of the last visit. */
export interface HopStat {
	hopIndex: number
	visits: number
	timeMs: number
	holdMs: number
	lastVisitAgeMs: number | null
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

function nearestHop(plan: HopPlan, centreHz: number): number {
	let best = 0
	let bestDist = Number.POSITIVE_INFINITY
	plan.hops.forEach((hop, i) => {
		const dist = Math.abs(hop.centreHz - centreHz)
		if (dist < bestDist) {
			best = i
			bestDist = dist
		}
	})
	return best
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
	 * Hop whose long hold set the long-hold lock. While the lock holds, voice on traffic there is
	 * probed, not followed (capFor): a busy hop is visited again before the lock clears (its own
	 * coarse visit, and revisits), and a follow of one coarse sweep on each of those visits (8050
	 * ms on 7 hops of 1150 ms) would keep the other hops waiting past a 28 s ID after the follow.
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
			 * True (or "voice") while the window the scheduler is tuned to is being recorded (the
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
		const actions: SchedulerAction[] =
			this.phase === "hold" ? [{ type: "stop-probes" }] : []
		this.endHold(false)
		this.lastBlockEnd = startSample
		v.dwellEnd = startSample + this.dwellSamples(this.parkedVisit)
		v.tracks.clear()
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
		if (
			this.phase === "dwell" &&
			v.dwellEnd !== null &&
			endSample >= v.dwellEnd
		)
			return [...actions, ...this.decide()]
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
		for (const t of v.tracks.values()) if (t.open) t.openBlocks += count - 1
		this.lastBlockEnd = before
		return this.onBlock(endSample)
	}

	onStale(blocks: number): void {
		if (
			this.phase === "dwell" &&
			this.visit !== null &&
			this.visit.dwellEnd !== null
		)
			this.visit.dwellEnd += blocks * this.blockSamples
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
			})
		} else {
			known.snrDb = track.snrDb
			known.centreHz = track.centreHz
			known.obwHz = track.obwHz
			known.open = true
			if (flagged) known.needsConfirm = false
			else known.needsConfirm ||= needsConfirm
			known.followOnAir = followOnAir
			known.voiceLater = voiceLater
			known.flagged ||= flagged
			known.ageBlocks = Math.max(known.ageBlocks, track.blocks)
			known.confirmHoldMs = Math.max(known.confirmHoldMs, confirmHoldMs)
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
		const active = this.recordingActive?.() ?? false
		if (now >= hold.cap || active === false) return this.leaveHop([])
		const next = this.nextCandidate()
		if (next !== null) {
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
	 * starts now if no hold ran. A recording of voice ("voice": classed analog, voiced, still open)
	 * is kept as a decoded follow is: up to `hold.maxHoldMs` whatever L has left, so a 28 s ID is
	 * recorded whole; past one coarse sweep it locks the next long follow out (endVisit), and once
	 * the other hops waited L (lockAfterMs) too. A recording that is not voice (true) keeps L. Not while the long-hold lock holds, while parked (a parked hop is
	 * never left), on a one-hop plan, for a signals-only job or under `hold.policy: "never"`. A
	 * hold that ran past one coarse sweep locks the next long follow out (endVisit). The held
	 * frequency's evidence is charged as on any leave; the `record` hold itself brings none. Never
	 * when every frequency the recording can be of has carrier evidence (recordedTrack).
	 */
	private keepForRecording(): boolean {
		const v = this.visit
		if (
			this.recordingActive === undefined ||
			v === null ||
			this.parkedVisit ||
			this.longHoldLock > 0 ||
			this.plan.hops.length < 2 ||
			this.spec.signalsOnly === true ||
			this.spec.hold.policy === "never"
		)
			return false
		const now = this.now()
		const start = this.holdOrigin()
		const active = this.recordingActive()
		if (active === false) return false
		const cap =
			active === "voice"
				? start + this.spec.hold.maxHoldMs
				: Math.min(
						start + this.spec.hold.maxHoldMs,
						start + this.followBudgetMs(),
					)
		if (now >= cap) return false
		const heldId = this.hold?.trackId
		// Charged first, so a hold that just heard a carrier counts. A recording only of frequencies
		// with carrier evidence is held under the carrier rules only: keeping its hop for it would
		// hold them on every visit again.
		this.endHold(true)
		const trackId = this.recordedTrack(heldId)
		if (trackId === null) return false
		v.holdStartedAt ??= now
		v.budgeted = true
		v.recordEndMs = cap - start
		this.noteLong({
			cap,
			watch: false,
			long: cap > start + this.chainBudgetMs(),
		})
		this.hold = {
			trackId,
			mode: "record",
			deadline: Math.min(cap, now + RECORD_RECHECK_MS),
			cap,
			watch: false,
			decoded: false,
			from: now,
			runFrom: now,
		}
		this.phase = "hold"
		return true
	}

	/**
	 * Track a `record` hold reports (progress `holdingOn`), or null when the recording can only be of
	 * frequencies with carrier evidence. recordingActive names the window, not the frequency, so
	 * every open analog voice of the visit is a candidate: null when each has carrier evidence, else
	 * the track just held if it is one without, else the strongest without. With no open analog
	 * voice: the track just held if it is still open, else the visit's strongest open track (null
	 * when it has carrier evidence); "" when none is open.
	 */
	private recordedTrack(heldId: string | undefined): string | null {
		const v = this.visit
		if (v === null) return ""
		const carrier = (t: TrackInfo): boolean =>
			this.memoryOf(t)?.evidence === "carrier"
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
		if (held?.open === true) return carrier(held) ? null : (heldId ?? "")
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

	/** Per-hop accounting under the current plan; the visit in progress counts up to `now`. */
	hopStats(): HopStat[] {
		const now = this.now()
		const v = this.visit
		return this.hops.map((hop, hopIndex) => {
			const current = v !== null && v.hopIndex === hopIndex
			const held = current ? this.heldMs(v, now) : 0
			return {
				hopIndex,
				visits: hop.visits + (current ? 1 : 0),
				timeMs: hop.timeMs + (current ? now - v.startedAt : 0),
				holdMs: hop.holdMs + held,
				lastVisitAgeMs: current
					? 0
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
			waitMs: 0,
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
				// New on a hop that already had a full visit: that visit missed it.
				onsetSeen: (this.hops[v.hopIndex]?.fullVisits ?? 0) >= 1,
				restUntil: 0,
				suspect: false,
				runFrom: now,
				watchAfter: 0,
				seenVisit: v.serial,
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
				if (now - closed.at >= TRAFFIC_GAP_MS) this.markTraffic(entry)
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
		memory.closedAt = { visit: v.serial, block: v.blocks, at: this.now() }
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
			startedAt: this.now(),
			serial: ++this.visitSerial,
			epochBlock: 0,
			classWait: false,
			gapWait: false,
			longFollow: false,
			longDecoded: false,
			budgeted: false,
			watched: false,
			recordEndMs: null,
			newlyQuiet: false,
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
				v.holdStartedAt = this.now()
				return this.startHold(next)
			}
			if (this.waitForClass(v)) return []
			if (this.listenForGap(v)) return []
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
				m.seenVisit !== v.serial &&
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
	 * label that arrives with its 5th block can still start a follow. Only a track whose spectrum
	 * reads as analog voice (`voiceLater`) is waited for; any other young burst leaves at the dwell.
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
			if (
				t.open &&
				!t.tried &&
				this.mayHold(t) &&
				!t.followOnAir &&
				t.voiceLater &&
				t.ageBlocks < CLASS_SETTLE_BLOCKS
			)
				need = Math.max(need, CLASS_SETTLE_BLOCKS - t.ageBlocks)
		if (need === 0) return false
		v.classWait = true
		v.dwellEnd += need * this.blockSamples
		return true
	}

	/**
	 * Not flagged, and, with carrier evidence, its retry budget has
	 * refilled and no other carrier hold ran in this coarse sweep.
	 */
	private mayHold(t: TrackInfo): boolean {
		if (t.flagged) return false
		const m = this.memoryOf(t)
		if (m === undefined) return true
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
	 *   and on the hop that set the lock the probe only;
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
			const cap = Math.min(long, start + this.followBudgetMs())
			if (this.longHoldLock > 0)
				return this.lockedOut(v.hopIndex)
					? { cap: now, watch: false, long: false }
					: {
							cap: Math.min(sweep, cap),
							watch: false,
							long: false,
							budget: true,
						}
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
	 * The hold ends. With `evidence`, what it heard counts: on air at its end without a break since
	 * it started (or since the last reopening) for CARRIER_WATCH_MS on a watch, or for
	 * `hold.maxHoldMs` on a follow that no decoder confirmed, is carrier evidence. A carrier's
	 * retry budget is charged RETRY_REST_FACTOR times the hold.
	 */
	private endHold(evidence: boolean): void {
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
			if (now - from >= unbroken) this.markCarrier(m, false)
			else if (sampled && hold.watch && now >= hold.cap) {
				// Every hop gets a coarse visit before it is held again; no carrier hold lengthens
				// that sweep (a carrier's retry waits one sweep more).
				m.watchAfter = this.coarseVisits + this.plan.hops.length
				this.retryLock = Math.max(this.retryLock, this.plan.hops.length)
			}
		}
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
		const v = this.visit
		this.endHold(true)
		if (v === null) return
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		this.noteHeardGaps(v, now)
		this.noteFlapListening(v, now)
		hop.visits++
		hop.timeMs += Math.max(0, now - v.startedAt)
		const heldMs = this.heldMs(v, now)
		hop.holdMs += heldMs
		// The other hops waited for this visit's long or budgeted holds (followBudgetMs); this hop
		// was visited.
		if (v.budgeted || v.longFollow || v.watched)
			for (const [i, other] of this.hops.entries())
				if (i !== v.hopIndex) other.waitMs += heldMs
		hop.waitMs = 0
		// A long hold that used more than one coarse sweep, a decoded follow that ran to L, or
		// budgeted holds that kept a hop waiting L (lockAfterMs): every hop gets a coarse visit
		// before the next long follow, and the hop is probed, not followed, until then (capFor). A
		// decoded call that ended sooner locks nothing.
		if (
			(v.longFollow && heldMs > this.chainBudgetMs()) ||
			(v.longDecoded && heldMs >= this.lockAfterMs()) ||
			(v.budgeted && this.longestWaitMs() >= this.lockAfterMs())
		) {
			this.longHoldLock = this.plan.hops.length
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
					m.misses = m.seenVisit === v.serial ? 0 : m.misses + 1
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
				(m.seenVisit !== v.serial && listened)
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
			if (i === next || hop.lastVisit === null) continue
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
		const mapped = pending.plan.hops.map((hop): HopState | null => {
			const i = nearestHop(old, hop.centreHz)
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
			}
		})
		const visited = new Set<number>()
		for (const i of this.visited) {
			const centre = old.hops[i]?.centreHz
			if (centre !== undefined) visited.add(nearestHop(pending.plan, centre))
		}
		this.plan = pending.plan
		this.spec = pending.spec
		this.hops = mapped.map(
			(state, i) => state ?? this.freshHop(pending.plan.hops[i]),
		)
		this.visited = visited
		this.lockHop = null
		this.coarseIndex = nearestHop(pending.plan, oldCoarseCentre)
		this.boundMemory()
	}
}
