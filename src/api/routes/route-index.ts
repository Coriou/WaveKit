import type { FastifyInstance } from "fastify"
import {
	API_ENUMS_PATH,
	OPENAPI_DOCUMENT_PATH,
	type ApiRouteIndex,
	type ApiRouteIndexEntry,
} from "@wavekit/api-types"

/**
 * Route schemas use Ajv's `nullable` and its tuple form `items: [...]`, which OpenAPI 3.1 does not
 * have: left in, a reader would take those fields as never null, and a strict tool refuses the
 * tuple. A copy, because the schemas themselves still drive validation.
 */
export function toOpenApi31Forms<T>(value: T): T
export function toOpenApi31Forms(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => toOpenApi31Forms(item))
	if (typeof value !== "object" || value === null) return value
	const { nullable, ...rest } = value as Record<string, unknown>
	const copy = Object.fromEntries(
		Object.entries(rest).map(([key, child]) => [
			// A property named "items" holds a schema, never an array: only a tuple is one.
			key === "items" && Array.isArray(child) ? "prefixItems" : key,
			toOpenApi31Forms(child),
		]),
	)
	// A property named "nullable" holds a schema: that key stays.
	if (typeof nullable !== "boolean")
		return nullable === undefined
			? copy
			: { ...copy, nullable: toOpenApi31Forms(nullable) }
	if (!nullable) return copy
	const type = copy["type"]
	if (type === undefined) return { anyOf: [copy, { type: "null" }] }
	const types = Array.isArray(type) ? (type as unknown[]) : [type]
	return {
		...copy,
		type: types.includes("null") ? types : [...types, "null"],
		...(Array.isArray(copy["enum"]) && !copy["enum"].includes(null)
			? { enum: [...(copy["enum"] as unknown[]), null] }
			: {}),
	}
}

/**
 * Install on the root before plugins so encapsulated and schema-less routes appear too. Call what
 * it returns after the OpenAPI plugin loads, so that GET /api is in the document as well.
 */
export function installRouteIndex(app: FastifyInstance): () => void {
	const routes = new Map<string, ApiRouteIndexEntry>()
	app.addHook("onRoute", route => {
		for (const method of Array.isArray(route.method)
			? route.method
			: [route.method]) {
			routes.set(`${method} ${route.url}`, {
				method,
				path: route.url,
				summary: route.schema?.summary ?? null,
				tags: [...(route.schema?.tags ?? [])],
			})
		}
	})
	return () => {
		// Root access admission applies just as for all other GET routes.
		app.get(
			"/api",
			{
				schema: { summary: "List registered routes", tags: ["system"] },
			},
			async (): Promise<ApiRouteIndex> => ({
				openapi: OPENAPI_DOCUMENT_PATH,
				enums: API_ENUMS_PATH,
				routes: [...routes.values()].sort(
					(a, b) =>
						a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
				),
			}),
		)
	}
}
