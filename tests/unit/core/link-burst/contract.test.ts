import { describe, expect, it } from "vitest"
import * as contract from "../../../../src/core/link-burst/contract.js"
import {
	LATE_SHED_WINDOWS,
	LATE_SHED_HITS,
	LATE_SHED_COOLDOWN_MS,
} from "../../../../src/decoders/enablement/contract.js"

describe("link burst contract", () => {
	it("pins the shared constants", () => {
		expect(contract.BURST_ABSORBER_DEFAULT_S).toBe(2)
		expect(contract.BURST_ABSORBER_MAX_S).toBe(10)
		expect(contract.BURST_ABSORBER_DEFAULT_ENABLED).toBe(true)
		expect(contract.ABSORBER_RELEASE_BYTES).toBe(65_536)
		expect(contract.ABSORBER_LAGGARD_MS).toBe(500)
		expect(contract.LINK_GAP_MS).toBe(200)
		expect(contract.HOST_LOOP_DELAY_MS).toBe(50)
		expect(contract.CATCHUP_WINDOW_MS).toBe(500)
		expect(contract.LINK_QUALITY_WINDOW_MS).toBe(600_000)
		expect(contract.LINK_QUALITY_SLOT_MS).toBe(10_000)
		expect(contract.LINK_DROPPING_HOLD_MS).toBe(60_000)
		expect(contract.LOOP_METER_RESOLUTION_MS).toBe(10)
		expect(contract.ABSORBER_COUNTER_PREFIX).toBe("@absorber")
		expect(contract.GAP_BUCKETS).toBe(48)
		expect(contract.CHUNK_SIZE_BUCKETS).toBe(16)
		expect(contract.CATCHUP_BUCKETS).toBe(16)
		expect(contract.CATCHUP_BUCKET_BASE_BYTES).toBe(1_024)
		expect(contract.LOOP_DELAY_RING).toBe(300)
		expect(LATE_SHED_WINDOWS).toBe(3)
		expect(LATE_SHED_HITS).toBe(2)
		expect(LATE_SHED_COOLDOWN_MS).toBe(30_000)
	})
	it("recognizes IQ frame sizes only", () => {
		expect(contract.frameBytesFor("U8_IQ")).toBe(2)
		expect(contract.frameBytesFor("S16_IQ")).toBe(4)
		for (const format of ["S16LE", "auto", "", "unknown"])
			expect(contract.frameBytesFor(format)).toBeNull()
	})
	it("defaults network absorption to two seconds and keeps loopback unbuffered", () => {
		expect(contract.resolveAbsorberSeconds(undefined, "network")).toBe(2)
		expect(contract.resolveAbsorberSeconds(undefined, "loopback")).toBe(0)
		expect(contract.resolveAbsorberSeconds(3, "loopback")).toBe(3)
		expect(contract.resolveAbsorberSeconds(0, "network")).toBe(0)
	})
})
