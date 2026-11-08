/**
 * Storage ownership of recordings a discovery lists in another discovery's folder (a co-channel
 * split moved the observation, or a merge made that folder an alias; the file stayed where it
 * was written). The observation window is
 * bounded (OBSERVATIONS_PER_DISCOVERY), so a listing can age out of it; this table keeps the
 * ownership independently of the window: an entry is made whenever an observation lists a
 * recording outside its discovery's own folders, and it lasts until the recording is forgotten,
 * the owner is deleted, or the file is gone from disk (maintenance prune). A merge moves the
 * owner's entries to the survivor. Persisted in the snapshot and journaled as changes, so it
 * survives a snapshot, a restart and a replay. Every kind (analog, digital) is covered: the key
 * is the recording id `<folderId>~<file>`.
 *
 * Bound: one entry per recording file listed outside its folder's owner, at most
 * HELD_RECORDINGS_MAX (about 150 B each in memory).
 */
import { z } from "zod"

export const HELD_RECORDINGS_MAX = 65_536

const RECORDING = /^(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]+\.wav)$/

export interface HeldRecordingEntry {
	/** The recording id, `<folderId>~<file>`. */
	id: string
	/** The live discovery that lists it. */
	ownerId: string
	/** The observation that listed it (the analog recovery association key). */
	observationId: string
}

/** One journaled change: the entry as now held, or `ownerId: null` when it was dropped. */
export interface HeldRecordingChange {
	id: string
	ownerId: string | null
	observationId?: string
}

const RecordingIdSchema = z.string().max(256).regex(RECORDING)
const DiscoveryIdSchema = z
	.string()
	.max(64)
	.regex(/^d_[0-9A-Za-z]+$/)

export const HeldRecordingEntrySchema = z
	.object({
		id: RecordingIdSchema,
		ownerId: DiscoveryIdSchema,
		observationId: z.string().min(1).max(128),
	})
	.strict()

export const HeldRecordingChangeSchema = z
	.object({
		id: RecordingIdSchema,
		ownerId: DiscoveryIdSchema.nullable(),
		observationId: z.string().min(1).max(128).optional(),
	})
	.strict()

export const HeldRecordingsSchema = z
	.array(HeldRecordingEntrySchema)
	.max(HELD_RECORDINGS_MAX)
export const HeldRecordingChangesSchema = z
	.array(HeldRecordingChangeSchema)
	.max(HELD_RECORDINGS_MAX)

/** The folder id and file name of a recording id; null for any other text. */
export function splitRecordingId(
	id: string,
): { folderId: string; name: string } | null {
	const m = RECORDING.exec(id)
	const folderId = m?.[1]
	const name = m?.[2]
	return folderId === undefined || name === undefined
		? null
		: { folderId, name }
}

export class HeldRecordingTable {
	private readonly byId = new Map<string, HeldRecordingEntry>()
	private readonly byFolder = new Map<string, Set<string>>()
	private readonly byOwner = new Map<string, Set<string>>()
	/** Ids changed since the last `takeChanges` (journaled with the next store entry). */
	private readonly touched = new Set<string>()
	/** Entries refused at the bound since the last `takeRefused`. */
	private refused = 0

	get size(): number {
		return this.byId.size
	}

	/** Changes not yet journaled. */
	get pendingChanges(): number {
		return this.touched.size
	}

	get(id: string): HeldRecordingEntry | undefined {
		return this.byId.get(id)
	}

	/** The entries of one folder (any owner). */
	inFolder(folderId: string): HeldRecordingEntry[] {
		const ids = this.byFolder.get(folderId)
		if (ids === undefined) return []
		const out: HeldRecordingEntry[] = []
		for (const id of ids) {
			const e = this.byId.get(id)
			if (e !== undefined) out.push(e)
		}
		return out
	}

	ownedBy(ownerId: string): string[] {
		return [...(this.byOwner.get(ownerId) ?? [])]
	}

	/** Records (or re-points) one entry; false at the bound (nothing changes). */
	hold(id: string, ownerId: string, observationId: string): boolean {
		const parts = splitRecordingId(id)
		if (parts === null || parts.folderId === ownerId) return false
		const previous = this.byId.get(id)
		if (
			previous !== undefined &&
			previous.ownerId === ownerId &&
			previous.observationId === observationId
		)
			return true
		if (previous === undefined && this.byId.size >= HELD_RECORDINGS_MAX) {
			this.refused++
			return false
		}
		if (previous !== undefined) this.unindex(previous)
		const entry = { id, ownerId, observationId }
		this.byId.set(id, entry)
		this.index(entry, parts.folderId)
		this.touched.add(id)
		return true
	}

	drop(id: string): void {
		const previous = this.byId.get(id)
		if (previous === undefined) return
		this.unindex(previous)
		this.byId.delete(id)
		this.touched.add(id)
	}

	/** A merge: every entry of `from` now belongs to `to` (an entry in `to`'s own folder goes). */
	moveOwner(from: string, to: string): void {
		for (const id of this.ownedBy(from)) {
			const e = this.byId.get(id)
			if (e === undefined) continue
			if (splitRecordingId(id)?.folderId === to) this.drop(id)
			else this.hold(id, to, e.observationId)
		}
	}

	dropOwner(ownerId: string): void {
		for (const id of this.ownedBy(ownerId)) this.drop(id)
	}

	/** Journal changes since the last call, sorted by id. */
	takeChanges(): HeldRecordingChange[] {
		if (this.touched.size === 0) return []
		const out = [...this.touched]
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
			.map((id): HeldRecordingChange => {
				const e = this.byId.get(id)
				return e === undefined
					? { id, ownerId: null }
					: { id, ownerId: e.ownerId, observationId: e.observationId }
			})
		this.touched.clear()
		return out
	}

	takeRefused(): number {
		const n = this.refused
		this.refused = 0
		return n
	}

	/** Replay: the journaled changes as written. */
	apply(changes: readonly HeldRecordingChange[]): void {
		for (const c of changes)
			if (c.ownerId === null || c.observationId === undefined) this.drop(c.id)
			else this.hold(c.id, c.ownerId, c.observationId)
		this.touched.clear()
	}

	entries(): HeldRecordingEntry[] {
		return [...this.byId.values()]
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.map(e => ({ ...e }))
	}

	restore(entries: readonly HeldRecordingEntry[]): void {
		this.clear()
		for (const e of entries) this.hold(e.id, e.ownerId, e.observationId)
		this.touched.clear()
	}

	clear(): void {
		this.byId.clear()
		this.byFolder.clear()
		this.byOwner.clear()
		this.touched.clear()
		this.refused = 0
	}

	private index(e: HeldRecordingEntry, folderId: string): void {
		let f = this.byFolder.get(folderId)
		if (f === undefined) this.byFolder.set(folderId, (f = new Set()))
		f.add(e.id)
		let o = this.byOwner.get(e.ownerId)
		if (o === undefined) this.byOwner.set(e.ownerId, (o = new Set()))
		o.add(e.id)
	}

	private unindex(e: HeldRecordingEntry): void {
		const folderId = splitRecordingId(e.id)?.folderId
		if (folderId !== undefined) {
			const f = this.byFolder.get(folderId)
			f?.delete(e.id)
			if (f?.size === 0) this.byFolder.delete(folderId)
		}
		const o = this.byOwner.get(e.ownerId)
		o?.delete(e.id)
		if (o?.size === 0) this.byOwner.delete(e.ownerId)
	}
}
