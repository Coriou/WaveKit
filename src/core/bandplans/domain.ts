/**
 * Pure CAS transitions over BandPlanState (docs/specs/band-plans/design.md).
 * Does not persist, resolve or tune. Callers serialize competing writes.
 */
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { ZodError, ZodIssue } from "zod"
import {
	BANDPLANS_LIMITS,
	BAND_EDIT_FIELDS,
	BUILTIN_PACK_IDS,
	bandEditSchema,
	bandInputSchema,
	bandPlanStateSchema,
	bandPlanTextSchema,
	importedPackSchema,
	operatorScanPresetSchema,
	planStackSchema,
	storedBandSchema,
	timestampSchema,
	uuidSchema,
} from "@wavekit/api-types"
import type {
	Band,
	BandEdit,
	BandEditField,
	BandEditFields,
	BandInput,
	BandPlanState,
	ExpectedToken,
	PlanStackEntry,
	StoredBand,
} from "@wavekit/api-types"
import { builtinPackIdFor, projectBuiltinPacks } from "./builtin-packs.js"
import { BandPlansError } from "./contract.js"
import type {
	BandPlanTransition,
	DomainContext,
	ParsedImport,
	PreviewDigestFor,
	TransitionResult,
} from "./contract.js"

const builtinPackIds: ReadonlySet<string> = new Set(BUILTIN_PACK_IDS)

function stateError(error: ZodError): BandPlansError {
	const quota = error.issues.some(isQuotaIssue)
	return new BandPlansError(quota ? "BANDPLANS_QUOTA" : "BANDPLANS_INVALID")
}

function isQuotaIssue(issue: ZodIssue): boolean {
	if (issue.code === "too_big") return true
	if (issue.code !== "custom") return false
	if (issue.message === "State byte limit exceeded") return true
	const params = issue.params
	return (
		typeof params === "object" &&
		params !== null &&
		"quota" in params &&
		params["quota"] === true
	)
}

function serverTime(
	context: DomainContext,
	floors: readonly string[] = [],
): string {
	const parsed = timestampSchema.safeParse(context.now())
	if (!parsed.success) throw new BandPlansError("BANDPLANS_INVALID")
	const time = Math.max(
		Date.parse(parsed.data),
		...floors.map(value => Date.parse(value)),
	)
	if (!Number.isFinite(time)) throw new BandPlansError("BANDPLANS_INVALID")
	return new Date(time).toISOString()
}

function assertToken(state: BandPlanState, expected: ExpectedToken): void {
	if (
		expected.storeId !== state.storeId ||
		expected.revision !== state.revision
	)
		throw new BandPlansError("BANDPLANS_CONFLICT", {
			storeId: state.storeId,
			revision: state.revision,
		})
}

function packExists(state: BandPlanState, packId: string): boolean {
	if (builtinPackIds.has(packId)) return true
	return state.importedPacks.some(pack => pack.id === packId)
}

function findBand(
	state: BandPlanState,
	packId: string,
	bandId: string,
): Band | StoredBand | null {
	if (builtinPackIds.has(packId)) {
		const pack = projectBuiltinPacks().find(item => item.id === packId)
		return pack?.bands.find(band => band.id === bandId) ?? null
	}
	const pack = state.importedPacks.find(item => item.id === packId)
	return pack?.bands.find(band => band.id === bandId) ?? null
}

function copyEditField(
	target: BandEditFields,
	source: BandEditFields,
	key: BandEditField,
): void {
	switch (key) {
		case "name":
			if (source.name !== undefined) target.name = source.name
			return
		case "startHz":
			if (source.startHz !== undefined) target.startHz = source.startHz
			return
		case "endHz":
			if (source.endHz !== undefined) target.endHz = source.endHz
			return
		case "group":
			if (source.group !== undefined) target.group = source.group
			return
		case "mode":
			if (Object.hasOwn(source, "mode")) target.mode = source.mode ?? null
			return
		case "bandwidthHz":
			if (Object.hasOwn(source, "bandwidthHz"))
				target.bandwidthHz = source.bandwidthHz ?? null
			return
		case "stepHz":
			if (Object.hasOwn(source, "stepHz")) target.stepHz = source.stepHz ?? null
			return
		case "skip":
			if (Object.hasOwn(source, "skip"))
				target.skip =
					source.skip == null ? null : { reason: source.skip.reason }
			return
		case "channels":
			if (source.channels !== undefined)
				target.channels = structuredClone(source.channels)
			return
		case "parentId":
			if (Object.hasOwn(source, "parentId"))
				target.parentId = source.parentId ?? null
			return
		case "colourHint":
			if (Object.hasOwn(source, "colourHint"))
				target.colourHint = source.colourHint ?? null
			return
		case "registryRef":
			if (Object.hasOwn(source, "registryRef"))
				target.registryRef =
					source.registryRef == null
						? null
						: {
								familyId: source.registryRef.familyId,
								rowId: source.registryRef.rowId,
							}
			return
		case "hidden":
			if (source.hidden !== undefined) target.hidden = source.hidden
			return
	}
}

function normalizeEditFields(fields: BandEditFields): BandEditFields {
	const normalized: BandEditFields = {}
	for (const key of BAND_EDIT_FIELDS) {
		if (Object.hasOwn(fields, key)) copyEditField(normalized, fields, key)
	}
	return normalized
}

function editHasField(fields: BandEditFields): boolean {
	return BAND_EDIT_FIELDS.some(key => Object.hasOwn(fields, key))
}

function mergeEditFields(
	existing: BandEditFields | undefined,
	set: BandEditFields | null,
	reset: readonly BandEditField[],
): BandEditFields {
	const merged = normalizeEditFields(existing ?? {})
	for (const key of reset) delete merged[key]
	if (set) {
		for (const key of BAND_EDIT_FIELDS) {
			if (Object.hasOwn(set, key)) copyEditField(merged, set, key)
		}
	}
	return merged
}

function effectiveBandInput(
	band: Band | StoredBand,
	set: BandEditFields,
): BandInput {
	return {
		name: set.name ?? band.name,
		startHz: set.startHz ?? band.startHz,
		endHz: set.endHz ?? band.endHz,
		group: set.group ?? band.group,
		mode: Object.hasOwn(set, "mode") ? (set.mode ?? null) : band.mode,
		bandwidthHz: Object.hasOwn(set, "bandwidthHz")
			? (set.bandwidthHz ?? null)
			: band.bandwidthHz,
		stepHz: Object.hasOwn(set, "stepHz") ? (set.stepHz ?? null) : band.stepHz,
		skip: Object.hasOwn(set, "skip") ? (set.skip ?? null) : band.skip,
		channels: set.channels ?? [...band.channels],
		parentId: Object.hasOwn(set, "parentId")
			? (set.parentId ?? null)
			: band.parentId,
		colourHint: Object.hasOwn(set, "colourHint")
			? (set.colourHint ?? null)
			: band.colourHint,
		registryRef: Object.hasOwn(set, "registryRef")
			? (set.registryRef ?? null)
			: band.registryRef,
	}
}

function compareEdits(a: BandEdit, b: BandEdit): number {
	const left = `${a.packId}/${a.bandId}`
	const right = `${b.packId}/${b.bandId}`
	if (left < right) return -1
	if (left > right) return 1
	return 0
}

function assertOperatorParent(
	state: BandPlanState,
	parentId: string | null,
	selfId: string | null,
): void {
	if (parentId === null) return
	if (
		parentId === selfId ||
		!state.operatorBands.some(band => band.id === parentId)
	)
		throw new BandPlansError("BANDPLANS_INVALID")
}

function storedOperatorBand(id: string, band: BandInput): StoredBand {
	const parsed = storedBandSchema.safeParse({
		...band,
		id,
		scan: null,
		provenance: { kind: "operator" },
	})
	if (!parsed.success) throw stateError(parsed.error)
	return parsed.data
}

function sha256Base64(contentBase64: string): string {
	return createHash("sha256")
		.update(Buffer.from(contentBase64, "base64"))
		.digest("hex")
}

function compareCodeUnit(left: string, right: string): number {
	if (left < right) return -1
	if (left > right) return 1
	return 0
}

/**
 * Order of `groupOverrides` does not change the digest. Source types are unique by schema.
 * WG6: a non-null `sourceUrl` adds a trailing `"sourceUrl"` key; absent or null keeps the
 * pre-WG6 canonical JSON byte for byte (golden-tested).
 */
export const previewDigestFor: PreviewDigestFor = (
	fileSha256,
	groupOverrides,
	sourceUrl,
) => {
	const pairs = groupOverrides
		.map(override => [override.sourceType, override.group] as const)
		.sort((left, right) => compareCodeUnit(left[0], right[0]))
	const canonical =
		sourceUrl === undefined || sourceUrl === null
			? { v: 1, sha256: fileSha256, groupOverrides: pairs }
			: { v: 1, sha256: fileSha256, groupOverrides: pairs, sourceUrl }
	return createHash("sha256")
		.update(JSON.stringify(canonical), "utf8")
		.digest("hex")
}

function importBands(
	parsedImport: ParsedImport,
	keepColourHints: boolean,
): StoredBand[] {
	return parsedImport.bands.map(band => {
		const parsed = storedBandSchema.safeParse({
			...band,
			colourHint: keepColourHints ? band.colourHint : null,
			scan: null,
			provenance: { kind: "imported" },
		})
		if (!parsed.success) throw stateError(parsed.error)
		return parsed.data
	})
}

function appendToStack(
	state: BandPlanState,
	packId: string,
	region: DomainContext["region"],
): void {
	const base: PlanStackEntry[] = state.stack
		? state.stack.map(entry => ({
				packId: entry.packId,
				enabled: entry.enabled,
			}))
		: [{ packId: builtinPackIdFor(region), enabled: true }]
	if (!base.some(entry => entry.packId === packId)) {
		if (base.length >= BANDPLANS_LIMITS.stackEntries)
			throw new BandPlansError("BANDPLANS_QUOTA")
		base.push({ packId, enabled: true })
	}
	state.stack = base
}

function finish(
	original: BandPlanState,
	proposed: BandPlanState,
	createdId: string | null,
	changed: boolean,
): TransitionResult {
	if (!changed || isDeepStrictEqual(proposed, original))
		return { changed: false, state: original, createdId: null }
	if (original.revision >= BANDPLANS_LIMITS.revision)
		throw new BandPlansError("BANDPLANS_QUOTA")
	proposed.revision = original.revision + 1
	const parsed = bandPlanStateSchema.safeParse(proposed)
	if (!parsed.success) throw stateError(parsed.error)
	return { changed: true, state: parsed.data, createdId }
}

export const transition: BandPlanTransition = (
	state,
	mutation,
	context,
	parsedImport,
) => {
	assertToken(state, mutation.expected)
	const next = structuredClone(state)
	let createdId: string | null = null
	let changed = false
	switch (mutation.type) {
		case "set-stack": {
			const entries = planStackSchema.safeParse(mutation.entries)
			if (!entries.success) throw stateError(entries.error)
			for (const entry of entries.data)
				if (!packExists(next, entry.packId))
					throw new BandPlansError("BANDPLANS_NOT_FOUND")
			if (!isDeepStrictEqual(next.stack, entries.data)) {
				next.stack = entries.data
				changed = true
			}
			break
		}
		case "reset-stack": {
			if (next.stack !== null) {
				next.stack = null
				changed = true
			}
			break
		}
		case "patch-band-edit": {
			if (!packExists(next, mutation.packId))
				throw new BandPlansError("BANDPLANS_NOT_FOUND")
			const band = findBand(next, mutation.packId, mutation.bandId)
			if (!band) throw new BandPlansError("BANDPLANS_NOT_FOUND")
			const index = next.edits.findIndex(
				edit =>
					edit.packId === mutation.packId && edit.bandId === mutation.bandId,
			)
			const previous = index === -1 ? undefined : next.edits[index]
			const merged = mergeEditFields(
				previous?.set,
				mutation.set,
				mutation.reset,
			)
			if (!editHasField(merged)) {
				if (previous) {
					next.edits.splice(index, 1)
					changed = true
				}
				break
			}
			const effective = bandInputSchema.safeParse(
				effectiveBandInput(band, merged),
			)
			if (!effective.success) throw new BandPlansError("BANDPLANS_INVALID")
			const normalized = normalizeEditFields(merged)
			if (
				previous &&
				isDeepStrictEqual(normalizeEditFields(previous.set), normalized)
			)
				break
			if (!previous && next.edits.length >= BANDPLANS_LIMITS.edits)
				throw new BandPlansError("BANDPLANS_QUOTA")
			const stored = bandEditSchema.safeParse({
				packId: mutation.packId,
				bandId: mutation.bandId,
				set: normalized,
				updatedAt: serverTime(context, previous ? [previous.updatedAt] : []),
			})
			if (!stored.success) throw new BandPlansError("BANDPLANS_INVALID")
			if (previous) next.edits[index] = stored.data
			else next.edits.push(stored.data)
			next.edits.sort(compareEdits)
			changed = true
			break
		}
		case "reset-band-edits": {
			if (!packExists(next, mutation.packId))
				throw new BandPlansError("BANDPLANS_NOT_FOUND")
			const before = next.edits.length
			next.edits = next.edits.filter(
				edit =>
					edit.packId !== mutation.packId || edit.bandId !== mutation.bandId,
			)
			changed = next.edits.length !== before
			break
		}
		case "reset-pack-edits": {
			if (!packExists(next, mutation.packId))
				throw new BandPlansError("BANDPLANS_NOT_FOUND")
			const before = next.edits.length
			next.edits = next.edits.filter(edit => edit.packId !== mutation.packId)
			changed = next.edits.length !== before
			break
		}
		case "create-operator-band": {
			if (next.operatorBands.length >= BANDPLANS_LIMITS.operatorBands)
				throw new BandPlansError("BANDPLANS_QUOTA")
			const hex = context.randomHex12()
			if (!/^[0-9a-f]{12}$/.test(hex))
				throw new BandPlansError("BANDPLANS_INVALID")
			const id = `op-${hex}`
			if (next.operatorBands.some(band => band.id === id))
				throw new BandPlansError("BANDPLANS_INVALID")
			assertOperatorParent(next, mutation.band.parentId, null)
			next.operatorBands.push(storedOperatorBand(id, mutation.band))
			createdId = id
			changed = true
			break
		}
		case "replace-operator-band": {
			const index = next.operatorBands.findIndex(
				band => band.id === mutation.bandId,
			)
			const previous = next.operatorBands[index]
			if (!previous) throw new BandPlansError("BANDPLANS_NOT_FOUND")
			assertOperatorParent(next, mutation.band.parentId, mutation.bandId)
			const replacement = storedOperatorBand(previous.id, mutation.band)
			if (!isDeepStrictEqual(previous, replacement)) {
				next.operatorBands[index] = replacement
				changed = true
			}
			break
		}
		case "delete-operator-band": {
			if (!next.operatorBands.some(band => band.id === mutation.bandId))
				throw new BandPlansError("BANDPLANS_NOT_FOUND")
			next.operatorBands = next.operatorBands.flatMap(band => {
				if (band.id === mutation.bandId) return []
				if (band.parentId === mutation.bandId)
					return [{ ...band, parentId: null }]
				return [band]
			})
			changed = true
			break
		}
		case "commit-import": {
			if (!parsedImport) throw new BandPlansError("BANDPLANS_IMPORT_INVALID")
			const fileSha256 = sha256Base64(mutation.contentBase64)
			const digest = previewDigestFor(
				fileSha256,
				mutation.groupOverrides,
				mutation.sourceUrl,
			)
			if (
				digest !== mutation.previewDigest ||
				parsedImport.preview.sha256 !== fileSha256
			)
				throw new BandPlansError("BANDPLANS_IMPORT_MISMATCH")
			const name = bandPlanTextSchema(80).safeParse(
				mutation.name ?? parsedImport.preview.meta.name ?? mutation.fileName,
			)
			if (!name.success) throw new BandPlansError("BANDPLANS_INVALID")
			if (parsedImport.bands.length > BANDPLANS_LIMITS.bandsPerPack)
				throw new BandPlansError("BANDPLANS_QUOTA")
			if (parsedImport.bands.length === 0)
				throw new BandPlansError("BANDPLANS_IMPORT_INVALID")
			const bands = importBands(parsedImport, mutation.keepColourHints)
			const replacing = mutation.replacesPackId
			let packId: string
			let replaceIndex = -1
			const floors: string[] = []
			if (replacing !== null) {
				replaceIndex = next.importedPacks.findIndex(
					pack => pack.id === replacing,
				)
				const previous = next.importedPacks[replaceIndex]
				if (!previous) throw new BandPlansError("BANDPLANS_NOT_FOUND")
				packId = replacing
				floors.push(previous.provenance.importedAt)
			} else {
				if (next.importedPacks.length >= BANDPLANS_LIMITS.importedPacks)
					throw new BandPlansError("BANDPLANS_QUOTA")
				const hex = context.randomHex12()
				if (!/^[0-9a-f]{12}$/.test(hex))
					throw new BandPlansError("BANDPLANS_INVALID")
				packId = `imported-${hex}`
				if (next.importedPacks.some(pack => pack.id === packId))
					throw new BandPlansError("BANDPLANS_INVALID")
			}
			const pack = importedPackSchema.safeParse({
				id: packId,
				name: name.data,
				provenance: {
					kind: "imported",
					trust: "community-unverified",
					format: parsedImport.preview.format,
					sourceName: mutation.fileName,
					author: mutation.author,
					licence: mutation.licence,
					importedAt: serverTime(context, floors),
					sha256: parsedImport.preview.sha256,
					...(typeof mutation.sourceUrl === "string"
						? { sourceUrl: mutation.sourceUrl }
						: {}),
				},
				bands,
			})
			if (!pack.success) throw stateError(pack.error)
			if (replaceIndex === -1) next.importedPacks.push(pack.data)
			else next.importedPacks[replaceIndex] = pack.data
			if (mutation.addToStack) appendToStack(next, packId, context.region)
			createdId = replaceIndex === -1 ? packId : null
			changed = true
			break
		}
		case "delete-pack": {
			const index = next.importedPacks.findIndex(
				pack => pack.id === mutation.packId,
			)
			if (index === -1) throw new BandPlansError("BANDPLANS_NOT_FOUND")
			next.importedPacks.splice(index, 1)
			next.edits = next.edits.filter(edit => edit.packId !== mutation.packId)
			if (next.stack)
				next.stack = next.stack.filter(
					entry => entry.packId !== mutation.packId,
				)
			changed = true
			break
		}
		case "create-preset": {
			if (next.presets.length >= BANDPLANS_LIMITS.presets)
				throw new BandPlansError("BANDPLANS_QUOTA")
			const id = uuidSchema.safeParse(context.uuid())
			if (
				!id.success ||
				id.data === next.storeId ||
				next.presets.some(preset => preset.id === id.data)
			)
				throw new BandPlansError("BANDPLANS_INVALID")
			const time = serverTime(context)
			const preset = operatorScanPresetSchema.safeParse({
				kind: "operator",
				id: id.data,
				name: mutation.preset.name,
				job: mutation.preset.job,
				createdAt: time,
				updatedAt: time,
			})
			if (!preset.success) throw new BandPlansError("BANDPLANS_INVALID")
			next.presets.push(preset.data)
			createdId = id.data
			changed = true
			break
		}
		case "replace-preset": {
			const index = next.presets.findIndex(
				preset => preset.id === mutation.presetId,
			)
			const previous = next.presets[index]
			if (!previous) throw new BandPlansError("BANDPLANS_NOT_FOUND")
			if (
				previous.name === mutation.preset.name &&
				isDeepStrictEqual(previous.job, mutation.preset.job)
			)
				break
			const preset = operatorScanPresetSchema.safeParse({
				...previous,
				name: mutation.preset.name,
				job: mutation.preset.job,
				updatedAt: serverTime(context, [previous.updatedAt]),
			})
			if (!preset.success) throw new BandPlansError("BANDPLANS_INVALID")
			next.presets[index] = preset.data
			changed = true
			break
		}
		case "delete-preset": {
			if (!next.presets.some(preset => preset.id === mutation.presetId))
				throw new BandPlansError("BANDPLANS_NOT_FOUND")
			next.presets = next.presets.filter(
				preset => preset.id !== mutation.presetId,
			)
			changed = true
			break
		}
		default: {
			const unreachable: never = mutation
			void unreachable
			throw new BandPlansError("BANDPLANS_INVALID")
		}
	}
	return finish(state, next, createdId, changed)
}
