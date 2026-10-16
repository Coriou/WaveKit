/**
 * Mesh device telemetry and neighbour reports (WG3 requirement 8).
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { MeshTracker } from "../../../src/core/mesh-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodeNeighborInfo,
	encodeTelemetry,
	meshPacket,
	type MeshPacketFixture,
} from "../../mocks/fixtures/meshtastic/encode.js"

const logger = createLogger({ level: "error" })
const T0 = Date.parse("2026-06-15T12:00:00.000Z")
const HOUR = 3_600_000
const FROM = 0x1000

function setup() {
	const clock = { now: T0 }
	const tracker = new MeshTracker({ now: () => clock.now }, logger)
	let id = 0
	const send = (fields: MeshPacketFixture, at = clock.now) => {
		id += 1
		tracker.processPacket(
			"lora",
			meshPacket({ from: FROM, id, ...fields }),
			new Date(at),
		)
	}
	return { clock, tracker, send }
}

const TELEMETRY = { portnum: 67 }
const NEIGHBOR = { portnum: 71 }

describe("mesh telemetry", () => {
	it("applies device metrics to the sending node", () => {
		const { tracker, send } = setup()
		send({
			...TELEMETRY,
			payload: encodeTelemetry({
				batteryLevel: 80,
				voltage: 4.25,
				channelUtilization: 12.5,
				airUtilTx: 1.5,
				uptimeSeconds: 3600,
			}),
		})
		const node = tracker.get("!00001000")
		expect(node?.telemetry).toEqual({
			batteryPct: 80,
			powered: false,
			voltageV: 4.25,
			channelUtilizationPct: 12.5,
			airUtilTxPct: 1.5,
			uptimeS: 3600,
			at: "2026-06-15T12:00:00.000Z",
		})
		expect(tracker.getStats().telemetryPackets).toBe(1)
	})

	it("treats battery above 100 as powered", () => {
		const { tracker, send } = setup()
		send({ ...TELEMETRY, payload: encodeTelemetry({ batteryLevel: 101 }) })
		expect(tracker.get("!00001000")?.telemetry).toMatchObject({
			batteryPct: null,
			powered: true,
		})
	})

	it("leaves battery and powered null when absent", () => {
		const { tracker, send } = setup()
		send({ ...TELEMETRY, payload: encodeTelemetry({ voltage: 3.5 }) })
		expect(tracker.get("!00001000")?.telemetry).toMatchObject({
			batteryPct: null,
			powered: null,
			voltageV: 3.5,
		})
	})

	it("ignores another telemetry variant without a decode error", () => {
		const { tracker, send } = setup()
		send({ ...TELEMETRY, payload: encodeTelemetry({ other: true }) })
		expect(tracker.get("!00001000")?.telemetry).toBeNull()
		const stats = tracker.getStats()
		expect(stats.decodeErrors).toBe(0)
		expect(stats.telemetryPackets).toBe(0)
	})

	it("counts malformed telemetry as a decode error", () => {
		const { tracker, send } = setup()
		send({ ...TELEMETRY, payload: Uint8Array.from([0x12, 0x7f, 0x01]) })
		expect(tracker.getStats().decodeErrors).toBe(1)
		expect(tracker.get("!00001000")?.telemetry).toBeNull()
	})

	it("applies a flood copy once", () => {
		const { tracker } = setup()
		const packet = meshPacket({
			from: FROM,
			id: 7,
			...TELEMETRY,
			payload: encodeTelemetry({ batteryLevel: 50 }),
		})
		tracker.processPacket("lora", packet, new Date(T0))
		tracker.processPacket("lora", packet, new Date(T0 + 1000))
		expect(tracker.getStats().telemetryPackets).toBe(1)
	})
})

describe("mesh neighbours", () => {
	it("replaces the list, sorted by node id", () => {
		const { tracker, send } = setup()
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: FROM,
				neighbors: [{ nodeNum: 0x30, snr: 4.5 }, { nodeNum: 0x20 }],
			}),
		})
		expect(tracker.get("!00001000")?.neighbours).toEqual([
			{ nodeId: "!00000020", snrDb: null, at: "2026-06-15T12:00:00.000Z" },
			{ nodeId: "!00000030", snrDb: 4.5, at: "2026-06-15T12:00:00.000Z" },
		])
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: FROM,
				neighbors: [{ nodeNum: 0x40, snr: 1 }],
			}),
		})
		expect(tracker.get("!00001000")?.neighbours?.map(n => n.nodeId)).toEqual([
			"!00000040",
		])
		expect(tracker.getStats().neighbourReports).toBe(2)
	})

	// A node listed twice keeps one entry, the one with the best SNR (a known
	// SNR beats null; ties keep the first), and takes one of the 32 slots.
	it("merges a node listed twice into one entry with the best SNR", () => {
		const { tracker, send } = setup()
		const duplicates = [
			{ nodeNum: 0x20, snr: 1.5 },
			{ nodeNum: 0x30 },
			{ nodeNum: 0x20, snr: 6 },
			{ nodeNum: 0x30, snr: -3 },
			{ nodeNum: 0x20, snr: 2 },
			{ nodeNum: 0x40, snr: 3 },
			{ nodeNum: 0x40 },
		]
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({ nodeNum: FROM, neighbors: duplicates }),
		})
		expect(
			tracker.get("!00001000")?.neighbours?.map(n => [n.nodeId, n.snrDb]),
		).toEqual([
			["!00000020", 6],
			["!00000030", -3],
			["!00000040", 3],
		])
	})

	it("counts a duplicated node once against the 32 slots", () => {
		const { tracker, send } = setup()
		const neighbors = Array.from({ length: 32 }, (_, i) => ({
			nodeNum: 0x100 + i,
		}))
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: FROM,
				neighbors: [{ nodeNum: 0x100, snr: 9 }, ...neighbors],
			}),
		})
		const list = tracker.get("!00001000")?.neighbours ?? []
		expect(list).toHaveLength(32)
		expect(list[0]).toMatchObject({ nodeId: "!00000100", snrDb: 9 })
		expect(list[31]?.nodeId).toBe("!0000011f")
	})

	it("rejects a report for another node as invalid", () => {
		const { tracker, send } = setup()
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: 0x9999,
				neighbors: [{ nodeNum: 0x20 }],
			}),
		})
		expect(tracker.get("!00001000")?.neighbours).toEqual([])
		const stats = tracker.getStats()
		expect(stats.invalidPackets).toBe(1)
		expect(stats.neighbourReports).toBe(0)
	})

	it("keeps the first 32 of 40 neighbours after sorting", () => {
		const { tracker, send } = setup()
		const neighbors = Array.from({ length: 40 }, (_, i) => ({
			nodeNum: 0x100 + (39 - i),
		}))
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({ nodeNum: FROM, neighbors }),
		})
		const list = tracker.get("!00001000")?.neighbours ?? []
		expect(list).toHaveLength(32)
		expect(list[0]?.nodeId).toBe("!00000100")
		expect(list[31]?.nodeId).toBe("!0000011f")
	})

	it("drops entries older than the node expiry on cleanup", () => {
		const { clock, tracker, send } = setup()
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: FROM,
				neighbors: [{ nodeNum: 2 }],
			}),
		})
		const sweep = () => (tracker as unknown as { sweep(): void }).sweep()
		clock.now = T0 + 4 * HOUR
		sweep()
		expect(tracker.get("!00001000")?.neighbours).toHaveLength(1)
		clock.now = T0 + 4 * HOUR + 1
		send({ portnum: 1 }, clock.now)
		const updates: string[] = []
		tracker.on("mesh:update", node => updates.push(node.nodeId))
		sweep()
		expect(tracker.get("!00001000")?.neighbours).toEqual([])
		expect(updates).toEqual(["!00001000"])
		sweep()
		expect(updates).toHaveLength(1)
	})

	it("does not let callers mutate tracker state", () => {
		const { tracker, send } = setup()
		send({
			...NEIGHBOR,
			payload: encodeNeighborInfo({
				nodeNum: FROM,
				neighbors: [{ nodeNum: 2 }],
			}),
		})
		tracker.get("!00001000")?.neighbours?.pop()
		expect(tracker.get("!00001000")?.neighbours).toHaveLength(1)
	})

	// Feature: web-gaps-3, Property 12: Neighbour state
	// Validates: Requirements 8.5
	it("Property 12: neighbour state is the latest valid report, sorted, capped, unexpired", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 0xfffff }), { maxLength: 60 }),
				fc.array(fc.integer({ min: 1, max: 0xfffff }), { maxLength: 60 }),
				fc.integer({ min: 0, max: 6 * HOUR }),
				(first, second, age) => {
					const { clock, tracker, send } = setup()
					const report = (nums: number[]) =>
						send({
							...NEIGHBOR,
							payload: encodeNeighborInfo({
								nodeNum: FROM,
								neighbors: nums.map(nodeNum => ({ nodeNum })),
							}),
						})
					report(first)
					report(second)
					clock.now = T0 + age
					;(tracker as unknown as { sweep(): void }).sweep()
					const list = tracker.get("!00001000")?.neighbours ?? []
					const ids = list.map(n => n.nodeId)
					expect(ids).toEqual([...ids].sort())
					expect(ids.length).toBeLessThanOrEqual(32)
					if (age > 4 * HOUR) {
						expect(ids).toEqual([])
					} else {
						// A node listed twice is one entry (one slot).
						const expected = [...new Set(second)]
							.map(n => "!" + n.toString(16).padStart(8, "0"))
							.sort()
							.slice(0, 32)
						expect(ids).toEqual(expected)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
