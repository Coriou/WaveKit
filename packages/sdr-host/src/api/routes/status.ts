import type { FastifyInstance } from "fastify"
import type { SdrHostConfig } from "../../config.js"

/**
 * Registers GET /api/status endpoint.
 */
export function registerStatusRoutes(
	fastify: FastifyInstance,
	config: SdrHostConfig,
): void {
	fastify.get("/api/status", async (request, reply) => {
		const { processManager, preflightResult, startTime } = fastify
		const uptime = Math.floor((Date.now() - startTime) / 1000)

		const rtlTcpState = processManager.getRtlTcpState()
		const rtlmuxState = processManager.getRtlmuxState()
		const rtlmuxStats = processManager.getRtlmuxStats()

		const statsPort = config.rtlmux.port + 1
		const requestHost = request.hostname || "localhost"
		const endpoint = `tcp://${requestHost}:${config.rtlmux.port}`
		const statsUrl = `http://${requestHost}:${statsPort}/stats.json`

		const warnings: string[] = [...preflightResult.warnings]
		const errors: string[] = [...preflightResult.errors]

		if (!rtlTcpState.running && rtlTcpState.lastError) {
			errors.push(`rtl_tcp: ${rtlTcpState.lastError}`)
		}
		if (!rtlmuxState.running && rtlmuxState.lastError) {
			errors.push(`rtlmux: ${rtlmuxState.lastError}`)
		}

		return reply.send({
			version: "1.0.0",
			uptime,
			dongle: preflightResult.dongle,
			rtlTcp: {
				running: rtlTcpState.running,
				pid: rtlTcpState.pid,
				restartCount: rtlTcpState.restartCount,
				lastRestartAt: rtlTcpState.lastRestartAt?.toISOString() ?? null,
				config: {
					sampleRate: config.rtlTcp.sampleRate,
					frequency: config.rtlTcp.frequency,
					buffer: config.rtlTcp.buffer,
					agc: config.rtlTcp.agc,
					gain: config.rtlTcp.gain,
					ppm: config.rtlTcp.ppm,
				},
			},
			rtlmux: {
				running: rtlmuxState.running,
				pid: rtlmuxState.pid,
				restartCount: rtlmuxState.restartCount,
				lastRestartAt: rtlmuxState.lastRestartAt?.toISOString() ?? null,
				endpoint,
				statsUrl,
				stats: rtlmuxStats,
			},
			warnings,
			errors,
		})
	})
}
