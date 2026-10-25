/**
 * Per-id write order for a client-side cache filled by overlapping requests and live events.
 *
 * Every write carries a sequence. A live event, and the answer to a successful mutation (it shows the
 * server after the change), takes `next()` when it arrives. A read's answer takes the `next()` its
 * request took when it started, since the server may have served it at any time after that. A write
 * to an id applies only when its sequence is strictly newer than everything already applied to that
 * id, so the newest-started read, or anything that arrived after it started, wins whatever order
 * the answers arrive in; a failed request writes nothing:
 *
 * - an upsert or removal leaves the id's sequence behind (a removal as a tombstone);
 * - a complete answer for a query (`cover`) speaks for every record that query matches, including
 *   ones the cache has never seen: an older answer cannot add them back.
 *
 * Bounds. At most `tombstones` removed ids and `coverages` complete answers are remembered. When
 * one is evicted (the oldest remembered first), `floor` rises to its sequence and applies to every
 * id: a write started at or before the floor is refused. Refusing is the safe side (a record may
 * be missing until the next refresh, never stale). With the defaults (2 048 tombstones of one id
 * string and one number each, about 100 B per Map entry, so about 200 KB; 32 coverages), an upsert
 * checks at most 32 coverage predicates, so a 500-record page costs at most 16 000 checks.
 */

export const WRITE_ORDER_TOMBSTONES_MAX = 2048
export const WRITE_ORDER_COVERAGES_MAX = 32

export interface WriteOrderLimits {
	tombstones?: number
	coverages?: number
}

export class WriteOrder<T> {
	private seq = 0
	/** Raised to the sequence of each evicted tombstone or coverage; applies to every id. */
	private floor = 0
	private readonly present = new Map<string, number>()
	/** Removed ids, oldest remembered first. */
	private readonly gone = new Map<string, number>()
	private readonly covered: { at: number; covers: (record: T) => boolean }[] =
		[]
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

	/** The sequence of a live write now, or of a request starting now. */
	next(): number {
		return ++this.seq
	}

	/** The newest sequence that speaks for `id` (and, for an upsert, for `record`). */
	last(id: string, record?: T): number {
		let at = Math.max(
			this.floor,
			this.present.get(id) ?? 0,
			this.gone.get(id) ?? 0,
		)
		if (record !== undefined)
			for (const c of this.covered) if (c.at > at && c.covers(record)) at = c.at
		return at
	}

	/** Records an upsert of `id` at `at` and returns true, or refuses it (false) when not newer. */
	upsert(id: string, record: T, at: number): boolean {
		if (at <= this.last(id, record)) return false
		this.gone.delete(id)
		this.present.set(id, at)
		return true
	}

	/** Records a removal of `id` at `at` (a tombstone) and returns true, or refuses it when not newer. */
	remove(id: string, at: number): boolean {
		if (at <= this.last(id)) return false
		this.present.delete(id)
		this.gone.delete(id)
		this.gone.set(id, at)
		if (this.gone.size > this.tombstonesMax) {
			const oldest = this.gone.entries().next().value
			if (oldest !== undefined) {
				this.gone.delete(oldest[0])
				this.floor = Math.max(this.floor, oldest[1])
			}
		}
		return true
	}

	/** A complete answer at `at`: every record `covers` matches is spoken for at `at`. */
	cover(covers: (record: T) => boolean, at: number): void {
		this.covered.push({ at, covers })
		if (this.covered.length > this.coveragesMax) {
			const oldest = this.covered.shift()
			if (oldest !== undefined) this.floor = Math.max(this.floor, oldest.at)
		}
	}

	/** How many tombstones are remembered (for tests and bounds). */
	get tombstoneCount(): number {
		return this.gone.size
	}
}
