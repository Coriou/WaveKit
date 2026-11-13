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
	measuredFromSample?: number,
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
		...(measuredFromSample !== undefined ? { measuredFromSample } : {}),
	} as TrackSnapshot
}

/** viaSources: the engine reads the ledger from its source manager (removable mid-test). */
async function make(opts: { viaSources?: boolean } = {}) {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const ledger = new TuningLedger({
		settleLink: () => ({ configuredSettleMs: SETTLE_MS, inFlightBytes: 0 }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
	if (opts.viaSources) sources.tuningLedger = ledger
	const conn = ledger.connection("rtl")
	const session = conn.start()!
	let host: Host | null = null
	const tuner = new FakeTuner()
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		...(opts.viaSources ? {} : { ledger }),
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
	const seen: {
		kind: string
		trust: string
		ev: PipelineEvent
		epoch: EngineEpoch
	}[] = []
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) =>
		seen.push({ kind: ev.kind, trust: epoch.tuningTrust, ev, epoch }),
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
		conn,
		sources,
		fanout,
		tuner,
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

/** A scanner hop's pending epoch, as the arbiter posts it (its id from allocateEpoch). */
function hopPending(engine: SpectrumEngine, centreHz: number): PendingEpoch {
	const clock = engine.sampleClock()
	return {
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

	it("a track on air across a proof boundary is trusted once its frequency is measured past it, never back-dated", async () => {
		const { engine, feed, write, seen, events, block, opening, host } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		// The track opens inside the settle window.
		await feed(block * 2)
		events([{ kind: "track-open", track: track(0, opening, 0, block * 2) }])
		const open = seen.at(-1)!
		expect(open.trust).toBe("unverified")
		expect((open.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"unverified",
		)
		// Still on air past the boundary: its newest block is proven, but its centre was measured
		// over blocks from before the boundary too. Unverified, and the pipeline is asked to measure
		// it again from its newest (proven) block.
		const past = SETTLE_BYTES / 2 + block * 3
		await feed(past - block * 2)
		events([{ kind: "track-update", track: track(0, opening, 0, past) }])
		const update = seen.at(-1)!
		expect(update.trust).toBe("unverified")
		const asks = () => host().inputs.filter(i => i.kind === "measure-from")
		expect(asks()).toEqual([
			{
				kind: "measure-from",
				stream: 0,
				epoch: opening,
				trackId: "t1",
				sample: past - block,
			},
		])
		// Asked once until the pipeline answered (a later update before its answer asks nothing).
		events([{ kind: "track-update", track: track(0, opening, 0, past) }])
		expect(asks()).toHaveLength(1)
		// The pipeline measured it from there: trusted.
		await feed(block)
		const later = past + block
		events([
			{
				kind: "track-update",
				track: track(0, opening, 0, later, past - block),
			},
		])
		const measured = seen.at(-1)!
		expect(measured.trust).toBe("commanded")
		expect((measured.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"commanded",
		)
		// The events that went out unverified stay so (labels are never rewritten).
		expect((open.ev as { track: TrackSnapshot }).track.tuningTrust).toBe(
			"unverified",
		)
		events([
			{
				kind: "track-close",
				track: track(0, opening, 0, later, past - block),
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

	it("currentEpoch names where its trusted run starts: the first trusted block, reset by an unverified one", async () => {
		const { engine, ledger, feed, write, events, block, opening, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		const receiptPos = ledger.receipts("rtl").at(-1)!.pos
		const blockAt = (end: number) =>
			events([{ kind: "block-summary", summary: summary(0, opening, end) }])
		await feed(block * 2)
		blockAt(samples())
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "unverified",
			trustedFromSample: null,
		})
		await feed(SETTLE_BYTES / 2 + block)
		const first = samples()
		blockAt(first)
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "commanded",
			trustedFromSample: first - block,
		})
		// The run starts at or past the settle after the receipt (2 bytes per sample, anchored at 0).
		expect((first - block) * 2).toBeGreaterThanOrEqual(
			receiptPos + SETTLE_BYTES,
		)
		await feed(block * 3)
		blockAt(samples())
		expect(engine.currentEpoch().trustedFromSample).toBe(first - block)
		// A doubt: the next block is unverified and the run is gone.
		ledger.raiseDoubt("rtl", "both", "untracked-retune")
		await feed(block)
		blockAt(samples())
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "unverified",
			trustedFromSample: null,
		})
		// Re-proven: a new run, from its own first trusted block (never the old run's start).
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]), {
			writer: "assert",
		})
		await feed(SETTLE_BYTES / 2 + block * 2)
		const again = samples()
		blockAt(again)
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "commanded",
			trustedFromSample: again - block,
		})
		await engine.stop()
	})

	it("a block read without a ledger ends the trusted run: a later trusted block starts a new one", async () => {
		const {
			engine,
			sources,
			ledger,
			feed,
			write,
			events,
			block,
			opening,
			samples,
		} = await make({ viaSources: true })
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		const blockAt = (end: number) =>
			events([{ kind: "block-summary", summary: summary(0, opening, end) }])
		await feed(SETTLE_BYTES / 2 + block * 2)
		const first = samples()
		blockAt(first)
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "commanded",
			trustedFromSample: first - block,
		})
		// The ledger is gone for one block (fail closed: unverified, the run ends).
		delete sources.tuningLedger
		await feed(block)
		blockAt(samples())
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "unverified",
			trustedFromSample: null,
		})
		// Back: the next trusted block starts a run of its own, never the old run's start.
		sources.tuningLedger = ledger
		await feed(block)
		const again = samples()
		blockAt(again)
		expect(engine.currentEpoch()).toMatchObject({
			tuningTrust: "commanded",
			trustedFromSample: again - block,
		})
		await engine.stop()
	})

	it("a command behind a queued stream boundary posts its DSP epoch at its receipt in the new stream (replug)", async () => {
		const {
			engine,
			ledger,
			conn,
			sources,
			fanout,
			tuner,
			session,
			feed,
			write,
			block,
			host,
		} = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const branch = fanout.branches.get("scanner-rtl")!.stream
		// The old session's last bytes are still in the branch when the connection drops.
		branch.pause()
		session.pos += 4096
		fanout.write(Buffer.alloc(4096))
		sources.emit("disconnected", "rtl")
		conn.close()
		// The replug: the receiver is back on its default; the new session's first bytes are its,
		// then the assert's frame of the held centre is flushed.
		const nextConn = ledger.connection("rtl")
		const next = nextConn.start()!
		sources.emit("session-started", "rtl", next.session)
		const before = 6000
		next.pos += before
		fanout.write(Buffer.alloc(before))
		const HELD = CENTRE + 200_000
		sources.caps.set("rtl", { ...sources.caps.get("rtl")!, centerFreq: HELD })
		nextConn.write(frame(0x01, HELD), { writer: "assert" })(null)
		expect(ledger.receipts("rtl").at(-1)).toMatchObject({
			session: next.session,
			pos: before,
		})
		tuner.emit("command-sent", "rtl", "set-frequency", HELD, "replay")
		await Promise.resolve()
		await Promise.resolve()
		next.pos += 8192
		fanout.write(Buffer.alloc(8192))
		branch.resume()
		await settle()
		const inputs = host().inputs
		const opened = inputs.findLastIndex(i => i.kind === "new-stream")
		expect(opened).toBeGreaterThan(-1)
		const epochs = inputs
			.slice(opened)
			.filter(
				(i): i is Extract<PipelineInput, { kind: "pending-epoch" }> =>
					i.kind === "pending-epoch",
			)
		expect(epochs).toHaveLength(1)
		const p = epochs[0]!.pending
		expect(p.centreHz).toBe(HELD)
		// At the receipt: the new stream's sample of its position (no bytes before it lost).
		expect(p.commandSample + p.bufferedSamples).toBe(before / 2)
		await engine.stop()
	})

	it("a hop submitted during a pipeline restart: the restarted stream's opening names it superseded, once", async () => {
		const { engine, write, feed, seen, events, block, host } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const restart = engine.reconfigure()
		// The old host can no longer take it; the new one has not started.
		const hop = hopPending(engine, HOP)
		engine.submitEpoch(hop)
		await restart
		expect(host().inputs.some(i => i.kind === "pending-epoch")).toBe(false)
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
		expect(seen.at(-1)!.epoch.supersededEpoch).toBe(hop.epoch)
		// Named once: the next opening names nothing.
		await engine.reconfigure()
		events([
			{
				kind: "epoch-started",
				epoch: engine.currentEpoch().epoch + 1,
				startSample: 0,
				settleMode: "none",
			},
		])
		expect(seen.at(-1)!.epoch.supersededEpoch).toBeUndefined()
		await engine.stop()
	})

	it("a hop the pipeline renumbered (an untracked epoch started first) names the id it was posted as", async () => {
		const { engine, write, feed, seen, events, block, samples } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const hop = hopPending(engine, HOP)
		engine.submitEpoch(hop)
		// The pipeline started an untracked epoch under the hop's id before the hop's post arrived,
		// so it numbers the hop max(id, last + 1) = id + 1.
		events([
			{
				kind: "untracked-retune",
				epoch: hop.epoch,
				startSample: samples(),
				stream: 0,
				deltaHz: 30_000,
			},
			{
				kind: "epoch-started",
				epoch: hop.epoch,
				startSample: samples(),
				settleMode: "none",
			},
		])
		expect(seen.at(-1)!.epoch.requestedEpoch).toBeUndefined()
		events([
			{
				kind: "epoch-started",
				epoch: hop.epoch + 1,
				startSample: samples(),
				settleMode: "timer",
			},
		])
		const started = seen.at(-1)!
		expect(started.kind).toBe("epoch-started")
		expect(started.epoch.epoch).toBe(hop.epoch + 1)
		expect(started.epoch.requestedEpoch).toBe(hop.epoch)
		expect(started.epoch.centreHz).toBe(HOP)
		// A start under its own id names nothing.
		const next = hopPending(engine, HOP + 100_000)
		engine.submitEpoch(next)
		events([
			{
				kind: "epoch-started",
				epoch: next.epoch,
				startSample: samples(),
				settleMode: "timer",
			},
		])
		expect(seen.at(-1)!.epoch.requestedEpoch).toBeUndefined()
		expect(seen.at(-1)!.epoch.centreHz).toBe(HOP + 100_000)
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

	it("a timer hop starts at its proof floor: its first block is proven, one a sample earlier is not", async () => {
		const { engine, ledger, feed, write, seen, events, block, host, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const pending = hopPending(engine, HOP)
		engine.suppressExternal(true)
		engine.submitEpoch(pending)
		write(frame(0x01, HOP), { writer: "scanner", jobId: "j1" })
		engine.suppressExternal(false)
		const posted = host().inputs.find(i => i.kind === "pending-epoch")
		expect(posted).toMatchObject({ pending: { awaitProofFloor: true } })
		const seq = ledger.fieldState("rtl").frequency.receipt!
		engine.noteHopReceipt(pending.epoch, seq)
		// Posted after the socket callback that noted it.
		expect(host().inputs.some(i => i.kind === "proof-floor")).toBe(false)
		await Promise.resolve()
		const floor = host().inputs.find(i => i.kind === "proof-floor")
		expect(floor).toMatchObject({ kind: "proof-floor", epoch: pending.epoch })
		const at = (floor as { sample: number }).sample
		// The receipt's B(R) (its position + 100 ms) lies past the samples fed so far.
		expect(at).toBeGreaterThan(samples())
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: at,
				settleMode: "timer",
			},
		])
		await feed(at + 4 * block - samples())
		events([
			{
				kind: "block-summary",
				summary: summary(0, pending.epoch, at - 1 + block, HOP),
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		events([
			{
				kind: "block-summary",
				summary: summary(0, pending.epoch, at + block, HOP),
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		// A hop whose frame got no receipt gets no floor (the pipeline's timer start stands).
		const lost = hopPending(engine, HOP + 100_000)
		engine.submitEpoch(lost)
		engine.noteHopReceipt(lost.epoch, null)
		await Promise.resolve()
		expect(
			host().inputs.filter(
				i => i.kind === "proof-floor" && i.epoch === lost.epoch,
			),
		).toEqual([])
		await engine.stop()
	})

	it("a marker hop is posted with the mapping width: its first block past the marker start is proven", async () => {
		const { engine, ledger, feed, write, seen, events, block, host, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block)
		const pending = { ...hopPending(engine, HOP), expectMarker: true }
		engine.suppressExternal(true)
		engine.submitEpoch(pending)
		write(frame(0x01, HOP), { writer: "scanner", jobId: "j1" })
		engine.suppressExternal(false)
		const posted = host().inputs.find(i => i.kind === "pending-epoch") as {
			pending: PendingEpoch
		}
		// At least the gaps + 1 sample of the lower bound.
		const slack = posted.pending.proofSlackSamples!
		expect(slack).toBeGreaterThanOrEqual(1)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		// The marker bracket ended inside the settle: the boundary is lowered to it.
		await feed(block * 2)
		const markerStart = samples()
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: markerStart + slack,
				settleMode: "marker",
				markerRunSamples: 512,
			},
		])
		await feed(block * 4)
		events([
			{
				kind: "block-summary",
				summary: summary(0, pending.epoch, markerStart + slack + block, HOP),
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
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
