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

	describe("cap dep snapshot and validation", () => {
		const FLOOR_VIEW = { setting: "auto", cap: 2048, source: "fallback" }
		async function statusOf(dep: () => unknown) {
			const h = makeService({
				summaryBins: 8192,
				binsCap: dep as () => SpectrumBinsCapView,
			})
			await h.service.start()
			await h.service.acquire("rtl", "job:a")
			const engineBins = h.host().cfg.spectrumBins
			const limits = h.service.status().limits
			await h.service.stop()
			return { engineBins, limits }
		}

		it.each<[string, () => unknown]>([
			["cap only", () => ({ cap: 8192 })],
			[
				"fallback with cap 8192",
				() => ({ setting: "auto", cap: 8192, source: "fallback" }),
			],
			[
				"config with setting !== cap",
				() => ({ setting: 2048, cap: 8192, source: "config" }),
			],
			[
				"measured with a fixed setting",
				() => ({ setting: 8192, cap: 8192, source: "measured" }),
			],
			[
				"unknown source",
				() => ({ setting: "auto", cap: 8192, source: "guess" }),
			],
			[
				"unknown setting",
				() => ({ setting: 3000, cap: 8192, source: "measured" }),
			],
			["null", () => null],
			["a string", () => "8192"],
		])(
			"a malformed or contradictory view (%s) answers the floor",
			async (_n, dep) => {
				const r = await statusOf(dep)
				expect(r.limits.binsCap).toEqual(FLOOR_VIEW)
				expect(r.limits.bins.max).toBe(PROFILE_BINS_FLOOR)
				expect(r.engineBins).toBe(PROFILE_BINS_FLOOR)
			},
		)

		it("each field is read once: a changing getter cannot desync status and clamp", async () => {
			let reads = 0
			const view = {
				setting: "auto",
				source: "measured",
				get cap() {
					reads++
					return reads === 1 ? 8192 : 4096
				},
			}
			const r = await statusOf(() => view)
			expect(reads).toBe(1)
			expect(r.limits.binsCap).toEqual({
				setting: "auto",
				cap: 8192,
				source: "measured",
			})
			expect(r.limits.bins.max).toBe(8192)
			expect(r.engineBins).toBe(8192)
		})

		it("a getter that throws answers the floor", async () => {
			const r = await statusOf(() => ({
				setting: "auto",
				source: "measured",
				get cap(): number {
					throw new Error("x")
				},
			}))
			expect(r.limits.binsCap).toEqual(FLOOR_VIEW)
		})

		it("extra fields on the view are not echoed into status", async () => {
			const r = await statusOf(() => ({
				setting: 4096,
				cap: 4096,
				source: "config",
				secret: "do-not-echo",
				measurements: [1, 2, 3],
			}))
			expect(r.limits.binsCap).toEqual({
				setting: 4096,
				cap: 4096,
				source: "config",
			})
			expect(JSON.stringify(r.limits)).not.toContain("do-not-echo")
		})
	})

	describe("every served profile stays within limits.bins.max", () => {
		async function setup(maxProfiles: number) {
			const h = makeService({ summaryBins: 512, binsCap: () => view(8192) })
			h.settings.ws.spectrumBins = 2048
			h.settings.ws.spectrumMaxProfiles = maxProfiles
			await h.service.start()
			await h.service.acquire("rtl", "job:a")
			h.host().epoch(1, true)
			for (let i = 0; i < 3; i++) h.host().summary(1, i, 512)
			return h
		}

		it("omitted bins take the default bounded to the client max (512, not 2048)", async () => {
			const h = await setup(4)
			const max = h.service.status().limits.bins.max
			expect(max).toBe(512)
			expect(h.service.status().defaultProfile.bins).toBe(512)
			await h.service.subscribe("c1", { sourceId: "rtl" })
			const ack = h.profiles.at(-1)!.ack
			expect(ack.profile!.bins).toBe(512)
			expect(ack.outcome).toBe("exact")
			expect(ack.adjusted).toEqual([])
			await h.service.subscribe("c2", undefined)
			expect(h.profiles.at(-1)!.ack.profile!.bins).toBe(512)
			await h.service.stop()
		})

		it("an admission fallback to the default never exceeds the bound", async () => {
			const h = await setup(1)
			await h.service.subscribe("a", { sourceId: "rtl", hz: 0.5, bins: 512 })
			expect(h.profiles.at(-1)!.ack.profile).toMatchObject({
				hz: 0.5,
				bins: 512,
			})
			await h.service.subscribe("b", { sourceId: "rtl", hz: 10, bins: 128 })
			const ack = h.profiles.at(-1)!.ack
			expect(ack.profile).toMatchObject({ key: "10:512", hz: 10, bins: 512 })
			expect(ack.adjusted).toContain("profile-limit")
			for (const p of h.service.status().profiles)
				expect(p.bins).toBeLessThanOrEqual(512)
			await h.service.stop()
		})
	})
})
