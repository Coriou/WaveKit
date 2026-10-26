import type { FastifyInstance } from "fastify"

/** Install on the root before plugins so encapsulated and schema-less routes appear too. */
export function registerRouteIndex(app: FastifyInstance): void {
	const routes = new Map<
		string,
		{
			method: string
			path: string
			summary: string | null
			tags: string[]
		}
	>()
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
		async () => ({
			routes: [...routes.values()].sort(
				(a, b) =>
					a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
			),
		}),
	)
}
