/**
 * Helpers of a discovery list read: how often it gives the event loop a turn, and the page's
 * records picked without sorting the whole store.
 */

/**
 * Longest stretch a paced read holds the main thread between rows: the 2 ms main-thread budget
 * of docs/PERFORMANCE.md. One row can pass it, so the worst stretch is this plus one row:
 * (1 own + 8 co-channel partners, DQ_CO_CHANNEL_MAX) × 256 observations
 * (OBSERVATIONS_PER_DISCOVERY) = 2,304 observation visits.
 */
export const LIST_SLICE_MS = 2

/** When a paced read gives way, and how. Injected by tests to yield at chosen rows. */
export interface ListPace {
	/** True once the current slice has spent its time. Called once per row. */
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
