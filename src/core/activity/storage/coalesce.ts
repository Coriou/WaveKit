/**
 * Per-entity coalescing of redundant position and presence receptions
 * (WG1 req 7.6-7.9). A busy ADS-B or AIS feed repeats the same aircraft or
 * vessel every second; storing each one fills the row cap within minutes and
 * prunes rare events. Activity therefore stores a redundant update of an
 * entity at most once per window. A reception is redundant only when every
 * field it carries is on the type's position/kinematics/presence allowlist or
 * is an identity field whose value is unchanged; anything else (a first
 * sighting, a changed identity, any other field or AIS message type) is
 * stored. Bare presence (an ICAO address with reception metadata only, as
 * Beast output gives) is redundant by this rule. Live trackers and WebSocket
 * paths never pass through here.
 */
import type { DecodeEnvelope, JsonValue } from "../types.js"

type JsonObject = { readonly [key: string]: JsonValue }

interface CoalesceSpec {
	/** Entity id field. */
	entity: string
	/** Position, kinematics, presence and reception metadata: never a reason to store. */
	redundant: ReadonlySet<string>
	/** Compared with the last stored value; a change (or a first value) is stored. */
	identity: readonly string[]
	/** Extra gate on the whole reception (AIS message types). */
	eligible?: (data: JsonObject) => boolean
}

const AIRCRAFT: CoalesceSpec = {
	entity: "icao",
	redundant: new Set([
		"icao",
		"hex",
		"lat",
		"lon",
		"altitude",
		"alt_baro",
		"alt_geom",
		"groundSpeed",
		"gs",
		"track",
		"heading",
		"true_heading",
		"mag_heading",
		"verticalRate",
		"baro_rate",
		"geom_rate",
		"signal",
		"rssi",
		"messageCount",
		"messages",
		"lastSeen",
		"seen",
		"seen_pos",
		"timestamp",
	]),
	identity: [
		"callsign",
		"flight",
		"squawk",
		"onGround",
		"ground",
		"category",
		"emergency",
	],
}

/** Class A position reports (1-3), class B (18, 19) and long-range (27). */
const SHIP_POSITION_TYPES = new Set([1, 2, 3, 18, 19, 27])

const SHIP: CoalesceSpec = {
	entity: "mmsi",
	redundant: new Set([
		"mmsi",
		"messageType",
		"lat",
		"lon",
		"cog",
		"sog",
		"heading",
		"lastSeen",
		"timestamp",
	]),
	// Type 19 carries name and ship type; the class A status is navStatus.
	identity: [
		"navStatus",
		"name",
		"callsign",
		"imo",
		"shipType",
		"destination",
		"eta",
		"draught",
	],
	eligible: data =>
		typeof data["messageType"] === "number" &&
		SHIP_POSITION_TYPES.has(data["messageType"]),
}

const SPECS: Readonly<Record<string, CoalesceSpec>> = {
	aircraft: AIRCRAFT,
	ship: SHIP,
}

interface EntityState {
	/** receivedAt (ms) of the last stored reception. */
	storedAt: number
	/** Last known value per identity field, as JSON text. */
	identity: Map<string, string>
}

export interface CoalesceDecision {
	store: boolean
	/**
	 * Records the reception as stored; call only once the row is queued. The
	 * returned function undoes it if the write later fails.
	 */
	commit(): () => void
}

const NOOP = (): void => {}
const STORE_UNTRACKED: CoalesceDecision = { store: true, commit: () => NOOP }

function asObject(value: JsonValue): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null
}

export class PositionCoalescer {
	private readonly entities = new Map<string, EntityState>()
	coalesced = 0

	/**
	 * @param windowMs one stored redundant update per entity per window; 0 disables.
	 * @param maxEntities bound on tracked entities (at least 1); the least recently stored go first.
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
		const spec = SPECS[envelope.outputType]
		if (!spec) return STORE_UNTRACKED
		const data = asObject(envelope.decodedData)
		const id = data?.[spec.entity]
		if (!data || (typeof id !== "string" && typeof id !== "number"))
			return STORE_UNTRACKED
		// receivedAt is the ingest clock, allocated once per reception by the
		// Activity ingress; producer timestamps never drive the window.
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
		const informative =
			(spec.eligible !== undefined && !spec.eligible(data)) ||
			Object.keys(data).some(
				field =>
					data[field] !== null &&
					!spec.redundant.has(field) &&
					!spec.identity.includes(field),
			)
		const changed =
			state === undefined ||
			[...seen].some(([field, value]) => state.identity.get(field) !== value)
		// A clock step backwards (at < storedAt) also stores, so it cannot mute an entity.
		const due =
			state === undefined ||
			at - state.storedAt >= this.windowMs ||
			at < state.storedAt
		if (!informative && !changed && !due)
			return { store: false, commit: () => NOOP }
		return { store: true, commit: () => this.record(key, state, seen, at) }
	}

	/** Counts a reception that was not stored because of the window. */
	noteCoalesced(): void {
		this.coalesced++
	}

	private record(
		key: string,
		previous: EntityState | undefined,
		seen: ReadonlyMap<string, string>,
		at: number,
	): () => void {
		const identity = new Map(previous?.identity)
		for (const [field, value] of seen) identity.set(field, value)
		const next: EntityState = { storedAt: at, identity }
		this.entities.delete(key)
		this.entities.set(key, next)
		this.evict()
		return () => {
			// Only while this reception is still the entity's latest stored one.
			if (this.entities.get(key) !== next) return
			this.entities.delete(key)
			if (previous) {
				this.entities.set(key, previous)
				this.evict()
			}
		}
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
