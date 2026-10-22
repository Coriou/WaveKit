import { describe, it, expect } from "vitest"
import fc from "fast-check"
import { createLinkQuality } from "../../../../src/core/link-burst/link-quality.js"
import type {
	AbsorberCounters,
	BurstAbsorber,
	SdrHostLinkFacts,
} from "../../../../src/core/link-burst/contract.js"

describe("report properties", () => {
	// Feature: link-burst-resilience, Property 11: Overflow is drop evidence (report half)
	// Validates: Requirements 1.6, 6.2
	it("preserves overflow counters", () => {
		fc.assert(
			fc.property(fc.nat(), fc.nat(), (total, window) => {
				const counters: AbsorberCounters = {
					capacityBytes: 100,
					heldBytes: 0,
					absorbedBytesTotal: 0,
					overflowBytesTotal: total,
					overflowChunksTotal: 0,
					flushedBytesTotal: 0,
					window: {
						peakHeldBytes: 0,
						absorbedBytes: 0,
						overflowBytes: window,
						flushedBytes: 0,
						peakHeldMs: 0,
						maxLaggardExcludeMs: null,
					},
				}
				const absorber: BurstAbsorber = {
					counters: () => counters,
					configure: () => {},
					ingest: () => {},
					flush: () => {},
					dispose: () => {},
				}
				const quality = createLinkQuality({
					sources: () => ["iq"],
					handles: () => ({
						transport: "network",
						capacitySeconds: 2,
						recorder: null,
						absorber,
					}),
					attribution: () => null,
					upstreamDropRate: () => null,
					receiver: () => null,
					monoNow: () => 0,
					now: () => 0,
				})
				expect(quality.one("iq")?.absorber).toMatchObject({
					overflowBytesTotal: total,
					overflowBytes10m: window,
				})
			}),
			{ numRuns: 100 },
		)
	})
	// Feature: link-burst-resilience, Property 12: Report bounds (report half)
	// Validates: Requirements 6.2, 6.5
	it("keeps only ids, timestamp and closed enum string values", () => {
		fc.assert(
			fc.property(fc.string(), secret => {
				const quality = createLinkQuality({
					sources: () => ["iq"],
					handles: () => ({
						transport: "network",
						capacitySeconds: 0,
						recorder: null,
						absorber: null,
					}),
					attribution: () => null,
					upstreamDropRate: () => null,
					receiver: () =>
						({
							interfaceKind: secret,
							signalDbm: secret,
							undervoltageNow: secret,
							throttled: secret,
							hostname: secret,
						}) as unknown as SdrHostLinkFacts,
					monoNow: () => 0,
					now: () => 0,
				})
				const strings: string[] = []
				function visit(value: unknown): void {
					if (typeof value === "string") strings.push(value)
					else if (value && typeof value === "object")
						Object.values(value).forEach(visit)
				}
				const reports = quality.all()
				expect(reports).toHaveLength(1)
				visit(reports)
				expect(
					strings.every(value =>
						[
							"iq",
							"network",
							"1970-01-01T00:00:00.000Z",
							"ethernet",
							"wireless",
							"other",
						].includes(value),
					),
				).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})
})
