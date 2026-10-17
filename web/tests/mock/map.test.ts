import Fastify from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

import { coverageSchema } from "../../src/data/coverage-store.ts"
import {
	aircraftSchema,
	aprsSchema,
	meshSchema,
	vesselSchema,
} from "../../src/data/fleets.ts"
import { onLand } from "../../mock/coastline.ts"
import {
	ROSCOFF,
	distKm,
	makeMesh,
	makeVessels,
	meshAt,
	multiplyFleet,
	registerMapMock,
	vesselAt,
} from "../../mock/map.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock map routes", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const get = (url: string) => server.app.inject({ method: "GET", url })

	it("lists the board's aircraft in the core's shape, with a track history", async () => {
		const body = (await get("/api/aircraft")).json<{
			aircraft: unknown[]
			stats: { aircraftCount: number; withPosition: number }
			timestamp: number
		}>()
		expect(typeof body.timestamp).toBe("number")
		expect(body.aircraft).toHaveLength(34)
		expect(body.stats).toMatchObject({ aircraftCount: 34, withPosition: 34 })
		const list = body.aircraft.map(a => aircraftSchema.parse(a))
		const afr = list.find(a => a.callsign === "AFR1234")
		expect(afr).toMatchObject({ icao: "3944EF", altitude: { baro: 36000 } })
		expect(afr?.trackHistory?.length).toBeGreaterThan(0)
		// most recent first
		const h = afr?.trackHistory ?? []
		expect((h[0]?.timestamp ?? 0) >= (h[h.length - 1]?.timestamp ?? 0)).toBe(
			true,
		)
		expect((await get("/api/aircraft/3944ef")).json()).toMatchObject({
			icao: "3944EF",
		})
		const missing = await get("/api/aircraft/ABCDEF")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toEqual({
			error: "Aircraft not found",
			icao: "ABCDEF",
		})
	})

	it("lists vessels with aids to navigation, and the core's MMSI errors", async () => {
		const body = (await get("/api/vessels")).json<{
			vessels: unknown[]
			stats: { byClass: Record<string, number> }
			timestamp: string
		}>()
		const list = body.vessels.map(v => vesselSchema.parse(v))
		expect(list).toHaveLength(15)
		expect(body.stats.byClass["aton"]).toBe(2)
		const batz = list.find(v => v.name === "Phare de l’île de Batz")
		expect(batz).toMatchObject({
			vesselClass: "aton",
			aton: { aidType: 5, virtual: false },
		})
		expect(list.find(v => v.name === "Belle Étoile")).toMatchObject({
			navStatus: 5,
		})
		expect((await get("/api/vessels/abc")).json()).toEqual({
			error: "MMSI must be 1-9 digits",
			code: "VALIDATION_ERROR",
		})
		expect((await get("/api/vessels/1")).json()).toEqual({
			error: "Vessel not found",
			code: "VESSEL_NOT_FOUND",
			mmsi: "000000001",
		})
		expect((await get("/api/vessels/227300410")).statusCode).toBe(200)
	})

	it("lists APRS stations with a weather station and the key grammar", async () => {
		const body = (await get("/api/aprs/stations")).json<{
			stations: unknown[]
		}>()
		const list = body.stations.map(s => aprsSchema.parse(s))
		expect(list).toHaveLength(6)
		const wx = list.find(s => s.callsign === "F6XYZ-13")
		expect(wx?.weather).toMatchObject({
			humidityPct: 78,
			windDirectionDeg: 270,
		})
		expect(wx?.key).toBe("callsign:F6XYZ-13")
		expect((await get("/api/aprs/stations/callsign:F4ABC-9")).statusCode).toBe(
			200,
		)
		expect((await get("/api/aprs/stations/nope")).json()).toMatchObject({
			code: "VALIDATION_ERROR",
		})
		expect((await get("/api/aprs/stations/callsign:F9ZZZ")).json()).toEqual({
			error: "APRS station not found",
			code: "APRS_STATION_NOT_FOUND",
			key: "callsign:F9ZZZ",
		})
	})

	it("lists mesh nodes with neighbour links and telemetry", async () => {
		const body = (await get("/api/mesh/nodes")).json<{ nodes: unknown[] }>()
		const list = body.nodes.map(n => meshSchema.parse(n))
		expect(list).toHaveLength(4)
		const relay = list.find(n => n.longName === "Harbour relay")
		expect(relay?.neighbours?.map(n => [n.nodeId, n.snrDb])).toEqual([
			["!9be011a7", 9],
			["!77c0de02", 3.5],
			["!0fe12a6b", 6.5],
		])
		expect(
			list.find(n => n.longName === "Lighthouse")?.telemetry,
		).toMatchObject({ batteryPct: 81 })
		expect((await get("/api/mesh/nodes/!A3F2C1D4")).json()).toMatchObject({
			nodeId: "!a3f2c1d4",
		})
		expect((await get("/api/mesh/nodes/a3f2")).json()).toMatchObject({
			code: "VALIDATION_ERROR",
		})
		expect((await get("/api/mesh/nodes/!00000000")).statusCode).toBe(404)
	})

	it("serves coverage around the station, per protocol", async () => {
		const all = coverageSchema.parse((await get("/api/coverage")).json())
		expect(all.available).toBe(true)
		expect(all.station).toEqual({ lat: ROSCOFF[0], lon: ROSCOFF[1] })
		expect(all.protocols.map(p => p.protocol)).toEqual(["adsb", "ais"])
		expect(all.protocols[0]?.sectors).toHaveLength(360)
		const ais = coverageSchema.parse(
			(await get("/api/coverage?protocol=ais")).json(),
		)
		expect(ais.protocols.map(p => p.protocol)).toEqual(["ais"])
		const bad = await get("/api/coverage?protocol=vhf")
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toEqual({
			error: "protocol must be one of: adsb, ais",
			code: "VALIDATION_ERROR",
		})
	})

	it("says when the station has no location", async () => {
		const app = Fastify()
		registerMapMock(app, { broadcast: () => {}, station: () => null })
		await app.ready()
		const body = coverageSchema.parse(
			(await app.inject({ method: "GET", url: "/api/coverage" })).json(),
		)
		expect(body).toMatchObject({
			available: false,
			reason: "no-station-location",
			station: null,
			protocols: [],
		})
		await app.close()
	})
})

describe("mock map traffic", () => {
	it("keeps every vessel at sea along its whole cycle (aids to navigation excepted)", () => {
		const bad: string[] = []
		// aids to navigation stand where they stand (the Batz lighthouse is on the island)
		for (const v of makeVessels().filter(x => x.vesselClass !== "aton")) {
			for (let t = 0; t < 4 * 3600; t += 20) {
				const p = vesselAt(v, t)
				// a berth sits on the simplified coastline's edge: allow 150 m around it
				const atBerth =
					v.dwellS > 0 &&
					(distKm(v.a, [p.lat, p.lon]) < 0.15 ||
						distKm(v.b, [p.lat, p.lon]) < 0.15)
				if (!atBerth && onLand(p.lat, p.lon)) {
					bad.push(
						`${v.name} at ${t}s (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)})`,
					)
					break
				}
			}
		}
		expect(bad).toEqual([])
		const kayak = makeMesh().find(m => m.longName === "Kayak")
		for (let t = 0; kayak && t < 7200; t += 30) {
			const p = meshAt(kayak, t)
			expect(onLand(p.lat, p.lon)).toBe(false)
		}
	})

	it("ferries and the Batz shuttle wait at their berth before leaving", () => {
		const shuttle = makeVessels().find(v => v.name === "Enez Vaz")
		expect(shuttle).toBeDefined()
		if (!shuttle) return
		// the cycle starts at the berth: before the phase, the shuttle sits there, moored
		const atBerth = vesselAt(shuttle, -shuttle.phaseS + 10)
		expect(atBerth.moored).toBe(true)
		expect(distKm(shuttle.a, [atBerth.lat, atBerth.lon])).toBeLessThan(0.01)
		const sailing = vesselAt(shuttle, 0)
		expect(sailing.moored).toBe(false)
		expect(sailing.sog).toBe(8)
	})

	it("sends vessel, APRS and mesh updates at most every 2 s per entity, aircraft every tick", async () => {
		let clock = 1_000_000
		const sent: { channel: string; type: string; key: string; at: number }[] =
			[]
		const app = Fastify()
		const mock = registerMapMock(app, {
			broadcast: (channel, type, data) => {
				const d = data as Record<string, unknown>
				const key = String(
					d["icao"] ?? d["mmsi"] ?? d["key"] ?? d["nodeId"] ?? "",
				)
				sent.push({ channel, type, key, at: clock })
			},
			station: () => ({ lat: ROSCOFF[0], lon: ROSCOFF[1] }),
			now: () => clock,
			tickMs: 1e9,
		})
		for (let i = 0; i < 300; i++) {
			clock += 1000
			mock.tick()
		}
		const updates = sent.filter(s => s.type.endsWith(":update"))
		expect(
			updates.filter(s => s.channel === "aircraft").length,
		).toBeGreaterThan(30 * 290)
		for (const ch of ["vessels", "aprs", "mesh"]) {
			const mine = updates.filter(s => s.channel === ch)
			expect(mine.length).toBeGreaterThan(0)
			const last = new Map<string, number>()
			for (const s of mine) {
				const prev = last.get(s.key)
				if (prev !== undefined) expect(s.at - prev).toBeGreaterThanOrEqual(2000)
				last.set(s.key, s.at)
			}
		}
		await app.close()
	})
})

describe("mock map WebSocket", () => {
	let server: MockServer
	let api = ""
	beforeAll(async () => {
		server = await buildMockServer({ port: 0, audioPort: 0 })
		api = (await server.listen()).apiUrl
	})
	afterAll(async () => {
		await server.close()
	})

	it("streams aircraft updates on the aircraft channel", async () => {
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const got = await new Promise<{ type: string; data: unknown }>(
			(resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no update")), 4000)
				socket.on("open", () =>
					socket.send(
						JSON.stringify({ type: "subscribe", channels: ["aircraft"] }),
					),
				)
				socket.on("message", raw => {
					const msg = JSON.parse(String(raw)) as { type: string; data: unknown }
					if (msg.type === "aircraft:update") {
						clearTimeout(timer)
						resolve(msg)
					}
				})
			},
		)
		socket.close()
		expect(aircraftSchema.safeParse(got.data).success).toBe(true)
	})
})

describe("mock load multiplier", () => {
	it("adds load - 1 distinct copies of each entity", () => {
		const base = makeVessels()
		const out = multiplyFleet(base, 3, (v, k) => ({
			...v,
			mmsi: `${v.mmsi}-${k}`,
		}))
		expect(out).toHaveLength(base.length * 3)
		expect(new Set(out.map(v => v.mmsi)).size).toBe(out.length)
		expect(multiplyFleet(base, 0.5, v => v)).toHaveLength(base.length)
	})

	it("serves load × the aircraft", async () => {
		const app = Fastify()
		registerMapMock(app, {
			broadcast: () => {},
			station: () => ({ lat: ROSCOFF[0], lon: ROSCOFF[1] }),
			load: 4,
		})
		const one = Fastify()
		registerMapMock(one, {
			broadcast: () => {},
			station: () => ({ lat: ROSCOFF[0], lon: ROSCOFF[1] }),
		})
		const count = async (a: typeof app) =>
			(
				(await a.inject({ url: "/api/aircraft" })).json() as {
					aircraft: { icao: string }[]
				}
			).aircraft
		const [many, few] = await Promise.all([count(app), count(one)])
		expect(many.length).toBe(few.length * 4)
		expect(new Set(many.map(a => a.icao)).size).toBe(many.length)
		await Promise.all([app.close(), one.close()])
	})
})
