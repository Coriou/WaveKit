import { it, expect } from "vitest"
import {
	createLinkAdvisor,
	isLoopbackHost,
} from "../../../src/core/link-advisory.js"

const input = {
	sourceId: "s",
	host: "private.invalid",
	sampleRateHz: 2_400_000,
}
function harness() {
	let now = 0
	const advisor = createLinkAdvisor({ now: () => now })
	return {
		advisor,
		feed(bytes: number, rate = input.sampleRateHz) {
			for (const at of [0, 5000, 10000]) advisor.observe("s", bytes, rate, at)
			now = 10000
		},
	}
}
it("127.0.0.5, ::1 and LOCALHOST are none", () => {
	const { advisor } = harness()
	for (const host of ["127.0.0.5", "::1", "LOCALHOST"])
		expect(advisor.classify({ ...input, host }, 10001).level).toBe("none")
	for (const host of ["127.evil", "127.0.0.256", "localhost.invalid", "[::1]"])
		expect(isLoopbackHost(host)).toBe(false)
})
it("10.0.0.2 with no history is unproven", () => {
	expect(
		harness().advisor.classify({ ...input, host: "10.0.0.2" }, null).level,
	).toBe("unproven")
})
it("sustained 2.048 MB/s, payload 4.8 MB/s is unproven", () => {
	const h = harness()
	h.feed(2_048_000, 1_024_000)
	expect(h.advisor.classify(input, null).level).toBe("unproven")
})
it("shortfall 1.0 % is not dropping, 1.01 % is", () => {
	for (const percent of [1, 1.01]) {
		const h = harness()
		h.feed(4_800_000 * (1 - percent / 100))
		expect(h.advisor.classify(input, null).level).toBe(
			percent === 1 ? "unproven" : "dropping",
		)
	}
})
it("upstream drops 10 000 B/s is not dropping, 10 001 is", () => {
	const h = harness()
	h.feed(4_800_000)
	expect(h.advisor.classify(input, 10000).level).toBe("none")
	expect(h.advisor.classify(input, 10001).level).toBe("dropping")
})
it("reconnect resets sustained", () => {
	const h = harness()
	h.feed(4_800_000)
	h.advisor.reset("s")
	expect(h.advisor.classify(input, null).sustainedBytesPerSecond).toBeNull()
})
it("full window, rate changes, stale and malformed samples cannot prove capacity", () => {
	let now = 5000
	const advisor = createLinkAdvisor({ now: () => now })
	advisor.observe("s", 4_800_000, 2_400_000, 0)
	advisor.observe("s", 4_800_000, 2_400_000, 5000)
	expect(advisor.classify(input, null).sustainedBytesPerSecond).toBeNull()
	advisor.observe("s", 0, 2_400_000, 10000)
	now = 20001
	expect(advisor.classify(input, null).shortfallPercent).toBeNull()
	advisor.observe("s", NaN, 2_400_000, now)
	expect(
		advisor.classify(input, Infinity).upstreamDropBytesPerSecond,
	).toBeNull()
	expect(advisor.classify({ ...input, sourceId: "other" }, null).level).toBe(
		"unproven",
	)
})

it.each([9999, 10000, 10001])("window span boundary %i ms", span => {
	const advisor = createLinkAdvisor({ now: () => span })
	advisor.observe("s", 4_704_000, 2_400_000, 0)
	advisor.observe("s", 4_704_000, 2_400_000, span)
	expect(advisor.classify(input, null).level).toBe(
		span < 10000 ? "unproven" : "dropping",
	)
})
it("jittered metrics retain a full time-weighted window between observations", () => {
	const advisor = createLinkAdvisor({ now: () => 10004 })
	for (const at of [0, 5001, 10002])
		advisor.observe("s", 4_704_000, 2_400_000, at)
	expect(advisor.classify(input, null).level).toBe("dropping")
})

it("averages elapsed intervals rather than sample counts", () => {
	const advisor = createLinkAdvisor({ now: () => 10000 })
	advisor.observe("s", 4_800_000, 2_400_000, 0)
	advisor.observe("s", 4_800_000, 2_400_000, 9000)
	advisor.observe("s", 0, 2_400_000, 10000)
	expect(advisor.classify(input, null).shortfallPercent).toBeCloseTo(10)
})

it.each([1, 1.01])(
	"irregular timestamps preserve the %s %% shortfall boundary",
	percent => {
		const advisor = createLinkAdvisor({ now: () => 10000 })
		const bytes = 4_800_000 * (1 - percent / 100)
		for (const at of [0, 8, 10000]) advisor.observe("s", bytes, 2_400_000, at)
		const advisory = advisor.classify(input, null)
		expect(advisory.level).toBe(percent === 1 ? "unproven" : "dropping")
		if (percent === 1)
			expect(advisory.sustainedBytesPerSecond).toBeCloseTo(4_752_000)
		else expect(advisory.sustainedBytesPerSecond).toBeNull()
	},
)
function liveHarness() {
	let now = 0
	let live = true
	const advisor = createLinkAdvisor({ now: () => now, live: () => live })
	return {
		advisor,
		setLive(value: boolean) {
			live = value
		},
		/** One metrics tick per second from `from` to `to` (inclusive) at `bytes` per second. */
		ticks(bytes: number, from: number, to: number) {
			for (let at = from; at <= to; at += 1000) {
				advisor.observe("s", bytes, input.sampleRateHz, at)
				now = at
			}
		},
		classify: () => advisor.classify(input, null),
	}
}
it("zero-byte metrics from a disconnected source never read dropping", () => {
	const h = liveHarness()
	h.ticks(4_800_000, 0, 10000)
	expect(h.classify().level).toBe("none")
	h.setLive(false)
	h.ticks(0, 11000, 30000)
	const advisory = h.classify()
	expect(advisory.level).toBe("none")
	expect(advisory).not.toHaveProperty("lossReason")
	expect(advisory.shortfallPercent).toBeNull()
	expect(h.advisor.shortfall("s", input.sampleRateHz, 2)).toBeNull()
})
it("a paused feed (zero bytes, not live) never reads dropping", () => {
	const h = liveHarness()
	h.setLive(false)
	h.ticks(0, 0, 20000)
	expect(h.classify()).toMatchObject({ level: "none" })
	expect(h.classify()).not.toHaveProperty("lossReason")
})
it("after a reconnect a real shortfall reads dropping again", () => {
	const h = liveHarness()
	h.setLive(false)
	h.ticks(0, 0, 15000)
	h.setLive(true)
	// The window restarts at the reconnect: no verdict until a full window is live.
	h.ticks(4_800_000 * 0.9, 16000, 20000)
	expect(h.classify().level).not.toBe("dropping")
	h.ticks(4_800_000 * 0.9, 21000, 26000)
	expect(h.classify().level).toBe("dropping")
	expect(h.advisor.shortfall("s", input.sampleRateHz, 2)).toBe(true)
})
it("a throwing liveness check reads live", () => {
	const advisor = createLinkAdvisor({
		now: () => 10000,
		live: () => {
			throw new Error("unavailable")
		},
	})
	for (const at of [0, 5000, 10000])
		advisor.observe("s", 4_800_000 * 0.9, input.sampleRateHz, at)
	expect(advisor.classify(input, null).level).toBe("dropping")
})
