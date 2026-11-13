/**
 * Trust runs and anchors in the spectrum engine (fix round 3): where a trusted run ended
 * (`currentEpoch().runEnd`, Q1), the anchor widened by the absorber's loss instead of losing the
 * map until a reconnect (F1), the reason a block reads unverified (`trustShadow.unverifiedBlocks`,
 * `labelReason`, F1/F5), a restarted track measurement with no block behind it (F4), and a
 * detected scanner marker lowering its hop's boundary (F2). Real TuningLedger, a recording
 * pipeline host fed events by hand, positions counted as SourceManager counts them; the
 * absorber's counters are the router's (`ingestCounters`), faked: the router builds an absorber
 * only for a source on a non-loopback host, which no test may reach.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	ANCHOR_LOSS_BREAKS,
	HOP_GAP_ALLOWANCE,
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

/**
 * `heldAtStart`: bytes the absorber holds when the engine starts (upstream of its anchor, so the
 * anchor is that wide); `make` offers them before returning.
 */
async function make(opts: { heldAtStart?: number } = {}) {
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
	/** The router's absorber counters (SourceFanoutRouter.ingestCounters). */
	const ingest: { heldBytes: number; lostBytesTotal: number } | null = {
		heldBytes: 0,
		lostBytesTotal: 0,
	}
	const heldAtStart = opts.heldAtStart ?? 0
	session.pos += heldAtStart
	ingest.heldBytes += heldAtStart
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
			ingestCounters: () => (ingest ? { ...ingest } : null),
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
	/** Bytes the source manager handed out that the absorber lost (never offered to the branch). */
	const lose = (bytes: number) => {
		session.pos += bytes
		ingest.lostBytesTotal += bytes
	}
	/** Bytes the source manager handed out that the absorber holds (offered later, by release). */
	const hold = (n: number) => {
		session.pos += n * 2
		ingest.heldBytes += n * 2
	}
	const release = async () => {
		fanout.write(Buffer.alloc(ingest.heldBytes))
		samples += ingest.heldBytes / 2
		ingest.heldBytes = 0
		await settle()
	}
	/** `n` samples the branch drops while congested: one gap in the engine's stream. */
	const gap = async (n: number) => {
		fanout.congest("scanner-rtl")
		session.pos += n * 2
		fanout.write(Buffer.alloc(n * 2))
		samples += n
		fanout.drain("scanner-rtl")
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
	const opening = engine.currentEpoch().epoch + 1
	events([
		{
			kind: "epoch-started",
			epoch: opening,
			startSample: 0,
			settleMode: "none",
		},
	])
	const blockAt = (end: number, epoch = opening, centreHz = CENTRE) => {
		events([
			{ kind: "block-summary", summary: summary(0, epoch, end, centreHz) },
		])
		return seen.at(-1)!.trust
	}
	if (heldAtStart > 0) await release()
	return {
		engine,
		ledger,
		ingest,
		feed,
		lose,
		hold,
		release,
		gap,
		write,
		seen,
		events,
		block,
		opening,
		blockAt,
		host: () => host!,
		samples: () => samples,
	}
}

describe("the end of a trusted run (Q1)", () => {
	it("names where the run ended: the start of the first unverified block, kept while a later run is trusted", async () => {
		const { engine, ledger, feed, write, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const first = samples()
		expect(blockAt(first)).toBe("commanded")
		expect(engine.currentEpoch().runEnd).toBeNull()
		await feed(block)
		blockAt(samples())
		// A doubt shorter than a block: the next block is unverified, the run ends at its start.
		ledger.raiseDoubt("rtl", "both", "untracked-retune")
		await feed(block)
		const doubted = samples()
		expect(blockAt(doubted)).toBe("unverified")
		expect(engine.currentEpoch()).toMatchObject({
			trustedFromSample: null,
			runEnd: { from: first - block, end: doubted - block },
		})
		// Re-proven: a new run; the old run's end stays for a consumer that saw it late.
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]), {
			writer: "assert",
		})
		await feed(SETTLE_BYTES / 2 + block * 2)
		const again = samples()
		expect(blockAt(again)).toBe("commanded")
		expect(engine.currentEpoch()).toMatchObject({
			trustedFromSample: again - block,
			runEnd: { from: first - block, end: doubted - block },
		})
		await engine.stop()
	})

	it("a label change (commanded to relay) ends the run at the changed block", async () => {
		const { engine, feed, write, block, blockAt, samples } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const first = samples()
		expect(blockAt(first)).toBe("commanded")
		write(frame(0x01, CENTRE), { writer: "relay" })
		await feed(SETTLE_BYTES / 2 + block * 2)
		const relayed = samples()
		expect(blockAt(relayed)).toBe("relay")
		// The run ends where its last commanded block ended (the blocks fed between it and the
		// relay block were never labelled: V6).
		expect(engine.currentEpoch()).toMatchObject({
			trustedFromSample: relayed - block,
			runEnd: { from: first - block, end: first },
		})
		await engine.stop()
	})
})

describe("a trusted run ends exactly at its last trusted block (V6)", () => {
	it("blocks missing between the last trusted block and the unverified one stay outside the run", async () => {
		const { engine, ledger, feed, write, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const first = samples()
		expect(blockAt(first)).toBe("commanded")
		await feed(block)
		const last = samples()
		expect(blockAt(last)).toBe("commanded")
		// Two blocks with no summary (discarded upstream), then a doubt and an unverified block.
		await feed(block * 2)
		ledger.raiseDoubt("rtl", "both", "untracked-retune")
		await feed(block)
		expect(blockAt(samples())).toBe("unverified")
		// The run ends where its last trusted block ended, not at the unverified block's start.
		expect(engine.currentEpoch().runEnd).toEqual({
			from: first - block,
			end: last,
		})
		await engine.stop()
	})
})

describe("a new epoch's label reason (V7)", () => {
	it("an epoch that has labelled no block yet says no-block, not the last epoch's reason", async () => {
		const { engine, feed, block, blockAt, samples, events, opening } =
			await make()
		await feed(block * 2)
		// No receipt: the opening's block reads unverified with its reason.
		expect(blockAt(samples())).toBe("unverified")
		const before = engine.labelReason()
		expect(before).not.toBeNull()
		expect(before).not.toBe("no-block")
		events([
			{
				kind: "epoch-started",
				epoch: opening + 1,
				startSample: samples(),
				settleMode: "timer",
			},
		])
		expect(engine.currentEpoch().tuningTrust).toBe("unverified")
		expect(engine.labelReason()).toBe("no-block")
		await engine.stop()
	})
})

describe("absorber loss widens the anchor (F1)", () => {
	it("blocks after an absorber loss are trusted again without a reconnect, and say why while not", async () => {
		const { engine, ledger, feed, lose, write, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(block * 2)
		// Inside the settle: unverified, by the ledger's reason.
		expect(blockAt(samples())).toBe("unverified")
		expect(engine.labelReason()).toBe("settling")
		await feed(SETTLE_BYTES / 2 + block)
		expect(blockAt(samples())).toBe("commanded")
		expect(engine.labelReason()).toBeNull()
		// The absorber overflows: 64 KiB the source manager handed out never reach the branch.
		lose(64 * 1024)
		await feed(block)
		expect(blockAt(samples())).toBe("commanded")
		await feed(block)
		expect(blockAt(samples())).toBe("commanded")
		const shadow = engine.trustShadow()!
		expect(shadow.anchorWidenedBytes).toBe(64 * 1024)
		expect(shadow.unverifiedBlocks).toMatchObject({ settling: 1 })
		expect(shadow.unverifiedBlocks["upstream-loss"]).toBeUndefined()
		// Still fail closed: a later frame of another centre is not trusted at the old one.
		write(frame(0x01, HOP))
		await feed(SETTLE_BYTES / 2 + block * 2)
		expect(blockAt(samples())).toBe("unverified")
		expect(engine.labelReason()).toBe("value-mismatch")
		expect(ledger.fieldState("rtl").frequency.state).toBe("proven")
		await engine.stop()
	})

	it("a loss counter that goes back (a router reset) reads unverified: upstream-loss", async () => {
		const { engine, ingest, feed, lose, write, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		lose(4096)
		await feed(block)
		expect(blockAt(samples())).toBe("commanded")
		// Nothing is known of the loss once the counter is lower than at the anchor.
		ingest.lostBytesTotal = 1024
		await feed(block)
		expect(blockAt(samples())).toBe("unverified")
		expect(engine.labelReason()).toBe("upstream-loss")
		expect(engine.trustShadow()!.unverifiedBlocks).toMatchObject({
			"upstream-loss": 1,
		})
		await engine.stop()
	})
})

describe("a restarted track measurement needs a block behind it (F4)", () => {
	it("a track closing on the block its restart begins at is unverified; one block measured after it is trusted", async () => {
		const { engine, feed, write, seen, events, block, opening } = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(block * 2)
		events([{ kind: "track-open", track: track(0, opening, 0, block * 2) }])
		const past = SETTLE_BYTES / 2 + block * 3
		await feed(past - block * 2)
		events([{ kind: "track-update", track: track(0, opening, 0, past) }])
		expect(seen.at(-1)!.trust).toBe("unverified")
		// The restart took effect after the newest block: nothing accumulated since.
		events([
			{
				kind: "track-close",
				track: track(0, opening, 0, past, past),
				endReason: "quiet",
			},
		])
		expect(seen.at(-1)!.trust).toBe("unverified")
		// The same track with one proven block measured after its restart: trusted.
		await feed(block)
		events([
			{
				kind: "track-close",
				track: track(0, opening, 0, past + block, past),
				endReason: "quiet",
			},
		])
		expect(seen.at(-1)!.trust).toBe("commanded")
		await engine.stop()
	})
})

describe("a detected scanner marker lowers its hop's boundary (F2)", () => {
	function hop(
		engine: SpectrumEngine,
		write: (payload: Buffer, tag?: TuningWriterTag) => void,
	): PendingEpoch {
		const clock = engine.sampleClock()
		const pending: PendingEpoch = {
			epoch: engine.allocateEpoch(),
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			settleSamples: 0,
			expectMarker: true,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz: HOP,
			sampleRateHz: RATE,
			gainKey: "na",
			tuningTrust: "unverified",
			centreChanged: true,
		}
		engine.suppressExternal(true)
		engine.submitEpoch(pending)
		// The arbiter's marker bracket: test mode on, the hop's centre, test mode off.
		const tag: TuningWriterTag = { writer: "scanner", jobId: "j1" }
		write(frame(0x07, 1), tag)
		write(frame(0x01, HOP), tag)
		write(frame(0x07, 0), tag)
		engine.suppressExternal(false)
		return pending
	}

	/**
	 * The slack the engine posted the marker hop with (PendingEpoch.proofSlackSamples): the
	 * pipeline starts the hop that far past the marker run's end plus the PLL settle.
	 */
	function postedSlack(
		inputs: readonly PipelineInput[],
		epoch: number,
	): number {
		for (const i of inputs)
			if (i.kind === "pending-epoch" && i.pending.epoch === epoch)
				return i.pending.proofSlackSamples ?? 0
		throw new Error(`hop ${epoch} not posted`)
	}

	it("trusts the hop's blocks from the marker on, long before its receipt's settle; never before the marker", async () => {
		const {
			engine,
			ledger,
			feed,
			write,
			events,
			block,
			blockAt,
			samples,
			host,
		} = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		expect(blockAt(samples())).toBe("commanded")
		const pending = hop(engine, write)
		const seq = ledger.fieldState("rtl").frequency.receipt!
		engine.noteHopReceipt(pending.epoch, seq)
		// The marker run ends a quarter block after the receipt (far inside the 100 ms settle).
		const receiptAt = samples()
		await feed(block / 4)
		const marker = samples()
		// As the pipeline starts it: the posted slack (the mapping width) past the marker.
		const slack = postedSlack(host().inputs, pending.epoch)
		expect(slack).toBeGreaterThanOrEqual(1)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker + slack,
				settleMode: "marker",
			},
		])
		// A block starting at the marker itself: its lowest position (one sample of rounding) lies
		// before the marker's highest one: not trusted. The hop's first block, the slack past it, is.
		await feed(block + slack)
		expect(blockAt(marker + block, pending.epoch, HOP)).toBe("unverified")
		expect(blockAt(marker + slack + block, pending.epoch, HOP)).toBe(
			"commanded",
		)
		// Well inside the receipt's settle (two blocks).
		expect(samples() - receiptAt).toBeLessThan(SETTLE_BYTES / 2)
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
		await engine.stop()
	})

	it("a marker seen before the hop's receipt is noted lowers it once the receipt is noted", async () => {
		const { engine, ledger, feed, write, events, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const pending = hop(engine, write)
		await feed(block / 4)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: samples(),
				settleMode: "marker",
			},
		])
		await feed(block + 8)
		// Not noted yet: the hop's samples need its receipt.
		expect(blockAt(samples(), pending.epoch, HOP)).toBe("unverified")
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		expect(blockAt(samples(), pending.epoch, HOP)).toBe("commanded")
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
		await engine.stop()
	})

	it("a timer-settled hop keeps the receipt's settle (no marker, no lowering)", async () => {
		const { engine, ledger, feed, write, events, block, blockAt, samples } =
			await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const pending = hop(engine, write)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		await feed(block / 4)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: samples(),
				settleMode: "timer",
			},
		])
		await feed(block + 8)
		expect(blockAt(samples(), pending.epoch, HOP)).toBe("unverified")
		expect(engine.trustShadow()!.markerBoundaries).toBe(0)
		await engine.stop()
	})

	it("a marker run that began before the hop's test-mode-on receipt lowers nothing (an older hop's marker)", async () => {
		const {
			engine,
			ledger,
			feed,
			write,
			events,
			block,
			blockAt,
			samples,
			host,
		} = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		// A run starting a block before the hop's bracket is written, ending a quarter block after.
		const early = samples()
		await feed(block)
		const pending = hop(engine, write)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		await feed(block / 4)
		const marker = samples()
		const slack = postedSlack(host().inputs, pending.epoch)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker + slack,
				settleMode: "marker",
				markerRunSamples: marker - early,
			},
		])
		await feed(block + slack)
		// The receipt's own settle stands.
		expect(blockAt(marker + slack + block, pending.epoch, HOP)).toBe(
			"unverified",
		)
		expect(engine.labelReason()).toBe("settling")
		expect(engine.trustShadow()!.markerBoundaries).toBe(0)
		await engine.stop()
	})

	it("a run that starts exactly at the hop's test-mode-on receipt (a source that switches at once) lowers it", async () => {
		const {
			engine,
			ledger,
			feed,
			write,
			events,
			block,
			blockAt,
			samples,
			host,
		} = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const receiptAt = samples()
		const pending = hop(engine, write)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		await feed(block / 4)
		const marker = samples()
		const slack = postedSlack(host().inputs, pending.epoch)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker + slack,
				settleMode: "marker",
				markerRunSamples: marker - receiptAt,
			},
		])
		await feed(block + slack)
		expect(blockAt(marker + slack + block, pending.epoch, HOP)).toBe(
			"commanded",
		)
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
		await engine.stop()
	})

	/** The slack the pipeline applies: the posted one, or the largest proof-slack sent since. */
	function appliedSlack(
		inputs: readonly PipelineInput[],
		epoch: number,
	): number {
		let slack = postedSlack(inputs, epoch)
		for (const i of inputs)
			if (i.kind === "proof-slack" && i.epoch === epoch)
				slack = Math.max(slack, i.samples)
		return slack
	}

	it("an upstream loss seen between a marker hop's posting and its marker grows its slack: its first block stays proven (P2)", async () => {
		const {
			engine,
			ledger,
			feed,
			lose,
			write,
			events,
			block,
			blockAt,
			samples,
			host,
		} = await make()
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const receiptAt = samples()
		const pending = hop(engine, write)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		const posted = postedSlack(host().inputs, pending.epoch)
		// 2 MiB lost after the bracket; the samples offered before the loss is seen (the next batch
		// to the pipeline) carry the marker.
		const loss = 2 * 1024 * 1024
		lose(loss)
		await feed(block / 4)
		// The batch goes to the pipeline on the engine's flush timer (20 ms).
		await new Promise(resolve => setTimeout(resolve, 30))
		const marker = samples() - block / 8
		const slack = appliedSlack(host().inputs, pending.epoch)
		expect(slack).toBeGreaterThanOrEqual(posted + loss / 2)
		// Sent before the batch that carries the marker's samples.
		const inputs = host().inputs
		const slackAt = inputs.findIndex(
			i => i.kind === "proof-slack" && i.epoch === pending.epoch,
		)
		expect(slackAt).toBeGreaterThanOrEqual(0)
		expect(inputs.findLastIndex(i => i.kind === "bytes")).toBeGreaterThan(
			slackAt,
		)
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker + slack,
				settleMode: "marker",
				markerRunSamples: marker - receiptAt - block / 16,
				proofSlackSamples: slack,
			},
		])
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
		await feed(marker + slack + block - samples())
		expect(blockAt(marker + slack + block, pending.epoch, HOP)).toBe(
			"commanded",
		)
		await engine.stop()
	})

	it("a wide anchor (bytes upstream when the engine started) gives a bounded slack, and the hop's first block past it is proven (P3)", async () => {
		// 256 KiB upstream (the branch high-water mark): 128 ms of samples at 1.024 Msps.
		const held = 256 * 1024
		const {
			engine,
			ledger,
			feed,
			write,
			events,
			block,
			blockAt,
			samples,
			host,
		} = await make({ heldAtStart: held })
		write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await feed(SETTLE_BYTES / 2 + block * 2)
		const receiptAt = samples()
		const pending = hop(engine, write)
		engine.noteHopReceipt(
			pending.epoch,
			ledger.fieldState("rtl").frequency.receipt,
		)
		const slack = postedSlack(host().inputs, pending.epoch)
		// The anchor width, the gap allowance and one sample of rounding: nothing else.
		expect(slack).toBe(held / 2 + HOP_GAP_ALLOWANCE + 1)
		expect((slack / RATE) * 1000).toBeLessThan(129)
		await feed(block / 4)
		const marker = samples()
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker + slack,
				settleMode: "marker",
				markerRunSamples: marker - receiptAt,
				proofSlackSamples: slack,
			},
		])
		expect(engine.trustShadow()!.markerBoundaries).toBe(1)
		await feed(marker + slack + block - samples())
		expect(blockAt(marker + slack + block, pending.epoch, HOP)).toBe(
			"commanded",
		)
		await engine.stop()
	})
})

describe("an absorber loss delays no later proof (N1)", () => {
	function timerHop(
		engine: SpectrumEngine,
		write: (payload: Buffer, tag?: TuningWriterTag) => void,
	): PendingEpoch {
		const clock = engine.sampleClock()
		const pending: PendingEpoch = {
			epoch: engine.allocateEpoch(),
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
			settleSamples: 0,
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz: HOP,
			sampleRateHz: RATE,
			gainKey: "na",
			tuningTrust: "unverified",
			centreChanged: true,
		}
		engine.suppressExternal(true)
		engine.submitEpoch(pending)
		write(frame(0x01, HOP), { writer: "scanner", jobId: "j1" })
		engine.suppressExternal(false)
		return pending
	}

	function proofFloor(inputs: readonly PipelineInput[], epoch: number) {
		for (const i of inputs)
			if (i.kind === "proof-floor" && i.epoch === epoch) return i.sample
		return null
	}

	/** 2 MiB lost, in `steps` losses each seen by a read (ANCHOR_LOSS_BREAKS: at and past it). */
	const LOSS = 2 * 1024 * 1024
	/** One step's loss: whole samples (2 bytes), about LOSS in all. */
	const step = (steps: number) => 2 * Math.floor(LOSS / steps / 2)

	it.each([1, ANCHOR_LOSS_BREAKS, ANCHOR_LOSS_BREAKS + 1])(
		"after a 2 MiB loss in %i step(s), the next hop's floor and first proven block are where they would be without it",
		async steps => {
			const {
				engine,
				ledger,
				feed,
				lose,
				write,
				events,
				block,
				blockAt,
				samples,
				host,
			} = await make()
			write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
			await feed(SETTLE_BYTES / 2 + block * 2)
			expect(blockAt(samples())).toBe("commanded")
			for (let i = 0; i < steps; i++) {
				lose(step(steps))
				await feed(block)
				expect(blockAt(samples())).toBe("commanded")
			}
			expect(engine.trustShadow()!.anchorWidenedBytes).toBe(step(steps) * steps)
			// Every byte offered from here on follows the whole loss: positions = offered + loss.
			const pending = timerHop(engine, write)
			const receiptAt = samples()
			engine.noteHopReceipt(
				pending.epoch,
				ledger.fieldState("rtl").frequency.receipt,
			)
			await feed(1)
			// The first sample whose lowest position, (s − gaps − 1) × 2 + loss, is at or past the
			// receipt's boundary, receiptAt × 2 + loss + settle, gaps taken as the allowance for
			// gaps still to come (P1): one sample of rounding and the allowance past it.
			const floor = proofFloor(host().inputs, pending.epoch)
			expect(floor).toBe(receiptAt + SETTLE_BYTES / 2 + HOP_GAP_ALLOWANCE + 1)
			events([
				{
					kind: "epoch-started",
					epoch: pending.epoch,
					startSample: floor!,
					settleMode: "timer",
				},
			])
			await feed(floor! + block - samples())
			expect(blockAt(floor! + block, pending.epoch, HOP)).toBe("commanded")
			expect(engine.labelReason()).toBeNull()
			await engine.stop()
		},
	)

	it.each([1, ANCHOR_LOSS_BREAKS + 1])(
		"bytes the absorber held when it lost (%i loss(es) seen) keep their lower bound: a pre-loss block inside the settle stays unverified",
		async steps => {
			const {
				engine,
				feed,
				lose,
				hold,
				release,
				write,
				block,
				blockAt,
				samples,
			} = await make()
			write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
			await feed(block)
			// Held up to a few samples short of the boundary (SETTLE_BYTES), then 2 MiB lost.
			hold(SETTLE_BYTES / 2 - block - 4)
			lose(step(steps))
			expect(blockAt(samples())).toBe("unverified")
			await release()
			const heldEnd = samples()
			// The held bytes precede the loss: their block ends before the boundary.
			expect(blockAt(heldEnd)).toBe("unverified")
			expect(engine.labelReason()).toBe("settling")
			for (let i = 1; i < steps; i++) {
				lose(step(steps))
				await feed(block)
				blockAt(samples())
			}
			// Read late, past every merge: still never above its true position.
			expect(blockAt(heldEnd)).toBe("unverified")
			await engine.stop()
		},
	)

	/** A timer hop posted and its floor placed, everything proven before it. */
	async function floored() {
		const h = await make()
		h.write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]))
		await h.feed(SETTLE_BYTES / 2 + h.block * 2)
		const pending = timerHop(h.engine, h.write)
		h.engine.noteHopReceipt(
			pending.epoch,
			h.ledger.fieldState("rtl").frequency.receipt,
		)
		await h.feed(1)
		const floor = proofFloor(h.host().inputs, pending.epoch)!
		const start = () =>
			h.events([
				{
					kind: "epoch-started",
					epoch: pending.epoch,
					startSample: floor,
					settleMode: "timer",
				},
			])
		return { ...h, pending, floor, start }
	}

	it.each([1, HOP_GAP_ALLOWANCE])(
		"%i gap(s) applied after the floor is posted and before it leave the first block proven (P1)",
		async gaps => {
			const h = await floored()
			for (let i = 0; i < gaps; i++) await h.gap(4)
			expect(h.samples()).toBeLessThan(h.floor)
			h.start()
			await h.feed(h.floor + h.block - h.samples())
			expect(h.blockAt(h.floor + h.block, h.pending.epoch, HOP)).toBe(
				"commanded",
			)
			await h.engine.stop()
		},
	)

	it("past the allowance the first block is unverified (fail closed), the next proven (P1)", async () => {
		const h = await floored()
		for (let i = 0; i <= HOP_GAP_ALLOWANCE; i++) await h.gap(4)
		h.start()
		await h.feed(h.floor + h.block * 2 - h.samples())
		expect(h.blockAt(h.floor + h.block, h.pending.epoch, HOP)).toBe(
			"unverified",
		)
		expect(h.engine.labelReason()).toBe("settling")
		expect(h.blockAt(h.floor + h.block * 2, h.pending.epoch, HOP)).toBe(
			"commanded",
		)
		await h.engine.stop()
	})

	it("gaps inside the first block, after its start, do not lower its start's bound, past the allowance too (P1)", async () => {
		const h = await floored()
		h.start()
		await h.feed(h.floor + 10 - h.samples())
		for (let i = 0; i < HOP_GAP_ALLOWANCE + 2; i++) await h.gap(4)
		await h.feed(h.floor + h.block - h.samples())
		expect(h.blockAt(h.floor + h.block, h.pending.epoch, HOP)).toBe("commanded")
		await h.engine.stop()
	})
})

describe("a stopped engine has no label reason (N3)", () => {
	it("labelReason is null once the engine stops, whatever its last block said", async () => {
		const { engine, feed, block, blockAt, samples } = await make()
		await feed(block * 2)
		expect(blockAt(samples())).toBe("unverified")
		expect(engine.labelReason()).not.toBeNull()
		await engine.stop()
		expect(engine.labelReason()).toBeNull()
	})
})
