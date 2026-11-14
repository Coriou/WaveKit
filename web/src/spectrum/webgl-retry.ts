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
	/** A probe is on its way: nothing else is due until it is answered. */
	private probing = false

	/**
	 * Whether to ask now. Only a plot that draws in basic mode asks: one whose renderer is still
	 * starting, or has none for another reason, has nothing to gain from a remount.
	 */
	due(kind: RendererKind, now: number): boolean {
		return kind === "canvas2d" && !this.probing && now >= this.notBefore
	}

	/** A probe was sent: a second return to the tab before its answer asks nothing. */
	probeStarted(): void {
		this.probing = true
	}

	/** The probe's answer; with WebGL2 back the plot remounts, which counts as an attempt. */
	probeAnswered(back: boolean, now: number): void {
		this.probing = false
		if (back) this.attempted(now)
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

/** What tryWebglAgain needs of the engine. */
export interface RetryEngine {
	health(): { rendererKind: RendererKind }
	probeWebgl2(): Promise<boolean>
}

/**
 * The tab came back into view: when a try is due, asks the engine (where its renderer lives)
 * whether WebGL2 is back, and calls `remount` if it is and the engine is still the plot's
 * (`current`). Resolves to whether it remounted.
 */
export async function tryWebglAgain(
	retry: WebglRetry,
	engine: RetryEngine,
	current: () => boolean,
	remount: () => void,
	now: () => number = Date.now,
): Promise<boolean> {
	if (!retry.due(engine.health().rendererKind, now())) return false
	retry.probeStarted()
	const back = await engine.probeWebgl2().catch(() => false)
	const go = back && current()
	retry.probeAnswered(go, now())
	if (go) remount()
	return go
}
