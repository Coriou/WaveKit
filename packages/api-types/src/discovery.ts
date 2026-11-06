/** What a fresh client reads to learn the API: the route index and the closed value lists. */
import type { ActivityCategory, ActivityKind } from "./activity.js"
import type { ScannerPassiveReason } from "./agent-status.js"
import type {
	DecoderInputState,
	DecoderReceptionHint,
	DecoderVerdictCode,
} from "./decoders.js"
import type { RecordingInventoryKind } from "./recordings.js"
import type {
	Identity,
	IdentityKind,
	ScanJob,
	ScanJobSpec,
	ScannerClass,
	ScannerConfidence,
	ScannerEvidenceLevel,
	ScannerProtocol,
	ScannerRecorderDecision,
} from "./scanner.js"
import type { SourceDeviceFacts, SourceVerdictCode } from "./sources.js"
import type {
	TunerChangeActor,
	TunerChangeField,
	TunerChangeReason,
	TunerState,
} from "./tuner.js"

/** Swagger UI; the OpenAPI document is `OPENAPI_DOCUMENT_PATH`. */
export const OPENAPI_UI_PATH = "/docs"
export const OPENAPI_DOCUMENT_PATH = `${OPENAPI_UI_PATH}/json`
export const API_ENUMS_PATH = "/api/enums"

export interface ApiRouteIndexEntry {
	method: string
	path: string
	summary: string | null
	tags: string[]
}

/** GET /api */
export interface ApiRouteIndex {
	/** The OpenAPI 3 document: every route's parameters, bounds and bodies. */
	openapi: typeof OPENAPI_DOCUMENT_PATH
	/** The accepted values of the closed lists (`ApiEnums`). */
	enums: typeof API_ENUMS_PATH
	routes: ApiRouteIndexEntry[]
}

/** `view` of GET /api/scanner/discoveries; absent reads `full`. */
export const DISCOVERY_VIEWS = ["full", "compact"] as const
export type DiscoveryView = (typeof DISCOVERY_VIEWS)[number]

/** `view` of GET /api/scanner/jobs; absent reads `full`. */
export const SCAN_JOB_VIEWS = ["full", "compact"] as const
export type ScanJobView = (typeof SCAN_JOB_VIEWS)[number]

/**
 * One row of GET /api/scanner/discoveries?view=compact. Each field has the meaning and the value
 * of the same name on the full row, except `recorder`, which holds only the last decision.
 */
export interface DiscoveryCompact {
	id: string
	frequencyHz: number
	/** The classifier's reading of the signal; `unknown` until it has one. Never null. */
	class: ScannerClass
	/** The published protocol; `unknown` on a weak record. Never null. */
	protocol: ScannerProtocol
	/** The published confidence. Never null. */
	confidence: ScannerConfidence
	/** `proven` when a proof is set, otherwise `weak`. */
	evidenceLevel: ScannerEvidenceLevel
	/** Null: no identity is published (none decoded, or decoded content not yet checked). */
	identity: Identity | null
	lastSeenAt: string
	/** Null: the recorder remembers no decision about the discovery. */
	recorder: { last: { code: ScannerRecorderDecision; at: string } } | null
}

/** GET /api/scanner/discoveries?view=compact */
export interface DiscoveryCompactPage {
	items: DiscoveryCompact[]
	nextCursor: string | null
	storeEpoch: string
	storeRevision: number
}

/** One row of GET /api/scanner/jobs?view=compact: a job without its plan and progress. */
export interface ScanJobCompact {
	id: string
	name: string | null
	kind: ScanJob["spec"]["kind"]
	state: ScanJob["state"]
	/** Null: the job has no pause or failure reason. */
	reason: string | null
	sourceId: string
	updatedAt: string
}

/** The compact row of a full job DTO. */
export function scanJobCompact(job: ScanJob): ScanJobCompact {
	return {
		id: job.id,
		name: job.name,
		kind: job.spec.kind,
		state: job.state,
		reason: job.reason ?? null,
		sourceId: job.spec.sourceId,
		updatedAt: job.updatedAt,
	}
}

/** GET /api/enums: the same lists the routes validate against. */
export interface ApiEnums {
	scanner: {
		protocols: readonly ScannerProtocol[]
		identityKinds: readonly IdentityKind[]
		confidences: readonly ScannerConfidence[]
		jobModes: readonly NonNullable<ScanJobSpec["mode"]>[]
		jobKinds: readonly NonNullable<ScanJobSpec["kind"]>[]
		sensitivities: readonly NonNullable<ScanJobSpec["sensitivity"]>[]
		discoveryViews: readonly DiscoveryView[]
		jobViews: readonly ScanJobView[]
		recorderDecisions: readonly ScannerRecorderDecision[]
		passiveReasons: readonly ScannerPassiveReason[]
	}
	activity: {
		kinds: readonly ActivityKind[]
		categories: readonly ActivityCategory[]
	}
	tuner: {
		gainModes: readonly TunerState["gainMode"][]
		directSamplingModes: readonly TunerState["directSampling"][]
		controlModes: readonly TunerState["controlMode"][]
		changeActors: readonly TunerChangeActor[]
		changeReasons: readonly TunerChangeReason[]
		changeFields: readonly TunerChangeField[]
	}
	sources: {
		verdictCodes: readonly SourceVerdictCode[]
		deviceFacts: readonly SourceDeviceFacts[]
	}
	decoders: {
		verdictCodes: readonly DecoderVerdictCode[]
		receptionHints: readonly DecoderReceptionHint[]
		inputStates: readonly DecoderInputState[]
	}
	recordings: {
		kinds: readonly RecordingInventoryKind[]
	}
}
