import { afterEach, describe, expect, it, vi } from "vitest"
import { AircraftTracker } from "../../../../src/core/aircraft-tracker.js"
import { CoverageManager } from "../../../../src/core/coverage/coverage-manager.js"
import { createLogger } from "../../../../src/utils/logger.js"

const T0 = Date.parse("2026-10-16T12:00:00.000Z")

describe("CoverageManager with the real AircraftTracker", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not recount a retained position on non-position messages", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const tracker = new AircraftTracker(
			{
				maxAge: 3600,
				cleanupInterval: 5000,
				maxTrackPoints: 100,
				minTrackDistance: 50,
			},
			createLogger({ level: "error" }),
		)
		const manager = new CoverageManager({
			station: { lat: 51.5, lon: -0.1 },
			aircraft: tracker,
			now: () => Date.now(),
		})
		manager.start()
		const accepted = () => manager.query("adsb").protocols[0]?.accepted ?? 0

		tracker.processUpdate({ hex: "ABC123", lat: 52, lon: -0.12, seen_pos: 0 })
		expect(accepted()).toBe(1)
		for (let i = 1; i <= 3; i++) {
			vi.setSystemTime(T0 + i * 3_600_000)
			tracker.processUpdate({ hex: "ABC123", flight: "TEST" })
		}
		expect(accepted()).toBe(1)
		expect(manager.query("adsb").protocols[0]?.sectors[0]?.at).toBe(
			new Date(T0).toISOString(),
		)
		tracker.processUpdate({ hex: "ABC123", lat: 52.1, lon: -0.12, seen_pos: 0 })
		expect(accepted()).toBe(2)
		manager.stop()
	})
})
