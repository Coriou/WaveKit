import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DiscoveryFilter } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	LIST_SLICE_MS,
	createListPace,
	firstSorted,
	type ListPace,
} from "../../../../src/core/scanner/store/list-page.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const BASE_HZ = 100_000_000
const SLOT_HZ = 100_000

/** Reorders 0..n-1 the same way every run (a multiplicative walk modulo a prime above n). */
function shuffled(n: number): number[] {
	const prime = 100_003
	const out: number[] = []
	for (let i = 1; out.length < n; i++) {
		const value = (i * 48_271) % prime
		if (value < n) out.push(value)
	}
	return out
}

function storeOf(
	n: number,
	hintScope?: () => undefined,
): { store: DiscoveryStore; ids: string[] } {
	const store = new DiscoveryStore({
		maxDiscoveries: n + 10,
		now: () => T0,
		newId: counterIds(),
		...(hintScope !== undefined ? { hintScope } : {}),
	})
	const ids: string[] = []
	// Last seen unrelated to creation order, as a sweep's re-hits leave a store.
	const order = shuffled(n)
	for (let i = 0; i < n; i++) {
		const id = store.ingest(
			makeObs({
				id: `o-${i}`,
				centreHz: BASE_HZ + i * SLOT_HZ,
				startedAt: T0 + order[i]! * 1_000,
				blocks: 2,
			}),
		).discoveryId
		if (id === null) throw new Error("record did not surface")
		ids.push(id)
	}
	return { store, ids }
}

/** Counts reads of `lastSeenAt` on every stored record: a default-order comparison reads two. */
function countLastSeenReads(store: DiscoveryStore): { reads: number } {
	const counter = { reads: 0 }
	const { discoveries } = store as unknown as {
		discoveries: Map<string, Discovery>
	}
	for (const d of discoveries.values()) {
		const value = d.lastSeenAt
		Object.defineProperty(d, "lastSeenAt", {
			enumerable: true,
			configurable: true,
			get() {
				counter.reads++
				return value
			},
		})
	}
	return counter
}

function noYield(): ListPace {
	return { due: () => false, wait: () => Promise.resolve() }
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("a discovery list read does bounded work", () => {
	it("reads the hint scope once per read, whatever the page size", () => {
		const hintScope = vi.fn(() => undefined)
		const { store } = storeOf(600, hintScope)
		hintScope.mockClear()
		expect(store.list({ limit: 500 }).items).toHaveLength(500)
		// Before: one read per weak row, 500 here.
		expect(hintScope).toHaveBeenCalledTimes(1)
	})

	it("deep-copies the page only, independent of the store size", () => {
		const copies = vi.fn(structuredClone)
		const count = (n: number): number => {
			const { store } = storeOf(n)
			vi.stubGlobal("structuredClone", copies)
			copies.mockClear()
			store.list({ limit: 100 })
			vi.unstubAllGlobals()
			return copies.mock.calls.length
		}
		expect(count(200)).toBe(100)
		expect(count(1_000)).toBe(100)
	})

	it("sorts the default order in far fewer comparisons than the whole store", () => {
		const n = 2_000
		const limit = 100
		const { store } = storeOf(n)
		const counter = countLastSeenReads(store)
		const { items } = store.list({ limit })
		expect(items).toHaveLength(limit)
		// The whole store: n × log2 n = 21,931 comparisons, two reads each on this order.
		const wholeSort = n * Math.log2(n)
		// The heap's worst case, reads of the presented rows included: at most
		// n × (1 + 2 × log2 100) = 28,575. This asserts what a shuffled store does: under half.
		expect(counter.reads / 2).toBeLessThan(wholeSort / 2)
	})

	it("reads each record's label once for sort=confidence", () => {
		const n = 300
		const { store } = storeOf(n)
		const internals = store as unknown as { publishedLabel: () => unknown }
		const labels = vi.spyOn(internals, "publishedLabel")
		store.list({ limit: 10, sort: "confidence" })
		// Before: two per comparison, at least 2 × (n − 1).
		expect(labels).toHaveBeenCalledTimes(n)
	})

	it("reads no observation list twice per row for checked content", () => {
		const { store, ids } = storeOf(2)
		const id = ids[0]!
		const decode = evidence("dmr", T0 + 1, {
			identity: { kind: "dmr-cc", value: "1" },
			contentVerified: false,
		})
		store.appendObservationEvidence("o-0", decode)
		store.applyEvidence(id, decode)
		const internals = store as unknown as {
			proofSources: () => unknown
			hasCheckedContent: (d: Discovery) => boolean
			discoveries: Map<string, Discovery>
		}
		const copied = vi.spyOn(internals, "proofSources")
		expect(internals.hasCheckedContent(internals.discoveries.get(id)!)).toBe(
			false,
		)
		expect(copied).not.toHaveBeenCalled()
	})
})

describe("firstSorted", () => {
	const compare = (a: number, b: number): number => a - b

	it("matches the whole sort at every count", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer(), { maxLength: 200 }),
				fc.integer({ min: 0, max: 220 }),
				(values, count) => {
					const whole = [...values].sort(compare)
					expect(firstSorted([...values], count, compare)).toEqual(
						whole.slice(0, count),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	const walk = shuffled(10_000)
	it.each([
		["every record beats the root", (i: number) => 10_000 - i],
		["no record beats the root", (i: number) => i],
		["shuffled", (i: number) => walk[i]!],
	])("stays within the stated bound: %s", (_name, value) => {
		const n = 10_000
		const count = 100
		const values = Array.from({ length: n }, (_, i) => value(i))
		let comparisons = 0
		const out = firstSorted(values, count, (a, b) => {
			comparisons++
			return b - a
		})
		expect(out).toHaveLength(count)
		const log = Math.ceil(Math.log2(count))
		expect(comparisons).toBeLessThanOrEqual(
			2 * count + (n - count) * (1 + 2 * log) + count * log,
		)
	})

	it("falls back to the sort at half the items, and uses the heap just below", () => {
		const items = [5, 4, 3, 2, 1, 0]
		const sort = vi.spyOn(items, "sort")
		expect(firstSorted(items, 3, compare)).toEqual([0, 1, 2])
		expect(sort).toHaveBeenCalledTimes(1)
		const below = [5, 4, 3, 2, 1, 0]
		const unsorted = vi.spyOn(below, "sort")
		expect(firstSorted(below, 2, compare)).toEqual([0, 1])
		expect(unsorted).not.toHaveBeenCalled()
		expect(firstSorted([1, 2], 0, compare)).toEqual([])
	})
})

describe("createListPace", () => {
	it("is due at the slice, not before, and starts over after a wait", async () => {
		expect(LIST_SLICE_MS).toBe(2)
		let now = 100
		const pace = createListPace(() => now)
		now = 100 + LIST_SLICE_MS - 0.001
		expect(pace.due()).toBe(false)
		now = 100 + LIST_SLICE_MS
		expect(pace.due()).toBe(true)
		await pace.wait()
		expect(pace.due()).toBe(false)
		now += LIST_SLICE_MS + 1
		expect(pace.due()).toBe(true)
	})

	it("really gives the event loop a turn", async () => {
		const order: string[] = []
		const turn = new Promise<void>(resolve => {
			setImmediate(() => {
				order.push("other work")
				resolve()
			})
		})
		await createListPace(() => 0).wait()
		order.push("read resumed")
		await turn
		expect(order).toEqual(["other work", "read resumed"])
	})
})

describe("paced reads", () => {
	it.each<[string, DiscoveryFilter]>([
		["default", { limit: 7 }],
		["second page", { limit: 7, cursor: "7" }],
		["last page", { limit: 7, cursor: "35" }],
		["frequency", { limit: 7, sort: "frequency" }],
		["confidence", { limit: 7, sort: "confidence" }],
		["near", { limit: 7, nearHz: BASE_HZ, toleranceHz: 500_000 }],
		["no match", { limit: 7, protocol: "dmr" }],
	])("answers the same rows as the plain read: %s", async (_name, filter) => {
		const { store } = storeOf(40)
		expect(await store.listPaced(filter)).toEqual(store.list(filter))
	})

	it("yields between rows when due, in the filter pass and the page", async () => {
		const n = 30
		const { store } = storeOf(n)
		const wait = vi.fn(() => Promise.resolve())
		const page = await store.listPaced({ limit: 5 }, { due: () => true, wait })
		expect(page.items).toHaveLength(5)
		expect(wait).toHaveBeenCalledTimes(n + 5)
	})

	it.each([
		// The last wait of the filter pass (10 rows): the page is chosen without it.
		["before the page is chosen", 10, 3],
		// The wait after the first presented row: the chosen page comes back short.
		["after the page is chosen", 11, 2],
	])(
		"leaves out a record removed during a yield %s, and caches nothing for it",
		async (_when, removeAtWait, rows) => {
			const { store } = storeOf(10)
			const gone = store.list({ limit: 3 }).items[1]!.id
			const internals = store as unknown as { proofCache: Map<string, unknown> }
			let waits = 0
			const page = await store.listPaced(
				{ limit: 3 },
				{
					due: () => true,
					wait: () => {
						if (++waits === removeAtWait) store.delete(gone)
						return Promise.resolve()
					},
				},
			)
			expect(page.items.map(d => d.id)).not.toContain(gone)
			expect(page.items).toHaveLength(rows)
			expect(page.nextCursor).toBe("3")
			expect(internals.proofCache.has(gone)).toBe(false)
		},
	)

	it("reports an invalid cursor as a rejection, as the plain read throws", async () => {
		const { store } = storeOf(2)
		await expect(store.listPaced({ cursor: "x" })).rejects.toThrow(
			"Invalid discovery cursor",
		)
	})
})

describe("compact rows", () => {
	/** A weak record, one with a published identity, one whose dsd-fme content is unchecked. */
	function mixed(): { store: DiscoveryStore; ids: string[] } {
		const { store, ids } = storeOf(3)
		const published = evidence("dmr", T0 + 1, {
			identity: { kind: "dmr-cc", value: "1" },
		})
		store.appendObservationEvidence("o-1", published)
		store.applyEvidence(ids[1]!, published)
		const unchecked = evidence("dmr", T0 + 1, {
			identity: { kind: "dmr-cc", value: "2" },
			contentVerified: false,
		})
		store.appendObservationEvidence("o-2", unchecked)
		store.applyEvidence(ids[2]!, unchecked)
		return { store, ids }
	}

	it("hold the same values as the full rows, in the same order", async () => {
		const { store } = mixed()
		const full = store.list({})
		const compact = await store.listCompactPaced({}, noYield())
		expect(compact.nextCursor).toBe(full.nextCursor)
		expect(compact.items).toEqual(
			full.items.map(d => ({
				id: d.id,
				frequencyHz: d.frequencyHz,
				class: d.class,
				protocol: d.protocol,
				confidence: d.confidence,
				evidenceLevel: d.evidenceLevel,
				identity: d.identity ?? null,
				lastSeenAt: d.lastSeenAt,
			})),
		)
		expect(compact.items.map(row => row.identity)).toContainEqual(null)
		expect(compact.items.map(row => row.identity)).toContainEqual({
			kind: "dmr-cc",
			value: "1",
		})
	})

	it("are never null in class, protocol or confidence", async () => {
		const { store } = storeOf(1)
		const { items } = await store.listCompactPaced({}, noYield())
		expect(items[0]).toMatchObject({
			class: "unknown",
			protocol: "unknown",
			confidence: "activity",
			evidenceLevel: "weak",
			identity: null,
		})
	})

	it("copy nothing deep, and share no identity object with the store", async () => {
		const { store, ids } = mixed()
		const copies = vi.fn(structuredClone)
		vi.stubGlobal("structuredClone", copies)
		const { items } = await store.listCompactPaced({}, noYield())
		expect(copies).not.toHaveBeenCalled()
		vi.unstubAllGlobals()
		const row = items.find(item => item.id === ids[1])!
		row.identity!.value = "changed"
		expect(store.get(ids[1]!)?.identity?.value).toBe("1")
	})
})
