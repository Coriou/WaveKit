import { describe, expect, it } from "vitest"
import type { JsonValue } from "../../../../../src/core/activity/types.js"
import { ActivityIngress } from "../../../../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import {
	APRS_POSITION_DATA_TYPES,
	COALESCE_SPECS,
	isCoalescibleShape,
	PositionCoalescer,
} from "../../../../../src/core/activity/storage/coalesce.js"
import { envelope, logger } from "./helpers.js"

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()

function requireSpec(type: string) {
	const spec = COALESCE_SPECS[type]
	expect(spec).toBeDefined()
	if (!spec) throw new Error(`missing ${type} spec`)
	return spec
}

function offer(
	c: PositionCoalescer,
	env: ReturnType<typeof envelope>,
): boolean {
	const decision = c.decide(env)
	if (decision.store) decision.commit()
	return decision.store
}

function aprs(at: number, data: JsonValue, decoderId = "direwolf") {
	return envelope({
		decoderId,
		outputType: "aprs",
		receivedAt: iso(at),
		decodedData: data,
	})
}

function mesh(at: number, data: JsonValue, decoderId = "lora") {
	return envelope({
		decoderId,
		outputType: "meshtastic",
		receivedAt: iso(at),
		decodedData: data,
	})
}

const POSITION = {
	source: "N0CALL",
	destination: "APRS",
	path: ["WIDE1-1"],
	dataType: "Position",
	lat: 51,
	lon: 4,
	altitude: 10,
	course: 90,
	speed: 12,
	raw: "!pos",
	timestamp: iso(T0),
}

describe("APRS and mesh coalescing specs", () => {
	it("locks the requirement 2 allowlists and the unchanged WG1 sets", () => {
		expect([...APRS_POSITION_DATA_TYPES].sort()).toEqual(
			[
				"Mic-E",
				"Mic-E (old)",
				"Position",
				"Position with messaging",
				"Position with timestamp",
				"Position with timestamp and messaging",
			].sort(),
		)
		const aprsSpec = requireSpec("aprs")
		expect(aprsSpec.entity).toBe("source")
		expect([...aprsSpec.identity].sort()).toEqual(["comment", "symbol"])
		expect([...aprsSpec.redundant].sort()).toEqual(
			[
				"altitude",
				"course",
				"dataType",
				"destination",
				"lat",
				"lon",
				"path",
				"raw",
				"source",
				"speed",
				"timestamp",
			].sort(),
		)
		const meshSpec = requireSpec("meshtastic")
		expect(meshSpec.entity).toBe("from")
		expect([...meshSpec.identity]).toEqual([])
		expect([...meshSpec.redundant].sort()).toEqual(
			[
				"bw",
				"channel",
				"cr",
				"frequency",
				"from",
				"hopLimit",
				"hopStart",
				"id",
				"payloadB64",
				"payloadLen",
				"portnum",
				"priority",
				"rxRssi",
				"rxSnr",
				"rxTime",
				"sf",
				"to",
				"viaMqtt",
				"wantAck",
			].sort(),
		)
		const aircraft = requireSpec("aircraft")
		expect(aircraft.entity).toBe("icao")
		expect([...aircraft.identity].sort()).toEqual(
			[
				"callsign",
				"category",
				"emergency",
				"flight",
				"ground",
				"onGround",
				"squawk",
			].sort(),
		)
		expect([...aircraft.redundant].sort()).toEqual(
			[
				"alt_baro",
				"alt_geom",
				"altitude",
				"baro_rate",
				"geom_rate",
				"groundSpeed",
				"gs",
				"heading",
				"hex",
				"icao",
				"lastSeen",
				"lat",
				"lon",
				"mag_heading",
				"messageCount",
				"messages",
				"rssi",
				"seen",
				"seen_pos",
				"signal",
				"timestamp",
				"track",
				"true_heading",
				"verticalRate",
			].sort(),
		)
		const ship = requireSpec("ship")
		expect(ship.entity).toBe("mmsi")
		expect([...ship.identity].sort()).toEqual(
			[
				"callsign",
				"destination",
				"draught",
				"eta",
				"imo",
				"name",
				"navStatus",
				"shipType",
			].sort(),
		)
		expect([...ship.redundant].sort()).toEqual(
			[
				"cog",
				"heading",
				"lastSeen",
				"lat",
				"lon",
				"messageType",
				"mmsi",
				"sog",
				"timestamp",
			].sort(),
		)
	})

	it("coalesces a redundant APRS or mesh position and stores everything else", () => {
		const c = new PositionCoalescer(60_000, 100)
		expect(offer(c, aprs(T0, POSITION))).toBe(true)
		expect(offer(c, aprs(T0 + 1_000, POSITION))).toBe(false)
		expect(offer(c, aprs(T0 + 59_999, { ...POSITION, symbol: "/" }))).toBe(true)
		expect(offer(c, aprs(T0 + 60_000, { ...POSITION, symbol: "/" }))).toBe(
			false,
		)
		expect(
			offer(
				c,
				aprs(T0 + 61_000, { ...POSITION, symbol: "/", comment: "parked" }),
			),
		).toBe(true)
		expect(
			offer(
				c,
				aprs(T0 + 62_000, { ...POSITION, symbol: "/", comment: "parked" }),
			),
		).toBe(false)
		expect(
			offer(c, aprs(T0 + 63_000, { ...POSITION, comment: null, symbol: "/" })),
		).toBe(false)
		expect(
			offer(
				c,
				aprs(T0 + 64_000, {
					...POSITION,
					symbol: "/",
					weather: { temperature: 70 },
				}),
			),
		).toBe(true)
		expect(
			offer(
				c,
				aprs(T0 + 65_000, {
					source: "N0CALL",
					dataType: "Status",
					status: "on duty",
				}),
			),
		).toBe(true)
		expect(
			offer(c, aprs(T0 + 66_000, { source: "N0CALL", dataType: "Position" })),
		).toBe(true)
		expect(
			offer(c, aprs(T0 + 67_000, { ...POSITION, source: "N0CALL-0" })),
		).toBe(true)
		expect(offer(c, aprs(T0 + 68_000, { ...POSITION, source: "abc" }))).toBe(
			true,
		)
		expect(offer(c, aprs(T0 + 69_000, { ...POSITION, source: "ABC" }))).toBe(
			true,
		)
		expect(offer(c, aprs(T0 + 70_000, POSITION, "other-decoder"))).toBe(true)
		// The ineligible position at +66s refreshed this entity's window.
		expect(offer(c, aprs(T0 + 125_999, POSITION))).toBe(false)
		expect(offer(c, aprs(T0 + 126_000, POSITION))).toBe(true)
		expect(offer(c, aprs(T0 + 125_000, POSITION))).toBe(true)

		const node = {
			from: 42,
			to: 1,
			portnum: 3,
			payloadB64: "AA==",
			rxRssi: -90,
		}
		expect(offer(c, mesh(T0, node))).toBe(true)
		expect(offer(c, mesh(T0 + 1_000, node))).toBe(false)
		expect(offer(c, mesh(T0 + 2_000, { ...node, portnum: 1 }))).toBe(true)
		expect(offer(c, mesh(T0 + 3_000, { ...node, lat: 51, lon: 4 }))).toBe(true)
		// The text and located packets above refreshed this node's window.
		expect(offer(c, mesh(T0 + 60_000, node))).toBe(false)
		expect(offer(c, mesh(T0 + 63_000, node))).toBe(true)
		expect(offer(c, mesh(T0 + 4_000, { ...node, from: 43 }))).toBe(true)
	})

	it("shares the entity bound across aircraft, APRS and mesh", () => {
		const c = new PositionCoalescer(60_000, 2)
		expect(
			offer(
				c,
				envelope({
					outputType: "aircraft",
					receivedAt: iso(T0),
					decodedData: { icao: "abc123", lat: 1, lon: 2 },
				}),
			),
		).toBe(true)
		expect(offer(c, aprs(T0 + 1, POSITION))).toBe(true)
		expect(c.size()).toBe(2)
		expect(offer(c, mesh(T0 + 2, { from: 7, portnum: 3 }))).toBe(true)
		expect(c.size()).toBe(2)
		expect(
			offer(
				c,
				envelope({
					outputType: "aircraft",
					receivedAt: iso(T0 + 3),
					decodedData: { icao: "abc123", lat: 1, lon: 2 },
				}),
			),
		).toBe(true)
	})

	it("treats a coalescible shape as redundant and a present identity as full", () => {
		expect(
			isCoalescibleShape("aircraft", {
				icao: "abc123",
				lat: 1,
				lon: 2,
				nope: null,
			}),
		).toBe(true)
		expect(
			isCoalescibleShape("aircraft", {
				icao: "abc123",
				lat: 1,
				lon: 2,
				nope: undefined,
			}),
		).toBe(false)
		expect(
			isCoalescibleShape("aircraft", { icao: "abc123", callsign: "UAL1" }),
		).toBe(false)
		expect(
			isCoalescibleShape("ship", { mmsi: "1", messageType: 1, lat: 1, lon: 2 }),
		).toBe(true)
		expect(
			isCoalescibleShape("ship", { mmsi: "1", messageType: 5, lat: 1, lon: 2 }),
		).toBe(false)
		expect(isCoalescibleShape("aprs", POSITION)).toBe(true)
		expect(isCoalescibleShape("aprs", { ...POSITION, symbol: "/" })).toBe(false)
		expect(isCoalescibleShape("aprs", { ...POSITION, weather: {} })).toBe(false)
		expect(isCoalescibleShape("meshtastic", { from: 1, portnum: 3 })).toBe(true)
		expect(isCoalescibleShape("meshtastic", { from: 1, portnum: 1 })).toBe(
			false,
		)
		expect(
			isCoalescibleShape("meshtastic", { from: 1, portnum: 3, lat: 1 }),
		).toBe(false)
		expect(isCoalescibleShape("page", { capcode: 1 })).toBe(false)
	})

	it("rolls an APRS entity back newest first when the write is nacked", () => {
		const ingress = new ActivityIngress(
			resolveActivityLimits({
				globalRatePerSec: 1_000_000,
				globalBurst: 1_000_000,
				decoderBurst: 1_000_000,
				decoderRatePerSec: 100_000,
			}),
			() => T0,
			logger,
		)
		const row = (eventId: string, ms: number, extra: Record<string, unknown>) =>
			envelope({
				eventId,
				decoderId: "direwolf",
				outputType: "aprs",
				receivedAt: iso(T0 + ms),
				decodedData: { ...POSITION, ...extra },
			})
		expect(ingress.admit(row("a1", 0, { symbol: "/" })).admitted).toBe(true)
		expect(
			ingress.admit(row("a2", 1_000, { symbol: "/", comment: "one" })).admitted,
		).toBe(true)
		expect(
			ingress.takeBatch(64, 1 << 20).map(record => record.eventId),
		).toEqual(["a1", "a2"])
		ingress.nack()
		expect(ingress.admit(row("r1", 2_000, { symbol: "/" })).admitted).toBe(true)
		expect(
			ingress.admit(row("r2", 3_000, { symbol: "/", comment: "one" })).admitted,
		).toBe(true)
	})
})
