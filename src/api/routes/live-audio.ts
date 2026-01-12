/**
 * Live Audio Routes - Live demodulation endpoints
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { LiveDemodulator } from "../../core/live-demodulator.js"
import type { LiveDemodConfig, LiveDemodStatus } from "@wavekit/api-types"
import type {
	LiveDemodConfig as CoreLiveDemodConfig,
	LiveDemodStatus as CoreLiveDemodStatus,
} from "../../core/live-demodulator.js"

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
	properties: liveDemodConfigSchema.properties,
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
			noiseReduction: config.noiseReduction,
			lowPass: config.lowPass,
			highPass: config.highPass,
			gain: config.gain,
			deEmphasis: config.deEmphasis,
			deEmphasisTau: config.deEmphasisTau,
			audioFormat: config.audioFormat,
			iqDcBlock: config.iqDcBlock,
			...(config.sourceId !== undefined ? { sourceId: config.sourceId } : {}),
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
			...(status.lastError !== undefined
				? { lastError: status.lastError }
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
		async () => toApiLiveDemodStatus(liveDemod.getStatus()),
	)

	fastify.post<{ Reply: { success: boolean } }>(
		"/api/live-audio/start",
		{
			schema: {
				tags: ["live-audio"],
				summary: "Start live audio",
				description: "Starts the live demodulation pipeline and HTTP stream",
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
		Body: Partial<LiveDemodConfig>
		Reply: LiveDemodStatus
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
		async request => {
			const body = request.body as Partial<LiveDemodConfig>

			const updates: Partial<CoreLiveDemodConfig> = {
				...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
				...(body.httpPort !== undefined ? { httpPort: body.httpPort } : {}),
				...(body.modulation !== undefined
					? { modulation: body.modulation }
					: {}),
				...(body.bandwidth !== undefined ? { bandwidth: body.bandwidth } : {}),
				...(body.squelch !== undefined ? { squelch: body.squelch } : {}),
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
				...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
			}

			await liveDemod.reconfigure(updates)
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
