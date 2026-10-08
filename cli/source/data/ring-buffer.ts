import type { AircraftState } from "@wavekit/api-types"
import type { AircraftEntry, MessageEntry, MessageRing } from "./types.js"

export const RING_CAPACITY = 1000
export const RING_FLOOR = 50
export const AIRCRAFT_TTL_MS = 300_000

export function createRing(
	capacity = RING_CAPACITY,
	floor = RING_FLOOR,
): MessageRing {
	return {
		capacity,
		floor,
		entries: [],
		gaps: [],
		nextSeq: 0,
		// Null prototype: decoder ids are data, so "__proto__" must be a plain key (R30).
		perDecoder: Object.create(null) as Record<string, number>,
		total: 0,
	}
}

export function ringNewestSeq(ring: MessageRing): number | null {
	return ring.entries[ring.entries.length - 1]?.seq ?? null
}

function evictOne(ring: MessageRing): void {
	let idx = ring.entries.findIndex(
		e => (ring.perDecoder[e.decoderId] ?? 0) > ring.floor,
	)
	if (idx < 0) idx = 0
	const [gone] = ring.entries.splice(idx, 1)
	if (gone)
		ring.perDecoder[gone.decoderId] = Math.max(
			0,
			(ring.perDecoder[gone.decoderId] ?? 1) - 1,
		)
}

/** Drop closed gaps older than the oldest retained entry. An open gap stays until it closes (one gap per disconnect). */
function pruneGaps(ring: MessageRing): void {
	const oldest = ring.entries[0]?.seq
	if (oldest === undefined || ring.gaps.length === 0) return
	ring.gaps = ring.gaps.filter(g => g.to === null || g.afterSeq >= oldest - 1)
}

/** Append (seq is monotonic for the session). When full, evict the oldest entry of a decoder above the floor, else the overall oldest. */
export function ringPush(
	ring: MessageRing,
	e: Omit<MessageEntry, "seq">,
): MessageEntry {
	const entry: MessageEntry = { ...e, seq: ring.nextSeq }
	ring.nextSeq++
	ring.total++
	ring.entries.push(entry)
	ring.perDecoder[e.decoderId] = (ring.perDecoder[e.decoderId] ?? 0) + 1
	while (ring.entries.length > ring.capacity) evictOne(ring)
	pruneGaps(ring)
	return entry
}

export function ringOpenGap(ring: MessageRing, from: number): void {
	const last = ring.gaps[ring.gaps.length - 1]
	if (last && last.to === null) return
	ring.gaps.push({ afterSeq: ring.nextSeq - 1, from, to: null })
}

export function ringCloseGap(ring: MessageRing, to: number): void {
	const last = ring.gaps[ring.gaps.length - 1]
	if (!last || last.to !== null) return
	last.to = Math.max(to, last.from)
}

export function aircraftKey(icao: string): string {
	return icao.toUpperCase()
}

export function aircraftUpsert(
	map: Map<string, AircraftEntry>,
	a: AircraftState,
	at: number,
): void {
	const key = aircraftKey(a.icao)
	const prev = map.get(key)?.state
	const identification =
		prev?.identification || a.identification
			? { ...prev?.identification, ...a.identification }
			: undefined
	const merged: AircraftState = {
		...prev,
		...a,
		icao: key,
		...(identification ? { identification } : {}),
	}
	map.set(key, { state: merged, at })
}

export function aircraftDelete(
	map: Map<string, AircraftEntry>,
	icao: string,
): void {
	map.delete(aircraftKey(icao))
}

export function aircraftPrune(
	map: Map<string, AircraftEntry>,
	now: number,
): number {
	let removed = 0
	for (const [key, e] of map) {
		if (now - e.at > AIRCRAFT_TTL_MS) {
			map.delete(key)
			removed++
		}
	}
	return removed
}

export function aircraftResync(
	map: Map<string, AircraftEntry>,
	list: readonly AircraftState[],
	at: number,
): void {
	map.clear()
	for (const a of list) aircraftUpsert(map, a, at)
}
