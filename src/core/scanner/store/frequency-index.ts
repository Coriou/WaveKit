/**
 * WG11 req 3.1 (lane SC): per-source, per-family discovery index sorted by the cached median
 * centre (ties by id), so sticky association binary-searches its tolerance window instead of
 * scanning every discovery of the source.
 */
import { nearest } from "./consolidation.js"

export interface IndexedCentre {
	readonly centreHz: number
	readonly id: string
}

const before = (a: IndexedCentre, centreHz: number, id: string): boolean =>
	a.centreHz < centreHz || (a.centreHz === centreHz && a.id < id)

export class CentreIndex {
	private readonly lists = new Map<string, IndexedCentre[]>()
	/**
	 * Non-finite centres refused by `add` (review m6), skipped without a warning. A NaN sorts
	 * nowhere and would break the binary search for its finite neighbours. ±Infinity never passed
	 * the linear distance test; a NaN did (`NaN > tol` is false, so it matched any probe of its
	 * family), which was a defect, not behaviour to keep. Among finite centres results are
	 * unchanged.
	 */
	private refused = 0

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
		if (!Number.isFinite(centreHz)) {
			this.refused += 1
			return
		}
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
		if (!Number.isFinite(centreHz)) return // never added
		const key = CentreIndex.key(sourceId, family)
		const list = this.lists.get(key)
		if (list === undefined) return
		const i = CentreIndex.lowerBound(list, centreHz, id)
		const e = list[i]
		if (e !== undefined && e.id === id && e.centreHz === centreHz)
			list.splice(i, 1)
		else {
			// defensive: linear removal keeps the index exact
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

	/**
	 * DQ 7.7: the `k` entries of one list nearest to `centreHz` within `radiusHz`, nearest first
	 * (ties: smaller id). O(log n + k), independent of how many entries share the window.
	 */
	nearest(
		sourceId: string,
		family: string,
		centreHz: number,
		radiusHz: number,
		k: number,
	): IndexedCentre[] {
		const list = this.lists.get(CentreIndex.key(sourceId, family))
		if (list === undefined) return []
		return nearest(list, centreHz, radiusHz, k)
	}

	/** Non-finite centres refused since construction (tests). */
	refusedNonFinite(): number {
		return this.refused
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

/**
 * Discoveries sorted by `frequencyHz` (ties by id). One global list answers a
 * cross-source window in one binary search; each source has its own list.
 * This is not the median-centre index: a measured offset can separate
 * `frequencyHz` from the sticky centre, and near matches `frequencyHz`.
 */
export interface IndexedFrequency {
	readonly frequencyHz: number
	readonly id: string
}

const frequencyBefore = (
	a: IndexedFrequency,
	frequencyHz: number,
	id: string,
): boolean =>
	a.frequencyHz < frequencyHz || (a.frequencyHz === frequencyHz && a.id < id)

export class FrequencyIndex {
	private readonly all: IndexedFrequency[] = []
	private readonly bySource = new Map<string, IndexedFrequency[]>()
	/** Non-finite frequencies refused by `add`. A NaN sorts nowhere. */
	private refused = 0

	/** First position whose entry is not before (frequencyHz, id). */
	private static lowerBound(
		list: readonly IndexedFrequency[],
		frequencyHz: number,
		id: string,
	): number {
		let lo = 0
		let hi = list.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			const e = list[mid]
			if (e !== undefined && frequencyBefore(e, frequencyHz, id)) lo = mid + 1
			else hi = mid
		}
		return lo
	}

	private static insert(
		list: IndexedFrequency[],
		frequencyHz: number,
		id: string,
	): void {
		const i = FrequencyIndex.lowerBound(list, frequencyHz, id)
		const e = list[i]
		if (e !== undefined && e.frequencyHz === frequencyHz && e.id === id) return
		list.splice(i, 0, { frequencyHz, id })
	}

	private static extract(
		list: IndexedFrequency[],
		frequencyHz: number,
		id: string,
	): void {
		const i = FrequencyIndex.lowerBound(list, frequencyHz, id)
		const e = list[i]
		if (e !== undefined && e.id === id && e.frequencyHz === frequencyHz)
			list.splice(i, 1)
		else {
			const j = list.findIndex(x => x.id === id)
			if (j >= 0) list.splice(j, 1)
		}
	}

	add(sourceIds: readonly string[], frequencyHz: number, id: string): void {
		if (!Number.isFinite(frequencyHz)) {
			this.refused += 1
			return
		}
		FrequencyIndex.insert(this.all, frequencyHz, id)
		for (const sourceId of sourceIds) {
			let list = this.bySource.get(sourceId)
			if (list === undefined) {
				list = []
				this.bySource.set(sourceId, list)
			}
			FrequencyIndex.insert(list, frequencyHz, id)
		}
	}

	remove(sourceIds: readonly string[], frequencyHz: number, id: string): void {
		if (!Number.isFinite(frequencyHz)) return
		FrequencyIndex.extract(this.all, frequencyHz, id)
		for (const sourceId of sourceIds) {
			const list = this.bySource.get(sourceId)
			if (list === undefined) continue
			FrequencyIndex.extract(list, frequencyHz, id)
			if (list.length === 0) this.bySource.delete(sourceId)
		}
	}

	/**
	 * Entries with lowHz ≤ frequencyHz ≤ highHz, in (frequency, id) order.
	 * `sourceId` omitted searches every source. Callers pass finite bounds.
	 */
	range(lowHz: number, highHz: number, sourceId?: string): IndexedFrequency[] {
		if (!Number.isFinite(lowHz) || !Number.isFinite(highHz) || highHz < lowHz)
			return []
		const list = sourceId === undefined ? this.all : this.bySource.get(sourceId)
		if (list === undefined) return []
		const out: IndexedFrequency[] = []
		for (
			let i = FrequencyIndex.lowerBound(list, lowHz, "");
			i < list.length;
			i++
		) {
			const e = list[i]
			if (e === undefined || e.frequencyHz > highHz) break
			out.push(e)
		}
		return out
	}

	/** Non-finite frequencies refused since construction. */
	refusedNonFinite(): number {
		return this.refused
	}

	/** Discoveries in the global list. */
	size(): number {
		return this.all.length
	}

	clear(): void {
		this.all.length = 0
		this.bySource.clear()
	}
}
