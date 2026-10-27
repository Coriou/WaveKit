import {
	guardScan,
	parseScanEvent,
} from "../../../cli/source/data/scanner-guards.js"
import type { ScannerRouteService } from "../../../src/api/routes/scanner.js"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	discoveryQuerySchema,
	IDENTITY_QUERY,
} from "../../../src/api/routes/scanner-schemas.js"

describe("scanner query schemas: ADS-B", () => {
	let app: FastifyInstance
	afterEach(async () => {
		await app.close()
	})

	it("accepts ?protocol=adsb and still refuses an unknown protocol", async () => {
		app = Fastify({ logger: false })
		app.get("/q", { schema: { querystring: discoveryQuerySchema } }, req => ({
			query: req.query,
		}))
		await app.ready()
		const ok = await app.inject({ method: "GET", url: "/q?protocol=adsb" })
		expect(ok.statusCode).toBe(200)
		expect(ok.json().query.protocol).toBe("adsb")
		const bad = await app.inject({ method: "GET", url: "/q?protocol=modes" })
		expect(bad.statusCode).toBe(400)
	})

	it("an icao identity is a known identity kind", () => {
		expect(IDENTITY_QUERY.exec("icao:4840d6")?.slice(1)).toEqual([
			"icao",
			"4840d6",
		])
	})
})

it("exposes decode anchors and aircraft counts on discovery list and detail responses", async () => {
	const { scannerRoutes } = await import("../../../src/api/routes/scanner.js")
	const { DiscoveryStore } =
		await import("../../../src/core/scanner/store/discovery-store.js")
	const at = Date.UTC(2026, 9, 27)
	const store = new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => at,
		newId: () => "anchor",
	})
	store.anchorDecode(
		"rtl",
		1_090_000_000,
		{
			protocol: "adsb",
			origin: "ambient",
			crcClean: true,
			identity: { kind: "icao", value: "abc123" },
			epoch: 1,
			at,
			metadata: {},
		},
		"commanded",
	)
	const app = Fastify({ logger: false })
	try {
		await app.register(scannerRoutes, {
			scanner: {
				listDiscoveries: () => store.list({}),
				getDiscovery: (id: string) => store.get(id),
				discoveryObservations: (id: string) =>
					store.observations(id, null, 100),
			} as unknown as ScannerRouteService,
		})
		const list = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries",
		})
		expect(list.statusCode).toBe(200)
		expect(list.json().items[0]).toMatchObject({
			anchor: "decode",
			aircraftCount: 1,
			frequencyHz: 1_090_000_000,
			proof: { kind: "decoded" },
		})
		const detail = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries/d_anchor",
		})
		expect(detail.statusCode).toBe(200)
		expect(detail.json()).toMatchObject({ anchor: "decode", aircraftCount: 1 })
		for (const body of [list.json().items[0], detail.json()])
			for (const key of ["bandwidthHz", "airtimeMs", "measuredOffsetHz"])
				expect(body).toHaveProperty(key, 0)
		for (const body of [list.json().items[0], detail.json()]) {
			expect(body.signal).toEqual({
				best: { peakDbfs: 0, meanDbfs: 0, snrDb: 0, floorDbfs: 0 },
				last: { peakDbfs: 0, meanDbfs: 0, snrDb: 0, floorDbfs: 0 },
			})
			expect(guardScan("discovery", body)).toBeDefined()
			expect(
				parseScanEvent("scanner:discovery", {
					change: "updated",
					discovery: body,
				}),
			).toEqual({
				type: "scanner:invalidate",
				key: "discovery:d_anchor",
			})
		}
		expect(guardScan("discoveries", list.json())).toBeDefined()
		const observations = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries/d_anchor/observations",
		})
		expect(observations.statusCode).toBe(200)
		expect(observations.json().items[0]).toMatchObject({
			obwHz: 0,
			obwMethod: "on-bins",
			peakDbfs: 0,
			meanDbfs: 0,
			snrDb: 0,
			floorDbfs: 0,
			thresholdDb: 0,
			dutyCycle: 0,
		})
	} finally {
		store.stopAnchorExpiry()
		await app.close()
	}
})
