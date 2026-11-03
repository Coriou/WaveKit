// tests/unit/core/scanner/scheduler-traffic.test.ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	simulateSweep,
	type SimResult,
	type SimSignal,
} from "../../../../src/core/scanner/plan/sweep-sim.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

/*
 * Traffic against carriers in a sweep: QSOs on air when the job starts or starting later, regular
 * long overs, an ID after a QSO, decoded calls, and carriers that flap in short gaps. The
 * thresholds of the traffic scenes are what the sweep scheduler heard before frequency memory
 * existed (holds were one confirm probe per visit, decoded calls followed to maxHoldMs), run on the
 * same scenes with the same simulator: the scheduler must never hear less of real traffic.
 */

const MHZ = 1_000_000
/** About 1.024 Msps at 80 % usable: 819.2 kHz per hop. */
const HALF_SPAN_HZ = 409_600
/** Synthetic centres, 800 kHz apart. */
const centres = (n: number): number[] =>
	Array.from({ length: n }, (_, i) => 150 * MHZ + i * 800_000)
/** Timer settle 1000 ms + (2 + 1) blocks of 50 ms. */
const SETTLE_MS = 1_000
const BLOCK_MS = 50
const DWELL_MS = SETTLE_MS + 3 * BLOCK_MS
/** The first hold of a frequency not known (CARRIER_WATCH_MS), and the cap of a carrier's holds. */
const WATCH_MS = 8_000
/** A hang that starts before a hold's cap may run this long to class the gap (1000 ms + a block). */
const CLASS_HANG_MS = 1_050
const spec = makeNormalisedSpec({ dwellMs: DWELL_MS, settleMs: SETTLE_MS })
const sim = {
	settleMs: SETTLE_MS,
	blockMs: BLOCK_MS,
	minSurfaceBlocks: 2,
	probeStartMs: 300,
}

/** An analog-voice transmission (analog-fm confirm 1500 ms + 300 ms probe start). */
const voice = (
	hz: number,
	startMs: number,
	durationMs = 28_000,
): SimSignal => ({
	centreHz: hz,
	startMs,
	endMs: startMs + durationMs,
	snrDb: 21,
	needsConfirm: true,
	confirmHoldMs: 1_800,
	followOnAir: true,
})
/** A DMR-like call: no analog label, a decoder confirms it 800 ms into the probe. */
const decoded = (
	hz: number,
	startMs: number,
	durationMs: number,
): SimSignal => ({
	...voice(hz, startMs, durationMs),
	followOnAir: false,
	decodeAfterMs: 800,
})

/** Deterministic uniform [0, 1) from a 32-bit seed (mulberry32). */
function random(seed: number): () => number {
	let x = seed >>> 0
	return () => {
		x = (x + 0x6d2b79f5) >>> 0
		let t = Math.imul(x ^ (x >>> 15), 1 | x)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
	}
}
/**
 * A synthetic QSO: overs of 5 to 30 s with turnaround gaps of `gapMinMs` to `gapMaxMs` (1 to 3 s
 * by default), from `fromMs` to `untilMs`.
 */
function qso(
	hz: number,
	fromMs: number,
	untilMs: number,
	seed: number,
	gapMinMs = 1_000,
	gapMaxMs = 3_000,
): SimSignal[] {
	const rnd = random(seed)
	const out: SimSignal[] = []
	let t = fromMs
	while (t < untilMs) {
		const over = Math.round(5_000 + 25_000 * rnd())
		out.push(voice(hz, t, Math.min(over, untilMs - t)))
		t += over + Math.round(gapMinMs + (gapMaxMs - gapMinMs) * rnd())
	}
	return out
}
const onAirMs = (signals: readonly SimSignal[]): number =>
	signals.reduce((a, s) => a + s.endMs - s.startMs, 0)
const heardTotal = (r: SimResult): number =>
	r.heardMs.reduce((a, b) => a + b, 0)
const heardShare = (r: SimResult, signals: readonly SimSignal[]): number =>
	heardTotal(r) / onAirMs(signals)

/** The QSO's hop: the middle one of 3, hop 3 of 7. */
const qsoHop = (hops: number): number => (hops === 3 ? 1 : 3)
const planOf = (hops: number) => makeHopPlan(centres(hops), HALF_SPAN_HZ)
const qsoHz = (hops: number): number =>
	planOf(hops).hops[qsoHop(hops)]!.centreHz + 100_000

/**
 * Overs of `overMs` (each changed by up to ± `jitterMs`, uniform, seed 7) with exact `gapMs`
 * turnarounds from `fromMs` to `untilMs`.
 */
function regularQso(
	hz: number,
	fromMs: number,
	untilMs: number,
	overMs: number,
	gapMs: number,
	jitterMs = 0,
): SimSignal[] {
	const rnd = random(7)
	const out: SimSignal[] = []
	for (let t = fromMs; t < untilMs; ) {
		const len = Math.round(overMs + (2 * rnd() - 1) * jitterMs)
		out.push(voice(hz, t, Math.min(len, untilMs - t)))
		t += len + gapMs
	}
	return out
}

describe("a QSO is heard at least as much as one confirm probe per visit heard it", () => {
	// Share of the QSO's air time heard over 10 minutes. The earlier scheduler (one probe of
	// 1800 + 300 ms per visit, revisits by activity) heard 3 hops: 51.4 / 51.1 / 51.0 % on air at
	// the start (seeds 1 to 3) and 51.1 / 51.0 / 51.5 % from 60 s; 7 hops: 39.3 / 40.6 / 39.8 % and
	// 41.6 / 39.3 / 39.2 %. Thresholds: the highest of those, rounded up (52 %, 42 %).
	for (const hops of [3, 7]) {
		const floor = hops === 3 ? 0.52 : 0.42
		for (const fromMs of [0, 60_000])
			for (const seed of [1, 2, 3])
				it(`${hops} hops, ${fromMs === 0 ? "on air when the job starts" : "starting at 60 s"}, seed ${seed}: heard ≥ ${floor * 100} %`, () => {
					const signals = qso(qsoHz(hops), fromMs, fromMs + 600_000, seed)
					const r = simulateSweep(planOf(hops), spec, {
						...sim,
						durationMs: fromMs + 600_000,
						signals,
					})
					expect(heardShare(r, signals)).toBeGreaterThanOrEqual(floor)
				})
	}
})

describe("a 28 s ID right after a QSO on air since the job started", () => {
	// The QSO (seed 1) runs to 600 s; the ID opens on the same frequency 1.5, 8 or 30 s later. The
	// earlier scheduler heard 3 hops: 15 100 / 14 450 / 13 500 ms, 7 hops: 11 250 / 11 250 /
	// 11 500 ms. Thresholds: the highest of those per plan, rounded up (15 500, 12 000 ms).
	for (const hops of [3, 7])
		for (const afterMs of [1_500, 8_000, 30_000]) {
			const floor = hops === 3 ? 15_500 : 12_000
			it(`${hops} hops, ID ${afterMs} ms after the QSO: heard ≥ ${floor} ms`, () => {
				const hz = qsoHz(hops)
				const talk = qso(hz, 0, 600_000, 1)
				const id = voice(hz, 600_000 + afterMs)
				const r = simulateSweep(planOf(hops), spec, {
					...sim,
					durationMs: id.endMs + 5_000,
					signals: [...talk, id],
				})
				expect(r.heardMs[talk.length]).toBeGreaterThanOrEqual(floor)
			})
		}
})

describe("a QSO of regular long overs is heard at least as much as one confirm probe per visit heard it", () => {
	// 10 minutes of overs. Its first hold may hear an over without a break for 8 s (carrier
	// evidence); it is traffic again once a hold hears a turnaround, then followed as traffic.
	// The thresholds are what the earlier scheduler (one confirm probe of 1800 + 300 ms per visit)
	// heard on the same scenes.
	const scenes: [string, number, number, number, number, number, number][] = [
		// name, hops, hz offset from the QSO hop centre, start, over, gap, earlier ms heard
		[
			"3 hops, 30 s overs, 1 s gaps at 150.9 MHz",
			3,
			100_000,
			0,
			30_000,
			1_000,
			301_650,
		],
		["7 hops, 25 s overs, 1 s gaps", 7, 100_000, 0, 25_000, 1_000, 242_750],
		["3 hops, 5 s overs, 1 s gaps", 3, 100_000, 0, 5_000, 1_000, 264_050],
		["3 hops, 45 s overs, 3 s gaps", 3, 100_000, 0, 45_000, 3_000, 284_750],
		[
			"3 hops, 10 s overs, 3 s gaps from 60 s",
			3,
			100_000,
			60_000,
			10_000,
			3_000,
			226_900,
		],
		["7 hops, 5 s overs, 2 s gaps", 7, 100_000, 0, 5_000, 2_000, 181_400],
		["7 hops, 30 s overs, 1 s gaps", 7, 100_000, 0, 30_000, 1_000, 230_400],
		[
			"7 hops, 45 s overs, 1.5 s gaps from 60 s",
			7,
			100_000,
			60_000,
			45_000,
			1_500,
			236_350,
		],
	]
	for (const [name, hops, offsetHz, fromMs, overMs, gapMs, floor] of scenes)
		it(`${name}: heard ≥ ${floor} ms`, () => {
			const hz = planOf(hops).hops[qsoHop(hops)]!.centreHz + offsetHz
			const signals = regularQso(hz, fromMs, fromMs + 600_000, overMs, gapMs)
			const r = simulateSweep(planOf(hops), spec, {
				...sim,
				durationMs: fromMs + 600_000,
				signals,
			})
			expect(heardTotal(r)).toBeGreaterThanOrEqual(floor)
		})

	// 3 hops, on air from the job start, overs changed by up to ± 0, 100, 250 or 500 ms. Earlier
	// scheduler, ms heard per jitter: 20 s / 1 s 300 200, 297 900, 295 600, 296 400; 30 s / 1.5 s
	// 297 400, 296 100, 294 700, 293 100; 45 s / 1 s 301 400, 301 900, 301 900, 298 100.
	const jittered: [number, number, number[]][] = [
		[20_000, 1_000, [300_200, 297_900, 295_600, 296_400]],
		[30_000, 1_500, [297_400, 296_100, 294_700, 293_100]],
		[45_000, 1_000, [301_400, 301_900, 301_900, 298_100]],
	]
	for (const [overMs, gapMs, floors] of jittered)
		[0, 100, 250, 500].forEach((jitterMs, k) => {
			const floor = floors[k]!
			it(`3 hops, ${overMs / 1000} s overs, ${gapMs / 1000} s gaps, ± ${jitterMs} ms: heard ≥ ${floor} ms`, () => {
				const signals = regularQso(
					qsoHz(3),
					0,
					600_000,
					overMs,
					gapMs,
					jitterMs,
				)
				const r = simulateSweep(planOf(3), spec, {
					...sim,
					durationMs: 600_000,
					signals,
				})
				expect(heardTotal(r)).toBeGreaterThanOrEqual(floor)
			})
		})
})

describe("a grid of regular QSOs: overs 5 to 45 s, gaps 1 to 3 s", () => {
	// Ms heard by the earlier scheduler (one confirm probe per visit) over 600 s, by over (rows, 5 to
	// 45 s) and gap (columns: 1, 1.5, 2, 2.5, 3 s).
	const earlier: Record<string, number[][]> = {
		"3 hops, from 0 s": [
			[264_050, 263_550, 196_500, 184_600, 178_900],
			[277_650, 251_600, 236_550, 240_450, 227_950],
			[291_250, 274_050, 259_750, 261_950, 250_050],
			[300_200, 288_800, 252_000, 274_850, 269_000],
			[300_400, 295_450, 289_850, 285_700, 280_400],
			[301_650, 297_350, 291_900, 287_950, 284_600],
			[300_100, 295_250, 292_150, 284_800, 285_200],
			[300_250, 295_500, 290_250, 286_700, 284_700],
			[301_350, 293_500, 289_000, 288_300, 284_750],
		],
		"3 hops, from 60 s": [
			[249_150, 259_350, 199_600, 186_200, 172_950],
			[284_400, 252_500, 240_800, 240_000, 226_900],
			[284_200, 271_150, 264_000, 261_150, 246_900],
			[300_650, 289_700, 289_250, 274_700, 268_850],
			[301_100, 294_950, 288_900, 284_700, 279_250],
			[300_650, 296_400, 293_000, 288_500, 283_050],
			[299_050, 296_600, 291_700, 288_000, 285_400],
			[298_250, 294_600, 290_050, 286_100, 284_450],
			[302_600, 294_300, 289_000, 287_250, 285_650],
		],
		"7 hops, from 0 s": [
			[212_550, 198_850, 181_400, 163_350, 158_750],
			[233_850, 216_950, 214_050, 192_350, 192_300],
			[236_100, 228_300, 222_350, 214_800, 208_200],
			[236_750, 210_550, 216_200, 222_500, 207_600],
			[242_750, 221_000, 212_700, 218_000, 220_450],
			[230_400, 225_000, 219_100, 217_250, 218_800],
			[237_500, 231_250, 227_550, 224_800, 220_400],
			[237_800, 232_900, 231_400, 229_250, 226_650],
			[236_600, 235_650, 232_850, 227_400, 226_050],
		],
		"7 hops, from 60 s": [
			[211_850, 201_400, 180_250, 168_150, 161_650],
			[217_850, 219_450, 217_950, 206_800, 191_550],
			[240_750, 234_850, 224_450, 219_500, 211_050],
			[236_400, 217_450, 215_950, 223_600, 208_950],
			[241_200, 223_350, 217_500, 221_450, 222_800],
			[233_000, 225_300, 225_250, 218_450, 220_750],
			[236_400, 230_100, 228_300, 221_900, 220_450],
			[236_000, 234_850, 232_800, 227_700, 228_000],
			[240_300, 236_350, 232_100, 228_850, 227_200],
		],
	}
	const gaps = [1_000, 1_500, 2_000, 2_500, 3_000]
	for (const hops of [3, 7])
		for (const fromMs of [0, 60_000]) {
			const name = `${hops} hops, from ${fromMs / 1000} s`
			it(`${name}: every cell heard at least as much as before`, () => {
				const below: string[] = []
				earlier[name]!.forEach((row, k) => {
					const overMs = 5_000 * (k + 1)
					row.forEach((floor, g) => {
						const gapMs = gaps[g]!
						const signals = regularQso(
							qsoHz(hops),
							fromMs,
							fromMs + 600_000,
							overMs,
							gapMs,
						)
						const r = simulateSweep(planOf(hops), spec, {
							...sim,
							durationMs: fromMs + 600_000,
							signals,
						})
						const cell = `${name}, ${overMs / 1000}/${gapMs / 1000}`
						if (heardTotal(r) < floor)
							below.push(`${cell}: ${heardTotal(r)} < ${floor}`)
					})
				})
				expect(below).toEqual([])
			}, 60_000)
		}
})

describe("a QSO of regular long overs is heard at least as much as before on every hop and hop overlap", () => {
	// Overs and gaps (ms) where a QSO on air at the job start was heard less than before on some
	// hop: its first hold heard an over without a break (carrier evidence) and later holds kept
	// landing inside overs (3 hops, hop 2: 45 s / 1 s heard 275 600 ms against 301 000 ms).
	const combos: [number, number][] = [
		[45_000, 1_000],
		[45_000, 2_500],
		[35_000, 3_000],
		[25_000, 2_500],
		[20_000, 2_500],
	]
	// Ms heard over 600 s by the earlier scheduler (one confirm probe per visit), per combo, at 100
	// kHz above each hop centre ("k") and in each hop overlap (400 kHz above hop k's centre, "k/k+1",
	// heard by both hops).
	const earlier: Record<number, Record<string, number[]>> = {
		3: {
			"0": [301_350, 288_300, 285_200, 285_700, 274_850],
			"1": [301_350, 288_300, 285_200, 285_700, 274_850],
			"2": [301_000, 286_500, 284_250, 282_100, 274_400],
			"0/1": [366_050, 351_750, 345_150, 341_100, 333_950],
			"1/2": [365_000, 349_500, 345_200, 340_700, 332_050],
		},
		7: {
			"0": [239_100, 229_000, 218_850, 219_000, 223_350],
			"1": [239_850, 229_150, 218_600, 219_300, 224_350],
			"2": [237_950, 228_150, 218_800, 219_250, 221_000],
			"3": [236_600, 227_400, 220_400, 218_000, 222_500],
			"4": [236_850, 226_350, 219_600, 218_600, 221_550],
			"5": [239_250, 225_400, 216_350, 216_800, 220_450],
			"6": [235_100, 224_250, 216_350, 218_250, 222_100],
			"0/1": [282_050, 271_200, 275_000, 263_250, 251_100],
			"1/2": [283_550, 269_750, 275_500, 261_450, 250_050],
			"2/3": [285_000, 269_650, 271_900, 262_000, 252_700],
			"3/4": [280_700, 271_500, 269_350, 261_350, 252_100],
			"4/5": [280_800, 272_500, 266_350, 262_450, 250_900],
			"5/6": [282_600, 271_150, 273_650, 260_850, 248_500],
		},
	}
	for (const hops of [3, 7])
		it(`${hops} hops: every hop and overlap heard at least as much as before`, () => {
			const plan = planOf(hops)
			const below: string[] = []
			for (const [at, floors] of Object.entries(earlier[hops]!)) {
				const k = Number(at.split("/")[0])
				const hz =
					plan.hops[k]!.centreHz + (at.includes("/") ? 400_000 : 100_000)
				combos.forEach(([overMs, gapMs], c) => {
					const signals = regularQso(hz, 0, 600_000, overMs, gapMs)
					const r = simulateSweep(plan, spec, {
						...sim,
						durationMs: 600_000,
						signals,
					})
					if (heardTotal(r) < floors[c]!)
						below.push(
							`${at}, ${overMs / 1000}/${gapMs / 1000}: ${heardTotal(r)} < ${floors[c]}`,
						)
				})
			}
			expect(below).toEqual([])
		}, 60_000)
})

describe("any QSO is heard at least as well as by one confirm probe per visit", () => {
	// Feature: scanner-sweep-fairness, Property 3: a QSO, whenever and wherever it starts, is never heard less than one confirm probe per visit heard it
	// Validates: Requirements 3 (real traffic is never heard less than one probe per visit), 1 (no hop starved by another hop's holds)
	it("hears at least 1.23 × the share one probe per coarse sweep hears, from the job start", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 7 }),
				fc.nat(1_000),
				// anywhere in the hop's 819.2 kHz, its overlaps with the next hops included
				fc.integer({ min: -400, max: 400 }),
				fc.integer({ min: 0, max: 120_000 }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(hops, slot, offsetKhz, fromMs, seed) => {
					const plan = planOf(hops)
					const hz = plan.hops[slot % hops]!.centreHz + offsetKhz * 1_000
					// Overs of 5 to 45 s with turnarounds of 1 to 1.9 s.
					const rnd = random(seed)
					const signals: SimSignal[] = []
					const endMs = fromMs + 600_000
					for (let t = fromMs; t < endMs; ) {
						const over = Math.round(5_000 + 40_000 * rnd())
						signals.push(voice(hz, t, Math.min(over, endMs - t)))
						t += over + Math.round(1_000 + 900 * rnd())
					}
					const r = simulateSweep(plan, spec, {
						...sim,
						durationMs: endMs,
						signals,
					})
					// One probe per coarse sweep hears the dwell's 3 blocks and the probe (1800 + 300 ms)
					// out of a sweep of hops × 1150 ms plus that probe: 2250 / (1150 × hops + 2100). The
					// earlier scheduler (a probe on every visit, revisits by activity) heard at least
					// 1.233 times that over 400 random QSOs of this kind; the scheduler must too, with no
					// exception for a QSO that is never followed long.
					const floor = 2_250 / (1_150 * hops + 2_100)
					expect(heardShare(r, signals)).toBeGreaterThanOrEqual(1.23 * floor)
				},
			),
			{ numRuns: 100 },
		)
	}, 300_000)
})

describe("decoded calls", () => {
	// The job notes a decode but does not follow it (voice not recorded): onConfirmed(id, false).
	// A decode proves traffic but bars nothing: every new call is probed again, also when a busy
	// frequency carries 20 s calls with 1 to 3 s turnarounds that no visit hears. The earlier
	// scheduler probed all 28 calls of 10 minutes (3 and 7 hops).
	for (const hops of [3, 7])
		it(`${hops} hops: every one of successive 20 s calls is probed`, () => {
			const rnd = random(5)
			const calls: SimSignal[] = []
			for (let t = 0; t < 600_000; ) {
				calls.push({
					...decoded(qsoHz(hops), t, 20_000),
					decodeFollows: false,
				})
				t += 20_000 + Math.round(1_000 + 2_000 * rnd())
			}
			expect(calls).toHaveLength(28)
			const r = simulateSweep(planOf(hops), spec, {
				...sim,
				durationMs: 600_000,
				signals: calls,
			})
			for (const held of r.holds) expect(held).toBeGreaterThanOrEqual(1)
		})

	// DMR-like calls decoded 800 ms into the probe are followed to their end, whatever the onset
	// evidence. The earlier scheduler (decoded follows to maxHoldMs) heard a 28 s call at 0 s and at
	// 5 s: 3 hops 25 850 / 27 400 ms, 7 hops 23 550 / 20 500 ms; 40 s calls every 70 s from 10 s:
	// 37 500 then 38 200 ms each (3 hops), 37 500 then 37 050 ms each (7 hops). Thresholds: those.
	const single: Record<number, [number, number]> = {
		3: [25_850, 27_400],
		7: [23_550, 20_500],
	}
	const series: Record<number, [number, number]> = {
		3: [37_500, 38_200],
		7: [37_500, 37_050],
	}
	for (const hops of [3, 7]) {
		;[0, 5_000].forEach((atMs, k) => {
			it(`${hops} hops, a 28 s decoded call at ${atMs} ms is heard ≥ ${single[hops]![k]} ms`, () => {
				const r = simulateSweep(planOf(hops), spec, {
					...sim,
					durationMs: atMs + 40_000,
					signals: [decoded(qsoHz(hops), atMs, 28_000)],
				})
				expect(r.heardMs[0]).toBeGreaterThanOrEqual(single[hops]![k]!)
			})
		})
		it(`${hops} hops, 40 s decoded calls every 70 s are each heard to their end`, () => {
			const calls = Array.from({ length: 5 }, (_, i) =>
				decoded(qsoHz(hops), 10_000 + 70_000 * i, 40_000),
			)
			const r = simulateSweep(planOf(hops), spec, {
				...sim,
				durationMs: 400_000,
				signals: calls,
			})
			const [first, rest] = series[hops]!
			expect(r.heardMs[0]).toBeGreaterThanOrEqual(first)
			for (const ms of r.heardMs.slice(1))
				expect(ms).toBeGreaterThanOrEqual(rest)
		})
	}
})

/** Visits of hop `hop` that held something (longer than two dwells and a block). */
const heldVisits = (r: SimResult, hop: number): SimResult["visits"] =>
	r.visits.filter(
		v =>
			v.hopIndex === hop && v.leftAtMs - v.tunedAtMs > 2 * DWELL_MS + BLOCK_MS,
	)
/**
 * Most holds a carrier that flapped from the job start gets in `runMs`: its first hold, then one
 * per retry. A carrier's hold watches it to min(one sweep, WATCH_MS) from its start (a flap does
 * not end it), so it lasts d ≥ min(sweep, WATCH_MS), and it then rests at least
 * 20 × 0.5 × d = 10 d (FLAP_REST_FACTOR, spread from 0.5).
 */
const flapHolds = (hops: number, runMs: number): number => {
	const d = Math.min(hops * DWELL_MS, WATCH_MS)
	return 1 + Math.floor(runMs / (d + 10 * d))
}
/**
 * Most holds any carrier gets in `runMs`: as flapHolds, with the rest of a carrier that has not
 * flapped yet (an on-time longer than its watches: RETRY_REST_FACTOR 2, so at least d), so it is
 * held at most half the time and never on every visit.
 */
const carrierHolds = (hops: number, runMs: number): number => {
	const d = Math.min(hops * DWELL_MS, WATCH_MS)
	return 1 + Math.floor(runMs / (d + d))
}

describe("a flapping carrier with a short hangMs is one carrier", () => {
	// A carrier labelled analog voice, 5 s on / 0.5 s off from the job start for 300 s. A gap of
	// 0.5 s reads 550 ms, short of TRAFFIC_GAP_MS whatever hangMs is: a flap, carrier evidence, so
	// it is held only in its retry slots (3 hops: at most 1 + 300 000 / (11 × 3450) = 8 holds;
	// 7 hops: 1 + 300 000 / (11 × 8000) = 4). With hangMs 300 a hold could end inside a gap before
	// the reopening was heard: the hang classing a gap runs 1050 ms whatever hangMs is.
	for (const hangMs of [300, 999, 1_000, 1_050, 2_000])
		for (const hops of [3, 7])
			it(`hangMs ${hangMs}, ${hops} hops: held at most ${flapHolds(hops, 300_000)} times`, () => {
				const short = makeNormalisedSpec({
					dwellMs: DWELL_MS,
					settleMs: SETTLE_MS,
					hold: { ...spec.hold, hangMs },
				})
				const signals = regularQso(qsoHz(hops), 0, 300_000, 5_000, 500)
				const r = simulateSweep(planOf(hops), short, {
					...sim,
					durationMs: 300_000,
					signals,
				})
				const held = heldVisits(r, qsoHop(hops))
				expect(held.length).toBeGreaterThanOrEqual(1)
				expect(held.length).toBeLessThanOrEqual(flapHolds(hops, 300_000))
			})
})

describe("a gap that starts in a hold is classed before the hop is left", () => {
	// Two hops of 1150 ms: one coarse sweep is 2300 ms. A labelled transmission on air at the job
	// start (not known) is watched from the dwell end (1150 ms, no confirm probe) to WATCH_MS
	// later, 9150 ms. It closes 50 ms after `endMs`; the reopening starts at `reopenMs`.
	const plan = makeHopPlan(centres(2), HALF_SPAN_HZ)
	const noRevisit = makeNormalisedSpec({
		dwellMs: DWELL_MS,
		settleMs: SETTLE_MS,
		revisit: { share: 0, maxIntervalMs: null },
	})
	const hz = plan.hops[0]!.centreHz + 100_000
	const run = (
		endMs: number,
		reopenMs: number,
		durationMs = 60_000,
	): SimResult =>
		simulateSweep(plan, noRevisit, {
			...sim,
			durationMs,
			signals: [
				{ ...voice(hz, 0, endMs), needsConfirm: false },
				{ ...voice(hz, reopenMs, 400_000), needsConfirm: false },
			],
		})
	/** Later holds of hop 0 and the longest. */
	const later = (r: SimResult): number[] =>
		r.visits
			.filter(v => v.hopIndex === 0 && v.tunedAtMs > 0)
			.map(v => v.leftAtMs - v.tunedAtMs)
			.filter(ms => ms > 2 * DWELL_MS + BLOCK_MS)
	/** A carrier's hold on 2 hops: a dwell, one sweep and a hang classing a gap. */
	const carrierVisit = DWELL_MS + 2 * DWELL_MS + CLASS_HANG_MS + BLOCK_MS

	it("a close 500 ms before the cap: the hang runs to 1050 ms after it, and an off gap that long is traffic", () => {
		// Close at 8650 ms: the hang ends at max(min(8650 + 2000, 9150), 8650 + 1050) = 9700 ms.
		const r = run(8_600, 12_000)
		expect(r.visits[0]?.leftAtMs).toBe(9_700)
		// Traffic: the reopening (on air from 12 000 ms) is followed long on hop 0's next visit.
		expect(Math.max(...later(r))).toBeGreaterThan(carrierVisit)
	})

	it("a close 1400 ms before the cap is classed within the cap", () => {
		// Close at 7750 ms: the hang ends at the cap, 9150 ms, 1400 ms off air: traffic.
		const r = run(7_700, 12_000)
		expect(r.visits[0]?.leftAtMs).toBe(9_150)
		expect(Math.max(...later(r))).toBeGreaterThan(carrierVisit)
	})

	it("a reopening 450 ms after the close (a flapping carrier's gap) is carrier evidence", () => {
		// Close at 8650 ms, reopening sighted at 9200 ms (550 ms heard off, short of 1000): a flap.
		// The hold is past a carrier's cap (one sweep from 1150 ms), so the hop is left. It rests at
		// least 20 × 0.5 × 8050 ms = 80 500 ms (FLAP_REST_FACTOR); its later holds in 300 s are a
		// carrier's (at most one sweep and a hang), never a long follow.
		const r = run(8_600, 9_100, 300_000)
		expect(r.visits[0]?.leftAtMs).toBeLessThanOrEqual(9_200 + BLOCK_MS)
		expect(later(r).length).toBeGreaterThan(0)
		for (const ms of later(r)) expect(ms).toBeLessThanOrEqual(carrierVisit)
	})
})

describe("carriers flapping in short gaps are never followed as traffic", () => {
	/**
	 * A carrier labelled analog voice flapping `onMs` on / `offMs` off on hop `slot % hops` from
	 * `startMs` for 300 s: every hold of it is bounded and its holds are paced by its retry budget.
	 */
	const flapCase = (
		hops: number,
		slot: number,
		onMs: number,
		offMs: number,
		startMs: number,
	): void => {
		const plan = makeHopPlan(centres(hops), HALF_SPAN_HZ)
		const hop = slot % hops
		const hz = plan.hops[hop]!.centreHz + 100_000
		const signals: SimSignal[] = []
		for (let t = startMs; t < 300_000; t += onMs + offMs)
			signals.push(voice(hz, t, onMs))
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 300_000,
			signals,
		})
		// One on air from the job start is watched at most WATCH_MS on its first hold; one that
		// starts later on a hop whose earlier visit missed it is followed until its first flap (one
		// on-time, its gap and the reopening's sighting, 2 blocks); either way plus a hang classing
		// a gap that started before the cap. Later holds are a carrier's: at most one sweep.
		const bound =
			DWELL_MS +
			Math.max(WATCH_MS, onMs + offMs + 2 * BLOCK_MS) +
			CLASS_HANG_MS +
			BLOCK_MS
		for (const v of r.visits.filter(x => x.hopIndex === hop))
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(bound)
		// Its first hold, then retries, never one per visit: with on-times longer than a watch its
		// holds may hear it unbroken before they hear a flap (carrierHolds); with shorter ones every
		// hold hears a flap (flapHolds). One that starts after its hop's first visit ended
		// ((hop + 1) dwells) is a call whose onset was seen: its first flap may be unpaired (one
		// flap in its first hold), so that hold rests once its length (KNOWN_CALL_REST_FACTOR) and
		// the flap rest starts with its second hold: one hold more.
		const known = startMs >= (hop + 1) * DWELL_MS ? 1 : 0
		const most =
			onMs + offMs < Math.min(hops * DWELL_MS, WATCH_MS)
				? flapHolds(hops, 300_000) + known
				: carrierHolds(hops, 300_000)
		expect(heldVisits(r, hop).length).toBeLessThanOrEqual(most)
	}

	// Feature: scanner-sweep-fairness, Property 2: a carrier flapping with gaps of 300 to 600 ms is never followed long nor held on every visit, whenever it starts
	// Validates: Requirements 2 (no re-hold or long follow of a steady or flapping carrier), 1 (no hop starved by another hop's holds)
	it("holds a flapping carrier a bounded time per hold, paced by its retry budget", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 7 }),
				fc.nat(1_000),
				// on 2 to 25 s, off 300 to 600 ms: every gap reads at most 700 ms (gap + one block, ±
				// one block), short of TRAFFIC_GAP_MS (1000 ms)
				fc.integer({ min: 2_000, max: 25_000 }),
				fc.integer({ min: 300, max: 600 }),
				fc.integer({ min: 0, max: 60_000 }),
				flapCase,
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	// Regression (fast-check seed -203967601, path "73:3:8:3:14:6:5"): 4 hops, the carrier on hop 2,
	// 2 s on / 581 ms off from 16 991 ms. Its probes (2100 ms) ended inside an off gap, so no short
	// gap was heard, and the next visit's late open after more than 600 ms passed for a new over:
	// it was probed every ~7.85 s. Now a hold whose track closes keeps a hang of 1050 ms, hears
	// the reopening 581 ms later (a flap) and the carrier rests: 4 holds in 300 s.
	it("a carrier flapping 2 s on / 581 ms off is not probed on every visit", () => {
		flapCase(4, 2, 2_000, 581, 16_991)
	})

	// Regressions (fast-check seed -258117743, path "61:17:7:7:27:12", and seed 1911586836): 6
	// hops, a carrier whose onset a visit saw (a call), flapping 4822 ms on / 308 ms off from
	// 56 081 ms, or 5130 / 507 ms from 11 192 ms. Each hold heard one flap, and the pairing window
	// of a known call (10 s of the visit time of its hop) was shorter than two flaps heard in
	// consecutive holds can be apart (less than the flap period after one hold's flap, the next
	// hold's dwell, and less than the period again): the flaps were never paired and it rested
	// once its hold (5 and 6 holds, bound 4). Now the window is derived from that and counts held
	// time, so it earns the flap rest from its second flap: after each hold from the second on it
	// rests at least 20 × 0.5 = 10 times that hold (its length at least the visit less the dwell
	// and a class wait of 5 blocks), and no new hold starts before the next dwell end after it.
	for (const [slot, onMs, offMs, startMs] of [
		[22, 4_822, 308, 56_081],
		[0, 5_130, 507, 11_192],
	] as const)
		it(`a call flapping ${onMs} ms on / ${offMs} ms off from ${startMs} ms rests twenty times its holds from its second`, () => {
			flapCase(6, slot, onMs, offMs, startMs)
			const plan = makeHopPlan(centres(6), HALF_SPAN_HZ)
			const hop = slot % 6
			const hz = plan.hops[hop]!.centreHz + 100_000
			const signals: SimSignal[] = []
			for (let t = startMs; t < 300_000; t += onMs + offMs)
				signals.push(voice(hz, t, onMs))
			const held = heldVisits(
				simulateSweep(plan, spec, { ...sim, durationMs: 300_000, signals }),
				hop,
			)
			expect(held.length).toBeGreaterThanOrEqual(2)
			for (let k = 1; k + 1 < held.length; k++) {
				const v = held[k]!
				const lenMs = v.leftAtMs - v.tunedAtMs - DWELL_MS - 5 * BLOCK_MS
				expect(
					held[k + 1]!.tunedAtMs + DWELL_MS + 5 * BLOCK_MS,
				).toBeGreaterThanOrEqual(v.leftAtMs + 10 * lenMs)
			}
		})

	it("a new flapping carrier first followed as traffic is cut at its first short gap", () => {
		// 3 hops: hop 2's first visit (2300 to 3450 ms) misses a carrier that starts flapping 3 s on
		// / 0.5 s off at 4 s, so its next visit follows it (its onset was seen) after the probe.
		// Its first gap (0.5 s, read 550 ms) is a flap: the follow is cut to one coarse sweep
		// (3450 ms) from the start of the hold, not maxHoldMs.
		const plan = planOf(3)
		const hz = plan.hops[2]!.centreHz + 100_000
		const signals: SimSignal[] = []
		for (let t = 4_000; t < 120_000; t += 3_500)
			signals.push(voice(hz, t, 3_000))
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 120_000,
			signals,
		})
		const longest = Math.max(
			...r.visits
				.filter(v => v.hopIndex === 2)
				.map(v => v.leftAtMs - v.tunedAtMs),
		)
		expect(longest).toBeLessThanOrEqual(
			DWELL_MS + 3 * DWELL_MS + 3_500 + CLASS_HANG_MS + BLOCK_MS,
		)
		expect(longest).toBeLessThan(DWELL_MS + spec.hold.maxHoldMs)
	})
})

describe("holds of frequencies not known on a large plan", () => {
	it("five carriers labelled analog voice add at most 8 s each to the first sweep of a 60-hop plan, and one carrier hold to each later sweep", () => {
		// 60 hops of 1150 ms: a nominal sweep of 69 000 ms (an empty band takes exactly that). Each
		// carrier on air from the start is watched at most WATCH_MS (8000) on its first hold, not
		// one sweep (69 000 ms, cut to maxHoldMs 60 000), and the hops active during those holds get
		// at most one revisit per round(1 / 0.3) = 3 coarse hops (20 × 1150 = 23 000 ms): at most
		// 69 000 + 5 × 8000 + 23 000 = 132 000 ms (measured 109 000; one confirm probe per visit
		// took 141 250 ms). Then they are carriers: at most one carrier hold (8000 ms, a hang classing
		// a gap) per later sweep, 69 000 + 8000 + 1050 + 23 000 = 101 050 ms (measured 77 000).
		const plan = planOf(60)
		const signals = [3, 15, 27, 39, 51].map(i => ({
			...voice(plan.hops[i]!.centreHz + 100_000, 0, Number.POSITIVE_INFINITY),
			snrDb: 25,
		}))
		const empty = simulateSweep(plan, spec, {
			...sim,
			durationMs: 900_000,
			maxSweeps: 1,
		})
		expect(empty.sweepEndsMs[0]).toBe(60 * DWELL_MS)
		const r = simulateSweep(plan, spec, {
			...sim,
			durationMs: 900_000,
			signals,
			maxSweeps: 4,
		})
		const revisits = 20 * DWELL_MS
		expect(r.sweepEndsMs[0]).toBeLessThanOrEqual(
			60 * DWELL_MS + 5 * WATCH_MS + revisits,
		)
		for (let k = 1; k < r.sweepEndsMs.length; k++)
			expect(r.sweepEndsMs[k]! - r.sweepEndsMs[k - 1]!).toBeLessThanOrEqual(
				60 * DWELL_MS + WATCH_MS + CLASS_HANG_MS + revisits,
			)
		for (const v of r.visits)
			expect(v.leftAtMs - v.tunedAtMs).toBeLessThanOrEqual(
				DWELL_MS + WATCH_MS + BLOCK_MS,
			)
	})
})

describe("a QSO on one hop does not hide 28 s IDs on another", () => {
	// 900 s: a QSO (5 to 30 s overs) on hop 0 from the job start or from 60 s, 28 s IDs on the last
	// hop every 45 to 75 s from 50 to 70 s, four seeds. The scheduler before L followed the QSO for
	// maxHoldMs (60 s) and missed 16 of the 57 IDs on 3 hops (14 on 7 hops); one confirm probe
	// per visit detected all of them. QSO thresholds: Σ ms that scheduler (37902150) heard of the
	// QSO over the four seeds.
	const RUN_MS = 900_000
	const idTimes = (seed: number): number[] => {
		const rnd = random(seed * 77)
		const out: number[] = []
		for (
			let t = 50_000 + 20_000 * rnd();
			t < 850_000;
			t += 45_000 + 30_000 * rnd()
		)
			out.push(Math.round(t))
		return out
	}
	const scene = (
		hops: number,
		fromMs: number,
		gapMinMs: number,
		gapMaxMs: number,
		seeds: readonly number[] = [1, 2, 3, 4],
	): { detected: number; ids: number; qsoMs: number } => {
		const plan = planOf(hops)
		const q = plan.hops[0]!.centreHz - 100_000
		const v = plan.hops[hops - 1]!.centreHz + 100_000
		let detected = 0
		let ids = 0
		let qsoMs = 0
		for (const seed of seeds) {
			const talk = qso(q, fromMs, RUN_MS, seed, gapMinMs, gapMaxMs)
			const at = idTimes(seed)
			const r = simulateSweep(plan, spec, {
				...sim,
				durationMs: RUN_MS,
				signals: [...talk, ...at.map(ms => voice(v, ms))],
			})
			ids += at.length
			detected += at.filter(
				(_, k) => r.detectedAtMs[talk.length + k] !== null,
			).length
			qsoMs += r.heardMs.slice(0, talk.length).reduce((a, b) => a + b, 0)
		}
		return { detected, ids, qsoMs }
	}
	const earlier: Record<string, number> = {
		"3/0": 1_503_850,
		"3/60000": 1_101_350,
		"7/0": 927_900,
		"7/60000": 820_050,
	}
	// Single seeds of the same scene (seed 15 heard 343 700 ms where that scheduler heard 376 550:
	// a follow ended by a turnaround locked its hop to probes; seeds 38 and 24 each missed an ID
	// while the follows of two coarse sweeps were not counted against one L), and the lowest
	// ratio to that scheduler of each plan and start over seeds 1 to 40 (1, 21, 33, 16).
	// Thresholds: what that scheduler (37902150) heard of the QSO on each.
	const seeded: [number, number, number, number][] = [
		[3, 0, 15, 376_550],
		[3, 0, 1, 376_950],
		[3, 0, 38, 374_950],
		[3, 60_000, 21, 352_450],
		[7, 0, 33, 228_950],
		[7, 60_000, 16, 212_450],
		[7, 60_000, 24, 199_400],
	]
	for (const [hops, fromMs, seed, floor] of seeded)
		it(`${hops} hops, QSO from ${fromMs / 1000} s, seed ${seed}: every ID is detected and the QSO is heard ≥ ${floor} ms`, () => {
			const { detected, ids, qsoMs } = scene(hops, fromMs, 1_000, 3_000, [seed])
			expect(detected).toBe(ids)
			expect(qsoMs).toBeGreaterThanOrEqual(floor)
		})

	// The known class below one confirm probe per visit (docs/SCANNER.md, Fair holds): 3 hops, a
	// QSO on air from the job start. Seed 22 hears 354 300 ms of it where that scheduler
	// (37902150) heard 370 400 ms: 4.35 % less. Measured value, asserted so a change shows here.
	it("3 hops, QSO from 0 s, seed 22: every ID is detected, the QSO is heard 354 300 ms (4.35 % below one confirm probe per visit)", () => {
		const { detected, ids, qsoMs } = scene(3, 0, 1_000, 3_000, [22])
		expect(detected).toBe(ids)
		expect(qsoMs).toBe(354_300)
		expect(1 - qsoMs / 370_400).toBeCloseTo(0.0435, 4)
	})

	// The accepted current limit, a follow-up is planned (docs/SCANNER.md, Fair holds): a second
	// call on air. 900 s on 3, 5 and 7 hops, seeds 1 to 40: the QSO on hop 0 from the job start,
	// labelled calls of 8 to 20 s with 10 to 60 s gaps on hop 1, 28 s IDs on the last hop. Probe-only
	// revisits of a hop whose follows spent L are not counted against L, so an ID can start and end
	// while its hop waits. 2 of 1635 IDs are missed (one confirm probe per visit: none). Measured
	// values, asserted so a change shows here.
	it("accepted current limit: with a second call on air, 2 of 1635 28 s IDs are missed (about 0.1 %)", () => {
		const calls = (hz: number, seed: number): SimSignal[] => {
			const rnd = random(seed * 131 + 5)
			const out: SimSignal[] = []
			for (let t = 10_000 + 20_000 * rnd(); t < RUN_MS; ) {
				const len = Math.round(8_000 + 12_000 * rnd())
				out.push(voice(hz, t, Math.min(len, RUN_MS - t)))
				t += len + Math.round(10_000 + 50_000 * rnd())
			}
			return out
		}
		let ids = 0
		const missed: string[] = []
		for (const hops of [3, 5, 7])
			for (let seed = 1; seed <= 40; seed++) {
				const plan = planOf(hops)
				const talk = qso(plan.hops[0]!.centreHz - 100_000, 0, RUN_MS, seed)
				const other = calls(plan.hops[1]!.centreHz + 150_000, seed)
				const at = idTimes(seed)
				const v = plan.hops[hops - 1]!.centreHz + 100_000
				const r = simulateSweep(plan, spec, {
					...sim,
					durationMs: RUN_MS,
					signals: [...talk, ...other, ...at.map(ms => voice(v, ms))],
				})
				const first = talk.length + other.length
				ids += at.length
				at.forEach((ms, k) => {
					if (r.detectedAtMs[first + k] === null)
						missed.push(`${hops}/${seed}/${ms}`)
				})
			}
		expect(ids).toBe(1_635)
		expect(missed).toEqual(["3/12/812300", "7/7/314977"])
	}, 60_000)

	for (const hops of [3, 7])
		for (const fromMs of [0, 60_000])
			it(`${hops} hops, QSO from ${fromMs / 1000} s: every ID is detected and the QSO is heard ≥ ${earlier[`${hops}/${fromMs}`]} ms`, () => {
				const { detected, ids, qsoMs } = scene(hops, fromMs, 1_000, 3_000)
				expect(ids).toBe(57)
				expect(detected).toBe(ids)
				expect(qsoMs).toBeGreaterThanOrEqual(earlier[`${hops}/${fromMs}`]!)
			})

	// The accepted exception (docs/SCANNER.md, Fair holds): a QSO whose turnarounds are under 1 s
	// (0.3 to 0.9 s, or 0.5 to 1.5 s mixed) flaps like a carrier, so it is held as one and heard
	// less than one confirm probe per visit heard it (that scheduler: 3 hops 1 659 350 and
	// 1 612 300 ms, 7 hops 1 018 150 and 979 850 ms over the four seeds). The IDs are all
	// detected. Measured values, asserted so a change shows here (7 hops, 0.3 to 0.9 s: 300 350 ms
	// while a carrier hold's hang could run past what L had left, 300 250 ms bounded by it).
	const exception: Record<number, [number, number]> = {
		3: [371_100, 804_900],
		7: [300_250, 540_300],
	}
	for (const hops of [3, 7])
		it(`accepted exception, ${hops} hops: a QSO with turnarounds under 1 s is heard ${exception[hops]![0]} ms (0.3 to 0.9 s) and ${exception[hops]![1]} ms (0.5 to 1.5 s)`, () => {
			const fast = scene(hops, 0, 300, 900)
			const mixed = scene(hops, 0, 500, 1_500)
			expect(fast.detected).toBe(fast.ids)
			expect(mixed.detected).toBe(mixed.ids)
			expect(fast.qsoMs).toBe(exception[hops]![0])
			expect(mixed.qsoMs).toBe(exception[hops]![1])
		})

	// The same exception for a QSO starting mid-job (60 s) with 0.3 to 0.9 s turnarounds: that
	// scheduler heard 1 218 850 ms (3 hops) and 912 100 ms (7 hops) over the four seeds; this one
	// about a third and a half of that. Measured values, asserted so a change shows here.
	const midJob: Record<number, number> = { 3: 430_400, 7: 442_400 }
	for (const hops of [3, 7])
		it(`accepted exception, ${hops} hops: a QSO from 60 s with 0.3 to 0.9 s turnarounds is heard ${midJob[hops]} ms`, () => {
			const fast = scene(hops, 60_000, 300, 900)
			expect(fast.detected).toBe(fast.ids)
			expect(fast.qsoMs).toBe(midJob[hops])
		})
})

describe("busy decoded channels and tail-bridged repeaters", () => {
	// 40 DMR-like 10 s calls with 2 s gaps on hop 1, decoded 800 ms into the probe and followed:
	// decoded follows run to their end (to maxHoldMs at most), not cut to L, and a decoded call that
	// ends before L sets no lock. The scheduler before frequency memory heard 314 000 ms (3 hops)
	// and 269 150 ms (7 hops); with the lock after every long decoded follow: 232 750 ms (3 hops).
	const earlier: Record<number, number> = { 3: 314_000, 7: 269_150 }
	for (const hops of [3, 7])
		it(`${hops} hops: 10 s decoded calls every 12 s are heard ≥ ${earlier[hops]} ms`, () => {
			const hz = planOf(hops).hops[1]!.centreHz
			const calls = Array.from({ length: 40 }, (_, k) =>
				decoded(hz, k * 12_000, 10_000),
			)
			const r = simulateSweep(planOf(hops), spec, {
				...sim,
				durationMs: 600_000,
				signals: calls,
			})
			expect(r.heardMs.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
				earlier[hops]!,
			)
		})

	// A repeater on hop 0 whose tail bridges its turnarounds: 90 to 240 s on air without a break,
	// 5 to 40 s off, then a 28 s ID, then 20 to 60 s off; 28 s IDs on the last hop at 100, 300,
	// 500, 700 and 900 s; 1200 s. Once heard as traffic (or its onset seen) it rests once its hold
	// length (KNOWN_CALL_REST_FACTOR), not twice. Thresholds: the busy periods' ms heard by the
	// scheduler before frequency memory (37902150), by seed.
	const tails: Record<string, number[]> = {
		"3/0": [417_350, 396_350],
		"3/60000": [420_100, 383_500],
		"7/0": [265_000, 252_000],
		"7/60000": [256_800, 234_350],
	}
	for (const hops of [3, 7])
		for (const fromMs of [0, 60_000])
			it(`${hops} hops, repeater from ${fromMs / 1000} s: its busy periods are heard at least as much as before`, () => {
				const plan = planOf(hops)
				const hz = plan.hops[0]!.centreHz - 100_000
				const v = plan.hops[hops - 1]!.centreHz + 100_000
				tails[`${hops}/${fromMs}`]!.forEach((floor, k) => {
					const rnd = random(k + 1)
					const busy: SimSignal[] = []
					const ids: SimSignal[] = []
					for (let t = fromMs; t < 1_100_000; ) {
						const on = Math.round(90_000 + 150_000 * rnd())
						busy.push(voice(hz, t, on))
						t += on + Math.round(5_000 + 35_000 * rnd())
						ids.push(voice(hz, t, 28_000))
						t += 28_000 + Math.round(20_000 + 40_000 * rnd())
					}
					const others = [100_000, 300_000, 500_000, 700_000, 900_000].map(ms =>
						voice(v, ms),
					)
					const r = simulateSweep(plan, spec, {
						...sim,
						durationMs: 1_200_000,
						signals: [...busy, ...ids, ...others],
					})
					const heard = r.heardMs
						.slice(0, busy.length)
						.reduce((a, b) => a + b, 0)
					expect(heard).toBeGreaterThanOrEqual(floor)
				})
			})
})
