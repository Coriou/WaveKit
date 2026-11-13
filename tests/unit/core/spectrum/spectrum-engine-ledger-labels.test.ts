/**
 * Tuning trust step 3: the tuning ledger's label is the engine's only label. Each pipeline event
 * is stamped by the ledger on the samples it was measured on (a block its block, a track its newest
 * block, a transient the blocks around it), against the centre and rate the event was computed
 * at; a scanner hop's samples need its own frequency receipt. Real TuningLedger, a recording
 * pipeline host fed events by hand, positions counted as SourceManager counts them.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	SpectrumEngine,
	type EngineEpoch,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { blockSamplesOf } from "../../../../src/core/spectrum/retune-settle.js"
import type {
	BlockSummary,
	EngineState,
	PendingEpoch,
	PipelineEvent,
	PipelineInput,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import {
	TuningLedger,
	type TuningWriterTag,
} from "../../../../src/core/tuning-ledger.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

const CENTRE = 446_100_000
const HOP = 446_300_000
const RATE = 1_024_000
/** The ledger's settle: 100 ms at 1.024 Msps U8 = 204 800 bytes (no in-flight term). */
const SETTLE_MS = 100
const SETTLE_BYTES = (SETTLE_MS * RATE * 2) / 1000

class Host implements PipelineHost {
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
	close(): Promise<void> {
		return Promise.resolve()
	}
	utilization(): number | null {
		return null
	}
}

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

function summary(
	stream: number,
	epoch: number,
	endSample: number,
	centreHz = CENTRE,
): BlockSummary {
	return {
		sourceId: "rtl",
		stream,
		epoch,
		endSample,
		centreHz,
		sampleRateHz: RATE,
		binHz: 1000,
		startHz: centreHz - RATE / 2,
		bins: [],
		floorDbfs: -90,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: centreHz, dcGuardHz: 0, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

function track(
	stream: number,
	epoch: number,
	startSample: number,
	lastSample: number,
): TrackSnapshot {
	return {
		trackId: "t1",
		sourceId: "rtl",
		stream,
		epoch,
		startSample,
		lastSample,
		centreHz: CENTRE + 25_000,
		tuningTrust: "commanded",
	} as TrackSnapshot
}

async function make() {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const ledger = new TuningLedger({
		settleLink: () => ({ configuredSettleMs: SETTLE_MS, inFlightBytes: 0 }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
	const conn = ledger.connection("rtl")
	const session = conn.start()!
	let host: Host | null = null
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner: new FakeTuner(),
		ledger,
		settings: () => testSettings(),
		logger: pino({ level: "silent" }),
		createHost: (_cfg, handlers) => (host = new Host(handlers)),
	})
	await engine.start()
	const cfg = engine.config()!
	const block = blockSamplesOf(cfg.integrationMs, cfg.sampleRateHz, cfg.fftSize)
	let samples = 0
	const feed = async (n: number) => {
		session.pos += n * 2
		fanout.write(Buffer.alloc(n * 2))
		samples += n
		await settle()
	}
	const write = (
		payload: Buffer,
		tag: TuningWriterTag = { writer: "operator" },
	) => conn.write(payload, tag)(null)
	const seen: { kind: string; trust: string; ev: PipelineEvent }[] = []
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) =>
		seen.push({ kind: ev.kind, trust: epoch.tuningTrust, ev }),
	)
	const events = (evs: PipelineEvent[]) => host!.handlers.events(evs)
	// The stream's own start: no label (not a tuning event).
	const opening = engine.currentEpoch().epoch + 1
	events([
		{
			kind: "epoch-started",
			epoch: opening,
			startSample: 0,
			settleMode: "none",
		},
	])
	return {
		engine,
		ledger,
		session,
		feed,
		write,
		seen,
		events,
		block,
		opening,
		host: () => host!,
		samples: () => samples,
	}
}

describe("SpectrumEngine labels from the tuning ledger", () => {
	it("an opening carries no label, and a proof far behind its first byte trusts its blocks at once", async () => {
		const { engine, ledger, feed, write, seen, events, block, opening } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		events([{ kind: "block-summary", summary: summary(0, opening, block * 2) }])
		// Inside the settle: unverified.
		expect(seen.at(-1)!.trust).toBe("unverified")
		await feed(block * 4)
		events([
			{
				kind: "block-summary",
				summary: summary(0, opening, SETTLE_BYTES / 2 + block * 6),
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		// A pipeline restart opens a new stream: its start carries no label, its blocks the ledger's.
		await engine.reconfigure()
		const reopened = engine.currentEpoch().epoch + 1
		events([
			{
				kind: "epoch-started",
				epoch: reopened,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(seen.at(-1)).toMatchObject({
			kind: "epoch-started",
			trust: "unverified",
		})
		await feed(block * 2)
		events([
			{ kind: "block-summary", summary: summary(1, reopened, block * 2) },
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		expect(ledger.fieldState("rtl").frequency.state).toBe("proven")
		await engine.stop()
	})

	it("a track on air across a proof boundary is trusted from the first event past it, never back-dated", async () => {
		const { engine, feed, write, seen, events, block, opening } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		// The track opens inside the settle window.
		await feed(block * 2)
		events([{ kind: "track-open", track: track(0, opening, 0, block * 2) }])
		const open = seen.at(-1)!
		expect(open.trust).toBe("unverified")
		expect((open.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"unverified",
		)
		// Still on air past the boundary: its newest block is proven.
		const past = SETTLE_BYTES / 2 + block * 3
		await feed(past - block * 2)
		events([{ kind: "track-update", track: track(0, opening, 0, past) }])
		const update = seen.at(-1)!
		expect(update.trust).toBe("commanded")
		expect((update.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"commanded",
		)
		// The open event that went out unverified stays so (labels are never rewritten).
		expect((open.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"unverified",
		)
		events([
			{
				kind: "track-close",
				track: track(0, opening, 0, past),
				endReason: "quiet",
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		// A transient is labelled by the blocks around its sample.
		events([
			{ kind: "transient", centreHz: CENTRE, epoch: opening, sample: block },
			{
				kind: "transient",
				centreHz: CENTRE,
				epoch: opening,
				sample: past - block,
			},
		])
		expect(seen.slice(-2).map(s => s.trust)).toEqual([
			"unverified",
			"commanded",
		])
		await engine.stop()
	})

	it("relay receipts label relay; a receipt at another centre than the epoch's never trusts", async () => {
		const { engine, feed, write, seen, events, block, opening } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]), {
			writer: "relay",
		})
		await feed(SETTLE_BYTES / 2 + block * 2)
		const end = SETTLE_BYTES / 2 + block * 2
		events([{ kind: "block-summary", summary: summary(0, opening, end) }])
		expect(seen.at(-1)!.trust).toBe("relay")
		// The same block computed at another centre: the proof names the receiver's, not this one.
		events([
			{
				kind: "block-summary",
				summary: summary(0, opening, end, CENTRE + 10_000),
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		await engine.stop()
	})

	it("a scanner hop's start claims its own receipt; its blocks are trusted only on a proof by it", async () => {
		const { engine, feed, write, seen, events, block, host, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const ledger = (engine as unknown as { deps: { ledger: TuningLedger } })
			.deps.ledger
		/** The arbiter's hop: submitted, then its frequency frame flushed (a receipt). */
		const hop = (centreHz: number): PendingEpoch => {
			const clock = engine.sampleClock()
			const pending: PendingEpoch = {
				epoch: engine.allocateEpoch(),
				commandSample: clock.commandSample,
				bufferedSamples: clock.bufferedSamples,
				settleSamples: 0,
				expectMarker: false,
				markerTimeoutSamples: 0,
				pllSettleSamples: 0,
				centreHz,
				sampleRateHz: RATE,
				gainKey: "na",
				tuningTrust: "unverified",
				centreChanged: true,
			}
			engine.suppressExternal(true)
			engine.submitEpoch(pending)
			write(frame(0x01, centreHz), { writer: "scanner", jobId: "j1" })
			engine.suppressExternal(false)
			return pending
		}
		const started = (pending: PendingEpoch) =>
			events([
				{
					kind: "epoch-started",
					epoch: pending.epoch,
					startSample: samples(),
					settleMode: "timer",
				},
			])
		// A hop whose receipt the arbiter has not noted yet (its start can come before the flush):
		// the start names the hop's owner, but its samples need the receipt.
		const unnoted = hop(HOP)
		expect(host().inputs.some(i => i.kind === "pending-epoch")).toBe(true)
		started(unnoted)
		expect(seen.at(-1)).toMatchObject({
			kind: "epoch-started",
			trust: "commanded",
		})
		await feed(SETTLE_BYTES / 2 + block * 4)
		events([
			{
				kind: "block-summary",
				summary: summary(0, unnoted.epoch, samples(), HOP),
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		// A hop the arbiter noted (TunerArbiter: setFrequency's onReceipt): its start claims it.
		const noted = hop(HOP + 100_000)
		engine.noteHopReceipt(
			noted.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		started(noted)
		expect(seen.at(-1)).toMatchObject({
			kind: "epoch-started",
			trust: "commanded",
		})
		// Inside its settle its blocks are not trusted; past it they are.
		await feed(block * 2)
		events([
			{
				kind: "block-summary",
				summary: summary(0, noted.epoch, samples(), HOP + 100_000),
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		await feed(SETTLE_BYTES / 2 + block * 2)
		events([
			{
				kind: "block-summary",
				summary: summary(0, noted.epoch, samples(), HOP + 100_000),
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		// Another writer's frame at the same centre: the proof is no longer the hop's.
		write(frame(0x01, HOP + 100_000), { writer: "operator" })
		await feed(SETTLE_BYTES / 2 + block * 4)
		events([
			{
				kind: "block-summary",
				summary: summary(0, noted.epoch, samples(), HOP + 100_000),
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		// A hop whose frame got no receipt is never trusted.
		const lost = hop(HOP + 200_000)
		engine.noteHopReceipt(lost.epoch, null)
		started(lost)
		expect(seen.at(-1)!.trust).toBe("unverified")
		await engine.stop()
	})

	it("without a ledger every event reads unverified (fail closed)", async () => {
		const sources = new FakeSources()
		const fanout = new FakeFanout()
		let host: Host | null = null
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources,
			routing: {
				getFanout: () => fanout as never,
				releaseUnused: () => undefined,
			},
			tuner: new FakeTuner(),
			settings: () => testSettings(),
			logger: pino({ level: "silent" }),
			createHost: (_cfg, handlers) => (host = new Host(handlers)),
		})
		await engine.start()
		const labels: string[] = []
		engine.on("pipeline", (_ev: PipelineEvent, epoch: EngineEpoch) =>
			labels.push(epoch.tuningTrust),
		)
		const epoch = engine.currentEpoch().epoch + 1
		fanout.write(Buffer.alloc(200_000))
		await settle()
		host!.handlers.events([
			{ kind: "epoch-started", epoch, startSample: 0, settleMode: "none" },
			{ kind: "block-summary", summary: summary(0, epoch, 50_000) },
			{ kind: "track-open", track: track(0, epoch, 0, 50_000) },
		])
		expect(labels).toEqual(["unverified", "unverified", "unverified"])
		expect(engine.currentEpoch().tuningTrust).toBe("unverified")
		await engine.stop()
	})
})
