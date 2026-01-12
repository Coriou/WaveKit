import type { FastifyInstance } from "fastify"

export interface HealthResponse {
	healthy: boolean
	uptime: number
	checks: {
		dongle: "ok" | "error"
		rtlTcp: "ok" | "error"
		rtlmux: "ok" | "error"
	}
	reason?: string
}

/**
 * Registers GET /health endpoint.
 */
export function registerHealthRoutes(fastify: FastifyInstance): void {
	fastify.get("/health", async (request, reply) => {
		const { processManager, preflightResult, startTime } = fastify
		const uptime = Math.floor((Date.now() - startTime) / 1000)

		const rtlTcpState = processManager.getRtlTcpState()
		const rtlmuxState = processManager.getRtlmuxState()

		const checks = {
			dongle: preflightResult.dongle.present
				? ("ok" as const)
				: ("error" as const),
			rtlTcp: rtlTcpState.running ? ("ok" as const) : ("error" as const),
			rtlmux: rtlmuxState.running ? ("ok" as const) : ("error" as const),
		}

		const healthy = Object.values(checks).every(v => v === "ok")

		const response: HealthResponse = {
			healthy,
			uptime,
			checks,
		}

		// Add reason if unhealthy
		if (!healthy) {
			const reasons: string[] = []
			if (checks.dongle === "error") reasons.push("dongle not detected")
			if (checks.rtlTcp === "error") reasons.push("rtl_tcp not running")
			if (checks.rtlmux === "error") reasons.push("rtlmux not running")
			response.reason = reasons.join(", ")
		}

		return reply.status(healthy ? 200 : 503).send(response)
	})
}
