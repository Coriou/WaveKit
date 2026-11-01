/**
 * Per-entity coalescing at Activity admission (WG1 req 7.6-7.9, generalised).
 *
 * Entities, each per decoder: aircraft (ICAO address), ship (MMSI), APRS
 * position (source callsign), Meshtastic position (node) and rtl_433 sensor
 * reading (model + id + channel). Every other output (pages, calls, ACARS,
 * VDL2, ...) is one row per message, as before.
 *
 * Every reception of a tracked entity updates the entity's latest state: the
 * union of the fields on its type's allowlist (position, kinematics, presence,
 * reception metadata and identity), the newest value of each winning. A
 * reception is stored as a row when it is
 *  - a first sighting (or the first after the entity was evicted),
 *  - informative: outside the eligibility gate (AIS static data, APRS
 *    messages, other mesh ports, sensor events and readings without a
 *    measurement), or carrying any field off the allowlist,
 *  - an identity change: a first or changed value of an identity field
 *    (callsign, squawk and so an emergency squawk, emergency, AIS name or
 *    status, APRS symbol or comment, sensor battery),
 *  - due: `windowMs` or more after the entity's last stored row, or a clock
 *    step backwards.
 * Anything else is held: merged into the latest state and counted as
 * coalesced, never rate-limited. The entity's next stored row carries the
 * merged latest state (its own fields over the latest state) and
 * `coalesced: { receptions, firstSeenAt, lastSeenAt }` for the receptions it
 * stands for. Held receptions that no stored row follows are flushed as one
 * row `windowMs` after the first of them (store clock), so a row is never
 * more than one window behind the entity's latest state; an evicted entity's
 * held state is flushed at once. A held row the store cannot queue yet
 * (token bucket, queue cap, paused store) stays held and is retried; held
 * receptions are only consumed by the row that carries them. A merged row
 * over the queue byte cap can never queue: it is stored as the latest held
 * reception's own data, or counted as a drop when even that is over the cap,
 * so it never blocks the held rows behind it. A flushed row is the entity's
 * state when stored: storage/ingress.ts stamps its clocks with the store time
 * so seq order and time agree, and its `coalesced` span (even for one held
 * reception) says when the receptions were heard. A row whose write fails
 * holds the receptions it carried again (undo); none is lost. A gap of more
 * than `windowMs` between two receptions drops the stale position and
 * kinematics from the latest state (identity is kept).
 *
 * Merged state is bounded: a value over MAX_MERGED_VALUE_BYTES (JSON text) is
 * never merged or remembered as identity; the reception carrying it is
 * informative and stored as its own row. The largest allowlist (aircraft, 36
 * keys) × (1 KiB + key) is at most about 37 KiB of merged data, so a flushed
 * row always fits one envelope (128 KiB).
 *
 * Rows per entity in continuous view: one per window plus identity changes
 * (60 s: about 60 an hour), whatever the message rate. Live trackers and
 * WebSocket paths never pass through here.
 */
import type {
	DecodeAircraftIdentity,
	DecodeCoalesced,
	DecodeEnvelope,
	JsonValue,
} from "../types.js"

type JsonObject = { readonly [key: string]: JsonValue }

/** Largest allowlisted value (JSON text bytes) merged into an entity's latest state. */
export const MAX_MERGED_VALUE_BYTES = 1024

export interface CoalesceSpec {
	/** Entity id field. */
	entity: string
	/** Further fields that are part of the entity id when present (sensor model, channel). */
	entityParts?: readonly string[]
	/** Position, kinematics, presence and reception metadata: never a reason to store. */
	redundant: ReadonlySet<string>
	/** Compared with the last stored value; a change (or a first value) is stored. */
	identity: readonly string[]
	/** Extra gate on the whole reception (AIS message types, APRS position types, mesh port). */
	eligible?: (data: JsonObject) => boolean
	/** False: the reception names no entity; stored as it is and never tracked. */
	tracked?: (data: JsonObject) => boolean
	/**
	 * Rows keep their full presentation: `isCoalescibleShape` is false, so no
	 * position-only row shape or budget applies (sensor readings have no position).
	 */
	fullRows?: true
	/**
	 * Stored rows always list their fields (altitude, speed, track, ...):
	 * `isPositionOnlyShape` is false. A stored row stands for the entity's
	 * merged state (or a first sighting), never one of many position fixes.
	 */
	listRows?: true
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
		// readsb reception metadata (src/decoders/builtin/readsb.ts AircraftData): which output
		// format, the source clock and the SBS line hash, and a Beast frame's Mode S header.
		"readsbFormat",
		"sbsSourceTimestamp",
		"sbsContentId",
		"jsonSourceTimestamp",
		"modeS",
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
	listRows: true,
	// A Beast frame whose address is not CRC-proven (modeS.crcOk false) names no
	// aircraft: never tracked, so it cannot fill the entity bound with junk ids.
	tracked: data => {
		const modeS = data["modeS"]
		if (modeS === undefined || modeS === null) return true
		const header = asObject(modeS)
		return header !== null && header["crcOk"] === true
	},
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
		// AIS radio channel A or B (src/decoders/builtin/ais-catcher.ts ShipData): vessels alternate.
		"channel",
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
	listRows: true,
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

/** rtl_433 identity keys and `-M time/level/protocol` metadata: no measurement. */
const SENSOR_METADATA = [
	"model",
	"id",
	"channel",
	"time",
	"mic",
	"mod",
	"freq",
	"freq1",
	"freq2",
	"rssi",
	"snr",
	"noise",
	"protocol",
]

/**
 * rtl_433 periodic sensor readings (`signal` outputs, src/decoders/builtin/rtl433.ts), keyed
 * like the sensor presentation: model, id and channel. Weather-station measurements and
 * rtl_433's `-M time/level/protocol` metadata are redundant; a battery change is identity.
 * Any other field (button, event, state, code, alarm, tamper, ...) makes the reading an
 * event of its own, stored as a row. So is a reception with no measurement at all (only
 * identity, metadata or battery: a doorbell or remote press): every one is stored.
 */
const SENSOR: CoalesceSpec = {
	entity: "id",
	entityParts: ["model", "channel"],
	redundant: new Set([
		...SENSOR_METADATA,
		"temperature_C",
		"temperature_F",
		"humidity",
		"pressure_hPa",
		"pressure_kPa",
		"wind_avg_km_h",
		"wind_avg_m_s",
		"wind_max_km_h",
		"wind_max_m_s",
		"wind_dir_deg",
		"rain_mm",
		"rain_in",
		"uv",
		"uvi",
		"light_lux",
		"moisture",
		"battery_V",
		"battery_mV",
	]),
	identity: ["battery_ok", "subtype"],
	eligible: data => typeof data["model"] === "string" && hasMeasurement(data),
	fullRows: true,
}

const SENSOR_NOT_MEASURED: ReadonlySet<string> = new Set([
	...SENSOR_METADATA,
	"battery_ok",
	"subtype",
])

/** A non-null field beyond identity, metadata and battery state. */
function hasMeasurement(data: JsonObject): boolean {
	for (const field in data) {
		const value = data[field]
		if (
			value !== undefined &&
			value !== null &&
			!SENSOR_NOT_MEASURED.has(field)
		)
			return true
	}
	return false
}

/** Output-type allowlists. Aircraft and ship are the WG1 sets plus reception metadata. */
export const COALESCE_SPECS: Readonly<Record<string, CoalesceSpec>> = {
	aircraft: AIRCRAFT,
	ship: SHIP,
	aprs: APRS,
	meshtastic: MESHTASTIC,
	signal: SENSOR,
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
	if (!spec || spec.fullRows) return false
	if (spec.tracked !== undefined && !spec.tracked(data as JsonObject))
		return false
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

/**
 * Presenter form of the allowlist: the reception's row is a bare position
 * (a map point with no list fields, held to the small row budget). APRS and
 * mesh positions only; aircraft and ship rows always list their fields
 * (`listRows`), whatever admission merges (reception metadata, kinematics).
 */
export function isPositionOnlyShape(
	outputType: string,
	data: { readonly [key: string]: unknown },
): boolean {
	if (COALESCE_SPECS[outputType]?.listRows) return false
	return isCoalescibleShape(outputType, data)
}

/**
 * An identity value as remembered: primitives as they are (compared with
 * `===`, so the string "7700" and the number 7700 differ), anything else as
 * its JSON text.
 */
type IdentityValue = string | number | boolean | { readonly json: string }

function identityValue(value: JsonValue): IdentityValue {
	return typeof value === "object" && value !== null
		? { json: JSON.stringify(value) }
		: (value as string | number | boolean)
}

/** No JSON text for a primitive: the hot path compares without allocating. */
function sameIdentity(
	known: IdentityValue | undefined,
	value: JsonValue,
): boolean {
	if (known === undefined) return false
	if (typeof known !== "object") return known === value
	return (
		typeof value === "object" &&
		value !== null &&
		known.json === JSON.stringify(value)
	)
}

/**
 * A value and the commit (reception) that set it, linked to the value it
 * replaced. A failed commit is marked, never restored: undo walks back past
 * every failed stamp, so a failed row's identity or clock cannot come back
 * through a later row's undo, whatever order the rows fail in. A settled
 * (written) stamp drops its link; nothing before it is ever needed again.
 */
interface Stamped<T> {
	value: T
	failed: boolean
	prev: Stamped<T> | undefined
}

/**
 * Presents a held or merged reception: given the merged latest state, returns
 * the envelope to store (see ActivityIngress.admit). Retained while held.
 */
export type CoalescePresenter = (merged?: CoalesceMerge) => DecodeEnvelope

/** Receptions held back since the entity's last stored row. */
interface Held {
	/** The latest held reception: a flushed row carries its eventId and clocks. */
	envelope: DecodeEnvelope
	present: CoalescePresenter | undefined
	receptions: number
	firstSeenAt: string
	/** Store clock (ms) when the held receptions are flushed as one row. */
	dueAt: number
}

/**
 * One tracked entity. Memory, bounded by maxEntities: the map key (decoder id,
 * output type and entity id, about 40-80 B); at most 8 identity stamps (about
 * 60 B each); `latest`, at most the type's allowlist (aircraft 36 keys; a
 * decoder sends 10-15) holding values shared with the envelopes (about
 * 0.3-0.6 KB); while held, one envelope and its presenter (the decoder output,
 * context and plain envelope, about 1-1.5 KB). The admission bench measured
 * about 1.3 KB per tracked aircraft and 1.0 KB more while one SBS reception is
 * held (without the presenter); see ACTIVITY_POSITION_COALESCE_MAX_ENTITIES.
 */
interface EntityState {
	/** receivedAt (ms) of the last stored reception; -Infinity when none is left. */
	storedAt: Stamped<number> | undefined
	/** Last known value per identity field. */
	identity: Map<string, Stamped<IdentityValue>>
	/** Merged latest state: allowlisted fields only, newest value wins. */
	latest: Map<string, JsonValue>
	/** receivedAt (ms) of the entity's latest reception, stored or held. */
	lastAt: number
	held: Held | undefined
	/**
	 * The identity the entity's stored aircraft rows carried, newest member
	 * winning (rememberAircraft). A final flush reuses it once the tracker
	 * forgot the aircraft. At most 5 members of 64 bytes (320 bytes of
	 * values, about 0.5 KB with the object); aircraft entities only.
	 */
	aircraft: DecodeAircraftIdentity | undefined
}

/**
 * Undoes one commit (its write failed). Returns true when the row stood only
 * for held receptions and they are held again (or already counted lost): the
 * failed row lost nothing more. `settle` records that it was written.
 */
export interface CoalesceUndo {
	(): boolean
	settle(): void
}

/** What a stored row of a tracked entity carries instead of its own decodedData. */
export interface CoalesceMerge {
	decodedData: { readonly [key: string]: JsonValue }
	/** Absent when the row stands for one reception. */
	coalesced: DecodeCoalesced | undefined
	/**
	 * The identity the entity's earlier stored rows carried, for a presenter
	 * whose lookup no longer knows the aircraft. Absent when none.
	 */
	aircraft?: DecodeAircraftIdentity
}

export interface CoalesceDecision {
	store: boolean
	/**
	 * Present when the row should carry the entity's merged latest state rather
	 * than the reception's own data (absent for a first sighting, an untracked
	 * output, or a reception that already carries the whole state).
	 */
	merged?: CoalesceMerge
	/**
	 * Records the reception as stored; call only once the row is queued. The
	 * returned function undoes it if the write later fails; call its
	 * `settle` once the write succeeded. `keepHeld`: the row could not carry
	 * the merged state (stored as its own data), so the held receptions stay
	 * held for their own row.
	 */
	commit(keepHeld?: boolean): CoalesceUndo
}

/**
 * A row for held receptions: due, or of an evicted entity. Taking it changes
 * nothing; `commit` (once the row is queued) consumes the held receptions. A
 * flush that is never committed stays held and is returned again.
 */
export interface CoalesceFlush {
	envelope: DecodeEnvelope
	present: CoalescePresenter | undefined
	merged: CoalesceMerge
	commit(): CoalesceUndo
}

/** An evicted entity's held receptions, waiting for their row. */
interface Evicted {
	key: string
	envelope: DecodeEnvelope
	present: CoalescePresenter | undefined
	merged: CoalesceMerge
	/** Store clock (ms) of the next try: at once, or one window after a failed write. */
	dueAt: number
}

function undoOf(undo: () => boolean, settle: () => void): CoalesceUndo {
	return Object.assign(undo, { settle })
}

const NOOP_UNDO = (): CoalesceUndo =>
	undoOf(
		() => false,
		() => {},
	)
const STORE_UNTRACKED: CoalesceDecision = { store: true, commit: NOOP_UNDO }
const HOLD: CoalesceDecision = { store: false, commit: NOOP_UNDO }
const NO_IDENTITY: ReadonlyMap<string, IdentityValue> = new Map()

function live<T>(stamp: Stamped<T> | undefined): Stamped<T> | undefined {
	let current = stamp
	while (current?.failed) current = current.prev
	return current
}

function asObject(value: JsonValue | undefined): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null
}

/** A scalar id part as text, "" when absent; undefined when it cannot be a key. */
function partText(value: JsonValue | undefined): string | undefined {
	if (value === undefined || value === null) return ""
	if (typeof value === "string" || typeof value === "number")
		return String(value)
	return undefined
}

interface SpecIndex {
	spec: CoalesceSpec
	identity: ReadonlySet<string>
}

const SPEC_INDEX: ReadonlyMap<string, SpecIndex> = new Map(
	Object.entries(COALESCE_SPECS).map(([type, spec]) => [
		type,
		{ spec, identity: new Set(spec.identity) },
	]),
)

function snapshot(latest: ReadonlyMap<string, JsonValue>): {
	[key: string]: JsonValue
} {
	const out: { [key: string]: JsonValue } = {}
	for (const [field, value] of latest) out[field] = value
	return out
}

export class PositionCoalescer {
	private readonly entities = new Map<string, EntityState>()
	/** Entities with held receptions, in the order they were first held (so by dueAt). */
	private readonly heldOrder = new Map<string, EntityState>()
	/**
	 * Held state of evicted entities, flushed by the next `takeDue`. At most
	 * maxEntities wait (so held state is bounded by 2 × maxEntities); past it
	 * the oldest is handed to `onLost`. A Set keeps eviction order with O(1)
	 * removal of the oldest and of a committed row (no per-admission shifts).
	 */
	private readonly evicted = new Set<Evicted>()
	/**
	 * Evicted rows whose write failed, each due one window after its failure
	 * (so in dueAt order), as ordinary held rows are: at most one write try
	 * per row per window while the writer keeps failing. Counted with
	 * `evicted` against maxEntities.
	 */
	private readonly retrying = new Set<Evicted>()
	/** The waiting evicted row of each key (at most one: see addEvicted). */
	private readonly evictedByKey = new Map<string, Evicted>()
	coalesced = 0
	/**
	 * Evicted rows dropped because their entity was tracked again: its newer
	 * row was queued first, so the evicted row (older state, stamped when
	 * stored) would list after it as the entity's latest. Its receptions
	 * were counted as coalesced and have no row of their own.
	 */
	superseded = 0

	/**
	 * @param windowMs one stored row per entity per window; 0 disables.
	 * @param maxEntities bound on tracked entities (at least 1); the least recently stored go first.
	 * @param now store clock for flushing held receptions.
	 * @param onLost an evicted entity's held row dropped past the bound (a counted loss).
	 */
	constructor(
		private readonly windowMs: number,
		private readonly maxEntities: number,
		private readonly now: () => number = Date.now,
		private readonly onLost: (envelope: DecodeEnvelope) => void = () => {},
	) {}

	size(): number {
		return this.entities.size
	}

	/** Entities with held receptions (at most `size()`). */
	heldCount(): number {
		return this.heldOrder.size
	}

	/** Evicted entities whose held row is not queued yet (at most maxEntities). */
	evictedCount(): number {
		return this.evicted.size + this.retrying.size
	}

	/**
	 * Store-clock time the next held row is due, if any (a fresh evicted row:
	 * now; one whose write failed: a window after the failure). O(1).
	 */
	nextDueAt(): number | undefined {
		if (this.evicted.size > 0) return this.now()
		let due: number | undefined
		for (const entry of this.retrying) {
			due = entry.dueAt
			break
		}
		for (const state of this.heldOrder.values()) {
			const held = state.held?.dueAt
			if (held !== undefined && (due === undefined || held < due)) due = held
			break
		}
		return due
	}

	/**
	 * Remembers the identity a queued aircraft row carries on its entity,
	 * member by member (newest wins, a member the row lacks is kept), so the
	 * entity's later rows can carry it once the lookup no longer knows the
	 * aircraft. O(1); untracked envelopes are ignored.
	 */
	rememberAircraft(envelope: DecodeEnvelope): void {
		const identity = envelope.aircraft
		if (identity === undefined || this.windowMs <= 0) return
		const key = this.keyOf(envelope)
		if (key === undefined) return
		const state = this.entities.get(key)
		if (state === undefined) return
		const next: DecodeAircraftIdentity = { ...state.aircraft }
		for (const member of IDENTITY_MEMBERS) {
			const value = identity[member]
			if (typeof value === "string") next[member] = value
		}
		state.aircraft = next
	}

	decide(
		envelope: DecodeEnvelope,
		present?: CoalescePresenter,
	): CoalesceDecision {
		if (this.windowMs <= 0) return STORE_UNTRACKED
		const index = SPEC_INDEX.get(envelope.outputType)
		if (!index) return STORE_UNTRACKED
		const spec = index.spec
		const data = asObject(envelope.decodedData)
		if (!data) return STORE_UNTRACKED
		const key = entityKeyOf(envelope, index, data)
		if (key === undefined) return STORE_UNTRACKED
		// receivedAt is the ingest clock, allocated once per reception by the
		// Activity ingress; producer timestamps never drive the window.
		const at = Date.parse(envelope.receivedAt)
		if (!Number.isFinite(at)) return STORE_UNTRACKED
		const state = this.entities.get(key)
		const eligible = spec.eligible === undefined || spec.eligible(data)
		let informative = !eligible
		let changed = state === undefined
		for (const field in data) {
			const value = data[field]
			if (value === null) continue
			if (index.identity.has(field)) {
				if (value === undefined) continue
				// An oversized value is never remembered: stored as its own row.
				if (!fits(value)) informative = true
				else if (
					!changed &&
					!sameIdentity(state?.identity.get(field)?.value, value)
				)
					changed = true
			} else if (!spec.redundant.has(field)) informative = true
			else if (value !== undefined && !fits(value)) informative = true
		}
		if (state !== undefined && eligible) {
			// A gap longer than the window: the old position is no longer the latest.
			if (at - state.lastAt > this.windowMs)
				for (const field of state.latest.keys())
					if (!index.identity.has(field)) state.latest.delete(field)
			mergeInto(state.latest, data, spec, index.identity)
		}
		if (state !== undefined && at > state.lastAt) state.lastAt = at
		// A clock step backwards (at < storedAt) also stores, so it cannot mute an entity.
		const storedAt = state?.storedAt?.value
		const due =
			storedAt === undefined || at - storedAt >= this.windowMs || at < storedAt
		if (!informative && !changed && !due && state !== undefined) {
			this.hold(key, state, envelope, present)
			return HOLD
		}
		const merged =
			state !== undefined && eligible
				? mergedRow(state, data, envelope.receivedAt)
				: undefined
		return {
			store: true,
			...(merged === undefined ? {} : { merged }),
			commit: (keepHeld?: boolean) =>
				this.record(
					key,
					identityOf(data, spec),
					at,
					eligible ? data : undefined,
					index,
					keepHeld !== true,
				),
		}
	}

	/** The entity key of a tracked envelope, else undefined. */
	private keyOf(envelope: DecodeEnvelope): string | undefined {
		const index = SPEC_INDEX.get(envelope.outputType)
		const data = asObject(envelope.decodedData)
		if (!index || !data) return undefined
		return entityKeyOf(envelope, index, data)
	}

	/** Counts a reception that was held instead of stored. */
	noteCoalesced(): void {
		this.coalesced++
	}

	/**
	 * The next row for held receptions: an evicted entity's at once, else the
	 * entity whose first held reception is `windowMs` old by `now`. O(1): the
	 * held map is in dueAt order (a store clock step backwards only delays it).
	 * The held receptions stay held until the flush is committed.
	 */
	takeDue(now: number): CoalesceFlush | undefined {
		for (const evicted of this.evicted) return this.evictedFlush(evicted)
		for (const entry of this.retrying) {
			if (entry.dueAt <= now) return this.evictedFlush(entry)
			break
		}
		for (const [key, state] of this.heldOrder) {
			const held = state.held
			if (held === undefined) {
				this.heldOrder.delete(key)
				continue
			}
			if (held.dueAt > now) return undefined
			return this.heldFlush(key, state, held)
		}
		return undefined
	}

	/**
	 * Every row for held receptions due by `now`, in `takeDue` order: evicted
	 * entities first, then held entities by dueAt. A flush left uncommitted
	 * stays held, and the caller may go on to the next one (a row the queue
	 * has no room for must not hold back a smaller one behind it).
	 */
	*dueFlushes(now: number): Generator<CoalesceFlush, void, undefined> {
		// Live Set iteration, no copy: a committed (deleted) entry is skipped
		// safely, and one lost meanwhile is never yielded as well as counted.
		for (const entry of this.evicted) yield this.evictedFlush(entry)
		for (const entry of this.retrying) {
			if (entry.dueAt > now) break
			yield this.evictedFlush(entry)
		}
		for (const [key, state] of this.heldOrder) {
			const held = state.held
			if (held === undefined) {
				this.heldOrder.delete(key)
				continue
			}
			if (held.dueAt > now) return
			yield this.heldFlush(key, state, held)
		}
	}

	/** Every held row, due or not (shutdown). */
	takeAll(): CoalesceFlush[] {
		const out = Array.from(this.evicted, entry => this.evictedFlush(entry))
		for (const entry of this.retrying) out.push(this.evictedFlush(entry))
		for (const [key, state] of this.heldOrder)
			if (state.held !== undefined)
				out.push(this.heldFlush(key, state, state.held))
		return out
	}

	private evictedFlush(entry: Evicted): CoalesceFlush {
		return {
			envelope: entry.envelope,
			present: entry.present,
			merged: entry.merged,
			commit: () => {
				this.removeEvicted(entry)
				let pending: Evicted | undefined = entry
				return undoOf(
					() => {
						// Waits a window for its next try (or is superseded, or
						// counted lost past the bound).
						if (pending !== undefined) this.addEvicted(pending, true)
						pending = undefined
						return true
					},
					() => {
						pending = undefined
					},
				)
			},
		}
	}

	/**
	 * Queues an evicted entity's held row: at once, or (`failed`: its write
	 * failed) one window from now. A failed row whose entity is tracked again,
	 * or that a newer evicted row of its entity replaced, is superseded
	 * (counted, dropped): that newer row was queued first. Past maxEntities
	 * waiting rows the oldest is lost (counted): a failed one first.
	 */
	private addEvicted(entry: Evicted, failed: boolean): void {
		if (failed) {
			if (this.entities.has(entry.key) || this.evictedByKey.has(entry.key)) {
				this.superseded++
				return
			}
			entry.dueAt = this.now() + this.windowMs
			this.retrying.add(entry)
		} else {
			// Never two rows of one key: a tracked-again entity drops its old one.
			const older = this.evictedByKey.get(entry.key)
			if (older !== undefined) {
				this.removeEvicted(older)
				this.superseded++
			}
			entry.dueAt = this.now()
			this.evicted.add(entry)
		}
		this.evictedByKey.set(entry.key, entry)
		if (this.evicted.size + this.retrying.size <= this.maxEntities) return
		const lost =
			this.retrying.values().next().value ?? this.evicted.values().next().value
		if (lost) {
			this.removeEvicted(lost)
			this.onLost(lost.envelope)
		}
	}

	private removeEvicted(entry: Evicted): void {
		this.evicted.delete(entry)
		this.retrying.delete(entry)
		if (this.evictedByKey.get(entry.key) === entry)
			this.evictedByKey.delete(entry.key)
	}

	/** The entity is tracked again: its waiting evicted row is superseded. */
	private supersede(key: string): void {
		const entry = this.evictedByKey.get(key)
		if (entry === undefined) return
		this.removeEvicted(entry)
		this.superseded++
	}

	private heldFlush(
		key: string,
		state: EntityState,
		held: Held,
	): CoalesceFlush {
		const at = Date.parse(held.envelope.receivedAt)
		return {
			envelope: held.envelope,
			present: held.present,
			merged: {
				decodedData: snapshot(state.latest),
				coalesced: flushSpan(held),
				...identityMerge(state),
			},
			commit: () => {
				const carried = state.held === held
				if (carried) {
					state.held = undefined
					this.heldOrder.delete(key)
				}
				return this.record(
					key,
					NO_IDENTITY,
					at,
					undefined,
					undefined,
					false,
					carried ? held : undefined,
				)
			},
		}
	}

	private hold(
		key: string,
		state: EntityState,
		envelope: DecodeEnvelope,
		present: CoalescePresenter | undefined,
	): void {
		const held = state.held
		if (held === undefined) {
			state.held = {
				envelope,
				present,
				receptions: 1,
				firstSeenAt: envelope.receivedAt,
				dueAt: this.now() + this.windowMs,
			}
			this.heldOrder.set(key, state)
			return
		}
		held.envelope = envelope
		held.present = present
		held.receptions++
	}

	/**
	 * `flushed`: the row is a flush of these held receptions (and nothing else).
	 * A row that carried held receptions, either way, holds them again on undo.
	 */
	private record(
		key: string,
		seen: ReadonlyMap<string, IdentityValue>,
		at: number,
		data: JsonObject | undefined,
		index: SpecIndex | undefined,
		carriesHeld: boolean,
		flushed?: Held,
	): CoalesceUndo {
		let state = this.entities.get(key)
		if (state === undefined) {
			// Tracked again: an evicted row still waiting holds older state.
			this.supersede(key)
			state = {
				storedAt: undefined,
				identity: new Map(),
				latest: new Map(),
				lastAt: at,
				held: undefined,
				aircraft: undefined,
			}
			if (data !== undefined && index !== undefined)
				mergeInto(state.latest, data, index.spec, index.identity)
		}
		// An eligible row carried the held receptions (an ineligible one, such as
		// AIS static data, or one stored without the merged state, leaves them
		// for their own row).
		let carried = flushed
		if (carriesHeld && data !== undefined && state.held !== undefined) {
			carried = state.held
			state.held = undefined
			this.heldOrder.delete(key)
		}
		const owner = state
		const fields: Array<[string, Stamped<IdentityValue>]> = []
		for (const [field, value] of seen) {
			const stamp: Stamped<IdentityValue> = {
				value,
				failed: false,
				prev: state.identity.get(field),
			}
			state.identity.set(field, stamp)
			fields.push([field, stamp])
		}
		const clock: Stamped<number> = {
			value: at,
			failed: false,
			prev: state.storedAt,
		}
		state.storedAt = clock
		this.entities.delete(key)
		this.entities.set(key, state)
		this.evict()
		// Undo touches only what this reception set and nothing later rows
		// replaced. A later row that replaced it skips it on its own undo.
		const undo = (): boolean => {
			clock.failed = true
			for (const [, stamp] of fields) stamp.failed = true
			// The held receptions the row carried are held again, never lost.
			if (carried !== undefined) this.restoreHeld(key, owner, carried)
			carried = undefined
			const current = this.entities.get(key)
			if (!current) return flushed !== undefined
			for (const [field, stamp] of fields) {
				if (current.identity.get(field) !== stamp) continue
				const back = live(stamp.prev)
				if (back) current.identity.set(field, back)
				else current.identity.delete(field)
			}
			if (current.storedAt === clock) current.storedAt = live(clock.prev)
			if (
				current.identity.size === 0 &&
				current.storedAt === undefined &&
				current.held === undefined
			)
				this.entities.delete(key)
			return flushed !== undefined
		}
		const settle = () => {
			clock.prev = undefined
			carried = undefined
			for (const [, stamp] of fields) stamp.prev = undefined
		}
		return undoOf(undo, settle)
	}

	/**
	 * Holds a failed row's held receptions again. They join receptions held
	 * since (the newer envelope stays, the earlier first sighting wins); else
	 * they are due one window from now, at the back of the due order. An
	 * entity evicted (or replaced) since gets them back as an evicted row.
	 */
	private restoreHeld(key: string, state: EntityState, held: Held): void {
		if (this.entities.get(key) !== state) {
			this.addEvicted(evictedOf(key, state, held), true)
			return
		}
		const current = state.held
		if (current === undefined) {
			state.held = { ...held, dueAt: this.now() + this.windowMs }
			this.heldOrder.delete(key)
			this.heldOrder.set(key, state)
			return
		}
		current.receptions += held.receptions
		if (Date.parse(held.firstSeenAt) < Date.parse(current.firstSeenAt))
			current.firstSeenAt = held.firstSeenAt
	}

	/**
	 * Map order is least recently stored first. Dropping the oldest entries is
	 * safe: an evicted entity's next reception is stored as a first sighting,
	 * and its held receptions are flushed as a row, never dropped.
	 */
	private evict(): void {
		for (const [key, state] of this.entities) {
			if (this.entities.size <= this.maxEntities) return
			this.entities.delete(key)
			const held = state.held
			if (held === undefined) continue
			state.held = undefined
			this.heldOrder.delete(key)
			this.addEvicted(evictedOf(key, state, held), false)
		}
	}
}

/** An entity's held receptions as an evicted row (due time set by addEvicted). */
function evictedOf(key: string, state: EntityState, held: Held): Evicted {
	return {
		key,
		envelope: held.envelope,
		present: held.present,
		merged: {
			decodedData: snapshot(state.latest),
			coalesced: flushSpan(held),
			...identityMerge(state),
		},
		dueAt: 0,
	}
}

const IDENTITY_MEMBERS = [
	"callsign",
	"registration",
	"typeCode",
	"typeDescription",
	"operator",
] as const satisfies readonly (keyof DecodeAircraftIdentity)[]

/** The remembered identity for a merge, when the entity has one. */
function identityMerge(state: EntityState): Pick<CoalesceMerge, "aircraft"> {
	return state.aircraft === undefined ? {} : { aircraft: state.aircraft }
}

/** decoderId, output type, entity id and parts; undefined when it cannot be a key. */
function entityKeyOf(
	envelope: DecodeEnvelope,
	index: SpecIndex,
	data: JsonObject,
): string | undefined {
	const spec = index.spec
	const id = data[spec.entity]
	if (typeof id !== "string" && typeof id !== "number") return undefined
	if (spec.tracked !== undefined && !spec.tracked(data)) return undefined
	let key = `${envelope.decoderId}\u0000${envelope.outputType}\u0000${String(id)}`
	if (spec.entityParts)
		for (const part of spec.entityParts) {
			const text = partText(data[part])
			if (text === undefined) return undefined
			key += `\u0000${text}`
		}
	return key
}

/** Allowlisted, non-null fields of an eligible reception, newest wins. */
function mergeInto(
	latest: Map<string, JsonValue>,
	data: JsonObject,
	spec: CoalesceSpec,
	identity: ReadonlySet<string>,
): void {
	for (const field in data) {
		const value = data[field]
		if (value === null || value === undefined) continue
		if (!spec.redundant.has(field) && !identity.has(field)) continue
		// The reception's own row carries an oversized value; a stale one must not outlive it.
		if (fits(value)) latest.set(field, value)
		else latest.delete(field)
	}
}

/** JSON text of the value is at most MAX_MERGED_VALUE_BYTES (UTF-8). */
function fits(value: JsonValue): boolean {
	if (typeof value === "number" || typeof value === "boolean") return true
	// JSON escapes at most 6 bytes per UTF-16 unit, quotes included in the slack.
	if (
		typeof value === "string" &&
		value.length * 6 + 2 <= MAX_MERGED_VALUE_BYTES
	)
		return true
	return (
		Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_MERGED_VALUE_BYTES
	)
}

/** Identity values a stored reception records. */
function identityOf(
	data: JsonObject,
	spec: CoalesceSpec,
): ReadonlyMap<string, IdentityValue> {
	let seen: Map<string, IdentityValue> | undefined
	for (const field of spec.identity) {
		const value = data[field]
		if (value === undefined || value === null || !fits(value)) continue
		seen ??= new Map()
		seen.set(field, identityValue(value))
	}
	return seen ?? NO_IDENTITY
}

/**
 * The span a flushed row carries, even for one held reception: the row is
 * stamped when stored (storage/ingress.ts), so `lastSeenAt` is the only
 * record of when its latest reception arrived.
 */
function flushSpan(held: Held): DecodeCoalesced {
	return {
		receptions: held.receptions,
		firstSeenAt: held.firstSeenAt,
		lastSeenAt: held.envelope.receivedAt,
	}
}

/**
 * The stored row's data: the latest state with the reception's own fields
 * over it (its off-allowlist fields included). Undefined when the reception
 * already carries the whole state and nothing was held.
 */
function mergedRow(
	state: EntityState,
	data: JsonObject,
	receivedAt: string,
): CoalesceMerge | undefined {
	const held = state.held
	let missing = false
	for (const field of state.latest.keys())
		if (data[field] === undefined || data[field] === null) {
			missing = true
			break
		}
	if (!missing && held === undefined) return undefined
	const decodedData = snapshot(state.latest)
	for (const field in data) {
		const value = data[field]
		if (value !== undefined) decodedData[field] = value
	}
	return {
		decodedData,
		...identityMerge(state),
		coalesced:
			held === undefined
				? undefined
				: {
						receptions: held.receptions + 1,
						firstSeenAt: held.firstSeenAt,
						lastSeenAt: receivedAt,
					},
	}
}
