import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { scanPresetJobSchema } from "@wavekit/api-types"
import type {
	Bandplan,
	Impact,
	ResolvedBand,
	ScanJob,
	ScanPresetJob,
} from "@wavekit/api-types"

import {
	addRange,
	addSkip,
	buildSpec,
	consentText,
	customRange,
	DEFAULT_OPTIONS,
	draftValid,
	EMPTY_DRAFT,
	impactDisturbs,
	optionsChanged,
	parseMHz,
	presetJobOf,
	presetOn,
	presetsFrom,
	presetsOf,
	passPhrase,
	previewSummary,
	protocolLabels,
	rangeError,
	rangesOfPreset,
	scanRangeOf,
	shortPlanName,
	spacingText,
	tagRanges,
	toggleChoice,
	togglePreset,
	updateRange,
	userPresetOf,
	PROTOCOL_CHOICES,
	type PlanDraft,
} from "../../src/features/scanner/planner/plan.ts"
import {
	changedRanges,
	draftOf,
	patchSpec,
	pendingText,
	runChanges,
} from "../../src/features/scanner/planner/pending.ts"
import {
	bandAtX,
	bandsView,
	clampView,
	fitView,
	hzAt,
	lanesOf,
	MIN_SPAN_HZ,
	placeTags,
	scaleWidth,
	scaleX,
	segmentedScale,
	tickStep,
	ticks,
	xOf,
	zoomView,
} from "../../src/features/scanner/planner/ruler.ts"

const MHZ = (m: number) => Math.round(m * 1e6)

const BANDPLANS: Bandplan[] = [
	{
		id: "airband",
		region: "EU",
		name: "Airband (8.33 / 25 kHz)",
		ranges: [
			{
				startHz: MHZ(118),
				endHz: MHZ(137),
				rasters: [
					{ spacingHz: 25_000, firstChannelHz: MHZ(118) },
					{ spacingHz: 25_000 / 3, firstChannelHz: MHZ(118) },
				],
				protocols: ["analog-am"],
				bandplanId: "airband",
			},
		],
	},
	{
		id: "pager-vhf",
		region: "EU",
		name: "VHF paging (169 MHz metering band excluded)",
		ranges: [
			{
				startHz: MHZ(137),
				endHz: MHZ(169.4) - 1,
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(137) }],
				protocols: ["pocsag", "flex"],
				bandplanId: "pager-vhf",
			},
			{
				startHz: MHZ(169.475) + 1,
				endHz: MHZ(174),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(137) }],
				protocols: ["pocsag", "flex"],
				bandplanId: "pager-vhf",
			},
		],
	},
	{
		id: "vhf-land-mobile",
		region: "all",
		name: "VHF land mobile",
		ranges: [
			{
				startHz: MHZ(136),
				endHz: MHZ(174),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: MHZ(136.00625) },
					{ spacingHz: 6250, firstChannelHz: MHZ(136.003125) },
				],
				protocols: ["dmr", "analog-fm", "p25p1"],
				bandplanId: "vhf-land-mobile",
			},
		],
	},
	{
		id: "pmr446",
		region: "EU",
		name: "PMR446",
		ranges: [
			{
				startHz: MHZ(446),
				endHz: MHZ(446.2),
				rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(446.00625) }],
				protocols: ["analog-fm", "dmr"],
				bandplanId: "pmr446",
			},
		],
	},
]

function band(
	key: string,
	group: ResolvedBand["band"]["group"],
	a: number,
	b: number,
	skip: string | null = null,
): ResolvedBand {
	return {
		key,
		packId: "builtin-fr",
		bandId: key,
		layer: 1,
		band: {
			id: key,
			name: key,
			startHz: MHZ(a),
			endHz: MHZ(b),
			group,
			mode: null,
			bandwidthHz: null,
			stepHz: 12_500,
			skip: skip ? { reason: skip } : null,
			channels: [],
			parentId: null,
			colourHint: null,
			registryRef: null,
			scan: null,
			provenance: { kind: "builtin" },
		},
		segments: [{ startHz: MHZ(a), endHz: MHZ(b) }],
		editedFields: [],
		issues: [],
		provenance: { kind: "builtin" },
		packProvenance: { kind: "builtin" },
	} as ResolvedBand
}

describe("planner: ranges from band plans", () => {
	const presets = presetsOf(BANDPLANS)

	it("one preset per band plan, short chip names, close pieces joined", () => {
		expect(presets.map(p => p.label)).toEqual([
			"Airband",
			"VHF paging",
			"VHF land mobile",
			"PMR446",
		])
		const paging = presets.find(p => p.id === "pager-vhf")
		expect(paging?.ranges).toHaveLength(1)
		expect(paging?.ranges[0]).toMatchObject({
			startHz: MHZ(137),
			endHz: MHZ(174),
		})
		expect(shortPlanName("CB (40 CEPT channels)")).toBe("CB")
	})

	it("a preset's ranges carry the band plan's spacing and protocols", () => {
		const air = presets[0]
		if (!air) throw new Error("no preset")
		const [r] = rangesOfPreset(air)
		expect(r).toMatchObject({
			name: "Airband",
			preset: "airband",
			spacingHz: [25_000, 8333],
			protocols: ["analog-am"],
			bandplanId: "airband",
		})
		expect(spacingText(r?.spacingHz ?? [])).toBe("25 + 8.33")
	})

	it("presets toggle and stay sorted by frequency", () => {
		const [air, , lm, pmr] = presets
		if (!air || !lm || !pmr) throw new Error("no preset")
		let d: PlanDraft = EMPTY_DRAFT
		d = togglePreset(d, pmr)
		d = togglePreset(d, air)
		d = togglePreset(d, lm)
		expect(d.ranges.map(r => r.preset)).toEqual([
			"airband",
			"vhf-land-mobile",
			"pmr446",
		])
		expect(presetOn(air, d.ranges)).toBe(true)
		d = togglePreset(d, air)
		expect(presetOn(air, d.ranges)).toBe(false)
		expect(d.ranges).toHaveLength(2)
	})

	it("a band takes the scanner plan that fits it, else its own step and its group's protocols", () => {
		// land mobile 146–174 is most of the VHF land mobile plan (136–174)
		const lm = customRange(MHZ(146), MHZ(174), BANDPLANS, {
			stepHz: 12_500,
			group: "land-mobile",
		})
		expect(lm.spacingHz).toEqual([12_500, 6250])
		expect(lm.protocols).toEqual(["dmr", "analog-fm", "p25p1"])
		expect(lm.planRasters).toHaveLength(2)
		// Marine VHF sits inside VHF paging (137–169.4), which is far wider: the band's own 25 kHz and FM voice
		const marine = customRange(MHZ(156), MHZ(162.025), BANDPLANS, {
			name: "Marine VHF",
			stepHz: 25_000,
			group: "marine",
		})
		expect(marine.spacingHz).toEqual([25_000])
		expect(marine.protocols).toEqual(["analog-fm"])
		expect(marine.name).toBe("Marine VHF")
	})

	it("a drawn range with no band borrows the plan around it, else 12.5 kHz and FM, DMR, P25", () => {
		const r = customRange(MHZ(156), MHZ(162), BANDPLANS)
		// pager-vhf (137–169.4) is the narrowest plan holding it
		expect(r.protocols).toEqual(["pocsag", "flex"])
		expect(r.spacingHz).toEqual([12_500])
		expect(r.name).toBe("156.000–162.000")
		const far = customRange(MHZ(900), MHZ(901), BANDPLANS)
		expect(far.spacingHz).toEqual([12_500])
		expect(far.protocols).toEqual(["analog-fm", "dmr", "p25p1"])
		const stepped = customRange(MHZ(900), MHZ(901), [], {
			name: "X",
			stepHz: 25_000,
		})
		expect(stepped.spacingHz).toEqual([25_000])
	})

	it("range errors: reversed edges and outside the tuner", () => {
		expect(rangeError({ startHz: MHZ(10), endHz: MHZ(20) })).toMatch(/tuner/)
		expect(rangeError({ startHz: MHZ(150), endHz: MHZ(140) })).toMatch(
			/Low edge/,
		)
		expect(rangeError({ startHz: MHZ(140), endHz: MHZ(150) })).toBeNull()
		expect(draftValid(EMPTY_DRAFT)).toBe(false)
	})

	it("parses typed MHz with a comma", () => {
		expect(parseMHz("156,025")).toBe(156_025_000)
		expect(parseMHz(" 446.00625 ")).toBe(446_006_250)
		expect(parseMHz("abc")).toBeNull()
	})
})

describe("planner: protocols", () => {
	it("dedupes display names and toggles grouped ids", () => {
		expect(protocolLabels(["p25p1", "p25p2", "dmr", "analog-fm"])).toEqual([
			"DMR",
			"P25",
			"FM voice",
		])
		const p25 = PROTOCOL_CHOICES.find(c => c.label === "P25")
		if (!p25) throw new Error("no P25")
		expect(toggleChoice(["dmr"], p25)).toEqual(["dmr", "p25p1", "p25p2"])
		expect(toggleChoice(["dmr", "p25p1"], p25)).toEqual(["dmr"])
	})
})

describe("planner: the job spec", () => {
	const presets = presetsOf(BANDPLANS)
	const lm = presets.find(p => p.id === "vhf-land-mobile")
	if (!lm) throw new Error("no preset")

	it("a sweep with the plan's ranges, rasters and plan id; default options send nothing", () => {
		const d = togglePreset(EMPTY_DRAFT, lm)
		const spec = buildSpec(d)
		expect(spec).toEqual({
			name: "VHF land mobile",
			mode: "sweep",
			kind: "discover",
			skipDecodedElsewhere: true,
			ranges: [
				{
					startHz: MHZ(136),
					endHz: MHZ(174),
					name: "VHF land mobile",
					rasters: [
						{ spacingHz: 12_500, firstChannelHz: MHZ(136.00625) },
						{ spacingHz: 6250, firstChannelHz: MHZ(136.003125) },
					],
					protocols: ["dmr", "analog-fm", "p25p1"],
					bandplanId: "vhf-land-mobile",
				},
			],
		})
	})

	it("changed edges or spacing drop the plan id; Any sends no raster", () => {
		const d = togglePreset(EMPTY_DRAFT, lm)
		const r = d.ranges[0]
		if (!r) throw new Error("no range")
		const moved = scanRangeOf({ ...r, startHz: MHZ(146) })
		expect(moved.bandplanId).toBeUndefined()
		const any = scanRangeOf({ ...r, spacingHz: [] })
		expect(any.rasters).toEqual([])
		expect(any.bandplanId).toBeUndefined()
		const custom = scanRangeOf({ ...r, spacingHz: [25_000] })
		expect(custom.rasters).toEqual([
			{ spacingHz: 25_000, firstChannelHz: MHZ(136) },
		])
	})

	it("options and skips map to the spec", () => {
		const d: PlanDraft = {
			...togglePreset(EMPTY_DRAFT, lm),
			skips: [
				{ key: "x1", startHz: MHZ(150), endHz: MHZ(151), reason: "Taxis" },
			],
			options: {
				sensitivity: "high",
				hold: false,
				record: false,
				stopAfter: "pass",
				signalsOnly: true,
				skipDecodedElsewhere: false,
			},
		}
		const spec = buildSpec(d)
		expect(spec.exclusions).toEqual([
			{ startHz: MHZ(150), endHz: MHZ(151), reason: "Taxis" },
		])
		expect(spec.sensitivity).toBe("high")
		expect(spec.hold).toEqual({ policy: "never" })
		expect(spec.record).toEqual({ voice: false, analog: false })
		expect(spec.stop).toEqual({ afterSweeps: 1 })
		expect(spec.signalsOnly).toBe(true)
		expect(spec.skipDecodedElsewhere).toBeUndefined()
		expect(optionsChanged(d.options)).toBe(true)
		expect(optionsChanged(DEFAULT_OPTIONS)).toBe(false)
	})

	it("names a plan from its ranges", () => {
		const air = presets[0]
		const pmr = presets[3]
		if (!air || !pmr) throw new Error("no preset")
		const two = togglePreset(togglePreset(EMPTY_DRAFT, air), pmr)
		expect(buildSpec(two).name).toBe("Airband + PMR446")
		const three = togglePreset(two, lm)
		expect(buildSpec(three).name).toBe("Airband + 2 more")
	})
})

describe("planner: footer words", () => {
	const hop = (centreHz: number) => ({
		index: 0,
		centreHz,
		covered: { startHz: centreHz - 1e6, endHz: centreHz + 1e6 },
		channelCount: 1,
		dcAdjacentChannelsHz: [],
		excluded: [],
		dcMinEdgeHz: 0,
	})
	it("full pass and hops, or one hop parked", () => {
		expect(
			previewSummary({
				sweepPeriodMs: 9600,
				plan: {
					hops: Array.from({ length: 26 }, (_, i) => hop(MHZ(146 + i))),
					usableHalfSpanHz: 0,
					dcGuardHz: 0,
					ppmMarginHz: 0,
				},
			}),
		).toBe("Full pass ≈ 10 s · 26 hops")
		expect(
			previewSummary({
				sweepPeriodMs: null,
				plan: {
					hops: [hop(MHZ(446.1))],
					usableHalfSpanHz: 0,
					dcGuardHz: 0,
					ppmMarginHz: 0,
				},
			}),
		).toBe("One hop · parks at 446.100")
	})

	it('a sub-second pass reads "under 1 s", never "≈ < 1 s" (running footer and setup)', () => {
		expect(passPhrase(400)).toBe("under 1 s")
		expect(passPhrase(9600)).toBe("≈ 10 s")
		expect(passPhrase(0)).toBe("under 1 s")
	})

	it("the consent line names who the sweep pauses", () => {
		const impact: Impact = {
			liveAudioClients: 1,
			digitalVoiceListeners: 0,
			runningDecoders: ["readsb", "ais", "dsd", "acars", "pocsag"],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}
		const name = (id: string) =>
			({ readsb: "ADS-B", ais: "AIS" })[id] ?? id.toUpperCase()
		expect(consentText(impact, name)).toBe(
			"Takes the receiver · pauses ADS-B, AIS and 3 others · live audio follows the scan",
		)
		expect(
			consentText(
				{ ...impact, runningDecoders: ["ais"], liveAudioClients: 0 },
				name,
			),
		).toBe("Takes the receiver · pauses AIS")
		expect(consentText(null, name)).toBe("Takes the receiver")
		expect(impactDisturbs(impact)).toBe(true)
		expect(
			impactDisturbs({ ...impact, runningDecoders: [], liveAudioClients: 0 }),
		).toBe(false)
	})
})

describe("planner: ruler maths", () => {
	it("x and Hz are inverses over the view", () => {
		// Feature: scan-planner, Property 1: the ruler's x and Hz mappings round-trip
		fc.assert(
			fc.property(
				fc.integer({ min: 24_000_000, max: 1_700_000_000 }),
				fc.integer({ min: MIN_SPAN_HZ, max: 60_000_000 }),
				fc.integer({ min: 100, max: 2000 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(lo, span, width, f) => {
					const v = { lo, hi: lo + span }
					const hz = lo + f * span
					expect(hzAt(xOf(hz, v, width), v, width)).toBeCloseTo(hz, 0)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("zoom keeps the pointer's frequency in place and never goes below 200 kHz", () => {
		const v = { lo: MHZ(140), hi: MHZ(180) }
		const at = MHZ(150)
		const z = zoomView(v, 0.5, at)
		expect((at - z.lo) / (z.hi - z.lo)).toBeCloseTo(
			(at - v.lo) / (v.hi - v.lo),
			6,
		)
		expect(z.hi - z.lo).toBeCloseTo(MHZ(20), 0)
		const tiny = zoomView(v, 1e-6, at)
		expect(tiny.hi - tiny.lo).toBe(MIN_SPAN_HZ)
		const edge = clampView({ lo: 0, hi: MHZ(10) })
		expect(edge.lo).toBe(24_000_000)
	})

	it("fits ranges with room, and opens on the region's VHF bands", () => {
		const f = fitView([{ startHz: MHZ(146), endHz: MHZ(174) }])
		expect(f?.lo).toBeLessThan(MHZ(146))
		expect(f?.hi).toBeGreaterThan(MHZ(174))
		expect(fitView([])).toBeNull()
		const v = bandsView([
			{ startHz: MHZ(26.965), endHz: MHZ(27.405) },
			{ startHz: MHZ(118), endHz: MHZ(137) },
			{ startHz: MHZ(146), endHz: MHZ(174) },
			{ startHz: MHZ(446), endHz: MHZ(446.2) },
		])
		expect(v.lo).toBeGreaterThan(MHZ(115))
		expect(v.lo).toBeLessThan(MHZ(118))
		expect(v.hi).toBeGreaterThan(MHZ(174))
		expect(v.hi).toBeLessThan(MHZ(176))
	})

	it("round tick steps with room between labels", () => {
		expect(tickStep(MHZ(56), 800, 80)).toBe(MHZ(10))
		expect(tickStep(MHZ(0.2), 800, 80)).toBe(20_000)
		const t = ticks({ lo: MHZ(117), hi: MHZ(175) }, 800)
		expect(t[0]?.text).toBe("120")
		expect(t.every((x, i) => i === 0 || x.x - (t[i - 1]?.x ?? 0) >= 80)).toBe(
			true,
		)
	})

	it("lanes: one per group, ordered by first band; clicks pick the narrowest band", () => {
		const lanes = lanesOf([
			band("air", "air", 118, 137),
			band("lmv", "land-mobile", 146, 174),
			band("marine", "marine", 156, 162.025),
			band("harbour", "marine", 156.5, 157.45),
			band("inpt", "land-mobile", 380, 400, "Encrypted"),
		])
		expect(lanes.map(l => l.name)).toEqual(["Air", "Land mobile", "Marine"])
		expect(lanes[1]?.bands.map(b => b.skip)).toEqual([null, "Encrypted"])
		expect(lanes[2]?.colour).toBe("var(--wk-grp-marine)")
		const v = { lo: MHZ(150), hi: MHZ(165) }
		const marine = lanes[2]
		if (!marine) throw new Error("no lane")
		expect(bandAtX(marine, xOf(MHZ(157), v, 1000), v, 1000)?.key).toBe(
			"harbour",
		)
		expect(bandAtX(marine, xOf(MHZ(160), v, 1000), v, 1000)?.key).toBe("marine")
		expect(bandAtX(marine, xOf(MHZ(151), v, 1000), v, 1000)).toBeNull()
	})

	it("tags never overlap and show a name only where it fits", () => {
		const tags = placeTags(
			[
				{ num: 1, name: "Land mobile", x0: 10, x1: 400 },
				{ num: 2, name: "Marine", x0: 12, x1: 200 },
				{ num: 3, name: "PMR446", x0: 500, x1: 503 },
			],
			600,
		)
		for (let i = 1; i < tags.length; i++)
			expect(tags[i]?.left ?? 0).toBeGreaterThanOrEqual(
				(tags[i - 1]?.left ?? 0) + (tags[i - 1]?.w ?? 0),
			)
		expect(tags[0]?.nameW).toBe(0) // the next tag is right there
		expect(tags[1]?.nameW).toBeGreaterThan(0)
		expect(tags[2]?.nameW).toBe(0) // a 3 px range has no room
	})

	it("segmented scale: disjoint stretches get a break, close ones share a segment", () => {
		const one = segmentedScale(
			[
				{ startHz: MHZ(146), endHz: MHZ(156) },
				{ startHz: MHZ(156), endHz: MHZ(174) },
			],
			800,
		)
		expect(one.segments).toHaveLength(1)
		expect(one.breaks).toHaveLength(0)
		const two = segmentedScale(
			[
				{ startHz: MHZ(169.4), endHz: MHZ(169.8) },
				{ startHz: MHZ(466.025), endHz: MHZ(466.23) },
			],
			800,
		)
		expect(two.segments).toHaveLength(2)
		expect(two.breaks).toHaveLength(1)
		const a = scaleX(two, MHZ(169.6)) ?? -1
		const b = scaleX(two, MHZ(466.1)) ?? -1
		expect(a).toBeGreaterThan(0)
		expect(b).toBeGreaterThan(a)
		expect(b).toBeLessThan(800)
		// a tiny stretch beside a wide one still gets a fifth of the room
		const mixed = segmentedScale(
			[
				{ startHz: MHZ(146), endHz: MHZ(174) },
				{ startHz: MHZ(446), endHz: MHZ(446.2) },
			],
			1000,
		)
		const small = mixed.segments[1]
		expect(small && small.x1 - small.x0).toBeGreaterThanOrEqual(
			0.19 * (1000 - 22),
		)
		// the capture window keeps its real width on its segment
		const wide = mixed.segments[0]
		if (!wide) throw new Error("no segment")
		const px = scaleWidth(mixed, MHZ(160), 2_400_000)
		expect(px).toBeCloseTo(
			((wide.x1 - wide.x0) / (wide.hi - wide.lo)) * 2_400_000,
			6,
		)
	})
})

describe("planner: running edits", () => {
	const job = {
		spec: {
			ranges: [
				{
					startHz: MHZ(146),
					endHz: MHZ(156),
					protocols: ["dmr", "analog-fm"],
					name: "Land mobile",
					bandplanId: "vhf-land-mobile",
					rasters: [{ spacingHz: 12_500, firstChannelHz: MHZ(146) }],
				},
				{
					startHz: MHZ(156),
					endHz: MHZ(162.025),
					protocols: ["analog-fm"],
					name: "Marine",
					enabled: false,
					dwellMs: 300,
				},
			],
			exclusions: [{ startHz: MHZ(150), endHz: MHZ(150.1), reason: "Taxis" }],
		},
	} as unknown as Pick<ScanJob, "spec">

	it("no change against the job's own values", () => {
		const d = draftOf(job)
		expect(d.enabled).toEqual([true, false])
		expect(runChanges(job, d)).toEqual([])
	})

	it("counts range on/off, protocols and skips; marks the changed rows", () => {
		const base = draftOf(job)
		const d = {
			enabled: [false, false],
			protocols: [
				["dmr", "analog-fm"],
				["analog-fm", "dmr"],
			] as const,
			exclusions: [
				...base.exclusions.slice(1),
				{ startHz: MHZ(160), endHz: MHZ(160.1) },
			],
		}
		const changes = runChanges(job, d)
		expect(changes.map(c => c.kind).sort()).toEqual([
			"enabled",
			"protocols",
			"skip-added",
			"skip-removed",
		])
		expect([...changedRanges(job, d)].sort()).toEqual([0, 1])
		expect(pendingText(changes.length)).toBe("4 changes waiting")
		expect(pendingText(1)).toBe("1 change waiting")
		// a reordered protocol list is no change
		expect(
			runChanges(job, {
				...base,
				protocols: [["analog-fm", "dmr"], ["analog-fm"]],
			}),
		).toEqual([])
	})

	it("the PATCH keeps every locked field and live field as the job has them", () => {
		const d = { ...draftOf(job), enabled: [true, true] }
		const body = patchSpec(job, d)
		expect(body.ranges?.[0]).toEqual({
			...job.spec.ranges[0],
			enabled: true,
			protocols: ["dmr", "analog-fm"],
		})
		expect(body.ranges?.[1]).toMatchObject({
			enabled: true,
			dwellMs: 300,
			name: "Marine",
			startHz: MHZ(156),
		})
		expect(body.exclusions).toEqual(job.spec.exclusions)
	})
})

describe("planner: scan presets from the core", () => {
	const at = (n: number) => `2026-10-17T10:0${n}:00.000Z`
	const job = (over: Partial<ScanPresetJob> = {}): ScanPresetJob => ({
		mode: null,
		bandplans: [],
		ranges: [],
		exclusions: [],
		protocols: [],
		sensitivity: null,
		thresholdDb: null,
		fftSize: null,
		integrationMs: null,
		dwellMs: null,
		settleMs: null,
		...over,
	})
	const builtin = (id: string, name: string, plans: string[]) => ({
		preset: {
			kind: "builtin" as const,
			id,
			name,
			region: "EU" as const,
			job: job({ bandplans: plans }),
		},
		applicable: true,
		issues: [],
	})
	const operator = (
		id: string,
		name: string,
		j: ScanPresetJob,
		created: number,
	) => ({
		preset: {
			kind: "operator" as const,
			id,
			name,
			job: j,
			createdAt: at(created),
			updatedAt: at(created),
		},
		applicable: true,
		issues: [],
	})
	const HARBOUR = job({
		mode: "sweep",
		ranges: [
			{
				startHz: MHZ(156.5),
				endHz: MHZ(157.45),
				rasters: [{ spacingHz: 25_000, firstChannelHz: MHZ(156.5) }],
				obwHz: [],
				protocols: ["analog-fm"],
			},
		],
		exclusions: [{ startHz: MHZ(156.8), endHz: MHZ(156.81), reason: "Ch 16" }],
		sensitivity: "high",
	})
	const LIST = [
		builtin("builtin-airband", "Airband (8.33 / 25 kHz)", ["airband"]),
		builtin("builtin-pmr446", "PMR446", ["pmr446"]),
		builtin("builtin-combo-x", "Land mobile + PMR", [
			"vhf-land-mobile",
			"pmr446",
		]),
		operator("u-old", "Old one", job({ bandplans: ["airband", "gone"] }), 1),
		operator("u-harbour", "Harbour", HARBOUR, 2),
	]
	const named = (lo: number, hi: number) =>
		lo >= MHZ(156) && hi <= MHZ(158) ? "Harbour channels" : undefined
	const presets = presetsFrom(LIST, BANDPLANS, named)
	const byId = (id: string) => {
		const p = presets.find(x => x.id === id)
		if (!p) throw new Error(id)
		return p
	}

	it("lists yours first (newest first), then the built-ins in the core's order", () => {
		expect(presets.map(p => p.id)).toEqual([
			"u-harbour",
			"u-old",
			"builtin-airband",
			"builtin-pmr446",
			"builtin-combo-x",
		])
		expect(presets.filter(p => p.user)).toHaveLength(2)
		expect(byId("builtin-airband").label).toBe("Airband")
		expect(byId("u-old").missing).toEqual(["gone"])
		// without the core's list, one preset per scanner band plan
		expect(presetsFrom(null, BANDPLANS).map(p => p.id)).toEqual(
			presetsOf(BANDPLANS).map(p => p.id),
		)
	})

	it("a combination repeats its plans' ranges, so a plan already on is not added twice", () => {
		const pmr = byId("builtin-pmr446")
		const combo = byId("builtin-combo-x")
		let d = togglePreset(EMPTY_DRAFT, pmr)
		d = togglePreset(d, combo)
		expect(d.ranges.map(r => [r.name, r.preset])).toEqual([
			["VHF land mobile", "builtin-combo-x"],
			["PMR446", "builtin-pmr446"],
		])
		expect(presetOn(combo, d.ranges)).toBe(true)
		expect(presetOn(pmr, d.ranges)).toBe(true)
		d = togglePreset(d, combo)
		expect(d.ranges.map(r => r.preset)).toEqual(["builtin-pmr446"])
		expect(presetOn(pmr, d.ranges)).toBe(true)
	})

	it("your preset brings its ranges, skips and sensitivity, and takes its skips back out", () => {
		const harbour = byId("u-harbour")
		const on = togglePreset(EMPTY_DRAFT, harbour)
		expect(on.ranges[0]).toMatchObject({
			name: "Harbour channels",
			spacingHz: [25_000],
			protocols: ["analog-fm"],
			preset: "u-harbour",
		})
		expect(on.skips).toMatchObject([
			{ startHz: MHZ(156.8), endHz: MHZ(156.81), reason: "Ch 16" },
		])
		expect(on.options.sensitivity).toBe("high")
		expect(userPresetOf(presets, on.ranges)?.id).toBe("u-harbour")
		const off = togglePreset(on, harbour)
		expect(off.ranges).toHaveLength(0)
		expect(off.skips).toHaveLength(0)
		// mixed with a built-in, the plan is no longer "from" your preset
		const mixed = togglePreset(on, byId("builtin-airband"))
		expect(userPresetOf(presets, mixed.ranges)).toBeNull()
	})

	it("saving keeps an untouched built-in by id and stores every other range", () => {
		let d = togglePreset(EMPTY_DRAFT, byId("builtin-airband"))
		d = togglePreset(d, byId("builtin-pmr446"))
		d = addRange(d, customRange(MHZ(433), MHZ(435), BANDPLANS))
		d = { ...d, options: { ...d.options, sensitivity: "low" } }
		const pmrKey = d.ranges.find(r => r.preset === "builtin-pmr446")?.key ?? ""
		d = updateRange(d, pmrKey, { spacingHz: [6250] })
		const j = presetJobOf(d, presets)
		expect(scanPresetJobSchema.safeParse(j).success).toBe(true)
		expect(j.bandplans).toEqual(["airband"])
		expect(j.ranges.map(r => [r.startHz, r.endHz])).toEqual([
			[MHZ(433), MHZ(435)],
			[MHZ(446), MHZ(446.2)],
		])
		expect(j.ranges[1]?.rasters).toEqual([
			{ spacingHz: 6250, firstChannelHz: MHZ(446) },
		])
		expect(j).toMatchObject({ mode: "sweep", sensitivity: "low" })
	})

	it("a saved plan loads back as the same ranges, spacing, protocols and skips", () => {
		// Feature: web-app, Property: Save as preset round trip
		// Validates: canvas ScanPlanner "Save as preset"
		const arbRange = fc
			.record({
				lo: fc.integer({ min: 30_000, max: 1_700_000 }),
				span: fc.integer({ min: 10, max: 20_000 }),
				spacing: fc.constantFrom(6250, 12_500, 25_000),
				protos: fc.subarray(["analog-fm", "dmr", "pocsag"] as const, {
					minLength: 1,
				}),
			})
			.map(x => ({ ...x, lo: x.lo * 1000, hi: (x.lo + x.span) * 1000 }))
		fc.assert(
			fc.property(
				fc.array(arbRange, { minLength: 1, maxLength: 6 }),
				ranges => {
					let d: PlanDraft = EMPTY_DRAFT
					for (const r of ranges)
						d = addRange(d, {
							...customRange(r.lo, r.hi, null),
							spacingHz: [r.spacing],
							protocols: [...r.protos],
						})
					d = addSkip(d, ranges[0]?.lo ?? 0, (ranges[0]?.lo ?? 0) + 5000)
					const j = presetJobOf(d, presets)
					expect(scanPresetJobSchema.safeParse(j).success).toBe(true)
					const [back] = presetsFrom(
						[operator("u-new", "Mine", j, 9)],
						BANDPLANS,
					)
					if (!back) throw new Error("no preset")
					const loaded = togglePreset(EMPTY_DRAFT, back)
					const shape = (x: PlanDraft) =>
						x.ranges.map(r => [
							r.startHz,
							r.endHz,
							r.spacingHz.join(),
							[...r.protocols].sort().join(),
						])
					expect(shape(loaded)).toEqual(shape(d))
					expect(loaded.skips.map(s => [s.startHz, s.endHz])).toEqual(
						d.skips.map(s => [s.startHz, s.endHz]),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("tags the plan with a preset just saved", () => {
		const d = addRange(EMPTY_DRAFT, customRange(MHZ(433), MHZ(435), null))
		expect(tagRanges(d, "u-new").ranges.map(r => r.preset)).toEqual(["u-new"])
	})
})
