/**
 * Band inspection UX req 3.1: absorbed discovery id -> current survivor id, so a read by an id a
 * merge absorbed still finds its record. Global, insertion ordered, at most `max` entries (the
 * oldest merge is evicted first). Chains are resolved at write time: when a survivor is itself
 * absorbed later, every entry pointing at it is re-pointed in place (an update, not a new entry).
 * In memory only; never journaled.
 */

export const ABSORBED_ID_INDEX_MAX = 16_384

export class AbsorbedIdIndex {
	private readonly survivorOf = new Map<string, string>()
	/** Reverse map: survivor -> absorbed ids currently pointing at it. */
	private readonly absorbedBy = new Map<string, Set<string>>()

	constructor(private readonly max: number = ABSORBED_ID_INDEX_MAX) {}

	get size(): number {
		return this.survivorOf.size
	}

	/** The survivor `id` was merged into, or undefined when not indexed (never merged or evicted). */
	resolve(id: string): string | undefined {
		return this.survivorOf.get(id)
	}

	/** `absorbed` merged into `survivor`. */
	record(absorbed: string, survivor: string): void {
		if (absorbed === survivor || absorbed.length === 0 || survivor.length === 0)
			return
		// Re-point everything that resolved to `absorbed` (chain resolution, in place).
		const inherited = this.absorbedBy.get(absorbed)
		if (inherited !== undefined) {
			this.absorbedBy.delete(absorbed)
			const target = this.reverse(survivor)
			for (const id of inherited) {
				if (id === survivor) {
					// The survivor was once absorbed into `absorbed`: it is live again, no self entry.
					this.survivorOf.delete(id)
					continue
				}
				this.survivorOf.set(id, survivor)
				target.add(id)
			}
			if (target.size === 0) this.absorbedBy.delete(survivor)
		}
		// A live survivor is never an absorbed id.
		this.unlink(survivor)
		const previous = this.survivorOf.get(absorbed)
		if (previous !== undefined) this.absorbedBy.get(previous)?.delete(absorbed)
		// A fresh merge of `absorbed` counts as its newest entry.
		this.survivorOf.delete(absorbed)
		this.survivorOf.set(absorbed, survivor)
		this.reverse(survivor).add(absorbed)
		while (this.survivorOf.size > this.max) {
			const oldest = this.survivorOf.keys().next()
			if (oldest.done === true) break
			this.unlink(oldest.value)
		}
	}

	private reverse(survivor: string): Set<string> {
		let set = this.absorbedBy.get(survivor)
		if (set === undefined) {
			set = new Set()
			this.absorbedBy.set(survivor, set)
		}
		return set
	}

	private unlink(id: string): void {
		const owner = this.survivorOf.get(id)
		if (owner === undefined) return
		this.survivorOf.delete(id)
		const set = this.absorbedBy.get(owner)
		if (set === undefined) return
		set.delete(id)
		if (set.size === 0) this.absorbedBy.delete(owner)
	}
}
