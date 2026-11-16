/**
 * End to end through the real SpectrumEngine: a sweep hop submitted while a voiced track is being
 * recorded cuts the file at the hop's command position, which the engine itself reports
 * (pendingRetuneSample while the hop settles, retunedFromSample once it started). No position is
 * filled by hand: the engine's ring, live edge, epoch numbering and command positions are its own,
 * fed by a fake fanout; a recording host stands in for the pipeline and answers the hop's start
 * 1.5 s after the command. The engine itself is the recorder's view, as scanner-service passes
 * it; a real tuning ledger (FakeReceiverLedger) holds receipts of the start tuning, so the
 * engine labels it `commanded` on its own.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	WidebandAnalogRecorder,
	type WidebandEngineView,
} from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
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
import { FakeReceiverLedger } from "../../../mocks/fake-receiver-ledger.js"
import { NfmSource } from "./wideband-nfm-fixtures.js"
import {
	CENTRE,
	FS,
	OFFSET,
	fakeOps,
	input,
	microtasks,
	snapshot,
} from "./wideband-recorder-harness.js"

const AUDIO = 8000
const frames = (samples: number): number => Math.round((samples * AUDIO) / FS)
const logger = pino({ level: "silent" })

class RecordingHost implements PipelineHost {
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(_input: WorkerPipelineInput, transfer?: ArrayBuffer): void {
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

describe("WidebandAnalogRecorder at a hop through the real SpectrumEngine", () => {
	it("a voiced file cut by a hop holds no sample of the new tuning", async () => {
		const sources = new FakeSources("rtl", {
			centerFreq: CENTRE,
			sampleRate: FS,
		})
		const fanout = new FakeFanout()
		// The receiver's tuning ledger: this session holds receipts of the start centre and rate,
		// and every byte the fanout writes advances its position, so the engine labels the old
		// tuning `commanded` itself.
		const receiver = new FakeReceiverLedger("rtl", {
			rateHz: FS,
			settleMs: 100,
		})
		receiver.prove(CENTRE, FS)
		sources.tuningLedger = receiver.ledger
		fanout.ledgerFeed = receiver
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
		})
		await engine.start()
		const events = (evs: PipelineEvent[]): void =>
			hosts.at(-1)!.handlers.events(evs)
		events([
			{ kind: "epoch-started", epoch: 1, startSample: 0, settleMode: "none" },
		])

		// The recorder's reads, to check no sample at or past the command was demodulated: the
		// real engine is the view (as scanner-service passes it), its readRing observed in place.
		const reads: { from: number; to: number }[] = []
		const readRing = engine.readRing.bind(engine)
		engine.readRing = (from, to) => {
			const got = readRing(from, to)
			if (got)
				reads.push({
					from: got.startSample,
					to: got.startSample + got.bytes.length / 2,
				})
			return got
		}
		const view: WidebandEngineView = engine
		const queue: (() => void)[] = []
		let rec!: WidebandAnalogRecorder
		const { ops, begin } = fakeOps(b => rec.bindingLive(b))
		rec = new WidebandAnalogRecorder({
			engine: () => view,
			settings: () => ({ preRollMs: 300, hangMs: 2000, cpuBudgetCores: 1 }),
			beginAnalog: begin,
			logger,
			now: () => 1_700_000_000_000,
			schedule: run => queue.push(run),
		})
		const oldTuning = new NfmSource({ fs: FS, offsetHz: OFFSET })
		// The new tuning: another loud carrier at the same offset (what the settle would record).
		const newTuning = new NfmSource({ fs: FS, offsetHz: OFFSET, seed: 99 })
		let pumps = 0
		// The pipeline's block summaries of the old tuning, which the engine labels from the
		// ledger (the only label); none once the hop is commanded (its settle is not reported).
		let summaries = true
		const block = (): void => {
			const e = engine.currentEpoch()
			events([
				{
					kind: "block-summary",
					summary: {
						sourceId: "rtl",
						stream: e.stream,
						epoch: e.epoch,
						endSample: engine.liveEdge(),
						centreHz: CENTRE,
						sampleRateHz: FS,
						binHz: 1000,
						startHz: CENTRE - FS / 2,
						bins: [],
						floorDbfs: -90,
						thresholdDb: 10,
						tracks: [],
						masks: { dcHz: CENTRE, dcGuardHz: 0, spurRanges: [] },
						floorOccupied: false,
						overload: false,
					},
				},
			])
		}
		const feed = async (
			src: NfmSource,
			seconds: number,
			on: boolean,
			each?: () => void,
		): Promise<void> => {
			const chunk = FS / 40
			for (let i = 0; i < Math.round((seconds * FS) / chunk); i++) {
				fanout.write(Buffer.from(src.next(chunk, on)))
				await settle()
				if (summaries) block()
				each?.()
				for (let k = 0; k < 1000 && queue.length > 0; k++) {
					queue.shift()!()
					await microtasks(8)
				}
				if (++pumps % 40 === 0) await new Promise(r => setImmediate(r))
			}
		}

		await feed(oldTuning, 0.5, false)
		const onset = engine.liveEdge()
		const track = (): void => {
			const edge = engine.liveEdge()
			if (edge - onset >= 0.1 * FS)
				rec.track(
					input("o1", snapshot("o1", onset, edge, { stream: 0, epoch: 1 }), {
						discoveryId: "d_old",
					}),
				)
		}
		await feed(oldTuning, 2.5, true, track)
		// The engine's own label of the old tuning, from the ledger's receipts.
		expect(engine.currentEpoch().tuningTrust).toBe("commanded")
		summaries = false
		// The arbiter's hop: its command position is the engine's own clock.
		const clock = engine.sampleClock()
		const hop: PendingEpoch = {
			epoch: engine.allocateEpoch(),
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			settleSamples: Math.round(1.5 * FS),
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz: CENTRE + 2_000_000,
			sampleRateHz: FS,
			gainKey: "m:296",
			tuningTrust: "commanded",
			centreChanged: true,
		}
		receiver.write("set-frequency", hop.centreHz, "scanner")
		engine.submitEpoch(hop)
		const command = clock.commandSample + clock.bufferedSamples
		expect(engine.currentEpoch().pendingRetuneSample).toBe(command)
		// Every sample from here on is of the new tuning; the pipeline still reads the old epoch
		// (the track goes on) until the hop's settled start.
		await feed(newTuning, 1.5, true, track)
		const started = engine.liveEdge()
		events([
			{
				kind: "epoch-started",
				epoch: hop.epoch,
				startSample: started,
				settleMode: "timer",
			},
		])
		expect(engine.currentEpoch()).toMatchObject({
			epoch: hop.epoch,
			startSample: started,
			retunedFromSample: command,
		})
		rec.closed(
			"o1",
			snapshot("o1", onset, started, { stream: 0, epoch: 1 }),
			"epoch-changed",
		)
		await feed(newTuning, 3, false)
		await rec.idle()

		const old = ops.filter(op => op.input.discoveryId === "d_old")
		expect(old).toHaveLength(1)
		const op = old[0]!
		expect(op.cut).toBe("epoch-changed")
		expect(op.outcome).toBe("finalized")
		// By sample position: nothing read at or past the command, and the file's frames end there.
		expect(reads.length).toBeGreaterThan(0)
		expect(Math.max(...reads.map(r => r.to))).toBeLessThanOrEqual(command)
		const fileStart = onset - Math.round(0.3 * FS)
		expect(op.frames).toBeLessThanOrEqual(frames(command - fileStart))
		expect(op.frames).toBeGreaterThanOrEqual(
			frames(command - fileStart) - 8 * 60,
		)
		// The settle the settled start alone would have let in: 1.5 s.
		expect(started - command).toBe(1.5 * FS)
		await rec.stop()
		await engine.stop()
	}, 120_000)
})
