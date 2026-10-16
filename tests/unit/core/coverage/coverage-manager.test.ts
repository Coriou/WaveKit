import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { CoverageManager } from "../../../../src/core/coverage/coverage-manager.js"
import type { AircraftState, VesselState } from "@wavekit/api-types"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const STATION = { lat: 0, lon: 0 }

function aircraft(over: Partial<AircraftState> = {}): AircraftState {
	return {
		icao: "ABC123",
		position: { lat: 0.5, lon: 0 },
		lastUpdated: NOW,
		...over,
	} as AircraftState
}

function vessel(over: Partial<VesselState> = {}): VesselState {
	return {
		mmsi: "123456789",
		position: { lat: 0, lon: 0.5, at: new Date(NOW - 5000).toISOString() },
		...over,
	} as VesselState
}

function setup(station: typeof STATION | null = STATION) {
	const air = new EventEmitter()
	const ves = new EventEmitter()
	const manager = new CoverageManager({
		station,
		aircraft: air,
		vessels: ves,
		now: () => NOW,
	})
	manager.start()
	return { air, ves, manager }
}

const accepted = (m: CoverageManager, p: "adsb" | "ais") =>
	m.query().protocols.find(x => x.protocol === p)?.accepted ?? 0

describe("CoverageManager", () => {
	it("counts new and update events", () => {
		const { air, ves, manager } = setup()
		air.emit("aircraft:new", aircraft())
		ves.emit("vessel:new", vessel())
		expect(accepted(manager, "adsb")).toBe(1)
		expect(accepted(manager, "ais")).toBe(1)
		air.emit("aircraft:update", aircraft({ lastUpdated: NOW + 1000 }))
		expect(accepted(manager, "adsb")).toBe(2)
	})

	it("counts a repeated update without a new position once", () => {
		const { air, ves, manager } = setup()
		air.emit("aircraft:new", aircraft())
		air.emit("aircraft:update", aircraft())
		ves.emit("vessel:new", vessel())
		ves.emit("vessel:update", vessel())
		expect(accepted(manager, "adsb")).toBe(1)
		expect(accepted(manager, "ais")).toBe(1)
	})

	it("lost clears the entity so the same time counts again", () => {
		const { air, ves, manager } = setup()
		air.emit("aircraft:new", aircraft())
		air.emit("aircraft:lost", "ABC123", aircraft())
		air.emit("aircraft:new", aircraft())
		ves.emit("vessel:new", vessel())
		ves.emit("vessel:lost", "123456789", vessel())
		ves.emit("vessel:new", vessel())
		expect(accepted(manager, "adsb")).toBe(2)
		expect(accepted(manager, "ais")).toBe(2)
	})

	it("subtracts seenPos seconds from lastUpdated", () => {
		const { manager } = setup()
		manager.observeAircraft(aircraft({ seenPos: 30 }))
		// 30 s old is accepted (limit 60 s)
		expect(accepted(manager, "adsb")).toBe(1)
		const sector = manager.query("adsb").protocols[0]?.sectors[0]
		expect(sector?.at).toBe(new Date(NOW - 30_000).toISOString())
		manager.observeAircraft(aircraft({ icao: "DEF456", seenPos: 120 }))
		expect(accepted(manager, "adsb")).toBe(1)
		expect(manager.query().rejected.stale).toBe(1)
	})

	it("parses the vessel position time", () => {
		const { manager } = setup()
		manager.observeVessel(vessel())
		const sector = manager.query("ais").protocols[0]?.sectors[0]
		expect(sector?.at).toBe(new Date(NOW - 5000).toISOString())
	})

	it("skips entities without a position or with a bad time", () => {
		const { manager } = setup()
		const noPos = aircraft()
		delete noPos.position
		manager.observeAircraft(noPos)
		manager.observeVessel(vessel({ position: null }))
		manager.observeVessel(
			vessel({ position: { lat: 0, lon: 0.5, at: "garbage" } }),
		)
		expect(accepted(manager, "adsb")).toBe(0)
		expect(accepted(manager, "ais")).toBe(0)
	})

	it("start is idempotent and stop removes every listener", () => {
		const { air, ves, manager } = setup()
		manager.start()
		const events = [
			[air, "aircraft:new"],
			[air, "aircraft:update"],
			[air, "aircraft:lost"],
			[ves, "vessel:new"],
			[ves, "vessel:update"],
			[ves, "vessel:lost"],
		] as const
		for (const [e, name] of events) expect(e.listenerCount(name)).toBe(1)
		manager.stop()
		for (const [e, name] of events) expect(e.listenerCount(name)).toBe(0)
	})

	it("reports unavailable without a station", () => {
		const { air, manager } = setup(null)
		air.emit("aircraft:new", aircraft())
		const res = manager.query()
		expect(res.available).toBe(false)
		expect(res.reason).toBe("no-station-location")
		expect(res.protocols).toEqual([])
	})
})
