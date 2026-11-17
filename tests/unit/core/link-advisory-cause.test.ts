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
	INGEST_CELL_MS,
	LINK_GAP_MS,
	SOURCE_METRICS_INTERVAL_MS,
} from "../../../src/core/link-burst/contract.js"
import { LINK_SUSTAINED_WINDOW_MS } from "../../../src/core/rate-policy-contract.js"

const RATE = 2_400_000
const PAYLOAD = RATE * 2
// 2 % below the payload: past the 1 % shortfall bound, so `dropping`.
const SHORT = PAYLOAD * 0.98
const input = { sourceId: "s", host: "source.invalid", sampleRateHz: RATE }

interface Evidence {
	eluMax: number | null
	eluComplete: boolean
	eluLive: number | null
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
			elu: null,
			eluMax: evidence.eluMax,
			eluComplete: evidence.eluComplete,
			eluLive: evidence.eluLive,
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

const load = (eluMax: number | null, loopDelayMaxMs: number | null) => ({
	elu: null,
	eluMax,
	eluComplete: eluMax !== null,
	eluLive: null,
	loopDelayMaxMs,
})

const quiet: Evidence = {
	eluMax: 0.3,
	eluComplete: true,
	eluLive: null,
	loopDelayMaxMs: 0,
	arrivalGapMaxMs: 0,
}

describe("dropping cause ladder", () => {
	it.each<[string, Evidence, string]>([
		// Step 1: the worst take or the loop delay at the busy bounds.
		["worst take at 0.90", { ...quiet, eluMax: CORE_BUSY_ELU }, "core-busy"],
		[
			"worst take 0.98 beats a link-like gap: the link was not assessed",
			{ ...quiet, eluMax: 0.98, arrivalGapMaxMs: 1000 },
			"core-busy",
		],
		[
			"an incomplete read still asserts a busy take",
			{ ...quiet, eluMax: 0.95, eluComplete: false },
			"core-busy",
		],
		[
			"loop delay at 200 ms beats a gap beyond it",
			{
				...quiet,
				loopDelayMaxMs: LINK_GAP_MS,
				arrivalGapMaxMs: 3 * LINK_GAP_MS,
			},
			"core-busy",
		],
		[
			"saturated take, other evidence missing",
			{
				eluMax: 0.95,
				eluComplete: false,
				eluLive: null,
				loopDelayMaxMs: null,
				arrivalGapMaxMs: null,
			},
			"core-busy",
		],
		[
			"loop delay at the bound, utilisation missing",
			{
				...quiet,
				eluMax: null,
				eluComplete: false,
				loopDelayMaxMs: LINK_GAP_MS,
			},
			"core-busy",
		],
		[
			"worst take just under 0.90, no other evidence",
			{ ...quiet, eluMax: 0.8999 },
			"unknown",
		],
		// Step 2: a gap the loop cannot explain, at and below 200 ms.
		[
			"gap excess at 200 ms",
			{ ...quiet, eluMax: 0.8, loopDelayMaxMs: 100, arrivalGapMaxMs: 300 },
			"source",
		],
		[
			"gap excess at 200 ms with utilisation missing",
			{
				...quiet,
				eluMax: null,
				eluComplete: false,
				arrivalGapMaxMs: LINK_GAP_MS,
			},
			"source",
		],
		[
			"gap excess 199 ms with a 100 ms loop delay",
			{ ...quiet, eluMax: 0.5, loopDelayMaxMs: 100, arrivalGapMaxMs: 299 },
			"unknown",
		],
		[
			"loop delay just under 200 ms",
			{ ...quiet, loopDelayMaxMs: LINK_GAP_MS - 0.1 },
			"unknown",
		],
		// Step 3: every take with headroom, at and past 50 ms and 0.70.
		[
			"loop 49.9 ms, worst take 0.69",
			{ ...quiet, eluMax: 0.69, loopDelayMaxMs: HOST_LOOP_DELAY_MS - 0.1 },
			"source",
		],
		[
			"loop at 50 ms",
			{ ...quiet, loopDelayMaxMs: HOST_LOOP_DELAY_MS },
			"unknown",
		],
		["worst take at 0.70", { ...quiet, eluMax: SOURCE_ELU_MAX }, "unknown"],
		[
			"an incomplete read never proves headroom",
			{ ...quiet, eluComplete: false },
			"unknown",
		],
		[
			"a busy in-progress take vetoes source",
			{ ...quiet, eluLive: SOURCE_ELU_MAX },
			"unknown",
		],
		[
			"a quiet in-progress take does not",
			{ ...quiet, eluLive: 0.69 },
			"source",
		],
		[
			"a saturated in-progress take never asserts core-busy",
			{ ...quiet, eluLive: 1 },
			"unknown",
		],
		// Step 4: missing or malformed evidence.
		["worst take missing", { ...quiet, eluMax: null }, "unknown"],
		["loop delay missing", { ...quiet, loopDelayMaxMs: null }, "unknown"],
		["gap missing", { ...quiet, arrivalGapMaxMs: null }, "unknown"],
		["worst take NaN", { ...quiet, eluMax: Number.NaN }, "unknown"],
		["worst take above 1", { ...quiet, eluMax: 1.5 }, "unknown"],
		["loop delay infinite", { ...quiet, loopDelayMaxMs: Infinity }, "unknown"],
		["gap negative", { ...quiet, arrivalGapMaxMs: -1 }, "unknown"],
		[
			"loop delay missing, gap large",
			{ ...quiet, loopDelayMaxMs: null, arrivalGapMaxMs: 1000 },
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
		// Takes over W; loop evidence from one recorder cell before it.
		expect(h.coreLoad).toHaveBeenCalledWith(h.now - LINK_SUSTAINED_WINDOW_MS)
		expect(h.coreLoad).toHaveBeenCalledWith(
			h.now - LINK_SUSTAINED_WINDOW_MS - INGEST_CELL_MS,
		)
		expect(h.arrivalGapMaxMs).toHaveBeenCalledWith(
			"s",
			h.now - LINK_SUSTAINED_WINDOW_MS,
		)
	})
	it("looks back to the observation bounding the averaged window, at most 15 s", () => {
		const h = harness(quiet)
		h.window(SHORT)
		// The average still ends at the last observation 4 s ago: its first interval
		// starts 14 s ago.
		h.setNow(h.now + 4000)
		h.classify()
		expect(h.arrivalGapMaxMs).toHaveBeenLastCalledWith("s", h.now - 14_000)
		// Irregular metrics never stretch the lookback past the bound.
		const g = harness(quiet)
		for (const at of [0, 11_000, 16_000])
			g.advisor.observe("s", SHORT, RATE, at)
		g.setNow(16_000)
		g.classify()
		expect(g.arrivalGapMaxMs).toHaveBeenLastCalledWith(
			"s",
			16_000 - LINK_SUSTAINED_WINDOW_MS - SOURCE_METRICS_INTERVAL_MS,
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
		h.coreLoad.mockImplementation(() => load(0.3, 0))
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
				coreLoad: () => load(0.2, 0),
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
		for (const eluMax of [0.98, 0.5]) {
			const h = harness({
				...quiet,
				eluMax,
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
		const h = harness({ ...quiet, eluMax: 0.2, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		expect(h.classify()).toMatchObject({
			level: "dropping",
			lossReason: "source",
		})
	})
	it("upstream drops alone are dropping with a cause", () => {
		const h = harness({ ...quiet, eluMax: 0.2 })
		h.window(PAYLOAD)
		expect(h.advisor.classify(input, 10001)).toMatchObject({
			level: "dropping",
			lossReason: "source",
		})
	})
	it("without an average W is the sustained window", () => {
		const h = harness({ ...quiet, eluMax: 0.2 })
		h.setNow(30_000)
		h.advisor.classify(input, 10001)
		expect(h.arrivalGapMaxMs).toHaveBeenLastCalledWith(
			"s",
			h.now - LINK_SUSTAINED_WINDOW_MS,
		)
	})
	it("loopback never carries a cause", () => {
		const h = harness({ ...quiet, eluMax: 0.98, loopDelayMaxMs: 2400 })
		h.window(SHORT)
		const advisory = h.advisor.classify({ ...input, host: "localhost" }, 20000)
		expect(advisory.level).toBe("none")
		expect(advisory).not.toHaveProperty("lossReason")
	})
})

describe("a stateless cause", () => {
	it("follows the evidence at every recheck: no latch, no hold", () => {
		const h = harness({ ...quiet, eluMax: 0.2, arrivalGapMaxMs: 1000 })
		h.window(SHORT)
		expect(h.classify().lossReason).toBe("source")
		Object.assign(h.evidence, { eluMax: 0.98, loopDelayMaxMs: 2400 })
		expect(h.classify().lossReason).toBe("core-busy")
		Object.assign(h.evidence, { eluMax: 0.8, loopDelayMaxMs: 5 })
		h.arrivalGapMaxMs.mockImplementation(() => 0)
		expect(h.classify().lossReason).toBe("unknown")
		Object.assign(h.evidence, { eluMax: 0.3 })
		expect(h.classify().lossReason).toBe("source")
	})
	it("leaving dropping, a rate change or a reset carries nothing over", () => {
		const h = harness({ ...quiet, eluMax: 0.98 })
		h.window(PAYLOAD)
		expect(h.advisor.classify(input, 10001).lossReason).toBe("core-busy")
		expect(h.advisor.classify(input, 0).level).not.toBe("dropping")
		// A hypothetical raise has no received history, so it is not dropping.
		expect(h.classify(RATE * 2).level).not.toBe("dropping")
		h.advisor.reset("s")
		h.evidence.eluMax = 0.3
		expect(h.advisor.classify(input, 10001).lossReason).toBe("source")
	})
})

describe("excluded source cause", () => {
	it("reads unknown while excluded, and source again once it is not or it throws", () => {
		let excluded: boolean | Error = true
		let now = 0
		const advisor = createLinkAdvisor({
			now: () => now,
			monoNow: () => now,
			coreLoad: () => load(0.2, 0),
			arrivalGapMaxMs: () => 1000,
			sourceCauseExcluded: () => {
				if (excluded instanceof Error) throw excluded
				return excluded
			},
		})
		for (const at of [0, 5000, 10000]) advisor.observe("s", SHORT, RATE, at)
		now = 10000
		expect(advisor.classify(input, null).lossReason).toBe("unknown")
		excluded = false
		expect(advisor.classify(input, null).lossReason).toBe("source")
		excluded = new Error("unreadable")
		expect(advisor.classify(input, null).lossReason).toBe("source")
		// Never a core-busy cause.
		excluded = true
		const busy = createLinkAdvisor({
			now: () => now,
			monoNow: () => now,
			coreLoad: () => load(0.98, 0),
			arrivalGapMaxMs: () => 0,
			sourceCauseExcluded: () => true,
		})
		for (const at of [0, 5000, 10000]) busy.observe("s", SHORT, RATE, at)
		expect(busy.classify(input, null).lossReason).toBe("core-busy")
	})
})

describe("remediation", () => {
	it("a source loss at rate R leaves dropping once the link sustains R/2", () => {
		const h = harness({ ...quiet, eluMax: 0.2, arrivalGapMaxMs: 1000 })
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
