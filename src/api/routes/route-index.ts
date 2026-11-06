import type { FastifyInstance } from "fastify"
import {
	API_ENUMS_PATH,
	OPENAPI_DOCUMENT_PATH,
	type ApiRouteIndex,
	type ApiRouteIndexEntry,
} from "@wavekit/api-types"

/** Install on the root before plugins so encapsulated and schema-less routes appear too. */
export function registerRouteIndex(app: FastifyInstance): void {
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
