/**
 * Turns one block's on-bins into emission segments (spec §6.2): joins runs across small holes,
 * splits them at internal dips (amendment 10) and at raster channel edges, merges pieces that have no peak of their own (or sit more
 * than skirtDb below their neighbour) back into the parent as skirt, drops far skirts (below), and
 * flags segments that touch the usable span or an exclusion. Bin ranges are half-open: [startBin, endBin).
 */
export interface Segment {
	startBin: number
	endBin: number
	peakBin: number
	peakDb: number
	centroidBin: number
	flags: { truncated: boolean; skirt: boolean; edge: boolean }
}

export interface SegmentOptions {
	gapBins: number
	usableStartBin: number
	usableEndBin: number
	/**
	 * Inner span [edgeStartBin, edgeEndBin) inside the usable one: a segment reaching past it
	 * (within `gapBins`) is flagged `edge` (in window) or `truncated` (out of window), so the
	 * outer band of the detection span stays flagged. Absent: the usable span's own bounds.
	 */
	edgeStartBin?: number
	edgeEndBin?: number
	exclusionEdges: number[]
	rasterBinEdges: number[]
	skirtDb: number
	inWindow: boolean
	/**
	 * Far skirts (spec §6.2, P18): a strong emitter's spectral regrowth or phase-noise skirt one or two
	 * channels out can show up as a separate weak segment, because a hole in the on-bins keeps it from
	 * merging. A segment more than `minDb` below one whose peak is within `reachBins` is dropped and that
	 * segment flagged `skirt`, unless it sits at the strong one's mirror about `dcBin` (an IQ image,
	 * Task 11a flags those). A weaker boundary piece with no independent peak across the hole is
	 * also dropped, using skirtDb and PROMINENCE_DB; measured masked-bin power is not zeroed.
	 * Absent: off.
	 */
	farSkirt?: { reachBins: number; minDb: number; dcBin: number }
	/**
	 * Dip split: a run is also cut at an internal valley at least `DIP_SPLIT_DB` below
	 * the peaks on both sides, measured on the power smoothed over `smoothBins` (odd, ≥ 1).
	 * Absent: off.
	 */
	dipSplit?: { smoothBins: number }
	/**
	 * Channel boundaries: sorted bin edges of the coarsest raster's channels. A
	 * prominence merge (no 6 dB valley, neighbour within `skirtDb`) never joins pieces across
	 * one, so a plateau of busy channels splits per channel. A sideband, a far-weaker skirt
	 * (more than `skirtDb` down) or a one-channel pair still merges across. Absent: no limit.
	 */
	channelEdges?: number[]
	/**
	 * Sidebands: a piece more than `db` below a neighbour whose peak is within
	 * `reachBins` merges into it whatever the valley between them (modulation sidebands and
	 * close splatter of one carrier stay with it; the raster cap does not apply). Absent: off.
	 */
	sideband?: { db: number; reachBins: number }
	/**
	 * One-channel rule: two pieces whose peaks are closer than the channel limit are one
	 * emitter whatever the valley between them, such as the two lobes of an FSK carrier cut by
	 * a raster edge it does not follow. The limit is `perBin[peak]` (the smaller of the two
	 * peaks' values; 0 = off there) when given, else `minPeakBins`. Absent: off.
	 */
	channel?: { minPeakBins: number; perBin?: Uint16Array }
}

/** A raster piece keeps its identity only if its peak rises this far above the valley to its neighbour. */
export const PROMINENCE_DB = 6
/** Peak bins this close to mirror positions about DC count as an IQ-image pair, which far-skirt dropping leaves alone. */
const MIRROR_SLACK_BINS = 2
/**
 * A valley this far below the peaks on both sides splits a run. 6 dB = `PROMINENCE_DB`,
 * the same depth that already keeps a raster piece apart, so a dip cut is never merged back as a
 * prominence skirt (the raw valley is at least as deep as the smoothed one).
 */
export const DIP_SPLIT_DB = PROMINENCE_DB
/**
 * A dip splits only when the valley lies in the lower half (in dB) of the smaller
 * peak's height above the floor. Two lobes of one FSK carrier (a 47 dB POCSAG pair with a
 * valley 10 to 20 dB down) keep their valley high above the floor; the guard gap between two
 * channels falls toward it.
 */
export const DIP_FLOOR_FRACTION = 0.5

interface Piece {
	start: number
	end: number
	peakBin: number
	peakDb: number
	skirt: boolean
}

export function segment(
	on: Uint8Array,
	powerDb: Float32Array,
	floorDb: Float32Array,
	opts: SegmentOptions,
): Segment[] {
	const edges = [...opts.rasterBinEdges].sort((a, b) => a - b)
	const out: Segment[] = []
	const rules: MergeRules | undefined =
		opts.channelEdges !== undefined ||
		opts.sideband !== undefined ||
		opts.channel !== undefined
			? {
					edges: opts.channelEdges ?? [],
					...(opts.sideband ? { sideband: opts.sideband } : {}),
					...(opts.channel ? { channel: opts.channel } : {}),
				}
			: undefined
	for (const [start, end] of findRuns(on, opts)) {
		const cuts = opts.dipSplit
			? mergeCuts(
					edges,
					dipCuts(start, end, powerDb, floorDb, opts.dipSplit.smoothBins),
				)
			: edges
		const pieces = splitAtEdges(start, end, cuts, on, powerDb)
		for (const piece of mergeSkirts(pieces, powerDb, opts.skirtDb, rules)) {
			out.push(finish(piece, powerDb, floorDb, opts))
		}
	}
	return opts.farSkirt
		? dropFarSkirts(out, opts.farSkirt, powerDb, opts.skirtDb)
		: out
}

function dropFarSkirts(
	segs: Segment[],
	far: NonNullable<SegmentOptions["farSkirt"]>,
	powerDb: Float32Array,
	skirtDb: number,
): Segment[] {
	const parents = new Set<Segment>()
	const kept = segs.filter((s, index) => {
		// Adjacent peak intervals are disjoint. The extra valley scans visit each bin at most
		// twice over the whole list, rather than scanning every pair of nearby segments.
		const boundaryParent = [segs[index - 1], segs[index + 1]].find(
			q =>
				q !== undefined &&
				isBoundarySkirt(s, q, powerDb, skirtDb, far.reachBins),
		)
		const parent =
			boundaryParent ??
			segs.find(
				q =>
					q !== s &&
					q.peakDb - s.peakDb > far.minDb &&
					Math.abs(q.peakBin - s.peakBin) <= far.reachBins &&
					Math.abs(q.peakBin + s.peakBin - 2 * far.dcBin) > MIRROR_SLACK_BINS,
			)
		if (parent !== undefined) parents.add(parent)
		return parent === undefined
	})
	for (const p of parents) p.flags.skirt = true
	return kept
}

/**
 * A mask may cut a monotone skirt into two on-runs. Its boundary maximum is not a
 * local peak when the next measured bin toward the parent is still rising. Require
 * a strong nearby parent AND less than 6 dB prominence along the entire path: a DC
 * spike alone cannot erase a genuine peak with a valley of its own. Unknown/nonfinite
 * power is insufficient evidence to reject a segment. Real mirror peaks retain the
 * ordinary far-skirt IQ-image exemption; this rule only removes pieces without a peak.
 */
function isBoundarySkirt(
	s: Segment,
	parent: Segment,
	powerDb: Float32Array,
	skirtDb: number,
	reachBins: number,
): boolean {
	if (
		!Number.isFinite(s.peakDb) ||
		!Number.isFinite(parent.peakDb) ||
		parent.peakDb - s.peakDb <= skirtDb ||
		Math.abs(parent.peakBin - s.peakBin) > reachBins
	)
		return false
	const step = parent.peakBin > s.peakBin ? 1 : -1
	if (s.peakBin !== (step > 0 ? s.endBin - 1 : s.startBin)) return false
	const next = powerDb[s.peakBin + step]
	if (next === undefined || !Number.isFinite(next) || next <= s.peakDb)
		return false
	for (let bin = s.peakBin + step; bin !== parent.peakBin; bin += step) {
		const power = powerDb[bin]
		if (
			power === undefined ||
			!Number.isFinite(power) ||
			s.peakDb - power >= PROMINENCE_DB
		)
			return false
	}
	return true
}

function findRuns(on: Uint8Array, opts: SegmentOptions): [number, number][] {
	const runs: [number, number][] = []
	const lo = Math.max(0, opts.usableStartBin)
	const hi = Math.min(on.length, opts.usableEndBin)
	let start = -1
	let lastOn = -1
	for (let i = lo; i < hi; i++) {
		if (on[i] !== 1) continue
		if (start < 0) {
			start = i
		} else if (i - lastOn - 1 > opts.gapBins) {
			runs.push([start, lastOn + 1])
			start = i
		}
		lastOn = i
	}
	if (start >= 0) runs.push([start, lastOn + 1])
	return runs
}

/** Sorted union of two sorted cut lists (the dip list is usually empty). */
function mergeCuts(a: number[], b: number[]): number[] {
	if (b.length === 0) return a
	if (a.length === 0) return b
	const out: number[] = []
	let i = 0
	let j = 0
	while (i < a.length || j < b.length) {
		const x = a[i] ?? Infinity
		const y = b[j] ?? Infinity
		if (x <= y) {
			out.push(x)
			i++
			if (x === y) j++
		} else {
			out.push(y)
			j++
		}
	}
	return out
}

/**
 * Valley bins of [start, end) that sit at least `DIP_SPLIT_DB` below the highest
 * smoothed level on each side since the previous cut, in the lower `DIP_FLOOR_FRACTION` of the
 * smaller side's height above the floor. One pass, O(end - start); the box mean over
 * `smoothBins` is a running sum in dB, so one FFT bin of scatter cannot fake a dip.
 */
function dipCuts(
	start: number,
	end: number,
	powerDb: Float32Array,
	floorDb: Float32Array,
	smoothBins: number,
): number[] {
	const cuts: number[] = []
	const half = Math.max(0, (smoothBins - 1) >> 1)
	if (end - start < 2 * half + 3) return cuts
	const at = (i: number): number => {
		const v = powerDb[i]
		return v !== undefined && Number.isFinite(v) ? v : -200
	}
	// Box over [i - half, i + half], clipped to the run.
	let sum = 0
	let lo = start
	let hi = start
	const smoothAt = (i: number): number => {
		const a = Math.max(start, i - half)
		const b = Math.min(end, i + half + 1)
		while (hi < b) sum += at(hi++)
		while (lo < a) sum -= at(lo++)
		return sum / (b - a)
	}
	let peak = smoothAt(start)
	let valley = Infinity
	let valleyAt = -1
	const deep = (lowerPeak: number): boolean => {
		const f = floorDb[valleyAt]
		const floor = f !== undefined && Number.isFinite(f) ? f : -200
		return valley - floor <= (lowerPeak - floor) * DIP_FLOOR_FRACTION
	}
	for (let i = start + 1; i < end; i++) {
		const v = smoothAt(i)
		if (
			valleyAt >= 0 &&
			peak - valley >= DIP_SPLIT_DB &&
			v - valley >= DIP_SPLIT_DB &&
			deep(Math.min(peak, v))
		) {
			cuts.push(valleyAt)
			peak = v
			valley = Infinity
			valleyAt = -1
		} else if (v > peak) {
			peak = v
			valley = Infinity
			valleyAt = -1
		} else if (v < valley) {
			valley = v
			valleyAt = i
		}
	}
	return cuts
}

function peakOf(
	start: number,
	end: number,
	powerDb: Float32Array,
): { peakBin: number; peakDb: number } {
	let peakBin = start
	let peakDb = -Infinity
	for (let i = start; i < end; i++) {
		const p = powerDb[i] ?? -Infinity
		if (p > peakDb) {
			peakDb = p
			peakBin = i
		}
	}
	return { peakBin, peakDb }
}

/** Cuts [start, end) at raster edges; each piece is trimmed to its outermost on-bins (pieces of only holes vanish). */
function splitAtEdges(
	start: number,
	end: number,
	edges: number[],
	on: Uint8Array,
	powerDb: Float32Array,
): Piece[] {
	const bounds = [start]
	for (const e of edges) if (e > start && e < end) bounds.push(e)
	bounds.push(end)
	const pieces: Piece[] = []
	for (let i = 0; i + 1 < bounds.length; i++) {
		let a = bounds[i] ?? start
		let b = bounds[i + 1] ?? end
		while (a < b && on[a] !== 1) a++
		while (b > a && on[b - 1] !== 1) b--
		if (a < b)
			pieces.push({ start: a, end: b, ...peakOf(a, b, powerDb), skirt: false })
	}
	return pieces
}

function valleyBetween(a: number, b: number, powerDb: Float32Array): number {
	const lo = Math.min(a, b)
	const hi = Math.max(a, b)
	let v = Infinity
	for (let i = lo; i <= hi; i++) v = Math.min(v, powerDb[i] ?? Infinity)
	return v
}

/** Split rules for `mergeSkirts` (all optional; absent = the pre-amendment 10 merge). */
interface MergeRules {
	edges: readonly number[]
	sideband?: SegmentOptions["sideband"]
	channel?: SegmentOptions["channel"]
}

/** True when `p` cannot stand on its own next to the stronger neighbour `q`. */
function isSkirtOf(
	p: Piece,
	q: Piece,
	powerDb: Float32Array,
	skirtDb: number,
	rules?: MergeRules,
): boolean {
	// One-channel rule: equal peaks join too (two FSK lobes are usually within 1 dB).
	if (isSameChannel(p, q, rules?.channel)) return true
	if (q.peakDb <= p.peakDb) return false
	if (isSidebandOf(p, q, rules?.sideband)) return true
	const prominence = p.peakDb - valleyBetween(p.peakBin, q.peakBin, powerDb)
	return prominence < PROMINENCE_DB || q.peakDb - p.peakDb > skirtDb
}

/** `p` peaks within one channel of the not weaker `q` (`SegmentOptions.channel`). */
function isSameChannel(
	p: Piece,
	q: Piece,
	channel: SegmentOptions["channel"],
): boolean {
	if (channel === undefined || q.peakDb < p.peakDb) return false
	const limit =
		channel.perBin !== undefined
			? Math.min(channel.perBin[p.peakBin] ?? 0, channel.perBin[q.peakBin] ?? 0)
			: channel.minPeakBins
	return Math.abs(p.peakBin - q.peakBin) < limit
}

/** `p` is a sideband of the much stronger, close `q` (see `SegmentOptions.sideband`). */
function isSidebandOf(
	p: Piece,
	q: Piece,
	sideband: SegmentOptions["sideband"],
): boolean {
	return (
		sideband !== undefined &&
		q.peakDb - p.peakDb > sideband.db &&
		Math.abs(p.peakBin - q.peakBin) <= sideband.reachBins
	)
}

/**
 * A merge of `p` into `q` that the channel boundaries refuse: a prominence merge
 * (`p` within `skirtDb` of `q`, neither its sideband nor in its channel) whose merged span
 * would hold a coarse channel edge.
 */
function capped(
	p: Piece,
	q: Piece,
	skirtDb: number,
	rules?: MergeRules,
): boolean {
	const edges = rules?.edges ?? []
	if (edges.length === 0 || q.peakDb - p.peakDb > skirtDb) return false
	if (isSidebandOf(p, q, rules?.sideband)) return false
	if (isSameChannel(p, q, rules?.channel)) return false
	const lo = Math.min(p.start, q.start)
	const hi = Math.max(p.end, q.end)
	// First edge > lo (sorted): binary search.
	let a = 0
	let b = edges.length
	while (a < b) {
		const m = (a + b) >>> 1
		if (edges[m]! <= lo) a = m + 1
		else b = m
	}
	return a < edges.length && edges[a]! < hi
}

function mergeSkirts(
	pieces: Piece[],
	powerDb: Float32Array,
	skirtDb: number,
	rules?: MergeRules,
): Piece[] {
	const list = [...pieces]
	for (;;) {
		let mergeAt = -1
		let into = -1
		let weakest = Infinity
		for (let i = 0; i < list.length; i++) {
			const p = list[i]
			if (p === undefined || p.peakDb >= weakest) continue
			const left = list[i - 1]
			const right = list[i + 1]
			const failsLeft =
				left !== undefined &&
				isSkirtOf(p, left, powerDb, skirtDb, rules) &&
				!capped(p, left, skirtDb, rules)
			const failsRight =
				right !== undefined &&
				isSkirtOf(p, right, powerDb, skirtDb, rules) &&
				!capped(p, right, skirtDb, rules)
			if (!failsLeft && !failsRight) continue
			weakest = p.peakDb
			mergeAt = i
			if (failsLeft && failsRight)
				into =
					(left?.peakDb ?? -Infinity) >= (right?.peakDb ?? -Infinity)
						? i - 1
						: i + 1
			else into = failsLeft ? i - 1 : i + 1
		}
		if (mergeAt < 0) return list
		const p = list[mergeAt]
		const q = list[into]
		if (p === undefined || q === undefined) return list
		const merged: Piece = {
			start: Math.min(p.start, q.start),
			end: Math.max(p.end, q.end),
			peakBin: q.peakBin,
			peakDb: q.peakDb,
			skirt: true,
		}
		list.splice(Math.min(mergeAt, into), 2, merged)
	}
}

function finish(
	p: Piece,
	powerDb: Float32Array,
	floorDb: Float32Array,
	opts: SegmentOptions,
): Segment {
	let num = 0
	let den = 0
	for (let i = p.start; i < p.end; i++) {
		const excess =
			10 ** ((powerDb[i] ?? -200) / 10) - 10 ** ((floorDb[i] ?? -200) / 10)
		if (excess <= 0) continue
		num += i * excess
		den += excess
	}
	const edgeStart = Math.max(
		opts.usableStartBin,
		opts.edgeStartBin ?? opts.usableStartBin,
	)
	const edgeEnd = Math.min(
		opts.usableEndBin,
		opts.edgeEndBin ?? opts.usableEndBin,
	)
	const touchesSpan =
		p.start <= edgeStart + opts.gapBins || p.end >= edgeEnd - opts.gapBins
	const touchesExclusion = opts.exclusionEdges.some(
		e => e >= p.start - opts.gapBins && e <= p.end + opts.gapBins,
	)
	const touches = touchesSpan || touchesExclusion
	return {
		startBin: p.start,
		endBin: p.end,
		peakBin: p.peakBin,
		peakDb: p.peakDb,
		centroidBin: den > 0 ? num / den : p.peakBin,
		flags: {
			truncated: touches && !opts.inWindow,
			skirt: p.skirt,
			edge: touches && opts.inWindow,
		},
	}
}
