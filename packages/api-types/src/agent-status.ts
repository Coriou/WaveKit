import { z } from "zod"
import {
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	DECODER_VERDICT_TEXT_MAX_LENGTH,
	decoderVerdictSchema,
} from "./decoders.js"

/**
 * GET /api/agent/status: one compact answer to "what is the receiver doing", for
 * agents and scripts that would otherwise poll six routes. Every field is a
 * summary of a fuller route (named per field); read that route for detail.
 */
export const AGENT_STATUS_LIMITS = Object.freeze({
	/**
	 * Target body size for a full configuration: every built-in decoder type (9) plus
	 * three extra instances, two sources, two tuners, live audio and a scanner job.
	 * A decoder row with the longest verdict (three actions) is about 200 bytes, so
	 * 12 rows ≈ 2.4 KiB; the other sections add about 1.3 KiB. The worst-case test
	 * fixture measures 3,791 bytes, under 4 KiB.
	 */
	targetBytes: 4096,
	/** Scanner job names are cut to 64 characters here (the job route keeps up to 100). */
	jobNameMaxLength: 64,
})

/** Who moves the tuner now: WaveKit, an external relay client (SDR++), or a scanner job. */
export const AGENT_TUNER_OWNERS = ["wavekit", "external", "scanner"] as const
export type AgentTunerOwner = (typeof AGENT_TUNER_OWNERS)[number]

export const AGENT_SOURCE_STATES = [
	"disconnected",
	"waiting",
	"streaming",
	"stale",
	"paused",
	"ended",
] as const
export const AGENT_SOURCE_WARNINGS = ["rate-mismatch", "signal-flat"] as const
export type AgentSourceWarning = (typeof AGENT_SOURCE_WARNINGS)[number]

/** `disabled` when Activity is off in config; otherwise the store lifecycle. */
export const AGENT_ACTIVITY_STATES = [
	"disabled",
	"opening",
	"retrying",
	"available",
	"unavailable",
] as const
export type AgentActivityState = (typeof AGENT_ACTIVITY_STATES)[number]

const SCAN_JOB_STATES = [
	"pending",
	"starting",
	"running",
	"holding",
	"paused",
	"completed",
	"cancelled",
	"failed",
] as const
const LIVE_AUDIO_HEALTH = ["running", "starting", "stopped", "error"] as const
const id = z.string().min(1).max(256)
const iso = z.string().min(1).max(64)
const hz = z.number().finite().nonnegative()

/** GET /api/tuner: one row per tuner. */
export const agentTunerSchema = z
	.object({
		sourceId: id,
		/** Null while the core has not commanded or observed it. */
		frequencyHz: hz.nullable(),
		sampleRateHz: hz.nullable(),
		gainMode: z.enum(["manual", "agc"]).nullable(),
		/** Tenths of a dB; null in AGC or while unknown. */
		gain: z.number().finite().nullable(),
		owner: z.enum(AGENT_TUNER_OWNERS),
		/** True when frequency or rate comes only from config: the receiver may be elsewhere. */
		declaredOnly: z.boolean(),
	})
	.strict()

/** GET /api/sources: one row per source. */
export const agentSourceSchema = z
	.object({
		id,
		connected: z.boolean(),
		state: z.enum(AGENT_SOURCE_STATES),
		sampleAgeMs: z.number().finite().nonnegative().nullable(),
		warnings: z.array(z.enum(AGENT_SOURCE_WARNINGS)).max(2),
	})
	.strict()

/** GET /api/live-audio/status; null when live audio is not configured. */
export const agentLiveAudioSchema = z
	.object({
		running: z.boolean(),
		health: z.enum(LIVE_AUDIO_HEALTH),
		sourceId: id,
		modulation: z.string().min(1).max(16),
		/** Channel offset from the tuned centre. */
		offsetHz: z.number().finite(),
		clients: z.number().int().nonnegative(),
		/** Null while not running. */
		squelchOpen: z.boolean().nullable(),
	})
	.strict()

/** GET /api/scanner and /api/scanner/jobs; null when the scanner is not configured. */
export const agentScannerSchema = z
	.object({
		enabled: z.boolean(),
		activeJobs: z.number().int().nonnegative(),
		/** The most recently updated non-terminal job, else null. */
		job: z
			.object({
				id,
				name: z.string().max(AGENT_STATUS_LIMITS.jobNameMaxLength).nullable(),
				kind: z.enum(["discover", "monitor", "identify"]),
				state: z.enum(SCAN_JOB_STATES),
				reason: z.string().min(1).max(64).nullable(),
				sourceId: id,
			})
			.strict()
			.nullable(),
	})
	.strict()

/** GET /api/decoders/summary: the same verdict, one row per decoder. */
export const agentDecoderSchema = z
	.object({ id, protocol: id, verdict: decoderVerdictSchema })
	.strict()

/** GET /api/activity/status. `rows` is null unless the store is available. */
export const agentActivitySchema = z
	.object({
		state: z.enum(AGENT_ACTIVITY_STATES),
		rows: z.number().int().nonnegative().nullable(),
	})
	.strict()

export const agentStatusSchema = z
	.object({
		at: iso,
		tuners: z.array(agentTunerSchema),
		sources: z.array(agentSourceSchema),
		liveAudio: agentLiveAudioSchema.nullable(),
		scanner: agentScannerSchema.nullable(),
		decoders: z.array(agentDecoderSchema),
		activity: agentActivitySchema,
		/** Newest output per decoder protocol, newest first; protocols with none are absent. */
		lastDecode: z.array(z.object({ protocol: id, at: iso }).strict()),
	})
	.strict()

export type AgentTuner = z.infer<typeof agentTunerSchema>
export type AgentSource = z.infer<typeof agentSourceSchema>
export type AgentLiveAudio = z.infer<typeof agentLiveAudioSchema>
export type AgentScanner = z.infer<typeof agentScannerSchema>
export type AgentDecoder = z.infer<typeof agentDecoderSchema>
export type AgentActivity = z.infer<typeof agentActivitySchema>
export type AgentStatus = z.infer<typeof agentStatusSchema>

const nullable = (type: string) => ({ type: [type, "null"] }) as const
const str = { type: "string" } as const
const num = { type: "number" } as const
const bool = { type: "boolean" } as const
const strictObject = <P extends Record<string, unknown>>(properties: P) =>
	({
		type: "object",
		additionalProperties: false,
		required: Object.keys(properties),
		properties,
	}) as const

/** Fastify response schema for GET /api/agent/status (mirrors agentStatusSchema). */
export const agentStatusResponseSchema = strictObject({
	at: str,
	tuners: {
		type: "array",
		items: strictObject({
			sourceId: str,
			frequencyHz: nullable("number"),
			sampleRateHz: nullable("number"),
			gainMode: nullable("string"),
			gain: nullable("number"),
			owner: { type: "string", enum: [...AGENT_TUNER_OWNERS] },
			declaredOnly: bool,
		}),
	},
	sources: {
		type: "array",
		items: strictObject({
			id: str,
			connected: bool,
			state: { type: "string", enum: [...AGENT_SOURCE_STATES] },
			sampleAgeMs: nullable("number"),
			warnings: {
				type: "array",
				items: { type: "string", enum: [...AGENT_SOURCE_WARNINGS] },
			},
		}),
	},
	liveAudio: {
		...strictObject({
			running: bool,
			health: { type: "string", enum: [...LIVE_AUDIO_HEALTH] },
			sourceId: str,
			modulation: str,
			offsetHz: num,
			clients: { type: "integer" },
			squelchOpen: nullable("boolean"),
		}),
		type: ["object", "null"],
	},
	scanner: {
		...strictObject({
			enabled: bool,
			activeJobs: { type: "integer" },
			job: {
				...strictObject({
					id: str,
					name: nullable("string"),
					kind: str,
					state: str,
					reason: nullable("string"),
					sourceId: str,
				}),
				type: ["object", "null"],
			},
		}),
		type: ["object", "null"],
	},
	decoders: {
		type: "array",
		items: strictObject({
			id: str,
			protocol: str,
			verdict: strictObject({
				code: { type: "string", enum: [...DECODER_VERDICT_CODES] },
				text: { type: "string", maxLength: DECODER_VERDICT_TEXT_MAX_LENGTH },
				actions: {
					type: "array",
					items: { type: "string", enum: [...DECODER_VERDICT_ACTIONS] },
				},
			}),
		}),
	},
	activity: strictObject({
		state: { type: "string", enum: [...AGENT_ACTIVITY_STATES] },
		rows: nullable("integer"),
	}),
	lastDecode: {
		type: "array",
		items: strictObject({ protocol: str, at: str }),
	},
})
