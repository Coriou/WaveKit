import { describe, expect, it } from "vitest"
import type { SpectrumBinsCapView } from "@wavekit/api-types"
import {
	BACKFILL_LIMITS,
	PROFILE_BINS_CEILING,
	PROFILE_BINS_FLOOR,
} from "../../../../src/core/spectrum/subscribe-options.js"
import { decodeBins } from "../../../../src/core/spectrum/spectrum-service.js"
import { spectrumFrameJsonLength } from "../../../../src/core/spectrum/spectrum-backfill.js"
import {
	makeService,
	runScenario,
} from "./spectrum-service-bins-cap-harness.js"

const view = (cap: number): SpectrumBinsCapView => ({
	setting: cap as 2048 | 4096 | 8192,
	cap,
	source: "config",
})

async function bins(summaryBins: number, cap: number | null, ask: number) {
	const r = await runScenario(
		{ summaryBins, ...(cap === null ? {} : { binsCap: () => view(cap) }) },
		{ sourceId: "rtl", bins: ask, hz: 25 },
	)
	return {
		profileBins: r.logged!.ack.profile!.bins,
		adjusted: r.logged!.ack.adjusted,
		max: r.status.limits.bins.max,
		binsCap: r.status.limits.binsCap,
		frameBins: r.live[0]?.binCount,
	}
}

describe("spectrum bins cap (service and engine)", () => {
	it("cap 8192 with budget 8192: 8192 exact, 8193 clamps with adjusted bins", async () => {
		const exact = await bins(8192, 8192, 8192)
		expect(exact).toMatchObject({
			profileBins: 8192,
			adjusted: [],
			max: 8192,
			binsCap: view(8192),
			frameBins: 8192,
		})
		const over = await bins(8192, 8192, 8193)
		expect(over).toMatchObject({ profileBins: 8192, adjusted: ["bins"] })
	})

	it("cap 2048 with budget 8192 serves 2048", async () => {
		const r = await bins(8192, 2048, 8192)
		expect(r).toMatchObject({
			profileBins: 2048,
			adjusted: ["bins"],
			max: 2048,
			binsCap: view(2048),
		})
	})

	it("cap 8192 with budget 2048 serves 2048", async () => {
		const r = await bins(2048, 8192, 8192)
		expect(r).toMatchObject({ profileBins: 2048, max: 2048 })
		expect(r.binsCap).toEqual(view(8192))
	})

	it("cap 4096 with budget 8192 serves 4096 and the engine budget is the cap", async () => {
		const h = makeService({ summaryBins: 8192, binsCap: () => view(4096) })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		expect(h.host().cfg.spectrumBins).toBe(4096)
		expect(h.service.status().limits.bins.max).toBe(4096)
		await h.service.stop()
	})

	it("the engine budget is min(budget, floor) without the dep", async () => {
		const h = makeService({ summaryBins: 8192 })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		expect(h.host().cfg.spectrumBins).toBe(PROFILE_BINS_FLOOR)
		const status = h.service.status()
		expect("binsCap" in status.limits).toBe(false)
		await h.service.stop()
	})

	it.each([
		[
			"throws",
			() => {
				throw new Error("x")
			},
		],
		["NaN", () => NaN],
		["3000", () => 3000],
		["99999", () => 99999],
		["fractional", () => 4096.5],
		["a string", () => "8192"],
		["1024", () => 1024],
	])("a hostile dep (%s) falls back to the floor", async (_name, bad) => {
		const dep = (): SpectrumBinsCapView => ({
			setting: "auto",
			cap: bad() as number,
			source: "measured",
		})
		const r = await runScenario(
			{ summaryBins: 8192, binsCap: dep },
			{ sourceId: "rtl", bins: 8192, hz: 25 },
		)
		expect(r.logged!.ack.profile!.bins).toBe(PROFILE_BINS_FLOOR)
		expect(r.status.limits.bins.max).toBe(PROFILE_BINS_FLOOR)
		expect(r.status.limits.binsCap?.cap).toBe(PROFILE_BINS_FLOOR)
		expect(r.live[0]?.binCount).toBeLessThanOrEqual(PROFILE_BINS_FLOOR)
	})

	it("the ceiling constant is 8192 and no cap goes above it", () => {
		expect(PROFILE_BINS_CEILING).toBe(8192)
	})

	it("BACKFILL_LIMITS.maxBytes bounds serialized backfill of 8192-bin frames", async () => {
		const h = makeService({ summaryBins: 8192, binsCap: () => view(8192) })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host().epoch(1, true)
		for (let i = 0; i < 120; i++) h.host().summary(1, i, 8192)
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 8192,
			backfillMs: BACKFILL_LIMITS.maxMs,
		})
		const { ack, backfill, snapshots } = h.profiles.at(-1)!
		expect(ack.profile!.bins).toBe(8192)
		const sizes = backfill.map(f => spectrumFrameJsonLength(f))
		const total = sizes.reduce((a, b) => a + b, 0)
		expect(backfill.length).toBeGreaterThan(0)
		expect(backfill.length).toBeLessThan(BACKFILL_LIMITS.maxFrames)
		expect(total).toBeLessThanOrEqual(BACKFILL_LIMITS.maxBytes)
		// at the bound: one more frame would not fit, so the oldest were dropped by bytes
		expect(total + Math.max(...sizes)).toBeGreaterThan(BACKFILL_LIMITS.maxBytes)
		expect(ack.backfillFrames).toBe(backfill.length)
		expect(decodeBins(snapshots[0]!.bins)).toHaveLength(8192)
		await h.service.stop()
	})
})
