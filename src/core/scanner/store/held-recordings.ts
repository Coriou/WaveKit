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
 * HELD_RECORDINGS_MAX (65,536; about 150 B each in memory, under 10 MiB). At the bound a new
 * entry is refused, and the refusal fails closed: the folder of the refused recording is marked
 * overflowed (`overflowed`), and while it is, every recording file in that folder counts as held
 * by an unknown live discovery. No delete path of the folder's own discovery (delete, prune,
 * evict, fold) reaches those files, and retention keeps them (counted), because the owner whose
 * policy they follow is unknown. At most HELD_OVERFLOW_FOLDERS_MAX (4,096) folders are marked one
 * by one; past that every folder counts as overflowed (`all`). The marks are persisted and
 * journaled like the entries; a folder's mark ends only when the folder is gone from disk, `all`
 * never ends by itself.
 *
 * Journal bound: one entry carries at most HELD_RECORDING_CHANGES_MAX changes. A larger change
 * set (a consolidation group that drops and adds many) is split over several journal entries by
 * `takeJournalParts`, ordered re-points, drops, adds, so a replay never holds more than the
 * bound at any point. Every prefix of that sequence is safe (a crash or a refused append can end
 * the durable journal after any entry): the first entry opens a temporary guard, under an id of
 * its own, that marks overflowed every folder a later entry adds to or re-points into (and every
 * folder already marked), so until the change that protects a file is replayed the whole folder
 * is kept. The last entry adds the marks as the table held them to the replayed ones and closes
 * that guard only. A replay keeps every other guard and mark, so sequences whose entries
 * interleave never undo each other's protection, in any order and at any prefix. A guard still
 * open when replay ends (the sequence never finished) stays a mark until its folder is gone from
 * disk. A sequence never replaces the marks, so a mark released in the same take as a sequence
 * may come back on replay: fail closed, the next maintenance prune releases it again.
 */
import { randomBytes } from "node:crypto"
import { z } from "zod"

export const HELD_RECORDINGS_MAX = 65_536
/** The changes one journal entry carries (the schema's bound; a larger set is split). */
export const HELD_RECORDING_CHANGES_MAX = HELD_RECORDINGS_MAX
/** Folders marked one by one when the table is full; past it every folder counts as marked. */
export const HELD_OVERFLOW_FOLDERS_MAX = 4096
/** Temporary guards a replay keeps open at once; one more is made a mark at once (fail closed). */
export const HELD_OPEN_GUARDS_MAX = 64

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

/** Folders whose held recordings the table could not list (see the bound above). */
export interface HeldOverflowState {
	folders: string[]
	all: boolean
}

/** One split sequence's temporary marks (`takeJournalParts`), under the sequence's own id. */
export interface HeldGuardState extends HeldOverflowState {
	id: string
}

/** The held-recording fields of one journal entry (`takeJournalParts`). */
export interface HeldJournalPart {
	heldRecordings: HeldRecordingChange[]
	/** The marks as now held, replacing the replayed ones (an entry that is a whole sequence). */
	heldOverflow?: HeldOverflowState
	/** A sequence's first entry: opens its temporary guard. */
	heldGuard?: HeldGuardState
	/** A sequence's last entry: adds these marks to the replayed ones and closes its guard. */
	heldGuardEnd?: HeldGuardState
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
	.max(HELD_RECORDING_CHANGES_MAX)
export const HeldOverflowSchema = z
	.object({
		folders: z.array(DiscoveryIdSchema).max(HELD_OVERFLOW_FOLDERS_MAX),
		all: z.boolean(),
	})
	.strict()
export const HeldGuardSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[0-9a-z-]+$/),
		folders: z.array(DiscoveryIdSchema).max(HELD_OVERFLOW_FOLDERS_MAX),
		all: z.boolean(),
	})
	.strict()

/**
 * The cheap bound check a journal writer runs before appending (array lengths only): true when
 * the payload's held-recording fields fit their schema bounds.
 */
export function heldPayloadWithinBounds(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null) return true
	const { heldRecordings, heldOverflow, heldGuard, heldGuardEnd } = payload as {
		heldRecordings?: unknown
		heldOverflow?: unknown
		heldGuard?: unknown
		heldGuardEnd?: unknown
	}
	if (
		Array.isArray(heldRecordings) &&
		heldRecordings.length > HELD_RECORDING_CHANGES_MAX
	)
		return false
	return [heldOverflow, heldGuard, heldGuardEnd].every(marks => {
		const folders =
			typeof marks === "object" && marks !== null
				? (marks as { folders?: unknown }).folders
				: undefined
		return !(
			Array.isArray(folders) && folders.length > HELD_OVERFLOW_FOLDERS_MAX
		)
	})
}

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

const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export class HeldRecordingTable {
	private readonly byId = new Map<string, HeldRecordingEntry>()
	private readonly byFolder = new Map<string, Set<string>>()
	private readonly byOwner = new Map<string, Set<string>>()
	/**
	 * Ids changed since the last take (journaled with the next store entry), each with whether it
	 * was held at that take.
	 */
	private readonly touched = new Map<string, boolean>()
	/** Entries refused at the bound since the last `takeRefused`. */
	private refused = 0
	/** Folders with a refused entry (fail closed: their recordings count as held). */
	private readonly overflow = new Set<string>()
	private overflowAll = false
	/** The overflow marks changed since the last take. */
	private overflowDirty = false
	/**
	 * Replay only: the temporary guards of split sequences whose last entry is not replayed yet,
	 * by sequence id. Each counts as marks (`overflowed`); never journaled by themselves (the
	 * snapshot holds them as marks). Empty at runtime unless a sequence never finished.
	 */
	private readonly guards = new Map<
		string,
		{ folders: Set<string>; all: boolean }
	>()
	/** The ids of this table's split sequences: unique across restarts. */
	private readonly guardPrefix = randomBytes(6).toString("hex")
	private guardSeq = 0
	/**
	 * Replay of an entry that journals its own held changes (`replayJournaled`): a listing the
	 * replay re-derives may meet the full table before the entry's own drops are applied. Its
	 * refusal marks nothing (the runtime journaled the outcome: the change, or the mark), so a
	 * replay leaves no mark the runtime never held. The journaled changes themselves (`apply`)
	 * still mark on refusal.
	 */
	private quietRefusals = false

	get size(): number {
		return this.byId.size
	}

	/** Changes not yet journaled (entries, and the overflow marks). */
	get pendingChanges(): number {
		return this.touched.size + (this.overflowDirty ? 1 : 0)
	}

	/**
	 * True when a live discovery may list a recording in `folderId` that the table could not
	 * record (it was full): every recording file there counts as held by an unknown owner.
	 */
	overflowed(folderId: string): boolean {
		if (this.overflowAll || this.overflow.has(folderId)) return true
		for (const g of this.guards.values())
			if (g.all || g.folders.has(folderId)) return true
		return false
	}

	/** The marks and every open guard as one set (`all`: every folder counts as marked). */
	private markedState(): { folders: Set<string>; all: boolean } {
		let all = this.overflowAll
		const folders = new Set(this.overflow)
		for (const g of this.guards.values()) {
			if (g.all) all = true
			for (const id of g.folders) folders.add(id)
		}
		if (all || folders.size > HELD_OVERFLOW_FOLDERS_MAX)
			return { folders: new Set(), all: true }
		return { folders, all: false }
	}

	/** Marked folders (`all`: every folder counts as marked), open guards included. */
	get overflowCount(): { folders: number; all: boolean } {
		const m = this.markedState()
		return { folders: m.folders.size, all: m.all }
	}

	/**
	 * The overflow marks as persisted (open guards included: a sequence a replay never finished
	 * keeps its folders marked); undefined when there are none.
	 */
	overflowState(): HeldOverflowState | undefined {
		const m = this.markedState()
		if (!m.all && m.folders.size === 0) return undefined
		return { folders: [...m.folders].sort(compareId), all: m.all }
	}

	/** The overflow marks to journal when they changed since the last call (the whole state). */
	takeOverflowChange(): HeldOverflowState | undefined {
		if (!this.overflowDirty) return undefined
		this.overflowDirty = false
		return this.overflowState() ?? { folders: [], all: false }
	}

	/**
	 * Restore and replay: the marks exactly as persisted (absent: none). Open guards are kept (a
	 * restore clears them first, `restore`).
	 */
	setOverflow(state: HeldOverflowState | undefined): void {
		this.overflow.clear()
		this.overflowAll = state?.all ?? false
		if (!this.overflowAll)
			for (const id of state?.folders ?? []) {
				if (this.overflow.size >= HELD_OVERFLOW_FOLDERS_MAX) {
					this.overflow.clear()
					this.overflowAll = true
					break
				}
				this.overflow.add(id)
			}
		this.overflowDirty = false
	}

	/** A folder gone from disk holds nothing: its mark ends. `all` never ends here. */
	releaseOverflow(folderId: string): boolean {
		let released = false
		for (const g of this.guards.values())
			if (g.folders.delete(folderId)) released = true
		if (this.overflow.delete(folderId)) {
			this.overflowDirty = true
			released = true
		}
		return released
	}

	/** Every folder id with a mark or an open guard (a copy). */
	overflowFolders(): string[] {
		const folders = new Set(this.overflow)
		for (const g of this.guards.values())
			for (const id of g.folders) folders.add(id)
		return [...folders]
	}

	/**
	 * Replay of a split sequence's first entry: opens its guard (its folders count as marked until
	 * `closeGuard` with the same id). Past HELD_OPEN_GUARDS_MAX open guards it is made a mark at
	 * once (fail closed: kept until its folders are gone from disk).
	 */
	openGuard(guard: HeldGuardState): void {
		if (this.guards.has(guard.id) || this.guards.size >= HELD_OPEN_GUARDS_MAX) {
			this.addMarks(guard)
			return
		}
		this.guards.set(guard.id, {
			folders: new Set(guard.folders),
			all: guard.all,
		})
	}

	/**
	 * Replay of a split sequence's last entry: the marks it carries are added to the replayed ones
	 * (never replacing them), then its own guard closes; every other guard and mark stays.
	 */
	closeGuard(guard: HeldGuardState): void {
		this.addMarks(guard)
		this.guards.delete(guard.id)
	}

	/** Replay: adds journaled marks to the replayed ones (already journaled: not dirty). */
	private addMarks(marks: HeldOverflowState): void {
		const dirty = this.overflowDirty
		if (marks.all) {
			this.overflow.clear()
			this.overflowAll = true
		} else for (const id of marks.folders) this.markOverflow(id)
		this.overflowDirty = dirty
	}

	private markOverflow(folderId: string): void {
		if (this.overflowAll || this.overflow.has(folderId)) return
		if (this.overflow.size >= HELD_OVERFLOW_FOLDERS_MAX) {
			this.overflow.clear()
			this.overflowAll = true
		} else this.overflow.add(folderId)
		this.overflowDirty = true
	}

	private touch(id: string, wasHeld: boolean): void {
		if (!this.touched.has(id)) this.touched.set(id, wasHeld)
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

	/**
	 * Records (or re-points) one entry. False at the bound: the entry is refused and its folder is
	 * marked overflowed (fail closed, see the bound above).
	 */
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
			if (this.quietRefusals) return false
			this.refused++
			this.markOverflow(parts.folderId)
			return false
		}
		this.touch(id, previous !== undefined)
		if (previous !== undefined) this.unindex(previous)
		const entry = { id, ownerId, observationId }
		this.byId.set(id, entry)
		this.index(entry, parts.folderId)
		return true
	}

	drop(id: string): void {
		const previous = this.byId.get(id)
		if (previous === undefined) return
		this.touch(id, true)
		this.unindex(previous)
		this.byId.delete(id)
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

	/**
	 * Journal changes since the last call, in chunks of at most HELD_RECORDING_CHANGES_MAX: the
	 * re-pointed entries, then the dropped ones, then the added ones (each sorted by id), so a
	 * replay in that order never holds more than HELD_RECORDINGS_MAX. An id added and dropped
	 * since the last call is no change. Empty when nothing changed.
	 */
	takeChangeChunks(): HeldRecordingChange[][] {
		if (this.touched.size === 0) return []
		const repointed: string[] = []
		const dropped: string[] = []
		const added: string[] = []
		for (const [id, wasHeld] of this.touched) {
			const held = this.byId.has(id)
			if (wasHeld && held) repointed.push(id)
			else if (wasHeld) dropped.push(id)
			else if (held) added.push(id)
		}
		this.touched.clear()
		const ordered = [
			...repointed.sort(compareId),
			...dropped.sort(compareId),
			...added.sort(compareId),
		].map((id): HeldRecordingChange => {
			const e = this.byId.get(id)
			return e === undefined
				? { id, ownerId: null }
				: { id, ownerId: e.ownerId, observationId: e.observationId }
		})
		const chunks: HeldRecordingChange[][] = []
		for (let i = 0; i < ordered.length; i += HELD_RECORDING_CHANGES_MAX)
			chunks.push(ordered.slice(i, i + HELD_RECORDING_CHANGES_MAX))
		return chunks
	}

	/**
	 * The held-recording fields of the journal entries for the changes since the last call (both
	 * the entries and the overflow marks), one part per entry, in order; empty when nothing
	 * changed. One part carries its changes and, when they changed, the marks (replacing them).
	 * Several parts (past HELD_RECORDING_CHANGES_MAX) share one new sequence id: the first opens
	 * a guard of the marks widened by every folder a later part holds an entry in (past
	 * HELD_OVERFLOW_FOLDERS_MAX, `all`), the last adds the marks as now held and closes that
	 * guard. A replay that stops after any part, with any other sequence's parts interleaved,
	 * keeps every file a later part would protect.
	 */
	takeJournalParts(): HeldJournalPart[] {
		const chunks = this.takeChangeChunks()
		const marks = this.takeOverflowChange()
		if (chunks.length <= 1) {
			const heldRecordings = chunks[0] ?? []
			if (heldRecordings.length === 0 && marks === undefined) return []
			return [
				{
					heldRecordings,
					...(marks !== undefined ? { heldOverflow: marks } : {}),
				},
			]
		}
		const marked = this.markedState()
		const guard = marked.folders
		for (const chunk of chunks.slice(1))
			for (const c of chunk) {
				if (c.ownerId === null) continue
				const folderId = splitRecordingId(c.id)?.folderId
				if (folderId !== undefined) guard.add(folderId)
			}
		const id = `${this.guardPrefix}-${(++this.guardSeq).toString(36)}`
		const guarded: HeldGuardState =
			marked.all || guard.size > HELD_OVERFLOW_FOLDERS_MAX
				? { id, folders: [], all: true }
				: { id, folders: [...guard].sort(compareId), all: false }
		const held: HeldGuardState = {
			id,
			...(this.overflowState() ?? { folders: [], all: false }),
		}
		const last = chunks.length - 1
		return chunks.map((heldRecordings, i) =>
			i === 0
				? { heldRecordings, heldGuard: guarded }
				: i === last
					? { heldRecordings, heldGuardEnd: held }
					: { heldRecordings },
		)
	}

	/** Discards the changes and overflow-mark changes not yet journaled (a restore derived them). */
	discardChanges(): void {
		this.touched.clear()
		this.overflowDirty = false
	}

	takeRefused(): number {
		const n = this.refused
		this.refused = 0
		return n
	}

	/**
	 * Replay: the journaled changes as written, drops first (an entry written by an older core
	 * may interleave them). A hold refused at the bound marks its folder (fail closed).
	 */
	apply(changes: readonly HeldRecordingChange[]): void {
		const quiet = this.quietRefusals
		this.quietRefusals = false
		for (const c of changes)
			if (c.ownerId === null || c.observationId === undefined) this.drop(c.id)
		for (const c of changes)
			if (c.ownerId !== null && c.observationId !== undefined)
				this.hold(c.id, c.ownerId, c.observationId)
		this.touched.clear()
		this.quietRefusals = quiet
	}

	/**
	 * Replay of one entry: `run` with re-derived refusals quiet when the entry journals its own
	 * held changes (`journaled`); an entry without them (an older core's) marks as at runtime.
	 */
	replayJournaled<T>(journaled: boolean, run: () => T): T {
		const quiet = this.quietRefusals
		this.quietRefusals = journaled
		try {
			return run()
		} finally {
			this.quietRefusals = quiet
		}
	}

	entries(): HeldRecordingEntry[] {
		return [...this.byId.values()]
			.sort((a, b) => compareId(a.id, b.id))
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
		this.overflow.clear()
		this.overflowAll = false
		this.overflowDirty = false
		this.guards.clear()
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
