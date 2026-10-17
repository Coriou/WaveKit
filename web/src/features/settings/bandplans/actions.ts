// Band plan writes from Settings › Band plans: each one says what it did in the app toast, with Undo where the core
// can take it back (DESIGN.md "Band plans" 6: edits apply at once with Undo, nothing restarts).
import type {
	Band,
	BandEditField,
	BandEditFields,
	BandInput,
	PlanStackEntryView,
} from "@wavekit/api-types"
import { BAND_EDIT_FIELDS } from "@wavekit/api-types"
import type { BandplanStackStore } from "../../../data/index.ts"
import { bandplanWriteError } from "../../../data/index.ts"
import type { SettingWriteResult } from "../../../data/setting-write.ts"
import { WRITE_OK, writeError } from "../../../data/setting-write.ts"
import { showAppToast } from "../../../shell/toast.ts"
import type { BandEntry } from "./model.ts"
import { OPERATOR, toggleText } from "./model.ts"

const warn = (error: unknown) =>
	showAppToast(bandplanWriteError(error), { tone: "warn" })

/** Runs an undo, saying so when it fails. */
const undoing = (fn: () => Promise<unknown>) => () => {
	fn().then(
		() => undefined,
		(error: unknown) => warn(error),
	)
}

export function toInput(b: Band): BandInput {
	return {
		name: b.name,
		startHz: b.startHz,
		endHz: b.endHz,
		group: b.group,
		mode: b.mode,
		bandwidthHz: b.bandwidthHz,
		stepHz: b.stepHz,
		skip: b.skip,
		channels: [...b.channels],
		parentId: b.parentId,
		colourHint: b.colourHint,
		registryRef: b.registryRef,
	}
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** An edit split into what overrides the pack and what goes back to it. */
export function editPatch(
	original: Band,
	set: BandEditFields,
): { set: BandEditFields | null; reset: BandEditField[] } {
	const out: Record<string, unknown> = {}
	const reset: BandEditField[] = []
	for (const field of BAND_EDIT_FIELDS) {
		if (!Object.hasOwn(set, field)) continue
		const value = set[field]
		const base =
			field === "hidden"
				? false
				: (original as unknown as Record<string, unknown>)[field]
		if (same(value, base)) reset.push(field)
		else out[field] = value
	}
	return {
		set: Object.keys(out).length ? (out as BandEditFields) : null,
		reset,
	}
}

/** The patch that puts `fields` back as they are now (Undo). */
function restorePatch(
	entry: BandEntry,
	fields: readonly string[],
): { set: BandEditFields | null; reset: BandEditField[] } {
	const out: Record<string, unknown> = {}
	const reset: BandEditField[] = []
	const prev = (entry.edit?.set ?? {}) as Record<string, unknown>
	for (const field of BAND_EDIT_FIELDS) {
		if (!fields.includes(field)) continue
		if (Object.hasOwn(prev, field)) out[field] = prev[field]
		else reset.push(field)
	}
	return {
		set: Object.keys(out).length ? (out as BandEditFields) : null,
		reset,
	}
}

/** Saves fields of a band: an edit layer over a pack band, or the band itself when it is yours. */
export async function saveBand(
	store: BandplanStackStore,
	entry: BandEntry,
	set: BandEditFields,
	toast: string,
): Promise<SettingWriteResult> {
	try {
		if (entry.packId === OPERATOR || !entry.original) {
			const prev = toInput(entry.band)
			const next: Record<string, unknown> = { ...prev }
			for (const [key, value] of Object.entries(set))
				if (key !== "hidden" && value !== undefined) next[key] = value
			await store.replaceBand(entry.band.id, next as unknown as BandInput)
			showAppToast(toast, {
				undo: undoing(() => store.replaceBand(entry.band.id, prev)),
			})
			return WRITE_OK
		}
		const patch = editPatch(entry.original, set)
		if (!patch.set && !patch.reset.length) return WRITE_OK
		const back = restorePatch(entry, Object.keys(set))
		await store.patchBand(entry.packId, entry.band.id, patch.set, patch.reset)
		showAppToast(toast, {
			undo: undoing(() =>
				store.patchBand(entry.packId, entry.band.id, back.set, back.reset),
			),
		})
		return WRITE_OK
	} catch (error) {
		return writeError(bandplanWriteError(error))
	}
}

/** Reset to France: drops every edit of the band. */
export async function resetBand(
	store: BandplanStackStore,
	entry: BandEntry,
): Promise<void> {
	const prev = entry.edit?.set
	try {
		await store.resetBand(entry.packId, entry.band.id)
		showAppToast(`${entry.band.name} is back to ${entry.packName}`, {
			...(prev
				? {
						undo: undoing(() =>
							store.patchBand(entry.packId, entry.band.id, prev),
						),
					}
				: {}),
		})
	} catch (error) {
		warn(error)
	}
}

export async function deleteBand(
	store: BandplanStackStore,
	entry: BandEntry,
): Promise<boolean> {
	try {
		await store.deleteBand(entry.band.id)
		const input = toInput(entry.band)
		showAppToast(`${entry.band.name} deleted`, {
			undo: undoing(() => store.createBand(input)),
		})
		return true
	} catch (error) {
		warn(error)
		return false
	}
}

/** A new band of yours, opened in the editor. */
export async function addBand(
	store: BandplanStackStore,
	near: { startHz: number; endHz: number },
): Promise<string | null> {
	try {
		const dto = await store.createBand({
			name: "New band",
			startHz: near.startHz,
			endHz: near.endHz,
			group: "other",
			mode: "nfm",
			bandwidthHz: 12_500,
			stepHz: 12_500,
			skip: null,
			channels: [],
			parentId: null,
			colourHint: null,
			registryRef: null,
		})
		return dto.createdId ? `${OPERATOR}/${dto.createdId}` : null
	} catch (error) {
		warn(error)
		return null
	}
}

/** "Undo all edits": every edit layer and every band you added, with one Undo. */
export async function resetAll(store: BandplanStackStore): Promise<void> {
	const view = store.get().view
	if (!view) return
	const edits = view.edits
	const added = view.operatorBands.map(toInput)
	const packs = [...new Set(edits.map(e => e.packId))]
	const n =
		new Set(edits.map(e => `${e.packId}/${e.bandId}`)).size + added.length
	try {
		for (const p of packs) await store.resetPack(p)
		for (const b of view.operatorBands) await store.deleteBand(b.id)
		showAppToast(`${n} edit${n === 1 ? "" : "s"} undone`, {
			undo: undoing(async () => {
				for (const e of edits) await store.patchBand(e.packId, e.bandId, e.set)
				for (const b of added) await store.createBand(b)
			}),
		})
	} catch (error) {
		warn(error)
	}
}

export async function setStack(
	store: BandplanStackStore,
	next: readonly PlanStackEntryView[],
	toast: string,
): Promise<void> {
	const prev = store.get().view?.stack.entries ?? []
	try {
		await store.setStack(next)
		showAppToast(toast, { undo: undoing(() => store.setStack(prev)) })
	} catch (error) {
		warn(error)
	}
}

export function togglePlan(
	store: BandplanStackStore,
	id: string,
): Promise<void> {
	const entries = store.get().view?.stack.entries ?? []
	const on = !entries.find(e => e.packId === id)?.enabled
	const next = entries.map(e => (e.packId === id ? { ...e, enabled: on } : e))
	return setStack(store, next, toggleText(next, id, on))
}

export async function removeImport(
	store: BandplanStackStore,
	id: string,
	name: string,
): Promise<void> {
	try {
		await store.deletePack(id)
		showAppToast(`${name} removed`)
	} catch (error) {
		warn(error)
	}
}
