/**
 * APRS tracker properties: merge, dedupe, kill, expiry and the cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import type { AprsEntityKind } from "@wavekit/api-types"
import { AprsTracker } from "../../../src/core/aprs-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

const CALLS = ["N0CALL", "W1AW", "K1ABC", "VE3ABC"] as const
const NAMES = ["MEET", "AID4", "NET", "OBJ1"] as const
const DUPLICATE_WINDOW_MS = 30_000

interface SimPacket {
	source: string
	destination: string
	raw: string
	at: number
	dataType: string
	kind: AprsEntityKind
	name: string | null
	killed: boolean
	key: string
	callsign: string
	lat?: number
	lon?: number
	comment?: string
	speed?: number
}

interface ModelStation {
	key: string
	kind: AprsEntityKind
	callsign: string
	name: string | null
	position: { lat: number; lon: number; at: string } | null
	comment: string | null
	status: string | null
	speedKn: number | null
	packetCount: number
	digipeatedCopies: number
	lastDataType: string
	lastSeen: string
	firstSeen: string
}

function emptyStation(packet: SimPacket, atIso: string): ModelStation {
	return {
		key: packet.key,
		kind: packet.kind,
		callsign: packet.callsign,
		name: packet.name,
		position: null,
		comment: null,
		status: null,
		speedKn: null,
		packetCount: 1,
		digipeatedCopies: 0,
		lastDataType: packet.dataType,
		lastSeen: atIso,
		firstSeen: atIso,
	}
}

function payload(packet: SimPacket): Record<string, unknown> {
	const data: Record<string, unknown> = {
		timestamp: new Date(packet.at),
		source: packet.source,
		destination: packet.destination,
		path: ["WIDE1-1"],
		dataType: packet.dataType,
		raw: packet.raw,
	}
	if (packet.kind !== "station" && packet.name) {
		data["objectName"] = packet.name
		data["objectKind"] = packet.kind
		data["objectKilled"] = packet.killed
	}
	if (packet.lat !== undefined) data["lat"] = packet.lat
	if (packet.lon !== undefined) data["lon"] = packet.lon
	if (packet.comment !== undefined) data["comment"] = packet.comment
	if (packet.speed !== undefined) data["speed"] = packet.speed
	return data
}

describe("AprsTracker properties", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("merges, dedupes and kills over generated packet sequences", () => {
		// Feature: web-gaps-2, Property 5: APRS merge and dedupe
		// Validates: Requirements 3.3, 3.4, 3.5
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						call: fc.integer({ min: 0, max: CALLS.length - 1 }),
						name: fc.integer({ min: 0, max: NAMES.length - 1 }),
						gap: fc.integer({ min: 0, max: 40_000 }),
						copyPrev: fc.boolean(),
						kind: fc.constantFrom(
							"position",
							"status",
							"message",
							"object",
							"item",
							"kill-object",
							"kill-item",
						),
						lat: fc.integer({ min: -80, max: 80 }),
						lon: fc.integer({ min: -170, max: 170 }),
						comment: fc.stringMatching(/^[A-Z0-9]{0,8}$/),
						speed: fc.integer({ min: 0, max: 200 }),
						withPosition: fc.boolean(),
						withSpeed: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				steps => {
					const packets: SimPacket[] = []
					let at = 1_700_000_000_000
					for (let i = 0; i < steps.length; i++) {
						const step = steps[i]
						if (!step) continue
						at += step.gap
						const prev = packets[packets.length - 1]
						if (step.copyPrev && prev) {
							packets.push({ ...prev, at })
							continue
						}
						const call = CALLS[step.call] ?? "N0CALL"
						const name = NAMES[step.name] ?? "MEET"
						const killed =
							step.kind === "kill-object" || step.kind === "kill-item"
						const kind: AprsEntityKind =
							step.kind === "object" || step.kind === "kill-object"
								? "object"
								: step.kind === "item" || step.kind === "kill-item"
									? "item"
									: "station"
						const dataType =
							step.kind === "status"
								? "Status"
								: step.kind === "message"
									? "Message"
									: kind === "object"
										? "Object"
										: kind === "item"
											? "Item"
											: "Position"
						const key =
							kind === "object"
								? `aprs-object:${name}`
								: kind === "item"
									? `aprs-item:${name}`
									: `callsign:${call}`
						const packet: SimPacket = {
							source: call,
							destination: "APRS",
							raw: `r${i}`,
							at,
							dataType,
							kind,
							name: kind === "station" ? null : name,
							killed,
							key,
							callsign: call,
						}
						if (step.withPosition) {
							packet.lat = step.lat
							packet.lon = step.lon
						}
						if (step.comment.length > 0) packet.comment = step.comment
						if (step.withSpeed) packet.speed = step.speed
						packets.push(packet)
					}

					const aprs = new AprsTracker({}, logger)
					const events: string[] = []
					const lost: Array<{ key: string; killed: boolean }> = []
					aprs.on("aprs:new", () => {
						events.push("new")
					})
					aprs.on("aprs:update", () => {
						events.push("update")
					})
					aprs.on("aprs:lost", (key, station) => {
						events.push("lost")
						lost.push({ key, killed: station.killed })
					})

					const model = new Map<string, ModelStation>()
					const dedupe = new Map<string, number>()
					const expectedLost: Array<{ key: string; killed: boolean }> = []
					let expectedEvents = 0
					let duplicates = 0

					for (const packet of packets) {
						const dedupeKey = `${packet.source}>${packet.destination}:${packet.raw}`
						const seen = dedupe.get(dedupeKey)
						if (
							seen !== undefined &&
							packet.at >= seen &&
							packet.at - seen < DUPLICATE_WINDOW_MS
						) {
							duplicates += 1
							const station = model.get(packet.key)
							if (station) station.digipeatedCopies += 1
							continue
						}
						dedupe.set(dedupeKey, packet.at)
						if (packet.killed) {
							if (model.delete(packet.key)) {
								expectedLost.push({ key: packet.key, killed: true })
								expectedEvents += 1
							}
							continue
						}
						const atIso = new Date(packet.at).toISOString()
						let station = model.get(packet.key)
						if (!station) {
							station = emptyStation(packet, atIso)
							model.set(packet.key, station)
							expectedEvents += 1
						} else {
							station.packetCount += 1
							station.callsign = packet.callsign
							station.lastSeen = atIso
							station.lastDataType = packet.dataType
							expectedEvents += 1
						}
						if (packet.dataType === "Message") continue
						if (packet.lat !== undefined && packet.lon !== undefined) {
							station.position = {
								lat: packet.lat,
								lon: packet.lon,
								at: atIso,
							}
						}
						if (packet.speed !== undefined) station.speedKn = packet.speed
						const text = packet.comment?.trim() ?? ""
						if (packet.dataType === "Status") {
							if (text && station.kind === "station") station.status = text
						} else if (text) {
							station.comment = text
						}
					}

					for (const packet of packets) {
						aprs.processAprs("d", payload(packet), new Date(packet.at))
					}

					expect(events).toHaveLength(expectedEvents)
					expect(lost).toEqual(expectedLost)
					expect(aprs.getStats().duplicatesDropped).toBe(duplicates)
					expect(aprs.getStats().invalidPackets).toBe(0)
					expect(aprs.getStats().packetsProcessed).toBe(packets.length)
					expect(aprs.getAll()).toHaveLength(model.size)
					for (const [key, station] of model) {
						expect(aprs.get(key)).toMatchObject(station)
					}
					for (const station of aprs.getAll()) {
						expect(model.has(station.key)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("stays within the cap and expires exactly the entities older than maxAge", () => {
		// Feature: web-gaps-2, Property 6: Tracker expiry and cap
		// Validates: Requirements 3.6
		const calls = ["N0CALL", "W1AW", "K1ABC", "VE3ABC", "G4ABC", "DL1XYZ"]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						n: fc.integer({ min: 0, max: calls.length - 1 }),
						at: fc.integer({ min: 0, max: 5_000 }),
					}),
					{ maxLength: 20 },
				),
				fc.integer({ min: 0, max: 8_000 }),
				(reports, sweepAt) => {
					vi.useFakeTimers()
					let now = 0
					const aprs = new AprsTracker(
						{
							now: () => now,
							maxAgeMs: 1_000,
							cleanupIntervalMs: 20,
							maxStations: 5,
							statsIntervalMs: 60_000,
							duplicateWindowMs: 100_000,
						},
						logger,
					)
					const lost: Array<{ key: string; killed: boolean }> = []
					aprs.on("aprs:lost", (key, station) => {
						lost.push({ key, killed: station.killed })
					})
					try {
						aprs.start()
						const rows = new Map<string, { at: number; seq: number }>()
						const expectedLost: Array<{ key: string; killed: boolean }> = []
						let seq = 0

						const evict = (): void => {
							while (rows.size >= 5) {
								let victim: string | undefined
								let bestAt = Infinity
								let bestSeq = Infinity
								for (const [key, row] of rows) {
									if (
										victim === undefined ||
										row.at < bestAt ||
										(row.at === bestAt && row.seq < bestSeq) ||
										(row.at === bestAt && row.seq === bestSeq && key < victim)
									) {
										victim = key
										bestAt = row.at
										bestSeq = row.seq
									}
								}
								if (victim === undefined) return
								rows.delete(victim)
								expectedLost.push({ key: victim, killed: false })
							}
						}

						reports.forEach((report, index) => {
							const call = calls[report.n] ?? "N0CALL"
							const key = `callsign:${call}`
							now = report.at
							if (!rows.has(key)) evict()
							if (rows.size >= 5 && !rows.has(key)) return
							rows.set(key, { at: report.at, seq: seq })
							seq += 1
							aprs.processAprs(
								"d",
								{
									timestamp: new Date(report.at),
									source: call,
									destination: "APRS",
									path: [],
									dataType: "Status",
									comment: "up",
									raw: `p${index}`,
								},
								new Date(report.at),
							)
							expect(aprs.getAll().length).toBeLessThanOrEqual(5)
						})

						now = sweepAt
						vi.advanceTimersByTime(20)
						let expired = 0
						for (const [key, row] of [...rows]) {
							if (sweepAt - row.at > 1_000) {
								rows.delete(key)
								expectedLost.push({ key, killed: false })
								expired += 1
							}
						}

						expect(aprs.getAll().length).toBeLessThanOrEqual(5)
						expect(lost).toEqual(expectedLost)
						expect(aprs.getStats().expiredTotal).toBe(expired)
						expect([...rows.keys()].sort()).toEqual(
							aprs
								.getAll()
								.map(station => station.key)
								.sort(),
						)
						for (const [key, row] of rows) {
							expect(aprs.get(key)?.lastSeen).toBe(
								new Date(row.at).toISOString(),
							)
						}
						for (const event of lost) expect(event.killed).toBe(false)
					} finally {
						aprs.stop()
						vi.useRealTimers()
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
