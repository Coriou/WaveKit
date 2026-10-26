/**
 * rtl_433 replay chain on a SYNTHETIC OOK sensor capture (scripts/fixtures/ook-sensor-iq.mjs):
 * plan → replay transport (capture stream as decoder input, rtl_433 argv on cf32) → probe pool →
 * pool adapter `decoded` → scanner evidence on the capture's channel and trial memory. The
 * rtl_433 child is mocked: its lines are what rtl_433 printed for this fixture at 48 kHz (three
 * checksummed rows of one burst; made-up id and readings).
 */
import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	shortPulseBits,
	synthesizeOokSensor,
	synthesizeShortPulseSensor,
	toCf32,
} from "../../../../scripts/fixtures/ook-sensor-iq.mjs"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import {
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_RATE_HZ,
	iqCaptureMaxBytes,
	type IqCaptureView,
	type IqReplayResult,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	REPLAY_END_GRACE_MS,
	REPLAY_PROBE_PRIORITY,
	offsetTransport,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { createRtl433Decoder } from "../../../../src/decoders/builtin/rtl433.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const RF = CENTRE + 50_000
const LINE =
	'{"time" : "@0.050021s", "model" : "Acurite-609TXC", "id" : 90, "battery_ok" : 1, "temperature_C" : 21.500, "humidity" : 40, "status" : 2, "mic" : "CHECKSUM", "mod" : "ASK", "freq" : 433.923, "rssi" : -8.191, "snr" : 29.863, "noise" : -38.053}'
const IDENTITY = { kind: "ism-model", value: "Acurite-609TXC:90" }

const wait = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

const view: IqCaptureView = {
	captureId: "cap-1",
	sourceId: "rtl",
	observationId: "o_1",
	epoch: 1,
	rfHz: RF,
	tuningTrust: "commanded",
	capturedAtMs: 0,
	durationMs: 1000,
	gapSamples: 0,
}

/** The capture: one synthetic burst at 48 kHz cf32, 3 kHz off the channel centre. */
function fixture(): Buffer {
	return toCf32(
		synthesizeOokSensor({ sampleRateHz: IQ_CAPTURE_RATE_HZ, offsetHz: 3000 }),
	)
}

async function replayThroughPool(lines: number) {
	const capture = fixture()
	const input = new PassThrough()
	const openReplay = vi.fn(() => input)
	const h = poolHarness({
		transports: [offsetTransport, createReplayTransport({ openReplay })],
	})
	const adapter = createPoolReplayProbes(h.pool, {
		priority: REPLAY_PROBE_PRIORITY,
		jobId: IQ_REPLAY_QUEUE_HOLDER,
	})
	const trial = planReplayTrials({
		capture: view,
		track: null,
		knownProtocol: null,
		priors: { ism: 2 },
		narrowRaster: false,
	}).find(t => t.mode.decoderType === "rtl433")
	if (!trial) throw new Error("no rtl433 trial planned")
	const res = adapter.request({
		captureId: "cap-1",
		sourceId: "rtl",
		epoch: 1,
		observationId: "o_1",
		rfHz: RF,
		protocol: trial.protocol,
		mode: trial.mode,
	})
	if (!("run" in res)) throw new Error("deferred")
	await flushAsync()
	expect(openReplay).toHaveBeenCalledWith("cap-1", "rtl433")
	const [id, decoder] = [...h.decoders.created.entries()][0]!
	// The real adapter builds its command from the probe config: rtl_433 on the cf32 as it is.
	const rtl433 = createRtl433Decoder(decoder.config, pino({ level: "silent" }))
	const argv = (rtl433 as unknown as { getArgs(): string[] }).getArgs()
	expect(argv[1]).toMatch(/^rtl_433 -r cf32:- -s 48000 /)
	expect(argv[1]).toContain(`-f ${RF}`)
	input.end(capture)
	await flushAsync()
	expect(decoder.received().equals(capture)).toBe(true)
	const parse = (line: string): DecoderOutput | null =>
		(
			rtl433 as unknown as { parseOutput(l: string): DecoderOutput | null }
		).parseOutput(line)
	for (let i = 0; i < lines; i++) {
		const out = parse(LINE)
		if (out) h.decoders.emitOutput(id, out)
	}
	decoder.emit("exit", 0, null)
	await wait(REPLAY_END_GRACE_MS + 150)
	const answer = await res.run.result
	adapter.dispose()
	return answer
}

const noPassive = {
	patch: (s: ScannerSettings) => {
		s.passive.enabled = false
	},
}

function scanner() {
	const h = serviceHarness(noPassive)
	const internals = h.service as unknown as {
		live: Map<string, LiveObservation>
		classify(t: TrackSnapshot, s: string): LiveObservation["classification"]
		replayPlans: Map<string, readonly unknown[]>
	}
	const track = trackOf({ trackId: "t1", centreHz: RF, obwHz: 4000, epoch: 1 })
	internals.live.set("t1", {
		observationId: "o_1",
		sourceId: "rtl",
		trackId: "t1",
		epoch: 1,
		jobIds: [],
		discoveryId: "d_1",
		startedAt: 0,
		classification: internals.classify(track, "rtl"),
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	})
	return { h, internals }
}

describe("rtl_433 replay chain (synthetic OOK sensor)", () => {
	it("the short-pulse fixture: 56 bits with parity and checksum; one burst fits a 96 kHz capture", () => {
		const bits = shortPulseBits({
			id: 421,
			channel: 3,
			tempC: 21.5,
			humidity: 40,
		})
		expect(bits).toHaveLength(56)
		const bytes = Array.from({ length: 7 }, (_, i) =>
			bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0),
		)
		expect(bytes[6]).toBe(bytes.slice(0, 6).reduce((a, b) => a + b, 0) & 0xff)
		for (const b of bytes.slice(2, 6)) {
			let ones = 0
			for (let i = 0; i < 8; i++) ones += (b >> i) & 1
			expect(ones % 2).toBe(0)
		}
		const iq = toCf32(
			synthesizeShortPulseSensor({ sampleRateHz: 96_000, offsetHz: 3000 }),
		)
		expect(iq.length).toBeLessThanOrEqual(iqCaptureMaxBytes(96_000))
	})

	it("the synthetic capture fits one capture file", () => {
		const bytes = fixture().length
		expect(bytes % 8).toBe(0)
		expect(bytes).toBeLessThanOrEqual(IQ_CAPTURE_MAX_BYTES)
	})

	it("three checksummed rows decode; the result lands on the discovery and in trial memory", async () => {
		const answer = await replayThroughPool(3)
		expect(answer).toEqual({
			outcome: "decoded",
			decoded: { protocol: "ism", identity: IDENTITY },
		})
		const { h, internals } = scanner()
		await h.service.start()
		try {
			const applied = vi
				.spyOn(
					h.service as unknown as {
						applyEvidence(l: LiveObservation, ev: unknown): boolean
					},
					"applyEvidence",
				)
				.mockImplementation(() => true)
			const trial = {
				protocol: "ism" as const,
				known: false,
				mode: {
					decoderType: "rtl433" as const,
					protocol: "ism" as const,
					covers: ["ism" as const],
					options: {},
					holdMs: 4000,
				},
			}
			internals.replayPlans.set("cap-1", [trial])
			const result: IqReplayResult = {
				captureId: "cap-1",
				sourceId: "rtl",
				observationId: "o_1",
				epoch: 1,
				rfHz: RF,
				trials: [
					{
						protocol: "ism",
						decoderType: "rtl433",
						known: false,
						outcome: answer.outcome,
					},
				],
				decoded: answer.decoded,
			}
			h.service.applyReplayResult(result)
			expect(applied).toHaveBeenCalledWith(
				expect.objectContaining({ observationId: "o_1" }),
				expect.objectContaining({
					protocol: "ism",
					identity: IDENTITY,
					epoch: 1,
					crcClean: true,
				}),
			)
			expect(
				h.service
					.trialMemoryOf("d_1")
					.map(e => [e.protocol, e.decoder, e.lastOutcome]),
			).toEqual([["ism", "rtl433", "decoded"]])
		} finally {
			await h.service.stop()
		}
	})

	it("a single row is no accepted decode (two are needed): no identity", async () => {
		const answer = await replayThroughPool(1)
		expect(answer.decoded).toBeNull()
		expect(answer.outcome).not.toBe("decoded")
	})

	it("a cancelled rtl433 trial is no failed attempt in trial memory", async () => {
		const { h, internals } = scanner()
		await h.service.start()
		try {
			internals.replayPlans.set("cap-1", [])
			h.service.applyReplayResult({
				captureId: "cap-1",
				sourceId: "rtl",
				observationId: "o_1",
				epoch: 1,
				rfHz: RF,
				trials: [
					{
						protocol: "ism",
						decoderType: "rtl433",
						known: false,
						outcome: "cancelled",
					},
				],
				decoded: null,
			})
			const memory = h.service.trialMemoryOf("d_1")
			// no attempt and no failure is remembered for a cut-short run
			expect(
				memory.filter(
					e =>
						e.decoder === "rtl433" &&
						(e.attempts > 0 || e.consecutiveFailures > 0),
				),
			).toEqual([])
		} finally {
			await h.service.stop()
		}
	})
})
