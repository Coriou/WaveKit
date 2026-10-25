/**
 * Per-discovery confirm memory (WG16 SC fix 3a). The confirm interpreters accept an identity on
 * its second CRC-clean occurrence (H2). Each probe and each ambient decoder keeps its own
 * DoubleMatch, so a POCSAG capcode decoded once per short probe never paired. This memory is
 * shared by every probe and ambient decoder: an occurrence pairs with an earlier one under the
 * same scope (the discovery, else the observation), key and value.
 *
 * Rules:
 * - Pairs only when the earlier occurrence is at least CONFIRM_MIN_SEPARATION_MS and at most
 *   CONFIRM_WINDOW_MS old. Closer occurrences are one transmission heard by two decoders (a
 *   probe and an ambient decoder on the same channel) and never pair; that occurrence keeps
 *   the earlier time so a real repeat still measures from it.
 * - A paired or fresh occurrence records its own time (a repeat refreshes the window).
 * - At most CONFIRM_MAX_ENTRIES entries; the least recently recorded is evicted first.
 * - Invalid scope, key, value or clock reading: no pairing (the safe answer).
 */

/**
 * Pairing window: 5 min = 300 000 ms. A scanner probe holds a channel for seconds and the
 * scheduler revisits it within minutes; a pager or beacon repeating every 60 s pairs within
 * the window with 5x margin, while an identity seen once an hour never confirms on its own.
 */
export const CONFIRM_WINDOW_MS = 300_000

/**
 * Least separation between paired occurrences: 2 000 ms. Two live decoders hearing one
 * transmission emit it within their output skew (chunked IQ plus decoder buffering, well
 * under 2 s), so occurrences closer than this are counted once.
 */
export const CONFIRM_MIN_SEPARATION_MS = 2_000

/**
 * Entry bound: 4096 = 256 discoveries x 16 identities each. An entry is a short key string
 * and a number (about 200 bytes), so the memory stays under 1 MB.
 */
export const CONFIRM_MAX_ENTRIES = 4096

/** Longest scope, key or value part accepted (identity values are at most 193 characters). */
export const CONFIRM_MAX_PART_CHARS = 256

export class ConfirmMemory {
	/** Entry id → time recorded, least recently recorded first. */
	private readonly seen = new Map<string, number>()

	constructor(private readonly now: () => number) {}

	get size(): number {
		return this.seen.size
	}

	/** True when this occurrence pairs with an earlier one in `scope` (see the module rules). */
	pair(scope: string, key: string, value: string): boolean {
		if (!validPart(scope) || !validPart(key) || !validPart(value)) return false
		let at: number
		try {
			at = this.now()
		} catch {
			return false
		}
		if (!Number.isFinite(at)) return false
		this.expire(at)
		const id = `${scope}\u0000${key}\u0000${value}`
		const prev = this.seen.get(id)
		if (prev !== undefined && at - prev < CONFIRM_MIN_SEPARATION_MS)
			return false
		const paired = prev !== undefined && at - prev <= CONFIRM_WINDOW_MS
		this.seen.delete(id)
		this.seen.set(id, at)
		while (this.seen.size > CONFIRM_MAX_ENTRIES) {
			const oldest = this.seen.keys().next()
			if (oldest.done === true) break
			this.seen.delete(oldest.value)
		}
		return paired
	}

	clear(): void {
		this.seen.clear()
	}

	/** Drops entries older than the window, oldest first (insertion order is recording order). */
	private expire(at: number): void {
		for (const [id, t] of this.seen) {
			// A clock that stepped back keeps the entry; it expires once time passes it again.
			if (at - t <= CONFIRM_WINDOW_MS) break
			this.seen.delete(id)
		}
	}
}

function validPart(part: string): boolean {
	return (
		typeof part === "string" &&
		part.length > 0 &&
		part.length <= CONFIRM_MAX_PART_CHARS
	)
}
