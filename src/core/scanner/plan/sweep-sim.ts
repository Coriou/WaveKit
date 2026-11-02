// src/core/scanner/plan/sweep-sim.ts
/**
 * Deterministic sweep simulator: drives the real SweepScheduler with a fake clock, a timer settle
 * per tune and fixed-length detection blocks. One sample is one millisecond, so dwell arithmetic in
 * samples reads as milliseconds. The plan preview runs it on an empty band to report the period and
 * intercept probability the scheduler really produces; tests add synthetic on-air signals to check
 * per-hop time share and intercept. Pure: no I/O, no wall clock.
 */
import { SweepScheduler, type SchedulerAction } from "../scheduler.js"
import type { Hop, HopPlan, NormalisedJobSpec } from "../types.js"
import type { TrackSnapshot } from "../../spectrum/types.js"

export interface SimSignal {
	centreHz: number
	startMs: number
	/** `Number.POSITIVE_INFINITY` for a steady carrier. */
	endMs: number
	snrDb: number
	/** What the service would answer for this track (narrow, gated, not decoded yet). */
	needsConfirm: boolean
	/** Confirm hold the job runner passes (class hold + probe start latency). */
	confirmHoldMs: number
	/** Analog voice the job follows on air (job runner `followOnAir`). */
	followOnAir: boolean
	spur?: boolean
	obwHz?: number
}

export interface SimOptions {
	settleMs: number
	blockMs: number
	minSurfaceBlocks: number
	probeStartMs: number
	durationMs: number
	signals?: readonly SimSignal[]
	activitySeed?: (hop: Hop) => number
	/** Stops once this many sweeps completed (the preview's bound). */
	maxSweeps?: number
}

export interface SimVisit {
	hopIndex: number
	tunedAtMs: number
	leftAtMs: number
}

export interface SimResult {
	/** One record per tune (a continued visit stays in its tune's record). */
	visits: SimVisit[]
	/** Settled listening per hop: merged block spans, ms. */
	listens: { hopIndex: number; fromMs: number; toMs: number }[]
	/** Times sweeps completed. */
	sweepEndsMs: number[]
	/** First time each signal surfaced as a track, null when never. */
	detectedAtMs: (number | null)[]
	/** Listening ms per signal while it was on air and its hop was tuned. */
	heardMs: number[]
	/** Holds started per signal (confirm or follow). */
	holds: number[]
	/** Simulated end time. */
	endMs: number
}

/** Same frequency within the hop: a signal belongs to every hop whose covered span holds it. */
function inHop(hop: Hop | undefined, hz: number): boolean {
	return (
		hop !== undefined && hz >= hop.covered.startHz && hz <= hop.covered.endHz
	)
}

function trackOf(
	id: string,
	sig: SimSignal,
	epoch: number,
	fromMs: number,
	toMs: number,
	blocks: number,
): TrackSnapshot {
	return {
		trackId: id,
		sourceId: "sim",
		stream: 1,
		epoch,
		startSample: fromMs,
		lastSample: toMs,
		centreHz: sig.centreHz,
		obwHz: sig.obwHz ?? 11_000,
		obwMethod: "-20dB",
		peakDbfs: -80 + sig.snrDb + 5,
		meanDbfs: -80 + sig.snrDb,
		snrDb: sig.snrDb,
		floorDbfs: -80,
		thresholdDb: 9,
		blocks,
		maxBlockSnrDb: sig.snrDb,
		dutyCycle: 1,
		spectralShape: "flat",
		flags: {
			overload: false,
			gap: false,
			truncated: false,
			edge: false,
			skirt: false,
			obwBiased: false,
			burst: false,
			iqImage: false,
			spur: sig.spur ?? false,
		},
		tuningTrust: "commanded",
	}
}

/** Runs the scheduler until `durationMs` (or `maxSweeps`). Cost: one loop step per block. */
export function simulateSweep(
	plan: HopPlan,
	spec: NormalisedJobSpec,
	opts: SimOptions,
): SimResult {
	const signals = opts.signals ?? []
	let clock = 0
	const s = new SweepScheduler(plan, spec, {
		blockSamples: opts.blockMs,
		sampleRateHz: 1000,
		now: () => clock,
		probeStartMs: opts.probeStartMs,
		minSurfaceBlocks: opts.minSurfaceBlocks,
		...(opts.activitySeed ? { activitySeed: opts.activitySeed } : {}),
	})
	const visits: SimVisit[] = []
	const listens: SimResult["listens"] = []
	const sweepEndsMs: number[] = []
	const detectedAtMs: (number | null)[] = signals.map(() => null)
	const heardMs = signals.map(() => 0)
	const holds = signals.map(() => 0)
	let holding: string | null = null
	const noteHold = (): void => {
		const now = s.progress().holdingOn
		if (now !== null && now !== holding) {
			const i = Number(now.slice(now.indexOf("-s") + 2))
			holds[i] = (holds[i] ?? 0) + 1
		}
		holding = now
	}
	let hopIndex: number | null = null
	let settleAt: number | null = null
	let epoch = 0
	let settled = false
	/** Per signal on the current epoch: blocks heard so far, and whether its track is open. */
	let onBlocks = signals.map(() => 0)
	let open = signals.map(() => false)
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type === "sweep-complete") sweepEndsMs.push(clock)
			if (a.type !== "tune") continue
			const last = visits.at(-1)
			if (last) last.leftAtMs = clock
			visits.push({ hopIndex: a.hopIndex, tunedAtMs: clock, leftAtMs: clock })
			hopIndex = a.hopIndex
			epoch++
			settleAt = clock + opts.settleMs
			settled = false
			onBlocks = signals.map(() => 0)
			open = signals.map(() => false)
		}
	}
	apply(s.start())
	const maxSweeps = opts.maxSweeps ?? Number.POSITIVE_INFINITY
	while (clock < opts.durationMs && sweepEndsMs.length < maxSweeps) {
		if (settleAt !== null && clock >= settleAt) {
			settleAt = null
			settled = true
			apply(s.onEpochStarted(clock))
			continue
		}
		if (!settled) {
			clock = settleAt ?? clock + opts.blockMs
			continue
		}
		const from = clock
		clock += opts.blockMs
		const hop = hopIndex === null ? undefined : plan.hops[hopIndex]
		const tuned = hopIndex
		const lastListen = listens.at(-1)
		if (
			lastListen &&
			lastListen.hopIndex === tuned &&
			lastListen.toMs === from &&
			tuned !== null
		)
			lastListen.toMs = clock
		else if (tuned !== null)
			listens.push({ hopIndex: tuned, fromMs: from, toMs: clock })
		const pending: SchedulerAction[] = []
		signals.forEach((sig, i) => {
			const here = inHop(hop, sig.centreHz)
			const on = here && sig.startMs <= from && sig.endMs >= clock
			const id = `e${epoch}-s${i}`
			if (on) {
				heardMs[i] = (heardMs[i] ?? 0) + opts.blockMs
				const blocks = (onBlocks[i] ?? 0) + 1
				onBlocks[i] = blocks
				if (blocks >= opts.minSurfaceBlocks) {
					open[i] = true
					if (detectedAtMs[i] === null) detectedAtMs[i] = clock
					pending.push(
						...s.onTrack(
							trackOf(id, sig, epoch, from, clock, blocks),
							sig.needsConfirm,
							sig.confirmHoldMs,
							{ followOnAir: sig.followOnAir },
						),
					)
				}
			} else if (open[i] === true) {
				open[i] = false
				onBlocks[i] = 0
				pending.push(...s.onTrackClosed(id))
			} else onBlocks[i] = 0
		})
		apply(pending)
		noteHold()
		apply(s.onBlock(clock))
		noteHold()
		apply(s.tick(clock))
		noteHold()
	}
	const last = visits.at(-1)
	if (last) last.leftAtMs = clock
	return {
		visits,
		listens,
		sweepEndsMs,
		detectedAtMs,
		heardMs,
		holds,
		endMs: clock,
	}
}

/** Ms spent per hop (tune to leave) inside `[fromMs, toMs)`. */
export function hopTimeMs(
	result: SimResult,
	hopCount: number,
	fromMs = 0,
	toMs = result.endMs,
): number[] {
	const out = new Array<number>(hopCount).fill(0)
	for (const v of result.visits) {
		const a = Math.max(fromMs, v.tunedAtMs)
		const b = Math.min(toMs, v.leftAtMs)
		if (b > a) out[v.hopIndex] = (out[v.hopIndex] ?? 0) + (b - a)
	}
	return out
}

/**
 * Probability that a transmission of `txMs` starting uniformly in `[fromMs, toMs)` meets a listening
 * span: the measure of the union of start intervals `[span.from - txMs + leadMs, span.to - tailMs]`
 * over the spans, divided by the window. On air for 2T inside the span: lead = tail = 2T, which
 * for one span of d per period P is (D + d - 4T) / P.
 */
export function interceptProbability(
	spans: readonly { fromMs: number; toMs: number }[],
	txMs: number,
	leadMs: number,
	tailMs: number,
	fromMs: number,
	toMs: number,
): number {
	const window = toMs - fromMs
	if (window <= 0) return 0
	const intervals = spans
		.map(sp => ({
			a: Math.max(fromMs, sp.fromMs - txMs + leadMs),
			b: Math.min(toMs, sp.toMs - tailMs),
		}))
		.filter(iv => iv.b > iv.a)
		.sort((x, y) => x.a - y.a)
	let total = 0
	let curA: number | null = null
	let curB = 0
	for (const iv of intervals) {
		if (curA === null) {
			curA = iv.a
			curB = iv.b
		} else if (iv.a <= curB) curB = Math.max(curB, iv.b)
		else {
			total += curB - curA
			curA = iv.a
			curB = iv.b
		}
	}
	if (curA !== null) total += curB - curA
	return Math.min(1, total / window)
}
