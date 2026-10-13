/**
 * APRS tracker: merge, dedupe, kill, expiry, cap and hostile payloads.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { AprsStation } from "@wavekit/api-types"
import { AprsTracker } from "../../../src/core/aprs-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

function tracker(config: ConstructorParameters<typeof AprsTracker>[0] = {}) {
	return new AprsTracker(config, logger)
}

function packet(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		timestamp: new Date("2026-06-15T12:00:00.000Z"),
		source: "N0CALL",
		destination: "APRS",
		path: ["WIDE1-1"],
		dataType: "Position",
		lat: 40.5,
		lon: -74.25,
		symbol: "/>",
		comment: "alpha",
		raw: "!alpha",
		...overrides,
	}
}

describe("AprsTracker", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("merges fields and never clears one the report does not carry", () => {
		const aprs = tracker()
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:05:00.000Z")
		aprs.processAprs(
			"direwolf-1",
			packet({
				altitude: 1200,
				course: 90,
				speed: 36,
				comment: "first",
				raw: "!first",
			}),
			t0,
		)
		aprs.processAprs(
			"direwolf-2",
			packet({
				lat: 41,
				lon: -75,
				comment: "second",
				raw: "!second",
				altitude: 1_000_000_000,
				course: 360,
				speed: -5,
				symbol: "A",
			}),
			t1,
		)

		const state = aprs.get("callsign:N0CALL")
		expect(state).toMatchObject({
			key: "callsign:N0CALL",
			kind: "station",
			callsign: "N0CALL",
			name: null,
			altitudeFt: 1200,
			courseDeg: 90,
			speedKn: 36,
			symbol: "/>",
			comment: "second",
			status: null,
			decoderId: "direwolf-2",
			packetCount: 2,
			digipeatedCopies: 0,
			killed: false,
			firstSeen: t0.toISOString(),
			lastSeen: t1.toISOString(),
			lastDataType: "Position",
			path: ["WIDE1-1"],
		})
		expect(state?.position).toEqual({
			lat: 41,
			lon: -75,
			at: t1.toISOString(),
		})
	})

	it("uses the report time for position at, not the payload timestamp", () => {
		const aprs = tracker({ now: () => Date.parse("2026-06-15T13:00:00.000Z") })
		aprs.processAprs(
			"d",
			packet({ timestamp: "2026-06-15T12:00:00.000Z" }),
			new Date("2026-06-15T12:30:00.000Z"),
		)
		expect(aprs.get("callsign:N0CALL")?.position?.at).toBe(
			"2026-06-15T12:30:00.000Z",
		)
	})

	it("folds callsign case, omits SSID -0 and keys objects by trimmed name", () => {
		const aprs = tracker()
		aprs.processAprs(
			"d",
			packet({ source: "n0call-0", raw: "!a" }),
			new Date("2026-06-15T12:00:00.000Z"),
		)
		aprs.processAprs(
			"d",
			packet({
				source: "w1aw-9",
				dataType: "Object",
				objectName: "MEETING  ",
				objectKind: "object",
				objectKilled: false,
				raw: ";live",
			}),
			new Date("2026-06-15T12:01:00.000Z"),
		)
		aprs.processAprs(
			"d",
			packet({
				source: "K1ABC",
				dataType: "Item",
				objectName: "AID#4",
				objectKind: "item",
				objectKilled: false,
				raw: ")live",
			}),
			new Date("2026-06-15T12:02:00.000Z"),
		)

		expect(aprs.get("callsign:N0CALL")?.callsign).toBe("N0CALL")
		expect(aprs.get("aprs-object:MEETING")).toMatchObject({
			kind: "object",
			name: "MEETING",
			callsign: "W1AW-9",
		})
		expect(aprs.get("aprs-item:AID#4")).toMatchObject({
			kind: "item",
			name: "AID#4",
			callsign: "K1ABC",
		})
		expect(aprs.getAll().map(station => station.key)).toEqual([
			"aprs-item:AID#4",
			"aprs-object:MEETING",
			"callsign:N0CALL",
		])
	})

	it("sets status and weather without clearing position, and ignores message content", () => {
		const aprs = tracker()
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:01:00.000Z")
		const t2 = new Date("2026-06-15T12:02:00.000Z")
		const t3 = new Date("2026-06-15T12:03:00.000Z")
		aprs.processAprs("d", packet({ comment: "place", raw: "!p" }), t0)
		aprs.processAprs(
			"d",
			packet({
				dataType: "Status",
				comment: "En route",
				lat: 1,
				lon: 2,
				raw: ">En route",
			}),
			t1,
		)
		aprs.processAprs(
			"d",
			packet({
				dataType: "Positionless weather",
				comment: undefined,
				lat: undefined,
				lon: undefined,
				raw: "_wx1",
				weather: {
					temperature: 72,
					humidity: 40,
					pressure: 1013.2,
					windDirection: 180,
				},
			}),
			t2,
		)
		aprs.processAprs(
			"d",
			packet({
				dataType: "Positionless weather",
				comment: undefined,
				lat: undefined,
				lon: undefined,
				raw: "_wx2",
				weather: { windSpeed: 12, rainfall: 0.2, temperature: 10_000 },
			}),
			t3,
		)
		aprs.processAprs(
			"d",
			packet({
				dataType: "Message",
				comment: "hello",
				lat: 9,
				lon: 9,
				symbol: "/a",
				raw: ":msg",
			}),
			new Date("2026-06-15T12:04:00.000Z"),
		)

		const state = aprs.get("callsign:N0CALL")
		expect(state?.status).toBe("En route")
		expect(state?.comment).toBe("place")
		expect(state?.position).toEqual({ lat: 1, lon: 2, at: t1.toISOString() })
		expect(state?.symbol).toBe("/>")
		expect(state?.weather).toEqual({
			temperatureF: 72,
			humidityPct: 40,
			pressureMbar: 1013.2,
			windSpeedMph: 12,
			windDirectionDeg: 180,
			rainLastHourIn: 0.2,
			at: t3.toISOString(),
		})
		expect(state?.lastDataType).toBe("Message")
		expect(state?.packetCount).toBe(5)
	})

	it("counts a digipeat and emits nothing, then accepts the packet after 30 s", () => {
		const aprs = tracker()
		const events: string[] = []
		aprs.on("aprs:new", () => {
			events.push("new")
		})
		aprs.on("aprs:update", () => {
			events.push("update")
		})
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		aprs.processAprs("d", packet({ comment: "place" }), t0)
		const before = structuredClone(aprs.get("callsign:N0CALL"))
		aprs.processAprs(
			"d",
			packet({ comment: "changed", lat: 1, lon: 2 }),
			new Date(t0.getTime() + 29_999),
		)
		expect(events).toEqual(["new"])
		expect(aprs.get("callsign:N0CALL")).toEqual({
			...before,
			digipeatedCopies: 1,
		})
		expect(aprs.getStats().duplicatesDropped).toBe(1)
		expect(aprs.getStats().packetsProcessed).toBe(2)
		expect(aprs.getStats().lastPacketAt).toBe(
			new Date(t0.getTime() + 29_999).toISOString(),
		)

		aprs.processAprs(
			"d",
			packet({ comment: "later" }),
			new Date(t0.getTime() + 30_000),
		)
		expect(aprs.get("callsign:N0CALL")).toMatchObject({
			comment: "later",
			packetCount: 2,
			digipeatedCopies: 1,
			lastSeen: new Date(t0.getTime() + 30_000).toISOString(),
		})
		expect(events).toEqual(["new", "update"])
	})

	it("does not dedupe packets that omit raw", () => {
		const aprs = tracker()
		const body = packet()
		delete body["raw"]
		aprs.processAprs("d", body, new Date("2026-06-15T12:00:00.000Z"))
		aprs.processAprs("d", body, new Date("2026-06-15T12:00:01.000Z"))
		expect(aprs.get("callsign:N0CALL")?.packetCount).toBe(2)
		expect(aprs.getStats().duplicatesDropped).toBe(0)
	})

	it("forgets the oldest digipeat key past 4096", () => {
		const aprs = tracker()
		const t0 = Date.parse("2026-06-15T12:00:00.000Z")
		for (let i = 0; i < 4096; i++) {
			aprs.processAprs(
				"d",
				packet({
					raw: `k${i}`,
					comment: undefined,
					lat: undefined,
					lon: undefined,
				}),
				new Date(t0 + i),
			)
		}
		aprs.processAprs("d", packet({ raw: "k0" }), new Date(t0 + 10_000))
		expect(aprs.get("callsign:N0CALL")).toMatchObject({
			packetCount: 4096,
			digipeatedCopies: 1,
		})
		aprs.processAprs("d", packet({ raw: "k4096" }), new Date(t0 + 10_001))
		aprs.processAprs("d", packet({ raw: "k0" }), new Date(t0 + 10_002))
		expect(aprs.get("callsign:N0CALL")?.packetCount).toBe(4098)
		aprs.processAprs("d", packet({ raw: "k4096" }), new Date(t0 + 10_003))
		expect(aprs.get("callsign:N0CALL")).toMatchObject({
			packetCount: 4098,
			digipeatedCopies: 2,
		})
		expect(aprs.getStats().duplicatesDropped).toBe(2)
		expect(aprs.getAll()).toHaveLength(1)
	})

	it("removes a killed object without merging the kill, then can hear it again", () => {
		const aprs = tracker()
		const created: AprsStation[] = []
		const lost: AprsStation[] = []
		aprs.on("aprs:new", station => {
			created.push(station)
		})
		aprs.on("aprs:lost", (_key, station) => {
			lost.push(station)
		})
		const t0 = new Date("2026-06-15T12:00:00.000Z")
		const t1 = new Date("2026-06-15T12:05:00.000Z")
		aprs.processAprs(
			"d",
			packet({
				source: "W1AW",
				dataType: "Object",
				objectName: "MEETING",
				objectKind: "object",
				objectKilled: false,
				comment: "club",
				raw: ";live",
			}),
			t0,
		)
		aprs.processAprs(
			"d",
			packet({
				source: "K1ABC",
				dataType: "Object",
				objectName: "MEETING",
				objectKind: "object",
				objectKilled: true,
				comment: "gone",
				lat: 1,
				lon: 2,
				raw: ";kill",
			}),
			t1,
		)
		expect(aprs.get("aprs-object:MEETING")).toBeUndefined()
		expect(lost).toHaveLength(1)
		expect(lost[0]).toMatchObject({
			key: "aprs-object:MEETING",
			killed: true,
			comment: "club",
			callsign: "W1AW",
			packetCount: 1,
			lastSeen: t0.toISOString(),
		})
		expect(lost[0]?.position).toEqual({
			lat: 40.5,
			lon: -74.25,
			at: t0.toISOString(),
		})
		expect(created[0]?.killed).toBe(false)
		expect(created[0]).not.toBe(lost[0])
		expect(aprs.getStats().expiredTotal).toBe(0)

		aprs.processAprs(
			"d",
			packet({
				dataType: "Object",
				objectName: "MEETING",
				objectKind: "object",
				objectKilled: false,
				raw: ";again",
			}),
			new Date("2026-06-15T12:10:00.000Z"),
		)
		expect(aprs.get("aprs-object:MEETING")).toMatchObject({
			packetCount: 1,
			killed: false,
			firstSeen: "2026-06-15T12:10:00.000Z",
		})
	})

	it("does not emit lost when a kill names an unknown object", () => {
		const aprs = tracker()
		const lost: string[] = []
		aprs.on("aprs:lost", key => {
			lost.push(key)
		})
		aprs.processAprs(
			"d",
			packet({
				dataType: "Item",
				objectName: "AID4",
				objectKind: "item",
				objectKilled: true,
				raw: ")kill",
			}),
		)
		expect(lost).toEqual([])
		expect(aprs.getAll()).toHaveLength(0)
		expect(aprs.getStats().invalidPackets).toBe(0)
		expect(aprs.getStats().packetsProcessed).toBe(1)
	})

	it("expires entities older than the default 2 h and counts only those", () => {
		vi.useFakeTimers()
		let clock = 0
		const aprs = tracker({ now: () => clock, statsIntervalMs: 60_000 })
		const lost: Array<{ key: string; killed: boolean }> = []
		aprs.on("aprs:lost", (key, station) => {
			lost.push({ key, killed: station.killed })
		})
		aprs.processAprs("d", packet({ raw: "a" }), new Date(0))
		aprs.processAprs("d", packet({ source: "W1AW", raw: "b" }), new Date(500))
		aprs.start()
		clock = 7_200_000
		vi.advanceTimersByTime(30_000)
		expect(lost).toEqual([])
		expect(aprs.getAll()).toHaveLength(2)
		clock = 7_200_001
		vi.advanceTimersByTime(30_000)
		expect(lost).toEqual([{ key: "callsign:N0CALL", killed: false }])
		expect(aprs.get("callsign:N0CALL")).toBeUndefined()
		expect(aprs.getStats().expiredTotal).toBe(1)
		aprs.stop()
	})

	it("evicts the least recently heard entity at the default cap of 2000", () => {
		const aprs = tracker()
		const lost: string[] = []
		aprs.on("aprs:lost", key => {
			lost.push(key)
		})
		for (let i = 0; i < 2000; i++) {
			const call = `N${i.toString(36).toUpperCase().padStart(4, "0")}`
			aprs.processAprs(
				"d",
				packet({
					source: call,
					raw: `r${i}`,
					lat: undefined,
					lon: undefined,
					comment: undefined,
				}),
				new Date(i),
			)
		}
		expect(aprs.getAll()).toHaveLength(2000)
		const newest = `N${(2000).toString(36).toUpperCase().padStart(4, "0")}`
		aprs.processAprs(
			"d",
			packet({ source: newest, raw: "newest", lat: undefined, lon: undefined }),
			new Date(2000),
		)
		expect(lost).toEqual(["callsign:N0000"])
		expect(aprs.getAll()).toHaveLength(2000)
		expect(aprs.get("callsign:N0000")).toBeUndefined()
		expect(aprs.get(`callsign:${newest}`)?.callsign).toBe(newest)
		expect(aprs.getStats().expiredTotal).toBe(0)
	})

	it("breaks a lastSeen tie by earlier processing order when evicting", () => {
		const aprs = tracker({ maxStations: 2 })
		const lost: string[] = []
		aprs.on("aprs:lost", key => {
			lost.push(key)
		})
		const when = new Date("2026-06-15T12:00:00.000Z")
		aprs.processAprs("d", packet({ source: "W1AW", raw: "a" }), when)
		aprs.processAprs("d", packet({ source: "N0CALL", raw: "b" }), when)
		aprs.processAprs(
			"d",
			packet({ source: "K1ABC", raw: "c" }),
			new Date("2026-06-15T12:05:00.000Z"),
		)
		expect(lost).toEqual(["callsign:W1AW"])
		expect(aprs.getStats().latestKey).toBe("callsign:K1ABC")
		expect(aprs.getAll()[0]?.key).toBe("callsign:K1ABC")
	})

	it("reports a rolling 60 s rate of unique packets and emits stats once per interval", () => {
		vi.useFakeTimers()
		let clock = 1_000
		const aprs = tracker({
			now: () => clock,
			cleanupIntervalMs: 60_000,
		})
		const statsEvents: number[] = []
		aprs.on("stats:update", stats => {
			statsEvents.push(stats.packetsProcessed)
		})
		aprs.processAprs("d", packet(), new Date(clock))
		aprs.processAprs("d", packet(), new Date(clock + 1))
		expect(aprs.getStats().packetsPerSecond).toBeCloseTo(1 / 60)
		expect(aprs.getStats().byKind).toEqual({ station: 1, object: 0, item: 0 })
		clock = 62_000
		expect(aprs.getStats().packetsPerSecond).toBe(0)
		aprs.start()
		aprs.start()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([2])
		aprs.stop()
		aprs.stop()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([2])
	})

	it("counts malformed payloads as invalid and does not throw or clear state", () => {
		const aprs = tracker()
		aprs.processAprs(
			"d",
			packet({ raw: "good" }),
			new Date("2026-06-15T12:00:00.000Z"),
		)
		const before = structuredClone(aprs.get("callsign:N0CALL"))
		const bad: unknown[] = [
			null,
			[],
			"packet",
			{ destination: "APRS", dataType: "Position", timestamp: new Date() },
			packet({ lat: Number.NaN }),
			packet({ lat: "north" }),
			packet({ lon: Number.POSITIVE_INFINITY }),
			packet({ comment: "A".repeat(10_000) }),
			packet({ raw: "R".repeat(10_000) }),
			packet({ timestamp: 1_700_000_000_000 }),
			packet({ path: "WIDE1-1" }),
			packet({ source: "\u0000" }),
			packet({
				dataType: "Object",
				objectName: "A:B",
				objectKind: "object",
				raw: ";colon",
			}),
			packet({
				dataType: "Object",
				objectName: "A\u0000B",
				objectKind: "object",
				raw: ";ctrl",
			}),
			packet({ symbol: "S".repeat(10), raw: "sym" }),
			packet({ altitude: "high", raw: "alt" }),
		]
		for (const data of bad) {
			expect(() => aprs.processAprs("d", data)).not.toThrow()
		}
		expect(aprs.get("callsign:N0CALL")).toEqual(before)
		expect(aprs.getAll()).toHaveLength(1)
		expect(aprs.getStats().invalidPackets).toBe(bad.length)
		expect(aprs.getStats().packetsProcessed).toBe(1 + bad.length)
		expect(aprs.get("aprs-object:A:B")).toBeUndefined()
	})

	it("strips controls from a comment and still tracks the station", () => {
		const aprs = tracker()
		aprs.processAprs("d", packet({ comment: "hel\u0001lo", raw: "!c" }))
		expect(aprs.get("callsign:N0CALL")?.comment).toBe("hello")
	})
})
