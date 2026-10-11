import { describe, expect, it } from "vitest"
import {
	liveAudioListen,
	type ListenContext,
	type ListenStrategy,
} from "../../../../src/core/scanner/listen.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import {
	CENTRE,
	FS,
	serviceHarness,
} from "../../../mocks/scanner/service-fakes.js"

const discovery = (frequencyHz: number, measuredOffsetHz = 0) =>
	({
		id: "d_1",
		frequencyHz,
		measuredOffsetHz,
		sourceIds: ["rtl"],
	}) as unknown as Discovery

function liveDemod(sourceId = "rtl", running = false) {
	const calls: unknown[] = []
	const status = {
		sourceId,
		running,
		config: { offsetHz: 0 },
		httpUrl: "http://h:8081/stream",
		wavUrl: "http://h:8081/stream.wav",
	}
	return {
		calls,
		status,
		demod: {
			getStatus: () => status,
			reconfigure: (c: { offsetHz: number }) => {
				calls.push(c)
				status.config.offsetHz = c.offsetHz
				return Promise.resolve()
			},
			start: () => {
				status.running = true
				return Promise.resolve()
			},
		},
	}
}

const caps = {
	kind: "iq" as const,
	format: "U8_IQ" as const,
	sampleRate: 2_048_000,
	centerFreq: 446_100_000,
	exclusive: false,
}

describe("liveAudioListen", () => {
	it("retargets live audio to the measured centre and starts it", async () => {
		const { calls, demod } = liveDemod()
		const res = await liveAudioListen(discovery(446_193_750, 150), {
			caps,
			usableHalfSpanHz: 819_200,
			liveDemod: demod as never,
		})
		expect(calls).toEqual([{ offsetHz: 93_900 }])
		expect(res).toEqual({
			mode: "live-audio",
			sourceId: "rtl",
			frequencyHz: 446_193_750,
			offsetHz: 93_900,
			httpUrl: "http://h:8081/stream",
			wavUrl: "http://h:8081/stream.wav",
		})
	})

	it("answers OUT_OF_WINDOW outside the usable span, on another source, or when csdr rejects the offset", async () => {
		const { demod } = liveDemod()
		await expect(
			liveAudioListen(discovery(447_000_000), {
				caps,
				usableHalfSpanHz: 819_200,
				liveDemod: demod as never,
			}),
		).rejects.toMatchObject({ code: "OUT_OF_WINDOW", statusCode: 409 })
		const other = liveDemod("air").demod
		await expect(
			liveAudioListen(discovery(446_150_000), {
				caps,
				usableHalfSpanHz: 819_200,
				liveDemod: other as never,
			}),
		).rejects.toMatchObject({ code: "OUT_OF_WINDOW" })
		const failing = {
			...liveDemod().demod,
			reconfigure: () =>
				Promise.reject(
					new WaveKitError("too far", "CHANNEL_OFFSET_OUT_OF_RANGE"),
				),
		}
		await expect(
			liveAudioListen(discovery(446_150_000), {
				caps,
				usableHalfSpanHz: 819_200,
				liveDemod: failing as never,
			}),
		).rejects.toMatchObject({ code: "OUT_OF_WINDOW" })
		await expect(
			liveAudioListen(discovery(446_150_000), {
				caps,
				usableHalfSpanHz: 819_200,
				liveDemod: null,
			}),
		).rejects.toMatchObject({ code: "LIVE_AUDIO_UNAVAILABLE", statusCode: 409 })
	})

	it("maps an idle start that rejects the offset to OUT_OF_WINDOW and restores the previous offset", async () => {
		const { calls, status, demod } = liveDemod()
		const idleFailing = {
			...demod,
			start: () =>
				Promise.reject(
					new WaveKitError("too far", "CHANNEL_OFFSET_OUT_OF_RANGE"),
				),
		}
		await expect(
			liveAudioListen(discovery(446_150_000), {
				caps,
				usableHalfSpanHz: 819_200,
				liveDemod: idleFailing as never,
			}),
		).rejects.toMatchObject({ code: "OUT_OF_WINDOW", statusCode: 409 })
		expect(calls).toEqual([{ offsetHz: 50_000 }, { offsetHz: 0 }])
		expect(status.config.offsetHz).toBe(0)
		expect(status.running).toBe(false)
	})
})

describe("ScannerService.listen", () => {
	it("answers 404 for an unknown discovery, 409 for a locked-out one, and otherwise runs the live-audio strategy", async () => {
		const h = serviceHarness()
		const store = (h.service as unknown as { store: DiscoveryStore }).store
		const base = { ...discovery(446_150_000), operator: {} } as Discovery
		store.restore({
			discoveries: [base, { ...base, id: "d_2", operator: { lockout: true } }],
			observations: [],
			corrections: [],
		})
		await expect(h.service.listen("d_missing")).rejects.toMatchObject({
			code: "SCANNER_DISCOVERY_NOT_FOUND",
			statusCode: 404,
		})
		await expect(h.service.listen("d_2")).rejects.toMatchObject({
			code: "SCANNER_DISCOVERY_LOCKED_OUT",
			statusCode: 409,
		})
		// The harness has no live demodulator, so the default strategy (live audio) refuses.
		await expect(h.service.listen("d_1")).rejects.toMatchObject({
			code: "LIVE_AUDIO_UNAVAILABLE",
			statusCode: 409,
		})
		// An injected strategy (Task 46's monitor) gets the source caps and the usable half-span.
		const seen: ListenContext[] = []
		const strategy: ListenStrategy = (d, ctx) => {
			seen.push(ctx)
			return Promise.resolve({
				mode: "monitor",
				sourceId: "rtl",
				frequencyHz: d.frequencyHz,
				httpUrl: "u",
				wavUrl: "w",
			})
		}
		;(
			h.service as unknown as { deps: { listen?: ListenStrategy } }
		).deps.listen = strategy
		await expect(h.service.listen("d_1")).resolves.toMatchObject({
			mode: "monitor",
			frequencyHz: 446_150_000,
		})
		expect(seen[0]).toMatchObject({
			caps: { centerFreq: CENTRE, sampleRate: FS },
			usableHalfSpanHz: (FS * 0.8) / 2,
			liveDemod: null,
		})
	})
})
