import { describe, expect, expectTypeOf, it } from "vitest"
import {
	LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS,
	LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS,
	LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS,
	LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS,
	LIVE_AUDIO_AUTO_ROUTE_FIFO_MS,
	LIVE_AUDIO_AUTO_ROUTE_FORMAT,
	LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS,
	LIVE_AUDIO_AUTO_ROUTE_RATE,
	LIVE_AUDIO_AUTO_ROUTE_TARGET_MS,
	LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
} from "@wavekit/api-types"
import type {
	LiveAudioAutoRoute,
	LiveAudioAutoRouteLevel,
	LiveAudioAutoRouteSource,
	LiveAudioLevel,
	LiveDemodStatus,
} from "@wavekit/api-types"
import {
	AUTO_ROUTE_BLOCK_BYTES,
	AUTO_ROUTE_BLOCK_SAMPLES,
	AUTO_ROUTE_FIFO_SAMPLES,
	AUTO_ROUTE_STREAM,
} from "../../../../src/core/auto-listen/contract.js"

describe("auto listen route contract", () => {
	it("pins the constants (requirements 2.1, 7.3)", () => {
		expect(LIVE_AUDIO_AUTO_ROUTE_RATE).toBe(48_000)
		expect(LIVE_AUDIO_AUTO_ROUTE_FORMAT).toBe("s16le")
		expect(LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS).toBe(20)
		expect(LIVE_AUDIO_AUTO_ROUTE_FIFO_MS).toBe(3_000)
		expect(LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS).toBe(300)
		expect(LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS).toBe(200)
		expect(LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS).toBe(300)
		expect(LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS).toBe(300)
		expect(LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS).toBe(1_500)
		expect(LIVE_AUDIO_AUTO_ROUTE_TARGET_MS).toBe(60)
		expect(LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS).toBe(5)
	})

	it("preemption bound equals the evidence pre-roll capacity", () => {
		expect(LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS).toBe(
			LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS,
		)
	})

	it("derives block and FIFO sizes", () => {
		expect(AUTO_ROUTE_BLOCK_SAMPLES).toBe(960)
		expect(AUTO_ROUTE_BLOCK_BYTES).toBe(1_920)
		expect(AUTO_ROUTE_FIFO_SAMPLES).toBe(144_000)
		expect(AUTO_ROUTE_STREAM).toEqual({ rate: 48_000, format: "s16le" })
		expect(Object.isFrozen(AUTO_ROUTE_STREAM)).toBe(true)
	})

	it("adds optional autoRoute to status and level (requirements 6.1, 6.2)", () => {
		expectTypeOf<LiveDemodStatus["autoRoute"]>().toEqualTypeOf<
			LiveAudioAutoRoute | undefined
		>()
		expectTypeOf<LiveAudioLevel["autoRoute"]>().toEqualTypeOf<
			LiveAudioAutoRouteLevel | undefined
		>()
		expectTypeOf<LiveAudioAutoRouteSource>().toEqualTypeOf<
			"analog" | "digital" | "none"
		>()
		const route: LiveAudioAutoRoute = {
			active: "digital",
			protocol: "dmr",
			decoderId: "dmr-1",
			slot: null,
			since: new Date(0).toISOString(),
			httpUrl: "http://localhost/auto",
			wavUrl: "http://localhost/auto.wav",
			clientCount: 1,
			digitalAvailable: true,
			underruns: 0,
			droppedMs: 0,
			clockRebases: 0,
			latencyMs: 20,
		}
		expect(Object.keys(route)).toHaveLength(13)
	})
})
