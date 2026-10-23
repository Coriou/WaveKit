import type { FastifyInstance } from "fastify"
import type { SdrHostSamplingHistory } from "@wavekit/api-types"
import type { SdrHostConfig } from "../../config.js"
import { endpointsFromTelemetry } from "../../telemetry/endpoints.js"

export const SDR_HOST_VERSION = "1.0.0"

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
			version: SDR_HOST_VERSION,
			iqDelivery: { modes: ["raw"] },
			receiverId: fastify.receiverId,
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
			// Upstream sample evidence, independent of USB/process presence and
			// of downstream clients (rtlmux reads upstream with zero clients).
			sampling: processManager.getSampling(),
			delivery: processManager.getDelivery(),
			samplingHistory: {
				pollIntervalMs: 2000,
				windowMs: 5 * 60_000,
				points: processManager.getSamplingHistory(),
			} satisfies SdrHostSamplingHistory,
			// Every address a client may dial, best first; null while the host
			// network is not visible (receiver-endpoints 1.1-1.3).
			endpoints: endpointsFromTelemetry(
				fastify.hostTelemetry.snapshot().network,
				{
					iqPort: config.rtlmux.port,
					apiPort: config.api.port,
				},
			),
			warnings,
			errors,
		})
	})
}
