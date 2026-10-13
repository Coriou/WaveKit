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

export interface CoalesceSpec {
	/** Entity id field. */
	entity: string
	/** Position, kinematics, presence and reception metadata: never a reason to store. */
	redundant: ReadonlySet<string>
	/** Compared with the last stored value; a change (or a first value) is stored. */
	identity: readonly string[]
	/** Extra gate on the whole reception (AIS message types, APRS position types, mesh port). */
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

/**
 * APRS position packets (WG2 req 2.1). Objects, items, messages, status,
 * weather and anything carrying `weather` or `message` stay ineligible.
 */
export const APRS_POSITION_DATA_TYPES: ReadonlySet<string> = new Set([
	"Position",
	"Position with messaging",
	"Position with timestamp",
	"Position with timestamp and messaging",
	"Mic-E",
	"Mic-E (old)",
])

const APRS: CoalesceSpec = {
	entity: "source",
	redundant: new Set([
		"source",
		"destination",
		"path",
		"dataType",
		"lat",
		"lon",
		"altitude",
		"course",
		"speed",
		"raw",
		"timestamp",
	]),
	identity: ["symbol", "comment"],
	eligible: data =>
		typeof data["dataType"] === "string" &&
		APRS_POSITION_DATA_TYPES.has(data["dataType"]) &&
		typeof data["lat"] === "number" &&
		Number.isFinite(data["lat"]) &&
		typeof data["lon"] === "number" &&
		Number.isFinite(data["lon"]),
}

/** Meshtastic POSITION_APP (portnum 3). No identity fields (WG2 req 2.2). */
const MESHTASTIC: CoalesceSpec = {
	entity: "from",
	redundant: new Set([
		"from",
		"to",
		"id",
		"channel",
		"hopLimit",
		"hopStart",
		"wantAck",
		"viaMqtt",
		"priority",
		"portnum",
		"payloadB64",
		"payloadLen",
		"rxRssi",
		"rxSnr",
		"rxTime",
		"frequency",
		"bw",
		"sf",
		"cr",
	]),
	identity: [],
	eligible: data => data["portnum"] === 3,
}

/** Output-type allowlists. Aircraft and ship are the WG1 sets, unchanged. */
export const COALESCE_SPECS: Readonly<Record<string, CoalesceSpec>> = {
	aircraft: AIRCRAFT,
	ship: SHIP,
	aprs: APRS,
	meshtastic: MESHTASTIC,
}

/**
 * Stateless form of the coalescing allowlist (WG2 req 1.6). True when the
 * eligibility gate passes and every non-null value is redundant. A present
 * identity field (callsign, symbol, name, ...) is a full reception. Undefined
 * values on a key outside both sets match `decide`: `undefined !== null`, so
 * they are not redundant either.
 */
export function isCoalescibleShape(
	outputType: string,
	data: { readonly [key: string]: unknown },
): boolean {
	const spec = COALESCE_SPECS[outputType]
	if (!spec) return false
	if (spec.eligible !== undefined && !spec.eligible(data as JsonObject))
		return false
	for (const field of Object.keys(data)) {
		const value = data[field]
		if (
			value === undefined &&
			!spec.redundant.has(field) &&
			!spec.identity.includes(field)
		)
			return false
		if (value === undefined || value === null) continue
		if (spec.identity.includes(field)) return false
		if (!spec.redundant.has(field)) return false
	}
	return true
}

/** A value and the commit (reception) that set it, so one failed row undoes only its own part. */
interface Stamped<T> {
	value: T
	by: number
}

interface EntityState {
	/** receivedAt (ms) of the last stored reception; -Infinity when none is left. */
	storedAt: Stamped<number>
	/** Last known value per identity field, as JSON text. */
	identity: Map<string, Stamped<string>>
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
	private seq = 0
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
		const spec = COALESCE_SPECS[envelope.outputType]
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
			[...seen].some(
				([field, value]) => state.identity.get(field)?.value !== value,
			)
		// A clock step backwards (at < storedAt) also stores, so it cannot mute an entity.
		const due =
			state === undefined ||
			at - state.storedAt.value >= this.windowMs ||
			at < state.storedAt.value
		if (!informative && !changed && !due)
			return { store: false, commit: () => NOOP }
		return { store: true, commit: () => this.record(key, seen, at) }
	}

	/** Counts a reception that was not stored because of the window. */
	noteCoalesced(): void {
		this.coalesced++
	}

	private record(
		key: string,
		seen: ReadonlyMap<string, string>,
		at: number,
	): () => void {
		const by = ++this.seq
		const state: EntityState = this.entities.get(key) ?? {
			storedAt: { value: Number.NEGATIVE_INFINITY, by: 0 },
			identity: new Map(),
		}
		const priorStoredAt = state.storedAt
		const priorFields = new Map<string, Stamped<string> | undefined>()
		for (const [field, value] of seen) {
			priorFields.set(field, state.identity.get(field))
			state.identity.set(field, { value, by })
		}
		state.storedAt = { value: at, by }
		this.entities.delete(key)
		this.entities.set(key, state)
		this.evict()
		// Undo touches only what this reception set and nothing later rows
		// replaced, so a later stored row never inherits a failed row's identity.
		// The ingress undoes failed rows newest first.
		return () => {
			const current = this.entities.get(key)
			if (!current) return
			for (const [field, prior] of priorFields) {
				if (current.identity.get(field)?.by !== by) continue
				if (prior) current.identity.set(field, prior)
				else current.identity.delete(field)
			}
			if (current.storedAt.by === by) current.storedAt = priorStoredAt
			if (
				current.identity.size === 0 &&
				current.storedAt.value === Number.NEGATIVE_INFINITY
			)
				this.entities.delete(key)
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
