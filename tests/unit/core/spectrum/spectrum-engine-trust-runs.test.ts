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
	/** The router's absorber counters (SourceFanoutRouter.ingestCounters). */
	const ingest: { heldBytes: number; lostBytesTotal: number } | null = {
		heldBytes: 0,
		lostBytesTotal: 0,
	}
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
	return {
		engine,
		ledger,
		ingest,
		feed,
		lose,
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
		write(frame(0x01, HOP), { writer: "scanner", jobId: "j1" })
		engine.suppressExternal(false)
		return pending
	}

	it("trusts the hop's blocks from the marker on, long before its receipt's settle; never before the marker", async () => {
		const { engine, ledger, feed, write, events, block, blockAt, samples } =
			await make()
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
		events([
			{
				kind: "epoch-started",
				epoch: pending.epoch,
				startSample: marker,
				settleMode: "marker",
			},
		])
		// A block starting at the marker itself: its lowest position (one sample of rounding) may
		// lie before the marker's highest one: not trusted. One starting just past it is.
		await feed(block)
		expect(blockAt(samples(), pending.epoch, HOP)).toBe("unverified")
		await feed(8)
		expect(blockAt(samples(), pending.epoch, HOP)).toBe("commanded")
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
})
