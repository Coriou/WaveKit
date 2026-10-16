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

interface HopState {
	activityScore: number
	scoreAt: number | null
	lastVisit: number | null
	gainTenthsDb: number | null
	cleanVisits: number
	boost: boolean
}

interface TrackInfo {
	snrDb: number
	needsConfirm: boolean
	confirmHoldMs: number
	open: boolean
	tried: boolean
}

interface Visit {
	hopIndex: number
	revisit: boolean
	dwellEnd: number | null
	blocks: number
	activeBlocks: number
	overloaded: boolean
	tracks: Map<string, TrackInfo>
	holdStartedAt: number | null
}

interface Hold {
	trackId: string
	mode: "confirm" | "follow" | "hang"
	deadline: number
}

type Phase = "idle" | "tuning" | "dwell" | "hold"

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
		v.dwellEnd = startSample + this.dwellSamples()
		v.tracks.clear()
		v.holdStartedAt = null
		this.hold = null
		this.phase = "dwell"
		return actions
	}

	onBlock(endSample: number): SchedulerAction[] {
		const v = this.visit
		if (v === null || (this.phase !== "dwell" && this.phase !== "hold"))
			return []
		v.blocks++
		for (const t of v.tracks.values())
			if (t.open) {
				v.activeBlocks++
				break
			}
		if (
			this.phase === "dwell" &&
			v.dwellEnd !== null &&
			endSample >= v.dwellEnd
		)
			return this.decide()
		return []
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
	): SchedulerAction[] {
		const v = this.visit
		if (v === null || (this.phase !== "dwell" && this.phase !== "hold"))
			return []
		// truncated, iqImage and spur are sticky and may first appear on a later track-update: never probed (§ 4.9)
		const flagged =
			track.flags.truncated || track.flags.iqImage || track.flags.spur
		const known = v.tracks.get(track.trackId)
		if (known === undefined) {
			v.tracks.set(track.trackId, {
				snrDb: track.snrDb,
				needsConfirm: needsConfirm && !flagged,
				confirmHoldMs,
				open: true,
				tried: false,
			})
		} else {
			known.snrDb = track.snrDb
			known.open = true
			if (flagged) known.needsConfirm = false
			else known.needsConfirm ||= needsConfirm
			known.confirmHoldMs = Math.max(known.confirmHoldMs, confirmHoldMs)
		}
		// the held track turned out truncated or an image: drop its probe and hold
		if (
			flagged &&
			this.phase === "hold" &&
			this.hold?.trackId === track.trackId
		)
			return this.afterProbe()
		return []
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
		const t = this.visit?.tracks.get(trackId)
		if (t !== undefined) t.open = false
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
		if (this.hold.mode === "confirm") return this.afterProbe()
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

	replan(plan: HopPlan, spec: NormalisedJobSpec): void {
		if (plan.hops.length === 0)
			throw new WaveKitError(
				"A sweep needs at least one hop",
				"SCANNER_EMPTY_PLAN",
			)
		this.pendingReplan = { plan, spec }
		// The plan still swaps at the hop boundary. signalsOnly is a track decision,
		// so the next confirm sees it before that boundary.
		if (spec.signalsOnly !== undefined) this.spec.signalsOnly = spec.signalsOnly
		else delete this.spec.signalsOnly
		if (this.phase === "idle") this.applyReplan()
	}

	progress(): {
		sweepIndex: number
		hopIndex: number
		hopCount: number
		sweepPeriodMs: number | null
		holdingOn: string | null
		coverage: number
	} {
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
		}
	}

	private dwellSamples(): number {
		const blocks = (this.minSurfaceBlocks + 1) * this.blockSamples
		const current = this.visit?.hopIndex ?? 0
		const dwellMs = this.plan.hops[current]?.dwellMs ?? this.spec.dwellMs
		const operator = Math.round(
			((dwellMs - this.spec.settleMs) * this.sampleRateHz) / 1000,
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
		this.visit = {
			hopIndex,
			revisit,
			dwellEnd: null,
			blocks: 0,
			activeBlocks: 0,
			overloaded: false,
			tracks: new Map(),
			holdStartedAt: null,
		}
		this.hold = null
		this.phase = "tuning"
		return [
			{
				type: "tune",
				hopIndex,
				centreHz: hop.centreHz,
				gainTenthsDb:
					this.hops[hopIndex]?.gainTenthsDb ?? this.spec.tuner.gainTenthsDb,
			},
		]
	}

	private decide(): SchedulerAction[] {
		const v = this.visit
		if (v === null) return []
		this.visited.add(v.hopIndex)
		if (this.spec.hold.policy !== "never") {
			const next = this.nextCandidate()
			if (next !== null) {
				v.holdStartedAt = this.now()
				return this.startProbe(next[0], next[1])
			}
		}
		return this.leaveHop([])
	}

	private nextCandidate(): [string, TrackInfo] | null {
		if (this.spec.signalsOnly === true) return null
		const v = this.visit
		if (v === null) return null
		let best: [string, TrackInfo] | null = null
		for (const [id, t] of v.tracks) {
			if (!t.open || !t.needsConfirm || t.tried) continue
			if (
				best === null ||
				t.snrDb > best[1].snrDb ||
				(t.snrDb === best[1].snrDb && id < best[0])
			)
				best = [id, t]
		}
		return best
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
		if (next !== null && this.now() < this.maxHoldDeadline())
			return [...stop, ...this.startProbe(next[0], next[1])]
		return this.leaveHop(stop)
	}

	private maxHoldDeadline(): number {
		return (this.visit?.holdStartedAt ?? this.now()) + this.spec.hold.maxHoldMs
	}

	private leaveHop(prefix: SchedulerAction[]): SchedulerAction[] {
		const now = this.now()
		const wasRevisit = this.visit?.revisit ?? false
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
		if (revisit !== null) {
			this.coarseSinceRevisit = 0
			return [...actions, ...this.tuneTo(revisit, true)]
		}
		return [...actions, ...this.tuneTo(this.coarseIndex, false)]
	}

	private endVisit(now: number): void {
		const v = this.visit
		this.hold = null
		if (v === null) return
		const hop = this.hops[v.hopIndex]
		if (hop === undefined) return
		const active = v.blocks > 0 ? v.activeBlocks / v.blocks : 0
		if (hop.scoreAt === null) hop.activityScore = active
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
