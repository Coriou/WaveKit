import { describe, expect, it } from "vitest"
import pino from "pino"
import {
	SpectrumEngine,
	type EngineEpoch,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	BlockSummary,
	EngineState,
	TrackSnapshot,
	PendingEpoch,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	OPERATOR_RETUNE_SETTLE_MS,
	blockSamplesOf,
} from "../../../../src/core/spectrum/retune-settle.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
const FS = 1_024_000

class RecordingHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(input)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	utilization(): number | null {
		return null
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
	pendings(): PendingEpoch[] {
		return this.inputs.flatMap(i =>
			i.kind === "pending-epoch" ? [i.pending] : [],
		)
	}
}

function makeEngine(networkMs: number) {
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
				s.sweep.settleMs.network = networkMs
			}),
		logger,
		createHost: (_cfg, handlers) => {
			const host = new RecordingHost(handlers)
			hosts.push(host)
			return host
		},
		batchBytes: 4096,
	})
	return { engine, sources, fanout, tuner, hosts }
}

function summary(epoch: number, endSample: number): BlockSummary {
	return {
		sourceId: "rtl",
		stream: 1,
		epoch,
		endSample,
		centreHz: 446_300_000,
		sampleRateHz: FS,
		binHz: 1000,
		startHz: 445_900_000,
		bins: [-90],
		floorDbfs: -90,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: 446_300_000, dcGuardHz: 1500, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

describe("SpectrumEngine operator retune settle (WG9 req 3.4)", () => {
	it("gives a REST retune the operator settle and stale cap", async () => {
		const { engine, sources, fanout, tuner, hosts } = makeEngine(1000)
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const pendings = hosts[0]!.pendings()
		expect(pendings).toHaveLength(1)
		expect(pendings[0]).toMatchObject({
			commandSample: 2000,
			expectMarker: false,
			settleSamples: Math.round((OPERATOR_RETUNE_SETTLE_MS * FS) / 1000),
			staleMaxMs: OPERATOR_RETUNE_SETTLE_MS,
			centreHz: 446_300_000,
			tuningTrust: "commanded",
		})
		await engine.stop()
	})

	it("passes the scanner's own epoch through unchanged (no operator settle, no stale cap)", async () => {
		const { engine, sources, tuner, hosts } = makeEngine(1000)
		await engine.start()
		const clock = engine.sampleClock()
		const scanner: PendingEpoch = {
			epoch: engine.allocateEpoch(),
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			settleSamples: FS,
			expectMarker: true,
			markerTimeoutSamples: 1000,
			pllSettleSamples: 10,
			centreHz: 446_500_000,
			sampleRateHz: FS,
			gainKey: "m:296",
			tuningTrust: "commanded",
			centreChanged: true,
		}
		engine.suppressExternal(true)
		engine.submitEpoch(scanner)
		tuner.emit("command-sent", "rtl", "set-frequency", 446_500_000, "scanner")
		sources.setCaps("rtl", { centerFreq: 446_500_000 })
		engine.suppressExternal(false)
		await settle()
		const pendings = hosts[0]!.pendings()
		expect(pendings).toEqual([scanner])
		expect("staleMaxMs" in pendings[0]!).toBe(false)
		expect("verifiedFromSample" in pendings[0]!).toBe(false)
		// its blocks keep the epoch label from the first one (no unverified window)
		const seen: EngineEpoch[] = []
		engine.on("pipeline", (_ev: PipelineEvent, ep: EngineEpoch) =>
			seen.push(ep),
		)
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: scanner.epoch,
				startSample: 100,
				settleMode: "marker",
			},
			{ kind: "block-summary", summary: summary(scanner.epoch, 100 + 51_200) },
		])
		expect(seen.at(-1)?.tuningTrust).toBe("commanded")
		await engine.stop()
	})

	it("labels blocks before the network settle unverified, then the epoch's own label", async () => {
		const { engine, sources, fanout, tuner, hosts } = makeEngine(1000)
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const p = hosts[0]!.pendings()[0]!
		const cfg = engine.config()!
		const block = blockSamplesOf(cfg.integrationMs, FS, cfg.fftSize)
		const verifiedFrom = p.commandSample + p.bufferedSamples + FS
		const start = p.commandSample + p.bufferedSamples + p.settleSamples
		const seen: { end: number; trust: string }[] = []
		engine.on("pipeline", (ev: PipelineEvent, ep: EngineEpoch) => {
			if (ev.kind === "block-summary")
				seen.push({ end: ev.summary.endSample, trust: ep.tuningTrust })
		})
		const ends = [
			start + block, // first block after the operator settle
			verifiedFrom + block - 1, // straddles the network settle
			verifiedFrom + block, // starts exactly at it
			verifiedFrom + 5 * block,
		]
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch,
				startSample: start,
				settleMode: "timer",
			},
		])
		// tt minor: status agrees with the frames while the unverified window is open
		expect(engine.currentEpoch().tuningTrust).toBe("unverified")
		hosts[0]!.handlers.events(
			ends.slice(0, 2).map(e => ({
				kind: "block-summary" as const,
				summary: summary(p.epoch, e),
			})),
		)
		expect(engine.currentEpoch().tuningTrust).toBe("unverified")
		hosts[0]!.handlers.events(
			ends.slice(2).map(e => ({
				kind: "block-summary" as const,
				summary: summary(p.epoch, e),
			})),
		)
		expect(seen.map(s => s.trust)).toEqual([
			"unverified",
			"unverified",
			"commanded",
			"commanded",
		])
		// the first block at or past the network settle closes the window for status too
		expect(engine.currentEpoch().tuningTrust).toBe("commanded")
		await engine.stop()
	})

	it("carries the network-settle sample in the pending epoch and labels track and transient events by their start (WG9 R1 M1)", async () => {
		const { engine, sources, fanout, tuner, hosts } = makeEngine(1000)
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const p = hosts[0]!.pendings()[0]!
		const verifiedFrom = p.commandSample + p.bufferedSamples + FS
		expect(p.verifiedFromSample).toBe(verifiedFrom)
		const start = p.commandSample + p.bufferedSamples + p.settleSamples
		const prior = engine.currentEpoch()
		const seen: { kind: string; trust: string }[] = []
		engine.on("pipeline", (ev: PipelineEvent, ep: EngineEpoch) => {
			if (ev.kind !== "epoch-started")
				seen.push({ kind: ev.kind, trust: ep.tuningTrust })
		})
		const track = (startSample: number, epoch = p.epoch): TrackSnapshot =>
			({ epoch, startSample, tuningTrust: "commanded" }) as TrackSnapshot
		hosts[0]!.handlers.events([
			// the previous epoch's track closes on the retune with its own label
			{
				kind: "track-close",
				track: track(10, prior.epoch),
				endReason: "retune",
			},
			{
				kind: "epoch-started",
				epoch: p.epoch,
				startSample: start,
				settleMode: "timer",
			},
			{ kind: "track-open", track: track(start) },
			{ kind: "track-update", track: track(verifiedFrom - 1) },
			{ kind: "track-close", track: track(start), endReason: "quiet" },
			{
				kind: "transient",
				centreHz: 446_300_000,
				epoch: p.epoch,
				sample: start,
			},
			{ kind: "track-open", track: track(verifiedFrom) },
			{
				kind: "transient",
				centreHz: 446_300_000,
				epoch: p.epoch,
				sample: verifiedFrom,
			},
			{ kind: "stale-discard", epoch: p.epoch, blocks: 1 },
		])
		expect(seen).toEqual([
			{ kind: "track-close", trust: prior.tuningTrust },
			{ kind: "track-open", trust: "unverified" },
			{ kind: "track-update", trust: "unverified" },
			{ kind: "track-close", trust: "unverified" },
			{ kind: "transient", trust: "unverified" },
			{ kind: "track-open", trust: "commanded" },
			{ kind: "transient", trust: "commanded" },
			{ kind: "stale-discard", trust: "commanded" },
		])
		await engine.stop()
	})

	it("has no unverified window when the network settle is within the operator settle", async () => {
		const { engine, sources, fanout, tuner, hosts } = makeEngine(100)
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const p = hosts[0]!.pendings()[0]!
		expect(p.settleSamples).toBe(Math.round((100 * FS) / 1000))
		expect("verifiedFromSample" in p).toBe(false)
		const start = p.commandSample + p.bufferedSamples + p.settleSamples
		const seen: string[] = []
		engine.on("pipeline", (ev: PipelineEvent, ep: EngineEpoch) => {
			if (ev.kind === "block-summary") seen.push(ep.tuningTrust)
		})
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch,
				startSample: start,
				settleMode: "timer",
			},
			{ kind: "block-summary", summary: summary(p.epoch, start + 51_200) },
		])
		expect(seen).toEqual(["commanded"])
		await engine.stop()
	})
})

describe("SpectrumEngine operator retune window (WG9 R3 minors)", () => {
	async function retuned() {
		const made = makeEngine(1000)
		const { engine, sources, fanout, tuner, hosts } = made
		await engine.start()
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		tuner.emit("command-sent", "rtl", "set-frequency", 446_300_000, "rest")
		sources.setCaps("rtl", { centerFreq: 446_300_000 })
		await settle()
		const p = hosts[0]!.pendings()[0]!
		const cfg = engine.config()!
		const block = blockSamplesOf(cfg.integrationMs, FS, cfg.fftSize)
		const verifiedFrom = p.commandSample + p.bufferedSamples + FS
		const start = p.commandSample + p.bufferedSamples + p.settleSamples
		return { ...made, p, block, verifiedFrom, start }
	}
	const track = (epoch: number, startSample: number): TrackSnapshot =>
		({ epoch, startSample, tuningTrust: "commanded" }) as TrackSnapshot

	it("closes the status window on a track or transient that starts at or past the network settle", async () => {
		for (const kind of ["track-open", "transient"] as const) {
			const { engine, hosts, p, verifiedFrom, start } = await retuned()
			hosts[0]!.handlers.events([
				{
					kind: "epoch-started",
					epoch: p.epoch,
					startSample: start,
					settleMode: "timer",
				},
				{ kind: "track-open", track: track(p.epoch, verifiedFrom - 1) },
			])
			// a track still inside the window keeps status unverified
			expect(engine.currentEpoch().tuningTrust).toBe("unverified")
			hosts[0]!.handlers.events([
				kind === "track-open"
					? { kind, track: track(p.epoch, verifiedFrom) }
					: {
							kind,
							centreHz: 446_300_000,
							epoch: p.epoch,
							sample: verifiedFrom,
						},
			])
			// the pipeline emits tracks before the block summary: status does not lag them
			expect(engine.currentEpoch().tuningTrust).toBe("commanded")
			await engine.stop()
		}
	})

	it("keeps a track opened before the settle unverified across a commanded block, its update and its close", async () => {
		const { engine, hosts, p, block, verifiedFrom, start } = await retuned()
		const seen: { kind: string; trust: string }[] = []
		engine.on("pipeline", (ev: PipelineEvent, ep: EngineEpoch) => {
			if (ev.kind !== "epoch-started")
				seen.push({ kind: ev.kind, trust: ep.tuningTrust })
		})
		const early = track(p.epoch, start)
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch,
				startSample: start,
				settleMode: "timer",
			},
			{ kind: "track-open", track: early },
			{ kind: "block-summary", summary: summary(p.epoch, verifiedFrom + block) },
			{ kind: "track-update", track: early },
			{ kind: "track-close", track: early, endReason: "quiet" },
		])
		expect(seen).toEqual([
			{ kind: "track-open", trust: "unverified" },
			{ kind: "block-summary", trust: "commanded" },
			{ kind: "track-update", trust: "unverified" },
			{ kind: "track-close", trust: "unverified" },
		])
		expect(engine.currentEpoch().tuningTrust).toBe("commanded")
		await engine.stop()
	})

	it("prunes the network-settle entry of an older stream's pending epoch at the new stream's start", async () => {
		const { engine, sources, fanout, hosts, p } = await retuned()
		const verifiedFrom = (): Map<number, number> =>
			(engine as unknown as { verifiedFrom: Map<number, number> })
				.verifiedFrom
		// the first stream's own start, then the retune is pending
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch - 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(verifiedFrom().has(p.epoch)).toBe(true)
		// the source reconnects before the retune's epoch started
		sources.emit("disconnected", "rtl")
		sources.emit("payload-started", "rtl")
		fanout.write(Buffer.alloc(4000, 7))
		await settle()
		const opened = hosts[0]!.inputs.find(i => i.kind === "new-stream")
		expect(opened).toBeDefined()
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(verifiedFrom().size).toBe(0)
		await engine.stop()
	})
})
