/**
 * Per-discovery confirm memory. The confirm interpreters accept an identity on
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
 * - Acceptance is kept per scope too (isAccepted / markAccepted): an identity accepted on one
 *   discovery is never accepted on another through the same decoder. At most
 *   CONFIRM_MAX_ENTRIES accepted entries, least recently used evicted first.
 * - Content-aware ambient callers use pairMessage: two distinct payloads need no skew delay;
 *   identical payloads never pair. Other callers keep pair() and its separation guard.
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
	private readonly messages = new Map<string, { at: number; message: string }>()
	private readonly seen = new Map<string, number>()
	/** Accepted entry ids, least recently used first. */
	private readonly accepted = new Set<string>()

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

	/**
	 * Content-aware ambient pairing needs no 2 s delay: different checked payloads prove
	 * two messages even when aircraft send them milliseconds apart. Identical content
	 * never pairs, even after 2 s; callers without content retain pair()'s skew guard.
	 * At most 4096 identity entries, each with one 64-character digest (4096 × 64).
	 */
	pairMessage(
		scope: string,
		key: string,
		value: string,
		message: string,
	): boolean {
		if (
			!validPart(scope) ||
			!validPart(key) ||
			!validPart(value) ||
			!validPart(message)
		)
			return false
		let at: number
		try {
			at = this.now()
		} catch {
			return false
		}
		if (!Number.isFinite(at)) return false
		const id = `${scope}\u0000${key}\u0000${value}`
		const previous = this.messages.get(id)
		if (previous && at < previous.at) return false
		const inWindow =
			previous !== undefined && at - previous.at <= CONFIRM_WINDOW_MS
		if (inWindow && previous.message === message) return false
		const temporalPair = this.pair(scope, key, value)
		this.messages.delete(id)
		this.messages.set(id, { at, message })
		while (this.messages.size > CONFIRM_MAX_ENTRIES) {
			const oldest = this.messages.keys().next()
			if (!oldest.done) this.messages.delete(oldest.value)
		}
		return inWindow || (previous === undefined && temporalPair)
	}

	/** Whether `value` under `key` is accepted in `scope` (refreshes its recency). */
	isAccepted(scope: string, key: string, value: string): boolean {
		if (!validPart(scope) || !validPart(key) || !validPart(value)) return false
		const id = `${scope}\u0000${key}\u0000${value}`
		if (!this.accepted.has(id)) return false
		this.accepted.delete(id)
		this.accepted.add(id)
		return true
	}

	markAccepted(scope: string, key: string, value: string): void {
		if (!validPart(scope) || !validPart(key) || !validPart(value)) return
		const id = `${scope}\u0000${key}\u0000${value}`
		this.accepted.delete(id)
		this.accepted.add(id)
		while (this.accepted.size > CONFIRM_MAX_ENTRIES) {
			const oldest = this.accepted.values().next()
			if (oldest.done === true) break
			this.accepted.delete(oldest.value)
		}
	}

	get acceptedSize(): number {
		return this.accepted.size
	}

	clear(): void {
		this.messages.clear()
		this.seen.clear()
		this.accepted.clear()
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
