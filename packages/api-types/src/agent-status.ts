import { z } from "zod"
import {
	DECODER_RECEPTION_HINTS,
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	decoderVerdictSchema,
} from "./decoders.js"
import { SOURCE_FEED_STATES, type SourceVerdictCode } from "./sources.js"

/**
 * GET /api/agent/status: one compact answer to "what is the receiver doing", for
 * agents and scripts that would otherwise poll six routes. Every field is a
 * summary of a fuller route (named per field); read that route for detail.
 */
export const AGENT_STATUS_LIMITS = Object.freeze({
	/**
	 * Hard ceiling on the body. The caps below bound every field, so the largest body
	 * the route can build is fixed. Worst case in JSON bytes, every number at the
	 * longest a double serialises to (25 bytes signed, 24 unsigned: 17 significant
	 * digits behind `0.00000`; 23 for an integer, `1.2345678901234567e+300`), every
	 * string at its byte cap, every enum and list at its longest member (repeats
	 * allowed), ISO times at 27:
	 *   envelope: keys and braces 121, `at` 29, `truncated` 5, activity 54,
	 *             `hiddenProblems` 23                                      =   232
	 *   tuners:     2 × 219 (sourceId 32, three numbers, owner) + 3         =   441
	 *   sources:    2 × 273 (id 32, longest state and feed, age, the longest
	 *               warning twice, tuningUnverified; `verdict` 33 with the 20-byte
	 *               `receiver-not-running`, `passive` 31 with the 18-byte
	 *               `measuring-baseline`) + 3                                =   549
	 *   liveAudio:  sourceId 32, modulation 12, two numbers                 =   202
	 *   scanner:    job id 32, name 32, reason 24, sourceId 32, two integers,
	 *               discoveries 7 digits                                    =   321
	 *   decoders:   9 × 191 (id 32, protocol 16, code 23, the longest action
	 *               3 times: 64) + 10                                        = 1,729
	 *   lastDecode: 9 × 66 (protocol 16, ISO time 27) + 10                  =   604
	 * Total 4,078 < 4,096. The worst-case test builds exactly this body, checks the
	 * schema admits it and nothing one row or one byte larger, and measures it.
	 * A decoder row's `reception` hint rides only on a `listening` verdict, which has no
	 * actions: code 9 instead of 23 and `[]` 2 instead of 3 actions 64 saves 76 bytes,
	 * the hint `,"reception":"heard-undecoded"` adds 30, so such a row is 46 bytes
	 * under the worst-case row and the total stands.
	 * A verdict's `cause` rides only on a loss code (AGENT_DECODER_CAUSE_CODES) with at
	 * most `causeActionsMax` (2) actions: code 21 (`efficiency-late-drops`) instead of
	 * 23 saves 2, 2 actions 43 instead of 3 actions 64 saves 21, and
	 * `,"cause":"decoder"` adds 18, so such a row is 5 bytes under the worst-case row
	 * and the total stands. `cause` and `reception` never share a row (listening is no
	 * loss code). The summary route's `retryAt` is not carried here.
	 */
	targetBytes: 4096,
	/**
	 * Ids (decoder, source, job) cut to 32 UTF-8 bytes of JSON; a 28-byte job id and a
	 * 32-character scanner probe decoder id fit whole.
	 */
	idMaxBytes: 32,
	/**
	 * Decoder protocol (type) names cut to 16 bytes, so that sources carry `verdict` and
	 * `passive`; the longest built-in is 15, and a longer custom type sets `truncated`.
	 */
	protocolMaxBytes: 16,
	/** Scanner job names cut to 32 bytes here (the job route keeps up to 100 characters). */
	jobNameMaxBytes: 32,
	/** Pause or failure reasons cut to 24 bytes; the longest is 22 (`resumed-without-retune`). */
	reasonMaxBytes: 24,
	/** Live-audio modulation names cut to 12 bytes; the longest is 3 (`nfm`). */
	modulationMaxBytes: 12,
	/**
	 * `scanner.discoveries` stops here and sets `truncated`: the most `storage.maxDiscoveries`
	 * accepts, 7 digits in the budget above. Records kept from eviction can pass that cap.
	 */
	discoveriesMax: 1_000_000,
	/** Sources and their tuners (one tuner per source): the first two. */
	sourcesMax: 2,
	/**
	 * Decoder rows, problem verdicts first: as many rows as built-in decoder types (9),
	 * though two instances of one type take two rows. `lastDecode` is one per protocol, as many.
	 */
	decodersMax: 9,
	/** A verdict's first actions, most helpful first; no verdict suggests more than 3. */
	actionsMax: 3,
	/** Actions on a row carrying `cause`: every loss verdict suggests 2 (see above). */
	causeActionsMax: 2,
})

/**
 * The loss verdicts whose agent row carries `cause` (whose loss stopped the
 * decoder); the summary route's other causes (a running decoder while the host
 * is busy) stay on that route.
 */
export const AGENT_DECODER_CAUSE_CODES = [
	"efficiency-drops",
	"efficiency-late-drops",
	"efficiency-cpu",
] as const satisfies readonly (typeof DECODER_VERDICT_CODES)[number][]

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

/** A source row's `verdict` (GET /api/sources `verdict.code`): every code but `ok`. */
export const AGENT_SOURCE_VERDICTS = [
	"waiting",
	"no-samples",
	"receiver-no-device",
	"receiver-not-running",
	"backpressure",
	"disconnected",
	"feed-paused",
	"feed-error",
	"ended",
] as const satisfies readonly Exclude<SourceVerdictCode, "ok">[]

/**
 * Why the scanner's cost guard holds a source's passive scanning off: `passive-cost` what passive
 * adds to a shared engine costs too much of a core, `engine-cost` the whole engine does (passive
 * alone, or saturated), `measuring-baseline` off for one minute to measure the engine without it,
 * `unknown` a reason this build does not name (never a guess).
 */
export const SCANNER_PASSIVE_REASONS = [
	"passive-cost",
	"engine-cost",
	"measuring-baseline",
	"unknown",
] as const
export type ScannerPassiveReason = (typeof SCANNER_PASSIVE_REASONS)[number]

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
const L = AGENT_STATUS_LIMITS
const utf8 = new TextEncoder()

/** UTF-8 bytes of `value` as a JSON string body (escapes included, quotes not). */
export function jsonStringBytes(value: string): number {
	return utf8.encode(JSON.stringify(value)).length - 2
}

/** A string within `maxBytes` of JSON; the byte cap bounds its length too. */
const capped = (maxBytes: number, minLength = 1) =>
	z
		.string()
		.min(minLength)
		.max(maxBytes)
		.refine(value => jsonStringBytes(value) <= maxBytes)
const id = capped(L.idMaxBytes)
const protocol = capped(L.protocolMaxBytes)
/** `Date#toISOString`: 24 characters, 27 for years past 9999; ASCII only, so bytes = characters. */
const iso = z
	.string()
	.max(27)
	.regex(/^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
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
		/**
		 * The receiver feed (`feed.state` on GET /api/sources): `paused` and `resuming`
		 * are operator holds, `error` a failed resume. `live` for sources without one.
		 */
		feed: z.enum(SOURCE_FEED_STATES),
		/**
		 * True while the source's tuner has its frequency, sample rate, gain or gain mode in
		 * `unknownFields` (for example after a plain resume): the receiver may be tuned elsewhere.
		 */
		tuningUnverified: z.boolean(),
		/** GET /api/sources `verdict.code`; absent when it reads `ok`. Message on that route. */
		verdict: z.enum(AGENT_SOURCE_VERDICTS).optional(),
		/** Why the cost guard holds passive scanning off (GET /api/scanner); absent otherwise. */
		passive: z.enum(SCANNER_PASSIVE_REASONS).optional(),
		/**
		 * GET /api/sources `receiver`, compact: identity strength, what became of the
		 * learned state, and whether the accepted tuning was restored. Absent before it is known.
		 */
		receiver: z
			.object({
				strength: z.enum(["unit", "model", "unknown"]),
				learnedState: z.enum(["fresh", "resumed", "adopted", "none"]),
				tuningRestored: z.boolean(),
			})
			.strict()
			.optional(),
	})
	.strict()

/** GET /api/live-audio/status; null when live audio is not configured. */
export const agentLiveAudioSchema = z
	.object({
		running: z.boolean(),
		health: z.enum(LIVE_AUDIO_HEALTH),
		sourceId: id,
		modulation: capped(L.modulationMaxBytes),
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
		/** Sweeps paused with reason `resumed-without-retune`: each waits for a job resume. */
		heldJobs: z.number().int().nonnegative(),
		/** Records in the discovery store, read from its size; null when this core cannot say. */
		discoveries: z
			.number()
			.int()
			.nonnegative()
			.max(L.discoveriesMax)
			.nullable(),
		/**
		 * The most recently updated job paused with reason `resumed-without-retune`, else the
		 * most recently updated non-terminal job, else null.
		 */
		job: z
			.object({
				id,
				name: capped(L.jobNameMaxBytes, 0).nullable(),
				kind: z.enum(["discover", "monitor", "identify"]),
				state: z.enum(SCAN_JOB_STATES),
				reason: capped(L.reasonMaxBytes).nullable(),
				sourceId: id,
			})
			.strict()
			.nullable(),
	})
	.strict()

/**
 * GET /api/decoders/summary: the same verdict, one row per decoder, without its
 * sentence (`text`); read the summary route for the wording. `reception` is the
 * summary's hint, present only on a `listening` verdict (the byte budget in
 * AGENT_STATUS_LIMITS relies on that).
 */
export const agentDecoderSchema = z
	.object({
		id,
		protocol,
		verdict: z
			.object({
				code: decoderVerdictSchema.shape.code,
				actions: z.array(z.enum(DECODER_VERDICT_ACTIONS)).max(L.actionsMax),
				/**
				 * Whose loss stopped the decoder: "host" (host starvation, samples
				 * dropped on several streams) or "decoder". Only on a loss code.
				 */
				cause: decoderVerdictSchema.shape.cause,
			})
			.strict(),
		reception: z.enum(DECODER_RECEPTION_HINTS).optional(),
	})
	.strict()
	.refine(
		row =>
			row.reception === undefined ||
			(row.verdict.code === "listening" && row.verdict.actions.length === 0),
		{ message: "reception rides only on a listening verdict without actions" },
	)
	.refine(
		row =>
			row.verdict.cause === undefined ||
			((AGENT_DECODER_CAUSE_CODES as readonly string[]).includes(
				row.verdict.code,
			) &&
				row.verdict.actions.length <= L.causeActionsMax),
		{
			message: `cause rides only on a loss verdict with at most ${L.causeActionsMax} actions`,
		},
	)

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
		/**
		 * True when a list was cut at its cap, an id was shortened or the discovery count
		 * stopped at its cap: the named full route has everything. Shortened job names alone
		 * do not set it.
		 */
		truncated: z.boolean(),
		tuners: z.array(agentTunerSchema).max(L.sourcesMax),
		sources: z.array(agentSourceSchema).max(L.sourcesMax),
		liveAudio: agentLiveAudioSchema.nullable(),
		scanner: agentScannerSchema.nullable(),
		/**
		 * Problem verdicts (anything but `decoding`, `listening` or `off`) first, then
		 * the rest, each in configuration order.
		 */
		decoders: z.array(agentDecoderSchema).max(L.decodersMax),
		/** Problem decoders cut from `decoders` by its cap; read the summary route for them. */
		hiddenProblems: z.number().int().nonnegative(),
		activity: agentActivitySchema,
		/** Newest output per decoder protocol, newest first; protocols with none are absent. */
		lastDecode: z
			.array(z.object({ protocol, at: iso }).strict())
			.max(L.decodersMax),
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
	truncated: bool,
	tuners: {
		type: "array",
		maxItems: L.sourcesMax,
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
		maxItems: L.sourcesMax,
		items: (() => {
			const row = strictObject({
				id: str,
				connected: bool,
				state: { type: "string", enum: [...AGENT_SOURCE_STATES] },
				sampleAgeMs: nullable("number"),
				warnings: {
					type: "array",
					items: { type: "string", enum: [...AGENT_SOURCE_WARNINGS] },
				},
				feed: { type: "string", enum: [...SOURCE_FEED_STATES] },
				tuningUnverified: bool,
			})
			// Optional: listed in properties, not in required.
			return {
				...row,
				properties: {
					...row.properties,
					verdict: { type: "string", enum: [...AGENT_SOURCE_VERDICTS] },
					passive: { type: "string", enum: [...SCANNER_PASSIVE_REASONS] },
					receiver: strictObject({
						strength: { type: "string", enum: ["unit", "model", "unknown"] },
						learnedState: {
							type: "string",
							enum: ["fresh", "resumed", "adopted", "none"],
						},
						tuningRestored: bool,
					}),
				},
			}
		})(),
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
			heldJobs: { type: "integer" },
			discoveries: nullable("integer"),
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
		maxItems: L.decodersMax,
		items: (() => {
			const row = strictObject({
				id: str,
				protocol: str,
				verdict: strictObject({
					code: { type: "string", enum: [...DECODER_VERDICT_CODES] },
					actions: {
						type: "array",
						maxItems: L.actionsMax,
						items: { type: "string", enum: [...DECODER_VERDICT_ACTIONS] },
					},
				}),
			})
			// Optional: listed in properties, not in required.
			return {
				...row,
				properties: {
					...row.properties,
					verdict: {
						...row.properties.verdict,
						properties: {
							...row.properties.verdict.properties,
							cause: { type: "string", enum: ["host", "decoder"] },
						},
					},
					reception: { type: "string", enum: [...DECODER_RECEPTION_HINTS] },
				},
			}
		})(),
	},
	hiddenProblems: { type: "integer", minimum: 0 },
	activity: strictObject({
		state: { type: "string", enum: [...AGENT_ACTIVITY_STATES] },
		rows: nullable("integer"),
	}),
	lastDecode: {
		type: "array",
		maxItems: L.decodersMax,
		items: strictObject({ protocol: str, at: str }),
	},
})
