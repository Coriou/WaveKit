import { readFileSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { SPECTRUM_BINS_BUDGET } from "@wavekit/api-types"
import type {
	BinsCapMeasurer,
	BinsCostSample,
} from "../../../../src/core/spectrum/bin-cap.js"
import { resolveSpectrumBinsCap } from "../../../../src/core/spectrum/bin-cap.js"

const B = SPECTRUM_BINS_BUDGET
const limit = {
	summaryBytesPerSecond: B.summaryBytesPerSecond / B.margin,
	cloneMsPerSecond: B.cloneMsPerSecond / B.margin,
	profileMsPerSecond: B.profileMsPerSecond / B.margin,
}
type Dim = keyof typeof limit
const DIMS: Dim[] = [
	"summaryBytesPerSecond",
	"cloneMsPerSecond",
	"profileMsPerSecond",
]

const ok = (bins: number): BinsCostSample => ({
	bins,
	summaryBytesPerSecond: 1,
	cloneMsPerSecond: 0.1,
	profileMsPerSecond: 0.1,
})
const table =
	(costs: Record<number, Partial<BinsCostSample>>): BinsCapMeasurer =>
	bins => ({ ...ok(bins), ...costs[bins] })

/** Fixed clock: deterministic tests never depend on real elapsed time. */
const now = (): number => 0

const fits = (s: BinsCostSample): boolean =>
	DIMS.every(k => s[k] * B.margin <= B[k])

describe("resolveSpectrumBinsCap", () => {
	// Feature: web-gaps-8, Property 12: Cap choice
	// Validates: Requirements 5.2
	it("picks the largest choice within budget × margin, floor when none, fallback on failure", () => {
		const value = fc.oneof(
			fc.double({ min: 0, max: 2, noNaN: true }),
			fc.constantFrom(Number.NaN, Infinity, -Infinity, -1),
		)
		const sample = fc.record({ a: value, b: value, c: value })
		fc.assert(
			fc.property(sample, sample, fc.boolean(), (s8, s4, overtime) => {
				const mk = (
					bins: number,
					r: { a: number; b: number; c: number },
				): BinsCostSample => ({
					bins,
					summaryBytesPerSecond: r.a * limit.summaryBytesPerSecond,
					cloneMsPerSecond: r.b * limit.cloneMsPerSecond,
					profileMsPerSecond: r.c * limit.profileMsPerSecond,
				})
				const samples: Record<number, BinsCostSample> = {
					8192: mk(8192, s8),
					4096: mk(4096, s4),
				}
				let t = 0
				const calls: number[] = []
				const res = resolveSpectrumBinsCap("auto", {
					now: () => t,
					measure: bins => {
						calls.push(bins)
						t += overtime ? B.benchWallMs + 1 : 10
						return samples[bins]!
					},
				})
				const good = (s: BinsCostSample): boolean =>
					DIMS.every(k => Number.isFinite(s[k]) && s[k] >= 0)
				let expected: { cap: number; source: string }
				if (overtime) expected = { cap: 2048, source: "fallback" }
				else if (!good(samples[8192]!))
					expected = { cap: 2048, source: "fallback" }
				else if (fits(samples[8192]!))
					expected = { cap: 8192, source: "measured" }
				else if (!good(samples[4096]!))
					expected = { cap: 2048, source: "fallback" }
				else if (fits(samples[4096]!))
					expected = { cap: 4096, source: "measured" }
				else expected = { cap: 2048, source: "measured" }
				expect({ cap: res.cap, source: res.source }).toEqual(expected)
				expect(res.setting).toBe("auto")
				expect(calls[0]).toBe(8192)
				expect(calls).not.toContain(2048)
				for (const m of res.measurements) expect(good(m)).toBe(true)
			}),
			{ numRuns: 200 },
		)
	})

	it.each([2048, 4096, 8192] as const)(
		"fixed %i never calls the measurer",
		n => {
			const measure = vi.fn<BinsCapMeasurer>()
			const now = vi.fn(() => 0)
			expect(resolveSpectrumBinsCap(n, { measure, now })).toEqual({
				setting: n,
				cap: n,
				source: "config",
				measurements: [],
				wallMs: 0,
			})
			expect(measure).not.toHaveBeenCalled()
		},
	)

	it.each(DIMS)("%s failing alone at 8192 gives 4096", dim => {
		const res = resolveSpectrumBinsCap("auto", {
			now,
			measure: table({ 8192: { [dim]: limit[dim] * 1.01 } }),
		})
		expect(res).toMatchObject({ cap: 4096, source: "measured" })
		expect(res.measurements.map(m => m.bins)).toEqual([8192, 4096])
	})

	it.each(DIMS)("%s failing alone at both gives measured floor", dim => {
		const bad = { [dim]: limit[dim] * 1.01 }
		expect(
			resolveSpectrumBinsCap("auto", {
				now,
				measure: table({ 8192: bad, 4096: bad }),
			}),
		).toMatchObject({
			cap: 2048,
			source: "measured",
		})
	})

	it("margin edge: exactly at budget passes, just past fails", () => {
		const at = {
			summaryBytesPerSecond: (512 * 1024) / 1.5,
			cloneMsPerSecond: 10 / 1.5,
			profileMsPerSecond: 5 / 1.5,
		}
		expect(
			resolveSpectrumBinsCap("auto", { now, measure: table({ 8192: at }) }).cap,
		).toBe(8192)
		for (const dim of DIMS) {
			const past = { ...at, [dim]: at[dim] * (1 + 1e-9) }
			expect(
				resolveSpectrumBinsCap("auto", { now, measure: table({ 8192: past }) })
					.cap,
			).toBe(4096)
		}
	})

	it.each([
		[
			"throw",
			(): BinsCostSample => {
				throw new Error("boom")
			},
		],
		["NaN", (b: number) => ({ ...ok(b), cloneMsPerSecond: Number.NaN })],
		["Infinity", (b: number) => ({ ...ok(b), profileMsPerSecond: Infinity })],
		[
			"-Infinity",
			(b: number) => ({ ...ok(b), summaryBytesPerSecond: -Infinity }),
		],
		["negative", (b: number) => ({ ...ok(b), cloneMsPerSecond: -1 })],
		["wrong bins", (b: number) => ok(b + 1)],
	] as [string, BinsCapMeasurer][])("%s gives fallback", (_n, measure) => {
		expect(resolveSpectrumBinsCap("auto", { now, measure })).toMatchObject({
			cap: 2048,
			source: "fallback",
		})
	})

	it("overtime with a fake clock gives fallback", () => {
		let t = 1000
		const res = resolveSpectrumBinsCap("auto", {
			now: () => t,
			measure: b => {
				t += 201
				return ok(b)
			},
		})
		expect(res).toMatchObject({ cap: 2048, source: "fallback", wallMs: 201 })
	})

	it("a getter sample is read once: NaN on a second read cannot pass as 8192", () => {
		const reads = new Map<number, number>()
		const res = resolveSpectrumBinsCap("auto", {
			now: () => 0,
			measure: bins => {
				const sample = { ...ok(bins) } as BinsCostSample
				Object.defineProperty(sample, "summaryBytesPerSecond", {
					enumerable: true,
					get: () => {
						const n = (reads.get(bins) ?? 0) + 1
						reads.set(bins, n)
						return n === 1 ? 1 : NaN
					},
				})
				return sample
			},
		})
		expect(res.cap).toBe(8192)
		expect(res.source).toBe("measured")
		expect(reads.get(8192)).toBe(1)
		for (const m of res.measurements) {
			expect(Number.isFinite(m.summaryBytesPerSecond)).toBe(true)
			expect(
				Object.getOwnPropertyDescriptor(m, "summaryBytesPerSecond")?.get,
			).toBeUndefined()
		}
	})

	it("a getter that fails the budget on the second read still uses the first value", () => {
		let n = 0
		const res = resolveSpectrumBinsCap("auto", {
			now: () => 0,
			measure: bins => {
				const sample = { ...ok(bins) }
				Object.defineProperty(sample, "profileMsPerSecond", {
					enumerable: true,
					get: () => (++n === 1 ? 1e9 : 0),
				})
				return sample
			},
		})
		expect(res.measurements[0]).toMatchObject({
			bins: 8192,
			profileMsPerSecond: 1e9,
		})
	})

	it("overtime fallback from the default measurer reports a finite non-zero wallMs", () => {
		let t = 0
		const res = resolveSpectrumBinsCap("auto", { now: () => (t += 50) })
		expect(res).toMatchObject({ cap: 2048, source: "fallback" })
		expect(res.wallMs).toBeGreaterThan(0)
		expect(Number.isFinite(res.wallMs)).toBe(true)
	})

	it("a clock that throws or turns NaN keeps the last known finite wallMs", () => {
		let calls = 0
		const throwing = resolveSpectrumBinsCap("auto", {
			now: () => {
				calls++
				if (calls === 1) return 0
				if (calls === 2) return 30
				throw new Error("clock")
			},
			measure: bins => ({
				...ok(bins),
				profileMsPerSecond: B.profileMsPerSecond * 10,
			}),
		})
		expect(throwing).toMatchObject({ source: "fallback", wallMs: 30 })
		let k = 0
		const nan = resolveSpectrumBinsCap("auto", {
			now: () => [0, 40][k++] ?? NaN,
			measure: bins => ({
				...ok(bins),
				profileMsPerSecond: B.profileMsPerSecond * 10,
			}),
		})
		expect(nan).toMatchObject({ source: "fallback", wallMs: 40 })
	})

	it("overtime spent in sample getters (during snapshot) gives fallback", () => {
		let t = 0
		const res = resolveSpectrumBinsCap("auto", {
			now: () => t,
			measure: bins => ({
				bins,
				summaryBytesPerSecond: 0,
				cloneMsPerSecond: 0,
				get profileMsPerSecond() {
					t = B.benchWallMs + 1
					return 0
				},
			}),
		})
		expect(res).toMatchObject({
			cap: 2048,
			source: "fallback",
			wallMs: B.benchWallMs + 1,
		})
	})

	it("default measurer: one NaN clock reading mid-bench gives fallback", () => {
		let calls = 0
		const res = resolveSpectrumBinsCap("auto", {
			now: () => (++calls === 268 ? NaN : 0),
		})
		expect(calls).toBeGreaterThanOrEqual(268)
		expect(res).toMatchObject({ cap: 2048, source: "fallback", wallMs: 0 })
	})

	it("default measurer: a clock stepping backwards gives fallback", () => {
		let calls = 0
		const res = resolveSpectrumBinsCap("auto", {
			now: () => (++calls === 268 ? 5 : 10),
		})
		expect(res).toMatchObject({ cap: 2048, source: "fallback" })
	})

	it("default measurer: clock 0, 30, then throwing gives fallback with wallMs 30", () => {
		let calls = 0
		const res = resolveSpectrumBinsCap("auto", {
			now: () => {
				calls++
				if (calls === 1) return 0
				if (calls === 2) return 30
				throw new Error("clock")
			},
		})
		expect(res).toMatchObject({ cap: 2048, source: "fallback", wallMs: 30 })
	})

	it("default measurer stops on overtime and falls back", () => {
		let t = 0
		const res = resolveSpectrumBinsCap("auto", { now: () => (t += 50) })
		expect(res).toMatchObject({ cap: 2048, source: "fallback" })
	})

	it("bin-cap.ts imports only @wavekit/api-types", () => {
		const src = readFileSync(
			new URL("../../../../src/core/spectrum/bin-cap.ts", import.meta.url),
			"utf8",
		)
		const specs = [
			...src.matchAll(
				/\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
			),
			...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
			...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
			...src.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
		].map(m => m[1])
		expect(specs.length).toBeGreaterThan(0)
		expect(new Set(specs)).toEqual(new Set(["@wavekit/api-types"]))
	})

	it("real default measurer runs (timing reported, not asserted)", () => {
		const res = resolveSpectrumBinsCap("auto")
		process.stdout.write(`BINCAP ${JSON.stringify(res)}\n`)
		expect([2048, 4096, 8192]).toContain(res.cap)
	})
})
