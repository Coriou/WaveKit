import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	computeDecodedElsewhere,
	toDecoderCoverageView,
} from "../../../../../src/core/scanner/plan/decoded-elsewhere.js"
import type {
	DecoderCoverageView,
	ScanRange,
} from "../../../../../src/core/scanner/types.js"
import type { DecoderStatus } from "../../../../../src/decoders/types.js"

type Band = NonNullable<DecoderCoverageView["band"]>

const JOB = "job-src"
const spec = (ranges: ScanRange[] = [{ startHz: 0, endHz: 2e9 }]) => ({
	sourceId: JOB,
	ranges,
})

function band(over: Partial<Band> = {}): Band {
	return {
		verdict: "in-band",
		basis: "configured",
		targetsHz: [100_000_000],
		rangesHz: [],
		captureCenterHz: 100_000_000,
		windowHalfWidthHz: 1_000_000,
		...over,
	}
}

function view(over: Partial<DecoderCoverageView> = {}): DecoderCoverageView {
	return {
		id: "d1",
		running: true,
		health: "running",
		suspended: false,
		owner: "config",
		sourceId: "other",
		inputKind: "iq",
		band: band(),
		...over,
	}
}

function ext(over: Partial<DecoderCoverageView> = {}): DecoderCoverageView {
	return view({ sourceId: null, inputKind: "external", band: band(), ...over })
}

const run = (views: DecoderCoverageView[], s = spec()) =>
	computeDecodedElsewhere(views, s)

describe("computeDecodedElsewhere trust exclusions", () => {
	const cases: [string, DecoderCoverageView][] = [
		["probe owner", view({ owner: "scanner" })],
		["suspended", view({ suspended: true })],
		["faulted", view({ health: "faulted" })],
		["restarting", view({ health: "restarting" })],
		["not running", view({ running: false })],
		["same source", view({ sourceId: JOB })],
		["out-of-band", view({ band: band({ verdict: "out-of-band" }) })],
		["unknown verdict", view({ band: band({ verdict: "unknown" }) })],
		["missing centre", view({ band: band({ captureCenterHz: null }) })],
		["missing width", view({ band: band({ windowHalfWidthHz: null }) })],
		[
			"target outside window",
			view({ band: band({ targetsHz: [101_000_001] }) }),
		],
		[
			"external region-default",
			ext({ band: band({ basis: "region-default" }) }),
		],
		[
			"external decoder-default",
			ext({ band: band({ basis: "decoder-default" }) }),
		],
		["external with inputKind iq", ext({ inputKind: "iq" })],
		["NaN target", view({ band: band({ targetsHz: [Number.NaN] }) })],
		["negative width", view({ band: band({ windowHalfWidthHz: -5 }) })],
		["Infinity width", view({ band: band({ windowHalfWidthHz: Infinity }) })],
		["Infinity target", ext({ band: band({ targetsHz: [Infinity] }) })],
		["null band", view({ band: null })],
		[
			"targetsHz not an array",
			view({ band: { ...band(), targetsHz: 5 as unknown as number[] } }),
		],
	]
	for (const [name, v] of cases) {
		it(`no coverage: ${name}`, () => {
			expect(run([v])).toEqual({ ranges: [], truncated: false })
		})
	}

	it("no coverage and no throw: band getter throws", () => {
		const bad = view({ id: "bad" })
		Object.defineProperty(bad, "band", {
			get() {
				throw new Error("boom")
			},
		})
		const res = run([bad, view({ id: "ok" })])
		expect(res.ranges).toHaveLength(1)
		expect(res.ranges[0]?.decoderIds).toEqual(["ok"])
	})
})

describe("computeDecodedElsewhere coverage", () => {
	it("WaveKit target clipped to the window", () => {
		const v = view({ band: band({ targetsHz: [100_998_000] }) })
		expect(run([v]).ranges).toEqual([
			{
				startHz: 100_991_750,
				endHz: 101_000_000,
				sourceId: "other",
				decoderIds: ["d1"],
				applied: false,
			},
		])
	})

	it("band range intersected with the window", () => {
		const v = view({
			band: band({
				targetsHz: [],
				rangesHz: [{ minHz: 98e6, maxHz: 100.5e6 }],
			}),
		})
		expect(run([v]).ranges).toMatchObject([{ startHz: 99e6, endHz: 100.5e6 }])
	})

	it("ignores malformed band ranges", () => {
		const v = view({
			band: band({
				targetsHz: [],
				rangesHz: [
					{ minHz: 100.5e6, maxHz: 100.4e6 },
					{ minHz: Number.NaN, maxHz: 100e6 },
					{ minHz: 102e6, maxHz: 103e6 },
				],
			}),
		})
		expect(run([v]).ranges).toEqual([])
	})

	it("external target covers ±6250 without a window", () => {
		const v = ext({
			band: band({
				captureCenterHz: null,
				windowHalfWidthHz: null,
				targetsHz: [162e6],
			}),
		})
		expect(run([v]).ranges).toEqual([
			{
				startHz: 161_993_750,
				endHz: 162_006_250,
				sourceId: null,
				decoderIds: ["d1"],
				applied: false,
			},
		])
	})

	it("external accepts protocol and override basis, ignores ranges", () => {
		for (const basis of ["protocol", "override"] as const) {
			const v = ext({
				band: band({
					basis,
					targetsHz: [1e6],
					rangesHz: [{ minHz: 5e6, maxHz: 6e6 }],
				}),
			})
			expect(run([v]).ranges).toMatchObject([
				{ startHz: 993_750, endHz: 1_006_250 },
			])
		}
	})

	it("clips to enabled ranges only, possibly in several pieces", () => {
		const v = view({
			band: band({ targetsHz: [], rangesHz: [{ minHz: 99e6, maxHz: 101e6 }] }),
		})
		const res = run(
			[v],
			spec([
				{ startHz: 99.2e6, endHz: 99.4e6 },
				{ startHz: 99.5e6, endHz: 99.7e6, enabled: false },
				{ startHz: 100.5e6, endHz: 102e6 },
			]),
		)
		expect(res.ranges.map(r => [r.startHz, r.endHz])).toEqual([
			[99.2e6, 99.4e6],
			[100.5e6, 101e6],
		])
	})

	it("merges touching and overlapping intervals across decoders, uniting ids", () => {
		const a = view({
			id: "b",
			band: band({
				targetsHz: [],
				rangesHz: [{ minHz: 99.5e6, maxHz: 100e6 }],
			}),
		})
		const b = view({
			id: "a",
			band: band({
				targetsHz: [],
				rangesHz: [{ minHz: 100e6, maxHz: 100.2e6 }],
			}),
		})
		const c = view({
			id: "a",
			band: band({
				targetsHz: [],
				rangesHz: [{ minHz: 100.1e6, maxHz: 100.3e6 }],
			}),
		})
		expect(run([a, b, c]).ranges).toEqual([
			{
				startHz: 99.5e6,
				endHz: 100.3e6,
				sourceId: "other",
				decoderIds: ["a", "b"],
				applied: false,
			},
		])
	})

	it("keeps sources separate and sorts by start then source with null last", () => {
		const r = band({
			targetsHz: [],
			rangesHz: [{ minHz: 99.5e6, maxHz: 100e6 }],
		})
		const res = run([
			ext({ id: "e", band: band({ targetsHz: [99.5e6] }) }),
			view({ id: "z", sourceId: "zeta", band: r }),
			view({ id: "a", sourceId: "alpha", band: r }),
			view({ id: "x", sourceId: "x", band: band({ targetsHz: [99.2e6] }) }),
		])
		expect(res.ranges.map(e => [e.startHz, e.sourceId])).toEqual([
			[99_193_750, "x"],
			[99_493_750, null],
			[99.5e6, "alpha"],
			[99.5e6, "zeta"],
		])
	})

	it("returns nothing for no views or no enabled range", () => {
		expect(run([])).toEqual({ ranges: [], truncated: false })
		expect(
			run([view()], spec([{ startHz: 0, endHz: 2e9, enabled: false }])),
		).toEqual({
			ranges: [],
			truncated: false,
		})
	})
})

describe("computeDecodedElsewhere bounds", () => {
	const distinct = (n: number) =>
		Array.from({ length: n }, (_, i) =>
			view({ id: `d${i}`, band: band({ targetsHz: [99.1e6 + i * 20_000] }) }),
		)

	it("64 decoders: all examined, not truncated", () => {
		const res = run(distinct(64))
		expect(res.ranges).toHaveLength(64)
		expect(res.truncated).toBe(false)
	})

	it("65 decoders: the 65th is ignored, truncated", () => {
		const res = run(distinct(65))
		expect(res.ranges).toHaveLength(64)
		expect(res.ranges.some(r => r.decoderIds.includes("d64"))).toBe(false)
		expect(res.truncated).toBe(true)
	})

	it("stopped views use slots: 64 stopped then a covering view yields nothing, no warning", () => {
		const res = run(
			Array.from({ length: 64 }, (_, i) =>
				view({ id: `u${i}`, running: false }),
			).concat(distinct(1)),
		)
		expect(res).toEqual({ ranges: [], truncated: false })
		expect(
			run(Array.from({ length: 65 }, () => view({ running: false }))),
		).toEqual({ ranges: [], truncated: false })
	})

	it("64 covering views then a throwing view 65: never read, truncated", () => {
		let reads = 0
		const views = distinct(64)
		Object.defineProperty(views, 64, {
			get() {
				reads++
				throw new Error("overflow read")
			},
		})
		const res = run(views)
		expect(reads).toBe(0)
		expect(res.ranges).toHaveLength(64)
		expect(res.truncated).toBe(true)
	})

	it("65 out-of-band views: no coverage, no warning", () => {
		const res = run(
			Array.from({ length: 65 }, () =>
				view({ band: band({ verdict: "out-of-band" }) }),
			),
		)
		expect(res).toEqual({ ranges: [], truncated: false })
	})

	it("past the item budget with no coverage: no warning", () => {
		const targetsHz = [...Array<number>(32).fill(NaN), 100_000_000]
		expect(run([view({ band: band({ targetsHz }) })])).toEqual({
			ranges: [],
			truncated: false,
		})
	})

	it("32 targets then a throwing element: the overflow is never read", () => {
		const targetsHz = Array.from({ length: 33 }, (_, i) => 99.1e6 + i * 20_000)
		Object.defineProperty(targetsHz, 32, {
			get() {
				throw new Error("overflow read")
			},
		})
		const res = run([view({ band: band({ targetsHz }) })])
		expect(res.ranges).toHaveLength(32)
		expect(res.truncated).toBe(true)
	})

	it("an external target list past the bound is never read past it", () => {
		const targetsHz = Array.from({ length: 33 }, (_, i) => 99.1e6 + i * 20_000)
		Object.defineProperty(targetsHz, 32, {
			get() {
				throw new Error("overflow read")
			},
		})
		const res = run([ext({ band: band({ targetsHz }) })])
		expect(res.ranges).toHaveLength(32)
		expect(res.truncated).toBe(true)
	})

	it("a view list past the bound never reads the overflow element", () => {
		const views = distinct(64)
		Object.defineProperty(views, 64, {
			get() {
				throw new Error("overflow read")
			},
		})
		Object.defineProperty(views, "length", { value: 66 })
		const res = run(views)
		expect(res.ranges).toHaveLength(64)
	})

	it("a sourceId getter is read once: validation and emission agree", () => {
		let reads = 0
		const v = view()
		Object.defineProperty(v, "sourceId", {
			get() {
				reads++
				return reads === 1 ? "job" : "other"
			},
		})
		const res = computeDecodedElsewhere([v], { ...spec(), sourceId: "job" })
		expect(res.ranges).toEqual([])
		expect(reads).toBe(1)
	})

	const items = (targets: number, ranges: number) =>
		view({
			band: band({
				targetsHz: Array.from(
					{ length: targets },
					(_, i) => 99.1e6 + i * 20_000,
				),
				rangesHz: Array.from({ length: ranges }, (_, i) => ({
					minHz: 100.1e6 + i * 20_000,
					maxHz: 100.1e6 + i * 20_000 + 1000,
				})),
			}),
		})

	it("32 items (targets plus ranges): all examined", () => {
		const res = run([items(20, 12)])
		expect(res.ranges).toHaveLength(32)
		expect(res.truncated).toBe(false)
	})

	it("33 items: the last range is ignored, truncated", () => {
		const res = run([items(20, 13)])
		expect(res.ranges).toHaveLength(32)
		expect(res.truncated).toBe(true)
	})

	it("33 targets: targets come first, the 33rd is ignored", () => {
		const res = run([items(33, 1)])
		expect(res.ranges).toHaveLength(32)
		expect(res.truncated).toBe(true)
	})

	const manyRanges = (n: number) => {
		const views: DecoderCoverageView[] = []
		for (let d = 0; d * 32 < n; d++) {
			const count = Math.min(32, n - d * 32)
			views.push(
				view({
					id: `d${d}`,
					band: band({
						captureCenterHz: 1e9,
						windowHalfWidthHz: 1e9,
						targetsHz: Array.from(
							{ length: count },
							(_, i) => 1e6 + (d * 32 + i) * 20_000,
						),
					}),
				}),
			)
		}
		return views
	}

	it("256 merged ranges: reported, not truncated", () => {
		const res = run(manyRanges(256))
		expect(res.ranges).toHaveLength(256)
		expect(res.truncated).toBe(false)
	})

	it("257 merged ranges: lowest 256 kept, truncated", () => {
		const res = run(manyRanges(257))
		expect(res.ranges).toHaveLength(256)
		expect(res.truncated).toBe(true)
		expect(res.ranges.at(-1)?.startHz).toBe(1e6 + 255 * 20_000 - 6250)
	})

	it("custom limits apply", () => {
		const res = computeDecodedElsewhere(distinct(3), spec(), { maxRanges: 2 })
		expect(res.ranges).toHaveLength(2)
		expect(res.truncated).toBe(true)
	})
})

const SOURCES = ["other", "s2", JOB, null] as const
const arbView: fc.Arbitrary<DecoderCoverageView> = fc.record({
	id: fc.constantFrom("a", "b", "c", "d"),
	running: fc.boolean(),
	health: fc.constantFrom("running", "idle", "restarting", "faulted"),
	suspended: fc.boolean(),
	owner: fc.constantFrom("config", "scanner"),
	sourceId: fc.constantFrom(...SOURCES),
	inputKind: fc.constantFrom("iq", "audio_pcm", "external"),
	band: fc.option(
		fc.record({
			verdict: fc.constantFrom("in-band", "out-of-band", "unknown"),
			basis: fc.constantFrom(
				"configured",
				"protocol",
				"decoder-default",
				"region-default",
				"override",
				null,
			),
			targetsHz: fc.array(
				fc.oneof(
					fc.integer({ min: 0, max: 2_000_000 }),
					fc.constantFrom(Number.NaN, Infinity, -5),
				),
				{ maxLength: 6 },
			),
			rangesHz: fc.array(
				fc.record({
					minHz: fc.integer({ min: 0, max: 2_000_000 }),
					maxHz: fc.integer({ min: 0, max: 2_000_000 }),
				}),
				{ maxLength: 3 },
			),
			captureCenterHz: fc.option(fc.integer({ min: 0, max: 2_000_000 })),
			windowHalfWidthHz: fc.option(fc.integer({ min: 0, max: 500_000 })),
		}),
	),
})

function trusted(v: DecoderCoverageView): boolean {
	if (!v.running || v.suspended || v.owner !== "config") return false
	if (v.health !== "running" && v.health !== "idle") return false
	if (v.sourceId === JOB || v.band === null) return false
	if (v.sourceId !== null)
		return (
			v.band.verdict === "in-band" &&
			v.band.captureCenterHz !== null &&
			v.band.windowHalfWidthHz !== null
		)
	return (
		v.inputKind === "external" &&
		(v.band.basis === "configured" ||
			v.band.basis === "protocol" ||
			v.band.basis === "override")
	)
}

describe("computeDecodedElsewhere properties", () => {
	// Feature: web-gaps-6, Property 2: Trust rule
	// Validates: Requirements 1.3
	it("only trusted views contribute, and only inside their proven windows", () => {
		fc.assert(
			fc.property(fc.array(arbView, { maxLength: 8 }), views => {
				const { ranges } = run(views)
				const trustedIds = new Set(views.filter(trusted).map(v => v.id))
				for (const r of ranges) {
					for (const id of r.decoderIds) expect(trustedIds.has(id)).toBe(true)
					expect(r.sourceId).not.toBe(JOB)
					expect(r.applied).toBe(false)
				}
				// Removing untrusted views never changes the result.
				expect(run(views.filter(trusted))).toEqual(run(views))
				// Every WaveKit entry lies inside the window of some trusted view on its source.
				for (const r of ranges) {
					if (r.sourceId === null) continue
					const ok = views.some(
						v =>
							trusted(v) &&
							v.sourceId === r.sourceId &&
							v.band !== null &&
							r.startHz >=
								(v.band.captureCenterHz ?? 0) - (v.band.windowHalfWidthHz ?? 0),
					)
					expect(ok).toBe(true)
				}
			}),
			{ numRuns: 200 },
		)
	})

	it("overlapping enabled ranges yield one merged entry", () => {
		const res = run(
			[ext({ band: band({ targetsHz: [250_000], basis: "configured" }) })],
			spec([
				{ startHz: 100_000, endHz: 300_000 },
				{ startHz: 200_000, endHz: 400_000 },
			]),
		)
		expect(res.ranges).toHaveLength(1)
		const wide = run(
			[
				view({
					band: band({
						targetsHz: [],
						rangesHz: [{ minHz: 100_000, maxHz: 400_000 }],
						captureCenterHz: 250_000,
						windowHalfWidthHz: 200_000,
					}),
				}),
			],
			spec([
				{ startHz: 100_000, endHz: 300_000 },
				{ startHz: 200_000, endHz: 400_000 },
			]),
		)
		expect(wide.ranges).toMatchObject([{ startHz: 100_000, endHz: 400_000 }])
	})

	// Feature: web-gaps-6, Property 3: Merge shape
	// Validates: Requirements 1.2, 1.5
	it("entries are clipped, disjoint per source, sorted, ids sorted and unique", () => {
		const arbRanges = fc.array(
			fc.record({
				startHz: fc.integer({ min: 0, max: 2_000_000 }),
				width: fc.integer({ min: 0, max: 800_000 }),
				enabled: fc.option(fc.boolean(), { nil: undefined }),
			}),
			{ minLength: 1, maxLength: 4 },
		)
		fc.assert(
			fc.property(
				fc.array(arbView, { maxLength: 10 }),
				arbRanges,
				(views, rs) => {
					const ranges: ScanRange[] = rs.map(r => ({
						startHz: r.startHz,
						endHz: r.startHz + r.width,
						...(r.enabled === undefined ? {} : { enabled: r.enabled }),
					}))
					const out = computeDecodedElsewhere(views, spec(ranges)).ranges
					expect(out.length).toBeLessThanOrEqual(256)
					const union = mergeEnabled(ranges)
					for (const e of out) {
						expect(e.startHz).toBeLessThanOrEqual(e.endHz)
						expect(union.some(([s, t]) => e.startHz >= s && e.endHz <= t)).toBe(
							true,
						)
						expect(e.decoderIds.length).toBeGreaterThan(0)
						expect([...new Set(e.decoderIds)].sort()).toEqual(e.decoderIds)
					}
					for (let i = 1; i < out.length; i++) {
						const a = out[i - 1]!
						const b = out[i]!
						const order =
							a.startHz < b.startHz ||
							(a.startHz === b.startHz &&
								(b.sourceId === null
									? true
									: a.sourceId !== null && a.sourceId <= b.sourceId))
						expect(order).toBe(true)
					}
					const bySource = new Map<string | null, typeof out>()
					for (const e of out)
						bySource.set(e.sourceId, [...(bySource.get(e.sourceId) ?? []), e])
					for (const list of bySource.values())
						for (let i = 1; i < list.length; i++)
							expect(list[i]!.startHz).toBeGreaterThan(list[i - 1]!.endHz)
				},
			),
			{ numRuns: 200 },
		)
	})
})

function mergeEnabled(ranges: ScanRange[]): [number, number][] {
	const sorted = ranges
		.filter(r => r.enabled !== false)
		.map((r): [number, number] => [r.startHz, r.endHz])
		.sort((a, b) => a[0] - b[0])
	const out: [number, number][] = []
	for (const [s, e] of sorted) {
		const last = out[out.length - 1]
		if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e)
		else out.push([s, e])
	}
	return out
}

function status(over: Partial<DecoderStatus> = {}): DecoderStatus {
	return {
		id: "dec",
		type: "acars",
		running: true,
		health: "running",
		uptime: 1,
		stats: {} as DecoderStatus["stats"],
		restartCount: 0,
		...over,
	}
}

describe("toDecoderCoverageView", () => {
	it("maps a WaveKit decoder with its band assessment", () => {
		const v = toDecoderCoverageView(
			status({
				sourceId: "s1",
				owner: "config",
				suspended: false,
				bandAssessment: {
					verdict: "in-band",
					basis: "protocol",
					targetsHz: [131_550_000],
					rangesHz: [{ minHz: 1, maxHz: 2 }],
					captureCenterHz: 131e6,
					windowHalfWidthHz: 1e6,
				},
			}),
			"default",
		)
		expect(v).toEqual({
			id: "dec",
			running: true,
			health: "running",
			suspended: false,
			owner: "config",
			sourceId: "s1",
			inputKind: "iq",
			band: {
				verdict: "in-band",
				basis: "protocol",
				targetsHz: [131_550_000],
				rangesHz: [{ minHz: 1, maxHz: 2 }],
				captureCenterHz: 131e6,
				windowHalfWidthHz: 1e6,
			},
		})
	})

	it("resolves an absent sourceId to the default source", () => {
		expect(toDecoderCoverageView(status(), "default").sourceId).toBe("default")
		expect(toDecoderCoverageView(status(), null).sourceId).toBeNull()
	})

	it("missing fields map to the safe side", () => {
		const v = toDecoderCoverageView(
			status({ running: undefined as unknown as boolean }),
			"default",
		)
		expect(v.running).toBe(false)
		expect(v.band).toBeNull()
		expect(v.suspended).toBe(true)
		expect(v.owner).toBe("scanner")
		expect(
			toDecoderCoverageView(
				status({ bandAssessment: { verdict: "in-band" } }),
				"d",
			).band,
		).toEqual({
			verdict: "in-band",
			basis: null,
			targetsHz: [],
			rangesHz: [],
			captureCenterHz: null,
			windowHalfWidthHz: null,
		})
	})

	it("keeps probes, suspension and health", () => {
		const v = toDecoderCoverageView(
			status({ owner: "scanner", suspended: true, health: "restarting" }),
			"d",
		)
		expect(v).toMatchObject({
			owner: "scanner",
			suspended: true,
			health: "restarting",
		})
	})

	it("external input: configured targets only under the assessment's own basis", () => {
		const v = toDecoderCoverageView(
			status({
				sourceId: "ignored",
				owner: "config",
				suspended: false,
				deviceSerial: "0001",
				targetFrequenciesHz: [162_025_000],
				bandAssessment: {
					verdict: "unknown",
					basis: "configured",
					reasonCode: "external-input",
				},
			}),
			"default",
		)
		expect(v.sourceId).toBeNull()
		expect(v.inputKind).toBe("external")
		expect(v.band).toMatchObject({
			basis: "configured",
			targetsHz: [162_025_000],
		})
		const res = computeDecodedElsewhere([v], spec())
		expect(res.ranges).toMatchObject([{ startHz: 162_018_750, sourceId: null }])
	})

	it("external input never gets a manufactured basis", () => {
		const v = toDecoderCoverageView(
			status({
				owner: "config",
				suspended: false,
				targetFrequenciesHz: [100_000_000],
				bandAssessment: { verdict: "unknown", reasonCode: "external-input" },
			}),
			"default",
		)
		expect(v.band).toMatchObject({ basis: null, targetsHz: [] })
		expect(computeDecodedElsewhere([v], spec()).ranges).toEqual([])
		const bogus = toDecoderCoverageView(
			status({
				owner: "config",
				suspended: false,
				targetFrequenciesHz: [100_000_000],
				bandAssessment: {
					verdict: "unknown",
					basis: "made-up" as "configured",
					reasonCode: "external-input",
				},
			}),
			"default",
		)
		expect(bogus.band?.basis).toBeNull()
		expect(computeDecodedElsewhere([bogus], spec()).ranges).toEqual([])
	})

	it("malformed or missing owner and suspension never count", () => {
		const covering = {
			sourceId: "s1",
			bandAssessment: {
				verdict: "in-band" as const,
				basis: "protocol" as const,
				targetsHz: [100_000_000],
				captureCenterHz: 100_000_000,
				windowHalfWidthHz: 1e6,
			},
		}
		const cases: Partial<DecoderStatus>[] = [
			{ owner: "unknown" as "config", suspended: false },
			{ owner: "config", suspended: "true" as unknown as boolean },
			{},
			{
				owner: "config",
				suspended: false,
				running: "yes" as unknown as boolean,
			},
			{
				owner: "config",
				suspended: false,
				health: "weird" as DecoderStatus["health"],
			},
		]
		for (const c of cases) {
			const v = toDecoderCoverageView(status({ ...covering, ...c }), "d")
			expect(computeDecodedElsewhere([v], spec()).ranges).toEqual([])
		}
		const ok = toDecoderCoverageView(
			status({ ...covering, owner: "config", suspended: false }),
			"d",
		)
		expect(computeDecodedElsewhere([ok], spec()).ranges).toHaveLength(1)
	})

	it("external input without assessment has no band", () => {
		const v = toDecoderCoverageView(
			status({ deviceSerial: "0001", targetFrequenciesHz: [1e6] }),
			"default",
		)
		expect(v.band).toBeNull()
	})

	it("deviceSerial never moves a decoder off its source", () => {
		const covering = {
			id: "dec",
			owner: "config" as const,
			suspended: false,
			sourceId: "job",
			bandAssessment: {
				verdict: "in-band" as const,
				basis: "configured" as const,
				targetsHz: [100_000_000],
				captureCenterHz: 100_000_000,
				windowHalfWidthHz: 1e6,
			},
		}
		const s = { sourceId: "job", ranges: [{ startHz: 99e6, endHz: 101e6 }] }
		for (const deviceSerial of [null, "0001", 42]) {
			const v = toDecoderCoverageView(
				status({
					...covering,
					deviceSerial: deviceSerial as unknown as string,
				}),
				"job",
			)
			expect(v.sourceId).toBe("job")
			expect(v.inputKind).toBe("iq")
			expect(computeDecodedElsewhere([v], s).ranges).toEqual([])
		}
	})

	it("reads each status field once: a switching sourceId cannot leave its source", () => {
		let reads = 0
		const st = status({
			owner: "config",
			suspended: false,
			bandAssessment: {
				verdict: "in-band",
				basis: "configured",
				targetsHz: [100_000_000],
				captureCenterHz: 100_000_000,
				windowHalfWidthHz: 1e6,
			},
		})
		Object.defineProperty(st, "sourceId", {
			get() {
				reads++
				return reads === 1 ? "job" : "other"
			},
		})
		const v = toDecoderCoverageView(st, "job")
		expect(reads).toBe(1)
		expect(v.sourceId).toBe("job")
		expect(
			computeDecodedElsewhere([v], { ...spec(), sourceId: "job" }).ranges,
		).toEqual([])
	})

	it("a throwing getter maps to the safe non-covering view", () => {
		for (const field of ["owner", "bandAssessment", "health"]) {
			const st = status({ owner: "config", suspended: false, sourceId: "s1" })
			Object.defineProperty(st, field, {
				get() {
					throw new Error("boom")
				},
			})
			expect(toDecoderCoverageView(st, "d")).toMatchObject({
				running: false,
				owner: "scanner",
				suspended: true,
				band: null,
			})
		}
	})

	it("copies targets by index without dropping invalid ones", () => {
		const v = toDecoderCoverageView(
			status({
				owner: "config",
				suspended: false,
				sourceId: "other",
				bandAssessment: {
					verdict: "in-band",
					basis: "configured",
					targetsHz: [...Array<number>(32).fill(NaN), 100_000_000],
					captureCenterHz: 100_000_000,
					windowHalfWidthHz: 1e6,
				},
			}),
			"job",
		)
		// 32 copied plus one unread overflow sentinel
		expect(v.band?.targetsHz).toHaveLength(33)
		expect(computeDecodedElsewhere([v], spec())).toEqual({
			ranges: [],
			truncated: false,
		})
	})

	it("never reads target or range 33", () => {
		let reads = 0
		const targetsHz = Array.from({ length: 33 }, () => 100_000_000)
		const rangesHz = Array.from({ length: 33 }, () => ({ minHz: 1, maxHz: 2 }))
		for (const arr of [targetsHz, rangesHz])
			Object.defineProperty(arr, 32, {
				get() {
					reads++
					throw new Error("overflow read")
				},
			})
		const v = toDecoderCoverageView(
			status({
				owner: "config",
				suspended: false,
				sourceId: "other",
				bandAssessment: {
					verdict: "in-band",
					basis: "configured",
					targetsHz,
					rangesHz,
					captureCenterHz: 100_000_000,
					windowHalfWidthHz: 1e6,
				},
			}),
			"job",
		)
		computeDecodedElsewhere([v], spec())
		expect(reads).toBe(0)
		// Targets use the whole shared budget; each list keeps one unread overflow sentinel.
		expect(v.band?.targetsHz).toHaveLength(33)
		expect(v.band?.rangesHz).toHaveLength(1)
	})

	const inBand = (
		targetsHz: number[],
		rangesHz: { minHz: number; maxHz: number }[] = [],
	) => ({
		owner: "config" as const,
		suspended: false,
		bandAssessment: {
			verdict: "in-band" as const,
			basis: "configured" as const,
			targetsHz,
			rangesHz,
			captureCenterHz: 100_000_000,
			windowHalfWidthHz: 1e6,
		},
	})

	it("a malformed sourceId never resolves to the default source", () => {
		for (const bad of [null, 42, {}]) {
			const v = toDecoderCoverageView(
				status({
					...inBand([100_000_000]),
					sourceId: bad as unknown as string,
				}),
				"other",
			)
			expect(computeDecodedElsewhere([v], spec()).ranges).toEqual([])
		}
		const ok = toDecoderCoverageView(status(inBand([100_000_000])), "other")
		expect(computeDecodedElsewhere([ok], spec()).ranges).toHaveLength(1)
	})

	it("targets and ranges share one 32-item budget", () => {
		let reads = 0
		const rangesHz = [{ minHz: 1, maxHz: 2 }]
		Object.defineProperty(rangesHz, 0, {
			get() {
				reads++
				throw new Error("item 33")
			},
		})
		const v = toDecoderCoverageView(
			status({
				...inBand(
					Array.from({ length: 32 }, () => 100_000_000),
					rangesHz,
				),
				sourceId: "other",
			}),
			"d",
		)
		expect(reads).toBe(0)
		const r = computeDecodedElsewhere([v], spec())
		expect(r.ranges).toHaveLength(1)
		expect(r.truncated).toBe(true)
	})

	it("keeps the overflow visible after mapping", () => {
		const v = toDecoderCoverageView(
			status({
				...inBand(Array.from({ length: 33 }, () => 100_000_000)),
				sourceId: "other",
			}),
			"d",
		)
		const r = computeDecodedElsewhere([v], spec())
		expect(r.ranges).toHaveLength(1)
		expect(r.truncated).toBe(true)
	})
})
