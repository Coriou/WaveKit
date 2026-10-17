/**
 * WG11 req 3.1 (lane SC): per-source, per-family discovery index sorted by the cached median
 * centre (ties by id), so sticky association binary-searches its tolerance window instead of
 * scanning every discovery of the source.
 */
export interface IndexedCentre {
	readonly centreHz: number
	readonly id: string
}

const before = (a: IndexedCentre, centreHz: number, id: string): boolean =>
	a.centreHz < centreHz || (a.centreHz === centreHz && a.id < id)

export class CentreIndex {
	private readonly lists = new Map<string, IndexedCentre[]>()

	private static key(sourceId: string, family: string): string {
		return `${sourceId}\u0000${family}`
	}

	/** First position whose entry is not before (centreHz, id). */
	private static lowerBound(
		list: readonly IndexedCentre[],
		centreHz: number,
		id: string,
	): number {
		let lo = 0
		let hi = list.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const e = list[mid]
			if (e !== undefined && before(e, centreHz, id)) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	add(sourceId: string, family: string, centreHz: number, id: string): void {
		const key = CentreIndex.key(sourceId, family)
		let list = this.lists.get(key)
		if (list === undefined) {
			list = []
			this.lists.set(key, list)
		}
		list.splice(CentreIndex.lowerBound(list, centreHz, id), 0, {
			centreHz,
			id,
		})
	}

	remove(sourceId: string, family: string, centreHz: number, id: string): void {
		const key = CentreIndex.key(sourceId, family)
		const list = this.lists.get(key)
		if (list === undefined) return
		const i = CentreIndex.lowerBound(list, centreHz, id)
		const e = list[i]
		if (e !== undefined && e.id === id && Object.is(e.centreHz, centreHz))
			list.splice(i, 1)
		else {
			// defensive (a NaN centre sorts nowhere): linear removal keeps the index exact
			const j = list.findIndex(x => x.id === id)
			if (j >= 0) list.splice(j, 1)
		}
		if (list.length === 0) this.lists.delete(key)
	}

	/** Visits the entries with lowHz ≤ centre ≤ highHz in (centre, id) order. */
	range(
		sourceId: string,
		family: string,
		lowHz: number,
		highHz: number,
		visit: (e: IndexedCentre) => void,
	): void {
		const list = this.lists.get(CentreIndex.key(sourceId, family))
		if (list === undefined) return
		for (
			let i = CentreIndex.lowerBound(list, lowHz, "");
			i < list.length;
			i++
		) {
			const e = list[i]
			if (e === undefined || e.centreHz > highHz) break
			visit(e)
		}
	}

	/** Entries per (source, family), for tests and the bound check. */
	size(): number {
		let n = 0
		for (const list of this.lists.values()) n += list.length
		return n
	}

	clear(): void {
		this.lists.clear()
	}
}
