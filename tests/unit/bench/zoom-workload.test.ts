import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	Cu8Ring,
	ZoomSlice,
	BUDGETS,
	chunkMissed,
	evaluateCell,
	ownedSliceBytes,
	makeCu8Signal,
	parseArgs,
	percentile,
	reduceMaxHold,
	sliceBins,
} from "../../../scripts/bench/zoom-workload-core.js"
import { runBenchmark } from "../../../scripts/bench/zoom-workload.js"

const ok = {
	incrementalCore: 0.05,
	eventLoopP99IncreaseMs: 0.5,
	missedDeadlines: 0,
	rssGrowthBytes: 0,
	ownedBytes: 0,
	rssOverBaselineBytes: 0,
}
const MiB = 1024 * 1024

describe("zoom workload parseArgs", () => {
	it("expands ranges and lists", () => {
		const o = parseArgs([
			"--fft",
			"8192..65536,2048",
			"--rate",
			"5,10",
			"--slices",
			"1,2",
			"--fs",
			"2048000",
			"--duration",
			"3",
			"--no-detector",
			"--variant",
			"fft,ddc",
		])
		expect(o.fft).toEqual([8192, 16384, 32768, 65536, 2048])
		expect(o.rate).toEqual([5, 10])
		expect(o.slices).toEqual([1, 2])
		expect(o.durationS).toBe(3)
		expect(o.detector).toBe(false)
		expect(o.variant).toEqual(["fft", "ddc"])
	})

	it("uses the full default grid and caps smoke duration", () => {
		const d = parseArgs([])
		expect(d.fft[0]).toBe(2048)
		expect(d.fft.at(-1)).toBe(262_144)
		expect(d.durationS).toBe(60)
		expect(parseArgs(["--smoke", "--duration", "60"]).durationS).toBe(5)
	})

	it.each([
		[["--fft", "3000"]],
		[["--fft", "1024"]],
		[["--fft", "524288"]],
		[["--fft", "2048..3000"]],
		[["--rate", "0"]],
		[["--rate", "26"]],
		[["--slices", "9"]],
		[["--slices", "1.5"]],
		[["--duration", "0"]],
		[["--duration", "abc"]],
		[["--bogus", "1"]],
		[["--fft"]],
	])("rejects %j", argv => {
		expect(() => parseArgs(argv)).toThrow()
	})

	it("truncates a long bad value in the message", () => {
		expect(() => parseArgs(["--rate", "x".repeat(500)])).toThrow(/^.{0,80}$/)
	})
})

describe("zoom workload percentile", () => {
	it("handles edges (nearest rank)", () => {
		expect(percentile([], 50)).toBeNaN()
		expect(percentile([7], 0)).toBe(7)
		expect(percentile([7], 99)).toBe(7)
		const v = Array.from({ length: 100 }, (_, i) => i + 1)
		expect(percentile(v, 0)).toBe(1)
		expect(percentile(v, 50)).toBe(50)
		expect(percentile(v, 99)).toBe(99)
		expect(percentile(v, 100)).toBe(100)
		expect(percentile([1, 2, 3, 4], 50)).toBe(2)
	})

	// Feature: web-gaps-9, Property 1: percentile is monotone in p and within [min, max]
	// Validates: Requirements 4.3, 4.4
	it("is monotone in p and bounded by the data", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), {
					minLength: 1,
					maxLength: 200,
				}),
				fc.double({ min: 0, max: 100, noNaN: true }),
				fc.double({ min: 0, max: 100, noNaN: true }),
				(values, a, b) => {
					const s = values.slice().sort((x, y) => x - y)
					const lo = Math.min(a, b)
					const hi = Math.max(a, b)
					const pl = percentile(s, lo)
					const ph = percentile(s, hi)
					return pl <= ph && pl >= s[0]! && ph <= s[s.length - 1]!
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("zoom workload pass rule", () => {
	it("passes at each bound", () => {
		expect(evaluateCell(ok).pass).toBe(true)
		expect(evaluateCell({ ...ok, incrementalCore: 0.1 }).pass).toBe(true)
		expect(evaluateCell({ ...ok, eventLoopP99IncreaseMs: 2 }).pass).toBe(true)
	})

	it("fails past each bound", () => {
		expect(evaluateCell({ ...ok, incrementalCore: 0.1001 }).pass).toBe(false)
		expect(evaluateCell({ ...ok, eventLoopP99IncreaseMs: 2.001 }).pass).toBe(
			false,
		)
		const missed = evaluateCell({ ...ok, missedDeadlines: 1 })
		expect(missed.pass).toBe(false)
		expect(missed.reasons.join()).toMatch(/missed/)
		expect(evaluateCell({ ...ok, rssGrowthBytes: 17 * 1024 * 1024 }).pass).toBe(
			false,
		)
		expect(evaluateCell({ ...ok, incrementalCore: Number.NaN }).pass).toBe(
			false,
		)
	})
})

describe("zoom workload memory and deadline accounting", () => {
	it("bounds owned memory at 32 MiB per source", () => {
		expect(BUDGETS.ownedBytesPerSource).toBe(32 * MiB)
		expect(evaluateCell({ ...ok, ownedBytes: 32 * MiB }).pass).toBe(true)
		expect(evaluateCell({ ...ok, ownedBytes: 32 * MiB + 1 }).pass).toBe(false)
	})

	it("bounds RSS high-water over baseline at cap plus margin", () => {
		const cap = 64 * MiB
		expect(evaluateCell({ ...ok, rssOverBaselineBytes: cap }).pass).toBe(true)
		const r = evaluateCell({ ...ok, rssOverBaselineBytes: cap + 1 })
		expect(r.pass).toBe(false)
		expect(r.reasons.join()).toMatch(/over baseline/)
		expect(evaluateCell({ ...ok, rssGrowthBytes: 16 * MiB }).pass).toBe(true)
		expect(evaluateCell({ ...ok, rssGrowthBytes: 16 * MiB + 1 }).pass).toBe(
			false,
		)
	})

	it("computes owned slice bytes structurally", () => {
		const fs = 2_048_000
		const one = ownedSliceBytes({
			n: 65_536,
			slices: 1,
			variant: "fft",
			fs,
			spanHz: 128_000,
		})
		expect(one).toBe(26 * 65_536 + 4 * 4096)
		expect(
			ownedSliceBytes({
				n: 65_536,
				slices: 4,
				variant: "fft",
				fs,
				spanHz: 128_000,
			}),
		).toBe(4 * one)
		// 262144 x 8 slices is far past the per-source ceiling.
		const big = ownedSliceBytes({
			n: 262_144,
			slices: 8,
			variant: "fft",
			fs,
			spanHz: 128_000,
		})
		expect(evaluateCell({ ...ok, ownedBytes: big }).pass).toBe(false)
	})

	it("counts a chunk that starts or finishes late, at the bound and past it", () => {
		expect(chunkMissed(1000, 1000, 1250)).toBe(false)
		expect(chunkMissed(1000, 1000, 1250.001)).toBe(true)
		expect(chunkMissed(1000, 1250.001, 1250.001)).toBe(true)
		expect(chunkMissed(1000, 1100, 1200)).toBe(false)
	})

	it("uses the decimator output rate for ddc bin spacing", () => {
		const s = new ZoomSlice({
			n: 8192,
			fs: 2_400_000,
			offsetHz: 0,
			spanHz: 128_000,
			variant: "ddc",
		})
		// floor(2.4e6/128e3) = 18 is not exact; chooseDecimation picks D = 16, 150 kHz (the old reconstruction gave 133 333).
		expect(s.fftRateHz).toBe(150_000)
	})
})

describe("zoom workload DSP helpers", () => {
	it("generates deterministic seeded CU8", () => {
		const a = makeCu8Signal(7, 48_000, 0.1)
		expect(a).toEqual(makeCu8Signal(7, 48_000, 0.1))
		expect(a).not.toEqual(makeCu8Signal(8, 48_000, 0.1))
		expect(a.length).toBe(2 * 4800)
	})

	it("ring keeps the latest contiguous samples", () => {
		const r = new Cu8Ring(4)
		r.push(Uint8Array.from([0, 0, 1, 1, 2, 2]))
		r.push(Uint8Array.from([3, 3, 4, 4, 5, 5]))
		const re = new Float32Array(4)
		const im = new Float32Array(4)
		r.copyWindowed(new Float32Array(4).fill(1), re, im)
		expect(Array.from(re, v => Math.round(v * 127.5 + 127.5))).toEqual([
			2, 3, 4, 5,
		])
	})

	it("selects slice bins and max-holds to 2048", () => {
		expect(sliceBins(65_536, 2_048_000, 0, 128_000)).toEqual({
			start: 32_768 - 2048,
			end: 32_768 + 2048,
		})
		expect(reduceMaxHold([1, 5, 2, 3], 2).bins).toEqual(
			Float32Array.from([5, 3]),
		)
		const s = new ZoomSlice({
			n: 8192,
			fs: 2_048_000,
			offsetHz: 100_000,
			spanHz: 128_000,
			variant: "fft",
		})
		s.feed(makeCu8Signal(1, 2_048_000, 0.01))
		expect(s.transform().length).toBeLessThanOrEqual(2048)
	})
})

describe("zoom workload smoke run", () => {
	it("writes samples, summary and meta", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zm-test-"))
		try {
			const o = parseArgs([
				"--smoke",
				"--duration",
				"0.5",
				"--gap",
				"0",
				"--fft",
				"8192",
				"--fs",
				"250000",
				"--out",
				dir,
			])
			const out: string[] = []
			const res = await runBenchmark(o, { write: s => void out.push(s) })
			expect(res.cells.map(c => c.kind)).toEqual(["baseline", "zoom"])
			for (const f of ["samples.jsonl", "summary.json", "meta.json"]) {
				expect(existsSync(join(dir, f))).toBe(true)
			}
			const summary = JSON.parse(
				readFileSync(join(dir, "summary.json"), "utf8"),
			) as { cells: Record<string, unknown>[] }
			const zoom = summary.cells[1]!
			for (const k of [
				"coreFraction",
				"incrementalCore",
				"transformMs",
				"eventLoopP99Ms",
				"rssHighWaterBytes",
				"heapUsedHighWaterBytes",
				"missedDeadlines",
				"pass",
				"reasons",
				"ownedBytes",
				"rssOverBaselineBytes",
			]) {
				expect(zoom).toHaveProperty(k)
			}
			const meta = JSON.parse(
				readFileSync(join(dir, "meta.json"), "utf8"),
			) as Record<string, unknown>
			expect(meta).toHaveProperty("loadavgEnd")
			expect(meta).toHaveProperty("gitHead")
			const lines = readFileSync(join(dir, "samples.jsonl"), "utf8")
				.trim()
				.split("\n")
			expect(lines.length).toBeGreaterThanOrEqual(2) // one final sample per cell at least
			expect(out.join("")).toContain("| cell |")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 10_000)
})
