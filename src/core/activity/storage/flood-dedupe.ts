/**
 * Meshtastic flood-copy memory for Activity admission (WG3 req 6.1-6.8).
 *
 * A mesh rebroadcasts each packet from several nodes, so one packet reaches
 * the receiver several times within seconds. A reception is a copy when a
 * queued reception with the same `from`, `id`, `portnum` and payload was
 * received 0 to 30 000 ms earlier, both bounds inclusive, by `receivedAt`.
 * A backward step (negative delta) is never a copy.
 *
 * Pure: no clock, no I/O. Entries live in a Map keyed by `<from>:<id>`; a
 * ring of the last `maxEntries` remembers gives the insertion order, so the
 * oldest remember is evicted in O(1). (Evicting through `map.keys().next()`
 * walks V8's deleted-entry holes and cost about 40 us per call.) A key
 * remembered again moves to the newest slot; its old slot goes stale and
 * still counts toward the bound, so at most `maxEntries` entries are live.
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
	slot: number
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
	private readonly ring: (string | undefined)[]
	private cursor = 0

	constructor(
		private readonly windowMs: number = FLOOD_WINDOW_MS,
		maxEntries: number = FLOOD_MAX_ENTRIES,
	) {
		this.ring = new Array<string | undefined>(Math.max(1, maxEntries))
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

	/** Remembers a queued reception, replacing any entry for its key. */
	remember(key: FloodKey, eventId: string): void {
		const slot = this.cursor
		const oldest = this.ring[slot]
		if (oldest !== undefined && this.entries.get(oldest)?.slot === slot)
			this.entries.delete(oldest)
		this.ring[slot] = key.key
		this.cursor = slot + 1 === this.ring.length ? 0 : slot + 1
		this.entries.set(key.key, {
			eventId,
			atMs: key.atMs,
			hash: key.hash,
			slot,
		})
	}

	/** Forgets `key` only while it still names `eventId` (a failed write). */
	forget(key: string, eventId: string): void {
		if (this.entries.get(key)?.eventId === eventId) this.entries.delete(key)
	}
}
