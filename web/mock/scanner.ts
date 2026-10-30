/**
 * Scanner mock: the core's /api/scanner routes (src/api/routes/scanner.ts, schemas from
 * scanner-schemas.ts) and the `scanner` WS channel (src/api/websocket/scanner-broadcast.ts), served
 * from the canvas data. Plan previews run a port of the core's planner (src/core/scanner/plan:
 * normaliseSpec, hop-planner, lockouts, poi, estimates) against the mock receiver; jobs run a
 * simulated sweep that steps the mock tuner hop by hop, holds on active mock signals and records
 * discoveries. Error bodies are the routes' own (`{ error, code, message, details? }`).
 * Type stripping only: no enums, parameter properties or namespaces.
 */
import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z, ZodError } from "zod"
import type {
	Bandplan,
	DecoderInfo,
	Discovery,
	DiscoveryMetadata,
	FailReason,
	Hop,
	HopPlan,
	Identity,
	IdentityKind,
	Impact,
	JobState,
	LiveAudioStatus,
	LockoutExclusion,
	NormalisedJobSpec,
	Observation,
	PauseReason,
	PlanIssue,
	PlanIssueCode,
	PlanPreview,
	ProtocolFamily,
	Raster,
	ScanExclusion,
	ScanJob,
	ScanJobHit,
	ScanJobHitStats,
	ScanJobHitsResponse,
	ScanJobProgress,
	ScanJobSpec,
	ScanMode,
	ScanRange,
	ScannerActivityEventData,
	ScannerClass,
	ScannerConfidence,
	ScannerDiscoveryEventData,
	ScannerIdentifyResult,
	ScannerProgressEventData,
	ScannerProof,
	ScannerProtocol,
	ScannerSettingBounds,
	ScannerSettingProvenance,
	ScannerSettingsValues,
	ScannerSettingsView,
	ScannerStatus,
	TunerState,
} from "@wavekit/api-types"
import { SCANNER_PROOF_PROTOCOL_LABEL } from "@wavekit/api-types"
import { bandFixtureDiscoveries } from "./band-fixtures.ts"
import { retuneSweepDiscoveries } from "./retune-sweep.ts"
import {
	DISCOVERY_SEEDS,
	MOCK_SIGNALS,
	MOCK_SWEEP_JOB_ID,
	NOISE_FLOOR_DBFS,
	SCANNER_BANDPLANS,
	USABLE_FRACTION,
	identifyPlanFor,
	seedDiscoveryId,
	signalActive,
} from "./data.ts"
import type { MockSignal } from "./data.ts"

// --- Core constants (src/core/scanner) ---

/** The scanner's tuner range (scanner-service previewContext). */
const TUNER_RANGE = { startHz: 24_000_000, endHz: 1_766_000_000 }
const MARKER_RUN_ASSUMED_MS = 30
const DEFAULT_PRIORITY = 50
const DEFAULT_AUTO_RESUME_MS = 60_000
const DEFAULT_TX_HINT_MS = 5000
const TYPICAL_OBW_HZ = 9000
const RBW_FINE_HZ = 250
const POI_LOW = 0.5
const VOICE_WAV_MB_PER_HOUR = 57.6
const IQ_SNIPPET_MB = 0.096
const CONFIRMS_PER_PROBE_HOUR = 60
const DISK_BUDGET_HOURS = 6
const CPU_ENGINE = 0.08
const CPU_OFFSET_PROBE = 0.5
const FREE_RANGE_WIDTH_HZ = 25_000
const DC_GRID_HZ = 100
const DEFAULT_OBW_FRACTION = 0.72
const EPS = 1e-6
const LOCKOUT_MIN_WIDTH_HZ = 1000
const LOCKOUT_EXCLUSIONS_MAX = 256
const JOB_HITS_LIMIT_DEFAULT = 100
const JOB_HITS_LIMIT_MAX = 500
const DISCOVERY_LIMIT_DEFAULT = 100
const DISCOVERY_LIMIT_MAX = 500
/** How long the simulated sweep holds on an active signal (capped by the job's maxHoldMs). */
const MOCK_HOLD_MS = 3000
/** Delay before a created job turns from `starting` to `running`. */
const MOCK_START_MS = 120

const DEFAULT_CONFIRM_HOLD_MS: Readonly<Record<ScannerClass, number>> = {
	"tdma-ms": 1800,
	"fsk4-12k5": 3800,
	"fsk4-6k25": 4000,
	"gmsk-narrow": 2000,
	"fsk2-wide": 4000,
	"afsk-fm": 3000,
	"ook-burst": 10_000,
	"analog-fm": 1500,
	"analog-am": 0,
	carrier: 0,
	wideband: 0,
	unknown: 0,
}

type DecoderType = "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433"

const PROTOCOL_DECODER: Readonly<Record<ScannerProtocol, DecoderType | null>> =
	{
		"analog-fm": null,
		"analog-am": null,
		dmr: "dsd-fme",
		p25p1: "dsd-fme",
		p25p2: "dsd-fme",
		nxdn48: "dsd-fme",
		nxdn96: "dsd-fme",
		ysf: "dsd-fme",
		dstar: "dsd-fme",
		dpmr: "dsd-fme",
		pocsag: "multimon-ng",
		flex: "multimon-ng",
		aprs: "direwolf",
		ism: "rtl433",
		"digital-unknown": null,
		carrier: null,
		unknown: null,
		ais: null,
		acars: null,
		vdl2: null,
		lora: null,
		adsb: null,
	}

const PROTOCOL_CLASS: Readonly<Record<ScannerProtocol, ScannerClass | null>> = {
	"analog-fm": "analog-fm",
	"analog-am": null,
	dmr: "tdma-ms",
	p25p1: "fsk4-12k5",
	p25p2: "fsk4-12k5",
	nxdn48: "fsk4-6k25",
	nxdn96: "fsk4-12k5",
	ysf: "fsk4-12k5",
	dstar: "gmsk-narrow",
	dpmr: "fsk4-6k25",
	pocsag: "fsk2-wide",
	flex: "fsk2-wide",
	aprs: "afsk-fm",
	ism: "ook-burst",
	"digital-unknown": null,
	carrier: null,
	unknown: null,
	ais: null,
	acars: null,
	vdl2: null,
	lora: null,
	adsb: null,
}

const PROTOCOL_FAMILY: Readonly<Record<ScannerProtocol, ProtocolFamily>> = {
	"analog-fm": "analog",
	"analog-am": "analog",
	dmr: "digital-voice",
	p25p1: "digital-voice",
	p25p2: "digital-voice",
	nxdn48: "digital-voice",
	nxdn96: "digital-voice",
	ysf: "digital-voice",
	dstar: "digital-voice",
	dpmr: "digital-voice",
	pocsag: "pager",
	flex: "pager",
	aprs: "packet",
	ism: "ism",
	"digital-unknown": "unknown",
	carrier: "carrier",
	unknown: "unknown",
	ais: "packet",
	acars: "packet",
	vdl2: "packet",
	lora: "packet",
	adsb: "packet",
}

const ALL_PROTOCOLS = Object.keys(PROTOCOL_DECODER) as ScannerProtocol[]
const ALL_CLASSES = Object.keys(DEFAULT_CONFIRM_HOLD_MS) as ScannerClass[]
const CONFIDENCE_RANK: Readonly<Record<ScannerConfidence, number>> = {
	activity: 0,
	candidate: 1,
	classified: 2,
	decoded: 3,
}
const IDENTITY_KINDS: readonly IdentityKind[] = [
	"dmr-cc",
	"p25-nac",
	"nxdn-ran",
	"ysf-dgid",
	"dstar-call",
	"dpmr-cc",
	"pocsag-capcode",
	"aprs-call",
	"ism-model",
	"ais-mmsi",
	"acars-reg",
	"vdl2-addr",
	"lora-node",
]

// --- Route schemas (src/api/routes/scanner-schemas.ts) ---

const protocolEnum = ALL_PROTOCOLS
const confidenceEnum = ["activity", "candidate", "classified", "decoded"]
const IDENTITY_QUERY = new RegExp(`^(${IDENTITY_KINDS.join("|")}):(.+)$`)
const DISCOVERY_ID = /^d_[0-9A-Za-z]+$/

const rangeSchema = {
	type: "object",
	properties: {
		startHz: { type: "number", minimum: 0 },
		endHz: { type: "number", minimum: 0 },
		spacingHz: { type: "number", exclusiveMinimum: 0 },
		firstChannelHz: { type: "number" },
		rasters: {
			type: "array",
			items: {
				type: "object",
				properties: {
					spacingHz: { type: "number", exclusiveMinimum: 0 },
					firstChannelHz: { type: "number" },
				},
				required: ["spacingHz", "firstChannelHz"],
				additionalProperties: false,
			},
		},
		obwHz: { type: "array", items: { type: "number", exclusiveMinimum: 0 } },
		protocols: { type: "array", items: { type: "string", enum: protocolEnum } },
		bandplanId: { type: "string" },
		enabled: { type: "boolean" },
		name: { type: "string", minLength: 1, maxLength: 100 },
		dwellMs: { type: "number", minimum: 10, maximum: 600000 },
		sensitivity: { type: "string", enum: ["low", "normal", "high"] },
	},
	required: ["startHz", "endHz"],
	dependencies: { firstChannelHz: ["spacingHz"] },
	not: { required: ["spacingHz", "rasters"] },
	additionalProperties: false,
}

const exclusionSchema = {
	type: "object",
	properties: {
		startHz: { type: "number", minimum: 0 },
		endHz: { type: "number", minimum: 0 },
		frequencyHz: { type: "number", minimum: 0 },
		widthHz: { type: "number", exclusiveMinimum: 0 },
		reason: { type: "string", maxLength: 200 },
	},
	oneOf: [
		{ required: ["startHz", "endHz"] },
		{ required: ["frequencyHz", "widthHz"] },
	],
	additionalProperties: false,
}

const looseObjectSchema = { type: "object", additionalProperties: true }

const scanJobSpecSchema = {
	type: "object",
	properties: {
		name: { type: "string", maxLength: 100 },
		sourceId: { type: "string", minLength: 1 },
		mode: { type: "string", enum: ["in-window", "sweep", "auto"] },
		kind: { type: "string", enum: ["discover", "monitor"] },
		ranges: { type: "array", items: rangeSchema, maxItems: 64 },
		bandplans: { type: "array", items: { type: "string" }, maxItems: 16 },
		exclusions: { type: "array", items: exclusionSchema, maxItems: 256 },
		protocols: { type: "array", items: { type: "string", enum: protocolEnum } },
		sensitivity: { type: "string", enum: ["low", "normal", "high"] },
		thresholdDb: { type: "number", minimum: 0, maximum: 40 },
		fftSize: { type: "integer", enum: [512, 1024, 2048, 4096, 8192, 16384] },
		integrationMs: { type: "number", minimum: 5, maximum: 1000 },
		dwellMs: { type: "number", minimum: 10, maximum: 600000 },
		settleMs: { type: "number", minimum: 0, maximum: 10000 },
		hold: {
			type: "object",
			properties: {
				policy: { type: "string", enum: ["hold", "confirm", "never"] },
				confirmHoldMs: { type: "number", minimum: 0, maximum: 600000 },
				maxHoldMs: { type: "number", minimum: 0, maximum: 3600000 },
				hangMs: { type: "number", minimum: 0, maximum: 60000 },
			},
			required: ["policy"],
			additionalProperties: false,
		},
		revisit: {
			type: "object",
			properties: {
				share: { type: "number", minimum: 0, maximum: 1 },
				maxIntervalMs: { type: "number", minimum: 0 },
			},
			additionalProperties: false,
		},
		record: {
			type: "object",
			properties: {
				voice: { type: "boolean" },
				analog: { type: "boolean" },
				data: { type: "boolean" },
			},
			additionalProperties: false,
		},
		evidence: {
			type: "object",
			properties: { psd: { type: "boolean" }, iq: { type: "boolean" } },
			additionalProperties: false,
		},
		tuner: {
			type: "object",
			properties: {
				sampleRateHz: { type: "integer", minimum: 225001, maximum: 3200000 },
				gainTenthsDb: { type: "integer", minimum: 0, maximum: 500 },
				agc: { type: "boolean" },
				overload: { type: "string", enum: ["flag", "reduce-gain"] },
			},
			additionalProperties: false,
		},
		stop: {
			type: "object",
			properties: {
				afterSweeps: { type: "integer", minimum: 1 },
				afterMs: { type: "integer", minimum: 1000 },
				onFirstDecoded: { type: "boolean" },
			},
			additionalProperties: false,
		},
		priority: { type: "integer", minimum: 0, maximum: 100 },
		takeover: { type: "boolean" },
		resume: {
			type: "object",
			properties: {
				autoAfterIdleMs: {
					anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
				},
				onBoot: { type: "boolean" },
			},
			additionalProperties: false,
		},
		txDurationHintMs: { type: "integer", minimum: 100, maximum: 600000 },
		monitor: looseObjectSchema,
		capture: {
			type: "object",
			properties: {
				enabled: { type: "boolean" },
				mode: { type: "string", enum: ["wideband", "channel"] },
				preMs: { type: "integer", minimum: 0, maximum: 5000 },
				postMs: { type: "integer", minimum: 0, maximum: 10000 },
				onlyDecoded: { type: "boolean" },
				maxPerHour: { type: "integer", minimum: 1, maximum: 60 },
			},
			required: ["enabled"],
			additionalProperties: false,
		},
		signalsOnly: { type: "boolean" },
		skipDecodedElsewhere: { type: "boolean" },
		skipBandPlanSkips: { type: "boolean" },
	},
	additionalProperties: false,
}

const jobIdParamsSchema = {
	type: "object",
	properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
	required: ["id"],
}
const discoveryIdParamsSchema = {
	type: "object",
	properties: {
		id: { type: "string", maxLength: 64, pattern: DISCOVERY_ID.source },
	},
	required: ["id"],
}
const resumeBodySchema = {
	type: ["object", "null"],
	properties: { takeover: { type: "boolean" } },
	additionalProperties: false,
}
const discoveryQuerySchema = {
	type: "object",
	properties: {
		jobId: { type: "string" },
		sourceId: { type: "string" },
		protocol: { type: "string", enum: protocolEnum },
		minConfidence: { type: "string", enum: confidenceEnum },
		freqMinHz: { type: "number", minimum: 0 },
		freqMaxHz: { type: "number", minimum: 0 },
		since: { type: "string", format: "date-time" },
		encrypted: { type: "boolean" },
		q: { type: "string", maxLength: 100 },
		identity: {
			type: "string",
			maxLength: 100,
			pattern: IDENTITY_QUERY.source,
		},
		sort: { type: "string", enum: ["lastSeen", "frequency", "confidence"] },
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
		evidence: { type: "string", enum: ["proven", "weak", "all"] },
		nearHz: { type: "integer", minimum: 1 },
		toleranceHz: { type: "integer", minimum: 1, maximum: 1_000_000 },
	},
	additionalProperties: false,
}
const observationsQuerySchema = {
	type: "object",
	properties: {
		cursor: { type: "string" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
	},
	additionalProperties: false,
}
const jobHitsQuerySchema = {
	type: "object",
	properties: {
		limit: {
			type: "integer",
			minimum: 1,
			maximum: JOB_HITS_LIMIT_MAX,
			default: JOB_HITS_LIMIT_DEFAULT,
		},
	},
	additionalProperties: false,
}
const discoveryPatchSchema = {
	type: "object",
	properties: {
		label: { type: "string", maxLength: 100 },
		notes: { type: "string", maxLength: 2000 },
		lockout: { type: "boolean" },
		keep: { type: "boolean" },
	},
	additionalProperties: false,
	minProperties: 1,
}

// --- Settings (src/core/scanner/settings.ts, config defaults) ---

function defaultSettings(): ScannerSettingsValues {
	return {
		enabled: true,
		passive: { enabled: true, offsetProbes: false },
		cpuBudgetCores: 1,
		cpuGuardPercent: 90,
		maxProbes: { offset: 1, channel: 4 },
		ringSeconds: 3,
		detection: {
			fftSize: "auto",
			integrationMs: 50,
			sensitivity: "normal",
			faTargetPerMhzMin: 1,
			dcGuardHz: 1500,
			ppmMargin: 2,
			clipFraction: 0.001,
			hysteresisDb: 3,
			minSurfaceBlocks: 2,
			shortIntegrationMs: 5,
			overlap: 0,
		},
		sweep: {
			markers: true,
			markerTimeoutMs: 2000,
			pllSettleMs: 5,
			settleMs: { local: 300, network: 1000 },
			revisitShare: 0.3,
		},
		hold: { maxHoldMs: 60_000, hangMs: 2000, preRollMs: 300 },
		storage: {
			dir: null,
			maxRecordingsMb: 512,
			maxEvidenceMb: 64,
			maxJournalMb: 64,
			maxAgeDays: 30,
			discoveryMaxAgeDays: 180,
			minFreeDiskMb: 2048,
			maxDiscoveries: 10_000,
			maxCapturesMb: 256,
		},
		ws: {
			maxMessagesPerSecond: 10,
			spectrumHz: 10,
			spectrumBins: 512,
			spectrumSummaryBins: 2048,
			spectrumMaxProfiles: 4,
		},
	}
}

const SETTINGS_BOUNDS: Readonly<Record<string, ScannerSettingBounds>> = {
	cpuBudgetCores: { type: "number", min: 0.1, max: 64 },
	"maxProbes.offset": { type: "integer", min: 0, max: 16 },
	"maxProbes.channel": { type: "integer", min: 0, max: 64 },
	"detection.integrationMs": { type: "number", min: 5, max: 1000 },
	"detection.faTargetPerMhzMin": { type: "number", min: 0.01, max: 1000 },
	"detection.hysteresisDb": { type: "number", min: 0, max: 20 },
	"detection.minSurfaceBlocks": { type: "integer", min: 1, max: 20 },
	"storage.maxRecordingsMb": { type: "integer", min: 1, max: 1_000_000 },
	"storage.maxEvidenceMb": { type: "integer", min: 1, max: 100_000 },
	"storage.maxJournalMb": { type: "integer", min: 1, max: 10_000 },
	"storage.maxAgeDays": { type: "integer", min: 1, max: 3650 },
	"storage.discoveryMaxAgeDays": { type: "integer", min: 1, max: 3650 },
	"storage.minFreeDiskMb": { type: "integer", min: 0, max: 1_000_000 },
	"storage.maxDiscoveries": { type: "integer", min: 1, max: 1_000_000 },
	"storage.maxCapturesMb": { type: "integer", min: 1, max: 100_000 },
	"ws.maxMessagesPerSecond": { type: "integer", min: 1, max: 100 },
	"ws.spectrumHz": { type: "number", min: 0.5, max: 25 },
	"ws.spectrumBins": { type: "integer", min: 128, max: 2048 },
	"detection.sensitivity": { type: "string", enum: ["low", "normal", "high"] },
	"passive.<sourceId>": { type: "boolean" },
}

/** RuntimeSettingsOverridesSchema (src/core/scanner/store/persistence.ts). */
const SettingsPatchSchema = z
	.object({
		passive: z.record(z.string().min(1), z.boolean()).optional(),
		cpuBudgetCores: z.number().min(0.1).max(64).optional(),
		maxProbes: z
			.object({
				offset: z.number().int().min(0).max(16).optional(),
				channel: z.number().int().min(0).max(64).optional(),
			})
			.strict()
			.optional(),
		detection: z
			.object({
				integrationMs: z.number().min(5).max(1000).optional(),
				sensitivity: z.enum(["low", "normal", "high"]).optional(),
				faTargetPerMhzMin: z.number().min(0.01).max(1000).optional(),
				hysteresisDb: z.number().min(0).max(20).optional(),
				minSurfaceBlocks: z.number().int().min(1).max(20).optional(),
			})
			.strict()
			.optional(),
		storage: z
			.object({
				maxRecordingsMb: z.number().int().min(1).max(1_000_000).optional(),
				maxEvidenceMb: z.number().int().min(1).max(100_000).optional(),
				maxJournalMb: z.number().int().min(1).max(10_000).optional(),
				maxAgeDays: z.number().int().min(1).max(3650).optional(),
				discoveryMaxAgeDays: z.number().int().min(1).max(3650).optional(),
				minFreeDiskMb: z.number().int().min(0).max(1_000_000).optional(),
				maxDiscoveries: z.number().int().min(1).max(1_000_000).optional(),
				maxCapturesMb: z.number().int().min(1).max(100_000).optional(),
			})
			.strict()
			.optional(),
		ws: z
			.object({
				maxMessagesPerSecond: z.number().int().min(1).max(100).optional(),
				spectrumHz: z.number().min(0.5).max(25).optional(),
				spectrumBins: z.number().int().min(128).max(2048).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

type Tree = Record<string, unknown>
const isTree = (v: unknown): v is Tree =>
	typeof v === "object" && v !== null && !Array.isArray(v)

function leaves(value: unknown, prefix = ""): [string, unknown][] {
	if (!isTree(value)) return [[prefix, value]]
	return Object.entries(value).flatMap(([key, child]) =>
		leaves(child, prefix ? `${prefix}.${key}` : key),
	)
}

function writePath(tree: Tree, path: string, value: unknown): void {
	const parts = path.split(".")
	const leaf = parts.pop()
	if (leaf === undefined) return
	let node = tree
	for (const part of parts) {
		const child = node[part]
		if (isTree(child)) node = child
		else {
			const created: Tree = {}
			node[part] = created
			node = created
		}
	}
	node[leaf] = value
}

/** ConfigValidationError.formatZodError (packages/shared). */
function formatZodError(error: ZodError): string {
	const lines = error.issues.map(issue => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "root"
		switch (issue.code) {
			case "invalid_type":
				return `  - ${path}: Expected ${issue.expected}, received ${issue.received}`
			case "invalid_enum_value":
				return `  - ${path}: Invalid value. Expected one of: ${issue.options.join(", ")}`
			case "too_small":
				return `  - ${path}: Value is too small (minimum: ${String(issue.minimum)})`
			case "too_big":
				return `  - ${path}: Value is too large (maximum: ${String(issue.maximum)})`
			case "invalid_string":
				return `  - ${path}: Invalid string format`
			default:
				return `  - ${path}: ${issue.message}`
		}
	})
	return `Configuration validation failed:\n${lines.join("\n")}`
}

// --- Errors ---

/** ScannerApiError: the routes answer it with its own status. */
class ScannerApiError extends Error {
	readonly code: string
	readonly statusCode: number
	readonly details: Record<string, unknown> | undefined
	constructor(
		message: string,
		code: string,
		statusCode: number,
		details?: Record<string, unknown>,
	) {
		super(message)
		this.name = "ScannerApiError"
		this.code = code
		this.statusCode = statusCode
		this.details = details
	}
}

/** A plain WaveKitError: the central handler answers 400 with a correlation id. */
class CoreError extends Error {
	readonly code: string
	constructor(message: string, code: string) {
		super(message)
		this.name = "WaveKitError"
		this.code = code
	}
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
	if (err instanceof ScannerApiError)
		return reply.code(err.statusCode).send({
			error: err.name,
			code: err.code,
			message: err.message,
			...(err.details ? { details: err.details } : {}),
		})
	if (err instanceof ZodError)
		return reply.code(400).send({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message: formatZodError(err),
		})
	if (err instanceof CoreError)
		return reply.code(400).send({
			error: err.name,
			code: err.code,
			message: err.message,
			correlationId: randomUUID(),
		})
	throw err
}

function notFound(reply: FastifyReply, what: string, id: string): FastifyReply {
	return reply.code(404).send({
		error: "NotFound",
		code: "SCANNER_NOT_FOUND",
		message: `${what} ${id} not found`,
	})
}

const issue = (
	code: PlanIssueCode,
	severity: "error" | "warning",
	message: string,
	details?: Record<string, unknown>,
): PlanIssue =>
	details === undefined
		? { code, severity, message }
		: { code, severity, message, details }

// --- Hop planner (src/core/scanner/plan/hop-planner.ts) ---

interface FreqRange {
	startHz: number
	endHz: number
}

interface HopPlanInput {
	ranges: ScanRange[]
	exclusions: ScanExclusion[]
	sampleRateHz: number
	usableFraction: number
	rbwHz: number
	dcGuardHz: number
	ppmMargin: number
	tunerRange: FreqRange
}

interface PlanItem {
	hz: number
	widthHz: number
	edgeHalfHz: number
}

interface FreeSpan {
	lo: number
	hi: number
	widthHz: number
	next: number
}

function rasterUnion(ranges: ScanRange[]): Raster[] {
	const out: Raster[] = []
	const seen = new Set<string>()
	for (const r of ranges)
		for (const x of r.rasters ?? []) {
			if (!(x.spacingHz > 0)) continue
			const phase =
				((x.firstChannelHz % x.spacingHz) + x.spacingHz) % x.spacingHz
			const key = `${x.spacingHz}:${phase}`
			if (seen.has(key)) continue
			seen.add(key)
			out.push(x)
		}
	return out
}

const inExclusion = (hz: number, exclusions: readonly FreqRange[]) =>
	exclusions.some(x => hz >= x.startHz && hz <= x.endHz)

const clamp = (hz: number, r: FreqRange) =>
	Math.min(r.endHz, Math.max(r.startHz, hz))

function rasterItems(
	ranges: ScanRange[],
	exclusions: ScanExclusion[],
): PlanItem[] {
	const byHz = new Map<number, PlanItem>()
	for (const r of ranges) {
		const classes = r.obwHz ?? []
		for (const raster of r.rasters ?? []) {
			const s = raster.spacingHz
			if (!(s > 0)) continue
			let fitting = -Infinity
			for (const o of classes) if (o <= s) fitting = Math.max(fitting, o)
			const obw =
				fitting > 0
					? fitting
					: classes.length > 0
						? Math.min(...classes)
						: DEFAULT_OBW_FRACTION * s
			const first = Math.ceil((r.startHz - raster.firstChannelHz) / s - EPS)
			for (let k = first; raster.firstChannelHz + k * s <= r.endHz + EPS; k++) {
				const hz = Math.round(raster.firstChannelHz + k * s)
				if (inExclusion(hz, exclusions)) continue
				const prev = byHz.get(hz)
				byHz.set(hz, {
					hz,
					widthHz: Math.max(s, prev?.widthHz ?? 0),
					edgeHalfHz: Math.max(obw / 2, prev?.edgeHalfHz ?? 0),
				})
			}
		}
	}
	return [...byHz.values()].sort((a, b) => a.hz - b.hz)
}

function freeSpans(
	ranges: ScanRange[],
	exclusions: ScanExclusion[],
): FreeSpan[] {
	const out: FreeSpan[] = []
	for (const r of ranges) {
		if ((r.rasters ?? []).length > 0) continue
		const widthHz =
			(r.obwHz ?? []).reduce((a, b) => Math.max(a, b), 0) || FREE_RANGE_WIDTH_HZ
		let pieces: [number, number][] = [[r.startHz, r.endHz]]
		for (const x of exclusions) {
			pieces = pieces.flatMap(([a, b]): [number, number][] => {
				if (x.endHz < a || x.startHz > b) return [[a, b]]
				const parts: [number, number][] = []
				if (x.startHz > a) parts.push([a, x.startHz])
				if (x.endHz < b) parts.push([x.endHz, b])
				return parts
			})
		}
		for (const [lo, hi] of pieces) out.push({ lo, hi, widthHz, next: lo })
	}
	return out
}

function greedyCentres(
	items: PlanItem[],
	spans: FreeSpan[],
	H: number,
	slack: number,
	wMax: number,
): number[] {
	const margin = H - slack
	const sorted = [...items].sort(
		(a, b) => a.hz - a.widthHz / 2 - (b.hz - b.widthHz / 2),
	)
	let lowAll = Infinity
	let highAll = -Infinity
	for (const i of sorted) {
		lowAll = Math.min(lowAll, i.hz - i.widthHz / 2)
		highAll = Math.max(highAll, i.hz + i.widthHz / 2)
	}
	for (const s of spans) {
		lowAll = Math.min(lowAll, s.lo - s.widthHz / 2)
		highAll = Math.max(highAll, s.hi + s.widthHz / 2)
	}
	if (highAll - lowAll <= 2 * margin) return [(lowAll + highAll) / 2]
	const step = 2 * H - wMax - 2 * slack
	const covered = new Uint8Array(sorted.length)
	const out: number[] = []
	let ptr = 0
	let prev: number | null = null
	for (;;) {
		while (ptr < sorted.length && covered[ptr] === 1) ptr++
		let low = Infinity
		let high = -Infinity
		const first = sorted[ptr]
		if (first) {
			low = first.hz - first.widthHz / 2
			high = first.hz + first.widthHz / 2
		}
		for (const s of spans) {
			if (s.next > s.hi) continue
			const l = s.next - s.widthHz / 2
			if (l < low) {
				low = l
				high = s.next + s.widthHz / 2
			}
		}
		if (low === Infinity) break
		let hG = low + margin
		if (prev !== null) {
			const c = prev + step
			if (low >= c - margin - EPS && high <= c + margin + EPS) hG = c
		}
		out.push(hG)
		prev = hG
		const lo = hG - margin - EPS
		const hi = hG + margin + EPS
		for (let j = ptr; j < sorted.length; j++) {
			const x = sorted[j]
			if (!x) break
			const xl = x.hz - x.widthHz / 2
			if (xl > hi) break
			if (xl >= lo && x.hz + x.widthHz / 2 <= hi) covered[j] = 1
		}
		for (const s of spans) {
			if (s.next > s.hi) continue
			const upTo = hG + margin - s.widthHz / 2
			if (upTo < s.next) continue
			s.next = upTo >= s.hi ? Infinity : upTo
		}
	}
	return out
}

function lowerBound(items: PlanItem[], hz: number): number {
	let lo = 0
	let hi = items.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if ((items[mid]?.hz ?? Infinity) < hz) lo = mid + 1
		else hi = mid
	}
	return lo
}

function placeDc(
	greedyHz: number,
	slackHz: number,
	items: PlanItem[],
	mainRaster: Raster | null,
	tunerRange: FreqRange,
): number {
	const sorted = [...items].sort((a, b) => a.hz - b.hz)
	const maxEdge = sorted.reduce((m, i) => Math.max(m, i.edgeHalfHz), 0)
	const objective = (h: number): number => {
		let m = Infinity
		const at = lowerBound(sorted, h)
		for (let j = at; j < sorted.length; j++) {
			const i = sorted[j]
			if (!i || i.hz - h - maxEdge >= m) break
			m = Math.min(m, i.hz - h - i.edgeHalfHz)
		}
		for (let j = at - 1; j >= 0; j--) {
			const i = sorted[j]
			if (!i || h - i.hz - maxEdge >= m) break
			m = Math.min(m, h - i.hz - i.edgeHalfHz)
		}
		return m
	}
	const score = (h: number): number => (items.length > 0 ? objective(h) : 0)
	const isHalf = (h: number): boolean => {
		if (!mainRaster) return false
		const s = mainRaster.spacingHz
		return (((h - mainRaster.firstChannelHz) % s) + s) % s === s / 2
	}
	const prefer = (a: number, b: number): boolean => {
		const ha = isHalf(a)
		const hb = isHalf(b)
		if (ha !== hb) return ha
		const da = Math.abs(a - greedyHz)
		const db = Math.abs(b - greedyHz)
		if (da !== db) return da < db
		return a < b
	}
	const lo = Math.max(tunerRange.startHz, greedyHz - slackHz)
	const hi = Math.min(tunerRange.endHz, greedyHz + slackHz)
	const first = Math.ceil(lo / DC_GRID_HZ) * DC_GRID_HZ
	if (first > hi) return clamp(greedyHz, tunerRange)
	let best = first
	let bestScore = score(first)
	for (let h = first + DC_GRID_HZ; h <= hi; h += DC_GRID_HZ) {
		const v = score(h)
		if (
			v > bestScore + EPS ||
			(Math.abs(v - bestScore) <= EPS && prefer(h, best))
		) {
			best = h
			bestScore = v
		}
	}
	return best
}

function mergeRanges(ranges: FreqRange[]): FreqRange[] {
	const sorted = [...ranges].sort((a, b) => a.startHz - b.startHz)
	const out: FreqRange[] = []
	for (const r of sorted) {
		const last = out.at(-1)
		if (last && r.startHz <= last.endHz)
			last.endHz = Math.max(last.endHz, r.endHz)
		else out.push({ ...r })
	}
	return out
}

function hopAt(
	index: number,
	centreHz: number,
	items: PlanItem[],
	input: HopPlanInput,
	H: number,
	g: number,
): Hop {
	const m = input.ppmMargin * 1e-6 * centreHz
	let channelCount = 0
	let dcMinEdgeHz = H
	const dcAdjacentChannelsHz: number[] = []
	for (let j = lowerBound(items, centreHz - H); j < items.length; j++) {
		const i = items[j]
		if (!i || i.hz > centreHz + H) break
		const d = Math.abs(i.hz - centreHz)
		if (d + i.widthHz / 2 > H + EPS) continue
		channelCount++
		const edge = d - i.edgeHalfHz
		dcMinEdgeHz = Math.min(dcMinEdgeHz, edge)
		if (edge < g + m) dcAdjacentChannelsHz.push(i.hz)
	}
	const lo = centreHz - H
	const hi = centreHz + H
	const excluded = mergeRanges(
		input.exclusions
			.filter(x => x.endHz > lo && x.startHz < hi)
			.map(x => ({
				startHz: Math.max(x.startHz, lo),
				endHz: Math.min(x.endHz, hi),
			})),
	)
	return {
		index,
		centreHz,
		covered: { startHz: lo, endHz: hi },
		channelCount,
		dcAdjacentChannelsHz,
		excluded,
		dcMinEdgeHz,
	}
}

function geometry(input: HopPlanInput): { H: number; g: number } {
	return {
		H: (input.sampleRateHz * input.usableFraction) / 2,
		g: Math.max(input.dcGuardHz, 2 * input.rbwHz),
	}
}

function planHops(input: HopPlanInput): HopPlan {
	const { H, g } = geometry(input)
	const items = rasterItems(input.ranges, input.exclusions)
	const spans = freeSpans(input.ranges, input.exclusions)
	const rasters = rasterUnion(input.ranges)
	const main = rasters[0] ?? null
	const slack =
		items.length > 0
			? rasters.reduce((a, r) => Math.min(a, r.spacingHz), Infinity)
			: 0
	let wMax = 0
	for (const i of items) wMax = Math.max(wMax, i.widthHz)
	for (const s of spans) wMax = Math.max(wMax, s.widthHz)
	const finish = (hops: Hop[]): HopPlan => ({
		hops,
		usableHalfSpanHz: H,
		dcGuardHz: g,
		ppmMarginHz: hops.reduce(
			(a, h) => Math.max(a, input.ppmMargin * 1e-6 * h.centreHz),
			0,
		),
	})
	if ((items.length === 0 && spans.length === 0) || wMax >= 2 * (H - slack))
		return finish([])
	const hops = greedyCentres(items, spans, H, slack, wMax).map((hG, index) => {
		let centre = clamp(hG, input.tunerRange)
		if (slack > 0) {
			const from = lowerBound(items, hG - H - slack)
			const near: PlanItem[] = []
			for (let j = from; j < items.length; j++) {
				const i = items[j]
				if (!i || i.hz > hG + H + slack) break
				near.push(i)
			}
			if (near.length > 0)
				centre = placeDc(hG, slack, near, main, input.tunerRange)
		}
		return hopAt(index, centre, items, input, H, g)
	})
	return finish(hops)
}

// --- Plan preview (src/core/scanner/plan/plan-preview.ts) ---

type ScanRangeLive = Pick<
	ScanRange,
	"enabled" | "protocols" | "name" | "dwellMs" | "sensitivity"
> & { startHz?: number; endHz?: number; bandplanId?: string }

/** A job's stored spec: the operator's input plus the live range edits (SF1 `rangeLive`). */
type StoredSpec = ScanJobSpec & { rangeLive?: ScanRangeLive[] }

interface SourceView {
	id: string
	centreHz: number
	sampleRateHz: number
	controlMode: TunerState["controlMode"]
}

interface PreviewContext {
	source: SourceView
	settings: ScannerSettingsValues
	bandplans: readonly Bandplan[]
	lockouts: () => {
		discoveryId: string
		centreHz: number
		bandwidthHz: number
	}[]
	impact: (spec: NormalisedJobSpec, exceptJobId?: string) => Impact
}

const isRangeEnabled = (r: Pick<ScanRange, "enabled">) => r.enabled !== false

function copyRange(r: ScanRange): ScanRange {
	const out: ScanRange = { startHz: r.startHz, endHz: r.endHz }
	if (r.rasters !== undefined) out.rasters = r.rasters.map(x => ({ ...x }))
	if (r.obwHz !== undefined) out.obwHz = [...r.obwHz]
	if (r.protocols !== undefined) out.protocols = [...r.protocols]
	if (r.bandplanId !== undefined) out.bandplanId = r.bandplanId
	if (r.enabled !== undefined) out.enabled = r.enabled
	if (r.name !== undefined) out.name = r.name
	if (r.dwellMs !== undefined) out.dwellMs = r.dwellMs
	if (r.sensitivity !== undefined) out.sensitivity = r.sensitivity
	return out
}

function overlayRangeLive(
	ranges: ScanRange[],
	live: ScanRangeLive[] | undefined,
	issues: PlanIssue[],
): void {
	if (live !== undefined) {
		const dropped: number[] = []
		for (let i = 0; i < live.length; i++) {
			const range = ranges[i]
			const src = live[i]
			if (src === undefined) continue
			const legacy = src.startHz === undefined || src.endHz === undefined
			const matches =
				range !== undefined &&
				(legacy
					? live.length === ranges.length
					: src.startHz === range.startHz &&
						src.endHz === range.endHz &&
						src.bandplanId === range.bandplanId)
			if (!matches || range === undefined) {
				dropped.push(i)
				continue
			}
			delete range.enabled
			delete range.protocols
			delete range.name
			delete range.dwellMs
			delete range.sensitivity
			if (src.enabled !== undefined) range.enabled = src.enabled
			if (src.protocols !== undefined) range.protocols = [...src.protocols]
			if (src.name !== undefined) range.name = src.name
			if (src.dwellMs !== undefined) range.dwellMs = src.dwellMs
			if (src.sensitivity !== undefined) range.sensitivity = src.sensitivity
		}
		if (dropped.length > 0)
			issues.push(
				issue(
					"range-locked",
					"warning",
					"the job's ranges changed since their last edit; those edits no longer apply",
					{
						reason: "range-live-stale",
						dropped,
						expected: live.length,
						received: ranges.length,
					},
				),
			)
	}
	for (const range of ranges) if (range.enabled === true) delete range.enabled
}

function fullyExcluded(r: FreqRange, exclusions: readonly ScanExclusion[]) {
	let reach = r.startHz
	for (const x of [...exclusions].sort((a, b) => a.startHz - b.startHz)) {
		if (x.startHz > reach) break
		reach = Math.max(reach, x.endHz)
		if (reach >= r.endHz) return true
	}
	return false
}

/** The mock source is U8_IQ without a channelizer: offset probes, no rtl433 probe. */
function probeTransportFor(protocol: ScannerProtocol): {
	transport: "offset" | null
	reason?: "needs-channelizer" | "no-decoder"
} {
	const decoder = PROTOCOL_DECODER[protocol]
	if (decoder === null) return { transport: null, reason: "no-decoder" }
	if (decoder === "rtl433")
		return { transport: null, reason: "needs-channelizer" }
	return { transport: "offset" }
}

function decodableClasses(protocols: readonly ScannerProtocol[]) {
	const list = protocols.length > 0 ? protocols : ALL_PROTOCOLS
	const out = new Set<ScannerClass>()
	for (const p of list) {
		const cls = PROTOCOL_CLASS[p]
		if (cls === null || probeTransportFor(p).transport === null) continue
		out.add(cls)
	}
	return [...out]
}

function defaultFftSize(sampleRateHz: number): number {
	const n = 2 ** Math.round(Math.log2(sampleRateHz / 1000))
	return Math.min(16_384, Math.max(512, n))
}

function normaliseSpec(
	spec: StoredSpec,
	ctx: PreviewContext,
): { spec: NormalisedJobSpec; issues: PlanIssue[] } {
	const issues: PlanIssue[] = []
	const prov: NormalisedJobSpec["provenance"] = {}
	const pv = (
		key: string,
		operator: boolean,
		fallback: NormalisedJobSpec["provenance"][string] = "default",
	) => {
		prov[key] = operator ? "operator" : fallback
	}
	const s = ctx.settings
	const source = ctx.source
	if (spec.sourceId !== undefined && spec.sourceId !== source.id)
		throw new CoreError(
			`unknown scanner source ${spec.sourceId}`,
			"SCANNER_SOURCE_NOT_FOUND",
		)
	pv("sourceId", spec.sourceId !== undefined)

	const ranges: ScanRange[] = []
	let inherited = false
	const hosts = ctx.bandplans
		.flatMap(p => p.ranges)
		.sort((a, b) => a.endHz - a.startHz - (b.endHz - b.startHz))
	for (const r of spec.ranges ?? []) {
		const own = copyRange(r)
		const host =
			r.rasters === undefined && r.bandplanId === undefined
				? hosts.find(h => h.startHz <= r.startHz && h.endHz >= r.endHz)
				: undefined
		if (host) {
			inherited = true
			if (host.rasters !== undefined)
				own.rasters = host.rasters.map(x => ({ ...x }))
			if (own.obwHz === undefined && host.obwHz !== undefined)
				own.obwHz = [...host.obwHz]
			if (own.protocols === undefined && host.protocols !== undefined)
				own.protocols = [...host.protocols]
			if (own.bandplanId === undefined && host.bandplanId !== undefined)
				own.bandplanId = host.bandplanId
		}
		ranges.push(own)
	}
	for (const id of spec.bandplans ?? []) {
		const bp = ctx.bandplans.find(p => p.id === id)
		if (!bp) {
			issues.push(
				issue(
					"range-empty",
					"error",
					`bandplan ${id} is not available in region EU`,
					{ bandplan: id },
				),
			)
			continue
		}
		for (const r of bp.ranges) ranges.push(copyRange(r))
	}
	overlayRangeLive(ranges, spec.rangeLive, issues)
	const enabled = ranges.filter(isRangeEnabled)
	const operatorRanges = (spec.ranges ?? []).length > 0
	const planRanges = (spec.bandplans ?? []).length > 0
	prov["ranges"] = operatorRanges
		? "operator"
		: planRanges
			? "bandplan"
			: "default"
	prov["ranges.rasters"] =
		inherited || planRanges
			? "bandplan"
			: operatorRanges
				? "operator"
				: "default"
	const exclusions: ScanExclusion[] = (spec.exclusions ?? []).map(x => ({
		...x,
	}))
	pv("exclusions", spec.exclusions !== undefined)

	const tuner = TUNER_RANGE
	for (const r of ranges) {
		const range = { startHz: r.startHz, endHz: r.endHz }
		if (!(r.startHz > 0) || !(r.endHz > r.startHz))
			issues.push(
				issue(
					"range-empty",
					"error",
					`range ${r.startHz}–${r.endHz} Hz is empty or inverted`,
					{ range },
				),
			)
		else if (r.startHz < tuner.startHz || r.endHz > tuner.endHz)
			issues.push(
				issue(
					"range-outside-tuner",
					"error",
					`range ${r.startHz}–${r.endHz} Hz is outside the tuner's ${tuner.startHz}–${tuner.endHz} Hz`,
					{ range, tuner },
				),
			)
	}
	if (enabled.length > 0 && enabled.every(r => fullyExcluded(r, exclusions)))
		issues.push(
			issue("all-excluded", "error", "the exclusions cover every range"),
		)

	const windowHalf = (source.sampleRateHz * USABLE_FRACTION) / 2
	const centre = source.centreHz
	const fits = enabled.every(
		r => r.startHz >= centre - windowHalf && r.endHz <= centre + windowHalf,
	)
	const requested = spec.mode ?? "auto"
	const mode: ScanMode =
		requested === "auto" ? (fits ? "in-window" : "sweep") : requested
	pv("mode", requested !== "auto")
	if (mode === "in-window" && !fits)
		issues.push(
			issue(
				"not-in-window",
				"error",
				"in-window mode needs every range inside the source's current usable span",
				{ centreHz: centre, halfSpanHz: windowHalf },
			),
		)
	if (ranges.length > 0 && enabled.length === 0)
		issues.push(
			issue("range-empty", "error", "every range is disabled", {
				disabled: ranges.length,
			}),
		)
	if (mode === "sweep") {
		if (ranges.length === 0)
			issues.push(
				issue(
					"range-empty",
					"error",
					"a sweep needs at least one range or bandplan",
				),
			)
		if (source.controlMode === "external")
			issues.push(
				issue(
					"source-busy",
					"error",
					`source ${source.id} is under external (relay) control`,
				),
			)
	}

	const fs =
		mode === "sweep"
			? (spec.tuner?.sampleRateHz ?? source.sampleRateHz)
			: source.sampleRateHz
	const sensitivity = spec.sensitivity ?? s.detection.sensitivity
	pv("sensitivity", spec.sensitivity !== undefined)
	const fftSize =
		spec.fftSize ??
		(s.detection.fftSize === "auto" ? defaultFftSize(fs) : s.detection.fftSize)
	pv(
		"fftSize",
		spec.fftSize !== undefined,
		s.detection.fftSize === "auto" ? "default" : "config",
	)
	const integrationMs =
		spec.integrationMs ??
		(sensitivity === "high" ? 100 : s.detection.integrationMs)
	pv("integrationMs", spec.integrationMs !== undefined)
	const thresholdDb = spec.thresholdDb ?? null
	pv("thresholdDb", spec.thresholdDb !== undefined)
	const rbw = fs / fftSize
	const obwClasses = enabled.flatMap(r => r.obwHz ?? []).filter(o => o > 0)
	const typicalObw =
		obwClasses.length > 0 ? Math.min(...obwClasses) : TYPICAL_OBW_HZ
	if (rbw > typicalObw / 4)
		issues.push(
			issue(
				"rbw-coarse",
				"warning",
				`RBW ${rbw.toFixed(0)} Hz is above a quarter of the ${typicalObw} Hz OBW`,
				{ rbwHz: rbw, obwHz: typicalObw },
			),
		)
	if (rbw < RBW_FINE_HZ)
		issues.push(
			issue(
				"rbw-fine",
				"warning",
				`RBW ${rbw.toFixed(0)} Hz is below ${RBW_FINE_HZ} Hz`,
				{
					rbwHz: rbw,
				},
			),
		)
	const half = (fs * USABLE_FRACTION) / 2
	const spacings = enabled.flatMap(r => (r.rasters ?? []).map(x => x.spacingHz))
	const slack = spacings.length > 0 ? Math.min(...spacings) : 0
	const widest = Math.max(0, ...spacings, ...obwClasses)
	if (widest >= 2 * (half - slack) || widest > 2 * half)
		issues.push(
			issue(
				"channel-too-wide",
				"error",
				`a ${widest} Hz channel does not fit the ${2 * half} Hz usable span`,
				{ widthHz: widest, usableSpanHz: 2 * half },
			),
		)

	// Settle: the mock rtl_tcp supports settle markers (measured), so no timer warnings.
	let settleMs: number
	if (mode === "in-window") {
		settleMs = spec.settleMs ?? 0
		pv("settleMs", spec.settleMs !== undefined)
	} else {
		settleMs = spec.settleMs ?? MARKER_RUN_ASSUMED_MS + s.sweep.pllSettleMs
		pv("settleMs", spec.settleMs !== undefined)
	}
	const minimumDwell =
		settleMs + (s.detection.minSurfaceBlocks + 1) * integrationMs
	const dwellMs = spec.dwellMs ?? minimumDwell
	pv("dwellMs", spec.dwellMs !== undefined)
	if (mode === "sweep" && dwellMs < minimumDwell)
		issues.push(
			issue(
				"dwell-too-short",
				"error",
				`dwell ${dwellMs} ms is below settle + ${s.detection.minSurfaceBlocks + 1} blocks (${minimumDwell} ms)`,
				{ minimumMs: minimumDwell },
			),
		)
	if (mode === "sweep")
		ranges.forEach((range, i) => {
			if (
				!isRangeEnabled(range) ||
				range.dwellMs === undefined ||
				range.dwellMs >= minimumDwell
			)
				return
			issues.push(
				issue(
					"dwell-too-short",
					"error",
					`range ${i} dwell ${range.dwellMs} ms is below settle + ${s.detection.minSurfaceBlocks + 1} blocks (${minimumDwell} ms)`,
					{ minimumMs: minimumDwell, rangeIndex: i },
				),
			)
		})

	const fromPlans = [...new Set(enabled.flatMap(r => r.protocols ?? []))]
	const protocols =
		spec.protocols !== undefined ? [...spec.protocols] : fromPlans
	prov["protocols"] =
		spec.protocols !== undefined
			? "operator"
			: fromPlans.length > 0
				? "bandplan"
				: "default"
	const policy = spec.hold?.policy ?? "hold"
	pv("hold.policy", spec.hold?.policy !== undefined)
	const confirmHoldMs: Partial<Record<ScannerClass, number>> = {}
	for (const c of ALL_CLASSES)
		confirmHoldMs[c] = spec.hold?.confirmHoldMs ?? DEFAULT_CONFIRM_HOLD_MS[c]
	pv("hold.confirmHoldMs", spec.hold?.confirmHoldMs !== undefined)
	const maxHoldMs = spec.hold?.maxHoldMs ?? s.hold.maxHoldMs
	pv("hold.maxHoldMs", spec.hold?.maxHoldMs !== undefined)
	const hangMs = spec.hold?.hangMs ?? s.hold.hangMs
	pv("hold.hangMs", spec.hold?.hangMs !== undefined)
	const neededHold = decodableClasses(protocols).reduce(
		(m, c) => Math.max(m, confirmHoldMs[c] ?? 0),
		0,
	)
	if (policy !== "never" && maxHoldMs < neededHold)
		issues.push(
			issue(
				"hold-inconsistent",
				"error",
				`maxHoldMs ${maxHoldMs} is below confirmHoldMs ${neededHold}`,
				{ maxHoldMs, confirmHoldMs: neededHold },
			),
		)
	const unavailable: Record<string, string> = {}
	let needsProbe = 0
	let withTransport = 0
	for (const p of spec.protocols ?? []) {
		const t = probeTransportFor(p)
		if (t.reason === "no-decoder") continue
		needsProbe++
		if (t.transport !== null) withTransport++
		else unavailable[p] = t.reason ?? "unsupported-format"
	}
	if (
		needsProbe > 0 &&
		withTransport === 0 &&
		needsProbe === (spec.protocols ?? []).length
	)
		issues.push(
			issue(
				"no-probe-transport",
				"error",
				`no requested protocol can be confirmed on ${source.id}`,
				{ protocols: unavailable },
			),
		)
	else if (Object.keys(unavailable).length > 0)
		issues.push(
			issue(
				"probe-unavailable",
				"warning",
				"some requested protocols have no probe transport",
				{ protocols: unavailable },
			),
		)

	pv("revisit.share", spec.revisit?.share !== undefined)
	pv("revisit.maxIntervalMs", spec.revisit?.maxIntervalMs !== undefined)
	pv("priority", spec.priority !== undefined)
	pv("resume.autoAfterIdleMs", spec.resume?.autoAfterIdleMs !== undefined)
	pv("txDurationHintMs", spec.txDurationHintMs !== undefined)
	pv("kind", spec.kind !== undefined)
	pv("capture", spec.capture !== undefined)
	ranges.forEach((range, i) => {
		if (range.name !== undefined) prov[`ranges[${i}].name`] = "operator"
		if (range.dwellMs !== undefined) prov[`ranges[${i}].dwellMs`] = "operator"
		if (range.sensitivity !== undefined)
			prov[`ranges[${i}].sensitivity`] = "operator"
	})
	const kind = spec.kind ?? "discover"
	if (spec.signalsOnly !== undefined) prov["signalsOnly"] = "operator"
	if (spec.skipDecodedElsewhere !== undefined)
		prov["skipDecodedElsewhere"] = "operator"
	if (spec.skipBandPlanSkips !== undefined)
		prov["skipBandPlanSkips"] = "operator"
	if (kind === "monitor" && spec.signalsOnly === true)
		issues.push(
			issue("signals-only-unsupported", "error", "monitor jobs need decoders"),
		)

	const c = spec.capture
	const n: NormalisedJobSpec = {
		sourceId: source.id,
		sensitivity,
		priority: spec.priority ?? DEFAULT_PRIORITY,
		mode,
		kind,
		ranges,
		exclusions,
		protocols,
		fftSize,
		integrationMs,
		thresholdDb,
		dwellMs,
		settleMs,
		hold: { policy, confirmHoldMs, maxHoldMs, hangMs },
		revisit: {
			share: spec.revisit?.share ?? s.sweep.revisitShare,
			maxIntervalMs: spec.revisit?.maxIntervalMs ?? null,
		},
		record: {
			voice: spec.record?.voice ?? true,
			analog: spec.record?.analog ?? true,
			data: spec.record?.data ?? true,
		},
		evidence: {
			psd: spec.evidence?.psd ?? true,
			iq: spec.evidence?.iq ?? false,
		},
		tuner: {
			sampleRateHz: spec.tuner?.sampleRateHz ?? null,
			gainTenthsDb: spec.tuner?.gainTenthsDb ?? null,
			agc: spec.tuner?.agc ?? null,
			overload: spec.tuner?.overload ?? "flag",
		},
		stop: {
			afterSweeps: spec.stop?.afterSweeps ?? null,
			afterMs: spec.stop?.afterMs ?? null,
			onFirstDecoded: spec.stop?.onFirstDecoded ?? false,
		},
		takeover: spec.takeover ?? false,
		resume: {
			autoAfterIdleMs:
				spec.resume?.autoAfterIdleMs === undefined
					? DEFAULT_AUTO_RESUME_MS
					: spec.resume.autoAfterIdleMs,
			onBoot: spec.resume?.onBoot ?? false,
		},
		txDurationHintMs: spec.txDurationHintMs ?? DEFAULT_TX_HINT_MS,
		capture: {
			enabled: c?.enabled ?? false,
			mode: c?.mode ?? "wideband",
			preMs: c?.preMs ?? 1000,
			postMs: c?.postMs ?? 500,
			onlyDecoded: c?.onlyDecoded ?? true,
			maxPerHour: c?.maxPerHour ?? 6,
		},
		provenance: prov,
	}
	if (spec.signalsOnly !== undefined) n.signalsOnly = spec.signalsOnly
	if (spec.skipDecodedElsewhere !== undefined)
		n.skipDecodedElsewhere = spec.skipDecodedElsewhere
	if (spec.skipBandPlanSkips !== undefined)
		n.skipBandPlanSkips = spec.skipBandPlanSkips
	return { spec: n, issues }
}

function hopInput(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
	extra: readonly ScanExclusion[] = [],
): HopPlanInput {
	const fs =
		spec.mode === "sweep"
			? (spec.tuner.sampleRateHz ?? ctx.source.sampleRateHz)
			: ctx.source.sampleRateHz
	return {
		ranges: spec.ranges.filter(isRangeEnabled),
		exclusions:
			extra.length === 0 ? spec.exclusions : [...spec.exclusions, ...extra],
		sampleRateHz: fs,
		usableFraction: USABLE_FRACTION,
		rbwHz: fs / spec.fftSize,
		dcGuardHz: ctx.settings.detection.dcGuardHz,
		ppmMargin: ctx.settings.detection.ppmMargin,
		tunerRange: TUNER_RANGE,
	}
}

/** In-window jobs describe one hop at the source's current centre. */
function inWindowPlan(spec: NormalisedJobSpec, ctx: PreviewContext): HopPlan {
	const input = hopInput(spec, ctx)
	const { H, g } = geometry(input)
	const centre = ctx.source.centreHz
	return {
		hops: [
			hopAt(
				0,
				centre,
				rasterItems(input.ranges, input.exclusions),
				input,
				H,
				g,
			),
		],
		usableHalfSpanHz: H,
		dcGuardHz: g,
		ppmMarginHz: input.ppmMargin * 1e-6 * centre,
	}
}

function withHopDwell(plan: HopPlan, spec: NormalisedJobSpec): HopPlan {
	const ranges = spec.ranges.filter(isRangeEnabled)
	if (!ranges.some(r => r.dwellMs !== undefined)) return plan
	let changed = false
	const hops = plan.hops.map(hop => {
		const overlapping = ranges.filter(
			r => r.endHz >= hop.covered.startHz && r.startHz <= hop.covered.endHz,
		)
		if (!overlapping.some(r => r.dwellMs !== undefined)) return hop
		changed = true
		return {
			...hop,
			dwellMs: Math.max(...overlapping.map(r => r.dwellMs ?? spec.dwellMs)),
		}
	})
	return changed ? { ...plan, hops } : plan
}

function planForSpec(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
	extra: readonly ScanExclusion[] = [],
): HopPlan {
	if (spec.mode !== "sweep") return inWindowPlan(spec, ctx)
	return withHopDwell(planHops(hopInput(spec, ctx, extra)), spec)
}

/** src/core/scanner/plan/lockouts.ts lockoutExclusionsFor. */
function lockoutExclusionsFor(
	targets: readonly {
		discoveryId: string
		centreHz: number
		bandwidthHz: number
	}[],
	enabledRanges: readonly ScanRange[],
): LockoutExclusion[] {
	const out: LockoutExclusion[] = []
	for (const t of targets) {
		const c = t.centreHz
		const holding = enabledRanges.filter(r => c >= r.startHz && c <= r.endHz)
		if (holding.length === 0) continue
		let step = Infinity
		for (const r of holding)
			for (const raster of r.rasters ?? [])
				if (raster.spacingHz > 0) step = Math.min(step, raster.spacingHz)
		const w = Math.max(
			Math.max(0, t.bandwidthHz),
			Number.isFinite(step) ? step : 0,
			LOCKOUT_MIN_WIDTH_HZ,
		)
		const lo = Math.floor(c - w / 2)
		const hi = Math.ceil(c + w / 2)
		let minStart = Infinity
		let maxEnd = -Infinity
		for (const r of enabledRanges) {
			if (r.endHz < lo || r.startHz > hi) continue
			minStart = Math.min(minStart, r.startHz)
			maxEnd = Math.max(maxEnd, r.endHz)
		}
		out.push({
			discoveryId: t.discoveryId,
			startHz: Math.max(lo, minStart),
			endHz: Math.min(hi, maxEnd),
			applied: true,
		})
	}
	out.sort(
		(a, b) =>
			a.startHz - b.startHz ||
			a.endHz - b.endHz ||
			(a.discoveryId < b.discoveryId
				? -1
				: a.discoveryId > b.discoveryId
					? 1
					: 0),
	)
	out.forEach((x, i) => {
		if (i >= LOCKOUT_EXCLUSIONS_MAX) x.applied = false
	})
	return out
}

/** planJob without the decoded-elsewhere and band-plan skip layers (not mocked). */
function planJob(
	spec: NormalisedJobSpec,
	ctx: PreviewContext,
): { plan: HopPlan; lockoutExclusions?: LockoutExclusion[] } {
	const targets = spec.mode === "sweep" ? ctx.lockouts() : []
	const candidates =
		targets.length === 0
			? []
			: lockoutExclusionsFor(targets, spec.ranges.filter(isRangeEnabled))
	if (candidates.length === 0) return { plan: planForSpec(spec, ctx) }
	const applied = candidates
		.filter(x => x.applied)
		.map(x => ({ startHz: x.startHz, endHz: x.endHz }))
	const locked = planForSpec(spec, ctx, applied)
	if (locked.hops.length > 0)
		return { plan: locked, lockoutExclusions: candidates }
	const base = planForSpec(spec, ctx)
	if (base.hops.length === 0)
		return { plan: locked, lockoutExclusions: candidates }
	return {
		plan: base,
		lockoutExclusions: candidates.map(x => ({ ...x, applied: false })),
	}
}

function protocolsForHop(spec: NormalisedJobSpec, hop: Hop): ScannerProtocol[] {
	if (spec.provenance["protocols"] === "operator") return [...spec.protocols]
	return [
		...new Set(
			spec.ranges
				.filter(
					r =>
						isRangeEnabled(r) &&
						r.endHz >= hop.covered.startHz &&
						r.startHz <= hop.covered.endHz,
				)
				.flatMap(r => r.protocols ?? []),
		),
	]
}

function sweepPeriod(hops: readonly Hop[], dwellMs: number, share: number) {
	const count = hops.length
	const every = share > 0 ? Math.max(1, Math.round(1 / share)) : Infinity
	const revisits = Number.isFinite(every) ? Math.floor(count / every) : 0
	if (count === 0 || hops.every(hop => hop.dwellMs === undefined))
		return (count + revisits) * dwellMs
	let sum = 0
	for (const hop of hops) sum += hop.dwellMs ?? dwellMs
	return sum + revisits * (sum / count)
}

function poiFor(
	hop: Hop,
	n: NormalisedJobSpec,
	periodMs: number | null,
): PlanPreview["poi"][number] {
	const T = n.integrationMs
	const D = n.txDurationHintMs
	const classes = decodableClasses(protocolsForHop(n, hop))
	const confirm =
		classes.length > 0
			? classes.reduce(
					(m, c) =>
						Math.max(m, n.hold.confirmHoldMs[c] ?? DEFAULT_CONFIRM_HOLD_MS[c]),
					0,
				)
			: null
	if (periodMs === null)
		return {
			hopIndex: hop.index,
			detection: D >= 2 * T ? 1 : 0,
			decode: confirm !== null && D >= confirm ? 1 : 0,
		}
	const d = (hop.dwellMs ?? n.dwellMs) - n.settleMs
	return {
		hopIndex: hop.index,
		detection: Math.min(1, Math.max(0, D + d - 2 * T) / periodMs),
		decode:
			confirm === null
				? 0
				: Math.min(1, Math.max(0, D - confirm + d) / periodMs),
	}
}

function estimate(
	n: NormalisedJobSpec,
	s: ScannerSettingsValues,
): PlanPreview["estimates"] {
	const candidates = n.protocols.length > 0 ? n.protocols : ALL_PROTOCOLS
	const decoders = new Set<DecoderType>()
	for (const p of candidates) {
		const decoder = PROTOCOL_DECODER[p]
		if (decoder !== null && probeTransportFor(p).transport !== null)
			decoders.add(decoder)
	}
	if (decoders.size === 0)
		return { cpuCores: CPU_ENGINE, diskMbPerHour: 0, probes: 0 }
	const probes = s.maxProbes.offset
	const voice =
		n.record.voice && decoders.has("dsd-fme")
			? probes * VOICE_WAV_MB_PER_HOUR
			: 0
	const iq = n.evidence.iq
		? probes * CONFIRMS_PER_PROBE_HOUR * IQ_SNIPPET_MB
		: 0
	return {
		cpuCores:
			Math.round((CPU_ENGINE + probes * CPU_OFFSET_PROBE) * 1000) / 1000,
		diskMbPerHour: Math.round((voice + iq) * 10) / 10,
		probes,
	}
}

const PLAN_EMPTY_CAUSES = new Set<PlanIssueCode>([
	"range-empty",
	"range-outside-tuner",
	"all-excluded",
	"channel-too-wide",
])

const emptyImpact = (): Impact => ({
	liveAudioClients: 0,
	digitalVoiceListeners: 0,
	runningDecoders: [],
	pinnedDecoders: [],
	scannerJobs: [],
	unrestorable: [],
})

function previewPlan(spec: StoredSpec, ctx: PreviewContext): PlanPreview {
	const { spec: n, issues } = normaliseSpec(spec, ctx)
	const { plan, lockoutExclusions } = planJob(n, ctx)
	const s = ctx.settings
	if (
		n.mode === "sweep" &&
		plan.hops.length === 0 &&
		!issues.some(i => PLAN_EMPTY_CAUSES.has(i.code))
	)
		issues.push(
			issue(
				"plan-empty",
				"error",
				"the sweep plan has no hops: no channel or free span is left to scan",
			),
		)
	const adjacent = plan.hops.filter(h => h.dcAdjacentChannelsHz.length > 0)
	if (adjacent.length > 0)
		issues.push(
			issue(
				"dc-adjacent-channels",
				"warning",
				`${adjacent.length} hop(s) have channels within g + m of DC`,
				{
					hops: adjacent.map(h => ({
						index: h.index,
						channelsHz: h.dcAdjacentChannelsHz,
					})),
				},
			),
		)
	const sweepPeriodMs =
		n.mode === "sweep" && plan.hops.length > 1
			? sweepPeriod(plan.hops, n.dwellMs, n.revisit.share)
			: null
	const poi = plan.hops.map(h => poiFor(h, n, sweepPeriodMs))
	const low = poi.filter(p => p.detection < POI_LOW)
	if (low.length > 0)
		issues.push(
			issue(
				"poi-low",
				"warning",
				`detection POI below ${POI_LOW * 100} % for a ${n.txDurationHintMs} ms transmission`,
				{
					hops: low.map(p => p.hopIndex),
					txDurationHintMs: n.txDurationHintMs,
				},
			),
		)
	const estimates = estimate(n, s)
	if (estimates.cpuCores > s.cpuBudgetCores)
		issues.push(
			issue(
				"budget-cpu",
				"warning",
				`estimated ${estimates.cpuCores} cores exceeds the ${s.cpuBudgetCores} core budget`,
				{ cpuCores: estimates.cpuCores },
			),
		)
	if (estimates.diskMbPerHour * DISK_BUDGET_HOURS > s.storage.maxRecordingsMb)
		issues.push(
			issue(
				"budget-disk",
				"warning",
				`${estimates.diskMbPerHour} MB/h fills the ${s.storage.maxRecordingsMb} MB recordings cap in under ${DISK_BUDGET_HOURS} h`,
				{ diskMbPerHour: estimates.diskMbPerHour },
			),
		)
	const impact = n.mode === "sweep" ? ctx.impact(n) : emptyImpact()
	if (impact.unrestorable.length > 0)
		issues.push(
			issue(
				"unrestorable",
				"warning",
				`pre-job value unknown for: ${impact.unrestorable.join(", ")}`,
				{ fields: impact.unrestorable },
			),
		)
	return {
		spec: n,
		plan,
		sweepPeriodMs,
		poi,
		estimates,
		impact,
		issues,
		...(lockoutExclusions ? { lockoutExclusions } : {}),
	}
}

/** Wire shorthands (§ 5.1) → core types, as the route's fromSpecBody. */
type RangeBody = ScanRange & { spacingHz?: number; firstChannelHz?: number }
interface ExclusionBody {
	startHz?: number
	endHz?: number
	frequencyHz?: number
	widthHz?: number
	reason?: string
}
type SpecBody = Omit<ScanJobSpec, "ranges" | "exclusions"> & {
	ranges?: RangeBody[]
	exclusions?: ExclusionBody[]
}

function fromSpecBody({ ranges, exclusions, ...rest }: SpecBody): ScanJobSpec {
	const toRange = ({
		spacingHz,
		firstChannelHz,
		...r
	}: RangeBody): ScanRange =>
		spacingHz === undefined
			? r
			: {
					...r,
					rasters: [
						{
							spacingHz,
							firstChannelHz: firstChannelHz ?? r.startHz + spacingHz / 2,
						},
					],
				}
	const toExclusion = (x: ExclusionBody): ScanExclusion => {
		const reason = x.reason !== undefined ? { reason: x.reason } : {}
		if (x.startHz !== undefined && x.endHz !== undefined)
			return { startHz: x.startHz, endHz: x.endHz, ...reason }
		const centre = x.frequencyHz ?? 0
		const half = (x.widthHz ?? 0) / 2
		return { startHz: centre - half, endHz: centre + half, ...reason }
	}
	return {
		...rest,
		...(ranges !== undefined ? { ranges: ranges.map(toRange) } : {}),
		...(exclusions !== undefined
			? { exclusions: exclusions.map(toExclusion) }
			: {}),
	}
}

/** src/core/scanner/plan/range-edits.ts applyRangePatch. */
function applyRangePatch(
	current: ScanRange[],
	patch: ScanRange[],
): { rangeLive: ScanRangeLive[]; issues: PlanIssue[] } {
	if (patch.length !== current.length)
		return {
			rangeLive: [],
			issues: [
				issue(
					"range-locked",
					"error",
					"a running job's ranges cannot be added or removed",
					{
						reason: "range-count",
						expected: current.length,
						received: patch.length,
					},
				),
			],
		}
	const same = (a: unknown, b: unknown) =>
		JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
	const issues: PlanIssue[] = []
	current.forEach((left, i) => {
		const right = patch[i]
		const fields =
			right === undefined
				? ["startHz", "endHz", "rasters", "obwHz", "bandplanId"]
				: (
						[
							["startHz", left.startHz === right.startHz],
							["endHz", left.endHz === right.endHz],
							["rasters", same(left.rasters, right.rasters)],
							["obwHz", same(left.obwHz, right.obwHz)],
							["bandplanId", left.bandplanId === right.bandplanId],
						] as const
					)
						.filter(([, equal]) => !equal)
						.map(([f]) => f)
		if (fields.length > 0)
			issues.push(
				issue(
					"range-locked",
					"error",
					`range ${i}: ${fields.join(", ")} cannot change while the job exists; stop it to change edges or channel spacing`,
					{ index: i, fields },
				),
			)
	})
	if (issues.length > 0) return { rangeLive: [], issues }
	return {
		rangeLive: patch.map((r, i) => {
			const live: ScanRangeLive = {}
			if (r.enabled !== undefined) live.enabled = r.enabled
			if (r.protocols !== undefined) live.protocols = [...r.protocols]
			if (r.name !== undefined) live.name = r.name
			if (r.dwellMs !== undefined) live.dwellMs = r.dwellMs
			if (r.sensitivity !== undefined) live.sensitivity = r.sensitivity
			const id = current[i]
			if (id) {
				live.startHz = id.startHz
				live.endHz = id.endHz
				if (id.bandplanId !== undefined) live.bandplanId = id.bandplanId
			}
			return live
		}),
		issues: [],
	}
}

function rejectErrors(issues: PlanIssue[]): void {
	const errors = issues.filter(i => i.severity === "error")
	if (errors.length === 0) return
	const busy = errors.find(i => i.code === "source-busy")
	if (busy)
		throw new ScannerApiError(busy.message, "SCANNER_SOURCE_BUSY", 409, {
			reason: "relay",
			issues,
		})
	throw new ScannerApiError(
		"The job spec has errors",
		"SCANNER_PLAN_INVALID",
		400,
		{
			issues,
		},
	)
}

// --- The mock ---

/** POST /api/scanner/discoveries/:id/listen answer (src/core/scanner/listen.ts ListenResult). */
export interface ScannerListenResult {
	mode: "live-audio" | "monitor"
	sourceId: string
	frequencyHz: number
	offsetHz?: number
	jobId?: string
	httpUrl: string
	wavUrl: string
}

export interface ScannerMockContext {
	sourceId: string
	tuner: TunerState
	broadcast: (channel: string, type: string, data: unknown) => void
	/** Tunes the mock receiver as the scanner (origin `scanner`): never an operator write. */
	retune: (hz: number) => void
	decoders: () => DecoderInfo[]
	liveStatus: () => LiveAudioStatus
	/** Retargets live audio to `offsetHz` in the current window and starts it. */
	liveListen: (offsetHz: number) => void
	/** Seeds the band inspection UX fixtures too (./band-fixtures.ts). */
	bandFixtures?: boolean
	/** Seeds the retune sweep scenario's discoveries too (./retune-sweep.ts). */
	retuneSweep?: boolean
	/** Starts with the engine's front-end overload hint shown (WAVEKIT_MOCK_OVERLOAD_HINT=1). */
	overloadHint?: boolean
}

export interface ScannerMock {
	/** Identify jobs (POST /api/scanner/identify lives in server.ts); listed with the others. */
	identifyJobs: Map<string, ScanJob>
	/** An operator REST tuner write: a running sweep pauses (`preempted-operator`). */
	operatorWrite(): void
	/** The sweep job holding the source's tuner, if any (identify refuses then). */
	sweepHolder(): string | null
	/**
	 * Shows the engine's `overloadHint` (`blankedPercent`, at the tuner's current manual gain; absent
	 * in AGC, as on the core) or hides it (null), then sends `scanner:status`.
	 */
	overloadHint(blankedPercent: number | null): void
	/** An identify result: creates or updates the discovery and sets its ids on the result. */
	identified(jobId: string, result: ScannerIdentifyResult): void
}

interface JobRec {
	id: string
	name: string | null
	passive: boolean
	raw: StoredSpec
	spec: NormalisedJobSpec
	plan: HopPlan
	issues: PlanIssue[]
	sweepPeriodMs: number | null
	lockoutExclusions?: LockoutExclusion[]
	impact: Impact | null
	consentedImpact: Impact | null
	state: JobState
	reason?: PauseReason | FailReason
	preemptedBy?: { jobId: string; name: string | null }
	resumeAt: number | null
	createdAt: number
	updatedAt: number
	startedAt?: number
	endedAt?: number
	lease: boolean
	snapshotHz: number | null
	hopIndex: number
	sweepIndex: number
	visited: Set<number>
	/** The held track (a tracker id like the core's scheduler, never a discovery id). */
	holdingOn: string | null
	/** The held signal's frequency, while holding. */
	heldHz: number | null
	counts: { observations: number; transients: number }
	timer: ReturnType<typeof setTimeout> | null
	/** Observations open on the current hop (closed when the hop or hold ends). */
	open: {
		observationId: string
		discoveryId: string
		hz: number
		peak: number
		at: number
	}[]
}

interface DiscoveryRec {
	d: Discovery
	observations: Observation[]
}

interface HitBook {
	hits: Map<string, ScanJobHit>
	total: number
	newDiscoveries: number
}

const iso = (ms: number) => new Date(ms).toISOString()
const emptyMetadata = (): DiscoveryMetadata => ({
	talkgroups: [],
	sources: [],
	slots: [],
	callsigns: [],
	capcodes: [],
	ismModels: [],
})
const isTerminal = (s: JobState) =>
	s === "completed" || s === "cancelled" || s === "failed"
const isActive = (s: JobState) => s === "running" || s === "holding"
const round1 = (x: number) => Math.round(x * 10) / 10

export function registerScannerMock(
	app: FastifyInstance,
	ctx: ScannerMockContext,
): ScannerMock {
	const { tuner, sourceId } = ctx
	let settings = defaultSettings()
	let overrides: z.infer<typeof SettingsPatchSchema> = {}
	const provenance: Record<string, ScannerSettingProvenance> = {}
	for (const [path] of leaves(settings)) provenance[path] = "default"
	provenance[`passiveBySource.${sourceId}`] = "default"

	const records = new Map<string, JobRec>()
	const identifyJobs = new Map<string, ScanJob>()
	const discoveries = new Map<string, DiscoveryRec>()
	const books = new Map<string, HitBook>()
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let idCounter = 0
	let observationSeq = 0
	let overloadBlanked: number | null = ctx.overloadHint ? 7.5 : null

	const newId = (prefix: string) => {
		idCounter += 1
		return `${prefix}_${Date.now().toString(36).toUpperCase()}${idCounter.toString(36).toUpperCase().padStart(4, "0")}`
	}
	const later = (ms: number, fn: () => void) => {
		const t = setTimeout(() => {
			timers.delete(t)
			fn()
		}, ms)
		timers.add(t)
		return t
	}
	const cancelTimer = (t: ReturnType<typeof setTimeout> | null) => {
		if (!t) return
		clearTimeout(t)
		timers.delete(t)
	}

	// --- WS limiter (WsLimiter: latest per key, progress 2 Hz, the rest 1 s) ---

	const lastSent = new Map<string, number>()
	const pending = new Map<string, { type: string; data: unknown }>()
	const offer = (
		key: string,
		type: string,
		data: unknown,
		intervalMs = 1000,
	) => {
		const queued = pending.get(key)
		if (queued) {
			queued.type = type
			queued.data = data
			return
		}
		const now = Date.now()
		const last = lastSent.get(key)
		if (last === undefined || now - last >= intervalMs) {
			lastSent.set(key, now)
			if (lastSent.size > 5000) {
				for (const [k, at] of lastSent)
					if (now - at > 10_000) lastSent.delete(k)
			}
			ctx.broadcast("scanner", type, data)
			return
		}
		const entry = { type, data }
		pending.set(key, entry)
		later(last + intervalMs - now, () => {
			pending.delete(key)
			lastSent.set(key, Date.now())
			ctx.broadcast("scanner", entry.type, entry.data)
		})
	}

	// --- Views ---

	const decodersOnSource = () =>
		ctx.decoders().filter(d => d.sourceId === sourceId)

	const allJobIds = (): { id: string; passive: boolean; state: JobState }[] => [
		...[...records.values()].map(r => ({
			id: r.id,
			passive: r.passive,
			state: r.state,
		})),
		...[...identifyJobs.values()].map(j => ({
			id: j.id,
			passive: false,
			state: j.state,
		})),
	]

	const impactFor = (spec: NormalisedJobSpec, exceptJobId?: string): Impact => {
		const live = ctx.liveStatus()
		const unknown = new Set(tuner.unknownFields ?? [])
		const changes: string[] = ["frequency"]
		if (spec.tuner.sampleRateHz !== null) changes.push("sampleRate")
		if (spec.tuner.gainTenthsDb !== null) changes.push("gainMode", "gain")
		if (spec.tuner.agc !== null) changes.push("agcMode")
		const onSource = decodersOnSource()
		return {
			liveAudioClients:
				live.running && live.sourceId === sourceId ? live.clientCount : 0,
			digitalVoiceListeners: 0,
			runningDecoders: onSource
				.filter(d => d.running && !d.suspended)
				.map(d => d.id),
			pinnedDecoders: onSource
				.filter(d => d.startMode === "operator")
				.map(d => d.id),
			scannerJobs: allJobIds()
				.filter(j => !j.passive && j.id !== exceptJobId && !isTerminal(j.state))
				.map(j => j.id),
			unrestorable: changes.filter(f =>
				unknown.has(f as NonNullable<TunerState["unknownFields"]>[number]),
			),
		}
	}

	const previewContext = (): PreviewContext => ({
		source: {
			id: sourceId,
			centreHz: tuner.frequency,
			sampleRateHz: tuner.sampleRate,
			controlMode: tuner.controlMode,
		},
		settings,
		bandplans: SCANNER_BANDPLANS,
		lockouts: () =>
			[...discoveries.values()]
				.filter(
					({ d }) =>
						d.operator?.lockout === true && d.sourceIds.includes(sourceId),
				)
				.map(({ d }) => ({
					discoveryId: d.id,
					centreHz: d.frequencyHz,
					bandwidthHz: d.bandwidthHz,
				})),
		impact: impactFor,
	})

	const preview = (spec: StoredSpec) => previewPlan(spec, previewContext())

	// --- Discoveries ---

	const statsOf = (peak: number) => ({
		peakDbfs: round1(peak),
		meanDbfs: round1(peak - 4),
		snrDb: round1(peak - NOISE_FLOOR_DBFS),
		floorDbfs: NOISE_FLOOR_DBFS,
	})

	const observationOf = (
		d: Discovery,
		at: number,
		jobIds: string[],
		opts: { endedAt?: number; hopIndex?: number; peak?: number } = {},
	): Observation => {
		observationSeq += 1
		const peak = opts.peak ?? d.signal.last.peakDbfs
		const o: Observation = {
			id: `o_${at.toString(36).toUpperCase()}${observationSeq.toString(36).toUpperCase().padStart(5, "0")}`,
			discoveryId: d.id,
			startedAt: iso(at),
			sampleRange: { stream: 1, epoch: 1, start: Math.round(at * 2.4) },
			centerHz: d.frequencyHz + d.measuredOffsetHz,
			obwHz: d.bandwidthHz,
			obwMethod: "-20dB",
			peakDbfs: round1(peak),
			meanDbfs: round1(peak - 4),
			snrDb: round1(peak - NOISE_FLOOR_DBFS),
			floorDbfs: NOISE_FLOOR_DBFS,
			thresholdDb: 9,
			dutyCycle: 0.8,
			hypotheses: [
				{
					protocol: d.protocol,
					score: d.confidence === "activity" ? 0.4 : 0.9,
				},
			],
			recordingIds: [],
			recording: "none",
			flags: {
				overload: false,
				gap: false,
				offRaster: false,
				obwBiased: false,
				adjacentLeak: false,
				suspectedIntermod: false,
				edge: false,
			},
			sourceId,
			jobIds,
			tuningTrust: "commanded",
		}
		if (opts.endedAt !== undefined) {
			o.endedAt = iso(opts.endedAt)
			o.endReason = "quiet"
			o.sampleRange.end = Math.round(opts.endedAt * 2.4)
		}
		if (opts.hopIndex !== undefined) o.hopIndex = opts.hopIndex
		if (d.confidence === "decoded")
			o.decode = [
				{
					protocol: d.protocol,
					...(d.identity ? { identity: { ...d.identity } } : {}),
					metadata: {},
					crcClean: true,
					...(d.encrypted ? { encrypted: true } : {}),
					at,
					epoch: 1,
					origin: "ambient",
				},
			]
		return o
	}

	const seed = () => {
		const now = Date.now()
		DISCOVERY_SEEDS.forEach((s, index) => {
			const hz = Math.round(s.mhz * 1e6)
			const signal = MOCK_SIGNALS.find(x => x.hz === hz)
			if (!signal) throw new Error(`discovery seed ${hz} has no mock signal`)
			const last = now - s.agoMin * 60_000
			const first = now - s.firstDays * 86_400_000
			const jobIds = [
				`passive-${sourceId}`,
				...(s.swept ? [MOCK_SWEEP_JOB_ID] : []),
			]
			const d: Discovery = {
				id: seedDiscoveryId(index, hz),
				frequencyHz: hz,
				frequencyKey: `r:${hz}`,
				measuredOffsetHz: ((index * 37) % 9) * 40 - 160,
				bandwidthHz: signal.bwHz,
				protocol: s.protocol,
				family: PROTOCOL_FAMILY[s.protocol],
				class: s.class,
				confidence: s.confidence,
				encrypted: s.encrypted ?? false,
				coChannel: [],
				firstSeenAt: iso(first),
				lastSeenAt: iso(last),
				observationCount: s.observations,
				airtimeMs: Math.round(s.observations * (signal.on ?? 2) * 1000),
				signal: {
					best: statsOf(signal.powerDbfs),
					last: statsOf(signal.powerDbfs - 3),
				},
				metadata: { ...emptyMetadata(), ...(s.metadata ?? {}) },
				sourceIds: [sourceId],
				jobIds,
				tuningTrust: "commanded",
				evidence: {
					recordings:
						s.confidence === "decoded" &&
						PROTOCOL_FAMILY[s.protocol] === "digital-voice"
							? 3
							: s.protocol === "analog-fm"
								? 2
								: 0,
					psd: true,
					iq: false,
				},
			}
			if (s.identity) d.identity = { ...s.identity }
			if (s.operator) d.operator = { ...s.operator }
			if (s.confidence === "candidate" && PROTOCOL_DECODER[s.protocol] !== null)
				d.undecodedReason = "no-sync"
			const observations: Observation[] = []
			// a day of earlier transmissions for the opened row's "Last 24 h", busier in daytime
			const older = Math.min(60, Math.max(0, s.observations - 3))
			const day: number[] = []
			for (let k = 0; k < older; k++) {
				const at =
					last -
					20 * 60_000 -
					(((k * 7919 + index * 104_729) % 1380) + 1) * 60_000
				const hour = new Date(at).getHours()
				if (at > first && (hour >= 7 || (k + index) % 3 === 0)) day.push(at)
			}
			for (const at of day.sort((x, y) => x - y))
				observations.push(
					observationOf(d, at, jobIds, {
						endedAt: at + Math.round((signal.on ?? 2) * 1000),
					}),
				)
			for (let k = 2; k >= 0; k--) {
				const at = last - k * 7 * 60_000
				observations.push(
					observationOf(d, at, jobIds, {
						endedAt: at + Math.round((signal.on ?? 2) * 1000),
					}),
				)
			}
			discoveries.set(d.id, { d, observations })
		})
	}
	seed()
	if (ctx.bandFixtures)
		for (const d of bandFixtureDiscoveries(sourceId, Date.now()))
			discoveries.set(d.id, { d, observations: [] })
	if (ctx.retuneSweep)
		for (const d of retuneSweepDiscoveries(sourceId, Date.now()))
			discoveries.set(d.id, { d, observations: [] })

	const findDiscoveryAt = (
		hz: number,
		bwHz: number,
	): DiscoveryRec | undefined => {
		let best: DiscoveryRec | undefined
		let bestD = Infinity
		for (const rec of discoveries.values()) {
			if (!rec.d.sourceIds.includes(sourceId)) continue
			const dist = Math.abs(rec.d.frequencyHz - hz)
			if (dist <= Math.max(1000, bwHz / 2) && dist < bestD) {
				best = rec
				bestD = dist
			}
		}
		return best
	}

	const emitDiscovery = (
		change: ScannerDiscoveryEventData["change"],
		d: Discovery,
		jobHits?: ScanJobHit[],
	) =>
		offer(`discovery:${d.id}`, "scanner:discovery", {
			change,
			discovery: structuredClone(d),
			...(jobHits ? { jobHits } : {}),
		} satisfies ScannerDiscoveryEventData)

	const bookOf = (jobId: string): HitBook => {
		let book = books.get(jobId)
		if (!book) {
			book = { hits: new Map(), total: 0, newDiscoveries: 0 }
			books.set(jobId, book)
		}
		return book
	}

	const hitStats = (jobId: string): ScanJobHitStats => {
		const book = books.get(jobId)
		return {
			discoveries: book?.hits.size ?? 0,
			hits: book?.total ?? 0,
			newDiscoveries: book?.newDiscoveries ?? 0,
			truncated: false,
		}
	}

	const credit = (
		jobId: string,
		d: Discovery,
		created: boolean,
		at: number,
	) => {
		const book = bookOf(jobId)
		book.total += 1
		let hit = book.hits.get(d.id)
		if (!hit) {
			hit = {
				jobId,
				discoveryId: d.id,
				hits: 0,
				firstHitAt: iso(at),
				lastHitAt: iso(at),
				firstSeenInJob: created,
				lastDurationMs: null,
			}
			if (created) book.newDiscoveries += 1
		}
		hit.hits += 1
		hit.lastHitAt = iso(at)
		// most recent last (the hits list reads newest first)
		book.hits.delete(d.id)
		book.hits.set(d.id, hit)
		return { ...hit }
	}

	/**
	 * One observation of `signal` credited to `jobId`: creates or updates its discovery, emits
	 * `scanner:discovery` (with jobHits) and `scanner:activity` (active).
	 */
	const observe = (
		jobId: string,
		signal: MockSignal,
		hopIndex: number | undefined,
	): { discoveryId: string; observationId: string; peak: number } => {
		const now = Date.now()
		const peak = signal.powerDbfs + (Math.random() - 0.5) * 2
		let rec = findDiscoveryAt(signal.hz, signal.bwHz)
		const created = rec === undefined
		if (!rec) {
			const plan = identifyPlanFor(signal)
			const protocol = plan.protocol ?? "unknown"
			const d: Discovery = {
				id: newId("d"),
				frequencyHz: signal.hz,
				frequencyKey: `r:${signal.hz}`,
				measuredOffsetHz: 0,
				bandwidthHz: signal.bwHz,
				protocol,
				family: PROTOCOL_FAMILY[protocol],
				class: plan.class,
				confidence: plan.protocol ? "candidate" : "activity",
				encrypted: false,
				coChannel: [],
				firstSeenAt: iso(now),
				lastSeenAt: iso(now),
				observationCount: 0,
				airtimeMs: 0,
				signal: { best: statsOf(peak), last: statsOf(peak) },
				metadata: emptyMetadata(),
				sourceIds: [sourceId],
				jobIds: [],
				tuningTrust: "commanded",
				evidence: { recordings: 0, psd: true, iq: false },
			}
			rec = { d, observations: [] }
			discoveries.set(d.id, rec)
		}
		const d = rec.d
		d.lastSeenAt = iso(now)
		d.observationCount += 1
		d.airtimeMs += Math.round((signal.on ?? 1) * 1000)
		d.signal.last = statsOf(peak)
		if (peak > d.signal.best.peakDbfs) d.signal.best = statsOf(peak)
		if (!d.jobIds.includes(jobId)) d.jobIds.push(jobId)
		const o = observationOf(d, now, [jobId], {
			...(hopIndex !== undefined ? { hopIndex } : {}),
			peak,
		})
		rec.observations.push(o)
		if (rec.observations.length > 200) rec.observations.shift()
		const hit = credit(jobId, d, created, now)
		emitDiscovery(created ? "created" : "updated", d, [hit])
		offer(`activity:${o.id}`, "scanner:activity", {
			sourceId,
			observationId: o.id,
			discoveryId: d.id,
			jobIds: [jobId],
			frequencyHz: d.frequencyHz,
			active: true,
			peakDbfs: round1(peak),
			hypothesis: { protocol: d.protocol, score: 0.9 },
		} satisfies ScannerActivityEventData)
		return { discoveryId: d.id, observationId: o.id, peak }
	}

	/** Ends an observation: `endedAt`, the job's lastDurationMs, `scanner:activity` inactive. */
	const endObservation = (
		jobId: string,
		open: JobRec["open"][number],
		reason: "quiet" | "hop" | "job-end",
	) => {
		const now = Date.now()
		const rec = discoveries.get(open.discoveryId)
		const o = rec?.observations.find(x => x.id === open.observationId)
		if (o && o.endedAt === undefined) {
			o.endedAt = iso(now)
			o.endReason = reason
			o.sampleRange.end = Math.round(now * 2.4)
		}
		const hit = books.get(jobId)?.hits.get(open.discoveryId)
		if (hit) hit.lastDurationMs = Math.max(0, now - open.at)
		offer(`activity:${open.observationId}`, "scanner:activity", {
			sourceId,
			observationId: open.observationId,
			discoveryId: open.discoveryId,
			jobIds: [jobId],
			frequencyHz: open.hz,
			active: false,
			peakDbfs: round1(open.peak),
		} satisfies ScannerActivityEventData)
	}

	const discoveryCounts = (
		jobId: string,
	): Record<ScannerConfidence, number> => {
		const counts = { activity: 0, candidate: 0, classified: 0, decoded: 0 }
		for (const { d } of discoveries.values())
			if (d.jobIds.includes(jobId)) counts[d.confidence] += 1
		return counts
	}

	// --- Jobs ---

	const progressOf = (r: JobRec): ScanJobProgress => {
		const sweep = r.spec.mode === "sweep"
		return {
			sweepIndex: r.sweepIndex,
			hopIndex: r.hopIndex,
			hopCount: r.plan.hops.length,
			sweepPeriodMs: r.sweepPeriodMs,
			coverage: sweep
				? r.plan.hops.length > 0
					? r.visited.size / r.plan.hops.length
					: 0
				: r.state === "pending" || r.state === "starting"
					? 0
					: 1,
			holdingOn: r.holdingOn,
			settleMode: isActive(r.state) ? (sweep ? "marker" : "none") : null,
			probes: [],
			counts: { ...r.counts, discoveries: discoveryCounts(r.id) },
			hitStats: hitStats(r.id),
		}
	}

	/** In-window jobs follow the source's current centre (one hop described there). */
	const refreshWindow = (r: JobRec) => {
		if (r.spec.mode !== "in-window") return
		r.plan = inWindowPlan(r.spec, previewContext())
	}

	const toDto = (r: JobRec): ScanJob => {
		refreshWindow(r)
		const dto: ScanJob = {
			id: r.id,
			resumeAt: r.resumeAt === null ? null : iso(r.resumeAt),
			resumeHeldBy: null,
			name: r.name,
			state: r.state,
			...(r.reason ? { reason: r.reason } : {}),
			...(r.preemptedBy && r.state === "paused" && r.reason === "preempted-job"
				? { preemptedBy: { ...r.preemptedBy } }
				: {}),
			passive: r.passive,
			spec: structuredClone(r.spec),
			plan: structuredClone(r.plan),
			issues: structuredClone(r.issues),
			impact: r.impact ? structuredClone(r.impact) : null,
			unrestorable: [],
			...(r.lockoutExclusions
				? { lockoutExclusions: structuredClone(r.lockoutExclusions) }
				: {}),
			progress: progressOf(r),
			createdAt: iso(r.createdAt),
			updatedAt: iso(r.updatedAt),
			...(r.startedAt !== undefined ? { startedAt: iso(r.startedAt) } : {}),
			...(r.endedAt !== undefined ? { endedAt: iso(r.endedAt) } : {}),
		}
		return dto
	}

	const emitJob = (r: JobRec) => {
		if (records.get(r.id) !== r) return
		offer(`job:${r.id}`, "scanner:job", toDto(r))
	}

	const emitProgress = (r: JobRec) => {
		const p = progressOf(r)
		const hop = r.plan.hops[p.hopIndex]
		const data: ScannerProgressEventData = {
			jobId: r.id,
			state: r.state,
			sweepIndex: p.sweepIndex,
			hopIndex: p.hopIndex,
			hopCount: p.hopCount,
			centerHz: hop?.centreHz ?? tuner.frequency,
			...(p.holdingOn ? { holdingOn: p.holdingOn } : {}),
			coverage: p.coverage,
			probes: 0,
			hits: p.hitStats?.hits ?? 0,
			newDiscoveries: p.hitStats?.newDiscoveries ?? 0,
		}
		offer(`progress:${r.id}`, "scanner:progress", data, 500)
	}

	const status = (): ScannerStatus => {
		const all = allJobIds()
		const holder = leaseHolder()
		return {
			enabled: settings.enabled,
			channelizerAvailable: false,
			engines: [
				{
					sourceId,
					state: "running",
					rbwHz: tuner.sampleRate / defaultFftSize(tuner.sampleRate),
					fftSize: defaultFftSize(tuner.sampleRate),
					kByRange: [],
					floorDbfs: NOISE_FLOOR_DBFS,
					floorOccupied: false,
					overload: false,
					settleMode: holder ? "marker" : "none",
					settleMs: MARKER_RUN_ASSUMED_MS + settings.sweep.pllSettleMs,
					settleMeasured: true,
					markerSupported: true,
					stuckTestMode: false,
					staleAfterSettle: 0,
					blankedFrames: overloadBlanked === null ? 0 : 1200,
					broadbandRfi: null,
					passive: { enabled: passiveEnabled() },
					frequencyError: null,
					...(overloadBlanked !== null && tuner.gainMode === "manual"
						? {
								overloadHint: {
									reason: "front end may be overloaded at this gain" as const,
									gain: tuner.gain,
									blankedPercent: overloadBlanked,
								},
							}
						: {}),
				},
			],
			budgets: {
				cpuBudgetCores: settings.cpuBudgetCores,
				cpuCoresInUse: CPU_ENGINE,
				maxProbes: { ...settings.maxProbes },
				probesInUse: { offset: 0, channel: 0 },
			},
			cpuGuard: {
				percent: 18,
				limitPercent: settings.cpuGuardPercent,
				source: "os",
			},
			disk: "ok",
			jobs: {
				active: all.filter(j => !isTerminal(j.state)).length,
				total: all.length,
			},
		}
	}
	const emitStatus = () => offer("status", "scanner:status", status())

	const leaseHolder = (): JobRec | undefined =>
		[...records.values()].find(r => r.lease && !isTerminal(r.state))

	const stopTimers = (r: JobRec) => {
		cancelTimer(r.timer)
		r.timer = null
	}

	const closeOpen = (r: JobRec, reason: "quiet" | "hop" | "job-end") => {
		for (const open of r.open) endObservation(r.id, open, reason)
		r.open = []
	}

	const touch = (r: JobRec) => {
		r.updatedAt = Date.now()
	}

	/** The hop's active mock signals inside the job's enabled, non-excluded ranges. */
	const activeSignals = (r: JobRec, centreHz: number): MockSignal[] => {
		const half = r.plan.usableHalfSpanHz
		const ranges = r.spec.ranges.filter(isRangeEnabled)
		const excluded = [
			...r.spec.exclusions,
			...(r.lockoutExclusions ?? []).filter(x => x.applied),
		]
		const t = Date.now() / 1000
		return MOCK_SIGNALS.filter(
			s =>
				Math.abs(s.hz - centreHz) <= half &&
				(ranges.length === 0 ||
					ranges.some(x => s.hz >= x.startHz && s.hz <= x.endHz)) &&
				!excluded.some(x => s.hz >= x.startHz && s.hz <= x.endHz) &&
				signalActive(s, t) &&
				findDiscoveryAt(s.hz, s.bwHz)?.d.operator?.lockout !== true,
		)
	}

	const finish = (
		r: JobRec,
		state: "completed" | "cancelled" | "failed",
		reason?: FailReason,
	) => {
		stopTimers(r)
		closeOpen(r, "job-end")
		const hadLease = r.lease
		r.state = state
		if (reason) r.reason = reason
		else delete r.reason
		r.holdingOn = null
		r.heldHz = null
		r.resumeAt = null
		r.endedAt = Date.now()
		touch(r)
		r.lease = false
		if (hadLease && r.snapshotHz !== null && r.snapshotHz !== tuner.frequency)
			ctx.retune(r.snapshotHz)
		emitJob(r)
		emitProgress(r)
		emitStatus()
		if (hadLease) handBack()
	}

	/** P16: a freed lease goes to the best job that lost it to another job. */
	const handBack = () => {
		if (leaseHolder()) return
		const waiting = [...records.values()]
			.filter(r => r.state === "paused" && r.reason === "preempted-job")
			.sort(
				(a, b) =>
					b.spec.priority - a.spec.priority || a.createdAt - b.createdAt,
			)
		const best = waiting[0]
		if (best) resumeSweep(best)
	}

	const scheduleStep = (r: JobRec) => {
		const hop = r.plan.hops[r.hopIndex]
		const dwell = hop?.dwellMs ?? r.spec.dwellMs
		stopTimers(r)
		r.timer = later(dwell, () => {
			r.timer = null
			advance(r)
		})
	}

	/** Tunes the current hop, records what is on air and holds on the strongest when allowed. */
	const visit = (r: JobRec) => {
		const hop = r.plan.hops[r.hopIndex]
		if (!hop || !isActive(r.state)) return
		if (tuner.frequency !== hop.centreHz) ctx.retune(hop.centreHz)
		r.visited.add(r.hopIndex)
		const heard = activeSignals(r, hop.centreHz)
		for (const s of heard) {
			const o = observe(r.id, s, r.hopIndex)
			r.counts.observations += 1
			r.open.push({ ...o, hz: s.hz, at: Date.now() })
		}
		const strongest = [...heard].sort((a, b) => b.powerDbfs - a.powerDbfs)[0]
		if (strongest && r.spec.hold.policy !== "never") {
			r.state = "holding"
			// like the core's scheduler: the hold names a tracker track, not a discovery
			r.holdingOn = newId("trk")
			r.heldHz = strongest.hz
			touch(r)
			emitJob(r)
			stopTimers(r)
			r.timer = later(Math.min(MOCK_HOLD_MS, r.spec.hold.maxHoldMs), () => {
				r.timer = null
				if (r.state === "holding") endHold(r)
			})
			return
		}
		scheduleStep(r)
	}

	/** The hold ends (quiet, timed out, or its frequency was skipped): back to running, next hop. */
	const endHold = (r: JobRec) => {
		stopTimers(r)
		r.state = "running"
		r.holdingOn = null
		r.heldHz = null
		touch(r)
		emitJob(r)
		advance(r)
	}

	const advance = (r: JobRec) => {
		if (!isActive(r.state)) return
		closeOpen(r, "hop")
		let next = r.hopIndex + 1
		if (next >= r.plan.hops.length) {
			next = 0
			r.sweepIndex += 1
			const { afterSweeps } = r.spec.stop
			if (afterSweeps !== null && r.sweepIndex >= afterSweeps) {
				finish(r, "completed")
				return
			}
		}
		const { afterMs } = r.spec.stop
		if (
			afterMs !== null &&
			r.startedAt !== undefined &&
			Date.now() - r.startedAt >= afterMs
		) {
			finish(r, "completed")
			return
		}
		r.hopIndex = next
		visit(r)
	}

	/** Takes the lease (snapshotting the operator's tuning) and runs from the current hop. */
	const resumeSweep = (r: JobRec) => {
		if (!r.lease) {
			r.lease = true
			r.snapshotHz = tuner.frequency
		}
		r.state = "running"
		delete r.reason
		delete r.preemptedBy
		r.resumeAt = null
		touch(r)
		emitJob(r)
		visit(r)
	}

	const pauseFor = (r: JobRec, reason: PauseReason, keepLease: boolean) => {
		stopTimers(r)
		closeOpen(r, "quiet")
		r.state = "paused"
		r.reason = reason
		r.holdingOn = null
		r.heldHz = null
		if (!keepLease) r.lease = false
		touch(r)
	}

	const autoResumeAt = (r: JobRec) =>
		r.spec.resume.autoAfterIdleMs === null
			? null
			: Date.now() + r.spec.resume.autoAfterIdleMs

	const startJob = (r: JobRec) => {
		r.state = "starting"
		if (r.spec.mode === "sweep") {
			r.lease = true
			r.snapshotHz = tuner.frequency
		}
		later(MOCK_START_MS, () => {
			if (r.state !== "starting" || records.get(r.id) !== r) return
			r.state = "running"
			r.startedAt = Date.now()
			touch(r)
			emitJob(r)
			emitProgress(r)
			if (r.spec.mode === "sweep") visit(r)
		})
	}

	const makeRecord = (
		id: string,
		raw: StoredSpec,
		p: PlanPreview,
		passive: boolean,
	): JobRec => {
		const now = Date.now()
		const sweep = p.spec.mode === "sweep"
		return {
			id,
			name: raw.name ?? null,
			passive,
			raw,
			spec: p.spec,
			plan: p.plan,
			issues: p.issues,
			sweepPeriodMs: p.sweepPeriodMs,
			...(p.lockoutExclusions
				? { lockoutExclusions: p.lockoutExclusions }
				: {}),
			impact: sweep ? p.impact : null,
			consentedImpact: sweep && p.spec.takeover ? p.impact : null,
			state: "pending",
			resumeAt: null,
			createdAt: now,
			updatedAt: now,
			lease: false,
			snapshotHz: null,
			hopIndex: 0,
			sweepIndex: 0,
			visited: new Set(),
			holdingOn: null,
			heldHz: null,
			counts: { observations: 0, transients: 0 },
			timer: null,
			open: [],
		}
	}

	const passiveId = `passive-${sourceId}`
	const passiveEnabled = () =>
		settings.passive.enabled && (overrides.passive?.[sourceId] ?? true)

	/** The passive in-window job of the source (rebuilt after it ended, removed when disabled). */
	const ensurePassive = () => {
		const existing = records.get(passiveId)
		if (existing && isTerminal(existing.state)) records.delete(passiveId)
		const current = records.get(passiveId)
		const eligible = settings.enabled && passiveEnabled()
		if (!eligible) {
			if (current) {
				finish(current, "cancelled")
				records.delete(passiveId)
				books.delete(passiveId)
			}
			return
		}
		if (current) return
		const raw: StoredSpec = {
			name: `Passive ${sourceId}`,
			sourceId,
			mode: "in-window",
			protocols: [],
			priority: 0,
			resume: { onBoot: true },
		}
		const r = makeRecord(passiveId, raw, preview(raw), true)
		records.set(passiveId, r)
		r.state = "running"
		r.startedAt = r.createdAt
	}

	/** The seeded, ended marine sweep (persisted history of a real core). */
	const seedHistory = () => {
		const raw: StoredSpec = {
			name: "Marine VHF",
			mode: "sweep",
			bandplans: ["marine-vhf"],
			stop: { afterSweeps: 20 },
			takeover: true,
		}
		const p = preview(raw)
		const r = makeRecord(MOCK_SWEEP_JOB_ID, raw, p, false)
		const now = Date.now()
		r.createdAt = now - 26 * 3_600_000
		r.startedAt = r.createdAt + 900
		r.endedAt = r.createdAt + 41 * 60_000
		r.updatedAt = r.endedAt
		r.state = "completed"
		r.sweepIndex = 20
		r.hopIndex = 0
		r.plan.hops.forEach((_, i) => r.visited.add(i))
		r.counts = { observations: 57, transients: 12 }
		records.set(r.id, r)
		const book = bookOf(r.id)
		for (const { d } of discoveries.values()) {
			if (!d.jobIds.includes(r.id)) continue
			book.total += 19
			book.hits.set(d.id, {
				jobId: r.id,
				discoveryId: d.id,
				hits: 19,
				firstHitAt: iso(r.startedAt + 60_000),
				lastHitAt: iso(r.endedAt - 120_000),
				firstSeenInJob: false,
				lastDurationMs: 3400,
			})
		}
	}
	seedHistory()
	ensurePassive()

	const requireJob = (id: string): JobRec | ScanJob => {
		const r = records.get(id) ?? identifyJobs.get(id)
		if (!r)
			throw new ScannerApiError(
				`Job ${id} not found`,
				"SCANNER_JOB_NOT_FOUND",
				404,
			)
		return r
	}
	const invalid = (id: string, event: string, state: JobState) =>
		new ScannerApiError(
			`Job ${id} cannot handle "${event}" in state ${state}`,
			"SCANNER_INVALID_TRANSITION",
			409,
		)
	const impactNonEmpty = (i: Impact) =>
		i.liveAudioClients > 0 ||
		i.digitalVoiceListeners > 0 ||
		i.runningDecoders.length > 0 ||
		i.pinnedDecoders.length > 0 ||
		i.scannerJobs.length > 0 ||
		i.unrestorable.length > 0
	const impactGrew = (now: Impact, consented: Impact | null) => {
		if (!consented) return impactNonEmpty(now)
		const more = (a: string[], b: string[]) => a.some(x => !b.includes(x))
		return (
			now.liveAudioClients > consented.liveAudioClients ||
			now.digitalVoiceListeners > consented.digitalVoiceListeners ||
			more(now.runningDecoders, consented.runningDecoders) ||
			more(now.pinnedDecoders, consented.pinnedDecoders) ||
			more(now.scannerJobs, consented.scannerJobs)
		)
	}
	const sourceBusy = (holder: JobRec) =>
		new ScannerApiError(
			`Lease held by scanner job ${holder.id}`,
			"SCANNER_SOURCE_BUSY",
			409,
			{ reason: "held", holderJobId: holder.id },
		)

	/** Replans the live sweeps whose lockout exclusions changed (WG2 req 12). */
	const replanLockouts = () => {
		for (const r of records.values()) {
			if (r.passive || r.spec.mode !== "sweep" || isTerminal(r.state)) continue
			const next = planJob(r.spec, previewContext())
			if (
				JSON.stringify(next.lockoutExclusions ?? []) ===
				JSON.stringify(r.lockoutExclusions ?? [])
			)
				continue
			if (next.lockoutExclusions) r.lockoutExclusions = next.lockoutExclusions
			else delete r.lockoutExclusions
			r.plan = next.plan
			if (r.hopIndex >= r.plan.hops.length) r.hopIndex = 0
			touch(r)
			emitJob(r)
		}
	}

	// --- Ticker: progress at 2 Hz, auto-resume, relay preemption ---

	let tick = 0
	const ticker = setInterval(() => {
		tick += 1
		const now = Date.now()
		for (const r of [...records.values()]) {
			if (isTerminal(r.state)) continue
			if (r.spec.mode === "sweep") {
				if (isActive(r.state) && r.lease && tuner.controlMode === "external") {
					pauseFor(r, "preempted-relay", false)
					r.resumeAt = null
					emitJob(r)
				}
				if (
					r.state === "paused" &&
					r.reason === "preempted-relay" &&
					r.resumeAt === null &&
					tuner.controlMode === "internal" &&
					r.spec.resume.autoAfterIdleMs !== null
				) {
					r.resumeAt = autoResumeAt(r)
					touch(r)
					emitJob(r)
				}
				if (
					r.state === "paused" &&
					(r.reason === "preempted-operator" ||
						r.reason === "preempted-relay") &&
					r.resumeAt !== null &&
					now >= r.resumeAt &&
					tuner.controlMode === "internal" &&
					!leaseHolder()
				)
					resumeSweep(r)
				if (isActive(r.state) || r.state === "starting") emitProgress(r)
			} else if (tick % 4 === 0 && isActive(r.state)) emitProgress(r)
		}
	}, 500)

	app.addHook("onClose", async () => {
		clearInterval(ticker)
		for (const t of timers) clearTimeout(t)
		timers.clear()
	})

	// --- Routes ---

	app.get("/api/scanner", async () => status())

	const settingsView = (): ScannerSettingsView => ({
		effective: structuredClone(settings),
		passiveBySource: { [sourceId]: passiveEnabled() },
		provenance: { ...provenance },
		bounds: SETTINGS_BOUNDS,
	})
	app.get("/api/scanner/settings", async () => settingsView())
	app.patch<{ Body: unknown }>(
		"/api/scanner/settings",
		{ schema: { body: { type: "object" } } },
		async (request, reply) => {
			try {
				const patch = SettingsPatchSchema.parse(request.body)
				const { passive, ...rest } = patch
				const next = structuredClone(settings) as unknown as Tree
				for (const [path, value] of leaves(rest)) {
					if (value === undefined || path === "") continue
					writePath(next, path, value)
					provenance[path] = "runtime"
				}
				settings = next as unknown as ScannerSettingsValues
				overrides = {
					...overrides,
					...rest,
					...(passive !== undefined
						? { passive: { ...(overrides.passive ?? {}), ...passive } }
						: {}),
				}
				if (passive?.[sourceId] !== undefined)
					provenance[`passiveBySource.${sourceId}`] = "runtime"
				ensurePassive()
				offer("status", "scanner:status", status(), 0)
				return settingsView()
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.get("/api/scanner/bandplans", async () =>
		structuredClone(SCANNER_BANDPLANS),
	)

	app.post<{ Body: SpecBody }>(
		"/api/scanner/plan",
		{ schema: { body: scanJobSpecSchema } },
		async (request, reply) => {
			try {
				return preview(fromSpecBody(request.body))
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.post<{ Body: SpecBody }>(
		"/api/scanner/jobs",
		{ schema: { body: scanJobSpecSchema } },
		async (request, reply) => {
			try {
				const spec = fromSpecBody(request.body)
				if (!settings.enabled)
					throw new ScannerApiError(
						"The scanner is disabled",
						"SCANNER_DISABLED",
						503,
					)
				if (spec.kind === "monitor")
					throw new ScannerApiError(
						"Listen-scan jobs need the channelizer",
						"SCANNER_MONITOR_UNAVAILABLE",
						400,
					)
				const p = preview(spec)
				rejectErrors(p.issues)
				const n = p.spec
				if (n.mode === "sweep") {
					if (impactNonEmpty(p.impact) && !n.takeover)
						throw new ScannerApiError(
							"This sweep disturbs other consumers; resend with takeover",
							"SCANNER_TAKEOVER_REQUIRED",
							409,
							{ impact: p.impact },
						)
					const holder = leaseHolder()
					if (holder) {
						if (n.priority <= holder.spec.priority) throw sourceBusy(holder)
					}
				}
				const r = makeRecord(newId("j"), spec, p, false)
				const holder = n.mode === "sweep" ? leaseHolder() : undefined
				records.set(r.id, r)
				if (holder) {
					// a higher-priority sweep takes the lease over (the arbiter's hand-over)
					const wasActive = isActive(holder.state)
					pauseFor(holder, "preempted-job", false)
					holder.preemptedBy = { jobId: r.id, name: r.name }
					if (!wasActive) holder.resumeAt = null
					emitJob(holder)
				}
				startJob(r)
				const dto = toDto(r)
				offer(`job:${r.id}`, "scanner:job", dto)
				emitStatus()
				return reply.code(201).send(dto)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.get("/api/scanner/jobs", async () => [
		...[...records.values()].map(toDto),
		...[...identifyJobs.values()].map(j => structuredClone(j)),
	])

	app.get<{ Params: { id: string } }>(
		"/api/scanner/jobs/:id",
		{ schema: { params: jobIdParamsSchema } },
		async (request, reply) => {
			const r = records.get(request.params.id)
			if (r) return toDto(r)
			const j = identifyJobs.get(request.params.id)
			return j ?? notFound(reply, "Job", request.params.id)
		},
	)

	app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
		"/api/scanner/jobs/:id/hits",
		{ schema: { params: jobIdParamsSchema, querystring: jobHitsQuerySchema } },
		async (request, reply) => {
			try {
				const { id } = request.params
				requireJob(id)
				const limit = request.query.limit ?? JOB_HITS_LIMIT_DEFAULT
				const book = books.get(id)
				const body: ScanJobHitsResponse = {
					jobId: id,
					stats: hitStats(id),
					hits: book
						? [...book.hits.values()]
								.reverse()
								.slice(0, limit)
								.map(h => ({ ...h }))
						: [],
				}
				return body
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.patch<{ Params: { id: string }; Body: SpecBody }>(
		"/api/scanner/jobs/:id",
		{ schema: { params: jobIdParamsSchema, body: scanJobSpecSchema } },
		async (request, reply) => {
			try {
				const found = requireJob(request.params.id)
				if (isTerminal(found.state))
					throw new ScannerApiError(
						"Job has ended",
						"SCANNER_JOB_TERMINAL",
						409,
					)
				if (!("raw" in found))
					throw new ScannerApiError(
						"Identify jobs cannot be edited",
						"SCANNER_IDENTIFY_NOT_EDITABLE",
						409,
					)
				const r = found
				const patch = fromSpecBody(request.body)
				const allowed: (keyof ScanJobSpec)[] = [
					"thresholdDb",
					"sensitivity",
					"exclusions",
					"hold",
					"revisit",
					"record",
					"protocols",
					"capture",
					"signalsOnly",
					"skipDecodedElsewhere",
					"skipBandPlanSkips",
				]
				const merged: StoredSpec = {
					...r.raw,
					sourceId: r.spec.sourceId,
					mode: r.spec.mode,
				}
				for (const key of allowed)
					if (patch[key] !== undefined)
						Object.assign(merged, { [key]: patch[key] })
				if (patch.ranges !== undefined) {
					const edited = applyRangePatch(r.spec.ranges, patch.ranges)
					rejectErrors(edited.issues)
					merged.rangeLive = edited.rangeLive
				}
				const p = preview(merged)
				rejectErrors(p.issues)
				r.raw = merged
				r.spec = p.spec
				r.plan = p.plan
				r.issues = p.issues
				r.sweepPeriodMs = p.sweepPeriodMs
				if (p.lockoutExclusions) r.lockoutExclusions = p.lockoutExclusions
				else delete r.lockoutExclusions
				if (r.hopIndex >= r.plan.hops.length) r.hopIndex = 0
				touch(r)
				// src/core/scanner/job-runner.ts replan: a probe on a now-excluded frequency is
				// released, so the hold ends and the sweep moves on (Skip on a held hit)
				const heldHz = r.heldHz
				if (
					r.state === "holding" &&
					heldHz !== null &&
					r.spec.exclusions.some(x => heldHz >= x.startHz && heldHz <= x.endHz)
				)
					endHold(r)
				const job = toDto(r)
				offer(`job:${r.id}`, "scanner:job", job)
				return { job, plan: structuredClone(p.plan), issues: p.issues }
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	const identifyAction = (
		j: ScanJob,
		action: "pause" | "resume" | "cancel",
	) => {
		if (action !== "cancel")
			throw new ScannerApiError(
				"Identify jobs cannot be paused; cancel it and identify again",
				"SCANNER_IDENTIFY_NOT_PAUSABLE",
				409,
			)
		if (isTerminal(j.state)) throw invalid(j.id, "cancel", j.state)
		j.state = "cancelled"
		j.updatedAt = new Date().toISOString()
		j.endedAt = j.updatedAt
		for (const t of j.identify?.targets ?? [])
			for (const trial of t.trials)
				if (trial.outcome === "running" || trial.outcome === "pending")
					trial.outcome = "cancelled"
		offer(`job:${j.id}`, "scanner:job", structuredClone(j))
		return structuredClone(j)
	}

	const pauseJob = (r: JobRec): void => {
		const preempted =
			r.state === "paused" &&
			(r.reason === "preempted-operator" ||
				r.reason === "preempted-relay" ||
				r.reason === "preempted-job")
		if (preempted) {
			r.reason = "operator"
			r.resumeAt = null
			delete r.preemptedBy
			touch(r)
		} else if (isActive(r.state)) pauseFor(r, "operator", true)
		else throw invalid(r.id, "pause", r.state)
		emitJob(r)
		emitProgress(r)
	}

	const resumeJob = (r: JobRec, takeover: boolean): void => {
		if (r.state !== "paused") throw invalid(r.id, "resume", r.state)
		if (r.spec.mode !== "sweep") {
			if (r.reason !== "operator") throw invalid(r.id, "resume", r.state)
			r.state = "running"
			delete r.reason
			touch(r)
			emitJob(r)
			return
		}
		const holder = leaseHolder()
		if (r.reason === "operator") {
			if (!r.lease) {
				if (holder && holder !== r) throw sourceBusy(holder)
				const impact = impactFor(r.spec, r.id)
				if (!takeover && impactGrew(impact, r.consentedImpact))
					throw new ScannerApiError(
						"Resuming disturbs consumers started since the operator took the tuner; resend with takeover",
						"SCANNER_TAKEOVER_REQUIRED",
						409,
						{ impact },
					)
			}
			resumeSweep(r)
			return
		}
		if (r.reason === "resume-blocked" && !takeover)
			throw invalid(r.id, "resume", r.state)
		if (holder && holder !== r) throw sourceBusy(holder)
		const best = [...records.values()]
			.filter(
				j =>
					j.spec.mode === "sweep" &&
					j.state === "paused" &&
					(j.reason === "preempted-operator" ||
						j.reason === "preempted-relay" ||
						j.reason === "preempted-job"),
			)
			.sort(
				(a, b) =>
					b.spec.priority - a.spec.priority || a.createdAt - b.createdAt,
			)[0]
		if (best && best !== r && r.reason !== "resume-blocked")
			throw new ScannerApiError(
				`Scanner job ${best.id} waits for the lease with a better claim`,
				"SCANNER_SOURCE_BUSY",
				409,
				{ reason: "held", waiter: best.id },
			)
		resumeSweep(r)
	}

	for (const action of ["pause", "resume", "cancel"] as const) {
		app.post<{ Params: { id: string }; Body: { takeover?: boolean } | null }>(
			`/api/scanner/jobs/:id/${action}`,
			{
				schema: {
					params: jobIdParamsSchema,
					...(action === "resume" ? { body: resumeBodySchema } : {}),
				},
			},
			async (request, reply) => {
				try {
					const found = requireJob(request.params.id)
					if (!("raw" in found)) return identifyAction(found, action)
					const r = found
					if (action === "pause") pauseJob(r)
					else if (action === "resume")
						resumeJob(r, request.body?.takeover === true)
					else {
						if (isTerminal(r.state)) throw invalid(r.id, "cancel", r.state)
						finish(r, "cancelled")
					}
					return toDto(r)
				} catch (err) {
					return sendError(reply, err)
				}
			},
		)
	}

	app.delete<{ Params: { id: string } }>(
		"/api/scanner/jobs/:id",
		{ schema: { params: jobIdParamsSchema } },
		async (request, reply) => {
			try {
				const found = requireJob(request.params.id)
				if (!isTerminal(found.state))
					throw new ScannerApiError(
						"Only ended jobs can be deleted",
						"SCANNER_JOB_NOT_TERMINAL",
						409,
					)
				records.delete(found.id)
				identifyJobs.delete(found.id)
				books.delete(found.id)
				return reply.code(204).send()
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	// --- Discoveries ---

	interface DiscoveryQuery {
		jobId?: string
		sourceId?: string
		protocol?: ScannerProtocol
		minConfidence?: ScannerConfidence
		freqMinHz?: number
		freqMaxHz?: number
		since?: string
		encrypted?: boolean
		q?: string
		identity?: string
		sort?: "lastSeen" | "frequency" | "confidence"
		cursor?: string
		limit?: number
		evidence?: "proven" | "weak" | "all"
		nearHz?: number
		toleranceHz?: number
	}

	/** WG12: the mock proves what it decoded; the rest is weak activity. */
	const withProof = (d: Discovery): Discovery => {
		if (d.confidence !== "decoded" || d.protocol === "carrier")
			return { ...d, evidenceLevel: "weak" }
		const id = d.identity
			? ` (${d.identity.kind === "dmr-cc" ? "CC" : ""}${d.identity.value}${d.metadata.talkgroups[0] ? `, TG ${d.metadata.talkgroups[0]}` : ""})`
			: ""
		const proof: ScannerProof = {
			kind: "decoded",
			protocol: d.protocol,
			transport: "live",
			at: d.lastSeenAt,
			observationId: `${d.id}-o`,
			tried: [d.protocol],
			unavailable: [],
			encrypted: d.encrypted,
			summary: `${SCANNER_PROOF_PROTOCOL_LABEL[d.protocol]} decoded${id}`,
			...(d.identity ? { identity: d.identity } : {}),
		}
		return { ...d, proof, evidenceLevel: "proven" }
	}

	const identityFromQuery = (raw: string): Identity => {
		const colon = raw.indexOf(":")
		const kind = colon < 0 ? "" : raw.slice(0, colon)
		const value = colon < 0 ? "" : raw.slice(colon + 1).trim()
		const fail = (message: string) =>
			new ZodError([{ code: "custom", path: ["identity"], message }])
		if (value.length === 0) throw fail("Identity value is empty")
		const known = IDENTITY_KINDS.find(k => k === kind)
		if (!known) throw fail("Identity kind is unknown")
		return { kind: known, value }
	}

	const parseCursor = (cursor: string | undefined): number => {
		if (cursor === undefined) return 0
		if (!/^\d{1,9}$/.test(cursor))
			throw new CoreError("Invalid discovery cursor", "SCANNER_INVALID_CURSOR")
		return Number(cursor)
	}

	app.get<{ Querystring: DiscoveryQuery }>(
		"/api/scanner/discoveries",
		{ schema: { querystring: discoveryQuerySchema } },
		async (request, reply) => {
			try {
				const f = request.query
				const identity =
					f.identity !== undefined ? identityFromQuery(f.identity) : undefined
				const since = f.since !== undefined ? Date.parse(f.since) : undefined
				const limit = Math.min(
					DISCOVERY_LIMIT_MAX,
					Math.max(1, Math.floor(f.limit ?? DISCOVERY_LIMIT_DEFAULT)),
				)
				const offset = parseCursor(f.cursor)
				const q = f.q?.toLowerCase()
				const identityValue = identity?.value.trim().toLowerCase()
				const min = f.minConfidence
				const items = [...discoveries.values()]
					.map(x => withProof(x.d))
					.filter(
						d =>
							(f.nearHz === undefined ||
								Math.abs(d.frequencyHz - f.nearHz) <=
									(f.toleranceHz ?? 6250)) &&
							(f.evidence === undefined ||
								f.evidence === "all" ||
								d.evidenceLevel === f.evidence) &&
							(f.jobId === undefined || d.jobIds.includes(f.jobId)) &&
							(f.sourceId === undefined || d.sourceIds.includes(f.sourceId)) &&
							(f.protocol === undefined || d.protocol === f.protocol) &&
							(min === undefined ||
								CONFIDENCE_RANK[d.confidence] >= CONFIDENCE_RANK[min]) &&
							(f.freqMinHz === undefined || d.frequencyHz >= f.freqMinHz) &&
							(f.freqMaxHz === undefined || d.frequencyHz <= f.freqMaxHz) &&
							(since === undefined || Date.parse(d.lastSeenAt) >= since) &&
							(f.encrypted === undefined || d.encrypted === f.encrypted) &&
							(identity === undefined ||
								(d.identity?.kind === identity.kind &&
									d.identity.value.trim().toLowerCase() === identityValue)) &&
							(q === undefined ||
								(d.operator?.label ?? "").toLowerCase().includes(q) ||
								(d.identity?.value ?? "").toLowerCase().includes(q)),
					)
				const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
				const byLastSeen = (a: Discovery, b: Discovery) =>
					text(b.lastSeenAt, a.lastSeenAt) || text(a.id, b.id)
				const sort = f.sort ?? "lastSeen"
				const near = f.nearHz
				items.sort(
					near !== undefined
						? (a, b) =>
								Math.abs(a.frequencyHz - near) -
									Math.abs(b.frequencyHz - near) || text(a.id, b.id)
						: sort === "frequency"
							? (a, b) => a.frequencyHz - b.frequencyHz || text(a.id, b.id)
							: sort === "confidence"
								? (a, b) =>
										CONFIDENCE_RANK[b.confidence] -
											CONFIDENCE_RANK[a.confidence] || byLastSeen(a, b)
								: byLastSeen,
				)
				return {
					items: items
						.slice(offset, offset + limit)
						.map(d => structuredClone(d)),
					nextCursor:
						offset + limit < items.length ? String(offset + limit) : null,
				}
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.get<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id",
		{ schema: { params: jobIdParamsSchema } },
		async (request, reply) => {
			const rec = discoveries.get(request.params.id)
			return rec
				? structuredClone(rec.d)
				: notFound(reply, "Discovery", request.params.id)
		},
	)

	const requireDiscovery = (id: string): DiscoveryRec => {
		const rec = discoveries.get(id)
		if (!rec)
			throw new ScannerApiError(
				`Discovery ${id} not found`,
				"SCANNER_DISCOVERY_NOT_FOUND",
				404,
			)
		return rec
	}

	app.get<{
		Params: { id: string }
		Querystring: { cursor?: string; limit?: number }
	}>(
		"/api/scanner/discoveries/:id/observations",
		{
			schema: {
				params: jobIdParamsSchema,
				querystring: observationsQuerySchema,
			},
		},
		async (request, reply) => {
			try {
				const rec = requireDiscovery(request.params.id)
				const all = [...rec.observations].reverse()
				const offset = parseCursor(request.query.cursor)
				const size = Math.min(
					500,
					Math.max(1, Math.floor(request.query.limit ?? 100)),
				)
				return {
					items: all.slice(offset, offset + size).map(o => structuredClone(o)),
					nextCursor: offset + size < all.length ? String(offset + size) : null,
				}
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.patch<{
		Params: { id: string }
		Body: { label?: string; notes?: string; lockout?: boolean; keep?: boolean }
	}>(
		"/api/scanner/discoveries/:id",
		{ schema: { params: jobIdParamsSchema, body: discoveryPatchSchema } },
		async (request, reply) => {
			try {
				const { d } = requireDiscovery(request.params.id)
				const patch = request.body
				const operator: NonNullable<Discovery["operator"]> = {
					...(d.operator ?? {}),
				}
				if (patch.label !== undefined) operator.label = patch.label
				if (patch.notes !== undefined) operator.notes = patch.notes
				if (patch.lockout !== undefined) operator.lockout = patch.lockout
				if (patch.keep !== undefined) operator.keep = patch.keep
				d.operator = operator
				emitDiscovery("updated", d)
				if (patch.lockout !== undefined) replanLockouts()
				return structuredClone(d)
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.delete<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id",
		{ schema: { params: discoveryIdParamsSchema } },
		async (request, reply) => {
			const rec = discoveries.get(request.params.id)
			if (!rec) return notFound(reply, "Discovery", request.params.id)
			discoveries.delete(rec.d.id)
			emitDiscovery("deleted", rec.d)
			if (rec.d.operator?.lockout === true) replanLockouts()
			return reply.code(204).send()
		},
	)

	app.post<{ Params: { id: string } }>(
		"/api/scanner/discoveries/:id/listen",
		{ schema: { params: jobIdParamsSchema } },
		async (request, reply) => {
			try {
				const { d } = requireDiscovery(request.params.id)
				if (d.operator?.lockout)
					throw new ScannerApiError(
						"The discovery is locked out",
						"SCANNER_DISCOVERY_LOCKED_OUT",
						409,
					)
				const status = ctx.liveStatus()
				if (!status.config.enabled)
					throw new ScannerApiError(
						"Live audio is not configured",
						"LIVE_AUDIO_UNAVAILABLE",
						409,
					)
				const offsetHz = Math.round(
					d.frequencyHz + d.measuredOffsetHz - tuner.frequency,
				)
				const usableHalfSpanHz = (tuner.sampleRate * USABLE_FRACTION) / 2
				if (Math.abs(offsetHz) > usableHalfSpanHz)
					throw new ScannerApiError(
						"The discovery is outside the current window",
						"OUT_OF_WINDOW",
						409,
						{ offsetHz, usableHalfSpanHz },
					)
				ctx.liveListen(offsetHz)
				const after = ctx.liveStatus()
				const result: ScannerListenResult = {
					mode: "live-audio",
					sourceId,
					frequencyHz: d.frequencyHz,
					offsetHz,
					httpUrl: after.httpUrl,
					wavUrl: after.wavUrl ?? "",
				}
				return result
			} catch (err) {
				return sendError(reply, err)
			}
		},
	)

	app.get("/api/scanner/captures", async () => [])

	return {
		identifyJobs,
		operatorWrite() {
			for (const r of records.values()) {
				if (r.spec.mode !== "sweep" || isTerminal(r.state)) continue
				if (isActive(r.state) && r.lease) {
					pauseFor(r, "preempted-operator", false)
					r.resumeAt = autoResumeAt(r)
					emitJob(r)
					emitProgress(r)
				} else if (
					r.state === "paused" &&
					(r.reason === "preempted-operator" || r.reason === "preempted-relay")
				) {
					// the operator is still busy: the idle timer starts again
					r.resumeAt = autoResumeAt(r)
					touch(r)
					emitJob(r)
				} else if (r.state === "paused" && r.reason === "operator" && r.lease) {
					// an operator pause keeps its reason but loses the lease (no restore)
					r.lease = false
					touch(r)
				}
			}
			ensurePassive()
		},
		sweepHolder() {
			return leaseHolder()?.id ?? null
		},
		overloadHint(blankedPercent) {
			overloadBlanked = blankedPercent
			emitStatus()
		},
		identified(jobId, result) {
			if (result.measurements.source !== "track") return
			const signal = MOCK_SIGNALS.find(
				s => s.hz === result.measurements.centreHz,
			)
			if (!signal) return
			const o = observe(jobId, signal, undefined)
			const rec = discoveries.get(o.discoveryId)
			if (!rec) return
			const d = rec.d
			const before = d.confidence
			if (CONFIDENCE_RANK[result.confidence] > CONFIDENCE_RANK[d.confidence])
				d.confidence = result.confidence
			if (
				result.protocol &&
				(d.protocol === "unknown" || result.confidence === "decoded")
			) {
				d.protocol = result.protocol
				d.family = PROTOCOL_FAMILY[result.protocol]
			}
			d.class = result.measurements.class
			if (result.identity) d.identity = { ...result.identity }
			const m = result.metadata
			const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])]
			d.metadata = {
				talkgroups: merge(d.metadata.talkgroups, m.talkgroups),
				sources: merge(d.metadata.sources, m.sources),
				slots: [...new Set([...d.metadata.slots, ...m.slots])],
				callsigns: merge(d.metadata.callsigns, m.callsigns),
				capcodes: merge(d.metadata.capcodes, m.capcodes),
				ismModels: merge(d.metadata.ismModels, m.ismModels),
				...(m.ctcssHz !== undefined
					? { ctcssHz: m.ctcssHz }
					: d.metadata.ctcssHz !== undefined
						? { ctcssHz: d.metadata.ctcssHz }
						: {}),
			}
			if (d.confidence === "decoded") delete d.undecodedReason
			const hit = books.get(jobId)?.hits.get(d.id)
			emitDiscovery(
				CONFIDENCE_RANK[d.confidence] > CONFIDENCE_RANK[before]
					? "upgraded"
					: "updated",
				d,
				hit ? [{ ...hit }] : undefined,
			)
			const obs = rec.observations.find(x => x.id === o.observationId)
			if (obs) {
				obs.endedAt = iso(Date.now())
				obs.endReason = "quiet"
			}
			offer(`activity:${o.observationId}`, "scanner:activity", {
				sourceId,
				observationId: o.observationId,
				discoveryId: d.id,
				jobIds: [jobId],
				frequencyHz: d.frequencyHz,
				active: false,
				peakDbfs: round1(o.peak),
			} satisfies ScannerActivityEventData)
			result.discoveryId = d.id
			result.observationId = o.observationId
		},
	}
}
