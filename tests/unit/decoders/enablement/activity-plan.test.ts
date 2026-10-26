import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type {
	ActivityQuery,
	ActivitySnapshot,
	ChannelActivity,
} from "../../../../src/decoders/enablement/activity-contract.js"
import {
	ACTIVITY_DWELL_MS,
	ACTIVITY_MOVES_PER_MINUTE,
	ACTIVITY_REPLAY_CORES_ARM64,
	ACTIVITY_REPLAY_CORES_X64,
	ACTIVITY_SLOTS_ARM64,
	ACTIVITY_SLOTS_X64,
	activityOrder,
	allocateActivitySlots,
	readySnapshot,
	resolveActivityPolicy,
	selectChannels,
} from "../../../../src/decoders/enablement/activity-plan.js"
import type { SlotCharge } from "../../../../src/decoders/enablement/activity-plan.js"
import {
	EFFICIENCY_BUDGET_ARM64,
	EFFICIENCY_BUDGET_X64,
	channelizerBaseCores,
	placementCostCores,
} from "../../../../src/decoders/enablement/contract.js"

const EPOCH = { sourceId: "s", engineId: "e1", epoch: 3 }
const query = (candidatesHz: number[]): ActivityQuery => ({
	epoch: EPOCH,
	decoderId: "pager",
	decoderType: "multimon-ng",
	protocols: ["pocsag", "flex"],
	centreHz: 466_100_000,
	candidatesHz,
	channelWidthHz: 12_000,
})
const channel = (
	hz: number,
	over: Partial<ChannelActivity> = {},
): ChannelActivity => ({
	hz,
	score: 0,
	state: "cold",
	reasons: [],
	live: false,
	lastEnergyMonoMs: null,
	stateSinceMonoMs: 0,
	...over,
})
const snapshot = (
	q: ActivityQuery,
	channels: ChannelActivity[] = q.candidatesHz.map(hz => channel(hz)),
	over: Partial<ActivitySnapshot> = {},
): ActivitySnapshot => ({
	query: q,
	revision: 1,
	evaluatedMonoMs: 0,
	lastFrameMonoMs: 0,
	status: "ready",
	nextEvaluationMonoMs: null,
	channels,
	...over,
})

describe("readySnapshot", () => {
	const q = query([1, 2, 3])
	it("accepts one ready snapshot of the same epoch and candidates", () => {
		const s = snapshot(q)
		expect(readySnapshot(q, [s])).toBe(s)
	})
	it.each([
		["unavailable", snapshot(q, undefined, { status: "unavailable" })],
		["retuning", snapshot(q, undefined, { status: "retuning" })],
		["stale", snapshot(q, undefined, { status: "stale" })],
		[
			"another epoch",
			snapshot({ ...q, epoch: { ...EPOCH, epoch: 4 } }, undefined),
		],
		[
			"another engine",
			snapshot({ ...q, epoch: { ...EPOCH, engineId: "e2" } }, undefined),
		],
		["missing candidate", snapshot(q, [channel(1), channel(2)])],
		[
			"extra candidate",
			snapshot(q, [channel(1), channel(2), channel(3), channel(4)]),
		],
		["duplicate candidate", snapshot(q, [channel(1), channel(1), channel(3)])],
		["reordered", snapshot(q, [channel(2), channel(1), channel(3)])],
		["other candidates", snapshot(query([1, 2, 4]))],
		[
			"negative score",
			snapshot(q, [channel(1, { score: -1 }), channel(2), channel(3)]),
		],
		[
			"NaN score",
			snapshot(q, [channel(1, { score: NaN }), channel(2), channel(3)]),
		],
		[
			"bad state",
			snapshot(q, [
				channel(1, { state: "boiling" as never }),
				channel(2),
				channel(3),
			]),
		],
	])("falls back on %s", (_name, s) => {
		expect(readySnapshot(q, [s])).toBeNull()
		expect(activityOrder(q.candidatesHz, readySnapshot(q, [s]))).toEqual([
			1, 2, 3,
		])
	})
	it("falls back when two snapshots answer the same query", () => {
		expect(readySnapshot(q, [snapshot(q), snapshot(q)])).toBeNull()
		expect(readySnapshot(q, [])).toBeNull()
	})
})

describe("activityOrder", () => {
	it("orders hot by score, then warm by score, then cold in today's order", () => {
		const q = query([10, 20, 30, 40, 50, 60])
		const s = snapshot(q, [
			channel(10),
			channel(20, { state: "warm", score: 1 }),
			channel(30, { state: "hot", score: 3 }),
			channel(40, { state: "warm", score: 2 }),
			channel(50),
			channel(60, { state: "hot", score: 5 }),
		])
		expect(activityOrder(q.candidatesHz, s)).toEqual([60, 30, 40, 20, 10, 50])
	})

	// Feature: activity-ranked channels, Property 1: ranking is a permutation
	// Validates: Requirements 3.22
	it("is always a permutation of the candidates", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 1, max: 1_000 }), {
					minLength: 1,
					maxLength: 40,
				}),
				fc.array(
					fc.record({
						state: fc.constantFrom("hot", "warm", "cold" as const),
						score: fc.double({ min: 0, max: 20, noNaN: true }),
					}),
					{ minLength: 40, maxLength: 40 },
				),
				(hzs, states) => {
					const q = query(hzs)
					const s = snapshot(
						q,
						hzs.map((hz, i) => channel(hz, states[i]!)),
					)
					const order = activityOrder(hzs, readySnapshot(q, [s]))
					expect([...order].sort((a, b) => a - b)).toEqual(
						[...hzs].sort((a, b) => a - b),
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("allocateActivitySlots", () => {
	const RATE = 1_024_000
	const mm = placementCostCores("multimon-ng", "channel")
	const dsd = placementCostCores("dsd-fme", "channel")
	const charge = (
		key: string,
		cost: number,
		sourceId = "s",
		rate = RATE,
	): SlotCharge => ({
		key,
		sourceId,
		reach: "channel",
		costCores: cost,
		sampleRateHz: rate,
	})

	it("states the x86-64 default arithmetic: VFO+4 paging, VFO+2 digital voice", () => {
		const out = allocateActivitySlots({
			budgetCores: EFFICIENCY_BUDGET_X64,
			replayAllowanceCores: ACTIVITY_REPLAY_CORES_X64,
			mandatory: [charge("mm-vfo", mm), charge("dsd-vfo", dsd)],
			pending: [],
			plannedKeys: new Set(),
			groups: [
				{ sourceId: "s", sampleRateHz: RATE, perChannelCores: mm, want: 4 },
				{ sourceId: "s", sampleRateHz: RATE, perChannelCores: dsd, want: 2 },
			],
		})
		expect(out.given).toEqual([4, 2])
		// 0.22 + 5 x 0.14 + 3 x 0.155 + 0.10 = 1.485
		expect(out.committedCores).toBeCloseTo(0.22 + mm + dsd, 9)
		expect(EFFICIENCY_BUDGET_X64 - out.remainingCores).toBeCloseTo(1.485, 9)
	})

	it("states the arm64 default arithmetic within 0.75 core", () => {
		const out = allocateActivitySlots({
			budgetCores: EFFICIENCY_BUDGET_ARM64,
			replayAllowanceCores: ACTIVITY_REPLAY_CORES_ARM64,
			mandatory: [charge("mm-vfo", mm), charge("dsd-vfo", dsd)],
			pending: [],
			plannedKeys: new Set(),
			groups: [
				{
					sourceId: "s",
					sampleRateHz: RATE,
					perChannelCores: mm,
					want: ACTIVITY_SLOTS_ARM64["multimon-ng"],
				},
				{
					sourceId: "s",
					sampleRateHz: RATE,
					perChannelCores: dsd,
					want: ACTIVITY_SLOTS_ARM64["dsd-fme"],
				},
			],
		})
		expect(out.given).toEqual([1, 0])
		// 0.22 + 2 x 0.14 + 0.155 + 0.05 = 0.705 <= 0.75
		expect(EFFICIENCY_BUDGET_ARM64 - out.remainingCores).toBeCloseTo(0.705, 9)
		// The old example (VFO + 2 paging slots beside the dsd-fme VFO) did not fit.
		expect(0.22 + 3 * mm + dsd).toBeGreaterThan(EFFICIENCY_BUDGET_ARM64)
	})

	it("gives a slot exactly at the budget and none just past it", () => {
		const base = channelizerBaseCores(RATE)
		const at = base + mm + 3 * mm
		const run = (budgetCores: number) =>
			allocateActivitySlots({
				budgetCores,
				replayAllowanceCores: 0,
				mandatory: [charge("vfo", mm)],
				pending: [],
				plannedKeys: new Set(),
				groups: [
					{ sourceId: "s", sampleRateHz: RATE, perChannelCores: mm, want: 8 },
				],
			}).given[0]
		expect(run(at)).toBe(3)
		expect(run(at - 1e-6)).toBe(2)
	})

	it("charges a second source its own channelizer base, 0.26 above 2.048 Msps", () => {
		const out = allocateActivitySlots({
			budgetCores: 0.22 + mm + 0.26 + mm,
			replayAllowanceCores: 0,
			mandatory: [charge("vfo", mm)],
			pending: [],
			plannedKeys: new Set(),
			groups: [
				{ sourceId: "s", sampleRateHz: RATE, perChannelCores: mm, want: 0 },
				{
					sourceId: "t",
					sampleRateHz: 2_400_000,
					perChannelCores: mm,
					want: 2,
				},
			],
		})
		expect(out.given).toEqual([0, 1])
		expect(out.remainingCores).toBeCloseTo(0, 9)
	})

	it("charges pending starts the plan does not count, once", () => {
		const groups = [
			{ sourceId: "s", sampleRateHz: RATE, perChannelCores: mm, want: 8 },
		]
		const budgetCores = 0.22 + mm + 4 * mm
		const pending = [
			charge("other", mm),
			charge("other", mm),
			charge("known", mm),
		]
		const out = allocateActivitySlots({
			budgetCores,
			replayAllowanceCores: 0,
			mandatory: [charge("vfo", mm)],
			pending,
			plannedKeys: new Set(["known"]),
			groups,
		})
		expect(out.given).toEqual([3])
	})

	it("gives nothing when mandatory placements already exceed the budget", () => {
		const out = allocateActivitySlots({
			budgetCores: 0.5,
			replayAllowanceCores: 0.1,
			mandatory: [charge("a", 0.3), charge("b", 0.3)],
			pending: [],
			plannedKeys: new Set(),
			groups: [
				{ sourceId: "s", sampleRateHz: RATE, perChannelCores: mm, want: 4 },
			],
		})
		expect(out.given).toEqual([0])
	})

	// Feature: activity-ranked channels, Property 3: the budget is never exceeded or double-spent
	// Validates: Requirements 3.22
	it("never spends more than the budget across decoders and sources", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 4, noNaN: true }),
				fc.double({ min: 0, max: 0.5, noNaN: true }),
				fc.array(
					fc.record({
						source: fc.constantFrom("s", "t", "u"),
						cost: fc.constantFrom(0.14, 0.155, 0.21, 0.25),
					}),
					{ maxLength: 6 },
				),
				fc.array(
					fc.record({
						source: fc.constantFrom("s", "t", "u"),
						cost: fc.constantFrom(mm, dsd),
						want: fc.integer({ min: 0, max: 10 }),
					}),
					{ maxLength: 6 },
				),
				(budgetCores, replay, mandatory, groups) => {
					const rate = (id: string) => (id === "u" ? 2_400_000 : RATE)
					const out = allocateActivitySlots({
						budgetCores,
						replayAllowanceCores: replay,
						mandatory: mandatory.map((m, i) =>
							charge(`m${i}`, m.cost, m.source, rate(m.source)),
						),
						pending: [],
						plannedKeys: new Set(),
						groups: groups.map(g => ({
							sourceId: g.source,
							sampleRateHz: rate(g.source),
							perChannelCores: g.cost,
							want: g.want,
						})),
					})
					let total = 0
					const bases = new Set<string>()
					for (const m of mandatory) {
						total += m.cost
						bases.add(m.source)
					}
					groups.forEach((g, i) => {
						expect(out.given[i]).toBeLessThanOrEqual(g.want)
						expect(out.given[i]).toBeGreaterThanOrEqual(0)
						total += out.given[i]! * g.cost
						if (out.given[i]! > 0) bases.add(g.source)
					})
					for (const id of bases) total += channelizerBaseCores(rate(id))
					if (out.given.some(n => n > 0))
						expect(total + replay).toBeLessThanOrEqual(budgetCores + 1e-6)
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("selectChannels", () => {
	const hot = (hz: number, live = false) =>
		channel(hz, { state: "hot", score: 4, live })
	const base = {
		ranked: true,
		nowMonoMs: 60_000,
		dwellMs: ACTIVITY_DWELL_MS,
		movesLeft: ACTIVITY_MOVES_PER_MINUTE,
		moveWindowFreesMonoMs: null,
	}
	it("fills free slots in order with no move", () => {
		const out = selectChannels({
			...base,
			order: [1, 2, 3],
			activity: null,
			ranked: false,
			count: 2,
			incumbents: [],
		})
		expect(out.chosen).toEqual([{ hz: 1 }, { hz: 2 }])
		expect(out.moves).toBe(0)
	})
	it("moves the lowest-ranked incumbent past its dwell for a hot channel", () => {
		const activity = new Map([
			[9, hot(9)],
			[1, channel(1)],
			[2, channel(2)],
		])
		const out = selectChannels({
			...base,
			order: [9, 1, 2],
			activity,
			count: 2,
			incumbents: [
				{ key: "k1", hz: 1, dwellSinceMonoMs: 0 },
				{ key: "k2", hz: 2, dwellSinceMonoMs: 0 },
			],
		})
		expect(out.chosen).toEqual([
			{ hz: 9, movedFrom: { key: "k2", hz: 2 } },
			{ hz: 1 },
		])
		expect(out.moves).toBe(1)
	})
	it("never displaces a live incumbent or one inside its dwell", () => {
		const activity = new Map([
			[9, hot(9)],
			[1, hot(1, true)],
			[2, channel(2)],
		])
		const out = selectChannels({
			...base,
			order: [9, 1, 2],
			activity: new Map([...activity, [1, { ...channel(1), live: true }]]),
			count: 2,
			incumbents: [
				{ key: "k1", hz: 1, dwellSinceMonoMs: 0 },
				{ key: "k2", hz: 2, dwellSinceMonoMs: 50_000 },
			],
		})
		expect(out.chosen.map(c => c.hz)).toEqual([1, 2])
		expect(out.moves).toBe(0)
		expect(out.blockedUntilMonoMs).toBe(50_000 + ACTIVITY_DWELL_MS)
	})
	it("stops at the move limit and reports when the window frees", () => {
		const out = selectChannels({
			...base,
			order: [9, 1],
			activity: new Map([
				[9, hot(9)],
				[1, channel(1)],
			]),
			count: 1,
			incumbents: [{ key: "k1", hz: 1, dwellSinceMonoMs: 0 }],
			movesLeft: 0,
			moveWindowFreesMonoMs: 70_000,
		})
		expect(out.chosen).toEqual([{ hz: 1 }])
		expect(out.blockedUntilMonoMs).toBe(70_000)
	})
	it("a cold channel never displaces an incumbent, and the fallback never moves", () => {
		const cold = selectChannels({
			...base,
			order: [5, 1],
			activity: new Map([
				[5, channel(5)],
				[1, channel(1)],
			]),
			count: 1,
			incumbents: [{ key: "k1", hz: 1, dwellSinceMonoMs: 0 }],
		})
		expect(cold.chosen).toEqual([{ hz: 1 }])
		const fallback = selectChannels({
			...base,
			ranked: false,
			order: [5, 1],
			activity: null,
			count: 1,
			incumbents: [{ key: "k1", hz: 1, dwellSinceMonoMs: 0 }],
		})
		expect(fallback.chosen).toEqual([{ hz: 1 }])
	})
	it("drops the lowest-ranked incumbents when the slot count shrinks", () => {
		const out = selectChannels({
			...base,
			ranked: false,
			order: [1, 2, 3],
			activity: null,
			count: 1,
			incumbents: [
				{ key: "k3", hz: 3, dwellSinceMonoMs: 0 },
				{ key: "k2", hz: 2, dwellSinceMonoMs: 0 },
			],
		})
		expect(out.chosen).toEqual([{ hz: 2 }])
	})
})

describe("resolveActivityPolicy", () => {
	it("defaults per host and honours configured values", () => {
		expect(resolveActivityPolicy(undefined, 1.5, "x64", 8)).toEqual({
			slots: ACTIVITY_SLOTS_X64,
			replayAllowanceCores: ACTIVITY_REPLAY_CORES_X64,
			budgetCores: 1.5,
			maxMovesPerMinute: 6,
			dwellMs: 20_000,
		})
		expect(resolveActivityPolicy(undefined, 0.75, "arm64", 4).slots).toEqual(
			ACTIVITY_SLOTS_ARM64,
		)
		expect(
			resolveActivityPolicy(
				{ slots: { "dsd-fme": 5 }, dwellMs: 1_000, maxMovesPerMinute: 2 },
				1.5,
				"x64",
				8,
			),
		).toMatchObject({
			slots: { "multimon-ng": 4, "dsd-fme": 5 },
			dwellMs: 1_000,
			maxMovesPerMinute: 2,
		})
	})
})
