/**
 * Bounded synchronous work while the scanner loads its state: validation and restore run in
 * slices of SCANNER_LOAD_SLICE_ITEMS items with an event-loop turn between slices, so a large
 * store never holds the main thread for the whole load (timers, worker replies such as the
 * Activity writer's open, and I/O run between slices).
 */
import type { z } from "zod"

/**
 * Items per synchronous slice. Measured on a 3,840-discovery, 76,800-observation snapshot
 * (56 MB) at load average 4 to 5: validation about 15 µs per item, restore about 17 µs per
 * item, so a 1,024-item slice holds the thread for about 15 to 17 ms. The whole load is then
 * about 80 slices, each a setImmediate turn (microseconds).
 */
export const SCANNER_LOAD_SLICE_ITEMS = 1024

export type YieldTurn = () => Promise<void>

export const yieldToEventLoop: YieldTurn = () =>
	new Promise<void>(resolve => {
		setImmediate(resolve)
	})

export type SliceParse<T> =
	| { success: true; data: T[] }
	| { success: false; issues: z.ZodIssue[] }

/**
 * `z.array(schema).safeParse(items)` in slices: the same output and the same issue paths
 * (`[key, index, ...]`), with `yieldTurn` awaited after every `sliceItems` items. Stops at the
 * first slice with an invalid item.
 */
export async function parseInSlices<T>(
	items: readonly unknown[],
	schema: z.ZodType<T>,
	key: string,
	yieldTurn: YieldTurn,
	sliceItems: number = SCANNER_LOAD_SLICE_ITEMS,
): Promise<SliceParse<T>> {
	const data: T[] = []
	const issues: z.ZodIssue[] = []
	for (let start = 0; start < items.length; start += sliceItems) {
		if (start > 0) await yieldTurn()
		const end = Math.min(items.length, start + sliceItems)
		for (let i = start; i < end; i++) {
			const parsed = schema.safeParse(items[i])
			if (parsed.success) data.push(parsed.data)
			else
				for (const issue of parsed.error.issues)
					issues.push({ ...issue, path: [key, i, ...issue.path] })
		}
		if (issues.length > 0) return { success: false, issues }
	}
	return { success: true, data }
}
