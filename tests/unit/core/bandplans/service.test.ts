import { createHash, randomUUID } from "node:crypto"
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import {
	BANDPLAN_SCANNER_PROTOCOLS,
	BANDPLANS_LIMITS,
	BUILTIN_PACK_IDS,
} from "@wavekit/api-types"
import type {
	BandPlanMutation,
	BandPlanPack,
	BandPlanState,
	BandRegion,
	BuiltinScanPreset,
	DisplayGroup,
	ScanPresetJob,
	StoredBand,
} from "@wavekit/api-types"
import fc from "fast-check"
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { mountFastTemp } from "../../../helpers/bandplans/temp-volume.js"
import type { FastTemp } from "../../../helpers/bandplans/temp-volume.js"
import {
	previewDigestFor,
	transition as domainTransition,
} from "../../../../src/core/bandplans/domain.js"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import type {
	BandPlanService,
	BandPlanServiceOptions,
	BandPlanStoreUnavailableReason,
	ParsedImport,
	ParsedImportPreview,
	SdrppParseResult,
	TransitionResult,
} from "../../../../src/core/bandplans/contract.js"
import { parseGqrxBandPlan } from "../../../../src/core/bandplans/import/gqrx.js"
import { parseSdrSharpBandPlan } from "../../../../src/core/bandplans/import/sdrsharp.js"
import { createBandPlanService } from "../../../../src/core/bandplans/service.js"
import type { BandPlanServiceDeps } from "../../../../src/core/bandplans/service.js"
import {
	BANDPLAN_READ_ONLY_EMPTY_STORE_ID,
	BandPlanStorage,
	validateBandPlanState,
} from "../../../../src/core/bandplans/storage.js"

const REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegion[]
const roots: string[] = []
const services: BandPlanService[] = []
let volume: FastTemp | undefined
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(
		services.splice(0).map(service => service.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(path => rm(path, { recursive: true, force: true })),
	)
})
async function root() {
	if (!volume) throw new Error("temp volume is not mounted")
	const path = await volume.mkdtemp("wavekit-bandplans-service-")
	roots.push(path)
	return path
}
const stateFile = (path: string) => join(path, "bandplans", "state.json")
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}
const JOB: ScanPresetJob = {
	mode: null,
	bandplans: ["airband"],
	ranges: [],
	exclusions: [],
	protocols: [],
	sensitivity: null,
	thresholdDb: null,
	fftSize: null,
	integrationMs: null,
	dwellMs: null,
	settleMs: null,
}
function band(id: string, provenance: StoredBand["provenance"]): StoredBand {
	return {
		id,
		name: id,
		startHz: 118000000,
		endHz: 137000000,
		group: "air",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint: null,
		registryRef: null,
		scan: null,
		provenance,
	}
}
function projectBuiltinPacks(): BandPlanPack[] {
	return REGIONS.map(region => ({
		id: `builtin-${region.toLowerCase()}`,
		kind: "builtin" as const,
		name: `Built-in (${region})`,
		region,
		provenance: { kind: "builtin" as const },
		bands: [
			{
				id: "airband",
				name: "Airband",
				startHz: 118000000,
				endHz: 137000000,
				group: "air",
				mode: null,
				bandwidthHz: null,
				stepHz: null,
				skip: null,
				channels: [],
				parentId: null,
				colourHint: null,
				registryRef: null,
				scan: {
					bandplanId: "airband",
					ranges: [{ startHz: 118000000, endHz: 137000000 }],
				},
				provenance: { kind: "builtin" },
			},
		],
	}))
}
function builtinPresetsFor(region: BandRegion): readonly BuiltinScanPreset[] {
	return [
		{
			kind: "builtin",
			id: "builtin-airband",
			name: `Air ${region}`,
			region,
			job: JOB,
		},
	]
}
function importedBand(name: string): StoredBand {
	return {
		...band("b-row", { kind: "imported" }),
		name,
		group: "amateur",
		colourHint: "#112233",
	}
}
interface Harness {
	deps: BandPlanServiceDeps
	resolves: () => number
	parses: {
		readonly byteLength: number
		readonly sha256: string
		readonly sourceType: string | undefined
	}[]
	randomHex12: () => string
}
function makeDeps(
	transition: BandPlanServiceDeps["transition"] = defaultTransition,
): Harness {
	const parses: {
		byteLength: number
		sha256: string
		sourceType: string | undefined
	}[] = []
	let resolves = 0
	let hex = 0
	const deps: BandPlanServiceDeps = {
		projectBuiltinPacks,
		builtinPackIdFor: region => `builtin-${region.toLowerCase()}`,
		resolveBandPlans: input => {
			resolves += 1
			return {
				bands: [],
				shadowed: [],
				hidden: [],
				orphanedEdits: input.edits
					.filter(edit => {
						const pack = input.packs.get(edit.packId)
						return (
							pack !== undefined &&
							!pack.bands.some(item => item.id === edit.bandId)
						)
					})
					.map(edit => ({ packId: edit.packId, bandId: edit.bandId })),
			}
		},
		transition,
		parseSdrppBandPlan: (bytes, options): SdrppParseResult => {
			const sha256 = createHash("sha256").update(bytes).digest("hex")
			parses.push({
				byteLength: bytes.byteLength,
				sha256,
				sourceType: options.overrides.keys().next().value,
			})
			if (bytes.byteLength === 0)
				return { ok: false, code: "BANDPLANS_IMPORT_INVALID", reason: "empty" }
			if (bytes.byteLength > BANDPLANS_LIMITS.importFileBytes)
				return {
					ok: false,
					code: "BANDPLANS_IMPORT_TOO_LARGE",
					reason: "row-limit",
				}
			const stored = importedBand(`Band ${sha256.slice(0, 8)}`)
			const sourceType = options.overrides.keys().next().value
			const preview: ParsedImportPreview = {
				format: "sdrpp-json",
				fileName: options.fileName,
				bytes: bytes.byteLength,
				sha256,
				meta: {
					name: null,
					countryName: null,
					countryCode: null,
					author: null,
					version: null,
				},
				trust: "community-unverified",
				bands: [{ ...stored, channels: [] }],
				report: {
					rowsTotal: 1,
					accepted: 1,
					skipped: [],
					groupMapping: sourceType
						? [
								{
									sourceType,
									group: "amateur" as const,
									rule: "override" as const,
									count: 1,
								},
							]
						: [],
					mapped: 1,
					toOther: 0,
					colourHints: 1,
				},
			}
			return { ok: true, value: { preview, bands: [stored] } }
		},
		builtinPresetsFor,
		presetIssuesFor: preset =>
			preset.job.bandplans
				.filter(id => id === "missing")
				.map(bandplanId => ({ code: "unknown-bandplan" as const, bandplanId })),
		presetToJobSpec: preset => ({ name: preset.name }),
	}
	return {
		deps,
		resolves: () => resolves,
		parses,
		randomHex12: () => {
			hex += 1
			return hex.toString(16).padStart(12, "0")
		},
	}
}
function defaultTransition(
	state: BandPlanState,
	mutation: BandPlanMutation,
	context: { now: () => string; randomHex12: () => string },
	parsedImport: ParsedImport | null,
): TransitionResult {
	if (
		mutation.expected.storeId !== state.storeId ||
		mutation.expected.revision !== state.revision
	)
		throw new BandPlansError("BANDPLANS_CONFLICT", {
			storeId: state.storeId,
			revision: state.revision,
		})
	const next = structuredClone(state)
	let createdId: string | null = null
	if (mutation.type === "reset-stack") next.stack = null
	else if (mutation.type === "set-stack")
		next.stack = mutation.entries.map(entry => ({ ...entry }))
	else if (mutation.type === "commit-import") {
		if (!parsedImport) throw new BandPlansError("BANDPLANS_IMPORT_INVALID")
		createdId = `imported-${context.randomHex12()}`
		next.importedPacks = [
			{
				id: createdId,
				name: mutation.name ?? "Imported",
				provenance: {
					kind: "imported",
					trust: "community-unverified",
					format: parsedImport.preview.format,
					sourceName: mutation.fileName,
					author: mutation.author,
					licence: mutation.licence,
					importedAt: context.now(),
					sha256: parsedImport.preview.sha256,
				},
				bands: structuredClone(parsedImport.bands) as StoredBand[],
			},
		]
	} else throw new BandPlansError("BANDPLANS_INVALID")
	if (JSON.stringify(next) === JSON.stringify(state))
		return { changed: false, state, createdId: null }
	next.revision += 1
	return { changed: true, state: validateBandPlanState(next), createdId }
}
async function open(
	stateDir: string,
	extras: Partial<
		Omit<BandPlanServiceOptions, "stateDir" | "context" | "writable">
	> & {
		context?: BandPlanServiceOptions["context"]
		writable?: boolean
		transition?: BandPlanServiceDeps["transition"]
		parseSdrppBandPlan?: BandPlanServiceDeps["parseSdrppBandPlan"]
		importParsers?: BandPlanServiceDeps["importParsers"]
		builtinPresetsFor?: BandPlanServiceDeps["builtinPresetsFor"]
		presetIssuesFor?: BandPlanServiceDeps["presetIssuesFor"]
		scannerBandplans?: BandPlanServiceDeps["scannerBandplans"]
	} = {},
) {
	const harness = makeDeps(extras.transition)
	const deps: BandPlanServiceDeps = {
		...harness.deps,
		...(extras.parseSdrppBandPlan
			? { parseSdrppBandPlan: extras.parseSdrppBandPlan }
			: {}),
		...(extras.importParsers ? { importParsers: extras.importParsers } : {}),
		...(extras.builtinPresetsFor
			? { builtinPresetsFor: extras.builtinPresetsFor }
			: {}),
		...(extras.presetIssuesFor
			? { presetIssuesFor: extras.presetIssuesFor }
			: {}),
		...(extras.scannerBandplans
			? { scannerBandplans: extras.scannerBandplans }
			: {}),
	}
	const service = await createBandPlanService(
		{
			stateDir,
			context: extras.context ?? { region: "EU", effectiveCountry: null },
			writable: extras.writable ?? true,
			domain: extras.domain ?? {
				now: () => "2026-10-13T00:00:00.000Z",
				uuid: () => "ea9f7e26-8b4d-44b6-90d5-92c7048b0173",
				randomHex12: harness.randomHex12,
			},
			...(extras.onCommit ? { onCommit: extras.onCommit } : {}),
			...(extras.onStoreUnavailable
				? { onStoreUnavailable: extras.onStoreUnavailable }
				: {}),
			...(extras.storageStage ? { storageStage: extras.storageStage } : {}),
		},
		deps,
	)
	services.push(service)
	return { service, ...harness }
}
function token(service: BandPlanService) {
	const store = service.view().store
	if (store.state !== "available" || store.storeId === null)
		throw new Error("store unavailable")
	return { storeId: store.storeId, revision: store.revision }
}
function setStack(
	expected: { storeId: string; revision: number },
	packId: (typeof BUILTIN_PACK_IDS)[number],
): {
	type: "set-stack"
	expected: { storeId: string; revision: number }
	entries: { packId: (typeof BUILTIN_PACK_IDS)[number]; enabled: boolean }[]
} {
	return {
		type: "set-stack",
		expected,
		entries: [{ packId, enabled: true }],
	}
}
function resetStack(expected: {
	storeId: string
	revision: number
}): BandPlanMutation {
	return { type: "reset-stack", expected }
}
function fileFields(
	bytes: Uint8Array,
	overrides: { sourceType: string; group: DisplayGroup }[] = [],
) {
	return {
		format: "sdrpp-json" as const,
		fileName: "plan.json",
		contentBase64: Buffer.from(bytes).toString("base64"),
		groupOverrides: overrides,
	}
}
function commitOf(
	expected: { storeId: string; revision: number },
	bytes: Uint8Array,
	previewDigest: string,
	overrides: { sourceType: string; group: DisplayGroup }[] = [],
): BandPlanMutation {
	return {
		type: "commit-import",
		expected,
		...fileFields(bytes, overrides),
		previewDigest,
		name: null,
		author: null,
		licence: null,
		keepColourHints: true,
		replacesPackId: null,
		addToStack: false,
	}
}
function rejection(error: unknown) {
	return error
}

describe("band plan service", { timeout: 60_000 }, () => {
	beforeAll(() => {
		volume = mountFastTemp()
	})
	afterAll(() => {
		volume?.destroy()
	})
	it("does not import lane modules or export openBandPlanService", async () => {
		const service = await readFile(
			new URL("../../../../src/core/bandplans/service.ts", import.meta.url),
			"utf8",
		)
		const storage = await readFile(
			new URL("../../../../src/core/bandplans/storage.ts", import.meta.url),
			"utf8",
		)
		expect(service).not.toMatch(
			/from "\.\/(?:resolve|builtin-packs|presets|import\/)/,
		)
		expect(service).toMatch(/from "\.\/domain\.js"/)
		expect(service).not.toMatch(/operator-data/)
		expect(service).not.toMatch(/from ["'][^"']*scanner/)
		expect(service).not.toMatch(
			/export (?:async )?function openBandPlanService/,
		)
		expect(service).toMatch(/export async function createBandPlanService/)
		expect(storage).not.toMatch(/from "\.\/service\.js"|operator-data|scanner/)
	})

	// Feature: band-plans, Property 7: CAS and revision
	// Validates: Requirements 8.2
	it("rejects stale tokens, skips no-op persistence, and admits one winner", async () => {
		const path = await root()
		let writes = 0
		const sink = vi.fn(() => undefined)
		const { service } = await open(path, {
			onCommit: sink,
			storageStage: stage => {
				if (stage === "temp-open") writes += 1
			},
		})
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 5 }),
				fc.integer({ min: 1, max: 40 }),
				async (slot, staleOffset) => {
					writes = 0
					sink.mockClear()
					const view = service.view()
					if (view.store.state !== "available" || view.store.storeId === null)
						throw new Error("store unavailable")
					const before = {
						storeId: view.store.storeId,
						revision: view.store.revision,
					}
					const currentId =
						view.stack.source === "operator"
							? view.stack.entries[0]?.packId
							: undefined
					const choices = BUILTIN_PACK_IDS.filter(id => id !== currentId)
					const left = choices[slot % choices.length]
					const right = choices[(slot + 1) % choices.length]
					if (!left || !right) throw new Error("missing pack choice")
					await expect(
						service.mutate({
							...setStack(before, left),
							expected: { ...before, revision: before.revision + staleOffset },
						}),
					).rejects.toMatchObject({
						code: "BANDPLANS_CONFLICT",
						current: before,
					})
					const noop =
						view.stack.source === "default"
							? resetStack(before)
							: {
									type: "set-stack" as const,
									expected: before,
									entries: view.stack.entries.map(entry => ({
										packId: entry.packId,
										enabled: entry.enabled,
									})),
								}
					const skipped = await service.mutate(noop)
					expect(skipped).toMatchObject({
						changed: false,
						createdId: null,
						delivery: "not-needed",
					})
					expect(writes).toBe(0)
					expect(sink).not.toHaveBeenCalled()
					const results = await Promise.allSettled([
						service.mutate(setStack(before, left)),
						service.mutate(setStack(before, right)),
					])
					expect(results[0]?.status).toBe("fulfilled")
					expect(results[1]).toMatchObject({
						status: "rejected",
						reason: {
							code: "BANDPLANS_CONFLICT",
							current: token(service),
						},
					})
					expect(token(service).revision).toBe(before.revision + 1)
					expect(writes).toBe(1)
					expect(sink).toHaveBeenCalledTimes(1)
					expect(sink).toHaveBeenCalledWith({
						storeId: before.storeId,
						revision: before.revision + 1,
					})
					expect(
						JSON.parse(await readFile(stateFile(path), "utf8")).stack,
					).toEqual([{ packId: left, enabled: true }])
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 9: Unavailable degradation
	// Validates: Requirements 8.4
	it("serves built-ins and rejects every mutation when the store cannot open", async () => {
		const harness = makeDeps()
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...REGIONS),
				fc.constantFrom(null, "FR"),
				fc.boolean(),
				async (region, effectiveCountry, writable) => {
					const service = await createBandPlanService(
						{
							stateDir: "relative",
							context: { region, effectiveCountry },
							writable,
						},
						harness.deps,
					)
					services.push(service)
					const view = service.view()
					expect(view.store).toEqual({ state: "unavailable" })
					expect(view.stack).toEqual({
						source: "default",
						entries: [
							{
								packId: `builtin-${region.toLowerCase()}`,
								enabled: true,
								kind: "builtin",
								name: `Built-in (${region})`,
							},
						],
					})
					expect(view.operatorBands).toEqual([])
					expect(view.edits).toEqual([])
					expect(view.orphanedEdits).toEqual([])
					expect(view.packs.map(pack => pack.id)).toEqual(
						REGIONS.map(item => `builtin-${item.toLowerCase()}`),
					)
					expect(view.context).toEqual({ region, effectiveCountry })
					expect(view.capabilities).toEqual({
						writable,
						importFormats: ["sdrpp-json"],
					})
					const presets = service.presets()
					expect(presets.store).toEqual({ state: "unavailable" })
					expect(presets.presets.map(item => item.preset.kind)).toEqual([
						"builtin",
					])
					expect(service.resolved().store).toEqual({ state: "unavailable" })
					expect(
						service.pack(`builtin-${region.toLowerCase()}`).pack.region,
					).toBe(region)
					expect(service.presetJob("builtin-airband").spec).toEqual({
						name: `Air ${region}`,
					})
					await expect(
						service.mutate({ type: "reset-stack" }),
					).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
					await service.close()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 12: Preview-commit equivalence
	// Validates: Requirements 6.6
	it("stores exactly the previewed bands and rejects different bytes", async () => {
		const path = await root()
		const { service, parses } = await open(path)
		await fc.assert(
			fc.asyncProperty(
				fc.uint8Array({ minLength: 1, maxLength: 24 }),
				fc.integer({ min: 0, max: 255 }),
				async (bytes, extra) => {
					parses.length = 0
					const before = await readFile(stateFile(path))
					const preview = service.previewImport(fileFields(bytes))
					expect(preview.sha256).toBe(
						createHash("sha256").update(bytes).digest("hex"),
					)
					expect(preview.previewDigest).toBe(
						previewDigestFor(preview.sha256, []),
					)
					expect(await readFile(stateFile(path))).toEqual(before)
					const committed = await service.mutate(
						commitOf(token(service), bytes, preview.previewDigest),
					)
					expect(committed.changed).toBe(true)
					expect(committed.createdId).toMatch(/^imported-[0-9a-f]{12}$/)
					expect(service.pack(committed.createdId ?? "").pack.bands).toEqual(
						preview.bands,
					)
					const other = Uint8Array.from([...bytes, extra])
					await expect(
						service.mutate(
							commitOf(token(service), other, preview.previewDigest),
						),
					).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_MISMATCH" })
					expect(service.pack(committed.createdId ?? "").pack.bands).toEqual(
						preview.bands,
					)
					expect(parses.map(item => item.sha256)).toEqual([
						preview.sha256,
						preview.sha256,
						createHash("sha256").update(other).digest("hex"),
					])
				},
			),
			{ numRuns: 100 },
		)
	})

	it("keeps stored layers unavailable after a post-rename failure until reopen", async () => {
		const path = await root()
		let armed = false
		const { service } = await open(path, {
			storageStage: stage => {
				if (armed && stage === "directory-sync") throw new Error("sync fault")
			},
		})
		const before = token(service)
		armed = true
		await expect(
			service.mutate(setStack(before, "builtin-eu")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(service.view().store).toEqual({ state: "unavailable" })
		expect(service.view().stack.source).toBe("default")
		expect(service.view().operatorBands).toEqual([])
		expect(JSON.parse(await readFile(stateFile(path), "utf8")).revision).toBe(1)
		await expect(
			service.mutate(setStack(before, "builtin-us")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(service.pack("builtin-eu").pack.kind).toBe("builtin")
		await service.close()
		const reopened = await open(path)
		expect(reopened.service.view().store).toMatchObject({
			state: "available",
			revision: 1,
		})
		expect(reopened.service.view().stack).toMatchObject({
			source: "operator",
			entries: [
				expect.objectContaining({ packId: "builtin-eu", enabled: true }),
			],
		})
	})

	it("keeps the previous revision available when a pre-rename write fails", async () => {
		const path = await root()
		let armed = false
		const { service } = await open(path, {
			storageStage: stage => {
				if (armed && stage === "temp-write") throw new Error("write fault")
			},
		})
		const before = token(service)
		armed = true
		await expect(
			service.mutate(setStack(before, "builtin-eu")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(token(service)).toEqual(before)
		expect(service.view().stack.source).toBe("default")
		armed = false
		const retried = await service.mutate(setStack(before, "builtin-eu"))
		expect(retried.changed).toBe(true)
		expect(token(service).revision).toBe(1)
	})

	it("rejects writes when writable is false and still serves stored reads", async () => {
		const path = await root()
		const first = await open(path)
		await first.service.mutate(setStack(token(first.service), "builtin-us"))
		await first.service.close()
		const { service } = await open(path, { writable: false })
		expect(service.view().capabilities.writable).toBe(false)
		expect(service.view().stack.source).toBe("operator")
		const bytes = await readFile(stateFile(path))
		await expect(
			service.mutate(resetStack(token(service))),
		).rejects.toMatchObject({ code: "BANDPLANS_READ_ONLY" })
		let preview: unknown
		try {
			service.previewImport(fileFields(Uint8Array.of(1, 2, 3)))
		} catch (error) {
			preview = rejection(error)
		}
		expect(preview).toMatchObject({ code: "BANDPLANS_READ_ONLY" })
		expect(await readFile(stateFile(path))).toEqual(bytes)
		expect(service.presets().presets[0]?.preset.kind).toBe("builtin")
	})

	it("rejects schema, precondition, quota and import faults before taking a queue slot", async () => {
		const path = await root()
		const entered = gate()
		const blocked = gate()
		let armed = false
		const { service, parses } = await open(path, {
			storageStage: async stage => {
				if (armed && stage === "directory-sync") {
					entered.release()
					await blocked.promise
				}
			},
		})
		const before = token(service)
		armed = true
		const active = service.mutate(setStack(before, "builtin-eu"))
		await entered.promise
		await expect(service.mutate({ type: "reset-stack" })).rejects.toMatchObject(
			{
				code: "BANDPLANS_PRECONDITION_REQUIRED",
			},
		)
		await expect(
			service.mutate({ type: "not-a-mutation", expected: before }),
		).rejects.toMatchObject({ code: "BANDPLANS_INVALID" })
		await expect(
			service.mutate(commitOf(before, Uint8Array.of(), "ab".repeat(32))),
		).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_INVALID" })
		await expect(
			service.mutate(commitOf(before, Uint8Array.of(9), "ab".repeat(32))),
		).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_MISMATCH" })
		expect(parses).toHaveLength(2)
		const waiting = Array.from({ length: 16 }, () =>
			service.mutate(setStack(before, "builtin-us")),
		)
		await expect(
			service.mutate(setStack(before, "builtin-ca")),
		).rejects.toMatchObject({ code: "BANDPLANS_BUSY" })
		blocked.release()
		await active
		const settled = await Promise.allSettled(waiting)
		expect(settled).toHaveLength(16)
		for (const item of settled)
			expect(item).toMatchObject({
				status: "rejected",
				reason: { code: "BANDPLANS_CONFLICT" },
			})
		expect(token(service).revision).toBe(1)
		const again = await service.mutate(setStack(token(service), "builtin-ca"))
		expect(again.changed).toBe(true)
		expect(again.delivery).toBe("unmounted")
	})

	it("rejects an oversized request body with BANDPLANS_QUOTA", async () => {
		const { service } = await open(await root())
		const expected = token(service)
		const body = {
			type: "create-preset" as const,
			expected,
			preset: {
				name: "Big",
				job: {
					...JOB,
					ranges: Array.from({ length: 64 }, () => ({
						startHz: 1,
						endHz: 100,
						rasters: Array.from({ length: 8 }, () => ({
							spacingHz: 1,
							firstChannelHz: 1,
						})),
						obwHz: [1, 1, 1, 1, 1, 1, 1, 1],
						protocols: [...BANDPLAN_SCANNER_PROTOCOLS],
					})),
					exclusions: Array.from({ length: 256 }, () => ({
						startHz: 1,
						endHz: 2,
						reason: "x".repeat(200),
					})),
				},
			},
		}
		expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(
			BANDPLANS_LIMITS.requestBytes,
		)
		await expect(service.mutate(body)).rejects.toMatchObject({
			code: "BANDPLANS_QUOTA",
		})
		expect(token(service)).toEqual(expected)
	})

	it("publishes synchronously after the directory sync and never fails the mutation", async () => {
		const path = await root()
		const entered = gate()
		const blocked = gate()
		const order: string[] = []
		let armed = false
		let service!: BandPlanService
		const opened = await open(path, {
			storageStage: async stage => {
				if (armed && stage === "directory-sync") {
					order.push("sync-wait")
					entered.release()
					await blocked.promise
					order.push("sync-go")
				}
			},
			onCommit: event => {
				order.push(`sink:${event.revision}`)
				expect(service.view().store).toMatchObject({
					revision: event.revision,
				})
				return undefined
			},
		})
		service = opened.service
		armed = true
		let resolved = false
		const pending = service
			.mutate(setStack(token(service), "builtin-eu"))
			.then(result => {
				resolved = true
				order.push("response")
				return result
			})
		await entered.promise
		expect(resolved).toBe(false)
		expect(order).toEqual(["sync-wait"])
		expect(service.view().store).toMatchObject({
			state: "available",
			revision: 0,
		})
		blocked.release()
		const result = await pending
		expect(result.delivery).toBe("sent")
		expect(order).toEqual(["sync-wait", "sync-go", "sink:1", "response"])
		await service.close()
		const throwing = await open(path, {
			onCommit: () => {
				throw new Error("sink down")
			},
		})
		const failed = await throwing.service.mutate(
			setStack(token(throwing.service), "builtin-us"),
		)
		expect(failed).toMatchObject({ changed: true, delivery: "failed" })
		expect(token(throwing.service).revision).toBe(2)
		const asyncSink = await open(await root(), {
			onCommit: () => {
				const pendingSink: Promise<undefined> = Promise.reject(
					new Error("late"),
				)
				return pendingSink as unknown as undefined
			},
		})
		const asyncResult = await asyncSink.service.mutate(
			setStack(token(asyncSink.service), "builtin-eu"),
		)
		expect(asyncResult.delivery).toBe("failed")
		expect(token(asyncSink.service).revision).toBe(1)
	})

	it("drains admitted work on close and ignores a second close", async () => {
		const path = await root()
		const entered = gate()
		const blocked = gate()
		let armed = false
		const { service } = await open(path, {
			onCommit: () => undefined,
			storageStage: async stage => {
				if (armed && stage === "directory-sync") {
					entered.release()
					await blocked.promise
				}
			},
		})
		armed = true
		const pending = service.mutate(setStack(token(service), "builtin-eu"))
		await entered.promise
		const closing = service.close()
		expect(service.close()).toBe(closing)
		await expect(
			service.mutate(setStack(token(service), "builtin-us")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		blocked.release()
		await expect(pending).resolves.toMatchObject({
			changed: true,
			delivery: "sent",
		})
		await closing
		expect(service.view().store).toEqual({ state: "unavailable" })
		expect(service.view().stack.source).toBe("default")
		expect(JSON.parse(await readFile(stateFile(path), "utf8")).revision).toBe(1)
	})

	it("returns detached views, memoizes resolution per revision, and projects stored layers", async () => {
		const path = await root()
		const storage = await BandPlanStorage.open({ stateDir: path })
		const seeded = validateBandPlanState({
			...storage.snapshot(),
			stack: [
				{ packId: "builtin-us", enabled: false },
				{ packId: "imported-0123456789ab", enabled: true },
			],
			importedPacks: [
				{
					id: "imported-0123456789ab",
					name: "Community",
					provenance: {
						kind: "imported",
						trust: "community-unverified",
						format: "sdrpp-json",
						sourceName: "community.json",
						author: null,
						licence: null,
						importedAt: "2026-10-13T00:00:00.000Z",
						sha256: "ab".repeat(32),
					},
					bands: [importedBand("Local two metre")],
				},
			],
			operatorBands: [band("op-local", { kind: "operator" })],
			edits: [
				{
					packId: "builtin-eu",
					bandId: "airband",
					set: { hidden: true },
					updatedAt: "2026-10-13T00:00:00.000Z",
				},
				{
					packId: "builtin-eu",
					bandId: "missing",
					set: { name: "Renamed" },
					updatedAt: "2026-10-13T00:00:00.000Z",
				},
			],
			presets: [
				{
					kind: "operator",
					id: randomUUID(),
					name: "Local",
					job: { ...JOB, bandplans: ["missing"] },
					createdAt: "2026-10-13T00:00:00.000Z",
					updatedAt: "2026-10-13T00:00:00.000Z",
				},
			],
			revision: 3,
		})
		await storage.persist(seeded)
		await storage.close()
		const { service, resolves } = await open(path, {
			context: { region: "EU", effectiveCountry: "FR" },
		})
		const view = service.view()
		expect(view.store).toEqual({
			state: "available",
			storeId: seeded.storeId,
			revision: 3,
		})
		expect(view.stack.source).toBe("operator")
		expect(view.stack.entries.map(entry => entry.packId)).toEqual([
			"builtin-us",
			"imported-0123456789ab",
		])
		expect(view.stack.entries[1]).toMatchObject({
			kind: "imported",
			name: "Community",
			enabled: true,
		})
		expect(view.operatorBands.map(item => item.id)).toEqual(["op-local"])
		expect(view.orphanedEdits).toEqual([
			{ packId: "builtin-eu", bandId: "missing" },
		])
		expect(view.packs.find(pack => pack.id === "builtin-eu")?.editCount).toBe(2)
		const presets = service.presets()
		expect(presets.presets.map(item => item.preset.kind)).toEqual([
			"builtin",
			"operator",
		])
		expect(presets.presets[1]).toMatchObject({ applicable: false })
		expect(service.presetJob("builtin-airband").issues).toEqual([])
		expect(service.presetJob(seeded.presets[0]?.id ?? "").issues).toEqual([
			{ code: "unknown-bandplan", bandplanId: "missing" },
		])
		expect(() => service.pack("operator")).toThrow(BandPlansError)
		expect(() => service.presetJob("missing-preset")).toThrow(BandPlansError)
		const pack = service.pack("builtin-eu")
		expect(pack.pack.bands[0]?.name).toBe("Airband")
		const shipped = pack.pack.bands[0] as { name: string } | undefined
		if (!shipped) throw new Error("missing built-in band")
		shipped.name = "mutated"
		;(view.edits as unknown as unknown[]).splice(0, view.edits.length)
		expect(service.pack("builtin-eu").pack.bands[0]?.name).toBe("Airband")
		expect(service.view().edits).toHaveLength(2)
		expect(resolves()).toBe(1)
		service.resolved()
		expect(resolves()).toBe(1)
		const request = setStack(token(service), "builtin-ca")
		const pending = service.mutate(request)
		request.entries[0]!.enabled = false
		request.entries[0]!.packId = "builtin-jp"
		const written = await pending
		expect(written.view.stack.entries[0]).toMatchObject({
			packId: "builtin-ca",
			enabled: true,
		})
		expect(resolves()).toBe(2)
		expect(service.view().context.effectiveCountry).toBe("FR")
	})

	it("forwards import overrides and leaves an invalid preview unpersisted", async () => {
		const path = await root()
		const { service, parses } = await open(path)
		const bytes = Uint8Array.of(4, 5, 6)
		const overrides = [{ sourceType: "Aviation", group: "air" as const }]
		const before = await readFile(stateFile(path))
		const preview = service.previewImport(fileFields(bytes, overrides))
		expect(preview.report.groupMapping[0]?.sourceType).toBe("Aviation")
		expect(await readFile(stateFile(path))).toEqual(before)
		let invalid: unknown
		try {
			service.previewImport({ format: "sdrpp-json" })
		} catch (error) {
			invalid = error
		}
		expect(invalid).toMatchObject({ code: "BANDPLANS_INVALID" })
		expect(await readFile(stateFile(path))).toEqual(before)
		await service.mutate(
			commitOf(token(service), bytes, preview.previewDigest, overrides),
		)
		expect(parses.map(item => item.sourceType)).toEqual([
			"Aviation",
			"Aviation",
		])
	})

	it("legacy open creates nothing and rejects mutations as read-only", async () => {
		const path = await root()
		const before = await readdir(path)
		const reasons: BandPlanStoreUnavailableReason[] = []
		const { service } = await open(path, {
			writable: false,
			onStoreUnavailable: reason => {
				reasons.push(reason)
			},
		})
		expect(reasons).toEqual([])
		expect(await readdir(path)).toEqual(before)
		expect(service.view().store).toEqual({
			state: "available",
			storeId: null,
			revision: 0,
		})
		expect(JSON.stringify(service.view())).not.toContain(
			BANDPLAN_READ_ONLY_EMPTY_STORE_ID,
		)
		expect(service.presets().store).toEqual(service.view().store)
		expect(service.resolved().store).toEqual(service.view().store)
		expect(service.view().stack.source).toBe("default")
		expect(service.view().capabilities.writable).toBe(false)
		await expect(
			service.mutate({
				type: "reset-stack",
				expected: {
					storeId: "00000000-0000-4000-8000-000000000001",
					revision: 0,
				},
			}),
		).rejects.toMatchObject({ code: "BANDPLANS_READ_ONLY" })
		let preview: unknown
		try {
			service.previewImport(fileFields(Uint8Array.of(1)))
		} catch (error) {
			preview = error
		}
		expect(preview).toMatchObject({ code: "BANDPLANS_READ_ONLY" })
		const closing = service.close()
		expect(service.close()).toBe(closing)
		await closing
		expect(await readdir(path)).toEqual(before)
	})

	it("read-only open serves state from a writable service despite a stale lock", async () => {
		const path = await root()
		const first = await open(path)
		await first.service.mutate(setStack(token(first.service), "builtin-us"))
		const stored = token(first.service)
		await first.service.close()
		await mkdir(join(path, "bandplans", ".writer-lock"), { mode: 0o700 })
		const reasons: BandPlanStoreUnavailableReason[] = []
		const { service } = await open(path, {
			writable: false,
			onStoreUnavailable: reason => {
				reasons.push(reason)
			},
		})
		expect(reasons).toEqual([])
		expect(token(service)).toEqual(stored)
		expect(service.view().stack).toMatchObject({
			source: "operator",
			entries: [expect.objectContaining({ packId: "builtin-us" })],
		})
		await expect(
			service.mutate(resetStack(token(service))),
		).rejects.toMatchObject({ code: "BANDPLANS_READ_ONLY" })
		expect(
			(await lstat(join(path, "bandplans", ".writer-lock"))).isDirectory(),
		).toBe(true)
	})

	it.each([
		["invalid", "invalid"],
		["oversized", "oversized"],
		["permissions", "permissions"],
		["io", "io"],
		["lock-held", "lock-held"],
	] as const)(
		"reports %s exactly once when open cannot use the store",
		async (kind, reason) => {
			const path = await root()
			if (kind !== "io" && kind !== "lock-held") {
				const seeded = await open(path)
				await seeded.service.close()
			}
			if (kind === "invalid") await writeFile(stateFile(path), "{bad")
			if (kind === "oversized")
				await writeFile(
					stateFile(path),
					"x".repeat(BANDPLANS_LIMITS.stateBytes + 1),
				)
			if (kind === "permissions") await chmod(stateFile(path), 0o644)
			if (kind === "lock-held") {
				const holder = await open(path)
				expect(holder.service.view().store.state).toBe("available")
			}
			const reasons: BandPlanStoreUnavailableReason[] = []
			const { service } = await open(path, {
				...(kind === "io"
					? {
							storageStage: (stage: string) => {
								if (stage === "parent-sync") throw new Error("sync fault")
							},
						}
					: {}),
				onStoreUnavailable: reported => {
					reasons.push(reported)
				},
			})
			expect(reasons).toEqual([reason])
			expect(service.view().store).toEqual({ state: "unavailable" })
			await expect(
				service.mutate({ type: "reset-stack" }),
			).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
			expect(reasons).toEqual([reason])
		},
	)

	it("ignores a throwing unavailable listener and still opens degraded", async () => {
		let calls = 0
		const { service } = await open("relative", {
			writable: false,
			onStoreUnavailable: () => {
				calls += 1
				throw new Error("listener")
			},
		})
		expect(calls).toBe(1)
		expect(service.view().store).toEqual({ state: "unavailable" })
		expect(service.view().stack.source).toBe("default")
	})

	it("reports a post-rename latch once and stays quiet on a pre-rename miss", async () => {
		const path = await root()
		const reasons: BandPlanStoreUnavailableReason[] = []
		let armed = false
		let stageName = "temp-write"
		const { service } = await open(path, {
			onStoreUnavailable: reason => {
				reasons.push(reason)
			},
			storageStage: stage => {
				if (armed && stage === stageName) throw new Error("fault")
			},
		})
		expect(reasons).toEqual([])
		const before = token(service)
		armed = true
		await expect(
			service.mutate(setStack(before, "builtin-eu")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(reasons).toEqual([])
		expect(token(service)).toEqual(before)
		stageName = "directory-sync"
		await expect(
			service.mutate(setStack(before, "builtin-eu")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(reasons).toEqual(["io"])
		expect(service.view().store).toEqual({ state: "unavailable" })
		await expect(
			service.mutate(setStack(before, "builtin-us")),
		).rejects.toMatchObject({ code: "BANDPLANS_UNAVAILABLE" })
		expect(reasons).toEqual(["io"])
		expect(JSON.parse(await readFile(stateFile(path), "utf8")).revision).toBe(1)
	})

	it("stops at the state-byte quota with the file and revision unchanged", async () => {
		const path = await root()
		const channel = (index: number) => ({
			id: `c${String(index).padStart(63, "a")}`,
			name: "n".repeat(40),
			frequencyHz: 100_000_000_000,
			aliases: Array.from({ length: 8 }, () => "b".repeat(32)),
			registryRef: {
				familyId: "f".repeat(64),
				rowId: "r".repeat(64),
			},
		})
		const inputOf = (count: number) => ({
			name: "B".repeat(80),
			startHz: 1,
			endHz: 100_000_000_000,
			group: "land-mobile" as const,
			mode: "nfm" as const,
			bandwidthHz: 10_000_000,
			stepHz: 10_000_000,
			skip: { reason: "s".repeat(80) },
			channels: Array.from({ length: count }, (_, index) => channel(index)),
			parentId: null,
			colourHint: "#abcdef",
			registryRef: {
				familyId: "f".repeat(64),
				rowId: "r".repeat(64),
			},
		})
		const requestSized = (count: number) =>
			Buffer.byteLength(
				JSON.stringify({
					type: "create-operator-band",
					expected: {
						storeId: "00000000-0000-4000-8000-000000000000",
						revision: 9999,
					},
					band: inputOf(count),
				}),
			)
		let channels = 1
		while (
			channels < BANDPLANS_LIMITS.channelsPerBand &&
			requestSized(channels + 1) <= BANDPLANS_LIMITS.requestBytes
		)
			channels += 1
		const input = inputOf(channels)
		expect(requestSized(channels)).toBeLessThanOrEqual(
			BANDPLANS_LIMITS.requestBytes,
		)
		const stored = (index: number) => ({
			id: `op-a${index.toString(16).padStart(11, "0")}`,
			...input,
			scan: null,
			provenance: { kind: "operator" as const },
		})
		const storage = await BandPlanStorage.open({ stateDir: path })
		let seeded: ReturnType<typeof validateBandPlanState>
		try {
			const shell = storage.snapshot()
			const emptySize = Buffer.byteLength(
				JSON.stringify({ ...shell, operatorBands: [] }),
			)
			const bandSize = Buffer.byteLength(JSON.stringify(stored(0))) + 1
			// Two bands of headroom: one legal commit, then the quota rejection.
			const count = Math.max(
				1,
				Math.floor(
					(BANDPLANS_LIMITS.stateBytes - emptySize - bandSize * 2) / bandSize,
				),
			)
			seeded = validateBandPlanState({
				...shell,
				operatorBands: Array.from({ length: count }, (_, index) =>
					stored(index),
				),
			})
			expect(Buffer.byteLength(JSON.stringify(seeded))).toBeLessThanOrEqual(
				BANDPLANS_LIMITS.stateBytes,
			)
			expect(seeded.operatorBands.length).toBeLessThan(
				BANDPLANS_LIMITS.operatorBands,
			)
			await storage.persist(seeded)
		} finally {
			await storage.close()
		}
		const { service } = await open(path, { transition: domainTransition })
		const started = Date.now()
		let expected = {
			storeId: seeded.storeId,
			revision: seeded.revision,
		}
		let previous = await readFile(stateFile(path))
		let commits = 0
		for (;;) {
			expect(commits).toBeLessThan(4)
			const body = {
				type: "create-operator-band" as const,
				expected,
				band: input,
			}
			expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
				BANDPLANS_LIMITS.requestBytes,
			)
			try {
				await service.mutate(body)
			} catch (error) {
				expect(error).toMatchObject({ code: "BANDPLANS_QUOTA" })
				const after = await readFile(stateFile(path))
				expect(after.equals(previous)).toBe(true)
				expect(service.view().store).toMatchObject({
					state: "available",
					storeId: expected.storeId,
					revision: expected.revision,
				})
				expect(expected.revision).toBeGreaterThan(seeded.revision)
				expect(previous.byteLength).toBeGreaterThan(
					BANDPLANS_LIMITS.stateBytes - BANDPLANS_LIMITS.requestBytes,
				)
				expect(commits).toBeGreaterThan(0)
				expect(Date.now() - started).toBeLessThan(5_000)
				return
			}
			commits += 1
			expected = {
				storeId: expected.storeId,
				revision: expected.revision + 1,
			}
			previous = await readFile(stateFile(path))
			expect(previous.byteLength).toBeLessThanOrEqual(
				BANDPLANS_LIMITS.stateBytes,
			)
		}
	})

	it("round-trips a preview digest with overrides and rejects a mismatch unchanged", async () => {
		const path = await root()
		const { service } = await open(path)
		const bytes = Uint8Array.of(9, 8, 7, 6)
		const overrides = [
			{ sourceType: "PMR", group: "personal-radio" as const },
			{ sourceType: "Air", group: "air" as const },
		]
		const flipped = [overrides[1]!, overrides[0]!]
		const before = await readFile(stateFile(path))
		const preview = service.previewImport(fileFields(bytes, overrides))
		const again = service.previewImport(fileFields(bytes, flipped))
		expect(again.previewDigest).toBe(preview.previewDigest)
		expect(preview.previewDigest).toBe(
			previewDigestFor(preview.sha256, overrides),
		)
		expect(preview.previewDigest).not.toBe(preview.sha256)
		expect(await readFile(stateFile(path))).toEqual(before)
		const revision = token(service).revision
		const wrong =
			preview.previewDigest === "c".repeat(64) ? "d".repeat(64) : "c".repeat(64)
		await expect(
			service.mutate(commitOf(token(service), bytes, wrong, overrides)),
		).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_MISMATCH" })
		const changed = [
			{ sourceType: "PMR", group: "marine" as const },
			overrides[1]!,
		]
		expect(previewDigestFor(preview.sha256, changed)).not.toBe(
			preview.previewDigest,
		)
		await expect(
			service.mutate(
				commitOf(token(service), bytes, preview.previewDigest, changed),
			),
		).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_MISMATCH" })
		expect(await readFile(stateFile(path))).toEqual(before)
		expect(token(service).revision).toBe(revision)
		const committed = await service.mutate(
			commitOf(token(service), bytes, preview.previewDigest, flipped),
		)
		expect(committed.changed).toBe(true)
		expect(token(service).revision).toBe(revision + 1)
	})

	it("rejects a commit when the parser hash disagrees with the bytes", async () => {
		const path = await root()
		const bytes = Uint8Array.of(1, 2, 3, 4)
		const fake = "ab".repeat(32)
		const { service } = await open(path, {
			parseSdrppBandPlan: (_bytes, options) => ({
				ok: true,
				value: {
					preview: {
						format: "sdrpp-json",
						fileName: options.fileName,
						bytes: bytes.byteLength,
						sha256: fake,
						meta: {
							name: null,
							countryName: null,
							countryCode: null,
							author: null,
							version: null,
						},
						trust: "community-unverified",
						bands: [],
						report: {
							rowsTotal: 1,
							accepted: 1,
							skipped: [],
							groupMapping: [],
							mapped: 1,
							toOther: 0,
							colourHints: 0,
						},
					},
					bands: [importedBand("Lie")],
				},
			}),
		})
		const before = await readFile(stateFile(path))
		const preview = service.previewImport(fileFields(bytes))
		expect(preview.sha256).toBe(fake)
		expect(preview.previewDigest).toBe(previewDigestFor(fake, []))
		await expect(
			service.mutate(commitOf(token(service), bytes, preview.previewDigest)),
		).rejects.toMatchObject({ code: "BANDPLANS_IMPORT_MISMATCH" })
		expect(await readFile(stateFile(path))).toEqual(before)
		expect(token(service).revision).toBe(0)
	})

	it("passes effective plan ids once per preset call and omits them when unwired", async () => {
		const path = await root()
		const wiredCalls: unknown[] = []
		const wiredIds: Array<ReadonlySet<string> | undefined> = []
		const plans = [
			{ id: "airband", region: "EU" as const, name: "Air", ranges: [] },
			{ id: "marine", region: "EU" as const, name: "Marine", ranges: [] },
		]
		const presets = [
			{
				kind: "builtin" as const,
				id: "builtin-airband",
				name: "Air",
				region: "EU" as const,
				job: JOB,
			},
			{
				kind: "builtin" as const,
				id: "builtin-marine",
				name: "Marine",
				region: "EU" as const,
				job: { ...JOB, bandplans: ["marine", "missing-plan"] },
			},
		]
		const wired = await open(path, {
			builtinPresetsFor: () => presets,
			scannerBandplans: view => {
				wiredCalls.push(view)
				return plans
			},
			presetIssuesFor: (preset, _region, effectiveIds) => {
				wiredIds.push(effectiveIds)
				if (!effectiveIds)
					return [{ code: "unknown-bandplan" as const, bandplanId: "bp1" }]
				return preset.job.bandplans
					.filter(id => !effectiveIds.has(id))
					.map(bandplanId => ({
						code: "unknown-bandplan" as const,
						bandplanId,
					}))
			},
		})
		const list = wired.service.presets()
		expect(wiredCalls).toHaveLength(1)
		expect(wiredCalls[0]).not.toHaveProperty("presets")
		expect(wiredIds).toHaveLength(2)
		expect(wiredIds[0]).toEqual(new Set(["airband", "marine"]))
		expect(wiredIds[1]).toBe(wiredIds[0])
		expect(list.presets.map(item => item.applicable)).toEqual([true, false])
		expect(list.presets[1]?.issues).toEqual([
			{ code: "unknown-bandplan", bandplanId: "missing-plan" },
		])
		expect(wired.service.presetJob("builtin-airband").issues).toEqual([])
		expect(wiredCalls).toHaveLength(2)
		const plain = await open(path, {
			presetIssuesFor: (_preset, _region, effectiveIds) => {
				expect(effectiveIds).toBeUndefined()
				return [{ code: "unknown-bandplan" as const, bandplanId: "bp1" }]
			},
		})
		expect(plain.service.presetJob("builtin-airband").issues).toEqual([
			{ code: "unknown-bandplan", bandplanId: "bp1" },
		])
	})

	// Feature: band-plans, Property 21: Store identity
	// Validates: Requirements 11.8
	it("reports a null storeId only for the never-persisted read-only state", async () => {
		const nil = BANDPLAN_READ_ONLY_EMPTY_STORE_ID
		await fc.assert(
			fc.asyncProperty(
				fc.stringMatching(/^[0-9a-f]{12}$/),
				fc.integer({ min: 0, max: 8 }),
				fc.constantFrom(
					"writable",
					"readonly-file",
					"readonly-empty",
					"readonly-directory",
				),
				async (hex, revision, mode) => {
					const storeId = `00000000-0000-4000-8000-${hex.toLowerCase()}`
					const path = await root()
					if (mode === "readonly-directory" || mode === "readonly-file")
						await mkdir(join(path, "bandplans"), { mode: 0o700 })
					if (mode === "readonly-file") {
						const state = validateBandPlanState({
							version: 1,
							storeId,
							revision,
							stack: null,
							importedPacks: [],
							operatorBands: [],
							edits: [],
							presets: [],
						})
						const file = stateFile(path)
						await writeFile(file, JSON.stringify(state), { mode: 0o600 })
						await chmod(file, 0o600)
						await chmod(join(path, "bandplans"), 0o700)
					}
					const { service } = await open(path, {
						writable: mode === "writable",
					})
					const view = service.view()
					expect(view.store.state).toBe("available")
					if (view.store.state !== "available") return
					const unpersisted =
						mode === "readonly-empty" || mode === "readonly-directory"
					expect(view.store.storeId === null).toBe(unpersisted)
					expect(JSON.stringify(view)).not.toContain(nil)
					expect(service.presets().store).toEqual(view.store)
					expect(view.capabilities.writable).toBe(mode === "writable")
					if (unpersisted) {
						expect(view.store).toEqual({
							state: "available",
							storeId: null,
							revision: 0,
						})
						return
					}
					const file = JSON.parse(await readFile(stateFile(path), "utf8")) as {
						storeId: string
						revision: number
					}
					expect(view.store.storeId).toBe(file.storeId)
					expect(view.store.revision).toBe(file.revision)
					expect(typeof view.store.storeId).toBe("string")
					if (mode === "readonly-file") {
						expect(view.store.storeId).toBe(storeId)
						expect(view.store.revision).toBe(revision)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-5, Property 12: Import round trip
	// Validates: Requirements 7.2, 7.4, 7.6
	it("imports generated Gqrx files through injected parsers with a stable digest and the file's format", async () => {
		const path = await root()
		let committed: StoredBand[] = []
		let format: string | undefined
		let packId: string | null = null
		const { service } = await open(path, {
			importParsers: { "gqrx-csv": parseGqrxBandPlan },
			transition: (state, mutation, context, parsedImport) => {
				const result = domainTransition(state, mutation, context, parsedImport)
				const pack = result.state.importedPacks[0]
				if (pack) {
					committed = pack.bands
					format = pack.provenance.format
				}
				return result
			},
		})
		expect(service.view().capabilities.importFormats).toEqual([
			"sdrpp-json",
			"gqrx-csv",
		])
		const rowArb = fc.record({
			start: fc.integer({ min: 1, max: 1_000_000_000 }),
			width: fc.integer({ min: 1, max: 1_000_000 }),
			mode: fc.constantFrom("AM", "NFM", "WFM", "USB", "LSB", "CW", "Weird"),
			step: fc.integer({ min: 1, max: 100_000 }),
			colour: fc.integer({ min: 0, max: 0xffffff }),
		})
		await fc.assert(
			fc.asyncProperty(
				fc.array(rowArb, { minLength: 1, maxLength: 12 }),
				async rows => {
					const lines = rows.map(
						(row, i) =>
							`${row.start},${row.start + row.width},${row.mode},${row.step},#${row.colour.toString(16).padStart(6, "0")},Band ${i}`,
					)
					const bytes = Buffer.from(lines.join("\n"))
					const fields = { ...fileFields(bytes), format: "gqrx-csv" as const }
					const first = service.previewImport(fields)
					const second = service.previewImport(fields)
					expect(second.previewDigest).toBe(first.previewDigest)
					expect(first.format).toBe("gqrx-csv")
					expect(first.bands.map(b => [b.name, b.startHz, b.endHz])).toEqual(
						rows.map((row, i) => [
							`Band ${i}`,
							row.start,
							row.start + row.width,
						]),
					)
					expect(first.bands.map(b => b.stepHz)).toEqual(
						rows.map(row => row.step),
					)
					expect(first.bands.map(b => b.colourHint)).toEqual(
						rows.map(row => `#${row.colour.toString(16).padStart(6, "0")}`),
					)
					const view = service.view()
					if (view.store.state !== "available" || view.store.storeId === null)
						throw new Error("store unavailable")
					const result = await service.mutate({
						...commitOf(
							{ storeId: view.store.storeId, revision: view.store.revision },
							bytes,
							first.previewDigest,
						),
						format: "gqrx-csv",
						replacesPackId: packId,
					})
					packId = result.createdId ?? packId
					expect(format).toBe("gqrx-csv")
					expect(committed).toHaveLength(rows.length)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-5, Property 12: Import round trip
	// Validates: Requirements 7.1, 7.4, 7.6
	it("imports generated SDR# files through injected parsers with a stable digest and the file's format", async () => {
		const path = await root()
		let committed: StoredBand[] = []
		let format: string | undefined
		let packId: string | null = null
		const { service } = await open(path, {
			importParsers: { "sdrsharp-xml": parseSdrSharpBandPlan },
			transition: (state, mutation, context, parsedImport) => {
				const result = domainTransition(state, mutation, context, parsedImport)
				const pack = result.state.importedPacks[0]
				if (pack) {
					committed = pack.bands
					format = pack.provenance.format
				}
				return result
			},
		})
		expect(service.view().capabilities.importFormats).toEqual([
			"sdrpp-json",
			"sdrsharp-xml",
		])
		const rowArb = fc.record({
			start: fc.integer({ min: 1, max: 1_000_000_000 }),
			width: fc.integer({ min: 1, max: 1_000_000 }),
			mode: fc.constantFrom("AM", "NFM", "WFM", "USB", "LSB", "CW", "Weird"),
			step: fc.integer({ min: 1, max: 100_000 }),
		})
		await fc.assert(
			fc.asyncProperty(
				fc.array(rowArb, { minLength: 1, maxLength: 12 }),
				async rows => {
					const entries = rows.map(
						(row, i) =>
							`<RangeEntry minFrequency="${row.start}" maxFrequency="${row.start + row.width}" mode="${row.mode}" step="${row.step}">Band &amp; ${i}</RangeEntry>`,
					)
					const bytes = Buffer.from(
						`<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfRangeEntry>\n${entries.join("\n")}\n</ArrayOfRangeEntry>\n`,
					)
					const fields = {
						...fileFields(bytes),
						format: "sdrsharp-xml" as const,
					}
					const first = service.previewImport(fields)
					const second = service.previewImport(fields)
					expect(second.previewDigest).toBe(first.previewDigest)
					expect(first.format).toBe("sdrsharp-xml")
					expect(first.bands.map(b => [b.name, b.startHz, b.endHz])).toEqual(
						rows.map((row, i) => [
							`Band & ${i}`,
							row.start,
							row.start + row.width,
						]),
					)
					expect(first.bands.map(b => b.stepHz)).toEqual(
						rows.map(row => row.step),
					)
					const view = service.view()
					if (view.store.state !== "available" || view.store.storeId === null)
						throw new Error("store unavailable")
					const result = await service.mutate({
						...commitOf(
							{ storeId: view.store.storeId, revision: view.store.revision },
							bytes,
							first.previewDigest,
						),
						format: "sdrsharp-xml",
						replacesPackId: packId,
					})
					packId = result.createdId ?? packId
					expect(format).toBe("sdrsharp-xml")
					expect(committed).toHaveLength(rows.length)
				},
			),
			{ numRuns: 100 },
		)
	})
})
