/**
 * Helpers of a discovery list read: how often it gives the event loop a turn, and the page's
 * records picked without sorting the whole store.
 */

/**
 * Longest stretch a paced read holds the main thread between checks: the 2 ms main-thread budget
 * of docs/PERFORMANCE.md. One row can pass it, so the worst stretch is this plus one row:
 * (1 own + 8 co-channel partners, DQ_CO_CHANNEL_MAX) × 256 observations
 * (OBSERVATIONS_PER_DISCOVERY) = 2,304 observation visits.
 */
export const LIST_SLICE_MS = 2

/**
 * A paced selection checks its pace after this many steps (a comparison or a moved element).
 * Measured at about 104 ns per comparison (18.3 M comparisons in 1.9 s on a million records), so
 * 1,024 steps are about 0.1 ms: a slice ends within 5 % of LIST_SLICE_MS.
 */
export const LIST_PACE_EVERY_STEPS = 1_024

/**
 * The most comparisons a paced selection makes between two pace checks: 1,023 steps short of a
 * check, then one heap step that overshoots it. A heap step is 1 comparison at the root and
 * 2 per level of the sift; a heap holds under half of a store of at most 1,000,000 records
 * (`storage.maxDiscoveries`), under 2^20, so at most 20 levels: 1,023 + 1 + 2 × 20 = 1,064.
 */
export const LIST_STRETCH_COMPARISONS = 1_064

/** When a paced read gives way, and how. Injected by tests to yield at chosen rows. */
export interface ListPace {
	/** True once the current slice has spent its time. Called once per row, and every LIST_PACE_EVERY_STEPS steps of a selection. */
	due(): boolean
	/** Gives the event loop a turn and starts a new slice. */
	wait(): Promise<void>
}

export function createListPace(
	now: () => number = () => performance.now(),
): ListPace {
	let start = now()
	return {
		due: () => now() - start >= LIST_SLICE_MS,
		wait: async () => {
			await new Promise<void>(resolve => setImmediate(resolve))
			start = now()
		},
	}
}

/**
 * The `count` first records of `items` under `compare` (a total order), sorted. Sorting all of N
 * takes up to N × log2 N comparisons; this keeps a heap of `count`, so at most
 * 2 × count (build) + (N − count) × (1 + 2 × log2 count) (worst: each record beats the root)
 * + count × log2 count (the final sort), and about N when few records beat the root. Asking for
 * half or more falls back to the sort: the heap no longer saves anything.
 *
 * The heap scans newest insertion first. The store's Map keeps creation order and the default
 * sort is newest first, so the page is mostly found early and later records lose at the root.
 * `items` may be reordered.
 */
export function firstSorted<T>(
	items: T[],
	count: number,
	compare: (a: T, b: T) => number,
): T[] {
	if (count <= 0) return []
	if (count * 2 >= items.length) return items.sort(compare).slice(0, count)
	// Max-heap of the best `count` so far: the root is the first to lose its place.
	const heap = items.slice(items.length - count)
	const siftDown = (from: number): void => {
		let at = from
		for (;;) {
			const left = 2 * at + 1
			if (left >= count) return
			const right = left + 1
			const child =
				right < count && compare(heap[right]!, heap[left]!) > 0 ? right : left
			if (compare(heap[child]!, heap[at]!) <= 0) return
			const moved = heap[at]!
			heap[at] = heap[child]!
			heap[child] = moved
			at = child
		}
	}
	for (let i = (count >>> 1) - 1; i >= 0; i--) siftDown(i)
	for (let i = items.length - count - 1; i >= 0; i--) {
		const item = items[i]!
		if (compare(item, heap[0]!) >= 0) continue
		heap[0] = item
		siftDown(0)
	}
	return heap.sort(compare)
}

/**
 * `items` sorted, bottom-up: at most N × ceil(log2 N) comparisons and as many moves, with a pace
 * check every LIST_PACE_EVERY_STEPS of either. `items` serves as scratch space. The one stretch
 * without a check is the allocation of the second array (N pointers, 8 MB at a million records,
 * at memory speed). `alreadySpent` counts the steps since the caller's last check.
 */
async function mergeSortPaced<T>(
	items: T[],
	compare: (a: T, b: T) => number,
	pace: ListPace,
	alreadySpent = 0,
): Promise<T[]> {
	const n = items.length
	let from = items
	let to = new Array<T>(n)
	let spent = alreadySpent
	for (let width = 1; width < n; width *= 2) {
		for (let lo = 0; lo < n; lo += 2 * width) {
			const mid = Math.min(lo + width, n)
			const hi = Math.min(lo + 2 * width, n)
			let left = lo
			let right = mid
			for (let at = lo; at < hi; at++) {
				if (
					left < mid &&
					(right >= hi || compare(from[right]!, from[left]!) >= 0)
				)
					to[at] = from[left++]!
				else to[at] = from[right++]!
				if (++spent >= LIST_PACE_EVERY_STEPS) {
					spent = 0
					if (pace.due()) await pace.wait()
				}
			}
		}
		const swap = from
		from = to
		to = swap
	}
	return from
}

/**
 * `firstSorted` that checks `pace` at bounded intervals (LIST_STRETCH_COMPARISONS). It answers the
 * same records in the same order for the same total order, so `compare` must read keys that hold
 * still across a yield: a snapshot, not a live record. Same bound on comparisons as `firstSorted`;
 * the sort of a large count is N × ceil(log2 N).
 */
export async function firstSortedPaced<T>(
	items: T[],
	count: number,
	compare: (a: T, b: T) => number,
	pace: ListPace,
): Promise<T[]> {
	if (count <= 0) return []
	if (count * 2 >= items.length)
		return (await mergeSortPaced(items, compare, pace)).slice(0, count)
	const heap = items.slice(items.length - count)
	/** One sift from `from`; answers its comparisons. */
	const siftDown = (from: number): number => {
		let at = from
		let comparisons = 0
		for (;;) {
			const left = 2 * at + 1
			if (left >= count) return comparisons
			const right = left + 1
			let child = left
			if (right < count) {
				comparisons++
				if (compare(heap[right]!, heap[left]!) > 0) child = right
			}
			comparisons++
			if (compare(heap[child]!, heap[at]!) <= 0) return comparisons
			const moved = heap[at]!
			heap[at] = heap[child]!
			heap[child] = moved
			at = child
		}
	}
	let spent = 0
	for (let i = (count >>> 1) - 1; i >= 0; i--) {
		spent += siftDown(i)
		if (spent >= LIST_PACE_EVERY_STEPS) {
			spent = 0
			if (pace.due()) await pace.wait()
		}
	}
	for (let i = items.length - count - 1; i >= 0; i--) {
		const item = items[i]!
		spent++
		if (compare(item, heap[0]!) < 0) {
			heap[0] = item
			spent += siftDown(0)
		}
		if (spent >= LIST_PACE_EVERY_STEPS) {
			spent = 0
			if (pace.due()) await pace.wait()
		}
	}
	return mergeSortPaced(heap, compare, pace, spent)
}
