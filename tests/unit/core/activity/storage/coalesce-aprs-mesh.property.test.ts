import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	APRS_POSITION_DATA_TYPES,
	COALESCE_SPECS,
	PositionCoalescer,
} from "../../../../../src/core/activity/storage/coalesce.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import { envelope } from "./helpers.js"

const WINDOW_MS = 60_000
const T0 = Date.parse("2026-10-13T00:00:00.000Z")

const APRS_REDUNDANT = [
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
] as const
const MESH_REDUNDANT = [
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
] as const
const APRS_TYPES = [
	"Position",
	"Position with messaging",
	"Position with timestamp",
	"Position with timestamp and messaging",
	"Mic-E",
	"Mic-E (old)",
]

interface Spec {
	entity: string
	redundant: ReadonlySet<string>
	identity: readonly string[]
	eligible?: (data: Record<string, unknown>) => boolean
}

const REFERENCE_SPECS: Record<string, Spec> = {
	aircraft: {
		entity: "icao",
		redundant: new Set(COALESCE_SPECS["aircraft"]?.redundant ?? []),
		identity: [...(COALESCE_SPECS["aircraft"]?.identity ?? [])],
	},
	aprs: {
		entity: "source",
		redundant: new Set(APRS_REDUNDANT),
		identity: ["symbol", "comment"],
		eligible: data =>
			typeof data["dataType"] === "string" &&
			APRS_TYPES.includes(data["dataType"]) &&
			typeof data["lat"] === "number" &&
			Number.isFinite(data["lat"]) &&
			typeof data["lon"] === "number" &&
			Number.isFinite(data["lon"]),
	},
	meshtastic: {
		entity: "from",
		redundant: new Set(MESH_REDUNDANT),
		identity: [],
		eligible: data => data["portnum"] === 3,
	},
}

interface Stamp<T> {
	value: T
	by: number
}

interface EntityState {
	storedAt: Stamp<number>
	identity: Map<string, Stamp<string>>
}

/** Independent window, identity and LRU model. Undo is newest-commit first. */
class ReferenceCoalescer {
	private readonly entities = new Map<string, EntityState>()
	private seq = 0

	constructor(
		private readonly windowMs: number,
		private readonly maxEntities: number,
	) {}

	size(): number {
		return this.entities.size
	}

	decide(env: DecodeEnvelope): { store: boolean; commit: () => () => void } {
		if (this.windowMs <= 0) return { store: true, commit: () => () => {} }
		const spec = REFERENCE_SPECS[env.outputType]
		const data = asObject(env.decodedData)
		const id = data?.[spec?.entity ?? ""]
		if (!spec || !data || (typeof id !== "string" && typeof id !== "number"))
			return { store: true, commit: () => () => {} }
		const at = Date.parse(env.receivedAt)
		if (!Number.isFinite(at)) return { store: true, commit: () => () => {} }
		const key = `${env.decoderId}\u0000${env.outputType}\u0000${String(id)}`
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
		const due =
			state === undefined ||
			at - state.storedAt.value >= this.windowMs ||
			at < state.storedAt.value
		if (!informative && !changed && !due)
			return { store: false, commit: () => () => {} }
		return { store: true, commit: () => this.record(key, seen, at) }
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
		const priorFields = new Map<string, Stamp<string> | undefined>()
		for (const [field, value] of seen) {
			priorFields.set(field, state.identity.get(field))
			state.identity.set(field, { value, by })
		}
		state.storedAt = { value: at, by }
		this.entities.delete(key)
		this.entities.set(key, state)
		for (const oldest of this.entities.keys()) {
			if (this.entities.size <= this.maxEntities) break
			this.entities.delete(oldest)
		}
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
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

const eventArb = fc.oneof(
	fc.record({
		kind: fc.constant("aprs" as const),
		decoderId: fc.constantFrom("d1", "d2"),
		dt: fc.integer({ min: -10_000, max: 90_000 }),
		source: fc.constantFrom("N0CALL", "N0CALL-0", "ABC", "abc"),
		dataType: fc.constantFrom(
			"Position",
			"Mic-E",
			"Mic-E (old)",
			"Status",
			"Message",
		),
		positioned: fc.boolean(),
		symbol: fc.constantFrom("absent", "/", "\\"),
		comment: fc.constantFrom("absent", "a", "b"),
		extra: fc.constantFrom("none", "weather", "undefined"),
		undo: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant("meshtastic" as const),
		decoderId: fc.constantFrom("d1", "d2"),
		dt: fc.integer({ min: -10_000, max: 90_000 }),
		from: fc.constantFrom(1, 2, 42),
		portnum: fc.constantFrom(1, 3),
		extraLat: fc.boolean(),
		undo: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant("aircraft" as const),
		decoderId: fc.constantFrom("d1", "d2"),
		dt: fc.integer({ min: -10_000, max: 90_000 }),
		icao: fc.constantFrom("abc123", "def456"),
		callsign: fc.constantFrom("absent", "UAL1", "DAL2"),
		undo: fc.boolean(),
	}),
)

function decoded(event: {
	kind: "aprs" | "meshtastic" | "aircraft"
	source?: string
	dataType?: string
	positioned?: boolean
	symbol?: string
	comment?: string
	extra?: string
	from?: number
	portnum?: number
	extraLat?: boolean
	icao?: string
	callsign?: string
}): Record<string, unknown> {
	if (event.kind === "aprs") {
		const data: Record<string, unknown> = {
			source: event.source,
			dataType: event.dataType,
		}
		if (event.positioned) {
			data["lat"] = 51
			data["lon"] = 4
		}
		if (event.symbol !== "absent") data["symbol"] = event.symbol
		if (event.comment !== "absent") data["comment"] = event.comment
		if (event.extra === "weather") data["weather"] = { temperature: 70 }
		if (event.extra === "undefined") data["bogus"] = undefined
		return data
	}
	if (event.kind === "meshtastic") {
		const data: Record<string, unknown> = {
			from: event.from,
			portnum: event.portnum,
		}
		if (event.extraLat) data["lat"] = 51
		return data
	}
	const data: Record<string, unknown> = { icao: event.icao, lat: 51, lon: 4 }
	if (event.callsign !== "absent") data["callsign"] = event.callsign
	return data
}

describe("APRS and mesh coalescing properties", () => {
	// Feature: web-gaps-2, Property 4: APRS and mesh coalescing
	// Validates: Requirements 2.1, 2.2, 2.3, 2.4
	it("stores exactly the reference timeline, rolls back the newest commit and stays bounded", () => {
		expect([...APRS_POSITION_DATA_TYPES].sort()).toEqual([...APRS_TYPES].sort())
		expect([...(COALESCE_SPECS["aprs"]?.redundant ?? [])].sort()).toEqual(
			[...APRS_REDUNDANT].sort(),
		)
		expect([...(COALESCE_SPECS["aprs"]?.identity ?? [])].sort()).toEqual([
			"comment",
			"symbol",
		])
		expect([...(COALESCE_SPECS["meshtastic"]?.redundant ?? [])].sort()).toEqual(
			[...MESH_REDUNDANT].sort(),
		)
		expect(COALESCE_SPECS["meshtastic"]?.identity).toEqual([])
		fc.assert(
			fc.property(
				fc.array(eventArb, { minLength: 1, maxLength: 12 }),
				fc.integer({ min: 1, max: 4 }),
				(events, maxEntities) => {
					const real = new PositionCoalescer(WINDOW_MS, maxEntities)
					const reference = new ReferenceCoalescer(WINDOW_MS, maxEntities)
					let at = T0
					events.forEach((event, index) => {
						at += event.dt
						const env = envelope({
							eventId: `e-${index}`,
							decoderId: event.decoderId,
							outputType: event.kind,
							receivedAt: new Date(at).toISOString(),
							decodedData: decoded(event) as DecodeEnvelope["decodedData"],
						})
						const left = real.decide(env)
						const right = reference.decide(env)
						expect(left.store).toBe(right.store)
						if (left.store) {
							const undoReal = left.commit()
							const undoReference = right.commit()
							if (event.undo) {
								undoReal()
								undoReference()
							}
						}
						expect(real.size()).toBe(reference.size())
						expect(real.size()).toBeLessThanOrEqual(maxEntities)
					})
				},
			),
			{ numRuns: 100 },
		)
	})
})
