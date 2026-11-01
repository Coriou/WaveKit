/**
 * (Goal 0 stage 3, capture before admission): a track whose gate passed but that the
 * store has not admitted yet (no discovery) may still get a detection IQ capture, so the first
 * transmission is not lost. The capture port's ring pre-roll (IQ_CAPTURE_PREROLL_MAX_MS, 2 s)
 * already covers the track start; the scanner only has to ask before admission.
 *
 * Such captures share the port's per-source budget (IQ_CAPTURE_PER_SOURCE_PER_MINUTE = 6), so
 * captures of observations that are still pending may take at most
 * PENDING_CAPTURES_PER_SOURCE_PER_MINUTE = 2 of them per rolling minute: at least 6 − 2 = 4 per
 * minute stay for admitted tracks. A pending capture whose observation is admitted afterwards
 * (`admitted`) is an admitted track's capture from then on and gives its pending slot back: a
 * strong carrier admitted 4 s after its gate pass no longer blocks the next minute's short bursts.
 * Captures of observations never admitted (noise, a weak carrier) keep counting for the whole
 * window, so they still take at most 2 per minute.
 *
 * Memory: at most 2 (timestamp, observation id) slots per source, and a source entry is dropped
 * once all its slots are older than the window. At most PENDING_CAPTURE_MAX_SOURCES = 64 sources
 * are tracked; a new source past the cap is refused (the safe answer: no pending capture), so the
 * map is at most 64 × 2 slots.
 */
export const PENDING_CAPTURES_PER_SOURCE_PER_MINUTE = 2
export const PENDING_CAPTURE_WINDOW_MS = 60_000
export const PENDING_CAPTURE_MAX_SOURCES = 64

interface Slot {
	at: number
	observationId: string | null
}

export class PendingCaptureLimiter {
	private readonly bySource = new Map<string, Slot[]>()

	constructor(private readonly now: () => number) {}

	get sources(): number {
		return this.bySource.size
	}

	/** True (and counted) when the source may take one more pending capture now. */
	take(sourceId: string, observationId?: string): boolean {
		if (typeof sourceId !== "string" || sourceId.length === 0) return false
		const t = this.now()
		if (!Number.isFinite(t)) return false
		this.sweep(t)
		const slot: Slot = { at: t, observationId: observationId ?? null }
		const list = this.bySource.get(sourceId)
		if (list === undefined) {
			if (this.bySource.size >= PENDING_CAPTURE_MAX_SOURCES) return false
			this.bySource.set(sourceId, [slot])
			return true
		}
		if (list.length >= PENDING_CAPTURES_PER_SOURCE_PER_MINUTE) return false
		list.push(slot)
		return true
	}

	/** A pending capture that the port refused gives its slot back. */
	release(sourceId: string): void {
		const list = this.bySource.get(sourceId)
		if (!list) return
		list.pop()
		if (list.length === 0) this.bySource.delete(sourceId)
	}

	/**
	 * The observation was admitted (it has a discovery now): its pending slot, if it took one, is
	 * freed. False when it held none (admitted before asking, or its slot already aged out).
	 */
	admitted(sourceId: string, observationId: string): boolean {
		const list = this.bySource.get(sourceId)
		if (!list) return false
		const i = list.findIndex(s => s.observationId === observationId)
		if (i < 0) return false
		list.splice(i, 1)
		if (list.length === 0) this.bySource.delete(sourceId)
		return true
	}

	private sweep(t: number): void {
		for (const [id, list] of this.bySource) {
			while (list.length > 0 && t - list[0]!.at >= PENDING_CAPTURE_WINDOW_MS)
				list.shift()
			if (list.length === 0) this.bySource.delete(id)
		}
	}
}

/**
 * Capture at admission: the store admitted the observation on its closing ingest (it was pending
 * before that ingest and has a discovery after it), so the gate-pass ask (which skips closing
 * snapshots) never ran for it as an admitted track. True when it should ask now: a real (not
 * synthetic, not late) track whose gate passed, closed on quiet or max-duration (a retune or a
 * gap leaves no IQ worth keeping), with no capture asked for yet and no analog trial waiting on
 * one.
 */
export function admittedAtClose(input: {
	synthetic: boolean
	late: boolean
	endReason: string | undefined
	gate: string | undefined
	pendingBefore: boolean
	hasDiscovery: boolean
	alreadyRequested: boolean
	analogDeferred: boolean
}): boolean {
	return (
		!input.synthetic &&
		!input.late &&
		(input.endReason === "quiet" || input.endReason === "max-duration") &&
		input.gate === "passed" &&
		input.pendingBefore &&
		input.hasDiscovery &&
		!input.alreadyRequested &&
		!input.analogDeferred
	)
}
