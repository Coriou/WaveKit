/**
 * Digital Voice Routes - decoded dsd-fme voice stream status and control
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { DigitalVoiceStatus } from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import type { DigitalVoiceService } from "../../core/digital-voice.js"

const nullableString = { type: ["string", "null"] } as const
const nullableNumber = { type: ["number", "null"] } as const

const digitalVoiceCallSchema = {
	type: "object",
	properties: {
		decoderId: { type: "string" },
		callId: { type: "string" },
		protocol: nullableString,
		talkgroup: nullableNumber,
		source: nullableNumber,
		slot: nullableNumber,
		encrypted: { type: "boolean" },
		active: { type: "boolean" },
		startedAt: { type: "string" },
		endedAt: { type: "string" },
	},
	required: [
		"decoderId",
		"callId",
		"protocol",
		"talkgroup",
		"source",
		"slot",
		"encrypted",
		"active",
		"startedAt",
	],
} as const

const nullableCallSchema = {
	anyOf: [digitalVoiceCallSchema, { type: "null" }],
} as const

const digitalVoiceConfigSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		httpPort: { type: "number" },
		voiceSlot: {
			anyOf: [
				{ type: "number", enum: [1, 2] },
				{ type: "string", enum: ["both"] },
			],
		},
		jitterBufferMs: { type: "number" },
		maxBufferMs: { type: "number" },
	},
	required: [
		"enabled",
		"httpPort",
		"voiceSlot",
		"jitterBufferMs",
		"maxBufferMs",
	],
} as const

const digitalVoiceDecoderSchema = {
	type: "object",
	properties: {
		decoderId: { type: "string" },
		mode: { type: "string" },
		udpPort: { type: "number" },
		httpUrl: { type: "string" },
		wavUrl: { type: "string" },
		clientCount: { type: "number" },
		bytesStreamed: { type: "number" },
		datagramsReceived: { type: "number" },
		datagramsRejected: { type: "number" },
		encryptedDatagramsDropped: { type: "number" },
		droppedSamples: { type: "number" },
		underruns: { type: "number" },
		bufferedMs: { type: "number" },
		lastDatagramAt: { type: "string" },
		call: nullableCallSchema,
		lastCall: digitalVoiceCallSchema,
	},
	required: [
		"decoderId",
		"mode",
		"udpPort",
		"httpUrl",
		"wavUrl",
		"clientCount",
		"bytesStreamed",
		"datagramsReceived",
		"datagramsRejected",
		"encryptedDatagramsDropped",
		"droppedSamples",
		"underruns",
		"bufferedMs",
		"call",
	],
} as const

export const digitalVoiceStatusSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		running: { type: "boolean" },
		config: digitalVoiceConfigSchema,
		sampleRate: { type: "number" },
		audioFormat: { type: "string", enum: ["s16le"] },
		channels: { type: "number", enum: [1] },
		httpUrl: { type: "string" },
		wavUrl: { type: "string" },
		clientCount: { type: "number" },
		bytesStreamed: { type: "number" },
		decoders: { type: "array", items: digitalVoiceDecoderSchema },
		call: nullableCallSchema,
		lastError: { type: "string" },
	},
	required: [
		"enabled",
		"running",
		"config",
		"sampleRate",
		"audioFormat",
		"channels",
		"httpUrl",
		"wavUrl",
		"clientCount",
		"bytesStreamed",
		"decoders",
		"call",
	],
} as const

const actionResponseSchema = {
	type: "object",
	properties: { success: { type: "boolean" } },
	required: ["success"],
} as const

const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
	},
	required: ["error", "message"],
} as const

export interface DigitalVoiceRoutesOptions {
	digitalVoice: DigitalVoiceService
}

export const digitalVoiceRoutes: FastifyPluginAsync<
	DigitalVoiceRoutesOptions
> = async (fastify: FastifyInstance, options: DigitalVoiceRoutesOptions) => {
	const { digitalVoice } = options

	fastify.get<{ Reply: DigitalVoiceStatus }>(
		"/api/digital-voice/status",
		{
			schema: {
				tags: ["digital-voice"],
				summary: "Get digital voice status",
				description:
					"Digital voice stream status: format, per-decoder streams and counters, and the current call",
				response: { 200: digitalVoiceStatusSchema },
			},
		},
		async () => digitalVoice.getStatus(),
	)

	fastify.post<{
		Reply:
			| { success: boolean }
			| { error: string; code: string; message: string }
	}>(
		"/api/digital-voice/start",
		{
			schema: {
				tags: ["digital-voice"],
				summary: "Start the digital voice stream",
				description:
					"Starts the HTTP stream and pacing. 409 when no dsd-fme decoder streams voice (digital voice disabled at startup, or every decoder sets its own output).",
				response: { 200: actionResponseSchema, 409: errorResponseSchema },
			},
		},
		async (_request, reply) => {
			try {
				await digitalVoice.start()
			} catch (err) {
				if (
					err instanceof WaveKitError &&
					err.code === "DIGITAL_VOICE_UNAVAILABLE"
				) {
					return reply.code(409).send({
						error: "Conflict",
						code: err.code,
						message: err.message,
					})
				}
				throw err
			}
			return { success: true }
		},
	)

	fastify.post<{ Reply: { success: boolean } }>(
		"/api/digital-voice/stop",
		{
			schema: {
				tags: ["digital-voice"],
				summary: "Stop the digital voice stream",
				description:
					"Stops the HTTP stream (clients are disconnected). dsd-fme keeps decoding call metadata.",
				response: { 200: actionResponseSchema },
			},
		},
		async () => {
			await digitalVoice.stop()
			return { success: true }
		},
	)
}
