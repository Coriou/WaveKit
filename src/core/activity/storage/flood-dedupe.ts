/**
 * Meshtastic flood-copy memory for Activity admission (WG3 req 6.1-6.8).
 *
 * A mesh rebroadcasts each packet from several nodes, so one packet reaches
 * the receiver several times within seconds. A reception is a copy when a
 * queued reception with the same `from`, `id`, `portnum` and payload was
 * received 0 to 30 000 ms earlier, both bounds inclusive, by `receivedAt`.
 * A backward step (negative delta) is never a copy.
 *
 * Pure: no clock, no I/O. Entries live in a Map keyed by `<from>:<id>` and
 * on a doubly linked list in remember order (oldest at the head), so
 * re-remember, forget and evict-oldest are all O(1). Only live entries count
 * toward `maxEntries`. (Evicting through `map.keys().next()` walks V8's
 * deleted-entry holes and cost about 40 us per call.)
 */

export const FLOOD_WINDOW_MS = 30_000
export const FLOOD_MAX_ENTRIES = 20_000

const UINT32_MAX = 0xffff_ffff
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** The identity of one valid Meshtastic reception. */
export interface FloodKey {
	/** `<from>:<id>`. */
	key: string
	/** FNV-1a 32 of `<portnum>:<payloadB64>`. */
	hash: number
	atMs: number
}

interface FloodEntry {
	eventId: string
	atMs: number
	hash: number
	key: string
	prev: FloodEntry | undefined
	next: FloodEntry | undefined
}

function isUint32(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= UINT32_MAX
	)
}

function fnvStep(seed: number, text: string): number {
	let hash = seed
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, FNV_PRIME)
	}
	return hash
}

/** FNV-1a 32 over UTF-16 code units (base64 is ASCII, so bytes). */
export function fnv1a32(text: string): number {
	return fnvStep(FNV_OFFSET, text) >>> 0
}

/** fnv1a32(`${portnum}:${payloadB64}`) without building the string. */
function packetHash(portnum: number, payloadB64: string): number {
	let hash = fnvStep(FNV_OFFSET, String(portnum))
	hash = Math.imul(hash ^ 0x3a, FNV_PRIME)
	return fnvStep(hash, payloadB64) >>> 0
}

/**
 * Extracts the dedupe key from a `meshtastic` reception's decodedData, or
 * undefined when it can never be a copy: not an object, `from` not uint32,
 * `id` not a non-zero uint32, `portnum` not uint32, `payloadB64` not a
 * string, or `receivedAt` not a parseable time.
 */
export function floodKeyOf(
	decodedData: unknown,
	receivedAt: string,
): FloodKey | undefined {
	if (
		typeof decodedData !== "object" ||
		decodedData === null ||
		Array.isArray(decodedData)
	)
		return undefined
	const data = decodedData as Record<string, unknown>
	const { from, id, portnum, payloadB64 } = data
	if (!isUint32(from) || !isUint32(id) || id === 0) return undefined
	if (!isUint32(portnum) || typeof payloadB64 !== "string") return undefined
	const atMs = Date.parse(receivedAt)
	if (!Number.isFinite(atMs)) return undefined
	return {
		key: `${from}:${id}`,
		hash: packetHash(portnum, payloadB64),
		atMs,
	}
}

export class FloodDedupe {
	private readonly entries = new Map<string, FloodEntry>()
	private head: FloodEntry | undefined
	private tail: FloodEntry | undefined
	private readonly maxEntries: number

	constructor(
		private readonly windowMs: number = FLOOD_WINDOW_MS,
		maxEntries: number = FLOOD_MAX_ENTRIES,
	) {
		this.maxEntries = Math.max(1, maxEntries)
	}

	get size(): number {
		return this.entries.size
	}

	/** True when a remembered original matches within [0, windowMs]. */
	isCopy(key: FloodKey): boolean {
		const entry = this.entries.get(key.key)
		if (!entry || entry.hash !== key.hash) return false
		const delta = key.atMs - entry.atMs
		return delta >= 0 && delta <= this.windowMs
	}

	/**
	 * Remembers a queued reception, replacing any entry for its key and making
	 * it the newest. Evicts the oldest live entry only at `maxEntries`.
	 */
	remember(key: FloodKey, eventId: string): void {
		const existing = this.entries.get(key.key)
		if (existing) {
			this.unlink(existing)
			existing.eventId = eventId
			existing.atMs = key.atMs
			existing.hash = key.hash
			this.append(existing)
			return
		}
		if (this.entries.size >= this.maxEntries && this.head) {
			const oldest = this.head
			this.unlink(oldest)
			this.entries.delete(oldest.key)
		}
		const entry: FloodEntry = {
			eventId,
			atMs: key.atMs,
			hash: key.hash,
			key: key.key,
			prev: undefined,
			next: undefined,
		}
		this.entries.set(key.key, entry)
		this.append(entry)
	}

	/** Forgets `key` only while it still names `eventId` (a failed write). */
	forget(key: string, eventId: string): void {
		const entry = this.entries.get(key)
		if (entry?.eventId !== eventId) return
		this.unlink(entry)
		this.entries.delete(key)
	}

	private append(entry: FloodEntry): void {
		entry.prev = this.tail
		entry.next = undefined
		if (this.tail) this.tail.next = entry
		else this.head = entry
		this.tail = entry
	}

	private unlink(entry: FloodEntry): void {
		if (entry.prev) entry.prev.next = entry.next
		else this.head = entry.next
		if (entry.next) entry.next.prev = entry.prev
		else this.tail = entry.prev
		entry.prev = undefined
		entry.next = undefined
	}
}
