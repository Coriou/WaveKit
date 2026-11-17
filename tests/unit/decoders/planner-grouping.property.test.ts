import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	ActivityQuery,
	ActivitySnapshot,
} from "../../../src/decoders/enablement/activity-contract.js"
import type {
	ActivityIncumbent,
	PlannerActivity,
} from "../../../src/decoders/enablement/activity-plan.js"
import { resolveActivityPolicy } from "../../../src/decoders/enablement/activity-plan.js"
import type {
	PlacementGrouping,
	PlacementPlan,
	PlannerDecoder,
	PlannerInput,
	PlannerSource,
} from "../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_BUDGET_X64,
	placementKey,
} from "../../../src/decoders/enablement/contract.js"
import { dsdChallengeKey } from "../../../src/decoders/enablement/dsd-activity.js"
import { pagingRasterRanges } from "../../../src/decoders/enablement/paging-plan.js"
import {
	activityPlanQueries,
	activityQueries,
	planPlacements,
} from "../../../src/decoders/enablement/placement.js"
import { planPlacements as referencePlan } from "./placement-reference.js"

// An off-raster centre inside the EU UHF paging band (6.25 kHz raster).
const CENTRE = 466_103_300
const EU_RASTER = pagingRasterRanges("EU")
/** Band-plan channels on a 25 kHz grid around the centre. */
const GRID = Array.from(
	{ length: 17 },
	(_, i) => CENTRE + 21_700 + (i - 8) * 25_000,
)

const pager = (over: Partial<PlannerDecoder>): PlannerDecoder => ({
	id: "pager",
	type: "multimon-ng",
	origin: "config",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: undefined,
	configuredChannelsHz: [],
	reach: "channel",
	channelBandwidthHz: 12_000,
	channelTransitionHz: 2_500,
	protocols: ["pocsag", "flex"],
	channelPlacements: false,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	pagingRaster: EU_RASTER,
	...over,
})
const dsd = (over: Partial<PlannerDecoder>): PlannerDecoder =>
	pager({
		id: "dsd",
		type: "dsd-fme",
		origin: "catalogue",
		order: 1,
		protocols: ["dmr"],
		channelBandwidthHz: 12_500,
		channelPlacements: true,
		pagingRaster: [],
		bandRegion: "EU",
		...over,
	})
/** A catalogue ACARS decoder on synthetic channels: gated secondaries. */
const acars = (channels: number[]): PlannerDecoder =>
	pager({
		id: "acars",
		type: "acarsdec",
		origin: "catalogue",
		order: 3,
		protocols: [],
		channelBandwidthHz: 12_000,
		channelTransitionHz: 6_000,
		channelPlacements: true,
		pagingRaster: [],
		configuredChannelsHz: channels,
	})

const gridHz = fc.nat(GRID.length - 1).map(i => GRID[i]!)
const hzNear = fc.integer({ min: CENTRE - 400_000, max: CENTRE + 400_000 })
const mode = fc.constantFrom("auto" as const, "always" as const, "off" as const)
const DECODER_IDS = ["pager", "dsd", "dsd-2"] as const

const decoders = fc
	.record({
		pager: fc.option(
			fc.record({
				mode,
				origin: fc.constantFrom("config" as const, "catalogue" as const),
				configured: fc.array(hzNear, { maxLength: 2 }),
			}),
			{ nil: undefined, freq: 3 },
		),
		// The voice decoder is always there: the moves come from it.
		dsd: fc.record({
			mode: fc.constantFrom("auto" as const, "always" as const),
			startMode: fc.constantFrom("auto" as const, "operator" as const),
			// Firm (configured) channels beside the ranked ones.
			configured: fc.array(gridHz, { maxLength: 2 }),
		}),
		second: fc.boolean(),
		acars: fc.option(fc.array(hzNear, { minLength: 1, maxLength: 4 }), {
			nil: undefined,
			freq: 2,
		}),
	})
	.map(({ pager: p, dsd: d, second, acars: a }) => {
		const list: PlannerDecoder[] = []
		if (p)
			list.push(
				pager({
					mode: p.mode,
					origin: p.origin,
					configuredChannelsHz: p.configured,
				}),
			)
		list.push(
			dsd({
				mode: d.mode,
				startMode: d.startMode,
				configuredChannelsHz: d.configured,
			}),
		)
		if (second) list.push(dsd({ id: "dsd-2", order: 2 }))
		if (a) list.push(acars(a))
		return list
	})

const sources = fc
	.array(
		fc.record({
			offset: fc.integer({ min: -100_000, max: 100_000 }),
			sampleRateHz: fc.constantFrom(1_024_000, 2_048_000),
			held: fc.constantFrom(false, false, false, true),
			channelizerAvailable: fc.constantFrom(true, true, true, false),
			ranked: fc.constantFrom(true, true, true, false),
		}),
		{ minLength: 1, maxLength: 3 },
	)
	.map(values =>
		values.map((s, order) => ({
			source: {
				id: `s${order}`,
				centreHz: CENTRE + s.offset,
				sampleRateHz: s.sampleRateHz,
				usableFraction: 0.8,
				dedicatedScanner: false,
				held: s.held,
				reservedBy: null,
				// The first source carries the voice decoder's ranked set most often.
				channelizerAvailable: order === 0 || s.channelizerAvailable,
				order,
			} satisfies PlannerSource,
			ranked: s.ranked || (order === 0 && !s.held),
		})),
	)

const POLICY = resolveActivityPolicy(
	{ slots: { "dsd-fme": 2, "multimon-ng": 3 } },
	EFFICIENCY_BUDGET_X64,
	"x64",
	8,
)

/** The raw planner input, before the snapshots and challengers are answered. */
const raw = fc
	.record({
		decoders,
		sources,
		bandplan: fc.subarray(GRID, { minLength: 2 }),
		maxBandplanChannels: fc.integer({ min: 3, max: 8 }),
		vfo: fc.option(fc.record({ index: fc.nat(2), hz: hzNear }), {
			nil: null,
			freq: 3,
		}),
		incumbents: fc.array(
			fc.record({
				decoder: fc.constantFrom(...DECODER_IDS),
				source: fc.nat(2),
				hz: fc.oneof({ weight: 4, arbitrary: gridHz }, hzNear),
				primary: fc.boolean(),
				// Sync: none, seen and protected, seen and expired, seen with no expiry.
				sync: fc.constantFrom("none", "none", "live", "expired", "open"),
				dwellSinceMonoMs: fc.integer({ min: 0, max: 60_000 }),
			}),
			{ maxLength: 5 },
		),
		observed: fc.array(fc.array(hzNear, { maxLength: 6 }), { maxLength: 3 }),
		nowMonoMs: fc.integer({ min: 20_000, max: 120_000 }),
		recentMoves: fc.array(
			fc.record({
				source: fc.nat(2),
				ago: fc.integer({ min: 0, max: 90_000 }),
			}),
			{ maxLength: 4 },
		),
		demoted: fc.array(gridHz, { maxLength: 2 }),
		pending: fc.array(gridHz, { maxLength: 2 }),
		withRange: fc.boolean(),
		// Secondaries of the voice decoder on its own ranked channels, past their
		// dwell: what a move replaces.
		busy: fc.constantFrom(0, 1, 2, 2, 3, 3),
	})
	.map((g): PlannerInput & { activity: PlannerActivity } => {
		const ss = g.sources.map(s => s.source)
		const sourceId = (n: number) => `s${n % ss.length}`
		const epochs = g.sources
			.filter(s => s.ranked)
			.map(s => ({ sourceId: s.source.id, engineId: "e", epoch: 1 }))
		// The listed band-plan channels are the nearest ones: settle there.
		const near = [...g.bandplan].sort(
			(a, b) => Math.abs(a - ss[0]!.centreHz!) - Math.abs(b - ss[0]!.centreHz!),
		)
		const settled = near.slice(0, g.busy).map(hz => ({
			decoder: "dsd" as const,
			source: 0,
			hz,
			primary: false,
			sync: "none" as const,
			dwellSinceMonoMs: 0,
		}))
		const incumbents: ActivityIncumbent[] = [...settled, ...g.incumbents].map(
			inc => ({
				key: placementKey(inc.decoder, sourceId(inc.source), "channel", inc.hz),
				decoderId: inc.decoder,
				sourceId: sourceId(inc.source),
				hz: inc.hz,
				primary: inc.primary,
				dwellSinceMonoMs: inc.dwellSinceMonoMs,
				...(inc.sync === "live"
					? { syncSeen: true, syncUntilMonoMs: g.nowMonoMs + 5_000 }
					: inc.sync === "expired"
						? { syncSeen: true, syncUntilMonoMs: g.nowMonoMs - 1 }
						: inc.sync === "open"
							? { syncSeen: true }
							: {}),
			}),
		)
		return {
			decoders: g.decoders,
			sources: ss,
			vfo: g.vfo
				? { sourceId: sourceId(g.vfo.index), frequencyHz: g.vfo.hz }
				: null,
			bandplanChannels: window =>
				g.bandplan.filter(hz => hz >= window.minHz && hz <= window.maxHz),
			...(g.withRange
				? {
						bandplanRangeContains: (_id: string, hz: number) =>
							Math.abs(hz - CENTRE) < 200_000,
					}
				: {}),
			maxBandplanChannels: g.maxBandplanChannels,
			activity: {
				nowMonoMs: g.nowMonoMs,
				policy: POLICY,
				demotions: g.demoted.map(hz => ({
					key: placementKey("dsd", "s0", "channel", hz),
					untilMonoMs: g.nowMonoMs + 10_000,
				})),
				epochs,
				observed: epochs.flatMap((epoch, i) => {
					const hz = g.observed[i]
					return hz ? [{ epoch, channelsHz: hz }] : []
				}),
				snapshots: [],
				incumbents,
				recentMoves: g.recentMoves.map(m => ({
					sourceId: sourceId(m.source),
					atMonoMs: g.nowMonoMs - m.ago,
				})),
				pendingStarts: g.pending.map(hz => ({
					key: placementKey("dsd", "s0", "channel", hz),
					sourceId: "s0",
					reach: "channel" as const,
					costCores: 0.1,
					sampleRateHz: ss[0]!.sampleRateHz!,
				})),
			},
		}
	})

/**
 * Answers for every query, scores from `seed` (any value is valid); some not
 * ready. Channels in `coldHz` (running secondaries, mostly) answer cold.
 */
function answer(
	queries: readonly ActivityQuery[],
	seed: number,
	coldHz: ReadonlySet<number> = new Set(),
): ActivitySnapshot[] {
	return queries.map((query, q) => ({
		query,
		revision: 1,
		evaluatedMonoMs: 0,
		lastFrameMonoMs: 0,
		status: (seed + q) % 11 === 0 ? "stale" : "ready",
		nextEvaluationMonoMs: (seed + q) % 3 === 0 ? 200_000 + q : null,
		channels: query.candidatesHz.map((hz, i) => {
			const score = coldHz.has(hz) ? 0 : (seed * 31 + q * 7 + i * 13) % 11
			return {
				hz,
				excluded: (seed + i) % 9 === 0,
				score,
				state: score > 7 ? "hot" : score > 3 ? "warm" : "cold",
				reasons: [],
				live: score > 9,
				lastEnergyMonoMs: null,
				stateSinceMonoMs: 0,
			}
		}),
	}))
}

/** Channels some query lists, confirmed for its decoder when `pick` says so (about 3 in 4). */
function challengers(
	queries: readonly ActivityQuery[],
	pick: number,
): string[] {
	const bit = (i: number) => ((pick >> (i % 8)) & 1) === 1
	return queries.flatMap(query =>
		query.candidatesHz
			.filter((_, i) => bit(i) || bit(i + 3))
			.map(hz => dsdChallengeKey(query.decoderId, query.epoch.sourceId, hz)),
	)
}

/** A plan with its map as ordered entries, so order is compared too. */
const comparable = (plan: PlacementPlan) => ({
	wanted: plan.wanted,
	unplaced: [...plan.unplaced],
	activity: plan.activity,
})

/** Counts band-plan lookups (one per activity decoder and source per grouping). */
function counted(input: PlannerInput & { activity: PlannerActivity }) {
	const calls = { n: 0 }
	const lookup = input.bandplanChannels
	return {
		calls,
		input: {
			...input,
			bandplanChannels: (...args: Parameters<typeof lookup>) => {
				calls.n++
				return lookup(...args)
			},
		},
	}
}

describe("the split planner against the frozen pre-change planner", () => {
	it("activityQueries returns exactly the reference planner's queries without snapshots", () => {
		let queried = 0
		fc.assert(
			fc.property(raw, input => {
				const old = referencePlan(input).activity?.queries ?? []
				expect(activityQueries(input)).toStrictEqual(old)
				expect(activityPlanQueries(input).queries).toStrictEqual(old)
				if (old.length > 0) queried++
			}),
			{ numRuns: 200 },
		)
		expect(queried).toBeGreaterThan(40)
	})

	// Generator reach, measured over four runs of 400 inputs (random seeds):
	// non-empty wanted 100 % (400/400 each time), non-empty queries 94-96 %
	// (375-384), non-empty moves 32-38 % (127-152). Each is asserted >= 20 %.
	it("plans what the reference plans, without and with the grouping of the same pass", () => {
		const reach = {
			runs: 0,
			wanted: 0,
			queries: 0,
			moves: 0,
			gated: 0,
			lookups: 0,
			unranked: 0,
		}
		fc.assert(
			fc.property(raw, fc.nat(1_000), fc.nat(255), (pre, seed, pick) => {
				const queries = referencePlan(pre).activity?.queries ?? []
				const cold = new Set(
					seed % 8 === 0
						? []
						: pre.activity.incumbents.filter(i => !i.primary).map(i => i.hz),
				)
				const snapshots = answer(queries, seed, cold)
				const confirmedChallengers = challengers(queries, pick)
				const answered: PlannerInput = {
					...pre,
					activity: { ...pre.activity, snapshots, confirmedChallengers },
				}
				const expected = comparable(referencePlan(answered))
				// Planned afresh.
				expect(comparable(planPlacements(answered))).toStrictEqual(expected)
				// Planned from the grouping of the same pass, which is reused: no
				// band-plan lookup is made again.
				const c = counted(pre)
				const grouped = activityPlanQueries(c.input)
				expect(grouped.queries).toStrictEqual(queries)
				const lookups = c.calls.n
				const supplied: PlannerInput = {
					...c.input,
					activity: { ...c.input.activity, snapshots, confirmedChallengers },
					...(grouped.grouping ? { grouping: grouped.grouping } : {}),
				}
				expect(comparable(planPlacements(supplied))).toStrictEqual(expected)
				expect(c.calls.n).toBe(lookups)
				reach.runs++
				if (expected.wanted.length) reach.wanted++
				if (expected.activity?.queries.length) reach.queries++
				if (expected.activity?.moves.length) reach.moves++
				if (expected.wanted.some(p => p.gated === true)) reach.gated++
				// Reuse is only shown where the grouping looked a band plan up.
				if (lookups > 0) reach.lookups++
				if (pre.activity.epochs.length < pre.sources.length) reach.unranked++
			}),
			{ numRuns: 400 },
		)
		expect(reach.wanted / reach.runs).toBeGreaterThanOrEqual(0.2)
		expect(reach.queries / reach.runs).toBeGreaterThanOrEqual(0.2)
		expect(reach.moves / reach.runs).toBeGreaterThanOrEqual(0.2)
		expect(reach.gated / reach.runs).toBeGreaterThanOrEqual(0.2)
		expect(reach.lookups / reach.runs).toBeGreaterThanOrEqual(0.2)
		expect(reach.unranked / reach.runs).toBeGreaterThanOrEqual(0.2)
	})
})

/** One dsd-fme decoder ranked on one source, its band-plan lookups counted. */
function fixture() {
	const epoch = { sourceId: "s0", engineId: "e", epoch: 1 }
	const sources: PlannerSource[] = [
		{
			id: "s0",
			centreHz: CENTRE,
			sampleRateHz: 1_024_000,
			usableFraction: 0.8,
			dedicatedScanner: false,
			held: false,
			reservedBy: null,
			channelizerAvailable: true,
			order: 0,
		},
	]
	const base: PlannerInput & { activity: PlannerActivity } = {
		decoders: [dsd({ mode: "auto" })],
		sources,
		vfo: null,
		bandplanChannels: window =>
			GRID.filter(hz => hz >= window.minHz && hz <= window.maxHz),
		bandplanRangeContains: () => false,
		maxBandplanChannels: 8,
		activity: {
			nowMonoMs: 30_000,
			policy: resolveActivityPolicy(
				{ slots: { "dsd-fme": 2 } },
				EFFICIENCY_BUDGET_X64,
				"x64",
				8,
			),
			epochs: [epoch],
			snapshots: [],
			incumbents: [],
			recentMoves: [],
			pendingStarts: [],
		},
	}
	const c = counted(base)
	const { queries, grouping } = activityPlanQueries(c.input)
	expect(queries).toHaveLength(1)
	expect(grouping).not.toBeNull()
	// One band-plan lookup per (decoder, source) per grouping.
	expect(c.calls.n).toBe(1)
	const snapshots = answer(queries, 3)
	const pass = (over: Partial<PlannerInput> = {}): PlannerInput => ({
		...c.input,
		activity: { ...c.input.activity, snapshots, confirmedChallengers: [] },
		grouping: grouping!,
		...over,
	})
	return { c, grouping: grouping!, snapshots, pass, sources }
}

describe("the grouping hand-over", () => {
	it("serves its own pass's input however often it is passed, with no state between calls", () => {
		const { c, pass } = fixture()
		const first = planPlacements(pass())
		const second = planPlacements(pass())
		// Reused both times: no hidden slot is taken by the first call.
		expect(c.calls.n).toBe(1)
		expect(comparable(second)).toStrictEqual(comparable(first))
		const { grouping: _grouping, ...fresh } = pass()
		expect(comparable(first)).toStrictEqual(
			comparable(referencePlan(fresh as PlannerInput)),
		)
	})

	it("a different input never reuses a supplied grouping: one more key, another sources array, another range lookup, another activity member", () => {
		const { c, pass } = fixture()
		const variants: Array<[string, PlannerInput]> = [
			["one more key", { ...pass(), extra: 1 } as PlannerInput],
			["another sources array", pass({ sources: [...c.input.sources] })],
			["another range lookup", pass({ bandplanRangeContains: () => false })],
			["another decoders array", pass({ decoders: [...c.input.decoders] })],
			[
				"another vfo",
				pass({ vfo: { sourceId: "s0", frequencyHz: CENTRE + 21_700 } }),
			],
			[
				"another incumbents array",
				pass({
					activity: {
						...pass().activity!,
						incumbents: [...c.input.activity.incumbents],
					},
				}),
			],
		]
		for (const [name, input] of variants) {
			const before = c.calls.n
			const plan = planPlacements(input)
			expect(c.calls.n, name).toBe(before + 1)
			const { grouping: _g, ...plain } = input
			expect(comparable(plan), name).toStrictEqual(
				comparable(referencePlan(plain as PlannerInput)),
			)
		}
		// Without the range lookup the key count differs too.
		const { bandplanRangeContains: _r, ...without } = pass()
		const before = c.calls.n
		planPlacements(without as PlannerInput)
		expect(c.calls.n).toBe(before + 1)
	})

	it("a value not made by activityPlanQueries, or made for another input, is never read as a grouping", () => {
		const { c, pass } = fixture()
		const forged = {} as unknown as PlacementGrouping
		let before = c.calls.n
		planPlacements(pass({ grouping: forged }))
		expect(c.calls.n).toBe(before + 1)
		// Equal members are the same input: a grouping made for a copy of the
		// outer object serves it.
		const copy = activityPlanQueries({ ...c.input }).grouping!
		before = c.calls.n
		planPlacements(pass({ grouping: copy }))
		expect(c.calls.n).toBe(before)
		const other = activityPlanQueries({
			...c.input,
			sources: [...c.input.sources],
		}).grouping!
		before = c.calls.n
		planPlacements(pass({ grouping: other }))
		// Made for another sources array: this input is grouped afresh.
		expect(c.calls.n).toBe(before + 1)
		const withoutActivity: PlannerInput = { ...c.input }
		delete withoutActivity.activity
		expect(activityPlanQueries(withoutActivity)).toStrictEqual({
			queries: [],
			grouping: null,
		})
	})

	it("an in-place change of a source between the two calls is the caller's violation: the identity rule cannot see it and the plan follows the source as it was", () => {
		const { c, pass, sources, snapshots } = fixture()
		const asItWas = comparable(
			referencePlan({
				...c.input,
				sources: sources.map(s => ({ ...s })),
				activity: { ...c.input.activity, snapshots, confirmedChallengers: [] },
			}),
		)
		// Violates activityPlanQueries' precondition: the same array and object,
		// changed in place.
		const before = c.calls.n
		sources[0]!.centreHz = CENTRE + 300_000
		const supplied = planPlacements(pass())
		// Reused: no lookup, so the moved centre was never read.
		expect(c.calls.n).toBe(before)
		expect(comparable(supplied)).toStrictEqual(asItWas)
		// Planned afresh, the moved centre gives another plan.
		const { grouping: _g, ...plain } = pass()
		expect(comparable(planPlacements(plain as PlannerInput))).not.toStrictEqual(
			asItWas,
		)
	})
})
