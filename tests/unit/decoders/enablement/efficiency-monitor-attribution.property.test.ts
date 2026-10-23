import fc from "fast-check"
import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"

const fixture = (overflow = false, sibling = false) => {
	let mono = 0
	let gap = 200
	let total = 0
	let siblingTotal = 0
	let loop = 0
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () =>
			new Map(
				overflow
					? [
							["a", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
							[
								"@absorber#1",
								{ droppedBytesTotal: total, droppedChunksTotal: total },
							],
						]
					: [
							["a", { droppedBytesTotal: total, droppedChunksTotal: total }],
							...(sibling
								? ([
										[
											"b",
											{
												droppedBytesTotal: siblingTotal,
												droppedChunksTotal: siblingTotal,
											},
										],
									] as const)
								: []),
						],
			),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => 0,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
		ingest: () => ({ maxGapMs: gap, catchupBytes: 0, chunks: 1 }),
		loopDelay: () => ({ maxMs: loop, p99Ms: 0 }),
		shortfall: () => false,
	})
	for (mono = 0; mono <= 4000; mono += 2000) monitor.sampleNow()
	mono = 4000
	return {
		monitor,
		step(code: "link" | "unknown" | "none" | "host" | "consumer") {
			mono += 2000
			gap = code === "unknown" || code === "host" ? 0 : 200
			loop = code === "host" ? 50 : 0
			if (code !== "none") {
				total++
				if (code !== "consumer") siblingTotal++
			}
			const sample = monitor.sampleNow()
			return { at: mono, code: sample.sources.get("s")?.attribution }
		},
	}
}
const sequence = fc.array(fc.constantFrom("link", "unknown", "none", "host"), {
	minLength: 1,
	maxLength: 150,
})

const allAttributions = fc.array(
	fc.constantFrom("link", "unknown", "none", "host", "consumer"),
	{ minLength: 1, maxLength: 150 },
)

// Feature: link-burst-resilience, Property 8: Link neither condemns nor credits (monitor half)
// Validates: Requirements 4.1, 4.2, 4.3
it("link intervals never add coverage or condemn", () => {
	fc.assert(
		fc.property(allAttributions, codes => {
			const h = fixture(false, true)
			let condemned = false
			for (const code of codes) {
				const before = h.monitor.coveredSinceMono("s", 4000)
				const sample = h.step(code)
				condemned ||= code !== "none" && code !== "link"
				expect(sample.code).toBe(code)
				expect(h.monitor.droppedSinceMono("s", 4000)).toBe(condemned)
				expect(h.monitor.droppedBetweenMono("s", sample.at, sample.at)).toBe(
					code !== "none" && code !== "link",
				)
				if (code === "link")
					expect(h.monitor.coveredSinceMono("s", 4000)).toBe(before)
			}
		}),
		{ numRuns: 100 },
	)
})

// Feature: link-burst-resilience, Property 9: Clean window (monitor half)
// Validates: Requirements 4.4
it("link preserves the clean mark and other drops reset it", () => {
	fc.assert(
		fc.property(allAttributions, codes => {
			const h = fixture(false, true)
			for (const code of codes) {
				const clean = h.monitor.cleanAtMono("s")
				h.step(code)
				if (code === "link") expect(h.monitor.cleanAtMono("s")).toBe(clean)
				if (code !== "none" && code !== "link")
					expect(h.monitor.cleanAtMono("s")).toBeNull()
			}
		}),
		{ numRuns: 100 },
	)
})

// Feature: link-burst-resilience, Property 11: Overflow is drop evidence (monitor half)
// Validates: Requirements 1.6
it("overflow and all-branch loss have the same gate evidence", () => {
	fc.assert(
		fc.property(sequence, codes => {
			const branch = fixture()
			const overflow = fixture(true)
			for (const code of codes) {
				branch.step(code)
				overflow.step(code)
				expect(overflow.monitor.dropState("s")).toEqual(
					branch.monitor.dropState("s"),
				)
				expect(overflow.monitor.droppedSinceMono("s", 4000)).toBe(
					branch.monitor.droppedSinceMono("s", 4000),
				)
			}
		}),
		{ numRuns: 100 },
	)
})
