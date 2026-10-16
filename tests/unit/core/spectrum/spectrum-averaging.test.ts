import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import type { SpectrumProfileAdjustment } from "@wavekit/api-types"
import {
	admitProfile,
	applyAverage,
	averageSequence,
	averagingOf,
	makeProfile,
	nearestProfile,
	normaliseProfile,
	profileKey,
	type SpectrumProfile,
} from "../../../../src/core/spectrum/spectrum-averaging.js"

const def = makeProfile(10, 512, 1)

/**
 * Spec recurrence in a Float32Array, using the raw frame numbers. Seeding copies
 * through an element store (the same conversion the hold uses). Inputs are half-dB
 * steps, which are exactly representable, so signed-zero subnormals stay out.
 */
function reference(
	frames: readonly number[][],
	n: number,
	restart: readonly boolean[],
): number[] | null {
	let avg: Float32Array | null = null
	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i]!
		if (restart[i]) avg = null
		if (n <= 1 || avg === null || avg.length !== frame.length) {
			const seeded = new Float32Array(frame.length)
			for (let j = 0; j < frame.length; j++) seeded[j] = frame[j]!
			avg = seeded
			continue
		}
		for (let j = 0; j < frame.length; j++)
			avg[j] = avg[j]! + (frame[j]! - avg[j]!) / n
	}
	return avg ? [...avg] : null
}

describe("spectrum averaging", () => {
	it("keeps the off key and omits averaging from the profile", () => {
		expect(profileKey(10, 512)).toBe("10:512")
		expect(profileKey(10, 512, 1)).toBe("10:512")
		expect(profileKey(7.5, 300, 1)).toBe("7.5:300")
		expect(profileKey(10, 512, 4)).toBe("10:512:a4")
		expect(makeProfile(10, 512)).toEqual({ key: "10:512", hz: 10, bins: 512 })
		expect(makeProfile(10, 512, 4)).toEqual({
			key: "10:512:a4",
			hz: 10,
			bins: 512,
			averaging: 4,
		})
	})

	it("rounds and clamps averaging like bins", () => {
		expect(normaliseProfile({ averaging: 4 }, def)).toEqual({
			profile: { key: "10:512:a4", hz: 10, bins: 512, averaging: 4 },
			adjusted: [],
		})
		expect(normaliseProfile({ averaging: 1 }, def)).toEqual({
			profile: { key: "10:512", hz: 10, bins: 512 },
			adjusted: [],
		})
		expect(normaliseProfile({ averaging: 8.6 }, def).adjusted).toEqual([
			"averaging",
		])
		expect(normaliseProfile({ averaging: 8.6 }, def).profile.averaging).toBe(9)
		expect(
			normaliseProfile({ averaging: 0 }, def).profile.averaging,
		).toBeUndefined()
		expect(averagingOf(normaliseProfile({ averaging: 0 }, def).profile)).toBe(1)
		expect(normaliseProfile({ averaging: 100 }, def).profile.averaging).toBe(32)
		expect(normaliseProfile({}, def)).toEqual({
			profile: { key: "10:512", hz: 10, bins: 512 },
			adjusted: [],
		})
	})

	it("at the limit, a request without averaging never lands on an averaged profile", () => {
		const averaged = makeProfile(15, 1024, 4)
		const adjusted: SpectrumProfileAdjustment[] = []
		const got = admitProfile(
			makeProfile(20, 1024, 1),
			"rtl",
			def,
			[{ sourceId: "rtl", profile: averaged }],
			1,
			adjusted,
		)
		expect(averagingOf(got)).toBe(1)
		expect(got.key).toBe("10:512")
		expect(adjusted).toEqual(["profile-limit"])
	})

	it("shares an existing profile of the same averaging and counts it against the cap", () => {
		const averaged = makeProfile(15, 1024, 4)
		const adjusted: SpectrumProfileAdjustment[] = []
		const got = admitProfile(
			makeProfile(20, 512, 4),
			"rtl",
			def,
			[{ sourceId: "rtl", profile: averaged }],
			1,
			adjusted,
		)
		expect(got.key).toBe(averaged.key)
		expect(adjusted).toEqual(["profile-limit"])
	})

	it("falls back to averaging off and names averaging when none of the same depth exist", () => {
		const adjusted: SpectrumProfileAdjustment[] = []
		const got = nearestProfile(
			makeProfile(20, 1024, 8),
			[def, makeProfile(15, 512, 4)],
			adjusted,
		)
		expect(got.key).toBe(def.key)
		expect(adjusted).toEqual(["averaging"])
	})

	// Feature: web-gaps-1, Property 3: Averaging recurrence
	// Validates: Requirements 2.2, 2.3
	it("matches the recurrence, is the identity at n = 1, and restarts on layout or epoch", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 32 }),
				fc.array(
					fc.array(
						fc.integer({ min: -240, max: 0 }).map(v => v / 2),
						{ minLength: 1, maxLength: 6 },
					),
					{ minLength: 1, maxLength: 10 },
				),
				fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }),
				(n, frames, restart) => {
					const got = averageSequence(frames, n, restart)
					const want = reference(frames, n, restart)
					expect(got).not.toBeNull()
					expect([...(got ?? [])]).toEqual(want)
					const last = [...new Float32Array(frames.at(-1)!)]
					if (n === 1) expect([...(got ?? [])]).toEqual(last)
					const prev = frames.length > 1 ? frames.at(-2)! : null
					const restarted =
						restart[frames.length - 1] === true ||
						prev === null ||
						prev.length !== last.length
					if (restarted) expect([...(got ?? [])]).toEqual(last)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-1, Property 4: Averaging isolation
	// Validates: Requirements 2.4, 2.5, 2.6
	it("never serves an averaged profile to a client that omitted averaging, and stays within the cap", () => {
		const reqArb = fc.record({
			clientId: fc.integer({ min: 1, max: 4 }).map(n => `c${n}`),
			sourceId: fc.constantFrom("rtl", "air"),
			hz: fc.option(
				fc.double({ min: -5, max: 40, noNaN: true, noDefaultInfinity: true }),
				{ nil: undefined },
			),
			bins: fc.option(fc.integer({ min: -10, max: 3000 }), { nil: undefined }),
			averaging: fc.option(fc.integer({ min: -5, max: 40 }), {
				nil: undefined,
			}),
		})
		fc.assert(
			fc.property(
				fc.array(reqArb, { minLength: 0, maxLength: 10 }),
				fc.integer({ min: 1, max: 4 }),
				(requests, cap) => {
					const committed = new Map<
						string,
						{ sourceId: string; profile: SpectrumProfile }
					>()
					for (const req of requests) {
						const normalised = normaliseProfile(
							{
								...(req.hz !== undefined ? { hz: req.hz } : {}),
								...(req.bins !== undefined ? { bins: req.bins } : {}),
								...(req.averaging !== undefined
									? { averaging: req.averaging }
									: {}),
							},
							def,
						)
						const others = [...committed.entries()]
							.filter(([id]) => id !== req.clientId)
							.map(([, sel]) => sel)
						const profile = admitProfile(
							normalised.profile,
							req.sourceId,
							def,
							others,
							cap,
							normalised.adjusted,
						)
						committed.set(req.clientId, { sourceId: req.sourceId, profile })
						if (req.averaging === undefined)
							expect(averagingOf(profile)).toBe(1)
						const pairs = new Set(
							[...committed.values()]
								.filter(s => s.profile.key !== def.key)
								.map(s => `${s.sourceId}:${s.profile.key}`),
						)
						expect(pairs.size).toBeLessThanOrEqual(cap)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("seeds the average with the first frame", () => {
		const first = applyAverage(null, [-40, -80], 4)
		expect([...first]).toEqual([-40, -80])
		const second = applyAverage(first, [-80, -40], 4)
		expect([...second]).toEqual([-50, -70])
	})
})
