/**
 * Per-id write order for a client-side cache filled by overlapping reads, mutations and live
 * events (band inspection UX req 3.3).
 *
 * Every write carries a `version` and a `seenAt`:
 *
 * - with a current core, `version` is the record's server revision (one store-wide counter that
 *   strictly increases on every change to a record) and `seenAt` the store revision when the
 *   answer or event was taken (a page's or answer's `storeRevision`, an event's `revision`);
 * - with an older core (no revisions), both are a client sequence: a read's is taken when its
 *   request starts, a live event's or a successful mutation's when it arrives.
 *
 * Rules, per id:
 *
 * - an upsert applies only when its version is newer than the cached one;
 * - a complete page for a query (`cover`) speaks, at its `seenAt`, for every record the query
 *   matches: an upsert at or below that version of a record it matches but did not list is stale;
 * - a page that no longer lists a cached record removes it (`removeSoft`) unless the cached
 *   version is newer than the page; that is not a deletion (the record may only have moved), so a
 *   later upsert at or above the removed version may bring it back;
 * - a deletion (`removeHard`: a DELETE, a `deleted` event, an id a merge absorbed) is final: ids
 *   are never reused, so nothing brings that id back.
 *
 * Bounds. At most `tombstones` removed ids and `coverages` complete pages are remembered. When one
 * is evicted (the oldest remembered first), `floor` rises to its `seenAt`, and every write taken
 * at or before the floor is refused: a write seen that early cannot be told from a stale one any
 * more. Refusing is the safe side (a record may be missing until the next read, never stale).
 * With the defaults (2 048 removed ids of one id string and three numbers each, about 120 B per
 * Map entry, so about 250 KB; 32 coverages, each holding up to 500 listed ids), an upsert checks
 * at most 32 coverage predicates, so a 500-record page costs at most 16 000 checks.
 */

export const WRITE_ORDER_TOMBSTONES_MAX = 2048
export const WRITE_ORDER_COVERAGES_MAX = 32

export interface WriteOrderLimits {
	tombstones?: number
	coverages?: number
}

interface Removed {
	/** The cached version at removal (soft), or Infinity (hard: final). */
	version: number
	seenAt: number
	hard: boolean
}

interface Coverage<T> {
	at: number
	covers: (record: T) => boolean
	ids: ReadonlySet<string>
}

export class WriteOrder<T> {
	/** Raised to the `seenAt` of each evicted tombstone or coverage; applies to every id. */
	private floor = 0
	private readonly present = new Map<string, number>()
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

	/** Applies an upsert of `id` at `version` (taken at `seenAt`) and returns true, or refuses it. */
	upsert(id: string, record: T, version: number, seenAt = version): boolean {
		if (seenAt <= this.floor) return false
		const gone = this.removed.get(id)
		if (gone !== undefined && (gone.hard || version < gone.version))
			return false
		const have = this.present.get(id)
		if (have !== undefined && version <= have) return false
		for (const c of this.covered)
			if (version <= c.at && !c.ids.has(id) && c.covers(record)) return false
		this.removed.delete(id)
		this.present.set(id, version)
		return true
	}

	/**
	 * A complete page taken at `at` no longer lists cached `id`: removes it (true) unless the cached
	 * version is newer than the page, or it is not cached.
	 */
	removeSoft(id: string, at: number): boolean {
		const have = this.present.get(id)
		if (have === undefined || have > at) return false
		this.present.delete(id)
		this.remember(id, { version: have, seenAt: at, hard: false })
		return true
	}

	/** `id` was deleted (taken at `seenAt`): final, whatever was cached. */
	removeHard(id: string, seenAt: number): void {
		this.present.delete(id)
		this.remember(id, { version: Infinity, seenAt, hard: true })
	}

	/** A complete page taken at `at` for a query: `covers` matches its records, `ids` lists them. */
	cover(covers: (record: T) => boolean, at: number, ids: ReadonlySet<string>) {
		this.covered.push({ at, covers, ids })
		if (this.covered.length > this.coveragesMax) {
			const oldest = this.covered.shift()
			if (oldest !== undefined) this.raiseFloor(oldest.at)
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
		this.raiseFloor(oldest[1].seenAt)
	}

	private raiseFloor(at: number): void {
		if (Number.isFinite(at)) this.floor = Math.max(this.floor, at)
	}
}
