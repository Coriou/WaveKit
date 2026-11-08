/**
 * The discovery ids that own an evidence or recording folder on disk (`evidence/<id>`,
 * `recordings/dv/<id>`, `recordings/analog/<id>`), in memory. Built from one directory listing at
 * load and on every retention pass; marked before any write that may create a folder, so the
 * answer over-approximates the disk (a marked id whose write failed holds nothing until the next
 * listing). A write's mark lasts its whole pending lifetime: `mark` returns its end, and every
 * listing that finishes while the write is pending, or that ran while it was, keeps the id (the
 * listing may have read the directory before the write created the folder). Merge aliases read
 * it on the hot path: a Set lookup, never a stat.
 *
 * Fail closed: until the first listing finished, every id answers "holds a folder".
 */
export class FolderIndex {
	private ids = new Set<string>()
	private built = false
	/** Per running listing, the ids marked since it began (listings may overlap). */
	private readonly listings = new Set<Set<string>>()
	/** Ids with a write still pending, and how many. */
	private readonly pending = new Map<string, number>()

	get ready(): boolean {
		return this.built
	}

	/** Distinct folder ids known (0 before the first listing). */
	get size(): number {
		return this.ids.size
	}

	holds(id: string): boolean {
		return !this.built || this.ids.has(id)
	}

	/**
	 * A write that may create `id`'s folder is about to run; call the returned function once it
	 * settled (idempotent). Until then every finished listing keeps `id`.
	 */
	mark(id: string): () => void {
		this.ids.add(id)
		for (const marked of this.listings) marked.add(id)
		this.pending.set(id, (this.pending.get(id) ?? 0) + 1)
		let ended = false
		return () => {
			if (ended) return
			ended = true
			const n = (this.pending.get(id) ?? 1) - 1
			if (n > 0) this.pending.set(id, n)
			else this.pending.delete(id)
			// A listing running now may have read the directory before this write created it.
			for (const marked of this.listings) marked.add(id)
		}
	}

	/** Ids with a write pending (tests and diagnostics). */
	get pendingWrites(): number {
		return this.pending.size
	}

	/** Starts a listing; pass the token to `finishListing` or `abandonListing`. */
	beginListing(): ListingToken {
		const marked = new Set<string>()
		this.listings.add(marked)
		return { marked }
	}

	/**
	 * The listing's ids replace the index, plus every id marked or settled since it began and
	 * every id whose write is still pending.
	 */
	finishListing(token: ListingToken, listed: Iterable<string>): void {
		this.listings.delete(token.marked)
		const next = new Set(listed)
		for (const id of token.marked) next.add(id)
		for (const id of this.pending.keys()) next.add(id)
		this.ids = next
		this.built = true
	}

	/** A failed listing leaves the index as it was (still fail closed when never built). */
	abandonListing(token: ListingToken): void {
		this.listings.delete(token.marked)
	}

	/** Every known folder id (a copy). */
	list(): string[] {
		return [...this.ids]
	}
}

export interface ListingToken {
	readonly marked: Set<string>
}
