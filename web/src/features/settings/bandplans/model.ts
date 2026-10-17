// Settings › Band plans (docs/web/canvas/Settings.dc.html, DESIGN.md "Band plans"): the stack of plans and the
// bands they add up to, from the core's stack view, its packs as shipped and the resolved plan. Pure, so the
// wording, the marks, the filters and the nesting test in node.
import type {
	Band,
	BandEdit,
	BandPlanImportFormat,
	BandPlanPack,
	BandPlanPackSummary,
	BandPlanStackView,
	DisplayGroup,
	PlanStackEntryView,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import { DISPLAY_GROUPS } from "@wavekit/api-types"
import { formatMHz } from "../../format.ts"
import { groupName } from "../../tuner/band.ts"

export const OPERATOR = "operator"
export const YOUR_EDITS = "Your edits"

export const FORMAT_NAME: Readonly<Record<BandPlanImportFormat, string>> = {
	"sdrpp-json": "SDR++ JSON",
	"sdrsharp-xml": "SDR# XML",
	"gqrx-csv": "Gqrx CSV",
}

/** "156.000–162.025 MHz". */
export function edgesText(startHz: number, endHz: number): string {
	return `${formatMHz(startHz)}–${formatMHz(endHz)} MHz`
}

export type BandMark = "Added" | "Hidden" | "Renamed" | "Edited"

/** One band of the list: the pack band with its edits, or one of yours. */
export interface BandEntry {
	/** `${packId}/${bandId}`, as the resolved plan keys it. */
	readonly key: string
	readonly packId: string
	readonly band: Band
	/** As the pack ships it; null for a band you added. */
	readonly original: Band | null
	readonly edit: BandEdit | null
	readonly hidden: boolean
	/** The plan that names it: "France", or "Your edits" for added and renamed bands. */
	readonly namedBy: string
	readonly packName: string
	readonly verified: boolean
	readonly mark: BandMark | null
}

export function applyEdit(band: Band, edit: BandEdit | null): Band {
	if (!edit) return band
	const out: Record<string, unknown> = { ...band }
	for (const [key, value] of Object.entries(edit.set))
		if (key !== "hidden" && value !== undefined) out[key] = value
	return out as unknown as Band
}

/**
 * The bands the active plans add up to, lowest first: yours, then every enabled plan's bands with your
 * edits, hidden ones included (they stay listed), minus those a higher plan names entirely.
 */
export function bandEntries(
	view: BandPlanStackView,
	packs: Readonly<Record<string, BandPlanPack>>,
	resolved: ResolvedBandPlanView | null,
): BandEntry[] {
	const shadowed = new Set(resolved?.shadowed ?? [])
	const out: BandEntry[] = view.operatorBands.map(band => ({
		key: `${OPERATOR}/${band.id}`,
		packId: OPERATOR,
		band,
		original: null,
		edit: null,
		hidden: false,
		namedBy: YOUR_EDITS,
		packName: YOUR_EDITS,
		verified: false,
		mark: "Added",
	}))
	for (const entry of view.stack.entries) {
		const pack = packs[entry.packId]
		if (!entry.enabled || !pack) continue
		for (const original of pack.bands) {
			const key = `${pack.id}/${original.id}`
			if (shadowed.has(key)) continue
			const edit =
				view.edits.find(
					e => e.packId === pack.id && e.bandId === original.id,
				) ?? null
			const hidden = edit?.set.hidden === true
			const renamed = edit !== null && edit.set.name !== undefined
			const mark: BandMark | null = hidden
				? "Hidden"
				: renamed
					? "Renamed"
					: edit
						? "Edited"
						: null
			out.push({
				key,
				packId: pack.id,
				band: applyEdit(original, edit),
				original,
				edit,
				hidden,
				namedBy: renamed ? YOUR_EDITS : pack.name,
				packName: pack.name,
				verified: original.provenance.kind === "builtin-cited",
				mark,
			})
		}
	}
	return out.sort(
		(a, b) =>
			a.band.startHz - b.band.startHz ||
			b.band.endHz - a.band.endHz ||
			(a.key < b.key ? -1 : 1),
	)
}

/** Bands you changed or added: what "Your edits" counts. */
export const isEdited = (e: BandEntry): boolean =>
	e.mark !== null || e.edit !== null

export type BandFilter = "all" | "edited" | DisplayGroup

export interface BandChip {
	readonly id: BandFilter
	readonly label: string
	readonly n: number
	/** A group's swatch. */
	readonly group?: DisplayGroup
}

/** All, then each group that has bands (WaveKit's fixed order), then Edited when anything is. */
export function bandChips(entries: readonly BandEntry[]): BandChip[] {
	const chips: BandChip[] = [{ id: "all", label: "All", n: entries.length }]
	for (const g of DISPLAY_GROUPS) {
		const n = entries.filter(e => e.band.group === g).length
		if (n) chips.push({ id: g, label: groupName(g), n, group: g })
	}
	const edited = entries.filter(isEdited).length
	if (edited) chips.push({ id: "edited", label: "Edited", n: edited })
	return chips
}

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")

/** A typed frequency in MHz ("156.8", "446,1"), else null. */
export function typedMHz(q: string): number | null {
	const t = q.trim().replace(",", ".")
	if (!/^\d+(\.\d+)?$/.test(t)) return null
	const v = Number(t)
	return v > 0 ? Math.round(v * 1e6) : null
}

export function matchesBand(e: BandEntry, q: string): boolean {
	const hz = typedMHz(q)
	if (hz !== null) return hz >= e.band.startHz && hz <= e.band.endHz
	const text = fold(
		[
			e.band.name,
			groupName(e.band.group),
			...e.band.channels.flatMap(c => [c.name, ...c.aliases]),
		].join(" "),
	)
	return fold(q)
		.trim()
		.split(/\s+/)
		.every(w => text.includes(w))
}

export interface BandListRow {
	readonly entry: BandEntry
	readonly depth: number
}

/**
 * The list under the stack: a tree by parent band (same plan) when nothing narrows it, else the matching
 * bands flat, lowest first.
 */
export function bandRows(
	entries: readonly BandEntry[],
	q: string,
	filter: BandFilter,
): BandListRow[] {
	const flat = q.trim() !== "" || filter !== "all"
	if (flat)
		return entries
			.filter(e =>
				filter === "all"
					? true
					: filter === "edited"
						? isEdited(e)
						: e.band.group === filter,
			)
			.filter(e => !q.trim() || matchesBand(e, q))
			.map(entry => ({ entry, depth: 0 }))
	const keys = new Set(entries.map(e => e.key))
	const parentKey = (e: BandEntry) =>
		e.band.parentId === null ? null : `${e.packId}/${e.band.parentId}`
	const rows: BandListRow[] = []
	const walk = (parent: string | null, depth: number) => {
		for (const e of entries) {
			const p = parentKey(e)
			const top = p === null || !keys.has(p)
			if (parent === null ? top : p === parent) {
				rows.push({ entry: e, depth })
				if (depth < 6) walk(e.key, depth + 1)
			}
		}
	}
	walk(null, 0)
	return rows
}

/** The list row's second line: "Your edits · 2 channels · Scans skip it: Broadcast". */
export function bandExtra(e: BandEntry): string {
	const n = e.band.channels.length
	return [
		n ? `${n} channel${n === 1 ? "" : "s"}` : "",
		e.band.skip ? `Scans skip it: ${e.band.skip.reason}` : "",
	]
		.filter(Boolean)
		.join(" · ")
}

// ---- the stack

export interface PlanItem {
	readonly id: string
	readonly name: string
	readonly kind: "edits" | "builtin" | "imported"
	readonly on: boolean
	readonly sub: string
	readonly prov: string
	/** Where "Show source" goes. */
	readonly source: string | null
	readonly canCheck: boolean
}

const day = (iso: string) => {
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return iso
	return new Date(t).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
	})
}

/** "github.com/Arrin-KN1E/SDR-Band-Plans": the address without the scheme and the file. */
export function shortUrl(url: string): string {
	return url.replace(/^https?:\/\//, "").replace(/\/[^/]*$/, "")
}

/** Your edits on top, then the stack in order, each with its sub line and provenance. */
export function planItems(
	view: BandPlanStackView,
	packs: Readonly<Record<string, BandPlanPack>>,
	editCount: number,
): PlanItem[] {
	const items: PlanItem[] = [
		{
			id: OPERATOR,
			name: YOUR_EDITS,
			kind: "edits",
			on: true,
			sub: `${editCount ? `${editCount} change${editCount === 1 ? "" : "s"}` : "No changes yet"}, kept when packs update. Always on top.`,
			prov: "",
			source: null,
			canCheck: false,
		},
	]
	const entries = view.stack.entries
	entries.forEach((entry, i) => {
		const summary = view.packs.find(p => p.id === entry.packId)
		items.push(planItem(entry, summary, packs[entry.packId], entries, i))
	})
	return items
}

function planItem(
	entry: PlanStackEntryView,
	summary: BandPlanPackSummary | undefined,
	pack: BandPlanPack | undefined,
	entries: readonly PlanStackEntryView[],
	i: number,
): PlanItem {
	const count = summary?.bandCount ?? pack?.bands.length ?? 0
	const prov = summary?.provenance ?? pack?.provenance
	if (prov?.kind === "imported") {
		const from = prov.sourceUrl
			? `from ${shortUrl(prov.sourceUrl)}`
			: `from ${prov.sourceName}`
		return {
			id: entry.packId,
			name: entry.name,
			kind: "imported",
			on: entry.enabled,
			sub: `Imported ${day(prov.importedAt)} ${from}`,
			prov: [
				FORMAT_NAME[prov.format],
				`${count} band${count === 1 ? "" : "s"}`,
				prov.author ? `by ${prov.author}` : "",
				prov.licence ?? "",
				"none verified",
			]
				.filter(Boolean)
				.join(" · "),
			source: prov.sourceUrl ?? null,
			canCheck: prov.sourceUrl !== undefined,
		}
	}
	const bands = pack?.bands ?? []
	const verified = bands.filter(b => b.provenance.kind === "builtin-cited")
	const citations = [
		...new Map(
			verified.flatMap(b =>
				b.provenance.kind === "builtin-cited"
					? b.provenance.citations.map(c => [c.title, c] as const)
					: [],
			),
		).values(),
	]
	const above = entries
		.slice(0, i)
		.filter(e => e.enabled)
		.at(-1)
	return {
		id: entry.packId,
		name: entry.name,
		kind: "builtin",
		on: entry.enabled,
		sub: above
			? `Fills what ${above.name} leaves out`
			: "Names a band first where plans overlap",
		prov: [
			`${verified.length} of ${count} verified`,
			citations.map(c => c.title).join(", "),
		]
			.filter(Boolean)
			.join(" · "),
		source: citations[0]?.url ?? null,
		canCheck: false,
	}
}

/** What turning a plan off means: "France off · its bands fall through to CEPT / EU baseline". */
export function toggleText(
	entries: readonly PlanStackEntryView[],
	id: string,
	on: boolean,
): string {
	const i = entries.findIndex(e => e.packId === id)
	const name = entries[i]?.name ?? id
	if (on) return `${name} on`
	const below = entries.slice(i + 1).find(e => e.enabled)
	return below
		? `${name} off · its bands fall through to ${below.name}`
		: `${name} off`
}

/** The stack with one entry moved by `by` places, clamped. */
export function moved<T extends { readonly packId: string }>(
	entries: readonly T[],
	id: string,
	by: number,
): T[] {
	const out = [...entries]
	const i = out.findIndex(e => e.packId === id)
	if (i < 0) return out
	const [e] = out.splice(i, 1)
	const j = Math.max(0, Math.min(out.length, i + by))
	if (e) out.splice(j, 0, e)
	return out
}

/** The stack with `id` dropped before `target`. */
export function droppedBefore<T extends { readonly packId: string }>(
	entries: readonly T[],
	id: string,
	target: string,
): T[] {
	const e = entries.find(x => x.packId === id)
	if (!e || id === target) return [...entries]
	const out = entries.filter(x => x.packId !== id)
	const j = out.findIndex(x => x.packId === target)
	out.splice(j < 0 ? out.length : j, 0, e)
	return out
}
