/**
 * Tuner Relay Routes - RTL-TCP relay status endpoint
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { TunerRelay, TunerRelayStatus } from "../../core/tuner-relay.js"

const tunerRelayStatusSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		listening: { type: "boolean" },
		host: { type: "string" },
		port: { type: "number" },
		sourceId: { type: "string" },
		sourceConnected: { type: "boolean" },
		sourceKind: { type: "string" },
		sourceFormat: { type: "string" },
		compatibility: {
			type: "string",
			enum: ["ok", "missing-source", "unsupported-kind", "unsupported-format"],
		},
		compatibilityMessage: { type: "string" },
		clientsConnected: { type: "number" },
		controlClientId: { type: "string" },
		controlClientRemote: { type: "string" },
		controlPolicy: { type: "string", enum: ["exclusive", "shared"] },
		maxClients: { type: "number" },
		bytesSent: { type: "number" },
		bytesReceived: { type: "number" },
		lastCommand: { type: "string" },
		lastCommandAt: { type: "string", format: "date-time" },
		lastFrequency: { type: "number" },
		lastSampleRate: { type: "number" },
		lastGain: { type: "number" },
		lastPpm: { type: "number" },
		lastError: { type: "string" },
		rtlTcpHeader: {
			type: "object",
			properties: {
				magic: { type: "string" },
				tunerType: { type: "number" },
				gainCount: { type: "number" },
			},
			required: ["magic", "tunerType", "gainCount"],
		},
	},
	required: [
		"enabled",
		"listening",
		"host",
		"port",
		"clientsConnected",
		"controlPolicy",
		"bytesSent",
		"bytesReceived",
	],
} as const

export interface TunerRelayRoutesOptions {
	tunerRelay: TunerRelay
}

export const tunerRelayRoutes: FastifyPluginAsync<
	TunerRelayRoutesOptions
> = async (fastify: FastifyInstance, options: TunerRelayRoutesOptions) => {
	const { tunerRelay } = options

	fastify.get<{ Reply: TunerRelayStatus }>(
		"/api/tuner-relay",
		{
			schema: {
				tags: ["tuner-relay"],
				summary: "Get tuner relay status",
				description: "Returns RTL-TCP tuner relay status and connection info",
				response: {
					200: tunerRelayStatusSchema,
				},
			},
		},
		async () => tunerRelay.getStatus(),
	)
}
