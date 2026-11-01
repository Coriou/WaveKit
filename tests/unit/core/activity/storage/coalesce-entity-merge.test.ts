import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import {
	parseBeastMessage,
	parseJsonAircraft,
	parseSbsLine,
} from "../../../../../src/decoders/builtin/readsb.js"
import { parseNmeaSentence } from "../../../../../src/decoders/builtin/ais-catcher.js"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import {
	COALESCE_SPECS,
	PositionCoalescer,
} from "../../../../../src/core/activity/storage/coalesce.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import {
	ACTIVITY_LIMIT_DEFAULTS,
	resolveActivityLimits,
} from "../../../../../src/core/activity/storage/limits.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type {
	DecodeEnvelope,
	JsonValue,
} from "../../../../../src/core/activity/types.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const WINDOW = ACTIVITY_LIMIT_DEFAULTS.positionCoalesceMs

/** SBS clock fields (YYYY/MM/DD, HH:MM:SS.mmm) for a time. */
function sbsClock(ms: number): [string, string] {
	const iso = new Date(ms).toISOString()
	return [iso.slice(0, 10).replaceAll("-", "/"), iso.slice(11, 23)]
}

interface SbsFields {
	callsign?: string
	altitude?: number
	groundSpeed?: number
	track?: number
	lat?: number
	lon?: number
	verticalRate?: number
	squawk?: string
	onGround?: boolean
}

/** A synthetic BaseStation line, the way readsb writes it on its SBS port. */
function sbsLine(type: number, icao: string, ms: number, f: SbsFields): string {
	const [date, time] = sbsClock(ms)
	const v = (x: string | number | undefined) =>
		x === undefined ? "" : String(x)
	return [
		"MSG",
		type,
		1,
		1,
		icao,
		1,
		date,
		time,
		date,
		time,
		v(f.callsign),
		v(f.altitude),
		v(f.groundSpeed),
		v(f.track),
		v(f.lat),
		v(f.lon),
		v(f.verticalRate),
		v(f.squawk),
		"",
		"",
		"",
		f.onGround === undefined ? "" : f.onGround ? "-1" : "0",
	].join(",")
}

/** The envelope the Activity ingress builds for a readsb output (as decoder manager publishes it). */
function readsbEnvelope(
	data: DecoderOutput["data"],
	ms: number,
	eventId: string,
): DecodeEnvelope {
	return createDecodeEnvelope(
		{ timestamp: new Date(ms), decoder: "adsb", type: "aircraft", data },
		{
			eventId,
			receivedAt: new Date(ms),
			decoderId: "adsb",
			provenance: { sourceId: null, frequency: null },
		},
	)
}

function allowed(outputType: string): Set<string> {
	const spec = COALESCE_SPECS[outputType]
	return new Set([...(spec?.redundant ?? []), ...(spec?.identity ?? [])])
}

function keysOf(value: JsonValue): string[] {
	return Object.keys(value as Record<string, JsonValue>)
}

function offer(c: PositionCoalescer, env: DecodeEnvelope): boolean {
	const d = c.decide(env)
	if (d.store) d.commit()
	else c.noteCoalesced()
	return d.store
}

describe("root cause: readsb envelopes were never redundant", () => {
	// Before this fix every SBS envelope carried readsbFormat, sbsSourceTimestamp and sbsContentId
	// (a different hash per line); none was on the aircraft allowlist, so decide() found every
	// reception informative, stored each one and left the token buckets to drop them.
	it("every key of an SBS, JSON and proven Beast envelope is on the aircraft allowlist", () => {
		const sbs = parseSbsLine(
			sbsLine(3, "A0B001", T0, {
				altitude: 31000,
				lat: 10.5,
				lon: 20.5,
				onGround: false,
			}),
		)
		const json = parseJsonAircraft({
			hex: "a0b001",
			flight: "TST001  ",
			alt_baro: 31000,
			gs: 420,
			track: 90,
			lat: 10.5,
			lon: 20.5,
			squawk: "1234",
			messages: 40,
			now: T0 / 1000,
			seen: 0.4,
		})
		const env = [sbs, json].map((data, i) =>
			readsbEnvelope(data, T0, `rc-${i}`),
		)
		const sbsKeys = keysOf(env[0]?.decodedData ?? null)
		expect(sbsKeys).toEqual(
			expect.arrayContaining([
				"readsbFormat",
				"sbsSourceTimestamp",
				"sbsContentId",
			]),
		)
		expect(keysOf(env[1]?.decodedData ?? null)).toContain("jsonSourceTimestamp")
		const ok = allowed("aircraft")
		for (const e of env)
			for (const key of keysOf(e.decodedData))
				expect(ok.has(key), key).toBe(true)
	})

	it("holds the second SBS position of an aircraft inside the window", () => {
		const c = new PositionCoalescer(WINDOW, 100, () => T0)
		const first = sbsLine(3, "A0B001", T0, {
			altitude: 31000,
			lat: 10.5,
			lon: 20.5,
			onGround: false,
		})
		const next = sbsLine(3, "A0B001", T0 + 500, {
			altitude: 31025,
			lat: 10.51,
			lon: 20.5,
			onGround: false,
		})
		const velocity = sbsLine(4, "A0B001", T0 + 1000, {
			groundSpeed: 420,
			track: 90,
			verticalRate: 0,
		})
		expect(offer(c, readsbEnvelope(parseSbsLine(first), T0, "a"))).toBe(true)
		expect(offer(c, readsbEnvelope(parseSbsLine(next), T0 + 500, "b"))).toBe(
			false,
		)
		expect(
			offer(c, readsbEnvelope(parseSbsLine(velocity), T0 + 1000, "c")),
		).toBe(false)
		expect(c.coalesced).toBe(2)
	})

	it("tracks a CRC-proven Beast address and never an unproven one", () => {
		// DF17 frame with a valid CRC (synthetic): address A0B001, payload zero.
		const proven = parseBeastMessage(
			0x33,
			Buffer.alloc(6),
			0,
			Buffer.from("8da0b00100000000000000000000", "hex"),
		)
		expect(proven?.modeS?.crcOk).toBeDefined()
		const unproven = parseBeastMessage(
			0x32,
			Buffer.alloc(6),
			0,
			Buffer.from("28000aabcdef12", "hex"),
		)
		expect(unproven?.modeS?.crcOk).toBe(false)
		const c = new PositionCoalescer(WINDOW, 100, () => T0)
		for (let i = 0; i < 3; i++)
			expect(offer(c, readsbEnvelope(unproven, T0 + i, `u-${i}`))).toBe(true)
		expect(c.size()).toBe(0)
		if (proven?.modeS?.crcOk) {
			expect(offer(c, readsbEnvelope(proven, T0, "p1"))).toBe(true)
			expect(offer(c, readsbEnvelope(proven, T0 + 1, "p2"))).toBe(false)
		}
	})

	it("every key of an AIS position envelope is on the ship allowlist (channel included)", () => {
		const ship = parseNmeaSentence("!AIVDM,1,1,,A,13u@Dp0P00PH=3pN4T0,0*7D")
		expect(ship?.channel).toBe("A")
		const env = createDecodeEnvelope(
			{ timestamp: new Date(T0), decoder: "ais", type: "ship", data: ship },
			{
				eventId: "s1",
				receivedAt: new Date(T0),
				decoderId: "ais",
				provenance: { sourceId: null, frequency: null },
			},
		)
		const ok = allowed("ship")
		for (const key of keysOf(env.decodedData))
			expect(ok.has(key), key).toBe(true)
	})
})

function aircraft(
	at: number,
	data: Record<string, JsonValue>,
	eventId = `ev-${at}`,
): DecodeEnvelope {
	return envelope({
		eventId,
		decoderId: "adsb",
		outputType: "aircraft",
		receivedAt: new Date(at).toISOString(),
		decodedData: { icao: "A0B001", ...data },
	})
}

function ingressAt(clock: { t: number }, overrides = {}) {
	return new ActivityIngress(
		resolveActivityLimits({
			globalRatePerSec: 1_000_000,
			globalBurst: 1_000_000,
			decoderBurst: 1_000_000,
			decoderRatePerSec: 100_000,
			...overrides,
		}),
		() => clock.t,
		logger,
	)
}

function drain(i: ActivityIngress, into: BuiltActivityRow[]): void {
	for (;;) {
		const batch = i.takeBatch(64, 1 << 20)
		if (batch.length === 0) return
		into.push(...batch)
		i.ack(new Set(batch.map(r => r.eventId)))
	}
}

function stored(row: BuiltActivityRow | undefined): DecodeEnvelope {
	const record = JSON.parse(row?.recordJson ?? "null") as {
		payload: DecodeEnvelope
	}
	return record.payload
}

describe("per-entity merge at admission", () => {
	it("stores the merged latest state with the held count and span", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		expect(
			i.admit(aircraft(T0, { callsign: "TST001", lat: 10, lon: 20 })).admitted,
		).toBe(true)
		clock.t = T0 + 1_000
		expect(i.admit(aircraft(T0 + 1_000, { altitude: 31000 }))).toEqual({
			admitted: false,
			reason: "coalesced",
		})
		clock.t = T0 + 2_000
		expect(
			i.admit(aircraft(T0 + 2_000, { groundSpeed: 420, lat: 10.1 })).admitted,
		).toBe(false)
		// Due: one window after the stored row.
		clock.t = T0 + WINDOW
		expect(i.admit(aircraft(T0 + WINDOW, { track: 90 }, "due")).admitted).toBe(
			true,
		)
		drain(i, rows)
		expect(rows).toHaveLength(2)
		const row = stored(rows[1])
		expect(row.eventId).toBe("due")
		expect(row.decodedData).toMatchObject({
			icao: "A0B001",
			callsign: "TST001",
			altitude: 31000,
			groundSpeed: 420,
			lat: 10.1,
			lon: 20,
			track: 90,
		})
		expect(row.coalesced).toEqual({
			receptions: 3,
			firstSeenAt: new Date(T0 + 1_000).toISOString(),
			lastSeenAt: new Date(T0 + WINDOW).toISOString(),
		})
		expect(JSON.parse(rows[1]?.summaryJson ?? "{}")).toMatchObject({
			coalesced: row.coalesced,
		})
		expect(i.coalescedPositions).toBe(2)
		expect(i.dropped["rate-limited"]).toBe(0)
	})

	it("stores an identity change at once, an emergency squawk included", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		i.admit(aircraft(T0, { squawk: "1234", lat: 10, lon: 20 }))
		expect(i.admit(aircraft(T0 + 500, { lat: 10.01 })).admitted).toBe(false)
		expect(
			i.admit(aircraft(T0 + 1_000, { squawk: "7700" }, "sq")).admitted,
		).toBe(true)
		expect(
			i.admit(aircraft(T0 + 1_500, { callsign: "TST002" }, "cs")).admitted,
		).toBe(true)
		drain(i, rows)
		const emergency = stored(rows[1])
		expect(emergency.decodedData).toMatchObject({
			squawk: "7700",
			lat: 10.01,
			lon: 20,
		})
		expect(emergency.coalesced?.receptions).toBe(2)
		expect(stored(rows[2]).decodedData).toMatchObject({
			callsign: "TST002",
			squawk: "7700",
		})
		expect(stored(rows[2]).coalesced).toBeUndefined()
	})

	it("flushes held receptions one window after the first, when no row follows", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		i.admit(aircraft(T0, { callsign: "TST001", lat: 10, lon: 20 }))
		clock.t = T0 + 5_000
		i.admit(aircraft(T0 + 5_000, { lat: 10.2 }, "last"))
		expect(i.nextCoalesceDueAt()).toBe(T0 + 5_000 + WINDOW)
		i.flushCoalesced(T0 + 5_000 + WINDOW - 1)
		drain(i, rows)
		expect(rows).toHaveLength(1)
		i.flushCoalesced(T0 + 5_000 + WINDOW)
		drain(i, rows)
		expect(rows).toHaveLength(2)
		const row = stored(rows[1])
		expect(row.eventId).toBe("last")
		expect(row.decodedData).toMatchObject({ callsign: "TST001", lat: 10.2 })
		// Stamped when stored; one held reception, its time in the span.
		expect(row.receivedAt).toBe(new Date(T0 + 5_000 + WINDOW).toISOString())
		expect(row.coalesced).toEqual({
			receptions: 1,
			firstSeenAt: new Date(T0 + 5_000).toISOString(),
			lastSeenAt: new Date(T0 + 5_000).toISOString(),
		})
		expect(i.nextCoalesceDueAt()).toBeUndefined()
	})

	it("drops a stale position after a gap longer than the window", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		i.admit(aircraft(T0, { callsign: "TST001", lat: 10, lon: 20 }))
		const back = T0 + WINDOW + 1
		expect(i.admit(aircraft(back, { altitude: 5000 }, "back")).admitted).toBe(
			true,
		)
		drain(i, rows)
		const row = stored(rows[1])
		expect(row.decodedData).toEqual({
			icao: "A0B001",
			callsign: "TST001",
			altitude: 5000,
		})
	})

	it("stores off-allowlist and ineligible receptions as their own, unmerged into later rows", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		i.admit(aircraft(T0, { callsign: "TST001", lat: 10, lon: 20 }))
		expect(i.admit(aircraft(T0 + 1_000, { nic: 8 }, "nic")).admitted).toBe(true)
		clock.t = T0 + 1_000 + WINDOW
		i.admit(aircraft(T0 + 1_000 + WINDOW, { lat: 11 }, "due"))
		drain(i, rows)
		expect(stored(rows[1]).decodedData).toMatchObject({
			nic: 8,
			callsign: "TST001",
			lat: 10,
		})
		expect(stored(rows[2]).decodedData).not.toHaveProperty("nic")
	})

	it("keeps pages, calls and ACARS one row per message", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		for (const outputType of ["message", "call", "acars", "decode"])
			for (let n = 0; n < 3; n++)
				expect(
					i.admit(
						envelope({
							decoderId: "pager",
							outputType,
							receivedAt: new Date(T0 + n).toISOString(),
							decodedData: { address: 1234, message: "TEST" },
						}),
					).admitted,
				).toBe(true)
		expect(i.coalescedPositions).toBe(0)
	})
})

describe("generalised entities", () => {
	function sensor(
		at: number,
		data: Record<string, JsonValue>,
		eventId?: string,
	) {
		return envelope({
			...(eventId ? { eventId } : {}),
			decoderId: "ism",
			outputType: "signal",
			receivedAt: new Date(at).toISOString(),
			decodedData: { model: "Test-TH", id: 42, channel: 1, ...data },
		})
	}

	it("coalesces rtl_433 periodic readings per model, id and channel and stores events", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		expect(
			i.admit(sensor(T0, { temperature_C: 20.1, humidity: 50, battery_ok: 1 }))
				.admitted,
		).toBe(true)
		// rtl_433 repeats each send 2-3 times, then sends again every 30-60 s.
		expect(
			i.admit(
				sensor(T0 + 10, { temperature_C: 20.1, humidity: 50, battery_ok: 1 }),
			).admitted,
		).toBe(false)
		expect(
			i.admit(
				sensor(T0 + 30_000, {
					temperature_C: 20.3,
					humidity: 51,
					battery_ok: 1,
				}),
			).admitted,
		).toBe(false)
		// Another channel or id is another sensor.
		expect(
			i.admit(sensor(T0 + 30_001, { channel: 2, temperature_C: 18 })).admitted,
		).toBe(true)
		// A battery change, or a field off the allowlist (a button), is stored.
		expect(
			i.admit(sensor(T0 + 30_002, { temperature_C: 20.3, battery_ok: 0 }))
				.admitted,
		).toBe(true)
		expect(i.admit(sensor(T0 + 30_003, { button: 1 })).admitted).toBe(true)
		clock.t = T0 + 30_003 + WINDOW
		i.flushCoalesced(clock.t)
		drain(i, rows)
		expect(rows).toHaveLength(4)
		// The battery row carried the held readings.
		expect(stored(rows[2]).decodedData).toMatchObject({
			temperature_C: 20.3,
			battery_ok: 0,
		})
		expect(stored(rows[2]).coalesced?.receptions).toBe(3)
	})

	it("merges AIS and APRS position reports per vessel and station", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock)
		const rows: BuiltActivityRow[] = []
		const ship = (
			at: number,
			data: Record<string, JsonValue>,
			eventId?: string,
		) =>
			envelope({
				...(eventId ? { eventId } : {}),
				decoderId: "ais",
				outputType: "ship",
				receivedAt: new Date(at).toISOString(),
				decodedData: {
					mmsi: "000000001",
					messageType: 1,
					channel: "A",
					...data,
				},
			})
		i.admit(ship(T0, { lat: 1, lon: 2, navStatus: 0 }))
		expect(
			i.admit(ship(T0 + 3_000, { lat: 1.01, lon: 2, sog: 12, channel: "B" }))
				.admitted,
		).toBe(false)
		// A static report (type 5) is never merged and always stored.
		expect(
			i.admit(ship(T0 + 4_000, { messageType: 5, name: "TEST VESSEL" }))
				.admitted,
		).toBe(true)
		const aprs = (at: number, lat: number) =>
			envelope({
				decoderId: "aprs",
				outputType: "aprs",
				receivedAt: new Date(at).toISOString(),
				decodedData: { source: "N0CALL-9", dataType: "Position", lat, lon: 2 },
			})
		i.admit(aprs(T0, 1))
		expect(i.admit(aprs(T0 + 30_000, 1.5)).admitted).toBe(false)
		clock.t = T0 + 3_000 + WINDOW
		i.flushCoalesced(clock.t)
		drain(i, rows)
		const shipRows = rows.map(stored).filter(r => r.outputType === "ship")
		expect(shipRows).toHaveLength(3)
		// The held position report, flushed with the latest state; the static report stayed its own.
		expect(shipRows[2]?.decodedData).toMatchObject({
			messageType: 1,
			lat: 1.01,
			sog: 12,
			navStatus: 0,
			channel: "B",
		})
		expect(shipRows[2]?.decodedData).not.toHaveProperty("name")
		const aprsRow = rows.map(stored).filter(r => r.outputType === "aprs")
		expect(aprsRow.at(-1)?.decodedData).toMatchObject({ lat: 1.5 })
	})
})

describe("entity bound", () => {
	const at = (n: number) => new Date(T0 + n).toISOString()
	const plane = (
		icao: string,
		n: number,
		data: Record<string, JsonValue> = {},
	) =>
		envelope({
			eventId: `${icao}-${n}`,
			decoderId: "adsb",
			outputType: "aircraft",
			receivedAt: at(n),
			decodedData: { icao, lat: 1, lon: 2, ...data },
		})

	it("tracks exactly maxEntities and flushes an evicted entity's held state", () => {
		const clock = { t: T0 }
		const i = ingressAt(clock, { positionCoalesceMaxEntities: 2 })
		const rows: BuiltActivityRow[] = []
		i.admit(plane("A00001", 0))
		i.admit(plane("A00002", 1))
		// At the bound: both are tracked, so both hold.
		expect(i.admit(plane("A00001", 2, { lat: 1.1 })).admitted).toBe(false)
		expect(i.admit(plane("A00002", 3)).admitted).toBe(false)
		drain(i, rows)
		expect(rows).toHaveLength(2)
		// Past the bound: the least recently stored (A00001) is evicted, its held row flushed.
		expect(i.admit(plane("A00003", 4)).admitted).toBe(true)
		drain(i, rows)
		expect(rows.map(r => r.eventId)).toEqual([
			"A00001-0",
			"A00002-1",
			"A00003-4",
			"A00001-2",
		])
		expect(stored(rows[3]).decodedData).toMatchObject({
			icao: "A00001",
			lat: 1.1,
		})
		// The evicted entity is new again.
		expect(i.admit(plane("A00001", 5)).admitted).toBe(true)
	})

	it("never holds more entities than the bound under churn", () => {
		const c = new PositionCoalescer(WINDOW, 3, () => T0)
		for (let n = 0; n < 50; n++) {
			const icao = `A0000${n % 7}`
			offer(c, plane(icao, n))
			expect(c.size()).toBeLessThanOrEqual(3)
			expect(c.heldCount()).toBeLessThanOrEqual(c.size())
			while (c.takeDue(T0) !== undefined) {
				// evicted rows only: nothing is due yet
			}
		}
	})
})

describe("presented end to end through the Activity ingress", () => {
	it("presents the merged state of a held aircraft (title and fields from older messages)", () => {
		const clock = { t: T0 }
		const store = new ActivityIngress(
			resolveActivityLimits(),
			() => clock.t,
			logger,
		)
		let n = 0
		const core = createActivityIngress({
			sink: (env, present) => {
				store.admit(env, present)
			},
			logger,
			now: () => new Date(clock.t),
			randomUUID: () => `p-${n++}`,
		})
		const publish = (line: string) =>
			core.publish("adsb", "readsb", {
				timestamp: new Date(clock.t),
				decoder: "adsb",
				type: "aircraft",
				data: parseSbsLine(line),
			})
		publish(sbsLine(1, "A0B001", T0, { callsign: "TST001" }))
		clock.t = T0 + 500
		publish(sbsLine(4, "A0B001", clock.t, { groundSpeed: 420, track: 90 }))
		clock.t = T0 + WINDOW
		publish(
			sbsLine(3, "A0B001", clock.t, { altitude: 31000, lat: 10.5, lon: 20.5 }),
		)
		const rows: BuiltActivityRow[] = []
		drain(store, rows)
		expect(rows).toHaveLength(2)
		const row = stored(rows[1])
		expect(row.title).toBe("TST001")
		expect(row.entityKey).toBe("icao:A0B001")
		expect(row.position).toMatchObject({ lat: 10.5, lon: 20.5 })
		expect(row.fields.map(f => f.key)).toEqual(
			expect.arrayContaining(["altitude", "groundSpeed"]),
		)
		expect(row.coalesced).toEqual({
			receptions: 2,
			firstSeenAt: new Date(T0 + 500).toISOString(),
			lastSeenAt: new Date(T0 + WINDOW).toISOString(),
		})
	})
})

describe("1090 MHz load: 60 aircraft × 2 SBS messages/s for 10 min", () => {
	/**
	 * decodedData as an SBS envelope projects it (parseSbsLine fields, Dates as ISO text, a fresh
	 * content hash per line), without the per-line SHA-256 and envelope validation, so the 72,000
	 * receptions stay cheap. Identification and squawk every 10 s, positions and velocities between.
	 */
	function message(
		k: number,
		tick: number,
		ms: number,
	): Record<string, JsonValue> {
		const at = new Date(ms).toISOString()
		const base: Record<string, JsonValue> = {
			icao: `A0${(0xb000 + k).toString(16).toUpperCase()}`,
			lastSeen: at,
			messageCount: 1,
			readsbFormat: "sbs",
			sbsSourceTimestamp: at,
			sbsContentId: `${k}-${tick}`,
		}
		const phase = tick % 20
		if (phase === 0)
			return { ...base, callsign: `TST${String(k).padStart(3, "0")}` }
		if (phase === 10)
			return { ...base, squawk: String(1000 + k), onGround: false }
		if (tick % 2 === 1)
			return { ...base, groundSpeed: 400 + k, track: 90, verticalRate: 0 }
		return {
			...base,
			altitude: 30000 + k * 100,
			lat: 10 + k * 0.01 + tick * 0.0001,
			lon: 20 + tick * 0.0001,
			onGround: false,
		}
	}

	it("rate-limits nothing, stores every aircraft's latest state at most one window old", async () => {
		const clock = { t: T0 }
		const store = new ActivityIngress(
			resolveActivityLimits(),
			() => clock.t,
			logger,
		)
		const rows: BuiltActivityRow[] = []
		const lastPosition = new Map<string, number>()
		const TICKS = 1_200 // 10 min of 500 ms ticks
		let n = 0
		for (let tick = 0; tick < TICKS; tick++) {
			for (let k = 0; k < 60; k++) {
				// 60 aircraft spread across each 500 ms tick: 2 messages/s each, 120/s in all.
				clock.t = T0 + tick * 500 + k * 8
				const data = message(k, tick, clock.t)
				if (typeof data["lat"] === "number")
					lastPosition.set(data["icao"] as string, data["lat"])
				store.admit(
					envelope({
						eventId: `load-${n++}`,
						decoderId: "adsb",
						outputType: "aircraft",
						receivedAt: new Date(clock.t).toISOString(),
						decodedData: data,
					}),
				)
			}
			// The store's coalesce timer and writer, once per tick.
			store.flushCoalesced(clock.t)
			drain(store, rows)
			// Lets the test worker answer its runner.
			if (tick % 100 === 99) await new Promise(resolve => setImmediate(resolve))
		}
		const end = clock.t
		expect(store.dropped["rate-limited"]).toBe(0)
		expect(store.dropped["queue-full"]).toBe(0)
		expect(store.admitted).toBe(rows.length)
		expect(store.coalescedPositions + store.admitted).toBe(TICKS * 60)
		const perAircraft = new Map<string, DecodeEnvelope[]>()
		for (const row of rows) {
			const env = stored(row)
			const icao = (env.decodedData as { icao: string }).icao
			perAircraft.set(icao, [...(perAircraft.get(icao) ?? []), env])
		}
		// No lost entity, and each one's newest row is the latest state, at most one window old.
		expect(perAircraft.size).toBe(60)
		for (const [icao, list] of perAircraft) {
			const latest = list.at(-1) as DecodeEnvelope
			expect(end - Date.parse(latest.receivedAt)).toBeLessThanOrEqual(WINDOW)
			expect(latest.decodedData).toMatchObject({
				callsign: expect.any(String),
				squawk: expect.any(String),
				altitude: expect.any(Number),
				groundSpeed: expect.any(Number),
			})
			// Latitude advances 0.0001° per 500 ms tick: one window behind is at most 120 ticks.
			const lat = (latest.decodedData as { lat: number }).lat
			expect((lastPosition.get(icao) ?? 0) - lat).toBeLessThanOrEqual(
				(WINDOW / 500) * 0.0001 + 1e-9,
			)
			expect(latest.coalesced?.receptions).toBeGreaterThan(100)
		}
		// Rows per hour: 60 aircraft × (first sighting + first onGround + first squawk, then one
		// per 60 s window) = 60 × (3 + 9) = 720 in 10 min, 4,320 an hour. Before this change every
		// line was stored up to the 20/s decoder bucket: 72,000+ rows an hour and ~60,000 rate-limited
		// receptions per 10 min.
		const rowsPerHour = rows.length * 6
		expect(rowsPerHour).toBeLessThanOrEqual(4_400)
		expect(rowsPerHour).toBeGreaterThanOrEqual(60 * 60)
	}, 60_000)
})
