/**
 * A20.6 and A20.7, enforceable: a seeded FM-link corpus (design A20, corpus) with ceilings. The
 * corpus is the first 4 seeds of the design study (1000-1003 for false alarms, 5120-5123 and
 * 5180-5183 for reversals), 12 conditions, 6 s per false-alarm run. Every detection counts: the
 * tracker is re-armed after each one, as on a resumed latch. Deterministic; no wall clock.
 */
import { describe, expect, it } from "vitest"
import { ReverseBurstTracker } from "../../../../src/core/evidence-squelch/reverse-burst.js"
import { fmLink } from "./reverse-burst-signals.js"
import type { FmLinkOptions } from "./reverse-burst-signals.js"

type Condition = Omit<FmLinkOptions, "hz" | "seconds" | "seed">

/** [name, options, false-alarm ceiling over the corpus, reversals required (all)?] */
const CONDITIONS: [string, Condition, number, boolean][] = [
	["clean, CNR 30 dB", { cnrDb: 30 }, 0, true],
	["+0.5 Hz", { cnrDb: 30, errorHz: 0.5 }, 0, true],
	["-0.5 Hz", { cnrDb: 30, errorHz: -0.5 }, 0, true],
	["Rayleigh 10 Hz, CNR 20 dB", { cnrDb: 20, fade: "rayleigh" }, 0, true],
	["Rayleigh 10 Hz, CNR 12 dB", { cnrDb: 12, fade: "rayleigh" }, 0, false],
	["slow fades to -20 dB", { cnrDb: 25, fade: "slow" }, 0, true],
	[
		"flutter 15° + 30 %",
		{ cnrDb: 25, flutterDeg: 15, flutterAm: 0.3 },
		0,
		false,
	],
	["weak carrier, CNR 8 dB", { cnrDb: 8 }, 0, true],
	["weak tone -30 dB", { cnrDb: 20, toneDeviation: 0.0316 }, 0, true],
	["voice 0.4", { cnrDb: 30, voice: 0.4 }, 0, false],
	[
		"voice + Rayleigh, CNR 15 dB, +0.5 Hz",
		{ cnrDb: 15, fade: "rayleigh", voice: 0.4, errorHz: 0.5 },
		0,
		false,
	],
	// Known limit (A20.6): 3 detections in the 600 s study.
	[
		"weak tone -30 dB + voice 0.4",
		{ cnrDb: 25, toneDeviation: 0.0316, voice: 0.4 },
		1,
		false,
	],
]
const TONES = [67, 127.3, 254.1]
const SEEDS = 4
/** Study bounds for the required conditions, 8 kHz samples (design A20). */
const ONSET_MIN = -121
const LATENCY_MAX = 892

function reversalSeconds(seed: number): number {
	return 2 + ((seed * 2_654_435_761) % 3_400) / 1_000
}

describe("A20: seeded false-alarm and detection corpus", () => {
	for (const [name, condition, ceiling, required] of CONDITIONS)
		it(`${name}: at most ${ceiling} detections in ${SEEDS * 6} s${required ? "; every reversal detected in bounds" : ""}`, () => {
			const t = new ReverseBurstTracker()
			let detections = 0
			for (let s = 0; s < SEEDS; s++) {
				const hz = TONES[s % 3] ?? 67
				const x = fmLink({ hz, seconds: 6, seed: 1_000 + s, ...condition })
				t.arm(hz)
				for (let n = 0; n < x.length; n++)
					if (t.push(x[n] ?? 0, n)) {
						detections += 1
						t.arm(hz)
					}
				if (!required) continue
				for (const deg of [120, 180]) {
					const seed = 5_000 + s + deg
					const r = reversalSeconds(seed)
					const y = fmLink({
						hz,
						seconds: r + 0.18,
						seed,
						reversalS: r,
						reversalDeg: deg,
						...condition,
					})
					const rev = Math.round(r * 8_000)
					t.arm(hz)
					let hit = -1
					for (let n = 0; n < y.length; n++)
						if (t.push(y[n] ?? 0, n)) {
							hit = n
							break
						}
					expect([s, deg, hit >= rev]).toEqual([s, deg, true])
					expect(t.onsetIndex - rev).toBeGreaterThanOrEqual(ONSET_MIN)
					expect(t.onsetIndex - rev).toBeLessThanOrEqual(0)
					expect(hit + 1 - rev).toBeLessThanOrEqual(LATENCY_MAX)
				}
			}
			expect(detections).toBeLessThanOrEqual(ceiling)
		}, 120_000)
})
