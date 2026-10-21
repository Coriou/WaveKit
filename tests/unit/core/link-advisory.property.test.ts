import { it, expect, vi } from "vitest"
import type { LinkAdvisory, ResourceAlert } from "@wavekit/api-types"
import { createRatePolicy } from "../../../src/core/rate-policy.js"
import { ResourceAggregator } from "../../../src/core/resource-aggregator.js"
import { createLogger } from "../../../src/utils/logger.js"

import fc from "fast-check"
import { createLinkAdvisor } from "../../../src/core/link-advisory.js"

// Feature: decoder-enablement, Property 10: Link advisory
// Validates: Requirements 7.1, 7.2, 7.3
it("timed observations match a reference model", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					step: fc.constantFrom(1, 5000, 10000, 10001, 15000),
					bytes: fc.integer({ min: 0, max: 6000000 }),
					rate: fc.constantFrom(1024000, 2400000),
				}),
				{ maxLength: 50 },
			),
			fc.integer({ min: 0, max: 20000 }),
			(sequence, drops) => {
				let now = 0
				let rate = 0
				let sustained: number | null = null
				let samples: Array<{ at: number; bytes: number }> = []
				const advisor = createLinkAdvisor({ now: () => now })
				for (const sample of sequence) {
					now += sample.step
					if (rate !== sample.rate) samples = []
					rate = sample.rate
					samples.push({ at: now, bytes: sample.bytes })
					const full =
						samples.length > 1 && now - (samples[0]?.at ?? now) >= 10000
					const mean = full
						? samples.slice(1).reduce((sum, observation, index) => {
								const previous = samples[index]
								const duration = Math.max(
									0,
									observation.at - Math.max(now - 10000, previous?.at ?? now),
								)
								return sum + observation.bytes * (duration / 10000)
							}, 0)
						: null
					if (mean !== null && mean >= rate * 1.98)
						sustained = Math.max(sustained ?? 0, mean)
					advisor.observe("s", sample.bytes, rate, now)
					const level =
						drops > 10000 || (mean !== null && mean < rate * 1.98)
							? "dropping"
							: sustained === null || sustained < rate * 2
								? "unproven"
								: "none"
					expect(
						advisor.classify(
							{ sourceId: "s", host: "private.invalid", sampleRateHz: rate },
							drops,
						).level,
					).toBe(level)
				}
			},
		),
		{ numRuns: 100 },
	)
})
it("arbitrary re-check runs report exactly level changes", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.record({
					bytes: fc.constantFrom(4_704_000, 4_800_000),
					drops: fc.constantFrom(0, 10000, 10001),
				}),
				{ maxLength: 30 },
			),
			async sequence => {
				const h = recheckHarness()
				await h.raise()
				const levels = ["unproven"]
				for (const sample of sequence) {
					h.tick(sample.bytes, sample.drops)
					const level =
						sample.bytes < 4_752_000 || sample.drops > 10000
							? "dropping"
							: "none"
					if (levels.at(-1) !== level) levels.push(level)
				}
				expect(h.reports.map(r => r.level)).toEqual(levels)
				h.policy.dispose()
			},
		),
		{ numRuns: 100 },
	)
})

function recheckHarness(host = "private.invalid") {
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
