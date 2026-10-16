import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
	BANDPLAN_IMPORT_FORMATS,
	BANDPLANS_LIMITS,
	OPERATOR_PACK_ID,
	BANDPLAN_URL_IMPORT_HOSTS,
	bandPlanImportUrlSchema,
	bandPlanMutationSchema,
	bandPlanTextSchema,
	importPreviewRequestSchema,
	importUrlPreviewRequestSchema,
} from "@wavekit/api-types"
import type {
	Band,
	BandPlanContext,
	BandPlanMutation,
	BandPlanPack,
	BandPlanPackSummary,
	BandPlanPackView,
	BandPlanStackView,
	BandPlanState,
	BandPlanStore,
	BandPlansChangedEventData,
	BandPlanUpdateCheck,
	ImportUrlPreview,
	DisplayGroup,
	ImportPreview,
	BandPlanImportFormat,
	ImportPreviewRequest,
	PlanStackEntry,
	PlanStackEntryView,
	ResolvedBandPlanView,
	ScanPreset,
	ScanPresetIssue,
	ScanPresetJobView,
	ScanPresetListView,
	ScanPresetView,
	StoredBand,
} from "@wavekit/api-types"
import { BandPlansError } from "./contract.js"
import type {
	BandPlanDelivery,
	BandPlanImportParser,
	BandPlanImportParsers,
	BandPlanMutationResult,
	BandPlanService,
	BandPlanServiceOptions,
	BandPlanStoreUnavailableReason,
	BandPlanTransition,
	BandPlanUrlFetcher,
	BandPlanUrlFetchResult,
	BuiltinPackIdFor,
	BuiltinPresetsFor,
	DomainContext,
	ParsedImport,
	ParseSdrppBandPlan,
	PresetIssuesFor,
	PresetToJobSpec,
	ProjectBuiltinPacks,
	ResolveBandPlans,
	ResolveScannerBandplans,
	ResolvedBandPlan,
	ResolverInput,
} from "./contract.js"
import { previewDigestFor } from "./domain.js"
import {
	BandPlanStorage,
	bandPlanStorageFailureReason,
	validateBandPlanState,
} from "./storage.js"
import type { BandPlanStorageOptions } from "./storage.js"

/**
 * Lane functions other than `previewDigestFor` are injected. Main's
 * openBandPlanService in src/core/bandplans/index.ts supplies the real ones.
 */
export interface BandPlanServiceDeps {
	readonly projectBuiltinPacks: ProjectBuiltinPacks
	readonly builtinPackIdFor: BuiltinPackIdFor
	readonly resolveBandPlans: ResolveBandPlans
	readonly transition: BandPlanTransition
	readonly parseSdrppBandPlan: ParseSdrppBandPlan
	/**
	 * WG5: parsers of the SDR# and Gqrx formats. A format without a parser is
	 * BANDPLANS_IMPORT_INVALID and is not advertised in `capabilities.importFormats`.
	 */
	readonly importParsers?: BandPlanImportParsers
	readonly builtinPresetsFor: BuiltinPresetsFor
	readonly presetIssuesFor: PresetIssuesFor
	readonly presetToJobSpec: PresetToJobSpec
	/**
	 * Effective scanner list for preset issues. Absent keeps BP1 checks.
	 * Main wires `resolveScannerBandplans` in the barrel.
	 */
	readonly scannerBandplans?: ResolveScannerBandplans
	/**
	 * WG6: `diffImportedBands` from ./import/update-diff.js (Main wires it in the barrel).
	 * Absent: checkImportUpdate answers BANDPLANS_URL_IMPORT_DISABLED.
	 */
	readonly diffImportedBands?: DiffImportedBands
}
/** Structural type of import/update-diff.ts `diffImportedBands`; the service never imports it. */
export type DiffImportedBands = (
	current: readonly StoredBand[],
	fresh: readonly StoredBand[],
) => {
	readonly added: BandPlanUpdateCheck["added"]
	readonly removed: BandPlanUpdateCheck["removed"]
	readonly changed: BandPlanUpdateCheck["changed"]
}
/** Bounds of the issued URL-preview registry (trust: sourceUrl is never a client claim). */
export const URL_PREVIEW_REGISTRY = Object.freeze({
	entries: 32,
	ttlMs: 15 * 60 * 1000,
})
interface IssuedUrlPreview {
	readonly sourceUrl: string
	readonly sha256: string
	readonly issuedAtMs: number
}
interface PreparedMutation {
	readonly mutation: BandPlanMutation
	readonly parsedImport: ParsedImport | null
}
const unavailable = () => new BandPlansError("BANDPLANS_UNAVAILABLE")
function notifyUnavailable(
	options: BandPlanServiceOptions,
	reason: BandPlanStoreUnavailableReason,
): void {
	const listener = options.onStoreUnavailable
	if (!listener) return
	try {
		listener(reason)
	} catch {
		// A listener fault must not stop degraded reads.
	}
}
function detach<T>(value: T): T {
	return structuredClone(value)
}
function isThenable(value: unknown): boolean {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	)
}
function measuredBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8")
	} catch {
		throw new BandPlansError("BANDPLANS_INVALID")
	}
}
function missingExpected(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(!Object.hasOwn(value, "expected") ||
			Reflect.get(value, "expected") === undefined)
	)
}
/** The frozen service option observes the before-phase of each storage stage. */
function adaptStage(
	hook: NonNullable<BandPlanServiceOptions["storageStage"]>,
): NonNullable<BandPlanStorageOptions["stage"]> {
	return (stage, phase) => {
		if (phase === "before") return hook(stage)
	}
}
function asBand(band: StoredBand): Band {
	return {
		id: band.id,
		name: band.name,
		startHz: band.startHz,
		endHz: band.endHz,
		group: band.group,
		mode: band.mode,
		bandwidthHz: band.bandwidthHz,
		stepHz: band.stepHz,
		skip: band.skip,
		channels: band.channels.map(channel => ({
			...channel,
			aliases: [...channel.aliases],
		})),
		parentId: band.parentId,
		colourHint: band.colourHint,
		registryRef: band.registryRef,
		scan: null,
		provenance: band.provenance,
	}
}
function asImportedPack(
	pack: BandPlanState["importedPacks"][number],
): BandPlanPack {
	return {
		id: pack.id,
		kind: "imported",
		name: pack.name,
		region: null,
		provenance: pack.provenance,
		bands: pack.bands.map(asBand),
	}
}
function emptyState(): BandPlanState {
	return validateBandPlanState({
		version: 1,
		storeId: randomUUID(),
		revision: 0,
		stack: null,
		importedPacks: [],
		operatorBands: [],
		edits: [],
		presets: [],
	})
}

/**
 * Resolves even when `<stateDir>/bandplans/` cannot be opened. Reads then serve
 * built-ins, the default stack and built-in presets with `store: unavailable`.
 * A read-only open with no state.json stays available and serves an empty state.
 */
export async function createBandPlanService(
	options: BandPlanServiceOptions,
	deps: BandPlanServiceDeps,
): Promise<BandPlanService> {
	const domain: DomainContext = {
		now: options.domain?.now ?? (() => new Date().toISOString()),
		uuid: options.domain?.uuid ?? randomUUID,
		randomHex12:
			options.domain?.randomHex12 ?? (() => randomBytes(6).toString("hex")),
		region: options.context.region,
	}
	let storage: BandPlanStorage | undefined
	try {
		storage = await BandPlanStorage.open({
			stateDir: options.stateDir,
			writable: options.writable,
			...(options.onStoreUnavailable
				? { onStoreUnavailable: options.onStoreUnavailable }
				: {}),
			...(options.storageStage
				? { stage: adaptStage(options.storageStage) }
				: {}),
		})
	} catch (error) {
		if (!(error instanceof BandPlansError)) throw error
		notifyUnavailable(options, bandPlanStorageFailureReason(error))
	}
	try {
		return new BandPlanRuntime(storage, options, deps, domain)
	} catch (error) {
		if (storage) await storage.close().catch(() => undefined)
		throw error
	}
}

class BandPlanRuntime implements BandPlanService {
	private current: BandPlanState
	private tail: Promise<void> = Promise.resolve()
	private admitted = 0
	private closing = false
	private closed = false
	private closeResult: Promise<void> | undefined
	private readonly builtins: readonly BandPlanPack[]
	private readonly builtinById: ReadonlyMap<string, BandPlanPack>
	private resolvedMemo: { key: string; value: ResolvedBandPlan } | undefined
	/** previewDigest → issued URL preview; insertion order is FIFO eviction order. */
	private readonly issuedUrlPreviews = new Map<string, IssuedUrlPreview>()
	constructor(
		private readonly storage: BandPlanStorage | undefined,
		private readonly options: BandPlanServiceOptions,
		private readonly deps: BandPlanServiceDeps,
		private readonly domain: DomainContext,
	) {
		this.builtins = deps.projectBuiltinPacks()
		this.builtinById = new Map(this.builtins.map(pack => [pack.id, pack]))
		this.current = storage ? storage.snapshot() : emptyState()
	}
	view(): BandPlanStackView {
		const state = this.persisted()
		const stack = this.effectiveStack()
		return detach({
			schemaVersion: 1,
			store: this.storeView(),
			context: this.context(),
			capabilities: {
				writable: this.options.writable,
				importFormats: BANDPLAN_IMPORT_FORMATS.filter(
					format => this.parserFor(format) !== undefined,
				),
				urlImportHosts: this.urlImportOn() ? [...this.urlHosts()] : [],
			},
			stack: {
				source: stack.source,
				entries: this.stackEntries(stack.entries),
			},
			packs: this.summaries(),
			operatorBands: state ? state.operatorBands.map(asBand) : [],
			edits: state ? [...state.edits] : [],
			orphanedEdits: [...this.resolution().orphanedEdits],
			limits: BANDPLANS_LIMITS,
		})
	}
	resolved(): ResolvedBandPlanView {
		const resolved = this.resolution()
		return detach({
			store: this.storeView(),
			context: this.context(),
			bands: resolved.bands,
			shadowed: resolved.shadowed,
			hidden: resolved.hidden,
		})
	}
	pack(packId: string): BandPlanPackView {
		if (packId === OPERATOR_PACK_ID)
			throw new BandPlansError("BANDPLANS_NOT_FOUND")
		const pack = this.packById(packId)
		if (!pack) throw new BandPlansError("BANDPLANS_NOT_FOUND")
		return detach({ store: this.storeView(), pack })
	}
	presets(): ScanPresetListView {
		const effectiveIds = this.effectiveScannerIds()
		return detach({
			store: this.storeView(),
			context: this.context(),
			presets: this.visiblePresets().map(preset =>
				this.presetView(preset, effectiveIds),
			),
		})
	}
	presetJob(presetId: string): ScanPresetJobView {
		const preset = this.visiblePresets().find(item => item.id === presetId)
		if (!preset) throw new BandPlansError("BANDPLANS_NOT_FOUND")
		const effectiveIds = this.effectiveScannerIds()
		return detach({
			presetId,
			region: this.options.context.region,
			spec: this.deps.presetToJobSpec(preset),
			issues: this.issuesFor(preset, effectiveIds),
		})
	}
	previewImport(request: unknown): ImportPreview {
		if (this.closing) throw unavailable()
		if (!this.options.writable) throw new BandPlansError("BANDPLANS_READ_ONLY")
		if (measuredBytes(request) > BANDPLANS_LIMITS.importRequestBytes)
			throw new BandPlansError("BANDPLANS_IMPORT_TOO_LARGE")
		const parsed = importPreviewRequestSchema.safeParse(request)
		if (!parsed.success) throw new BandPlansError("BANDPLANS_INVALID")
		const preview = detach(this.decodeAndParse(parsed.data).preview)
		return {
			...preview,
			previewDigest: previewDigestFor(
				preview.sha256,
				parsed.data.groupOverrides,
			),
		}
	}
	async previewImportUrl(request: unknown): Promise<ImportUrlPreview> {
		const fetcher = this.urlFetcherOrThrow()
		if (this.closing) throw unavailable()
		const parsed = importUrlPreviewRequestSchema.safeParse(request)
		if (!parsed.success) throw new BandPlansError("BANDPLANS_INVALID")
		const { url, format, groupOverrides } = parsed.data
		return this.previewFetched(
			url,
			format,
			groupOverrides,
			await this.fetchAllowed(fetcher, url),
		)
	}
	async checkImportUpdate(packId: string): Promise<BandPlanUpdateCheck> {
		const fetcher = this.urlFetcherOrThrow()
		const diffImportedBands = this.deps.diffImportedBands
		if (!diffImportedBands)
			throw new BandPlansError("BANDPLANS_URL_IMPORT_DISABLED")
		if (this.closing) throw unavailable()
		if (typeof packId !== "string" || packId === OPERATOR_PACK_ID)
			throw new BandPlansError("BANDPLANS_NOT_FOUND")
		const stored = this.persisted()?.importedPacks.find(
			pack => pack.id === packId,
		)
		if (!stored) {
			if (this.builtinById.has(packId))
				throw new BandPlansError("BANDPLANS_INVALID")
			throw new BandPlansError("BANDPLANS_NOT_FOUND")
		}
		const sourceUrl = stored.provenance.sourceUrl
		if (sourceUrl === undefined) throw new BandPlansError("BANDPLANS_INVALID")
		const fetched = await this.fetchAllowed(fetcher, sourceUrl)
		const fetchedSha256 = createHash("sha256")
			.update(fetched.bytes)
			.digest("hex")
		const base = {
			packId,
			sourceUrl,
			checkedAt: this.domain.now(),
			currentSha256: stored.provenance.sha256,
			fetchedSha256,
		}
		if (fetchedSha256 === stored.provenance.sha256)
			return {
				...base,
				upToDate: true,
				added: [],
				removed: [],
				changed: [],
				preview: null,
			}
		const { preview, bands } = this.previewFetchedWithBands(
			sourceUrl,
			stored.provenance.format,
			[],
			fetched,
		)
		// Both sides are bounded by bandsPerPack, so the diff is never truncated.
		const diff = diffImportedBands(stored.bands, bands)
		return detach({
			...base,
			upToDate: false,
			added: diff.added,
			removed: diff.removed,
			changed: diff.changed,
			preview,
		})
	}
	mutate(input: unknown): Promise<BandPlanMutationResult> {
		let prepared: PreparedMutation
		try {
			if (this.closing || this.closed || !this.storage?.isAvailable())
				throw unavailable()
			if (!this.options.writable)
				throw new BandPlansError("BANDPLANS_READ_ONLY")
			prepared = this.prepare(input)
			if (this.admitted >= BANDPLANS_LIMITS.waitingTransactions + 1)
				throw new BandPlansError("BANDPLANS_BUSY")
		} catch (error) {
			return Promise.reject(error)
		}
		this.admitted += 1
		const operation = this.tail
			.then(() => this.commit(prepared))
			.finally(() => {
				this.admitted -= 1
			})
		// A failed transaction cannot poison later accepted work.
		this.tail = operation.then(
			() => undefined,
			() => undefined,
		)
		return operation
	}
	close(): Promise<void> {
		if (!this.closeResult) {
			this.closing = true
			this.closeResult = this.tail.then(async () => {
				this.closed = true
				this.resolvedMemo = undefined
				if (this.storage) await this.storage.close()
			})
		}
		return this.closeResult
	}
	private urlHosts(): readonly string[] {
		return this.options.urlImportHosts ?? BANDPLAN_URL_IMPORT_HOSTS
	}
	/** Off: no fetcher, an empty allowlist, or a read-only (unprotected) service. */
	private urlImportOn(): boolean {
		return (
			this.options.urlFetcher !== undefined &&
			this.urlHosts().length > 0 &&
			this.options.writable
		)
	}
	private urlFetcherOrThrow(): BandPlanUrlFetcher {
		const fetcher = this.options.urlFetcher
		if (!fetcher || !this.urlImportOn())
			throw new BandPlansError("BANDPLANS_URL_IMPORT_DISABLED")
		return fetcher
	}
	/** Syntax and exact host membership in the CURRENT allowlist; never echoes the URL. */
	private assertAllowedUrl(url: string): void {
		if (!bandPlanImportUrlSchema.safeParse(url).success)
			throw new BandPlansError("BANDPLANS_URL_REFUSED")
		let host: string
		try {
			host = new URL(url).hostname.toLowerCase()
		} catch {
			throw new BandPlansError("BANDPLANS_URL_REFUSED")
		}
		if (!this.urlHosts().includes(host))
			throw new BandPlansError("BANDPLANS_URL_REFUSED")
	}
	private async fetchAllowed(
		fetcher: BandPlanUrlFetcher,
		url: string,
	): Promise<BandPlanUrlFetchResult> {
		this.assertAllowedUrl(url)
		let result: BandPlanUrlFetchResult
		try {
			result = await fetcher(url, [...this.urlHosts()])
		} catch (error) {
			if (error instanceof BandPlansError) throw error
			throw new BandPlansError("BANDPLANS_URL_FETCH_FAILED")
		}
		if (!(result.bytes instanceof Uint8Array))
			throw new BandPlansError("BANDPLANS_URL_FETCH_FAILED")
		if (result.bytes.byteLength > BANDPLANS_LIMITS.importFileBytes)
			throw new BandPlansError("BANDPLANS_IMPORT_TOO_LARGE")
		return result
	}
	private previewFetched(
		url: string,
		format: BandPlanImportFormat,
		groupOverrides: ImportPreviewRequest["groupOverrides"],
		fetched: BandPlanUrlFetchResult,
	): ImportUrlPreview {
		return this.previewFetchedWithBands(url, format, groupOverrides, fetched)
			.preview
	}
	private previewFetchedWithBands(
		url: string,
		format: BandPlanImportFormat,
		groupOverrides: ImportPreviewRequest["groupOverrides"],
		fetched: BandPlanUrlFetchResult,
	): { preview: ImportUrlPreview; bands: readonly StoredBand[] } {
		const contentBase64 = Buffer.from(
			fetched.bytes.buffer,
			fetched.bytes.byteOffset,
			fetched.bytes.byteLength,
		).toString("base64")
		const parsed = detach(
			this.decodeAndParse({
				format,
				fileName: urlFileName(url),
				contentBase64,
				groupOverrides,
			}),
		)
		const previewDigest = previewDigestFor(
			parsed.preview.sha256,
			groupOverrides,
			url,
		)
		this.registerUrlPreview(previewDigest, url, parsed.preview.sha256)
		return {
			preview: {
				...parsed.preview,
				previewDigest,
				sourceUrl: url,
				contentBase64,
			},
			bands: parsed.bands,
		}
	}
	private nowMs(): number {
		const ms = Date.parse(this.domain.now())
		return Number.isFinite(ms) ? ms : 0
	}
	private registerUrlPreview(
		digest: string,
		sourceUrl: string,
		sha256: string,
	) {
		const registry = this.issuedUrlPreviews
		registry.delete(digest)
		registry.set(digest, { sourceUrl, sha256, issuedAtMs: this.nowMs() })
		while (registry.size > URL_PREVIEW_REGISTRY.entries) {
			const oldest = registry.keys().next()
			if (oldest.done === true) break
			registry.delete(oldest.value)
		}
	}
	/** An unexpired preview this service issued for exactly this digest, URL and bytes. */
	private assertIssuedUrlPreview(
		digest: string,
		sourceUrl: string,
		sha256: string,
	): void {
		const entry = this.issuedUrlPreviews.get(digest)
		if (!entry) throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
		const age = this.nowMs() - entry.issuedAtMs
		if (age < 0 || age > URL_PREVIEW_REGISTRY.ttlMs) {
			this.issuedUrlPreviews.delete(digest)
			throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
		}
		if (entry.sourceUrl !== sourceUrl || entry.sha256 !== sha256)
			throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
	}
	/** Re-checked inside the queue so two racing commits cannot both use one preview. */
	private issuedUrlCommit(prepared: PreparedMutation): string | null {
		const mutation = prepared.mutation
		if (mutation.type !== "commit-import") return null
		if (typeof mutation.sourceUrl !== "string") return null
		this.assertIssuedUrlPreview(
			mutation.previewDigest,
			mutation.sourceUrl,
			fileSha256(mutation.contentBase64),
		)
		return mutation.previewDigest
	}
	private context(): BandPlanContext {
		return {
			region: this.options.context.region,
			effectiveCountry: this.options.context.effectiveCountry,
		}
	}
	private persisted(): BandPlanState | undefined {
		if (!this.storage?.isAvailable() || this.closed) return undefined
		return this.current
	}
	private storeView(): BandPlanStore {
		const state = this.persisted()
		if (!state) return { state: "unavailable" }
		if (this.storage?.persisted() !== true)
			return { state: "available", storeId: null, revision: state.revision }
		return {
			state: "available",
			storeId: state.storeId,
			revision: state.revision,
		}
	}
	private effectiveStack(): {
		source: "default" | "operator"
		entries: readonly PlanStackEntry[]
	} {
		const state = this.persisted()
		if (!state || state.stack === null)
			return {
				source: "default",
				entries: [
					{
						packId: this.deps.builtinPackIdFor(this.options.context.region),
						enabled: true,
					},
				],
			}
		return { source: "operator", entries: state.stack }
	}
	private stackEntries(
		entries: readonly PlanStackEntry[],
	): PlanStackEntryView[] {
		return entries.map(entry => {
			const pack = this.packById(entry.packId)
			const kind =
				pack?.kind ??
				(entry.packId.startsWith("imported-") ? "imported" : "builtin")
			return {
				packId: entry.packId,
				enabled: entry.enabled,
				kind,
				name: pack?.name ?? entry.packId,
			}
		})
	}
	private packById(id: string): BandPlanPack | undefined {
		const builtin = this.builtinById.get(id)
		if (builtin) return builtin
		const imported = this.persisted()?.importedPacks.find(
			pack => pack.id === id,
		)
		return imported ? asImportedPack(imported) : undefined
	}
	private summaries(): BandPlanPackSummary[] {
		const state = this.persisted()
		const edits = state?.edits ?? []
		const count = (packId: string) =>
			edits.reduce((total, edit) => total + (edit.packId === packId ? 1 : 0), 0)
		return [
			...this.builtins.map(pack => ({
				id: pack.id,
				kind: pack.kind,
				name: pack.name,
				region: pack.region,
				provenance: pack.provenance,
				bandCount: pack.bands.length,
				editCount: count(pack.id),
			})),
			...(state?.importedPacks ?? []).map(pack => ({
				id: pack.id,
				kind: "imported" as const,
				name: pack.name,
				region: null,
				provenance: pack.provenance,
				bandCount: pack.bands.length,
				editCount: count(pack.id),
			})),
		]
	}
	private resolverInput(): ResolverInput {
		const packs = new Map<string, BandPlanPack>()
		for (const pack of this.builtins) packs.set(pack.id, pack)
		const state = this.persisted()
		if (state)
			for (const pack of state.importedPacks)
				packs.set(pack.id, asImportedPack(pack))
		return {
			packs,
			stack: this.effectiveStack().entries,
			operatorBands: state ? state.operatorBands.map(asBand) : [],
			edits: state ? [...state.edits] : [],
		}
	}
	private resolution(): ResolvedBandPlan {
		const state = this.persisted()
		const key = !state
			? "unavailable"
			: this.storage?.persisted() === true
				? `${state.storeId}:${state.revision}`
				: `readonly-empty:${state.revision}`
		if (this.resolvedMemo?.key === key) return this.resolvedMemo.value
		const value = this.deps.resolveBandPlans(this.resolverInput())
		this.resolvedMemo = { key, value }
		return value
	}
	private visiblePresets(): readonly ScanPreset[] {
		const builtins = this.deps.builtinPresetsFor(this.options.context.region)
		const stored = this.persisted()?.presets ?? []
		return [...builtins, ...stored]
	}
	private effectiveScannerIds(): ReadonlySet<string> | undefined {
		const resolve = this.deps.scannerBandplans
		if (!resolve) return undefined
		return new Set(resolve(this.view()).map(plan => plan.id))
	}
	private presetView(
		preset: ScanPreset,
		effectiveIds: ReadonlySet<string> | undefined,
	): ScanPresetView {
		const issues = this.issuesFor(preset, effectiveIds)
		return { preset, applicable: issues.length === 0, issues }
	}
	private issuesFor(
		preset: ScanPreset,
		effectiveIds: ReadonlySet<string> | undefined,
	): readonly ScanPresetIssue[] {
		const region = this.options.context.region
		return effectiveIds
			? this.deps.presetIssuesFor(preset, region, effectiveIds)
			: this.deps.presetIssuesFor(preset, region)
	}
	private parserFor(
		format: BandPlanImportFormat,
	): BandPlanImportParser | undefined {
		if (format === "sdrpp-json") return this.deps.parseSdrppBandPlan
		return this.deps.importParsers?.[format]
	}
	private decodeAndParse(file: {
		readonly format: BandPlanImportFormat
		readonly fileName: string
		readonly contentBase64: string
		readonly groupOverrides: ImportPreviewRequest["groupOverrides"]
	}): ParsedImport {
		const bytes = decodeBase64(file.contentBase64)
		if (bytes.byteLength > BANDPLANS_LIMITS.importFileBytes)
			throw new BandPlansError("BANDPLANS_IMPORT_TOO_LARGE")
		const overrides = new Map<string, DisplayGroup>(
			file.groupOverrides.map(override => [
				override.sourceType,
				override.group,
			]),
		)
		const parse = this.parserFor(file.format)
		if (parse === undefined)
			throw new BandPlansError("BANDPLANS_IMPORT_INVALID")
		const result = parse(bytes, {
			fileName: file.fileName,
			overrides,
		})
		if (!result.ok) throw new BandPlansError(result.code)
		return result.value
	}
	private prepare(input: unknown): PreparedMutation {
		if (missingExpected(input))
			throw new BandPlansError("BANDPLANS_PRECONDITION_REQUIRED")
		const parsed = bandPlanMutationSchema.safeParse(input)
		if (!parsed.success) throw new BandPlansError("BANDPLANS_INVALID")
		const limit =
			parsed.data.type === "commit-import"
				? BANDPLANS_LIMITS.importRequestBytes
				: BANDPLANS_LIMITS.requestBytes
		if (measuredBytes(input) > limit)
			throw new BandPlansError("BANDPLANS_QUOTA")
		if (parsed.data.type !== "commit-import")
			return { mutation: parsed.data, parsedImport: null }
		const sourceUrl = parsed.data.sourceUrl
		if (typeof sourceUrl === "string") {
			if (!this.urlImportOn())
				throw new BandPlansError("BANDPLANS_URL_IMPORT_DISABLED")
			this.assertAllowedUrl(sourceUrl)
		}
		const imported = this.decodeAndParse(parsed.data)
		const bytesSha256 = fileSha256(parsed.data.contentBase64)
		const digest = previewDigestFor(
			bytesSha256,
			parsed.data.groupOverrides,
			sourceUrl,
		)
		if (
			imported.preview.sha256 !== bytesSha256 ||
			digest !== parsed.data.previewDigest
		)
			throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
		if (typeof sourceUrl === "string")
			this.assertIssuedUrlPreview(digest, sourceUrl, bytesSha256)
		return { mutation: parsed.data, parsedImport: detach(imported) }
	}
	private async commit(
		prepared: PreparedMutation,
	): Promise<BandPlanMutationResult> {
		const storage = this.storage
		// Admitted work finishes after close starts. A latched store does not.
		if (this.closed || storage === undefined || !storage.isAvailable())
			throw unavailable()
		const issuedDigest = this.issuedUrlCommit(prepared)
		const proposal = this.deps.transition(
			validateBandPlanState(this.current),
			prepared.mutation,
			this.domain,
			prepared.parsedImport,
		)
		if (!proposal.changed)
			return {
				changed: false,
				view: this.view(),
				createdId: null,
				delivery: "not-needed",
			}
		await storage.persist(proposal.state)
		if (issuedDigest !== null) this.issuedUrlPreviews.delete(issuedDigest)
		this.current = storage.snapshot()
		this.resolvedMemo = undefined
		const delivery = this.publish()
		return {
			changed: true,
			view: this.view(),
			createdId: proposal.createdId,
			delivery,
		}
	}
	private publish(): BandPlanDelivery {
		const sink = this.options.onCommit
		if (!sink) return "unmounted"
		try {
			const event: BandPlansChangedEventData = {
				storeId: this.current.storeId,
				revision: this.current.revision,
			}
			const result: unknown = sink(event)
			if (isThenable(result)) {
				void Promise.resolve(result).catch(() => undefined)
				return "failed"
			}
			return "sent"
		} catch {
			return "failed"
		}
	}
}

const URL_FILE_NAME_FALLBACK = "band-plan"
/** Last decoded path segment, at most 128 code points and valid band-plan text; else "band-plan". */
function urlFileName(url: string): string {
	try {
		const segments = new URL(url).pathname.split("/")
		const decoded = decodeURIComponent(segments[segments.length - 1] ?? "")
		const bounded = [...decoded].slice(0, 128).join("")
		return bandPlanTextSchema(128).safeParse(bounded).success
			? bounded
			: URL_FILE_NAME_FALLBACK
	} catch {
		return URL_FILE_NAME_FALLBACK
	}
}

function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, "base64"))
}

function fileSha256(contentBase64: string): string {
	return createHash("sha256").update(decodeBase64(contentBase64)).digest("hex")
}
