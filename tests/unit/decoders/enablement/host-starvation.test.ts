import { describe, expect, it } from "vitest"
import {
	HOST_STARVATION_BRANCHES_MIN,
	HOST_STARVATION_WINDOW_MS,
	hostStarvedAt,
	lossCause,
	ownLoss,
} from "../../../../src/decoders/enablement/host-starvation.js"
import {
	EFFICIENCY_RETRY_MAX_MS,
	EFFICIENCY_RETRY_MS,
	TUNED_RETRY_MAX_MS,
	TUNED_RETRY_MS,
	lossRetryMs,
} from "../../../../src/decoders/enablement/contract.js"
import type { ChargedDrop } from "../../../../src/decoders/enablement/contract.js"
import { HOST_BUSY_HOLD_MS } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	LIVE,
	SAMPLE_MS,
	starvationHarness,
} from "./host-starvation-harness.js"

const drop = (
	atMono: number,
	branches: readonly string[] | "source",
	code: ChargedDrop["code"] = "consumer",
): ChargedDrop => ({ atMono, branches, code })

describe("host-starvation classifier", () => {
	it("states its window and branch threshold", () => {
		// The late-drop window: 5 samples of 2000 ms.
		expect(HOST_STARVATION_WINDOW_MS).toBe(10_000)
		expect(HOST_STARVATION_BRANCHES_MIN).toBe(2)
	})

	it.each([
		[HOST_STARVATION_WINDOW_MS - 1, true],
		[HOST_STARVATION_WINDOW_MS, true],
		[HOST_STARVATION_WINDOW_MS + 1, false],
	])(
		"a sibling's drop %i ms after reads as host starvation: %s",
		(gap, host) => {
			const drops = [drop(20_000, ["r"]), drop(20_000 + gap, [LIVE])]
			expect(hostStarvedAt(drops, 20_000)).toBe(host)
			expect(ownLoss(drops, "r", 0, Infinity)).toBe(!host)
		},
	)

	it("one branch alone on a healthy host is the decoder's own loss", () => {
		const drops = [drop(2_000, ["r"]), drop(4_000, ["r"])]
		expect(hostStarvedAt(drops, 4_000)).toBe(false)
		expect(lossCause(drops, 4_000)).toEqual({
			cause: "decoder",
			congestedBranches: 1,
		})
	})

	it("a host-attributed sample (loop lag or host CPU) is host loss", () => {
		const drops = [drop(2_000, ["r"], "host")]
		expect(ownLoss(drops, "r", 0, Infinity)).toBe(false)
		expect(lossCause(drops, 2_000)?.cause).toBe("host")
	})

	it("source-wide loss alone is not host evidence", () => {
		const drops = [drop(2_000, ["r"]), drop(2_000, "source", "unknown")]
		expect(ownLoss(drops, "r", 0, Infinity)).toBe(true)
	})

	it.each([
		[2_000 + HOST_STARVATION_WINDOW_MS - 1, false],
		[2_000 + HOST_STARVATION_WINDOW_MS, true],
	])("a drop is judged only once settled (sampled at %i): %s", (at, judged) => {
		expect(ownLoss([drop(2_000, ["r"])], "r", 0, Infinity, at)).toBe(judged)
	})

	it("no drops: no cause", () => {
		expect(lossCause([], 10_000)).toBeNull()
	})
})

describe("tuned retry backoff", () => {
	it("30 s first, doubling to a 240 s cap", () => {
		expect(TUNED_RETRY_MS).toBe(30_000)
		expect(TUNED_RETRY_MAX_MS).toBe(240_000)
		const delays: number[] = []
		let previous: number | undefined
		for (let i = 0; i < 6; i++)
			delays.push((previous = lossRetryMs(previous, true)))
		expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 240_000, 240_000])
	})

	it("untuned keeps 300 s doubling to 1 800 s", () => {
		const delays: number[] = []
		let previous: number | undefined
		for (let i = 0; i < 5; i++)
			delays.push((previous = lossRetryMs(previous, false)))
		expect(delays).toEqual([
			EFFICIENCY_RETRY_MS,
			600_000,
			1_200_000,
			EFFICIENCY_RETRY_MAX_MS,
			EFFICIENCY_RETRY_MAX_MS,
		])
	})

	it("a longer untuned history is capped for the tuned decoder", () => {
		expect(lossRetryMs(EFFICIENCY_RETRY_MAX_MS, true)).toBe(TUNED_RETRY_MAX_MS)
		expect(lossRetryMs(0, true)).toBe(TUNED_RETRY_MS)
		expect(lossRetryMs(Number.NaN, true)).toBe(TUNED_RETRY_MS)
	})
})

describe("gate: host starvation never sheds the tuned decoder", () => {
	it("congestion alternating between readsb and live audio across samples is host loss", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		// The reported pattern: readsb's branch and live audio congest in
		// alternate 2000 ms samples. Each sample alone is a strict subset (a
		// consumer), so the old per-sample rule shed readsb.
		for (let i = 0; i < 60; i++)
			h.tick([i % 2 === 0 ? h.branch("readsb") : LIVE])
		expect(h.shed).toEqual([])
		expect(h.isRunning("readsb")).toBe(true)
		expect(h.gate.hostBusy?.("a")).toMatchObject({
			cause: "host",
			congestedBranches: 2,
		})
	})

	it("event-loop lag with only readsb's branch dropping is host loss", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		for (let i = 0; i < 60; i++) h.tick([h.branch("readsb")], 80)
		expect(h.shed).toEqual([])
		expect(h.gate.hostBusy?.("a")).toMatchObject({
			cause: "host",
			loopLagMaxMs: 80,
			loopLagP99Ms: 40,
		})
	})

	it("host starvation sheds the untuned decoder (newest first), never the tuned one", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		// readsb's new branch changed the topology: an untuned newcomer waits
		// for a fresh 60 000 ms clear window.
		h.clean(64_000)
		h.start("ais", false)
		for (let i = 0; i < 60; i++)
			h.tick(
				i % 2 === 0
					? [h.branch("readsb"), h.branch("ais")]
					: [LIVE, h.branch("ais")],
			)
		expect(h.shed.map(s => [s.key, s.detail])).toEqual([["ais", "late-drops"]])
		expect(h.isRunning("readsb")).toBe(true)
	})

	it("a tuned probationer is not shed by host loss and graduates once it ends", () => {
		const h = starvationHarness()
		expect(h.admit("readsb", true)).toMatchObject({ admit: true })
		// Probation judges each drop on the evidence known then, so live
		// audio congests first: readsb's branch alone first would be its own.
		for (let i = 0; i < 10; i++)
			h.tick([i % 2 === 0 ? LIVE : h.branch("readsb")])
		expect(h.shed).toEqual([])
		h.clean(32_000)
		expect(h.probation("readsb")).toBe(false)
	})

	it("hostBusy holds 60 000 ms after the latest host loss, then clears", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		h.tick([h.branch("readsb"), LIVE])
		expect(HOST_BUSY_HOLD_MS).toBe(60_000)
		h.clean(HOST_BUSY_HOLD_MS)
		expect(h.gate.hostBusy?.("a")?.cause).toBe("host")
		h.tick()
		expect(h.gate.hostBusy?.("a")).toBeNull()
	})
})

describe("gate: the tuned decoder's own sustained loss", () => {
	it("sheds it, then re-admits it 30 s later once its source flows", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		// Only readsb's branch drops; live audio flows; the loop is healthy.
		let at: number | null = null
		for (let i = 0; i < 40 && at === null; i++) {
			h.tick([h.branch("readsb")])
			if (h.shed.length > 0) at = h.mono()
		}
		expect(h.shed).toEqual([{ key: "readsb", detail: "late-drops", at }])
		expect(h.gate.shedAttribution?.(h.keyOf("readsb"))).toEqual({
			tuned: true,
			attribution: {
				cause: "decoder",
				congestedBranches: 1,
				loopLagP99Ms: 2,
				loopLagMaxMs: 4,
			},
		})
		// Refused just before its 30 000 ms retry, admitted on probation at it.
		h.clean(30_000 - SAMPLE_MS)
		expect(h.admit("readsb", true)).toMatchObject({
			admit: false,
			detail: "late-drops",
			retryAtMs: at! + 30_000,
		})
		h.tick()
		expect(h.mono()).toBe(at! + 30_000)
		expect(h.admit("readsb", true)).toEqual({ admit: true })
		expect(h.probation("readsb")).toBe(true)
	})

	it("a second shed backs off 60 s", () => {
		const h = starvationHarness()
		h.start("readsb", true)
		const shedOnce = () => {
			const before = h.shed.length
			for (let i = 0; i < 60 && h.shed.length === before; i++)
				h.tick([h.branch("readsb")])
			expect(h.shed.length).toBe(before + 1)
			return h.mono()
		}
		const first = shedOnce()
		h.clean(30_000)
		expect(h.admit("readsb", true)).toEqual({ admit: true })
		const second = shedOnce()
		expect(second).toBeGreaterThan(first)
		h.clean(60_000 - SAMPLE_MS)
		expect(h.admit("readsb", true)).toMatchObject({
			admit: false,
			retryAtMs: second + 60_000,
		})
		h.tick()
		expect(h.admit("readsb", true)).toEqual({ admit: true })
	})
})
