// Windowing for the Activity list: rows of measured (or estimated) heights, only the visible ones mounted.

export interface VirtualWindow {
	/** First and one-past-last mounted entry. */
	start: number
	end: number
	/** Top offset of entry `start`, and the full scroll height. */
	offset: number
	total: number
}

/** Prefix offsets: offsets[i] is the top of entry i, offsets[n] the total height. */
export function prefixOffsets(heights: readonly number[]): Float64Array {
	const out = new Float64Array(heights.length + 1)
	for (let i = 0; i < heights.length; i++)
		out[i + 1] = (out[i] ?? 0) + (heights[i] ?? 0)
	return out
}

/** The last index whose top is at or above `y` (binary search). */
export function indexAt(offsets: Float64Array, y: number): number {
	let lo = 0
	let hi = offsets.length - 2
	if (hi < 0) return 0
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if ((offsets[mid] ?? 0) <= y) lo = mid
		else hi = mid - 1
	}
	return lo
}

/** Entries to mount for a viewport, with `overscan` pixels above and below. */
export function virtualWindow(
	offsets: Float64Array,
	scrollTop: number,
	viewport: number,
	overscan = 400,
): VirtualWindow {
	const n = offsets.length - 1
	const total = offsets[n] ?? 0
	if (n <= 0) return { start: 0, end: 0, offset: 0, total }
	const start = indexAt(offsets, Math.max(0, scrollTop - overscan))
	const bottom = scrollTop + viewport + overscan
	let end = indexAt(offsets, bottom) + 1
	if (end > n) end = n
	return { start, end, offset: offsets[start] ?? 0, total }
}
