import type {
	PlannerDecoder,
	PlannerSource,
	PlannerInput,
} from "../../../../src/decoders/enablement/contract.js"
import { planPlacements } from "../../../../src/decoders/enablement/placement.js"
import { expect, it } from "vitest"
import fc from "fast-check"
import { createVfoTracker } from "../../../../src/decoders/enablement/channel-sources.js"

// Feature: decoder-enablement, Property 13: VFO follows
// Validates: Requirements 3.5, 5.5
it("settles the last VFO held for a full period", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					hz: fc.integer({ min: 1, max: 1000000000 }),
					wait: fc.integer({ min: 0, max: 2000 }),
				}),
				{ maxLength: 50 },
			),
			sequence => {
				let now = 0
				let job: { at: number; fn: () => void } | null = null
				let expected: number | null = null
				let pending: number | null = null
				let changedAt = 0
				const tracker = createVfoTracker({
					now: () => now,
					onSettled: () => {},
					setTimer(fn, ms) {
						const next = { at: now + ms, fn }
						job = next
						return {
							cancel() {
								if (job === next) job = null
							},
						}
					},
				})
				for (const { hz, wait } of sequence) {
					tracker.update({ sourceId: "s", frequencyHz: hz })
					if (pending !== hz) {
						pending = hz
						changedAt = now
					}
					now += wait
					const due = job as { at: number; fn: () => void } | null
					if (due && due.at <= now) {
						job = null
						due.fn()
					}
					if (now - changedAt >= 1000) expected = pending
					expect(tracker.current()?.frequencyHz ?? null).toBe(expected)
				}
				tracker.dispose()
			},
		),
		{ numRuns: 100 },
	)
})

const decoder = (overrides: Partial<PlannerDecoder> = {}): PlannerDecoder => ({
	id: "test",
	type: "acarsdec",
	origin: "catalogue",
	order: 0,
	mode: "auto",
	startMode: "auto",
	configuredSourceId: null,
	band: undefined,
	configuredChannelsHz: [100_000_000],
	reach: "channel",
	channelBandwidthHz: 20_000,
	channelTransitionHz: 10_000,
	protocols: [],
	channelPlacements: true,
	unavailable: false,
	ownDevice: false,
	centreSlotHz: null,
	centrePassbandHz: null,
	...overrides,
})
const source = (overrides: Partial<PlannerSource> = {}): PlannerSource => ({
	id: "s",
	centreHz: 100_000_000,
	sampleRateHz: 2_400_000,
	usableFraction: 0.8,
	dedicatedScanner: false,
	held: false,
	reservedBy: null,
	channelizerAvailable: true,
	order: 0,
	...overrides,
})
const input = (d = decoder(), sources = [source()]): PlannerInput => ({
	decoders: [d],
	sources,
	vfo: null,
	bandplanChannels: () => [],
	maxBandplanChannels: 4,
})

// Feature: decoder-enablement, Property 5: Channel sources
// Validates: Requirements 3.4, 3.5, 3.7
it("orders configured, VFO and capped band-plan channels", () => {
	fc.assert(
		fc.property(
			fc.constantFrom("dsd-fme", "multimon-ng"),
			fc.uniqueArray(fc.integer({ min: 99900000, max: 100100000 }), {
				maxLength: 12,
			}),
			fc.integer({ min: 0, max: 5 }),
			(type, channels, cap) => {
				const configured = 100000000
				const vfo = 100010000
				const listed = [...channels, vfo]
				const result = planPlacements({
					...input(decoder({ type, configuredChannelsHz: [configured] })),
					vfo: { sourceId: "s", frequencyHz: vfo },
					bandplanChannels: () => listed,
					maxBandplanChannels: cap,
				})
				const nearest = [...new Set(listed)]
					.sort(
						(a, b) =>
							Math.abs(a - configured) - Math.abs(b - configured) || a - b,
					)
					.slice(0, Math.min(cap, 4))
				expect(result.wanted.map(p => p.channelHz)).toEqual([
					...new Set([configured, vfo, ...nearest]),
				])
			},
		),
		{ numRuns: 100 },
	)
})
