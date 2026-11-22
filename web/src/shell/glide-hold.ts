/**
 * When a slot held for the tuned card's glide may show again (DESIGN.md, "Layout: rails and stage", motion).
 *
 * The glide is a CSS transition, and a transition starts on the first frame that resolves the card's new style, not
 * at the React commit that moved it: on a starved page (a loaded host draws 1 or 2 frames in 600 ms) that frame can
 * come hundreds of milliseconds late. A hold released on a timer from the commit then lets the player (or a drawer)
 * show while the card is still crossing it. So the timer is only the earliest release: from then on the hold waits,
 * frame by frame, until the card's painted box stands at its new home.
 */
import type { Rect } from "./layout/geometry.ts"

/** How long the tuned card glides to a new home (shell.css `.wk-shell-cardslot`: --wk-dur-4, 260 ms), and the margin
 * after it before a slot held for the glide may show (a frame or two of the transition's end). */
export const CARD_GLIDE_MS = 260
export const CARD_GLIDE_MARGIN_MS = 60

/** The clock the hold runs on (the browser's timers and animation frames; a fake one in the tests). */
export interface GlideClock {
	/** Calls `fn` once after `ms`; returns a cancel. */
	after(ms: number, fn: () => void): () => void
	/** Calls `fn` on the next animation frame; returns a cancel. */
	frame(fn: () => void): () => void
}

export const browserClock: GlideClock = {
	after(ms, fn) {
		const id = setTimeout(fn, ms)
		return () => clearTimeout(id)
	},
	frame(fn) {
		if (typeof requestAnimationFrame !== "function") {
			const id = setTimeout(fn, 16)
			return () => clearTimeout(id)
		}
		const id = requestAnimationFrame(() => fn())
		return () => cancelAnimationFrame(id)
	},
}

/** A held slot shows again only after this long, even if the card's box never reads as landed (a lost element, a
 * transition the browser dropped): a slot must not stay out of sight for good. */
export const GLIDE_HOLD_CAP_MS = 4000

/**
 * Holds until the glide has landed: not before `minMs` (the glide's time plus its margin), then on the first check,
 * at `minMs` or on a later animation frame, where `landed()` says the card's painted box is at its new home; at
 * `capMs` at the latest. Calls `release` once. Returns a cancel (a chained glide, an unmount).
 */
export function holdUntilLanded(o: {
	clock: GlideClock
	minMs: number
	capMs?: number
	landed: () => boolean
	release: () => void
}): () => void {
	let done = false
	const cancels: (() => void)[] = []
	const stop = () => {
		for (const c of cancels.splice(0)) c()
	}
	const finish = () => {
		if (done) return
		done = true
		stop()
		o.release()
	}
	const check = () => {
		if (done) return
		if (o.landed()) finish()
		else cancels.push(o.clock.frame(check))
	}
	cancels.push(o.clock.after(o.minMs, check))
	cancels.push(o.clock.after(o.capMs ?? GLIDE_HOLD_CAP_MS, finish))
	return () => {
		done = true
		stop()
	}
}

/** The card's painted box is at `to` (its position within 1 px; the glide moves it by a transform), or there is no
 * card to wait for. */
export function cardLanded(
	box: { x: number; y: number } | null,
	to: Rect | null,
): boolean {
	if (!box || !to) return true
	return Math.abs(box.x - to.x) <= 1 && Math.abs(box.y - to.y) <= 1
}
