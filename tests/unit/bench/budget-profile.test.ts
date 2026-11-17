import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	bucketShares,
	callCounts,
	type CpuProfile,
	createModuleMapper,
	longTasks,
	moduleMatches,
	type PreciseCoverage,
} from "../../../scripts/bench/budget-profile.js"

const URL = "file:///w/dist/index.js"
/** Line 0 marks the manager, line 2 the websocket events module, line 4 the scanner service. */
const BUNDLE = [
	"// src/decoders/manager.ts",
	"function reconcilePlacementsPass() {}",
	"// src/api/websocket/events.ts",
	"function sendToClients() {}",
	"// src/core/scanner/scanner-service.ts",
	"function onTrack() {}",
].join("\n")

interface Frame {
	fn: string
	url?: string
	line?: number
}

/** A profile from stacks (root first) and per-sample durations (µs). */
function profileOf(
	samples: readonly { stack: readonly Frame[]; us: number }[],
): CpuProfile {
	const nodes: CpuProfile["nodes"] = [
		{
			id: 1,
			callFrame: { functionName: "(root)", url: "", lineNumber: -1 },
			children: [],
		},
		{ id: 2, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 } },
	]
	nodes[0]?.children?.push(2)
	const byPath = new Map<string, number>()
	let next = 3
	const leafOf = (stack: readonly Frame[]): number => {
		if (stack.length === 1 && stack[0]?.fn === "(idle)") return 2
		let parent = 1
		let path = ""
		for (const f of stack) {
			path += `>${f.fn}@${f.url ?? ""}:${f.line ?? 0}`
			let id = byPath.get(path)
			if (id === undefined) {
				id = next++
				byPath.set(path, id)
				nodes.push({
					id,
					callFrame: {
						functionName: f.fn,
						url: f.url ?? "",
						lineNumber: f.line ?? 0,
					},
					children: [],
				})
				nodes.find(n => n.id === parent)?.children?.push(id)
			}
			parent = id
		}
		return parent
	}
	const ids = samples.map(s => leafOf(s.stack))
	// Sample i's time is timeDeltas[i + 1]; a trailing idle sample carries the last one.
	return {
		nodes,
		startTime: 0,
		endTime: samples.reduce((s, x) => s + x.us, 0),
		samples: [...ids, 2],
		timeDeltas: [0, ...samples.map(s => s.us)],
	}
}

const manager: Frame = { fn: "reconcilePlacementsPass", url: URL, line: 1 }
const events: Frame = { fn: "sendToClients", url: URL, line: 3 }
const scanner: Frame = { fn: "onTrack", url: URL, line: 5 }
const idle = [{ fn: "(idle)" }] as const

describe("bucketShares", () => {
	it("gives a sample to the first rule in order that matches any frame on its stack", () => {
		const p = profileOf([
			// C1 (reconcile) is below B3 (ws) in the rule order: the ws frame wins.
			{ stack: [manager, events], us: 1000 },
			{ stack: [manager], us: 3000 },
			{ stack: idle, us: 4000 },
		])
		const r = bucketShares(p, BUNDLE, { isBundleUrl: u => u === URL })
		const by = Object.fromEntries(r.buckets.map(b => [b.id, b]))
		expect(r.totalUs).toBe(8000)
		expect(r.idleUs).toBe(4000)
		expect(r.busyUs).toBe(4000)
		expect(by["B3"]?.share).toBeCloseTo(0.25, 12)
		expect(by["C1"]?.share).toBeCloseTo(0.75, 12)
		expect(r.buckets.some(b => b.id === "idle")).toBe(false)
	})

	it("counts a recursive stack once", () => {
		const p = profileOf([{ stack: [scanner, scanner, scanner], us: 2000 }])
		const r = bucketShares(p, BUNDLE)
		expect(r.busyUs).toBe(2000)
		expect(r.buckets.find(b => b.id === "D4")?.us).toBe(2000)
		expect(r.buckets.reduce((s, b) => s + b.us, 0)).toBe(2000)
	})

	it("reports native write time inside its bucket", () => {
		const p = profileOf([
			{ stack: [events, { fn: "writev" }], us: 500 },
			{ stack: [events], us: 1500 },
		])
		const b3 = bucketShares(p, BUNDLE).buckets.find(b => b.id === "B3")
		expect(b3?.share).toBeCloseTo(1, 12)
		expect(b3?.nativeWriteShare).toBeCloseTo(0.25, 12)
	})

	it("puts unmatched frames in Z and GC in its own bucket", () => {
		const p = profileOf([
			{ stack: [{ fn: "mystery", url: "file:///elsewhere.js" }], us: 100 },
			{ stack: [{ fn: "(garbage collector)" }], us: 300 },
		])
		const by = Object.fromEntries(
			bucketShares(p, BUNDLE).buckets.map(b => [b.id, b.share]),
		)
		expect(by["Z"]).toBeCloseTo(0.25, 12)
		expect(by["GC"]).toBeCloseTo(0.75, 12)
	})

	it("busy shares sum to 1 within 1e-9", () => {
		const frames = [
			manager,
			events,
			scanner,
			{ fn: "(program)" },
			{ fn: "x", url: "node:internal/timers" },
		]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						stack: fc.array(fc.integer({ min: 0, max: frames.length - 1 }), {
							minLength: 1,
							maxLength: 4,
						}),
						us: fc.integer({ min: 1, max: 5000 }),
						idle: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 40 },
				),
				rows => {
					fc.pre(rows.some(r => !r.idle))
					const p = profileOf(
						rows.map(r => ({
							stack: r.idle ? idle : r.stack.map(i => frames[i] ?? manager),
							us: r.us,
						})),
					)
					const shares = bucketShares(p, BUNDLE).buckets.reduce(
						(s, b) => s + b.share,
						0,
					)
					expect(Math.abs(shares - 1)).toBeLessThan(1e-9)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("longTasks", () => {
	it("splits a run at an idle sample into two tasks", () => {
		const p = profileOf([
			{ stack: [manager], us: 30_000 },
			{ stack: [events], us: 30_000 },
			{ stack: idle, us: 1_000 },
			{ stack: [manager], us: 40_000 },
			{ stack: [manager], us: 40_000 },
		])
		const r = longTasks(p, 50, { bundleText: BUNDLE })
		expect(r.count).toBe(2)
		expect(r.top.map(t => t.durationMs)).toEqual([80, 60])
		expect(r.top[0]?.startMs).toBe(61)
		expect(r.top[1]?.startMs).toBe(0)
		expect(r.top[1]?.buckets["C1"]).toBeCloseTo(0.5, 12)
		expect(r.top[1]?.buckets["B3"]).toBeCloseTo(0.5, 12)
		expect(r.totalMs).toBe(140)
	})

	it("takes a run at the threshold and drops one just under it", () => {
		const at = profileOf([{ stack: [manager], us: 50_000 }])
		const under = profileOf([{ stack: [manager], us: 49_999 }])
		expect(longTasks(at, 50).count).toBe(1)
		expect(longTasks(under, 50).count).toBe(0)
		expect(longTasks(under, 49.999).count).toBe(1)
	})

	it("returns at most 10, longest first", () => {
		const rows = []
		for (let i = 1; i <= 12; i++) {
			rows.push({ stack: [manager], us: 50_000 + i })
			rows.push({ stack: idle, us: 10 })
		}
		const r = longTasks(profileOf(rows), 50)
		expect(r.count).toBe(12)
		expect(r.top).toHaveLength(10)
		expect(r.top[0]?.durationMs).toBe(50.012)
	})
})

describe("module mapping", () => {
	it("maps a line to the last marker at or before it", () => {
		const m = createModuleMapper({
			bundleText: BUNDLE,
			isBundleUrl: u => u === URL,
		})
		expect(m.moduleOf(URL, 0)).toBe("src/decoders/manager.ts")
		expect(m.moduleOf(URL, 1)).toBe("src/decoders/manager.ts")
		expect(m.moduleOf(URL, 2)).toBe("src/api/websocket/events.ts")
		expect(m.moduleOf(URL, 99)).toBe("src/core/scanner/scanner-service.ts")
		expect(m.moduleOf("file:///a/node_modules/zod/lib/index.js", 3)).toBe(
			"nm/zod/lib/index.js",
		)
		expect(m.moduleOf("", 0)).toBe("native")
		const before = createModuleMapper({
			bundleText: `x\n${BUNDLE}`,
			isBundleUrl: u => u === URL,
		})
		expect(before.moduleOf(URL, 0)).toBe("prelude")
	})

	it("matches path suffixes and package names", () => {
		expect(
			moduleMatches("src/core/fanout-manager.ts", "fanout-manager.ts"),
		).toBe(true)
		expect(
			moduleMatches("src/core/my-fanout-manager.ts", "fanout-manager.ts"),
		).toBe(false)
		expect(
			moduleMatches(
				"node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js",
				"zod",
			),
		).toBe(true)
		expect(moduleMatches("node_modules/zod-x/index.js", "zod")).toBe(false)
	})
})

describe("callCounts", () => {
	const offsetOfLine = (line: number): number =>
		BUNDLE.split("\n")
			.slice(0, line)
			.reduce((s, l) => s + l.length + 1, 0)
	const fnAt = (functionName: string, line: number, count: number) => ({
		functionName,
		ranges: [
			{
				startOffset: offsetOfLine(line),
				endOffset: offsetOfLine(line) + 5,
				count,
			},
		],
		isBlockCoverage: false,
	})

	it("counts by name and owning module, summing same-named functions and reporting absent ones as null", () => {
		const coverage: PreciseCoverage = [
			{
				url: URL,
				functions: [
					fnAt("reconcilePlacementsPass", 1, 7),
					fnAt("reconcilePlacementsPass", 1, 3),
					// Same name in another module: not the listed function.
					fnAt("onTrack", 3, 100),
					fnAt("onTrack", 5, 4),
				],
			},
		]
		const counts = callCounts(
			coverage,
			BUNDLE,
			[
				{ name: "reconcilePlacementsPass", module: "decoders/manager.ts" },
				{ name: "onTrack", module: "scanner/scanner-service.ts" },
				{ name: "ingest", module: "spectrum/spectrum-engine.ts" },
			],
			{ isBundleUrl: u => u === URL },
		)
		expect(counts).toEqual({
			reconcilePlacementsPass: 10,
			onTrack: 4,
			ingest: null,
		})
	})

	it("maps a function that starts exactly on a marker line to that marker's module", () => {
		const coverage: PreciseCoverage = [
			{
				url: URL,
				functions: [fnAt("sendToClients", 2, 9), fnAt("sendToClients", 1, 5)],
			},
		]
		const counts = callCounts(
			coverage,
			BUNDLE,
			[{ name: "sendToClients", module: "api/websocket/events.ts" }],
			{ isBundleUrl: u => u === URL },
		)
		expect(counts["sendToClients"]).toBe(9)
	})

	it("reads an unbundled package by its URL", () => {
		const coverage: PreciseCoverage = [
			{
				url: "file:///a/node_modules/zod/lib/types.js",
				functions: [
					{
						functionName: "safeParse",
						ranges: [{ startOffset: 0, endOffset: 1, count: 12 }],
					},
				],
			},
		]
		expect(
			callCounts(coverage, "", [{ name: "safeParse", module: "zod" }])[
				"safeParse"
			],
		).toBe(12)
	})
})
