// src/core/scanner/scheduler.ts
/**
 * Sweep scheduler (spec § 10.2): ascending coarse hops, dwell measured in samples from the settled
 * epoch start, holds for confirmation and following, activity-weighted revisits, per-hop gain
 * memory, and re-plans applied at hop boundaries. Pure: the job runner feeds events and executes
 * the returned actions.
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
 * Frequencies remembered per hop. A hop spans at most 3.2 Msps × 0.8 = 2.56 MHz, which is 205
 * 12.5 kHz channels; 256 covers every channel of the widest hop, so a full hop never evicts a
 * frequency it hears (frequencies no longer heard go first).
 */
const MAX_FREQUENCY_MEMORY = 256
/**
 * A track that first opens on a visit after it has received minSurfaceBlocks + LATE_OPEN_BLOCKS
 * blocks was off air at the start of the visit: anything on air from the first block surfaces after
 * minSurfaceBlocks blocks, plus one block for the order of track and block events.
 */
const LATE_OPEN_BLOCKS = 2
/**
 * Presence: share of a hop's recent full visits that heard a frequency, an average with weight 1/4
 * per visit. At PERSISTENT_PRESENCE (1/2) or more it is persistent: a gap nobody heard (it was
 * missed by a visit, or closed and reopened while the hop was away) is presumed short, the same
 * emission. From 0, three visits that hear it make it persistent (1 − (3/4)³ ≈ 0.58); from 1,
 * three full visits that miss it end that ((3/4)³ ≈ 0.42), two do not ((3/4)² ≈ 0.56).
 */
const PRESENCE_WEIGHT = 0.25
const PERSISTENT_PRESENCE = 0.5
/**
 * Full visits of a hop that must have missed a new frequency before its onset counts as seen: the
 * same three missed visits that end persistence. Fewer, and a flapping carrier that was off for
 * one or two dwells would pass for a new transmission.
 */
const ONSET_EVIDENCE_VISITS = 3
/** A frequency no longer heard is forgotten below this presence (at least 10 missed visits from 1). */
const FORGET_PRESENCE = 0.05
/**
 * Retry budget per frequency that is not known as traffic. Each hold that bars it (or its turning
 * steady) charges its bucket, and the bucket drains 1 ms per FOLLOW_BUDGET_WINDOWS ms; once it has
 * drained the frequency is held again (a hold of at most ONSET_UNSEEN_FOLLOW_MS), at most one such
 * retry per coarse sweep (retryLock). The k-th charge in a row is RETRY_CHARGE_MS × 2^(k − 1), at
 * most `hold.maxHoldMs`: 8, 16, 32, then 60 s with the 60 s default, so retries at least 40, 80,
 * 160, then 300 s after the end of the previous hold. A QSO on air since the job started is
 * listened to again soon and a turnaround gap (TRAFFIC_GAP_MS) is heard; a carrier on air from the
 * start of a 3-hop plan of 1150 ms hops (holds of one 3450 ms sweep) is held at 0 s and then no
 * earlier than 43, 127 and 290 s (4 holds in its first 5 minutes), then once per 5 minutes.
 */
const FOLLOW_BUDGET_WINDOWS = 5
const RETRY_CHARGE_MS = 8_000
/**
 * Off-air time that proves traffic: a frequency heard off air for at least this long (a close and a
 * reopen, a close and the end of the visit, a late open, or a visit that listened this long without
 * hearing it) is traffic, not a carrier. A gap is measured from the close (the first block heard
 * off air) to the sighting of the reopening (minSurfaceBlocks blocks after it went on air), so a
 * gap of g ms reads as about g + 50 ms in 50 ms blocks: a carrier flapping with gaps of 300 to
 * 500 ms reads 350 to 550 ms, at least 450 ms (9 blocks) short of 1000; the turnaround of a QSO
 * (1 to 3 s) reads 1050 ms or more.
 */
const TRAFFIC_GAP_MS = 1_000
/**
 * Hold of a frequency not known as traffic (on air since before its onset could be bracketed, and
 * no gap of TRAFFIC_GAP_MS heard): at most one coarse sweep and at most this long from the start of
 * the visit's holds, whatever the plan size. With a 1150 ms hop, a 3-hop sweep (3450 ms) is
 * shorter; a 60-hop plan's sweep (69 s, cut to `hold.maxHoldMs`) is not, so five labelled carriers
 * add at most 5 × 4000 = 20 000 ms to its first sweep instead of 5 × 60 000 ms.
 */
const ONSET_UNSEEN_FOLLOW_MS = 8_000
/**
 * Follow and retry buckets kept per hop of the plan: one per frequency, as many as a hop's
 * frequency memory (MAX_FREQUENCY_MEMORY) times the hop count. Hops overlap, so the frequencies of
 * the whole plan are fewer than that and no bucket with ms left is dropped; past it the bucket
 * with the least ms left goes first. A drained bucket with no retry strikes is dropped when a new
 * one is made.
 */
const FOLLOW_BUDGETS_PER_HOP = MAX_FREQUENCY_MEMORY
/**
 * A track of at most 4 blocks is classed as a burst whatever it is (classifySpectral), so analog
 * voice can only be labelled from its 5th block: a dwell that ends with a younger unlabelled track
 * whose spectrum reads as analog voice (TrackHints.voiceLater) waits for it once, at most CLASS_SETTLE_BLOCKS − 1 = 4 more blocks (200 ms in 50 ms blocks).
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
 * A frequency heard on a hop. `barred`: a hold already ended on it while it stayed on air, so it is
 * not held again during the same emission. `steady` once one emission has been present for longer
 * than the longest hold (`hold.maxHoldMs`) or is barred and heard again on a later visit.
 *
 * An emission is presumed continuous between visits. A sighting starts a new one when an off-air
 * gap of at least `hold.hangMs` was heard (a close and a reopen in one visit, or a late open after
 * that much listening), or when a gap nobody heard (closed or missed on an earlier visit, a late
 * open) fell on a frequency that is not persistent; only a heard gap, or a gap nobody heard on
 * traffic, frees a barred or steady frequency. A heard gap of TRAFFIC_GAP_MS or more makes it
 * traffic. A reopen within TRAFFIC_GAP_MS keeps the emission (a flapping carrier stays barred and
 * steady); only its transmission length restarts.
 */
interface FrequencyMemory {
	centreHz: number
	halfWidthHz: number
	/** Start of the current transmission (steadiness by length). */
	firstSeenAt: number
	/** Clock of the last sighting. */
	lastSeenAt: number
	/** Hop visit serial of the last sighting. */
	lastSerial: number
	barred: boolean
	steady: boolean
	/**
	 * An onset was heard or bracketed on it at least once (off air on an earlier full visit, a
	 * heard gap, a decode): not a bare carrier, so it keeps hop activity (revisits) even when it is
	 * not, or no longer, traffic. A follow that hears it on air without a break for `hold.maxHoldMs`
	 * clears it.
	 */
	onsetSeen: boolean
	/**
	 * Traffic, not a carrier: it was heard off air for TRAFFIC_GAP_MS, it was decoded, or (see
	 * `provisional`) it is new on a hop whose earlier full visit missed it. Traffic is never steady
	 * and a bar never stops its next hold: only the long-hold lock (a coarse visit of every hop
	 * between long follows) and `hold.maxHoldMs` per hold bound it. A non-decoded follow that hears
	 * it on air without a break for `hold.maxHoldMs` makes it a carrier again.
	 */
	traffic: boolean
	/**
	 * Traffic only because visits bracketed its onset (it is new on a hop whose earlier full visit
	 * missed it): a carrier that switches on, or flaps in short gaps that a visit happened to miss,
	 * looks the same. A gap shorter than TRAFFIC_GAP_MS heard on it ends that (it is not traffic,
	 * and a follow of it is cut to the bound of a frequency not known as traffic); a gap of
	 * TRAFFIC_GAP_MS or a decode confirms it.
	 */
	provisional: boolean
	/** Share of the hop's recent full visits that heard it (PRESENCE_WEIGHT). */
	presence: number
	/** The last full visit of the hop did not hear it. */
	missed: boolean
	/**
	 * Its last track closed with no other track of the visit on it: visit serial, block count and
	 * clock of the close. A sighting in the same block is a rollover of the same emission.
	 */
	closedAt: { serial: number; block: number; at: number } | null
}

/**
 * Bucket of one frequency (FOLLOW_BUDGET_WINDOWS), shared by every hop whose span holds it:
 * overlapping hops hear the same frequency. Follows are charged to it as they run; on a frequency
 * not known as traffic it paces retries (spendCarrier). Same frequency as FrequencyMemory: within
 * the wider half width.
 */
interface FollowBudget {
	centreHz: number
	halfWidthHz: number
	/** Ms used at `usedAt`. */
	usedMs: number
	usedAt: number
	/** Holds in a row that barred the frequency without traffic evidence (RETRY_CHARGE_MS). */
	strikes: number
}

interface HopState {
	activityScore: number
	scoreAt: number | null
	lastVisit: number | null
	gainTenthsDb: number | null
	cleanVisits: number
	boost: boolean
	/** Visits of this hop so far (revisits and continued visits included). */
	serial: number
	/** Full visits so far (minSurfaceBlocks + 1 blocks or more): each would have heard a frequency on air. */
	fullVisits: number
	memory: FrequencyMemory[]
	/** Accounting (job progress, fairness tests): visits, ms from tune to leave, ms held. */
	visits: number
	timeMs: number
	holdMs: number
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
	/** Steady or barred frequency, or a flagged track: never held. */
	steady: boolean
	/** Truncated, image or spur: never held, no activity. */
	flagged: boolean
	open: boolean
	tried: boolean
	/** Its follow was cut to one coarse sweep only because another long hold had just ended. */
	deferred: boolean
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
	holdStartedAt: number | null
	/** Gain the visit was tuned with. A continued visit (no tune) needs the same gain. */
	gainTenthsDb: number | null
	/** Clock at the tune (or at the continue). */
	startedAt: number
	/** Hop serial of this visit (FrequencyMemory.lastSerial). */
	serial: number
	/**
	 * `blocks` when the current epoch started. Listening (late opens) counts from it: before a
	 * restart (outage, preemption, resume) the visit heard nothing of what happened in between.
	 */
	epochBlock: number
	/** A carrier (never an onset) turned steady during this visit. */
	newlySteady: boolean
	/** The dwell was lengthened once for a track too young to be labelled (CLASS_SETTLE_BLOCKS). */
	classWait: boolean
	/**
	 * Frequencies whose held track closed this visit: a reopening of one is not held again (a
	 * follow or a probe ending on it may follow it on instead).
	 */
	closedAfterHold: Set<FrequencyMemory>
	/** A follow of this visit was allowed past one coarse sweep (followCap). */
	longFollow: boolean
	/** A held track closed during this visit (its hold did not hear one unbroken transmission). */
	heldClosed: boolean
	/** The dwell was lengthened once to listen for a frequency missed by it (waitForGap). */
	gapWait: boolean
	/** Frequencies that dwell extension listens for; it ends early once they are all heard again. */
	gapWaitFor: Set<FrequencyMemory>
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
	trackId: string
	mode: "confirm" | "follow" | "hang"
	deadline: number
	/** Last clock a follow (and its hang and reopenings) may run to (see followCap). */
	cap: number
	deferred: boolean
	/** A decoder confirmed the held transmission (onConfirmed). */
	decoded: boolean
}

/** How a sighting of a remembered frequency relates to its last emission. */
type Sighting = "same" | "reopen" | "unheard-gap" | "heard-gap"

type Phase = "idle" | "tuning" | "dwell" | "hold"

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

export class SweepScheduler {
	private plan: HopPlan
	private spec: NormalisedJobSpec
	private blockSamples: number
	private sampleRateHz: number
	private readonly now: () => number
	private readonly probeStartMs: number
	private readonly minSurfaceBlocks: number
	private readonly activitySeed: ((hop: Hop) => number) | undefined
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
	 * Coarse visits still to end before another follow may outlast one coarse sweep: after such a
	 * long hold every hop gets its dwell first (set to the hop count, one less per coarse visit).
	 */
	private longHoldLock = 0
	/**
	 * Coarse visits still to end before another retry (remember): at most one frequency not known
	 * as traffic is held again per coarse sweep, so retries add at most one ONSET_UNSEEN_FOLLOW_MS
	 * hold to a sweep (set to the hop count at a retry, one less per coarse visit).
	 */
	private retryLock = 0
	/** The follow in progress: its frequency's budget is charged when it ends. */
	private following: { budget: FollowBudget; from: number } | null = null
	/** Follow and retry buckets by frequency, across hops (FOLLOW_BUDGETS_PER_HOP). */
	private budgets: FollowBudget[] = []

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
		this.endFollow()
		this.lastBlockEnd = startSample
		v.dwellEnd = startSample + this.dwellSamples(this.parkedVisit)
		v.tracks.clear()
		this.forgetGapEvidence(v)
		v.holdStartedAt = null
		this.hold = null
		this.phase = "dwell"
		// A re-sent window starts fresh: time without data is no dwell.
		this.parkedSweepSamples = 0
		this.parkIfOneHop()
		return actions
	}

	/**
	 * Nothing was heard between the old epoch and the new one: a close heard on this visit before
	 * it is no off-air gap (the frequency may have come back at once), and late opens count
	 * listening from the new epoch only. A reopening is the same emission (FrequencyMemory).
	 */
	private forgetGapEvidence(v: Visit): void {
		v.epochBlock = v.blocks
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		for (const m of hop.memory)
			if (m.closedAt !== null && m.closedAt.serial === v.serial)
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
		const memory = flagged ? null : this.remember(v, track, known === undefined)
		// Traffic is never steady, and a bar does not stop its next hold (FrequencyMemory.traffic).
		const steady =
			flagged ||
			(memory !== null && !memory.traffic && (memory.barred || memory.steady))
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
				steady,
				flagged,
				open: true,
				tried: false,
				deferred: false,
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
			known.steady ||= steady
			known.flagged ||= flagged
			known.ageBlocks = Math.max(known.ageBlocks, track.blocks)
			known.confirmHoldMs = Math.max(known.confirmHoldMs, confirmHoldMs)
		}
		// the held track turned out truncated or an image: drop its probe and hold
		if (
			flagged &&
			this.phase === "hold" &&
			this.hold?.trackId === track.trackId
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
			v === null ||
			this.spec.hold.policy !== "hold" ||
			this.spec.signalsOnly === true
		)
			return
		const t = v.tracks.get(trackId)
		const held = v.tracks.get(hold.trackId)
		if (
			t === undefined ||
			held === undefined ||
			!t.open ||
			t.tried ||
			t.steady ||
			!t.followOnAir ||
			Math.abs(t.centreHz - held.centreHz) >
				Math.max(SAME_FREQUENCY_FLOOR_HZ, t.obwHz / 2, held.obwHz / 2)
		)
			return
		t.tried = true
		t.deferred = hold.deferred
		this.hold = {
			trackId,
			mode: "follow",
			deadline: hold.cap,
			cap: hold.cap,
			deferred: hold.deferred,
			decoded: hold.decoded,
		}
	}

	/**
	 * A decoder confirmed the held track. With a follow, a decode proves a transmission: its
	 * frequency is traffic, and the follow runs to `hold.maxHoldMs` from the start of the visit's
	 * holds with no onset or budget rule (followCap), only the long-hold lock. A decode without a
	 * follow (policy `confirm`, voice not recorded) identified the emission: it is barred like any
	 * hold that ends on air, not probed again while it stays on air.
	 */
	onConfirmed(trackId: string, follow: boolean): SchedulerAction[] {
		if (this.phase !== "hold" || this.hold?.trackId !== trackId) return []
		const v = this.visit
		const t = v?.tracks.get(trackId)
		if (follow && this.spec.hold.policy === "hold" && t !== undefined) {
			const hop = v === null ? undefined : this.hops[v.hopIndex]
			const memory = hop === undefined ? undefined : this.memoryOf(hop, t)
			if (memory !== undefined) this.markTraffic(memory)
			this.startFollow(trackId, t, true)
			if (!t.open && this.hold !== null) {
				this.hold.mode = "hang"
				this.hold.deadline = this.hangDeadline(this.hold.cap)
			}
			return []
		}
		return this.afterProbe()
	}

	onTrackClosed(trackId: string): SchedulerAction[] {
		const v = this.visit
		const t = v?.tracks.get(trackId)
		if (v !== null && t !== undefined && t.open) {
			t.open = false
			if (t.tried) v.heldClosed = true
			this.noteClosed(v, t)
			const hop = this.hops[v.hopIndex]
			const memory = hop === undefined ? undefined : this.memoryOf(hop, t)
			if (t.tried && memory !== undefined) v.closedAfterHold.add(memory)
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
	 * started can be classed (a reopening within TRAFFIC_GAP_MS is the same emission, a longer gap
	 * is traffic): a hold runs past its cap by at most TRAFFIC_GAP_MS + one block (1050 ms in 50 ms
	 * blocks), never past `hold.maxHoldMs`.
	 */
	private hangDeadline(cap: number): number {
		const now = this.now()
		const v = this.visit
		const held =
			this.hold === null ? undefined : v?.tracks.get(this.hold.trackId)
		const hop = v === null ? undefined : this.hops[v.hopIndex]
		const memory =
			hop === undefined || held === undefined
				? undefined
				: this.memoryOf(hop, held)
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		const classify =
			memory !== undefined && !memory.traffic
				? Math.min(this.spec.hold.hangMs, TRAFFIC_GAP_MS + blockMs)
				: 0
		return Math.min(
			this.maxHoldDeadline(),
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
		if (this.phase !== "hold" || this.hold === null) return []
		if (now >= this.maxHoldDeadline())
			return this.leaveHop([{ type: "stop-probes" }])
		if (now < this.hold.deadline) return []
		if (this.hold.mode === "confirm") return this.confirmTimedOut()
		// The hang ran out, or the follow reached its cap with the track still on air.
		return this.leaveHop([{ type: "stop-probes" }])
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
			const held =
				current && v.holdStartedAt !== null ? now - v.holdStartedAt : 0
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
				holdingOn: this.phase === "hold" ? (this.hold?.trackId ?? null) : null,
				coverage: 1,
			}
		return {
			sweepIndex: this.sweepIndex,
			hopIndex:
				this.visit?.hopIndex ??
				Math.min(this.coarseIndex, this.plan.hops.length - 1),
			hopCount: this.plan.hops.length,
			sweepPeriodMs: this.sweepPeriodMs,
			holdingOn: this.phase === "hold" ? (this.hold?.trackId ?? null) : null,
			coverage: this.lastCoverage ?? this.visited.size / this.plan.hops.length,
		}
	}

	// ── internals ────────────────────────────────────────────────────────

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
			serial: 0,
			fullVisits: 0,
			memory: [],
			visits: 0,
			timeMs: 0,
			holdMs: 0,
		}
	}

	/**
	 * Records a sighting in the hop's frequency memory and returns its entry (see FrequencyMemory
	 * for when a sighting starts a new emission).
	 */
	private remember(
		v: Visit,
		track: TrackSnapshot,
		isNew: boolean,
	): FrequencyMemory | null {
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return null
		const now = this.now()
		const halfWidthHz = Math.max(SAME_FREQUENCY_FLOOR_HZ, track.obwHz / 2)
		let entry = hop.memory.find(
			m =>
				Math.abs(m.centreHz - track.centreHz) <=
				Math.max(m.halfWidthHz, halfWidthHz),
		)
		if (entry === undefined) {
			// Off air for TRAFFIC_GAP_MS of this visit before it opened: traffic. Missed by at least one
			// full visit of the hop: traffic until a gap shorter than TRAFFIC_GAP_MS shows a carrier
			// (FrequencyMemory.provisional). On the hop's first visit (job start, resume) it may have
			// been on air all along. Only ONSET_EVIDENCE_VISITS missed visits make it new to the
			// presence rule (a gap nobody heard ends its emission at once).
			const heardOff =
				this.openedLate(v, entry, isNew) && this.listenedMs(v) >= TRAFFIC_GAP_MS
			const bracketed = hop.fullVisits >= ONSET_EVIDENCE_VISITS
			const provisional = !heardOff && hop.fullVisits >= 1
			const onsetSeen = heardOff || provisional
			entry = {
				centreHz: track.centreHz,
				halfWidthHz,
				firstSeenAt: now,
				lastSeenAt: now,
				lastSerial: v.serial,
				barred: false,
				steady: false,
				onsetSeen,
				traffic: onsetSeen,
				provisional,
				// On air for as long as the hop has been heard: persistent until visits miss it.
				presence: heardOff || bracketed ? 0 : 1,
				missed: false,
				closedAt: null,
			}
			hop.memory.push(entry)
			this.boundMemory(hop)
		} else {
			const sighting = this.sighting(v, entry, isNew, now)
			const gap = this.heardOffGap(v, entry, isNew, now)
			// A new emission. A gap nobody heard frees only a frequency already known as traffic: on
			// anything else it may be a carrier's short gap that a visit happened to miss, and only
			// its retry budget (below) holds it again. A heard gap is TRAFFIC_GAP_MS or more (gap).
			if (
				sighting === "heard-gap" ||
				(sighting === "unheard-gap" && entry.traffic)
			) {
				entry.barred = false
				entry.steady = false
			}
			if (gap) this.markTraffic(entry)
			else if (entry.provisional && this.heardShortGap(v, entry)) {
				// Its onset was bracketed (onsetSeen, hop activity stays), but a short gap is a carrier's.
				entry.traffic = false
				entry.provisional = false
				this.spendCarrier(entry, now)
				this.cutFollowOf(v, entry)
			}
			// Not traffic, barred or steady, and its retry budget has refilled: held again (a hold
			// of at most ONSET_UNSEEN_FOLLOW_MS), so something on air since the job started is
			// listened to again instead of staying barred until it is forgotten.
			if (
				!entry.traffic &&
				(entry.barred || entry.steady) &&
				this.retryLock === 0 &&
				this.usedOf(entry, now) <= 0
			) {
				this.retryLock = this.plan.hops.length
				entry.barred = false
				entry.steady = false
				entry.firstSeenAt = now
			}
			if (sighting !== "same" && !entry.steady) entry.firstSeenAt = now
		}
		entry.closedAt = null
		entry.missed = false
		entry.lastSeenAt = now
		// Heard again during a dwell extended to listen for it (waitForGap): the wait ends.
		if (
			v.gapWaitFor.delete(entry) &&
			v.gapWaitFor.size === 0 &&
			this.phase === "dwell" &&
			v.dwellEnd !== null &&
			this.lastBlockEnd !== null
		)
			v.dwellEnd = Math.min(v.dwellEnd, this.lastBlockEnd)
		// Barred and heard again on a later visit: a frequency that outlasted a hold and is still
		// there. On air for longer than the longest hold: a carrier, not a transmission. Traffic is
		// never steady.
		const wasSteady = entry.steady
		if (!entry.traffic) {
			if (entry.lastSerial < v.serial && entry.barred) entry.steady = true
			if (now - entry.firstSeenAt >= this.spec.hold.maxHoldMs)
				entry.steady = true
		}
		if (entry.steady && !wasSteady && !entry.traffic) {
			if (!entry.onsetSeen) v.newlySteady = true
			// Turning steady starts its retry budget unless a hold already did.
			if (this.usedOf(entry, now) <= 0) this.spendCarrier(entry, now)
		}
		entry.lastSerial = v.serial
		entry.halfWidthHz = Math.max(entry.halfWidthHz, halfWidthHz)
		return entry
	}

	/**
	 * A frequency not known as traffic was barred by a hold or turned steady (`known` carrier: at
	 * once the longest charge): its retry budget is charged RETRY_CHARGE_MS × 2^(strikes) (at most
	 * `hold.maxHoldMs`) and its next sighting after the bucket drained is held again (remember).
	 */
	private spendCarrier(m: FrequencyMemory, now: number, known = false): void {
		if (m.traffic) return
		const budget = this.budgetFor(m, now)
		const max = this.spec.hold.maxHoldMs
		budget.strikes = known ? 31 : Math.min(31, budget.strikes + 1)
		budget.usedMs = Math.min(max, RETRY_CHARGE_MS * 2 ** (budget.strikes - 1))
		budget.usedAt = now
	}

	/**
	 * Traffic evidence: the frequency was heard off air for TRAFFIC_GAP_MS (a decode is evidence too,
	 * onConfirmed). It is never steady and a bar no longer stops its holds.
	 */
	private markTraffic(m: FrequencyMemory): void {
		const budget = this.budgetOf(m)
		if (budget !== undefined) budget.strikes = 0
		m.provisional = false
		m.traffic = true
		m.onsetSeen = true
		m.barred = false
		m.steady = false
	}

	/**
	 * This sighting reopens the frequency less than TRAFFIC_GAP_MS after a close the visit heard
	 * (not in the same block, a rollover): the gap of a flapping carrier.
	 */
	private heardShortGap(v: Visit, entry: FrequencyMemory): boolean {
		const closed = entry.closedAt
		return (
			closed !== null &&
			closed.serial === v.serial &&
			closed.block !== v.blocks &&
			this.now() - closed.at < TRAFFIC_GAP_MS
		)
	}

	/**
	 * The frequency is a carrier after all (a provisional onset, then a short gap): a follow of it
	 * in progress ends at the bound of a frequency not known as traffic (followCap).
	 */
	private cutFollowOf(v: Visit, entry: FrequencyMemory): void {
		const hold = this.hold
		const hop = this.hops[v.hopIndex]
		const held = hold === null ? undefined : v.tracks.get(hold.trackId)
		if (
			hold === null ||
			hold.mode === "confirm" ||
			hold.decoded ||
			hop === undefined ||
			held === undefined ||
			this.memoryOf(hop, held) !== entry
		)
			return
		const start = v.holdStartedAt ?? this.now()
		const cap = Math.min(
			hold.cap,
			start + Math.min(this.chainBudgetMs(), ONSET_UNSEEN_FOLLOW_MS),
		)
		hold.cap = cap
		hold.deadline = Math.min(hold.deadline, cap)
	}

	/**
	 * This sighting ends an off-air gap of at least TRAFFIC_GAP_MS the visit heard: a close earlier
	 * in the visit (not in the same block, a rollover), or a late open after that much listening.
	 */
	private heardOffGap(
		v: Visit,
		entry: FrequencyMemory,
		isNew: boolean,
		now: number,
	): boolean {
		const closed = entry.closedAt
		if (closed !== null && closed.serial === v.serial)
			return closed.block !== v.blocks && now - closed.at >= TRAFFIC_GAP_MS
		return (
			this.openedLate(v, entry, isNew) && this.listenedMs(v) >= TRAFFIC_GAP_MS
		)
	}

	/** The frequency's bucket, if one was made. */
	private budgetOf(m: FrequencyMemory): FollowBudget | undefined {
		return this.budgets.find(
			b =>
				Math.abs(b.centreHz - m.centreHz) <=
				Math.max(b.halfWidthHz, m.halfWidthHz),
		)
	}

	/**
	 * The frequency's bucket, made empty when it has none. Making one drops the drained buckets
	 * with no retry strikes (except the follow in progress) and keeps at most
	 * FOLLOW_BUDGETS_PER_HOP × hop count, dropping the one with the least ms left first.
	 */
	private budgetFor(m: FrequencyMemory, now: number): FollowBudget {
		const found = this.budgetOf(m)
		if (found !== undefined) {
			found.halfWidthHz = Math.max(found.halfWidthHz, m.halfWidthHz)
			return found
		}
		const active = this.following?.budget
		this.budgets = this.budgets.filter(
			b => b === active || this.followUsed(b, now) > 0 || b.strikes > 0,
		)
		const limit = FOLLOW_BUDGETS_PER_HOP * Math.max(1, this.plan.hops.length)
		while (this.budgets.length >= limit) {
			let drop = -1
			this.budgets.forEach((b, i) => {
				const d = this.budgets[drop]
				if (
					b !== active &&
					(d === undefined || this.followUsed(b, now) < this.followUsed(d, now))
				)
					drop = i
			})
			if (drop < 0) break
			this.budgets.splice(drop, 1)
		}
		const budget: FollowBudget = {
			centreHz: m.centreHz,
			halfWidthHz: m.halfWidthHz,
			usedMs: 0,
			usedAt: now,
			strikes: 0,
		}
		this.budgets.push(budget)
		return budget
	}

	/**
	 * Ms of the frequency's bucket not yet drained at `now`, the follow in progress on
	 * it included.
	 */
	private usedOf(m: FrequencyMemory, now: number): number {
		const budget = this.budgetOf(m)
		if (budget === undefined) return 0
		const running =
			this.following?.budget === budget ? now - this.following.from : 0
		return this.followUsed(budget, now) + running
	}

	/** Keeps the memory within MAX_FREQUENCY_MEMORY: the frequency missed longest goes first. */
	private boundMemory(hop: HopState): void {
		while (hop.memory.length > MAX_FREQUENCY_MEMORY) {
			let drop = 0
			hop.memory.forEach((m, i) => {
				const d = hop.memory[drop]
				if (
					d !== undefined &&
					(Number(m.missed) > Number(d.missed) ||
						(m.missed === d.missed && m.lastSeenAt < d.lastSeenAt))
				)
					drop = i
			})
			hop.memory.splice(drop, 1)
		}
	}

	/**
	 * A new track opened after the visit received minSurfaceBlocks + LATE_OPEN_BLOCKS blocks
	 * without it on this frequency: it was off air at the start of the visit.
	 */
	private openedLate(
		v: Visit,
		entry: FrequencyMemory | undefined,
		isNew: boolean,
	): boolean {
		return (
			isNew &&
			(entry === undefined || entry.lastSerial < v.serial) &&
			v.blocks - v.epochBlock >= this.minSurfaceBlocks + LATE_OPEN_BLOCKS
		)
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
	 * How a sighting of a remembered frequency relates to its last emission. A close and an open in
	 * the same block is a max-duration rollover ("same"). A gap heard within this visit starts a
	 * new emission when it lasted `hold.hangMs` or more ("fresh"), else it is the same emission
	 * reopening ("reopen"). A late open heard the frequency off air for the listening before it,
	 * fresh when that was `hold.hangMs` or more. A gap nobody heard (closed on an earlier visit,
	 * missed by the last full visit, or a shorter late open) is fresh on a frequency that is not
	 * persistent and the same emission on a persistent one. Absence is counted in visits that could
	 * have heard the frequency, never in clock time: time held on another hop or an outage refreshes
	 * nothing.
	 */
	private sighting(
		v: Visit,
		entry: FrequencyMemory,
		isNew: boolean,
		now: number,
	): Sighting {
		const closed = entry.closedAt
		const hang = this.spec.hold.hangMs
		if (closed !== null && closed.serial === v.serial) {
			if (closed.block === v.blocks) return "same"
			return now - closed.at >= hang ? "heard-gap" : "reopen"
		}
		const late = this.openedLate(v, entry, isNew)
		if (late && this.listenedMs(v) >= hang) return "heard-gap"
		if (closed === null && !entry.missed && !late) return "same"
		return entry.presence >= PERSISTENT_PRESENCE ? "same" : "unheard-gap"
	}

	/**
	 * This visit heard the frequency close and stay off air for at least `hold.hangMs` up to `now`
	 * (a gap that long starts a new emission, see sighting).
	 */
	private heardGone(v: Visit, m: FrequencyMemory, now: number): boolean {
		const closed = m.closedAt
		return (
			closed !== null &&
			closed.serial === v.serial &&
			now - closed.at >= this.spec.hold.hangMs
		)
	}

	/** A track closed: its frequency went off air unless another open track of the visit is on it. */
	private noteClosed(v: Visit, t: TrackInfo): void {
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		const memory = this.memoryOf(hop, t)
		if (memory === undefined) return
		for (const other of v.tracks.values())
			if (other.open && this.memoryOf(hop, other) === memory) return
		memory.closedAt = { serial: v.serial, block: v.blocks, at: this.now() }
	}

	/**
	 * Hops overlap by the widest channel: a frequency barred on one hop is barred on the hops whose
	 * span also holds it, as if their last visit had heard it (their next full visits confirm it or count it missed).
	 */
	private barInOverlaps(hopIndex: number, from: FrequencyMemory): void {
		this.plan.hops.forEach((hop, i) => {
			const state = this.hops[i]
			if (
				i === hopIndex ||
				state === undefined ||
				from.centreHz < hop.covered.startHz ||
				from.centreHz > hop.covered.endHz
			)
				return
			let entry = state.memory.find(
				m =>
					Math.abs(m.centreHz - from.centreHz) <=
					Math.max(m.halfWidthHz, from.halfWidthHz),
			)
			if (entry === undefined) {
				entry = {
					...from,
					lastSerial: state.serial,
					steady: false,
					missed: false,
					closedAt: null,
				}
				state.memory.push(entry)
				this.boundMemory(state)
			}
			entry.barred = true
			entry.closedAt = null
			entry.lastSerial = Math.max(entry.lastSerial, state.serial)
		})
	}

	/** Same-frequency entry of a visit's track. */
	private memoryOf(hop: HopState, t: TrackInfo): FrequencyMemory | undefined {
		const halfWidthHz = Math.max(SAME_FREQUENCY_FLOOR_HZ, t.obwHz / 2)
		return hop.memory.find(
			m =>
				Math.abs(m.centreHz - t.centreHz) <=
				Math.max(m.halfWidthHz, halfWidthHz),
		)
	}

	/** A new visit record of `hopIndex` (tuned or continued). */
	private newVisit(
		hopIndex: number,
		revisit: boolean,
		tracks: Map<string, TrackInfo>,
		gainTenthsDb: number | null,
	): Visit {
		const hop = this.hops[hopIndex]
		if (hop !== undefined) hop.serial++
		return {
			hopIndex,
			revisit,
			dwellEnd: null,
			blocks: 0,
			overloaded: false,
			tracks,
			holdStartedAt: null,
			gainTenthsDb,
			startedAt: this.now(),
			serial: hop?.serial ?? 0,
			epochBlock: 0,
			newlySteady: false,
			classWait: false,
			closedAfterHold: new Set(),
			longFollow: false,
			heldClosed: false,
			gapWait: false,
			gapWaitFor: new Set(),
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
			if (this.waitForClass(v) || this.waitForGap(v)) return []
		}
		return this.leaveHop([])
	}

	/**
	 * A frequency not known as traffic that is barred or steady, was heard on the hop's last full
	 * visit and is persistent, yet this dwell did not hear it: it may be in the gap between two
	 * overs of a QSO. With nothing to hold, the dwell listens once for TRAFFIC_GAP_MS (plus the
	 * minSurfaceBlocks a reopening needs to surface): if it stays off that long it is traffic
	 * (endVisit), if it comes back the wait ends on the next block. Cost: at most
	 * minSurfaceBlocks + ceil(TRAFFIC_GAP_MS / block) + 1 blocks of listening per visit (23 blocks,
	 * 1150 ms, in 50 ms blocks, so 1000 ms past a 3-block dwell), and only on a visit that missed
	 * such a frequency: a steady carrier is never missed.
	 */
	private waitForGap(v: Visit): boolean {
		if (
			v.gapWait ||
			v.dwellEnd === null ||
			this.spec.hold.policy !== "hold" ||
			this.spec.signalsOnly === true ||
			this.blockSamples <= 0
		)
			return false
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return false
		for (const m of hop.memory)
			if (
				!m.traffic &&
				(m.barred || m.steady) &&
				m.lastSerial < v.serial &&
				!m.missed &&
				m.presence >= PERSISTENT_PRESENCE
			)
				v.gapWaitFor.add(m)
		if (v.gapWaitFor.size === 0) return false
		const blockMs = (this.blockSamples * 1000) / this.sampleRateHz
		// One block more than listenedMs needs: a reopening is sighted before its block is counted.
		const need =
			this.minSurfaceBlocks +
			Math.ceil(TRAFFIC_GAP_MS / blockMs) +
			1 -
			(v.blocks - v.epochBlock)
		v.gapWait = true
		if (need <= 0) {
			v.gapWaitFor.clear()
			return false
		}
		v.dwellEnd += need * this.blockSamples
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
				!t.steady &&
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
	 * The strongest open, untried, non-steady track to confirm; else (policy `hold`) the strongest
	 * analog voice to follow on air. Steady and barred frequencies are never held.
	 */
	private nextCandidate(): Candidate | null {
		if (this.spec.signalsOnly === true) return null
		const v = this.visit
		if (v === null) return null
		let best: Candidate | null = null
		const follow = this.spec.hold.policy === "hold"
		const hop = this.hops[v.hopIndex]
		for (const [id, t] of v.tracks) {
			if (!t.open || t.tried || t.steady) continue
			const memory = hop === undefined ? undefined : this.memoryOf(hop, t)
			if (memory !== undefined && v.closedAfterHold.has(memory)) continue
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
		if (c.kind === "confirm") return this.startProbe(c.id, c.t)
		c.t.tried = true
		this.startFollow(c.id, c.t)
		this.phase = "hold"
		return []
	}

	/** Holds `trackId` in follow mode up to its cap (followCap); the frequency's budget runs from now. */
	private startFollow(trackId: string, t: TrackInfo, decoded = false): void {
		const { cap, deferred, long } = this.followCap(t, decoded)
		t.deferred = deferred
		if (long && this.visit !== null) this.visit.longFollow = true
		this.hold = {
			trackId,
			mode: "follow",
			deadline: cap,
			cap,
			deferred,
			decoded,
		}
		this.chargeFrom(t)
	}

	/** From now, the hold of `t` is charged to its frequency's bucket (endFollow). */
	private chargeFrom(t: TrackInfo): void {
		const v = this.visit
		const hop = v === null ? undefined : this.hops[v.hopIndex]
		const memory = hop === undefined ? undefined : this.memoryOf(hop, t)
		if (memory === undefined) return
		const now = this.now()
		const budget = this.budgetFor(memory, now)
		if (this.following?.budget === budget) return
		this.endFollow()
		this.following = { budget, from: now }
	}

	/** Charges the follow in progress to its frequency's budget. */
	private endFollow(): void {
		const f = this.following
		if (f === null) return
		this.following = null
		const now = this.now()
		f.budget.usedMs = this.followUsed(f.budget, now) + (now - f.from)
		f.budget.usedAt = now
	}

	/** Long-follow ms of a bucket still unspent at `now` (FOLLOW_BUDGET_WINDOWS). */
	private followUsed(b: FollowBudget, now: number): number {
		return Math.max(0, b.usedMs - (now - b.usedAt) / FOLLOW_BUDGET_WINDOWS)
	}

	/**
	 * Last clock a follow of `t` may run to, counted from the start of the visit's holds. Traffic
	 * (FrequencyMemory.traffic) and a decoded transmission (`decoded`) are followed long, to
	 * `hold.maxHoldMs`, once every hop has had a coarse visit since the last long hold; while that
	 * lock holds, one coarse sweep (chainBudgetMs), deferred. Anything else (on air since before its
	 * onset could be bracketed, no gap heard) is held at most one coarse sweep and at most
	 * ONSET_UNSEEN_FOLLOW_MS. A one-hop plan has no other hop to starve: always long.
	 */
	private followCap(
		t: TrackInfo,
		decoded = false,
	): {
		cap: number
		deferred: boolean
		long: boolean
	} {
		const now = this.now()
		const long = this.maxHoldDeadline()
		const v = this.visit
		if (v === null || this.plan.hops.length < 2)
			return { cap: long, deferred: false, long: false }
		const start = v.holdStartedAt ?? now
		const short = Math.min(long, start + this.chainBudgetMs())
		const hop = this.hops[v.hopIndex]
		const memory = hop === undefined ? undefined : this.memoryOf(hop, t)
		if (!decoded && memory?.traffic !== true)
			return {
				cap: Math.min(short, start + ONSET_UNSEEN_FOLLOW_MS),
				deferred: false,
				long: false,
			}
		if (this.longHoldLock > 0)
			return { cap: short, deferred: true, long: false }
		return { cap: long, deferred: false, long: long > short }
	}

	/**
	 * One nominal coarse sweep: the sum of the hop dwells (holds left out), at most
	 * `hold.maxHoldMs`. A visit chains further confirm holds only within it, and a follow outlasts
	 * it only as followCap allows, so the other hops wait at most one extra sweep for a hop except
	 * during a long follow (at most `hold.maxHoldMs`, then a full coarse sweep before the next one).
	 */
	private chainBudgetMs(): number {
		let sum = 0
		for (const hop of this.plan.hops) sum += hop.dwellMs ?? this.spec.dwellMs
		return Math.min(this.spec.hold.maxHoldMs, sum)
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
			deferred: false,
			decoded: false,
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
	 * voice that may be followed long (followCap: traffic, every hop visited since the last long
	 * follow) is probed past that, up to its follow cap; that hold is a long follow (it locks the
	 * next long follow out until every hop had a visit). A one-hop plan: up to `hold.maxHoldMs`.
	 */
	private confirmEnd(t: TrackInfo): number {
		const now = this.now()
		const long = this.maxHoldDeadline()
		const v = this.visit
		if (v === null || this.plan.hops.length < 2) return long
		const window =
			Math.min(t.confirmHoldMs, CONFIRM_FLOOR_MS) + this.probeStartMs
		const short = Math.min(
			long,
			Math.max((v.holdStartedAt ?? now) + this.chainBudgetMs(), now + window),
		)
		if (
			now + t.confirmHoldMs + this.probeStartMs <= short ||
			!t.followOnAir ||
			this.spec.hold.policy !== "hold" ||
			this.spec.signalsOnly === true
		)
			return short
		const follow = this.followCap(t)
		if (!follow.long) return short
		v.longFollow = true
		this.chargeFrom(t)
		return follow.cap
	}

	/** A probe finished (confirmed without following, or timed out): next queued track or leave. */
	private afterProbe(): SchedulerAction[] {
		this.endFollow()
		const stop: SchedulerAction[] = [{ type: "stop-probes" }]
		const next = this.nextCandidate()
		const now = this.now()
		const started = this.visit?.holdStartedAt ?? now
		if (
			next !== null &&
			now < this.maxHoldDeadline() &&
			now - started < this.chainBudgetMs()
		)
			return [...stop, ...this.startHold(next)]
		return this.leaveHop(stop)
	}

	/**
	 * The confirm hold ran out without a decode. Analog voice still on air is followed (it has no
	 * decoder to confirm it); anything else ends like any probe.
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
					Math.abs(other.centreHz - probed.centreHz) <=
						Math.max(SAME_FREQUENCY_FLOOR_HZ, other.obwHz / 2, probed.obwHz / 2)
				) {
					id = otherId
					t = other
					break
				}
		if (
			id !== undefined &&
			t !== undefined &&
			t.open &&
			t.followOnAir &&
			!t.steady &&
			this.spec.hold.policy === "hold" &&
			this.spec.signalsOnly !== true
		) {
			const follow = this.followCap(t)
			if (follow.cap > this.now()) {
				t.tried = true
				this.startFollow(id, t)
				return [{ type: "stop-probes" }]
			}
			// No time left to follow it here. Held back only by the lock (deferred), its frequency
			// stays un-barred (endVisit) and its next visit follows it once the lock clears.
			if (follow.deferred) t.deferred = true
		}
		return this.afterProbe()
	}

	private maxHoldDeadline(): number {
		return (this.visit?.holdStartedAt ?? this.now()) + this.spec.hold.maxHoldMs
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
		const hold = this.hold
		this.endFollow()
		this.hold = null
		if (v === null) return
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		this.noteTrafficEvidence(v, hop, now)
		this.demoteUnbroken(v, hop, hold, now)
		hop.visits++
		hop.timeMs += Math.max(0, now - v.startedAt)
		const heldMs =
			v.holdStartedAt === null ? 0 : Math.max(0, now - v.holdStartedAt)
		hop.holdMs += heldMs
		// A follow allowed past one coarse sweep that used it: every hop gets a coarse visit
		// before the next one (followCap).
		if (v.longFollow && heldMs > this.chainBudgetMs())
			this.longHoldLock = this.plan.hops.length
		else if (!v.revisit && this.longHoldLock > 0) this.longHoldLock--
		if (!v.revisit && this.retryLock > 0) this.retryLock--
		// A hold that ended with its track still on air bars the frequency from another hold
		// during the same emission; one that ended with the frequency heard off air for at least
		// `hold.hangMs` frees it. A close less than `hold.hangMs` before the hop is left is no heard
		// gap (a flapping carrier between two flaps): the emission is presumed still on air, as a
		// reopen within `hold.hangMs` would be. A follow cut short only to give the other hops their
		// turn (deferred) bars nothing: the deferral covers every track of its frequency (a reopening
		// picked at the end of a probe is deferred while the probed track was the tried one).
		const deferred = new Set<FrequencyMemory>()
		for (const t of v.tracks.values()) {
			const memory = t.deferred ? this.memoryOf(hop, t) : undefined
			if (memory !== undefined) deferred.add(memory)
		}
		let openBlocks = 0
		const barred = new Set<FrequencyMemory>()
		for (const t of v.tracks.values()) {
			const memory = this.memoryOf(hop, t)
			if (t.tried && memory !== undefined) {
				if (
					!deferred.has(memory) &&
					(t.open || !this.heardGone(v, memory, now))
				)
					barred.add(memory)
				else if (!barred.has(memory)) memory.barred = false
			}
			// Spurs and carriers (steady with no onset ever seen) are no activity: they never need a
			// revisit. Traffic, or anything whose onset was seen, stays activity even while barred or
			// steady (a long QSO, a busy repeater).
			if (t.flagged) continue
			if (
				(t.steady || memory?.steady === true) &&
				memory?.traffic !== true &&
				memory?.onsetSeen !== true
			)
				continue
			openBlocks = Math.max(openBlocks, t.openBlocks)
		}
		for (const memory of barred) {
			memory.barred = true
			this.spendCarrier(memory, now)
			this.barInOverlaps(v.hopIndex, memory)
		}
		// A full dwell hears everything on air for minSurfaceBlocks blocks: presence is counted in
		// such visits only. A frequency they keep missing is forgotten.
		if (v.blocks >= this.minSurfaceBlocks + 1) {
			hop.fullVisits++
			for (const m of hop.memory) {
				const heard = m.lastSerial === v.serial
				m.presence += PRESENCE_WEIGHT * ((heard ? 1 : 0) - m.presence)
				if (!heard) m.missed = true
			}
			hop.memory = hop.memory.filter(
				m =>
					!m.missed || m.presence >= FORGET_PRESENCE || this.usedOf(m, now) > 0,
			)
		}
		const active = v.blocks > 0 ? Math.min(1, openBlocks / v.blocks) : 0
		// A carrier that turned steady on this visit explained the hop's past score: restart it.
		if (hop.scoreAt === null || v.newlySteady) hop.activityScore = active
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
	 * Off-air time the visit heard on frequencies not known as traffic: one that closed and stayed
	 * off for TRAFFIC_GAP_MS up to the end of the visit, or one the visit did not hear at all while
	 * it listened for TRAFFIC_GAP_MS (listenedMs, the dwell extension of waitForGap or any longer
	 * visit), is traffic.
	 */
	private noteTrafficEvidence(v: Visit, hop: HopState, now: number): void {
		const listened = this.listenedMs(v)
		for (const m of hop.memory) {
			if (m.traffic) continue
			const closed = m.closedAt
			const closedLongEnough =
				closed !== null &&
				closed.serial === v.serial &&
				now - closed.at >= TRAFFIC_GAP_MS
			const unheard = m.lastSerial < v.serial && listened >= TRAFFIC_GAP_MS
			if (closedLongEnough || unheard) this.markTraffic(m)
		}
	}

	/**
	 * A follow that was not decoded and heard its frequency on air without a break for
	 * `hold.maxHoldMs` (the hold ran to its bound and no held track closed): one transmission that
	 * long is a carrier, not traffic. It is held again only when its retry budget refills
	 * (FOLLOW_BUDGET_WINDOWS), so a carrier that once went off air for a while does not take a long
	 * follow on every lock cycle.
	 */
	private demoteUnbroken(
		v: Visit,
		hop: HopState,
		hold: Hold | null,
		now: number,
	): void {
		if (
			hold === null ||
			hold.decoded ||
			v.heldClosed ||
			v.holdStartedAt === null ||
			now - v.holdStartedAt < this.spec.hold.maxHoldMs
		)
			return
		const t = v.tracks.get(hold.trackId)
		if (t === undefined || !t.open) return
		const memory = this.memoryOf(hop, t)
		if (memory === undefined || !memory.traffic) return
		memory.traffic = false
		memory.onsetSeen = false
		memory.steady = true
		this.spendCarrier(memory, now, true)
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

	private applyReplan(): void {
		const pending = this.pendingReplan
		if (pending === null) return
		this.pendingReplan = null
		const old = this.plan
		const oldCoarseCentre =
			old.hops[Math.min(this.coarseIndex, old.hops.length - 1)]?.centreHz ?? 0
		// An old hop's accounting (visits, time, holds) moves to the first new hop mapped to it; a
		// second one starts at zero so totals are not counted twice.
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
			// Each new hop owns its memory: two hops mapped to one old hop must recover independently.
			return {
				...prev,
				memory: prev.memory.map(m => ({
					...m,
					closedAt: m.closedAt === null ? null : { ...m.closedAt },
				})),
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
		this.coarseIndex = nearestHop(pending.plan, oldCoarseCentre)
	}
}
