/**
 * Mesh tracker properties: flood copies, hops and the cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import type { MeshNode } from "@wavekit/api-types"
import { formatNodeId, MeshTracker } from "../../../src/core/mesh-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	encodePosition,
	encodeUser,
	meshPacket,
} from "../../mocks/fixtures/meshtastic/encode.js"

const logger = createLogger({ level: "error" })

function ascii(maxLength: number) {
	return fc
		.array(fc.integer({ min: 0x20, max: 0x7e }), {
			minLength: 1,
			maxLength,
		})
		.map(codes => String.fromCharCode(...codes))
}

function withoutCopies(node: MeshNode): Omit<MeshNode, "duplicateCopies"> {
	const { duplicateCopies: _copies, ...rest } = node
	return rest
}

function expectedHops(hopStart: number, hopLimit: number): number | null {
	if (hopStart > 0 && hopStart >= hopLimit) return hopStart - hopLimit
	return null
}

describe("MeshTracker properties", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("changes only duplicateCopies for a flood copy, and hopsAway follows 5.6", () => {
		// Feature: web-gaps-2, Property 8: Mesh merge and flood copies
		// Validates: Requirements 5.4, 5.5, 5.6
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						from: fc.integer({ min: 1, max: 4 }),
						packetId: fc.integer({ min: 1, max: 6 }),
						hopStart: fc.integer({ min: 0, max: 7 }),
						hopLimit: fc.integer({ min: 0, max: 7 }),
						dt: fc.integer({ min: 0, max: 30_000 }),
						snr: fc.double({
							min: -20,
							max: 10,
							noNaN: true,
							noDefaultInfinity: true,
						}),
						port: fc.constantFrom(1, 3),
					}),
					{ minLength: 1, maxLength: 20 },
				),
				steps => {
					const nodes = new MeshTracker(
						{ duplicateWindowMs: 60_000, maxNodes: 10 },
						logger,
					)
					let events = 0
					nodes.on("mesh:new", () => {
						events += 1
					})
					nodes.on("mesh:update", () => {
						events += 1
					})
					nodes.on("mesh:lost", () => {
						events += 1
					})
					const seen = new Map<string, number>()
					const copies = new Map<string, number>()
					let clock = 1_000_000
					for (const step of steps) {
						clock += step.dt
						const key = `${step.from}:${step.packetId}`
						const prev = seen.get(key)
						const duplicate = prev !== undefined && clock - prev <= 60_000
						const nodeId = formatNodeId(step.from)
						const before = nodes.get(nodeId)
						const snapshot = before ? structuredClone(before) : undefined
						const eventsBefore = events
						const snr = Object.is(step.snr, -0) ? 0 : step.snr
						nodes.processPacket(
							"lora",
							meshPacket({
								from: step.from,
								id: step.packetId,
								hopStart: step.hopStart,
								hopLimit: step.hopLimit,
								portnum: step.port,
								payload:
									step.port === 3
										? encodePosition({
												latitudeI: 100_000_000,
												longitudeI: 200_000_000,
											})
										: new Uint8Array(),
								rxSnr: snr,
								rxRssi: -40,
							}),
							new Date(clock),
						)
						if (duplicate) {
							seen.set(key, clock)
							expect(events).toBe(eventsBefore)
							const after = nodes.get(nodeId)
							expect(after).toBeDefined()
							expect(after?.duplicateCopies).toBe(
								(snapshot?.duplicateCopies ?? 0) + 1,
							)
							if (snapshot && after) {
								expect(withoutCopies(after)).toEqual(withoutCopies(snapshot))
							}
							copies.set(nodeId, (copies.get(nodeId) ?? 0) + 1)
						} else {
							seen.set(key, clock)
							const after = nodes.get(nodeId)
							expect(after?.hopsAway).toBe(
								expectedHops(step.hopStart, step.hopLimit),
							)
							expect(after?.snrDb).toBe(snr === 0 ? null : snr)
							if (step.port === 3) {
								expect(after?.position?.lat).toBeCloseTo(10, 5)
								expect(after?.position?.lon).toBeCloseTo(20, 5)
							}
						}
					}
					for (const node of nodes.getAll()) {
						expect(node.duplicateCopies).toBe(copies.get(node.nodeId) ?? 0)
						expect(node.key).toBe(`node:${node.nodeId}`)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("does not rename a node from a User id that is not its own", () => {
		// Feature: web-gaps-2, Property 8: Mesh merge and flood copies
		// Validates: Requirements 5.4, 5.5, 5.6
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0xfffffffe }),
				ascii(20),
				ascii(12),
				(from, good, bad) => {
					const nodes = new MeshTracker({}, logger)
					const nodeId = formatNodeId(from)
					const other = from === 1 ? "!00000002" : "!00000001"
					nodes.processPacket(
						"lora",
						meshPacket({
							from,
							id: 1,
							portnum: 4,
							payload: encodeUser({
								id: nodeId,
								longName: good,
								shortName: "ok",
							}),
						}),
						new Date(1_000),
					)
					const before = nodes.getStats().invalidPackets
					nodes.processPacket(
						"lora",
						meshPacket({
							from,
							id: 2,
							portnum: 4,
							payload: encodeUser({ id: other, longName: bad, hwModel: 3 }),
						}),
						new Date(2_000),
					)
					expect(nodes.get(nodeId)).toMatchObject({
						longName: good,
						shortName: "ok",
						hwModel: null,
						packetCount: 2,
					})
					expect(nodes.getStats().invalidPackets).toBe(before + 1)
					expect(nodes.get(other)).toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("stays within the cap and expires exactly the stale nodes", () => {
		// Feature: web-gaps-2, Property 6: Tracker expiry and cap
		// Validates: Requirements 5.7
		vi.useFakeTimers()
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.integer({ min: 100, max: 5_000 }),
				fc.array(
					fc.oneof(
						fc.record({
							kind: fc.constant("report" as const),
							node: fc.integer({ min: 1, max: 8 }),
							t: fc.integer({ min: 0, max: 20_000 }),
						}),
						fc.record({
							kind: fc.constant("sweep" as const),
							t: fc.integer({ min: 0, max: 30_000 }),
						}),
					),
					{ maxLength: 25 },
				),
				(maxNodes, maxAgeMs, steps) => {
					let clock = 0
					const nodes = new MeshTracker(
						{
							maxNodes,
							maxAgeMs,
							cleanupIntervalMs: 1_000,
							statsIntervalMs: 86_400_000,
							now: () => clock,
						},
						logger,
					)
					const lost: string[] = []
					nodes.on("mesh:lost", id => {
						lost.push(id)
					})
					const ref = new Map<string, number>()
					const refLost: string[] = []
					const evict = () => {
						let victim: string | undefined
						let best = Infinity
						for (const [id, at] of ref) {
							if (
								victim === undefined ||
								at < best ||
								(at === best && id < victim)
							) {
								victim = id
								best = at
							}
						}
						if (victim === undefined) return
						ref.delete(victim)
						refLost.push(victim)
					}
					let seq = 1
					nodes.start()
					try {
						for (const step of steps) {
							if (step.kind === "report") {
								const nodeId = formatNodeId(step.node)
								const isNew = !ref.has(nodeId)
								if (isNew) {
									while (ref.size >= maxNodes) evict()
								}
								if (!isNew || ref.size < maxNodes) ref.set(nodeId, step.t)
								nodes.processPacket(
									"lora",
									meshPacket({
										from: step.node,
										id: seq,
										portnum: 1,
									}),
									new Date(step.t),
								)
								seq += 1
							} else {
								clock = step.t
								const doomed: string[] = []
								for (const [id, at] of ref) {
									if (step.t - at > maxAgeMs) doomed.push(id)
								}
								for (const id of doomed) {
									ref.delete(id)
									refLost.push(id)
								}
								vi.advanceTimersByTime(1_000)
							}
							expect(nodes.getAll().length).toBeLessThanOrEqual(maxNodes)
						}
						expect(lost).toEqual(refLost)
						expect(new Set(nodes.getAll().map(node => node.nodeId))).toEqual(
							new Set(ref.keys()),
						)
						for (const node of nodes.getAll()) {
							expect(Date.parse(node.lastSeen)).toBe(ref.get(node.nodeId))
						}
					} finally {
						nodes.stop()
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
