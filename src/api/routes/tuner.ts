/**
 * Tuner Routes - RTL-TCP tuner control endpoints
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify"
import type { TunerController } from "../../core/tuner-controller.js"
import type {
	TunerState,
	SetFrequencyRequest,
	SetGainRequest,
	SetGainModeRequest,
	SetSampleRateRequest,
	SetPpmRequest,
	SetBooleanRequest,
	SetDirectSamplingRequest,
	SetControlModeRequest,
	SetIfGainRequest,
	SetTunerIfGainRequest,
	SetTunerGainIndexRequest,
	SetXtalRequest,
	TunerConfigUpdate,
} from "@wavekit/api-types"

const tunerIfGainSchema = {
	type: "object",
	nullable: true,
	properties: {
		stage: { type: "integer" },
		gain: { type: "integer" },
	},
	required: ["stage", "gain"],
} as const

const tunerStateSchema = {
	type: "object",
	properties: {
		sourceId: { type: "string" },
		frequency: { type: "integer" },
		sampleRate: { type: "integer" },
		gainMode: { type: "string", enum: ["manual", "agc"] },
		gain: { type: "integer" },
		ppm: { type: "integer" },
		agcMode: { type: "boolean" },
		biasTee: { type: "boolean" },
		directSampling: { type: "string", enum: ["off", "i", "q"] },
		offsetTuning: { type: "boolean" },
		ifGain: { type: "integer" },
		tunerIfGain: tunerIfGainSchema,
		testMode: { type: "boolean" },
		rtlXtal: { type: "integer" },
		tunerXtal: { type: "integer" },
		tunerGainIndex: { type: "integer" },
		controlMode: { type: "string", enum: ["internal", "external"] },
		lastCommandAt: { type: "string", format: "date-time" },
		lastError: { type: "string" },
		commandCount: { type: "integer" },
	},
	required: [
		"sourceId",
		"frequency",
		"sampleRate",
		"gainMode",
		"gain",
		"ppm",
		"agcMode",
		"biasTee",
		"directSampling",
		"offsetTuning",
		"ifGain",
		"testMode",
		"controlMode",
		"commandCount",
	],
} as const

const errorResponseSchema = {
	type: "object",
	properties: {
		error: { type: "string" },
		code: { type: "string" },
		message: { type: "string" },
	},
	required: ["error", "code", "message"],
} as const

const tunerConfigUpdateSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		frequency: { type: "integer" },
		sampleRate: { type: "integer" },
		gainMode: { type: "string", enum: ["manual", "agc"] },
		gain: { type: "integer" },
		ppm: { type: "integer" },
		agcMode: { type: "boolean" },
		biasTee: { type: "boolean" },
		directSampling: { type: "string", enum: ["off", "i", "q"] },
		offsetTuning: { type: "boolean" },
		ifGain: { type: "integer" },
		tunerIfGain: tunerIfGainSchema,
		testMode: { type: "boolean" },
		rtlXtal: { type: "integer" },
		tunerXtal: { type: "integer" },
		tunerGainIndex: { type: "integer" },
		controlMode: { type: "string", enum: ["internal", "external"] },
	},
} as const

export interface TunerRoutesOptions {
	tunerController: TunerController
}

function handleTunerError(reply: FastifyReply, err: unknown): unknown {
	const error = err instanceof Error ? err : new Error("Unknown error")
	const maybeStatus = err as { statusCode?: number; code?: string }
	const statusCode =
		typeof maybeStatus?.statusCode === "number" ? maybeStatus.statusCode : 500
	const code =
		typeof maybeStatus?.code === "string" ? maybeStatus.code : "TUNER_ERROR"

	return reply.status(statusCode).send({
		error: error.name || "TunerError",
		code,
		message: error.message,
	})
}

export const tunerRoutes: FastifyPluginAsync<TunerRoutesOptions> = async (
	fastify: FastifyInstance,
	options: TunerRoutesOptions,
) => {
	const { tunerController } = options

	// GET /api/tuner - List all tuner states
	fastify.get<{ Reply: TunerState[] }>(
		"/api/tuner",
		{
			schema: {
				tags: ["tuner"],
				summary: "Get all tuner states",
				description: "Returns tuner state for all RTL-TCP sources",
				response: {
					200: { type: "array", items: tunerStateSchema },
				},
			},
		},
		async () => tunerController.getAllStates(),
	)

	// GET /api/tuner/:sourceId - Get single tuner state
	fastify.get<{ Params: { sourceId: string }; Reply: TunerState | unknown }>(
		"/api/tuner/:sourceId",
		{
			schema: {
				tags: ["tuner"],
				summary: "Get tuner state",
				description: "Returns tuner state for a specific source",
				params: {
					type: "object",
					properties: { sourceId: { type: "string" } },
					required: ["sourceId"],
				},
				response: {
					200: tunerStateSchema,
					404: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			const state = tunerController.getState(request.params.sourceId)
			if (!state) {
				return reply.status(404).send({
					error: "NotFound",
					code: "TUNER_SOURCE_NOT_FOUND",
					message: `Tuner source not found: ${request.params.sourceId}`,
				})
			}
			return state
		},
	)

	// POST /api/tuner/:sourceId/frequency
	fastify.post<{
		Params: { sourceId: string }
		Body: SetFrequencyRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/frequency",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set frequency",
				body: {
					type: "object",
					properties: { hz: { type: "integer" } },
					required: ["hz"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setFrequency(
					request.params.sourceId,
					request.body.hz,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/gain
	fastify.post<{
		Params: { sourceId: string }
		Body: SetGainRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set gain",
				body: {
					type: "object",
					properties: { tenthsDb: { type: "integer" } },
					required: ["tenthsDb"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setGain(
					request.params.sourceId,
					request.body.tenthsDb,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/gain-mode
	fastify.post<{
		Params: { sourceId: string }
		Body: SetGainModeRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/gain-mode",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set gain mode",
				body: {
					type: "object",
					properties: { mode: { type: "string", enum: ["manual", "agc"] } },
					required: ["mode"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setGainMode(
					request.params.sourceId,
					request.body.mode,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/sample-rate
	fastify.post<{
		Params: { sourceId: string }
		Body: SetSampleRateRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/sample-rate",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set sample rate",
				body: {
					type: "object",
					properties: { hz: { type: "integer" } },
					required: ["hz"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setSampleRate(
					request.params.sourceId,
					request.body.hz,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/ppm
	fastify.post<{
		Params: { sourceId: string }
		Body: SetPpmRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/ppm",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set PPM correction",
				body: {
					type: "object",
					properties: { ppm: { type: "integer" } },
					required: ["ppm"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setPpm(request.params.sourceId, request.body.ppm)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/if-gain
	fastify.post<{
		Params: { sourceId: string }
		Body: SetIfGainRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/if-gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set IF gain",
				body: {
					type: "object",
					properties: { gain: { type: "integer" } },
					required: ["gain"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setIfGain(
					request.params.sourceId,
					request.body.gain,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/test-mode
	fastify.post<{
		Params: { sourceId: string }
		Body: SetBooleanRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/test-mode",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set test mode",
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" } },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setTestMode(
					request.params.sourceId,
					request.body.enabled,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/agc
	fastify.post<{
		Params: { sourceId: string }
		Body: SetBooleanRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/agc",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set AGC mode",
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" } },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setAgcMode(
					request.params.sourceId,
					request.body.enabled,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/bias-tee
	fastify.post<{
		Params: { sourceId: string }
		Body: SetBooleanRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/bias-tee",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set bias-T power",
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" } },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setBiasTee(
					request.params.sourceId,
					request.body.enabled,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/direct-sampling
	fastify.post<{
		Params: { sourceId: string }
		Body: SetDirectSamplingRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/direct-sampling",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set direct sampling mode",
				body: {
					type: "object",
					properties: { mode: { type: "string", enum: ["off", "i", "q"] } },
					required: ["mode"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setDirectSampling(
					request.params.sourceId,
					request.body.mode,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/offset-tuning
	fastify.post<{
		Params: { sourceId: string }
		Body: SetBooleanRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/offset-tuning",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set offset tuning",
				body: {
					type: "object",
					properties: { enabled: { type: "boolean" } },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setOffsetTuning(
					request.params.sourceId,
					request.body.enabled,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/rtl-xtal
	fastify.post<{
		Params: { sourceId: string }
		Body: SetXtalRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/rtl-xtal",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set RTL XTAL frequency",
				body: {
					type: "object",
					properties: { hz: { type: "integer" } },
					required: ["hz"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setRtlXtal(
					request.params.sourceId,
					request.body.hz,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/tuner-xtal
	fastify.post<{
		Params: { sourceId: string }
		Body: SetXtalRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/tuner-xtal",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set tuner XTAL frequency",
				body: {
					type: "object",
					properties: { hz: { type: "integer" } },
					required: ["hz"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setTunerXtal(
					request.params.sourceId,
					request.body.hz,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/tuner-gain-index
	fastify.post<{
		Params: { sourceId: string }
		Body: SetTunerGainIndexRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/tuner-gain-index",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set tuner gain index",
				body: {
					type: "object",
					properties: { index: { type: "integer" } },
					required: ["index"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setTunerGainIndex(
					request.params.sourceId,
					request.body.index,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/tuner-if-gain
	fastify.post<{
		Params: { sourceId: string }
		Body: SetTunerIfGainRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/tuner-if-gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set tuner IF gain",
				body: {
					type: "object",
					properties: {
						stage: { type: "integer" },
						gain: { type: "integer" },
					},
					required: ["stage", "gain"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.setTunerIfGain(
					request.params.sourceId,
					request.body.stage,
					request.body.gain,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// POST /api/tuner/:sourceId/control-mode - Release/reclaim control
	fastify.post<{
		Params: { sourceId: string }
		Body: SetControlModeRequest
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/control-mode",
		{
			schema: {
				tags: ["tuner"],
				summary: "Set control mode",
				description:
					"Set to 'external' to release control to SDR++, 'internal' to reclaim control",
				body: {
					type: "object",
					properties: {
						mode: { type: "string", enum: ["internal", "external"] },
					},
					required: ["mode"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				tunerController.setControlMode(
					request.params.sourceId,
					request.body.mode,
				)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)

	// PATCH /api/tuner/:sourceId/config - Bulk update
	fastify.patch<{
		Params: { sourceId: string }
		Body: TunerConfigUpdate
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/config",
		{
			schema: {
				tags: ["tuner"],
				summary: "Update tuner configuration",
				description: "Apply multiple tuner settings at once",
				body: tunerConfigUpdateSchema,
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				await tunerController.configure(request.params.sourceId, request.body)
				return tunerController.getState(request.params.sourceId)
			} catch (err) {
				return handleTunerError(reply, err)
			}
		},
	)
}
