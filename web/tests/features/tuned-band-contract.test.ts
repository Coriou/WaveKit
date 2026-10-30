import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import {
	BAND_REACH_HZ,
	bandHoldsHz,
	onBand,
} from "../../src/features/tuned/band-decoders.ts"

/**
 * The core's bandContainsTuned (src/decoders/enablement/tuned-band.ts), loaded at run time the way
 * web/tests/mock/decoder-summary.test.ts loads the core verdict: the web does not compile core sources.
 */
type CoreBand = {
	targetsHz?: number[]
	rangesHz?: Range[]
	basis: string
}
type CoreTuned = (band: CoreBand | undefined, tunedHz: number | null) => boolean
const CORE_TUNED_BAND = new URL(
	"../../../src/decoders/enablement/tuned-band.ts",
	import.meta.url,
).href
const coreModule = async () =>
	(await import(/* @vite-ignore */ CORE_TUNED_BAND)) as {
		bandContainsTuned: CoreTuned
		TUNED_TARGET_TOLERANCE_HZ: number
	}

const decoder = (over: Partial<DecoderInfo>): DecoderInfo => ({
	id: "d",
	type: "d",
	running: true,
	health: "running",
	uptime: 10,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	suspended: false,
	...over,
})

const MHZ = 1_000_000

type Range = { minHz: number; maxHz: number }

describe("the tuned band, web and core", () => {
	it("share the reach", async () => {
		expect(BAND_REACH_HZ).toBe((await coreModule()).TUNED_TARGET_TOLERANCE_HZ)
	})

	it("hold the span between a decoder's lowest and highest target", async () => {
		const { bandContainsTuned } = await coreModule()
		const targetsHz = [130 * MHZ, 132 * MHZ]
		expect(
			bandContainsTuned({ targetsHz, basis: "catalogue" }, 131 * MHZ),
		).toBe(true)
		const d = decoder({ targetFrequenciesHz: targetsHz })
		expect(onBand(d, 131 * MHZ)).toBe(true)
		expect(onBand(d, 132.3 * MHZ)).toBe(false)
	})

	// Feature: decoder-autostart, Property 6: web and core agree on the tuned band
	// Validates: Requirements R5
	it("agree for any targets, ranges and tuned frequency", async () => {
		const { bandContainsTuned } = await coreModule()
		// Frequencies near a 100 MHz anchor so tuned values land inside, at and beyond every edge; a few
		// malformed values (zero, negative, non-finite, inverted ranges) that both must refuse.
		const freq = fc.oneof(
			{ weight: 8, arbitrary: fc.integer({ min: 98 * MHZ, max: 102 * MHZ }) },
			{ weight: 1, arbitrary: fc.constantFrom(0, -MHZ, Number.NaN, Infinity) },
		)
		const range = fc.record({ minHz: freq, maxHz: freq })
		const targets = fc.option(fc.array(freq, { maxLength: 4 }), {
			nil: undefined,
		})
		const ranges = fc.option(fc.array(range, { maxLength: 3 }), {
			nil: undefined,
		})
		// Tuned values exactly at a reach edge of a target or range bound, or anywhere near the anchor.
		const tuned = (ts: number[] | undefined, rs: Range[] | undefined) => {
			const edges = [
				...(ts ?? []),
				...(rs ?? []).flatMap(r => [r.minHz, r.maxHz]),
			]
				.filter(Number.isFinite)
				.flatMap(e => [
					e - BAND_REACH_HZ,
					e + BAND_REACH_HZ,
					e - BAND_REACH_HZ - 1,
					e + BAND_REACH_HZ + 1,
				])
			return edges.length > 0 ? fc.oneof(freq, fc.constantFrom(...edges)) : freq
		}
		fc.assert(
			fc.property(
				targets.chain(ts =>
					ranges.chain(rs => tuned(ts, rs).map(hz => ({ ts, rs, hz }))),
				),
				({ ts, rs, hz }) => {
					const core = bandContainsTuned(
						{
							...(ts ? { targetsHz: ts } : {}),
							...(rs ? { rangesHz: rs } : {}),
							basis: "catalogue",
						},
						hz,
					)
					expect(bandHoldsHz(ts, rs, hz)).toBe(core)
					const d = decoder({
						...(ts ? { targetFrequenciesHz: ts } : {}),
						...(rs
							? {
									bandAssessment: {
										verdict: "in-band",
										rangesHz: rs,
										...(ts ? { targetsHz: ts } : {}),
									},
								}
							: {}),
					})
					expect(onBand(d, hz)).toBe(core)
				},
			),
			{ numRuns: 500 },
		)
	})
})
