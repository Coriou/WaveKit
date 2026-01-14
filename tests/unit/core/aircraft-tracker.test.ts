/**
 * Aircraft Tracker Unit Tests
 *
 * Tests for the AircraftTracker state aggregation service.
 * This is an ADS-B-specific component that does NOT affect other decoders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	AircraftTracker,
	type AircraftTrackerConfig,
} from "../../../src/core/aircraft-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { RawAircraftMessage, AircraftState } from "@wavekit/api-types"

// Create a test logger
const testLogger = createLogger({ level: "error" })

/**
 * Helper to create a raw aircraft message for testing
 */
function createRawMessage(
	overrides: Partial<RawAircraftMessage> = {},
): RawAircraftMessage {
	return {
		hex: "ABC123",
		...overrides,
	}
}

/**
 * Helper to wait for a promise with a timeout
 */
function waitForEvent<T>(
	tracker: AircraftTracker,
	event: "aircraft:new" | "aircraft:update" | "aircraft:lost",
	timeout = 1000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Timeout waiting for ${event}`))
		}, timeout)

		tracker.once(event, (...args: unknown[]) => {
			clearTimeout(timer)
			resolve(args[0] as T)
		})
	})
}

describe("AircraftTracker", () => {
	let tracker: AircraftTracker
	const config: AircraftTrackerConfig = {
		maxAge: 60,
		cleanupInterval: 5000,
		maxTrackPoints: 100,
		minTrackDistance: 50,
	}

	beforeEach(() => {
		tracker = new AircraftTracker(config, testLogger)
	})

	afterEach(() => {
		tracker.stop()
	})

	describe("processUpdate - New Aircraft", () => {
		it("should create new aircraft on first message", () => {
			const raw = createRawMessage({ hex: "ABC123", flight: "UAL123" })
			tracker.processUpdate(raw)

			const aircraft = tracker.get("ABC123")
			expect(aircraft).toBeDefined()
			expect(aircraft!.icao).toBe("ABC123")
			expect(aircraft!.callsign).toBe("UAL123")
		})

		it("should emit aircraft:new event for new aircraft", async () => {
			const eventPromise = waitForEvent<AircraftState>(tracker, "aircraft:new")
			const raw = createRawMessage({ hex: "DEF456" })
			tracker.processUpdate(raw)

			const aircraft = await eventPromise
			expect(aircraft.icao).toBe("DEF456")
		})

		it("should normalize ICAO to uppercase", () => {
			const raw = createRawMessage({ hex: "abc123" })
			tracker.processUpdate(raw)

			expect(tracker.get("ABC123")).toBeDefined()
			expect(tracker.get("abc123")).toBeDefined() // get() also normalizes
		})

		it("should strip ~ prefix from ICAO", () => {
			const raw = createRawMessage({ hex: "~ABC123" })
			tracker.processUpdate(raw)

			expect(tracker.get("ABC123")).toBeDefined()
		})

		it("should ignore messages without hex", () => {
			const raw = { flight: "UAL123" } as RawAircraftMessage
			tracker.processUpdate(raw)

			expect(tracker.getAll()).toHaveLength(0)
		})
	})

	describe("processUpdate - State Aggregation", () => {
		it("should merge updates into existing aircraft", () => {
			// First message with callsign
			tracker.processUpdate(
				createRawMessage({ hex: "ABC123", flight: "UAL123" }),
			)

			// Second message with squawk
			tracker.processUpdate(createRawMessage({ hex: "ABC123", squawk: "1200" }))

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.callsign).toBe("UAL123")
			expect(aircraft!.squawk).toBe("1200")
		})

		it("should emit aircraft:update for subsequent messages", async () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))

			const eventPromise = waitForEvent<AircraftState>(
				tracker,
				"aircraft:update",
			)
			tracker.processUpdate(createRawMessage({ hex: "ABC123", squawk: "7700" }))

			const aircraft = await eventPromise
			expect(aircraft.squawk).toBe("7700")
		})

		it("should update message count", () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123", messages: 10 }))
			tracker.processUpdate(createRawMessage({ hex: "ABC123", messages: 15 }))

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.messages).toBe(15)
		})

		it("should update lastUpdated timestamp", async () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			const first = tracker.get("ABC123")!.lastUpdated

			await new Promise(resolve => setTimeout(resolve, 10))
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			const second = tracker.get("ABC123")!.lastUpdated

			expect(second).toBeGreaterThan(first)
		})
	})

	describe("Position and Track History", () => {
		it("should create position from lat/lon", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.position).toBeDefined()
			expect(aircraft!.position!.lat).toBe(45.5)
			expect(aircraft!.position!.lon).toBe(-122.6)
		})

		it("should add track history on position update", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.trackHistory).toHaveLength(1)
			expect(aircraft!.trackHistory![0]!.lat).toBe(45.5)
		})

		it("should not add track point if distance < minTrackDistance", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
				}),
			)

			// Tiny position change (< 50m)
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.50001,
					lon: -122.60001,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.trackHistory).toHaveLength(1)
		})

		it("should add track point if distance >= minTrackDistance", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
				}),
			)

			// Significant position change (> 50m)
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.51,
					lon: -122.61,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.trackHistory!.length).toBeGreaterThanOrEqual(2)
		})

		it("should limit track history to maxTrackPoints", () => {
			const limitedTracker = new AircraftTracker(
				{ ...config, maxTrackPoints: 3, minTrackDistance: 0 },
				testLogger,
			)

			// Add more points than the limit
			for (let i = 0; i < 5; i++) {
				limitedTracker.processUpdate(
					createRawMessage({
						hex: "ABC123",
						lat: 45.5 + i * 0.1,
						lon: -122.6 + i * 0.1,
					}),
				)
			}

			const aircraft = limitedTracker.get("ABC123")
			expect(aircraft!.trackHistory).toHaveLength(3)

			limitedTracker.stop()
		})

		it("should include altitude in track point", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
					alt_baro: 35000,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.trackHistory![0]!.altitude).toBe(35000)
		})

		it("should set altitude to null when on ground", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					lat: 45.5,
					lon: -122.6,
					alt_baro: "ground",
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.trackHistory![0]!.altitude).toBeNull()
		})
	})

	describe("Velocity Data", () => {
		it("should parse ground speed", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					gs: 450,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.velocity).toBeDefined()
			expect(aircraft!.velocity!.gs).toBe(450)
		})

		it("should parse track and heading", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					track: 180,
					mag_heading: 182,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.velocity!.track).toBe(180)
			expect(aircraft!.velocity!.magHeading).toBe(182)
		})
	})

	describe("Altitude Data", () => {
		it("should parse barometric altitude", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					alt_baro: 35000,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.altitude).toBeDefined()
			expect(aircraft!.altitude!.baro).toBe(35000)
			expect(aircraft!.altitude!.onGround).toBe(false)
		})

		it("should set onGround when alt_baro is ground", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					alt_baro: "ground",
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.altitude!.baro).toBeNull()
			expect(aircraft!.altitude!.onGround).toBe(true)
		})

		it("should parse geometric altitude", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					alt_geom: 35100,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.altitude!.geom).toBe(35100)
		})
	})

	describe("Navigation Data", () => {
		it("should parse nav modes", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					nav_modes: ["autopilot", "vnav", "lnav"],
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.navigation).toBeDefined()
			expect(aircraft!.navigation!.modes).toEqual(["autopilot", "vnav", "lnav"])
		})

		it("should parse selected altitude", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					nav_altitude_mcp: 38000,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.navigation!.altitudeMcp).toBe(38000)
		})
	})

	describe("Identification Data", () => {
		it("should parse registration from readsb", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					r: "N12345",
					t: "B738",
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.identification).toBeDefined()
			expect(aircraft!.identification!.registration).toBe("N12345")
			expect(aircraft!.identification!.typeCode).toBe("B738")
			expect(aircraft!.identification!.source).toBe("readsb")
		})
	})

	describe("Signal Quality", () => {
		it("should parse RSSI", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					rssi: -20.5,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.signalQuality).toBeDefined()
			expect(aircraft!.signalQuality!.rssi).toBe(-20.5)
		})

		it("should parse ADS-B version", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					version: 2,
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.signalQuality!.adsbVersion).toBe(2)
		})
	})

	describe("Category and Emergency", () => {
		it("should parse emitter category", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					category: "A3",
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.category).toBe("A3")
		})

		it("should parse emergency status", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					emergency: "general",
				}),
			)

			const aircraft = tracker.get("ABC123")
			expect(aircraft!.emergency).toBe("general")
		})
	})

	describe("Cleanup", () => {
		it("should remove stale aircraft", async () => {
			const fastCleanup = new AircraftTracker(
				{ ...config, maxAge: 0.1, cleanupInterval: 50 },
				testLogger,
			)

			fastCleanup.processUpdate(createRawMessage({ hex: "ABC123" }))
			expect(fastCleanup.get("ABC123")).toBeDefined()

			fastCleanup.start()

			// Wait for cleanup
			await new Promise(resolve => setTimeout(resolve, 200))

			expect(fastCleanup.get("ABC123")).toBeUndefined()
			fastCleanup.stop()
		})

		it("should emit aircraft:lost when removing stale aircraft", async () => {
			const fastCleanup = new AircraftTracker(
				{ ...config, maxAge: 0.1, cleanupInterval: 50 },
				testLogger,
			)

			fastCleanup.processUpdate(createRawMessage({ hex: "ABC123" }))

			const lostPromise = new Promise<string>(resolve => {
				fastCleanup.on("aircraft:lost", (icao: string) => {
					resolve(icao)
				})
			})

			fastCleanup.start()
			const icao = await lostPromise
			expect(icao).toBe("ABC123")

			fastCleanup.stop()
		})
	})

	describe("Statistics", () => {
		it("should return accurate statistics", () => {
			tracker.processUpdate(
				createRawMessage({
					hex: "ABC123",
					flight: "UAL123",
					lat: 45.5,
					lon: -122.6,
				}),
			)
			tracker.processUpdate(
				createRawMessage({ hex: "DEF456", lat: 46.5, lon: -123.6 }),
			)
			tracker.processUpdate(createRawMessage({ hex: "GHI789" }))

			const stats = tracker.getStats()
			expect(stats.aircraftCount).toBe(3)
			expect(stats.withPosition).toBe(2)
			expect(stats.withCallsign).toBe(1)
		})

		it("should track messages processed", () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			tracker.processUpdate(createRawMessage({ hex: "DEF456" }))

			const stats = tracker.getStats()
			expect(stats.messagesProcessed).toBe(3)
		})
	})

	describe("Retrieval Methods", () => {
		it("should getAll return all aircraft", () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			tracker.processUpdate(createRawMessage({ hex: "DEF456" }))

			const all = tracker.getAll()
			expect(all).toHaveLength(2)
			expect(all.map(a => a.icao).sort()).toEqual(["ABC123", "DEF456"])
		})

		it("should get return undefined for non-existent aircraft", () => {
			expect(tracker.get("NONEXISTENT")).toBeUndefined()
		})

		it("should return size", () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			tracker.processUpdate(createRawMessage({ hex: "DEF456" }))

			expect(tracker.size).toBe(2)
		})
	})

	describe("Lifecycle", () => {
		it("should start and stop cleanly", () => {
			expect(() => tracker.start()).not.toThrow()
			expect(() => tracker.stop()).not.toThrow()
		})

		it("should clear aircraft on stop", () => {
			tracker.processUpdate(createRawMessage({ hex: "ABC123" }))
			tracker.start()
			tracker.stop()

			expect(tracker.getAll()).toHaveLength(0)
		})
	})
})
