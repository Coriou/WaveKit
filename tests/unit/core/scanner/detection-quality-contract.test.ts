import { describe, expect, it } from "vitest"
import * as dq from "../../../../src/core/scanner/detection-quality-contract.js"

// WG15 DQ.0: the frozen contract values (docs/specs/detection-quality/design.md, Contract).
describe("detection-quality contract (frozen)", () => {
	it("pins every constant of the design table", () => {
		expect({ ...dq }).toEqual({
			DQ_OVERLOAD_CREATE_SNR_DB: 25,
			DQ_CREATE_SNR_DB: 18,
			DQ_PENDING_MIN_OBS: 3,
			DQ_PENDING_MEDIAN_SNR_DB: 15,
			DQ_PENDING_WINDOW_MS: 600_000,
			DQ_PENDING_PER_SOURCE: 512,
			DQ_PENDING_SAMPLES: 5,
			DQ_PENDING_BUCKET_HZ: 2_500,
			DQ_CROSS_FAMILY_HZ: 1_000,
			DQ_OBW_RATIO_MIN: 0.5,
			DQ_OBW_RATIO_MAX: 2,
			DQ_CO_CHANNEL_MAX: 8,
			DQ_IDENTITY_SPLIT_MIN_HZ: 6_000,
			DQ_IDENTITY_SPLIT_MAX_HZ: 30_000,
			DQ_IDENTITY_OVERLAP_MS: 2_000,
			DQ_IDENTITY_WEAKER_DB: 10,
			DQ_IDENTITY_PROTOCOLS: ["dmr", "p25p1", "p25p2", "ysf"],
			DQ_LEVEL_SPLIT_DB: 20,
			DQ_OBW_SPLIT_RATIO: 1.5,
			DQ_MIN_HISTORY_OBS: 3,
			DQ_DATA_FREQ_HZ: 1_250,
			DQ_DATA_HOLD_MS: 1_000,
			DQ_DATA_HELD_MAX: 8,
			DQ_DATA_RING: 256,
			DQ_DATA_RATE_PER_S: 16,
			DQ_CONSOLIDATE_GROUP_MAX: 16,
			DQ_CONSOLIDATE_SCAN_MAX: 32,
			DQ_YOUNG_OBW_RATIO: 3,
		})
		expect(Object.isFrozen(dq.DQ_IDENTITY_PROTOCOLS)).toBe(true)
	})

	it("keeps the stated arithmetic", () => {
		// 25 dB = noise maximum 15 + 10; 18 dB = noise maximum 15 + 3
		expect(dq.DQ_OVERLOAD_CREATE_SNR_DB).toBe(dq.DQ_PENDING_MEDIAN_SNR_DB + 10)
		expect(dq.DQ_CREATE_SNR_DB).toBe(dq.DQ_PENDING_MEDIAN_SNR_DB + 3)
		// 512 buckets cover more than half of 2.4 Msps / 2.5 kHz = 960
		expect(dq.DQ_PENDING_PER_SOURCE * 2).toBeGreaterThan(
			2_400_000 / dq.DQ_PENDING_BUCKET_HZ,
		)
		expect(dq.DQ_PENDING_SAMPLES).toBeGreaterThanOrEqual(dq.DQ_PENDING_MIN_OBS)
		expect(dq.DQ_PENDING_WINDOW_MS).toBe(10 * 60_000)
		// data: half a 2.5 kHz raster; 256 / 16 per s = 16 s of one busy source
		expect(dq.DQ_DATA_FREQ_HZ * 2).toBe(dq.DQ_PENDING_BUCKET_HZ)
		expect(dq.DQ_DATA_RING / dq.DQ_DATA_RATE_PER_S).toBe(16)
		// 9.2: one emitter spans 13 to 39 kHz, so a band of 3 each way holds it from any one value
		expect(39_000 / 13_000).toBeLessThanOrEqual(dq.DQ_YOUNG_OBW_RATIO)
		expect(dq.DQ_YOUNG_OBW_RATIO).toBeGreaterThan(dq.DQ_OBW_RATIO_MAX)
	})
})
