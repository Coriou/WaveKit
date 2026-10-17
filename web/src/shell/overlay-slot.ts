// Where an overlay outside the shell (the connection chip) may sit on a wide window: the gap on the top row between
// the Tuner and the Receiver, and the free plot width beside a full-height drawer. Null on narrow windows, where the
// chip sits above the bottom row instead. Written by the shell on every layout.
import { Store } from "../data/store.ts"

export interface OverlaySlot {
	/** The top-row gap between the Tuner and the Receiver, or null while the Receiver stacks under the Tuner. */
	readonly gap: { readonly x: number; readonly w: number } | null
	/** Width of the plot left of a full-height drawer (the window's width without one). */
	readonly freeW: number
	/** Bottom of the top row: below it the plot is free. */
	readonly topRow: number
}

export const overlaySlot = new Store<OverlaySlot | null>(null)

export function sameSlot(
	a: OverlaySlot | null,
	b: OverlaySlot | null,
): boolean {
	if (a === null || b === null) return a === b
	return (
		a.freeW === b.freeW &&
		a.topRow === b.topRow &&
		a.gap?.x === b.gap?.x &&
		a.gap?.w === b.gap?.w
	)
}
