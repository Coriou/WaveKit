import { DECODER_LAST_ERROR_MAX_LENGTH } from "@wavekit/api-types"

/**
 * Optional DecoderStatus fields from CLI-COORDINATION requests 2-4. Response
 * schemas strip unknown properties, so every decoder status schema spreads these.
 */
export const decoderStatusExtensionProperties = {
	sourceId: { type: "string" },
	deviceSerial: { type: "string" },
	targetFrequenciesHz: {
		type: "array",
		items: { type: "number", exclusiveMinimum: 0 },
	},
	lastError: {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["error", "exit"] },
			message: { type: "string", maxLength: DECODER_LAST_ERROR_MAX_LENGTH },
			at: { type: "string", format: "date-time" },
		},
		required: ["kind", "message", "at"],
	},
	idleTimeoutMs: { type: "number", minimum: 0 },
} as const
