/**
 * Vessel tracker examples: merge, class, expiry, cap, stats, JSON fixtures.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { VesselClass } from "@wavekit/api-types"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { parseJsonShip } from "../../../src/decoders/builtin/ais-catcher.js"
import { createLogger } from "../../../src/utils/logger.js"
import { loadJsonSample } from "../../mocks/fixtures/ais/index.js"

const logger = createLogger({ level: "error" })

function tracker(config: ConstructorParameters<typeof VesselTracker>[0] = {}) {
	return new VesselTracker(config, logger)
}

describe("VesselTracker", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("merges fields and never clears one the report does not carry", () => {
		const vessels = tracker()
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:05:00.000Z")
		vessels.processShip(
			"ais-1",
			{
				mmsi: "123456789",
				messageType: 1,
				lat: 40.7128,
				lon: -74.006,
				cog: 180.5,
				sog: 12.3,
				heading: 179,
				navStatus: 0,
				name: "EVER GIVEN@@@",
			},
			t0,
		)
		vessels.processShip(
			"ais-2",
			{
				mmsi: 123456789,
				messageType: 5,
				callsign: "H3RC",
				shipType: 70,
				destination: "  NEW YORK  ",
				imo: 9811000,
				draught: 14.5,
				eta: "2026-01-15T14:00:00Z",
				lat: 91,
				lon: 181,
				cog: 360,
				sog: 102.3,
				heading: 511,
				navStatus: 15,
				name: "@@@",
			},
			t1,
		)

		const state = vessels.get("123456789")
		expect(state).toMatchObject({
			mmsi: "123456789",
			name: "EVER GIVEN",
			callsign: "H3RC",
			imo: 9811000,
			shipType: 70,
			destination: "NEW YORK",
			eta: "2026-01-15T14:00:00.000Z",
			draught: 14.5,
			cog: 180.5,
			sog: 12.3,
			heading: 179,
			navStatus: 0,
			messageTypes: [1, 5],
			messageCount: 2,
			decoderId: "ais-2",
			vesselClass: "A",
			firstSeen: t0.toISOString(),
			lastSeen: t1.toISOString(),
			lastStaticAt: t1.toISOString(),
		})
		expect(state?.position).toEqual({
			lat: 40.7128,
			lon: -74.006,
			at: t0.toISOString(),
		})
	})

	it("derives class from the types seen, first match in the design order", () => {
		const cases: Array<{
			types: number[]
			vesselClass: VesselClass
			name?: string
		}> = [
			{ types: [1], vesselClass: "A" },
			{ types: [2, 3], vesselClass: "A" },
			{ types: [5], vesselClass: "A" },
			{ types: [18], vesselClass: "B" },
			{ types: [19], vesselClass: "B" },
			{ types: [24], vesselClass: "B" },
			{ types: [1, 18], vesselClass: "B" },
			{ types: [5, 24], vesselClass: "B" },
			{ types: [4], vesselClass: "base-station" },
			{ types: [11, 1], vesselClass: "base-station" },
			{ types: [21], vesselClass: "aton", name: "BUOY" },
			{ types: [21, 18], vesselClass: "aton", name: "BUOY" },
			{ types: [9], vesselClass: "sar" },
			{ types: [9, 1], vesselClass: "sar" },
			{ types: [27], vesselClass: "unknown" },
		]
		for (const [index, entry] of cases.entries()) {
			const vessels = tracker()
			for (const messageType of entry.types) {
				vessels.processShip("ais", {
					mmsi: String(index + 1),
					messageType,
					...(entry.name ? { name: entry.name } : {}),
				})
			}
			expect(vessels.get(String(index + 1))?.vesselClass).toBe(
				entry.vesselClass,
			)
		}
	})

	it("sets lastStaticAt for types 5, 19, 24 and for type 21 only with a name", () => {
		const vessels = tracker()
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:01:00.000Z")
		const t2 = new Date("2026-06-15T12:02:00.000Z")
		vessels.processShip("ais", { mmsi: "1", messageType: 21 }, t0)
		expect(vessels.get("1")?.lastStaticAt).toBeNull()
		vessels.processShip(
			"ais",
			{ mmsi: "1", messageType: 21, name: "AMBROSE LIGHT" },
			t1,
		)
		expect(vessels.get("1")?.lastStaticAt).toBe(t1.toISOString())
		vessels.processShip(
			"ais",
			{ mmsi: "1", messageType: 21, name: " @@@ " },
			new Date("2026-06-15T12:03:00.000Z"),
		)
		expect(vessels.get("1")?.name).toBe("AMBROSE LIGHT")
		expect(vessels.get("1")?.lastStaticAt).toBe(t1.toISOString())
		vessels.processShip(
			"ais",
			{ mmsi: "2", messageType: 24, callsign: "KC1234" },
			t2,
		)
		expect(vessels.get("2")?.lastStaticAt).toBe(t2.toISOString())
		expect(vessels.get("2")?.vesselClass).toBe("B")
	})

	it("counts invalid reports and does not throw", () => {
		const vessels = tracker()
		vessels.processShip("ais", null)
		vessels.processShip("ais", { name: "NO MMSI" })
		vessels.processShip("ais", { mmsi: "1234567890", messageType: 1 })
		vessels.processShip("ais", { mmsi: "abc", messageType: 1 })
		vessels.processShip("ais", { mmsi: "123", messageType: 1.5 })
		vessels.processShip("ais", {
			mmsi: "123",
			messageType: 1,
			lat: Number.POSITIVE_INFINITY,
		})
		expect(vessels.getAll()).toHaveLength(0)
		expect(vessels.getStats().messagesProcessed).toBe(6)
		expect(vessels.getStats().vesselCount).toBe(0)
		expect(vessels.getStats().lastMessageAt).toBeNull()
	})

	it("zero-pads MMSIs and lists the newest report first", () => {
		const vessels = tracker()
		vessels.processShip(
			"ais",
			{ mmsi: "7", messageType: 1 },
			new Date("2026-06-15T12:00:00.000Z"),
		)
		vessels.processShip(
			"ais",
			{ mmsi: 8, messageType: 1 },
			new Date("2026-06-15T13:00:00.000Z"),
		)
		expect(vessels.get("7")?.mmsi).toBe("000000007")
		expect(vessels.getAll().map(state => state.mmsi)).toEqual([
			"000000008",
			"000000007",
		])
	})

	it("expires vessels older than maxAgeMs and counts them", () => {
		vi.useFakeTimers()
		let clock = 0
		const vessels = tracker({
			maxAgeMs: 1_000,
			cleanupIntervalMs: 100,
			statsIntervalMs: 60_000,
			now: () => clock,
		})
		const lost: string[] = []
		vessels.on("vessel:lost", mmsi => {
			lost.push(mmsi)
		})
		vessels.processShip("ais", { mmsi: "1", messageType: 1 }, new Date(0))
		vessels.processShip("ais", { mmsi: "2", messageType: 1 }, new Date(500))
		vessels.start()
		clock = 1_000
		vi.advanceTimersByTime(100)
		expect(lost).toEqual([])
		expect(vessels.getAll()).toHaveLength(2)
		clock = 1_001
		vi.advanceTimersByTime(100)
		expect(lost).toEqual(["000000001"])
		expect(vessels.get("1")).toBeUndefined()
		expect(vessels.getStats().expiredTotal).toBe(1)
		clock = 1_501
		vi.advanceTimersByTime(100)
		expect(lost).toEqual(["000000001", "000000002"])
		expect(vessels.getStats().latestMmsi).toBeNull()
		expect(vessels.getStats().lastMessageAt).toBe(new Date(500).toISOString())
		vessels.stop()
	})

	it("evicts the least recently heard vessel past the cap", () => {
		const vessels = tracker({ maxVessels: 2 })
		const lost: string[] = []
		vessels.on("vessel:lost", mmsi => {
			lost.push(mmsi)
		})
		vessels.processShip(
			"ais",
			{ mmsi: "1", messageType: 1 },
			new Date("2026-06-15T12:00:00.000Z"),
		)
		vessels.processShip(
			"ais",
			{ mmsi: "2", messageType: 1 },
			new Date("2026-06-15T12:01:00.000Z"),
		)
		vessels.processShip(
			"ais",
			{ mmsi: "3", messageType: 1 },
			new Date("2026-06-15T12:02:00.000Z"),
		)
		expect(lost).toEqual(["000000001"])
		expect(vessels.getAll().map(state => state.mmsi)).toEqual([
			"000000003",
			"000000002",
		])
		expect(vessels.getStats().expiredTotal).toBe(0)
	})

	it("breaks a lastSeen tie by the smaller MMSI when evicting", () => {
		const vessels = tracker({ maxVessels: 2 })
		const lost: string[] = []
		vessels.on("vessel:lost", mmsi => {
			lost.push(mmsi)
		})
		const when = new Date("2026-06-15T12:00:00.000Z")
		vessels.processShip("ais", { mmsi: "2", messageType: 1 }, when)
		vessels.processShip("ais", { mmsi: "1", messageType: 1 }, when)
		vessels.processShip(
			"ais",
			{ mmsi: "3", messageType: 1 },
			new Date("2026-06-15T12:05:00.000Z"),
		)
		expect(lost).toEqual(["000000001"])
	})

	it("reports a rolling 60 s rate and emits stats once per interval", () => {
		vi.useFakeTimers()
		let clock = 1_000
		const vessels = tracker({
			statsIntervalMs: 5_000,
			cleanupIntervalMs: 60_000,
			now: () => clock,
		})
		const statsEvents: number[] = []
		vessels.on("stats:update", stats => {
			statsEvents.push(stats.messagesProcessed)
		})
		vessels.processShip("ais", { mmsi: "1", messageType: 1 }, new Date(clock))
		expect(vessels.getStats().messagesPerSecond).toBeCloseTo(1 / 60)
		clock = 61_001
		expect(vessels.getStats().messagesPerSecond).toBe(0)
		vessels.start()
		vessels.start()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([1])
		vessels.stop()
		vessels.stop()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([1])
	})

	it("builds state from the JSON-mode fixtures", () => {
		const vessels = tracker()
		const samples = loadJsonSample()
		samples.forEach((sample, index) => {
			const ship = parseJsonShip(sample as unknown as Record<string, unknown>)
			expect(ship).not.toBeNull()
			vessels.processShip(
				"ais-json",
				ship,
				new Date(Date.UTC(2026, 5, 15, 12, index, 0)),
			)
		})
		expect(vessels.getAll()).toHaveLength(samples.length)
		const ever = vessels.get("123456789")
		expect(ever).toMatchObject({
			name: "EVER GIVEN",
			callsign: "H3RC",
			shipType: 70,
			imo: 9811000,
			vesselClass: "A",
			navStatus: 0,
			destination: "NEW YORK",
			draught: 14.5,
		})
		expect(ever?.position).toMatchObject({ lat: 40.7128, lon: -74.006 })
		expect(vessels.get("567890123")?.vesselClass).toBe("B")
		expect(vessels.get("567890123")?.lastStaticAt).toBeNull()
		expect(vessels.get("222345678")).toMatchObject({
			name: "AMBROSE LIGHT",
			vesselClass: "aton",
		})
		expect(vessels.get("222345678")?.lastStaticAt).not.toBeNull()
		expect(vessels.get("333456789")).toMatchObject({
			name: "FISHING KING",
			callsign: "KC1234",
			shipType: 30,
			vesselClass: "B",
		})
		expect(vessels.get("555678901")).toMatchObject({
			name: "ATLANTIC VOYAGER",
			callsign: "GBTT",
			destination: "SOUTHAMPTON",
			draught: 12.8,
			eta: "2026-01-15T14:00:00.000Z",
			vesselClass: "A",
		})
		expect(vessels.getAll()[0]?.mmsi).toBe("555678901")
		const stats = vessels.getStats()
		expect(stats.withName).toBe(samples.length)
		expect(stats.withPosition).toBe(
			samples.filter(sample => sample.lat !== undefined).length,
		)
		expect(stats.byClass.A + stats.byClass.B + stats.byClass.aton).toBe(
			samples.length,
		)
	})
})
