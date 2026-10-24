/**
 * A20 reverse-burst tracker (design A20): detection, onset and latency bounds over every block
 * alignment, steps that must not fire, false alarms on bounded fades and flutter, and arming.
 * Synthetic and seeded; latency is counted in samples.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CTCSS_HZ } from "../../../../src/core/audio-tones/ctcss.js"
import {
	REVERSE_BURST_BLOCK_SAMPLES,
	REVERSE_BURST_RING_BLOCKS,
	ReverseBurstTracker,
} from "../../../../src/core/evidence-squelch/reverse-burst.js"
import { directTone, seeded } from "./reverse-burst-signals.js"

const N = REVERSE_BURST_BLOCK_SAMPLES
/** Measured over every alignment (design A20, sweep): onset - reversal, in 8 kHz samples. */
const ONSET_MIN = -121
const ONSET_MAX = -41
/** Deciding sample + 1 - reversal, in 8 kHz samples. */
const LATENCY_MIN = 520
const LATENCY_MAX = 892

interface Run {
	hit: number
	onset: number
}

function run(t: ReverseBurstTracker, x: Float64Array, hz: number): Run {
	t.arm(hz)
	for (let n = 0; n < x.length; n++)
		if (t.push(x[n] ?? 0, n)) return { hit: n, onset: t.onsetIndex }
	return { hit: -1, onset: -1 }
}

function hits(t: ReverseBurstTracker, x: Float64Array, hz: number): number {
	t.arm(hz)
	let count = 0
	for (let n = 0; n < x.length; n++)
		if (t.push(x[n] ?? 0, n)) {
			count += 1
			t.arm(hz)
		}
	return count
}

describe("A20: ReverseBurstTracker", () => {
	it("detects 120° and 180° reversals at 67.0, 127.3 and 254.1 Hz within the measured bounds", () => {
		const t = new ReverseBurstTracker()
		for (const hz of [67, 127.3, 254.1])
			for (const deg of [120, 180]) {
				const rev = 12 * N + 37
				const r = run(
					t,
					directTone({
						hz,
						samples: rev + 1_600,
						reversalAt: rev,
						reversalDeg: deg,
						noise: 0.0015,
						seed: 3,
					}),
					hz,
				)
				expect(r.hit).toBeGreaterThanOrEqual(rev)
				expect(r.onset - rev).toBeGreaterThanOrEqual(ONSET_MIN)
				expect(r.onset - rev).toBeLessThanOrEqual(ONSET_MAX)
				expect(r.hit + 1 - rev).toBeGreaterThanOrEqual(LATENCY_MIN)
				expect(r.hit + 1 - rev).toBeLessThanOrEqual(LATENCY_MAX)
				expect(t.armed).toBe(false)
			}
	})

	it("every alignment 0-319 inside a block (127.3 Hz, 120° and 180°, ±0.5 Hz): detected, onset and latency in bounds", () => {
		const t = new ReverseBurstTracker()
		for (const deg of [120, 180])
			for (const err of [-0.5, 0.5])
				for (let o = 0; o < N; o++) {
					const rev = 12 * N + o
					const r = run(
						t,
						directTone({
							hz: 127.3,
							samples: rev + 1_600,
							reversalAt: rev,
							reversalDeg: deg,
							errorHz: err,
							phase: (o * 0.37) % 6.28,
							noise: 0.0015,
							seed: o + 1,
						}),
						127.3,
					)
					expect([o, r.hit >= rev]).toEqual([o, true])
					expect(r.onset - rev).toBeGreaterThanOrEqual(ONSET_MIN)
					expect(r.onset - rev).toBeLessThanOrEqual(ONSET_MAX)
					expect(r.hit + 1 - rev).toBeGreaterThanOrEqual(LATENCY_MIN)
					expect(r.hit + 1 - rev).toBeLessThanOrEqual(LATENCY_MAX)
				}
	})

	it("the mixed-block case (127.3 Hz, 120°, sample 10 × 320 + 80) is placed before the reversal, not a block early", () => {
		const t = new ReverseBurstTracker()
		const rev = 10 * N + 80
		const r = run(
			t,
			directTone({
				hz: 127.3,
				samples: rev + 1_600,
				reversalAt: rev,
				reversalDeg: 120,
			}),
			127.3,
		)
		expect(r.hit + 1 - rev).toBe(560)
		expect(r.onset - rev).toBeGreaterThanOrEqual(ONSET_MIN)
		expect(r.onset - rev).toBeLessThanOrEqual(ONSET_MAX)
		// Not the start of the block before the mixed one (the review's 50 ms early onset).
		expect(r.onset).toBeGreaterThan(9 * N + 160)
	})

	it("steps of 60° and 80° are not detected", () => {
		const t = new ReverseBurstTracker()
		for (const deg of [60, 80])
			for (const hz of [67, 127.3, 254.1])
				expect(
					run(
						t,
						directTone({
							hz,
							samples: 30 * N,
							reversalAt: 12 * N + 100,
							reversalDeg: deg,
							noise: 0.0015,
							seed: 5,
						}),
						hz,
					).hit,
				).toBe(-1)
	})

	it("no detection on fades to -20 dB, a carrier drop to noise or 10 Hz phase flutter", () => {
		const t = new ReverseBurstTracker()
		const samples = 6 * 8_000
		for (let seed = 1; seed <= 10; seed++)
			for (const hz of [67, 127.3, 254.1]) {
				const rand = seeded(seed)
				const dip = 0.5 + rand()
				// Slow fades to -20 dB.
				expect(
					hits(
						t,
						directTone({
							hz,
							samples,
							noise: 0.0015,
							seed,
							envelope: n =>
								10 **
								-(
									Math.max(0, Math.sin((Math.PI * n * 3 * dip) / samples)) ** 8
								),
						}),
						hz,
					),
				).toBe(0)
				// Carrier drop: tone then noise only (the tone is gone, its phase meaningless).
				expect(
					hits(
						t,
						directTone({
							hz,
							samples,
							noise: 0.02,
							seed,
							envelope: n => (n < samples / 2 ? 1 : 0),
						}),
						hz,
					),
				).toBe(0)
				// 10 Hz phase flutter, 15° RMS (a sum of three 6-12 Hz sinusoids).
				const f = [6 + 6 * rand(), 6 + 6 * rand(), 6 + 6 * rand()]
				const p = [6.28 * rand(), 6.28 * rand(), 6.28 * rand()]
				const flutter = (n: number): number =>
					(((15 * Math.PI) / 180) *
						Math.SQRT2 *
						(Math.sin((2 * Math.PI * (f[0] ?? 0) * n) / 8_000 + (p[0] ?? 0)) +
							Math.sin((2 * Math.PI * (f[1] ?? 0) * n) / 8_000 + (p[1] ?? 0)) +
							Math.sin(
								(2 * Math.PI * (f[2] ?? 0) * n) / 8_000 + (p[2] ?? 0),
							))) /
					Math.sqrt(3)
				expect(
					hits(
						t,
						directTone({ hz, samples, noise: 0.0015, seed, phaseAt: flutter }),
						hz,
					),
				).toBe(0)
			}
	})

	it("arming: no evaluation before 8 blocks (a step at block 3 is not detected); disarm stops all work; restart empties the history", () => {
		const t = new ReverseBurstTracker()
		expect(REVERSE_BURST_RING_BLOCKS).toBe(8)
		const early = directTone({
			hz: 100,
			samples: 30 * N,
			reversalAt: 3 * N + 10,
			noise: 0.0015,
			seed: 2,
		})
		expect(run(t, early, 100).hit).toBe(-1)
		t.disarm()
		expect(t.armed).toBe(false)
		expect(t.push(1, 0)).toBe(false)
		// A step 2 blocks after a restart (a reopen) is inside the new warm-up: not detected.
		const x = directTone({
			hz: 100,
			samples: 40 * N,
			reversalAt: 22 * N,
			noise: 0.0015,
			seed: 4,
		})
		t.arm(100)
		let hit = -1
		for (let n = 0; n < x.length; n++) {
			if (n === 20 * N) t.restart()
			if (t.push(x[n] ?? 0, n)) {
				hit = n
				break
			}
		}
		expect(hit).toBe(-1)
		expect(t.armed).toBe(true)
		expect(t.toneHz).toBe(100)
	})

	// Feature: evidence-squelch, Property 22: no reverse burst without a step
	// Validates: Requirements A20.3, A20.6
	it("Property 22: bounded fades and phase moves without a step never fire", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: CTCSS_HZ.length - 1 }),
				fc.double({ min: -0.5, max: 0.5, noNaN: true }),
				fc.double({ min: 0, max: 6.28, noNaN: true }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(index, errorHz, phase, seed) => {
					const hz = CTCSS_HZ[index] ?? 67
					const rand = seeded(seed)
					const blocks = 100
					// Per block: amplitude in [0.2, 1], at most x2 per block; phase slope at most 20° per
					// block; both linear inside the block (continuous).
					const amp = new Float64Array(blocks + 1)
					const ph = new Float64Array(blocks + 1)
					amp[0] = 0.2 + 0.8 * rand()
					for (let b = 1; b <= blocks; b++) {
						const prev = amp[b - 1] ?? 1
						const next = prev * 2 ** (2 * rand() - 1)
						amp[b] = Math.min(1, Math.max(0.2, next))
						ph[b] = (ph[b - 1] ?? 0) + ((20 * Math.PI) / 180) * (2 * rand() - 1)
					}
					const lerp = (a: Float64Array, n: number): number => {
						const b = Math.floor(n / N)
						const f = (n % N) / N
						return (a[b] ?? 0) * (1 - f) + (a[b + 1] ?? 0) * f
					}
					const x = directTone({
						hz,
						samples: blocks * N,
						errorHz,
						phase,
						// Noise RMS 0.1 of the smallest amplitude (0.2 x 0.15).
						noise: 0.003,
						seed,
						envelope: n => lerp(amp, n),
						phaseAt: n => lerp(ph, n),
					})
					expect(hits(new ReverseBurstTracker(), x, hz)).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
