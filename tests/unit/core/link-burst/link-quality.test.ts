import { describe, it, expect, vi } from "vitest"
import { createLinkQuality } from "../../../../src/core/link-burst/link-quality.js"
import type { LinkQualityDeps } from "../../../../src/core/link-burst/link-quality.js"
import { createIngestRecorder } from "../../../../src/core/link-burst/recorder.js"

export function deps(): LinkQualityDeps {
	return {
		sources: () => ["iq", "audio"],
		handles: id =>
			id === "iq"
				? {
						transport: "network",
						capacitySeconds: 0,
						recorder: createIngestRecorder(),
						absorber: null,
					}
				: null,
		attribution: () => null,
		upstreamDropRate: () => null,
		receiver: () => null,
		monoNow: () => 0,
		now: () => 0,
	}
}
describe("link quality", () => {
	it("omits failed histograms and zeroes failed recorder and absorber fields", () => {
		const input = deps()
		const fail = () => {
			throw new Error("private")
		}
		input.handles = () => ({
			transport: "network",
			capacitySeconds: 2,
			recorder: {
				configure: () => {},
				resetArrival: () => {},
				observeChunk: () => {},
				noteHolding: () => {},
				interval: () => null,
				window: fail,
				histograms: fail,
			},
			absorber: {
				configure: () => {},
				ingest: () => {},
				flush: () => {},
				dispose: () => {},
				counters: fail,
			},
		})
		const report = createLinkQuality(input).one("iq")
		expect(report).not.toHaveProperty("histograms")
		expect(report?.arrivals).toMatchObject({ chunks10m: 0, worstStallMs: null })
		expect(report?.absorber).toMatchObject({
			overflowBytesTotal: 0,
			peakHeldMs10m: 0,
		})
	})
	it("returns no burst for loopback or an absent recorder and collapses empty receiver facts", () => {
		const input = deps()
		input.handles = () => ({
			transport: "loopback",
			capacitySeconds: 0,
			recorder: createIngestRecorder(),
			absorber: null,
		})
		input.receiver = () => ({
			interfaceKind: null,
			signalDbm: null,
			undervoltageNow: null,
			throttled: null,
		})
		expect(createLinkQuality(input).burst("iq")).toBeNull()
		expect(createLinkQuality(input).one("iq")?.receiver).toBeNull()
		input.handles = () => ({
			transport: "network",
			capacitySeconds: 0,
			recorder: null,
			absorber: null,
		})
		expect(createLinkQuality(input).burst("iq")).toBeNull()
	})

	it("reports only IQ handles and disabled absorber zeros", () => {
		const quality = createLinkQuality(deps())
		expect(quality.all()).toHaveLength(1)
		expect(quality.one("audio")).toBeNull()
		expect(quality.one("iq")?.absorber).toMatchObject({
			enabled: false,
			overflowBytesTotal: 0,
			laggardExcludeMsMax10m: null,
		})
		expect(quality.burst("iq")).toEqual({
			worstStallMs: null,
			overflowedBytes10m: 0,
			burstSeconds: 0,
		})
	})
	it("report carries histograms and loopDelay from deps", () => {
		const input = deps()
		const loop = {
			last: { maxMs: 5, p99Ms: 2 },
			maxMs10m: 5,
			p99MaxMs10m: 2,
			intervals10m: 1,
		}
		input.loopDelay = () => loop
		const report = createLinkQuality(input).one("iq")
		expect(report?.histograms?.windowMs).toBe(600000)
		expect(report?.loopDelay).toEqual(loop)
	})
	it("loopDelay null when the dep throws", () => {
		const input = deps()
		input.loopDelay = vi.fn(() => {
			throw new Error("private")
		})
		expect(createLinkQuality(input).one("iq")?.loopDelay).toBeNull()
	})
	it("throwing dependencies degrade safely", () => {
		const input = deps()
		input.receiver =
			input.attribution =
			input.upstreamDropRate =
				() => {
					throw new Error("private")
				}
		expect(createLinkQuality(input).all()[0]).toMatchObject({
			receiver: null,
			upstreamDropBytesPerSecond: null,
			attribution: { last: null },
		})
		input.sources = () => {
			throw new Error("private")
		}
		expect(createLinkQuality(input).all()).toEqual([])
	})
})
