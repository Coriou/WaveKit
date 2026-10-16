import { beforeEach, describe, expect, it, vi } from "vitest"
import { WaveKitError } from "../../../../src/utils/errors.js"

const mocks = vi.hoisted(() => ({
	collect: vi.fn(),
	compute: vi.fn(),
}))
vi.mock("../../../../src/core/station-estimate/estimator.js", () => ({
	collectContributors: mocks.collect,
	computeEstimate: mocks.compute,
}))

import { createStationEstimator } from "../../../../src/core/station-estimate/provider.js"

const basis = { aircraft: 1, vessels: 2, aprs: 3, mesh: 4 }

beforeEach(() => {
	mocks.collect.mockReset()
	mocks.compute.mockReset()
	mocks.collect.mockReturnValue({ points: [], basis, direct: 0 })
	mocks.compute.mockReturnValue({
		available: true,
		lat: 51.5,
		lon: -0.1,
		uncertaintyKm: 15,
		rawLat: 51.52,
		rawLon: -0.12,
	})
})

describe("createStationEstimator", () => {
	it("builds an available estimate and caches it for 60 s", async () => {
		let now = Date.parse("2026-01-01T00:00:00.000Z")
		const aircraft = vi.fn(() => [])
		const est = createStationEstimator({
			aircraft,
			stationConfigured: () => true,
			now: () => now,
		})
		const first = await est.estimate()
		expect(first).toEqual({
			available: true,
			reason: null,
			lat: 51.5,
			lon: -0.1,
			uncertaintyKm: 15,
			basis,
			computedAt: "2026-01-01T00:00:00.000Z",
			cachedUntil: "2026-01-01T00:01:00.000Z",
			authoritative: false,
			stationConfigured: true,
		})
		now += 59_999
		expect(await est.estimate()).toBe(first)
		expect(aircraft).toHaveBeenCalledTimes(1)
		now += 1
		const second = await est.estimate()
		expect(second).not.toBe(first)
		expect(second.computedAt).toBe("2026-01-01T00:01:00.000Z")
		expect(aircraft).toHaveBeenCalledTimes(2)
	})

	it("returns nulls when unavailable", async () => {
		mocks.compute.mockReturnValue({ available: false, reason: "degenerate" })
		const est = createStationEstimator({ stationConfigured: () => false })
		const result = await est.estimate()
		expect(result).toMatchObject({
			available: false,
			reason: "degenerate",
			lat: null,
			lon: null,
			uncertaintyKm: null,
			stationConfigured: false,
			authoritative: false,
		})
	})

	it("shares one computation between concurrent calls", async () => {
		const aircraft = vi.fn(() => [])
		const est = createStationEstimator({
			aircraft,
			stationConfigured: () => false,
		})
		const [a, b, c] = await Promise.all([
			est.estimate(),
			est.estimate(),
			est.estimate(),
		])
		expect(a).toBe(b)
		expect(b).toBe(c)
		expect(aircraft).toHaveBeenCalledTimes(1)
		expect(mocks.compute).toHaveBeenCalledTimes(1)
	})

	it("skips absent and throwing getters", async () => {
		const est = createStationEstimator({
			vessels: () => {
				throw new Error("down")
			},
			aprs: () => [],
			stationConfigured: () => false,
		})
		await est.estimate()
		const snapshots = mocks.collect.mock.calls[0]?.[0] as {
			aircraft?: unknown
			vessels?: unknown
			aprs?: unknown
			mesh?: unknown
		}
		expect(snapshots.aircraft).toBeUndefined()
		expect(snapshots.vessels).toBeUndefined()
		expect(snapshots.mesh).toBeUndefined()
		expect(snapshots.aprs).toEqual([])
	})

	it("fails uncached when stationConfigured throws, then recovers", async () => {
		let calls = 0
		const est = createStationEstimator({
			stationConfigured: () => {
				calls++
				if (calls === 1) throw new Error("nope")
				return true
			},
		})
		const failure = await est.estimate().catch((error: unknown) => error)
		expect((failure as WaveKitError).code).toBe("STATION_ESTIMATE_FAILED")
		expect((await est.estimate()).stationConfigured).toBe(true)
	})

	it("rejects with STATION_ESTIMATE_FAILED, does not cache, then recovers", async () => {
		mocks.compute.mockImplementationOnce(() => {
			throw new Error("boom")
		})
		const est = createStationEstimator({ stationConfigured: () => false })
		const failure = await est.estimate().catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(WaveKitError)
		expect((failure as WaveKitError).code).toBe("STATION_ESTIMATE_FAILED")
		const ok = await est.estimate()
		expect(ok.available).toBe(true)
		expect(mocks.compute).toHaveBeenCalledTimes(2)
	})
})
