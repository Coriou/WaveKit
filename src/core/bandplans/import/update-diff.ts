/**
 * WG6 req 6.2 (lane U): pure diff of a committed imported pack's bands against a freshly
 * parsed file, keyed by band id. No I/O; imports only the frozen contract surface.
 */
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import type {
	Band,
	BandPlanUpdateBand,
	BandPlanUpdateChangedBand,
} from "@wavekit/api-types"

/** The band shape the diff needs; other keys are read when present. */
export type DiffableBand = Pick<Band, "id" | "name" | "startHz" | "endHz">

export interface ImportedBandsDiff {
	readonly added: readonly BandPlanUpdateBand[]
	readonly removed: readonly BandPlanUpdateBand[]
	readonly changed: readonly BandPlanUpdateChangedBand[]
	/**
	 * True when any list was cut to BANDPLANS_LIMITS.bandsPerPack. Never true for stored packs
	 * and parser output (both are bounded by bandsPerPack); the wire type has no such flag.
	 */
	readonly truncated: boolean
}

/** Fields always compared (req 6.2); keys absent from both bands are skipped. */
export const UPDATE_DIFF_FIELD_ORDER: readonly string[] = Object.freeze([
	"name",
	"startHz",
	"endHz",
	"mode",
	"stepHz",
	"colourHint",
	"group",
	"sourceType",
	"channels",
])
/** Never compared: identity, server-derived scan and provenance. */
const IGNORED = new Set(["id", "scan", "provenance"])
const ORDERED = new Set(UPDATE_DIFF_FIELD_ORDER)

function summary(band: DiffableBand): BandPlanUpdateBand {
	return {
		id: band.id,
		name: band.name,
		startHz: band.startHz,
		endHz: band.endHz,
	}
}

function compareBands(left: BandPlanUpdateBand, right: BandPlanUpdateBand) {
	if (left.startHz !== right.startHz) return left.startHz - right.startHz
	if (left.id < right.id) return -1
	if (left.id > right.id) return 1
	return 0
}

function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null
	)
		return false
	return JSON.stringify(left) === JSON.stringify(right)
}

function field(band: DiffableBand, key: string): unknown {
	return Object.hasOwn(band, key) ? Reflect.get(band, key) : undefined
}

/**
 * Differing UPDATE_DIFF_FIELD_ORDER fields plus any other differing key (other than id, scan
 * and provenance), so a diff never hides a change; the whole list sorted by code unit (the
 * frozen DTO says "sorted", e.g. ["endHz", "mode"]).
 */
function changedFields(
	current: DiffableBand,
	fresh: DiffableBand,
): readonly string[] {
	const fields: string[] = []
	for (const key of UPDATE_DIFF_FIELD_ORDER)
		if (!sameValue(field(current, key), field(fresh, key))) fields.push(key)
	let extra: string[] | undefined
	for (const source of [current, fresh])
		for (const key in source)
			if (
				!IGNORED.has(key) &&
				!ORDERED.has(key) &&
				!extra?.includes(key) &&
				!sameValue(field(current, key), field(fresh, key))
			)
				(extra ??= []).push(key)
	if (extra) fields.push(...extra)
	return fields.sort()
}

function capped<T>(list: T[]): { list: T[]; cut: boolean } {
	const limit = BANDPLANS_LIMITS.bandsPerPack
	return list.length > limit
		? { list: list.slice(0, limit), cut: true }
		: { list, cut: false }
}

/**
 * Diff by id: `added` in fresh only, `removed` in current only, `changed` in both with a
 * differing field. Each list is sorted by startHz then id and capped at bandsPerPack.
 * A duplicate id keeps its first occurrence.
 */
export function diffImportedBands(
	current: readonly DiffableBand[],
	fresh: readonly DiffableBand[],
): ImportedBandsDiff {
	const before = new Map<string, DiffableBand>()
	for (const band of current)
		if (!before.has(band.id)) before.set(band.id, band)
	const after = new Map<string, DiffableBand>()
	for (const band of fresh) if (!after.has(band.id)) after.set(band.id, band)
	const added: BandPlanUpdateBand[] = []
	const changed: BandPlanUpdateChangedBand[] = []
	for (const [id, band] of after) {
		const previous = before.get(id)
		if (!previous) {
			added.push(summary(band))
			continue
		}
		const fields = changedFields(previous, band)
		if (fields.length > 0) changed.push({ ...summary(band), fields })
	}
	const removed: BandPlanUpdateBand[] = []
	for (const [id, band] of before)
		if (!after.has(id)) removed.push(summary(band))
	added.sort(compareBands)
	removed.sort(compareBands)
	changed.sort(compareBands)
	const a = capped(added)
	const r = capped(removed)
	const c = capped(changed)
	return {
		added: a.list,
		removed: r.list,
		changed: c.list,
		truncated: a.cut || r.cut || c.cut,
	}
}
