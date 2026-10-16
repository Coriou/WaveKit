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
					const enabled = ranges.filter(r => r.enabled !== false)
					for (const e of out) {
						expect(e.startHz).toBeLessThanOrEqual(e.endHz)
						expect(
							enabled.some(r => e.startHz >= r.startHz && e.endHz <= r.endHz),
						).toBe(true)
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
		expect(v.suspended).toBe(false)
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

	it("external input: sourceId null, configured targets as basis configured", () => {
		const v = toDecoderCoverageView(
			status({
				sourceId: "ignored",
				deviceSerial: "0001",
				targetFrequenciesHz: [162_025_000],
				bandAssessment: { verdict: "unknown", reasonCode: "external-input" },
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

	it("external input without assessment has no band", () => {
		const v = toDecoderCoverageView(
			status({ deviceSerial: "0001", targetFrequenciesHz: [1e6] }),
			"default",
		)
		expect(v.band).toBeNull()
	})
})
