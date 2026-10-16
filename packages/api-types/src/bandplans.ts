/**
 * Band plans and scan presets (docs/specs/band-plans). Frozen BP1 contract.
 *
 * Request bodies and persisted state are Zod schemas (the operator-data pattern);
 * read views are plain readonly interfaces built by core. Nullable fields are
 * serialized as null, never omitted. Nothing here tunes, scans or changes the
 * scanner's built-in bandplans: BP1 is display, editing, import and presets only.
 */
import { z } from "zod"
import type { BandRegion } from "./decoders.js"
import {
	expectedTokenSchema,
	modeSchema,
	revisionSchema,
	timestampSchema,
	uuidSchema,
} from "./operator-data.js"
import type { ExpectedToken } from "./operator-data.js"
import type { ScanJobSpec, ScanRange, ScannerProtocol } from "./scanner.js"

// --- Limits (engineering bounds, not RF facts) ---

export const BANDPLANS_LIMITS = Object.freeze({
	schemaVersion: 1,
	/** Persisted state.json, compact UTF-8. */
	stateBytes: 4 * 1024 * 1024,
	/** Every JSON request except import preview/commit. */
	requestBytes: 64 * 1024,
	/** Decoded SDR++ file bytes. */
	importFileBytes: 1024 * 1024,
	/** Import preview/commit JSON body (base64 file plus fields). */
	importRequestBytes: 1536 * 1024,
	/** SDR++ `bands` array entries examined; more rejects the file. */
	importRows: 4096,
	importedPacks: 8,
	bandsPerPack: 512,
	operatorBands: 256,
	channelsPerBand: 128,
	aliasesPerChannel: 8,
	edits: 1024,
	stackEntries: 16,
	presets: 64,
	presetRanges: 64,
	presetBandplans: 16,
	presetExclusions: 256,
	groupOverrides: 64,
	waitingTransactions: 16,
	frequencyHzMax: 100_000_000_000,
	revision: Number.MAX_SAFE_INTEGER,
})

// --- Identifiers and primitives ---

export const BUILTIN_PACK_IDS = [
	"builtin-eu",
	"builtin-us",
	"builtin-ca",
	"builtin-au",
	"builtin-nz",
	"builtin-jp",
	"builtin-cn",
] as const
export type BuiltinPackId = (typeof BUILTIN_PACK_IDS)[number]
/** The operator layer always sits above the ordered stack and is not a stack entry. */
export const OPERATOR_PACK_ID = "operator"

const slug = /^[a-z][a-z0-9-]{0,63}$/
export const bandIdSchema = z.string().regex(slug)
export const builtinPackIdSchema = z.enum(BUILTIN_PACK_IDS)
/** Server-assigned: `imported-` plus 12 lowercase hex digits. */
export const importedPackIdSchema = z.string().regex(/^imported-[0-9a-f]{12}$/)
export const stackPackIdSchema = z.union([
	builtinPackIdSchema,
	importedPackIdSchema,
])
/** Any addressable pack, including the operator layer. */
export const packIdSchema = z.union([
	stackPackIdSchema,
	z.literal(OPERATOR_PACK_ID),
])
export const bandChannelIdSchema = z.string().regex(slug)
/** Same shape as scanner bandplan ids (`airband`, `pmr446`). */
export const bandplanIdSchema = z.string().regex(slug)
export const bandHzSchema = z
	.number()
	.int()
	.min(1)
	.max(BANDPLANS_LIMITS.frequencyHzMax)

/** Trimmed, 1..max Unicode code points, no control or lone surrogate characters. */
export function bandPlanTextSchema(max: number) {
	return z
		.string()
		.refine(
			value => !/[\p{Cc}\p{Cs}]/u.test(value),
			"Control characters or invalid Unicode",
		)
		.refine(value => value === value.trim(), "Must be trimmed")
		.refine(
			value => [...value].length >= 1 && [...value].length <= max,
			"Invalid code-point length",
		)
}
export const bandChannelAliasSchema = z
	.string()
	.regex(/^[\x21-\x7e](?:[\x20-\x7e]{0,30}[\x21-\x7e])?$/)
export const bandColourHintSchema = z.string().regex(/^#[0-9a-f]{6}$/)

export const DISPLAY_GROUPS = [
	"marine",
	"air",
	"ism-srd",
	"pagers",
	"personal-radio",
	"amateur",
	"land-mobile",
	"broadcast",
	"other",
] as const
export const displayGroupSchema = z.enum(DISPLAY_GROUPS)
export type DisplayGroup = z.infer<typeof displayGroupSchema>

/** Optional link to a regional display registry row. BP1 stores it and derives nothing. */
export const bandRegistryRefSchema = z
	.object({ familyId: bandIdSchema, rowId: bandIdSchema })
	.strict()
export type BandRegistryRef = z.infer<typeof bandRegistryRefSchema>

export const bandSkipSchema = z
	.object({ reason: bandPlanTextSchema(80) })
	.strict()
export type BandSkip = z.infer<typeof bandSkipSchema>

export const bandChannelSchema = z
	.object({
		id: bandChannelIdSchema,
		name: bandPlanTextSchema(40),
		frequencyHz: bandHzSchema,
		aliases: z
			.array(bandChannelAliasSchema)
			.max(BANDPLANS_LIMITS.aliasesPerChannel),
		registryRef: bandRegistryRefSchema.nullable(),
	})
	.strict()
export type BandChannel = z.infer<typeof bandChannelSchema>

// --- Provenance ---

/**
 * Import file formats. WG5 (web-gaps-5 req 7.1) adds SDR# `BandPlan.xml` and Gqrx
 * `bandplan.csv`; a server advertises the formats it parses in `capabilities.importFormats`.
 */
export const BANDPLAN_IMPORT_FORMATS = [
	"sdrpp-json",
	"sdrsharp-xml",
	"gqrx-csv",
] as const
export type BandPlanImportFormat = (typeof BANDPLAN_IMPORT_FORMATS)[number]

export interface BandPlanCitation {
	readonly title: string
	readonly url: string
}
export const importedProvenanceSchema = z
	.object({
		kind: z.literal("imported"),
		/** Imported data is always "community, unverified"; "verified" needs a registry link. */
		trust: z.literal("community-unverified"),
		/** WG5: the imported file's format; state written before WG5 holds "sdrpp-json". */
		format: z.enum(BANDPLAN_IMPORT_FORMATS),
		sourceName: bandPlanTextSchema(128),
		author: bandPlanTextSchema(80).nullable(),
		licence: bandPlanTextSchema(80).nullable(),
		importedAt: timestampSchema,
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		/** WG6: the https URL the file was fetched from; absent for uploads and pre-WG6 state. */
		sourceUrl: z.lazy(() => bandPlanImportUrlSchema).optional(),
		/**
		 * WG7 (web-gaps-7 req 10.2): the group overrides the import was committed with, applied
		 * again by the update check; absent for imports without overrides and pre-WG7 state.
		 */
		groupOverrides: z
			.lazy(() =>
				z.array(importGroupOverrideSchema).max(BANDPLANS_LIMITS.groupOverrides),
			)
			.optional(),
	})
	.strict()
export type ImportedProvenance = z.infer<typeof importedProvenanceSchema>
/** Pack (layer) provenance. */
export type PlanProvenance =
	| { readonly kind: "builtin" }
	| ImportedProvenance
	| { readonly kind: "operator" }
/** Band provenance; imported bands defer to their pack's ImportedProvenance. */
export interface CitedBuiltinProvenance {
	readonly kind: "builtin-cited"
	readonly citations: readonly BandPlanCitation[]
}
export type BandProvenance =
	| CitedBuiltinProvenance
	| { readonly kind: "builtin" }
	| { readonly kind: "imported" }
	| { readonly kind: "operator" }

// --- Bands and packs ---

/** Read-only scanner reference, present only on built-in bands (exact copy of the plan ranges). */
export interface BandScan {
	readonly bandplanId: string
	readonly ranges: readonly ScanRange[]
}
/** Inclusive integer-Hz edges, startHz < endHz. Tuning hints are advisory and nullable. */
export interface Band {
	readonly id: string
	readonly name: string
	readonly startHz: number
	readonly endHz: number
	readonly group: DisplayGroup
	readonly mode: z.infer<typeof modeSchema> | null
	readonly bandwidthHz: number | null
	readonly stepHz: number | null
	readonly skip: BandSkip | null
	readonly channels: readonly BandChannel[]
	/** Band id in the same pack; nesting is display only. */
	readonly parentId: string | null
	readonly colourHint: string | null
	readonly registryRef: BandRegistryRef | null
	readonly scan: BandScan | null
	readonly provenance: BandProvenance
}

const bandFields = {
	name: bandPlanTextSchema(80),
	startHz: bandHzSchema,
	endHz: bandHzSchema,
	group: displayGroupSchema,
	mode: modeSchema.nullable(),
	bandwidthHz: z.number().int().min(1).max(10_000_000).nullable(),
	stepHz: z.number().positive().max(10_000_000).nullable(),
	skip: bandSkipSchema.nullable(),
	channels: z.array(bandChannelSchema).max(BANDPLANS_LIMITS.channelsPerBand),
	parentId: bandIdSchema.nullable(),
	colourHint: bandColourHintSchema.nullable(),
	registryRef: bandRegistryRefSchema.nullable(),
}
function checkBand(
	value: { startHz: number; endHz: number; channels: readonly BandChannel[] },
	ctx: z.RefinementCtx,
) {
	if (value.startHz >= value.endHz)
		ctx.addIssue({ code: "custom", path: ["endHz"], message: "Empty band" })
	const ids = new Set(value.channels.map(channel => channel.id))
	if (ids.size !== value.channels.length)
		ctx.addIssue({
			code: "custom",
			path: ["channels"],
			message: "Duplicate channel id",
		})
}
/** Operator band create/replace body; the server assigns `id`, `scan: null` and provenance. */
export const bandInputSchema = z
	.object(bandFields)
	.strict()
	.superRefine(checkBand)
export type BandInput = z.infer<typeof bandInputSchema>
/** Persisted imported or operator band (built-in bands are never persisted). */
export const storedBandSchema = z
	.object({
		id: bandIdSchema,
		...bandFields,
		scan: z.null(),
		provenance: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("imported") }).strict(),
			z.object({ kind: z.literal("operator") }).strict(),
		]),
	})
	.strict()
	.superRefine(checkBand)
export type StoredBand = z.infer<typeof storedBandSchema>

export interface BandPlanPack {
	readonly id: string
	readonly kind: "builtin" | "imported"
	readonly name: string
	/** Built-in packs: the BandRegion they project. Imported: null. */
	readonly region: BandRegion | null
	readonly provenance: PlanProvenance
	readonly bands: readonly Band[]
}

export const importedPackSchema = z
	.object({
		id: importedPackIdSchema,
		name: bandPlanTextSchema(80),
		provenance: importedProvenanceSchema,
		bands: z.array(storedBandSchema).max(BANDPLANS_LIMITS.bandsPerPack),
	})
	.strict()
export type ImportedPack = z.infer<typeof importedPackSchema>

// --- Stack and edits ---

export const planStackEntrySchema = z
	.object({ packId: stackPackIdSchema, enabled: z.boolean() })
	.strict()
export type PlanStackEntry = z.infer<typeof planStackEntrySchema>
/** Index 0 is the highest layer below the operator layer. Pack ids are unique. */
export const planStackSchema = z
	.array(planStackEntrySchema)
	.max(BANDPLANS_LIMITS.stackEntries)
	.refine(
		entries => new Set(entries.map(e => e.packId)).size === entries.length,
		"Duplicate stack pack id",
	)

export const BAND_EDIT_FIELDS = [
	"name",
	"startHz",
	"endHz",
	"group",
	"mode",
	"bandwidthHz",
	"stepHz",
	"skip",
	"channels",
	"parentId",
	"colourHint",
	"registryRef",
	"hidden",
] as const
export const bandEditFieldSchema = z.enum(BAND_EDIT_FIELDS)
export type BandEditField = z.infer<typeof bandEditFieldSchema>
/** Field-level overrides. Present keys override; absent keys fall through to the pack. */
export const bandEditFieldsSchema = z
	.object({ ...bandFields, hidden: z.boolean() })
	.partial()
	.strict()
	.superRefine((value, ctx) => {
		for (const key of BAND_EDIT_FIELDS)
			if (Object.hasOwn(value, key) && value[key] === undefined)
				ctx.addIssue({
					code: "custom",
					path: [key],
					message: "Explicit undefined is not an edit",
				})
	})
export type BandEditFields = z.infer<typeof bandEditFieldsSchema>
/** Edits target built-in or imported bands; operator bands are edited directly. */
export const bandEditSchema = z
	.object({
		packId: stackPackIdSchema,
		bandId: bandIdSchema,
		set: bandEditFieldsSchema.refine(
			value => Object.keys(value).length > 0,
			"A stored edit has at least one field",
		),
		updatedAt: timestampSchema,
	})
	.strict()
export type BandEdit = z.infer<typeof bandEditSchema>

// --- Scan presets ---

/** Canonical full-form range: [] is equivalent to the scanner's absent field. */
export const presetRangeSchema = z
	.object({
		startHz: bandHzSchema,
		endHz: bandHzSchema,
		rasters: z
			.array(
				z
					.object({
						spacingHz: z.number().positive().max(10_000_000),
						firstChannelHz: z
							.number()
							.min(0)
							.max(BANDPLANS_LIMITS.frequencyHzMax),
					})
					.strict(),
			)
			.max(8),
		obwHz: z.array(z.number().positive().max(10_000_000)).max(8),
		protocols: z.array(z.custom<ScannerProtocol>(isScannerProtocol)).max(21),
	})
	.strict()
	.refine(value => value.startHz < value.endHz, "Empty range")
export type PresetRange = z.infer<typeof presetRangeSchema>

export const BANDPLAN_SCANNER_PROTOCOLS = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	"digital-unknown",
	"carrier",
	"unknown",
	"ais",
	"acars",
	"vdl2",
	"lora",
] as const satisfies readonly ScannerProtocol[]
// Compile-time completeness: every ScannerProtocol is listed.
const protocolCompleteness: Exclude<
	ScannerProtocol,
	(typeof BANDPLAN_SCANNER_PROTOCOLS)[number]
> extends never
	? true
	: never = true
void protocolCompleteness
function isScannerProtocol(value: unknown): value is ScannerProtocol {
	return (
		typeof value === "string" &&
		(BANDPLAN_SCANNER_PROTOCOLS as readonly string[]).includes(value)
	)
}

/**
 * Closed subset of ScanJobSpec. Every key is present; null / [] means "not set" and
 * is omitted by presetToJobSpec. At least one bandplan or range is required.
 */
export const scanPresetJobSchema = z
	.object({
		mode: z.enum(["in-window", "sweep", "auto"]).nullable(),
		bandplans: z.array(bandplanIdSchema).max(BANDPLANS_LIMITS.presetBandplans),
		ranges: z.array(presetRangeSchema).max(BANDPLANS_LIMITS.presetRanges),
		exclusions: z
			.array(
				z
					.object({
						startHz: bandHzSchema,
						endHz: bandHzSchema,
						reason: bandPlanTextSchema(200).nullable(),
					})
					.strict()
					.refine(value => value.startHz <= value.endHz, "Inverted exclusion"),
			)
			.max(BANDPLANS_LIMITS.presetExclusions),
		protocols: z.array(z.custom<ScannerProtocol>(isScannerProtocol)).max(21),
		sensitivity: z.enum(["low", "normal", "high"]).nullable(),
		thresholdDb: z.number().min(0).max(40).nullable(),
		fftSize: z
			.union([
				z.literal(512),
				z.literal(1024),
				z.literal(2048),
				z.literal(4096),
				z.literal(8192),
				z.literal(16384),
			])
			.nullable(),
		integrationMs: z.number().min(5).max(1000).nullable(),
		dwellMs: z.number().min(10).max(600_000).nullable(),
		settleMs: z.number().min(0).max(10_000).nullable(),
	})
	.strict()
	.refine(
		value => value.bandplans.length + value.ranges.length > 0,
		"A preset needs a bandplan or a range",
	)
	.refine(
		value => new Set(value.bandplans).size === value.bandplans.length,
		"Duplicate bandplan id",
	)
export type ScanPresetJob = z.infer<typeof scanPresetJobSchema>

export const scanPresetInputSchema = z
	.object({ name: bandPlanTextSchema(80), job: scanPresetJobSchema })
	.strict()
export type ScanPresetInput = z.infer<typeof scanPresetInputSchema>
export const operatorScanPresetSchema = z
	.object({
		kind: z.literal("operator"),
		id: uuidSchema,
		name: bandPlanTextSchema(80),
		job: scanPresetJobSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
	})
	.strict()
export type OperatorScanPreset = z.infer<typeof operatorScanPresetSchema>
/** Read-only, derived from the effective region's built-in bandplans; id `builtin-<plan id>` or `builtin-combo-<name>`. */
export interface BuiltinScanPreset {
	readonly kind: "builtin"
	readonly id: string
	readonly name: string
	readonly region: BandRegion
	readonly job: ScanPresetJob
}
export type ScanPreset = BuiltinScanPreset | OperatorScanPreset
export type ScanPresetIssue = {
	readonly code: "unknown-bandplan"
	readonly bandplanId: string
}
export interface ScanPresetView {
	readonly preset: ScanPreset
	/**
	 * False when a bandplan id is not in the effective scanner list (BP2: the built-in
	 * plans of the enabled stack minus hidden bands; BP1: resolvable in the region).
	 */
	readonly applicable: boolean
	readonly issues: readonly ScanPresetIssue[]
}
/** GET /api/bandplans/presets/:id/job: body a client may POST to /api/scanner/jobs. */
export interface ScanPresetJobView {
	readonly presetId: string
	readonly region: BandRegion
	readonly spec: ScanJobSpec
	readonly issues: readonly ScanPresetIssue[]
}

// --- Persisted state v1 (<stateDir>/bandplans/state.json) ---

export const bandPlanStateSchema = z
	.object({
		version: z.literal(1),
		storeId: uuidSchema,
		revision: revisionSchema,
		/** null follows the default stack (the effective region's built-in pack). */
		stack: planStackSchema.nullable(),
		importedPacks: z
			.array(importedPackSchema)
			.max(BANDPLANS_LIMITS.importedPacks),
		operatorBands: z
			.array(storedBandSchema)
			.max(BANDPLANS_LIMITS.operatorBands),
		edits: z.array(bandEditSchema).max(BANDPLANS_LIMITS.edits),
		presets: z.array(operatorScanPresetSchema).max(BANDPLANS_LIMITS.presets),
	})
	.strict()
	.superRefine((value, ctx) => {
		const unique = (keys: string[], path: string) => {
			if (new Set(keys).size !== keys.length)
				ctx.addIssue({ code: "custom", path: [path], message: "Duplicate id" })
		}
		unique(
			value.importedPacks.map(pack => pack.id),
			"importedPacks",
		)
		for (const pack of value.importedPacks)
			unique(
				pack.bands.map(band => band.id),
				"importedPacks",
			)
		unique(
			value.operatorBands.map(band => band.id),
			"operatorBands",
		)
		unique(
			value.edits.map(edit => `${edit.packId}/${edit.bandId}`),
			"edits",
		)
		unique(
			value.presets.map(preset => preset.id),
			"presets",
		)
		const known = new Set<string>([
			...BUILTIN_PACK_IDS,
			...value.importedPacks.map(pack => pack.id),
		])
		if (value.stack?.some(entry => !known.has(entry.packId)))
			ctx.addIssue({
				code: "custom",
				path: ["stack"],
				message: "Stack names an unknown pack",
			})
		if (value.edits.some(edit => !known.has(edit.packId)))
			ctx.addIssue({
				code: "custom",
				path: ["edits"],
				message: "Edit names an unknown pack",
			})
		if (
			new TextEncoder().encode(JSON.stringify(value)).byteLength >
			BANDPLANS_LIMITS.stateBytes
		)
			ctx.addIssue({
				code: "custom",
				message: "State byte limit exceeded",
				params: { quota: true },
			})
	})
export type BandPlanState = z.infer<typeof bandPlanStateSchema>

// --- WG6: import by URL (web-gaps-6 requirement 5) ---

/**
 * WG6 (E-URL): hosts core may fetch a band-plan file from. Exact, lower-case host names; no
 * subdomains, IP literals or ports. [] disables URL import (403 BANDPLANS_URL_IMPORT_DISABLED);
 * file import is unaffected. One-constant switch.
 */
export const BANDPLAN_URL_IMPORT_HOSTS: readonly string[] = Object.freeze([
	"raw.githubusercontent.com",
])
/** WG6 req 5.3: bounds of one URL fetch. */
export const BANDPLANS_URL_LIMITS = Object.freeze({
	/** UTF-16 code units of the URL. */
	urlChars: 2048,
	/** Response body bytes (streamed; the fetch aborts past it). Same as the file import cap. */
	responseBytes: 1024 * 1024,
	/** Whole fetch: DNS, connect, TLS, headers and body. */
	totalTimeoutMs: 10_000,
	/** Fetches in flight per process; another request meanwhile is 503 BANDPLANS_BUSY. */
	inFlight: 1,
})
/** Content types accepted from the server (parameters such as charset ignored). */
export const BANDPLAN_URL_CONTENT_TYPES: readonly string[] = Object.freeze([
	"text/plain",
	"application/json",
	"application/xml",
	"text/xml",
	"text/csv",
	"application/octet-stream",
])
function isPlainHttpsUrl(value: string): boolean {
	// WG7 req 10.1: judge the raw string as the fetcher does, since WHATWG parsing drops an
	// explicit default port (`:443`) and an empty fragment (`#`) before the checks below.
	if (/[\u0000- \u007f\\#]/.test(value)) return false
	const schemeEnd = value.indexOf("//")
	if (schemeEnd < 0 || value.slice(0, schemeEnd).toLowerCase() !== "https:")
		return false
	const rest = value.slice(schemeEnd + 2)
	const authorityEnd = rest.search(/[/?]/)
	const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd)
	if (authority.includes(":") || authority.includes("@") || authority === "")
		return false
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return false
	}
	return (
		url.protocol === "https:" &&
		url.username === "" &&
		url.password === "" &&
		url.port === "" &&
		url.hash === ""
	)
}
/**
 * Syntactic URL rule (req 5.2): https, no credentials, no explicit port, no fragment, at most
 * 2 048 characters. Core also checks the host allowlist and every resolved address.
 */
export const bandPlanImportUrlSchema = z
	.string()
	.min(1)
	.max(BANDPLANS_URL_LIMITS.urlChars)
	.refine(
		isPlainHttpsUrl,
		"Expected an https URL without credentials, port or fragment",
	)

// --- SDR++ import ---

export const importGroupOverrideSchema = z
	.object({ sourceType: z.string().min(0).max(64), group: displayGroupSchema })
	.strict()
export type ImportGroupOverride = z.infer<typeof importGroupOverrideSchema>
const base64Schema = z
	.string()
	.max(BANDPLANS_LIMITS.importRequestBytes)
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const importFileFields = {
	format: z.enum(BANDPLAN_IMPORT_FORMATS),
	fileName: bandPlanTextSchema(128),
	contentBase64: base64Schema,
	groupOverrides: z
		.array(importGroupOverrideSchema)
		.max(BANDPLANS_LIMITS.groupOverrides)
		.refine(
			list => new Set(list.map(o => o.sourceType)).size === list.length,
			"Duplicate override",
		),
}
/** POST /api/bandplans/imports/preview. Never persists anything. */
export const importPreviewRequestSchema = z.object(importFileFields).strict()
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>
/**
 * WG6: POST /api/bandplans/imports/preview-url (protected only). Core fetches the URL once and
 * answers an ImportUrlPreview; nothing is persisted.
 */
export const importUrlPreviewRequestSchema = z
	.object({
		url: bandPlanImportUrlSchema,
		format: importFileFields.format,
		groupOverrides: importFileFields.groupOverrides,
	})
	.strict()
export type ImportUrlPreviewRequest = z.infer<
	typeof importUrlPreviewRequestSchema
>

export type ImportSkipReason =
	| "unnamed"
	| "malformed-row"
	| "invalid-edges"
	| "out-of-range"
	| "text-invalid"
	| "duplicate"
	| "pack-band-limit"
export type ImportGroupRule =
	| "table"
	| "name-keyword"
	| "override"
	| "fallback-other"
export interface ImportGroupMappingRow {
	/** SDR++ `type` value as found (trimmed, at most 64 chars). */
	readonly sourceType: string
	readonly group: DisplayGroup
	readonly rule: ImportGroupRule
	readonly count: number
}
export interface ImportReport {
	readonly rowsTotal: number
	readonly accepted: number
	readonly skipped: readonly {
		readonly reason: ImportSkipReason
		readonly count: number
	}[]
	/** Sorted by sourceType. Counts sum to `accepted`. */
	readonly groupMapping: readonly ImportGroupMappingRow[]
	/** Accepted bands mapped to a group other than "other". */
	readonly mapped: number
	/** Accepted bands mapped to "other". */
	readonly toOther: number
	readonly colourHints: number
}
export interface ImportPreview {
	readonly format: BandPlanImportFormat
	readonly fileName: string
	readonly bytes: number
	/** SHA-256 (lowercase hex) of the decoded file bytes; display and provenance only. */
	readonly sha256: string
	/**
	 * BP2 preview token: lowercase hex SHA-256 binding the file bytes and the request's
	 * groupOverrides (design "Batch 2: preview digest"). Commit must present it as
	 * `previewDigest`; any other bytes or overrides reject BANDPLANS_IMPORT_MISMATCH.
	 */
	readonly previewDigest: string
	readonly meta: {
		readonly name: string | null
		readonly countryName: string | null
		readonly countryCode: string | null
		readonly author: string | null
		readonly version: string | null
	}
	readonly trust: "community-unverified"
	/** Proposed bands with server-derived ids; scan is null, provenance imported. */
	readonly bands: readonly Band[]
	readonly report: ImportReport
}

/**
 * WG6: an ImportPreview of a fetched URL. `contentBase64` is the fetched file (at most 1 MiB
 * decoded): the client commits it through POST /api/bandplans/imports with `sourceUrl`.
 */
export interface ImportUrlPreview extends ImportPreview {
	readonly sourceUrl: string
	readonly contentBase64: string
}
/** WG6 req 6.2: one band of an update diff. */
export interface BandPlanUpdateBand {
	readonly id: string
	readonly name: string
	readonly startHz: number
	readonly endHz: number
}
/** WG6 req 6.2: a band present in both versions whose fields differ. */
export interface BandPlanUpdateChangedBand extends BandPlanUpdateBand {
	/** Band fields that differ (sorted), e.g. ["endHz", "mode"]. */
	readonly fields: readonly string[]
}
/**
 * WG6: POST /api/bandplans/packs/:packId/check-update (protected only). Re-fetches the pack's
 * `sourceUrl` and compares the fresh file with the committed pack. Never persists anything;
 * applying is an explicit commit of `preview` with `replacesPackId`.
 */
export interface BandPlanUpdateCheck {
	readonly packId: string
	readonly sourceUrl: string
	readonly checkedAt: string
	/** sha256 of the committed file. */
	readonly currentSha256: string
	/** sha256 of the fetched file. */
	readonly fetchedSha256: string
	/** Same bytes: no diff and no preview. */
	readonly upToDate: boolean
	/** Bands by id; each list sorted by startHz then id, at most BANDPLANS_LIMITS.bandsPerPack. */
	readonly added: readonly BandPlanUpdateBand[]
	readonly removed: readonly BandPlanUpdateBand[]
	readonly changed: readonly BandPlanUpdateChangedBand[]
	/** Null when up to date. */
	readonly preview: ImportUrlPreview | null
}

/** Commit fields, also embedded in the commit-import mutation. */
export const importCommitFieldsSchema = z
	.object({
		...importFileFields,
		expected: expectedTokenSchema,
		/** ImportPreview.previewDigest of the previewed bytes and groupOverrides. */
		previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
		name: bandPlanTextSchema(80).nullable(),
		author: bandPlanTextSchema(80).nullable(),
		licence: bandPlanTextSchema(80).nullable(),
		keepColourHints: z.boolean(),
		/** Re-import over an existing imported pack: keeps its id and edits. */
		replacesPackId: importedPackIdSchema.nullable(),
		/** Append to the bottom of the stack (materializing the default stack if null). */
		addToStack: z.boolean(),
		/**
		 * WG6: the URL of an ImportUrlPreview; the preview digest then binds it too. Absent or
		 * null for uploaded files (digest unchanged).
		 */
		sourceUrl: bandPlanImportUrlSchema.nullable().optional(),
	})
	.strict()
export type ImportCommitRequest = z.infer<typeof importCommitFieldsSchema>

// --- Mutations (route bodies plus a server-injected `type` and path ids) ---

const mutationObjects = [
	z
		.object({
			type: z.literal("set-stack"),
			expected: expectedTokenSchema,
			entries: planStackSchema,
		})
		.strict(),
	z
		.object({ type: z.literal("reset-stack"), expected: expectedTokenSchema })
		.strict(),
	z
		.object({
			type: z.literal("patch-band-edit"),
			expected: expectedTokenSchema,
			packId: stackPackIdSchema,
			bandId: bandIdSchema,
			set: bandEditFieldsSchema.nullable(),
			reset: z.array(bandEditFieldSchema).max(BAND_EDIT_FIELDS.length),
		})
		.strict(),
	z
		.object({
			type: z.literal("reset-band-edits"),
			expected: expectedTokenSchema,
			packId: stackPackIdSchema,
			bandId: bandIdSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("reset-pack-edits"),
			expected: expectedTokenSchema,
			packId: stackPackIdSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("create-operator-band"),
			expected: expectedTokenSchema,
			band: bandInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("replace-operator-band"),
			expected: expectedTokenSchema,
			bandId: bandIdSchema,
			band: bandInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("delete-operator-band"),
			expected: expectedTokenSchema,
			bandId: bandIdSchema,
		})
		.strict(),
	importCommitFieldsSchema.extend({ type: z.literal("commit-import") }),
	z
		.object({
			type: z.literal("delete-pack"),
			expected: expectedTokenSchema,
			packId: importedPackIdSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("create-preset"),
			expected: expectedTokenSchema,
			preset: scanPresetInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("replace-preset"),
			expected: expectedTokenSchema,
			presetId: uuidSchema,
			preset: scanPresetInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("delete-preset"),
			expected: expectedTokenSchema,
			presetId: uuidSchema,
		})
		.strict(),
] as const
export const bandPlanMutationSchema = z
	.discriminatedUnion("type", mutationObjects)
	.superRefine((value, ctx) => {
		if (value.type !== "patch-band-edit") return
		const set = Object.keys(value.set ?? {})
		const reset = value.reset
		if (
			set.length + reset.length === 0 ||
			new Set(reset).size !== reset.length ||
			reset.some(key => set.includes(key))
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Edit patch must be nonempty with distinct nonoverlapping keys",
			})
	})
export type BandPlanMutation = z.infer<typeof bandPlanMutationSchema>
export type BandPlanMutationType = BandPlanMutation["type"]

// --- Read views ---

export interface AvailableBandPlanStore {
	readonly state: "available"
	/**
	 * Null iff the served state is the never-persisted in-memory empty state (legacy
	 * read-only open without state.json). A null store accepts no mutation.
	 */
	readonly storeId: string | null
	readonly revision: number
}
export type BandPlanStore =
	| AvailableBandPlanStore
	| { readonly state: "unavailable" }
export interface BandPlanContext {
	/** The coarse region the scanner uses; picks the default built-in pack. */
	readonly region: BandRegion
	/** station.country when configured; display context only (no coordinate lookup). */
	readonly effectiveCountry: string | null
}
export interface BandPlanCapabilities {
	/** Mutation and import routes are mounted (protected mode only). */
	readonly writable: boolean
	readonly importFormats: readonly (typeof BANDPLAN_IMPORT_FORMATS)[number][]
	/**
	 * WG6: hosts URL import may fetch from; [] when URL import is off (no fetcher, empty
	 * allowlist or not writable). Sent by WG6 cores.
	 */
	readonly urlImportHosts?: readonly string[]
}
export interface PlanStackEntryView extends PlanStackEntry {
	readonly kind: "builtin" | "imported"
	readonly name: string
}
export interface BandPlanPackSummary {
	readonly id: string
	readonly kind: "builtin" | "imported"
	readonly name: string
	readonly region: BandRegion | null
	readonly provenance: PlanProvenance
	readonly bandCount: number
	readonly editCount: number
}
/** GET /api/bandplans. */
export interface BandPlanStackView {
	readonly schemaVersion: 1
	readonly store: BandPlanStore
	readonly context: BandPlanContext
	readonly capabilities: BandPlanCapabilities
	readonly stack: {
		readonly source: "default" | "operator"
		/** Index 0 is the highest layer below the operator layer. */
		readonly entries: readonly PlanStackEntryView[]
	}
	readonly packs: readonly BandPlanPackSummary[]
	readonly operatorBands: readonly Band[]
	readonly edits: readonly BandEdit[]
	/** Edits whose target band no longer exists in its pack; kept, not applied. */
	readonly orphanedEdits: readonly {
		readonly packId: string
		readonly bandId: string
	}[]
	readonly limits: typeof BANDPLANS_LIMITS
}
/** GET /api/bandplans/packs/:packId: the pack as shipped or imported, without edits. */
export interface BandPlanPackView {
	readonly store: BandPlanStore
	readonly pack: BandPlanPack
}

export interface BandSegment {
	readonly startHz: number
	readonly endHz: number
}
export type ResolvedBandIssue = "edge-conflict" | "dangling-parent"
export interface ResolvedBand {
	/** `${packId}/${bandId}`. */
	readonly key: string
	readonly packId: string
	readonly bandId: string
	/** 0 is the operator layer; n is stack entry n-1 among enabled entries. */
	readonly layer: number
	/** Effective band: pack band with edits applied (hidden bands never appear). */
	readonly band: Band
	/** Inclusive, sorted, disjoint, nonempty parts not named by a higher layer. */
	readonly segments: readonly BandSegment[]
	readonly editedFields: readonly BandEditField[]
	readonly issues: readonly ResolvedBandIssue[]
	readonly provenance: BandProvenance
	readonly packProvenance: PlanProvenance
}
/** GET /api/bandplans/resolved. */
export interface ResolvedBandPlanView {
	readonly store: BandPlanStore
	readonly context: BandPlanContext
	/** Sorted by first segment startHz, then layer, then key. */
	readonly bands: readonly ResolvedBand[]
	/** Keys of bands entirely named by higher layers. */
	readonly shadowed: readonly string[]
	/** Keys of bands hidden by an edit. */
	readonly hidden: readonly string[]
}
/** GET /api/bandplans/presets. Built-ins first (plan order), then operator presets by creation. */
export interface ScanPresetListView {
	readonly store: BandPlanStore
	readonly context: BandPlanContext
	readonly presets: readonly ScanPresetView[]
}
/** Mutation response. `createdId` names a new pack, operator band or preset. */
export interface BandPlanWriteDto {
	readonly view: BandPlanStackView
	readonly createdId: string | null
}

// --- WebSocket (optional, Main-wired) ---

export const BANDPLANS_WS_CHANNEL = "bandplans" as const
export const BANDPLANS_CHANGED_EVENT = "bandplans:changed" as const
/**
 * `bandplans:changed` on channel `bandplans`: a change token; clients refetch and ignore
 * older revisions of the same store. Sent after each changed durable commit (storeId
 * always a string then) and once on subscribe with the current token of an available
 * store (storeId null for the in-memory legacy state).
 */
export interface BandPlansChangedEventData {
	readonly storeId: string | null
	readonly revision: number
}
/** Wire envelope, same three-field shape as the operator-data channel. */
export interface BandPlansServerMessage {
	readonly type: typeof BANDPLANS_CHANGED_EVENT
	readonly channel: typeof BANDPLANS_WS_CHANNEL
	readonly data: BandPlansChangedEventData
}

// --- Errors ---

export const BANDPLANS_ERROR_DEFINITIONS = {
	BANDPLANS_INVALID: [400, "Invalid band-plan request."],
	BANDPLANS_PRECONDITION_REQUIRED: [
		428,
		"An expected band-plan token is required.",
	],
	BANDPLANS_CONFLICT: [409, "Band plans changed; fetch the current state."],
	BANDPLANS_NOT_FOUND: [404, "Band plan, band or preset not found."],
	BANDPLANS_READ_ONLY: [409, "Built-in band plans and presets are read-only."],
	BANDPLANS_QUOTA: [409, "Band-plan limit exceeded."],
	BANDPLANS_IMPORT_TOO_LARGE: [413, "Import file is too large."],
	BANDPLANS_IMPORT_INVALID: [
		422,
		"Import file is not a usable band plan of the selected format.",
	],
	BANDPLANS_IMPORT_MISMATCH: [
		409,
		"Import file differs from the previewed file.",
	],
	BANDPLANS_BUSY: [503, "Band plans are busy."],
	BANDPLANS_UNAVAILABLE: [503, "Band-plan storage is unavailable."],
	BANDPLANS_URL_IMPORT_DISABLED: [403, "Band-plan import by URL is disabled."],
	BANDPLANS_URL_REFUSED: [
		422,
		"The URL is not an allowed https band-plan source.",
	],
	BANDPLANS_URL_FETCH_FAILED: [502, "The band-plan URL could not be fetched."],
	BANDPLANS_URL_TIMEOUT: [504, "The band-plan URL fetch timed out."],
} as const
export type BandPlansErrorCode = keyof typeof BANDPLANS_ERROR_DEFINITIONS
export const bandPlansErrorCodeSchema = z.enum([
	"BANDPLANS_INVALID",
	"BANDPLANS_PRECONDITION_REQUIRED",
	"BANDPLANS_CONFLICT",
	"BANDPLANS_NOT_FOUND",
	"BANDPLANS_READ_ONLY",
	"BANDPLANS_QUOTA",
	"BANDPLANS_IMPORT_TOO_LARGE",
	"BANDPLANS_IMPORT_INVALID",
	"BANDPLANS_IMPORT_MISMATCH",
	"BANDPLANS_BUSY",
	"BANDPLANS_UNAVAILABLE",
	"BANDPLANS_URL_IMPORT_DISABLED",
	"BANDPLANS_URL_REFUSED",
	"BANDPLANS_URL_FETCH_FAILED",
	"BANDPLANS_URL_TIMEOUT",
])
/** `details.current` only on BANDPLANS_CONFLICT. */
export interface BandPlansErrorDto {
	readonly error: "BandPlansError"
	readonly code: BandPlansErrorCode
	readonly message: string
	readonly details?: { readonly current: ExpectedToken }
}
