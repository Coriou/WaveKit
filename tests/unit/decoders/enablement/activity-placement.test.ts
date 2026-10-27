import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type {
	ActivityQuery,
	ActivitySnapshot,
	ActivityState,
	ChannelActivity,
} from "../../../../src/decoders/enablement/activity-contract.js"
import type {
	ActivityIncumbent,
	PlannerActivity,
} from "../../../../src/decoders/enablement/activity-plan.js"
import {
	ACTIVITY_DWELL_MS,
	ACTIVITY_MOVE_WINDOW_MS,
	ACTIVITY_MOVES_PER_MINUTE,
	resolveActivityPolicy,
} from "../../../../src/decoders/enablement/activity-plan.js"
import type {
	PlacementPlan,
	PlannerDecoder,
	PlannerInput,
	PlannerSource,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	channelizerBaseCores,
	EFFICIENCY_BUDGET_X64,
} from "../../../../src/decoders/enablement/contract.js"
import {
	activityQueries,
	planPlacements,
} from "../../../../src/decoders/enablement/placement.js"
import { pagingRasterRanges } from "../../../../src/decoders/enablement/paging-plan.js"

const RATE = 1_024_000
// Off-raster, inside the EU UHF paging band (6.25 kHz raster).
const CENTRE = 466_103_300
const EU_RASTER = pagingRasterRanges("EU")
const EPOCH = { sourceId: "s", engineId: "e", epoch: 1 }

const pager = (over: Partial<PlannerDecoder> = {}): PlannerDecoder => ({
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
const dsd = (over: Partial<PlannerDecoder> = {}): PlannerDecoder =>
	pager({
		id: "dsd",
		type: "dsd-fme",
		origin: "catalogue",
		order: 1,
		protocols: ["dmr"],
		channelBandwidthHz: 12_500,
		channelPlacements: true,
		pagingRaster: [],
		...over,
	})
const source = (over: Partial<PlannerSource> = {}): PlannerSource => ({
	id: "s",
	centreHz: CENTRE,
	sampleRateHz: RATE,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...over,
})
const base = (
	decoders: PlannerDecoder[] = [pager()],
	sources: PlannerSource[] = [source()],
	over: Partial<PlannerInput> = {},
): PlannerInput => ({
	decoders,
	sources,
	vfo: null,
	bandplanChannels: () => [],
	maxBandplanChannels: 4,
	...over,
})
const activity = (over: Partial<PlannerActivity> = {}): PlannerActivity => ({
	nowMonoMs: 0,
	policy: resolveActivityPolicy(undefined, EFFICIENCY_BUDGET_X64, "x64", 8),
	epochs: [EPOCH],
	snapshots: [],
	incumbents: [],
	recentMoves: [],
	pendingStarts: [],
	...over,
})
type Heat = { state: ActivityState; score: number; live?: boolean }
/** A ranker double: answers every query, `heat` per frequency (default cold). */
function answer(
	queries: readonly ActivityQuery[],
	heat: ReadonlyMap<number, Heat>,
	status: ActivitySnapshot["status"] = "ready",
): ActivitySnapshot[] {
	return queries.map(query => ({
		query,
		revision: 1,
		evaluatedMonoMs: 0,
		lastFrameMonoMs: 0,
		status,
		nextEvaluationMonoMs: null,
		channels: query.candidatesHz.map(
			(hz): ChannelActivity => ({
				hz,
				score: heat.get(hz)?.score ?? 0,
				state: heat.get(hz)?.state ?? "cold",
				reasons: heat.get(hz) ? ["live-energy"] : [],
				live: heat.get(hz)?.live ?? false,
				lastEnergyMonoMs: null,
				stateSinceMonoMs: 0,
			}),
		),
	}))
}
function planWith(
	input: PlannerInput,
	act: PlannerActivity,
	heat?: ReadonlyMap<number, Heat>,
	status: ActivitySnapshot["status"] = "ready",
): PlacementPlan {
	const withAct = { ...input, activity: act }
	const snapshots = heat ? answer(activityQueries(withAct), heat, status) : []
	return planPlacements({ ...withAct, activity: { ...act, snapshots } })
}
const channels = (plan: PlacementPlan, id = "pager") =>
	plan.wanted.filter(p => p.decoderId === id).map(p => p.channelHz)
const today = planPlacements(base())
const todayHz = today.wanted.map(p => p.channelHz!)

describe("activity ranking: equivalence without ranking", () => {
	it("keeps today's eligibility and order when no ranking is available", () => {
		const huge = activity({
			policy: {
				...activity().policy,
				budgetCores: 64,
				slots: { "multimon-ng": 32, "dsd-fme": 32 },
			},
		})
		const plan = planWith(base(), huge)
		expect(channels(plan)).toEqual(todayHz)
		// The same with the ranking down (stale snapshot).
		expect(channels(planWith(base(), huge, new Map(), "stale"))).toEqual(
			todayHz,
		)
	})

	// Feature: activity-ranked channels, Property 2: eligibility preserved
	// Validates: Requirements 3.22, 3.18
	it("plans a permutation of the eligible set, VFO first, with any ranking", () => {
		const step = 6_250
		fc.assert(
			fc.property(
				fc.integer({ min: -30, max: 30 }),
				fc.option(fc.integer({ min: -40, max: 40 }), { nil: null }),
				fc.boolean(),
				fc.array(
					fc.record({
						i: fc.integer({ min: 0, max: 40 }),
						state: fc.constantFrom("hot", "warm", "cold" as const),
						score: fc.double({ min: 0, max: 10, noNaN: true }),
					}),
					{ maxLength: 12 },
				),
				(shift, vfoStep, onRaster, heats) => {
					const centre = 466_127_500 + shift * 1_000
					const sources = [source({ centreHz: centre })]
					const vfoHz =
						vfoStep === null
							? null
							: 466_125_000 + vfoStep * step + (onRaster ? 0 : 1_700)
					const input = base([pager()], sources, {
						vfo: vfoHz === null ? null : { sourceId: "s", frequencyHz: vfoHz },
					})
					const reference = planPlacements(input)
					const eligible = new Set(reference.wanted.map(p => p.channelHz))
					const heat = new Map(
						heats.map(h => [
							466_025_000 + h.i * step,
							{ state: h.state, score: h.score },
						]),
					)
					const plan = planWith(
						input,
						activity({
							policy: {
								...activity().policy,
								budgetCores: 64,
								slots: { "multimon-ng": 32, "dsd-fme": 32 },
							},
						}),
						heat,
					)
					const hz = plan.wanted.map(p => p.channelHz)
					expect(new Set(hz)).toEqual(eligible)
					expect(hz).toHaveLength(eligible.size)
					// 3.18: an on-raster VFO is first; an off-raster one is never planned.
					if (vfoHz !== null && eligible.has(vfoHz)) {
						expect(plan.wanted[0]).toMatchObject({
							channelHz: vfoHz,
							origin: "vfo",
							primary: true,
						})
					}
					if (vfoHz !== null && !onRaster) expect(hz).not.toContain(vfoHz)
					expect(plan.wanted.filter(p => p.primary)).toHaveLength(1)
				},
			),
			{ numRuns: 150 },
		)
	})
})

describe("activity ranking: slots and order", () => {
	it("ranks hot then warm ahead of the nearest channels and slices by slots", () => {
		const far = todayHz[todayHz.length - 1]!
		const mid = todayHz[10]!
		const plan = planWith(
			base(),
			activity(),
			new Map([
				[far, { state: "hot" as const, score: 5 }],
				[mid, { state: "warm" as const, score: 1 }],
			]),
		)
		const pagerPlan = plan.wanted.filter(p => p.decoderId === "pager")
		// Primary (nearest; ranking never moves it) + 4 activity slots.
		expect(pagerPlan).toHaveLength(5)
		expect(pagerPlan[0]).toMatchObject({
			primary: true,
			origin: "bandplan",
			channelHz: far,
		})
		expect(pagerPlan.slice(1).map(p => p.channelHz)).toEqual([
			mid,
			...todayHz.filter(hz => hz !== far && hz !== mid).slice(0, 3),
		])
		for (const p of pagerPlan.slice(1))
			expect(p).toMatchObject({ origin: "activity", gated: true })
		expect(pagerPlan[1]!.activity).toEqual({
			ranking: "activity",
			state: "warm",
			score: 1,
			live: false,
			reasons: ["live-energy"],
		})
		expect(plan.activity?.groups).toEqual([
			{
				decoderId: "pager",
				sourceId: "s",
				ranking: "activity",
				wanted: 4,
				given: 4,
			},
		])
	})

	it("keeps an off-raster VFO out of the paging candidates (3.18)", () => {
		const input = base([pager()], [source()], {
			vfo: { sourceId: "s", frequencyHz: CENTRE },
		})
		const queries = activityQueries({ ...input, activity: activity() })
		expect(queries).toHaveLength(1)
		expect(queries[0]!.candidatesHz).not.toContain(CENTRE)
		expect(queries[0]!.candidatesHz).toEqual(todayHz)
		const plan = planWith(input, activity(), new Map())
		expect(channels(plan)).not.toContain(CENTRE)
	})

	it("places dsd-fme on observed activity absent from the protocol band plan", () => {
		const far = 466_036_250
		const input = base([dsd()], [source()], {
			vfo: { sourceId: "s", frequencyHz: CENTRE },
			bandplanChannels: () => [],
		})
		const act = {
			...activity(),
			observed: [{ epoch: EPOCH, channelsHz: [far] }],
		}
		const out = planWith(
			input,
			act,
			new Map([[far, { state: "hot", score: 102, live: true }]]),
		)
		expect(channels(out, "dsd")).toEqual([CENTRE, far])
		expect(out.wanted[1]).toMatchObject({
			origin: "activity",
			primary: false,
			gated: true,
		})
	})

	it("filters observed centres by epoch, band, reach, explicit channels and budget", () => {
		const far = 466_036_250
		const input = base(
			[
				dsd({
					band: {
						basis: "configured",
						rangesHz: [{ minHz: 466_000_000, maxHz: 466_200_000 }],
					},
				}),
			],
			[source()],
			{
				vfo: { sourceId: "s", frequencyHz: CENTRE },
			},
		)
		const act = {
			...activity(),
			observed: [
				{ epoch: EPOCH, channelsHz: [far, 466_300_000, 465_000_000, NaN] },
			],
		}
		expect(channels(planWith(input, act), "dsd")).toEqual([CENTRE, far])
		expect(
			channels(
				planWith(input, {
					...act,
					observed: [
						{ epoch: { ...EPOCH, engineId: "old" }, channelsHz: [far] },
					],
				}),
				"dsd",
			),
		).toEqual([CENTRE])
		for (const budget of [0.63, 0.63 - 0.000001]) {
			const out = planWith(input, {
				...act,
				policy: { ...act.policy, budgetCores: budget },
			})
			// Primary 0.155 + base 0.22 + replay 0.1 + one slot 0.155 = 0.63.
			expect(channels(out, "dsd")).toHaveLength(budget === 0.63 ? 2 : 1)
		}
		const pinned = {
			...input,
			decoders: [
				dsd({
					origin: "config",
					followVfo: false,
					configuredChannelsHz: [CENTRE],
				}),
			],
		}
		expect(channels(planWith(pinned, act), "dsd")).toEqual([CENTRE])
	})

	it("deduplicates observed centres at half the passband but retains channels beyond it", () => {
		const input = base([dsd()], [source()], {
			vfo: { sourceId: "s", frequencyHz: CENTRE },
		})
		for (const offset of [6_250, 6_251, 12_500]) {
			const act = {
				...activity(),
				observed: [{ epoch: EPOCH, channelsHz: [CENTRE + offset] }],
			}
			expect(channels(planWith(input, act), "dsd")).toHaveLength(
				offset === 6_250 ? 1 : 2,
			)
		}
	})

	it("ranks the catalogue band-plan channels of dsd-fme, VFO first", () => {
		const plan = [466_050_000, 466_075_000, 466_150_000, 466_175_000]
		const input = base([dsd()], [source()], {
			vfo: { sourceId: "s", frequencyHz: 466_110_000 },
			bandplanChannels: () => plan,
		})
		const out = planWith(
			input,
			activity(),
			new Map([[466_175_000, { state: "hot" as const, score: 2 }]]),
		)
		expect(channels(out, "dsd")).toEqual([
			466_110_000, 466_175_000, 466_075_000,
		])
		expect(out.wanted[0]).toMatchObject({ origin: "vfo", primary: true })
	})

	it("gives every slot once across decoders and sources within the budget", () => {
		const second = source({ id: "t", centreHz: 466_150_000, order: 1 })
		const input = base(
			[pager(), dsd({ origin: "catalogue" })],
			[source(), second],
			{
				bandplanChannels: () => [466_060_000, 466_140_000],
			},
		)
		for (const budget of [0.5, 0.9, 1.2, 1.5, 2, 3]) {
			const out = planWith(
				input,
				activity({
					epochs: [EPOCH, { sourceId: "t", engineId: "e", epoch: 1 }],
					policy: { ...activity().policy, budgetCores: budget },
				}),
				new Map(),
			)
			const keys = out.wanted.map(p => p.key)
			expect(new Set(keys).size).toBe(keys.length)
			const bases = new Set(out.wanted.map(p => p.sourceId))
			const total =
				out.wanted.reduce((sum, p) => sum + p.costCores, 0) +
				[...bases].reduce(
					(sum, id) =>
						sum +
						channelizerBaseCores(id === "t" ? second.sampleRateHz! : RATE),
					0,
				) +
				activity().policy.replayAllowanceCores
			if (out.wanted.some(p => p.origin === "activity"))
				expect(total).toBeLessThanOrEqual(budget + 1e-9)
			for (const g of out.activity!.groups)
				expect(g.given).toBeLessThanOrEqual(g.wanted)
		}
	})
})

describe("activity ranking: pending starts", () => {
	it("counts a pending start that keeps no slot (review repro, planner level)", () => {
		// Pager primary 0.14, dsd-fme VFO 0.155, base 0.22: 0.515 mandatory. A
		// pager secondary still starting holds 0.14 more (0.655), so one
		// dsd-fme slot (0.155) does not fit in 0.67 even with no pager slots.
		const input = base([pager(), dsd()], [source()], {
			vfo: { sourceId: "s", frequencyHz: CENTRE },
			bandplanChannels: () => [466_060_000, 466_140_000],
		})
		const policy = {
			...activity().policy,
			budgetCores: 0.67,
			replayAllowanceCores: 0,
			slots: { "multimon-ng": 0, "dsd-fme": 1 },
		}
		const pendingKey = `pager#${todayHz[1]}@s`
		const run = (pending: boolean) =>
			planWith(
				input,
				activity({
					policy,
					pendingStarts: pending
						? [
								{
									key: pendingKey,
									sourceId: "s",
									reach: "channel",
									costCores: 0.14,
									sampleRateHz: RATE,
								},
							]
						: [],
				}),
				new Map(),
			)
		expect(run(false).wanted.filter(p => p.origin === "activity")).toHaveLength(
			1,
		)
		expect(run(true).wanted.filter(p => p.origin === "activity")).toHaveLength(
			0,
		)
	})

	it("keeps a pending activity slot it prepaid and never moves it", () => {
		const far = todayHz[todayHz.length - 1]!
		const pendingKey = `pager#${todayHz[4]}@s`
		const plan = planWith(
			base(),
			activity({
				nowMonoMs: 100_000,
				incumbents: todayHz.slice(0, 5).map((hz, i) => ({
					key: `pager#${hz}@s`,
					decoderId: "pager",
					sourceId: "s",
					hz,
					primary: i === 0,
					dwellSinceMonoMs: 0,
				})),
				pendingStarts: [
					{
						key: pendingKey,
						sourceId: "s",
						reach: "channel",
						costCores: 0.14,
						sampleRateHz: RATE,
					},
				],
			}),
			new Map([[far, { state: "hot" as const, score: 4 }]]),
		)
		const hz = channels(plan)
		expect(hz).toContain(todayHz[4])
		expect(hz).toContain(far)
		// The lowest-ranked unpinned slot moved instead.
		expect(hz).not.toContain(todayHz[3])
	})
})

/** Runs planning passes like the manager: incumbents start at once, moves are recorded. */
function simulate(
	input: PlannerInput,
	steps: readonly {
		atMs: number
		heat: ReadonlyMap<number, Heat>
		status?: ActivitySnapshot["status"]
	}[],
	observed?: PlannerActivity["observed"],
) {
	let incumbents: ActivityIncumbent[] = []
	const since = new Map<string, number>()
	const moves: { atMonoMs: number; sourceId: string; victimSince: number }[] =
		[]
	const plans: { atMs: number; plan: PlacementPlan }[] = []
	for (const step of steps) {
		const plan = planWith(
			input,
			activity({
				nowMonoMs: step.atMs,
				...(observed ? { observed } : {}),
				incumbents,
				recentMoves: moves.map(m => ({
					sourceId: m.sourceId,
					atMonoMs: m.atMonoMs,
				})),
			}),
			step.heat,
			step.status,
		)
		for (const m of plan.activity!.moves)
			moves.push({
				atMonoMs: m.atMonoMs,
				sourceId: m.sourceId,
				victimSince: since.get(m.fromKey)!,
			})
		const keys = new Set(plan.wanted.map(p => p.key))
		for (const key of [...since.keys()]) if (!keys.has(key)) since.delete(key)
		for (const p of plan.wanted)
			if (!since.has(p.key)) since.set(p.key, step.atMs)
		incumbents = plan.wanted.map((p: WantedPlacement) => ({
			key: p.key,
			decoderId: p.decoderId,
			sourceId: p.sourceId,
			hz: p.channelHz!,
			primary: p.primary,
			dwellSinceMonoMs: since.get(p.key)!,
		}))
		plans.push({ atMs: step.atMs, plan })
	}
	return { plans, moves }
}

describe("activity ranking: bounded moves", () => {
	it("dsd-fme observed slots respect dwell and move limits, keep live channels and survive ranking outages", () => {
		const far = 466_036_250
		const a = 466_125_000
		const b = 466_075_000
		const input = base([dsd()], [source()], {
			vfo: { sourceId: "s", frequencyHz: CENTRE },
		})
		const hot = new Map([
			[far, { state: "hot" as const, score: 102, live: true }],
		])
		const { plans, moves } = simulate(
			input,
			[
				{ atMs: 123.7, heat: new Map() },
				{ atMs: 20_122.7, heat: hot },
				{ atMs: 20_123.7, heat: hot },
				{ atMs: 20_124.7, heat: hot },
				{ atMs: 60_317.3, heat: hot, status: "stale" },
			],
			[{ epoch: EPOCH, channelsHz: [a, b, far] }],
		)
		expect(channels(plans[0]!.plan, "dsd")).toEqual([CENTRE, a, b])
		expect(channels(plans[1]!.plan, "dsd")).not.toContain(far)
		expect(channels(plans[2]!.plan, "dsd")).toContain(far)
		expect(moves).toHaveLength(1)
		expect(channels(plans[3]!.plan, "dsd")).toEqual(
			channels(plans[2]!.plan, "dsd"),
		)
		expect(channels(plans[4]!.plan, "dsd")).toEqual(
			channels(plans[2]!.plan, "dsd"),
		)
		const incumbent = plans[2]!.plan.wanted.map(p => ({
			key: p.key,
			decoderId: p.decoderId,
			sourceId: p.sourceId,
			hz: p.channelHz!,
			primary: p.primary,
			dwellSinceMonoMs: 0,
		}))
		const stopped = planWith(input, {
			...activity(),
			nowMonoMs: 80_317.3,
			epochs: [],
			observed: [],
			incumbents: incumbent,
		})
		expect(new Set(channels(stopped, "dsd"))).toEqual(
			new Set(channels(plans[2]!.plan, "dsd")),
		)
		const jitter = planWith(
			input,
			{
				...activity(),
				nowMonoMs: 80_317.3,
				incumbents: incumbent,
				observed: [{ epoch: EPOCH, channelsHz: [far + 137] }],
			},
			hot,
		)
		expect(channels(jitter, "dsd")).toContain(far)
		expect(channels(jitter, "dsd")).not.toContain(far + 137)
		const blocked = planWith(
			input,
			{
				...activity(),
				nowMonoMs: 80_317.3,
				incumbents: plans[0]!.plan.wanted.map(p => ({
					key: p.key,
					decoderId: p.decoderId,
					sourceId: p.sourceId,
					hz: p.channelHz!,
					primary: p.primary,
					dwellSinceMonoMs: 0,
				})),
				observed: [{ epoch: EPOCH, channelsHz: [a, b, far] }],
				recentMoves: Array.from({ length: 6 }, (_, i) => ({
					sourceId: "s",
					atMonoMs: 80_000 + i,
				})),
			},
			hot,
		)
		expect(channels(blocked, "dsd")).not.toContain(far)
		expect(blocked.activity!.moves).toEqual([])
	})

	it("follows activity to a far raster channel within the dwell and move bounds", () => {
		const far = todayHz[todayHz.length - 1]!
		const hotFar = new Map([
			[far, { state: "hot" as const, score: 4, live: true }],
		])
		const { plans, moves } = simulate(base(), [
			{ atMs: 0, heat: new Map() },
			{ atMs: 5_000, heat: hotFar },
			{ atMs: 19_999, heat: hotFar },
			{ atMs: 20_000, heat: hotFar },
			{ atMs: 25_000, heat: hotFar },
		])
		const at = (i: number) => channels(plans[i]!.plan)
		expect(at(0)).toEqual(todayHz.slice(0, 5))
		// Inside the dwell of every incumbent: no move yet, a deadline is reported.
		expect(at(1)).not.toContain(far)
		expect(plans[1]!.plan.activity!.nextEvaluationMonoMs).toBe(
			ACTIVITY_DWELL_MS,
		)
		expect(at(2)).not.toContain(far)
		// Dwell passed: the lowest-ranked incumbent (farthest of the nearest) yields.
		expect(at(3)).toContain(far)
		expect(at(3)).not.toContain(todayHz[4])
		const moved = plans[3]!.plan.wanted.find(p => p.channelHz === far)!
		expect(moved).toMatchObject({
			origin: "activity",
			gated: true,
			movedFrom: plans[0]!.plan.wanted[4]!.key,
		})
		expect(moves).toHaveLength(1)
		// Stable afterwards: the live channel is never displaced.
		expect(at(4)).toEqual(at(3))
	})

	it("does not reshuffle when the ranking drops out (health flap)", () => {
		const far = todayHz[todayHz.length - 1]!
		const hot = new Map([[far, { state: "hot" as const, score: 4 }]])
		const { plans } = simulate(base(), [
			{ atMs: 0, heat: new Map() },
			{ atMs: 30_000, heat: hot },
			{ atMs: 60_000, heat: hot, status: "stale" },
			{ atMs: 120_000, heat: hot, status: "unavailable" },
			{ atMs: 200_000, heat: new Map(), status: "retuning" },
		])
		const set = (i: number) => new Set(channels(plans[i]!.plan))
		expect(set(1).has(far)).toBe(true)
		expect(set(2)).toEqual(set(1))
		expect(set(3)).toEqual(set(1))
		expect(set(4)).toEqual(set(1))
	})

	// Feature: activity-ranked channels, Property 4: move limits and dwell
	// Validates: Requirements 3.22
	it("never moves more than 6 per minute per source, inside a dwell, or off a live channel", () => {
		const n = todayHz.length
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gapMs: fc.integer({ min: 0, max: 15_000 }),
						hot: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), {
							maxLength: 8,
						}),
						live: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), {
							maxLength: 3,
						}),
						status: fc.constantFrom(
							"ready",
							"ready",
							"ready",
							"stale" as const,
						),
					}),
					{ minLength: 1, maxLength: 40 },
				),
				steps => {
					let t = 0
					const run = steps.map(s => {
						t += s.gapMs
						const heat = new Map<number, Heat>()
						s.hot.forEach((i, rank) =>
							heat.set(todayHz[i]!, { state: "hot", score: 10 - rank }),
						)
						for (const i of s.live)
							heat.set(todayHz[i]!, { state: "hot", score: 1, live: true })
						return { atMs: t, heat, status: s.status }
					})
					const { plans, moves } = simulate(base(), run)
					for (const m of moves) {
						expect(m.atMonoMs - m.victimSince).toBeGreaterThanOrEqual(
							ACTIVITY_DWELL_MS,
						)
						const inWindow = moves.filter(
							o =>
								o.sourceId === m.sourceId &&
								o.atMonoMs > m.atMonoMs - ACTIVITY_MOVE_WINDOW_MS &&
								o.atMonoMs <= m.atMonoMs,
						)
						expect(inWindow.length).toBeLessThanOrEqual(
							ACTIVITY_MOVES_PER_MINUTE,
						)
					}
					// A live incumbent is never the victim, and the fallback never moves.
					plans.forEach(({ plan }, i) => {
						const before = new Set(i > 0 ? channels(plans[i - 1]!.plan) : [])
						for (const m of plan.activity!.moves) {
							expect(before.has(m.fromHz)).toBe(true)
							expect(run[i]!.heat.get(m.fromHz)?.live).not.toBe(true)
							expect(run[i]!.status).toBe("ready")
						}
					})
				},
			),
			{ numRuns: 120 },
		)
	})
})
