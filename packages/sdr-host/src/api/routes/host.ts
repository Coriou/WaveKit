import type { FastifyInstance } from "fastify"

/**
 * Registers GET /api/host: cached Pi host telemetry and first-boot status.
 * Each section states its scope and freshness; nothing is measured per request.
 */
export function registerHostRoutes(fastify: FastifyInstance): void {
	fastify.get("/api/host", async (request, reply) => {
		return reply.send(fastify.hostTelemetry.snapshot())
	})
}
