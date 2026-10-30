/**
 * Tuner Routes - RTL-TCP tuner control endpoints
 */

import type { SourceManager } from "../../core/source-manager.js"
import { TUNER_REST_COMMAND_POLICY } from "../../core/tuner-controller.js"
import type {
	FastifyError,
	FastifyInstance,
	FastifyPluginAsync,
	FastifyReply,
} from "fastify"
import {
	BandGainSettingsError,
	type BandGainSettingsService,
} from "../../core/band-gain.js"
import type {
	TunerController,
	TunerWriteOptions,
} from "../../core/tuner-controller.js"
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

/** Every REST tuner write is an operator command (signal discovery spec § 10.3). */
const REST: TunerWriteOptions = { origin: "rest" }

const gainModeSchema = {
	type: "string",
	enum: [...TUNER_REST_COMMAND_POLICY[2].rule.values],
}
const directSamplingSchema = {
	type: "string",
	enum: [...TUNER_REST_COMMAND_POLICY[8].rule.values],
}
const testModeSchema = { type: TUNER_REST_COMMAND_POLICY[6].rule.kind }
const agcModeSchema = { type: TUNER_REST_COMMAND_POLICY[7].rule.kind }
const offsetTuningSchema = { type: TUNER_REST_COMMAND_POLICY[9].rule.kind }
const biasTeeSchema = { type: TUNER_REST_COMMAND_POLICY[13].rule.kind }

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
		gainMode: gainModeSchema,
		gain: { type: "integer" },
		ppm: { type: "integer" },
		agcMode: agcModeSchema,
		biasTee: biasTeeSchema,
		directSampling: directSamplingSchema,
		offsetTuning: offsetTuningSchema,
		ifGain: { type: "integer" },
		tunerIfGain: tunerIfGainSchema,
		testMode: testModeSchema,
		rtlXtal: { type: "integer" },
		tunerXtal: { type: "integer" },
		tunerGainIndex: { type: "integer" },
		controlMode: { type: "string", enum: ["internal", "external"] },
		lastCommandAt: { type: "string", format: "date-time" },
		lastError: { type: "string" },
		commandCount: { type: "integer" },
		unknownFields: { type: "array", items: { type: "string" } },
		declaredOnlyFields: { type: "array", items: { type: "string" } },
		bandGain: {
			type: "object",
			properties: {
				tenthsDb: { type: "integer" },
				label: { type: "string" },
				owner: { type: "string", enum: ["scanner", "user"] },
			},
			required: ["tenthsDb", "owner"],
		},
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
		gainMode: gainModeSchema,
		gain: { type: "integer" },
		ppm: { type: "integer" },
		agcMode: agcModeSchema,
		biasTee: biasTeeSchema,
		directSampling: directSamplingSchema,
		offsetTuning: offsetTuningSchema,
		ifGain: { type: "integer" },
		tunerIfGain: tunerIfGainSchema,
		testMode: testModeSchema,
		rtlXtal: { type: "integer" },
		tunerXtal: { type: "integer" },
		tunerGainIndex: { type: "integer" },
		controlMode: { type: "string", enum: ["internal", "external"] },
	},
} as const

export interface TunerRoutesOptions {
	tunerController: TunerController
	sourceManager?: Pick<SourceManager, "runTunerCommand">
	/** Per-band gain settings; GET/PUT /api/tuner-band-gain are mounted only with them. */
	bandGain?: BandGainSettingsService | null
}

const GAIN_EXPECTED =
	'{"gain": integer, gain in tenths of a dB (0-500, e.g. 372 = 37.2 dB)}; the deprecated alias "tenthsDb" takes the same unit, send exactly one'
const U32 = "unsigned 32-bit"

/**
 * What each tuner route expects, named in every 400 it answers (field names, types and
 * units). Static text: a 400 never echoes the submitted value.
 */
const EXPECTED_BODY: Readonly<Record<string, string>> = Object.freeze({
	"/api/tuner/:sourceId/frequency":
		'{"hz": integer, frequency in Hz (24000000-1900000000)}',
	"/api/tuner/:sourceId/gain": GAIN_EXPECTED,
	"/api/tuner/:sourceId/gain-mode": '{"mode": "manual" | "agc"}',
	"/api/tuner/:sourceId/sample-rate":
		'{"hz": integer, sample rate in Hz (225001-300000 or 900001-3200000)}',
	"/api/tuner/:sourceId/ppm":
		'{"ppm": integer, frequency correction in ppm (-500-500)}',
	"/api/tuner/:sourceId/if-gain": `{"gain": integer, RTL2832 IF gain (${U32})}`,
	"/api/tuner/:sourceId/test-mode": '{"enabled": boolean}',
	"/api/tuner/:sourceId/agc": '{"enabled": boolean}',
	"/api/tuner/:sourceId/bias-tee": '{"enabled": boolean}',
	"/api/tuner/:sourceId/direct-sampling": '{"mode": "off" | "i" | "q"}',
	"/api/tuner/:sourceId/offset-tuning": '{"enabled": boolean}',
	"/api/tuner/:sourceId/rtl-xtal": `{"hz": integer, crystal frequency in Hz (${U32})}`,
	"/api/tuner/:sourceId/tuner-xtal": `{"hz": integer, crystal frequency in Hz (${U32})}`,
	"/api/tuner/:sourceId/tuner-gain-index": `{"index": integer, tuner gain table index (${U32})}`,
	"/api/tuner/:sourceId/tuner-if-gain":
		'{"stage": integer (0-65535), "gain": integer, tenths of a dB (0-65535)}',
	"/api/tuner/:sourceId/control-mode": '{"mode": "internal" | "external"}',
	"/api/tuner-band-gain":
		'{"applyToMyTuning": boolean, "entries": [{"minHz": integer Hz, "maxHz": integer Hz, "gain": integer tenths of a dB (0-500) or "keep", "label"?: string}]}',
	"/api/tuner/:sourceId/config":
		'an object of tuner fields only: "frequency" (Hz), "sampleRate" (Hz), "gain" (tenths of a dB, 0-500), "gainMode" ("manual" | "agc"), "ppm", "agcMode", "biasTee", "directSampling", "offsetTuning", "ifGain", "tunerIfGain", "testMode", "rtlXtal" (Hz), "tunerXtal" (Hz), "tunerGainIndex", "controlMode"',
})

function expectedFor(url: string | undefined): string | undefined {
	return url !== undefined && Object.hasOwn(EXPECTED_BODY, url)
		? EXPECTED_BODY[url]
		: undefined
}

function handleTunerError(
	reply: FastifyReply,
	err: unknown,
	expected?: string,
): unknown {
	const error = err instanceof Error ? err : new Error("Unknown error")
	const maybeStatus = err as { statusCode?: number; code?: string }
	if (
		maybeStatus?.code === "SOURCE_RECONNECTING" ||
		maybeStatus?.code === "TUNER_COMMAND_TIMEOUT" ||
		maybeStatus?.code === "TUNER_QUEUE_FULL"
	) {
		reply.header("Retry-After", "1")
		return reply.status(503).send({
			error: error.name,
			code: maybeStatus.code,
			message: error.message,
		})
	}
	const statusCode =
		maybeStatus?.code === "SOURCE_NOT_FOUND"
			? 404
			: maybeStatus?.code === "SOURCE_DISCONNECTED"
				? 503
				: typeof maybeStatus?.statusCode === "number"
					? maybeStatus.statusCode
					: 500
	const code =
		maybeStatus?.code === "SOURCE_NOT_FOUND"
			? "TUNER_SOURCE_NOT_FOUND"
			: typeof maybeStatus?.code === "string"
				? maybeStatus.code
				: "TUNER_ERROR"

	// A 400 answers static text only: the controller's message can echo the submitted value.
	return reply.status(statusCode).send({
		error: error.name || "TunerError",
		code,
		message:
			statusCode === 400
				? expected !== undefined
					? `Invalid tuner value; expected ${expected}`
					: "Invalid tuner value"
				: error.message,
	})
}

/** Fastify body parser 400s (malformed or empty JSON body, bad content length). */
function isBodyParseError(error: FastifyError): boolean {
	return (
		error.statusCode === 400 &&
		typeof error.code === "string" &&
		error.code.startsWith("FST_ERR_CTP_")
	)
}

export const tunerRoutes: FastifyPluginAsync<TunerRoutesOptions> = async (
	fastify: FastifyInstance,
	options: TunerRoutesOptions,
) => {
	const { tunerController } = options

	// Scoped to these routes: a schema or body parse 400 names the expected fields and units
	// (static text, so it is safe with access configured). Anything else goes to the parent
	// handler.
	fastify.setErrorHandler((error: FastifyError, request, reply) => {
		if (error.validation || isBodyParseError(error)) {
			const expected = expectedFor(request.routeOptions.url)
			const part = error.validation
				? (error.validationContext ?? "body")
				: "body"
			return reply.status(400).send({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message:
					expected !== undefined
						? `Invalid request ${part}; expected ${expected}`
						: `Invalid request ${part}`,
			})
		}
		throw error
	})
	const run = async (
		id: string,
		command: () => Promise<unknown>,
	): Promise<unknown> => {
		const result = options.sourceManager
			? await options.sourceManager.runTunerCommand(id, command)
			: await command()
		return tunerController.getState(id) ?? result
	}

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
				return await run(request.params.sourceId, async () => {
					// Prove the held rate once per connection first; a failed
					// write fails the request before any frequency write.
					if (!tunerController.hasBeforeOperatorRetune?.())
						await tunerController.proveSampleRateForFrequency(
							request.params.sourceId,
							REST,
							request.body.hz,
						)
					await tunerController.setFrequency(
						request.params.sourceId,
						request.body.hz,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				description:
					'Body {"gain": tenths of a dB}, the same name and unit as GET /api/tuner. "tenthsDb" is a deprecated alias; send exactly one.',
				body: {
					type: "object",
					properties: {
						gain: { type: "integer" },
						tenthsDb: { type: "integer", deprecated: true },
					},
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			const { gain, tenthsDb } = request.body
			const value = gain ?? tenthsDb
			if (
				value === undefined ||
				(gain !== undefined && tenthsDb !== undefined && gain !== tenthsDb)
			)
				return reply.status(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: `Invalid request body; expected ${GAIN_EXPECTED}`,
				})
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setGain(request.params.sourceId, value, REST)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { mode: gainModeSchema },
					required: ["mode"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setGainMode(
						request.params.sourceId,
						request.body.mode,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setSampleRate(
						request.params.sourceId,
						request.body.hz,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setPpm(
						request.params.sourceId,
						request.body.ppm,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setIfGain(
						request.params.sourceId,
						request.body.gain,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { enabled: testModeSchema },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setTestMode(
						request.params.sourceId,
						request.body.enabled,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { enabled: agcModeSchema },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setAgcMode(
						request.params.sourceId,
						request.body.enabled,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { enabled: biasTeeSchema },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setBiasTee(
						request.params.sourceId,
						request.body.enabled,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { mode: directSamplingSchema },
					required: ["mode"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setDirectSampling(
						request.params.sourceId,
						request.body.mode,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
					properties: { enabled: offsetTuningSchema },
					required: ["enabled"],
					additionalProperties: false,
				},
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setOffsetTuning(
						request.params.sourceId,
						request.body.enabled,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setRtlXtal(
						request.params.sourceId,
						request.body.hz,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setTunerXtal(
						request.params.sourceId,
						request.body.hz,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setTunerGainIndex(
						request.params.sourceId,
						request.body.index,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.setTunerIfGain(
						request.params.sourceId,
						request.body.stage,
						request.body.gain,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					tunerController.setControlMode(
						request.params.sourceId,
						request.body.mode,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
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
				return await run(request.params.sourceId, async () => {
					await tunerController.configure(
						request.params.sourceId,
						request.body,
						REST,
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
			}
		},
	)

	const bandGain = options.bandGain ?? null
	if (bandGain === null) return

	// GET /api/tuner-band-gain - Per-band gain table and "apply to my tuning"
	fastify.get(
		"/api/tuner-band-gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Per-band gain settings with provenance and limits",
			},
		},
		async () => bandGain.view(),
	)

	// PUT /api/tuner-band-gain - Replace them (persisted; Zod-validated in the service)
	fastify.put<{ Body: unknown }>(
		"/api/tuner-band-gain",
		{
			schema: {
				tags: ["tuner"],
				summary: "Replace the per-band gain settings (persisted)",
				body: { type: "object" },
				response: { 400: errorResponseSchema, 500: errorResponseSchema },
			},
		},
		async (request, reply) => {
			try {
				return await bandGain.put(request.body)
			} catch (err) {
				if (err instanceof BandGainSettingsError)
					return reply.status(err.statusCode).send({
						error: err.name,
						code: err.code,
						message: err.message,
					})
				throw err
			}
		},
	)
}
