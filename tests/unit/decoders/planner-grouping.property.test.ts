import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	ActivityQuery,
	ActivitySnapshot,
} from "../../../src/decoders/enablement/activity-contract.js"
import type {
	ActivityIncumbent,
	ActivityMove,
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
import {
	dsdChallengeKey,
	dsdTierKey,
} from "../../../src/decoders/enablement/dsd-activity.js"
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
				// The same no-sync cooldowns as manager tiers (dsdTierKey) and, for
				// the frozen reference, as its former placement-keyed demotions.
				tiers: g.demoted.map(hz => ({
					key: dsdTierKey("dsd", "s0", hz)!,
					tier: "nosync" as const,
					untilMonoMs: g.nowMonoMs + 10_000,
					failures: 1,
				})),
				...({
					demotions: g.demoted.map(hz => ({
						key: placementKey("dsd", "s0", "channel", hz),
						untilMonoMs: g.nowMonoMs + 10_000,
					})),
				} as object),
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
/** dsd-fme tier reasons, added after the frozen planner: not compared. */
const TIER_REASONS: readonly string[] = [
	"digital-memory",
	"analog-voice",
	"no-sync",
]
// A digital-held dsd-fme channel now ranks first (tier class 0), so activity
// slots may be emitted in another order: they are compared as a set.
const byKey = (a: { key: string }, b: { key: string }) =>
	a.key < b.key ? -1 : a.key > b.key ? 1 : 0
const comparable = (plan: PlacementPlan) => ({
	wanted: [
		...plan.wanted.filter(w => w.origin !== "activity"),
		...plan.wanted.filter(w => w.origin === "activity").sort(byKey),
	].map(w =>
		w.activity?.reasons
			? {
					...w,
					activity: {
						...w.activity,
						reasons: w.activity.reasons.filter(r => !TIER_REASONS.includes(r)),
					},
				}
			: w,
	),
	unplaced: [...plan.unplaced],
	// The move kind, trial mark and lane were added after the frozen planner.
	activity: plan.activity && {
		...plan.activity,
		moves: plan.activity.moves.map(
			({ kind: _kind, trial: _trial, lane: _lane, ...m }) => m,
		),
	},
})

/**
 * Compares a pass with the frozen reference. The dsd-fme tier rules change
 * what the generator reaches (no scanner evidence, no tries, no-sync tiers
 * only from `demoted`, which both planners demote) in these ways only:
 * - an incumbent with an unexpired sync ("held") ranks first in its group
 *   (tier class 0): its group's activity placements come in another order,
 *   and when the group has more incumbents than slots it is kept where the
 *   reference dropped it, leaving fewer victims ("kept");
 * - with two or more replaceable no-sync runs in a group (past their dwell,
 *   no sync, not pinned) the oldest run is the victim, where the reference
 *   took the lowest-ranked ("victim");
 * - the discovery yield (every slot held, count >= 2, a hot unknown; "yield").
 * A pass with no held incumbent and fewer than two runs in every group must
 * equal the reference exactly ("reference"). Otherwise ("projection" when no
 * victim was chosen) the non-activity placements (in order), the unplaced
 * list, the queries, every other group's activity placements and moves are
 * equal; in a diverging group the slot count, the held placements, the
 * moved-to channels and the move count are equal, kept placements plus
 * victims equal the reference's (the same incumbents), the victims are the
 * oldest runs, and a held incumbent comes first in a ranked group.
 * nextEvaluationMonoMs and the group views are not compared there.
 */
function againstReference(
	input: PlannerInput,
	plan: PlacementPlan,
	reference: PlacementPlan,
): "reference" | "projection" | "victim" | "yield" | "kept" | "limited" {
	const act = input.activity!
	const now = act.nowMonoMs
	const pinned = new Set(act.pendingStarts.map(p => p.key))
	const got = comparable(plan)
	const ref = comparable(reference)
	// Intended limits the frozen planner lacks: an unknown or no-sync-tier
	// challenger enters an occupied dsd-fme slot only with the group's trial
	// token (one move per pass, then 300 s), and the other moves stop
	// DSD_RECLAIM_RESERVE = 2 short of the window budget (kept for live
	// reclaims). Where that cuts a dsd-fme group's moves ("limited") the
	// non-activity placements, unplaced list and queries are equal, the
	// dsd-fme group makes at most one move (into a channel the reference
	// moves in, unless the cut left it more budget than the reference had),
	// and a multimon-ng group (more budget left) at least the reference's.
	const groupOf = (m: { decoderId: string; sourceId: string }) =>
		JSON.stringify([m.decoderId, m.sourceId])
	const movesIn = (c: ReturnType<typeof comparable>, g: string) =>
		(c.activity?.moves ?? []).filter(m => groupOf(m) === g)
	const moveGroups = [
		...new Set(
			[...(got.activity?.moves ?? []), ...(ref.activity?.moves ?? [])].map(
				groupOf,
			),
		),
	]
	const cut = moveGroups.filter(
		g =>
			!g.startsWith('["pager"') &&
			movesIn(got, g).length < movesIn(ref, g).length,
	)
	if (cut.length) {
		expect(got.wanted.filter(w => w.origin !== "activity")).toStrictEqual(
			ref.wanted.filter(w => w.origin !== "activity"),
		)
		expect(got.unplaced).toStrictEqual(ref.unplaced)
		expect(got.activity?.queries).toStrictEqual(ref.activity?.queries)
		for (const g of moveGroups) {
			const mine = movesIn(got, g)
			const theirs = movesIn(ref, g)
			if (g.startsWith('["pager"')) {
				// More budget left by a cut dsd-fme group: never fewer moves.
				expect(mine.length).toBeGreaterThanOrEqual(theirs.length)
				continue
			}
			// Unknown challengers only: each move took the trial token, one per
			// lane (fresh, retry).
			const lanes = (plan.activity?.moves ?? [])
				.filter(m => groupOf(m) === g)
				.map(m => m.lane)
			expect(mine.length).toBeLessThanOrEqual(2)
			expect(new Set(lanes).size).toBe(lanes.length)
			if (mine.length <= theirs.length)
				for (const m of mine)
					expect(theirs.map(r => r.toKey)).toContain(m.toKey)
			// The slot count is the reference's; every activity placement is
			// a reference placement, an incumbent the reference moved out, or a
			// sync-held incumbent (it now ranks first, so a shrink the
			// reference resolved by dropping it keeps it).
			const slotsOf = (c: ReturnType<typeof comparable>) =>
				c.wanted.filter(w => w.origin === "activity" && groupOf(w) === g)
			const refKeys = new Set(slotsOf(ref).map(w => w.key))
			const movedOut = new Set(theirs.map(m => m.fromKey))
			const held = new Set(
				act.incumbents.filter(i => i.syncSeen === true).map(i => i.key),
			)
			expect(slotsOf(got)).toHaveLength(slotsOf(ref).length)
			for (const w of slotsOf(got))
				expect(
					refKeys.has(w.key) || movedOut.has(w.key) || held.has(w.key),
					w.key,
				).toBe(true)
		}
		return "limited"
	}
	const groupKeys = [
		...new Set(
			act.incumbents
				.filter(i => i.decoderId !== "pager" && !i.primary)
				.map(i => JSON.stringify([i.decoderId, i.sourceId])),
		),
	]
	const isHeld = (i: ActivityIncumbent) =>
		i.syncSeen === true &&
		i.syncUntilMonoMs !== undefined &&
		now < i.syncUntilMonoMs
	const groups = groupKeys.map(k => {
		const [decoderId, sourceId] = JSON.parse(k) as [string, string]
		// The planner reads the first incumbent of a key (selectChannels and
		// the tier lookup both keep the first), so duplicates are dropped here.
		const seenKeys = new Set<string>()
		const incs = act.incumbents.filter(
			i =>
				i.decoderId === decoderId &&
				i.sourceId === sourceId &&
				!i.primary &&
				!seenKeys.has(i.key) &&
				seenKeys.add(i.key),
		)
		return {
			decoderId,
			sourceId,
			all: incs,
			held: incs.filter(isHeld),
			runs: incs.filter(
				i =>
					i.syncSeen !== true &&
					now - i.dwellSinceMonoMs >= POLICY.dwellMs &&
					!pinned.has(i.key),
			),
		}
	})
	const diverging = groups.filter(g => g.held.length > 0 || g.runs.length >= 2)
	if (!diverging.length) {
		expect(got).toStrictEqual(ref)
		return "reference"
	}
	const inGroup =
		(g: { decoderId: string; sourceId: string }) =>
		(x: { decoderId: string; sourceId: string }) =>
			x.decoderId === g.decoderId && x.sourceId === g.sourceId
	const isDiverging = (x: { decoderId: string; sourceId: string }) =>
		diverging.some(g => inGroup(g)(x))
	const activityOf = (c: ReturnType<typeof comparable>) =>
		c.wanted.filter(w => w.origin === "activity")
	expect(got.wanted.filter(w => w.origin !== "activity")).toStrictEqual(
		ref.wanted.filter(w => w.origin !== "activity"),
	)
	expect(got.unplaced).toStrictEqual(ref.unplaced)
	expect(got.activity?.queries).toStrictEqual(ref.activity?.queries)
	// Groups no tier change reaches: exactly the reference.
	expect(activityOf(got).filter(w => !isDiverging(w))).toStrictEqual(
		activityOf(ref).filter(w => !isDiverging(w)),
	)
	expect(got.activity?.moves.filter(m => !isDiverging(m))).toStrictEqual(
		ref.activity?.moves.filter(m => !isDiverging(m)),
	)
	let kind: "projection" | "victim" | "yield" | "kept" = "projection"
	for (const g of diverging) {
		const gotMoves = (got.activity?.moves ?? []).filter(inGroup(g))
		const refMoves = (ref.activity?.moves ?? []).filter(inGroup(g))
		const heldKeys = new Set(g.held.map(i => i.key))
		const yields = gotMoves.filter(m => heldKeys.has(m.fromKey))
		if (yields.length) {
			// Discovery yield: at most one per pass, only when every slot was
			// held and count >= 2; the reference never moves a synced slot.
			expect(yields).toHaveLength(1)
			expect(refMoves.some(m => heldKeys.has(m.fromKey))).toBe(false)
			const slots = activityOf(got).filter(inGroup(g)).length
			expect(slots).toBeGreaterThanOrEqual(2)
			kind = "yield"
			continue
		}
		const keys = (list: readonly { key: string }[]) =>
			new Set(list.map(w => w.key))
		const gotTo = new Set(gotMoves.map(m => m.toKey))
		const refTo = new Set(refMoves.map(m => m.toKey))
		// Kept placements plus victims: the incumbents each plan worked from.
		const keptAndVictims = (
			wanted: readonly { key: string; decoderId: string; sourceId: string }[],
			moves: readonly ActivityMove[],
			to: ReadonlySet<string>,
		) =>
			new Set([
				...[...keys(wanted.filter(inGroup(g)))].filter(k => !to.has(k)),
				...moves.map(m => m.fromKey),
			])
		const given = plan.activity?.groups.find(inGroup(g))?.given ?? 0
		const distinct = new Set(g.all.map(i => i.hz)).size
		const heldIn = (c: ReturnType<typeof comparable>) =>
			activityOf(c).filter(w => inGroup(g)(w) && heldKeys.has(w.key)).length
		expect(activityOf(got).filter(inGroup(g))).toHaveLength(
			activityOf(ref).filter(inGroup(g)).length,
		)
		if (g.held.length > 0 && distinct > given && heldIn(got) > heldIn(ref)) {
			// More incumbents than slots: the lowest-ranked are dropped, and a
			// held incumbent now ranks first, so it is kept where the reference
			// dropped it. That leaves fewer victims: the moves are a subset.
			const gotKeys = keys(activityOf(got))
			for (const w of activityOf(ref))
				if (heldKeys.has(w.key)) expect(gotKeys.has(w.key)).toBe(true)
			expect(gotMoves.length).toBeLessThanOrEqual(refMoves.length)
			for (const k of gotTo) expect(refTo.has(k)).toBe(true)
			kind = "kept"
			continue
		}
		expect(heldIn(got)).toBe(heldIn(ref))
		expect(gotTo).toEqual(refTo)
		expect(gotMoves).toHaveLength(refMoves.length)
		expect(keptAndVictims(activityOf(got), gotMoves, gotTo)).toEqual(
			keptAndVictims(activityOf(ref), refMoves, refTo),
		)
		if (g.runs.length >= 2 && gotMoves.length > 0) {
			// The victims are the oldest replaceable runs among those planned.
			const planned = keptAndVictims(activityOf(got), gotMoves, gotTo)
			const ages = g.runs
				.filter(i => planned.has(i.key))
				.map(i => i.dwellSinceMonoMs)
				.sort((a, b) => a - b)
			const since = new Map(g.runs.map(i => [i.key, i.dwellSinceMonoMs]))
			const victims = gotMoves
				.map(m => since.get(m.fromKey))
				.sort((a, b) => a! - b!)
			expect(victims).toEqual(ages.slice(0, victims.length))
			if (kind === "projection") kind = "victim"
		}
		const ranked =
			plan.activity?.groups.find(inGroup(g))?.ranking === "activity"
		if (g.held.length > 0 && ranked) {
			// The first activity placement of the group (raw plan order, the
			// group's rank) is a held incumbent, when one is planned. Unranked
			// (nearest order) groups keep today's order.
			const ordered = plan.wanted.filter(
				w => w.origin === "activity" && inGroup(g)(w),
			)
			if (ordered.some(w => heldKeys.has(w.key)))
				expect(heldKeys.has(ordered[0]!.key)).toBe(true)
		}
	}
	return kind
}

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

const SEED = Number.parseInt(process.env["PLANNER_PROPERTY_SEED"] ?? "", 10)
/** Runs of the grouping property (AGENTS.md floor: 100). */
const GROUPING_RUNS = 200
/**
 * Explicit timeout for the grouping property: 200 runs x 8 ms (worst whole-run
 * cost measured, generation included, at load ~26 on 8 cores: 6.1 ms per run
 * with two reference plans, one is now gone) x 8 (load margin, the host has
 * reached ~175) = 12 800 ms. Measured: 0.44-0.48 s per run of 200 at load ~12.
 */
const GROUPING_TIMEOUT_MS = GROUPING_RUNS * 8 * 8

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
	// A failure prints fast-check's seed and path (fc.assert's message, with
	// the counterexample); PLANNER_PROPERTY_SEED replays a seed.
	it(
		"plans what the reference plans, without and with the grouping of the same pass",
		{ timeout: GROUPING_TIMEOUT_MS },
		() => {
			const reach = {
				runs: 0,
				reference: 0,
				projection: 0,
				victim: 0,
				yield: 0,
				kept: 0,
				limited: 0,
				wanted: 0,
				queries: 0,
				moves: 0,
				gated: 0,
				lookups: 0,
				unranked: 0,
			}
			fc.assert(
				fc.property(raw, fc.nat(1_000), fc.nat(255), (pre, seed, pick) => {
					// The reference's queries without snapshots (the property above
					// holds activityQueries to them), so only one reference plan runs.
					const queries = activityQueries(pre)
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
					// Always held to the frozen reference: exactly where no intended
					// dsd-fme tier change applies, on the invariant projection with the
					// intended differences asserted explicitly where one does.
					const plan = planPlacements(answered)
					const expected = comparable(plan)
					const kind = againstReference(answered, plan, referencePlan(answered))
					reach[kind]++
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
				{
					numRuns: GROUPING_RUNS,
					verbose: 1,
					...(Number.isNaN(SEED) ? {} : { seed: SEED }),
				},
			)
			expect(reach.wanted / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.queries / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.moves / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.gated / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.lookups / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.unranked / reach.runs).toBeGreaterThanOrEqual(0.2)
			// Path reach, measured over five runs of 400: reference 122-131 (30-33 %),
			// projection 150-186, victim choice 88-110 (22-28 %), kept 1-9, yield 0
			// (the generator never holds every slot). Every run takes one path.
			// The trial token and the T1 move reserve move some former reference
			// runs to "limited", which must be reached.
			expect(reach.reference / reach.runs).toBeGreaterThanOrEqual(0.2)
			expect(reach.limited).toBeGreaterThan(0)
			expect(reach.victim / reach.runs).toBeGreaterThanOrEqual(0.1)
			expect(reach.projection).toBeGreaterThan(0)
			expect(reach.victim).toBeGreaterThan(0)
			expect(
				reach.reference +
					reach.projection +
					reach.victim +
					reach.yield +
					reach.kept +
					reach.limited,
			).toBe(reach.runs)
		},
	)
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
