/**
 * Aircraft identity links: observation from decoder output, evidence, lifetimes, conflicts and
 * the GET /api/aircraft-identity route. Identifiers are fictional.
 */
import { EventEmitter } from "node:events"
import Fastify from "fastify"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { aircraftIdentityRoutes } from "../../../src/api/routes/aircraft-identity.js"
import { AircraftIdentityManager } from "../../../src/core/aircraft-identity/manager.js"
import { observationsFrom } from "../../../src/core/aircraft-identity/observe.js"
import {
	AircraftIdentityRegistry,
	LINK_LIFETIME_MS,
	type IdentityObservation,
} from "../../../src/core/aircraft-identity/registry.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import { parseDumpvdl2Json } from "../../../src/decoders/builtin/dumpvdl2.js"
import { parseAcarsdecJson } from "../../../src/decoders/builtin/acarsdec.js"
import { loadLinkSample as loadVdl2 } from "../../mocks/fixtures/vdl2/index.js"
import { loadLinkSample as loadAcars } from "../../mocks/fixtures/acars/index.js"
import { createLogger } from "../../../src/utils/logger.js"

const T0 = new Date("2026-01-01T00:00:00.000Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

function out(type: string, data: unknown, at = T0): DecoderOutput {
	return { timestamp: at, decoder: "test", type, data } as DecoderOutput
}

function seen(
	a: IdentityObservation["a"],
	b: IdentityObservation["b"],
	at = T0,
	evidence: IdentityObservation["evidence"] = "observed",
): IdentityObservation {
	return { a, b, at, evidence, source: "vdl2" }
}

const ICAO = { kind: "icao", value: "0A0B01" } as const
const ICAO2 = { kind: "icao", value: "0A0B02" } as const
const REG = { kind: "reg", value: "N0WK01" } as const
const FLIGHT = { kind: "flight", value: "ZZ0101" } as const
const CALLSIGN = { kind: "callsign", value: "ZZZ101" } as const

describe("observations from decoder output", () => {
	it("a VDL2 frame carrying ACARS links its ICAO address to the registration and flight", () => {
		const [first] = loadVdl2()
		const obs = observationsFrom(out("vdl2", parseDumpvdl2Json(first as never)))
		expect(obs.map(o => [o.a, o.b])).toEqual([
			[ICAO, REG],
			[ICAO, FLIGHT],
		])
		expect(
			obs.every(o => o.evidence === "observed" && o.source === "vdl2"),
		).toBe(true)
	})

	it("an uplink addressed to the aircraft links it too; a ground broadcast does not", () => {
		const lines = loadVdl2().map(l => parseDumpvdl2Json(l as never))
		const media = observationsFrom(out("vdl2", lines[5]))
		expect(media.map(o => o.a)).toEqual([ICAO])
		expect(observationsFrom(out("vdl2", lines[3]))).toEqual([])
		expect(observationsFrom(out("vdl2", lines[1]))).toEqual([])
	})

	it("ACARS on VHF links the registration to the flight, never to an aircraft address", () => {
		const [first] = loadAcars()
		const obs = observationsFrom(
			out("acars", parseAcarsdecJson(first as never)),
		)
		expect(obs).toHaveLength(1)
		expect([obs[0]?.a, obs[0]?.b]).toEqual([
			{ kind: "reg", value: "N0WK03" },
			{ kind: "flight", value: "ZZ0303" },
		])
	})

	it("ADS-B links address and callsign only when the address is proven", () => {
		const proven = observationsFrom(
			out("aircraft", { icao: "0a0b01", callsign: "zzz101 " }),
		)
		expect(proven.map(o => [o.a, o.b])).toEqual([[ICAO, CALLSIGN]])
		const frame = (df: number, crcOk: boolean) =>
			observationsFrom(
				out("aircraft", {
					icao: "0A0B01",
					callsign: "ZZZ101",
					modeS: { df, crcOk, frame: "" },
				}),
			)
		expect(frame(17, true)).toHaveLength(1)
		expect(frame(17, false)).toEqual([])
		expect(frame(20, true)).toEqual([])
	})

	it("frames with errors or without both identifiers give nothing", () => {
		expect(
			observationsFrom(
				out("acars", { tail: ".N0WK01", flight: "ZZ0101", error: 1 }),
			),
		).toEqual([])
		expect(observationsFrom(out("acars", { tail: ".N0WK01" }))).toEqual([])
		expect(observationsFrom(out("ship", { mmsi: "1" }))).toEqual([])
		expect(observationsFrom(out("vdl2", "nonsense"))).toEqual([])
	})
})

describe("identity registry", () => {
	it("resolves a registration through an observed link", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO, REG))
		const r = reg.resolve(REG)
		expect(r).toMatchObject({
			icao: "0A0B01",
			resolvedBy: "observed",
			conflict: false,
		})
		expect(r.entityKeys).toEqual(["icao:0A0B01", "reg:N0WK01"])
		expect(r.links[0]?.expiresAt).toBe(
			new Date(T0.getTime() + LINK_LIFETIME_MS["icao|reg"]!).toISOString(),
		)
	})

	it("never resolves a callsign or flight number to an aircraft", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO, CALLSIGN))
		reg.observe(seen(ICAO, FLIGHT))
		for (const query of [CALLSIGN, FLIGHT]) {
			const r = reg.resolve(query)
			expect(r.icao).toBeNull()
			expect(r.resolvedBy).toBeNull()
			expect(r.entityKeys).toEqual([])
			expect(r.links).toHaveLength(1)
		}
	})

	it("a registration claimed by two aircraft is a conflict", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO, REG))
		reg.observe(seen(ICAO2, REG))
		expect(reg.resolve(REG)).toMatchObject({ icao: null, conflict: true })
		expect(reg.resolve(REG).entityKeys).toEqual(["reg:N0WK01"])
	})

	it("a conflicted registration is in neither aircraft's entity keys", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO, REG))
		expect(reg.resolve(ICAO).entityKeys).toEqual(["icao:0A0B01", "reg:N0WK01"])
		reg.observe(seen(ICAO2, REG))
		expect(reg.resolve(ICAO).entityKeys).toEqual(["icao:0A0B01"])
		expect(reg.resolve(ICAO2).entityKeys).toEqual(["icao:0A0B02"])
		// the links are still shown, only not used to read the aircraft's messages
		expect(reg.resolve(ICAO).links).toHaveLength(1)
	})

	it("a registration resolved elsewhere by an observed link leaves a database aircraft", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO2, REG, T0, "database"))
		expect(reg.resolve(ICAO2).entityKeys).toContain("reg:N0WK01")
		reg.observe(seen(ICAO, REG))
		expect(reg.resolve(ICAO2).entityKeys).toEqual(["icao:0A0B02"])
		expect(reg.resolve(ICAO).entityKeys).toEqual(["icao:0A0B01", "reg:N0WK01"])
	})

	it("an observed link wins over a database link, and hints never resolve", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime())
		reg.observe(seen(ICAO2, REG, T0, "database"))
		expect(reg.resolve(REG)).toMatchObject({
			icao: "0A0B02",
			resolvedBy: "database",
		})
		reg.observe(seen(ICAO, REG))
		expect(reg.resolve(REG)).toMatchObject({
			icao: "0A0B01",
			resolvedBy: "observed",
		})
		const hints = new AircraftIdentityRegistry(() => T0.getTime())
		hints.observe(seen(ICAO, REG, T0, "hint"))
		expect(hints.resolve(REG).icao).toBeNull()
	})

	it("links expire after their lifetime unless seen again", () => {
		let now = T0.getTime()
		const reg = new AircraftIdentityRegistry(() => now)
		reg.observe(seen(ICAO, CALLSIGN))
		reg.observe(seen(ICAO, REG))
		now += 3 * HOUR
		expect(
			reg
				.resolve(ICAO)
				.links.map(l => l.b.kind === "reg" || l.a.kind === "reg"),
		).toEqual([true])
		expect(reg.prune()).toBe(1)
		reg.observe(seen(ICAO, REG, new Date(now)))
		now += 29 * DAY
		expect(reg.resolve(REG).icao).toBe("0A0B01")
		now += 2 * DAY
		expect(reg.resolve(REG).icao).toBeNull()
		expect(reg.prune()).toBe(1)
		expect(reg.size).toBe(0)
	})

	it("counts sightings and keeps the first and last time", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime() + HOUR)
		reg.observe(seen(ICAO, REG, new Date(T0.getTime() + HOUR)))
		reg.observe(seen(REG, ICAO, T0))
		const [link] = reg.resolve(ICAO).links
		expect(link?.count).toBe(2)
		expect(link?.firstSeen).toBe(T0.toISOString())
		expect(link?.lastSeen).toBe(new Date(T0.getTime() + HOUR).toISOString())
	})

	it("keeps at most its capacity, dropping the least recently seen", () => {
		const reg = new AircraftIdentityRegistry(() => T0.getTime(), 2)
		reg.observe(seen(ICAO, REG))
		reg.observe(seen(ICAO2, { kind: "reg", value: "N0WK02" }))
		reg.observe(seen(ICAO, REG))
		reg.observe(seen(ICAO, FLIGHT))
		expect(reg.size).toBe(2)
		expect(reg.resolve(REG).icao).toBe("0A0B01")
		expect(reg.resolve({ kind: "reg", value: "N0WK02" }).icao).toBeNull()
	})

	// Feature: aircraft-signals, Property 3: callsigns and flight numbers never resolve
	it("whatever is observed, only ICAO addresses and registrations resolve", () => {
		const id = fc.record({
			kind: fc.constantFrom("icao", "reg", "callsign", "flight"),
			value: fc.constantFrom("0A0B01", "0A0B02", "N0WK01", "ZZ0101"),
		}) as fc.Arbitrary<IdentityObservation["a"]>
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(id, id, fc.constantFrom("observed", "database", "hint")),
					{
						maxLength: 20,
					},
				),
				id,
				(seenPairs, query) => {
					const reg = new AircraftIdentityRegistry(() => T0.getTime())
					for (const [a, b, evidence] of seenPairs)
						reg.observe(
							seen(a, b, T0, evidence as IdentityObservation["evidence"]),
						)
					const r = reg.resolve(query)
					if (query.kind === "callsign" || query.kind === "flight")
						return r.icao === null
					if (r.icao !== null && query.kind === "reg")
						return r.resolvedBy === "observed" || r.resolvedBy === "database"
					return true
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("identity manager and route", () => {
	const open: Array<{ close(): Promise<void> }> = []
	afterEach(async () => {
		await Promise.all(open.splice(0).map(app => app.close()))
	})

	it("records database links from enrichment, weaker than observed ones", () => {
		const manager = new AircraftIdentityManager(
			new EventEmitter() as never,
			createLogger({ level: "error" }),
			new AircraftIdentityRegistry(() => T0.getTime()),
		)
		manager.observeDatabase("0a0b02", "n0wk01", T0)
		manager.observeDatabase("not-hex", "N0WK01", T0)
		manager.observeDatabase("0A0B02", "", T0)
		const db = manager.resolve(REG)
		expect(db).toMatchObject({ icao: "0A0B02", resolvedBy: "database" })
		expect(db.links).toHaveLength(1)
		expect(db.links[0]).toMatchObject({
			evidence: "database",
			source: "database",
		})
		manager.observeDatabase("0A0B01", "N0WK01", T0)
		// two databases disagree: a conflict, no aircraft
		expect(manager.resolve(REG)).toMatchObject({ icao: null, conflict: true })
		manager.stop()
	})

	it("learns from decoder output and serves the result", async () => {
		const source = new EventEmitter()
		const manager = new AircraftIdentityManager(
			source as never,
			createLogger({ level: "error" }),
			new AircraftIdentityRegistry(() => T0.getTime()),
		)
		const [first] = loadVdl2()
		source.emit(
			"decoder:output",
			"vdl2",
			out("vdl2", parseDumpvdl2Json(first as never)),
		)
		const app = Fastify()
		open.push(app)
		await app.register(aircraftIdentityRoutes, { identity: manager })

		const res = await app.inject({ url: "/api/aircraft-identity/reg/n0wk01" })
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body).toMatchObject({
			query: { kind: "reg", value: "N0WK01" },
			icao: "0A0B01",
			resolvedBy: "observed",
			conflict: false,
		})
		expect(body.links).toHaveLength(2)

		const flight = await app.inject({
			url: "/api/aircraft-identity/flight/ZZ0101",
		})
		expect(flight.json()).toMatchObject({ icao: null, resolvedBy: null })

		expect(
			(await app.inject({ url: "/api/aircraft-identity/icao/XYZ" })).statusCode,
		).toBe(400)
		expect(
			(await app.inject({ url: "/api/aircraft-identity/tail/N0WK01" }))
				.statusCode,
		).toBe(400)

		manager.stop()
		source.emit(
			"decoder:output",
			"vdl2",
			out("vdl2", parseDumpvdl2Json(loadVdl2()[4] as never)),
		)
		const after = await app.inject({ url: "/api/aircraft-identity/reg/N0WK02" })
		expect(after.json().icao).toBeNull()
	})
})
