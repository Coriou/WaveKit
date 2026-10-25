/**
 * (Goal 0 stage 3, capture before admission): a track whose gate passed but that the
 * store has not admitted yet (no discovery) may still get a detection IQ capture, so the first
 * transmission is not lost. The capture port's ring pre-roll (IQ_CAPTURE_PREROLL_MAX_MS, 2 s)
 * already covers the track start; the scanner only has to ask before admission.
 *
 * Such captures share the port's per-source budget (IQ_CAPTURE_PER_SOURCE_PER_MINUTE = 6), so
 * pending tracks may take at most PENDING_CAPTURES_PER_SOURCE_PER_MINUTE = 2 of them per rolling
 * minute: at least 6 − 2 = 4 per minute stay for admitted tracks. Memory: at most 2 timestamps per
 * source, and a source entry is dropped once all its timestamps are older than the window.
 * At most PENDING_CAPTURE_MAX_SOURCES = 64 sources are tracked; a new source past the cap is
 * refused (the safe answer: no pending capture), so the map is at most 64 × 2 numbers.
 */
export const PENDING_CAPTURES_PER_SOURCE_PER_MINUTE = 2
export const PENDING_CAPTURE_WINDOW_MS = 60_000
export const PENDING_CAPTURE_MAX_SOURCES = 64

export class PendingCaptureLimiter {
	private readonly bySource = new Map<string, number[]>()

	constructor(private readonly now: () => number) {}

	get sources(): number {
		return this.bySource.size
	}

	/** True (and counted) when the source may take one more pending capture now. */
	take(sourceId: string): boolean {
		if (typeof sourceId !== "string" || sourceId.length === 0) return false
		const t = this.now()
		if (!Number.isFinite(t)) return false
		this.sweep(t)
		const list = this.bySource.get(sourceId)
		if (list === undefined) {
			if (this.bySource.size >= PENDING_CAPTURE_MAX_SOURCES) return false
			this.bySource.set(sourceId, [t])
			return true
		}
		if (list.length >= PENDING_CAPTURES_PER_SOURCE_PER_MINUTE) return false
		list.push(t)
		return true
	}

	/** A pending capture that the port refused gives its slot back. */
	release(sourceId: string): void {
		const list = this.bySource.get(sourceId)
		if (!list) return
		list.pop()
		if (list.length === 0) this.bySource.delete(sourceId)
	}

	private sweep(t: number): void {
		for (const [id, list] of this.bySource) {
			while (list.length > 0 && t - list[0]! >= PENDING_CAPTURE_WINDOW_MS)
				list.shift()
			if (list.length === 0) this.bySource.delete(id)
		}
	}
}
