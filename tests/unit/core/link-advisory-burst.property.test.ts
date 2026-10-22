import { describe, it, expect, vi } from "vitest"
import fc from "fast-check"
import { createLinkAdvisor } from "../../../src/core/link-advisory.js"
import { LINK_DROPPING_HOLD_MS } from "../../../src/core/link-burst/contract.js"

const input = { sourceId: "s", host: "source.invalid", sampleRateHz: 1000 }
describe("burst advisory", () => {
	// Feature: link-burst-resilience, Property 13: Advisory
	// Validates: Requirements 6.4, 6.6
	it("keeps loopback none, holds link drops and leaves absorbed bursts at the existing level", () => {
		fc.assert(
			fc.property(fc.nat(100000), fc.nat(100000), (stall, seconds) => {
				const burst = {
					worstStallMs: stall,
					burstSeconds: seconds,
					overflowedBytes10m: 0,
				}
				const baseline = createLinkAdvisor({ now: () => 10000 })
				const absorbed = createLinkAdvisor({
					now: () => 10000,
					burst: () => burst,
				})
				const held = createLinkAdvisor({
					now: () => 10000,
					monoNow: () => 200000,
					linkDropsSince: () => true,
					burst: () => burst,
				})
				for (const advisor of [baseline, absorbed, held]) {
					for (const at of [0, 5000, 10000])
						advisor.observe("s", 2000, 1000, at)
				}
				expect(absorbed.classify(input, null).level).toBe(
					baseline.classify(input, null).level,
				)
				expect(absorbed.classify(input, null).burst).toEqual(burst)
				expect(held.classify(input, null).level).toBe("dropping")
				for (const host of ["localhost", "::1", "127.0.0.5"]) {
					expect(held.classify({ ...input, host }, 20000)).toMatchObject({
						level: "none",
						transport: "loopback",
					})
					expect(held.classify({ ...input, host }, null)).not.toHaveProperty(
						"burst",
					)
				}
			}),
			{ numRuns: 100 },
		)
	})
	it("uses the monotonic hold boundary and ignores throwing optional evidence", () => {
		let mono = 90000
		const linkDropsSince = vi.fn((_id: string, since: number) => since <= 30000)
		const advisor = createLinkAdvisor({
			now: () => 0,
			monoNow: () => mono,
			linkDropsSince,
			burst: () => {
				throw new Error("unavailable")
			},
		})
		expect(advisor.classify(input, null).level).toBe("dropping")
		expect(linkDropsSince).toHaveBeenCalledWith(
			"s",
			mono - LINK_DROPPING_HOLD_MS,
		)
		mono++
		expect(advisor.classify(input, null).level).toBe("unproven")
		const throwing = createLinkAdvisor({
			now: () => 0,
			linkDropsSince: () => {
				throw new Error("unavailable")
			},
		})
		expect(throwing.classify(input, null).level).toBe("unproven")
	})
	it("weights shortfall by elapsed intervals rather than observation count", () => {
		const advisor = createLinkAdvisor({ now: () => 10000 })
		advisor.observe("s", 4000, 1000, 0)
		advisor.observe("s", 4000, 1000, 9900)
		advisor.observe("s", 0, 1000, 10000)
		expect(advisor.shortfall("s", 1000, 4)).toBe(false)
		advisor.observe("s", 0, 1000, 10001)
		expect(advisor.shortfall("s", 1000, 4)).toBeNull()
	})

	it("requires a full current window and uses frame four for S16", () => {
		let now = 0
		const advisor = createLinkAdvisor({ now: () => now })
		advisor.observe("s", 3950, 1000, 0)
		expect(advisor.shortfall("s", 1000, 4)).toBeNull()
		now = 10000
		advisor.observe("s", 3950, 1000, now)
		expect(advisor.shortfall("s", 1000, 4)).toBe(true)
		expect(advisor.shortfall("s", 1000, 2)).toBe(false)
		expect(advisor.shortfall("s", 2000, 4)).toBeNull()
		advisor.observe("s", 3960, 1000, 20000)
		now = 20000
		expect(advisor.shortfall("s", 1000, 4)).toBe(false)
		now = 30001
		expect(advisor.shortfall("s", 1000, 4)).toBeNull()
		advisor.reset("s")
		expect(advisor.shortfall("s", 1000, 4)).toBeNull()
	})
})
