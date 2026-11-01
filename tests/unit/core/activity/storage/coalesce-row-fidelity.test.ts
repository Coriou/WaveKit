import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import type { ActivityAircraftIdentityLookup } from "../../../../../src/core/activity/ingress.js"
import {
	createDecodeEnvelope,
	withEnvelopeMetadata,
} from "../../../../../src/core/activity/envelope.js"
import { presentAircraft } from "../../../../../src/core/activity/presentation/aircraft.js"
import { ROW_GROWTH_MAX_BYTES } from "../../../../../src/core/activity/presentation/budget.js"
import { presentShip } from "../../../../../src/core/activity/presentation/ship.js"
import {
	isPositionOnlyShape,
	PositionCoalescer,
} from "../../../../../src/core/activity/storage/coalesce.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import {
	ACTIVITY_AIRCRAFT_IDENTITY_ALLOWANCE_BYTES,
	ACTIVITY_LIMIT_DEFAULTS,
	resolveActivityLimits,
} from "../../../../../src/core/activity/storage/limits.js"
import {
	buildActivityRow,
	parseStoredSummary,
	type BuiltActivityRow,
} from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodeEnvelope,
	JsonValue,
} from "../../../../../src/core/activity/types.js"
import type { DecoderOutputType } from "../../../../../src/decoders/types.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const WINDOW = ACTIVITY_LIMIT_DEFAULTS.positionCoalesceMs

function reception(
	outputType: string,
	at: number,
	decodedData: Record<string, JsonValue>,
	eventId = `${outputType}-${at}`,
): DecodeEnvelope {
	return envelope({
		eventId,
		decoderId: outputType === "signal" ? "rtl433" : "dec",
		outputType,
		receivedAt: new Date(at).toISOString(),
		decodedData,
	})
}

function storeIngress(clock: { t: number }) {
	return new ActivityIngress(resolveActivityLimits({}), () => clock.t, logger)
}

function drain(i: ActivityIngress, into: BuiltActivityRow[] = []) {
	for (;;) {
		const batch = i.takeBatch(64, 1 << 20)
		if (batch.length === 0) return into
		into.push(...batch)
		i.ack(new Set(batch.map(r => r.eventId)))
	}
}

function stored(row: BuiltActivityRow | undefined): DecodeEnvelope {
	return (JSON.parse(row?.recordJson ?? "null") as { payload: DecodeEnvelope })
		.payload
}

const keys = (fields: readonly { key: string }[] | undefined) =>
	(fields ?? []).map(f => f.key)

describe("stored entity rows keep their list fields", () => {
	it("presents altitude, speed and track for a readsb reception with reception metadata", () => {
		const view = presentAircraft({
			icao: "A0F001",
			lat: 51.5,
			lon: -0.1,
			altitude: 35_000,
			groundSpeed: 450,
			track: 90,
			readsbFormat: "sbs",
			sbsContentId: "x",
			messageCount: 1,
			lastSeen: T0,
		})
		expect(keys(view?.fields)).toEqual(
			expect.arrayContaining(["altitude", "groundSpeed", "track"]),
		)
	})

	it("presents the altitude of a Mode S reception without a position", () => {
		const view = presentAircraft({
			icao: "A0F002",
			altitude: 12_000,
			readsbFormat: "beast",
			modeS: { df: 4, crcOk: true },
		})
		expect(view?.position).toBeUndefined()
		expect(keys(view?.fields)).toEqual(["altitude"])
	})

	it("lists the altitude of a bare fix too (aircraft and ship rows are never position-only)", () => {
		const data = { icao: "A0F003", lat: 51.5, lon: -0.1, altitude: 35_000 }
		expect(isPositionOnlyShape("aircraft", data)).toBe(false)
		expect(keys(presentAircraft(data)?.fields)).toEqual(["altitude"])
		expect(presentAircraft(data)?.position?.altM).toBe(10_668)
		// APRS and mesh positions keep the bare shape.
		expect(
			isPositionOnlyShape("aprs", {
				source: "N0CALL-9",
				dataType: "Position",
				lat: 1,
				lon: 2,
			}),
		).toBe(true)
	})

	it("presents speed and course for a class B type 18 report", () => {
		const view = presentShip({
			mmsi: "235000001",
			messageType: 18,
			lat: 50.1,
			lon: -1.2,
			sog: 7.5,
			cog: 181,
			heading: 180,
			channel: "B",
			lastSeen: T0,
		})
		expect(keys(view?.fields)).toEqual(expect.arrayContaining(["sog", "cog"]))
	})

	it("a merged flush row of a pre-callsign aircraft carries its kinematics fields", () => {
		const clock = { t: T0 }
		const store = storeIngress(clock)
		let n = 0
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `m-${n++}`,
		})
		const publish = (data: Record<string, JsonValue>) =>
			core.publish("adsb", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "adsb",
				type: "aircraft",
				data,
			})
		const meta = { readsbFormat: "sbs", sbsContentId: "c", messageCount: 1 }
		publish({ icao: "A0F004", lat: 51, lon: 0, altitude: 30_000, ...meta })
		clock.t = T0 + 1_000
		publish({ icao: "A0F004", groundSpeed: 420, track: 270, ...meta })
		clock.t = T0 + WINDOW + 1_000
		store.flushCoalesced(clock.t)
		const rows = drain(store)
		expect(rows).toHaveLength(2)
		expect(keys(stored(rows[0]).fields)).toEqual(["altitude"])
		expect(keys(stored(rows[1]).fields)).toEqual(
			expect.arrayContaining(["altitude", "groundSpeed", "track"]),
		)
	})
})

describe("rtl_433 receptions without a measurement are events", () => {
	it("stores every doorbell or remote press, never merging them", () => {
		const c = new PositionCoalescer(WINDOW, 64)
		const press = (at: number) =>
			c.decide(
				reception("signal", at, {
					model: "Generic-Remote",
					id: 1234,
					time: "2026-10-13 00:00:00",
					rssi: -3.1,
					protocol: 30,
				}),
			)
		for (const at of [T0, T0 + 1_000, T0 + 2_000]) {
			const d = press(at)
			expect(d.store).toBe(true)
			expect(d.merged).toBeUndefined()
			d.commit()
		}
		expect(c.heldCount()).toBe(0)
	})

	it("an identity-only reading ({model, id, battery_ok}) is an event too", () => {
		const c = new PositionCoalescer(WINDOW, 64)
		for (const at of [T0, T0 + 1_000]) {
			const d = c.decide(
				reception("signal", at, { model: "Door", id: 7, battery_ok: 1 }),
			)
			expect(d.store).toBe(true)
			d.commit()
		}
	})

	it("a measurement reading still merges", () => {
		const c = new PositionCoalescer(WINDOW, 64)
		c.decide(
			reception("signal", T0, { model: "TH", id: 9, temperature_C: 20 }),
		).commit()
		expect(
			c.decide(
				reception("signal", T0 + 1_000, {
					model: "TH",
					id: 9,
					temperature_C: 20.1,
				}),
			).store,
		).toBe(false)
	})
})

describe("a flushed row's time agrees with its list position", () => {
	it("is stamped when stored, with the held receptions' span in coalesced", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		const plane = (icao: string, at: number, lat: number) =>
			reception("aircraft", at, { icao, lat, lon: 2 }, `${icao}-${at}`)
		expect(i.admit(plane("A0F010", T0, 1)).admitted).toBe(true)
		clock.t = T0 + 1_000
		i.admit(plane("A0F010", clock.t, 1.1))
		clock.t = T0 + 5_000
		i.admit(plane("A0F010", clock.t, 1.2))
		clock.t = T0 + 30_000
		expect(i.admit(plane("A0F011", clock.t, 3)).admitted).toBe(true)
		clock.t = T0 + 1_000 + WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows.map(r => stored(r).eventId)).toEqual([
			`A0F010-${T0}`,
			`A0F011-${T0 + 30_000}`,
			`A0F010-${T0 + 5_000}`,
		])
		const times = rows.map(r => Date.parse(stored(r).receivedAt))
		expect([...times].sort((a, b) => a - b)).toEqual(times)
		const flushed = stored(rows[2])
		expect(flushed.receivedAt).toBe(new Date(clock.t).toISOString())
		expect(rows[2]?.receivedAtMs).toBe(clock.t)
		// The web lists producedAt: the snapshot is produced when stored too.
		expect(flushed.producedAt).toBe(flushed.receivedAt)
		expect(rows[2]?.producedAtMs).toBe(clock.t)
		expect(flushed.coalesced).toEqual({
			receptions: 2,
			firstSeenAt: new Date(T0 + 1_000).toISOString(),
			lastSeenAt: new Date(T0 + 5_000).toISOString(),
		})
		expect(parseStoredSummary(storedRowOf(rows[2]!)).coalesced).toEqual(
			flushed.coalesced,
		)
	})

	it("a single held reception's row keeps its reception time in coalesced", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(reception("aircraft", T0, { icao: "A0F012", lat: 1, lon: 2 }))
		clock.t = T0 + 2_000
		i.admit(
			reception("aircraft", clock.t, { icao: "A0F012", lat: 1.1, lon: 2 }),
		)
		clock.t = T0 + 2_000 + WINDOW
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows).toHaveLength(2)
		expect(stored(rows[1]).receivedAt).toBe(new Date(clock.t).toISOString())
		expect(stored(rows[1]).coalesced).toEqual({
			receptions: 1,
			firstSeenAt: new Date(T0 + 2_000).toISOString(),
			lastSeenAt: new Date(T0 + 2_000).toISOString(),
		})
	})
})

function storedRowOf(row: BuiltActivityRow) {
	return {
		seq: "1",
		event_id: row.eventId,
		kind: row.kind,
		produced_at_ms: row.producedAtMs,
		received_at_ms: row.receivedAtMs,
		summary_json: row.summaryJson,
		record_json: row.recordJson,
	}
}

describe("a failed write keeps the held receptions it carried", () => {
	const plane = (at: number, lat: number) =>
		reception("aircraft", at, { icao: "A0F020", lat, lon: 2 }, `p-${at}`)

	it("a nacked flush row is held again and flushed later", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		expect(i.admit(plane(clock.t, 1.1))).toMatchObject({ reason: "coalesced" })
		clock.t = T0 + 1_000 + WINDOW
		i.flushCoalesced(clock.t)
		expect(i.takeBatch(64, 1 << 20)).toHaveLength(1)
		i.nack()
		// Not lost: the receptions are held again, so no write-failed drop.
		expect(i.dropped["write-failed"]).toBe(0)
		const due = i.nextCoalesceDueAt()
		expect(due).toBeDefined()
		clock.t = due!
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows).toHaveLength(1)
		expect(stored(rows[0]).eventId).toBe(`p-${T0 + 1_000}`)
		expect(stored(rows[0]).coalesced?.firstSeenAt).toBe(
			new Date(T0 + 1_000).toISOString(),
		)
	})

	it("a nacked reception row that carried held receptions hands them to the next row", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		i.admit(plane(clock.t, 1.1))
		clock.t = T0 + WINDOW
		expect(i.admit(plane(clock.t, 1.2)).admitted).toBe(true)
		const batch = i.takeBatch(64, 1 << 20)
		expect(stored(batch[0]).coalesced?.receptions).toBe(2)
		i.nack()
		// Only the row's own reception is lost.
		expect(i.dropped["write-failed"]).toBe(1)
		clock.t = T0 + WINDOW + 500
		expect(i.admit(plane(clock.t, 1.3)).admitted).toBe(true)
		const rows = drain(i)
		expect(rows).toHaveLength(1)
		expect(stored(rows[0]).coalesced).toMatchObject({
			receptions: 2,
			firstSeenAt: new Date(T0 + 1_000).toISOString(),
		})
	})

	it("restored held receptions join ones held since", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		i.admit(plane(clock.t, 1.1))
		clock.t = T0 + 1_000 + WINDOW
		i.flushCoalesced(clock.t)
		const batch = i.takeBatch(64, 1 << 20)
		expect(batch).toHaveLength(1)
		// Received inside the flushed reception's window, held while its row is in flight.
		clock.t += 100
		expect(i.admit(plane(T0 + WINDOW + 500, 1.2))).toMatchObject({
			reason: "coalesced",
		})
		i.nack()
		clock.t = T0 + 1_000 + 2 * WINDOW + 200
		i.flushCoalesced(clock.t)
		const rows = drain(i)
		expect(rows.length).toBeGreaterThanOrEqual(1)
		const last = stored(rows[rows.length - 1])
		expect(last.coalesced).toMatchObject({
			receptions: 2,
			firstSeenAt: new Date(T0 + 1_000).toISOString(),
		})
	})

	it("a skipped flush row is held again too", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		i.admit(plane(clock.t, 1.1))
		clock.t = T0 + 1_000 + WINDOW
		i.flushCoalesced(clock.t)
		const batch = i.takeBatch(64, 1 << 20)
		i.noteSkipped(
			batch,
			batch.map(r => r.eventId),
		)
		i.ack(new Set())
		expect(i.dropped["write-failed"]).toBe(0)
		expect(i.nextCoalesceDueAt()).toBeDefined()
	})

	it("a shutdown flush row skipped after close is a counted loss, never held again", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		expect(i.admit(plane(clock.t, 1.1))).toMatchObject({ reason: "coalesced" })
		i.flushAllCoalesced()
		i.markClosed()
		const batch = i.takeBatch(64, 1 << 20)
		expect(batch).toHaveLength(1)
		i.noteSkipped(
			batch,
			batch.map(r => r.eventId),
		)
		i.ack(new Set())
		expect(i.dropped["write-failed"]).toBe(1)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		// The loss is in the ingestion-gap accounting staged at shutdown.
		expect(i.stageOpenEpisode(clock.t)).toBe(true)
		const gap = i.takeBatch(64, 1 << 20)
		expect(gap.map(r => r.kind)).toEqual(["ingestion-gap"])
		expect(JSON.parse(gap[0]!.recordJson)).toMatchObject({
			payload: { reason: "write-failed", dropped: 1 },
		})
		i.abandonQueued()
		expect(i.dropped["write-failed"]).toBe(1)
	})

	it("a shutdown flush row nacked after close is a counted loss too", () => {
		const clock = { t: T0 }
		const i = storeIngress(clock)
		i.admit(plane(T0, 1))
		drain(i)
		clock.t = T0 + 1_000
		i.admit(plane(clock.t, 1.1))
		i.flushAllCoalesced()
		i.markClosed()
		expect(i.takeBatch(64, 1 << 20)).toHaveLength(1)
		i.nack()
		expect(i.dropped["write-failed"]).toBe(1)
		expect(i.nextCoalesceDueAt()).toBeUndefined()
		i.abandonQueued()
		expect(i.dropped["write-failed"]).toBe(1)
	})
})

describe("identity comparison", () => {
	it("tells a string squawk from a number and compares objects by value", () => {
		const c = new PositionCoalescer(WINDOW, 64)
		const at = (k: number) => T0 + k * 1_000
		const plane = (k: number, extra: Record<string, JsonValue>) =>
			reception("aircraft", at(k), { icao: "A0F030", lat: 1, lon: 2, ...extra })
		c.decide(plane(0, { squawk: "7700", category: { a: 1 } })).commit()
		expect(
			c.decide(plane(1, { squawk: "7700", category: { a: 1 } })).store,
		).toBe(false)
		const changed = c.decide(plane(2, { squawk: 7700, category: { a: 1 } }))
		expect(changed.store).toBe(true)
		changed.commit()
		expect(c.decide(plane(3, { squawk: 7700, category: { a: 2 } })).store).toBe(
			true,
		)
	})
})

describe("stored aircraft rows carry the identity known when stored", () => {
	function harness(lookup: ActivityAircraftIdentityLookup | undefined) {
		const clock = { t: T0 }
		const store = storeIngress(clock)
		let n = 0
		const calls: string[] = []
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `i-${n++}`,
			...(lookup === undefined
				? {}
				: {
						aircraftIdentity: (icao: string) => {
							calls.push(icao)
							return lookup(icao)
						},
					}),
		})
		const publish = (
			type: DecoderOutputType,
			data: Record<string, JsonValue>,
		) =>
			core.publish("dec", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "dec",
				type,
				data,
			})
		return { clock, store, publish, calls }
	}

	it("persists the merged callsign and the enrichment cache's registration, type and operator", () => {
		const h = harness(icao =>
			icao === "A0F040"
				? {
						registration: "N0WK40",
						typeCode: "A320",
						typeDescription: "Airbus A320",
						operator: "WaveKit Air",
					}
				: null,
		)
		h.publish("aircraft", { icao: "a0f040", callsign: "WKA40", lat: 1, lon: 2 })
		h.clock.t = T0 + 1_000
		h.publish("aircraft", { icao: "a0f040", lat: 1.1, lon: 2 })
		h.clock.t = T0 + 1_000 + WINDOW
		h.store.flushCoalesced(h.clock.t)
		const rows = drain(h.store)
		expect(rows).toHaveLength(2)
		for (const row of rows) {
			const identity = {
				callsign: "WKA40",
				registration: "N0WK40",
				typeCode: "A320",
				typeDescription: "Airbus A320",
				operator: "WaveKit Air",
			}
			expect(stored(row).aircraft).toEqual(identity)
			expect(parseStoredSummary(storedRowOf(row)).aircraft).toEqual(identity)
		}
		// Looked up for stored rows only (never for the held reception).
		expect(h.calls).toEqual(["A0F040", "A0F040"])
	})

	it("keeps the callsign alone when the cache knows nothing, and nothing when neither does", () => {
		const h = harness(() => null)
		h.publish("aircraft", { icao: "A0F041", callsign: "WKA41", lat: 1, lon: 2 })
		h.publish("aircraft", { icao: "A0F042", lat: 1, lon: 2 })
		const rows = drain(h.store)
		expect(stored(rows[0]).aircraft).toEqual({ callsign: "WKA41" })
		expect(stored(rows[1]).aircraft).toBeUndefined()
		expect(parseStoredSummary(storedRowOf(rows[1]!)).aircraft).toBeUndefined()
	})

	it("ignores a lookup that throws or returns malformed or oversized values", () => {
		const h = harness(icao => {
			if (icao === "A0F043") throw new Error("cache unavailable")
			return {
				registration: "x".repeat(200),
				typeCode: 7 as unknown as string,
				operator: "Line\u0000Break",
				typeDescription: " ",
			}
		})
		h.publish("aircraft", { icao: "A0F043", lat: 1, lon: 2 })
		h.publish("aircraft", { icao: "A0F044", lat: 1, lon: 2 })
		const rows = drain(h.store)
		expect(rows).toHaveLength(2)
		expect(stored(rows[0]).aircraft).toBeUndefined()
		expect(stored(rows[1]).aircraft).toBeUndefined()
		expect(stored(rows[1]).title).toBe("A0F044")
	})

	it("never touches other outputs", () => {
		const h = harness(() => ({ registration: "N0WK45" }))
		h.publish("ship", { mmsi: "235000045", messageType: 1, lat: 1, lon: 2 })
		const rows = drain(h.store)
		expect(stored(rows[0]).aircraft).toBeUndefined()
		expect(h.calls).toEqual([])
	})
})

describe("stored aircraft identity stays inside the row growth bound plus its allowance", () => {
	// 1,100 for the presentation, plus 320 only identity members may use.
	const LIMIT =
		ROW_GROWTH_MAX_BYTES + ACTIVITY_AIRCRAFT_IDENTITY_ALLOWANCE_BYTES
	const ORDER = [
		"callsign",
		"registration",
		"typeCode",
		"operator",
		"typeDescription",
	] as const

	function rowBytes(env: DecodeEnvelope): number {
		const row = buildActivityRow({
			version: ACTIVITY_RECORD_VERSION,
			eventId: env.eventId,
			commitSeq: "0",
			producedAt: env.producedAt,
			receivedAt: env.receivedAt,
			kind: "decoder-reception",
			payload: env,
		})
		return (
			Buffer.byteLength(row.summaryJson, "utf8") +
			Buffer.byteLength(row.recordJson, "utf8") +
			Buffer.byteLength(row.ftsText, "utf8")
		)
	}

	function storeOne(
		data: Record<string, JsonValue>,
		known: ReturnType<ActivityAircraftIdentityLookup>,
	) {
		const clock = { t: T0 }
		const store = storeIngress(clock)
		const output = {
			timestamp: new Date(clock.t),
			decoder: "dec",
			type: "aircraft" as const,
			data,
		}
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => "i-0",
			aircraftIdentity: () => known,
		})
		core.publish("dec", "readsb", output)
		const rows = drain(store)
		expect(rows).toHaveLength(1)
		const env = stored(rows[0])
		const plain = createDecodeEnvelope(output, {
			eventId: env.eventId,
			receivedAt: new Date(env.receivedAt),
			decoderId: "dec",
			decoderType: "readsb",
			provenance: { sourceId: null, frequency: null },
		})
		return { row: rows[0]!, env, plainBytes: rowBytes(plain) }
	}

	const ordinary = (callsign: string): Record<string, JsonValue> => ({
		icao: "A0F050",
		callsign,
		altitude: 37_000,
		groundSpeed: 452.5,
		track: 271.3,
		verticalRate: -1_024,
		squawk: "7421",
		lat: 51.4706123,
		lon: -0.4619456,
	})

	it("the allowance is 5 members × 64 bytes", () => {
		expect(ACTIVITY_AIRCRAFT_IDENTITY_ALLOWANCE_BYTES).toBe(320)
	})

	it("drops identity members, lowest priority first, until record + summary + FTS growth fits 1,100 + 320 bytes", () => {
		const quotes = '"'.repeat(64)
		const { row, env, plainBytes } = storeOne(ordinary("WKA50"), {
			registration: quotes,
			typeCode: quotes,
			typeDescription: quotes,
			operator: quotes,
		})
		expect(rowBytes(env) - plainBytes).toBeLessThanOrEqual(LIMIT)
		// The callsign and the list fields survive; the summary agrees with the record.
		expect(env.aircraft?.callsign).toBe("WKA50")
		expect(keys(env.fields)).toContain("altitude")
		expect(parseStoredSummary(storedRowOf(row)).aircraft).toEqual(env.aircraft)
	})

	it("keeps the most identity that fits, at and past the bound, for escape-heavy values", () => {
		for (const n of [0, 8, 16, 24, 32, 40, 48, 56, 64]) {
			const text = '\\"'.repeat(n / 2) || "N0WK50"
			const known = {
				registration: text,
				typeCode: text,
				typeDescription: text,
				operator: text,
			}
			const { env, plainBytes } = storeOne(ordinary("WKA50"), known)
			const growth = rowBytes(env) - plainBytes
			expect(growth).toBeLessThanOrEqual(LIMIT)
			const identity = env.aircraft ?? {}
			const kept = ORDER.filter(key => identity[key] !== undefined)
			// Kept members are a priority prefix: a lower one never outlives a higher one.
			expect(kept).toEqual(ORDER.slice(0, kept.length))
			const next = ORDER[kept.length]
			if (next === undefined) continue
			// The first dropped member would have passed the bound.
			const value = next === "callsign" ? "WKA50" : known[next]
			const grown = withEnvelopeMetadata(env, {
				aircraft: { ...identity, [next]: value },
			})
			expect(rowBytes(grown) - plainBytes).toBeGreaterThan(LIMIT)
		}
	})

	it("keeps an identity that builds to exactly the bound plus allowance, and drops the type past it", () => {
		const data = ordinary("WKA53")
		// The presented row without an identity: the presentation alone.
		const stored = storeOne(data, null)
		expect(stored.env.aircraft).toEqual({ callsign: "WKA53" })
		const { aircraft: _callsign, ...presented } = stored.env
		const bare = { env: presented, plainBytes: stored.plainBytes }
		expect(rowBytes(bare.env) - bare.plainBytes).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
		const base = {
			registration: "N0WK53",
			typeCode: "B77W",
			typeDescription: "Boeing 777-300ER",
		}
		const growthOf = (operator: string) =>
			rowBytes(
				withEnvelopeMetadata(bare.env, {
					aircraft: { callsign: "WKA53", ...base, operator },
				}),
			) - bare.plainBytes
		// A plain character costs 3 built bytes (record, summary, FTS), a quote
		// 5 (escaped twice in JSON, raw in FTS): mix them to land on the limit.
		let at: string | undefined
		for (let quotes = 0; quotes <= 64 && at === undefined; quotes++)
			for (let plain = 0; quotes + plain <= 64; plain++) {
				const operator = '"'.repeat(quotes) + "x".repeat(plain)
				if (operator.length > 0 && growthOf(operator) === LIMIT) {
					at = operator
					break
				}
			}
		expect(at).toBeDefined()
		const atBound = storeOne(data, { ...base, operator: at! })
		expect(atBound.env.aircraft).toEqual({
			callsign: "WKA53",
			...base,
			operator: at,
		})
		expect(rowBytes(atBound.env) - atBound.plainBytes).toBe(LIMIT)
		// One escaped character more is past it: the type description goes first.
		const past = `${at!.slice(0, -1)}"`
		expect(growthOf(past)).toBeGreaterThan(LIMIT)
		const pastBound = storeOne(data, { ...base, operator: past })
		expect(pastBound.env.aircraft).toEqual({
			callsign: "WKA53",
			registration: "N0WK53",
			typeCode: "B77W",
			operator: past,
		})
		expect(keys(pastBound.env.fields)).toEqual(keys(bare.env.fields))
	})

	it("keeps an ordinary identity whole on a sparse row", () => {
		const known = {
			registration: "N0WK51",
			typeCode: "B77W",
			typeDescription: "Boeing 777-300ER",
			operator: "WaveKit International Airways",
		}
		const { env, plainBytes } = storeOne(
			{ icao: "A0F051", callsign: "WKA51", lat: 51.47, lon: -0.46 },
			known,
		)
		expect(env.aircraft).toEqual({ callsign: "WKA51", ...known })
		expect(rowBytes(env) - plainBytes).toBeLessThanOrEqual(ROW_GROWTH_MAX_BYTES)
	})

	it("keeps the whole ordinary identity of a fully listed row, using the allowance", () => {
		const known = {
			registration: "N0WK52",
			typeCode: "B77W",
			typeDescription: "Boeing 777-300ER",
			operator: "WaveKit International Airways",
		}
		const { env, plainBytes } = storeOne(ordinary("WKA52"), known)
		expect(env.aircraft).toEqual({ callsign: "WKA52", ...known })
		expect(keys(env.fields)).toEqual([
			"squawk",
			"altitude",
			"groundSpeed",
			"track",
			"verticalRate",
		])
		const growth = rowBytes(env) - plainBytes
		// Past the plain bound: the identity uses its allowance.
		expect(growth).toBeGreaterThan(ROW_GROWTH_MAX_BYTES)
		expect(growth).toBeLessThanOrEqual(LIMIT)
		// The presentation itself still fits 1,100.
		const { aircraft: _identity, ...presented } = env
		expect(rowBytes(presented) - plainBytes).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
	})
})
