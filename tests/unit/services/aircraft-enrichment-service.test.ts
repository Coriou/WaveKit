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
	CACHE_PRUNE_INTERVAL_MS,
	LOCAL_DB_FIRST_CHECK_MS,
	airlinePrefix,
	bundledAirline,
	type AircraftEnrichmentConfig,
} from "../../../src/services/aircraft-enrichment-service.js"
import {
	AircraftInfoStore,
	MAX_CACHE_ROWS,
	parseTar1090Line,
} from "../../../src/services/aircraft-info/store.js"
import { CircuitBreaker } from "../../../src/services/aircraft-info/http.js"
import {
	ROUTE_DESTINATION_SLACK_M,
	ROUTE_MAX_OFF_COURSE_DEG,
	ROUTE_OFF_COURSE_MARGIN_DEG,
	ROUTE_ORIGIN_SLACK_M,
	ROUTE_SLACK_MARGIN_M,
	offCourseDeg,
	routeFits,
	routePlausible,
} from "../../../src/services/aircraft-info/route-fit.js"
import type { SqliteDatabase } from "../../../src/core/activity/storage/sqlite.js"
import { AircraftTracker } from "../../../src/core/aircraft-tracker.js"
import { initialBearingDeg } from "../../../src/core/coverage/geo.js"
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
	online: true,
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
				// country names the ICAO address block (0A0000-0A7FFF), not the owner
				country: "Algeria",
				countryIso: "DZ",
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
				country: "Algeria",
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
				country: "Algeria",
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

		it("shows a photo only while online lookups are on, even when one is cached", async () => {
			const store = memoryStore()
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(happy),
				store,
			})
			service.wireToTracker(tracker!)
			await service.start()
			// switch on: the photo and its thumbnail URL reach the aircraft
			expect(await service.lookup("0A0B11")).toMatchObject({
				photo: { photographer: "A. Spotter" },
				imageUrl: "https://t.plnspttrs.net/10000/1000001_0000000000_t.jpg",
			})
			tracker!.processUpdate({ hex: "0A0B11" })
			await flush()
			expect(tracker!.get("0A0B11")?.identification?.photo).toBeDefined()
			expect(store.cached("photo", "0A0B11")).toBeDefined()
			// switch off: the aircraft on the map drops it, lookups leave it out
			service.setOnline(false)
			const off = tracker!.get("0A0B11")?.identification
			expect(off?.photo).toBeUndefined()
			expect(off?.imageUrl).toBeUndefined()
			expect(off?.registration).toBe("ZZ-WKA")
			const looked = await service.lookup("0A0B11")
			expect(looked?.registration).toBe("ZZ-WKA")
			expect(looked).not.toHaveProperty("photo")
			expect(looked).not.toHaveProperty("imageUrl")
			service.identify("0A0B11")
			expect(tracker!.get("0A0B11")?.identification).not.toHaveProperty("photo")
			service.stop()
			// a fresh start with lookups off and the photo still cached: none shown
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ ...config, online: false },
				logger,
				{ fetch, store },
			)
			tracker!.stop()
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			service.wireToTracker(tracker)
			await service.start()
			tracker.processUpdate({ hex: "0A0B11" })
			await flush()
			const cold = tracker.get("0A0B11")?.identification
			expect(cold?.registration).toBe("ZZ-WKA")
			expect(cold).not.toHaveProperty("photo")
			expect(cold).not.toHaveProperty("imageUrl")
			expect(fetch).not.toHaveBeenCalled()
			// back on: the cached photo is shown again
			service.setOnline(true)
			expect(tracker.get("0A0B11")?.identification?.imageUrl).toBe(
				"https://t.plnspttrs.net/10000/1000001_0000000000_t.jpg",
			)
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
				parseTar1090Line(
					"0a0b11;ZZ-WKA;ZZ01;0001;WAVEKIT MOCK TYPE;2005;WaveKit Air;",
				),
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

	describe("online lookups off by default", () => {
		let dir: string
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "wavekit-aircraft-"))
		})
		afterEach(() => {
			vi.useRealTimers()
			rmSync(dir, { recursive: true, force: true })
		})

		it("sends nothing without an explicit online: true", async () => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ rateLimitMs: 0, stateDir: dir },
				logger,
				{ fetch, store: memoryStore() },
			)
			service.wireToTracker(tracker)
			await service.start()
			expect(service.settings()).toMatchObject({
				online: false,
				onlineFrom: "config",
			})
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			await service.lookup("0A0B11")
			await service.refreshLocalDb(true)
			expect(fetch).not.toHaveBeenCalled()
		})

		it("downloads the local database only after lookups are turned on", async () => {
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
			})
			const gz = gzipSync("0A0B11;ZZ-WKA;A320;00;AIRBUS A-320;;;\n")
			const fetch = fakeFetch(url =>
				url.endsWith(".csv.gz") ? new Response(gz) : json({}, 404),
			)
			const store = memoryStore()
			service = new AircraftEnrichmentService(
				{
					rateLimitMs: 0,
					stateDir: dir,
					localDb: { url: "https://example.test/db.csv.gz" },
				},
				logger,
				{ fetch, store },
			)
			await service.start()
			vi.advanceTimersByTime(LOCAL_DB_FIRST_CHECK_MS * 2)
			expect(fetch).not.toHaveBeenCalled()
			service.setOnline(true)
			vi.advanceTimersByTime(LOCAL_DB_FIRST_CHECK_MS - 1)
			expect(fetch).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1)
			expect(fetch).toHaveBeenCalledTimes(1)
			await service.refreshLocalDb()
			expect(store.localAircraftCount()).toBe(1)
		})

		it("cancels a pending database check when lookups are turned off", async () => {
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
			})
			const fetch = fakeFetch(() => json({}, 404))
			service = new AircraftEnrichmentService(
				{ ...config, stateDir: dir },
				logger,
				{ fetch, store: memoryStore() },
			)
			await service.start()
			service.setOnline(false)
			vi.advanceTimersByTime(LOCAL_DB_FIRST_CHECK_MS * 2)
			expect(fetch).not.toHaveBeenCalled()
		})

		it("restores the saved preference before any lookup goes out", async () => {
			const store = memoryStore()
			store.setMeta("online", "0")
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(config, logger, { fetch, store })
			service.wireToTracker(tracker)
			// heard while the service is still starting, and an API lookup at the same time
			const starting = service.start()
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			const looked = service.lookup("0A0B11")
			await starting
			await looked
			await flush()
			expect(service.settings()).toMatchObject({
				online: false,
				onlineFrom: "ui",
			})
			expect(fetch).not.toHaveBeenCalled()
		})

		it("identifies aircraft heard while starting once settings are known", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(lines(["0A0B11;ZZ-WKA;A320;00;;;;"]))
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			service = new AircraftEnrichmentService({ rateLimitMs: 0 }, logger, {
				fetch: fakeFetch(happy),
				store,
			})
			service.wireToTracker(tracker)
			const starting = service.start()
			tracker.processUpdate({ hex: "0A0B11" })
			await starting
			expect(tracker.get("0A0B11")?.identification?.registration).toBe("ZZ-WKA")
		})

		it("stops a lookup under way when lookups are turned off", async () => {
			let svc: AircraftEnrichmentService | undefined
			const fetch = fakeFetch(url => {
				// adsbdb does not know it, and the user turns lookups off meanwhile
				if (url.includes("adsbdb.com")) {
					svc?.setOnline(false)
					return json({ response: "unknown aircraft" }, 404)
				}
				return happy(url)
			})
			svc = new AircraftEnrichmentService(config, logger, {
				fetch,
				store: memoryStore(),
			})
			service = svc
			await svc.start()
			await svc.lookup("0A0B11")
			// no hexdb follow-up, no Planespotters photo
			expect(fetch).toHaveBeenCalledTimes(1)
			expect(String(fetch.mock.calls[0]?.[0])).toContain("adsbdb.com")
		})

		it("rechecks the switch after waiting for its turn", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ ...config, rateLimitMs: 1000 },
				logger,
				{ fetch, store: memoryStore() },
			)
			await service.start()
			const first = service.lookup("0A0B11")
			await vi.advanceTimersByTimeAsync(0)
			expect(fetch).toHaveBeenCalledTimes(1) // adsbdb answered at once
			// the photo request is waiting for its turn when lookups go off
			service.setOnline(false)
			await vi.advanceTimersByTimeAsync(2000)
			await first
			expect(fetch).toHaveBeenCalledTimes(1)
		})

		it("a start after a stop that came while the cache opened begins afresh and ends started", async () => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			service = new AircraftEnrichmentService(
				{ ...config, stateDir: dir },
				logger,
				{ fetch: fakeFetch(happy) },
			)
			service.wireToTracker(tracker)
			const first = service.start()
			service.stop()
			const second = service.start()
			const third = service.start() // same generation: joins the second
			await Promise.all([first, second, third])
			expect(service.getCacheStats().size).toBe(0)
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(tracker.get("0A0B11")?.identification?.registration).toBe("ZZ-WKA")
		})

		it("a stop while the cache opens leaves the service stopped", async () => {
			tracker = new AircraftTracker(
				{ maxAge: 60, cleanupInterval: 60_000 },
				logger,
			)
			const fetch = fakeFetch(happy)
			service = new AircraftEnrichmentService(
				{ ...config, stateDir: dir },
				logger,
				{ fetch },
			)
			service.wireToTracker(tracker)
			const first = service.start()
			service.stop()
			await first
			tracker.processUpdate({ hex: "0A0B11", flight: "WKS101" })
			await flush()
			expect(fetch).not.toHaveBeenCalled()
			expect(tracker.get("0A0B11")?.identification).toBeUndefined()
		})
	})

	describe("identity links", () => {
		it("reports a registration from the local database or an online lookup", async () => {
			const store = memoryStore()
			await store.replaceAircraftDb(lines(["0A0B01;N0WK01;A320;00;;;;"]))
			service = new AircraftEnrichmentService(config, logger, {
				fetch: fakeFetch(happy),
				store,
			})
			const seen: string[] = []
			service.on("identity:registration", (icao, reg, from) =>
				seen.push(`${icao} ${reg} ${from}`),
			)
			await service.start()
			await service.lookup("0a0b01")
			await service.lookup("0A0B11")
			expect(seen).toEqual(["0A0B01 N0WK01 local", "0A0B11 ZZ-WKA online"])
		})

		it("reports nothing for an aircraft with no registration", async () => {
			service = new AircraftEnrichmentService(
				{ ...config, online: false },
				logger,
				{ fetch: fakeFetch(happy), store: memoryStore() },
			)
			const seen: string[] = []
			service.on("identity:registration", icao => seen.push(icao))
			await service.start()
			await service.lookup("0A0B02")
			expect(seen).toEqual([])
		})
	})

	describe("cache bounds", () => {
		const fill = (store: AircraftInfoStore, n: number, from = 0) => {
			for (let i = from; i < from + n; i++)
				store.remember("callsign", `K${i}`, { i }, 1000 + i)
		}

		it("holds the cap exactly and trims past it, closest to expiry first", () => {
			const store = new AircraftInfoStore(
				new DatabaseSync(":memory:") as unknown as SqliteDatabase,
				() => 0,
				10,
				2,
			)
			fill(store, 10)
			expect(store.cacheSize()).toBe(10) // at the cap: nothing goes
			fill(store, 1, 10)
			// past it: down to cap minus slack, the soonest-expiring rows first
			expect(store.cacheSize()).toBe(8)
			expect(store.cached("callsign", "K0")).toBeUndefined()
			expect(store.cached("callsign", "K2")).toBeUndefined()
			expect(store.cached("callsign", "K3")).toEqual({ value: { i: 3 } })
			expect(store.cached("callsign", "K10")).toEqual({ value: { i: 10 } })
			// replacing an existing row does not count as growth
			for (let i = 0; i < 5; i++)
				store.remember("callsign", "K10", { i: 10 }, 5000)
			expect(store.cacheSize()).toBe(8)
		})

		it("a database already past the cap is trimmed when opened", () => {
			const db = new DatabaseSync(":memory:") as unknown as SqliteDatabase
			fill(new AircraftInfoStore(db, () => 0, 100, 0), 20)
			const reopened = new AircraftInfoStore(db, () => 0, 15, 0)
			expect(reopened.cacheSize()).toBe(15)
		})

		it("prune drops expired rows", () => {
			let t = 0
			const store = new AircraftInfoStore(
				new DatabaseSync(":memory:") as unknown as SqliteDatabase,
				() => t,
			)
			fill(store, 5)
			t = 1002 // K0..K2 expired (expiry 1000..1002)
			store.prune()
			expect(store.cacheSize()).toBe(2)
		})

		it("the default cap is 100,000 rows", () => {
			expect(MAX_CACHE_ROWS).toBe(100_000)
		})

		it("the service prunes expired rows every hour", async () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
			try {
				let t = 0
				const store = memoryStore(() => t)
				store.remember("callsign", "OLD", null, 1000)
				service = new AircraftEnrichmentService(config, logger, {
					fetch: fakeFetch(happy),
					store,
					now: () => t,
				})
				await service.start()
				t = 2000
				expect(store.cacheSize()).toBe(1)
				vi.advanceTimersByTime(CACHE_PRUNE_INTERVAL_MS)
				expect(store.cacheSize()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("route plausibility", () => {
		const route = {
			origin: { icao: "ZZAA", name: "Origin", lat: 49.0128, lon: 2.55 },
			destination: {
				icao: "ZZBB",
				name: "Destination",
				lat: 40.6398,
				lon: -73.7789,
			},
		}
		const at = { lat: 48.81, lon: -3.87 }
		const flying = (
			track: number,
			position: { lat: number; lon: number } = at,
		) => ({
			position,
			velocity: { track },
		})

		it("judges the track against the bearing to the destination, at and past the bound", () => {
			expect(routePlausible(route, flying(284))).toBe(true)
			expect(routePlausible(route, flying(100))).toBe(false)
			expect(routePlausible(route, {})).toBe(true)
			expect(routePlausible(route, { position: at })).toBe(true)
			// just after take-off any heading fits
			expect(routePlausible(route, flying(100, { lat: 49.1, lon: 2.4 }))).toBe(
				true,
			)
			// due east of the destination: the bearing to it is due west (270)
			const east = { lat: 40.6398, lon: -70 }
			expect(
				routePlausible(route, flying(270 + ROUTE_MAX_OFF_COURSE_DEG - 1, east)),
			).toBe(true)
			expect(
				routePlausible(route, flying(270 - ROUTE_MAX_OFF_COURSE_DEG - 1, east)),
			).toBe(false)
		})

		it("a course exactly 100° off the bearing fits, just past it does not", () => {
			expect(ROUTE_MAX_OFF_COURSE_DEG).toBe(100)
			// on the equator 10° east of the destination: the bearing to it is exactly 270
			const equator = {
				origin: { icao: "ZZAA", name: "Origin", lat: 0, lon: 20 },
				destination: { icao: "ZZBB", name: "Destination", lat: 0, lon: 0 },
			}
			const east = { lat: 0, lon: 10 }
			expect(offCourseDeg(270, 170)).toBe(100)
			expect(routePlausible(equator, flying(170, east))).toBe(true)
			expect(routePlausible(equator, flying(10, east))).toBe(true)
			expect(routePlausible(equator, flying(169.999, east))).toBe(false)
			expect(routePlausible(equator, flying(10.001, east))).toBe(false)
			// wraps through north
			expect(offCourseDeg(10, 350)).toBe(20)
			expect(offCourseDeg(350, 10)).toBe(20)
		})

		it("the origin (80 km) and destination (30 km) slack hold strictly inside the distance", () => {
			expect(ROUTE_ORIGIN_SLACK_M).toBe(80_000)
			expect(ROUTE_DESTINATION_SLACK_M).toBe(30_000)
			const far = 500_000
			const away = ROUTE_MAX_OFF_COURSE_DEG + 1
			const fits = (fromOriginM: number, toDestinationM: number) =>
				routeFits({ fromOriginM, toDestinationM, offCourseDeg: away })
			expect(fits(far, far)).toBe(false)
			expect(fits(ROUTE_ORIGIN_SLACK_M - 1, far)).toBe(true)
			expect(fits(ROUTE_ORIGIN_SLACK_M, far)).toBe(false)
			expect(fits(ROUTE_ORIGIN_SLACK_M + 1, far)).toBe(false)
			expect(fits(far, ROUTE_DESTINATION_SLACK_M - 1)).toBe(true)
			expect(fits(far, ROUTE_DESTINATION_SLACK_M)).toBe(false)
			expect(fits(far, ROUTE_DESTINATION_SLACK_M + 1)).toBe(false)
			// outside both slacks the angle decides, at and just past its bound
			const at = (off: number) =>
				routeFits({ fromOriginM: far, toDestinationM: far, offCourseDeg: off })
			expect(at(ROUTE_MAX_OFF_COURSE_DEG)).toBe(true)
			expect(at(ROUTE_MAX_OFF_COURSE_DEG + 1e-9)).toBe(false)
		})

		it("hysteresis: a verdict flips only past bound + margin, and back only inside bound - margin", () => {
			expect(ROUTE_OFF_COURSE_MARGIN_DEG).toBe(10)
			expect(ROUTE_SLACK_MARGIN_M).toBe(5_000)
			const far = 500_000
			const angle = (off: number, previous?: boolean) =>
				routeFits(
					{ fromOriginM: far, toDestinationM: far, offCourseDeg: off },
					previous,
				)
			// fitting: keeps fitting up to and at 110°, stops just past it
			expect(angle(ROUTE_MAX_OFF_COURSE_DEG + 5, true)).toBe(true)
			expect(angle(110, true)).toBe(true)
			expect(angle(110 + 1e-9, true)).toBe(false)
			// not fitting: stays so down to just over 90°, fits again at 90°
			expect(angle(ROUTE_MAX_OFF_COURSE_DEG - 5, false)).toBe(false)
			expect(angle(90 + 1e-9, false)).toBe(false)
			expect(angle(90, false)).toBe(true)
			// no previous verdict: the plain bound
			expect(angle(100)).toBe(true)
			expect(angle(100 + 1e-9)).toBe(false)
			const away = 180
			const place = (
				fromOriginM: number,
				toDestinationM: number,
				previous: boolean,
			) =>
				routeFits({ fromOriginM, toDestinationM, offCourseDeg: away }, previous)
			// origin slack: 85 km to stop fitting, 75 km to fit again
			expect(place(85_000 - 1, far, true)).toBe(true)
			expect(place(85_000, far, true)).toBe(false)
			expect(place(75_000, far, false)).toBe(false)
			expect(place(75_000 - 1, far, false)).toBe(true)
			// destination slack: 35 km and 25 km
			expect(place(far, 35_000 - 1, true)).toBe(true)
			expect(place(far, 35_000, true)).toBe(false)
			expect(place(far, 25_000, false)).toBe(false)
			expect(place(far, 25_000 - 1, false)).toBe(true)
		})

		it("the tracker's verdict does not flap while the course hovers near the bound", async () => {
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
			// the fixture's airports both sit at 48.7, 2.3; the aircraft is far from both
			const at = { lat: 47.0, lon: -8.0 }
			const bearing = initialBearingDeg(at.lat, at.lon, 48.7, 2.3)
			const verdicts: Array<boolean | undefined> = []
			for (const off of [0, 105, 95, 109, 111, 105, 95, 91, 89, 95, 105]) {
				tracker.processUpdate({
					hex: "0A0B11",
					flight: "WKS101",
					...at,
					track: (bearing + off + 360) % 360,
				})
				await flush()
				verdicts.push(tracker.get("0A0B11")?.identification?.route?.plausible)
			}
			expect(verdicts).toEqual([
				true, // 0°
				true, // 105°: within 110
				true,
				true, // 109°
				false, // 111°: past 110
				false, // 105°
				false, // 95°
				false, // 91°
				true, // 89°: within 90
				true,
				true, // 105° again: still within 110
			])
		})

		it("the tracker carries the verdict and keeps it current as the aircraft turns", async () => {
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
			// the fixture's airports both sit at 48.7, 2.3: from the ocean point to their west-south-west,
			// heading east-north-east (about 76°) fits and the reverse does not
			tracker.processUpdate({
				hex: "0A0B11",
				flight: "WKS101",
				lat: 47.0,
				lon: -8.0,
				track: 75,
			})
			await flush()
			expect(tracker.get("0A0B11")?.identification?.route?.plausible).toBe(true)
			tracker.processUpdate({
				hex: "0A0B11",
				flight: "WKS101",
				lat: 47.0,
				lon: -8.0,
				track: 255,
			})
			await flush()
			expect(tracker.get("0A0B11")?.identification?.route?.plausible).toBe(
				false,
			)
		})
	})
})
