import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { LiveAudioStatus, TunerState } from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { createDataLayer } from "../../src/data/index.ts"
import type { DataLayer, FetchLike } from "../../src/data/index.ts"
import {
	planTune,
	scanHasReceiver,
	tuneContext,
	TuningController,
	captureOf,
	type TuneContext,
} from "../../src/features/tuning.ts"
import { fakeSockets } from "../data/fake-socket.ts"

const ctx = (over: Partial<TuneContext> = {}): TuneContext => ({
	centreHz: 161_500_000,
	sampleRateHz: 2_400_000,
	offsetHz: 0,
	bandwidthHz: 12_500,
	offsetAvailable: true,
	...over,
})

describe("planTune (the tuning rule)", () => {
	it("moves the live-audio offset inside the usable window", () => {
		expect(planTune(161_150_000, ctx())).toEqual({
			kind: "offset",
			hz: 161_150_000,
			offsetHz: -350_000,
		})
		expect(planTune(162_400_000, ctx())).toEqual({
			kind: "offset",
			hz: 162_400_000,
			offsetHz: 900_000,
		})
	})

	it("recentres the hardware outside the window, offset back to 0", () => {
		expect(planTune(446_006_250, ctx())).toEqual({
			kind: "recentre",
			hz: 446_006_250,
			centreHz: 446_006_250,
			offsetHz: 0,
		})
	})

	it("keeps the channel inside the core's usable 80 % (identify's window), less half its bandwidth", () => {
		expect(captureOf(ctx())).toEqual({
			startHz: 160_300_000,
			endHz: 162_700_000,
		})
		// 10 % of 2.4 MS/s is unusable at each edge, then half of the 12.5 kHz channel
		const edge = 162_700_000 - 240_000 - 6_250
		expect(planTune(edge, ctx()).kind).toBe("offset")
		expect(planTune(edge + 1, ctx()).kind).toBe("recentre")
		const low = 160_300_000 + 240_000 + 6_250
		expect(planTune(low, ctx()).kind).toBe("offset")
		expect(planTune(low - 1, ctx()).kind).toBe("recentre")
		expect(
			planTune(162_700_000 - 315_000, ctx({ bandwidthHz: 150_000 })).kind,
		).toBe("offset")
		expect(
			planTune(162_700_000 - 314_999, ctx({ bandwidthHz: 150_000 })).kind,
		).toBe("recentre")
	})

	it("always recentres when live audio cannot take an offset", () => {
		expect(planTune(161_150_000, ctx({ offsetAvailable: false })).kind).toBe(
			"recentre",
		)
		expect(planTune(161_150_000, ctx({ sampleRateHz: 0 })).kind).toBe(
			"recentre",
		)
	})

	it("does nothing when already tuned there (centre + offset)", () => {
		expect(planTune(161_150_000, ctx({ offsetHz: -350_000 }))).toEqual({
			kind: "none",
			hz: 161_150_000,
		})
	})

	it("rounds to whole Hz", () => {
		expect(planTune(161_150_000.4, ctx())).toMatchObject({ offsetHz: -350_000 })
	})

	it("the plan always lands the tuned frequency on the target (seeded)", () => {
		let seed = 11
		const rand = () =>
			(seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31
		for (let i = 0; i < 300; i++) {
			const c = ctx({
				centreHz: 100_000_000 + Math.round(rand() * 1e9),
				offsetHz: Math.round((rand() - 0.5) * 1e6),
				bandwidthHz: Math.round(rand() * 200_000),
				offsetAvailable: rand() > 0.2,
			})
			const hz = c.centreHz + Math.round((rand() - 0.5) * 6e6)
			const plan = planTune(hz, c)
			const tuned =
				plan.kind === "none"
					? c.centreHz + c.offsetHz
					: plan.kind === "offset"
						? c.centreHz + plan.offsetHz
						: plan.centreHz + plan.offsetHz
			expect(tuned).toBe(hz)
			if (plan.kind === "offset")
				expect(Math.abs(plan.offsetHz)).toBeLessThanOrEqual(
					c.sampleRateHz / 2 -
						Math.max(c.bandwidthHz / 2, c.sampleRateHz * 0.02),
				)
		}
	})
})

describe("tuneContext", () => {
	const tuner = {
		sourceId: "pi",
		frequency: 161_500_000,
		sampleRate: 2_400_000,
	} as TunerState
	const status = (sourceId: string) =>
		({
			sourceId,
			config: { bandwidth: 12_500, offsetHz: 2000 },
		}) as LiveAudioStatus

	it("reads the rule's inputs from the stores", () => {
		expect(tuneContext(tuner, status("pi"))).toEqual({
			centreHz: 161_500_000,
			sampleRateHz: 2_400_000,
			offsetHz: 2000,
			bandwidthHz: 12_500,
			offsetAvailable: true,
		})
		expect(tuneContext(tuner, status("other"))?.offsetAvailable).toBe(false)
		expect(tuneContext(tuner, null)?.offsetAvailable).toBe(false)
		expect(tuneContext(undefined, status("pi"))).toBeNull()
	})
})

describe("TuningController against the mock core", () => {
	let server: MockServer
	let data: DataLayer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioOrigin: "http://localhost:3102",
		})
		await server.app.ready()
		const fetch: FetchLike = async (input, init) => {
			const res = await server.app.inject({
				method: (init?.method ?? "GET") as "GET",
				url: input,
				...(typeof init?.body === "string" ? { payload: init.body } : {}),
				headers: { "content-type": "application/json" },
			})
			return new Response(res.body.length ? res.body : null, {
				status: res.statusCode,
				headers: { "Content-Type": "application/json" },
			})
		}
		const { factory } = fakeSockets()
		data = createDataLayer({ fetch, createSocket: factory, wsUrl: "ws://x/ws" })
		await data.start()
	})
	afterAll(async () => {
		data.dispose()
		await server.close()
	})

	it("tunes inside the window by offset and outside by recentring", async () => {
		const tuning = new TuningController(data)
		const centre = data.tuner.state()?.frequency ?? 0
		await tuning.tune(centre - 350_000)
		expect(data.tuner.state()?.frequency).toBe(centre)
		expect(data.liveAudio.get().status?.config.offsetHz).toBe(-350_000)
		expect(tuning.displayHz()).toBe(centre - 350_000)

		await tuning.tune(446_006_250)
		expect(data.tuner.state()?.frequency).toBe(446_006_250)
		expect(data.liveAudio.get().status?.config.offsetHz).toBe(0)
		expect(tuning.get()).toEqual({ targetHz: null, error: null })
	})

	it("shows the target at once and keeps only the latest while one runs", async () => {
		const tuning = new TuningController(data)
		const first = tuning.tune(161_000_000)
		expect(tuning.get().targetHz).toBe(161_000_000)
		void tuning.tune(161_100_000)
		void tuning.tune(161_150_000)
		expect(tuning.displayHz()).toBe(161_150_000)
		await first
		expect(tuning.get().targetHz).toBeNull()
		expect(tuning.displayHz()).toBe(161_150_000)
		// 161.0 recentred; 161.15 is then inside the window: one offset PATCH, 161.1 skipped
		expect(data.tuner.state()?.frequency).toBe(161_000_000)
		expect(data.liveAudio.get().status?.config.offsetHz).toBe(150_000)
	})

	it("keeps the core's error and clears the target", async () => {
		const tuning = new TuningController(data)
		await tuning.tune(2_000_000_000) // the core's rtl_tcp range stops at 1900 MHz
		expect(tuning.get().targetHz).toBeNull()
		expect(tuning.get().error).toMatch(/frequency out of range/)
	})

	it("while a sweep has the receiver, a tune inside the window recentres so the scan pauses", async () => {
		const tuning = new TuningController(data)
		await tuning.tune(161_500_000)
		const job = await data.scanner.startJob(
			{
				mode: "sweep",
				ranges: [{ startHz: 156_000_000, endHz: 162_000_000 }],
				integrationMs: 5,
				dwellMs: 60_000,
				hold: { policy: "never" },
			},
			{ takeover: true },
		)
		expect(scanHasReceiver(data.scanner.get().sweep)).toBe(true)
		const jobState = async () =>
			(
				await server.app.inject({
					method: "GET",
					url: `/api/scanner/jobs/${job.id}`,
				})
			).json<{ state: string; reason?: string }>()
		for (let i = 0; i < 50 && (await jobState()).state !== "running"; i++)
			await new Promise(resolve => setTimeout(resolve, 20))
		await data.tuner.load()
		const centre = data.tuner.state()?.frequency ?? 0
		// well inside the capture: without a sweep this would be an offset PATCH only
		await tuning.tune(centre + 200_000)
		expect(data.tuner.state()?.frequency).toBe(centre + 200_000)
		expect(data.liveAudio.get().status?.config.offsetHz ?? 0).toBe(0)
		expect(await jobState()).toMatchObject({
			state: "paused",
			reason: "preempted-operator",
		})
		await server.app.inject({
			method: "POST",
			url: `/api/scanner/jobs/${job.id}/cancel`,
		})
		expect(scanHasReceiver(null)).toBe(false)
		expect(scanHasReceiver({ state: "paused" })).toBe(false)
		expect(scanHasReceiver({ state: "holding" })).toBe(true)
	})
})
