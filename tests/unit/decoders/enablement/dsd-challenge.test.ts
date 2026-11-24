import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type {
	ActivitySnapshot,
	ChannelActivity,
} from "../../../../src/decoders/enablement/activity-contract.js"
import {
	ACTIVITY_DWELL_MS,
	activityOrder,
	mayTake,
	resolveActivityPolicy,
	selectChannels,
	victimColumn,
} from "../../../../src/decoders/enablement/activity-plan.js"
import type {
	MoveKind,
	SlotClass,
	SlotTier,
	TakeChallenger,
	TakeContext,
	TakeVictim,
} from "../../../../src/decoders/enablement/activity-plan.js"
import {
	DSD_BURST_MAX_MS,
	DSD_BURST_MIN_MS,
	DSD_BURST_OFF_MS,
	DSD_CHALLENGE_BURST_MEMORY_MS,
	DSD_CHALLENGE_MAX_OBSERVATIONS,
	DSD_CHALLENGE_MEMORY_MS,
	DSD_CHALLENGE_MIN_OBSERVATIONS,
	DSD_CHALLENGE_MIN_SPAN_MS,
	DSD_CHALLENGE_THIN_MS,
	DSD_DECAY_LIVE_MS,
	DSD_DIGITAL_HOLD_MS,
	DSD_MAX_CHALLENGERS,
	DSD_QUIET_VICTIM_MS,
	DSD_RECLAIM_BUDGET,
	DSD_RECLAIM_WINDOW_MS,
	DsdChallengeEvidence,
	DsdChannelTiers,
	dsdTierKey,
	dsdActivitySlotAllowed,
	dsdChallengeKey,
	dsdGroupKey,
} from "../../../../src/decoders/enablement/dsd-activity.js"

describe("R2: dsd-fme activity slots only in digital-voice band plans", () => {
	it.each([
		// EU: UHF land mobile 400-470 MHz, PMR446, VHF land mobile 136-174 MHz.
		["EU", 466_100_000, true],
		["EU", 446_050_000, true],
		["EU", 400_000_000, true],
		["EU", 399_999_999, false],
		["EU", 470_000_000, true],
		["EU", 470_000_001, false],
		["EU", 136_000_000, true],
		["EU", 135_999_999, false],
		["EU", 174_000_000, true],
		["EU", 174_000_001, false],
		["EU", 145_500_000, true],
		// 433 MHz ISM (433.05-434.79 MHz) lies inside 70 cm but is ISM: never.
		["EU", 433_049_999, true],
		["EU", 433_050_000, false],
		["EU", 433_920_000, false],
		["EU", 434_790_000, false],
		["EU", 434_790_001, true],
		// 863-870 MHz ISM/SRD (LoRa, telemetry) and anything without a plan.
		["EU", 862_999_999, false],
		["EU", 863_000_000, false],
		["EU", 868_950_000, false],
		["EU", 870_000_000, false],
		["EU", 870_000_001, false],
		["EU", 1_090_000_000, false],
		["US", 915_000_000, false],
		["US", 446_000_000, true],
		// US/CA 700/800/900 MHz land mobile, inclusive edges.
		["US", 768_999_999, false],
		["US", 769_000_000, true],
		["US", 805_000_000, true],
		["US", 805_000_001, false],
		["US", 851_150_000, true],
		["US", 868_950_000, true],
		["US", 869_000_000, true],
		["US", 869_000_001, false],
		["CA", 935_000_000, true],
		["CA", 940_000_001, false],
		["AU", 851_150_000, false],
	] as const)("%s %d Hz allowed: %s", (region, hz, allowed) => {
		expect(dsdActivitySlotAllowed(region, hz)).toBe(allowed)
	})

	it.each([NaN, Infinity, 0, -1])(
		"refuses a malformed frequency (%d) and an unknown region",
		hz => {
			expect(dsdActivitySlotAllowed("EU", hz)).toBe(false)
			expect(dsdActivitySlotAllowed(undefined, 466_100_000)).toBe(false)
		},
	)
})

describe("R2: dsd-fme challenge hysteresis bounds", () => {
	const key = dsdChallengeKey("dsd", "s", 466_100_000)

	it("states the bounds from the dwell and move window", () => {
		expect(DSD_CHALLENGE_MIN_OBSERVATIONS).toBe(2)
		expect(DSD_CHALLENGE_MIN_SPAN_MS).toBe(ACTIVITY_DWELL_MS / 2)
		expect(DSD_CHALLENGE_MIN_SPAN_MS).toBe(10_000)
		expect(DSD_CHALLENGE_MEMORY_MS).toBe(120_000)
	})

	it.each([
		[9_999, false],
		[10_000, true],
		[10_001, true],
	])("energy spanning %i ms confirms: %s", (span, ok) => {
		const e = new DsdChallengeEvidence()
		e.note(key, 1_000.5, 1_000.5)
		e.note(key, 1_000.5 + span, 1_000.5 + span)
		expect(e.confirmed(key, 1_000.5 + span)).toBe(ok)
		expect(e.snapshot(1_000.5 + span)).toEqual(ok ? [key] : [])
	})

	it("one observation never confirms, however old; the same energy is not a repeat", () => {
		const e = new DsdChallengeEvidence()
		e.note(key, 0, 0)
		expect(e.confirmed(key, 50_000)).toBe(false)
		e.note(key, 0, 50_000)
		e.note(key, -1, 50_000)
		expect(e.confirmed(key, 50_000)).toBe(false)
	})

	it.each([
		[119_999, true],
		[120_000, false],
		[120_001, false],
	])("evidence aged %i ms is kept: %s (the 120 s memory)", (age, kept) => {
		const e = new DsdChallengeEvidence()
		e.note(key, 1_000, 1_000)
		e.note(key, 11_000, 11_000)
		expect(e.confirmed(key, 1_000 + age)).toBe(kept)
		// A late first observation at/past the memory is not recorded at all.
		const late = new DsdChallengeEvidence()
		late.note(key, 1_000, 1_000 + age)
		late.note(key, 1_000 + age, 1_000 + age)
		expect(late.confirmed(key, 1_000 + age)).toBe(kept)
	})

	it("ignores future and non-finite energy", () => {
		const e = new DsdChallengeEvidence()
		e.note(key, 30_000, 20_000)
		e.note(key, NaN, 20_000)
		e.note(key, null, 20_000)
		e.note(key, 5_000, 20_000)
		expect(e.confirmed(key, 20_000)).toBe(false)
	})

	it("thins to one timestamp per 5 s plus the newest, at most 26, never losing the oldest early", () => {
		expect(DSD_CHALLENGE_THIN_MS).toBe(5_000)
		expect(DSD_CHALLENGE_MAX_OBSERVATIONS).toBe(26)
		const e = new DsdChallengeEvidence()
		// A continuous transmission seen every 250 ms confirms exactly at 10 s.
		for (let t = 0; t < 10_000; t += 250) {
			e.note(key, t, t)
			expect(e.confirmed(key, t)).toBe(false)
		}
		e.note(key, 10_000, 10_000)
		expect(e.confirmed(key, 10_000)).toBe(true)
		// Kept for the whole memory: still confirmed after the first ages out,
		// once the thinned timestamps have spread.
		for (let t = 10_250; t <= 300_000; t += 250) {
			e.note(key, t, t)
			expect(e.confirmed(key, t)).toBe(true)
		}
	})

	it.each([4_999, 5_000, 5_001])(
		"a timestamp %i ms after the one before the newest replaces or adds",
		gap => {
			const e = new DsdChallengeEvidence()
			e.note(key, 0, 0)
			e.note(key, 1, 1)
			e.note(key, gap, gap)
			// Replaced: [0, gap]; added: [0, 1, gap]. Both keep the oldest and newest.
			e.note(key, 10_000, 10_000)
			expect(e.confirmed(key, 10_000)).toBe(true)
			// After 0 and 1 age out (memory 120 s), the kept 10 000 still pairs.
			e.note(key, 120_001, 120_001)
			expect(e.confirmed(key, 120_001)).toBe(true)
		},
	)

	/** One pass per `step` ms; `on(t)` says whether the channel is live at t. */
	const observe = (
		e: DsdChallengeEvidence,
		on: (t: number) => boolean,
		from: number,
		to: number,
		step: number,
		k = key,
	) => {
		let last: number | null = null
		const paired: number[] = []
		for (let t = from; t <= to; t += step) {
			if (on(t)) last = t
			e.note(k, last, t, on(t))
			if (e.burstPaired(k, t)) paired.push(t)
		}
		return paired
	}

	it("states the burst bounds", () => {
		expect(DSD_CHALLENGE_BURST_MEMORY_MS).toBe(900_000)
		expect(DSD_BURST_MIN_MS).toBe(1_000)
		expect(DSD_BURST_MAX_MS).toBe(60_000)
		expect(DSD_BURST_OFF_MS).toBe(60_000)
	})

	it("two 3 s bursts 120 s to 15 min apart with an observed off period pair, for 120 s after the second onset", () => {
		const pair = (gap: number, at: number) => {
			const e = new DsdChallengeEvidence()
			const on = (t: number) =>
				(t >= 1_000 && t < 4_000) || (t >= 1_000 + gap && t < 4_000 + gap)
			observe(e, on, 0, 1_000 + gap + 250, 250)
			return e.burstPaired(key, 1_000 + gap + at)
		}
		expect(pair(119_999, 0)).toBe(false)
		expect(pair(120_000, 0)).toBe(true)
		expect(pair(240_000, 0)).toBe(true)
		expect(pair(899_750, 0)).toBe(true)
		expect(pair(900_000, 0)).toBe(false)
		expect(pair(240_000, 119_999)).toBe(true)
		expect(pair(240_000, 120_000)).toBe(false)
		// A burst pair also confirms (the hysteresis), a single burst does not.
		const e = new DsdChallengeEvidence()
		const on = (t: number) =>
			(t >= 1_000 && t < 4_000) || (t >= 300_000 && t < 303_000)
		observe(e, on, 0, 4_000, 250)
		expect(e.confirmed(key, 4_000)).toBe(false)
		observe(e, on, 4_250, 300_250, 250)
		expect(e.confirmed(key, 300_250)).toBe(true)
		expect(e.burstPairedKeys(300_250)).toEqual([key])
		expect(e.snapshot(300_250)).toEqual([key])
	})

	it.each([
		[999, false],
		[1_000, true],
		[60_000, true],
		[60_001, false],
	])("a first burst lasting %i ms may pair: %s", (len, ok) => {
		const e = new DsdChallengeEvidence()
		// Passes at the edges: onset 0, end 0 + len, second onset 300 s.
		e.note(key, 0, 0, true)
		e.note(key, len, len + 100, false)
		e.note(key, 300_000, 300_000, true)
		expect(e.burstPaired(key, 300_000)).toBe(ok)
	})

	it.each([
		[59_999, false],
		[60_000, true],
	])(
		"an off period of %i ms before the second onset may pair: %s",
		(off, ok) => {
			const e = new DsdChallengeEvidence()
			// The longest first burst (60 s) from 0: with onsets >= 120 s apart
			// the off period is >= 120 - 60 = 60 s, so the off bound is reached
			// exactly at the longest burst and the shortest onset gap.
			e.note(key, 0, 0, true)
			e.note(key, DSD_BURST_MAX_MS, DSD_BURST_MAX_MS + 10, false)
			const onset = DSD_BURST_MAX_MS + off
			e.note(key, onset, onset, true)
			expect(e.burstPaired(key, onset)).toBe(ok)
		},
	)

	// Feature: dsd-digital-tiers, Property 6: a steady carrier never burst-pairs
	// Validates: Requirements 3.8
	it("P6: a steady carrier observed at any sparse pass times never burst-pairs", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000 }),
				fc.array(fc.integer({ min: 1, max: 600_000 }), {
					minLength: 1,
					maxLength: 40,
				}),
				(start, gaps) => {
					const e = new DsdChallengeEvidence()
					let t = start
					for (const g of gaps) {
						t += g
						e.note(key, t - 100, t, true)
						expect(e.burstPaired(key, t)).toBe(false)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: dsd-digital-tiers, Property 7: runs under 1 s are never a first burst
	// Validates: Requirements 3.8
	it("P7: a run shorter than 1 s is never the first burst of a pair", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: DSD_BURST_MIN_MS - 1 }),
				fc.integer({ min: 120_000, max: 899_000 }),
				fc.array(fc.integer({ min: 0, max: 200_000 }), { maxLength: 10 }),
				(len, gap, probes) => {
					const e = new DsdChallengeEvidence()
					e.note(key, 0, 0, true)
					e.note(key, len, len + 50, false)
					e.note(key, gap, gap, true)
					for (const p of [0, ...probes])
						expect(e.burstPaired(key, gap + p)).toBe(false)
				},
			),
			{ numRuns: 200 },
		)
	})

	it.each([DSD_MAX_CHALLENGERS, DSD_MAX_CHALLENGERS + 1])(
		"tracks %i burst runs, dropping the oldest insertion past 1 024",
		count => {
			const e = new DsdChallengeEvidence()
			const k = (i: number) => dsdChallengeKey("dsd", "s", 400_000_000 + i)
			for (let i = 0; i < count; i++) {
				e.note(k(i), 0, 0, true)
				e.note(k(i), 3_000, 3_100, false)
			}
			e.note(k(count - 1), 200_000, 200_000, true)
			e.note(k(0), 200_000, 200_000, true)
			const paired = e.burstPairedKeys(200_000)
			expect(paired.includes(k(count - 1))).toBe(true)
			expect(paired.includes(k(0))).toBe(count === DSD_MAX_CHALLENGERS)
		},
	)

	it("a single burst never pairs with itself, and runs are swept 15 min after the end", () => {
		const e = new DsdChallengeEvidence()
		observe(e, t => t >= 0 && t < 3_000, 0, 200_000, 1_000)
		expect(e.burstPaired(key, 200_000)).toBe(false)
		e.snapshot(2_999 + DSD_CHALLENGE_BURST_MEMORY_MS)
		e.note(key, 1_000_000, 1_000_000, true)
		expect(e.burstPaired(key, 1_000_000)).toBe(false)
	})

	it.each([DSD_MAX_CHALLENGERS, DSD_MAX_CHALLENGERS + 1])(
		"tracks %i channels, dropping the oldest insertion past 1 024",
		count => {
			const e = new DsdChallengeEvidence()
			for (let i = 0; i < count; i++) {
				const k = dsdChallengeKey("dsd", "s", 400_000_000 + i)
				e.note(k, 0, 0)
				e.note(k, 10_000, 10_000)
			}
			const confirmed = e.snapshot(10_000)
			expect(confirmed).toHaveLength(DSD_MAX_CHALLENGERS)
			expect(confirmed.includes(dsdChallengeKey("dsd", "s", 400_000_000))).toBe(
				count === DSD_MAX_CHALLENGERS,
			)
		},
	)
})

/**
 * One (decoder, source) group: an incumbent past its dwell, never live, no
 * sync; a challenger that is hot (outranks it) at every pass. Each pass
 * records the challenger's energy and asks selectChannels for a move.
 */
function runPasses(
	passes: readonly number[],
	energyAt: (now: number) => number | null,
	liveAt: (now: number) => boolean,
): number | null {
	const evidence = new DsdChallengeEvidence()
	const incumbentHz = 466_150_000
	const challengerHz = 466_100_000
	const key = dsdChallengeKey("dsd", "s", challengerHz)
	for (const now of passes) {
		evidence.note(key, energyAt(now), now)
		const confirmed = new Set(evidence.snapshot(now))
		const activity = new Map<number, ChannelActivity>([
			[
				challengerHz,
				{
					hz: challengerHz,
					score: liveAt(now) ? 102 : 2,
					state: "hot",
					reasons: ["live-energy"],
					live: liveAt(now),
					lastEnergyMonoMs: energyAt(now),
					stateSinceMonoMs: 0,
				},
			],
			[
				incumbentHz,
				{
					hz: incumbentHz,
					score: 0,
					state: "cold",
					reasons: [],
					live: false,
					lastEnergyMonoMs: null,
					stateSinceMonoMs: 0,
				},
			],
		])
		const { moves } = selectChannels({
			order: [challengerHz, incumbentHz],
			ranked: true,
			activity,
			count: 1,
			canChallenge: hz => confirmed.has(dsdChallengeKey("dsd", "s", hz)),
			incumbents: [{ key: "slot", hz: incumbentHz, dwellSinceMonoMs: -1e9 }],
			nowMonoMs: now,
			dwellMs: ACTIVITY_DWELL_MS,
			movesLeft: 6,
			moveWindowFreesMonoMs: null,
		})
		// The first pass that would move the slot, or null for none.
		if (moves > 0) return now
	}
	return null
}

// Feature: channel-churn, Property 1: random one-off bursts never move a slot
// Validates: Requirements R2
it("a one-off burst shorter than the challenge span never moves a dsd-fme slot", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 1_000_000 }),
			fc.integer({ min: 0, max: DSD_CHALLENGE_MIN_SPAN_MS - 1 }),
			fc.array(fc.integer({ min: -5_000, max: 200_000 }), {
				minLength: 1,
				maxLength: 60,
			}),
			(start, duration, offsets) => {
				const end = start + duration
				const passes = [...new Set(offsets.map(o => start + o))].sort(
					(a, b) => a - b,
				)
				// The ranker reports the latest energy at or before now.
				const energyAt = (now: number) =>
					now < start ? null : Math.min(now, end)
				const liveAt = (now: number) => now >= start && now <= end
				return runPasses(passes, energyAt, liveAt) === null
			},
		),
		{ numRuns: 300 },
	)
})

it("non-vacuous: a transmission reaching the span, or a repeat, does move the slot", () => {
	const passes = Array.from({ length: 30 }, (_, i) => 1_000 + i * 1_000)
	// One 10 s transmission (1 000 … 11 000): the move comes at the pass that sees 10 s.
	expect(
		runPasses(
			passes,
			now => (now < 1_000 ? null : Math.min(now, 11_000)),
			now => now >= 1_000 && now <= 11_000,
		),
	).toBe(11_000)
	// Two short bursts 15 s apart: the second confirms.
	expect(
		runPasses(
			passes,
			now => (now < 2_000 ? null : now < 17_000 ? 2_000 : 17_000),
			now => now === 2_000 || now === 17_000,
		),
	).toBe(17_000)
	// A 9.999 s transmission does not.
	expect(
		runPasses(
			[1_000, 10_999, 20_000, 40_000],
			now => (now < 1_000 ? null : Math.min(now, 10_999)),
			now => now >= 1_000 && now <= 10_999,
		),
	).toBeNull()
})

const policy = resolveActivityPolicy(undefined, 3, "x64", 8)

const NOW = 10_000_000
const ctxOf = (extra: Partial<TakeContext> = {}): TakeContext => ({
	nowMonoMs: NOW,
	count: 2,
	allHeld: false,
	trialOpen: false,
	burstTrialOpen: false,
	yieldOpen: false,
	analogTryOpen: false,
	quietVictimMs: DSD_QUIET_VICTIM_MS,
	yieldSyncMs: 120_000,
	triedRecentMs: DSD_DIGITAL_HOLD_MS,
	...extra,
})
const chal = (
	cls: SlotClass,
	extra: Partial<TakeChallenger> = {},
): TakeChallenger => ({
	cls,
	live: false,
	confirmed: false,
	state: "hot",
	reclaimOk: false,
	burstPaired: false,
	demoted: false,
	retry: false,
	failures: 0,
	triedMonoMs: null,
	rank: 1,
	...extra,
})

/** Victim cells of the table: class, live, last sync age (ms, null for none). */
const VICTIMS: readonly {
	col: string
	cls: SlotClass
	live: boolean
	syncAge: number | null
}[] = [
	{ col: "Hl", cls: "H", live: true, syncAge: 200_000 },
	{ col: "Hr", cls: "H", live: false, syncAge: 30_000 },
	{ col: "Hq<120", cls: "H", live: false, syncAge: 90_000 },
	{ col: "Hq", cls: "H", live: false, syncAge: 200_000 },
	{ col: "Rl", cls: "R", live: true, syncAge: 2_000_000 },
	{ col: "Rq", cls: "R", live: false, syncAge: 2_000_000 },
	{ col: "Dl", cls: "D", live: true, syncAge: 4_000_000 },
	{ col: "Dq", cls: "D", live: false, syncAge: 4_000_000 },
	{ col: "DNl", cls: "DN", live: true, syncAge: 4_000_000 },
	{ col: "DNq", cls: "DN", live: false, syncAge: 4_000_000 },
	{ col: "Ul", cls: "U", live: true, syncAge: null },
	{ col: "Uq", cls: "U", live: false, syncAge: null },
	{ col: "Sl", cls: "S", live: true, syncAge: null },
	{ col: "Sq", cls: "S", live: false, syncAge: null },
	{ col: "Al", cls: "A", live: true, syncAge: null },
	{ col: "Aq", cls: "A", live: false, syncAge: null },
	{ col: "Nl", cls: "N", live: true, syncAge: null },
	{ col: "Nq", cls: "N", live: false, syncAge: null },
]

/**
 * A literal copy of the table (docs/DECODER-GUIDE.md item 8): per gate row,
 * per victim column. "yes" (dwell needed), "free" (no dwell), "below" (V
 * ranks below C), "s120" (V's last sync >= 120 s old), "no". DN columns
 * read as D, S as U, A and N as A/N; Hq<120 is an Hq whose sync is 60-120 s
 * old. The T2DU and T3 rows are "(token, live)" and "(count >= 2, all H,
 * live)": their challengers are live; a challenger that is not live is a
 * never-mover row.
 */
type Cell = "yes" | "free" | "below" | "s120" | "no"
const T: Record<string, Record<string, Cell>> = {
	T1: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "yes",
		Hq: "yes",
		Rl: "no",
		Rq: "yes",
		Dl: "no",
		Dq: "yes",
		Ul: "free",
		Uq: "free",
		AN: "free",
	},
	T2HR: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "no",
		Hq: "no",
		Rl: "no",
		Rq: "below",
		Dl: "yes",
		Dq: "yes",
		Ul: "yes",
		Uq: "yes",
		AN: "yes",
	},
	T2DU: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "no",
		Hq: "no",
		Rl: "no",
		Rq: "s120",
		Dl: "no",
		Dq: "below",
		Ul: "no",
		Uq: "below",
		AN: "yes",
	},
	T3: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "no",
		Hq: "s120",
	},
	TB: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "no",
		Hq: "s120",
		Rl: "no",
		Rq: "yes",
		Dl: "no",
		Dq: "yes",
		Ul: "no",
		Uq: "yes",
		AN: "yes",
	},
	T4: {
		Hl: "no",
		Hr: "no",
		"Hq<120": "no",
		Hq: "no",
		Rl: "no",
		Rq: "no",
		Dl: "no",
		Dq: "no",
		Ul: "no",
		Uq: "no",
		AN: "yes",
	},
	none: {},
}
const tableCol = (v: (typeof VICTIMS)[number]) =>
	v.cls === "A" || v.cls === "N"
		? "AN"
		: v.cls === "DN"
			? v.live
				? "Dl"
				: "Dq"
			: v.cls === "S"
				? v.live
					? "Ul"
					: "Uq"
				: v.col

/** The gate rows: challenger set-ups that reach exactly one row of the table. */
const ROWS: readonly {
	row: keyof typeof T
	kind: MoveKind | null
	c: TakeChallenger
	ctx: Partial<TakeContext>
}[] = [
	...(["H", "R", "D", "DN"] as const).map(cls => ({
		row: "T1" as const,
		kind: "reclaim" as const,
		c: chal(cls, { live: true, reclaimOk: true }),
		ctx: {},
	})),
	...(["H", "R"] as const).map(cls => ({
		row: "T2HR" as const,
		kind: "tier" as const,
		c: chal(cls, { confirmed: true }),
		ctx: {},
	})),
	...(["D", "S", "U"] as const).map(cls => ({
		row: "T2DU" as const,
		kind: "tier" as const,
		c: chal(cls, { confirmed: true, live: true }),
		ctx: { trialOpen: true },
	})),
	...(["D", "S", "U"] as const).map(cls => ({
		row: "TB" as const,
		kind: "burst-trial" as const,
		c: chal(cls, { live: true, burstPaired: true }),
		ctx: { burstTrialOpen: true },
	})),
	{
		row: "T4",
		kind: "analog-try",
		c: chal("A", { retry: true }),
		ctx: { analogTryOpen: true },
	},
	// Never movers: A otherwise, N, DN through T2, a live H/R without budget,
	// D/S/U without the token.
	...(
		[
			chal("A", { confirmed: true, live: true }),
			chal("N", { confirmed: true, live: true, demoted: true }),
			chal("DN", { confirmed: true, demoted: true }),
			chal("H", { confirmed: true, live: true }),
			chal("R", { confirmed: true, live: true }),
			chal("U", { confirmed: true }),
			chal("D", { confirmed: true, live: true, burstPaired: true }),
		] as const
	).map(c => ({ row: "none" as const, kind: null, c, ctx: {} })),
	// A discovery challenger that is not live: no token, burst or yield move
	// even with every gate open (a silent warm site only fails into retry).
	...(["D", "S", "U"] as const).flatMap(cls =>
		(["hot", "warm"] as const).map(state => ({
			row: "none" as const,
			kind: null,
			c: chal(cls, { confirmed: true, burstPaired: true, state }),
			ctx: {
				trialOpen: true,
				burstTrialOpen: true,
				yieldOpen: true,
				allHeld: true,
			},
		})),
	),
]

describe("dsd-fme slot challenge/yield table (mayTake)", () => {
	it("every gate × victim class × live × count × dwell × rank matches the table", () => {
		let cells = 0
		let moves = 0
		for (const r of ROWS)
			for (const v of VICTIMS)
				for (const count of [1, 2])
					for (const dwellPassed of [false, true])
						for (const below of [false, true]) {
							const victim: TakeVictim = {
								cls: v.cls,
								live: v.live,
								lastSyncMonoMs: v.syncAge === null ? null : NOW - v.syncAge,
								dwellPassed,
								pinned: false,
								noSyncRun: false,
								rank: below ? 2 : 0,
							}
							const got = mayTake(r.c, victim, ctxOf({ count, ...r.ctx }))
							const cell = T[r.row]![tableCol(v)] ?? "no"
							const ok =
								cell === "free" ||
								(dwellPassed &&
									(cell === "yes" ||
										(cell === "below" && below) ||
										(cell === "s120" && v.syncAge! >= 120_000)))
							expect(
								got,
								`${r.row} ${r.c.cls} vs ${v.col} count=${count} dwell=${dwellPassed} below=${below}`,
							).toBe(ok ? r.kind : null)
							cells++
							if (got) moves++
							// A pinned victim never is one.
							expect(
								mayTake(r.c, { ...victim, pinned: true }, ctxOf(r.ctx)),
							).toBeNull()
						}
		expect(cells).toBe(ROWS.length * VICTIMS.length * 8)
		expect(moves).toBeGreaterThan(100)
	})

	it("T3 (discovery yield): only with count >= 2 and every slot held, into an Hq synced >= 120 s ago", () => {
		for (const cls of ["D", "S", "U"] as const)
			for (const v of VICTIMS.filter(x => x.cls === "H"))
				for (const count of [1, 2, 3])
					for (const allHeld of [false, true])
						for (const tried of [
							null,
							NOW - DSD_DIGITAL_HOLD_MS + 1,
							NOW - DSD_DIGITAL_HOLD_MS,
						]) {
							const got = mayTake(
								chal(cls, { confirmed: true, live: true, triedMonoMs: tried }),
								{
									cls: "H",
									live: v.live,
									lastSyncMonoMs: NOW - v.syncAge!,
									dwellPassed: true,
									pinned: false,
									noSyncRun: false,
									rank: 3,
								},
								ctxOf({ count, allHeld, trialOpen: true, yieldOpen: true }),
							)
							const ok =
								count >= 2 &&
								allHeld &&
								T["T3"]![v.col] === "s120" &&
								(tried === null || NOW - tried >= DSD_DIGITAL_HOLD_MS)
							expect(got, `${cls} ${v.col} ${count} ${allHeld} ${tried}`).toBe(
								ok ? "yield" : null,
							)
						}
		// Warm (not hot), demoted, without the token or after a yield: none.
		const v: TakeVictim = {
			cls: "H",
			live: false,
			lastSyncMonoMs: NOW - 200_000,
			dwellPassed: true,
			pinned: false,
			noSyncRun: false,
			rank: 3,
		}
		const open = { count: 2, allHeld: true, trialOpen: true, yieldOpen: true }
		expect(
			mayTake(chal("U", { confirmed: true, live: true }), v, ctxOf(open)),
		).toBe("yield")
		// Hot but not live: no yield.
		expect(mayTake(chal("U", { confirmed: true }), v, ctxOf(open))).toBeNull()
		expect(
			mayTake(
				chal("U", { confirmed: true, live: true, state: "warm" }),
				v,
				ctxOf(open),
			),
		).toBeNull()
		expect(
			mayTake(
				chal("U", { confirmed: true }),
				v,
				ctxOf({ ...open, trialOpen: false }),
			),
		).toBeNull()
		expect(
			mayTake(
				chal("U", { confirmed: true }),
				v,
				ctxOf({ ...open, yieldOpen: false }),
			),
		).toBeNull()
		expect(mayTake(chal("A", { confirmed: true }), v, ctxOf(open))).toBeNull()
		expect(mayTake(chal("H", { confirmed: true }), v, ctxOf(open))).toBeNull()
	})

	it("TB after a failure waits 30 min from the last try; the Hr/Hq split is 60 s for T1 only", () => {
		const v: TakeVictim = {
			cls: "U",
			live: false,
			lastSyncMonoMs: null,
			dwellPassed: true,
			pinned: false,
			noSyncRun: false,
			rank: 3,
		}
		const tb = (failures: number, tried: number | null) =>
			mayTake(
				chal("U", {
					live: true,
					burstPaired: true,
					failures,
					triedMonoMs: tried,
				}),
				v,
				ctxOf({ burstTrialOpen: true }),
			)
		expect(tb(0, NOW)).toBe("burst-trial")
		expect(tb(1, NOW - DSD_DIGITAL_HOLD_MS + 1)).toBeNull()
		expect(tb(1, NOW - DSD_DIGITAL_HOLD_MS)).toBe("burst-trial")
		// Hr / Hq at 59 999 / 60 000 ms for T1; TB and T3 need 120 000 ms.
		const held = (age: number): TakeVictim => ({
			...v,
			cls: "H",
			lastSyncMonoMs: NOW - age,
			rank: 0,
		})
		const t1 = chal("R", { live: true, reclaimOk: true })
		expect(victimColumn(held(59_999), ctxOf())).toBe("Hr")
		expect(victimColumn(held(60_000), ctxOf())).toBe("Hq")
		expect(mayTake(t1, held(59_999), ctxOf())).toBeNull()
		expect(mayTake(t1, held(60_000), ctxOf())).toBe("reclaim")
		const tbc = chal("U", { live: true, burstPaired: true })
		expect(
			mayTake(tbc, held(119_999), ctxOf({ burstTrialOpen: true })),
		).toBeNull()
		expect(mayTake(tbc, held(120_000), ctxOf({ burstTrialOpen: true }))).toBe(
			"burst-trial",
		)
	})

	it("M-c: a D/DN victim whose run passed its dwell without a sync is an A/N victim for T2, TB and T4, not for T1", () => {
		for (const cls of ["D", "DN"] as const) {
			const v: TakeVictim = {
				cls,
				live: true,
				lastSyncMonoMs: NOW - 4_000_000,
				dwellPassed: true,
				pinned: false,
				noSyncRun: true,
				rank: 0,
			}
			expect(
				mayTake(
					chal("U", { confirmed: true, live: true }),
					v,
					ctxOf({ trialOpen: true }),
				),
			).toBe("tier")
			expect(
				mayTake(
					chal("U", { live: true, burstPaired: true }),
					v,
					ctxOf({ burstTrialOpen: true }),
				),
			).toBe("burst-trial")
			expect(
				mayTake(chal("A", { retry: true }), v, ctxOf({ analogTryOpen: true })),
			).toBe("analog-try")
			// T1 still reads it as a live D: no.
			expect(
				mayTake(chal("R", { live: true, reclaimOk: true }), v, ctxOf()),
			).toBeNull()
			expect(
				mayTake(
					chal("U", { confirmed: true, live: true }),
					{ ...v, noSyncRun: false },
					ctxOf({ trialOpen: true }),
				),
			).toBeNull()
		}
	})
})

describe("dsd-fme slot selection by class (selectChannels)", () => {
	const tierOf =
		(t: Record<number, Partial<SlotTier> & { cls: SlotClass }>) =>
		(hz: number): SlotTier | undefined =>
			t[hz]
				? {
						reclaimOk: false,
						burstPaired: false,
						demoted: false,
						retry: false,
						lastSyncMonoMs: null,
						triedMonoMs: null,
						failures: 0,
						noSyncRun: false,
						...t[hz],
					}
				: undefined
	const ch = (hz: number, live: boolean, state: "hot" | "cold" = "hot") => ({
		hz,
		score: live ? 101 : 1,
		state,
		live,
		reasons: [],
		lastEnergyMonoMs: null,
		stateSinceMonoMs: 0,
	})
	const run = (
		tiers: Record<number, Partial<SlotTier> & { cls: SlotClass }>,
		live: Record<number, boolean>,
		opts: Partial<Parameters<typeof selectChannels>[0]> = {},
	) =>
		selectChannels({
			order: [1, 2, 3],
			ranked: true,
			activity: new Map([1, 2, 3].map(hz => [hz, ch(hz, live[hz] ?? false)])),
			count: 1,
			incumbents: [{ key: "inc", hz: 3, dwellSinceMonoMs: 0 }],
			nowMonoMs: NOW,
			dwellMs: ACTIVITY_DWELL_MS,
			movesLeft: 6,
			moveWindowFreesMonoMs: null,
			canChallenge: () => true,
			tierOf: tierOf(tiers),
			reclaimReserve: 2,
			quietVictimMs: DSD_QUIET_VICTIM_MS,
			syncCooldownMs: 120_000,
			triedRecentMs: DSD_DIGITAL_HOLD_MS,
			...opts,
		})

	it("MAJOR-2: a live held site takes a quiet held slot (sync >= 60 s), never one synced < 60 s ago or live", () => {
		const site = {
			cls: "H" as const,
			reclaimOk: true,
			lastSyncMonoMs: NOW - 600_000,
		}
		const slot = (age: number) => ({
			cls: "H" as const,
			lastSyncMonoMs: NOW - age,
		})
		expect(run({ 1: site, 3: slot(60_000) }, { 1: true }).chosen).toEqual([
			{ hz: 1, movedFrom: { key: "inc", hz: 3 }, kind: "reclaim" },
		])
		const fresh = run({ 1: site, 3: slot(59_999) }, { 1: true })
		expect(fresh.moves).toBe(0)
		// Blocked until that sync is 60 s old.
		expect(fresh.blockedUntilMonoMs).toBe(NOW - 59_999 + 60_000)
		expect(run({ 1: site, 3: slot(600_000) }, { 1: true, 3: true }).moves).toBe(
			0,
		)
	})

	it("MAJOR-1 regression: past the hold two quiet 40 s runs leave a site remembered, and its next live burst reclaims", () => {
		const tiers = new DsdChannelTiers()
		const k = dsdTierKey("voice", "rtl", 466_100_000)!
		tiers.noteSync(k, 0)
		const after = DSD_DIGITAL_HOLD_MS + 1
		// Two runs of 40 s without a sync, each a failed run.
		for (const start of [after, after + 100_000]) {
			tiers.account(k, start, start + 40_000, false)
			tiers.noteFailure(k, start + 40_000, policy)
		}
		const now = after + 200_000
		const [e] = tiers.snapshot(now, policy).tiers
		expect(e).toMatchObject({ tier: "digital", decayed: false, failures: 0 })
		expect(tiers.held(k, now)).toBe(false)
		const r = run(
			{
				1: { cls: "R", reclaimOk: true, lastSyncMonoMs: 0 },
				3: { cls: "U" },
			},
			{ 1: true },
			{ nowMonoMs: now, canChallenge: () => false },
		)
		expect(r.chosen).toEqual([
			{ hz: 1, movedFrom: { key: "inc", hz: 3 }, kind: "reclaim" },
		])
	})

	it("M-c: a false-synced steady live carrier (decayed) does not pin a slot against discovery, count 1 and 2", () => {
		const tiers = new DsdChannelTiers()
		const k = dsdTierKey("voice", "rtl", 466_150_000)!
		tiers.noteSync(k, 0)
		// Live and listened for 10 min without another sync: decayed.
		for (let t = 0; t < DSD_DECAY_LIVE_MS; t += 1_000)
			tiers.account(k, t, t + 1_000, true)
		const now = DSD_DECAY_LIVE_MS
		expect(tiers.snapshot(now, policy).tiers[0]).toMatchObject({
			decayed: true,
			lastSyncMonoMs: 0,
		})
		const carrier = {
			cls: "D" as const,
			lastSyncMonoMs: 0,
			noSyncRun: true,
		}
		const r1 = run(
			{ 1: { cls: "U" }, 3: carrier },
			{ 1: true, 3: true },
			{
				nowMonoMs: now,
				trialOpen: true,
			},
		)
		expect(r1.chosen).toEqual([
			{
				hz: 1,
				movedFrom: { key: "inc", hz: 3 },
				kind: "tier",
				trial: true,
				lane: "fresh",
			},
		])
		// Count 2 with a live held site in the other slot: the carrier goes.
		const r2 = run(
			{
				1: { cls: "U" },
				2: { cls: "H", lastSyncMonoMs: now - 1_000 },
				3: carrier,
			},
			{ 1: true, 2: true, 3: true },
			{
				nowMonoMs: now,
				trialOpen: true,
				count: 2,
				incumbents: [
					{ key: "site", hz: 2, dwellSinceMonoMs: 0 },
					{ key: "inc", hz: 3, dwellSinceMonoMs: 0 },
				],
			},
		)
		expect(r2.chosen.find(c => c.movedFrom)?.movedFrom?.key).toBe("inc")
		// Non-vacuous: within its first dwell (no failed run yet) it holds.
		expect(
			run(
				{ 1: { cls: "U" }, 3: { ...carrier, noSyncRun: false } },
				{
					1: true,
					3: true,
				},
				{ nowMonoMs: now, trialOpen: true },
			).moves,
		).toBe(0)
	})

	it("m-3: after 2 live reclaims without a sync in 30 min a real burst within those 30 min is lost; at 30 min it reclaims", () => {
		const tiers = new DsdChannelTiers()
		const k = dsdTierKey("voice", "rtl", 466_100_000)!
		tiers.noteSync(k, 0)
		const t0 = DSD_DIGITAL_HOLD_MS + 60_000
		tiers.noteReclaim(k, t0)
		tiers.noteReclaim(k, t0 + 300_000)
		const at = (now: number) => {
			const e = tiers.snapshot(now, policy).tiers[0]!
			const ok =
				now - e.reclaimWindowMonoMs! >= DSD_RECLAIM_WINDOW_MS ||
				e.reclaims! < DSD_RECLAIM_BUDGET
			return run(
				{ 1: { cls: "R", reclaimOk: ok, lastSyncMonoMs: 0 }, 3: { cls: "U" } },
				{ 1: true },
				{ nowMonoMs: now, canChallenge: () => false },
			).moves
		}
		expect(at(t0 + DSD_RECLAIM_WINDOW_MS - 1)).toBe(0)
		expect(at(t0 + DSD_RECLAIM_WINDOW_MS)).toBe(1)
	})

	it("the move reserve: other gates stop 2 moves short, T1 may use them", () => {
		const t = { 1: { cls: "U" as const }, 3: { cls: "N" as const } }
		expect(run(t, { 1: true }, { movesLeft: 3, trialOpen: true }).moves).toBe(1)
		expect(run(t, { 1: true }, { movesLeft: 2, trialOpen: true }).moves).toBe(0)
		const r = {
			1: { cls: "R" as const, reclaimOk: true, lastSyncMonoMs: 0 },
			3: { cls: "N" as const },
		}
		expect(run(r, { 1: true }, { movesLeft: 1 }).moves).toBe(1)
	})

	it("the trial token allows one unknown entry per pass; without it none", () => {
		const base = {
			order: [1, 2, 3, 4],
			activity: new Map([1, 2, 3, 4].map(hz => [hz, ch(hz, hz < 3)])),
			count: 2,
			incumbents: [
				{ key: "a", hz: 3, dwellSinceMonoMs: 0 },
				{ key: "b", hz: 4, dwellSinceMonoMs: 0 },
			],
		}
		const t = {
			1: { cls: "U" as const },
			2: { cls: "U" as const },
			3: { cls: "N" as const },
			4: { cls: "N" as const },
		}
		expect(run(t, {}, { ...base, trialOpen: true }).moves).toBe(1)
		expect(run(t, {}, { ...base, trialOpen: false }).moves).toBe(0)
		// Silent (not live) unknowns never take the token.
		expect(
			run(
				t,
				{},
				{
					...base,
					activity: new Map([1, 2, 3, 4].map(hz => [hz, ch(hz, false)])),
					trialOpen: true,
				},
			).moves,
		).toBe(0)
		// Free slots fill at once, no token.
		expect(
			run(t, {}, { ...base, incumbents: [], trialOpen: false }).chosen,
		).toEqual([{ hz: 1 }, { hz: 2 }])
	})

	it("MJ-1: the trial token and the burst gap each have a fresh and a retry lane", () => {
		const fresh = { 1: { cls: "U" as const }, 3: { cls: "N" as const } }
		const failed = {
			1: { cls: "U" as const, failures: 1, triedMonoMs: 0 },
			3: { cls: "N" as const },
		}
		const lanes = (f: boolean, r: boolean) => ({ fresh: f, retry: r })
		// Channel 2 (an untiered fresh unknown) is left out of the order.
		const two = { order: [1, 3] }
		// T2: a never-tried challenger needs the fresh lane only.
		expect(
			run(fresh, { 1: true }, { ...two, trialOpen: lanes(false, true) }).moves,
		).toBe(0)
		expect(
			run(fresh, { 1: true }, { ...two, trialOpen: lanes(true, false) }).chosen,
		).toEqual([
			{
				hz: 1,
				movedFrom: { key: "inc", hz: 3 },
				kind: "tier",
				trial: true,
				lane: "fresh",
			},
		])
		// ... a failed one the retry lane only.
		expect(
			run(failed, { 1: true }, { ...two, trialOpen: lanes(true, false) }).moves,
		).toBe(0)
		expect(
			run(failed, { 1: true }, { ...two, trialOpen: lanes(false, true) })
				.chosen[0]?.lane,
		).toBe("retry")
		// TB the same, on its own gates.
		const paired = (t: typeof fresh | typeof failed) => ({
			...t,
			1: { ...t[1], burstPaired: true },
		})
		const tb = (t: typeof fresh | typeof failed, f: boolean, r: boolean) =>
			run(
				paired(t),
				{ 1: true },
				{
					...two,
					trialOpen: false,
					burstTrialOpen: lanes(f, r),
					canChallenge: () => false,
					nowMonoMs: NOW,
				},
			).chosen[0]
		expect(tb(fresh, false, true)?.hz).toBe(3)
		expect(tb(fresh, true, false)).toMatchObject({
			hz: 1,
			kind: "burst-trial",
			lane: "fresh",
		})
		expect(tb(failed, true, false)?.hz).toBe(3)
		expect(tb(failed, false, true)).toMatchObject({
			hz: 1,
			kind: "burst-trial",
			lane: "retry",
		})
		// One move per lane and pass: a fresh and a retry entry in one pass.
		const both = run(
			{
				1: { cls: "U" },
				2: { cls: "U", failures: 2, triedMonoMs: 0 },
				3: { cls: "N" },
				4: { cls: "N" },
			},
			{},
			{
				order: [1, 2, 3, 4],
				activity: new Map([1, 2, 3, 4].map(hz => [hz, ch(hz, hz < 3)])),
				count: 2,
				incumbents: [
					{ key: "a", hz: 3, dwellSinceMonoMs: 0 },
					{ key: "b", hz: 4, dwellSinceMonoMs: 0 },
				],
				trialOpen: lanes(true, true),
			},
		)
		expect(both.chosen.map(c => [c.hz, c.lane])).toEqual([
			[1, "fresh"],
			[2, "retry"],
		])
	})

	it("MJ-1: a new site enters at its first confirmation while 10 failing carriers saturate the retry lane; each lane closed until its gap, open at it", () => {
		const tiers = new DsdChannelTiers()
		const group = dsdGroupKey("voice", "rtl")
		const SITE = 1
		const carriers = Array.from({ length: 10 }, (_, i) => 10 + i)
		const order = [SITE, ...carriers]
		// Each carrier failed before; once placed and past its dwell it fails
		// again (N, demoted for a 1,920 s cooldown) and is an A/N victim.
		const failures = new Map(carriers.map(hz => [hz, 1]))
		const tried = new Map(carriers.map(hz => [hz, -DSD_DIGITAL_HOLD_MS]))
		const cooldown = new Map<number, number>()
		let siteAt: number | null = null
		let inc = { key: "c10", hz: 10, dwellSinceMonoMs: 0 }
		const retryMoves: number[] = []
		const passMs = 10_000
		const gateAt = (now: number, gate: string) =>
			tiers
				.snapshot(now, policy)
				.trials.find(t => t.groupKey === group && t.gate === gate)?.atMonoMs
		const open = (now: number, gate: string) => gateAt(now, gate) === undefined
		const pass = (now: number, shared = false) => {
			if (
				inc.hz !== SITE &&
				now - inc.dwellSinceMonoMs >= ACTIVITY_DWELL_MS &&
				!cooldown.has(inc.hz)
			) {
				failures.set(inc.hz, failures.get(inc.hz)! + 1)
				tried.set(inc.hz, now)
				cooldown.set(inc.hz, now + 1_920_000)
			}
			for (const [hz, until] of cooldown) if (now >= until) cooldown.delete(hz)
			const tierOfHz = (hz: number): SlotTier => ({
				cls: hz === SITE ? "U" : hz === inc.hz || cooldown.has(hz) ? "N" : "U",
				reclaimOk: false,
				burstPaired: false,
				demoted: hz !== SITE && hz !== inc.hz && cooldown.has(hz),
				retry: false,
				lastSyncMonoMs: null,
				triedMonoMs: hz === SITE ? null : tried.get(hz)!,
				failures: hz === SITE ? 0 : failures.get(hz)!,
				noSyncRun: false,
			})
			const retry = open(now, "trial:retry")
			const ranked = siteAt === null && now >= SITE_CONFIRMED ? order : carriers
			const r = selectChannels({
				order: ranked.filter(hz => hz !== inc.hz).concat(inc.hz),
				ranked: true,
				// Steady carriers and the site are receiving (discovery needs live).
				activity: new Map(order.map(hz => [hz, ch(hz, true)])),
				count: 1,
				incumbents: [inc],
				nowMonoMs: now,
				dwellMs: ACTIVITY_DWELL_MS,
				movesLeft: 6,
				moveWindowFreesMonoMs: null,
				canChallenge: () => true,
				tierOf: tierOfHz,
				reclaimReserve: 2,
				// The shared token of before the fix: one gate for both lanes.
				trialOpen: shared ? retry : { fresh: open(now, "trial:fresh"), retry },
			})
			const moved = r.chosen.find(c => c.movedFrom)
			if (!moved) return null
			tiers.noteTrial(group, `trial:${moved.lane!}`, now)
			if (moved.lane === "retry") retryMoves.push(now)
			inc = { key: `c${moved.hz}`, hz: moved.hz, dwellSinceMonoMs: now }
			return moved
		}
		// Before the site: an hour of failing carriers holds the retry lane
		// on every 600 s gap (6 entries an hour), the fresh lane unused.
		const SITE_CONFIRMED = 3_600_000 + 4 * passMs
		for (let t = 0; t < SITE_CONFIRMED; t += passMs) pass(t)
		expect(retryMoves.length).toBeGreaterThanOrEqual(6)
		for (let i = 1; i < retryMoves.length; i++)
			expect(retryMoves[i]! - retryMoves[i - 1]!).toBe(600_000)
		const lastRetry = retryMoves.at(-1)!
		expect(SITE_CONFIRMED - lastRetry).toBeLessThan(600_000)
		expect(open(SITE_CONFIRMED, "trial:retry")).toBe(false)
		// The site enters at its first pass (the carrier's dwell is past).
		const moved = pass(SITE_CONFIRMED)
		expect(moved).toMatchObject({ hz: SITE, lane: "fresh" })
		siteAt = SITE_CONFIRMED
		// Each lane: closed strictly within its gap, open at it.
		expect(open(siteAt + 300_000 - 1, "trial:fresh")).toBe(false)
		expect(open(siteAt + 300_000, "trial:fresh")).toBe(true)
		expect(open(lastRetry + 600_000 - 1, "trial:retry")).toBe(false)
		expect(open(lastRetry + 600_000, "trial:retry")).toBe(true)
	})

	it("MJ-1 non-vacuous: with one shared token the same site waits for the retry gap", () => {
		const tiers = new DsdChannelTiers()
		const group = dsdGroupKey("voice", "rtl")
		tiers.noteTrial(group, "trial:retry", NOW - 30_000)
		const retryOpen =
			tiers.snapshot(NOW, policy).trials.find(t => t.gate === "trial:retry") ===
			undefined
		const t = { 1: { cls: "U" as const }, 3: { cls: "N" as const } }
		expect(run(t, { 1: true }, { trialOpen: retryOpen }).moves).toBe(0)
		expect(
			run(t, { 1: true }, { trialOpen: { fresh: true, retry: retryOpen } })
				.moves,
		).toBe(1)
	})

	it("tier order: a held channel that failed once keeps its rank over a fresh hot unknown (fewest failures only among D, S, U)", () => {
		// X (1): held, failed once before its first sync, not live. Y (2): a
		// fresh hot live unknown with the token open. One analog slot past dwell.
		const t = {
			1: {
				cls: "H" as const,
				failures: 1,
				triedMonoMs: NOW - 100_000,
				lastSyncMonoMs: NOW - 50_000,
			},
			2: { cls: "U" as const },
			3: { cls: "A" as const },
		}
		expect(run(t, { 2: true }, { trialOpen: true }).chosen).toEqual([
			{ hz: 1, movedFrom: { key: "inc", hz: 3 }, kind: "tier" },
		])
	})

	it("retry lane: 10 escalated carriers tried long ago lose the next opening to a channel with 1 failure (fewest failures, then least recently tried)", () => {
		const SITE = 1
		const VICTIM = 3
		const carriers = Array.from({ length: 10 }, (_, i) => 10 + i)
		// The carriers rank above the site and were tried long before it.
		const order = [...carriers, SITE, VICTIM]
		const tiers: Record<number, Partial<SlotTier> & { cls: SlotClass }> = {
			[SITE]: { cls: "U", failures: 1, triedMonoMs: NOW - 1_000_000 },
			[VICTIM]: { cls: "N" },
		}
		carriers.forEach((hz, i) => {
			tiers[hz] = { cls: "U", failures: 3, triedMonoMs: i * 1_000 }
		})
		const live = Object.fromEntries(order.map(hz => [hz, true]))
		const select = (
			t: typeof tiers,
			opts: Partial<Parameters<typeof selectChannels>[0]>,
		) =>
			run(t, live, {
				order,
				activity: new Map(order.map(hz => [hz, ch(hz, true)])),
				nowMonoMs: NOW,
				...opts,
			}).chosen
		const lanes = { fresh: false, retry: true }
		// T2 trial token, retry lane.
		expect(select(tiers, { trialOpen: lanes })).toEqual([
			{
				hz: SITE,
				movedFrom: { key: "inc", hz: VICTIM },
				kind: "tier",
				trial: true,
				lane: "retry",
			},
		])
		// TB burst trial, retry lane (all burst-paired, every last try >= 30 min old).
		const paired = Object.fromEntries(
			Object.entries(tiers).map(([hz, t]) => [
				hz,
				{ ...t, burstPaired: Number(hz) !== VICTIM },
			]),
		) as typeof tiers
		const tb = select(paired, {
			trialOpen: false,
			burstTrialOpen: lanes,
			canChallenge: () => false,
			nowMonoMs: NOW + DSD_DIGITAL_HOLD_MS,
		})
		expect(tb).toMatchObject([{ hz: SITE, kind: "burst-trial", lane: "retry" }])
		// Equal failures: least recently tried first (the first carrier).
		const level = { ...tiers, [SITE]: { ...tiers[SITE]!, failures: 3 } }
		expect(select(level, { trialOpen: lanes })[0]?.hz).toBe(carriers[0])
	})

	it("one analog try per pass while the group's gate is open, least recently tried first, into the oldest A/N run", () => {
		const tiers = {
			1: { cls: "A" as const, retry: true, triedMonoMs: 5 },
			2: { cls: "A" as const, retry: true },
			3: { cls: "A" as const },
		}
		expect(
			run(tiers, {}, { analogRetryOpen: false, canChallenge: () => false })
				.moves,
		).toBe(0)
		expect(
			run(tiers, {}, { analogRetryOpen: true, canChallenge: () => false })
				.chosen,
		).toEqual([{ hz: 2, movedFrom: { key: "inc", hz: 3 }, kind: "analog-try" }])
		expect(
			run({ ...tiers, 3: { cls: "U" } }, {}, { analogRetryOpen: true }).moves,
		).toBe(0)
		const two = run(
			{ ...tiers, 4: { cls: "A" } },
			{},
			{
				analogRetryOpen: true,
				count: 2,
				order: [1, 2, 3, 4],
				activity: new Map([1, 2, 3, 4].map(hz => [hz, ch(hz, false)])),
				incumbents: [
					{ key: "a", hz: 3, dwellSinceMonoMs: 0 },
					{ key: "b", hz: 4, dwellSinceMonoMs: 1 },
				],
			},
		)
		expect(two.moves).toBe(1)
		expect(two.chosen.find(c => c.movedFrom)?.movedFrom?.key).toBe("a")
	})

	it("fills free slots with non-analog before analog, never with demoted (a DN only live with budget)", () => {
		const r = run(
			{
				1: { cls: "A" },
				2: { cls: "U" },
				3: { cls: "A", demoted: true },
			},
			{},
			{ incumbents: [], count: 3, demotedHz: new Set([3]) },
		)
		expect(r.chosen.map(c => c.hz)).toEqual([1, 2])
		expect(
			run({ 1: { cls: "A" }, 2: { cls: "U" } }, {}, { incumbents: [] }).chosen,
		).toEqual([{ hz: 2 }])
		const dn = { cls: "DN" as const, demoted: true, reclaimOk: true }
		expect(
			run({ 1: dn }, { 1: true }, { incumbents: [], order: [1] }).chosen,
		).toEqual([{ hz: 1 }])
		expect(run({ 1: dn }, {}, { incumbents: [], order: [1] }).chosen).toEqual(
			[],
		)
	})

	it("activityOrder: H first in any state, then R, then D/S/U (D by newest sync), A, and cold, DN, N last", () => {
		const snap = (
			chs: { hz: number; state: "hot" | "cold"; score: number }[],
		): ActivitySnapshot => ({
			query: {
				epoch: { sourceId: "s", engineId: "e", epoch: 1 },
				decoderId: "dsd",
				decoderType: "dsd-fme",
				protocols: ["dmr"],
				centreHz: 0,
				candidatesHz: chs.map(c => c.hz),
				channelWidthHz: 12_500,
			},
			revision: 1,
			evaluatedMonoMs: 0,
			lastFrameMonoMs: 0,
			status: "ready",
			nextEvaluationMonoMs: null,
			channels: chs.map(c => ({ ...ch(c.hz, false, c.state), score: c.score })),
		})
		const of = tierOf({
			2: { cls: "U" },
			3: { cls: "H", lastSyncMonoMs: 0 },
			4: { cls: "A" },
			5: { cls: "R", lastSyncMonoMs: 0 },
			6: { cls: "D", lastSyncMonoMs: 10 },
			7: { cls: "D", lastSyncMonoMs: 20 },
			8: { cls: "S" },
			9: { cls: "N" },
			10: { cls: "DN", lastSyncMonoMs: 30 },
		})
		const hot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(hz => ({
			hz,
			state: "hot" as const,
			score: hz,
		}))
		expect(
			activityOrder(
				hot.map(c => c.hz),
				snap(hot),
				of,
			),
		).toEqual([3, 5, 7, 6, 8, 2, 1, 4, 10, 9])
		// A cold H still ranks first; a cold R with the cold rest.
		expect(
			activityOrder(
				[5, 2, 3],
				snap([
					{ hz: 5, state: "cold", score: 0 },
					{ hz: 2, state: "hot", score: 1 },
					{ hz: 3, state: "cold", score: 0 },
				]),
				of,
			),
		).toEqual([3, 2, 5])
		// Without tierOf (multimon-ng) every channel is one class: by score.
		expect(
			activityOrder(
				hot.map(c => c.hz),
				snap(hot),
			),
		).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
	})
})

/**
 * P8 ping-pong: 2-4 remembered sites with random 3 s transmissions, passes
 * every 2 s for 1 h, count 1 or 2. A site running at its transmission syncs
 * (its hold and quiet reset), the move window (6 per 60 s, 2 kept for T1)
 * and the reclaim budget are modelled as the planner and manager apply them.
 */
function pingPong(
	sites: number,
	count: number,
	bursts: readonly (readonly number[])[],
	spawnMs: number,
) {
	const horizon = 3_600_000
	const hz = Array.from({ length: sites }, (_, i) => i + 1)
	const lastSync = new Map(hz.map(h => [h, 0]))
	const reclaim = new Map(
		hz.map(h => [h, { n: 0, at: Number.NEGATIVE_INFINITY }]),
	)
	let slots: { key: string; hz: number; dwellSinceMonoMs: number }[] = hz
		.slice(0, count)
		.map(h => ({ key: `k${h}`, hz: h, dwellSinceMonoMs: 0 }))
	const window: number[] = []
	const moves: { at: number; from: number; to: number; fromSync: number }[] = []
	const liveAt = (h: number, t: number) =>
		bursts[h - 1]!.some(b => t >= b && t < b + 3_000)
	for (let now = 2_000; now <= horizon; now += 2_000) {
		for (const s of slots)
			if (liveAt(s.hz, now) && now - s.dwellSinceMonoMs >= spawnMs) {
				lastSync.set(s.hz, now)
				reclaim.set(s.hz, { n: 0, at: Number.NEGATIVE_INFINITY })
			}
		while (window.length && window[0]! <= now - 60_000) window.shift()
		const tiers = (h: number): SlotTier => {
			const age = now - lastSync.get(h)!
			const r = reclaim.get(h)!
			return {
				cls: age < DSD_DIGITAL_HOLD_MS ? "H" : "R",
				reclaimOk: r.n < 2 || now - r.at >= DSD_RECLAIM_WINDOW_MS,
				burstPaired: false,
				demoted: false,
				retry: false,
				lastSyncMonoMs: lastSync.get(h)!,
				triedMonoMs: null,
				failures: 0,
				noSyncRun: false,
			}
		}
		const sel = selectChannels({
			order: hz,
			ranked: true,
			activity: new Map(
				hz.map(h => [
					h,
					{
						hz: h,
						score: liveAt(h, now) ? 101 : 1,
						state: "hot" as const,
						live: liveAt(h, now),
						reasons: [],
						lastEnergyMonoMs: null,
						stateSinceMonoMs: 0,
					},
				]),
			),
			count,
			incumbents: slots,
			nowMonoMs: now,
			dwellMs: ACTIVITY_DWELL_MS,
			movesLeft: Math.max(0, 6 - window.length),
			moveWindowFreesMonoMs: window.length >= 6 ? window[0]! + 60_000 : null,
			canChallenge: () => false,
			tierOf: tiers,
			reclaimReserve: 2,
			quietVictimMs: DSD_QUIET_VICTIM_MS,
			syncCooldownMs: 120_000,
			triedRecentMs: DSD_DIGITAL_HOLD_MS,
		})
		const next: typeof slots = []
		for (const c of sel.chosen) {
			if (c.movedFrom) {
				const from = c.movedFrom.hz
				moves.push({ at: now, from, to: c.hz, fromSync: lastSync.get(from)! })
				window.push(now)
				const r = reclaim.get(c.hz)!
				if (c.kind === "reclaim")
					reclaim.set(
						c.hz,
						now - r.at >= DSD_RECLAIM_WINDOW_MS
							? { n: 1, at: now }
							: { n: r.n + 1, at: r.at },
					)
				next.push({ key: `k${c.hz}@${now}`, hz: c.hz, dwellSinceMonoMs: now })
			} else next.push(slots.find(s => s.hz === c.hz)!)
		}
		slots = next
	}
	return moves
}

// Feature: dsd-digital-tiers, Property 8: no ping-pong between remembered sites
// Validates: Requirements 3.9
it("P8: remembered sites swap at most 12 times per hour per pair, never within 60 s of the victim's sync", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 2, max: 4 }),
			fc.integer({ min: 1, max: 2 }),
			fc.array(
				fc.array(fc.integer({ min: 0, max: 3_597_000 }), { maxLength: 8 }),
				{ minLength: 4, maxLength: 4 },
			),
			fc.integer({ min: 0, max: 2_000 }),
			(sites, count, bursts, spawnMs) => {
				const moves = pingPong(sites, count, bursts, spawnMs)
				for (const m of moves)
					expect(m.at - m.fromSync).toBeGreaterThanOrEqual(DSD_QUIET_VICTIM_MS)
				const swaps = new Map<string, number>()
				for (let i = 0; i < moves.length; i++)
					for (let j = i + 1; j < moves.length; j++)
						if (
							moves[j]!.from === moves[i]!.to &&
							moves[j]!.to === moves[i]!.from
						) {
							const pair = [moves[i]!.from, moves[i]!.to].sort().join("-")
							swaps.set(pair, (swaps.get(pair) ?? 0) + 1)
							break
						}
				for (const n of swaps.values()) expect(n).toBeLessThanOrEqual(12)
			},
		),
		{ numRuns: 100 },
	)
}, 300_000)
