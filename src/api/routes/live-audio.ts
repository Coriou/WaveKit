/**
 * Live Audio Routes - Live demodulation endpoints
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import { ZodError } from "zod"
import { ConfigValidationError, WaveKitError } from "../../utils/errors.js"
import type {
	LiveDemodulator,
	LiveDemodReconfigureUpdates as ReconfigureUpdates,
} from "../../core/live-demodulator.js"
import { deriveLegacyAudioUrl, requestHostHeader } from "./legacy-audio-host.js"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import type {
	LiveAudioToneSquelch,
	LiveDemodConfig,
	LiveDemodStatus,
} from "@wavekit/api-types"
import type {
	LiveDemodConfig as CoreLiveDemodConfig,
	LiveDemodStatus as CoreLiveDemodStatus,
} from "../../core/live-demodulator.js"

/**
 * WG7 req 3.1: the saved-frequency tone shape, flat (Fastify's ajv strips
 * properties inside `oneOf` branches); the core's Zod schema enforces the exact
 * variant, the standard tones and the NFM-only rule.
 */
const toneSquelchSchema = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["none", "ctcss", "dcs"] },
		frequencyTenthsHz: { type: "integer", minimum: 600, maximum: 3000 },
		code: { type: "string", pattern: "^[0-7]{3}$" },
		polarity: { type: "string", enum: ["normal", "inverted"] },
	},
	required: ["kind"],
	additionalProperties: false,
} as const

const liveDemodConfigSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		sourceId: { type: "string" },
		httpPort: { type: "number" },
		modulation: {
			type: "string",
			enum: ["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"],
		},
		bandwidth: { type: "number" },
		squelch: { type: "number" },
		squelchMode: { type: "string", enum: ["manual", "auto", "noise"] },
		autoMarginDb: { type: "number", minimum: 0, maximum: 40 },
		noiseQuietingDb: {
			type: "number",
			minimum: LIVE_AUDIO_NOISE_QUIETING_DB.min,
			maximum: LIVE_AUDIO_NOISE_QUIETING_DB.max,
		},
		toneSquelch: toneSquelchSchema,
		noiseReduction: {
			type: "string",
			enum: ["off", "voice", "noaa-apt", "narrow-band"],
		},
		lowPass: { type: "number" },
		highPass: { type: "number" },
		gain: { type: "number" },
		deEmphasis: { type: "boolean" },
		deEmphasisTau: { type: "number", enum: [50, 75] },
		audioFormat: { type: "string", enum: ["s16le", "f32le"] },
		iqDcBlock: { type: "boolean" },
		offsetHz: { type: "number" },
		agc: { type: "string", enum: ["off", "slow", "fast"] },
		engine: { type: "string", enum: ["csdr", "rust"] },
	},
	required: [
		"enabled",
		"httpPort",
		"modulation",
		"bandwidth",
		"squelch",
		"noiseReduction",
		"lowPass",
		"highPass",
		"gain",
		"deEmphasis",
		"deEmphasisTau",
		"audioFormat",
		"iqDcBlock",
	],
} as const

const liveDemodStatusSchema = {
	type: "object",
	properties: {
		enabled: { type: "boolean" },
		running: { type: "boolean" },
		sourceId: { type: "string" },
		sourceConnected: { type: "boolean" },
		sourceIqSampleRate: { type: "number" },
		config: liveDemodConfigSchema,
		effectiveSampleRate: { type: "number" },
		decimationFactor: { type: "number" },
		httpUrl: { type: "string" },
		clientCount: { type: "number" },
		bytesStreamed: { type: "number" },
		pipelineHealth: {
			type: "string",
			enum: ["running", "starting", "stopped", "error"],
		},
		lastError: { type: "string" },
		wavUrl: { type: "string" },
		pipelineRestarts: { type: "number" },
		channelPowerDbfs: { type: "number" },
		squelchOpen: { type: "boolean" },
		noiseFloorDbfs: { type: "number" },
		thresholdDbfs: { type: "number" },
		agc: { type: "string", enum: ["off", "slow", "fast"] },
		toneSquelch: {
			type: "object",
			properties: {
				state: { type: "string", enum: ["off", "waiting", "open"] },
			},
			required: ["state"],
		},
		tone: {
			type: "object",
			additionalProperties: false,
			required: ["ctcssHz", "dcs", "at"],
			properties: {
				ctcssHz: { type: ["number", "null"] },
				dcs: {
					anyOf: [
						{ type: "null" },
						{
							type: "object",
							additionalProperties: false,
							required: ["code", "polarity"],
							properties: {
								code: { type: "string" },
								polarity: {
									type: "string",
									enum: ["normal", "inverted"],
								},
							},
						},
					],
				},
				at: { type: "string", maxLength: 64 },
			},
		},
		engine: { type: "string", enum: ["csdr", "rust"] },
		engineFallback: {
			type: "string",
			enum: [
				"binary-unavailable",
				"protocol-unsupported",
				"input-format-unsupported",
				"modulation-unsupported",
				"open-rejected",
				"process-unstable",
			],
		},
	},
	required: [
		"enabled",
		"running",
		"sourceId",
		"sourceConnected",
		"sourceIqSampleRate",
		"config",
		"effectiveSampleRate",
		"decimationFactor",
		"httpUrl",
		"clientCount",
		"bytesStreamed",
		"pipelineHealth",
	],
} as const

const liveDemodConfigUpdateSchema = {
	type: "object",
	properties: {
		...liveDemodConfigSchema.properties,
		// null deletes the key (back to the modulation default).
		agc: {
			type: "string",
			enum: ["off", "slow", "fast", null],
			nullable: true,
		},
	},
	additionalProperties: false,
} as const

const liveDemodActionResponseSchema = {
	type: "object",
	properties: {
		success: { type: "boolean" },
	},
	required: ["success"],
} as const

const liveDemodPresetSchema = {
	type: "object",
	properties: {
		bandwidth: { type: "number" },
		deEmphasis: { type: "boolean" },
		deEmphasisTau: { type: "number", enum: [50, 75] },
	},
	required: ["bandwidth"],
	additionalProperties: false,
} as const

const presetsResponseSchema = {
	type: "object",
	properties: {
		nfm: liveDemodPresetSchema,
		wfm: liveDemodPresetSchema,
		am: liveDemodPresetSchema,
		usb: liveDemodPresetSchema,
		lsb: liveDemodPresetSchema,
		dsb: liveDemodPresetSchema,
		cw: liveDemodPresetSchema,
		raw: liveDemodPresetSchema,
	},
} as const

export interface LiveAudioRoutesOptions {
	liveDemod: LiveDemodulator
	/** Access is configured: PATCH 400 messages use the global handler's redacted text. */
	redactErrors?: boolean
	/**
	 * Legacy mode only (WG9 5.5): rewrite the localhost fallback stream URLs of
	 * the status response with the request's own Host. Absent: today's URLs.
	 */
	legacyAudioHost?: boolean
}

export const liveAudioRoutes: FastifyPluginAsync<
	LiveAudioRoutesOptions
> = async (fastify: FastifyInstance, options: LiveAudioRoutesOptions) => {
	const { liveDemod } = options

	const toApiLiveDemodConfig = (
		config: CoreLiveDemodConfig,
	): LiveDemodConfig => {
		return {
			enabled: config.enabled,
			httpPort: config.httpPort,
			modulation: config.modulation,
			bandwidth: config.bandwidth,
			squelch: config.squelch,
			squelchMode: config.squelchMode ?? "manual",
			autoMarginDb: config.autoMarginDb ?? 6,
			noiseQuietingDb:
				config.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
			...(config.toneSquelch !== undefined
				? { toneSquelch: copyTone(config.toneSquelch) }
				: {}),
			noiseReduction: config.noiseReduction,
			lowPass: config.lowPass,
			highPass: config.highPass,
			gain: config.gain,
			deEmphasis: config.deEmphasis,
			deEmphasisTau: config.deEmphasisTau,
			audioFormat: config.audioFormat,
			iqDcBlock: config.iqDcBlock,
			offsetHz: config.offsetHz,
			...(config.sourceId !== undefined ? { sourceId: config.sourceId } : {}),
			...(config.agc !== undefined ? { agc: config.agc } : {}),
			...(config.engine !== undefined ? { engine: config.engine } : {}),
		}
	}

	const toApiLiveDemodStatus = (
		status: CoreLiveDemodStatus,
	): LiveDemodStatus => {
		return {
			enabled: status.enabled,
			running: status.running,
			sourceId: status.sourceId,
			sourceConnected: status.sourceConnected,
			sourceIqSampleRate: status.sourceIqSampleRate,
			config: toApiLiveDemodConfig(status.config),
			effectiveSampleRate: status.effectiveSampleRate,
			decimationFactor: status.decimationFactor,
			httpUrl: status.httpUrl,
			clientCount: status.clientCount,
			bytesStreamed: status.bytesStreamed,
			pipelineHealth: status.pipelineHealth,
			wavUrl: status.wavUrl,
			pipelineRestarts: status.pipelineRestarts,
			...(status.noiseFloorDbfs !== undefined
				? { noiseFloorDbfs: status.noiseFloorDbfs }
				: {}),
			...(status.thresholdDbfs !== undefined
				? { thresholdDbfs: status.thresholdDbfs }
				: {}),
			...(status.lastError !== undefined
				? { lastError: status.lastError }
				: {}),
			...(status.channelPowerDbfs !== undefined
				? { channelPowerDbfs: status.channelPowerDbfs }
				: {}),
			...(status.squelchOpen !== undefined
				? { squelchOpen: status.squelchOpen }
				: {}),
			...(status.agc !== undefined ? { agc: status.agc } : {}),
			...(status.toneSquelch !== undefined
				? { toneSquelch: { state: status.toneSquelch.state } }
				: {}),
			...(status.tone !== undefined
				? { tone: copyStatusTone(status.tone) }
				: {}),
			engine: status.engine ?? "csdr",
			...(status.engineFallback !== undefined
				? { engineFallback: status.engineFallback }
				: {}),
		}
	}

	fastify.get<{ Reply: LiveDemodStatus }>(
		"/api/live-audio/status",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Get live audio status",
				description: "Returns live demodulator status and configuration",
				response: {
					200: liveDemodStatusSchema,
				},
			},
		},
		async (request, reply) => {
			const status = toApiLiveDemodStatus(liveDemod.getStatus())
			if (options.legacyAudioHost !== true) return status
			// Per response only: never stored, logged or broadcast.
			const host = requestHostHeader(request)
			const port = status.config.httpPort
			const httpUrl = deriveLegacyAudioUrl(status.httpUrl, host, port)
			const wavUrl =
				status.wavUrl === undefined
					? undefined
					: deriveLegacyAudioUrl(status.wavUrl, host, port)
			if (httpUrl === status.httpUrl && wavUrl === status.wavUrl) return status
			void reply.header("Cache-Control", "no-store")
			return {
				...status,
				httpUrl,
				...(wavUrl === undefined ? {} : { wavUrl }),
			}
		},
	)

	fastify.post<{ Reply: { success: boolean } }>(
		"/api/live-audio/start",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Start live audio",
				description:
					"Starts the live demodulation pipeline and HTTP stream, or restarts a dead pipeline while the stream server is up",
				response: {
					200: liveDemodActionResponseSchema,
				},
			},
		},
		async () => {
			await liveDemod.start()
			return { success: true }
		},
	)

	fastify.post<{ Reply: { success: boolean } }>(
		"/api/live-audio/stop",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Stop live audio",
				description: "Stops the live demodulation pipeline and HTTP stream",
				response: {
					200: liveDemodActionResponseSchema,
				},
			},
		},
		async () => {
			await liveDemod.stop()
			return { success: true }
		},
	)

	fastify.patch<{
		Body: Omit<Partial<LiveDemodConfig>, "agc"> & {
			agc?: LiveDemodConfig["agc"] | null
		}
		Reply: LiveDemodStatus | { error: string; code: string; message: string }
	}>(
		"/api/live-audio/config",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Update live audio config",
				description: "Applies updated live demodulation configuration",
				body: liveDemodConfigUpdateSchema,
				response: {
					200: liveDemodStatusSchema,
				},
			},
		},
		async (request, reply) => {
			const body = request.body

			const updates: ReconfigureUpdates = {
				...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
				...(body.httpPort !== undefined ? { httpPort: body.httpPort } : {}),
				...(body.modulation !== undefined
					? { modulation: body.modulation }
					: {}),
				...(body.bandwidth !== undefined ? { bandwidth: body.bandwidth } : {}),
				...(body.squelch !== undefined ? { squelch: body.squelch } : {}),
				...(body.squelchMode !== undefined
					? { squelchMode: body.squelchMode }
					: {}),
				...(body.autoMarginDb !== undefined
					? { autoMarginDb: body.autoMarginDb }
					: {}),
				...(body.noiseQuietingDb !== undefined
					? { noiseQuietingDb: body.noiseQuietingDb }
					: {}),
				...(body.toneSquelch !== undefined
					? { toneSquelch: body.toneSquelch }
					: {}),
				...(body.noiseReduction !== undefined
					? { noiseReduction: body.noiseReduction }
					: {}),
				...(body.lowPass !== undefined ? { lowPass: body.lowPass } : {}),
				...(body.highPass !== undefined ? { highPass: body.highPass } : {}),
				...(body.gain !== undefined ? { gain: body.gain } : {}),
				...(body.deEmphasis !== undefined
					? { deEmphasis: body.deEmphasis }
					: {}),
				...(body.deEmphasisTau !== undefined
					? { deEmphasisTau: body.deEmphasisTau }
					: {}),
				...(body.audioFormat !== undefined
					? { audioFormat: body.audioFormat }
					: {}),
				...(body.iqDcBlock !== undefined ? { iqDcBlock: body.iqDcBlock } : {}),
				...(body.offsetHz !== undefined ? { offsetHz: body.offsetHz } : {}),
				...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
				...(body.agc !== undefined ? { agc: body.agc } : {}),
				...(body.engine !== undefined ? { engine: body.engine } : {}),
			}

			try {
				await liveDemod.reconfigure(updates)
			} catch (err) {
				if (
					err instanceof ZodError ||
					(err instanceof WaveKitError &&
						err.code === "CHANNEL_OFFSET_OUT_OF_RANGE")
				) {
					return reply.code(400).send({
						error: "Bad Request",
						code: err instanceof ZodError ? "VALIDATION_ERROR" : err.code,
						message: options.redactErrors
							? "Request failed"
							: err instanceof ZodError
								? ConfigValidationError.formatZodError(err)
								: err.message,
					})
				}
				throw err
			}
			return toApiLiveDemodStatus(liveDemod.getStatus())
		},
	)

	fastify.get(
		"/api/live-audio/presets",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Get live audio presets",
				description: "Returns recommended presets for modulation modes",
				response: {
					200: presetsResponseSchema,
				},
			},
		},
		async () => {
			return {
				nfm: { bandwidth: 12500, deEmphasis: false },
				wfm: { bandwidth: 150000, deEmphasis: true, deEmphasisTau: 50 },
				am: { bandwidth: 10000, deEmphasis: false },
				usb: { bandwidth: 2400, deEmphasis: false },
				lsb: { bandwidth: 2400, deEmphasis: false },
				dsb: { bandwidth: 6000, deEmphasis: false },
				cw: { bandwidth: 500, deEmphasis: false },
				raw: { bandwidth: 0, deEmphasis: false },
			}
		},
	)
}

function copyStatusTone(
	tone: NonNullable<LiveDemodStatus["tone"]>,
): NonNullable<LiveDemodStatus["tone"]> {
	return {
		ctcssHz: tone.ctcssHz,
		dcs:
			tone.dcs === null
				? null
				: { code: tone.dcs.code, polarity: tone.dcs.polarity },
		at: tone.at,
	}
}

function copyTone(tone: LiveAudioToneSquelch): LiveAudioToneSquelch {
	switch (tone.kind) {
		case "ctcss":
			return { kind: "ctcss", frequencyTenthsHz: tone.frequencyTenthsHz }
		case "dcs":
			return { kind: "dcs", code: tone.code, polarity: tone.polarity }
		default:
			return { kind: "none" }
	}
}
