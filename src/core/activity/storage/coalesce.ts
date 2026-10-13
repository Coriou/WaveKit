/**
 * Per-entity coalescing of high-rate position receptions (WG1 req 7.6-7.8).
 * A busy ADS-B or AIS feed repeats the same aircraft or vessel every second;
 * storing each one fills the row cap within minutes and prunes rare events.
 * Activity therefore stores a position-only update of an entity at most once
 * per window, while first sightings and identity changes are always stored.
 * Live trackers and WebSocket paths never pass through here.
 */
import type { DecodeEnvelope, JsonValue } from "../types.js"

/** Identity and static fields per coalesced output type; position fields are everything else. */
const COALESCED: Readonly<
	Record<string, { entity: string; identity: readonly string[] }>
> = {
	aircraft: { entity: "icao", identity: ["callsign", "squawk"] },
	ship: {
		entity: "mmsi",
		identity: [
			"name",
			"callsign",
			"imo",
			"shipType",
			"destination",
			"eta",
			"draught",
			"navStatus",
		],
	},
}

interface EntityState {
	/** receivedAt (ms) of the last stored reception. */
	storedAt: number
	/** Last known value per identity field, as JSON text. */
	identity: Map<string, string>
}

export interface CoalesceDecision {
	store: boolean
	/** Records the reception as stored; call only once the row is admitted. */
	commit(): void
}

const STORE_UNTRACKED: CoalesceDecision = { store: true, commit: () => {} }

function asObject(
	value: JsonValue,
): { readonly [key: string]: JsonValue } | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: JsonValue })
		: null
}

export class PositionCoalescer {
	private readonly entities = new Map<string, EntityState>()
	coalesced = 0

	/**
	 * @param windowMs one stored position-only update per entity per window; 0 disables.
	 * @param maxEntities bound on tracked entities; the least recently stored go first.
	 */
	constructor(
		private readonly windowMs: number,
		private readonly maxEntities: number,
	) {}

	size(): number {
		return this.entities.size
	}

	decide(envelope: DecodeEnvelope): CoalesceDecision {
		if (this.windowMs <= 0) return STORE_UNTRACKED
		const spec = COALESCED[envelope.outputType]
		if (!spec) return STORE_UNTRACKED
		const data = asObject(envelope.decodedData)
		const id = data?.[spec.entity]
		if (!data || (typeof id !== "string" && typeof id !== "number"))
			return STORE_UNTRACKED
		const at = Date.parse(envelope.receivedAt)
		if (!Number.isFinite(at)) return STORE_UNTRACKED
		const key = `${envelope.decoderId}\u0000${envelope.outputType}\u0000${String(id)}`
		const seen = new Map<string, string>()
		for (const field of spec.identity) {
			const value = data[field]
			if (value !== undefined && value !== null)
				seen.set(field, JSON.stringify(value))
		}
		const state = this.entities.get(key)
		const changed =
			state === undefined ||
			[...seen].some(([field, value]) => state.identity.get(field) !== value)
		// A clock step backwards (at < storedAt) also stores, so it cannot mute an entity.
		const due =
			state === undefined ||
			at - state.storedAt >= this.windowMs ||
			at < state.storedAt
		if (!changed && !due) {
			return { store: false, commit: () => {} }
		}
		return {
			store: true,
			commit: () => {
				const identity = new Map(state?.identity)
				for (const [field, value] of seen) identity.set(field, value)
				this.entities.delete(key)
				this.entities.set(key, { storedAt: at, identity })
				this.evict()
			},
		}
	}

	/** Counts a reception that was not stored because of the window. */
	noteCoalesced(): void {
		this.coalesced++
	}

	/**
	 * Map order is least recently stored first. Dropping the oldest entries is
	 * safe: an evicted entity's next reception is stored as a first sighting.
	 */
	private evict(): void {
		for (const key of this.entities.keys()) {
			if (this.entities.size <= this.maxEntities) return
			this.entities.delete(key)
		}
	}
}
