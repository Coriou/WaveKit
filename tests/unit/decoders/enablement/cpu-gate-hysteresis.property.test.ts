import { expect, it } from "vitest"
import fc from "fast-check"
import {
	CPU_RELEASE_SAMPLES,
	cpuReleasePercent,
	EFFICIENCY_CLEAR_MS,
	OWN_OVER_SUSTAIN_SAMPLES,
} from "../../../../src/decoders/enablement/contract.js"
import { OWN_CPU_MAX_GAP_MS } from "../../../../src/decoders/enablement/own-cpu.js"
import { CAPACITY, gateHarness } from "./rx-starvation-harness.js"

const G = 90
/** Own cores (of CAPACITY) around the guard and the release threshold, or unknown. */
const ownArb = fc.oneof(
	fc.constantFrom(3.8, 3.6, 3.6 + 1e-9, 3.2, 3.2 - 1e-9, 0.8),
	fc.double({ min: 0, max: 4, noNaN: true }),
	fc.constant(null),
)
/** Time since the previous sample: mostly the 2000 ms cadence, sometimes a gap. */
const gapArb = fc.constantFrom(2_000, 2_000, 2_000, 2_000, 4_000, 4_001, 6_000)
const sampleArb = fc.record({ own: ownArb, gap: gapArb })
type Sample = { own: number | null; gap: number }
/** Calm stretches long enough to reach a release, mixed with random samples. */
const calmArb = fc.record({
	own: fc.double({ min: 0, max: 3.2, noNaN: true, maxExcluded: true }),
	gap: fc.constantFrom(2_000, 2_000, 2_000, 4_000),
})
const sequenceArb = fc
	.array(
		fc.oneof(
			fc.array(sampleArb, { minLength: 1, maxLength: 12 }),
			fc.array(calmArb, { minLength: 20, maxLength: 40 }),
		),
		{ minLength: 1, maxLength: 5 },
	)
	.map(parts => parts.flat())

const percentOf = (own: number | null) =>
	own === null ? null : (own / CAPACITY) * 100

/** Reference: the consecutive-run length ending at each sample, for `test`. */
function runs(samples: readonly Sample[], test: (p: number | null) => boolean) {
	const out: number[] = []
	let run = 0
	samples.forEach((s, i) => {
		const kept = i > 0 && s.gap <= OWN_CPU_MAX_GAP_MS
		run = test(percentOf(s.own)) ? (kept ? run + 1 : 1) : 0
		out.push(run)
	})
	return out
}

// Feature: rx-starvation, Property 9: no cpu verdict or refusal without sustained own-over
// Validates: CPU gate hysteresis (sustain, OWN_OVER_SUSTAIN_MS)
it("a cpu verdict or refusal needs OWN_OVER_SUSTAIN_SAMPLES consecutive own-over samples", () => {
	fc.assert(
		fc.property(sequenceArb, samples => {
			const h = gateHarness()
			const over = runs(samples, p => p !== null && p > G)
			let n = 0
			let admittedAt = 0
			let admittedRunAt = -1
			const tryAdmit = (i: number) => {
				const d = h.start(`p${n++}`)
				if (d.admit) {
					admittedAt = h.mono
					admittedRunAt = i
				} else if (d.detail === "cpu")
					// A cpu refusal: the latest sample ends a sustained run.
					expect(over[i]).toBeGreaterThanOrEqual(OWN_OVER_SUSTAIN_SAMPLES)
			}
			tryAdmit(-1)
			samples.forEach((s, i) => {
				h.advance(s.gap - 2_000)
				const verdicts = h.step(10, s.own)
				for (const v of verdicts)
					if (v.detail === "cpu") {
						// Some sample since admission ended a sustained run.
						let sustained = false
						for (let j = Math.max(0, admittedRunAt); j <= i; j++)
							if (over[j]! >= OWN_OVER_SUSTAIN_SAMPLES) sustained = true
						expect(sustained).toBe(true)
						expect(h.mono).toBeGreaterThanOrEqual(admittedAt)
					}
				if (h.running.length === 0) tryAdmit(i)
			})
		}),
		{ numRuns: 200 },
	)
})

// Feature: rx-starvation, Property 10: a cpu suspension is never readmitted within one clear period
// Validates: CPU gate hysteresis (release threshold, no suspend/readmit/suspend flapping)
it("a placement suspended for cpu is readmitted exactly when CPU_RELEASE_SAMPLES samples under the release threshold follow it, never within one clear window", () => {
	let readmissions = 0
	fc.assert(
		fc.property(sequenceArb, fc.boolean(), (samples, tuned) => {
			const h = gateHarness()
			expect(h.start("p", { tuned }).admit).toBe(true)
			h.running.splice(0)
			const suspendedAt = h.mono
			h.gate.noteSuspended("p", "cpu", h.mono, tuned)
			const release = cpuReleasePercent(G)
			const calm = runs(samples, p => p !== null && p < release)
			const admit = () =>
				h.gate.admit(h.wanted("p", { tuned }), h.running, h.mono)
			// Same pass: never readmitted.
			expect(admit().admit).toBe(false)
			for (const [i, s] of samples.entries()) {
				h.advance(s.gap - 2_000)
				h.step(10, s.own)
				const d = admit()
				// Untuned: the 300 000 ms loss backoff may hold it longer.
				const released = calm[i]! >= CPU_RELEASE_SAMPLES
				if (d.admit) {
					expect(released).toBe(true)
					expect(h.mono - suspendedAt).toBeGreaterThanOrEqual(
						EFFICIENCY_CLEAR_MS,
					)
					readmissions++
					return
				}
				// Tuned: its 30 000 ms backoff is shorter than the release window.
				if (tuned) expect(released).toBe(false)
				expect(d.detail).toBe("cpu")
			}
		}),
		{ numRuns: 200 },
	)
	// The generator reaches the release, not only the hold.
	expect(readmissions).toBeGreaterThan(0)
})
