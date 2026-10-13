/**
 * Mesh tracker: merge, flood copies, bounds and failure paths (WG2 req 5).
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { MeshNode } from "@wavekit/api-types"
import {
	formatNodeId,
	MeshTracker,
	type MeshTrackerConfig,
} from "../../../src/core/mesh-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodePosition,
	encodeUser,
	meshPacket,
	type MeshPacketFixture,
} from "../../mocks/fixtures/meshtastic/encode.js"

const logger = createLogger({ level: "error" })
const AT = new Date("2026-06-15T12:00:00.000Z")

function tracker(config: MeshTrackerConfig = {}) {
	return new MeshTracker(config, logger)
}

function send(nodes: MeshTracker, fields: MeshPacketFixture, at: Date = AT) {
	nodes.processPacket("lora", meshPacket(fields), at)
}

function withoutCopies(node: MeshNode): Omit<MeshNode, "duplicateCopies"> {
	const { duplicateCopies: _copies, ...rest } = node
	return rest
}

describe("MeshTracker", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("keys nodes by from, never by to or the broadcast address", () => {
		const nodes = tracker()
		send(nodes, { from: 0x80000000, to: 2, id: 1, portnum: 1 })
		send(nodes, { from: 0xffffffff, to: 3, id: 2, portnum: 1 })
		expect(formatNodeId(0x80000000)).toBe("!80000000")
		expect(nodes.getAll().map(node => node.nodeId)).toEqual(["!80000000"])
		expect(nodes.get("!80000000")).toMatchObject({
			key: "node:!80000000",
			nodeNum: 0x80000000,
			decoderId: "lora",
		})
		expect(nodes.get("!00000002")).toBeUndefined()
		expect(nodes.get("!ffffffff")).toBeUndefined()
		expect(nodes.getStats().invalidPackets).toBe(1)
		expect(nodes.get("nope")).toBeUndefined()
		expect(nodes.get("!80000000".toUpperCase())?.nodeId).toBe("!80000000")
	})

	it("merges position and user, and a later zero radio reading clears snr and rssi", () => {
		const nodes = tracker()
		const events: string[] = []
		nodes.on("mesh:new", () => events.push("new"))
		nodes.on("mesh:update", () => events.push("update"))
		send(nodes, {
			from: 1,
			id: 1,
			portnum: 3,
			payload: encodePosition({
				latitudeI: 377_749_000,
				longitudeI: -1_224_194_000,
				altitudeM: 0,
				timeS: 1_700_000_000,
			}),
			rxSnr: 6.5,
			rxRssi: -70,
			hopStart: 3,
			hopLimit: 3,
			viaMqtt: true,
		})
		send(nodes, {
			from: 1,
			id: 2,
			portnum: 4,
			payload: encodeUser({
				id: "!00000001",
				longName: "Ada",
				shortName: "AD",
				hwModel: 0,
				isLicensed: false,
				role: 1,
			}),
			rxSnr: 0,
			rxRssi: 0,
			hopStart: 3,
			hopLimit: 1,
			viaMqtt: false,
		})
		const node = nodes.get("!00000001")
		expect(node).toMatchObject({
			longName: "Ada",
			shortName: "AD",
			hwModel: 0,
			isLicensed: false,
			role: 1,
			snrDb: null,
			rssiDbm: null,
			hopsAway: 2,
			viaMqtt: false,
			packetCount: 2,
			lastPortnum: 4,
			lastNodeInfoAt: AT.toISOString(),
			position: {
				lat: 37.7749,
				lon: -122.4194,
				altitudeM: 0,
				at: AT.toISOString(),
			},
			portnums: { "3": 1, "4": 1 },
		})
		expect(events).toEqual(["new", "update"])
		expect(nodes.getStats()).toMatchObject({
			nodeCount: 1,
			withPosition: 1,
			withName: 1,
			packetsProcessed: 2,
			duplicatesDropped: 0,
			invalidPackets: 0,
			decodeErrors: 0,
			latestNodeId: "!00000001",
			lastPacketAt: AT.toISOString(),
		})
	})

	it("counts a mismatched user id and does not clear names with an empty one", () => {
		const nodes = tracker()
		send(nodes, {
			from: 5,
			id: 1,
			portnum: 4,
			payload: encodeUser({
				id: "!00000005",
				longName: "Ada",
				shortName: "AD",
				hwModel: 4,
				role: 2,
				isLicensed: true,
			}),
		})
		const stamped = nodes.get("!00000005")?.lastNodeInfoAt
		send(nodes, {
			from: 5,
			id: 2,
			portnum: 4,
			payload: encodeUser({ id: "!00000006", longName: "Eve", hwModel: 9 }),
		})
		send(nodes, {
			from: 5,
			id: 4,
			portnum: 4,
			payload: encodeUser({
				id: "\uFEFF!00000005",
				longName: "Bom",
			}),
		})
		send(nodes, {
			from: 5,
			id: 3,
			portnum: 4,
			payload: encodeUser({
				id: "!00000005",
				longName: "",
				shortName: "",
				hwModel: 8,
			}),
		})
		expect(nodes.get("!00000005")).toMatchObject({
			longName: "Ada",
			shortName: "AD",
			hwModel: 8,
			role: 2,
			isLicensed: true,
			lastNodeInfoAt: AT.toISOString(),
			packetCount: 4,
		})
		expect(stamped).toBe(AT.toISOString())
		expect(nodes.getStats().invalidPackets).toBe(2)
		expect(nodes.getStats().decodeErrors).toBe(0)
	})

	it("ignores a (0, 0) or out-of-range position and still counts a decode failure", () => {
		const nodes = tracker()
		send(nodes, {
			from: 1,
			id: 1,
			portnum: 3,
			payload: encodePosition({
				latitudeI: 100_000_000,
				longitudeI: 200_000_000,
			}),
			rxSnr: 3,
		})
		send(nodes, {
			from: 1,
			id: 2,
			portnum: 3,
			payload: encodePosition({ latitudeI: 0, longitudeI: 0, altitudeM: 12 }),
		})
		send(nodes, {
			from: 1,
			id: 3,
			portnum: 3,
			payload: encodePosition({ latitudeI: 901_000_000, longitudeI: 1 }),
		})
		send(nodes, {
			from: 1,
			id: 4,
			portnum: 3,
			payload: Uint8Array.from([0xff]),
			rxSnr: 4,
		})
		send(nodes, {
			from: 1,
			id: 5,
			portnum: 4,
			payload: Uint8Array.from([0x12, 0x01, 0xff]),
		})
		send(nodes, { from: 1, id: 6, portnum: 67, payload: Uint8Array.from([1]) })
		send(nodes, {
			from: 1,
			id: 7,
			portnum: 3,
			payload: Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x10, 0x00]),
		})
		const node = nodes.get("!00000001")
		expect(node?.position).toEqual({
			lat: 10,
			lon: 20,
			altitudeM: null,
			at: AT.toISOString(),
		})
		expect(node?.snrDb).toBe(5)
		expect(node?.portnums).toMatchObject({ "3": 5, "4": 1, "67": 1 })
		expect(node?.packetCount).toBe(7)
		expect(node?.longName).toBeNull()
		expect(nodes.getStats().decodeErrors).toBe(3)
		expect(nodes.getStats().invalidPackets).toBe(0)
	})

	it("follows hopsAway and replaces viaMqtt from the latest unique packet", () => {
		const nodes = tracker()
		const cases: Array<[number, number, number | null]> = [
			[3, 3, 0],
			[3, 1, 2],
			[0, 0, null],
			[2, 3, null],
			[1, 0, 1],
		]
		cases.forEach(([hopStart, hopLimit, away], index) => {
			send(nodes, {
				from: 1,
				id: index + 1,
				portnum: 1,
				hopStart,
				hopLimit,
				viaMqtt: index === 0,
			})
			expect(nodes.get("!00000001")?.hopsAway).toBe(away)
		})
		expect(nodes.get("!00000001")?.viaMqtt).toBe(false)
	})

	it("counts a flood copy only in duplicateCopies and emits nothing", () => {
		const nodes = tracker()
		const start = 1_000_000
		send(
			nodes,
			{ from: 1, id: 7, rxSnr: 4, hopStart: 3, hopLimit: 1, portnum: 1 },
			new Date(start),
		)
		const before = structuredClone(nodes.get("!00000001"))
		expect(before).toBeDefined()
		const events: string[] = []
		nodes.on("mesh:new", () => events.push("new"))
		nodes.on("mesh:update", () => events.push("update"))
		nodes.on("mesh:lost", () => events.push("lost"))
		send(
			nodes,
			{ from: 1, id: 7, rxSnr: 9, hopStart: 7, hopLimit: 0, portnum: 5 },
			new Date(start + 60_000),
		)
		const after = nodes.get("!00000001")
		expect(events).toEqual([])
		expect(after?.duplicateCopies).toBe(1)
		expect(withoutCopies(after!)).toEqual(withoutCopies(before!))
		expect(nodes.getStats()).toMatchObject({
			packetsProcessed: 2,
			duplicatesDropped: 1,
			lastPacketAt: new Date(start).toISOString(),
		})
		send(nodes, { from: 1, id: 8, portnum: 1 }, new Date(start + 60_001))
		expect(nodes.get("!00000001")?.packetCount).toBe(2)
		send(
			nodes,
			{ from: 1, id: 8, portnum: 1, rxSnr: 1 },
			new Date(start + 60_001 + 60_000),
		)
		expect(nodes.get("!00000001")?.packetCount).toBe(2)
		expect(nodes.get("!00000001")?.duplicateCopies).toBe(2)
		send(
			nodes,
			{ from: 1, id: 9, portnum: 1 },
			new Date(start + 60_001 + 60_001),
		)
		expect(nodes.get("!00000001")?.packetCount).toBe(3)
	})

	it("keeps a packet more than 60 s earlier and does not move the dedupe anchor backward", () => {
		const nodes = tracker()
		const start = 1_000_000
		send(nodes, { from: 1, id: 7, rxSnr: 4, portnum: 1 }, new Date(start))
		const events: string[] = []
		nodes.on("mesh:update", () => events.push("update"))
		send(
			nodes,
			{ from: 1, id: 7, rxSnr: 9, portnum: 5 },
			new Date(start - 30_000),
		)
		expect(events).toEqual([])
		expect(nodes.get("!00000001")).toMatchObject({
			duplicateCopies: 1,
			snrDb: 4,
			packetCount: 1,
		})
		send(
			nodes,
			{ from: 1, id: 7, rxSnr: 1, portnum: 1 },
			new Date(start + 60_000),
		)
		expect(nodes.get("!00000001")?.duplicateCopies).toBe(2)
		expect(events).toEqual([])
		send(
			nodes,
			{ from: 1, id: 7, rxSnr: 2, portnum: 1 },
			new Date(start - 60_001),
		)
		expect(events).toEqual(["update"])
		expect(nodes.get("!00000001")).toMatchObject({
			snrDb: 2,
			packetCount: 2,
			duplicateCopies: 2,
		})
		send(nodes, { from: 1, id: 7, rxSnr: 8, portnum: 9 }, new Date(start))
		expect(nodes.get("!00000001")).toMatchObject({
			snrDb: 2,
			packetCount: 2,
			duplicateCopies: 3,
		})
		expect(events).toEqual(["update"])
	})

	it("folds portnums past 63 distinct values into other and stays at 64 keys", () => {
		const nodes = tracker()
		for (let port = 1; port <= 63; port++) {
			send(nodes, { from: 1, id: port, portnum: port })
		}
		const at63 = nodes.get("!00000001")
		expect(Object.keys(at63?.portnums ?? {})).toHaveLength(63)
		expect(at63?.portnums["other"]).toBeUndefined()
		send(nodes, { from: 1, id: 64, portnum: 64 })
		send(nodes, { from: 1, id: 65, portnum: 65 })
		send(nodes, { from: 1, id: 66, portnum: 64 })
		send(nodes, { from: 1, id: 67, portnum: 1 })
		const node = nodes.get("!00000001")
		expect(Object.keys(node?.portnums ?? {})).toHaveLength(64)
		expect(node?.portnums["other"]).toBe(3)
		expect(node?.portnums["64"]).toBeUndefined()
		expect(node?.portnums["1"]).toBe(2)
		expect(node?.lastPortnum).toBe(1)
		const sum = Object.values(node?.portnums ?? {}).reduce((a, b) => a + b, 0)
		expect(sum).toBe(node?.packetCount)
	})

	it("drops malformed packets and accepts a 512-byte payload but not 513", () => {
		const nodes = tracker()
		const bad: unknown[] = [
			null,
			[],
			"packet",
			{ ...meshPacket({ from: 1, id: 1 }), rxSnr: Number.NaN },
			{ ...meshPacket({ from: 1, id: 1 }), rxRssi: Number.POSITIVE_INFINITY },
			{ ...meshPacket({ from: 1, id: 1 }), from: 1.5 },
			{ ...meshPacket({ from: 1, id: 1 }), payloadB64: "!!!!" },
			{
				...meshPacket({ from: 1, id: 1 }),
				payloadB64: Buffer.alloc(513, 1).toString("base64"),
			},
			{ ...meshPacket({ from: 1, id: 1 }), from: -1 },
		]
		for (const data of bad) nodes.processPacket("lora", data, AT)
		expect(nodes.getAll()).toHaveLength(0)
		expect(nodes.getStats().invalidPackets).toBe(bad.length)
		expect(nodes.getStats().packetsProcessed).toBe(0)
		send(nodes, {
			from: 1,
			id: 1,
			portnum: 1,
			payload: Buffer.alloc(512, 2),
		})
		expect(nodes.get("!00000001")?.packetCount).toBe(1)
		expect(nodes.getStats().decodeErrors).toBe(0)
	})

	it("expires nodes only after the default 4 h and does not count cap eviction as expiry", () => {
		vi.useFakeTimers()
		let clock = 0
		const nodes = tracker({
			cleanupIntervalMs: 30_000,
			statsIntervalMs: 86_400_000,
			now: () => clock,
		})
		const lost: string[] = []
		nodes.on("mesh:lost", id => lost.push(id))
		send(nodes, { from: 1, id: 1, portnum: 1 }, new Date(0))
		send(nodes, { from: 2, id: 2, portnum: 1 }, new Date(500))
		nodes.start()
		clock = 14_400_000
		vi.advanceTimersByTime(30_000)
		expect(lost).toEqual([])
		expect(nodes.getAll()).toHaveLength(2)
		clock = 14_400_001
		vi.advanceTimersByTime(30_000)
		expect(lost).toEqual(["!00000001"])
		expect(nodes.get("!00000001")).toBeUndefined()
		expect(nodes.getStats().expiredTotal).toBe(1)
		expect(nodes.getStats().lastPacketAt).toBe(new Date(500).toISOString())
		nodes.stop()
	})

	it("evicts the least recently heard node at the 1000 cap", () => {
		const nodes = tracker()
		const lost: Array<{ id: string; packetCount: number }> = []
		nodes.on("mesh:lost", (id, node) => {
			lost.push({ id, packetCount: node.packetCount })
		})
		for (let from = 1; from <= 1000; from++) {
			send(nodes, { from, id: from, portnum: 1 }, new Date(from))
		}
		expect(nodes.getAll()).toHaveLength(1000)
		send(nodes, { from: 1001, id: 1001, portnum: 1 }, new Date(1001))
		expect(nodes.getAll()).toHaveLength(1000)
		expect(lost).toEqual([{ id: "!00000001", packetCount: 1 }])
		expect(nodes.get("!00000001")).toBeUndefined()
		expect(nodes.get(formatNodeId(1001))?.nodeNum).toBe(1001)
		expect(nodes.getStats().expiredTotal).toBe(0)
		expect(nodes.getAll()[0]?.nodeId).toBe(formatNodeId(1001))
	})

	it("breaks a lastSeen tie by the smaller node id when evicting", () => {
		const nodes = tracker({ maxNodes: 2 })
		const lost: string[] = []
		nodes.on("mesh:lost", id => lost.push(id))
		send(nodes, { from: 2, id: 1, portnum: 1 }, AT)
		send(nodes, { from: 1, id: 2, portnum: 1 }, AT)
		send(nodes, { from: 3, id: 3, portnum: 1 }, new Date(AT.getTime() + 60_000))
		expect(lost).toEqual(["!00000001"])
	})

	it("forgets the oldest duplicate key past 4096 so that packet can be heard again", () => {
		const nodes = tracker()
		const at = new Date(5_000)
		for (let id = 1; id <= 4096; id++) {
			send(nodes, { from: 1, id, portnum: 1 }, at)
		}
		expect(nodes.get("!00000001")?.packetCount).toBe(4096)
		send(nodes, { from: 1, id: 4097, portnum: 1 }, at)
		send(nodes, { from: 1, id: 1, portnum: 1, rxSnr: 8 }, at)
		expect(nodes.get("!00000001")?.packetCount).toBe(4098)
		expect(nodes.get("!00000001")?.duplicateCopies).toBe(0)
		send(nodes, { from: 1, id: 2, portnum: 1, rxSnr: 9 }, at)
		expect(nodes.get("!00000001")?.duplicateCopies).toBe(1)
		expect(nodes.get("!00000001")?.snrDb).not.toBe(9)
		expect(nodes.get("!00000001")?.packetCount).toBe(4098)
	})

	it("reports a rolling 60 s rate of unique packets and unrefs its timers", () => {
		vi.useFakeTimers()
		let clock = 1_000
		const nodes = tracker({
			statsIntervalMs: 5_000,
			cleanupIntervalMs: 60_000,
			now: () => clock,
		})
		const statsEvents: number[] = []
		nodes.on("stats:update", stats => {
			statsEvents.push(stats.packetsProcessed)
		})
		send(nodes, { from: 1, id: 1, portnum: 1 }, new Date(clock))
		send(nodes, { from: 1, id: 1, portnum: 1 }, new Date(clock))
		nodes.processPacket("lora", null, new Date(clock))
		expect(nodes.getStats().packetsPerSecond).toBeCloseTo(1 / 60)
		clock = 62_000
		expect(nodes.getStats().packetsPerSecond).toBe(0)
		nodes.start()
		nodes.start()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([2])
		nodes.stop()
		nodes.stop()
		vi.advanceTimersByTime(5_000)
		expect(statsEvents).toEqual([2])
	})

	it("keeps the rate window to at most 61 one-second buckets under a packet flood (R1 #9)", () => {
		let clock = 0
		const nodes = tracker({ now: () => clock, maxNodes: 10 })
		for (let i = 0; i < 6_000; i++) {
			clock = i * 20 // 50 unique packets/s for 120 s
			send(nodes, { from: 1 + (i % 5), id: i + 1, portnum: 1 }, new Date(clock))
		}
		const buckets = (nodes as unknown as { rateBuckets: Map<number, number> })
			.rateBuckets
		expect(buckets.size).toBeLessThanOrEqual(61)
		// Whole-second buckets: the window spans 60 to 61 seconds.
		const rate = nodes.getStats().packetsPerSecond
		expect(rate).toBeGreaterThanOrEqual(50)
		expect(rate).toBeLessThanOrEqual((61 * 50) / 60)
	})

	it("keeps at most 61 rate buckets when the clock runs backwards (R2 5)", () => {
		let clock = 2_000_000
		const nodes = tracker({ now: () => clock, maxNodes: 10 })
		for (let i = 0; i < 1_000; i++) {
			clock = 2_000_000 - i * 1000
			send(nodes, { from: 1, id: i + 1, portnum: 1 }, new Date(clock))
		}
		const buckets = (nodes as unknown as { rateBuckets: Map<number, number> })
			.rateBuckets
		expect(buckets.size).toBeLessThanOrEqual(61)
	})

	it("unrefs the sweep and stats timers", () => {
		const nodes = tracker({
			statsIntervalMs: 60_000,
			cleanupIntervalMs: 60_000,
		})
		const handles: NodeJS.Timeout[] = []
		const original = global.setInterval
		vi.spyOn(global, "setInterval").mockImplementation((handler, timeout) => {
			const handle = original(handler, timeout)
			handles.push(handle)
			return handle
		})
		nodes.start()
		expect(handles).toHaveLength(2)
		for (const handle of handles) expect(handle.hasRef()).toBe(false)
		nodes.stop()
	})

	it("removes the evicted node even when the lost listener throws", () => {
		const nodes = tracker({ maxNodes: 1 })
		nodes.on("mesh:lost", () => {
			throw new Error("listener failed")
		})
		send(nodes, { from: 1, id: 1, portnum: 1 })
		expect(() =>
			send(nodes, { from: 2, id: 2, portnum: 1 }, new Date(AT.getTime() + 1)),
		).toThrow("listener failed")
		expect(nodes.get("!00000001")).toBeUndefined()
		expect(nodes.get("!00000002")).toBeUndefined()
		expect(nodes.getStats().expiredTotal).toBe(0)
	})
})
