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
 * 12.5 kHz channels; 256 covers every channel of the widest hop, so a full hop never evicts.
 */
const MAX_FREQUENCY_MEMORY = 256
/**
 * A track that first opens on a visit after it has received minSurfaceBlocks + LATE_OPEN_BLOCKS
 * blocks was off air at the start of the visit: anything on air from the first block surfaces after
 * minSurfaceBlocks blocks, plus one block for the order of track and block events.
 */
const LATE_OPEN_BLOCKS = 2

/**
 * A frequency heard on consecutive visits of one hop (memory pruned when a full visit misses it).
 * `barred`: a hold already ended on it while it stayed on air, so it is not held again until a
 * full visit no longer hears it. `steady` once it has been continuously present for longer than
 * the longest hold (`hold.maxHoldMs`) or is barred and heard again on the next visit.
 *
 * Continuity is presumed between visits (a carrier is on air whenever the hop is listened to) and
 * dropped, so the next sighting is a new transmission, as soon as a gap is observed or possible:
 * its track closed (not a same-block rollover), it opened late in a visit that had not heard it
 * yet, or it went unheard for longer than `hold.maxHoldMs` (an outage or a long absence).
 */
interface FrequencyMemory {
	centreHz: number
	halfWidthHz: number
	firstSeenAt: number
	/** Clock of the last sighting. */
	lastSeenAt: number
	/** Hop visit serial of the last sighting. */
	lastSerial: number
	barred: boolean
	steady: boolean
	/**
	 * Its last track closed with no other track of the visit on it: visit serial and block count of
	 * the close. A sighting in the same block is a rollover of the same emission.
	 */
	closedAt: { serial: number; block: number } | null
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
	/** Steady or barred frequency: never held, no activity. */
	steady: boolean
	open: boolean
	tried: boolean
	/** Blocks this track was open during the visit (activity). */
	openBlocks: number
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
	/** A frequency turned steady during this visit. */
	newlySteady: boolean
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
}

interface Hold {
	trackId: string
	mode: "confirm" | "follow" | "hang"
	deadline: number
}

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
		this.lastBlockEnd = startSample
		v.dwellEnd = startSample + this.dwellSamples(this.parkedVisit)
		v.tracks.clear()
		v.holdStartedAt = null
		this.hold = null
		this.phase = "dwell"
		// A re-sent window starts fresh: time without data is no dwell.
		this.parkedSweepSamples = 0
		this.parkIfOneHop()
		return actions
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
		const steady =
			flagged || (memory?.barred ?? false) || (memory?.steady ?? false)
		const followOnAir = hints.followOnAir === true && !flagged
		if (known === undefined) {
			v.tracks.set(track.trackId, {
				snrDb: track.snrDb,
				centreHz: track.centreHz,
				obwHz: track.obwHz,
				needsConfirm: needsConfirm && !flagged,
				confirmHoldMs,
				followOnAir,
				steady,
				open: true,
				tried: false,
				openBlocks: 0,
			})
		} else {
			known.snrDb = track.snrDb
			known.centreHz = track.centreHz
			known.obwHz = track.obwHz
			known.open = true
			if (flagged) known.needsConfirm = false
			else known.needsConfirm ||= needsConfirm
			known.followOnAir = followOnAir
			known.steady ||= steady
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
	 * repeater or a reply): the hold follows the new one, still bounded by `hold.maxHoldMs` from the
	 * start of the visit's holds.
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
		this.hold = { trackId, mode: "follow", deadline: this.maxHoldDeadline() }
	}

	onConfirmed(trackId: string, follow: boolean): SchedulerAction[] {
		if (this.phase !== "hold" || this.hold?.trackId !== trackId) return []
		if (follow && this.spec.hold.policy === "hold") {
			const open = this.visit?.tracks.get(trackId)?.open === true
			this.hold = open
				? { trackId, mode: "follow", deadline: this.maxHoldDeadline() }
				: {
						trackId,
						mode: "hang",
						deadline: Math.min(
							this.now() + this.spec.hold.hangMs,
							this.maxHoldDeadline(),
						),
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
			this.noteClosed(v, t)
		}
		if (
			this.phase === "hold" &&
			this.hold?.trackId === trackId &&
			this.hold.mode === "follow"
		)
			this.hold = {
				trackId,
				mode: "hang",
				deadline: Math.min(
					this.now() + this.spec.hold.hangMs,
					this.maxHoldDeadline(),
				),
			}
		return []
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
		if (this.hold.mode === "hang")
			return this.leaveHop([{ type: "stop-probes" }])
		return []
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
			memory: [],
			visits: 0,
			timeMs: 0,
			holdMs: 0,
		}
	}

	/**
	 * Records a sighting in the hop's frequency memory and returns its entry. A frequency still in
	 * the memory has been heard on every full visit since `firstSeenAt` (endVisit prunes the rest).
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
			entry = {
				centreHz: track.centreHz,
				halfWidthHz,
				firstSeenAt: now,
				lastSeenAt: now,
				lastSerial: v.serial,
				barred: false,
				steady: false,
				closedAt: null,
			}
			hop.memory.push(entry)
			if (hop.memory.length > MAX_FREQUENCY_MEMORY) hop.memory.shift()
		} else if (this.startsAfresh(v, entry, isNew, now)) {
			entry.firstSeenAt = now
			entry.barred = false
			entry.steady = false
		}
		entry.closedAt = null
		entry.lastSeenAt = now
		// Barred and heard again on a later visit: a frequency that outlasted a hold and is still
		// there. On air for longer than the longest hold: a carrier, not a transmission.
		const wasSteady = entry.steady
		if (entry.lastSerial < v.serial && entry.barred) entry.steady = true
		if (now - entry.firstSeenAt >= this.spec.hold.maxHoldMs) entry.steady = true
		if (entry.steady && !wasSteady) v.newlySteady = true
		entry.lastSerial = v.serial
		entry.halfWidthHz = Math.max(entry.halfWidthHz, halfWidthHz)
		return entry
	}

	/**
	 * A sighting of a remembered frequency is a new transmission when a gap was observed or may
	 * have passed unheard: its track closed in an earlier block (a close and an open in the same
	 * block is a max-duration rollover), a new track opened only after this visit had received
	 * minSurfaceBlocks + LATE_OPEN_BLOCKS blocks without it, or it was last heard more than
	 * `hold.maxHoldMs` ago (continuity is never presumed across a gap longer than the longest hold).
	 */
	private startsAfresh(
		v: Visit,
		entry: FrequencyMemory,
		isNew: boolean,
		now: number,
	): boolean {
		const closed = entry.closedAt
		if (
			closed !== null &&
			closed.serial === v.serial &&
			closed.block === v.blocks
		)
			return false
		if (closed !== null) return true
		if (now - entry.lastSeenAt > this.spec.hold.maxHoldMs) return true
		return (
			isNew &&
			entry.lastSerial < v.serial &&
			v.blocks >= this.minSurfaceBlocks + LATE_OPEN_BLOCKS
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
		memory.closedAt = { serial: v.serial, block: v.blocks }
	}

	/**
	 * Hops overlap by the widest channel: a frequency barred on one hop is barred on the hops whose
	 * span also holds it, as if their last visit had heard it (their next visit confirms or prunes).
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
				entry = { ...from, lastSerial: state.serial, steady: false }
				state.memory.push(entry)
				if (state.memory.length > MAX_FREQUENCY_MEMORY) state.memory.shift()
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
			newlySteady: false,
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
		}
		return this.leaveHop([])
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
		for (const [id, t] of v.tracks) {
			if (!t.open || t.tried || t.steady) continue
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
		this.hold = {
			trackId: c.id,
			mode: "follow",
			deadline: this.maxHoldDeadline(),
		}
		this.phase = "hold"
		return []
	}

	/**
	 * A visit chains further holds only while its holds stay within one nominal coarse sweep (the
	 * sum of the hop dwells, holds left out), capped by `hold.maxHoldMs`: the other hops wait at
	 * most one extra sweep for a busy hop, and the tracks left over are held on its next visit.
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
			Math.min(
				t.confirmHoldMs + this.probeStartMs,
				this.maxHoldDeadline() - now,
			),
		)
		t.tried = true
		this.hold = { trackId, mode: "confirm", deadline: now + holdMs }
		this.phase = "hold"
		return [{ type: "start-probe", trackId, holdMs }]
	}

	/** A probe finished (confirmed without following, or timed out): next queued track or leave. */
	private afterProbe(): SchedulerAction[] {
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
		const t = hold === null ? undefined : this.visit?.tracks.get(hold.trackId)
		if (
			hold !== null &&
			t !== undefined &&
			t.open &&
			t.followOnAir &&
			!t.steady &&
			this.spec.hold.policy === "hold" &&
			this.spec.signalsOnly !== true
		) {
			this.hold = {
				trackId: hold.trackId,
				mode: "follow",
				deadline: this.maxHoldDeadline(),
			}
			return [{ type: "stop-probes" }]
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
		this.hold = null
		if (v === null) return
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		hop.visits++
		hop.timeMs += Math.max(0, now - v.startedAt)
		if (v.holdStartedAt !== null)
			hop.holdMs += Math.max(0, now - v.holdStartedAt)
		// A hold that ended with its track still on air bars the frequency from another hold
		// until a full visit misses it; one that ended with the track gone frees it.
		let openBlocks = 0
		const barred = new Set<FrequencyMemory>()
		for (const t of v.tracks.values()) {
			const memory = this.memoryOf(hop, t)
			if (t.tried && memory !== undefined) {
				if (t.open) barred.add(memory)
				else if (!barred.has(memory)) memory.barred = false
			}
			if (t.steady || memory?.steady === true) continue
			openBlocks = Math.max(openBlocks, t.openBlocks)
		}
		for (const memory of barred) {
			memory.barred = true
			this.barInOverlaps(v.hopIndex, memory)
		}
		// A full dwell hears everything on air for minSurfaceBlocks blocks: what it missed is gone.
		if (v.blocks >= this.minSurfaceBlocks + 1)
			hop.memory = hop.memory.filter(m => m.lastSerial === v.serial)
		// Steady frequencies (carriers, birdies) are no activity: they never need a revisit.
		const active = v.blocks > 0 ? Math.min(1, openBlocks / v.blocks) : 0
		// A frequency that turned steady on this visit explained the hop's past score: restart it.
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
		const mapped = pending.plan.hops.map(hop => {
			const i = nearestHop(old, hop.centreHz)
			const prev = this.hops[i]
			const near =
				Math.abs((old.hops[i]?.centreHz ?? Number.NaN) - hop.centreHz) <=
				pending.plan.usableHalfSpanHz
			return prev !== undefined && near ? { ...prev } : null
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
