import Fastify from "fastify"
import swagger from "@fastify/swagger"
import { expect, it } from "vitest"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import {
	installRouteIndex,
	toOpenApi31Forms,
} from "../../../src/api/routes/route-index.js"

function* schemasIn(value: unknown): Generator<Record<string, unknown>> {
	if (Array.isArray(value)) {
		for (const item of value) yield* schemasIn(item)
	} else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>
		yield record
		for (const child of Object.values(record)) yield* schemasIn(child)
	}
}

it("turns a tuple into prefixItems, and nothing else named items", () => {
	expect(
		toOpenApi31Forms({
			tuple: {
				type: "array",
				items: [{ type: "number", nullable: true }, { type: "string" }],
				minItems: 2,
				maxItems: 2,
			},
			list: { type: "array", items: { type: "string" } },
			properties: { items: { type: "array", items: { type: "number" } } },
			required: ["items"],
		}),
	).toEqual({
		tuple: {
			type: "array",
			prefixItems: [{ type: ["number", "null"] }, { type: "string" }],
			minItems: 2,
			maxItems: 2,
		},
		list: { type: "array", items: { type: "string" } },
		properties: { items: { type: "array", items: { type: "number" } } },
		required: ["items"],
	})
})

it("turns what follows a tuple into items, and the old key goes", () => {
	expect(
		toOpenApi31Forms({
			closed: { items: [{ type: "number" }], additionalItems: false },
			open: {
				items: [{ type: "number" }],
				additionalItems: { type: "string", nullable: true },
			},
			// A property of that name, and a list where the keyword means nothing: both stay.
			properties: { additionalItems: { type: "string" } },
			list: { items: { type: "string" }, additionalItems: false },
		}),
	).toEqual({
		closed: { prefixItems: [{ type: "number" }], items: false },
		open: {
			prefixItems: [{ type: "number" }],
			items: { type: ["string", "null"] },
		},
		properties: { additionalItems: { type: "string" } },
		list: { items: { type: "string" }, additionalItems: false },
	})
})

it("documents the activity trails tuple with no array-valued items", async () => {
	const app = Fastify()
	await app.register(swagger, {
		openapi: { openapi: "3.1.0", info: { title: "test", version: "1" } },
	})
	await app.register(activityRoutes, { service: {} as never, enabled: true })
	try {
		await app.ready()
		const { paths } = toOpenApi31Forms(
			(
				app as unknown as {
					swagger(): { paths: Record<string, unknown> }
				}
			).swagger(),
		)
		const trails = paths["/api/activity/trails"]
		expect(trails).toBeDefined()
		const schemas = [...schemasIn(trails)]
		expect(schemas.some(node => Array.isArray(node["prefixItems"]))).toBe(true)
		expect(schemas.filter(node => Array.isArray(node["items"]))).toEqual([])
	} finally {
		await app.close()
	}
})

it("indexes every method, encapsulated route and schema including itself", async () => {
	const app = Fastify()
	const mountRouteIndex = installRouteIndex(app)
	await app.register(swagger)
	mountRouteIndex()
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
		expect(response.json().openapi).toBe("/docs/json")
		expect(response.json().enums).toBe("/api/enums")
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
