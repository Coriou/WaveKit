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
			measure: table({ 8192: { [dim]: limit[dim] * 1.01 } }),
		})
		expect(res).toMatchObject({ cap: 4096, source: "measured" })
		expect(res.measurements.map(m => m.bins)).toEqual([8192, 4096])
	})

	it.each(DIMS)("%s failing alone at both gives measured floor", dim => {
		const bad = { [dim]: limit[dim] * 1.01 }
		expect(
			resolveSpectrumBinsCap("auto", {
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
			resolveSpectrumBinsCap("auto", { measure: table({ 8192: at }) }).cap,
		).toBe(8192)
		for (const dim of DIMS) {
			const past = { ...at, [dim]: at[dim] * (1 + 1e-9) }
			expect(
				resolveSpectrumBinsCap("auto", { measure: table({ 8192: past }) }).cap,
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
		expect(resolveSpectrumBinsCap("auto", { measure })).toMatchObject({
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
