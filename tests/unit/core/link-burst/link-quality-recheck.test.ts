import { describe, it, expect, vi } from "vitest"
import type { LinkAdvisory } from "@wavekit/api-types"
import { createLinkQuality } from "../../../../src/core/link-burst/link-quality.js"
import type { LinkQualityDeps } from "../../../../src/core/link-burst/link-quality.js"
import { createLinkAdvisor } from "../../../../src/core/link-advisory.js"
import { ResourceAggregator } from "../../../../src/core/resource-aggregator.js"
import { createLogger } from "../../../../src/utils/logger.js"

function setup() {
	let mono = 0
	const advisor = createLinkAdvisor({
		now: () => 0,
		monoNow: () => mono,
		linkDropsSince: () => mono >= 2000 && mono < 60000,
	})
	const reportAdvisory = vi.fn()
	const deps: LinkQualityDeps = {
		sources: () => ["s"],
		handles: () => ({
			transport: "network",
			capacitySeconds: 0,
			recorder: null,
			absorber: null,
		}),
		attribution: () => null,
		upstreamDropRate: () => null,
		receiver: () => null,
		monoNow: () => mono,
		now: () => 0,
		advisory: id =>
			advisor.classify(
				{ sourceId: id, host: "source.invalid", sampleRateHz: 1000 },
				null,
			),
		reportAdvisory,
	}
	return {
		deps,
		reportAdvisory,
		setMono: (value: number) => {
			mono = value
		},
	}
}
describe("advisory recheck", () => {
	it("link hold raises dropping on the next tick and reports only level changes", () => {
		const h = setup()
		let level: LinkAdvisory["level"] = "none"
		const classify = h.deps.advisory!
		h.deps.advisory = id =>
			level === "dropping" ? classify(id) : { ...classify(id)!, level }
		const quality = createLinkQuality(h.deps)
		quality.recheckAdvisories()
		expect(h.reportAdvisory).not.toHaveBeenCalled()
		h.setMono(2000)
		level = "dropping"
		quality.recheckAdvisories()
		quality.recheckAdvisories()
		expect(h.reportAdvisory).toHaveBeenCalledTimes(1)
		level = "none"
		quality.recheckAdvisories()
		level = "dropping"
		quality.recheckAdvisories()
		expect(h.reportAdvisory).toHaveBeenCalledTimes(2)
	})
	it("loopback and absent handles are never rechecked", () => {
		const h = setup()
		h.deps.sources = () => ["local", "absent"]
		h.deps.handles = id =>
			id === "local"
				? {
						transport: "loopback",
						capacitySeconds: 0,
						recorder: null,
						absorber: null,
					}
				: null
		h.deps.advisory = vi.fn()
		createLinkQuality(h.deps).recheckAdvisories()
		expect(h.deps.advisory).not.toHaveBeenCalled()
	})
	it("throwing dependencies skip only that source", () => {
		const h = setup()
		h.deps.sources = () => ["bad", "s"]
		const classify = h.deps.advisory!
		h.deps.advisory = id => {
			if (id === "bad") throw new Error("unavailable")
			return classify(id)
		}
		createLinkQuality(h.deps).recheckAdvisories()
		expect(h.reportAdvisory).toHaveBeenCalledTimes(1)
		h.deps.reportAdvisory = () => {
			throw new Error("unavailable")
		}
		expect(() => createLinkQuality(h.deps).recheckAdvisories()).not.toThrow()
	})
	it("aggregator tick rechecks before emitting link quality", () => {
		vi.useFakeTimers()
		const order: string[] = []
		const aggregator = new ResourceAggregator(
			createLogger({ level: "fatal" }),
			{ autoBroadcast: false, broadcastIntervalMs: 2000 },
			{
				linkQuality: {
					all: () => [],
					one: () => null,
					recheckAdvisories: () => {
						order.push("recheck")
					},
				},
			},
		)
		try {
			aggregator.on("link-quality", () => {
				order.push("emit")
			})
			aggregator.startBroadcasting()
			vi.advanceTimersByTime(2000)
			expect(order).toEqual(["recheck", "emit"])
		} finally {
			aggregator.stopBroadcasting()
			vi.useRealTimers()
		}
	})
})
