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
	/**
	 * Blocks the track needs before its class (and so `followOnAir`) is known; younger updates
	 * report `followOnAir: false` and `voiceLater: true` (a spectrum that reads as analog voice).
	 * The classifier calls a track of at most 4 blocks a burst: 5.
	 */
	labelAfterBlocks?: number
	/**
	 * A decoder confirms the track this long into its confirm probe, while it is on air, and the
	 * job follows it (job runner onEvidence → `onConfirmed(trackId, true)`). Absent: no decode.
	 */
	decodeAfterMs?: number
	/**
	 * With `decodeAfterMs`: whether the job follows the decoded track (`onConfirmed(trackId, true)`,
	 * the default) or only notes the decode (`false`: voice not recorded, `onConfirmed(trackId,
	 * false)`).
	 */
	decodeFollows?: boolean
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
	/** Stops after this many loop steps (`SimResult.truncated`): the caller's hard work bound. */
	maxSteps?: number
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
	/** Loop steps taken: one per settle, epoch start, block, or run of quiet blocks. */
	steps: number
	/** Stopped by `maxSteps` before `durationMs` or `maxSweeps`. */
	truncated: boolean
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

/**
 * First block, counted from `clock` in blocks of `blockMs`, in which `sig` is on air (on for the
 * whole block, as the main loop counts it); null when none of the next `limit` blocks.
 */
function firstOnBlock(
	sig: SimSignal,
	clock: number,
	blockMs: number,
	limit: number,
): number | null {
	const j = Math.max(0, Math.ceil((sig.startMs - clock) / blockMs))
	if (j >= limit || sig.endMs < clock + (j + 1) * blockMs) return null
	return j
}

/**
 * Runs the scheduler until `durationMs` (or `maxSweeps`, or `maxSteps`). Cost: one loop step per
 * block while a signal of the tuned hop is on air or tracked, a hold runs or the hop is parked;
 * otherwise the quiet rest of a dwell is one step (scheduler `onBlocks`), so an empty band costs
 * a few steps per visit whatever the dwell and block lengths.
 */
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
	/** Confirm probes running: track id → clock the probe started. */
	const probes = new Map<string, number>()
	const apply = (actions: SchedulerAction[]): void => {
		for (const a of actions) {
			if (a.type === "sweep-complete") sweepEndsMs.push(clock)
			if (a.type === "start-probe") probes.set(a.trackId, clock)
			if (a.type === "stop-probes") probes.clear()
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
	const maxSteps = opts.maxSteps ?? Number.POSITIVE_INFINITY
	let steps = 0
	let truncated = false
	const listen = (tuned: number | null, from: number, to: number): void => {
		if (tuned === null) return
		const lastListen = listens.at(-1)
		if (lastListen && lastListen.hopIndex === tuned && lastListen.toMs === from)
			lastListen.toMs = to
		else listens.push({ hopIndex: tuned, fromMs: from, toMs: to })
	}
	/** Blocks from `clock` that can be skipped in one step (0: step block by block). */
	const quietBlocks = (hop: Hop | undefined): number => {
		const left = s.dwellBlocksLeft()
		if (left === null || left < 2) return 0
		let k = left
		for (const [i, sig] of signals.entries()) {
			if (!inHop(hop, sig.centreHz)) continue
			if (open[i] === true || (onBlocks[i] ?? 0) > 0) return 0
			const j = firstOnBlock(sig, clock, opts.blockMs, k)
			if (j !== null) k = j
		}
		return k >= 2 ? k : 0
	}
	while (clock < opts.durationMs && sweepEndsMs.length < maxSweeps) {
		if (steps >= maxSteps) {
			truncated = true
			break
		}
		steps++
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
		const hop = hopIndex === null ? undefined : plan.hops[hopIndex]
		const tuned = hopIndex
		const quiet = quietBlocks(hop)
		if (quiet > 0) {
			// No signal of this hop is on air or tracked in these blocks: nothing to report.
			clock += quiet * opts.blockMs
			listen(tuned, from, clock)
			apply(s.onBlocks(clock, quiet))
			noteHold()
			apply(s.tick(clock))
			noteHold()
			continue
		}
		clock += opts.blockMs
		listen(tuned, from, clock)
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
							{
								followOnAir:
									sig.followOnAir && blocks >= (sig.labelAfterBlocks ?? 0),
								voiceLater:
									sig.followOnAir && blocks < (sig.labelAfterBlocks ?? 0),
							},
						),
					)
					const probedAt = probes.get(id)
					if (
						sig.decodeAfterMs !== undefined &&
						probedAt !== undefined &&
						clock - probedAt >= sig.decodeAfterMs
					) {
						probes.delete(id)
						pending.push(...s.onConfirmed(id, sig.decodeFollows !== false))
					}
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
		steps,
		truncated,
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

/** A listening span, ms. */
export interface Span {
	fromMs: number
	toMs: number
}

/**
 * Start times s (a transmission of `txMs` is on air over [s, s + txMs]) for which it is on air for
 * `needMs` inside `span` [f, t] (it surfaces there) and, when `holdMs` is set, still on air
 * `holdMs` after the span ends (the dwell end, where the scheduler starts its hold).
 * Surfacing: s in [f + needMs − txMs, t − needMs]; none when the span or the transmission is
 * shorter than `needMs`. For s ≥ f the overlap is min(txMs, t − s) ≥ needMs; for s < f it is
 * min(s + txMs, t) − f ≥ min(needMs, t − f) ≥ needMs.
 * Held: s in [t + holdMs − txMs, t − needMs]; none when the span is shorter than `needMs` or the
 * transmission shorter than `needMs + holdMs` (it then covers [max(s, f), t] in full).
 */
function startInterval(
	span: Span,
	txMs: number,
	needMs: number,
	holdMs: number | null,
): { a: number; b: number } | null {
	if (span.toMs - span.fromMs < needMs || txMs < needMs + (holdMs ?? 0))
		return null
	const a =
		holdMs === null ? span.fromMs + needMs - txMs : span.toMs + holdMs - txMs
	const b = span.toMs - needMs
	return b > a ? { a, b } : null
}

/** Measure of the union of `intervals` clipped to [fromMs, toMs), over the window. */
function unionShare(
	intervals: { a: number; b: number }[],
	fromMs: number,
	toMs: number,
): number {
	const window = toMs - fromMs
	if (window <= 0) return 0
	const clipped = intervals
		.map(iv => ({ a: Math.max(fromMs, iv.a), b: Math.min(toMs, iv.b) }))
		.filter(iv => iv.b > iv.a)
		.sort((x, y) => x.a - y.a)
	let total = 0
	let curA: number | null = null
	let curB = 0
	for (const iv of clipped) {
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

/** Spans sorted and merged where they touch or overlap. */
function mergeSpans(spans: readonly Span[]): Span[] {
	const out: Span[] = []
	for (const sp of [...spans].sort((x, y) => x.fromMs - y.fromMs)) {
		const last = out.at(-1)
		if (last && sp.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, sp.toMs)
		else if (sp.toMs > sp.fromMs) out.push({ ...sp })
	}
	return out
}

/**
 * Probability that a transmission of `txMs` starting uniformly in `[fromMs, toMs)` is on air for
 * `needMs` inside one listening span, and with `holdMs` set still on air `holdMs` after that span
 * ends (see startInterval). Spans are merged first (a block run split in two records is one
 * span). Detection: needMs = minSurfaceBlocks blocks, holdMs = null; for one span of d per period
 * P that is (D + d − 2·needMs) / P. Decode: holdMs = the confirm hold, (D − needMs − holdMs) / P.
 */
export function interceptProbability(
	spans: readonly Span[],
	txMs: number,
	needMs: number,
	holdMs: number | null,
	fromMs: number,
	toMs: number,
): number {
	const intervals: { a: number; b: number }[] = []
	for (const sp of mergeSpans(spans)) {
		const iv = startInterval(sp, txMs, needMs, holdMs)
		if (iv) intervals.push(iv)
	}
	return unionShare(intervals, fromMs, toMs)
}

/**
 * interceptProbability for a schedule that repeats with period W = toMs − fromMs: `spans` inside
 * [fromMs, toMs) are one period, copies k·W later or earlier are the rest. Bounded work whatever
 * `txMs`: a span's start interval [a, b] is at most d + txMs − 2·needMs long; when it is at
 * least 2·W one of its copies covers the whole window (probability 1). Otherwise the copies tried
 * are k in [ceil((fromMs − b) / W), ceil((toMs − a) / W)], at most (b − a) / W + 3 < 5 of them, so
 * the work is at most 5 intervals per span (plus one wrap-around span joining a span that ends at
 * toMs to one that starts at fromMs). A span over the whole window is continuous listening.
 */
export function periodicInterceptProbability(
	spans: readonly Span[],
	txMs: number,
	needMs: number,
	holdMs: number | null,
	fromMs: number,
	toMs: number,
): number {
	const W = toMs - fromMs
	if (W <= 0) return 0
	const inWindow = mergeSpans(
		spans
			.map(sp => ({
				fromMs: Math.max(fromMs, sp.fromMs),
				toMs: Math.min(toMs, sp.toMs),
			}))
			.filter(sp => sp.toMs > sp.fromMs),
	)
	const first = inWindow[0]
	const last = inWindow.at(-1)
	if (first && first.fromMs <= fromMs && first.toMs >= toMs)
		return txMs >= needMs + (holdMs ?? 0) ? 1 : 0
	// A span running into the next period continues with the first one of that period.
	const periodic =
		first &&
		last &&
		first !== last &&
		last.toMs >= toMs &&
		first.fromMs <= fromMs
			? [...inWindow, { fromMs: last.fromMs, toMs: first.toMs + W }]
			: inWindow
	const intervals: { a: number; b: number }[] = []
	for (const sp of periodic) {
		const iv = startInterval(sp, txMs, needMs, holdMs)
		if (iv === null) continue
		if (iv.b - iv.a >= 2 * W) return 1
		const kMin = Math.ceil((fromMs - iv.b) / W)
		const kMax = Math.ceil((toMs - iv.a) / W)
		for (let k = kMin; k <= kMax; k++)
			intervals.push({ a: iv.a + k * W, b: iv.b + k * W })
	}
	return unionShare(intervals, fromMs, toMs)
}
