import { describe, expect, it } from "vitest"
import pino from "pino"
import { createDsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createDirewolfDecoder } from "../../../../src/decoders/builtin/direwolf.js"
import { createMultimonDecoder } from "../../../../src/decoders/builtin/multimon-ng.js"
import { createRtl433Decoder } from "../../../../src/decoders/builtin/rtl433.js"
import {
	PROBE_CHANNEL_REQUESTS,
	RTL433_PROBE_TARGET_RATE_HZ,
	createChannelTransport,
	offsetPreRollTransport,
	probeChannelAdmitted,
} from "../../../../src/core/scanner/probes/channel-transport.js"
import {
	offsetTransport,
	type ProbeMode,
	type TransportContext,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { probeCores } from "../../../../src/core/scanner/plan/cost.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import {
	FakeEngineView,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const capture = { centerHz: 446_000_000, sampleRateHz: 2_048_000 }
const mode: ProbeMode = {
	decoderType: "dsd-fme",
	protocol: "dmr",
	covers: ["dmr"],
	options: {},
	holdMs: 600,
}
const context = (targetHz = capture.centerHz): TransportContext => ({
	req: probeRequest({ targetHz }),
	epoch: new FakeEngineView({
		centreHz: capture.centerHz,
		sampleRateHz: capture.sampleRateHz,
	}).epoch,
	format: "U8_IQ",
	sampleRateHz: capture.sampleRateHz,
})

describe("predictive probe channel transport", () => {
	it("matches current builtin requests including audio filter differences", () => {
		const factories = {
			"dsd-fme": createDsdFmeDecoder,
			"multimon-ng": createMultimonDecoder,
			direwolf: createDirewolfDecoder,
			rtl433: createRtl433Decoder,
		}
		for (const type of Object.keys(factories) as (keyof typeof factories)[]) {
			const decoder = factories[type](
				{
					id: `test-${type}`,
					type,
					enabled: true,
					options: {
						channelHz: capture.centerHz,
						...(type === "rtl433"
							? { targetSampleRate: RTL433_PROBE_TARGET_RATE_HZ }
							: {}),
					},
				},
				pino({ level: "silent" }),
			)
			expect(decoder.getChannelRequest?.(capture)).toEqual({
				...PROBE_CHANNEL_REQUESTS[type],
				centerHz: capture.centerHz,
			})
		}
		expect(PROBE_CHANNEL_REQUESTS["dsd-fme"]).toMatchObject({
			bandwidthHz: 12_500,
			transitionHz: 6_250,
			format: "cf32",
		})
		expect(PROBE_CHANNEL_REQUESTS["multimon-ng"].bandwidthHz).toBeCloseTo(
			47_424,
		)
		expect(PROBE_CHANNEL_REQUESTS.rtl433).toMatchObject({
			outputRateHz: 250_000,
			format: "cu8",
		})
	})

	it("explicitly configures scanner rtl433 at 250 kHz while the builtin defaults to 1 MHz", () => {
		const base = {
			id: "scan-ism",
			type: "rtl433",
			enabled: true,
			options: { targetSampleRate: 1_000_000, offsetHz: 100 },
		}
		const logger = pino({ level: "silent" })
		expect(
			createRtl433Decoder({ ...base, options: {} }, logger).getChannelRequest(
				capture,
			),
		).toMatchObject({ outputRateHz: 1_000_000 })
		const transport = createChannelTransport({
			available: () => true,
			usableFraction: 0.8,
		})
		const configured = transport.configure(base, context())
		expect(configured.options["targetSampleRate"]).toBe(
			RTL433_PROBE_TARGET_RATE_HZ,
		)
		expect(configured.options).not.toHaveProperty("offsetHz")
		expect(
			createRtl433Decoder(configured, logger).getChannelRequest(capture),
		).toEqual({ ...PROBE_CHANNEL_REQUESTS.rtl433, centerHz: capture.centerHz })
	})

	it("uses occupied width in admission including the exact boundary", () => {
		for (const type of [
			"dsd-fme",
			"multimon-ng",
			"direwolf",
			"rtl433",
		] as const) {
			const request = PROBE_CHANNEL_REQUESTS[type]
			const limit =
				(capture.sampleRateHz * 0.8) / 2 -
				request.bandwidthHz / 2 -
				request.transitionHz
			for (const sign of [-1, 1]) {
				expect(
					probeChannelAdmitted(
						type,
						capture.centerHz + sign * limit,
						capture,
						0.8,
					),
				).toBe(true)
				expect(
					probeChannelAdmitted(
						type,
						capture.centerHz + sign * (limit + 1),
						capture,
						0.8,
					),
				).toBe(false)
			}
		}
	})

	it("requires provider availability and actual CU8 source format", () => {
		let available = false
		const transport = createChannelTransport({
			available: () => available,
			usableFraction: 0.8,
		})
		expect(transport.supports(mode, context())).toBe(false)
		available = true
		expect(transport.supports(mode, context())).toBe(true)
		for (const format of ["cf32", "F32_IQ", "S16_IQ", "audio", "cu8"])
			expect(transport.supports(mode, { ...context(), format })).toBe(false)
		expect(transport.kind).toBe("channel")
		expect(transport.preRoll).toBe(false)
		expect(transport.maxProbes(testSettings())).toBe(
			testSettings().maxProbes.channel,
		)
		expect(transport.cores("rtl433")).toBe(probeCores("channel", "rtl433"))
	})

	it("rejects invalid requests and unusable fractions", () => {
		const transport = createChannelTransport({
			available: () => true,
			usableFraction: 0.8,
		})
		expect(
			transport.supports(
				{ ...mode, decoderType: "unsupported" } as unknown as ProbeMode,
				context(),
			),
		).toBe(false)
		for (const target of [NaN, Infinity, -1, 0])
			expect(probeChannelAdmitted("dsd-fme", target, capture, 0.8)).toBe(false)
		for (const sampleRateHz of [NaN, -1, 47_999, 2_048_000.5])
			expect(
				probeChannelAdmitted(
					"dsd-fme",
					capture.centerHz,
					{ ...capture, sampleRateHz },
					0.8,
				),
			).toBe(false)
		expect(
			probeChannelAdmitted(
				"dsd-fme",
				capture.centerHz,
				{ ...capture, centerHz: NaN },
				0.8,
			),
		).toBe(false)
		for (const usableFraction of [NaN, Infinity, 0, -1, 1.1])
			expect(() =>
				createChannelTransport({ available: () => true, usableFraction }),
			).toThrow(WaveKitError)
	})

	it("configures absolute target and removes an offset shadow without mutating the base", () => {
		const transport = createChannelTransport({
			available: () => true,
			usableFraction: 0.8,
		})
		const base = {
			id: "scan-test",
			type: "dsd-fme",
			enabled: true,
			options: { offsetHz: 123, mode: "auto" },
		}
		expect(transport.configure(base, context())).toEqual({
			...base,
			useChannelizer: true,
			options: { mode: "auto", channelHz: capture.centerHz },
		})
		expect(base.options.offsetHz).toBe(123)
	})

	it("delegates pre-roll eligibility to the existing offset strategy", () => {
		const ctx = context()
		expect(offsetPreRollTransport.supports(mode, ctx)).toBe(false)
		ctx.req.preRollFromSample = 0
		expect(offsetPreRollTransport.supports(mode, ctx)).toBe(
			offsetTransport.supports(mode, ctx),
		)
		expect(
			offsetPreRollTransport.supports({ ...mode, decoderType: "rtl433" }, ctx),
		).toBe(false)
		expect(
			offsetPreRollTransport.supports(mode, { ...ctx, format: "audio" }),
		).toBe(false)
		expect(offsetPreRollTransport.configure).toBe(offsetTransport.configure)
	})
})
