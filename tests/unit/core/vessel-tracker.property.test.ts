/**
 * Vessel tracker properties: merge, expiry and the cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import type { VesselClass, VesselState } from "@wavekit/api-types"
import { VesselTracker } from "../../../src/core/vessel-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

interface Report {
	messageType: number
	name?: string | undefined
	callsign?: string | undefined
	imo?: number | undefined
	shipType?: number | undefined
	lat?: number | undefined
	lon?: number | undefined
	cog?: number | undefined
	sog?: number | undefined
	heading?: number | undefined
	navStatus?: number | undefined
	destination?: string | undefined
	eta?: string | undefined
	draught?: number | undefined
	decoderId: string
	at: number
}

function cleanText(value: string | undefined): string | null {
	if (value === undefined) return null
	const cleaned = value.trim().replace(/@+$/g, "").trim()
	return cleaned.length > 0 ? cleaned : null
}

function cleanEta(value: string | undefined): string | null {
	if (value === undefined) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return null
	return date.toISOString()
}

function keepNumber(
	value: number | undefined,
	accept: (value: number) => boolean,
): number | null {
	if (value === undefined || !accept(value)) return null
	return value
}

function classFor(types: readonly number[]): VesselClass {
	if (types.includes(4) || types.includes(11)) return "base-station"
	if (types.includes(21)) return "aton"
	if (types.includes(9)) return "sar"
	if (types.some(type => type === 18 || type === 19 || type === 24)) return "B"
	if (
		types.some(type => type === 1 || type === 2 || type === 3 || type === 5)
	) {
		return "A"
	}
	return "unknown"
}

function reference(reports: Report[]): VesselState {
	const state: VesselState = {
		mmsi: "000000001",
		vesselClass: "unknown",
		name: null,
		callsign: null,
		imo: null,
		shipType: null,
		destination: null,
		eta: null,
		draught: null,
		position: null,
		cog: null,
		sog: null,
		heading: null,
		navStatus: null,
		messageTypes: [],
		messageCount: 0,
		decoderId: "",
		firstSeen: "",
		lastSeen: "",
		lastStaticAt: null,
		channel: null,
		aton: null,
		altitudeM: null,
	}
	let atonSeen: VesselState["aton"] = null
	for (const report of reports) {
		const atIso = new Date(report.at).toISOString()
		const name = cleanText(report.name)
		const callsign = cleanText(report.callsign)
		const destination = cleanText(report.destination)
		const imo = keepNumber(
			report.imo,
			value => Number.isInteger(value) && value > 0,
		)
		const shipType = keepNumber(
			report.shipType,
			value => Number.isInteger(value) && value >= 1 && value <= 99,
		)
		const eta = cleanEta(report.eta)
		const draught = keepNumber(report.draught, value => value > 0)
		const cog = keepNumber(report.cog, value => value >= 0 && value < 360)
		const sog = keepNumber(report.sog, value => value >= 0 && value < 102.3)
		const heading = keepNumber(
			report.heading,
			value => value >= 0 && value <= 359,
		)
		const navStatus = keepNumber(
			report.navStatus,
			value => Number.isInteger(value) && value >= 0 && value <= 14,
		)
		const lat = keepNumber(
			report.lat,
			value => value !== 91 && Math.abs(value) <= 90,
		)
		const lon = keepNumber(
			report.lon,
			value => value !== 181 && Math.abs(value) <= 180,
		)
		if (state.messageCount === 0) state.firstSeen = atIso
		if (name !== null) state.name = name
		if (callsign !== null) state.callsign = callsign
		if (destination !== null) state.destination = destination
		if (imo !== null) state.imo = imo
		if (shipType !== null) state.shipType = shipType
		if (eta !== null) state.eta = eta
		if (draught !== null) state.draught = draught
		if (cog !== null) state.cog = cog
		if (sog !== null) state.sog = sog
		if (heading !== null) state.heading = heading
		if (navStatus !== null) state.navStatus = navStatus
		if (lat !== null && lon !== null) state.position = { lat, lon, at: atIso }
		if (!state.messageTypes.includes(report.messageType)) {
			state.messageTypes.push(report.messageType)
			state.messageTypes.sort((a, b) => a - b)
		}
		state.vesselClass = classFor(state.messageTypes)
		// Reports here carry no AtoN fields: a type 21 leaves them null.
		if (report.messageType === 21) {
			atonSeen = { aidType: null, virtual: null, offPosition: null }
		}
		state.aton = state.vesselClass === "aton" ? atonSeen : null
		state.messageCount += 1
		state.decoderId = report.decoderId
		state.lastSeen = atIso
		if (
			report.messageType === 5 ||
			report.messageType === 19 ||
			report.messageType === 24 ||
			(report.messageType === 21 && name !== null)
		) {
			state.lastStaticAt = atIso
		}
	}
	return state
}

const optionalText = fc.option(fc.string({ maxLength: 24 }), { nil: undefined })
const reportArb: fc.Arbitrary<Report> = fc.record({
	messageType: fc.integer({ min: 1, max: 27 }),
	name: optionalText,
	callsign: optionalText,
	destination: optionalText,
	imo: fc.option(fc.integer({ min: -2, max: 10_000_000 }), { nil: undefined }),
	shipType: fc.option(fc.integer({ min: -1, max: 120 }), { nil: undefined }),
	lat: fc.option(
		fc.oneof(
			fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
			fc.constant(91),
			fc.constant(0),
		),
		{ nil: undefined },
	),
	lon: fc.option(
		fc.oneof(
			fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
			fc.constant(181),
			fc.constant(0),
		),
		{ nil: undefined },
	),
	cog: fc.option(
		fc.oneof(
			fc.double({ min: -10, max: 400, noNaN: true, noDefaultInfinity: true }),
			fc.constant(360),
			fc.constant(0),
		),
		{ nil: undefined },
	),
	sog: fc.option(
		fc.oneof(
			fc.double({ min: -5, max: 120, noNaN: true, noDefaultInfinity: true }),
			fc.constant(102.3),
			fc.constant(0),
		),
		{ nil: undefined },
	),
	heading: fc.option(
		fc.oneof(
			fc.double({ min: -5, max: 520, noNaN: true, noDefaultInfinity: true }),
			fc.constant(511),
			fc.constant(0),
		),
		{ nil: undefined },
	),
	navStatus: fc.option(fc.integer({ min: -1, max: 16 }), { nil: undefined }),
	draught: fc.option(
		fc.double({ min: -1, max: 30, noNaN: true, noDefaultInfinity: true }),
		{ nil: undefined },
	),
	eta: fc.option(
		fc.oneof(
			fc
				.integer({ min: 0, max: 2_000_000_000_000 })
				.map(ms => new Date(ms).toISOString()),
			fc.constant("not-a-date"),
		),
		{ nil: undefined },
	),
	decoderId: fc.constantFrom("ais-a", "ais-b"),
	at: fc.integer({ min: 0, max: 2_000_000_000_000 }),
})

describe("VesselTracker properties", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("keeps the last valid value of each field", () => {
		// Feature: web-gaps-1, Property 7: Vessel merge
		// Validates: Requirements 5.2, 5.3, 5.4, 5.5
		fc.assert(
			fc.property(
				fc.array(reportArb, { minLength: 1, maxLength: 20 }),
				reports => {
					const vessels = new VesselTracker({}, logger)
					for (const report of reports) {
						vessels.processShip(
							report.decoderId,
							{ mmsi: "1", ...report },
							new Date(report.at),
						)
					}
					expect(vessels.get("000000001")).toEqual(reference(reports))
				},
			),
			{ numRuns: 100 },
		)
	})

	it("stays within the cap and expires exactly the stale vessels", () => {
		// Feature: web-gaps-1, Property 8: Vessel expiry and cap
		// Validates: Requirements 5.6
		vi.useFakeTimers()
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.integer({ min: 100, max: 5_000 }),
				fc.array(
					fc.oneof(
						fc.record({
							kind: fc.constant("report" as const),
							mmsi: fc.integer({ min: 1, max: 8 }),
							t: fc.integer({ min: 0, max: 20_000 }),
						}),
						fc.record({
							kind: fc.constant("sweep" as const),
							t: fc.integer({ min: 0, max: 30_000 }),
						}),
					),
					{ maxLength: 25 },
				),
				(maxVessels, maxAgeMs, steps) => {
					let clock = 0
					const vessels = new VesselTracker(
						{
							maxVessels,
							maxAgeMs,
							cleanupIntervalMs: 1_000,
							statsIntervalMs: 86_400_000,
							now: () => clock,
						},
						logger,
					)
					const lost: string[] = []
					vessels.on("vessel:lost", mmsi => {
						lost.push(mmsi)
					})
					const ref = new Map<string, number>()
					const refLost: string[] = []
					const evict = () => {
						let victim: string | undefined
						let best = Infinity
						for (const [mmsi, at] of ref) {
							if (
								victim === undefined ||
								at < best ||
								(at === best && mmsi < victim)
							) {
								victim = mmsi
								best = at
							}
						}
						if (victim === undefined) return
						ref.delete(victim)
						refLost.push(victim)
					}
					vessels.start()
					try {
						for (const step of steps) {
							if (step.kind === "report") {
								const mmsi = String(step.mmsi).padStart(9, "0")
								const isNew = !ref.has(mmsi)
								if (isNew) {
									while (ref.size >= maxVessels) evict()
								}
								if (!isNew || ref.size < maxVessels) ref.set(mmsi, step.t)
								vessels.processShip(
									"ais",
									{ mmsi, messageType: 1 },
									new Date(step.t),
								)
							} else {
								clock = step.t
								const doomed: string[] = []
								for (const [mmsi, at] of ref) {
									if (step.t - at > maxAgeMs) doomed.push(mmsi)
								}
								for (const mmsi of doomed) {
									ref.delete(mmsi)
									refLost.push(mmsi)
								}
								vi.advanceTimersByTime(1_000)
							}
							expect(vessels.getAll().length).toBeLessThanOrEqual(maxVessels)
						}
						expect(lost).toEqual(refLost)
						expect(new Set(vessels.getAll().map(state => state.mmsi))).toEqual(
							new Set(ref.keys()),
						)
						for (const state of vessels.getAll()) {
							expect(Date.parse(state.lastSeen)).toBe(ref.get(state.mmsi))
						}
					} finally {
						vessels.stop()
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
