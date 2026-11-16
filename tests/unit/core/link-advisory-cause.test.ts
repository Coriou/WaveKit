import { describe, it, expect, vi } from "vitest"
import type { LinkAdvisory } from "@wavekit/api-types"
import {
	CORE_BUSY_ELU,
	SOURCE_ELU_MAX,
	createLinkAdvisor,
	droppingCause,
} from "../../../src/core/link-advisory.js"
import type { CoreLoadEvidence } from "../../../src/core/link-advisory.js"
import {
	HOST_LOOP_DELAY_MS,
	LINK_GAP_MS,
} from "../../../src/core/link-burst/contract.js"
import { LINK_SUSTAINED_WINDOW_MS } from "../../../src/core/rate-policy-contract.js"

const RATE = 2_400_000
const PAYLOAD = RATE * 2
// 2 % below the payload: past the 1 % shortfall bound, so `dropping`.
const SHORT = PAYLOAD * 0.98
const input = { sourceId: "s", host: "source.invalid", sampleRateHz: RATE }

interface Evidence {
	elu: number | null
	loopDelayMaxMs: number | null
	arrivalGapMaxMs: number | null
}

function harness(
	evidence: Evidence,
	opts: { coreLoad?: boolean; gap?: boolean } = {},
) {
	let now = 0
	const coreLoad = vi.fn(
		(_since: number): CoreLoadEvidence => ({
			elu: evidence.elu,
			loopDelayMaxMs: evidence.loopDelayMaxMs,
		}),
	)
	const arrivalGapMaxMs = vi.fn(
		(_id: string, _since: number) => evidence.arrivalGapMaxMs,
	)
	const advisor = createLinkAdvisor({
		now: () => now,
		monoNow: () => now,
		...(opts.coreLoad === false ? {} : { coreLoad }),
		...(opts.gap === false ? {} : { arrivalGapMaxMs }),
	})
	return {
		advisor,
		evidence,
		coreLoad,
		arrivalGapMaxMs,
		/** One full advisory window received at `bytes` per second at `rate`. */
		window(bytes: number, rate = RATE) {
			for (const at of [now, now + 5000, now + 10000])
				advisor.observe("s", bytes, rate, at)
			now += 10000
		},
		setNow(value: number) {
			now = value
		},
		get now() {
			return now
		},
		classify(rate = RATE): LinkAdvisory {
			return advisor.classify({ ...input, sampleRateHz: rate }, null)
		},
	}
}

describe("dropping cause ladder", () => {
	const quiet = { elu: 0.3, loopDelayMaxMs: 0, arrivalGapMaxMs: 0 }
	it.each<[string, Evidence, string]>([
		// Step 1: utilisation at and below the busy bound.
		["elu at 0.90", { ...quiet, elu: CORE_BUSY_ELU }, "core-busy"],
		[
			"elu 0.98 beats a link-like gap",
			{ elu: 0.98, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 },
			"core-busy",
		],
		[
			"elu just under 0.90, no other evidence",
			{ ...quiet, elu: 0.8999 },
			"unknown",
		],
		// Step 2: gap the loop cannot explain, at and below 200 ms.
		[
			"gap excess at 200 ms",
			{
				elu: 0.5,
				loopDelayMaxMs: LINK_GAP_MS,
				arrivalGapMaxMs: 2 * LINK_GAP_MS,
			},
			"source",
		],
		[
			"gap excess 199 ms with a 200 ms stall",
			{
				elu: 0.5,
				loopDelayMaxMs: LINK_GAP_MS,
				arrivalGapMaxMs: 2 * LINK_GAP_MS - 1,
			},
			"core-busy",
		],
		// Step 3: loop delay at and below 200 ms.
		[
			"loop delay at 200 ms",
			{ elu: 0.5, loopDelayMaxMs: LINK_GAP_MS, arrivalGapMaxMs: 0 },
			"core-busy",
		],
		[
			"loop delay just under 200 ms",
			{ elu: 0.5, loopDelayMaxMs: LINK_GAP_MS - 0.1, arrivalGapMaxMs: 0 },
			"unknown",
		],
		// Step 4: an idle, responsive core, at and past 50 ms and 0.70.
		[
			"loop 49.9 ms, elu 0.69",
			{
				elu: 0.69,
				loopDelayMaxMs: HOST_LOOP_DELAY_MS - 0.1,
				arrivalGapMaxMs: 0,
			},
			"source",
		],
		[
			"loop at 50 ms",
			{ elu: 0.3, loopDelayMaxMs: HOST_LOOP_DELAY_MS, arrivalGapMaxMs: 0 },
			"unknown",
		],
		[
			"elu at 0.70",
			{ elu: SOURCE_ELU_MAX, loopDelayMaxMs: 0, arrivalGapMaxMs: 0 },
			"unknown",
		],
		// Step 5: missing or malformed evidence.
		["elu missing", { ...quiet, elu: null }, "unknown"],
		["loop delay missing", { ...quiet, loopDelayMaxMs: null }, "unknown"],
		["gap missing", { ...quiet, arrivalGapMaxMs: null }, "unknown"],
		["elu NaN", { ...quiet, elu: Number.NaN }, "unknown"],
		["elu above 1", { ...quiet, elu: 1.5 }, "unknown"],
		["loop delay infinite", { ...quiet, loopDelayMaxMs: Infinity }, "unknown"],
		["gap negative", { ...quiet, arrivalGapMaxMs: -1 }, "unknown"],
		[
			"saturated loop, other evidence missing",
			{ elu: 0.95, loopDelayMaxMs: null, arrivalGapMaxMs: null },
			"core-busy",
		],
		// Missing utilisation (e.g. after a stall longer than the meter's window) blocks only
		// steps 1 and 4.
		[
			"elu missing, gap beyond the loop delay",
			{ elu: null, loopDelayMaxMs: 0, arrivalGapMaxMs: LINK_GAP_MS },
			"source",
		],
		[
			"elu missing, loop delay at the core-busy bound",
			{ elu: null, loopDelayMaxMs: LINK_GAP_MS, arrivalGapMaxMs: 0 },
			"core-busy",
		],
		[
			"elu above 1, loop delay at the core-busy bound",
			{ elu: 1.5, loopDelayMaxMs: 6500, arrivalGapMaxMs: 6500 },
			"core-busy",
		],
		[
			"elu missing, loop delay high, gap missing",
			{ elu: null, loopDelayMaxMs: LINK_GAP_MS, arrivalGapMaxMs: null },
			"unknown",
		],
		[
			"elu missing, quiet loop and gap",
			{ elu: null, loopDelayMaxMs: 0, arrivalGapMaxMs: 0 },
			"unknown",
		],
	])("%s: %s", (_name, evidence, cause) => {
		expect(droppingCause(evidence)).toBe(cause)
		const h = harness(evidence)
		h.window(SHORT)
		expect(h.classify()).toMatchObject({ level: "dropping", lossReason: cause })
	})
	it("reads evidence over the advisory window ending now", () => {
		const h = harness(quiet)
		h.window(SHORT)
		h.classify()
		expect(h.coreLoad).toHaveBeenCalledWith(h.now - LINK_SUSTAINED_WINDOW_MS)
		expect(h.arrivalGapMaxMs).toHaveBeenCalledWith(
			"s",
			h.now - LINK_SUSTAINED_WINDOW_MS,
		)
	})
	it.each([
		["no core-load dependency", { coreLoad: false }],
		["no arrival-gap dependency", { gap: false }],
		["neither dependency", { coreLoad: false, gap: false }],
	] as const)("%s reads unknown, never source", (_name, opts) => {
		const h = harness(quiet, opts)
		h.window(SHORT)
		expect(h.classify()).toMatchObject({
			level: "dropping",
			lossReason: "unknown",
		})
	})
	it("throwing evidence reads unknown", () => {
		const h = harness(quiet)
		h.coreLoad.mockImplementation(() => {
			throw new Error("unavailable")
		})
		h.window(SHORT)
		expect(h.classify().lossReason).toBe("unknown")
		h.coreLoad.mockImplementation(() => ({ elu: 0.3, loopDelayMaxMs: 0 }))
		h.arrivalGapMaxMs.mockImplementation(() => {
			throw new Error("unavailable")
		})
		expect(h.classify().lossReason).toBe("unknown")
	})
	it("an unreadable monotonic clock reads unknown", () => {
		for (const monoNow of [
			() => Number.NaN,
			() => {
				throw new Error("unavailable")
			},
		]) {
			const advisor = createLinkAdvisor({
				now: () => 10000,
				monoNow,
				coreLoad: () => ({ elu: 0.2, loopDelayMaxMs: 0 }),
				arrivalGapMaxMs: () => 1000,
			})
			for (const at of [0, 5000, 10000]) advisor.observe("s", SHORT, RATE, at)
			expect(advisor.classify(input, null)).toMatchObject({
				level: "dropping",
				lossReason: "unknown",
			})
		}
	})
	it("a stalled loop with a received shortfall is core-busy, never source", () => {
		for (const elu of [0.98, 0.5]) {
			const h = harness({
				elu,
				loopDelayMaxMs: 2400,
				arrivalGapMaxMs: 2400,
			})
			h.window(SHORT)
			expect(h.classify()).toMatchObject({
				level: "dropping",
				lossReason: "core-busy",
			})
		}
	})
	it("a real link loss (no loop delay, 1 s arrival gap) is source", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		expect(h.classify()).toMatchObject({
			level: "dropping",
			lossReason: "source",
		})
	})
	it("upstream drops alone are dropping with a cause", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 0 })
		h.window(PAYLOAD)
		expect(h.advisor.classify(input, 10001)).toMatchObject({
			level: "dropping",
			lossReason: "source",
		})
	})
	it("loopback never carries a cause", () => {
		const h = harness({ elu: 0.98, loopDelayMaxMs: 2400, arrivalGapMaxMs: 0 })
		h.window(SHORT)
		const advisory = h.advisor.classify({ ...input, host: "localhost" }, 20000)
		expect(advisory.level).toBe("none")
		expect(advisory).not.toHaveProperty("lossReason")
	})
})

describe("cause latch", () => {
	it("keeps a known cause for the window, then decides afresh", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		const decided = h.now
		expect(h.classify().lossReason).toBe("source")
		Object.assign(h.evidence, { elu: 0.98, loopDelayMaxMs: 2400 })
		h.setNow(decided + 2000)
		expect(h.classify().lossReason).toBe("source")
		h.setNow(decided + LINK_SUSTAINED_WINDOW_MS - 1)
		expect(h.classify().lossReason).toBe("source")
		h.setNow(decided + LINK_SUSTAINED_WINDOW_MS)
		expect(h.classify().lossReason).toBe("core-busy")
	})
	it("never latches unknown", () => {
		const h = harness({ elu: null, loopDelayMaxMs: 0, arrivalGapMaxMs: 0 })
		h.window(SHORT)
		expect(h.classify().lossReason).toBe("unknown")
		h.evidence.elu = 0.98
		expect(h.classify().lossReason).toBe("core-busy")
	})
	it("leaving dropping drops the latch", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(PAYLOAD)
		// Upstream drops make it dropping without moving the clock.
		expect(h.advisor.classify(input, 10001).lossReason).toBe("source")
		Object.assign(h.evidence, { elu: 0.98, loopDelayMaxMs: 2400 })
		expect(h.advisor.classify(input, 10001).lossReason).toBe("source")
		expect(h.advisor.classify(input, 0).level).not.toBe("dropping")
		expect(h.advisor.classify(input, 10001).lossReason).toBe("core-busy")
	})
	it("a classification at another rate neither reads nor clears the latch", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		expect(h.classify().lossReason).toBe("source")
		Object.assign(h.evidence, { elu: 0.98, loopDelayMaxMs: 2400 })
		// A hypothetical raise has no received history, so it is not dropping.
		expect(h.classify(RATE * 2).level).not.toBe("dropping")
		expect(h.classify().lossReason).toBe("source")
	})
	it("reset clears the latch", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(PAYLOAD)
		expect(h.advisor.classify(input, 10001).lossReason).toBe("source")
		h.advisor.reset("s")
		h.evidence.elu = 0.98
		expect(h.advisor.classify(input, 10001).lossReason).toBe("core-busy")
	})
})

describe("remediation", () => {
	it("a source loss at rate R leaves dropping once the link sustains R/2", () => {
		const h = harness({ elu: 0.2, loopDelayMaxMs: 0, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		expect(h.classify()).toMatchObject({
			level: "dropping",
			lossReason: "source",
		})
		// Lower the sample rate: the same link now carries the whole payload.
		const half = RATE / 2
		h.window(half * 2, half)
		const after = h.classify(half)
		expect(after.level).toBe("none")
		expect(after).not.toHaveProperty("lossReason")
	})
})
