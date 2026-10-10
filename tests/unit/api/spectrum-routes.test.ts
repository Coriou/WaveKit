import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SpectrumStatus } from "@wavekit/api-types"
import {
	spectrumRoutes,
	type SpectrumRouteService,
} from "../../../src/api/routes/spectrum.js"

describe("spectrum routes", () => {
	let app: FastifyInstance
	const occupancyQuery = vi.fn((sourceId: string) =>
		sourceId === "rtl"
			? {
					sourceId,
					bucketHz: 12_500,
					sinceMs: 3_600_000,
					buckets: [
						{
							startHz: 446_187_500,
							dutyByHour: [null, 0.4],
							observedMs: 60_000,
							activeMs: 24_000,
						},
					],
					top: [
						{
							startHz: 446_187_500,
							duty: 0.4,
							observedMs: 60_000,
							activeMs: 24_000,
						},
					],
				}
			: null,
	)
	const status: SpectrumStatus = {
		defaultProfile: { key: "10:512", hz: 10, bins: 512 },
		profiles: [],
		limits: {
			maxProfiles: 4,
			hz: { min: 0.5, max: 25, step: 0.5 },
			bins: { min: 128, max: 2048 },
		},
		subscribers: 0,
		sources: [],
	}
	beforeEach(async () => {
		occupancyQuery.mockClear()
		app = Fastify({ logger: false })
		const service: SpectrumRouteService = {
			status: () => status,
			occupancyQuery,
		}
		await app.register(spectrumRoutes, { spectrum: service })
	})
	afterEach(async () => {
		await app.close()
	})

	it("serves the status", async () => {
		const res = await app.inject({ method: "GET", url: "/api/spectrum" })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({
			defaultProfile: { key: "10:512" },
			limits: { maxProfiles: 4 },
		})
	})

	it("queries occupancy with a default window and validates the range", async () => {
		const ok = await app.inject({
			method: "GET",
			url: "/api/spectrum/occupancy?sourceId=rtl&startHz=446000000&endHz=446200000",
		})
		expect(ok.statusCode).toBe(200)
		expect(occupancyQuery).toHaveBeenCalledWith(
			"rtl",
			{ startHz: 446_000_000, endHz: 446_200_000 },
			86_400_000,
		)
		expect(ok.json().top[0].duty).toBe(0.4)
		const inverted = await app.inject({
			method: "GET",
			url: "/api/spectrum/occupancy?sourceId=rtl&startHz=446200000&endHz=446000000",
		})
		expect(inverted.statusCode).toBe(400)
		expect(inverted.json()).toMatchObject({ code: "SPECTRUM_RANGE_INVALID" })
		const tooOld = await app.inject({
			method: "GET",
			url: "/api/spectrum/occupancy?sourceId=rtl&startHz=1&endHz=2&sinceMs=999999999999",
		})
		expect(tooOld.statusCode).toBe(400)
		const unknown = await app.inject({
			method: "GET",
			url: "/api/spectrum/occupancy?sourceId=air&startHz=1&endHz=2",
		})
		expect(unknown.statusCode).toBe(404)
	})
})
