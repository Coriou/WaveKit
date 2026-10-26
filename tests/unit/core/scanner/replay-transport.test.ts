import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import { createDirewolfDecoder } from "../../../../src/decoders/builtin/direwolf.js"
import { createDsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createMultimonDecoder } from "../../../../src/decoders/builtin/multimon-ng.js"
import { createRtl433Decoder } from "../../../../src/decoders/builtin/rtl433.js"
import { createChannelTransport } from "../../../../src/core/scanner/probes/channel-transport.js"
import {
	buildProbeConfig,
	type ProbeDecoderType,
	type ProbeMode,
	type TransportContext,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	createReplayTransport,
	replayCaptureOf,
	type ReplayProbeRequest,
} from "../../../../src/core/scanner/probes/replay-transport.js"
import {
	IQ_REPLAY_MAX_PROBES,
	IQ_REPLAY_PROBE_CORES,
	type IqCapturePort,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	FakeEngineView,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

const centreHz = 446_000_000
const modeOf = (
	decoderType: ProbeDecoderType,
	options: Record<string, unknown> = {},
): ProbeMode => ({
	decoderType,
	protocol: decoderType === "dsd-fme" ? "dmr" : "pocsag",
	covers: [],
	options,
	holdMs: 600,
})
const ctxOf = (
	req: ReplayProbeRequest,
	format = "U8_IQ",
): TransportContext => ({
	req,
	epoch: new FakeEngineView({ centreHz, sampleRateHz: 2_048_000 }).epoch,
	format,
	sampleRateHz: 2_048_000,
})
const replayReq = (
	over: Partial<ReplayProbeRequest> = {},
): ReplayProbeRequest =>
	({
		...probeRequest({ targetHz: 446_125_000 }),
		replay: { captureId: "cap-1" },
		...over,
	}) as ReplayProbeRequest

function fakePort(stream: Readable | null): {
	port: Pick<IqCapturePort, "openReplay">
	openReplay: ReturnType<typeof vi.fn>
} {
	const openReplay = vi.fn(() => stream)
	return { port: { openReplay }, openReplay }
}

describe("replay transport", () => {
	it("is the frozen shape: replay kind, no pre-roll, one probe at 0.15 cores", () => {
		const t = createReplayTransport(fakePort(null).port)
		expect(t.kind).toBe("replay")
		expect(t.preRoll).toBe(false)
		expect(t.maxProbes(testSettings())).toBe(IQ_REPLAY_MAX_PROBES)
		expect(t.cores("dsd-fme")).toBe(IQ_REPLAY_PROBE_CORES)
		expect(t.cores("multimon-ng")).toBe(IQ_REPLAY_PROBE_CORES)
	})

	it("supports only requests that name a capture, rtl433 included", () => {
		const t = createReplayTransport(fakePort(null).port)
		for (const type of [
			"dsd-fme",
			"multimon-ng",
			"direwolf",
			"rtl433",
		] as const) {
			expect(t.supports(modeOf(type), ctxOf(replayReq()))).toBe(true)
			expect(t.supports(modeOf(type), ctxOf(probeRequest() as never))).toBe(
				false,
			)
		}
		expect(replayCaptureOf(probeRequest())).toBeNull()
		expect(replayCaptureOf(replayReq())).toBe("cap-1")
		// A capture needs no live IQ format.
		expect(t.supports(modeOf("dsd-fme"), ctxOf(replayReq(), "S16_IQ"))).toBe(
			true,
		)
	})

	it("opens the replay stream of the request's capture with the mode's decoder type", () => {
		const stream = new PassThrough()
		const { port, openReplay } = fakePort(stream)
		const t = createReplayTransport(port)
		const mode = modeOf("multimon-ng")
		expect(t.openInput(mode, ctxOf(replayReq()))).toBe(stream)
		expect(openReplay).toHaveBeenCalledWith("cap-1", "multimon-ng")
	})

	it("returns null when the capture is gone or the request is live", () => {
		const gone = fakePort(null)
		const t = createReplayTransport(gone.port)
		expect(t.openInput(modeOf("dsd-fme"), ctxOf(replayReq()))).toBeNull()
		const live = fakePort(new PassThrough())
		const t2 = createReplayTransport(live.port)
		expect(
			t2.openInput(modeOf("dsd-fme"), ctxOf(probeRequest() as never)),
		).toBeNull()
		expect(live.openReplay).not.toHaveBeenCalled()
	})

	it("opens rtl433 replays and runs rtl_433 on the cf32 capture as it is", () => {
		const stream = new PassThrough()
		const { port, openReplay } = fakePort(stream)
		const t = createReplayTransport(port)
		const req = replayReq()
		const ctx = ctxOf(req)
		const mode = modeOf("rtl433")
		expect(t.openInput(mode, ctx)).toBe(stream)
		expect(openReplay).toHaveBeenCalledWith("cap-1", "rtl433")
		const cfg = buildProbeConfig({
			probeId: "r",
			req,
			mode,
			transport: t,
			ctx,
			recordDir: null,
			ports: null,
		})
		expect(cfg.options).toMatchObject({
			inputIqFormat: "cf32",
			inputSampleRate: 48_000,
			channelHz: req.targetHz,
		})
		const argv = (
			createRtl433Decoder(cfg, pino({ level: "silent" })) as unknown as {
				getArgs(): string[]
			}
		).getArgs()
		const pipeline = argv.join(" ")
		expect(pipeline).not.toContain("csdr")
		expect(argv[1]).toMatch(/^rtl_433 -r cf32:- -s 48000 /)
		expect(pipeline).toContain(`-f ${req.targetHz}`)
	})

	describe("configure equals the channel transport's options", () => {
		const channel = createChannelTransport({
			available: () => true,
			usableFraction: 0.8,
		})
		const replay = createReplayTransport(fakePort(null).port)
		const factories = {
			"dsd-fme": createDsdFmeDecoder,
			"multimon-ng": createMultimonDecoder,
			direwolf: createDirewolfDecoder,
		}
		for (const type of Object.keys(factories) as (keyof typeof factories)[]) {
			it(`${type}: same planned argv, demod rate 48 kHz`, () => {
				const req = replayReq()
				const ctx = ctxOf(req)
				const mode = modeOf(type, type === "dsd-fme" ? { mode: "auto" } : {})
				const cfg = (transport: typeof channel | typeof replay, id: string) =>
					buildProbeConfig({
						probeId: id,
						req,
						mode,
						transport,
						ctx,
						recordDir: null,
						ports: { kiss: 8001, agw: 8000 },
					})
				const viaChannel = cfg(channel, "a")
				const viaReplay = cfg(replay, "a")
				// The manager injects these for a channel feed; the replay transport sets them itself.
				const managerFed = {
					...viaChannel,
					options: {
						...viaChannel.options,
						inputIqFormat: "cf32",
						inputSampleRate: 48_000,
					},
				}
				expect(viaReplay).toEqual(managerFed)
				expect(viaReplay.options["offsetHz"]).toBeUndefined()
				expect(viaReplay.options["channelHz"]).toBe(req.targetHz)
				expect(viaReplay.useChannelizer).toBe(true)
				const log = pino({ level: "silent" })
				const argvOf = (c: typeof viaReplay): string[] =>
					(
						factories[type](c, log) as unknown as { getArgs(): string[] }
					).getArgs()
				const argv = argvOf(viaReplay)
				expect(argv).toEqual(argvOf(managerFed))
				const pipeline = argv.join(" ")
				// The only sox stage is the decoder's own format conversion, fed at the capture rate.
				expect(pipeline).not.toContain("47628")
				if (pipeline.includes("sox"))
					expect(pipeline).toContain("sox -t raw -r 48000")
				expect(pipeline).not.toContain("firdecimate")
				expect(pipeline).toContain("fmdemod")
			})
		}
	})
})
