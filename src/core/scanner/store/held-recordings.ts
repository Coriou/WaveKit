/**
 * Storage ownership of recordings listed by more than their folder's own discovery (a co-channel
 * split moved the observation, a merge made that folder an alias, or several observations list
 * one file; the file stays where it was written). The observation window is bounded
 * (OBSERVATIONS_PER_DISCOVERY), so a listing can age out of it; this table keeps every listing
 * independently of the window.
 *
 * Model: one entry per listing, keyed by the recording id `<folderId>~<file>` and the
 * observation that lists it, naming the live discovery that observation belongs to (`ownerId`,
 * the holder). A file's holders are the distinct holders of its entries: every live discovery
 * that lists it, the folder's own discovery included once the file has any other holder (so the
 * folder's discovery counts only when it lists the file itself). An entry is made whenever an
 * observation lists a recording outside its discovery's own folder, and for every listing in the
 * folder's own discovery of a file that already has an entry, and when an observation listing a
 * file in its discovery's own folder leaves the window (that listing is then the only record
 * that the folder's discovery lists the file, kept for a lister that arrives later). It lasts
 * until the file is forgotten (deleted), its holder is deleted (only that holder's entries go,
 * never the file's other entries), the observation moves (the entry follows it) or the file is
 * gone from disk (maintenance prune). A merge moves the dropped discovery's entries to the survivor. Persisted in
 * the snapshot and journaled as changes, so it survives a snapshot, a restart and a replay. Every
 * kind (analog, digital) is covered.
 *
 * Earlier state: an entry written by an earlier format (one holder per file) is one listing of
 * the new shape, so a snapshot loads as is. A journaled change of an earlier format
 * (HELD_JOURNAL_FORMAT below 3) re-pointed or dropped the file's single entry; replayed, a hold
 * adds its listing and a drop removes nothing (fail closed: a stale listing keeps the file until
 * the maintenance prune finds its file gone, its holder gone or its observation no longer listing
 * it).
 *
 * Bound: at most HELD_RECORDINGS_MAX (65,536) entries (about 200 B each in memory, under
 * 16 MiB). The listings that left the window are one entry per such recording still on disk:
 * at the default recordings quota (512 MiB) and a few seconds of call audio per file (tens of
 * KiB), a few thousand to about 20,000, well inside the bound; only a very large quota or many
 * kept files reach it, and then the refusal fails closed as below. At the bound a new entry is
 * refused, and the refusal fails closed: the folder of the refused recording is marked
 * overflowed (`overflowed`), and while it is, every recording file in that folder counts as held
 * by an unknown live discovery. No delete path reaches those files,
 * and retention keeps them (counted), because the holders whose policy they follow are unknown.
 * At most HELD_OVERFLOW_FOLDERS_MAX (4,096) folders are marked one by one; past that every folder
 * counts as overflowed (`all`). The marks are persisted and journaled like the entries; a
 * folder's mark ends only when the folder is gone from disk, `all` never ends by itself.
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
 *
 * Replay safety marks: a guard made a mark at once (past HELD_OPEN_GUARDS_MAX open guards, or a
 * repeated id) and a hold refused while replaying (a journaled change, or a listing re-derived
 * from an entry without this writer's format marker, HELD_JOURNAL_FORMAT) or restoring are kept
 * in a set of their own. No whole-set replacement of the marks (an entry's `heldOverflow`)
 * clears them, since the runtime that wrote it never met that refusal; they end only when their
 * folder is gone from disk. They count as marks everywhere and are persisted with them in the
 * snapshot (and in the next whole set the runtime journals). Bound: HELD_OVERFLOW_FOLDERS_MAX
 * folders; past it every folder counts as marked, which never ends by itself.
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
/**
 * The format marker (`heldFormat`) on every journal entry this writer emits: such an entry
 * journals one change per listing (recording id and observation) and the outcome of every
 * refusal (the change, or the mark), so a replay trusts it. An entry without it, or with an
 * earlier marker (HELD_JOURNAL_FORMAT_SINGLE: one holder per file), is never trusted: a refusal
 * its replay re-derives marks the folder, and its changes replay as described above.
 */
export const HELD_JOURNAL_FORMAT = 3
/** The earlier marker: entries that journaled one holder per file, and their overflow marks. */
export const HELD_JOURNAL_FORMAT_SINGLE = 2
/** The markers a journal entry may carry (older ones still load). */
export type HeldJournalFormat =
	| typeof HELD_JOURNAL_FORMAT_SINGLE
	| typeof HELD_JOURNAL_FORMAT

const RECORDING = /^(d_[0-9A-Za-z]+)~([A-Za-z0-9_.-]+\.wav)$/

export interface HeldRecordingEntry {
	/** The recording id, `<folderId>~<file>`. */
	id: string
	/** The live discovery the listing observation belongs to (the holder). */
	ownerId: string
	/** The observation that lists it (the analog recovery association key). */
	observationId: string
}

/**
 * One journaled change: the listing (`id`, `observationId`) as now held, or `ownerId: null` when
 * it was dropped. Earlier formats wrote a drop without `observationId` (the file's only entry).
 */
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
export const HeldJournalFormatSchema = z.union([
	z.literal(HELD_JOURNAL_FORMAT_SINGLE),
	z.literal(HELD_JOURNAL_FORMAT),
])
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

/** One listing, held as one record so its key is built (and hashed) once. */
interface Listing {
	readonly id: string
	readonly observationId: string
	ownerId: string
}

/** A change since the last take: the listing, and whether it was held at that take. */
interface Touched {
	readonly id: string
	readonly observationId: string
	readonly wasHeld: boolean
}

export class HeldRecordingTable {
	/**
	 * Per recording id: its one listing, or its listings by observation id (most files have one,
	 * held without a map of their own).
	 */
	private readonly byId = new Map<string, Listing | Map<string, Listing>>()
	private count = 0
	private readonly byFolder = new Map<string, Set<string>>()
	/** Per holder: its listings. */
	private readonly byOwner = new Map<string, Set<Listing>>()
	/**
	 * Listings changed since the last take (journaled with the next store entry), by recording
	 * id then observation id, each with whether it was held at that take.
	 */
	private readonly touched = new Map<string, Map<string, Touched>>()
	private touchedCount = 0
	/** False while a restore or a replayed change set is applied (nothing to journal). */
	private tracking = true
	/** Entries refused at the bound since the last `takeRefused`. */
	private refused = 0
	/** Folders with a refused entry (fail closed: their recordings count as held). */
	private readonly overflow = new Set<string>()
	private overflowAll = false
	/** The overflow marks changed since the last take. */
	private overflowDirty = false
	/**
	 * Replay safety marks: a guard promoted at once (past HELD_OPEN_GUARDS_MAX, or a repeated
	 * id) and a hold refused while replaying or restoring. They count as marks everywhere and are
	 * persisted with them (`overflowState`), but no whole-set replacement (`setOverflow`) clears
	 * them: the entry that replaces the marks was written by a runtime that never met that
	 * refusal. A folder's safety mark ends only when the folder is gone from disk
	 * (`releaseOverflow`). Bound: HELD_OVERFLOW_FOLDERS_MAX folders; past it every folder counts
	 * as marked (`safetyAll`), which never ends by itself.
	 */
	private readonly safety = new Set<string>()
	private safetyAll = false
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
	 * What a hold refused at the bound does. `runtime`: marks its folder (journaled). `quiet`:
	 * nothing; replay of an entry carrying this writer's format marker (`replayJournaled`), where
	 * a listing the replay re-derives may meet the full table before the entry's own drops are
	 * applied, and the runtime journaled the outcome (the change, or the mark). `safety`: a
	 * replay safety mark; replay of any other entry, the journaled changes themselves (`apply`)
	 * and a restore.
	 */
	private refusals: "runtime" | "quiet" | "safety" = "runtime"

	/** Entries (listings) held. */
	get size(): number {
		return this.count
	}

	/** Changes not yet journaled (entries, and the overflow marks). */
	get pendingChanges(): number {
		return this.touchedCount + (this.overflowDirty ? 1 : 0)
	}

	/**
	 * True when a live discovery may list a recording in `folderId` that the table could not
	 * record (it was full): every recording file there counts as held by an unknown owner.
	 */
	overflowed(folderId: string): boolean {
		if (this.overflowAll || this.overflow.has(folderId)) return true
		if (this.safetyAll || this.safety.has(folderId)) return true
		for (const g of this.guards.values())
			if (g.all || g.folders.has(folderId)) return true
		return false
	}

	/** The marks and every open guard as one set (`all`: every folder counts as marked). */
	private markedState(): { folders: Set<string>; all: boolean } {
		let all = this.overflowAll || this.safetyAll
		const folders = new Set(this.overflow)
		for (const id of this.safety) folders.add(id)
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
	 * Restore and replay: the marks exactly as persisted (absent: none). Open guards and replay
	 * safety marks are kept (a restore clears them first, `restore`).
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
		if (this.safety.delete(folderId)) {
			this.overflowDirty = true
			released = true
		}
		if (this.overflow.delete(folderId)) {
			this.overflowDirty = true
			released = true
		}
		return released
	}

	/** Every folder id with a mark, a replay safety mark or an open guard (a copy). */
	overflowFolders(): string[] {
		const folders = new Set(this.overflow)
		for (const id of this.safety) folders.add(id)
		for (const g of this.guards.values())
			for (const id of g.folders) folders.add(id)
		return [...folders]
	}

	/**
	 * Replay of a split sequence's first entry: opens its guard (its folders count as marked until
	 * `closeGuard` with the same id). Past HELD_OPEN_GUARDS_MAX open guards, or under an id
	 * already open, it is made a replay safety mark at once (fail closed: kept until its folders
	 * are gone from disk, whatever replaces the marks meanwhile).
	 */
	openGuard(guard: HeldGuardState): void {
		if (this.guards.has(guard.id) || this.guards.size >= HELD_OPEN_GUARDS_MAX) {
			if (guard.all) this.markSafetyAll()
			else for (const id of guard.folders) this.markSafety(id)
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

	/** A replay safety mark (never journaled by itself: a replay derives it again). */
	private markSafety(folderId: string): void {
		if (this.safetyAll || this.safety.has(folderId)) return
		if (this.safety.size >= HELD_OVERFLOW_FOLDERS_MAX) this.markSafetyAll()
		else this.safety.add(folderId)
	}

	private markSafetyAll(): void {
		this.safety.clear()
		this.safetyAll = true
	}

	private markOverflow(folderId: string): void {
		if (this.overflowAll || this.overflow.has(folderId)) return
		if (this.overflow.size >= HELD_OVERFLOW_FOLDERS_MAX) {
			this.overflow.clear()
			this.overflowAll = true
		} else this.overflow.add(folderId)
		this.overflowDirty = true
	}

	private touch(id: string, observationId: string, wasHeld: boolean): void {
		if (!this.tracking) return
		let m = this.touched.get(id)
		if (m === undefined) this.touched.set(id, (m = new Map()))
		if (m.has(observationId)) return
		m.set(observationId, { id, observationId, wasHeld })
		this.touchedCount++
	}

	/** True when the table holds any listing of `id`. */
	has(id: string): boolean {
		return this.byId.has(id)
	}

	/** The holder of one listing; undefined when the table does not hold it. */
	holderOf(id: string, observationId: string): string | undefined {
		return this.listing(id, observationId)?.ownerId
	}

	private listing(id: string, observationId: string): Listing | undefined {
		const v = this.byId.get(id)
		if (v === undefined || v instanceof Map) return v?.get(observationId)
		return v.observationId === observationId ? v : undefined
	}

	private listingsIn(id: string): readonly Listing[] {
		const v = this.byId.get(id)
		if (v === undefined) return []
		return v instanceof Map ? [...v.values()] : [v]
	}

	/** The distinct holders of `id`, sorted (empty when the table holds no listing of it). */
	holders(id: string): string[] {
		const v = this.byId.get(id)
		if (v === undefined) return []
		if (!(v instanceof Map)) return [v.ownerId]
		const out = new Set<string>()
		for (const l of v.values()) out.add(l.ownerId)
		return [...out].sort(compareId)
	}

	/** The listings of `id`. */
	listingsOf(id: string): HeldRecordingEntry[] {
		return this.listingsIn(id).map(l => ({
			id,
			ownerId: l.ownerId,
			observationId: l.observationId,
		}))
	}

	/** The listings of one folder's files (any holder). */
	inFolder(folderId: string): HeldRecordingEntry[] {
		const ids = this.byFolder.get(folderId)
		if (ids === undefined) return []
		const out: HeldRecordingEntry[] = []
		for (const id of ids) out.push(...this.listingsOf(id))
		return out
	}

	/** The recording ids `ownerId` holds a listing of. */
	ownedBy(ownerId: string): string[] {
		const listings = this.byOwner.get(ownerId)
		if (listings === undefined) return []
		return [...new Set([...listings].map(l => l.id))]
	}

	/**
	 * Records (or re-points) the listing of `id` by `observationId`, now held by `ownerId` (the
	 * folder's own discovery included). False at the bound: the entry is refused and its folder is
	 * marked overflowed (fail closed, see the bound above).
	 */
	hold(id: string, ownerId: string, observationId: string): boolean {
		const v = this.byId.get(id)
		const previous =
			v === undefined
				? undefined
				: v instanceof Map
					? v.get(observationId)
					: v.observationId === observationId
						? v
						: undefined
		if (previous !== undefined) {
			if (previous.ownerId === ownerId) return true
			this.touch(id, observationId, true)
			this.unindexOwner(previous)
			previous.ownerId = ownerId
			this.indexOwner(previous)
			return true
		}
		// Only a recording id is held (the id of a listed file already is one).
		const folderId =
			v === undefined ? splitRecordingId(id)?.folderId : undefined
		if (v === undefined && folderId === undefined) return false
		if (this.count >= HELD_RECORDINGS_MAX) {
			if (this.refusals === "quiet") return false
			const marked = folderId ?? splitRecordingId(id)?.folderId
			if (marked === undefined) return false
			this.refused++
			if (this.refusals === "safety") this.markSafety(marked)
			else this.markOverflow(marked)
			return false
		}
		this.touch(id, observationId, false)
		const listing: Listing = { id, observationId, ownerId }
		if (v === undefined) {
			this.byId.set(id, listing)
			if (folderId !== undefined) {
				let f = this.byFolder.get(folderId)
				if (f === undefined) this.byFolder.set(folderId, (f = new Set()))
				f.add(id)
			}
		} else if (v instanceof Map) v.set(observationId, listing)
		else
			this.byId.set(
				id,
				new Map([
					[v.observationId, v],
					[observationId, listing],
				]),
			)
		this.count++
		this.indexOwner(listing)
		return true
	}

	/** Drops one listing (the file's other listings stay). */
	release(id: string, observationId: string): void {
		const v = this.byId.get(id)
		const previous = this.listing(id, observationId)
		if (v === undefined || previous === undefined) return
		this.touch(id, observationId, true)
		this.unindexOwner(previous)
		this.count--
		if (!(v instanceof Map)) {
			this.forgetId(id)
			return
		}
		v.delete(observationId)
		const [only, more] = v.values()
		if (only !== undefined && more === undefined) this.byId.set(id, only)
	}

	/** Drops every listing of `id` (the file was deleted, or is gone from disk). */
	drop(id: string): void {
		for (const l of this.listingsIn(id)) this.release(id, l.observationId)
	}

	/**
	 * A merge: every listing `from` holds is now held by `to` (the file's others stay). A file in
	 * `to`'s own folder that only `to` lists now follows `to` anyway: its listings go, unless one
	 * of them is no `collapsible` listing (the caller's: a listing that left the observation
	 * window is the only record that `to` lists the file, so the file keeps every listing).
	 */
	moveOwner(
		from: string,
		to: string,
		collapsible: (observationId: string) => boolean = () => true,
	): void {
		if (from === to) return
		const ids = new Set<string>()
		for (const l of [...(this.byOwner.get(from) ?? [])]) {
			// A re-point: never refused at the bound.
			this.hold(l.id, to, l.observationId)
			ids.add(l.id)
		}
		for (const id of ids)
			if (
				splitRecordingId(id)?.folderId === to &&
				this.holders(id).every(h => h === to) &&
				this.listingsIn(id).every(l => collapsible(l.observationId))
			)
				this.drop(id)
	}

	/** A deleted holder: only its own listings go, never a listing another discovery holds. */
	dropOwner(ownerId: string): void {
		for (const l of [...(this.byOwner.get(ownerId) ?? [])])
			this.release(l.id, l.observationId)
	}

	/**
	 * Journal changes since the last call, in chunks of at most HELD_RECORDING_CHANGES_MAX: the
	 * re-pointed listings, then the dropped ones, then the added ones (each sorted by recording
	 * id, then observation id), so a replay in that order never holds more than
	 * HELD_RECORDINGS_MAX. A listing added and dropped since the last call is no change. Empty
	 * when nothing changed.
	 */
	takeChangeChunks(): HeldRecordingChange[][] {
		if (this.touchedCount === 0) return []
		const repointed: HeldRecordingChange[] = []
		const dropped: HeldRecordingChange[] = []
		const added: HeldRecordingChange[] = []
		for (const id of [...this.touched.keys()].sort(compareId)) {
			const changes = this.touched.get(id)
			if (changes === undefined) continue
			for (const t of [...changes.values()].sort((a, b) =>
				compareId(a.observationId, b.observationId),
			)) {
				const ownerId = this.listing(id, t.observationId)?.ownerId ?? null
				const change = { id, ownerId, observationId: t.observationId }
				if (t.wasHeld && ownerId !== null) repointed.push(change)
				else if (t.wasHeld) dropped.push(change)
				else if (ownerId !== null) added.push(change)
			}
		}
		this.touched.clear()
		this.touchedCount = 0
		const ordered = [...repointed, ...dropped, ...added]
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
		this.touchedCount = 0
		this.overflowDirty = false
	}

	takeRefused(): number {
		const n = this.refused
		this.refused = 0
		return n
	}

	/**
	 * Replay: the journaled changes as written, drops first (an entry written by an older core
	 * may interleave them). `format`: the entry's marker. This writer's changes name one listing
	 * each. An earlier format's re-pointed or dropped the file's single entry: a hold adds its
	 * listing and a drop removes nothing (fail closed, see above). A hold refused at the bound
	 * gives its folder a replay safety mark (fail closed; no later replacement of the marks
	 * clears it).
	 */
	apply(
		changes: readonly HeldRecordingChange[],
		format: number | undefined = HELD_JOURNAL_FORMAT,
	): void {
		const mode = this.refusals
		this.refusals = "safety"
		this.tracking = false
		const pairs = format === HELD_JOURNAL_FORMAT
		if (pairs)
			for (const c of changes)
				if (c.ownerId === null && c.observationId !== undefined)
					this.release(c.id, c.observationId)
		for (const c of changes)
			if (c.ownerId !== null && c.observationId !== undefined)
				this.hold(c.id, c.ownerId, c.observationId)
		this.tracking = true
		this.touched.clear()
		this.touchedCount = 0
		this.refusals = mode
	}

	/**
	 * Replay of one entry: `run` with re-derived refusals quiet when the entry is trusted to
	 * journal the outcome of every refusal (`journaled`: it carries this writer's format marker,
	 * HELD_JOURNAL_FORMAT); any other entry gives a refused folder a replay safety mark.
	 */
	replayJournaled<T>(journaled: boolean, run: () => T): T {
		const mode = this.refusals
		this.refusals = journaled ? "quiet" : "safety"
		try {
			return run()
		} finally {
			this.refusals = mode
		}
	}

	/** Every listing, sorted by recording id then observation id. */
	entries(): HeldRecordingEntry[] {
		const out: HeldRecordingEntry[] = []
		for (const id of [...this.byId.keys()].sort(compareId))
			out.push(
				...this.listingsOf(id).sort((a, b) =>
					compareId(a.observationId, b.observationId),
				),
			)
		return out
	}

	/** Restore: the persisted listings (an earlier format's single entries load as listings). */
	restore(entries: readonly HeldRecordingEntry[]): void {
		this.clear()
		const mode = this.refusals
		this.refusals = "safety"
		this.tracking = false
		for (const e of entries) this.hold(e.id, e.ownerId, e.observationId)
		this.tracking = true
		this.refusals = mode
		this.touched.clear()
		this.touchedCount = 0
	}

	clear(): void {
		this.byId.clear()
		this.count = 0
		this.byFolder.clear()
		this.byOwner.clear()
		this.touched.clear()
		this.touchedCount = 0
		this.refused = 0
		this.overflow.clear()
		this.overflowAll = false
		this.overflowDirty = false
		this.safety.clear()
		this.safetyAll = false
		this.guards.clear()
	}

	private indexOwner(l: Listing): void {
		let o = this.byOwner.get(l.ownerId)
		if (o === undefined) this.byOwner.set(l.ownerId, (o = new Set()))
		o.add(l)
	}

	private unindexOwner(l: Listing): void {
		const o = this.byOwner.get(l.ownerId)
		o?.delete(l)
		if (o?.size === 0) this.byOwner.delete(l.ownerId)
	}

	private forgetId(id: string): void {
		this.byId.delete(id)
		const folderId = splitRecordingId(id)?.folderId
		if (folderId === undefined) return
		const f = this.byFolder.get(folderId)
		f?.delete(id)
		if (f?.size === 0) this.byFolder.delete(folderId)
	}
}
