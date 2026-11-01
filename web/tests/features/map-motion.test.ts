// The Map's aircraft motion smoothing (motion.ts) on synthetic fix sequences: noisy straight flight, a turn, a
// teleport outlier, a confirmed relocation, a stale track and the 359° → 0° wrap. Every aircraft here is fictional.
import fc from "fast-check"
import { describe, expect, it } from "vitest"

import {
	advance,
	BLEND_MS,
	createMotion,
	EXTRAPOLATE_FULL_MS,
	EXTRAPOLATE_STOP_MS,
	HEADING_TAU_MS,
	MAX_PLAUSIBLE_KN,
	MAX_TURN_DEG_PER_S,
	reach,
	REACQUIRE_MS,
	SETTLE_KM,
	settling,
	shortestArc,
	SLACK_KM,
	type Fix,
	type MotionState,
} from "../../src/features/map/motion.ts"

const KM_PER_DEG = 111.195
const KM_PER_MS_PER_KN = 1.852 / 3_600_000
const T0 = 1_800_000_000_000
const START = { lat: 48.7, lon: 2.3 }
const FRAME_MS = 16

/** A point `n` km north and `e` km east of START (flat, as motion.ts over these distances). */
function at(n: number, e: number): { lat: number; lon: number } {
	return {
		lat: START.lat + n / KM_PER_DEG,
		lon: START.lon + e / (KM_PER_DEG * Math.cos((START.lat * Math.PI) / 180)),
	}
}

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
	const n = (b.lat - a.lat) * KM_PER_DEG
	const e =
		(b.lon - a.lon) *
		KM_PER_DEG *
		Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
	return Math.hypot(n, e)
}

function fix(
	n: number,
	e: number,
	posAt: number,
	course: number | null = 90,
	speedKn: number | null = 450,
): Fix {
	return {
		...at(n, e),
		posAt,
		course,
		speedKn,
		moving: course !== null && speedKn !== null && speedKn > 0,
	}
}

/**
 * Runs frames every FRAME_MS from `from` to `to`, handing advance() the latest fix whose time has come. Returns the
 * largest displacement between consecutive frames (km) and calls `each` after every frame.
 */
function run(
	s: MotionState,
	fixes: readonly Fix[],
	from: number,
	to: number,
	each?: (s: MotionState, now: number) => void,
): number {
	let k = 0
	let latest: Fix | undefined
	let prev = { lat: s.lat, lon: s.lon }
	let maxStep = 0
	for (let now = from; now <= to; now += FRAME_MS) {
		while (k < fixes.length && (fixes[k] as Fix).posAt <= now)
			latest = fixes[k++]
		if (latest) advance(s, latest, now)
		const step = km(prev, s)
		if (step > maxStep) maxStep = step
		prev = { lat: s.lat, lon: s.lon }
		each?.(s, now)
	}
	return maxStep
}

/** 450 kn east, a fix every 500 ms (ADS-B airborne position rate), km east at time t. */
const V = 450 * KM_PER_MS_PER_KN
const eastAt = (t: number) => V * (t - T0)

describe("aircraft motion smoothing", () => {
	it("follows a clean straight track exactly, with steps of the plane's own speed", () => {
		const fixes = Array.from({ length: 60 }, (_, i) =>
			fix(0, eastAt(T0 + i * 500), T0 + i * 500),
		)
		const s = createMotion(fixes[0] as Fix, T0)
		let worst = 0
		const maxStep = run(s, fixes, T0, T0 + 29_500, (m, now) => {
			worst = Math.max(worst, km(m, at(0, eastAt(now))))
		})
		expect(worst).toBeLessThan(0.001)
		expect(maxStep).toBeLessThan(V * FRAME_MS * 1.01)
	})

	it("smooths a noisy straight track: bounded steps, close to the truth, no jump at a fix", () => {
		// Feature: map-motion-smoothing, Property 1: noisy straight flight moves in bounded steps near the truth
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.double({ min: -0.1, max: 0.1, noNaN: true }),
						fc.double({ min: -0.1, max: 0.1, noNaN: true }),
					),
					{
						minLength: 40,
						maxLength: 40,
					},
				),
				noise => {
					const fixes = noise.map(([dn, de], i) =>
						fix(dn, eastAt(T0 + i * 500) + de, T0 + i * 500),
					)
					const s = createMotion(fixes[0] as Fix, T0)
					let worst = 0
					const maxStep = run(s, fixes, T0, T0 + 19_500, (m, now) => {
						worst = Math.max(worst, km(m, at(0, eastAt(now))))
					})
					// fixes stray up to 141 m; a naive snap would step that far in one frame (38× the plane's 3.7 m)
					expect(maxStep).toBeLessThan(V * FRAME_MS * 4)
					expect(worst).toBeLessThan(0.3)
					expect(s.rejected).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("blends a correction in within BLEND_MS without a jump, and is on the new track after it", () => {
		const s = createMotion(fix(0, 0, T0), T0)
		advance(s, fix(0, 0, T0), T0 + 1000)
		// a fix 1 km north of the track: plausible, so the drawn plane converges to it
		const f = fix(1, eastAt(T0 + 1000), T0 + 1000)
		const before = { lat: s.lat, lon: s.lon }
		advance(s, f, T0 + 1000)
		expect(km(before, s)).toBeLessThan(1e-9)
		const maxStep = run(s, [f], T0 + 1000 + FRAME_MS, T0 + 1000 + BLEND_MS)
		// critically damped: the fastest correction is ω·A/e = 3/s × 1 km / 2.718 = 1.1 km/s, 18 m a frame
		expect(maxStep).toBeLessThan(0.025)
		// just before the end at most (1 + 6)·e⁻⁶ = 1.7 % of the 1 km is left; at the end none
		advance(s, f, T0 + 1000 + BLEND_MS - 1)
		expect(km(s, at(1, eastAt(T0 + 1000 + BLEND_MS - 1)))).toBeLessThan(0.018)
		// it keeps decaying past BLEND_MS (no drop) until under SETTLE_KM: (1 + x)·e⁻ˣ < 10⁻³ at x = 9.23, 3.08 s
		advance(s, f, T0 + 1000 + BLEND_MS)
		expect(s.offAt).not.toBeNaN()
		advance(s, f, T0 + 1000 + 3000)
		expect(s.offAt).not.toBeNaN()
		advance(s, f, T0 + 1000 + 3100)
		expect(s.offAt).toBeNaN()
		// (the 0.1 m left is this test's flat-earth truth, scaled at START's latitude)
		expect(km(s, at(1, eastAt(T0 + 4100)))).toBeLessThan(SETTLE_KM + 0.0002)
		advance(s, f, T0 + 4600)
		expect(km(s, at(1, eastAt(T0 + 4600)))).toBeLessThan(SETTLE_KM + 0.0002)
	})

	it("ends a large correction without a jump: no drop at BLEND_MS, at most SETTLE_KM at the very end", () => {
		// a stationary plane, then an 8 km fix 10 s later (inside the 8.17 km gate). At BLEND_MS (1 + 6)·e⁻⁶ = 1.7 %
		// of it, 139 m, is left; dropping it there was a 139 m jump in 1 ms. Now it moves at its decay speed
		// A·ω²·t·e^(−ωt) = 8 km × (0.003/ms)² × 2000 ms × e⁻⁶ = 0.36 m/ms.
		const s = createMotion(fix(0, 0, T0, null, null), T0)
		const f = fix(8, 0, T0 + 10_000, null, null)
		advance(s, f, T0 + 10_000)
		expect(s.rejected).toBe(0)
		advance(s, f, T0 + 10_000 + BLEND_MS - 1)
		const before = { lat: s.lat, lon: s.lon }
		advance(s, f, T0 + 10_000 + BLEND_MS)
		expect(km(before, s)).toBeLessThan(0.0005)
		// every 16 ms frame to the end moves at most the peak ω·A/e = 8.8 m/ms; the last one drops under 1 m
		let prev = { lat: s.lat, lon: s.lon }
		let last = 0
		let t = T0 + 10_000 + BLEND_MS
		while (!Number.isNaN(s.offAt) && t < T0 + 30_000) {
			t += FRAME_MS
			advance(s, f, t)
			last = km(prev, s)
			expect(last).toBeLessThan(0.36 * FRAME_MS * 0.001)
			prev = { lat: s.lat, lon: s.lon }
		}
		// (1 + x)·e⁻ˣ < 1/8000 at x = 11.6: ends at 3.9 s
		expect(t - T0 - 10_000).toBeGreaterThan(3800)
		expect(t - T0 - 10_000).toBeLessThan(4000)
		expect(last).toBeLessThan(SETTLE_KM + 0.0005)
		expect(km(s, f)).toBeLessThan(1e-9)
	})

	it("keeps settling a stationary plane's correction (drawn speed 0 at its start), then stops", () => {
		// no speed or course: the 1 km correction starts at rest, so drawnKn is 0 and the engine, which scheduled
		// only on drawnKn > 0, left the plane at the old spot. settling() and pushKn keep it going.
		const s = createMotion(fix(0, 0, T0, null, null), T0)
		const f = fix(1, 0, T0 + 5000, null, null)
		advance(s, f, T0 + 5000)
		expect(s.drawnKn).toBe(0)
		expect(settling(s)).toBe(true)
		// |w| + |w + ω·c|/e = 0 + 0.003/ms × 1 km / e = 1.1 km/s = 2146 kn
		expect(s.pushKn).toBeCloseTo((0.003 * 1) / Math.E / KM_PER_MS_PER_KN, 3)
		let t = T0 + 5000
		while (settling(s) && t < T0 + 20_000) {
			t += 250
			advance(s, f, t)
		}
		// 1 km to under 1 m takes 3.08 s, the next 250 ms push after it ends the correction
		expect(t - T0 - 5000).toBe(3250)
		expect(km(s, f)).toBeLessThan(1e-9)
		expect(s.pushKn).toBe(0)
		// a held plane (stale past EXTRAPOLATE_STOP_MS, no correction, glyph turned) does not keep pushing
		const g = fix(0, 0, T0, 90)
		const h = createMotion(g, T0)
		advance(h, g, T0 + EXTRAPOLATE_STOP_MS + 1000)
		expect(settling(h)).toBe(false)
		expect(h.pushKn).toBe(0)
		// a glyph still turning toward a new track counts as settling until within SETTLE_DEG
		const k = createMotion(fix(0, 0, T0, 0, null), T0)
		advance(k, fix(0, 0, T0, 90, null), T0 + FRAME_MS)
		advance(k, fix(0, 0, T0, 90, null), T0 + 2 * FRAME_MS)
		expect(settling(k)).toBe(true)
		advance(k, fix(0, 0, T0, 90, null), T0 + 10_000)
		expect(settling(k)).toBe(false)
	})

	it("pushKn bounds how far the drawn plane moves until the next push (property)", () => {
		// Feature: map-motion-smoothing, Property 3: the push speed bounds the drawn motion while a correction runs
		fc.assert(
			fc.property(
				fc.double({ min: -5, max: 5, noNaN: true }),
				fc.double({ min: -5, max: 5, noNaN: true }),
				fc.option(fc.double({ min: 0, max: 359.9, noNaN: true })),
				fc.option(fc.double({ min: 0, max: 600, noNaN: true })),
				fc.integer({ min: 16, max: 2000 }),
				(dn, de, course, speed, every) => {
					const s = createMotion(fix(0, 0, T0, 90, 450), T0)
					advance(s, fix(0, 0, T0, 90, 450), T0 + 4000)
					const f = fix(dn, eastAt(T0 + 4000) + de, T0 + 4000, course, speed)
					for (let t = T0 + 4000; t < T0 + 12_000; t += every) {
						advance(s, f, t)
						const from = { lat: s.lat, lon: s.lon }
						const kn = s.pushKn
						// the straight-line distance over `every` is at most the bound speed times it
						advance(s, f, t + every)
						expect(km(from, s)).toBeLessThanOrEqual(
							kn * KM_PER_MS_PER_KN * every * 1.001 + 1e-6 + SETTLE_KM,
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("turns continuously: a standard-rate turn has bounded steps and the glyph keeps up", () => {
		// 3°/s turn at 450 kn: radius v / ω = 0.2315 km/s / 0.05236 rad/s = 4.42 km
		const w = (3 * Math.PI) / 180 / 1000
		const r = V / w
		const fixes = Array.from({ length: 120 }, (_, i) => {
			const t = i * 500
			const a = w * t
			// starts east-bound at (0, 0), turning right (south)
			return fix(
				r * (Math.cos(a) - 1),
				r * Math.sin(a),
				T0 + t,
				(90 + (a * 180) / Math.PI) % 360,
			)
		})
		const s = createMotion(fixes[0] as Fix, T0)
		let worstHeading = 0
		let worstPos = 0
		const maxStep = run(s, fixes, T0, T0 + 59_500, (m, now) => {
			const a = w * (now - T0)
			worstPos = Math.max(
				worstPos,
				km(m, at(r * (Math.cos(a) - 1), r * Math.sin(a))),
			)
			if (now > T0 + 2000)
				worstHeading = Math.max(
					worstHeading,
					Math.abs(shortestArc(m.rotate, 90 + (a * 180) / Math.PI)),
				)
		})
		expect(maxStep).toBeLessThan(V * FRAME_MS * 1.5)
		// dead reckoning along the tangent for a 500 ms gap is off by r(1 − cos(1.5°)) ≈ 1.5 m; blending adds lag
		expect(worstPos).toBeLessThan(0.1)
		expect(worstHeading).toBeLessThan(3)
	})

	it("holds back a teleport outlier and keeps flying the accepted track", () => {
		const fixes = Array.from({ length: 20 }, (_, i) =>
			i === 8
				? fix(300, 0, T0 + i * 500) // a wrong CPR zone, 300 km north
				: fix(0, eastAt(T0 + i * 500), T0 + i * 500),
		)
		const s = createMotion(fixes[0] as Fix, T0)
		let worst = 0
		const maxStep = run(s, fixes, T0, T0 + 9_500, (m, now) => {
			worst = Math.max(worst, km(m, at(0, eastAt(now))))
		})
		expect(s.rejected).toBe(1)
		expect(worst).toBeLessThan(0.001)
		expect(maxStep).toBeLessThan(V * FRAME_MS * 1.01)
	})

	it("accepts a relocation once a second fix confirms it, at once", () => {
		const fixes = [
			fix(0, 0, T0),
			fix(0, eastAt(T0 + 500), T0 + 500),
			fix(200, 0, T0 + 1000),
			fix(200, eastAt(T0 + 1500) - eastAt(T0 + 1000), T0 + 1500),
		]
		const s = createMotion(fixes[0] as Fix, T0)
		advance(s, fixes[1] as Fix, T0 + 500)
		advance(s, fixes[2] as Fix, T0 + 1000)
		expect(s.rejected).toBe(1)
		expect(km(s, at(0, eastAt(T0 + 1000)))).toBeLessThan(0.001)
		advance(s, fixes[3] as Fix, T0 + 1500)
		expect(km(s, fixes[3] as Fix)).toBeLessThan(0.001)
		// then flies on from there (east, scaled at the new latitude)
		const f3 = fixes[3] as Fix
		const c3 = KM_PER_DEG * Math.cos((f3.lat * Math.PI) / 180)
		run(s, fixes, T0 + 1516, T0 + 3000, (m, now) => {
			const there = { lat: f3.lat, lon: f3.lon + (V * (now - f3.posAt)) / c3 }
			expect(km(m, there)).toBeLessThan(0.001)
		})
	})

	it("gates on the plausible speed: at the bound accepted, past it held back", () => {
		// 10 s: 0.617 km/s × 10 s + 2 km slack = 8.17 km
		const bound = MAX_PLAUSIBLE_KN * KM_PER_MS_PER_KN * 10_000 + SLACK_KM
		const under = createMotion(fix(0, 0, T0, null, null), T0)
		advance(under, fix(bound - 0.001, 0, T0 + 10_000, null, null), T0 + 10_000)
		expect(under.rejected).toBe(0)
		// exactly at it (north from the equator, where n km is n / 111.195° and back again)
		const exact: Fix = {
			lat: 0,
			lon: 0,
			posAt: T0,
			course: null,
			speedKn: null,
			moving: false,
		}
		const atBound = createMotion(exact, T0)
		const onBound = { ...exact, lat: bound / KM_PER_DEG, posAt: T0 + 10_000 }
		expect(onBound.lat * KM_PER_DEG).toBe(bound)
		advance(atBound, onBound, T0 + 10_000)
		expect(atBound.rejected).toBe(0)
		expect(atBound.fixAt).toBe(T0 + 10_000)
		const past = createMotion(fix(0, 0, T0, null, null), T0)
		advance(past, fix(bound + 0.01, 0, T0 + 10_000, null, null), T0 + 10_000)
		expect(past.rejected).toBe(1)
	})

	it("takes any fix after REACQUIRE_MS without one accepted (no lock-out), not before", () => {
		const far = 500
		const s = createMotion(fix(0, 0, T0, null, null), T0)
		advance(
			s,
			fix(far, 0, T0 + REACQUIRE_MS - 1, null, null),
			T0 + REACQUIRE_MS - 1,
		)
		expect(s.rejected).toBe(1)
		const t = createMotion(fix(0, 0, T0, null, null), T0)
		advance(t, fix(far, 0, T0 + REACQUIRE_MS, null, null), T0 + REACQUIRE_MS)
		expect(t.rejected).toBe(0)
		expect(km(t, at(far, 0))).toBeLessThan(0.001)
	})

	it("caps the extrapolation: full speed to 10 s, easing to a stop at 20 s, then holding", () => {
		expect(reach(-5)).toBe(0)
		expect(reach(EXTRAPOLATE_FULL_MS)).toBe(EXTRAPOLATE_FULL_MS)
		expect(reach(EXTRAPOLATE_FULL_MS + 1)).toBeCloseTo(
			EXTRAPOLATE_FULL_MS + 1,
			3,
		)
		// 10 + (20 − 10) / 2 = 15 s of travel
		expect(reach(EXTRAPOLATE_STOP_MS)).toBe(15_000)
		expect(reach(EXTRAPOLATE_STOP_MS + 1)).toBe(15_000)
		const f = fix(0, 0, T0)
		const s = createMotion(f, T0)
		let prevStep = Number.POSITIVE_INFINITY
		let prev = { lat: s.lat, lon: s.lon }
		let grew = false
		for (let now = T0 + 1000; now <= T0 + 60_000; now += 1000) {
			advance(s, f, now)
			const step = km(prev, s)
			if (now > T0 + EXTRAPOLATE_FULL_MS && step > prevStep + 1e-9) grew = true
			prevStep = step
			prev = { lat: s.lat, lon: s.lon }
		}
		expect(grew).toBe(false)
		expect(km(s, f)).toBeCloseTo(V * 15_000, 6)
		expect(s.drawnKn).toBe(0)
		advance(s, f, T0 + 600_000)
		expect(km(s, f)).toBeCloseTo(V * 15_000, 6)
	})

	it("clamps a reported speed beyond MAX_PLAUSIBLE_KN", () => {
		const s = createMotion(fix(0, 0, T0, 0, MAX_PLAUSIBLE_KN), T0)
		advance(s, fix(0, 0, T0, 0, MAX_PLAUSIBLE_KN), T0 + 1000)
		expect(s.drawnKn).toBeCloseTo(MAX_PLAUSIBLE_KN, 6)
		const t = createMotion(fix(0, 0, T0, 0, 5000), T0)
		advance(t, fix(0, 0, T0, 0, 5000), T0 + 1000)
		expect(t.drawnKn).toBeCloseTo(MAX_PLAUSIBLE_KN, 6)
	})

	it("turns across 359° → 0° by the short way and never flips on one noisy track value", () => {
		const s = createMotion(fix(0, 0, T0, 358), T0)
		const seen: number[] = []
		let t = T0
		for (const c of [359, 0.5, 1, 2]) {
			for (let k = 0; k < 31; k++) {
				t += FRAME_MS
				advance(s, fix(0, 0, T0, c), t)
				seen.push(s.rotate)
			}
		}
		// always within 5° of north, never sweeping round through south
		expect(seen.every(r => Math.abs(shortestArc(r, 0)) < 5)).toBe(true)
		expect(Math.abs(shortestArc(s.rotate, 2))).toBeLessThan(1)
		// one 180° track value for 500 ms turns the glyph at most 60°/s × 0.5 s = 30°
		const before = s.rotate
		for (let k = 1; k <= 31; k++)
			advance(s, fix(0, 0, T0, 182), t + k * FRAME_MS)
		expect(Math.abs(shortestArc(before, s.rotate))).toBeLessThanOrEqual(
			MAX_TURN_DEG_PER_S * 0.5 + 1e-9,
		)
	})

	it("turns at MAX_TURN_DEG_PER_S at most, and by 1 − e^(−dt/τ) under it", () => {
		// a 1° change in 16 ms wants 1 × (1 − e^(−16/400)) = 0.039°, under the 0.96° cap
		const a = createMotion(fix(0, 0, T0, 0, 0), T0)
		advance(a, fix(0, 0, T0, 1, 0), T0 + FRAME_MS)
		expect(a.rotate).toBeCloseTo(1 - Math.exp(-FRAME_MS / HEADING_TAU_MS), 9)
		// a 90° change in 16 ms wants 3.5°, capped to 60°/s × 16 ms = 0.96°
		const b = createMotion(fix(0, 0, T0, 0, 0), T0)
		advance(b, fix(0, 0, T0, 90, 0), T0 + FRAME_MS)
		expect(b.rotate).toBeCloseTo((MAX_TURN_DEG_PER_S * FRAME_MS) / 1000, 9)
	})

	it("is idempotent for the same instant and fix (a second call in one frame changes nothing)", () => {
		// Feature: map-motion-smoothing, Property 2: advance() twice at one instant draws the same place
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 30_000 }),
				fc.double({ min: 0, max: 359.9, noNaN: true }),
				(dt, course) => {
					const s = createMotion(fix(0, 0, T0, course), T0)
					const f = fix(0.5, 0.5, T0 + 500, course)
					advance(s, f, T0 + 500 + dt)
					const once = { lat: s.lat, lon: s.lon, rotate: s.rotate }
					advance(s, f, T0 + 500 + dt)
					expect(s.lat).toBe(once.lat)
					expect(s.lon).toBe(once.lon)
					expect(s.rotate).toBe(once.rotate)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("ignores a fix not newer than the accepted one, so an old fix cannot rewind the gate's clock", () => {
		// accepted at T0 + 50 s; an older fix there (0 km, inside the slack) used to rewind fixAt to T0, so a 100 km
		// fix at T0 + 61 s passed the 60 s reacquire rule and teleported. From T0 + 50 s, 11 s allow only
		// 0.617 × 11 + 2 = 8.8 km: it is held back.
		const s = createMotion(fix(0, 0, T0 + 50_000, null, null), T0 + 50_000)
		advance(s, fix(0, 0, T0, null, null), T0 + 50_100)
		expect(s.fixAt).toBe(T0 + 50_000)
		advance(s, fix(100, 0, T0 + 61_000, null, null), T0 + 61_000)
		expect(s.rejected).toBe(1)
		expect(km(s, at(0, 0))).toBeLessThan(1e-9)
		// a different position timed with the accepted fix is ignored too
		advance(s, fix(0.5, 0, T0 + 50_000, null, null), T0 + 61_100)
		expect(s.fixAt).toBe(T0 + 50_000)
		expect(km(s, at(0, 0))).toBeLessThan(1e-9)
	})

	it("ignores a new course or speed for an ignored or held-back fix", () => {
		// accepted at T0 + 50 s, stationary; an older fix is ignored, then the same old fix with a new course and
		// speed must not turn or move the accepted track
		const s = createMotion(fix(0, 0, T0 + 50_000, null, null), T0 + 50_000)
		advance(s, fix(0, 0, T0 + 40_000, null, null), T0 + 50_100)
		advance(s, fix(0, 0, T0 + 40_000, 90, 450), T0 + 50_200)
		expect(s.vN).toBe(0)
		expect(s.vE).toBe(0)
		// same for a held-back far fix re-sent with a velocity
		advance(s, fix(200, 0, T0 + 51_000, null, null), T0 + 51_000)
		expect(s.rejected).toBe(1)
		advance(s, fix(200, 0, T0 + 51_000, 90, 450), T0 + 51_100)
		expect(s.vN).toBe(0)
		expect(s.vE).toBe(0)
		// a new velocity for the accepted fix still applies
		advance(s, fix(0, 0, T0 + 50_000, 90, 450), T0 + 51_200)
		expect(s.vE).toBeGreaterThan(0)
	})

	it("confirms a held-back fix only with a newer one", () => {
		const s = createMotion(fix(0, 0, T0, null, null), T0)
		advance(s, fix(200, 0, T0 + 1000, null, null), T0 + 1000)
		expect(s.rejected).toBe(1)
		// another far fix with the candidate's own time, 0.5 km from it (inside the 2 km slack): not a confirmation
		advance(s, fix(200.5, 0, T0 + 1000, null, null), T0 + 1100)
		expect(s.rejected).toBe(2)
		expect(km(s, at(0, 0))).toBeLessThan(1e-9)
		// a newer one agreeing with it is
		advance(s, fix(200.6, 0, T0 + 1500, null, null), T0 + 1500)
		expect(s.rejected).toBe(2)
		expect(km(s, at(200.6, 0))).toBeLessThan(1e-9)
	})

	it("retracks without moving the drawn point near the poles and across the antimeridian (property)", () => {
		// Feature: map-motion-smoothing, Property 4: a new track starts where the plane is drawn, at any latitude
		// and across ±180°. At 89°N, course 45°, 1200 kn and a fix 10 s old, scaling east by the drawn latitude
		// instead of the fix's moved the point 171 m east.
		const kmW = (
			a: { lat: number; lon: number },
			b: { lat: number; lon: number },
		) => {
			const d = ((((b.lon - a.lon + 180) % 360) + 360) % 360) - 180
			const e =
				d * KM_PER_DEG * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
			return Math.hypot((b.lat - a.lat) * KM_PER_DEG, e)
		}
		const pole: Fix = {
			lat: 89,
			lon: 10,
			posAt: T0,
			course: 45,
			speedKn: MAX_PLAUSIBLE_KN,
			moving: true,
		}
		const s = createMotion(pole, T0)
		advance(s, pole, T0 + 10_000)
		const before = { lat: s.lat, lon: s.lon }
		advance(s, { ...pole, course: 46 }, T0 + 10_000)
		expect(kmW(before, s)).toBeLessThan(1e-6)
		fc.assert(
			fc.property(
				fc.double({ min: -88, max: 88, noNaN: true }),
				fc.double({ min: 179, max: 181, noNaN: true }),
				fc.double({ min: 0, max: 359.9, noNaN: true }),
				fc.double({ min: 0, max: MAX_PLAUSIBLE_KN, noNaN: true }),
				fc.integer({ min: 0, max: 15_000 }),
				fc.double({ min: -0.5, max: 0.5, noNaN: true }),
				fc.double({ min: -0.5, max: 0.5, noNaN: true }),
				(lat, lon, course, speedKn, age, dN, dE) => {
					const f: Fix = {
						lat,
						lon: ((lon + 180) % 360) - 180,
						posAt: T0,
						course,
						speedKn,
						moving: true,
					}
					const m = createMotion(f, T0)
					advance(m, f, T0 + age)
					const was = { lat: m.lat, lon: m.lon }
					// the same fix with a new course, then a new fix up to 0.7 km away (inside the 2 km slack, another
					// latitude, maybe over ±180°) 1 ms later
					advance(m, { ...f, course: (course + 30) % 360 }, T0 + age)
					expect(kmW(was, m)).toBeLessThan(1e-6)
					const g: Fix = {
						...f,
						lat: lat + dN / KM_PER_DEG,
						lon:
							((lon +
								dE / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180)) +
								180) %
								360) -
							180,
						posAt: T0 + age + 1,
					}
					advance(m, g, T0 + age + 1)
					expect(m.rejected).toBe(0)
					expect(m.lon).toBeGreaterThanOrEqual(-180)
					expect(m.lon).toBeLessThan(180)
					// continuous: in 1 ms it moves at most its own speed (0.6 m/ms at 1200 kn) plus rounding
					expect(kmW(was, m)).toBeLessThan(0.001)
				},
			),
			{ numRuns: 200 },
		)
	})
})
