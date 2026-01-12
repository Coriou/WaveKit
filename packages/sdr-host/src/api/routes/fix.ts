import type { FastifyInstance } from "fastify"

interface FixResponse {
	issue: string
	description: string
	temporaryFix: string
	permanentFix: string
	documentation: string
}

/**
 * Registers GET /api/fix endpoint.
 */
export function registerFixRoutes(fastify: FastifyInstance): void {
	fastify.get("/api/fix", async (request, reply) => {
		const { preflightResult } = fastify

		// Check for DVB driver conflict
		if (
			preflightResult.dongle.driverConflict &&
			preflightResult.dongle.conflictingDriver
		) {
			const driver = preflightResult.dongle.conflictingDriver
			const response: FixResponse = {
				issue: "dvb_driver_conflict",
				description: `The ${driver} kernel driver has claimed the RTL-SDR device.`,
				temporaryFix: `sudo rmmod ${driver}`,
				permanentFix: `echo 'blacklist ${driver}' | sudo tee /etc/modprobe.d/blacklist-rtl.conf && sudo reboot`,
				documentation:
					"https://github.com/coriou/wavekit/blob/main/docs/SDR-HOST-SETUP.md#dvb-driver-conflict",
			}
			return reply.send(response)
		}

		// Check for missing dongle
		if (!preflightResult.dongle.present) {
			const response: FixResponse = {
				issue: "dongle_not_detected",
				description: "No RTL-SDR dongle was detected on USB.",
				temporaryFix: "Check USB cable connection and try a different port",
				permanentFix:
					"Ensure dongle is properly connected and detected by host with 'lsusb'",
				documentation:
					"https://github.com/coriou/wavekit/blob/main/docs/SDR-HOST-SETUP.md#dongle-detection",
			}
			return reply.send(response)
		}

		// No issues detected
		return reply.status(204).send()
	})
}
