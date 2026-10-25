/**
 * Per-id write order for a client-side cache filled by overlapping reads, mutations and live
 * events (band inspection UX req 3.3).
 *
 * Every write carries two keys, compared as a pair (record first):
 *
 * - `rev`, the record's version: with a current core its server revision (one store-wide counter
 *   that strictly increases on every change to a record);
 * - `read`, when the answer was served: with a current core the answer's `storeRevision` (an
 *   event's own `revision`).
 *
 * With an older core (no revisions) both are one client sequence: a read's is taken when its
 * request starts, a live event's or a successful mutation's when it arrives.
 *
 * Rules, per id:
 *
 * - an upsert applies when (rev, read) is at least the held pair. An equal pair is accepted, so
 *   a later read of the same revision refreshes what the core adds at read time (coverage);
 * - a complete page for a query (`cover`, read at R) makes inadmissible any upsert read before R
 *   of a record the query matches but the page did not list;
 * - a page that no longer lists a cached record removes it (`removeSoft`) unless the cached
 *   revision is newer than the page; that is not a deletion (the record may only have moved), so
 *   a later upsert at or above the removed pair may bring it back;
 * - a deletion (`removeHard`: a DELETE, a `deleted` event, an id a merge absorbed) is final: ids
 *   are never reused, so nothing brings that id back.
 *
 * Bounds. At most `tombstones` removed ids and `coverages` complete pages are remembered. When one
 * is evicted (the oldest remembered first), `floor` rises to its read, and any upsert read before
 * the floor is refused: one served that early can no longer be told from a stale one. A fresh
 * read is never below the floor, so refusing only delays a record until the next read and never
 * shows a stale one. With the defaults (2 048 removed ids of one id string and three fields each,
 * about 120 B per Map entry, so about 250 KB; 32 coverages, each holding up to 500 listed ids), an
 * upsert checks at most 32 coverage predicates, so a 500-record page costs at most 16 000 checks.
 */

export const WRITE_ORDER_TOMBSTONES_MAX = 2048
export const WRITE_ORDER_COVERAGES_MAX = 32

export interface WriteOrderLimits {
	tombstones?: number
	coverages?: number
}

interface Pair {
	rev: number
	read: number
}

interface Removed extends Pair {
	/** Final: no upsert brings the id back. */
	hard: boolean
}

interface Coverage<T> {
	read: number
	covers: (record: T) => boolean
	ids: ReadonlySet<string>
}

/** (rev, read) is lower than `held`. */
function below(rev: number, read: number, held: Pair): boolean {
	return rev < held.rev || (rev === held.rev && read < held.read)
}

export class WriteOrder<T> {
	/** Raised to the read of each evicted tombstone or coverage; applies to every id. */
	private floor = 0
	private readonly present = new Map<string, Pair>()
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

	/** Applies an upsert of `id` at (rev, read) and returns true, or refuses it. */
	upsert(id: string, record: T, rev: number, read = rev): boolean {
		if (read < this.floor) return false
		const gone = this.removed.get(id)
		if (gone !== undefined && (gone.hard || below(rev, read, gone)))
			return false
		const have = this.present.get(id)
		if (have !== undefined && below(rev, read, have)) return false
		for (const c of this.covered)
			if (read < c.read && !c.ids.has(id) && c.covers(record)) return false
		this.removed.delete(id)
		this.present.set(id, { rev, read })
		return true
	}

	/**
	 * A complete page read at `read` no longer lists cached `id`: removes it (true) unless the
	 * cached revision is newer than the page, or it is not cached.
	 */
	removeSoft(id: string, read: number): boolean {
		const have = this.present.get(id)
		if (have === undefined || have.rev > read) return false
		this.present.delete(id)
		this.remember(id, { rev: have.rev, read, hard: false })
		return true
	}

	/** `id` was deleted (seen at `read`): final, whatever was cached. */
	removeHard(id: string, read: number): void {
		this.present.delete(id)
		this.remember(id, { rev: Infinity, read, hard: true })
	}

	/** A complete page read at `read` for a query: `covers` matches its records, `ids` lists them. */
	cover(
		covers: (record: T) => boolean,
		read: number,
		ids: ReadonlySet<string>,
	) {
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
		this.raiseFloor(oldest[1].read)
	}

	private raiseFloor(read: number): void {
		if (Number.isFinite(read)) this.floor = Math.max(this.floor, read)
	}
}
