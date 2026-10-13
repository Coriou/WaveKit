import { randomBytes, randomUUID } from "node:crypto"
import {
	BANDPLAN_IMPORT_FORMATS,
	BANDPLANS_LIMITS,
	OPERATOR_PACK_ID,
	bandPlanMutationSchema,
	importPreviewRequestSchema,
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
	DisplayGroup,
	ImportPreview,
	ImportPreviewRequest,
	PlanStackEntry,
	PlanStackEntryView,
	ResolvedBandPlanView,
	ScanPreset,
	ScanPresetJobView,
	ScanPresetListView,
	ScanPresetView,
	StoredBand,
} from "@wavekit/api-types"
import { BandPlansError } from "./contract.js"
import type {
	BandPlanDelivery,
	BandPlanMutationResult,
	BandPlanService,
	BandPlanServiceOptions,
	BandPlanTransition,
	BuiltinPackIdFor,
	BuiltinPresetsFor,
	DomainContext,
	ParsedImport,
	ParseSdrppBandPlan,
	PresetIssuesFor,
	PresetToJobSpec,
	ProjectBuiltinPacks,
	ResolveBandPlans,
	ResolvedBandPlan,
	ResolverInput,
} from "./contract.js"
import { BandPlanStorage, validateBandPlanState } from "./storage.js"
import type { BandPlanStorageOptions } from "./storage.js"

/**
 * Dependencies are the frozen contract functions from lanes A, C and D.
 * This module does not import those modules. Main's openBandPlanService in
 * src/core/bandplans/index.ts is the composition that supplies the real ones.
 */
export interface BandPlanServiceDeps {
	readonly projectBuiltinPacks: ProjectBuiltinPacks
	readonly builtinPackIdFor: BuiltinPackIdFor
	readonly resolveBandPlans: ResolveBandPlans
	readonly transition: BandPlanTransition
	readonly parseSdrppBandPlan: ParseSdrppBandPlan
	readonly builtinPresetsFor: BuiltinPresetsFor
	readonly presetIssuesFor: PresetIssuesFor
	readonly presetToJobSpec: PresetToJobSpec
}
interface PreparedMutation {
	readonly mutation: BandPlanMutation
	readonly parsedImport: ParsedImport | null
}
const unavailable = () => new BandPlansError("BANDPLANS_UNAVAILABLE")
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
			...(options.storageStage
				? { stage: adaptStage(options.storageStage) }
				: {}),
		})
	} catch (error) {
		if (!(error instanceof BandPlansError)) throw error
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
				importFormats: [...BANDPLAN_IMPORT_FORMATS],
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
		return detach({
			store: this.storeView(),
			context: this.context(),
			presets: this.visiblePresets().map(preset => this.presetView(preset)),
		})
	}
	presetJob(presetId: string): ScanPresetJobView {
		const preset = this.visiblePresets().find(item => item.id === presetId)
		if (!preset) throw new BandPlansError("BANDPLANS_NOT_FOUND")
		return detach({
			presetId,
			region: this.options.context.region,
			spec: this.deps.presetToJobSpec(preset),
			issues: this.deps.presetIssuesFor(preset, this.options.context.region),
		})
	}
	previewImport(request: unknown): ImportPreview {
		if (this.closing) throw unavailable()
		if (!this.options.writable) throw new BandPlansError("BANDPLANS_READ_ONLY")
		if (measuredBytes(request) > BANDPLANS_LIMITS.importRequestBytes)
			throw new BandPlansError("BANDPLANS_IMPORT_TOO_LARGE")
		const parsed = importPreviewRequestSchema.safeParse(request)
		if (!parsed.success) throw new BandPlansError("BANDPLANS_INVALID")
		return detach(this.decodeAndParse(parsed.data).preview)
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
		const key = state ? `${state.storeId}:${state.revision}` : "unavailable"
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
	private presetView(preset: ScanPreset): ScanPresetView {
		const issues = this.deps.presetIssuesFor(
			preset,
			this.options.context.region,
		)
		return { preset, applicable: issues.length === 0, issues }
	}
	private decodeAndParse(file: {
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
		const result = this.deps.parseSdrppBandPlan(bytes, {
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
		const imported = this.decodeAndParse(parsed.data)
		if (imported.preview.sha256 !== parsed.data.previewSha256)
			throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
		return { mutation: parsed.data, parsedImport: detach(imported) }
	}
	private async commit(
		prepared: PreparedMutation,
	): Promise<BandPlanMutationResult> {
		const storage = this.storage
		// Admitted work finishes after close starts. A latched store does not.
		if (this.closed || storage === undefined || !storage.isAvailable())
			throw unavailable()
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

function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, "base64"))
}
