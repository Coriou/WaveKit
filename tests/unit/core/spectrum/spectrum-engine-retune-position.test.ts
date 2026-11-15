/**
 * A retune's command position (EngineEpoch.pendingRetuneSample, retunedFromSample): the engine
 * reports where a posted retune moved the tuner (commandSample + bufferedSamples posted), while it
 * is pending and on the epoch it started, so a consumer reading the old epoch's samples stops
 * there rather than at the settled start. A recording host stands in for the pipeline; its
 * epoch-started events are injected.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import {
	SpectrumEngine,
	type EngineEpoch,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	EngineState,
	PendingEpoch,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import type { WorkerPipelineInput } from "../../../../src/core/spectrum/worker-protocol.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

const RATE = 1_024_000
const logger = pino({ level: "silent" })

class RecordingHost implements PipelineHost {
	readonly inputs: WorkerPipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: WorkerPipelineInput, transfer?: ArrayBuffer): void {
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
}

async function make() {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const hosts: RecordingHost[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner: new FakeTuner(),
		settings: () => testSettings(),
		logger,
		createHost: (_cfg, handlers) => {
			const host = new RecordingHost(handlers)
			hosts.push(host)
			return host
		},
		batchBytes: 4096,
	})
	const started: EngineEpoch[] = []
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
		if (ev.kind === "epoch-started") started.push(epoch)
	})
	await engine.start()
	const events = (evs: PipelineEvent[]): void =>
		hosts.at(-1)!.handlers.events(evs)
	events([
		{ kind: "epoch-started", epoch: 1, startSample: 0, settleMode: "none" },
	])
	/** Feeds `samples` U8 IQ samples through the fanout into the engine. */
	const feed = async (samples: number): Promise<void> => {
		fanout.write(Buffer.alloc(samples * 2, 127))
		await settle()
	}
	/** A scanner hop posted now, `buffered` samples held in the core at its command. */
	const hop = (centreHz: number, buffered: number): PendingEpoch => {
		const pending: PendingEpoch = {
			epoch: engine.allocateEpoch(),
			commandSample: engine.sampleClock().commandSample,
			bufferedSamples: buffered,
			settleSamples: 1000,
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz,
			sampleRateHz: RATE,
			gainKey: "m:296",
			tuningTrust: "commanded",
			centreChanged: true,
		}
		engine.submitEpoch(pending)
		return pending
	}
	return { engine, sources, events, feed, hop, started }
}

describe("SpectrumEngine retune command positions", () => {
	it("reports the oldest pending start's position, then the matched start's (min incl. superseded) at epoch-started", async () => {
		const { engine, events, feed, hop, started } = await make()
		await feed(4000)
		expect(engine.liveEdge()).toBe(4000)
		const first = hop(446_200_000, 100)
		// Every sample received (4000) or held in the core (100) at the command is of the old tuning.
		expect(engine.currentEpoch().pendingRetuneSample).toBe(4100)
		await feed(2000)
		// A later post: the earlier one still moved the tuner at its own command.
		const second = hop(446_300_000, 50)
		expect(engine.currentEpoch().pendingRetuneSample).toBe(4100)
		expect(engine.currentEpoch().retunedFromSample).toBeUndefined()
		await feed(3000)
		// The pipeline starts the later post; the earlier never starts (superseded).
		events([
			{
				kind: "epoch-started",
				epoch: second.epoch,
				startSample: 8000,
				settleMode: "timer",
			},
		])
		const ev = started.at(-1)!
		expect(ev.epoch).toBe(second.epoch)
		expect(ev.centreHz).toBe(446_300_000)
		expect(ev.retunedFromSample).toBe(4100)
		expect(ev.pendingRetuneSample).toBeUndefined()
		const now = engine.currentEpoch()
		expect(now.epoch).toBe(second.epoch)
		expect(now.startSample).toBe(8000)
		expect(now.retunedFromSample).toBe(4100)
		// The superseded post left nothing pending: no stale position.
		expect(now.pendingRetuneSample).toBeUndefined()
		expect(first.epoch).toBeLessThan(second.epoch)
		// A lone post that starts under its own id: its own position.
		await feed(1000)
		const third = hop(446_400_000, 0)
		expect(engine.currentEpoch().pendingRetuneSample).toBe(10_000)
		events([
			{
				kind: "epoch-started",
				epoch: third.epoch,
				startSample: 11_000,
				settleMode: "timer",
			},
		])
		expect(started.at(-1)!.retunedFromSample).toBe(10_000)
		expect(engine.currentEpoch().retunedFromSample).toBe(10_000)
		expect(engine.currentEpoch().pendingRetuneSample).toBeUndefined()
		await engine.stop()
	})

	it("reports neither field with no pending hop, on an opening, or for a start that matches no post", async () => {
		const { engine, events, feed, hop, started } = await make()
		await feed(2000)
		const open = engine.currentEpoch()
		expect(open.pendingRetuneSample).toBeUndefined()
		expect(open.retunedFromSample).toBeUndefined()
		expect(started.at(-1)!.retunedFromSample).toBeUndefined()
		// A post with a clock that is not a sample index carries no position.
		const bad = hop(446_200_000, Number.NaN)
		expect(engine.currentEpoch().pendingRetuneSample).toBeUndefined()
		events([
			{
				kind: "epoch-started",
				epoch: bad.epoch,
				startSample: 3000,
				settleMode: "timer",
			},
		])
		expect(engine.currentEpoch().retunedFromSample).toBeUndefined()
		// A posted-mode start the queue cannot name (nothing pending): no position.
		events([
			{
				kind: "epoch-started",
				epoch: bad.epoch + 5,
				startSample: 3500,
				settleMode: "timer",
			},
		])
		expect(started.at(-1)!.retunedFromSample).toBeUndefined()
		expect(engine.currentEpoch().retunedFromSample).toBeUndefined()
		await engine.stop()
	})

	it("a retune on a new stream and a superseded pending start leave no stale position", async () => {
		const { engine, sources, events, feed, hop, started } = await make()
		await feed(4000)
		const old = hop(446_200_000, 0)
		expect(engine.currentEpoch().pendingRetuneSample).toBe(4000)
		// The connection drops: stream 1 opens (its own numbering from 0) while stream 0's
		// opening-to-come has not arrived; the current epoch is still stream 0's.
		sources.emit("disconnected", "rtl")
		await settle()
		await feed(500)
		const fresh = hop(446_300_000, 20)
		const before = engine.currentEpoch()
		expect(before.stream).toBe(0)
		// Stream 1's post is in stream 1's numbering: never reported against stream 0.
		expect(before.pendingRetuneSample).toBe(4000)
		// Stream 1's own opening: stream 0's post can no longer start and is dropped.
		events([
			{
				kind: "epoch-started",
				epoch: old.epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		const opened = engine.currentEpoch()
		expect(opened.stream).toBe(1)
		expect(opened.retunedFromSample).toBeUndefined()
		expect(started.at(-1)!.retunedFromSample).toBeUndefined()
		// Only stream 1's own post, at its own position.
		expect(opened.pendingRetuneSample).toBe(520)
		events([
			{
				kind: "epoch-started",
				epoch: fresh.epoch,
				startSample: 2000,
				settleMode: "timer",
			},
		])
		expect(engine.currentEpoch().retunedFromSample).toBe(520)
		expect(engine.currentEpoch().pendingRetuneSample).toBeUndefined()
		// A post superseded by the next and dropped when that one starts: nothing stays pending.
		await feed(3000)
		hop(446_400_000, 0)
		await feed(100)
		const later = hop(446_500_000, 0)
		expect(engine.currentEpoch().pendingRetuneSample).toBe(3500)
		events([
			{
				kind: "epoch-started",
				epoch: later.epoch,
				startSample: 4000,
				settleMode: "timer",
			},
		])
		expect(engine.currentEpoch().retunedFromSample).toBe(3500)
		expect(engine.currentEpoch().pendingRetuneSample).toBeUndefined()
		// The next opening clears the carried position.
		await engine.reconfigure()
		events([
			{
				kind: "epoch-started",
				epoch: engine.currentEpoch().epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(engine.currentEpoch().retunedFromSample).toBeUndefined()
		expect(engine.currentEpoch().pendingRetuneSample).toBeUndefined()
		await engine.stop()
	})
})
