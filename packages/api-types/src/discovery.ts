/** What a fresh client reads to learn the API: the route index and the closed value lists. */
import type { ActivityCategory, ActivityKind } from "./activity.js"
import type { RecordingInventoryKind } from "./recordings.js"
import type {
	IdentityKind,
	ScanJobSpec,
	ScannerConfidence,
	ScannerProtocol,
} from "./scanner.js"
import type { TunerState } from "./tuner.js"

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

/** GET /api/enums: the same lists the routes validate against. */
export interface ApiEnums {
	scanner: {
		protocols: readonly ScannerProtocol[]
		identityKinds: readonly IdentityKind[]
		confidences: readonly ScannerConfidence[]
		jobModes: readonly NonNullable<ScanJobSpec["mode"]>[]
		jobKinds: readonly NonNullable<ScanJobSpec["kind"]>[]
		sensitivities: readonly NonNullable<ScanJobSpec["sensitivity"]>[]
	}
	activity: {
		kinds: readonly ActivityKind[]
		categories: readonly ActivityCategory[]
	}
	tuner: {
		gainModes: readonly TunerState["gainMode"][]
		directSamplingModes: readonly TunerState["directSampling"][]
		controlModes: readonly TunerState["controlMode"][]
	}
	recordings: {
		kinds: readonly RecordingInventoryKind[]
	}
}
