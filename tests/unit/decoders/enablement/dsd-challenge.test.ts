import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { ChannelActivity } from "../../../../src/decoders/enablement/activity-contract.js"
import {
	ACTIVITY_DWELL_MS,
	selectChannels,
} from "../../../../src/decoders/enablement/activity-plan.js"
import {
	DSD_CHALLENGE_MAX_OBSERVATIONS,
	DSD_CHALLENGE_MEMORY_MS,
	DSD_CHALLENGE_MIN_OBSERVATIONS,
	DSD_CHALLENGE_MIN_SPAN_MS,
	DSD_CHALLENGE_THIN_MS,
	DSD_MAX_CHALLENGERS,
	DsdChallengeEvidence,
	dsdActivitySlotAllowed,
	dsdChallengeKey,
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
