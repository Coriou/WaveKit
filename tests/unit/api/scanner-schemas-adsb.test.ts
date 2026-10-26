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
