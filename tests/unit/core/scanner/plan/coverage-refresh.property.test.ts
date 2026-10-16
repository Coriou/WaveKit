// Feature: web-gaps-7, Property 12: Refresh bounds
// Validates: Requirements 7.1, 7.2
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	coverageFingerprint,
	createCoverageRefresh,
} from "../../../../../src/core/scanner/plan/coverage-refresh.js"
import { computeDecodedElsewhere } from "../../../../../src/core/scanner/plan/decoded-elsewhere.js"
import type {
	DecoderCoverageView,
	NormalisedJobSpec,
} from "../../../../../src/core/scanner/types.js"

function fakeClock() {
	let t = 0
	let seq = 0
	const timers = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => t,
		setTimer: (fn: () => void, ms: number): unknown => {
			const id = ++seq
			timers.set(id, { at: t + ms, fn })
			return id
		},
		clearTimer: (h: unknown): void => {
			timers.delete(h as number)
		},
		advance(ms: number): void {
			const end = t + ms
			for (;;) {
				let next: [number, { at: number; fn: () => void }] | undefined
				for (const e of timers) if (!next || e[1].at < next[1].at) next = e
				if (!next || next[1].at > end) break
				timers.delete(next[0])
				t = Math.max(t, next[1].at)
				next[1].fn()
			}
			t = end
		},
	}
}

describe("coverage refresh bounds (property 12)", () => {
	it("bounds refreshes and debounces every fire", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gap: fc.integer({ min: 0, max: 5000 }),
						change: fc.boolean(),
					}),
					{ maxLength: 300 },
				),
				events => {
					const clock = fakeClock()
					let fp = 0
					let refreshes = 0
					let lastNotify = -Infinity
					let lastRefreshed = "none"
					const fires: number[] = []
					const refresh = createCoverageRefresh({
						...clock,
						fingerprint: () => {
							fires.push(clock.now())
							expect(clock.now() - lastNotify).toBeGreaterThanOrEqual(2000)
							return String(fp)
						},
						onRefresh: () => {
							refreshes++
							expect(String(fp)).not.toBe(lastRefreshed)
							lastRefreshed = String(fp)
						},
					})
					for (const e of events) {
						clock.advance(e.gap)
						if (e.change) fp++
						lastNotify = clock.now()
						refresh.notify()
					}
					const total = clock.now()
					clock.advance(100000)
					expect(refreshes).toBeLessThanOrEqual(Math.ceil(total / 30000) + 1)
					for (let i = 1; i < fires.length; i++)
						expect(
							(fires[i] ?? 0) - (fires[i - 1] ?? 0),
						).toBeGreaterThanOrEqual(30000)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("coverageFingerprint soundness", () => {
	// Small pools so distinct generated views often fingerprint equal.
	const scalar = fc.constantFrom<unknown>(
		"?",
		"s1",
		"job",
		null,
		undefined,
		true,
		false,
		0,
		-0,
		100,
		150,
		Number.NaN,
		"running",
		"in-band",
		"config",
		"external",
		{},
	)
	const freq = fc.constantFrom<unknown>(
		100,
		150,
		200,
		-1,
		Number.NaN,
		"100",
		null,
	)
	const range = fc.oneof(
		fc.record({ minHz: freq, maxHz: freq }),
		fc.constantFrom<unknown>(null, 5),
	)
	const band = fc.oneof(
		fc.constant<unknown>(null),
		fc.record({
			verdict: fc.constantFrom<unknown>("in-band", "unknown", null),
			basis: fc.constantFrom<unknown>("configured", "decoder-default", null),
			targetsHz: fc.oneof(fc.array(freq, { maxLength: 3 }), scalar),
			rangesHz: fc.oneof(fc.array(range, { maxLength: 2 }), scalar),
			captureCenterHz: fc.constantFrom<unknown>(150, null, Number.NaN),
			windowHalfWidthHz: fc.constantFrom<unknown>(100, 0, null),
		}),
	)
	const goodView = fc.record({
		id: fc.constantFrom<unknown>("?", "d1", undefined),
		running: fc.constantFrom<unknown>(true, false, 1),
		health: fc.constantFrom<unknown>("running", "idle", "faulted"),
		suspended: fc.constantFrom<unknown>(false, true, 0),
		owner: fc.constantFrom<unknown>("config", "scanner"),
		sourceId: fc.constantFrom<unknown>("s1", "job", null, undefined),
		inputKind: fc.constantFrom<unknown>("iq", "external"),
		band,
	})
	const throwing = Object.defineProperty({}, "id", {
		get() {
			throw new Error("g")
		},
	})
	const anyView = fc.oneof(
		{ weight: 8, arbitrary: goodView as fc.Arbitrary<unknown> },
		{ weight: 1, arbitrary: scalar },
		{ weight: 1, arbitrary: fc.constant<unknown>(throwing) },
	)
	const views = fc.array(anyView, { maxLength: 3 })
	const specs = [
		{ sourceId: "job", ranges: [{ startHz: 0, endHz: 1e9 }] },
		{ sourceId: "s1", ranges: [{ startHz: 120, endHz: 180 }] },
		{ sourceId: "job", ranges: [{ startHz: 0, endHz: 140 }] },
	] as unknown as Pick<NormalisedJobSpec, "sourceId" | "ranges">[]

	it("equal fingerprints imply equal decoded-elsewhere output", () => {
		let equalPairs = 0
		fc.assert(
			fc.property(views, views, (a, b) => {
				const va = a as DecoderCoverageView[]
				const vb = b as DecoderCoverageView[]
				for (const v of [va, vb]) {
					expect(coverageFingerprint(v)).toBe(coverageFingerprint(v))
				}
				if (coverageFingerprint(va) !== coverageFingerprint(vb)) return
				equalPairs++
				for (const spec of specs) {
					expect(computeDecodedElsewhere(vb, spec)).toEqual(
						computeDecodedElsewhere(va, spec),
					)
				}
			}),
			{ numRuns: 300 },
		)
		expect(equalPairs).toBeGreaterThan(0)
	})

	it("a view equals itself in a fresh copy", () => {
		fc.assert(
			fc.property(views, a => {
				const copy = structuredClone(
					a.map(v => (v === throwing ? null : v)),
				) as DecoderCoverageView[]
				const orig = a.map(v =>
					v === throwing ? null : v,
				) as DecoderCoverageView[]
				expect(coverageFingerprint(copy)).toBe(coverageFingerprint(orig))
				for (const spec of specs)
					expect(computeDecodedElsewhere(copy, spec)).toEqual(
						computeDecodedElsewhere(orig, spec),
					)
			}),
			{ numRuns: 100 },
		)
	})
})
