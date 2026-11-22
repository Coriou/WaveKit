import { describe, expect, it } from "vitest"
import {
	compareManifests,
	formatComparison,
	IQ_DISAGREEMENT_MAX,
	iqSecondsOf,
	LOAD_P95_MAX,
	type Manifest,
	ManifestSchema,
	percentile,
	perIqSecond,
	REFERENCE_HOST_CPUS,
	roundWindowUp,
	RUN_QUEUE_WAIT_P95_MAX,
	spread,
	timingValidity,
} from "../../../scripts/bench/budget-manifest.js"

function manifest(
	over: Partial<Manifest> = {},
	results: Partial<Manifest["results"]> = {},
): Manifest {
	const base: Manifest = {
		schema: 2,
		label: "a",
		tier: "A",
		commit: { sha: "abc", dirty: false },
		core: {
			path: "/w/dist/index.js",
			sha256: "c0",
			imageId: null,
			overlay: null,
		},
		scene: { id: "budget-1024000", sha256: "s0", fixtures: "modelled" },
		composition: {
			parts: { spectrum: "real" },
			clients: 1,
			passive: true,
			notes: [],
			listenersChecked: true,
		},
		profiledTimingWindow: false,
		coverage: { classes: {}, missing: [], unknown: [] },
		rateHz: 1_024_000,
		startUtc: "2026-01-01T00:00:00.000Z",
		endUtc: "2026-01-01T00:01:00.000Z",
		windowSeconds: 60,
		windowSecondsRequested: 60,
		warmupSeconds: 20,
		iqSeconds: 60,
		iqSecondsFake: 60,
		iqSecondsDisagreement: 0,
		warnings: [],
		host: {
			platform: "linux",
			cpus: 8,
			loadSamples: [1, 2],
			load: { p50: 1, p95: 2, max: 2 },
			outerLoad: null,
		},
		runQueueWaitShare: { p50: 0.01, p95: 0.01, max: 0.01 },
		timingValid: true,
		timingInvalidReasons: [],
		results: {
			mainCpuMsPerIqSecond: 400,
			processCpuMsPerIqSecond: 800,
			workers: [],
			workersUnknownReason: null,
			threads: null,
			children: [],
			childrenUnknownReason: null,
			elu: 0.5,
			loopDelayMs: { p50: 1, p99: 10, max: 40 },
			gc: { minor: { count: 10, ms: 5 } },
			contextSwitches: { voluntary: 100, involuntary: 10 },
			writesPerSecond: { tcp: { count: 50, bytes: 1000 } },
			structuredClonePerSecond: 2,
			ws: [],
			sourceChunksPerSecond: 64,
			sourceSkippedSeconds: 0,
			buckets: null,
			profileBusyShare: null,
			longTasks: null,
			callsPerSecond: null,
			...results,
		},
		...over,
	}
	return ManifestSchema.parse(base)
}

describe("summary maths", () => {
	it("takes nearest-rank percentiles of finite values", () => {
		expect(percentile([3, 1, 2, 4], 50)).toBe(2)
		expect(percentile([3, 1, 2, 4], 95)).toBe(4)
		expect(percentile([5], 0)).toBe(5)
		expect(percentile([], 50)).toBeNull()
		expect(percentile([Number.NaN, 7], 50)).toBe(7)
		expect(spread([2, 9, 4])).toEqual({ p50: 4, p95: 9, max: 9 })
		expect(spread([])).toEqual({ p50: null, p95: null, max: null })
	})

	it("divides by IQ seconds only when both sides are known", () => {
		expect(perIqSecond(500, 50)).toBe(10)
		expect(perIqSecond(500, 0)).toBeNull()
		expect(perIqSecond(null, 10)).toBeNull()
		expect(perIqSecond(500, Number.NaN)).toBeNull()
	})
})

describe("timingValidity", () => {
	const under = (bound: number): number => bound - 1e-9
	it("is valid below the load bound with a run-queue figure below its bound", () => {
		const v = timingValidity({
			loadSamples: [under(LOAD_P95_MAX)],
			runQueueWaitP95: under(RUN_QUEUE_WAIT_P95_MAX),
		})
		expect(v).toEqual({ timingValid: true, timingInvalidReasons: [] })
	})

	it("fails at the load bound and past it", () => {
		for (const load of [LOAD_P95_MAX, LOAD_P95_MAX + 5]) {
			const v = timingValidity({ loadSamples: [load], runQueueWaitP95: 0 })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons).toHaveLength(1)
			expect(v.timingInvalidReasons[0]).toMatch(/load average p95/)
		}
	})

	it("fails at the run-queue bound and past it", () => {
		for (const rq of [RUN_QUEUE_WAIT_P95_MAX, 0.5]) {
			const v = timingValidity({ loadSamples: [1], runQueueWaitP95: rq })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons).toHaveLength(1)
			expect(v.timingInvalidReasons[0]).toMatch(/run-queue wait share p95/)
		}
	})

	it("without a run-queue figure trusts only a load below the reference core count", () => {
		expect(
			timingValidity({
				loadSamples: [under(REFERENCE_HOST_CPUS)],
				runQueueWaitP95: null,
			}).timingValid,
		).toBe(true)
		for (const load of [REFERENCE_HOST_CPUS, 20]) {
			const v = timingValidity({ loadSamples: [load], runQueueWaitP95: null })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons[0]).toMatch(/no run-queue wait figure/)
		}
	})

	it("adds one reason per failed condition", () => {
		const v = timingValidity({ loadSamples: [40], runQueueWaitP95: 0.2 })
		expect(v.timingInvalidReasons).toHaveLength(2)
		const u = timingValidity({ loadSamples: [40], runQueueWaitP95: null })
		expect(u.timingInvalidReasons).toHaveLength(2)
	})

	it("uses the p95 of the samples, not the last one", () => {
		const samples = [...Array.from({ length: 19 }, () => 2), 50]
		// 20 samples: the 95th percentile is the 19th smallest, 2.
		expect(
			timingValidity({ loadSamples: samples, runQueueWaitP95: 0 }).timingValid,
		).toBe(true)
		expect(
			timingValidity({ loadSamples: [...samples, 50], runQueueWaitP95: 0 })
				.timingValid,
		).toBe(false)
	})

	it("answers false for malformed or missing inputs", () => {
		for (const loadSamples of [
			undefined,
			null,
			"3",
			[],
			[1, "2"],
			[Number.NaN],
			[-1],
		]) {
			const v = timingValidity({ loadSamples, runQueueWaitP95: 0 })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons.length).toBeGreaterThan(0)
		}
		for (const runQueueWaitP95 of ["0.01", Number.NaN, -0.1, {}]) {
			const v = timingValidity({ loadSamples: [1], runQueueWaitP95 })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons).toEqual([
				"run-queue wait share is malformed",
			])
		}
	})
})

describe("compareManifests", () => {
	it("refuses a different tier, scene, rate or composition", () => {
		const a = manifest()
		const cases: [Partial<Manifest>, RegExp][] = [
			[{ tier: "B" }, /tier/],
			[{ scene: { ...a.scene, sha256: "other" } }, /scene/],
			[{ rateHz: 2_400_000 }, /rate/],
			[{ composition: { ...a.composition, clients: 2 } }, /composition/],
			[
				{ composition: { ...a.composition, parts: { spectrum: "absent" } } },
				/composition/,
			],
		]
		for (const [over, rx] of cases) {
			const r = compareManifests(a, manifest(over))
			expect(r.ok).toBe(false)
			if (!r.ok) expect(r.refusal).toMatch(rx)
		}
	})

	it("ignores key order inside the composition", () => {
		const a = manifest({
			composition: {
				parts: { spectrum: "real", channelizer: "absent" },
				clients: 1,
				passive: true,
				notes: [],
				listenersChecked: true,
			},
		})
		const b = manifest({
			composition: {
				listenersChecked: true,
				notes: [],
				passive: true,
				clients: 1,
				parts: { channelizer: "absent", spectrum: "real" },
			},
		})
		expect(compareManifests(a, b).ok).toBe(true)
	})

	it("lists CPU and count rows with the change, and timing rows when both are timing-valid", () => {
		const a = manifest()
		const b = manifest({ label: "b" }, { mainCpuMsPerIqSecond: 300, elu: 0.25 })
		const r = compareManifests(a, b)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		const main = r.rows.find(x => x.figure === "main-thread CPU ms per IQ s")
		expect(main).toEqual({
			figure: "main-thread CPU ms per IQ s",
			a: 400,
			b: 300,
			changePct: -25,
		})
		expect(r.rows.some(x => x.figure === "tcp writes per s")).toBe(true)
		expect(r.timingRows?.find(x => x.figure === "ELU")?.changePct).toBe(-50)
		const text = formatComparison(a, b, r)
		expect(text).toMatch(
			/\| main-thread CPU ms per IQ s \| 400 \| 300 \| -25\.0 % \|/,
		)
		expect(text).toMatch(/\| ELU \|/)
	})

	it("suppresses timing rows and says which manifest is not timing-valid and why", () => {
		const a = manifest()
		const b = manifest({
			label: "loaded",
			timingValid: false,
			timingInvalidReasons: ["load average p95 41.00 is not below 30"],
		})
		const r = compareManifests(a, b)
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.timingRows).toBeNull()
		expect(r.notes).toHaveLength(1)
		expect(r.notes[0]).toMatch(/B \(loaded\): load average p95 41\.00/)
		expect(r.notes[0]).not.toMatch(/A \(a\)/)
		const text = formatComparison(a, b, r)
		expect(text).not.toMatch(/\| ELU \|/)
		expect(text).not.toMatch(/\| loop delay/)
	})

	it("gives no change when the before figure is zero or unknown", () => {
		const a = manifest(
			{},
			{ structuredClonePerSecond: 0, sourceChunksPerSecond: null },
		)
		const r = compareManifests(a, manifest())
		if (!r.ok) throw new Error(r.refusal)
		expect(
			r.rows.find(x => x.figure === "structuredClone per s")?.changePct,
		).toBeNull()
		expect(
			r.rows.find(x => x.figure === "source chunks per s")?.changePct,
		).toBeNull()
	})

	it("notes when only one timing window was profiled", () => {
		const r = compareManifests(
			manifest(),
			manifest({ profiledTimingWindow: true }),
		)
		if (!r.ok) throw new Error(r.refusal)
		expect(r.notes.some(n => /profiled/.test(n))).toBe(true)
	})
})

describe("window rounding", () => {
	it("keeps a whole multiple of the scene period", () => {
		expect(roundWindowUp(60, 20)).toEqual({ seconds: 60, rounded: false })
		expect(roundWindowUp(20, 20)).toEqual({ seconds: 20, rounded: false })
	})

	it("rounds anything else up to the next multiple", () => {
		expect(roundWindowUp(41, 20)).toEqual({ seconds: 60, rounded: true })
		expect(roundWindowUp(10, 20)).toEqual({ seconds: 20, rounded: true })
		expect(roundWindowUp(59.5, 20)).toEqual({ seconds: 60, rounded: true })
	})
})

describe("IQ seconds", () => {
	it("divides the core's source bytes by two bytes per sample at the rate", () => {
		const r = iqSecondsOf({
			sourceBytes: 2 * 1_024_000 * 30,
			rateHz: 1_024_000,
			fakeIqSeconds: 30,
		})
		expect(r.iqSeconds).toBe(30)
		expect(r.iqSecondsFake).toBe(30)
		expect(r.iqSecondsDisagreement).toBe(0)
		expect(r.warnings).toEqual([])
	})

	it("warns, outside timing validity, when the fake disagrees by more than 1 %", () => {
		const bytes = 2 * 1_000_000 * 30
		const at = iqSecondsOf({
			sourceBytes: bytes,
			rateHz: 1_000_000,
			fakeIqSeconds: 30 / (1 + IQ_DISAGREEMENT_MAX / 2),
		})
		expect(at.warnings).toEqual([])
		const past = iqSecondsOf({
			sourceBytes: bytes,
			rateHz: 1_000_000,
			fakeIqSeconds: 29.5,
		})
		expect(past.iqSeconds).toBe(30)
		expect(past.iqSecondsDisagreement).toBeCloseTo(0.5 / 29.5, 12)
		expect(past.warnings).toEqual(["IQ seconds disagree by more than 1 %"])
	})

	it("falls back to the fake's figure with a warning when the core has no count", () => {
		const r = iqSecondsOf({
			sourceBytes: null,
			rateHz: 1_024_000,
			fakeIqSeconds: 12,
		})
		expect(r.iqSeconds).toBe(12)
		expect(r.iqSecondsDisagreement).toBeNull()
		expect(r.warnings[0]).toMatch(/IQ seconds come from the fake/)
	})
})

describe("timingValidity in tier B", () => {
	const ok = { loadSamples: [1], runQueueWaitP95: 0.01 }
	it("is valid with outer load samples below the bound", () => {
		expect(
			timingValidity({
				...ok,
				tier: "B",
				outerLoadSamples: [1, LOAD_P95_MAX - 1e-9],
			}),
		).toEqual({ timingValid: true, timingInvalidReasons: [] })
	})

	it("fails at the outer bound and past it", () => {
		for (const outer of [LOAD_P95_MAX, LOAD_P95_MAX + 10]) {
			const v = timingValidity({
				...ok,
				tier: "B",
				outerLoadSamples: [outer],
			})
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons).toHaveLength(1)
			expect(v.timingInvalidReasons[0]).toMatch(/outer host load average p95/)
		}
	})

	it("fails on missing or malformed outer samples", () => {
		for (const outerLoadSamples of [
			undefined,
			null,
			[],
			[1, null],
			[Number.NaN],
			"2",
		]) {
			const v = timingValidity({ ...ok, tier: "B", outerLoadSamples })
			expect(v.timingValid).toBe(false)
			expect(v.timingInvalidReasons[0]).toMatch(
				/no valid outer host load samples/,
			)
		}
	})

	it("ignores outer samples in tier A", () => {
		expect(timingValidity({ ...ok, outerLoadSamples: [99] }).timingValid).toBe(
			true,
		)
	})
})

describe("compareManifests window and coverage", () => {
	it("refuses window lengths more than 2 % apart", () => {
		const a = manifest()
		expect(compareManifests(a, manifest({ windowSeconds: 61 })).ok).toBe(true)
		const r = compareManifests(a, manifest({ windowSeconds: 62 }))
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.refusal).toMatch(/window length/)
	})

	it("refuses different missing or unknown classes unless allowed, then notes them", () => {
		const a = manifest({
			coverage: { classes: {}, missing: ["recorderSessions"], unknown: [] },
		})
		const b = manifest({
			coverage: { classes: {}, missing: [], unknown: ["placementPasses"] },
		})
		const r = compareManifests(a, b)
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.refusal).toMatch(/recorderSessions/)
			expect(r.refusal).toMatch(/placementPasses/)
			expect(r.refusal).toMatch(/--allow-coverage-diff/)
		}
		const allowed = compareManifests(a, b, { allowCoverageDiff: true })
		expect(allowed.ok).toBe(true)
		if (allowed.ok) {
			const note = allowed.notes.find(n => n.startsWith("Coverage differs"))
			expect(note).toMatch(/missing in one run only: recorderSessions/)
			expect(note).toMatch(/unknown in one run only: placementPasses/)
		}
		expect(compareManifests(a, manifest({ coverage: a.coverage })).ok).toBe(
			true,
		)
	})

	it("reports GC and long tasks per window second", () => {
		const lt = {
			thresholdMs: 50,
			count: 6,
			totalMs: 600,
			top: [{ startMs: 0, durationMs: 120, buckets: {} }],
		}
		const a = manifest(
			{},
			{ gc: { minor: { count: 60, ms: 30 } }, longTasks: lt },
		)
		const b = manifest(
			{ label: "b", windowSeconds: 60.6 },
			{ gc: { minor: { count: 121.2, ms: 30.3 } }, longTasks: lt },
		)
		const r = compareManifests(a, b)
		if (!r.ok) throw new Error(r.refusal)
		const gcCount = r.rows.find(x => x.figure === "GC minor count per window s")
		expect(gcCount?.a).toBe(1)
		expect(gcCount?.b).toBeCloseTo(2, 12)
		expect(
			r.rows.find(x => x.figure === "GC minor ms per window s")?.a,
		).toBeCloseTo(0.5, 12)
		expect(
			r.timingRows?.find(x => x.figure === "long tasks per window s")?.a,
		).toBe(0.1)
		expect(
			r.timingRows?.find(x => x.figure === "long task ms per window s")?.a,
		).toBe(10)
	})
})

describe("compareManifests starvation rows", () => {
	const starvation = (
		hog: number,
		elu: number,
		lost: number,
	): NonNullable<Manifest["starvation"]> => ({
		hog: {
			requested: String(hog),
			count: hog,
			startedPids: [],
			stoppedPids: [],
			killedPids: [],
			survivorPids: [],
			startUtc: null,
			stopUtc: null,
			settleSeconds: 10,
			nice: 0,
		},
		coreNice: { requested: 10, effective: 10, harness: 0 },
		coreQos: {
			requested: hog > 0 ? "background" : "default",
			command: hog > 0 ? ["/usr/sbin/taskpolicy", "-b"] : [],
			psPri: hog > 0 ? 4 : 31,
			effective: hog > 0 ? "background" : "default",
		},
		edgeReads: { startMs: 12, endMs: hog > 0 ? 900 : 15 },
		loadavg: { windowStart: [4, 3, 2], windowEnd: [9, 5, 3] },
		loop: {
			elu,
			p50Ms: 1,
			p99Ms: 10,
			p999Ms: 50,
			maxMs: 90,
			stalls: {
				resolutionMs: 50,
				thresholdMs: 50,
				count: 2,
				totalMs: 300,
				over100: 1,
				over500: 0,
				over1000: 0,
				top: [{ atUtc: "2026-11-22T00:00:00.000Z", ms: 200 }],
			},
		},
		stages: [
			{
				id: "fanout:x",
				label: "x",
				order: 3,
				inSamples: 1000,
				outSamples: 1000 - lost,
				droppedSamples: lost,
				toleranceSamples: 0,
				source: "t",
				reset: hog > 0,
				lostSamples: lost,
				lossShare: lost / 1000,
				losing: lost > 0,
			},
		],
		firstLosingStage:
			lost > 0
				? {
						id: "fanout:x",
						label: "x",
						lostSamples: lost,
						lossShare: lost / 1000,
					}
				: null,
		unknownBeforeFirstLoss: [],
		gaps: [],
	})

	it("prints ELU, delays, load and per-stage loss even when timing is not valid", () => {
		const a = manifest({ starvation: starvation(0, 0.5, 0) })
		const b = manifest({
			label: "b",
			timingValid: false,
			timingInvalidReasons: ["load"],
			starvation: starvation(8, 1, 20),
		})
		expect(ManifestSchema.safeParse(b).success).toBe(true)
		const r = compareManifests(a, b)
		if (!r.ok) throw new Error(r.refusal)
		expect(r.timingRows).toBeNull()
		const rows = r.starvationRows ?? []
		const get = (f: string) => rows.find(x => x.figure === f)
		expect(get("ELU")).toMatchObject({ a: 0.5, b: 1 })
		expect(get("hog children")).toMatchObject({ a: 0, b: 8 })
		expect(get("load1 at window end")).toMatchObject({ a: 9, b: 9 })
		expect(get("loop delay p99.9 ms")).toMatchObject({ a: 50, b: 50 })
		expect(get("core ps pri (QoS)")).toMatchObject({ a: 31, b: 4 })
		expect(get("edge B read ms")).toMatchObject({ a: 15, b: 900 })
		expect(r.notes.join("\n")).toContain(
			"Core QoS: A default (effective default) | B background (effective background)",
		)
		expect(r.notes.join("\n")).toContain(
			"Counter resets (delta unknown): A none | B fanout:x",
		)
		expect(get("stage fanout:x lost samples")).toMatchObject({ a: 0, b: 20 })
		expect(get("stage fanout:x loss (%)")?.b).toBeCloseTo(2)
		expect(r.notes.join("\n")).toContain(
			"B (b): first losing stage fanout:x (x), 20 samples",
		)
		expect(formatComparison(a, b, r)).toContain("| ELU | 0.500 | 1.00 |")
	})

	it("has no starvation rows for manifests from before the starvation harness", () => {
		const r = compareManifests(manifest(), manifest({ label: "b" }))
		if (!r.ok) throw new Error(r.refusal)
		expect(r.starvationRows).toBeNull()
	})
})
