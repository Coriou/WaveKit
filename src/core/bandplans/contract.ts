/**
 * Frozen BP1 in-core contract (docs/specs/band-plans/design.md). Lanes code against
 * these signatures; wire DTOs and Zod schemas live in packages/api-types/src/bandplans.ts.
 * This file holds types and the error class only: no I/O, no scanner mutation.
 */
import { BANDPLANS_ERROR_DEFINITIONS } from "@wavekit/api-types"
import type {
	Band,
	BandEdit,
	BandEditField,
	BandPlanContext,
	BandPlanMutation,
	BandPlanPack,
	BandPlanPackView,
	BandPlansChangedEventData,
	BandPlansErrorCode,
	BandPlanStackView,
	BandPlanState,
	BandRegion,
	BuiltinScanPreset,
	DisplayGroup,
	ExpectedToken,
	ImportGroupRule,
	ImportPreview,
	ImportSkipReason,
	PlanStackEntry,
	ResolvedBandPlanView,
	ScanJobSpec,
	ScanPreset,
	ScanPresetIssue,
	ScanPresetJobView,
	ScanPresetListView,
	StoredBand,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"

export class BandPlansError extends WaveKitError {
	readonly statusCode: number
	readonly current?: ExpectedToken
	constructor(code: BandPlansErrorCode, current?: ExpectedToken) {
		super(BANDPLANS_ERROR_DEFINITIONS[code][1], code)
		this.name = "BandPlansError"
		this.statusCode = BANDPLANS_ERROR_DEFINITIONS[code][0]
		if (current) this.current = { ...current }
	}
}

// --- Lane A: builtin-packs.ts and resolve.ts (pure) ---

/** builtin-packs.ts: one read-only pack per BandRegion, projected from bandplansFor(region). */
export type ProjectBuiltinPacks = () => readonly BandPlanPack[]
/** builtin-packs.ts: `builtin-<region lowercase>`. */
export type BuiltinPackIdFor = (region: BandRegion) => string
/** builtin-packs.ts: fixed display group by scanner plan id; unknown ids map to "other". */
export type BuiltinGroupFor = (bandplanId: string) => DisplayGroup

export interface ResolverInput {
	/** Every addressable non-operator pack (built-in and imported), keyed by id. */
	readonly packs: ReadonlyMap<string, BandPlanPack>
	/** Effective stack (persisted or default); disabled and unknown entries are skipped. */
	readonly stack: readonly PlanStackEntry[]
	readonly operatorBands: readonly Band[]
	readonly edits: readonly BandEdit[]
}
export interface ResolvedBandPlan {
	readonly bands: ResolvedBandPlanView["bands"]
	readonly shadowed: ResolvedBandPlanView["shadowed"]
	readonly hidden: ResolvedBandPlanView["hidden"]
	readonly orphanedEdits: BandPlanStackView["orphanedEdits"]
}
/** resolve.ts: total, deterministic, never mutates its input. */
export type ResolveBandPlans = (input: ResolverInput) => ResolvedBandPlan
/** resolve.ts: one band with one edit applied; also reports the edited fields and issues. */
export type ApplyBandEdit = (
	band: Band,
	edit: BandEdit | undefined,
	siblingIds: ReadonlySet<string>,
) => {
	readonly band: Band | null /* null when hidden */
	readonly editedFields: readonly BandEditField[]
	readonly issues: readonly ("edge-conflict" | "dangling-parent")[]
}

// --- Lane A: domain.ts (pure CAS + transition); Lane B: storage.ts and service.ts ---

export interface DomainContext {
	readonly now: () => string
	readonly uuid: () => string
	/** 12 lowercase hex digits for `imported-*` pack and `op-*` band ids. */
	readonly randomHex12: () => string
	readonly region: BandRegion
}
export interface TransitionResult {
	readonly changed: boolean
	readonly state: BandPlanState
	readonly createdId: string | null
}
/** domain.ts: pure CAS + transition; throws BandPlansError. `commit-import` receives a parsed preview. */
export type BandPlanTransition = (
	state: BandPlanState,
	mutation: BandPlanMutation,
	context: DomainContext,
	parsedImport: ParsedImport | null,
) => TransitionResult

export type BandPlanDelivery = "sent" | "failed" | "unmounted" | "not-needed"
export interface BandPlanMutationResult {
	readonly changed: boolean
	readonly view: BandPlanStackView
	readonly createdId: string | null
	/** Internal transport outcome, separate from durable mutation success. */
	readonly delivery: BandPlanDelivery
}

/** Fixed tokens for a store that cannot be served. Never file content or paths. */
export type BandPlanStoreUnavailableReason =
	| "lock-held"
	| "invalid"
	| "oversized"
	| "permissions"
	| "io"

export interface BandPlanServiceOptions {
	/** Existing durable local stateDir; the service owns `<stateDir>/bandplans/`. */
	readonly stateDir: string
	readonly context: BandPlanContext
	/** True only when composition mounts mutation routes (protected mode). */
	readonly writable: boolean
	/** Synchronous change notice after a durable changed commit; never awaited. */
	readonly onCommit?: (event: BandPlansChangedEventData) => undefined
	/**
	 * Called once when open cannot use the store, and once when a post-rename
	 * failure latches a store that had opened. Listener failures are ignored.
	 */
	readonly onStoreUnavailable?: (
		reason: BandPlanStoreUnavailableReason,
	) => void
	/** Test seams. */
	readonly domain?: Partial<Omit<DomainContext, "region">>
	readonly storageStage?: (stage: string) => void | Promise<void>
}

/**
 * The single authority routes code against. Reads never throw for storage reasons:
 * with an unavailable store they return `store: {state:"unavailable"}`, the default
 * stack and no stored layers. Mutations then reject BANDPLANS_UNAVAILABLE.
 */
export interface BandPlanService {
	view(): BandPlanStackView
	resolved(): ResolvedBandPlanView
	/** Throws BANDPLANS_NOT_FOUND for an unknown or operator pack id. */
	pack(packId: string): BandPlanPackView
	presets(): ScanPresetListView
	/** Throws BANDPLANS_NOT_FOUND for an unknown preset id. */
	presetJob(presetId: string): ScanPresetJobView
	/** Validates and parses an ImportPreviewRequest synchronously; persists nothing. */
	previewImport(request: unknown): ImportPreview
	/** Validates `input` as BandPlanMutation before admission; bounded serialized queue. */
	mutate(input: unknown): Promise<BandPlanMutationResult>
	/** Rejects new work, drains admitted work, releases the store lock. Idempotent. */
	close(): Promise<void>
}
/** service.ts exports `openBandPlanService: OpenBandPlanService`; it resolves even if storage fails. */
export type OpenBandPlanService = (
	options: BandPlanServiceOptions,
) => Promise<BandPlanService>

// --- Lane C: import/sdrpp.ts and import/group-map.ts (pure) ---

export interface GroupMapping {
	readonly group: DisplayGroup
	readonly rule: ImportGroupRule
}
/** group-map.ts: total; overrides win, then the type table, then name keywords, else "other". */
export type MapImportGroup = (
	sourceType: string,
	bandName: string,
	overrides: ReadonlyMap<string, DisplayGroup>,
) => GroupMapping

export interface SdrppParseOptions {
	readonly fileName: string
	readonly overrides: ReadonlyMap<string, DisplayGroup>
}
export interface ParsedImport {
	readonly preview: ImportPreview
	/** Persistable bands (provenance imported, scan null, colourHint kept). */
	readonly bands: readonly StoredBand[]
}
export type SdrppFailureReason =
	| ImportSkipReason
	| "encoding"
	| "json"
	| "shape"
	| "empty"
	| "row-limit"
	| "too-large"
export interface SdrppParseFailure {
	readonly ok: false
	readonly code: "BANDPLANS_IMPORT_TOO_LARGE" | "BANDPLANS_IMPORT_INVALID"
	/** Generic, bounded, never echoes file content. */
	readonly reason: SdrppFailureReason
}
export type SdrppParseResult =
	| { readonly ok: true; readonly value: ParsedImport }
	| SdrppParseFailure
/** sdrpp.ts: total function on bytes; never throws, size-checked before decoding. */
export type ParseSdrppBandPlan = (
	bytes: Uint8Array,
	options: SdrppParseOptions,
) => SdrppParseResult

// --- Lane D: presets.ts (pure) ---

/** presets.ts: one preset per bandplansFor(region) plan, then fixed combinations of existing ids. */
export type BuiltinPresetsFor = (
	region: BandRegion,
) => readonly BuiltinScanPreset[]
/** presets.ts: unresolved bandplan ids in `region` (always empty for built-ins). */
export type PresetIssuesFor = (
	preset: ScanPreset,
	region: BandRegion,
) => readonly ScanPresetIssue[]
/** presets.ts: omits null / [] fields; output satisfies scanJobSpecSchema. */
export type PresetToJobSpec = (preset: ScanPreset) => ScanJobSpec
