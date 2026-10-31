import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	SOURCE_RESUME_FAILED_MESSAGE,
	type DecoderInfo,
	type ExtendedSourceStatus,
	type SourceFeedResponse,
	type TunerState,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import { DEFAULT_CENTER_HZ } from "../../mock/data.ts"
import { resumeBodyOf } from "../../mock/source-feed.ts"

describe("mock receiver feed", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0, resumeMs: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const post = (url: string) => server.app.inject({ method: "POST", url })
	const source = async () =>
		(await server.app.inject({ method: "GET", url: "/api/sources" })).json<
			ExtendedSourceStatus[]
		>()[0]
	const decoders = async () =>
		(await server.app.inject({ method: "GET", url: "/api/decoders" })).json<
			DecoderInfo[]
		>()

	it("pauses, holds the source's decoders back and resumes, idempotently", async () => {
		const live = await source()
		expect(live?.feed?.state).toBe("live")
		expect(live?.connected).toBe(true)
		const wanted = (await decoders()).filter(
			d => d.sourceId === "rtl-0" && d.desiredRunning !== false,
		)
		expect(wanted.length).toBeGreaterThan(0)

		const paused = await post("/api/sources/rtl-0/pause")
		expect(paused.statusCode).toBe(200)
		expect(paused.json<SourceFeedResponse>()).toMatchObject({
			id: "rtl-0",
			changed: true,
			feed: { state: "paused" },
		})
		const again = await post("/api/sources/rtl-0/pause")
		expect(again.json<SourceFeedResponse>().changed).toBe(false)

		const held = await source()
		expect(held).toMatchObject({
			connected: false,
			dataRate: 0,
			feed: { state: "paused" },
			activity: { state: "disconnected" },
		})
		for (const d of (await decoders()).filter(x => x.sourceId === "rtl-0")) {
			if (d.desiredRunning === false || d.mode === "off") continue
			expect(d.running).toBe(false)
			expect(d.suspended).toBe(true)
			expect(d.suspension?.reasonCode).toBe("source-paused")
			expect(d.pid).toBeUndefined()
		}

		const resumed = await post("/api/sources/rtl-0/resume")
		expect(resumed.statusCode).toBe(200)
		expect(resumed.json<SourceFeedResponse>()).toMatchObject({
			changed: true,
			feed: { state: "live" },
		})
		expect((await post("/api/sources/rtl-0/resume")).json()).toMatchObject({
			changed: false,
		})
		expect((await source())?.connected).toBe(true)
		expect(
			(await decoders()).some(
				d => d.suspension?.reasonCode === "source-paused",
			),
		).toBe(false)
	})

	it("answers a failed resume with the core's 503 and keeps the source paused until a retry works", async () => {
		await post("/api/sources/rtl-0/pause")
		server.feed.failNextResumes(1)
		const failed = await post("/api/sources/rtl-0/resume")
		expect(failed.statusCode).toBe(503)
		expect(failed.json()).toMatchObject({
			code: "SOURCE_RESUME_FAILED",
			message: SOURCE_RESUME_FAILED_MESSAGE,
			id: "rtl-0",
			feed: { state: "error", error: SOURCE_RESUME_FAILED_MESSAGE },
		})
		expect((await source())?.feed?.state).toBe("error")
		expect((await source())?.connected).toBe(false)
		const retry = await post("/api/sources/rtl-0/resume")
		expect(retry.statusCode).toBe(200)
		expect(retry.json<SourceFeedResponse>().feed.state).toBe("live")
	})

	it("pausing a failed resume reads paused again (changed)", async () => {
		await post("/api/sources/rtl-0/pause")
		server.feed.failNextResumes(1)
		await post("/api/sources/rtl-0/resume")
		const paused = await post("/api/sources/rtl-0/pause")
		expect(paused.json<SourceFeedResponse>()).toMatchObject({
			changed: true,
			feed: { state: "paused" },
		})
		await post("/api/sources/rtl-0/resume")
	})

	it("answers an unknown source with SOURCE_NOT_FOUND", async () => {
		for (const op of ["pause", "resume"]) {
			const res = await post(`/api/sources/nope/${op}`)
			expect(res.statusCode).toBe(404)
			expect(res.json()).toMatchObject({ code: "SOURCE_NOT_FOUND" })
		}
	})

	it("the held feed carries the pre-pause tuning; a plain resume keeps a retune, a restore resume undoes it", async () => {
		const tuner = async () =>
			(await server.app.inject({ method: "GET", url: "/api/tuner" })).json<
				Array<{ sourceId: string; frequency: number }>
			>()[0]?.frequency
		const paused = await post("/api/sources/rtl-0/pause")
		expect(paused.json<SourceFeedResponse>().feed.restoreTuning).toMatchObject({
			centerFreq: DEFAULT_CENTER_HZ,
		})
		expect((await source())?.feed?.restoreTuning?.centerFreq).toBe(
			DEFAULT_CENTER_HZ,
		)
		const retune = () =>
			server.app.inject({
				method: "POST",
				url: "/api/tuner/rtl-0/frequency",
				payload: { hz: 433_920_000 },
			})
		await retune()
		const plain = await post("/api/sources/rtl-0/resume")
		expect(plain.json<SourceFeedResponse>().feed.restoreTuning).toBeUndefined()
		expect(await tuner()).toBe(433_920_000)

		// paused again at 433.92 MHz: that is now the pre-pause centre
		await post("/api/sources/rtl-0/pause")
		await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: DEFAULT_CENTER_HZ },
		})
		const restore = await server.app.inject({
			method: "POST",
			url: "/api/sources/rtl-0/resume",
			payload: { restoreTuning: true },
		})
		expect(restore.statusCode).toBe(200)
		expect(await tuner()).toBe(433_920_000)
		// back where the earlier tests expect it
		await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: DEFAULT_CENTER_HZ },
		})
	})

	it("a plain resume leaves centre, rate and gain unverified until set, as the core", async () => {
		const measured = await buildMockServer({
			port: 0,
			resumeMs: 0,
			measuredRateHz: 2_160_000,
		})
		await measured.app.ready()
		const state = async () =>
			(await measured.app.inject({ method: "GET", url: "/api/tuner" })).json<
				TunerState[]
			>()[0]
		const call = (url: string, payload?: object) =>
			measured.app.inject({
				method: "POST",
				url,
				...(payload ? { payload } : {}),
			})
		await call("/api/sources/rtl-0/pause")
		await call("/api/sources/rtl-0/resume")
		const after = await state()
		expect(after?.unknownFields).toEqual(
			expect.arrayContaining(["frequency", "sampleRate", "gainMode", "gain"]),
		)
		expect(after).toMatchObject({
			sampleRate: 2_160_000,
			measuredFields: ["sampleRate"],
		})
		// setting the rate and the centre makes them known again (no longer measured)
		await call("/api/tuner/rtl-0/sample-rate", { hz: 2_400_000 })
		await call("/api/tuner/rtl-0/frequency", { hz: DEFAULT_CENTER_HZ })
		const set = await state()
		expect(set?.measuredFields).toBeUndefined()
		expect(set?.unknownFields ?? []).not.toContain("sampleRate")
		expect(set?.unknownFields ?? []).not.toContain("frequency")
		await measured.close()
	})

	it("rejects a resume body other than { restoreTuning: boolean } with 400, as the core", async () => {
		expect(resumeBodyOf(undefined)).toEqual({ restoreTuning: false })
		expect(resumeBodyOf({})).toEqual({ restoreTuning: false })
		expect(resumeBodyOf({ restoreTuning: true })).toEqual({
			restoreTuning: true,
		})
		for (const payload of [
			{ restoreTuning: "yes" },
			{ restoreTuning: true, extra: 1 },
			{ restore: true },
		]) {
			const res = await server.app.inject({
				method: "POST",
				url: "/api/sources/rtl-0/resume",
				payload,
			})
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "INVALID_RESUME_REQUEST" })
		}
		expect(resumeBodyOf([true])).toBeNull()
	})
})
