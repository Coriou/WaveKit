/**
 * Tuner Routes - RTL-TCP tuner control endpoints
 */

import { z } from "zod"
import type { SourceManager } from "../../core/source-manager.js"
import {
	TUNER_REST_COMMAND_POLICY,
	TUNER_VALUE_BOUNDS,
} from "../../core/tuner-controller.js"
import {
	TunerLeaseHeldError,
	TunerTuning,
	type TuneOutcome,
	type TuneReceiverStatus,
	type TuneSource,
	type TunerLeaseHolder,
} from "../../core/tuner-tune.js"
import type {
	FastifyError,
	FastifyInstance,
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
} from "fastify"
import {
	TUNER_RESUME_REASONS,
	TUNER_CHANGE_ACTORS,
	TUNER_CHANGE_FIELDS,
	TUNER_CHANGE_REASONS,
	TUNE_RESTORE_CANCEL_REASONS,
	TUNE_RESTORE_MAX_S,
	TUNE_RESTORE_STATUSES,
	TUNE_SETTINGS,
	TUNE_WAITERS_MAX,
	sourceVerdictSchema,
} from "@wavekit/api-types"
import type { AccessPrincipal } from "../../access/types.js"
import type { Logger } from "../../utils/logger.js"
import {
	BandGainSettingsError,
	type BandGainSettingsService,
} from "../../core/band-gain.js"
import { BandGainSettingsSchema } from "../../core/band-gain-schema.js"
import {
	ajvValidationFields,
	isBodyParseError,
	rejectUnknownBodyFields,
	requestPart,
	routeSchemaFor,
	validationFieldsSchema,
	zodValidationFields,
	type ValidationField,
} from "../validation-errors.js"
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
	TuneRequest,
	TunerConfigUpdate,
	TunerDirectSampling,
	TunerGainMode,
} from "@wavekit/api-types"

/**
 * Every REST tuner write is an operator command (signal discovery spec § 10.3). Who it came from
 * is the admitted access principal's kind and nothing the client sent; a core without access has
 * no principal, so its writes read `unknown` in `lastChange`.
 */
function restWrite(
	kind: AccessPrincipal["kind"] | undefined,
): TunerWriteOptions {
	if (kind === "session") return { origin: "rest", actor: "web" }
	if (kind === "machine") return { origin: "rest", actor: "agent" }
	return { origin: "rest" }
}

export const gainModes = [
	...TUNER_REST_COMMAND_POLICY[2].rule.values,
] as TunerGainMode[]
export const directSamplingModes = [
	...TUNER_REST_COMMAND_POLICY[8].rule.values,
] as TunerDirectSampling[]
const gainModeSchema = { type: "string", enum: gainModes }
const directSamplingSchema = { type: "string", enum: directSamplingModes }
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

const tuneSettingsSchema = {
	type: "array",
	items: { type: "string", enum: [...TUNE_SETTINGS] },
} as const

const tunePreemptionSchema = {
	type: "object",
	properties: {
		jobId: { type: "string" },
		jobName: { type: "string", nullable: true },
		job: { type: "string", enum: ["paused", "failed"] },
		autoAfterIdleMs: { type: "integer", nullable: true },
		waiters: {
			type: "array",
			maxItems: TUNE_WAITERS_MAX,
			items: {
				type: "object",
				properties: {
					jobId: { type: "string" },
					jobName: { type: "string", nullable: true },
					autoAfterIdleMs: { type: "integer" },
				},
				required: ["jobId", "jobName", "autoAfterIdleMs"],
			},
		},
		message: { type: "string" },
	},
	required: [
		"jobId",
		"jobName",
		"job",
		"autoAfterIdleMs",
		"waiters",
		"message",
	],
} as const

const tuneRestoreSchema = {
	type: "object",
	properties: {
		at: { type: "string", format: "date-time" },
		status: { type: "string", enum: [...TUNE_RESTORE_STATUSES] },
		state: {
			type: "object",
			properties: {
				sampleRate: { type: "integer" },
				frequency: { type: "integer" },
				gainMode: gainModeSchema,
				gain: { type: "integer" },
			},
		},
		cancelledBy: {
			type: "object",
			properties: {
				actor: { type: "string", enum: [...TUNER_CHANGE_ACTORS] },
				reason: { type: "string", enum: [...TUNE_RESTORE_CANCEL_REASONS] },
				at: { type: "string", format: "date-time" },
				job: {
					type: "object",
					properties: {
						jobId: { type: "string" },
						jobName: { type: "string", nullable: true },
					},
					required: ["jobId", "jobName"],
				},
			},
			required: ["actor", "reason", "at"],
		},
		restored: tuneSettingsSchema,
		failure: { type: "string" },
	},
	required: ["at", "status", "state"],
} as const

const lastTuneSchema = {
	type: "object",
	properties: {
		at: { type: "string", format: "date-time" },
		usable: { type: "boolean" },
		applied: tuneSettingsSchema,
		notApplied: tuneSettingsSchema,
		code: { type: "string" },
		preempted: tunePreemptionSchema,
	},
	required: ["at", "usable", "applied", "notApplied"],
} as const

/** TunerState.proof's per-field entry (the tuning ledger's verdict on the live connection). */
const fieldProofSchema = {
	type: "object",
	properties: {
		state: {
			type: "string",
			enum: ["unverified", "settling", "commanded", "relay"],
		},
		writer: {
			type: ["string", "null"],
			enum: ["operator", "scanner", "assert", "relay", null],
		},
		session: { type: ["integer", "null"] },
		reason: { type: "string" },
		blocked: { type: "string" },
		lastReceipt: {
			type: "object",
			properties: {
				seq: { type: "integer" },
				pos: { type: "integer" },
				at: { type: "string", format: "date-time" },
			},
			required: ["seq", "pos", "at"],
		},
	},
	required: ["state", "writer", "session"],
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
		lastChange: {
			type: "object",
			properties: {
				actor: { type: "string", enum: [...TUNER_CHANGE_ACTORS] },
				reason: { type: "string", enum: [...TUNER_CHANGE_REASONS] },
				at: { type: "string", format: "date-time" },
				fields: {
					type: "array",
					items: { type: "string", enum: [...TUNER_CHANGE_FIELDS] },
				},
				jobId: { type: "string" },
			},
			required: ["actor", "reason", "at", "fields"],
		},
		lastError: { type: "string" },
		commandCount: { type: "integer" },
		unknownFields: { type: "array", items: { type: "string" } },
		declaredOnlyFields: { type: "array", items: { type: "string" } },
		measuredFields: { type: "array", items: { type: "string" } },
		bandGain: {
			type: "object",
			properties: {
				tenthsDb: { type: "integer" },
				label: { type: "string" },
				owner: { type: "string", enum: ["scanner", "user"] },
			},
			required: ["tenthsDb", "owner"],
		},
		restore: tuneRestoreSchema,
		lastTune: lastTuneSchema,
		resumeOutcome: {
			type: "object",
			properties: {
				outcome: { type: "string", enum: ["restored", "left-as-found"] },
				reason: { type: "string", enum: [...TUNER_RESUME_REASONS] },
				message: { type: "string" },
			},
			required: ["outcome", "reason", "message"],
		},
		proof: {
			type: "object",
			properties: {
				frequency: fieldProofSchema,
				sampleRate: fieldProofSchema,
				assertFights: { type: "integer" },
			},
			required: ["frequency", "sampleRate"],
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
		fields: validationFieldsSchema,
	},
	required: ["error", "code", "message"],
} as const

/** Body of POST /api/tuner/:sourceId/tune. Bounds from the controller, which checks them too. */
const tuneBodySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		sampleRateHz: {
			type: "integer",
			minimum: TUNER_VALUE_BOUNDS.sampleRate.min,
			maximum: TUNER_VALUE_BOUNDS.sampleRate.max,
		},
		frequencyHz: {
			type: "integer",
			minimum: TUNER_VALUE_BOUNDS.frequency.min,
			maximum: TUNER_VALUE_BOUNDS.frequency.max,
		},
		gainMode: gainModeSchema,
		gain: {
			type: "integer",
			minimum: TUNER_VALUE_BOUNDS.gain.min,
			maximum: TUNER_VALUE_BOUNDS.gain.max,
		},
		restoreAfterS: {
			type: "integer",
			minimum: 1,
			maximum: TUNE_RESTORE_MAX_S,
		},
		preempt: { type: "boolean" },
	},
} as const

/** What was and was not applied, on every answer of a tune that got as far as trying. */
const tuneResultProperties = {
	usable: { type: "boolean" },
	applied: tuneSettingsSchema,
	notApplied: tuneSettingsSchema,
	preempted: tunePreemptionSchema,
} as const

const tuneResponseSchema = {
	type: "object",
	properties: { ...tunerStateSchema.properties, ...tuneResultProperties },
	required: [...tunerStateSchema.required, "usable", "applied", "notApplied"],
} as const

const tuneFailureSchema = {
	type: "object",
	properties: {
		...errorResponseSchema.properties,
		...tuneResultProperties,
		inFlight: { type: "boolean" },
		jobId: { type: "string" },
		jobName: { type: "string", nullable: true },
		state: tunerStateSchema,
		sourceVerdict: sourceVerdictSchema,
	},
	required: errorResponseSchema.required,
} as const

const TUNE_URL = "/api/tuner/:sourceId/tune"
const TUNE_EXPECTED = `at least one of "sampleRateHz" (integer Hz, 225001-300000 or 900001-3200000), "frequencyHz" (integer Hz, 24000000-1900000000), "gainMode" ("manual" | "agc"), "gain" (integer, tenths of a dB, 0-500); optional "restoreAfterS" (integer seconds, 1-${TUNE_RESTORE_MAX_S}) puts the prior tuning back; optional "preempt" (boolean) takes the tuner from a scanner job holding it`

export const tunerConfigUpdateSchema = {
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
	/** With the whole of `TuneSource`, POST /api/tuner/:sourceId/tune mounts too. */
	sourceManager?: Pick<SourceManager, "runTunerCommand"> & Partial<TuneSource>
	/** Per-band gain settings; GET/PUT /api/tuner-band-gain are mounted only with them. */
	bandGain?: BandGainSettingsService | null
	/** The admitted principal's kind; absent on a core without access protection. */
	principalKind?: (
		request: FastifyRequest,
	) => AccessPrincipal["kind"] | undefined
	/**
	 * The job holding a source's tuner lease; absent on a core without a scanner. A tune answers
	 * 409 under a held lease unless told to preempt, and a restore yields to one.
	 */
	scannerLeaseHolder?: TunerLeaseHolder
	/** The source's receiver status, for the verdict of a tune that finds the source silent. */
	receiverStatus?: TuneReceiverStatus
}

const GAIN_EXPECTED =
	'{"gain": integer, gain in tenths of a dB (0-500, e.g. 372 = 37.2 dB)}; the deprecated alias "tenthsDb" takes the same unit, send exactly one'
const GAIN_FIELD_EXPECTED =
	'integer, gain in tenths of a dB (0-500, e.g. 372 = 37.2 dB); send "gain" or the deprecated alias "tenthsDb" (same unit), not both'
const U32 = "unsigned 32-bit"

/**
 * What each tuner route expects, named in every 400 it answers (field names, types and
 * units). Static text: a 400 never echoes the submitted value.
 */
/** Static 400 text for the band gain refinements. */
const BAND_GAIN_RULES: Readonly<Record<string, string>> = Object.freeze({
	"entries.*.maxHz": "above minHz",
	"entries.*": "ranges are inclusive and must not overlap another entry",
})

/** POST /api/tuner/:sourceId/take-back: no body, or an empty object. */
const TakeBackBodySchema = z.object({}).strict()
const TAKE_BACK_EXPECTED = "no body, or {}"

const EXPECTED_BODY: Readonly<Record<string, string>> = Object.freeze({
	"/api/tuner/:sourceId/take-back": TAKE_BACK_EXPECTED,
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
	[TUNE_URL]: TUNE_EXPECTED,
	"/api/tuner-band-gain":
		'{"applyToMyTuning": boolean, "entries": [{"minHz": integer Hz, "maxHz": integer Hz, "gain": integer tenths of a dB (0-500) or "keep", "label"?: string}]}',
	"/api/tuner/:sourceId/config":
		'an object of tuner fields only: "frequency" (Hz), "sampleRate" (Hz), "gain" (tenths of a dB, 0-500), "gainMode" ("manual" | "agc"), "ppm", "agcMode", "biasTee", "directSampling", "offsetTuning", "ifGain", "tunerIfGain", "testMode", "rtlXtal" (Hz), "tunerXtal" (Hz), "tunerGainIndex", "controlMode"',
})

/** PATCH /config: AGC with a gain or gain index in the same update (fixed text). */
const CONFIG_AGC_CONFLICT =
	'"gainMode" "agc" cannot be sent with "gain" or "tunerGainIndex" in one update: a gain write can leave AGC; send the gain first, then "gainMode" "agc" alone'

/** Per-field text where the schema alone cannot state the unit or range (route url -> field). */
const FIELD_EXPECTED: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
	"/api/tuner/:sourceId/frequency": {
		hz: "integer, frequency in Hz (24000000-1900000000)",
	},
	"/api/tuner/:sourceId/gain": {
		gain: GAIN_FIELD_EXPECTED,
		tenthsDb: GAIN_FIELD_EXPECTED,
	},
	"/api/tuner/:sourceId/sample-rate": {
		hz: "integer, sample rate in Hz (225001-300000 or 900001-3200000)",
	},
	"/api/tuner/:sourceId/ppm": {
		ppm: "integer, frequency correction in ppm (-500-500)",
	},
	"/api/tuner/:sourceId/tuner-if-gain": {
		stage: "integer (0-65535)",
		gain: "integer, tenths of a dB (0-65535)",
	},
	[TUNE_URL]: {
		sampleRateHz:
			"integer, sample rate in Hz (225001-300000 or 900001-3200000)",
		frequencyHz: "integer, frequency in Hz (24000000-1900000000)",
		gain: "integer, gain in tenths of a dB (0-500)",
		restoreAfterS: `integer, seconds (1-${TUNE_RESTORE_MAX_S})`,
	},
	"/api/tuner/:sourceId/config": {
		frequency: "integer, frequency in Hz (24000000-1900000000)",
		sampleRate: "integer, sample rate in Hz (225001-300000 or 900001-3200000)",
		gain: "integer, gain in tenths of a dB (0-500)",
		ppm: "integer, frequency correction in ppm (-500-500)",
	},
})

/** Fields a tuner 400 names, with the route's unit-bearing text where it has one. */
function tunerFields(
	url: string | undefined,
	fields: readonly ValidationField[],
): ValidationField[] {
	const known =
		url !== undefined && Object.hasOwn(FIELD_EXPECTED, url)
			? FIELD_EXPECTED[url]
			: undefined
	const expected = expectedFor(url)
	return fields.map(f => {
		const own =
			known !== undefined && Object.hasOwn(known, f.field)
				? known[f.field]
				: undefined
		if (own !== undefined)
			return {
				field: f.field,
				expected: f.expected.startsWith("required; ")
					? `required; ${own}`
					: own,
			}
		if (f.field === "body" && expected !== undefined)
			return { field: f.field, expected }
		return f
	})
}

function expectedFor(url: string | undefined): string | undefined {
	return url !== undefined && Object.hasOwn(EXPECTED_BODY, url)
		? EXPECTED_BODY[url]
		: undefined
}

/**
 * Field names a tuner 400 may name: the route schemas' property names and the controller's
 * TunerState field names. Anything else (an unknown key the client sent) is never echoed.
 */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
	...Object.keys(tunerConfigUpdateSchema.properties),
	...Object.keys(tuneBodySchema.properties),
	"sourceId",
	"hz",
	"tenthsDb",
	"mode",
	"enabled",
	"index",
	"stage",
])
/** At most this many failing fields are named (Fastify stops at the first by default). */
const MAX_NAMED_FIELDS = 4

/** "a.b" when every segment is a known field name or an array index, else null. */
function knownPath(segments: readonly (string | number)[]): string | null {
	if (segments.length === 0) return null
	for (const segment of segments)
		if (typeof segment === "string" && !KNOWN_FIELDS.has(segment)) return null
	return segments.join(".")
}

/** Where a Fastify (Ajv) validation failed, from schema paths only, never input values. */
function validationWhere(errors: FastifyError["validation"]): string | null {
	const where: string[] = []
	for (const issue of (errors ?? []).slice(0, MAX_NAMED_FIELDS)) {
		const segments: (string | number)[] = issue.instancePath
			.split("/")
			.filter(segment => segment !== "")
			.map(segment => (/^\d+$/.test(segment) ? Number(segment) : segment))
		const missing = (issue.params as { missingProperty?: unknown })
			.missingProperty
		if (typeof missing === "string") segments.push(missing)
		where.push(knownPath(segments) ?? "an unnamed field")
	}
	return where.length > 0 ? [...new Set(where)].join(", ") : null
}

/** The failing field a controller validation error (TunerValidationError) names, if known. */
function tunerErrorField(err: unknown): string | null {
	const field =
		typeof err === "object" && err !== null
			? (err as { field?: unknown }).field
			: undefined
	return typeof field === "string" ? knownPath(field.split(".")) : null
}

function handleTunerError(
	reply: FastifyReply,
	err: unknown,
	expected?: string,
	extra: Record<string, unknown> = {},
): unknown {
	const url = reply.request.routeOptions.url
	const error = err instanceof Error ? err : new Error("Unknown error")
	const maybeStatus = err as { statusCode?: number; code?: string }
	if (
		maybeStatus?.code === "SOURCE_RECONNECTING" ||
		maybeStatus?.code === "TUNER_COMMAND_TIMEOUT" ||
		maybeStatus?.code === "TUNER_QUEUE_FULL" ||
		maybeStatus?.code === "TUNER_NOT_USABLE" ||
		maybeStatus?.code === "TUNER_TUNE_PARTIAL"
	) {
		reply.header("Retry-After", "1")
		return reply.status(503).send({
			error: error.name,
			code: maybeStatus.code,
			message: error.message,
			...extra,
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

	// A 400 answers static text and the failing field's schema name only: the controller's
	// message can echo the submitted value.
	const field = statusCode === 400 ? tunerErrorField(err) : null
	const at = field !== null ? ` at ${field}` : ""
	return reply.status(statusCode).send({
		error: error.name || "TunerError",
		code,
		message:
			statusCode === 400
				? expected !== undefined
					? `Invalid tuner value${at}; expected ${expected}`
					: `Invalid tuner value${at}`
				: error.message,
		...(statusCode === 400
			? {
					fields: tunerFields(url, [
						{
							field: field ?? "body",
							expected: expected ?? "a value the tuner accepts",
						},
					]),
				}
			: {}),
		...extra,
	})
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
			const where = error.validation ? validationWhere(error.validation) : null
			const at = where !== null ? ` at ${where}` : ""
			const named = error.validation
				? ajvValidationFields(
						error.validation,
						requestPart(part),
						routeSchemaFor(request, part),
					)
				: []
			return reply.status(400).send({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message:
					expected !== undefined
						? `Invalid request ${part}${at}; expected ${expected}`
						: `Invalid request ${part}${at}`,
				fields: tunerFields(
					request.routeOptions.url,
					named.length > 0
						? named
						: [{ field: "body", expected: "a JSON object" }],
				),
			})
		}
		throw error
	})
	const rest = (request: FastifyRequest): TunerWriteOptions =>
		restWrite(options.principalKind?.(request))
	const run = async (
		id: string,
		command: () => Promise<unknown>,
	): Promise<unknown> => {
		const result = options.sourceManager
			? await options.sourceManager.runTunerCommand(id, command)
			: await command()
		return tunerController.getState(id) ?? result
	}
	// rtl_tcp ignores a gain index outside the gain table its header advertises: a 400 naming the
	// valid range (from the header, never the client's value). No header count: no check here.
	// The gain table length when `index` is past it, else undefined.
	const gainIndexLimit = (
		sourceId: string,
		index: number | undefined,
	): number | undefined => {
		if (index === undefined) return undefined
		const count = tunerController.tunerGainCount(sourceId)
		return count === undefined || index < count ? undefined : count
	}
	const sendGainIndexRange = (
		reply: FastifyReply,
		field: string,
		count: number,
	): FastifyReply => {
		const expected = `integer, tuner gain table index (0-${count - 1}) for this receiver`
		return reply.status(400).send({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message: `Invalid tuner value at ${field}; expected ${expected}`,
			fields: [{ field, expected }],
		})
	}
	/**
	 * Runs a write carrying a gain index once the range check passes: before the command queue, and
	 * again inside it against the receiver getting the write (a reconnect while queued may bring
	 * another header). Out of range either way: the same 400, and nothing is written.
	 */
	const runGainIndexWrite = async (
		reply: FastifyReply,
		sourceId: string,
		index: number | undefined,
		field: string,
		write: () => Promise<void>,
	): Promise<unknown> => {
		const early = gainIndexLimit(sourceId, index)
		if (early !== undefined) return sendGainIndexRange(reply, field, early)
		let queuedLimit: number | undefined
		const result = await run(sourceId, async () => {
			queuedLimit = gainIndexLimit(sourceId, index)
			if (queuedLimit !== undefined) return undefined
			await write()
			return tunerController.getState(sourceId)
		})
		return queuedLimit !== undefined
			? sendGainIndexRange(reply, field, queuedLimit)
			: result
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
							rest(request),
							request.body.hz,
						)
					await tunerController.setFrequency(
						request.params.sourceId,
						request.body.hz,
						rest(request),
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

	// POST /api/tuner/:sourceId/take-back - The held centre and rate, written again in one call
	fastify.post<{
		Params: { sourceId: string }
		Body: unknown
		Reply: TunerState | unknown
	}>(
		"/api/tuner/:sourceId/take-back",
		{
			schema: {
				tags: ["tuner"],
				summary: "Take the receiver's tuning back",
				description:
					"Writes the held sample rate and centre (accepted, also before a plain resume, else configured) as operator writes, whatever is proven now, and ends a plain resume's hold: one call re-proves both. Answers the tuner state (proof settling). 409 TUNER_TAKE_BACK_BLOCKED under a relay client, a scanner lease or another core owning the receiver; 409 TUNER_NOTHING_HELD with no held value (set the tuning instead).",
				params: {
					type: "object",
					properties: { sourceId: { type: "string" } },
					required: ["sourceId"],
				},
				response: {
					200: tunerStateSchema,
					400: errorResponseSchema,
					404: errorResponseSchema,
					409: errorResponseSchema,
				},
			},
		},
		async (request, reply) => {
			if (!TakeBackBodySchema.safeParse(request.body ?? {}).success)
				return reply.status(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: `Invalid tuner value at body; expected ${TAKE_BACK_EXPECTED}`,
					fields: [{ field: "body", expected: TAKE_BACK_EXPECTED }],
				})
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.takeTuningBack(
						request.params.sourceId,
						rest(request),
					)
					return tunerController.getState(request.params.sourceId)
				})
			} catch (err) {
				return handleTunerError(reply, err, TAKE_BACK_EXPECTED)
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
					message: `Invalid request body at ${value === undefined ? "gain" : "gain, tenthsDb"}; expected ${GAIN_EXPECTED}`,
					fields:
						value === undefined
							? [
									{
										field: "gain",
										expected: `required; ${GAIN_FIELD_EXPECTED}`,
									},
								]
							: [
									{ field: "gain", expected: GAIN_FIELD_EXPECTED },
									{ field: "tenthsDb", expected: GAIN_FIELD_EXPECTED },
								],
				})
			try {
				return await run(request.params.sourceId, async () => {
					await tunerController.setGain(
						request.params.sourceId,
						value,
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
						rest(request),
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
				return await runGainIndexWrite(
					reply,
					request.params.sourceId,
					request.body.index,
					"index",
					() =>
						tunerController.setTunerGainIndex(
							request.params.sourceId,
							request.body.index,
							rest(request),
						),
				)
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
						rest(request),
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
				description:
					"Apply multiple tuner settings at once. Takes the field names and units of GET /api/tuner; any other field is a 400.",
				body: tunerConfigUpdateSchema,
				response: { 200: tunerStateSchema, 400: errorResponseSchema },
			},
			preValidation: rejectUnknownBodyFields(
				tunerConfigUpdateSchema,
				expectedFor("/api/tuner/:sourceId/config"),
			),
		},
		async (request, reply) => {
			const { gainMode, gain, tunerGainIndex } = request.body
			// A gain or gain index write can leave AGC (R820T/R828D): AGC beside one is a conflict.
			if (
				gainMode === "agc" &&
				(gain !== undefined || tunerGainIndex !== undefined)
			)
				return reply.status(400).send({
					error: "ValidationError",
					code: "VALIDATION_ERROR",
					message: `Invalid tuner values; ${CONFIG_AGC_CONFLICT}`,
					fields: [{ field: "gainMode", expected: CONFIG_AGC_CONFLICT }],
				})
			try {
				return await runGainIndexWrite(
					reply,
					request.params.sourceId,
					tunerGainIndex,
					"tunerGainIndex",
					() =>
						tunerController.configure(
							request.params.sourceId,
							request.body,
							rest(request),
						),
				)
			} catch (err) {
				return handleTunerError(
					reply,
					err,
					expectedFor(request.routeOptions.url),
				)
			}
		},
	)

	const source = options.sourceManager
	if (
		source?.isTunerUsable !== undefined &&
		source.getStatus !== undefined &&
		source.on !== undefined &&
		source.off !== undefined
	) {
		// Made on first use and only then: until a tune runs, the state carries nothing of it.
		const tuneSource = source as TuneSource
		let tuning: TunerTuning | undefined
		const tuningOf = (): TunerTuning =>
			(tuning ??= new TunerTuning(
				fastify.log as unknown as Logger,
				tunerController,
				tuneSource,
				options.scannerLeaseHolder,
				options.receiverStatus,
			))
		fastify.addHook("onClose", async () => {
			tuning?.close()
		})
		const tuneResult = (outcome: TuneOutcome) => ({
			usable: outcome.usable,
			applied: outcome.applied,
			notApplied: outcome.notApplied,
			...(outcome.preempted ? { preempted: outcome.preempted } : {}),
		})
		const leaseFacts = (err: unknown) =>
			err instanceof TunerLeaseHeldError
				? { jobId: err.job.jobId, jobName: err.job.name }
				: {}

		// POST /api/tuner/:sourceId/tune - Rate, centre and gain in one call
		fastify.post<{
			Params: { sourceId: string }
			Body: TuneRequest
			Reply: unknown
		}>(
			TUNE_URL,
			{
				schema: {
					tags: ["tuner"],
					summary: "Tune: rate, centre and gain in one call",
					description:
						"Applies the settings in order and answers once the source delivers IQ again, at most 18 s later. With restoreAfterS the prior tuning comes back unless another write changes the tuner first. A scanner job holding the tuner answers 409 TUNER_LEASE_HELD unless preempt is true; the answer then says what became of the job.",
					body: tuneBodySchema,
					response: {
						200: tuneResponseSchema,
						400: errorResponseSchema,
						404: tuneFailureSchema,
						409: tuneFailureSchema,
						500: tuneFailureSchema,
						503: tuneFailureSchema,
					},
				},
				// An unknown field is named by the key list, as on the other routes, and wins over
				// "at least one of": the client's own key text is never echoed.
				preValidation: rejectUnknownBodyFields(tuneBodySchema),
			},
			async (request, reply) => {
				const { sampleRateHz, frequencyHz, gainMode, gain } = request.body
				if (
					sampleRateHz === undefined &&
					frequencyHz === undefined &&
					gainMode === undefined &&
					gain === undefined
				)
					return reply.status(400).send({
						error: "ValidationError",
						code: "VALIDATION_ERROR",
						message: `Invalid request body; expected ${TUNE_EXPECTED}`,
						fields: [{ field: "body", expected: TUNE_EXPECTED }],
					})
				try {
					const outcome = await tuningOf().tune(
						request.params.sourceId,
						request.body,
						rest(request),
					)
					if (outcome.error === undefined)
						return { ...outcome.state, ...tuneResult(outcome) }
					return handleTunerError(reply, outcome.error, TUNE_EXPECTED, {
						...tuneResult(outcome),
						...leaseFacts(outcome.error),
						...(outcome.inFlight ? { inFlight: true } : {}),
						...(outcome.state ? { state: outcome.state } : {}),
						...(outcome.sourceVerdict
							? { sourceVerdict: outcome.sourceVerdict }
							: {}),
					})
				} catch (err) {
					return handleTunerError(reply, err, TUNE_EXPECTED, leaseFacts(err))
				}
			},
		)

		// DELETE /api/tuner/:sourceId/tune/restore - Keep the temporary tuning
		fastify.delete<{ Params: { sourceId: string }; Reply: unknown }>(
			"/api/tuner/:sourceId/tune/restore",
			{
				schema: {
					tags: ["tuner"],
					summary: "Cancel the pending restore of a temporary tune",
					response: {
						200: tunerStateSchema,
						404: errorResponseSchema,
					},
				},
			},
			async (request, reply) => {
				try {
					return tuningOf().cancelRestore(
						request.params.sourceId,
						rest(request).actor ?? "unknown",
					)
				} catch (err) {
					return handleTunerError(reply, err)
				}
			},
		)
	}

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
				if (err instanceof BandGainSettingsError) {
					const parsed =
						err.statusCode === 400
							? BandGainSettingsSchema.safeParse(request.body)
							: null
					return reply.status(err.statusCode).send({
						error: err.name,
						code: err.code,
						message: err.message,
						...(err.statusCode === 400
							? {
									fields:
										parsed !== null && !parsed.success
											? zodValidationFields(
													parsed.error,
													BandGainSettingsSchema,
													{ rules: BAND_GAIN_RULES },
												)
											: [
													{
														field: "body",
														expected:
															EXPECTED_BODY["/api/tuner-band-gain"] ?? "",
													},
												],
								}
							: {}),
					})
				}
				throw err
			}
		},
	)
}
