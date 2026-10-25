/**
 * Per-id write order for a client-side cache filled by overlapping reads, mutations and live
 * events (band inspection UX req 3.3).
 *
 * Every write carries three keys, compared in this order:
 *
 * - `rev`, the record's version: with a current core its server revision (one store-wide counter
 *   that strictly increases on every change to a record);
 * - `read`, when the answer was served: with a current core the answer's `storeRevision` (an
 *   event's own `revision`);
 * - `seq`, a client sequence: taken when a read's request starts, when an event or a mutation's
 *   answer arrives. It breaks ties between two reads of the same revision at the same store
 *   revision (what the core adds when a record is read, coverage and hints, may still differ):
 *   the later-started read is the fresher view.
 *
 * With an older core (no revisions) all three are the same client sequence.
 *
 * Rules, per id:
 *
 * - an upsert applies when its keys are at least the held ones (the same write repeated is
 *   harmless);
 * - a complete page for a query (`cover`, read at R) makes inadmissible any upsert read before R
 *   of a record the query matches but the page did not list;
 * - a page that no longer lists a cached record removes it (`removeSoft`) unless the cached
 *   revision is newer than the page; that is not a deletion (the record may only have moved), so
 *   a later upsert at or above the removed keys may bring it back;
 * - a deletion (`removeHard`: a DELETE, a `deleted` event, an id a merge absorbed) is final: ids
 *   are never reused, so nothing brings that id back.
 *
 * Bounds. At most `tombstones` removed ids and `coverages` complete pages are remembered. When one
 * is evicted (the oldest remembered first), `floor` rises to its read, and any upsert read before
 * the floor is refused with "floor": one served that early can no longer be told from a stale
 * one, so the caller reads again (a fresh read is never below the floor). A deletion seen without
 * a store revision (an older core) is remembered at read +Infinity; when it is evicted the floor
 * rises to the highest read seen so far, which a fresh read always reaches.
 * With the defaults (2 048 removed ids of one id string and four fields each, about 130 B per Map
 * entry, so about 270 KB; 32 coverages, each holding up to 500 listed ids), an upsert checks at
 * most 32 coverage predicates, so a 500-record page costs at most 16 000 checks.
 */

export const WRITE_ORDER_TOMBSTONES_MAX = 2048
export const WRITE_ORDER_COVERAGES_MAX = 32

export interface WriteOrderLimits {
	tombstones?: number
	coverages?: number
}

/** The order of one write: record revision, read revision, client sequence. */
export interface WriteKeys {
	rev: number
	read: number
	seq: number
}

/** What became of an upsert: applied, refused by the id's own order, or refused by the floor. */
export type UpsertOutcome = "applied" | "order" | "floor"

interface Removed extends WriteKeys {
	/** Final: no upsert brings the id back. */
	hard: boolean
}

interface Coverage<T> {
	read: number
	covers: (record: T) => boolean
	ids: ReadonlySet<string>
}

/** `k` orders before `held`. */
export function keysBefore(k: WriteKeys, held: WriteKeys): boolean {
	if (k.rev !== held.rev) return k.rev < held.rev
	if (k.read !== held.read) return k.read < held.read
	return k.seq < held.seq
}

export class WriteOrder<T> {
	/** Raised to the read of each evicted tombstone or coverage; applies to every id. */
	private floor = 0
	/** The highest finite read any write carried. */
	private highWater = 0
	private readonly present = new Map<string, WriteKeys>()
	/** Removed ids, oldest remembered first. */
	private readonly removed = new Map<string, Removed>()
	private readonly covered: Coverage<T>[] = []
	private readonly tombstonesMax: number
	private readonly coveragesMax: number

	constructor(limits: WriteOrderLimits = {}) {
		this.tombstonesMax = Math.max(
			1,
			limits.tombstones ?? WRITE_ORDER_TOMBSTONES_MAX,
		)
		this.coveragesMax = Math.max(
			1,
			limits.coverages ?? WRITE_ORDER_COVERAGES_MAX,
		)
	}

	/** Applies an upsert of `id` at `keys`, or says why it was refused. */
	upsert(id: string, record: T, keys: WriteKeys): UpsertOutcome {
		this.saw(keys.read)
		const gone = this.removed.get(id)
		if (gone !== undefined && (gone.hard || keysBefore(keys, gone)))
			return "order"
		const have = this.present.get(id)
		if (have !== undefined && keysBefore(keys, have)) return "order"
		for (const c of this.covered)
			if (keys.read < c.read && !c.ids.has(id) && c.covers(record))
				return "order"
		if (keys.read < this.floor) return "floor"
		this.removed.delete(id)
		this.present.set(id, { ...keys })
		return "applied"
	}

	/**
	 * A complete page (at `keys`) no longer lists cached `id`: removes it (true) unless the cached
	 * revision is newer than the page's read, or it is not cached.
	 */
	removeSoft(id: string, keys: WriteKeys): boolean {
		this.saw(keys.read)
		const have = this.present.get(id)
		if (have === undefined || have.rev > keys.read) return false
		this.present.delete(id)
		this.remember(id, {
			rev: have.rev,
			read: keys.read,
			seq: keys.seq,
			hard: false,
		})
		return true
	}

	/** `id` was deleted, seen at store revision `read` (Infinity when unknown): final. */
	removeHard(id: string, read: number): void {
		this.saw(read)
		this.present.delete(id)
		this.remember(id, { rev: Infinity, read, seq: Infinity, hard: true })
	}

	/** A complete page read at `read` for a query: `covers` matches its records, `ids` lists them. */
	cover(
		covers: (record: T) => boolean,
		read: number,
		ids: ReadonlySet<string>,
	) {
		this.saw(read)
		this.covered.push({ read, covers, ids })
		if (this.covered.length > this.coveragesMax) {
			const oldest = this.covered.shift()
			if (oldest !== undefined) this.raiseFloor(oldest.read)
		}
	}

	/** How many removed ids are remembered (for tests and bounds). */
	get tombstoneCount(): number {
		return this.removed.size
	}

	private remember(id: string, entry: Removed): void {
		this.removed.delete(id)
		this.removed.set(id, entry)
		if (this.removed.size <= this.tombstonesMax) return
		const oldest = this.removed.entries().next().value
		if (oldest === undefined) return
		this.removed.delete(oldest[0])
		// a deletion without the core's revision: anything read so far may predate it
		this.raiseFloor(
			Number.isFinite(oldest[1].read) ? oldest[1].read : this.highWater,
		)
	}

	private raiseFloor(read: number): void {
		this.floor = Math.max(this.floor, read)
	}

	private saw(read: number): void {
		if (Number.isFinite(read)) this.highWater = Math.max(this.highWater, read)
	}
}
