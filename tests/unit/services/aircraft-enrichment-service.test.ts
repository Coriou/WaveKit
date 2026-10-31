/**
 * Aircraft Enrichment Service: local database, on-disk cache, free online sources
 * (adsbdb, hexdb, planespotters) and the airline/route of a callsign.
 */

import { gzipSync } from "node:zlib"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
	AircraftEnrichmentService,
	airlinePrefix,
	bundledAirline,
	type AircraftEnrichmentConfig,
} from "../../../src/services/aircraft-enrichment-service.js"
import {
	AircraftInfoStore,
	parseTar1090Line,
} from "../../../src/services/aircraft-info/store.js"
import { CircuitBreaker } from "../../../src/services/aircraft-info/http.js"
import type { SqliteDatabase } from "../../../src/core/activity/storage/sqlite.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

const ADSBDB_AIRCRAFT = {
	response: {
		aircraft: {
			type: "A320 214",
			icao_type: "A320",
			manufacturer: "Airbus",
			mode_s: "0A0B11",
			registration: "ZZ-WKA",
			registered_owner_country_iso_name: "CH",
			registered_owner_country_name: "Switzerland",
			registered_owner_operator_flag_code: "WKS",
			registered_owner: "WaveKit Swiss",
			url_photo: "https://image.airport-data.com/aircraft/001702996.jpg",
			url_photo_thumbnail:
				"https://airport-data.com/images/aircraft/thumbnails/001/702/001702996.jpg",
		},
	},
}

const PLANESPOTTERS = {
	photos: [
		{
			id: "1000001",
			thumbnail: {
				src: "https://t.plnspttrs.net/10000/1000001_0000000000_t.jpg",
			},
			thumbnail_large: {
				src: "https://t.plnspttrs.net/10000/1000001_0000000000_280.jpg",
			},
			link: "https://www.planespotters.net/photo/1000001/zz-wka",
			photographer: "A. Spotter",
		},
	],
}

const airport = (icao: string, iata: string, name: string) => ({
	country_iso_name: "FR",
	country_name: "France",
	elevation: 291,
	iata_code: iata,
	icao_code: icao,
	latitude: 48.7,
	longitude: 2.3,
	municipality: "Mock City",
	name,
})

const ADSBDB_CALLSIGN = {
	response: {
		flightroute: {
			callsign: "WKS101",
			airline: {
				name: "WaveKit Swiss",
				icao: "WKS",
				iata: "DS",
				country: "Switzerland",
				country_iso: "CH",
				callsign: "WAVEKIT",
			},
			origin: airport("ZZZY", "ZZY", "Mock Origin Airport"),
			destination: airport("ZZZZ", "ZZZ", "Mock Airport"),
		},
	},
}

type Handler = (url: string) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function fakeFetch(handler: Handler) {
	return vi.fn((input: string, _init?: RequestInit) =>
		Promise.resolve(handler(input)),
	)
}

/** adsbdb + planespotters answering for ZZ-WKA, 404 for anything else. */
const happy: Handler = url => {
	if (url.includes("adsbdb.com/v0/aircraft/0A0B11"))
		return json(ADSBDB_AIRCRAFT)
	if (url.includes("planespotters.net/pub/photos/reg/ZZ-WKA"))
		return json(PLANESPOTTERS)
	if (url.includes("adsbdb.com/v0/callsign/WKS101"))
		return json(ADSBDB_CALLSIGN)
	return json({ response: "unknown" }, 404)
}

function memoryStore(now?: () => number): AircraftInfoStore {
	return new AircraftInfoStore(
		new DatabaseSync(":memory:") as unknown as SqliteDatabase,
		now,
	)
}

async function* lines(rows: string[]) {
	for (const row of rows) yield row
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

const config: AircraftEnrichmentConfig = {
	rateLimitMs: 0,
	requestTimeoutMs: 500,
}

describe("AircraftEnrichmentService", () => {
	let service: AircraftEnrichmentService | undefined
	let tracker: AircraftTracker | undefined

	afterEach(() => {
		service?.stop()
		tracker?.stop()
		service = undefined
		tracker = undefined
	})

	describe("online lookup", () => {
		it("merges adsbdb identity with a Planespotters photo and credit", async () => {
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(config, logger, {
				fetch,
				store: memoryStore(),
			})
			await service.start()
			const id = await service.lookup("0a0b11")
			expect(id).toMatchObject({
				registration: "ZZ-WKA",
				typeCode: "A320",
				typeDescription: "A320 214",
				manufacturer: "Airbus",
				operator: "WaveKit Swiss",
				operatorCode: "WKS",
				country: "Switzerland",
				countryIso: "CH",
				source: "adsbdb",
				photo: {
					thumbnailUrl:
						"https://t.plnspttrs.net/10000/1000001_0000000000_t.jpg",
					largeUrl: "https://t.plnspttrs.net/10000/1000001_0000000000_280.jpg",
					photographer: "A. Spotter",
					link: "https://www.planespotters.net/photo/1000001/zz-wka",
					source: "planespotters",
				},
				imageUrl: "https://t.plnspttrs.net/10000/1000001_0000000000_t.jpg",
			})
			const sent = fetch.mock.calls[0]?.[1] as RequestInit | undefined
			expect(new Headers(sent?.headers).get("User-Agent")).toMatch(
				/WaveKit\/.+https:\/\//,
			)
		})

		it("answers from the cache the second time, also after a restart", async () => {
			const store = memoryStore()
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(config, logger, { fetch, store })
			await service.start()
			await service.lookup("0A0B11")
			const calls = fetch.mock.calls.length
			await service.lookup("0A0B11")
			expect(fetch.mock.calls.length).toBe(calls)

			const offline = fakeFetch(() => {
				throw new TypeError("fetch failed")
			})
			const restarted = new AircraftEnrichmentService(config, logger, {
				fetch: offline,
				store,
			})
			await restarted.start()
			expect((await restarted.lookup("0A0B11"))?.registration).toBe("ZZ-WKA")
			expect(offline).not.toHaveBeenCalled()
			restarted.stop()
		})

		it("falls back to hexdb when adsbdb does not know the aircraft", async () => {
			const fetch = fakeFetch(url => {
				if (url.includes("hexdb.io/api/v1/aircraft/ABC123"))
					return json({
						Registration: "N12345",
						ICAOTypeCode: "B738",
						Type: "Boeing 737-800",
						RegisteredOwners: "United Airlines",
					})
				return json({ response: "unknown aircraft" }, 404)
			})
			service = new AircraftEnrichmentService(config, logger, {
				fetch,
				store: memoryStore(),
			})
			await service.start()
			expect(await service.lookup("ABC123")).toMatchObject({
				registration: "N12345",
				typeCode: "B738",
				operator: "United Airlines",
				source: "hexdb",
			})
		})

		it("caches nothing when every source is unreachable, and keeps the local answer", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(
				lines(["0A0B11;ZZ-WKA;A320;00;AIRBUS A-320;2005;;"]),
			)
			const fetch = fakeFetch(() => {
				throw new TypeError("fetch failed")
			})
			service = new AircraftEnrichmentService(config, logger, { fetch, store })
			await service.start()
			expect(await service.lookup("0A0B11")).toMatchObject({
				registration: "ZZ-WKA",
				typeCode: "A320",
				typeDescription: "Airbus A-320",
				year: 2005,
				country: "Switzerland",
				source: "local",
			})
			expect(store.cached("airframe", "0A0B11")).toBeUndefined()
			expect(store.cached("photo", "0A0B11")).toBeUndefined()
		})

		it("never goes online with online: false", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(
				lines(["0A0B14;ZZ-WKC;C25B;1000;CESSNA 525B;;ARMEE;"]),
			)
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ ...config, online: false },
				logger,
				{
					fetch,
					store,
				},
			)
			await service.start()
			expect(await service.lookup("0A0B14")).toMatchObject({
				registration: "ZZ-WKC",
				operator: "ARMEE",
				flags: { military: true },
				country: "France",
			})
			expect(fetch).not.toHaveBeenCalled()
		})
	})

	describe("tracker", () => {
		beforeEach(() => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
		})

		it("applies identity, airline and route, and pushes an update", async () => {
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(happy),
				store: memoryStore(),
			})
			service.wireToTracker(tracker!)
			await service.start()
			const updates: string[] = []
			tracker!.on("aircraft:update", a => updates.push(a.icao))
			tracker!.processUpdate({ hex: "0A0B11", flight: "WKS101 " })
			await flush()
			const id = tracker!.get("0A0B11")?.identification
			expect(id?.registration).toBe("ZZ-WKA")
			expect(id?.photo?.photographer).toBe("A. Spotter")
			expect(id?.airline).toMatchObject({
				name: "WaveKit Swiss",
				icao: "WKS",
			})
			expect(id?.route).toMatchObject({
				callsign: "WKS101",
				origin: { iata: "ZZY" },
				destination: { iata: "ZZZ", name: "Mock Airport" },
			})
			expect(updates).toContain("0A0B11")
		})

		it("uses the bundled airline offline and drops a route that no longer matches", async () => {
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(happy),
				store: memoryStore(),
			})
			service.wireToTracker(tracker!)
			await service.start()
			tracker!.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(tracker!.get("0A0B11")?.identification?.route).toBeDefined()
			// New callsign with no known route: the old route goes, the airline comes
			// from the bundled table (adsbdb learned WKS, so it stays WaveKit Swiss).
			tracker!.processUpdate({ hex: "0A0B11", flight: "WKS99" })
			await flush()
			const id = tracker!.get("0A0B11")?.identification
			expect(id?.route).toBeUndefined()
			expect(id?.airline?.name).toBe("WaveKit Swiss")

			tracker!.processUpdate({ hex: "AAAAAA", flight: "AFR1234" })
			await flush()
			expect(tracker!.get("AAAAAA")?.identification?.airline).toMatchObject({
				name: "Air France",
				iata: "AF",
				source: "local",
			})
		})
	})

	describe("local aircraft database", () => {
		let dir: string
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "wavekit-aircraft-"))
		})
		afterEach(() => rmSync(dir, { recursive: true, force: true }))

		it("downloads tar1090-db and swaps it in", async () => {
			const gz = gzipSync(
				"000001;;;10;;;Miscode - VARIOUS;\n0A0B11;ZZ-WKA;A320;00;AIRBUS A-320;;;\nbad line\n",
			)
			const fetch = fakeFetch(url =>
				url.endsWith(".csv.gz") ? new Response(gz) : json({}, 404),
			)
			const store = memoryStore()
			service = new AircraftEnrichmentService(
				{
					...config,
					stateDir: dir,
					localDb: { url: "https://example.test/db.csv.gz" },
				},
				logger,
				{ fetch, store },
			)
			await service.start()
			await service.refreshLocalDb()
			expect(store.localAircraftCount()).toBe(2)
			expect(store.localAircraft("0A0B11")?.registration).toBe("ZZ-WKA")
			expect(store.meta("aircraft_db_updated_at")).toBeDefined()
			// Fresh: no second download.
			await service.refreshLocalDb()
			expect(fetch).toHaveBeenCalledTimes(1)
		})

		it("keeps the current table when the download fails", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(lines(["0A0B11;ZZ-WKA;A320;00;;;;"]))
			const fetch = fakeFetch(() => new Response("nope", { status: 503 }))
			service = new AircraftEnrichmentService(
				{ ...config, stateDir: dir },
				logger,
				{ fetch, store },
			)
			await service.start()
			await service.refreshLocalDb(true)
			expect(store.localAircraft("0A0B11")?.registration).toBe("ZZ-WKA")
		})

		it("finds the ICAO address of a registration", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(
				lines(["0A0B11;ZZ-WKA;A320;00;;;;", "0A0B13;ZZ-WKB;A319;00;;;;"]),
			)
			expect(store.hexForRegistration("zz-wka")).toBe("0A0B11")
			expect(store.hexForRegistration(".ZZ-WKB")).toBe("0A0B13")
			// ACARS often drops the dash
			expect(store.hexForRegistration(".ZZWKB")).toBe("0A0B13")
			expect(store.hexForRegistration("ZZWKA")).toBe("0A0B11")
			expect(store.hexForRegistration("F-XXXX")).toBeUndefined()
		})

		it("parses tar1090-db lines", () => {
			expect(
				parseTar1090Line("0a0b11;ZZ-WKA;ZZ01;0001;WAVEKIT MOCK TYPE;2005;WaveKit Air;"),
			).toEqual([
				"0A0B11",
				"ZZ-WKA",
				"ZZ01",
				"0001",
				"WAVEKIT MOCK TYPE",
				2005,
				"WaveKit Air",
			])
			expect(parseTar1090Line("0A0B12;;;00;;;;")).toBeNull()
			expect(parseTar1090Line("not-hex;X")).toBeNull()
		})
	})

	describe("helpers", () => {
		it("reads an airline prefix only from airline-style callsigns", () => {
			expect(airlinePrefix("WKS45UL")).toBe("WKS")
			expect(airlinePrefix("afr6116")).toBe("AFR")
			expect(airlinePrefix("FHBXA")).toBeNull()
			expect(airlinePrefix("N12345")).toBeNull()
		})

		it("knows common airlines offline", () => {
			expect(bundledAirline("EZY")).toMatchObject({
				name: "easyJet",
				iata: "U2",
				callsign: "EASY",
			})
			expect(bundledAirline("QZQ")).toBeNull()
		})

		it("opens the breaker after repeated failures and backs off", () => {
			let t = 0
			const b = new CircuitBreaker(3, 1000, 4000, () => t)
			b.failure()
			b.failure()
			expect(b.allows()).toBe(true)
			b.failure()
			expect(b.allows()).toBe(false)
			t = 1000
			expect(b.allows()).toBe(true)
			b.failure()
			b.failure()
			b.failure()
			t = 2999
			expect(b.allows()).toBe(false)
			b.success()
			expect(b.allows()).toBe(true)
		})
	})
	describe("online switch", () => {
		it("turns online lookups off at runtime and keeps the choice across restarts", async () => {
			const store = memoryStore()
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(config, logger, { fetch, store })
			await service.start()
			expect(service.settings()).toMatchObject({
				enabled: true,
				online: true,
				onlineFrom: "config",
				persistent: true,
				localDb: { aircraft: 0, updatedAt: null },
			})
			expect(service.setOnline(false)).toMatchObject({
				online: false,
				onlineFrom: "ui",
			})
			expect((await service.lookup("0A0B11"))?.registration).toBeUndefined()
			expect(fetch).not.toHaveBeenCalled()
			service.stop()

			service = new AircraftEnrichmentService(config, logger, { fetch, store })
			await service.start()
			expect(service.settings()).toMatchObject({
				online: false,
				onlineFrom: "ui",
			})
			service.setOnline(true)
			expect((await service.lookup("0A0B11"))?.registration).toBe("ZZ-WKA")
		})

		it("looks up the aircraft already tracked when lookups come back on", async () => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ ...config, online: false },
				logger,
				{ fetch, store: memoryStore() },
			)
			service.wireToTracker(tracker)
			await service.start()
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(
				tracker.get("0A0B11")?.identification?.registration,
			).toBeUndefined()
			service.setOnline(true)
			await flush()
			const id = tracker.get("0A0B11")?.identification
			expect(id?.registration).toBe("ZZ-WKA")
			expect(id?.route?.callsign).toBe("WKS101")
		})

		it("sends a new aircraft's update only after its new event", async () => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(happy),
				store: memoryStore(),
			})
			service.wireToTracker(tracker)
			await service.start()
			const seen: string[] = []
			tracker.on("aircraft:new", () => seen.push("new"))
			tracker.on("aircraft:update", () => seen.push("update"))
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(seen[0]).toBe("new")
			expect(seen).toContain("update")
		})

		it("tries a callsign again after adsbdb was unreachable", async () => {
			let t = 1_000_000
			let down = true
			tracker = new AircraftTracker(
				{ maxAge: 3600, cleanupInterval: 60_000 },
				logger,
			)
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(url => {
					if (down && url.includes("/v0/callsign/"))
						throw new TypeError("fetch failed")
					return happy(url)
				}),
				store: memoryStore(() => t),
				now: () => t,
			})
			service.wireToTracker(tracker)
			await service.start()
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(tracker.get("0A0B11")?.identification?.route).toBeUndefined()
			down = false
			t += 11 * 60_000
			tracker.processUpdate({
				hex: "0A0B11",
				flight: "WKS101",
				alt_baro: 30000,
			})
			await flush()
			expect(tracker.get("0A0B11")?.identification?.route?.callsign).toBe(
				"WKS101",
			)
		})
	})
})
