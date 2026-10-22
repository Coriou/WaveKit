import { it, expect, vi } from "vitest"
import type { LinkAdvisory, ResourceAlert } from "@wavekit/api-types"
import { createRatePolicy } from "../../../src/core/rate-policy.js"
import { createLinkAdvisor } from "../../../src/core/link-advisory.js"
import { ResourceAggregator } from "../../../src/core/resource-aggregator.js"
import { createLogger } from "../../../src/utils/logger.js"

export function recheckHarness(host = "private.invalid") {
	let now = 0
	let rate = 1_024_000
	let drops = 0
	const timers: Array<{ fn(): void; cancelled: boolean }> = []
	const reports: LinkAdvisory[] = []
	const log = createLogger({ level: "fatal" })
	const aggregator = new ResourceAggregator(log, { autoBroadcast: false })
	const alerts: ResourceAlert[] = []
	aggregator.on("alert", (alert: ResourceAlert) => alerts.push(alert))
	const advisor = createLinkAdvisor({ now: () => now })
	const write = vi.fn((_id: string, hz: number) => {
		rate = hz
		return Promise.resolve()
	})
	const emit = vi.fn()
	const policy = createRatePolicy({
		port: { readsbOn: () => ({ mode: "auto", ownDevice: false }) },
		tuner: {
			sampleRateOf: () => rate,
			controlModeOf: () => "internal",
			setSampleRate: write,
		},
		link: advisor,
		linkInput: sourceId => ({ sourceId, host, sampleRateHz: rate }),
		upstreamDropsOf: () => drops,
		reportLink(sourceId, advisory) {
			reports.push(advisory)
			aggregator.reportLinkAdvisory(sourceId, advisory)
		},
		setTimer(fn, ms) {
			expect(ms).toBe(10000)
			const timer = { fn, cancelled: false }
			timers.push(timer)
			return {
				cancel() {
					timer.cancelled = true
				},
			}
		},
		emit,
		now: () => new Date(now),
		log,
		enabled: true,
	})
	return {
		policy,
		reports,
		alerts,
		timers,
		write,
		emit,
		raise: () =>
			policy.beforeOperatorRetune("s", 1_090_000_000, { origin: "rest" }),
		tick(bytes = 4_800_000, upstream = 0) {
			drops = upstream
			for (const at of [now, now + 5000, now + 10000])
				advisor.observe("s", bytes, rate, at)
			now += 10000
			const timer = timers.shift()
			if (timer && !timer.cancelled) timer.fn()
		},
	}
}
it("re-check 10 s after a raise reports dropping once as a critical alert", async () => {
	const h = recheckHarness()
	await h.raise()
	h.tick(4_704_000)
	h.tick(4_704_000)
	expect(h.reports.map(r => r.level)).toEqual(["unproven", "dropping"])
	expect(h.alerts.map(a => a.severity)).toEqual(["warning", "critical"])
})
it("upstream drops above 10 000 B/s at the re-check report dropping", async () => {
	const h = recheckHarness()
	await h.raise()
	h.tick(4_800_000, 10001)
	expect(h.reports.at(-1)?.level).toBe("dropping")
})
it("a healthy link after the raise reports nothing new", async () => {
	const h = recheckHarness()
	h.tick()
	await h.raise()
	// A new payload remains unproven until a full window at the raised rate.
	h.tick()
	const count = h.reports.length
	h.tick()
	expect(h.reports).toHaveLength(count)
})
it("dropping then recovered reports the new level once", async () => {
	const h = recheckHarness()
	await h.raise()
	h.tick(4_704_000)
	h.tick()
	h.tick()
	expect(h.reports.map(r => r.level)).toEqual(["unproven", "dropping", "none"])
})
it.each(["restore", "operator", "reset", "dispose"] as const)(
	"restore, an operator rate write, reset and dispose each cancel the re-check: %s",
	async action => {
		const h = recheckHarness()
		await h.raise()
		const timer = h.timers[0]
		if (action === "restore")
			await h.policy.beforeOperatorRetune("s", 162_000_000, { origin: "rest" })
		else if (action === "operator") h.policy.onOperatorSampleRate("s")
		else if (action === "reset") h.policy.reset("s")
		else h.policy.dispose()
		expect(timer?.cancelled).toBe(true)
		const count = h.reports.length
		timer?.fn()
		expect(h.reports).toHaveLength(count)
	},
)
it("loopback source arms no re-check", async () => {
	const h = recheckHarness("LOCALHOST")
	await h.raise()
	expect(h.timers).toEqual([])
})
it("re-check never writes the radio and never emits a tuner event", async () => {
	const h = recheckHarness()
	await h.raise()
	h.tick(4_704_000)
	h.tick()
	expect(h.write).toHaveBeenCalledTimes(1)
	expect(h.emit).toHaveBeenCalledTimes(1)
})

it("a cancelled callback cannot attach to a subsequent raise", async () => {
	const h = recheckHarness()
	await h.raise()
	const stale = h.timers.shift()
	await h.policy.beforeOperatorRetune("s", 162_000_000, { origin: "rest" })
	await h.raise()
	const count = h.reports.length
	stale?.fn()
	expect(h.reports).toHaveLength(count)
	expect(h.timers).toHaveLength(1)
	h.tick(4_704_000)
	expect(h.reports.at(-1)?.level).toBe("dropping")
	h.policy.dispose()
})
