import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	Cu8Ring,
	ZoomSlice,
	evaluateCell,
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
}

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
