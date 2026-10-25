import fc from "fast-check"
import { expect, it } from "vitest"
import type {
	PlannerDecoder,
	PlannerSource,
} from "../../../../src/decoders/enablement/contract.js"
import {
	fitsReach,
	planPlacements,
} from "../../../../src/decoders/enablement/placement.js"

const sources = fc
	.array(
		fc.record({
			centreHz: fc.integer({ min: 100_000_000, max: 1_200_000_000 }),
			sampleRateHz: fc.constantFrom(1_024_000, 2_048_000, 2_400_000),
			dedicatedScanner: fc.boolean(),
			held: fc.boolean(),
			reservedBy: fc.constantFrom(null, "other", "test"),
			channelizerAvailable: fc.boolean(),
		}),
		{ minLength: 1, maxLength: 4 },
	)
	.map(values =>
		values.map(
			(s, order): PlannerSource => ({
				...s,
				id: String(order),
				order,
				usableFraction: 0.8,
			}),
		),
	)
const decoders = fc
	.record({
		type: fc.constantFrom(
			"acarsdec",
			"dsd-fme",
			"rtl433",
			"readsb",
			"lora-meshtastic",
		),
		mode: fc.constantFrom("auto" as const, "always" as const, "off" as const),
		configuredSourceId: fc.constantFrom(null, "0", "1"),
		configuredChannelsHz: fc.array(
			fc.integer({ min: 100_000_000, max: 1_200_000_000 }),
			{ maxLength: 7 },
		),
	})
	.map(
		(d): PlannerDecoder => ({
			...d,
			id: "test",
			origin: "catalogue",
			order: 0,
			startMode: "auto",
			band: {
				basis: "configured",
				rangesHz: [{ minHz: 100_000_000, maxHz: 1_200_000_000 }],
			},
			reach:
				d.type === "readsb"
					? "raw"
					: d.type === "lora-meshtastic"
						? "centre"
						: "channel",
			channelBandwidthHz: 24_000,
			channelTransitionHz: 10_000,
			protocols: [],
			channelPlacements: true,
			unavailable: false,
			ownDevice: false,
			centreSlotHz: { minHz: 869_400_000, maxHz: 869_650_000 },
			centrePassbandHz: 500_000,
		}),
	)

// Feature: decoder-enablement, Property 4: Reach is honest
// Validates: Requirements 3.2, 3.3
it("every planned placement satisfies reach; fitting configured channels are retained", () => {
	fc.assert(
		fc.property(sources, decoders, (ss, d) => {
			const plan = planPlacements({
				decoders: [d],
				sources: ss,
				vfo: null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			})
			for (const p of plan.wanted) {
				const s = ss.find(s => s.id === p.sourceId)!
				// Judged at the reach the placement uses (rtl_433 window reach is raw).
				expect(fitsReach({ ...d, reach: p.reach }, s, p.channelHz)).toBe(true)
			}
			if (d.mode !== "off" && d.type === "acarsdec") {
				for (const hz of d.configuredChannelsHz) {
					const eligible = ss.some(
						s =>
							(d.configuredSourceId !== null
								? s.id === d.configuredSourceId
								: !s.dedicatedScanner &&
									(s.reservedBy === null || s.reservedBy === d.id)) &&
							s.channelizerAvailable &&
							fitsReach(d, s, hz),
					)
					if (eligible)
						expect(plan.wanted.some(p => p.channelHz === hz)).toBe(true)
				}
			}
		}),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 11: One instance per channel
// Validates: Requirements 8.1, 8.2, 8.3
it("each channel has one eligible source and prefers an unheld source", () => {
	fc.assert(
		fc.property(sources, decoders, (ss, d) => {
			const plan = planPlacements({
				decoders: [d],
				sources: ss,
				vfo: null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			})
			expect(new Set(plan.wanted.map(p => p.channelHz)).size).toBe(
				plan.wanted.length,
			)
			for (const p of plan.wanted) {
				const s = ss.find(s => s.id === p.sourceId)!
				if (d.configuredSourceId !== null)
					expect(s.id).toBe(d.configuredSourceId)
				else {
					expect(s.dedicatedScanner).toBe(false)
					expect([null, d.id]).toContain(s.reservedBy)
					if (d.type === "acarsdec" && s.held) {
						expect(
							ss.some(
								other =>
									!other.held &&
									!other.dedicatedScanner &&
									(other.reservedBy === null || other.reservedBy === d.id) &&
									other.channelizerAvailable &&
									fitsReach(d, other, p.channelHz),
							),
						).toBe(false)
					}
				}
			}
		}),
		{ numRuns: 200 },
	)
})

// Feature: decoder-enablement, Property 3: Always skips only the band
// Validates: Requirements 2.1, 3.9
it("always never receives an out-of-band suspension", () => {
	fc.assert(
		fc.property(sources, decoders, (ss, d) => {
			const plan = planPlacements({
				decoders: [{ ...d, mode: "always" }],
				sources: ss,
				vfo: null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
			})
			expect(plan.unplaced.get(d.id)).not.toBe("frequency-out-of-band")
		}),
		{ numRuns: 200 },
	)
})
