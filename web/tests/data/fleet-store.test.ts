import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CoverageStore } from "../../src/data/coverage-store.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { FleetStore } from "../../src/data/fleet-store.ts"
import {
	AIRCRAFT_SPEC,
	MESH_SPEC,
	VESSEL_SPEC,
	type Aircraft,
	type Vessel,
} from "../../src/data/fleets.ts"
import { json, scripted } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const CORE_NOW = Date.parse("2026-10-17T10:00:00.000Z")

function vessel(over: Partial<Vessel> = {}): Vessel {
	return {
		mmsi: "227300410",
		vesselClass: "A",
		name: "Enez Vaz",
		callsign: null,
		imo: null,
		shipType: 60,
		destination: "Île de Batz",
		eta: null,
		draught: null,
		position: { lat: 48.735, lon: -3.9965, at: "2026-10-17T09:59:50.000Z" },
		cog: 300,
		sog: 8,
		heading: 300,
		navStatus: 0,
		messageTypes: [1, 3],
		messageCount: 10,
		decoderId: "ais-catcher",
		firstSeen: "2026-10-17T09:00:00.000Z",
		lastSeen: "2026-10-17T09:59:55.000Z",
		lastStaticAt: null,
		...over,
	}
}

function aircraft(over: Partial<Aircraft> = {}): Aircraft {
	return {
		icao: "3944EF",
		callsign: "AFR1234",
		position: { lat: 48.81, lon: -3.87 },
		velocity: { gs: 452, track: 284 },
		altitude: { baro: 36000 },
		seen: 0.5,
		seenPos: 1,
		messages: 100,
		firstSeen: CORE_NOW - 60_000,
		lastUpdated: CORE_NOW,
		...over,
	}
}

describe("FleetStore", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	const setup = (handler: Parameters<typeof scripted>[0]) => {
		const { api, calls } = scripted(handler)
		const sockets = fakeSockets()
		const events = new EventsClient({
			url: "ws://x/ws",
			createSocket: sockets.factory,
		})
		events.connect()
		sockets.last().open()
		return { api, calls, events, sockets }
	}

	it("loads the snapshot, converting the core's times into this browser's clock", async () => {
		const { api, events, sockets } = setup(() =>
			json(200, {
				vessels: [vessel(), { mmsi: 12 }],
				stats: {},
				timestamp: new Date(CORE_NOW).toISOString(),
			}),
		)
		const store = new FleetStore(api, events, VESSEL_SPEC)
		const detach = store.attach()
		await store.load()
		const s = store.get()
		expect(s.status).toBe("live")
		// the invalid row is dropped
		expect([...s.entries.keys()]).toEqual(["227300410"])
		const e = s.entries.get("227300410")
		const browserNow = Date.now()
		// position 10 s before the core's answer, heard 5 s before it
		expect(e?.posAt).toBe(browserNow - 10_000)
		expect(e?.heardAt).toBe(browserNow - 5_000)
		expect(e?.trail).toHaveLength(1)
		expect(sockets.last().sent).toContainEqual({
			type: "subscribe",
			channels: ["vessels"],
		})
		detach()
		expect(sockets.last().sent).toContainEqual({
			type: "unsubscribe",
			channels: ["vessels"],
		})
		expect(store.get().status).toBe("idle")
	})

	it("batches WebSocket updates into one published change per flush window", async () => {
		const { api, events, sockets } = setup(() =>
			json(200, {
				aircraft: [],
				stats: {},
				timestamp: CORE_NOW,
			}),
		)
		const store = new FleetStore(api, events, AIRCRAFT_SPEC, { flushMs: 250 })
		store.attach()
		await store.load()
		const published = vi.fn()
		store.subscribe(published)
		const socket = sockets.last()
		for (let i = 0; i < 20; i++)
			socket.receive({
				type: "aircraft:update",
				data: aircraft({
					position: { lat: 48.81 + i * 0.01, lon: -3.87 },
				}),
			})
		socket.receive({
			type: "aircraft:new",
			data: aircraft({ icao: "ABCDEF", callsign: "EZY12" }),
		})
		socket.receive({ type: "aircraft:update", data: { icao: 3 } })
		expect(published).not.toHaveBeenCalled()
		vi.advanceTimersByTime(250)
		expect(published).toHaveBeenCalledTimes(1)
		const entries = store.get().entries
		expect(entries.size).toBe(2)
		expect(entries.get("3944EF")?.value.position?.lat).toBeCloseTo(49.0)
		socket.receive({
			type: "aircraft:lost",
			data: { icao: "ABCDEF", aircraft: aircraft({ icao: "ABCDEF" }) },
		})
		vi.advanceTimersByTime(250)
		expect(published).toHaveBeenCalledTimes(2)
		expect(store.get().entries.has("ABCDEF")).toBe(false)
	})

	it("takes the aircraft trail from the core's track history, oldest first", async () => {
		const { api, events } = setup(() =>
			json(200, {
				aircraft: [
					aircraft({
						trackHistory: [
							{
								lat: 48.82,
								lon: -3.88,
								altitude: 36000,
								timestamp: CORE_NOW - 1000,
							},
							{
								lat: 48.8,
								lon: -3.86,
								altitude: 36000,
								timestamp: CORE_NOW - 16_000,
							},
						],
					}),
				],
				stats: {},
				timestamp: CORE_NOW,
			}),
		)
		const store = new FleetStore(api, events, AIRCRAFT_SPEC)
		store.attach()
		await store.load()
		const e = store.get().entries.get("3944EF")
		expect(e?.trailFromCore).toBe(true)
		expect(e?.trail.map(p => p.lat)).toEqual([48.8, 48.82])
		expect(e?.trail[0]?.at).toBe(Date.now() - 16_000)
	})

	it("builds other trails from the positions seen since the page opened", async () => {
		const { api, events, sockets } = setup(() =>
			json(200, {
				vessels: [vessel()],
				stats: {},
				timestamp: new Date(CORE_NOW).toISOString(),
			}),
		)
		const store = new FleetStore(api, events, VESSEL_SPEC, { flushMs: 0 })
		store.attach()
		await store.load()
		const socket = sockets.last()
		const at = (s: number) => new Date(CORE_NOW + s * 1000).toISOString()
		// same place again: no new point
		socket.receive({
			type: "vessel:update",
			data: vessel({
				position: { lat: 48.735, lon: -3.9965, at: at(5) },
				lastSeen: at(5),
			}),
		})
		vi.advanceTimersByTime(1)
		socket.receive({
			type: "vessel:update",
			data: vessel({
				position: { lat: 48.737, lon: -3.999, at: at(10) },
				lastSeen: at(10),
			}),
		})
		vi.advanceTimersByTime(1)
		const e = store.get().entries.get("227300410")
		expect(e?.trailFromCore).toBe(false)
		expect(e?.trail.map(p => p.lat)).toEqual([48.735, 48.737])
	})

	it("is unavailable when the core does not run the tracker, and reloads after a reconnect", async () => {
		let status = 404
		const { api, events, sockets, calls } = setup(() =>
			status === 404
				? json(404, {
						error: "Not Found",
						code: "NOT_FOUND",
						message: "Route GET:/api/mesh/nodes not found",
					})
				: json(200, {
						nodes: [],
						stats: {},
						timestamp: new Date(CORE_NOW).toISOString(),
					}),
		)
		const store = new FleetStore(api, events, MESH_SPEC)
		store.attach()
		await store.load()
		expect(store.get()).toMatchObject({ status: "unavailable", error: null })
		status = 200
		sockets.last().drop()
		await vi.advanceTimersByTimeAsync(1000)
		sockets.last().open()
		await vi.advanceTimersByTimeAsync(0)
		// the reconnect reloaded the list
		expect(calls.length).toBe(2)
		expect(store.get().status).toBe("live")
	})
})

describe("CoverageStore", () => {
	it("loads, refreshes while attached and says when the route is missing", async () => {
		vi.useFakeTimers()
		let n = 0
		const { api } = scripted(() => {
			n += 1
			return n === 3
				? json(404, { error: "Not Found", code: "NOT_FOUND", message: "x" })
				: json(200, {
						available: false,
						reason: "no-station-location",
						station: null,
						windowHours: 24,
						bearingStepDeg: 1,
						protocols: [],
						rejected: {
							"invalid-position": 0,
							"too-far": 0,
							stale: 0,
							"no-station": 3,
						},
						timestamp: "2026-10-17T10:00:00.000Z",
					})
		})
		const store = new CoverageStore(api, { refreshMs: 1000 })
		const detach = store.attach()
		await vi.advanceTimersByTimeAsync(0)
		expect(store.get()).toMatchObject({
			status: "ready",
			coverage: { available: false, reason: "no-station-location" },
		})
		await vi.advanceTimersByTimeAsync(1000)
		expect(n).toBe(2)
		await vi.advanceTimersByTimeAsync(1000)
		expect(store.get().status).toBe("unavailable")
		detach()
		await vi.advanceTimersByTimeAsync(5000)
		expect(n).toBe(3)
		vi.useRealTimers()
	})
})
