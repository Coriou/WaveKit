/**
 * When a plot that draws in basic mode (no WebGL2) may try WebGL2 again. Trying means a remount:
 * the waterfall starts over and the stream reconnects, so it is asked for sparingly.
 */

import type { RendererKind } from "./protocol.ts"

/** The wait after a first attempt (ms); it doubles after each one up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 30_000
/** The longest wait between two attempts (ms). */
export const RETRY_MAX_MS = 600_000

export class WebglRetry {
	private wait = RETRY_MIN_MS
	private notBefore = 0

	/**
	 * Whether to ask now. Only a plot that draws in basic mode asks: one whose renderer is still
	 * starting, or has none for another reason, has nothing to gain from a remount.
	 */
	due(kind: RendererKind, now: number): boolean {
		return kind === "canvas2d" && now >= this.notBefore
	}

	/** The plot remounts to try WebGL2: the next ask waits, twice as long after each attempt. */
	attempted(now: number): void {
		this.notBefore = now + this.wait
		this.wait = Math.min(this.wait * 2, RETRY_MAX_MS)
	}

	/** The renderer that came up: WebGL2 ends the waiting; basic mode again keeps it. */
	settled(kind: RendererKind): void {
		if (kind !== "webgl2") return
		this.wait = RETRY_MIN_MS
		this.notBefore = 0
	}
}
