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
 *    messages, other mesh ports, sensor events), or carrying any field off
 *    the allowlist,
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
 * held state is flushed at once, never dropped. A gap of more than `windowMs`
 * between two receptions drops the stale position and kinematics from the
 * latest state (identity is kept).
 *
 * Rows per entity in continuous view: one per window plus identity changes
 * (60 s: about 60 an hour), whatever the message rate. Live trackers and
 * WebSocket paths never pass through here.
 */
import type { DecodeCoalesced, DecodeEnvelope, JsonValue } from "../types.js"

type JsonObject = { readonly [key: string]: JsonValue }

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

/**
 * rtl_433 periodic sensor readings (`signal` outputs, src/decoders/builtin/rtl433.ts), keyed
 * like the sensor presentation: model, id and channel. Weather-station measurements and
 * rtl_433's `-M time/level/protocol` metadata are redundant; a battery change is identity.
 * Any other field (button, event, state, code, alarm, tamper, ...) makes the reading an
 * event of its own, stored as a row.
 */
const SENSOR: CoalesceSpec = {
	entity: "id",
	entityParts: ["model", "channel"],
	redundant: new Set([
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
	eligible: data => typeof data["model"] === "string",
	fullRows: true,
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
	/** Last known value per identity field, as JSON text. */
	identity: Map<string, Stamped<string>>
	/** Merged latest state: allowlisted fields only, newest value wins. */
	latest: Map<string, JsonValue>
	/** receivedAt (ms) of the entity's latest reception, stored or held. */
	lastAt: number
	held: Held | undefined
}

/** Undoes one commit (its write failed). `settle` records that it was written. */
export interface CoalesceUndo {
	(): void
	settle(): void
}

/** What a stored row of a tracked entity carries instead of its own decodedData. */
export interface CoalesceMerge {
	decodedData: { readonly [key: string]: JsonValue }
	/** Absent when the row stands for one reception. */
	coalesced: DecodeCoalesced | undefined
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
	 * `settle` once the write succeeded.
	 */
	commit(): CoalesceUndo
}

/** A row for held receptions: due, or of an evicted entity. */
export interface CoalesceFlush {
	envelope: DecodeEnvelope
	present: CoalescePresenter | undefined
	merged: CoalesceMerge
	commit(): CoalesceUndo
}

function undoOf(undo: () => void, settle: () => void): CoalesceUndo {
	return Object.assign(undo, { settle })
}

const NOOP_UNDO = (): CoalesceUndo =>
	undoOf(
		() => {},
		() => {},
	)
const STORE_UNTRACKED: CoalesceDecision = { store: true, commit: NOOP_UNDO }
const HOLD: CoalesceDecision = { store: false, commit: NOOP_UNDO }
const NO_IDENTITY: ReadonlyMap<string, string> = new Map()

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
	/** Held state of evicted entities, flushed by the next `takeDue`. */
	private readonly evicted: CoalesceFlush[] = []
	coalesced = 0

	/**
	 * @param windowMs one stored row per entity per window; 0 disables.
	 * @param maxEntities bound on tracked entities (at least 1); the least recently stored go first.
	 * @param now store clock for flushing held receptions.
	 */
	constructor(
		private readonly windowMs: number,
		private readonly maxEntities: number,
		private readonly now: () => number = Date.now,
	) {}

	size(): number {
		return this.entities.size
	}

	/** Entities with held receptions (at most `size()`). */
	heldCount(): number {
		return this.heldOrder.size
	}

	/** Store-clock time the next held row is due, if any (evicted rows: now). */
	nextDueAt(): number | undefined {
		if (this.evicted.length > 0) return this.now()
		for (const state of this.heldOrder.values()) return state.held?.dueAt
		return undefined
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
		const id = data?.[spec.entity]
		if (!data || (typeof id !== "string" && typeof id !== "number"))
			return STORE_UNTRACKED
		if (spec.tracked !== undefined && !spec.tracked(data))
			return STORE_UNTRACKED
		let key = `${envelope.decoderId}\u0000${envelope.outputType}\u0000${String(id)}`
		if (spec.entityParts)
			for (const part of spec.entityParts) {
				const text = partText(data[part])
				if (text === undefined) return STORE_UNTRACKED
				key += `\u0000${text}`
			}
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
				if (
					!changed &&
					value !== undefined &&
					state?.identity.get(field)?.value !== JSON.stringify(value)
				)
					changed = true
			} else if (!spec.redundant.has(field)) informative = true
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
			commit: () =>
				this.record(
					key,
					identityOf(data, spec),
					at,
					eligible ? data : undefined,
					index,
				),
		}
	}

	/** Counts a reception that was held instead of stored. */
	noteCoalesced(): void {
		this.coalesced++
	}

	/**
	 * The next row for held receptions: an evicted entity's at once, else the
	 * entity whose first held reception is `windowMs` old by `now`. O(1): the
	 * held map is in dueAt order (a store clock step backwards only delays it).
	 */
	takeDue(now: number): CoalesceFlush | undefined {
		const evicted = this.evicted.shift()
		if (evicted) return evicted
		for (const [key, state] of this.heldOrder) {
			const held = state.held
			if (held !== undefined && held.dueAt > now) return undefined
			this.heldOrder.delete(key)
			if (held === undefined) continue
			state.held = undefined
			const at = Date.parse(held.envelope.receivedAt)
			return {
				envelope: held.envelope,
				present: held.present,
				merged: { decodedData: snapshot(state.latest), coalesced: span(held) },
				commit: () => this.record(key, NO_IDENTITY, at, undefined, undefined),
			}
		}
		return undefined
	}

	/** Every held row, due or not (shutdown). */
	takeAll(): CoalesceFlush[] {
		const out: CoalesceFlush[] = []
		for (;;) {
			const next = this.takeDue(Number.POSITIVE_INFINITY)
			if (!next) return out
			out.push(next)
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

	private record(
		key: string,
		seen: ReadonlyMap<string, string>,
		at: number,
		data: JsonObject | undefined,
		index: SpecIndex | undefined,
	): CoalesceUndo {
		let state = this.entities.get(key)
		if (state === undefined) {
			state = {
				storedAt: undefined,
				identity: new Map(),
				latest: new Map(),
				lastAt: at,
				held: undefined,
			}
			if (data !== undefined && index !== undefined)
				mergeInto(state.latest, data, index.spec, index.identity)
		}
		// An eligible row carried the held receptions (an ineligible one, such as
		// AIS static data, leaves them for their own row).
		if (data !== undefined && state.held !== undefined) {
			state.held = undefined
			this.heldOrder.delete(key)
		}
		const fields: Array<[string, Stamped<string>]> = []
		for (const [field, value] of seen) {
			const stamp: Stamped<string> = {
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
		const undo = () => {
			clock.failed = true
			for (const [, stamp] of fields) stamp.failed = true
			const current = this.entities.get(key)
			if (!current) return
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
		}
		const settle = () => {
			clock.prev = undefined
			for (const [, stamp] of fields) stamp.prev = undefined
		}
		return undoOf(undo, settle)
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
			this.evicted.push({
				envelope: held.envelope,
				present: held.present,
				merged: { decodedData: snapshot(state.latest), coalesced: span(held) },
				commit: NOOP_UNDO,
			})
		}
	}
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
		if (spec.redundant.has(field) || identity.has(field))
			latest.set(field, value)
	}
}

/** Identity values a stored reception records, as JSON text. */
function identityOf(
	data: JsonObject,
	spec: CoalesceSpec,
): ReadonlyMap<string, string> {
	let seen: Map<string, string> | undefined
	for (const field of spec.identity) {
		const value = data[field]
		if (value === undefined || value === null) continue
		seen ??= new Map()
		seen.set(field, JSON.stringify(value))
	}
	return seen ?? NO_IDENTITY
}

function span(held: Held): DecodeCoalesced | undefined {
	return held.receptions < 2
		? undefined
		: {
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
