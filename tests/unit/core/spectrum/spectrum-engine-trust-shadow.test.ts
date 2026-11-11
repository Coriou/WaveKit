import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	SHADOW_DISAGREEMENTS,
	SpectrumEngine,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { blockSamplesOf } from "../../../../src/core/spectrum/retune-settle.js"
import { alarmWaitBlocksOf } from "../../../../src/core/spectrum/retune-alarm.js"
import type {
	BlockSummary,
	EngineState,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import { TuningLedger } from "../../../../src/core/tuning-ledger.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

class Host implements PipelineHost {
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(_input: PipelineInput, transfer?: ArrayBuffer): void {
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

const CENTRE = 446_100_000
const RATE = 1_024_000

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

function summary(epoch: number, endSample: number, stream = 0): BlockSummary {
	return {
		sourceId: "rtl",
		stream,
		epoch,
		endSample,
		centreHz: CENTRE,
		sampleRateHz: RATE,
		binHz: 1000,
		startHz: CENTRE - RATE / 2,
		bins: [],
		floorDbfs: -90,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: CENTRE, dcGuardHz: 0, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

async function make() {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const tuner = new FakeTuner()
	const ledger = new TuningLedger({
		settleLink: () => ({ configuredSettleMs: 0, inFlightBytes: 0 }),
		frameBytes: () => 2,
		capsRate: () => RATE,
	})
	const conn = ledger.connection("rtl")
	const session = conn.start()!
	sources.emit("session-started", "rtl", session.session)
	let host: Host | null = null
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		ledger,
		settings: () => testSettings(),
		logger: pino({ level: "silent" }),
		createHost: (_cfg, handlers) => (host = new Host(handlers)),
	})
	await engine.start()
	const cfg = engine.config()!
	const block = blockSamplesOf(cfg.integrationMs, cfg.sampleRateHz, cfg.fftSize)
	// The pipeline's alarm wait for this config (blocks a pending alarm is held).
	const wait = alarmWaitBlocksOf(cfg.trackHangMs, block, cfg.sampleRateHz)
	let samples = 0
	/** Source bytes: counted by the ledger session and offered to the branch, in order. */
	const feed = async (n: number) => {
		const bytes = Buffer.alloc(n * 2)
		session.pos += bytes.length
		fanout.write(bytes)
		samples += n
		await settle()
	}
	// The stream's own start (its labels: caps centre and rate, the tuner's trust).
	host!.handlers.events([
		{
			kind: "epoch-started",
			epoch: engine.currentEpoch().epoch + 1,
			startSample: 0,
			settleMode: "none",
		},
	])
	const emitBlock = () =>
		host!.handlers.events([
			{
				kind: "block-summary",
				summary: summary(engine.currentEpoch().epoch, samples),
			},
		])
	const emitAt = (stream: number, endSample: number) =>
		host!.handlers.events([
			{
				kind: "block-summary",
				summary: summary(engine.currentEpoch().epoch, endSample, stream),
			},
		])
	return {
		engine,
		ledger,
		conn,
		session,
		feed,
		emitBlock,
		emitAt,
		block,
		wait,
		sources,
		fanout,
		host: () => host!,
		samples: () => samples,
		resetSamples: () => {
			samples = 0
		},
	}
}

function last(engine: SpectrumEngine) {
	return engine.trustShadow()!.disagreements.at(-1)
}

describe("SpectrumEngine tuning-ledger shadow", () => {
	it("counts agreement, a stricter ledger (no receipt, a doubt) and a value mismatch, and exposes them", async () => {
		const { engine, ledger, conn, session, feed, emitBlock, block } =
			await make()
		expect(engine.currentEpoch().tuningTrust).toBe("commanded")
		// No receipt yet: the ledger is stricter than the engine's state rule.
		await feed(block * 2)
		emitBlock()
		expect(engine.trustShadow()).toMatchObject({
			agree: 0,
			ledgerStricter: 1,
		})
		expect(last(engine)).toMatchObject({
			kind: "ledger-stricter",
			engineTrust: "commanded",
			ledgerTrust: "unverified",
			reason: "no-receipt",
			session: 1,
			engineCentreHz: CENTRE,
			ledgerCentreHz: null,
		})
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 2)
		emitBlock()
		expect(engine.trustShadow()).toMatchObject({ agree: 1, ledgerStricter: 1 })
		// A doubt (here the host-centre path's call, made directly) unproves the next block.
		ledger.raiseDoubt("rtl", "frequency", "host-centre-mismatch")
		await feed(block * 2)
		emitBlock()
		expect(engine.trustShadow()).toMatchObject({ agree: 1, ledgerStricter: 2 })
		expect(last(engine)).toMatchObject({
			reason: "doubt",
			doubtReason: "host-centre-mismatch",
		})
		// A receipt at another centre: the ledger trusts a value the engine's epoch does not name.
		conn.write(frame(0x01, CENTRE + 100_000), { writer: "operator" })(null)
		await feed(block * 2)
		emitBlock()
		expect(engine.trustShadow()).toMatchObject({ mismatch: 1 })
		expect(last(engine)).toMatchObject({
			kind: "mismatch",
			ledgerTrust: "commanded",
			ledgerCentreHz: CENTRE + 100_000,
		})
		expect(engine.trustShadow()!.disagreements).toHaveLength(3)
		expect(session.ended).toBe(false)
		await engine.stop()
	})

	it("reads no shadow without a ledger, and a pipeline error raises a doubt", async () => {
		const { engine, ledger, conn, feed, block } = await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block)
		const host = (
			engine as unknown as { host: { handlers: PipelineHostHandlers } }
		).host
		engine.on("error", () => undefined)
		host.handlers.error(new Error("worker hiccup"))
		expect(ledger.doubts("rtl").map(d => [d.field, d.reason])).toEqual([
			["both", "pipeline-error"],
		])
		await engine.stop()
		const bare = new SpectrumEngine({
			sourceId: "rtl",
			sources: new FakeSources(),
			routing: {
				getFanout: () => new FakeFanout() as never,
				releaseUnused: () => undefined,
			},
			tuner: null,
			settings: () => testSettings(),
			logger: pino({ level: "silent" }),
		})
		expect(bare.trustShadow()).toBeNull()
	})
	it("keeps the last 32 disagreements, at and past the bound", async () => {
		const { engine, feed, emitBlock, block } = await make()
		for (let i = 0; i < SHADOW_DISAGREEMENTS; i++) {
			await feed(block)
			emitBlock()
		}
		let shadow = engine.trustShadow()!
		expect(shadow.ledgerStricter).toBe(SHADOW_DISAGREEMENTS)
		expect(shadow.disagreements).toHaveLength(SHADOW_DISAGREEMENTS)
		const first = shadow.disagreements[0]!.posA
		await feed(block)
		emitBlock()
		shadow = engine.trustShadow()!
		expect(shadow.ledgerStricter).toBe(SHADOW_DISAGREEMENTS + 1)
		expect(shadow.disagreements).toHaveLength(SHADOW_DISAGREEMENTS)
		// The oldest left; positions grow block by block.
		expect(shadow.disagreements[0]!.posA).toBeGreaterThan(first!)
		expect(shadow.disagreements.at(-1)!.posB).toBe(
			shadow.disagreements.at(-1)!.posA! + (block + 1) * 2,
		)
		await engine.stop()
	})

	it("maps a late block through its own stream's block length after a rate change", async () => {
		const { engine, sources, feed, emitAt, block, samples } = await make()
		await feed(block * 4)
		const oldEnd = samples()
		// A rate change restarts the pipeline: stream 1 at twice the rate, twice the block.
		sources.setCaps("rtl", { sampleRate: RATE * 2 })
		await engine.reconfigure()
		const cfg = engine.config()!
		const block1 = blockSamplesOf(
			cfg.integrationMs,
			cfg.sampleRateHz,
			cfg.fftSize,
		)
		expect(block1).not.toBe(block)
		// The late block of stream 0 arrives now.
		emitAt(0, oldEnd)
		const d = last(engine)!
		expect(d.reason).toBe("no-receipt")
		// Stream 0's sample 0 is source position 0; its block is `block` samples of 2 bytes.
		expect(d.posA).toBe((oldEnd - block - 1) * 2)
		expect(d.posB).toBe(oldEnd * 2)
		await engine.stop()
	})

	it("reads a block reaching before its session's start as before-session", async () => {
		const { engine, ledger, conn, sources, fanout, feed, emitAt, block } =
			await make()
		await feed(block * 4)
		conn.close()
		const next = ledger.connection("rtl")
		const s2 = next.start()!
		sources.emit("session-started", "rtl", s2.session)
		next.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		// Half a block of the new session after block * 4 samples of the old one.
		const bytes = Buffer.alloc(block)
		s2.pos += bytes.length
		fanout.write(bytes)
		await settle()
		emitAt(0, block * 4 + block / 2)
		expect(last(engine)).toMatchObject({
			reason: "before-session",
			session: 2,
			posA: 0,
		})
		await engine.stop()
	})

	it("raises an untracked-retune doubt at the start of the alarm's reference block", async () => {
		const { engine, ledger, conn, feed, block, wait, host, samples } =
			await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 20)
		engine.on("warning", () => undefined)
		expect(wait).toBeGreaterThan(2)
		// Held pending for its full wait, then fired: its reference block started wait + 2
		// blocks before the firing block's end, far more than two blocks back.
		const reference = samples() - (wait + 2) * block
		expect(reference).toBeGreaterThan(0)
		host().handlers.events([
			{
				kind: "untracked-retune",
				epoch: engine.currentEpoch().epoch + 1,
				stream: 0,
				startSample: samples(),
				referenceStartSample: reference,
				deltaHz: 25_000,
				suspected: "external-control",
			},
		])
		const doubt = ledger.doubts("rtl").at(-1)!
		expect(doubt.reason).toBe("untracked-retune")
		// One sample of gap rounding, 2 bytes each.
		expect(doubt.pos).toBe((reference - 1) * 2)
		expect(doubt.pos).toBeLessThan(ledger.position("rtl")!.pos)
		await engine.stop()
	})

	it("without a reference sample reaches back the pipeline's alarm wait; without a stream, the session start", async () => {
		const { engine, ledger, conn, feed, block, wait, host, samples } =
			await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 20)
		engine.on("warning", () => undefined)
		const alarm = (stream?: number) =>
			host().handlers.events([
				{
					kind: "untracked-retune",
					epoch: engine.currentEpoch().epoch + 1,
					...(stream !== undefined ? { stream } : {}),
					startSample: samples(),
					deltaHz: 25_000,
				},
			])
		alarm(0)
		expect(ledger.doubts("rtl").at(-1)!.pos).toBe(
			(samples() - (wait + 2) * block - 1) * 2,
		)
		// No stream on the event: its samples cannot be mapped, so the session start.
		alarm()
		expect(ledger.doubts("rtl").map(d => d.pos)).toEqual([
			0,
			(samples() - (wait + 2) * block - 1) * 2,
		])
		await engine.stop()
	})

	it("maps a late untracked-retune alarm through its own older stream", async () => {
		const { engine, ledger, conn, sources, feed, block, host, samples } =
			await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 4)
		const oldEnd = samples()
		// Stream 1 at twice the rate starts at source position block * 8.
		sources.setCaps("rtl", { sampleRate: RATE * 2 })
		await engine.reconfigure()
		await feed(block * 4)
		engine.on("warning", () => undefined)
		const alarm = (stream: number) =>
			host().handlers.events([
				{
					kind: "untracked-retune",
					epoch: engine.currentEpoch().epoch + 1,
					stream,
					startSample: oldEnd,
					referenceStartSample: oldEnd - 2 * block,
					deltaHz: 25_000,
				},
			])
		// Stream 0's map: its reference block, one sample of gap rounding.
		const expected = (oldEnd - 2 * block - 1) * 2
		alarm(0)
		expect(ledger.doubts("rtl").at(-1)!.pos).toBe(expected)
		// A stream whose map is not kept: the session start (doubts are in position order).
		alarm(99)
		expect(ledger.doubts("rtl").map(d => d.pos)).toEqual([0, expected])
		await engine.stop()
	})

	it("doubts a pipeline error from the oldest sample a pending alarm may still be owed for", async () => {
		const {
			engine,
			ledger,
			conn,
			feed,
			emitBlock,
			block,
			wait,
			host,
			samples,
		} = await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 20)
		// An alarm pending since the reference block below would fire on the block reported
		// now (its summary first); the error loses it.
		emitBlock()
		const reported = samples()
		const reference = reported - (wait + 2) * block
		expect(reference).toBeGreaterThan(0)
		await feed(block * 5)
		engine.on("error", () => undefined)
		host().handlers.error(new Error("worker hiccup"))
		const doubt = ledger.doubts("rtl").at(-1)!
		expect(doubt.reason).toBe("pipeline-error")
		// At the lost alarm's reference block, one sample of gap rounding, 2 bytes each.
		expect(doubt.pos).toBe((reference - 1) * 2)
		expect(doubt.pos).toBeLessThan(ledger.position("rtl")!.pos)
		await engine.stop()
	})

	it("doubts a pipeline error before any block summary from the stream's start", async () => {
		const { engine, ledger, conn, feed, block, host } = await make()
		conn.write(Buffer.concat([frame(0x01, CENTRE), frame(0x02, RATE)]), {
			writer: "operator",
		})(null)
		await feed(block * 10)
		engine.on("error", () => undefined)
		engine.on("fatal", () => undefined)
		host().handlers.fatal!(new Error("worker gone"))
		const doubt = ledger.doubts("rtl").at(-1)!
		expect(doubt.reason).toBe("pipeline-error")
		expect(doubt.pos).toBe(0)
		await engine.stop()
	})
})
