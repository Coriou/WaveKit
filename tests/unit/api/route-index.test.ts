import Fastify from "fastify"
import swagger from "@fastify/swagger"
import { expect, it } from "vitest"
import { registerRouteIndex } from "../../../src/api/routes/route-index.js"

it("indexes every method, encapsulated route and schema including itself", async () => {
	const app = Fastify()
	registerRouteIndex(app)
	await app.register(swagger)
	await app.register(async child => {
		child.route({
			method: ["GET", "POST"],
			url: "/synthetic",
			schema: { summary: "Synthetic route", tags: ["test"] },
			handler: async () => ({}),
		})
		child.get("/bare", async () => ({}))
	})
	try {
		const response = await app.inject("/api")
		expect(response.statusCode).toBe(200)
		expect(response.json().routes).toEqual(
			expect.arrayContaining([
				{
					method: "GET",
					path: "/api",
					summary: "List registered routes",
					tags: ["system"],
				},
				{
					method: "GET",
					path: "/synthetic",
					summary: "Synthetic route",
					tags: ["test"],
				},
				{
					method: "POST",
					path: "/synthetic",
					summary: "Synthetic route",
					tags: ["test"],
				},
				{
					method: "HEAD",
					path: "/synthetic",
					summary: "Synthetic route",
					tags: ["test"],
				},
				{ method: "GET", path: "/bare", summary: null, tags: [] },
			]),
		)
	} finally {
		await app.close()
	}
})
