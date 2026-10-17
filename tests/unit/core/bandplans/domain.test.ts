import { createHash } from "node:crypto"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	BANDPLANS_LIMITS,
	DISPLAY_GROUPS,
	bandPlanStateSchema,
} from "@wavekit/api-types"
import type {
	BandInput,
	BandPlanMutation,
	BandPlanPack,
	BandPlanState,
	BandRegion,
	StoredBand,
} from "@wavekit/api-types"
import {
	builtinPackIdFor,
	projectBuiltinPacks,
} from "../../../../src/core/bandplans/builtin-packs.js"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import type {
	DomainContext,
	ParsedImport,
	ResolverInput,
} from "../../../../src/core/bandplans/contract.js"
import {
	previewDigestFor,
	transition,
} from "../../../../src/core/bandplans/domain.js"
import { resolveBandPlans } from "../../../../src/core/bandplans/resolve.js"

const STORE = "00000000-0000-4000-8000-0000000000aa"
const NOW = "2026-01-02T00:00:00.000Z"
const EARLIER = "2026-01-01T00:00:00.000Z"

function empty(revision = 0): BandPlanState {
	return bandPlanStateSchema.parse({
		version: 1,
		storeId: STORE,
		revision,
		stack: null,
		importedPacks: [],
		operatorBands: [],
		edits: [],
		presets: [],
	})
}

function ctx(region: BandRegion = "EU", now = NOW): DomainContext {
	let hex = 0
	let uuid = 1
	return {
		region,
		now: () => now,
		randomHex12: () => {
			hex += 1
			return hex.toString(16).padStart(12, "0")
		},
		uuid: () => {
			uuid += 1
			return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`
		},
	}
}

function token(state: BandPlanState) {
	return { storeId: state.storeId, revision: state.revision }
}

function codeOf(run: () => unknown): string {
	try {
		run()
	} catch (error) {
		if (error instanceof BandPlansError) return error.code
		throw error
	}
	return ""
}

function bandInput(name = "Local", parentId: string | null = null): BandInput {
	return {
		name,
		startHz: 100,
		endHz: 200,
		group: "other",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId,
		colourHint: null,
		registryRef: null,
	}
}

function preset(name = "Local scan", bandplan = "airband") {
	return {
		name,
		job: {
			mode: null,
			bandplans: [bandplan],
			ranges: [],
			exclusions: [],
			protocols: [],
			sensitivity: null,
			thresholdDb: null,
			fftSize: null,
			integrationMs: null,
			dwellMs: null,
			settleMs: null,
		},
	}
}

function storedBand(
	id: string,
	name = id,
	colourHint: string | null = null,
): StoredBand {
	return {
		id,
		name,
		startHz: 100,
		endHz: 200,
		group: "other",
		mode: null,
		bandwidthHz: null,
		stepHz: null,
		skip: null,
		channels: [],
		parentId: null,
		colourHint,
		registryRef: null,
		scan: null,
		provenance: { kind: "imported" },
	}
}

function hashed(body: string) {
	const bytes = Buffer.from(body)
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		contentBase64: bytes.toString("base64"),
	}
}

function parsed(
	bands: readonly StoredBand[],
	sha256: string,
	metaName: string | null = "Meta",
): ParsedImport {
	return {
		preview: {
			format: "sdrpp-json",
			fileName: "community.json",
			bytes: 8,
			sha256,
			meta: {
				name: metaName,
				countryName: null,
				countryCode: null,
				author: "Meta Author",
				version: "1",
			},
			trust: "community-unverified",
			bands: [],
			report: {
				rowsTotal: bands.length,
				accepted: bands.length,
				skipped: [],
				groupMapping: [],
				mapped: 0,
				toOther: bands.length,
				colourHints: 0,
			},
		},
		bands,
	}
}

function commit(
	state: BandPlanState,
	file: { sha256: string; contentBase64: string },
	_bands: readonly StoredBand[],
	extra: Partial<Extract<BandPlanMutation, { type: "commit-import" }>> = {},
): BandPlanMutation {
	const groupOverrides = extra.groupOverrides ?? []
	const {
		previewDigest,
		groupOverrides: _groupOverrides,
		type: _type,
		expected: _expected,
		...rest
	} = extra
	return {
		type: "commit-import",
		expected: token(state),
		format: "sdrpp-json",
		fileName: "community.json",
		contentBase64: file.contentBase64,
		groupOverrides,
		name: null,
		author: null,
		licence: null,
		keepColourHints: false,
		replacesPackId: null,
		addToStack: true,
		...rest,
		previewDigest:
			previewDigest ?? previewDigestFor(file.sha256, groupOverrides),
	}
}

function asInput(
	state: BandPlanState,
	region: BandRegion = "EU",
): ResolverInput {
	const packs = new Map<string, BandPlanPack>(
		projectBuiltinPacks().map(pack => [pack.id, pack]),
	)
	for (const imported of state.importedPacks)
		packs.set(imported.id, {
			id: imported.id,
			kind: "imported",
			name: imported.name,
			region: null,
			provenance: imported.provenance,
			bands: imported.bands,
		})
	return {
		packs,
		stack: state.stack ?? [{ packId: builtinPackIdFor(region), enabled: true }],
		operatorBands: state.operatorBands,
		edits: state.edits,
	}
}

describe("band plan transitions", () => {
	it("rejects a stale token with the current one and leaves the argument unchanged", () => {
		const state = empty()
		const context = ctx()
		const created = transition(
			state,
			{
				type: "create-operator-band",
				expected: token(state),
				band: bandInput(),
			},
			context,
			null,
		)
		const before = structuredClone(created.state)
		let current: { storeId: string; revision: number } | undefined
		try {
			transition(
				created.state,
				{
					type: "reset-stack",
					expected: token(state),
				},
				context,
				null,
			)
			expect.fail("expected conflict")
		} catch (error) {
			expect(error).toBeInstanceOf(BandPlansError)
			current = (error as BandPlansError).current
		}
		expect(current).toEqual(token(created.state))
		expect(created.state).toEqual(before)
		expect(state).toEqual(empty())
	})

	it("stores an operator stack, treats an identical write as a no-op, and resets to null", () => {
		const state = empty()
		const entries = [{ packId: "builtin-eu" as const, enabled: true }]
		const stored = transition(
			state,
			{ type: "set-stack", expected: token(state), entries },
			ctx(),
			null,
		)
		expect(stored.changed).toBe(true)
		expect(stored.state.stack).toEqual(entries)
		expect(stored.state.revision).toBe(1)
		const again = transition(
			stored.state,
			{ type: "set-stack", expected: token(stored.state), entries },
			ctx(),
			null,
		)
		expect(again.changed).toBe(false)
		expect(again.state).toBe(stored.state)
		const cleared = transition(
			stored.state,
			{
				type: "set-stack",
				expected: token(stored.state),
				entries: [],
			},
			ctx(),
			null,
		)
		expect(cleared.state.stack).toEqual([])
		const reset = transition(
			cleared.state,
			{ type: "reset-stack", expected: token(cleared.state) },
			ctx(),
			null,
		)
		expect(reset.state.stack).toBeNull()
		const noop = transition(
			reset.state,
			{ type: "reset-stack", expected: token(reset.state) },
			ctx(),
			null,
		)
		expect(noop.changed).toBe(false)
		expect(noop.state.revision).toBe(reset.state.revision)
	})

	it("rejects an unknown stack pack and a duplicate stack", () => {
		const state = empty()
		expect(
			codeOf(() =>
				transition(
					state,
					{
						type: "set-stack",
						expected: token(state),
						entries: [{ packId: "imported-000000000099", enabled: true }],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
		expect(
			codeOf(() =>
				transition(
					state,
					{
						type: "set-stack",
						expected: token(state),
						entries: [
							{ packId: "builtin-eu", enabled: true },
							{ packId: "builtin-eu", enabled: false },
						],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		expect(state.revision).toBe(0)
	})

	it("stores a pack-equal edit, ignores a repeat, and drops the edit when the last field is reset", () => {
		const state = empty()
		const air = projectBuiltinPacks()
			.find(pack => pack.id === "builtin-eu")!
			.bands.find(item => item.id === "airband")!
		const renamed = transition(
			state,
			{
				type: "patch-band-edit",
				expected: token(state),
				packId: "builtin-eu",
				bandId: "airband",
				set: { name: air.name },
				reset: [],
			},
			ctx(),
			null,
		)
		expect(renamed.changed).toBe(true)
		expect(renamed.state.edits[0]?.set).toEqual({ name: air.name })
		const repeat = transition(
			renamed.state,
			{
				type: "patch-band-edit",
				expected: token(renamed.state),
				packId: "builtin-eu",
				bandId: "airband",
				set: { name: air.name },
				reset: [],
			},
			ctx(),
			null,
		)
		expect(repeat.changed).toBe(false)
		expect(repeat.state.revision).toBe(1)
		const removed = transition(
			renamed.state,
			{
				type: "patch-band-edit",
				expected: token(renamed.state),
				packId: "builtin-eu",
				bandId: "airband",
				set: null,
				reset: ["name"],
			},
			ctx(),
			null,
		)
		expect(removed.state.edits).toEqual([])
		expect(removed.state.revision).toBe(2)
	})

	it("rejects an invalid effective band and a missing target, and sorts edits by key", () => {
		const state = empty()
		const air = projectBuiltinPacks()
			.find(pack => pack.id === "builtin-eu")!
			.bands.find(item => item.id === "airband")!
		expect(
			codeOf(() =>
				transition(
					state,
					{
						type: "patch-band-edit",
						expected: token(state),
						packId: "builtin-eu",
						bandId: "airband",
						set: { startHz: air.endHz },
						reset: [],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		expect(
			codeOf(() =>
				transition(
					state,
					{
						type: "patch-band-edit",
						expected: token(state),
						packId: "builtin-eu",
						bandId: "missing",
						set: { name: "Nope" },
						reset: [],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
		const first = transition(
			state,
			{
				type: "patch-band-edit",
				expected: token(state),
				packId: "builtin-eu",
				bandId: "cb",
				set: { name: "CB edit" },
				reset: [],
			},
			ctx(),
			null,
		)
		const second = transition(
			first.state,
			{
				type: "patch-band-edit",
				expected: token(first.state),
				packId: "builtin-eu",
				bandId: "airband",
				set: { hidden: true },
				reset: [],
			},
			ctx(),
			null,
		)
		expect(second.state.edits.map(item => item.bandId)).toEqual([
			"airband",
			"cb",
		])
	})

	it("keeps orphan edits until the band or the pack is reset", () => {
		const state = bandPlanStateSchema.parse({
			...empty(),
			edits: [
				{
					packId: "builtin-eu",
					bandId: "missing",
					set: { name: "Orphan" },
					updatedAt: EARLIER,
				},
				{
					packId: "builtin-us",
					bandId: "amateur-2m",
					set: { name: "Kept" },
					updatedAt: EARLIER,
				},
			],
		})
		expect(
			codeOf(() =>
				transition(
					state,
					{
						type: "reset-pack-edits",
						expected: token(state),
						packId: "imported-000000000099",
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
		const bandReset = transition(
			state,
			{
				type: "reset-band-edits",
				expected: token(state),
				packId: "builtin-eu",
				bandId: "missing",
			},
			ctx(),
			null,
		)
		expect(bandReset.state.edits.map(item => item.packId)).toEqual([
			"builtin-us",
		])
		const packReset = transition(
			state,
			{
				type: "reset-pack-edits",
				expected: token(state),
				packId: "builtin-eu",
			},
			ctx(),
			null,
		)
		expect(packReset.state.edits.map(item => item.packId)).toEqual([
			"builtin-us",
		])
		const noop = transition(
			packReset.state,
			{
				type: "reset-pack-edits",
				expected: token(packReset.state),
				packId: "builtin-eu",
			},
			ctx(),
			null,
		)
		expect(noop.changed).toBe(false)
	})

	it("assigns operator band ids, rejects a bad parent, and clears children on delete", () => {
		const state = empty()
		const context = ctx()
		const created = transition(
			state,
			{
				type: "create-operator-band",
				expected: token(state),
				band: bandInput("Parent"),
			},
			context,
			null,
		)
		expect(created.createdId).toBe("op-000000000001")
		expect(created.state.operatorBands[0]).toMatchObject({
			id: "op-000000000001",
			scan: null,
			provenance: { kind: "operator" },
		})
		const child = transition(
			created.state,
			{
				type: "create-operator-band",
				expected: token(created.state),
				band: bandInput("Child", created.createdId),
			},
			context,
			null,
		)
		expect(
			codeOf(() =>
				transition(
					child.state,
					{
						type: "create-operator-band",
						expected: token(child.state),
						band: bandInput("Loose", "missing"),
					},
					context,
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		expect(
			codeOf(() =>
				transition(
					child.state,
					{
						type: "replace-operator-band",
						expected: token(child.state),
						bandId: "op-000000000002",
						band: bandInput("Loop", "op-000000000002"),
					},
					context,
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		const same = transition(
			created.state,
			{
				type: "replace-operator-band",
				expected: token(created.state),
				bandId: "op-000000000001",
				band: bandInput("Parent"),
			},
			context,
			null,
		)
		expect(same.changed).toBe(false)
		const removed = transition(
			child.state,
			{
				type: "delete-operator-band",
				expected: token(child.state),
				bandId: "op-000000000001",
			},
			context,
			null,
		)
		expect(removed.state.operatorBands).toEqual([
			expect.objectContaining({ id: "op-000000000002", parentId: null }),
		])
		expect(
			codeOf(() =>
				transition(
					removed.state,
					{
						type: "delete-operator-band",
						expected: token(removed.state),
						bandId: "op-000000000001",
					},
					context,
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
	})

	it("uses the later of now and the previous timestamp", () => {
		const created = transition(
			empty(),
			{ type: "create-preset", expected: token(empty()), preset: preset() },
			ctx("EU", EARLIER),
			null,
		)
		const replaced = transition(
			created.state,
			{
				type: "replace-preset",
				expected: token(created.state),
				presetId: created.createdId!,
				preset: preset("Later name"),
			},
			ctx("EU", "2025-12-01T00:00:00.000Z"),
			null,
		)
		expect(replaced.state.presets[0]).toMatchObject({
			createdAt: EARLIER,
			updatedAt: EARLIER,
			name: "Later name",
		})
		expect(replaced.changed).toBe(true)
		const repeat = transition(
			replaced.state,
			{
				type: "replace-preset",
				expected: token(replaced.state),
				presetId: created.createdId!,
				preset: preset("Later name"),
			},
			ctx(),
			null,
		)
		expect(repeat.changed).toBe(false)
	})

	// Feature: web-gaps-5, Property 12: Import round trip
	// Validates: Requirements 7.6
	it.each(["sdrpp-json", "sdrsharp-xml", "gqrx-csv"] as const)(
		"stores the parsed %s format in the provenance",
		format => {
			const file = hashed(`community-${format}`)
			const state = empty()
			const base = parsed([storedBand("b-one", "One", null)], file.sha256)
			const imported = transition(
				state,
				commit(state, file, [], { format }),
				ctx("CA"),
				{ ...base, preview: { ...base.preview, format } },
			)
			expect(imported.state.importedPacks[0]?.provenance.format).toBe(format)
		},
	)

	it("commits an import, strips colour unless asked, and materializes the regional default stack", () => {
		const file = hashed("community-a")
		const state = empty()
		const imported = transition(
			state,
			commit(state, file, [storedBand("b-one", "One", "#aabbcc")], {
				addToStack: true,
			}),
			ctx("CA"),
			parsed([storedBand("b-one", "One", "#aabbcc")], file.sha256, null),
		)
		expect(imported.createdId).toBe("imported-000000000001")
		expect(imported.state.importedPacks[0]).toMatchObject({
			name: "community.json",
			provenance: {
				kind: "imported",
				author: null,
				licence: null,
				sha256: file.sha256,
				sourceName: "community.json",
			},
		})
		expect(imported.state.importedPacks[0]?.bands[0]?.colourHint).toBeNull()
		expect(imported.state.stack).toEqual([
			{ packId: "builtin-ca", enabled: true },
			{ packId: "imported-000000000001", enabled: true },
		])
		const kept = hashed("community-b")
		const coloured = transition(
			empty(),
			commit(empty(), kept, [storedBand("b-one", "One", "#aabbcc")], {
				keepColourHints: true,
				name: "Named",
				author: "Ada",
				addToStack: false,
			}),
			ctx(),
			parsed([storedBand("b-one", "One", "#aabbcc")], kept.sha256, "Meta"),
		)
		expect(coloured.state.stack).toBeNull()
		expect(coloured.state.importedPacks[0]?.name).toBe("Named")
		expect(coloured.state.importedPacks[0]?.bands[0]?.colourHint).toBe(
			"#aabbcc",
		)
		expect(coloured.state.importedPacks[0]?.provenance.author).toBe("Ada")
	})

	it("rejects a mismatched or missing import and keeps edits across a replacement", () => {
		const file = hashed("community-c")
		const state = empty()
		expect(
			codeOf(() =>
				transition(
					state,
					commit(state, file, [storedBand("b-one")]),
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_IMPORT_INVALID")
		expect(
			codeOf(() =>
				transition(
					state,
					commit(state, file, [storedBand("b-one")], {
						previewDigest: "c".repeat(64),
					}),
					ctx(),
					parsed([storedBand("b-one")], file.sha256),
				),
			),
		).toBe("BANDPLANS_IMPORT_MISMATCH")
		const created = transition(
			state,
			commit(state, file, [
				storedBand("b-one", "One"),
				storedBand("b-two", "Two"),
			]),
			ctx(),
			parsed(
				[storedBand("b-one", "One"), storedBand("b-two", "Two")],
				file.sha256,
			),
		)
		const packId = created.createdId!
		const named = transition(
			created.state,
			{
				type: "patch-band-edit",
				expected: token(created.state),
				packId,
				bandId: "b-one",
				set: { name: "Kept" },
				reset: [],
			},
			ctx(),
			null,
		)
		const orphaned = transition(
			named.state,
			{
				type: "patch-band-edit",
				expected: token(named.state),
				packId,
				bandId: "b-two",
				set: { name: "Dropped" },
				reset: [],
			},
			ctx(),
			null,
		)
		const nextFile = hashed("community-d")
		const replaced = transition(
			orphaned.state,
			commit(orphaned.state, nextFile, [storedBand("b-one", "One")], {
				replacesPackId: packId,
				addToStack: true,
			}),
			ctx(),
			parsed([storedBand("b-one", "One")], nextFile.sha256),
		)
		expect(replaced.createdId).toBeNull()
		expect(replaced.state.importedPacks.map(pack => pack.id)).toEqual([packId])
		expect(replaced.state.stack).toEqual([
			{ packId: "builtin-eu", enabled: true },
			{ packId, enabled: true },
		])
		expect(replaced.state.edits.map(item => item.bandId).sort()).toEqual([
			"b-one",
			"b-two",
		])
		const resolved = resolveBandPlans(asInput(replaced.state))
		expect(resolved.orphanedEdits).toEqual([{ packId, bandId: "b-two" }])
		expect(
			resolved.bands.find(item => item.bandId === "b-one")?.band.name,
		).toBe("Kept")
		expect(resolved.bands.some(item => item.band.name === "Dropped")).toBe(
			false,
		)
		const removed = transition(
			replaced.state,
			{ type: "delete-pack", expected: token(replaced.state), packId },
			ctx(),
			null,
		)
		expect(removed.state.importedPacks).toEqual([])
		expect(removed.state.edits).toEqual([])
		expect(removed.state.stack).toEqual([
			{ packId: "builtin-eu", enabled: true },
		])
		expect(
			codeOf(() =>
				transition(
					removed.state,
					{
						type: "delete-pack",
						expected: token(removed.state),
						packId,
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
	})

	it("rejects quotas, a bad clock, a bad id, and revision overflow, but allows a no-op at the ceiling", () => {
		const fullOperators = bandPlanStateSchema.parse({
			...empty(),
			operatorBands: Array.from(
				{ length: BANDPLANS_LIMITS.operatorBands },
				(_, index) => ({
					...bandInput(`B${index}`),
					id: `op-${index.toString(16).padStart(12, "0")}`,
					scan: null,
					provenance: { kind: "operator" },
				}),
			),
		})
		expect(
			codeOf(() =>
				transition(
					fullOperators,
					{
						type: "create-operator-band",
						expected: token(fullOperators),
						band: bandInput(),
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_QUOTA")
		const fullPresets = bandPlanStateSchema.parse({
			...empty(),
			presets: Array.from({ length: BANDPLANS_LIMITS.presets }, (_, index) => ({
				kind: "operator" as const,
				id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
				name: "Preset",
				job: preset().job,
				createdAt: NOW,
				updatedAt: NOW,
			})),
		})
		expect(
			codeOf(() =>
				transition(
					fullPresets,
					{
						type: "create-preset",
						expected: token(fullPresets),
						preset: preset(),
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_QUOTA")
		const packed = empty()
		let cursor = packed
		const context = ctx()
		for (let index = 0; index < BANDPLANS_LIMITS.importedPacks; index += 1) {
			const file = hashed(`pack-${index}`)
			cursor = transition(
				cursor,
				commit(cursor, file, [storedBand("b-one")], { addToStack: false }),
				context,
				parsed([storedBand("b-one")], file.sha256),
			).state
		}
		const extra = hashed("one-more")
		expect(
			codeOf(() =>
				transition(
					cursor,
					commit(cursor, extra, [storedBand("b-one")]),
					context,
					parsed([storedBand("b-one")], extra.sha256),
				),
			),
		).toBe("BANDPLANS_QUOTA")
		expect(
			codeOf(() =>
				transition(
					empty(),
					{
						type: "create-operator-band",
						expected: token(empty()),
						band: bandInput(),
					},
					{ ...ctx(), randomHex12: () => "ZZ" },
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		expect(
			codeOf(() =>
				transition(
					empty(),
					{ type: "create-preset", expected: token(empty()), preset: preset() },
					{ ...ctx(), now: () => "not-a-time" },
					null,
				),
			),
		).toBe("BANDPLANS_INVALID")
		const ceiling = empty(BANDPLANS_LIMITS.revision)
		expect(
			codeOf(() =>
				transition(
					ceiling,
					{
						type: "set-stack",
						expected: token(ceiling),
						entries: [{ packId: "builtin-eu", enabled: false }],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_QUOTA")
		const noop = transition(
			ceiling,
			{ type: "reset-stack", expected: token(ceiling) },
			ctx(),
			null,
		)
		expect(noop.changed).toBe(false)
		expect(noop.state.revision).toBe(BANDPLANS_LIMITS.revision)
	})

	it("rejects an empty import, a pack over the band quota, and a 1025th edit", () => {
		const file = hashed("bounds")
		const state = empty()
		expect(
			codeOf(() =>
				transition(
					state,
					commit(state, file, []),
					ctx(),
					parsed([], file.sha256),
				),
			),
		).toBe("BANDPLANS_IMPORT_INVALID")
		const tooMany = Array.from(
			{ length: BANDPLANS_LIMITS.bandsPerPack + 1 },
			(_, index) => storedBand(`b-${index}`),
		)
		expect(
			codeOf(() =>
				transition(
					state,
					commit(state, file, tooMany),
					ctx(),
					parsed(tooMany, file.sha256),
				),
			),
		).toBe("BANDPLANS_QUOTA")
		const provenance = {
			kind: "imported" as const,
			trust: "community-unverified" as const,
			format: "sdrpp-json" as const,
			sourceName: "file.json",
			author: null,
			licence: null,
			importedAt: NOW,
			sha256: "ab".repeat(32),
		}
		const bands = Array.from({ length: 512 }, (_, index) =>
			storedBand(`b-${index}`),
		)
		const editsFor = (packId: string) =>
			bands.map(item => ({
				packId,
				bandId: item.id,
				set: { hidden: true },
				updatedAt: NOW,
			}))
		const full = bandPlanStateSchema.parse({
			...empty(),
			importedPacks: [
				{
					id: "imported-0000000000a1",
					name: "A",
					provenance,
					bands,
				},
				{
					id: "imported-0000000000a2",
					name: "B",
					provenance,
					bands,
				},
			],
			edits: [
				...editsFor("imported-0000000000a1"),
				...editsFor("imported-0000000000a2"),
			],
		})
		expect(full.edits).toHaveLength(BANDPLANS_LIMITS.edits)
		expect(
			codeOf(() =>
				transition(
					full,
					{
						type: "patch-band-edit",
						expected: token(full),
						packId: "builtin-eu",
						bandId: "airband",
						set: { name: "One more" },
						reset: [],
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_QUOTA")
		expect(full.edits).toHaveLength(BANDPLANS_LIMITS.edits)
	})

	it("deletes a preset and leaves an unchanged replacement unrevised", () => {
		const created = transition(
			empty(),
			{
				type: "create-preset",
				expected: token(empty()),
				preset: preset("Scan"),
			},
			ctx(),
			null,
		)
		expect(created.createdId).toMatch(/^[0-9a-f-]{36}$/)
		const removed = transition(
			created.state,
			{
				type: "delete-preset",
				expected: token(created.state),
				presetId: created.createdId!,
			},
			ctx(),
			null,
		)
		expect(removed.state.presets).toEqual([])
		expect(
			codeOf(() =>
				transition(
					removed.state,
					{
						type: "delete-preset",
						expected: token(removed.state),
						presetId: created.createdId!,
					},
					ctx(),
					null,
				),
			),
		).toBe("BANDPLANS_NOT_FOUND")
	})

	// Feature: band-plans, Property 5: Edit round-trip
	// Validates: Requirements 5.1, 5.2, 5.3, 5.4
	it("restores unedited resolution after a field reset or a band reset", () => {
		const arbName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/)
		fc.assert(
			fc.property(
				arbName,
				fc.constantFrom(...DISPLAY_GROUPS),
				fc.constantFrom(null, "#112233"),
				(name, group, colourHint) => {
					const base = empty()
					const context = ctx()
					const baseline = resolveBandPlans(asInput(base))
					const patched = transition(
						base,
						{
							type: "patch-band-edit",
							expected: token(base),
							packId: "builtin-eu",
							bandId: "airband",
							set: { name, group, hidden: false, colourHint },
							reset: [],
						},
						context,
						null,
					)
					const resetFields = transition(
						patched.state,
						{
							type: "patch-band-edit",
							expected: token(patched.state),
							packId: "builtin-eu",
							bandId: "airband",
							set: null,
							reset: ["name", "group", "hidden", "colourHint"],
						},
						context,
						null,
					)
					expect(resolveBandPlans(asInput(resetFields.state))).toEqual(baseline)
					const resetBand = transition(
						patched.state,
						{
							type: "reset-band-edits",
							expected: token(patched.state),
							packId: "builtin-eu",
							bandId: "airband",
						},
						context,
						null,
					)
					expect(resolveBandPlans(asInput(resetBand.state))).toEqual(baseline)
					expect(resetBand.state.edits).toEqual([])
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 5: Edit round-trip
	// Validates: Requirements 5.3, 5.4
	it("removes exactly one pack's edits on pack reset", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/),
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/),
				(euName, usName) => {
					const context = ctx()
					const base = empty()
					const eu = transition(
						base,
						{
							type: "patch-band-edit",
							expected: token(base),
							packId: "builtin-eu",
							bandId: "airband",
							set: { name: euName },
							reset: [],
						},
						context,
						null,
					)
					const both = transition(
						eu.state,
						{
							type: "patch-band-edit",
							expected: token(eu.state),
							packId: "builtin-us",
							bandId: "amateur-2m",
							set: { name: usName },
							reset: [],
						},
						context,
						null,
					)
					const cleared = transition(
						both.state,
						{
							type: "reset-pack-edits",
							expected: token(both.state),
							packId: "builtin-eu",
						},
						context,
						null,
					)
					expect(cleared.state.edits.map(item => item.packId)).toEqual([
						"builtin-us",
					])
					const resolved = resolveBandPlans({
						...asInput(cleared.state),
						stack: [
							{ packId: "builtin-us", enabled: true },
							{ packId: "builtin-eu", enabled: true },
						],
					})
					expect(
						resolved.bands.find(item => item.key === "builtin-eu/airband")?.band
							.name,
					).toBe(
						projectBuiltinPacks()
							.find(pack => pack.id === "builtin-eu")!
							.bands.find(item => item.id === "airband")!.name,
					)
					expect(
						resolved.bands.find(item => item.key === "builtin-us/amateur-2m")
							?.band.name,
					).toBe(usName)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 6: Edit survival
	// Validates: Requirements 5.5, 5.6
	it("keeps surviving edits applied and reports the rest as orphans", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/),
				fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,8}$/),
				(keep, drop) => {
					const context = ctx()
					const file = hashed(`keep-${keep}-${drop}`)
					const base = empty()
					const created = transition(
						base,
						commit(base, file, [
							storedBand("b-one", "One"),
							storedBand("b-two", "Two"),
						]),
						context,
						parsed(
							[storedBand("b-one", "One"), storedBand("b-two", "Two")],
							file.sha256,
						),
					)
					const packId = created.createdId!
					const withKeep = transition(
						created.state,
						{
							type: "patch-band-edit",
							expected: token(created.state),
							packId,
							bandId: "b-one",
							set: { name: `K${keep}` },
							reset: [],
						},
						context,
						null,
					)
					const withDrop = transition(
						withKeep.state,
						{
							type: "patch-band-edit",
							expected: token(withKeep.state),
							packId,
							bandId: "b-two",
							set: { name: `D${drop}` },
							reset: [],
						},
						context,
						null,
					)
					const nextFile = hashed(`next-${keep}-${drop}`)
					const replaced = transition(
						withDrop.state,
						commit(withDrop.state, nextFile, [storedBand("b-one", "One")], {
							replacesPackId: packId,
							addToStack: true,
						}),
						context,
						parsed([storedBand("b-one", "One")], nextFile.sha256),
					)
					expect(replaced.state.edits.map(item => item.bandId).sort()).toEqual([
						"b-one",
						"b-two",
					])
					const resolved = resolveBandPlans(asInput(replaced.state))
					expect(resolved.orphanedEdits).toEqual([{ packId, bandId: "b-two" }])
					expect(
						resolved.bands.find(item => item.bandId === "b-one")?.band.name,
					).toBe(`K${keep}`)
					expect(
						resolved.bands.some(item => item.band.name === `D${drop}`),
					).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 7: CAS and revision
	// Validates: Requirements 8.2
	it("increments once for a change, never for a no-op, and rejects the stale token", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,10}$/), name => {
				const state = empty()
				const context = ctx()
				const created = transition(
					state,
					{
						type: "create-operator-band",
						expected: token(state),
						band: bandInput(name),
					},
					context,
					null,
				)
				expect(created.changed).toBe(true)
				expect(created.state.revision).toBe(state.revision + 1)
				const snapshot = structuredClone(created.state)
				expect(
					codeOf(() =>
						transition(
							created.state,
							{
								type: "create-operator-band",
								expected: token(state),
								band: bandInput(`${name}x`),
							},
							context,
							null,
						),
					),
				).toBe("BANDPLANS_CONFLICT")
				expect(created.state).toEqual(snapshot)
				const repeat = transition(
					created.state,
					{
						type: "replace-operator-band",
						expected: token(created.state),
						bandId: created.createdId!,
						band: bandInput(name),
					},
					context,
					null,
				)
				expect(repeat.changed).toBe(false)
				expect(repeat.state.revision).toBe(created.state.revision)
				const other = transition(
					state,
					{
						type: "create-preset",
						expected: token(state),
						preset: preset(name),
					},
					context,
					null,
				)
				expect(other.state.revision).toBe(1)
				expect(
					codeOf(() =>
						transition(
							other.state,
							{
								type: "delete-preset",
								expected: token(state),
								presetId: other.createdId!,
							},
							context,
							null,
						),
					),
				).toBe("BANDPLANS_CONFLICT")
			}),
			{ numRuns: 100 },
		)
	})

	it("canonicalizes the preview digest over sorted override pairs", () => {
		const sha256 = "ab".repeat(32)
		const digest = previewDigestFor(sha256, [
			{ sourceType: "b", group: "air" },
			{ sourceType: "a", group: "marine" },
		])
		expect(digest).toBe(
			createHash("sha256")
				.update(
					JSON.stringify({
						v: 1,
						sha256,
						groupOverrides: [
							["a", "marine"],
							["b", "air"],
						],
					}),
					"utf8",
				)
				.digest("hex"),
		)
		expect(digest).not.toBe(sha256)
	})

	it("rejects a parsed import whose file hash disagrees with the bytes", () => {
		const state = empty()
		const file = hashed("community-hash")
		const before = structuredClone(state)
		expect(
			codeOf(() =>
				transition(
					state,
					commit(state, file, [storedBand("b-one")]),
					ctx(),
					parsed([storedBand("b-one")], "cd".repeat(32)),
				),
			),
		).toBe("BANDPLANS_IMPORT_MISMATCH")
		expect(state).toEqual(before)
	})

	// Feature: band-plans, Property 20: Preview digest binding
	// Validates: Requirements 11.7
	it("binds the preview digest to the bytes and the override set", () => {
		const override = fc.record({
			sourceType: fc.string({ minLength: 0, maxLength: 12 }),
			group: fc.constantFrom(...DISPLAY_GROUPS),
		})
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 0, maxLength: 32 }),
				fc.uniqueArray(override, {
					minLength: 0,
					maxLength: 6,
					selector: item => item.sourceType,
				}),
				fc.integer({ min: 0, max: 255 }),
				(bytes, overrides, salt) => {
					const sha256 = createHash("sha256").update(bytes).digest("hex")
					const rotated =
						overrides.length === 0
							? overrides
							: [...overrides.slice(1), overrides[0]!]
					const forward = previewDigestFor(sha256, overrides)
					expect(previewDigestFor(sha256, [...overrides].reverse())).toBe(
						forward,
					)
					expect(previewDigestFor(sha256, rotated)).toBe(forward)
					const other = createHash("sha256")
						.update(Uint8Array.from([...bytes, salt]))
						.digest("hex")
					expect(previewDigestFor(other, overrides)).not.toBe(forward)
					if (overrides.length > 0) {
						const changed = overrides.map((item, index) =>
							index === 0
								? {
										...item,
										group:
											item.group === "other"
												? ("air" as const)
												: ("other" as const),
									}
								: item,
						)
						expect(previewDigestFor(sha256, changed)).not.toBe(forward)
					}
					const state = empty()
					const before = structuredClone(state)
					const file = {
						sha256,
						contentBase64: Buffer.from(bytes).toString("base64"),
					}
					const mismatched =
						forward === "c".repeat(64) ? "d".repeat(64) : "c".repeat(64)
					expect(
						codeOf(() =>
							transition(
								state,
								commit(state, file, [storedBand("b-one")], {
									groupOverrides: overrides,
									previewDigest: mismatched,
									addToStack: false,
								}),
								ctx(),
								parsed([storedBand("b-one")], sha256),
							),
						),
					).toBe("BANDPLANS_IMPORT_MISMATCH")
					expect(state).toEqual(before)
					const committed = transition(
						state,
						commit(state, file, [storedBand("b-one")], {
							groupOverrides: rotated,
							addToStack: false,
						}),
						ctx(),
						parsed([storedBand("b-one")], sha256),
					)
					expect(committed.changed).toBe(true)
					expect(committed.state.revision).toBe(1)
					expect(committed.state.importedPacks).toHaveLength(1)
					expect(
						codeOf(() =>
							transition(
								committed.state,
								commit(committed.state, file, [storedBand("b-one")], {
									groupOverrides: overrides,
									previewDigest: previewDigestFor(other, overrides),
									addToStack: false,
								}),
								ctx(),
								parsed([storedBand("b-one")], sha256),
							),
						),
					).toBe("BANDPLANS_IMPORT_MISMATCH")
					expect(committed.state.revision).toBe(1)
					expect(committed.state.importedPacks).toHaveLength(1)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("WG6 preview digest golden (uploads unchanged)", () => {
	// Values recorded from the pre-WG6 previewDigestFor before the sourceUrl argument existed.
	const SHA_A = "a".repeat(64)
	const SHA_B = "0123456789abcdef".repeat(4)
	const OVERRIDES = [
		{ sourceType: "ham", group: "amateur" },
		{ sourceType: "air", group: "air" },
	] as const
	it("pins the upload digest for absent and null sourceUrl", () => {
		const gold =
			"cefad5a498d7e1048788e015d3bc9422f89aee9d5d60564d25fdf25aba897c63"
		expect(previewDigestFor(SHA_A, [])).toBe(gold)
		expect(previewDigestFor(SHA_A, [], null)).toBe(gold)
		expect(previewDigestFor(SHA_A, [], undefined)).toBe(gold)
	})
	it("pins the upload digest with overrides", () => {
		expect(previewDigestFor(SHA_B, [...OVERRIDES])).toBe(
			"884c8d5bfe54c912c5672d14c5954e05b99b8aa2be6f6d6665b4833668cb62b9",
		)
	})
	it("binds a non-null sourceUrl", () => {
		const upload = previewDigestFor(SHA_A, [])
		const a = previewDigestFor(SHA_A, [], "https://example.org/a.json")
		const b = previewDigestFor(SHA_A, [], "https://example.org/b.json")
		expect(a).toMatch(/^[0-9a-f]{64}$/)
		expect(a).not.toBe(upload)
		expect(a).not.toBe(b)
	})
})
