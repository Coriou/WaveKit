/**
 * Turns one block's on-bins into emission segments (spec §6.2): joins runs across small holes,
 * splits them at raster channel edges, merges pieces that have no peak of their own (or sit more
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
	exclusionEdges: number[]
	rasterBinEdges: number[]
	skirtDb: number
	inWindow: boolean
	/**
	 * Far skirts (spec §6.2, P18): a strong emitter's spectral regrowth or phase-noise skirt one or two
	 * channels out can show up as a separate weak segment, because a hole in the on-bins keeps it from
	 * merging. A segment more than `minDb` below one whose peak is within `reachBins` is dropped and that
	 * segment flagged `skirt`, unless it sits at the strong one's mirror about `dcBin` (an IQ image,
	 * Task 11a flags those). Absent: off.
	 */
	farSkirt?: { reachBins: number; minDb: number; dcBin: number }
}

/** A raster piece keeps its identity only if its peak rises this far above the valley to its neighbour. */
export const PROMINENCE_DB = 6
/** Peak bins this close to mirror positions about DC count as an IQ-image pair, which far-skirt dropping leaves alone. */
const MIRROR_SLACK_BINS = 2

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
	for (const [start, end] of findRuns(on, opts)) {
		const pieces = splitAtEdges(start, end, edges, on, powerDb)
		for (const piece of mergeSkirts(pieces, powerDb, opts.skirtDb)) {
			out.push(finish(piece, powerDb, floorDb, opts))
		}
	}
	return opts.farSkirt ? dropFarSkirts(out, opts.farSkirt) : out
}

function dropFarSkirts(
	segs: Segment[],
	far: NonNullable<SegmentOptions["farSkirt"]>,
): Segment[] {
	const parents = new Set<Segment>()
	const kept = segs.filter(s => {
		const parent = segs.find(
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

/** True when `p` cannot stand on its own next to the stronger neighbour `q`. */
function isSkirtOf(
	p: Piece,
	q: Piece,
	powerDb: Float32Array,
	skirtDb: number,
): boolean {
	if (q.peakDb <= p.peakDb) return false
	const prominence = p.peakDb - valleyBetween(p.peakBin, q.peakBin, powerDb)
	return prominence < PROMINENCE_DB || q.peakDb - p.peakDb > skirtDb
}

function mergeSkirts(
	pieces: Piece[],
	powerDb: Float32Array,
	skirtDb: number,
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
				left !== undefined && isSkirtOf(p, left, powerDb, skirtDb)
			const failsRight =
				right !== undefined && isSkirtOf(p, right, powerDb, skirtDb)
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
	const touchesSpan =
		p.start <= opts.usableStartBin + opts.gapBins ||
		p.end >= opts.usableEndBin - opts.gapBins
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
