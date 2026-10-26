/**
 * acarsdec replay chain on a SYNTHETIC ACARS capture (scripts/fixtures/acars-msk.mjs, 48 kHz AM
 * IQ): plan → replay transport (capture stream as decoder input, AM demodulation at 48 kHz then
 * 12 kHz audio) → probe pool → pool adapter → scanner evidence and trial memory. The acarsdec
 * child is mocked: its line is what the image's acarsdec printed for this fixture's audio
 * (made-up registration, flight and text). One CRC-clean block decodes; a block with errors does
 * not; a cancelled trial is no failure.
 */
import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import { acarsCf32 } from "../../../../scripts/fixtures/acars-msk.mjs"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import {
	IQ_CAPTURE_MAX_BYTES,
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
import {
	createAcarsdecDecoder,
	NON_FINITE_SCAN_MAX_CHARS,
	nonFiniteToNull,
} from "../../../../src/decoders/builtin/acarsdec.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import { interpretAcarsReplay } from "../../../../src/core/scanner/probes/confirm/acars.js"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const RF = CENTRE + 50_000
/** The image's acarsdec on the fixture's audio (station id replaced; `-inf`: no noise estimate). */
const line = (error: number) =>
	`{"timestamp":1793016607.877815,"station_id":"test","channel":0,"freq":0.000,"level":-8.0,"noise":-inf,"error":${error},"mode":"2","label":"H1","block_id":"1","ack":false,"tail":"N12345","flight":"XX0001","msgno":"M01A","text":"WAVEKIT TEST","app":{"name":"acarsdec","ver":"206f733"}}`
const IDENTITY = { kind: "acars-reg", value: "N12345" }

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

async function replayThroughPool(lines: string[], end: "clean" | "cut") {
	const capture = acarsCf32()
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
		knownProtocol: "acars",
		priors: {},
		narrowRaster: false,
	})[0]
	if (trial?.mode.decoderType !== "acarsdec")
		throw new Error("no acarsdec trial")
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
	expect(openReplay).toHaveBeenCalledWith("cap-1", "acarsdec")
	const [id, decoder] = [...h.decoders.created.entries()][0]!
	// The real adapter's command: AM at the 48 kHz replay rate, then 12 kHz audio for acarsdec.
	const acarsdec = createAcarsdecDecoder(
		decoder.config,
		pino({ level: "silent" }),
	)
	const argv = (acarsdec as unknown as { getArgs(): string[] }).getArgs()
	expect(argv[1]).toContain("csdr amdemod")
	expect(argv[1]).toContain(
		"sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 12000 -",
	)
	expect(argv[1]).toContain(
		"acarsdec --output json:file:path=- --sndfile /dev/stdin,subtype=0x02 -m 1",
	)
	expect(argv[1]).not.toContain("firdecimate")
	if (end === "clean") input.end(capture)
	else input.write(capture)
	await flushAsync()
	expect(decoder.received().equals(capture)).toBe(true)
	const parse = (l: string): DecoderOutput | null =>
		(
			acarsdec as unknown as { parseOutput(l: string): DecoderOutput | null }
		).parseOutput(l)
	for (const l of lines) {
		const out = parse(l)
		expect(out).not.toBeNull()
		if (out) h.decoders.emitOutput(id, out)
	}
	if (end === "cut") input.destroy(new Error("replay failed"))
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
	const track = trackOf({ trackId: "t1", centreHz: RF, obwHz: 8000, epoch: 1 })
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

const trial = {
	protocol: "acars" as const,
	known: true,
	mode: {
		decoderType: "acarsdec" as const,
		protocol: "acars" as const,
		covers: ["acars" as const],
		options: {},
		holdMs: 4000,
	},
}
const result = (over: Partial<IqReplayResult>): IqReplayResult => ({
	captureId: "cap-1",
	sourceId: "rtl",
	observationId: "o_1",
	epoch: 1,
	rfHz: RF,
	trials: [],
	decoded: null,
	...over,
})

describe("interpretAcarsReplay", () => {
	const out = (data: Record<string, unknown>) => ({
		type: "acars",
		data: { tail: "N12345", error: 0, errorKnown: true, ...data },
		timestamp: new Date(1_000),
	})
	const run = (data: Record<string, unknown>, channelHz = RF) =>
		interpretAcarsReplay(
			out(data),
			createInterpreterState({ epoch: 1, origin: "probe", decoderId: "p" }),
			channelHz,
		)

	it("one clean block is the identity at the capture's channel; anything doubtful is none", () => {
		expect(run({})[0]).toMatchObject({ protocol: "acars", identity: IDENTITY })
		expect(run({ frequency: 0 })[0]?.identity).toEqual(IDENTITY)
		expect(run({ error: 1 })).toEqual([])
		// an error count acarsdec did not print is no evidence (the adapter's 0 is a default)
		expect(run({ errorKnown: false })).toEqual([])
		expect(run({ errorKnown: undefined })).toEqual([])
		expect(run({ tail: "no such tail!" })).toEqual([])
		expect(run({ frequency: RF + 20_000 })).toEqual([])
		// an implausible registration never stands on one block; a plausible one does
		for (const tail of ["-------", "--", ".", "A", "..-..", "N1234567X"])
			expect(run({ tail })).toEqual([])
		expect(run({ tail: "..N12345" })[0]?.identity).toEqual(IDENTITY)
		expect(run({ frequency: Number.NaN })).toEqual([])
		expect(run({}, 0)).toEqual([])
		expect(run({}, Number.NaN)).toEqual([])
		expect(
			interpretAcarsReplay(
				{ type: "acars", data: null, timestamp: new Date(1) },
				createInterpreterState({ epoch: 1, origin: "probe", decoderId: "p" }),
				RF,
			),
		).toEqual([])
	})
})

describe("acarsdec replay chain (synthetic ACARS)", () => {
	it("the fixture is one capture file; acarsdec's -inf is read as no value", () => {
		expect(acarsCf32().length).toBeLessThanOrEqual(IQ_CAPTURE_MAX_BYTES)
		expect(nonFiniteToNull('{"level":-8.0,"noise":-inf,"x":nan}')).toBe(
			'{"level":-8.0,"noise":null,"x":null}',
		)
		// a line past the bound is not scanned (it then fails JSON parsing, as before)
		const long = `{"noise":-inf,"pad":"${"x".repeat(NON_FINITE_SCAN_MAX_CHARS)}"}`
		expect(nonFiniteToNull(long)).toBe(long)
		// inside a string it is text, not a value
		expect(nonFiniteToNull('{"text":"a,\\"b\\":inf,c"}')).toBe(
			'{"text":"a,\\"b\\":inf,c"}',
		)
	})

	it("ONE CRC-clean block decodes; it lands on the discovery and in trial memory", async () => {
		const answer = await replayThroughPool([line(0)], "clean")
		expect(answer).toEqual({
			outcome: "decoded",
			decoded: { protocol: "acars", identity: IDENTITY },
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
			internals.replayPlans.set("cap-1", [trial])
			h.service.applyReplayResult(
				result({
					trials: [
						{
							protocol: "acars",
							decoderType: "acarsdec",
							known: true,
							outcome: answer.outcome,
						},
					],
					decoded: answer.decoded,
				}),
			)
			expect(applied).toHaveBeenCalledWith(
				expect.objectContaining({ observationId: "o_1" }),
				expect.objectContaining({
					protocol: "acars",
					identity: IDENTITY,
					crcClean: true,
				}),
			)
			expect(
				h.service
					.trialMemoryOf("d_1")
					.map(e => [e.protocol, e.decoder, e.lastOutcome]),
			).toEqual([["acars", "acarsdec", "decoded"]])
		} finally {
			await h.service.stop()
		}
	})

	it.each([
		["-inf", '"freq":-inf'],
		["false", '"freq":false'],
		["a string", '"freq":"131.550"'],
		["nan", '"freq":nan'],
		["null", '"freq":null'],
	])("a malformed frequency (%s) is no decode", async (_n, field) => {
		const bad = line(0).replace('"freq":0.000', field)
		const answer = await replayThroughPool([bad], "clean")
		expect(answer.decoded).toBeNull()
	})

	it.each([
		["absent", (l: string) => l.replace('"freq":0.000,', "")],
		["0", (l: string) => l],
	])("a frequency %s is still accepted", async (_n, edit) => {
		const answer = await replayThroughPool([edit(line(0))], "clean")
		expect(answer.decoded).toEqual({ protocol: "acars", identity: IDENTITY })
	})

	it("a line without an error field is no decode", async () => {
		const noError = line(0).replace('"error":0,', "")
		const answer = await replayThroughPool([noError, noError], "clean")
		expect(answer.decoded).toBeNull()
		expect(answer.outcome).not.toBe("decoded")
	})

	it("a block with errors (acarsdec error > 0) is no decode, however many", async () => {
		const answer = await replayThroughPool([line(1), line(2)], "clean")
		expect(answer.decoded).toBeNull()
		expect(answer.outcome).not.toBe("decoded")
	})

	it("a replay cut short is cancelled: its block is dropped and it is no failed attempt", async () => {
		const answer = await replayThroughPool([line(0)], "cut")
		expect(answer).toEqual({ outcome: "cancelled", decoded: null })
		const { h, internals } = scanner()
		await h.service.start()
		try {
			internals.replayPlans.set("cap-1", [trial])
			h.service.applyReplayResult(
				result({
					trials: [
						{
							protocol: "acars",
							decoderType: "acarsdec",
							known: true,
							outcome: "cancelled",
						},
					],
				}),
			)
			expect(
				h.service
					.trialMemoryOf("d_1")
					.filter(e => e.attempts > 0 || e.consecutiveFailures > 0),
			).toEqual([])
		} finally {
			await h.service.stop()
		}
	})
})
