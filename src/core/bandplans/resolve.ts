/**
 * Pure band-plan resolver (docs/specs/band-plans/design.md). No clock, randomness or I/O.
 * Coverage is inclusive integer Hz: ranges that touch or overlap merge.
 */
import {
	BAND_EDIT_FIELDS,
	OPERATOR_PACK_ID,
} from "@wavekit/api-types"
import type {
	Band,
	BandChannel,
	BandEdit,
	BandEditField,
	BandProvenance,
	DisplayGroup,
	PlanProvenance,
	ResolvedBand,
} from "@wavekit/api-types"
import type { ApplyBandEdit, ResolveBandPlans } from "./contract.js"

interface DraftBand {
	id: string
	name: string
	startHz: number
	endHz: number
	group: DisplayGroup
	mode: Band["mode"]
	bandwidthHz: number | null
	stepHz: number | null
	skip: Band["skip"]
	channels: BandChannel[]
	parentId: string | null
	colourHint: string | null
	registryRef: Band["registryRef"]
	scan: Band["scan"]
	provenance: BandProvenance
}

interface Interval {
	startHz: number
	endHz: number
}

type ResolveIssue = "edge-conflict" | "dangling-parent"

interface PreparedBand {
	readonly key: string
	readonly packId: string
	readonly bandId: string
	readonly layer: number
	readonly hidden: boolean
	readonly band: Band
	readonly editedFields: readonly BandEditField[]
	readonly issues: readonly ResolveIssue[]
	readonly provenance: BandProvenance
	readonly packProvenance: PlanProvenance
}

function cloneBand(band: Band): DraftBand {
	return structuredClone(band) as DraftBand
}

function applyPresentField(
	band: DraftBand,
	set: BandEdit["set"],
	field: BandEditField,
): void {
	switch (field) {
		case "name":
			if (set.name !== undefined) band.name = set.name
			return
		case "group":
			if (set.group !== undefined) band.group = set.group
			return
		case "mode":
			if (Object.hasOwn(set, "mode")) band.mode = set.mode ?? null
			return
		case "bandwidthHz":
			if (Object.hasOwn(set, "bandwidthHz"))
				band.bandwidthHz = set.bandwidthHz ?? null
			return
		case "stepHz":
			if (Object.hasOwn(set, "stepHz")) band.stepHz = set.stepHz ?? null
			return
		case "skip":
			if (Object.hasOwn(set, "skip"))
				band.skip =
					set.skip == null ? null : { reason: set.skip.reason }
			return
		case "channels":
			if (set.channels !== undefined) band.channels = structuredClone(set.channels)
			return
		case "colourHint":
			if (Object.hasOwn(set, "colourHint"))
				band.colourHint = set.colourHint ?? null
			return
		case "registryRef":
			if (Object.hasOwn(set, "registryRef"))
				band.registryRef =
					set.registryRef == null
						? null
						: {
								familyId: set.registryRef.familyId,
								rowId: set.registryRef.rowId,
							}
			return
		case "startHz":
		case "endHz":
		case "parentId":
		case "hidden":
			return
	}
}

export const applyBandEdit: ApplyBandEdit = (band, edit, siblingIds) => {
	const next = cloneBand(band)
	const applied = new Set<BandEditField>()
	const issues: ResolveIssue[] = []
	const set = edit?.set
	if (set) {
		for (const field of BAND_EDIT_FIELDS) {
			if (!Object.hasOwn(set, field)) continue
			if (
				field === "hidden" ||
				field === "startHz" ||
				field === "endHz" ||
				field === "parentId"
			)
				continue
			applyPresentField(next, set, field)
			applied.add(field)
		}
		if (Object.hasOwn(set, "startHz") || Object.hasOwn(set, "endHz")) {
			const startHz = Object.hasOwn(set, "startHz")
				? (set.startHz ?? next.startHz)
				: next.startHz
			const endHz = Object.hasOwn(set, "endHz")
				? (set.endHz ?? next.endHz)
				: next.endHz
			if (startHz >= endHz) issues.push("edge-conflict")
			else {
				if (Object.hasOwn(set, "startHz") && set.startHz !== undefined) {
					next.startHz = set.startHz
					applied.add("startHz")
				}
				if (Object.hasOwn(set, "endHz") && set.endHz !== undefined) {
					next.endHz = set.endHz
					applied.add("endHz")
				}
			}
		}
		if (Object.hasOwn(set, "parentId")) {
			next.parentId = set.parentId ?? null
			applied.add("parentId")
		}
		if (Object.hasOwn(set, "hidden")) applied.add("hidden")
	}
	if (next.parentId !== null && !siblingIds.has(next.parentId)) {
		next.parentId = null
		issues.push("dangling-parent")
	}
	const editedFields = BAND_EDIT_FIELDS.filter(field => applied.has(field))
	if (set?.hidden === true)
		return { band: null, editedFields, issues }
	return { band: next, editedFields, issues }
}

/** Touching inclusive ranges merge; a gap of at least 1 Hz stays split. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = intervals
		.filter(interval => interval.startHz <= interval.endHz)
		.map(interval => ({ startHz: interval.startHz, endHz: interval.endHz }))
		.sort((a, b) => a.startHz - b.startHz || a.endHz - b.endHz)
	const merged: Interval[] = []
	for (const interval of sorted) {
		const last = merged[merged.length - 1]
		if (last && interval.startHz <= last.endHz + 1)
			last.endHz = Math.max(last.endHz, interval.endHz)
		else merged.push(interval)
	}
	return merged
}

function subtractInterval(
	startHz: number,
	endHz: number,
	cover: readonly Interval[],
): Interval[] {
	if (startHz > endHz) return []
	const segments: Interval[] = []
	let cursor = startHz
	for (const interval of cover) {
		if (interval.endHz < cursor) continue
		if (interval.startHz > endHz) break
		if (interval.startHz > cursor)
			segments.push({ startHz: cursor, endHz: interval.startHz - 1 })
		const next = interval.endHz + 1
		if (next > cursor) cursor = next
		if (cursor > endHz) break
	}
	if (cursor <= endHz) segments.push({ startHz: cursor, endHz })
	return segments
}

function compareCodeUnit(a: string, b: string): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}

function prepareOperator(band: Band): PreparedBand {
	return {
		key: `${OPERATOR_PACK_ID}/${band.id}`,
		packId: OPERATOR_PACK_ID,
		bandId: band.id,
		layer: 0,
		hidden: false,
		band: cloneBand(band),
		editedFields: [],
		issues: [],
		provenance: band.provenance,
		packProvenance: { kind: "operator" },
	}
}

function prepareStackBand(
	packId: string,
	band: Band,
	layer: number,
	edit: BandEdit | undefined,
	siblingIds: ReadonlySet<string>,
	packProvenance: PlanProvenance,
): PreparedBand {
	const applied = applyBandEdit(band, edit, siblingIds)
	return {
		key: `${packId}/${band.id}`,
		packId,
		bandId: band.id,
		layer,
		hidden: applied.band === null,
		band: applied.band ?? band,
		editedFields: applied.editedFields,
		issues: applied.issues,
		provenance: band.provenance,
		packProvenance,
	}
}

export const resolveBandPlans: ResolveBandPlans = input => {
	const editByKey = new Map<string, BandEdit>()
	for (const edit of input.edits)
		editByKey.set(`${edit.packId}/${edit.bandId}`, edit)

	const layers: PreparedBand[][] = [input.operatorBands.map(prepareOperator)]
	// Layer numbers count only enabled entries whose pack exists (design step 1).
	let layerNumber = 1
	for (const entry of input.stack) {
		if (!entry.enabled) continue
		const pack = input.packs.get(entry.packId)
		if (!pack) continue
		const siblingIds = new Set(pack.bands.map(band => band.id))
		layers.push(
			pack.bands.map(band =>
				prepareStackBand(
					pack.id,
					band,
					layerNumber,
					editByKey.get(`${pack.id}/${band.id}`),
					siblingIds,
					pack.provenance,
				),
			),
		)
		layerNumber += 1
	}

	let cover: Interval[] = []
	const bands: ResolvedBand[] = []
	const shadowed: string[] = []
	const hidden: string[] = []
	for (const layer of layers) {
		const visible: Interval[] = []
		for (const item of layer) {
			if (item.hidden) {
				hidden.push(item.key)
				continue
			}
			if (!(item.band.startHz < item.band.endHz)) {
				shadowed.push(item.key)
				continue
			}
			const segments = subtractInterval(
				item.band.startHz,
				item.band.endHz,
				cover,
			)
			if (segments.length === 0) shadowed.push(item.key)
			else
				bands.push({
					key: item.key,
					packId: item.packId,
					bandId: item.bandId,
					layer: item.layer,
					band: item.band,
					segments,
					editedFields: item.editedFields,
					issues: item.issues,
					provenance: item.provenance,
					packProvenance: item.packProvenance,
				})
			visible.push({ startHz: item.band.startHz, endHz: item.band.endHz })
		}
		cover = mergeIntervals([...cover, ...visible])
	}

	bands.sort((a, b) => {
		const aStart = a.segments[0]?.startHz ?? 0
		const bStart = b.segments[0]?.startHz ?? 0
		if (aStart !== bStart) return aStart - bStart
		if (a.layer !== b.layer) return a.layer - b.layer
		return compareCodeUnit(a.key, b.key)
	})
	shadowed.sort(compareCodeUnit)
	hidden.sort(compareCodeUnit)

	const orphanedEdits: { packId: string; bandId: string }[] = []
	for (const edit of input.edits) {
		const pack = input.packs.get(edit.packId)
		if (!pack) continue
		if (pack.bands.some(band => band.id === edit.bandId)) continue
		orphanedEdits.push({ packId: edit.packId, bandId: edit.bandId })
	}
	orphanedEdits.sort((a, b) =>
		compareCodeUnit(`${a.packId}/${a.bandId}`, `${b.packId}/${b.bandId}`),
	)

	return { bands, shadowed, hidden, orphanedEdits }
}
