/**
 * What a re-plan costs while voice locks are outstanding: an operation count, never a clock. The rule
 * itself is checked against its definition, written out here as old × new span tests.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	carryVoiceLocks,
	HopBits,
	nearestHopIn,
} from "../../../../src/core/scanner/scheduler.js"
import type { Hop } from "../../../../src/core/scanner/types.js"
import { makeHopPlan } from "../../../mocks/scanner/job-spec.js"

type Span = Hop["covered"]

const HALF_SPAN_HZ = 409_600
const STEP_HZ = 800_000
const BASE_HZ = 100_000_000
const tiled = (n: number, shiftHz = 0): Span[] =>
	Array.from({ length: n }, (_, i) => ({
		startHz: BASE_HZ + shiftHz + i * STEP_HZ - HALF_SPAN_HZ,
		endHz: BASE_HZ + shiftHz + i * STEP_HZ + HALF_SPAN_HZ,
	}))

const bitsOf = (n: number, hops: Iterable<number>): HopBits => {
	const words = new Uint32Array(Math.ceil(n / 32))
	for (const i of hops) words[i >>> 5] = (words[i >>> 5] ?? 0) | (1 << i)
	return new HopBits(words)
}
const hopsIn = (bits: HopBits, n: number): number[] =>
	Array.from({ length: n }, (_, i) => i).filter(i => bits.has(i))

/** The rule by its definition: every old hop against every new hop, a set per lock. */
function byDefinition(
	old: readonly Span[],
	locks: readonly (readonly number[])[],
	next: readonly Span[],
): number[][] {
	const holds = (a: Span, b: Span) =>
		a.startHz <= b.startHz && b.endHz <= a.endHz
	const shares = (a: Span, b: Span) =>
		Math.min(a.endHz, b.endHz) - Math.max(a.startHz, b.startHz) >
		Math.min(a.endHz - a.startHz, b.endHz - b.startHz) / 2
	const out = next.map(() => new Set<number>())
	for (const [l, lock] of locks.entries()) {
		if (lock.length === 0) continue
		const owed = [...next.keys()].filter(
			k =>
				!old.some((o, i) => i !== l && !lock.includes(i) && holds(o, next[k]!)),
		)
		for (const [j, hop] of next.entries()) {
			if (!shares(hop, old[l]!)) continue
			for (const k of owed) if (k !== j) out[j]!.add(k)
		}
	}
	return out.map(s => [...s].sort((a, b) => a - b))
}

/** The heaviest lock pattern a sweep can reach: hop i held after hops 0..i-1 and the last were owed. */
function heavyLocks(n: number): number[][] {
	return Array.from({ length: n }, (_, i) =>
		i === n - 1 ? [] : [...Array.from({ length: i }, (_, k) => k), n - 1],
	)
}

describe("HopBits", () => {
	it("all hops but one: the size is right on and past a word boundary", () => {
		for (const n of [1, 31, 32, 33, 64, 65, 1_025]) {
			const bits = HopBits.allBut(n, 0)
			expect(bits.size).toBe(n - 1)
			expect(bits.has(0)).toBe(false)
			expect(bits.has(n - 1)).toBe(n > 1)
			// Past the plan: no such hop.
			expect(bits.has(n)).toBe(false)
		}
	})

	it("deleting is idempotent, and an index past the plan changes nothing", () => {
		const bits = HopBits.allBut(33, 0)
		bits.delete(32)
		bits.delete(32)
		bits.delete(5_000)
		expect(bits.size).toBe(31)
		expect(bits.has(32)).toBe(false)
		expect(bits.has(31)).toBe(true)
	})
})

describe("carrying voice locks into a plan", () => {
	// Feature: scanner record whole voice, Property 3: the sweep's answer equals the old × new rule.
	// Validates: sweep record hold, a plan change keeps what a voice hold owes
	it("gives the same locks as the rule's definition, on any plan change", () => {
		const span = fc
			.record({
				centre: fc.integer({ min: 0, max: 40 }),
				half: fc.integer({ min: 1, max: 12 }),
			})
			.map(({ centre, half }) => ({
				startHz: (centre - half) * 100_000,
				endHz: (centre + half) * 100_000,
			}))
		fc.assert(
			fc.property(
				fc.array(span, { minLength: 1, maxLength: 40 }),
				fc.array(span, { minLength: 1, maxLength: 40 }),
				fc.array(fc.array(fc.nat(39), { maxLength: 40 }), {
					minLength: 40,
					maxLength: 40,
				}),
				fc.boolean(),
				(old, other, rawLocks, same) => {
					const next = same ? old : other
					const locks = old.map((_, l) =>
						[...new Set(rawLocks[l]!)]
							.map(i => i % old.length)
							.filter(i => i !== l),
					)
					const { locks: out } = carryVoiceLocks(
						old,
						locks.map(lock => bitsOf(old.length, lock)),
						next,
					)
					expect(out.map(bits => hopsIn(bits, next.length))).toEqual(
						byDefinition(old, locks, next),
					)
					for (const bits of out)
						expect(bits.size).toBe(hopsIn(bits, next.length).length)
				},
			),
			{ numRuns: 300 },
		)
	})

	it("an unchanged tiled plan keeps each lock as it is, the same objects", () => {
		const spans = tiled(1_025)
		const locks = heavyLocks(1_025).map(lock => bitsOf(1_025, lock))
		const { locks: out, ops } = carryVoiceLocks(spans, locks, tiled(1_025))
		expect(out).toEqual(locks)
		for (const [i, lock] of out.entries()) expect(lock).toBe(locks[i])
		// The sweep alone: a new hop tests itself, its two neighbours and the old hop it drops.
		expect(ops).toBeLessThanOrEqual(4 * 1_025)
	})

	it("an unchanged plan whose hops share a window goes by the rule, not by keeping", () => {
		// Hop 1's window is more than half inside hop 0's: a lock on hop 0 also locks hop 1.
		const spans = [
			{ startHz: 0, endHz: 1_000 },
			{ startHz: 100, endHz: 1_100 },
			{ startHz: 5_000, endHz: 6_000 },
		]
		const { locks } = carryVoiceLocks(
			spans,
			[bitsOf(3, [1, 2]), bitsOf(3, []), bitsOf(3, [])],
			spans,
		)
		expect(locks.map(l => hopsIn(l, 3))).toEqual([[1, 2], [0, 2], []])
	})

	/**
	 * The bound the code states, for L locks and one heir per lock: 4 pairs per new hop in the sweep,
	 * then per lock one read per new hop, one holder read per new hop and ceil(M / 32) word operations.
	 * The new hops are half as wide on the old centres, so each has one holder and the reads are spent.
	 */
	const narrowed = (n: number): Span[] =>
		tiled(n).map(({ startHz, endHz }) => ({
			startHz: startHz + HALF_SPAN_HZ / 2,
			endHz: endHz - HALF_SPAN_HZ / 2,
		}))
	const changedBound = (n: number): number =>
		4 * n + (n - 1) * (2 * n + Math.ceil(n / 32))
	const heavyOps = (n: number): number =>
		carryVoiceLocks(
			tiled(n),
			heavyLocks(n).map(lock => bitsOf(n, lock)),
			narrowed(n),
		).ops

	it("a changed plan of 1,025 hops all locked stays within the stated count (4,100 + 1,024 × (2,050 + 33) = 2,137,092)", () => {
		expect(changedBound(1_025)).toBe(2_137_092)
		const ops = heavyOps(1_025)
		expect(ops).toBeLessThanOrEqual(changedBound(1_025))
		// Spent, so the count measures this pattern and not an early exit.
		expect(ops).toBeGreaterThan(2 * 1_024 * 1_025)
	})

	it("past that size the same formula holds (2,049 hops)", () => {
		const ops = heavyOps(2_049)
		expect(ops).toBeLessThanOrEqual(changedBound(2_049))
		expect(ops).toBeGreaterThan(2 * 2_048 * 2_049)
	})

	it("with one lock the count is linear in the plan, where the old scan was old × new", () => {
		const opsAt = (n: number): number => {
			const locks = Array.from({ length: n }, (_, i) =>
				bitsOf(n, i === 0 ? [n - 1] : []),
			)
			return carryVoiceLocks(tiled(n), locks, narrowed(n)).ops
		}
		const bound = (n: number): number => 6 * n + Math.ceil(n / 32)
		expect(opsAt(1_025)).toBeLessThanOrEqual(bound(1_025))
		expect(opsAt(4_097)).toBeLessThanOrEqual(bound(4_097))
	})

	it("a lock whose window the new plan drops costs no reads and leaves nothing", () => {
		const n = 1_025
		const { locks, ops } = carryVoiceLocks(
			tiled(n),
			heavyLocks(n).map(lock => bitsOf(n, lock)),
			tiled(2, 100_000_000_000),
		)
		expect(locks.map(l => l.size)).toEqual([0, 0])
		expect(ops).toBeLessThanOrEqual(2 * n)
	})

	it("no lock outstanding: no work at all", () => {
		const n = 1_025
		const { ops } = carryVoiceLocks(
			tiled(n),
			Array.from({ length: n }, () => bitsOf(n, [])),
			tiled(n, 100_000),
		)
		expect(ops).toBe(0)
	})
})

describe("nearest hop for many lookups", () => {
	const scanned = (centres: readonly number[], hz: number): number => {
		let best = 0
		let bestDist = Number.POSITIVE_INFINITY
		for (const [i, c] of centres.entries()) {
			if (Math.abs(c - hz) < bestDist) {
				best = i
				bestDist = Math.abs(c - hz)
			}
		}
		return best
	}

	// Feature: scanner record whole voice, Property 4: the search answers as the scan, ties included.
	// Validates: sweep record hold, a plan change maps hops by their nearest centre
	it("answers as a scan of the plan, on any order of hops, duplicates and ties", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 30 }),
				fc.array(fc.integer({ min: -5, max: 35 }), { minLength: 1 }),
				(centres, lookups) => {
					const nearest = nearestHopIn(makeHopPlan(centres))
					for (const hz of lookups)
						expect(nearest(hz)).toBe(scanned(centres, hz))
				},
			),
			{ numRuns: 300 },
		)
	})
})
