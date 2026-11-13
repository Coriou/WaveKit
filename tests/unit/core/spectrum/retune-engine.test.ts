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
	PendingEpoch,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import { OPERATOR_RETUNE_SETTLE_MS } from "../../../../src/core/spectrum/retune-settle.js"
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
			// A DSP epoch carries no label (the ledger labels its samples).
			tuningTrust: "unverified",
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
		// No operator window: its blocks are labelled by the ledger alone (none here: unverified).
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
		expect(seen.at(-1)?.tuningTrust).toBe("unverified")
		await engine.stop()
	})
})

describe("SpectrumEngine operator retune pending starts", () => {
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
		return { ...made, p }
	}

	it("prunes an older stream's pending epoch at the new stream's start", async () => {
		const { engine, sources, fanout, hosts, p } = await retuned()
		const starts = (): { key: number }[] =>
			(engine as unknown as { starts: { key: number }[] }).starts
		// the first stream's own start, then the retune is pending
		hosts[0]!.handlers.events([
			{
				kind: "epoch-started",
				epoch: p.epoch - 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(starts().find(s => s.key === p.epoch)).toBeDefined()
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
		expect(starts()).toEqual([])
		await engine.stop()
	})
})
