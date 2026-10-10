import { describe, expect, it } from "vitest"
import fc from "fast-check"
import pino from "pino"
import {
	buildPipelineConfig,
	DEFAULT_TUNING,
	SpectrumEngine,
	type EngineEpoch,
	type EngineStreamReason,
	type SpectrumEngineDeps,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineState,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

const logger = pino({ level: "silent" })
const EMPTY_STATE: EngineState = {
	version: 1,
	absoluteFloors: [],
	spurs: [],
	kByRange: [],
}

/** Records every input the engine posts; bytes are copied because buffers are recycled. */
class RecordingHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(
			input.kind === "bytes"
				? { ...input, bytes: Uint8Array.from(input.bytes) }
				: input,
		)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve(EMPTY_STATE)
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
}

function makeEngine(extra: Partial<SpectrumEngineDeps> = {}) {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const tuner = new FakeTuner()
	const hosts: RecordingHost[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () =>
			testSettings(s => {
				s.sweep.settleMs.network = 100
			}),
		logger,
		createHost: (_cfg, handlers) => {
			const host = new RecordingHost(handlers)
			hosts.push(host)
			return host
		},
		batchBytes: 4096,
		...extra,
	})
	return { engine, sources, fanout, tuner, hosts }
}

/** Rebuilds each stream's sample bytes from posted inputs; gaps stay `null`. */
function rebuild(
	inputs: PipelineInput[],
): { stream: number; bytes: (number | null)[] }[] {
	const streams: { stream: number; bytes: (number | null)[] }[] = []
	for (const input of inputs) {
		if (input.kind === "new-stream") {
			streams.push({ stream: input.stream, bytes: [] })
			continue
		}
		const current = streams.at(-1)
		if (!current) continue
		if (input.kind === "bytes") {
			expect(input.startSample * 2).toBe(current.bytes.length)
			for (const b of input.bytes) current.bytes.push(b)
		} else if (input.kind === "gap") {
			expect(input.startSample * 2).toBe(current.bytes.length)
			for (let i = 0; i < input.samples * 2; i++) current.bytes.push(null)
		}
	}
	return streams
}

describe("SpectrumEngine sample accounting", () => {
	// Feature: signal-discovery-scanner, Property 6: Epoch and gap accounting
	// Validates: spec § 4.1, § 4.6
	it("keeps absolute indices consistent across fanout drops and reconnects", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.array(fc.integer({ min: 1, max: 1500 }), {
					minLength: 4,
					maxLength: 24,
				}),
				fc.array(fc.tuple(fc.nat(23), fc.integer({ min: 1, max: 3 })), {
					maxLength: 3,
				}),
				fc.option(fc.nat(23), { nil: null }),
				async (seed, chunkSamples, congestions, reconnectAt) => {
					const { engine, sources, fanout, hosts } = makeEngine()
					await engine.start()
					const rng = mulberry32(seed)
					const sent: {
						stream: number
						bytes: number[]
						dropped: boolean[]
					}[] = [{ stream: 0, bytes: [], dropped: [] }]
					let congestedUntil = -1
					for (let i = 0; i < chunkSamples.length; i++) {
						if (reconnectAt === i) {
							await settle()
							sources.emit("disconnected", "rtl")
							sent.push({ stream: sent.length, bytes: [], dropped: [] })
						}
						const episode = congestions.find(([at]) => at === i)
						if (episode && congestedUntil < i) {
							await settle()
							fanout.congest("scanner-rtl")
							congestedUntil = i + episode[1] - 1
						}
						const chunk = Buffer.alloc(chunkSamples[i]! * 2)
						for (let j = 0; j < chunk.length; j++)
							chunk[j] = Math.floor(rng() * 256)
						const dropped = congestedUntil >= i
						fanout.write(chunk)
						const cur = sent.at(-1)!
						for (const b of chunk) {
							cur.bytes.push(b)
							cur.dropped.push(dropped)
						}
						if (congestedUntil === i) fanout.drain("scanner-rtl")
						if (reconnectAt === i) sources.emit("payload-started", "rtl")
					}
					// An episode running past the last chunk still ends (and reports its drops).
					await settle()
					if (congestedUntil >= chunkSamples.length) fanout.drain("scanner-rtl")
					await settle()
					await engine.stop()
					const streams = rebuild(hosts[0]!.inputs)
					expect(streams.map(s => s.stream)).toEqual(
						[...streams.map(s => s.stream)].sort((a, b) => a - b),
					)
					expect(new Set(streams.map(s => s.stream)).size).toBe(streams.length)
					expect(streams).toHaveLength(sent.length)
					for (let k = 0; k < sent.length; k++) {
						const got = streams[k]!.bytes
						const want = sent[k]!
						expect(got).toHaveLength(want.bytes.length)
						for (let j = 0; j < got.length; j++) {
							if (want.dropped[j]) expect(got[j]).toBeNull()
							else expect(got[j]).toBe(want.bytes[j])
						}
					}
				},
			),
			{ numRuns: 100, seed: 0x5ca7 },
		)
	}, 120_000)

	it("serves ring reads by absolute sample index after a drop", async () => {
		const { engine, fanout } = makeEngine()
		await engine.start()
		const a = Buffer.alloc(2000, 1)
		const b = Buffer.alloc(2000, 2)
		const c = Buffer.alloc(2000, 3)
		fanout.write(a)
		await settle()
		fanout.congest("scanner-rtl")
		fanout.write(b)
		fanout.drain("scanner-rtl")
		fanout.write(c)
		await settle()
		expect(engine.liveEdge()).toBe(3000)
		const read = engine.readRing(2000, 3000)
		expect(read?.startSample).toBe(2000)
		expect([...(read?.bytes ?? [])].every(v => v === 3)).toBe(true)
		const across = engine.readRing(500, 3000)
		expect(across?.startSample).toBe(2000)
		await engine.stop()
	})

	it("splits a drop episode that spans a reconnect between the two streams", async () => {
		const { engine, sources, fanout, hosts } = makeEngine()
		await engine.start()
		fanout.write(Buffer.alloc(1000, 1))
		await settle()
		fanout.congest("scanner-rtl")
		fanout.write(Buffer.alloc(600, 2))
		sources.emit("disconnected", "rtl")
		fanout.write(Buffer.alloc(400, 3))
		fanout.drain("scanner-rtl")
		sources.emit("payload-started", "rtl")
		fanout.write(Buffer.alloc(200, 4))
		await settle()
		await engine.stop()
		const streams = rebuild(hosts[0]!.inputs)
		expect(streams.map(s => s.bytes.length)).toEqual([1600, 600])
		expect(streams[0]!.bytes.slice(1000).every(b => b === null)).toBe(true)
		expect(streams[1]!.bytes.slice(0, 400).every(b => b === null)).toBe(true)
		expect(streams[1]!.bytes.slice(400).every(b => b === 4)).toBe(true)
	})

	it("keeps bytes still buffered in the branch at a disconnect in the old stream", async () => {
		const { engine, sources, fanout, hosts } = makeEngine()
		await engine.start()
		fanout.write(Buffer.alloc(1000, 1))
		sources.emit("disconnected", "rtl")
		fanout.write(Buffer.alloc(200, 2))
		sources.emit("payload-started", "rtl")
		await settle()
		await engine.stop()
		const streams = rebuild(hosts[0]!.inputs)
		expect(streams.map(s => s.bytes.length)).toEqual([1000, 200])
		expect(streams[0]!.bytes.every(b => b === 1)).toBe(true)
		expect(streams[1]!.bytes.every(b => b === 2)).toBe(true)
	})

	it("posts one timer-mode epoch for an external retune before any later bytes", async () => {
		const { engine, sources, fanout, tuner, hosts } = makeEngine()
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		fanout.write(Buffer.alloc(4000, 9))
		await settle()
		const inputs = hosts[0]!.inputs
		const pendings = inputs.filter(i => i.kind === "pending-epoch")
		expect(pendings).toHaveLength(1)
		const p =
			pendings[0]!.kind === "pending-epoch" ? pendings[0]!.pending : null
		expect(p).toMatchObject({
			commandSample: 2000,
			expectMarker: false,
			settleSamples: Math.round((100 * 1_024_000) / 1000),
			centreHz: 446_300_000,
			tuningTrust: "commanded",
			centreChanged: true,
		})
		const at = inputs.findIndex(i => i.kind === "pending-epoch")
		const laterBytes = inputs.slice(at + 1).filter(i => i.kind === "bytes")
		expect(
			laterBytes.every(i => i.kind === "bytes" && i.startSample >= 2000),
		).toBe(true)
		const earlier = inputs.slice(0, at).filter(i => i.kind === "bytes")
		expect(earlier.every(i => i.kind === "bytes" && i.startSample < 2000)).toBe(
			true,
		)
		await engine.stop()
	})

	it("ignores the scanner's own commands while suppressed", async () => {
		const { engine, sources, tuner, hosts } = makeEngine()
		await engine.start()
		engine.suppressExternal(true)
		tuner.emit("command-sent", "rtl", "set-frequency", 446_500_000, "scanner")
		sources.setCaps("rtl", { centerFreq: 446_500_000 })
		engine.suppressExternal(false)
		await settle()
		expect(
			hosts[0]!.inputs.filter(i => i.kind === "pending-epoch"),
		).toHaveLength(0)
		await engine.stop()
	})

	it("recreates the pipeline as a new stream when the sample rate changes", async () => {
		const { engine, sources, hosts } = makeEngine()
		await engine.start()
		sources.setCaps("rtl", { sampleRate: 2_048_000 })
		await settle()
		await settle()
		expect(hosts).toHaveLength(2)
		const ns = hosts[1]!.inputs.find(i => i.kind === "new-stream")
		expect(ns).toMatchObject({
			kind: "new-stream",
			stream: 1,
			sampleRateHz: 2_048_000,
		})
		await engine.stop()
	})
})

describe("SpectrumEngine with the real pipeline (inline host)", () => {
	// Feature: signal-discovery-scanner, Property 6: Epoch and gap accounting
	// Validates: spec § 4.6
	it("opens tracks of a retuned epoch only after its settled start, at the new RF", async () => {
		const fs = 1_024_000
		const sources = new FakeSources("rtl", { sampleRate: fs })
		const fanout = new FakeFanout()
		const tuner = new FakeTuner()
		const events: PipelineEvent[] = []
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources,
			routing: {
				getFanout: () => fanout as never,
				releaseUnused: () => undefined,
			},
			tuner,
			settings: () =>
				testSettings(s => {
					s.sweep.settleMs.network = 100
				}),
			logger,
			host: "inline",
		})
		engine.on("pipeline", (ev: PipelineEvent) => events.push(ev))
		await engine.start()
		const rng = mulberry32(42)
		const write = (n: number) => {
			const iq = addInto(gaussianNoise(rng, n, 0.05), tone(n, fs, 100_000, 0.5))
			fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
		}
		for (let i = 0; i < 6; i++) write(fs / 20)
		await settle()
		const commandSample = engine.liveEdge()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		// The same baseband scene reads as stale (§ 4.6) for up to STALE_MAX_MS (1 s) after the settled
		// start, then needs minSurfaceBlocks to open: feed 1.5 s after the command.
		for (let i = 0; i < 30; i++) write(fs / 20)
		await settle()
		await engine.stop()
		const started = events.filter(
			(e): e is Extract<PipelineEvent, { kind: "epoch-started" }> =>
				e.kind === "epoch-started" && e.settleMode === "timer",
		)
		expect(started).toHaveLength(1)
		const epoch = started[0]!
		expect(epoch.startSample).toBeGreaterThanOrEqual(
			commandSample + Math.round(0.1 * fs),
		)
		const opened = events.filter(
			(e): e is Extract<PipelineEvent, { kind: "track-open" }> =>
				e.kind === "track-open" && e.track.epoch === epoch.epoch,
		)
		expect(opened.length).toBeGreaterThan(0)
		for (const e of opened) {
			expect(e.track.startSample).toBeGreaterThanOrEqual(epoch.startSample)
			expect(Math.abs(e.track.centreHz - 446_400_000)).toBeLessThan(2_000)
		}
	}, 60_000)
})

describe("SpectrumEngine untracked retunes (§ 4.7)", () => {
	it("marks an untracked retune unverified without posting an epoch of its own", async () => {
		const { engine, hosts } = makeEngine()
		await engine.start()
		const host = hosts[0]!
		const before = host.inputs.length
		host.handlers.events([
			{
				kind: "untracked-retune",
				epoch: 7,
				startSample: 4096,
				deltaHz: -12_500,
			},
			{
				kind: "epoch-started",
				epoch: 7,
				startSample: 4096,
				settleMode: "none",
			},
		])
		expect(
			host.inputs.slice(before).filter(i => i.kind === "pending-epoch"),
		).toEqual([])
		expect(engine.currentEpoch()).toMatchObject({
			epoch: 7,
			tuningTrust: "unverified",
			startSample: 4096,
		})
		expect(engine.warnings()).toEqual([
			{ code: "untracked-retune", deltaHz: -12_500, at: expect.any(Number) },
		])
		await engine.stop()
	})
})

describe("SpectrumEngine pipeline config", () => {
	it("builds the pipeline with the engine summary budget, not the client bins", () => {
		const cfg = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			2_048_000,
			testSettings(s => {
				s.ws.spectrumBins = 256
			}),
			DEFAULT_TUNING,
		)
		expect(cfg.spectrumBins).toBe(2048)
		const smaller = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			2_048_000,
			testSettings(s => {
				s.ws.spectrumBins = 256
				s.ws.spectrumSummaryBins = 1024
			}),
			DEFAULT_TUNING,
		)
		expect(smaller.spectrumBins).toBe(1024)
	})
})

describe("SpectrumEngine stream events (R2)", () => {
	type LogEntry =
		| ["stream", number, EngineStreamReason]
		| ["pipeline", PipelineEvent["kind"], number]

	function record(engine: SpectrumEngine): LogEntry[] {
		const log: LogEntry[] = []
		engine.on("stream", (stream: number, reason: EngineStreamReason) =>
			log.push(["stream", stream, reason]),
		)
		engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) =>
			log.push(["pipeline", ev.kind, epoch.stream]),
		)
		return log
	}

	it("emits stream with restart before the restarted stream's first pipeline event", async () => {
		const fanout = new FakeFanout()
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources: new FakeSources(),
			routing: {
				getFanout: () => fanout as never,
				releaseUnused: () => undefined,
			},
			tuner: new FakeTuner(),
			settings: () => testSettings(),
			logger,
			host: "inline",
		})
		const log = record(engine)
		await engine.start()
		// The first stream is announced too, as "restart" (Tasks 35 and 37a rely on it).
		expect(log[0]).toEqual(["stream", 0, "restart"])
		await engine.reconfigure()
		const at = log.findIndex(e => e[0] === "stream" && e[1] === 1)
		expect(log[at]).toEqual(["stream", 1, "restart"])
		// The inline pipeline answers new-stream with epoch-started synchronously.
		const first = log.findIndex(e => e[0] === "pipeline" && e[2] === 1)
		expect(first).toBeGreaterThan(at)
		expect(log[first]).toEqual(["pipeline", "epoch-started", 1])
		await engine.stop()
	})

	it("emits stream with stop from stop(), after the last pipeline event", async () => {
		const { engine, hosts } = makeEngine()
		const log = record(engine)
		await engine.start()
		hosts[0]!.handlers.events([
			{ kind: "epoch-started", epoch: 1, startSample: 0, settleMode: "none" },
		])
		await engine.stop()
		expect(log.at(-1)).toEqual(["stream", 0, "stop"])
		await engine.stop()
		expect(log.filter(e => e[0] === "stream" && e[2] === "stop")).toHaveLength(
			1,
		)
	})

	it("announces a reconnect boundary and keeps late old-stream epochs on the old stream", async () => {
		const { engine, sources, tuner, hosts } = makeEngine()
		const log = record(engine)
		await engine.start()
		const host = hosts[0]!
		host.handlers.events([
			{ kind: "epoch-started", epoch: 1, startSample: 0, settleMode: "none" },
		])
		// An external retune posts a pending epoch on stream 0.
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const pending = host.inputs.find(i => i.kind === "pending-epoch")
		const epoch = pending?.kind === "pending-epoch" ? pending.pending.epoch : -1
		expect(epoch).toBeGreaterThan(1)
		// No bytes are buffered, so the boundary applies at once: stream 1 is announced, then posted.
		sources.emit("disconnected", "rtl")
		expect(log.at(-1)).toEqual(["stream", 1, "restart"])
		expect(host.inputs.at(-1)).toMatchObject({ kind: "new-stream", stream: 1 })
		// A thread host still delivers stream 0's epoch and events, then stream 1's own start.
		host.handlers.events([
			{ kind: "epoch-started", epoch, startSample: 1000, settleMode: "timer" },
			{ kind: "transient", centreHz: 446_310_000, epoch, sample: 1200 },
		])
		expect(engine.currentEpoch()).toMatchObject({
			stream: 0,
			epoch,
			startSample: 1000,
			centreHz: 446_300_000,
			tuningTrust: "commanded",
		})
		expect(log.slice(-2)).toEqual([
			["pipeline", "epoch-started", 0],
			["pipeline", "transient", 0],
		])
		host.handlers.events([
			{
				kind: "epoch-started",
				epoch: epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(engine.currentEpoch()).toMatchObject({
			stream: 1,
			epoch: epoch + 1,
			startSample: 0,
			centreHz: 446_300_000,
			tuningTrust: "unverified",
			settleMode: "none",
		})
		await engine.stop()
	})
})

describe("SpectrumEngine restart failures", () => {
	it("reports a host that cannot be created on a rate change as an error, not an unhandled rejection", async () => {
		const rejections: unknown[] = []
		const onRejection = (reason: unknown): void => {
			rejections.push(reason)
		}
		process.on("unhandledRejection", onRejection)
		try {
			let calls = 0
			const { engine, sources } = makeEngine({
				createHost: (_cfg, handlers) => {
					calls += 1
					if (calls > 1) {
						throw new WaveKitError("worker missing", "SCANNER_WORKER_MISSING")
					}
					return new RecordingHost(handlers)
				},
			})
			const errors: Error[] = []
			engine.on("error", (err: Error) => errors.push(err))
			await engine.start()
			sources.setCaps("rtl", { sampleRate: 2_048_000 })
			await settle()
			await settle()
			expect(calls).toBe(2)
			expect(errors).toHaveLength(1)
			expect(errors[0]).toMatchObject({ code: "SCANNER_WORKER_MISSING" })
			expect(rejections).toEqual([])
			await engine.stop()
		} finally {
			process.off("unhandledRejection", onRejection)
		}
	})

	it("reports a restart onto a source that is no longer IQ", async () => {
		const { engine, sources, hosts } = makeEngine()
		const errors: Error[] = []
		engine.on("error", (err: Error) => errors.push(err))
		await engine.start()
		sources.setCaps("rtl", {
			kind: "audio_pcm",
			format: "S16LE",
			sampleRate: 48_000,
		})
		await settle()
		await settle()
		expect(hosts).toHaveLength(1)
		expect(errors).toHaveLength(1)
		expect(errors[0]).toMatchObject({ code: "SCANNER_SOURCE_NOT_IQ" })
		await engine.stop()
	})
})

describe("SpectrumEngine sub-sample gaps", () => {
	it("realigns after a drop that ends mid-sample (S16, 6-byte chunks)", async () => {
		const { engine, fanout, hosts } = makeEngine({
			sources: new FakeSources("rtl", { format: "S16_IQ" }),
		})
		await engine.start()
		await settle()
		// Chunk k carries bytes 6k+1 … 6k+6; samples are 4 bytes.
		const chunk = (k: number): Buffer =>
			Buffer.from(Array.from({ length: 6 }, (_, j) => 6 * k + j + 1))
		fanout.write(chunk(0))
		await settle()
		fanout.congest("scanner-rtl")
		fanout.write(chunk(1))
		fanout.write(chunk(2))
		fanout.drain("scanner-rtl")
		fanout.write(chunk(3))
		await settle()
		// Lost: bytes 4-17 (the half sample held back, then 12 dropped) = samples 1-4,
		// plus the first 2 bytes of chunk 3, which finish sample 4.
		expect(engine.liveEdge()).toBe(6)
		expect([...(engine.readRing(5, 6)?.bytes ?? [])]).toEqual([21, 22, 23, 24])
		await engine.stop()
		const posted = hosts[0]!.inputs.filter(
			i => i.kind === "bytes" || i.kind === "gap",
		)
		expect(
			posted.map(i =>
				i.kind === "bytes"
					? { kind: i.kind, startSample: i.startSample, bytes: [...i.bytes] }
					: i,
			),
		).toEqual([
			{ kind: "bytes", startSample: 0, bytes: [1, 2, 3, 4] },
			{ kind: "gap", startSample: 1, samples: 4 },
			{ kind: "bytes", startSample: 5, bytes: [21, 22, 23, 24] },
		])
		expect(engine.accounting().gapSamples).toBe(4)
	})
})
