/**
 * Retune-delay measurement (trust step 2, A7): the engine measures, per flushed centre frame, the
 * payload distance to the first block whose content shows the change. The stamped fake's delay
 * queue holds each command before it takes effect (an upstream delay): the measurement must see it.
 * Real SourceManager, FanoutManager and SpectrumEngine; a recording pipeline host whose block
 * summaries render the stamps the block carried (a carrier pattern per centre).
 */
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { blockSamplesOf } from "../../../../src/core/spectrum/retune-settle.js"
import {
	CHANGE_DB,
	RETUNE_DELAY_SAMPLES,
	RETUNE_TAINT_WINDOWS,
	RetuneDelayMeter,
} from "../../../../src/core/spectrum/retune-delay.js"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	BlockSummary,
	EngineState,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import { startStampedRtlTcp } from "../../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "error" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 102.4 ksps U8 IQ (204.8 kB/s), what the fake delivers (1024 B every 5 ms). */
const RATE = 102_400
const F0 = 100_000_000
const F1 = 101_000_000
const F2 = 102_000_000
const BINS = 64
const DELAY_MS = 400

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

/** A carrier pattern per centre stamp: a block on another centre differs by 40 dB in places. */
function binsOf(stamp: number): number[] {
	return Array.from({ length: BINS }, (_, k) =>
		(k + stamp * 7) % 4 === 0 ? -50 : -90,
	)
}

/** Keeps each stream's samples; at each block boundary answers a summary of the block's stamps. */
class StampHost implements PipelineHost {
	private readonly samples = new Map<number, Buffer>()
	private stream = -1
	private reached = 0
	private emitted = 0
	constructor(
		readonly handlers: PipelineHostHandlers,
		private readonly block: number,
		private readonly epochOf: () => number,
	) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		if (input.kind === "new-stream") {
			this.stream = input.stream
			this.reached = 0
			this.emitted = 0
			this.samples.set(input.stream, Buffer.alloc(0))
			const stream = input.stream
			setImmediate(() =>
				this.handlers.events([
					{
						kind: "epoch-started",
						epoch: stream + 1,
						startSample: 0,
						settleMode: "none",
					},
				]),
			)
		} else if (input.kind === "bytes" || input.kind === "gap") {
			const n = input.kind === "bytes" ? input.bytes.length / 2 : input.samples
			const end = input.startSample + n
			const old = this.samples.get(this.stream) ?? Buffer.alloc(0)
			const grown = Buffer.alloc(Math.max(old.length, end * 2))
			old.copy(grown)
			if (input.kind === "bytes")
				Buffer.from(input.bytes).copy(grown, input.startSample * 2)
			this.samples.set(this.stream, grown)
			this.reached = Math.max(this.reached, end)
			while ((this.emitted + 1) * this.block <= this.reached) {
				this.emitted += 1
				this.summarise(this.stream, this.emitted * this.block)
			}
		}
		if (transfer) this.handlers.buffer(transfer)
	}
	private summarise(stream: number, endSample: number): void {
		const bytes = this.samples.get(stream)!
		// The block shows the new centre once most of its samples carry its stamp.
		const counts = new Map<number, number>()
		for (let i = endSample - this.block; i < endSample; i++) {
			const c = bytes[i * 2]!
			counts.set(c, (counts.get(c) ?? 0) + 1)
		}
		const stamp = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
		const summary: BlockSummary = {
			sourceId: "rtl",
			stream,
			epoch: this.epochOf(),
			endSample,
			centreHz: F0,
			sampleRateHz: RATE,
			binHz: 100,
			startHz: F0 - RATE / 2,
			bins: binsOf(stamp),
			floorDbfs: -90,
			thresholdDb: 10,
			tracks: [],
			masks: { dcHz: F0, dcGuardHz: 0, spurRanges: [] },
			floorOccupied: false,
			overload: false,
		}
		setImmediate(() =>
			this.handlers.events([{ kind: "block-summary", summary }]),
		)
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

describe("RetuneDelayMeter", () => {
	const block = (posA: number, bins: number[], session = 1) => ({
		session,
		posA,
		posB: posA + 1000,
		bins,
		binHz: 100,
	})
	const flat = (db: number) => Array.from({ length: BINS }, () => db)

	it("measures from the flush to the first block that differs, in bytes and ms", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1000 },
			F0,
			2000,
		)
		m.onBlock(block(1000, flat(-90)))
		m.onBlock(block(2000, flat(-90 + CHANGE_DB)))
		expect(m.status()).toEqual({
			count: 1,
			p50Ms: 500,
			maxMs: 500,
			p50Bytes: 1000,
			maxBytes: 1000,
			// Upper bound: to the detecting block's end (posB 3000).
			maxMsUpper: 1000,
			maxBytesUpper: 2000,
			undetected: 0,
			undetectedReasons: {
				superseded: 0,
				unmeasurable: 0,
				session: 0,
				noReference: 0,
				grid: 0,
				bracket: 0,
				timeout: 0,
			},
		})
	})

	it("reports the upper-bound max from the detecting block's end beside the lower bound", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1000 },
			F0,
			2000,
		)
		// A long block: its first byte at 1200 (lower bound), its end at 4200 (upper bound).
		m.onBlock({ ...block(1200, flat(-50)), posB: 4200 })
		expect(m.status()).toMatchObject({
			count: 1,
			maxBytes: 200,
			maxMs: 100,
			maxBytesUpper: 3200,
			maxMsUpper: 1600,
		})
	})

	it("merges overlapping marker-bracket windows instead of keeping only the last", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		// 10 Hz × 2 B: 5 s is 100 B. Bracket 1 taints [1000, 1200), bracket 2 [1150, 1280).
		m.onTestMode({ session: 1, on: true, pos: 1000 }, 10, 2)
		m.onTestMode({ session: 1, on: false, pos: 1100 }, 10, 2)
		m.onTestMode({ session: 1, on: true, pos: 1150 }, 10, 2)
		m.onTestMode({ session: 1, on: false, pos: 1180 }, 10, 2)
		// A block of bracket 1's pattern, before bracket 2's start, arriving late: tainted.
		m.onBlock({ ...block(1000, flat(-30)), posB: 1100 })
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1300 },
			F0,
			20,
		)
		// Had the pattern block been the reference, this clean block would read as the change.
		m.onBlock({ ...block(1300, flat(-90)), posB: 1400 })
		expect(m.status()).toMatchObject({ count: 0, undetected: 1 })
	})

	it("sizes a bracket's window from the rate in effect for it, not the engine's current one", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		m.onTestMode({ session: 1, on: true, pos: 1000 }, 10, 2)
		// The hop's own rate frame inside the bracket: 100 Hz × 2 B, 5 s is 1000 B.
		m.onReceipt(
			{ session: 1, field: "sampleRate", value: 100, pos: 1000 },
			10,
			20,
		)
		m.onTestMode({ session: 1, on: false, pos: 1100 }, 10, 2)
		// Within [1000, 2100) at the bracket's rate (past [1000, 1200) at the engine's).
		m.onBlock({ ...block(1500, flat(-30)), posB: 1600 })
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1700 },
			F0,
			200,
		)
		m.onBlock({ ...block(1700, flat(-90)), posB: 1800 })
		expect(m.status()).toMatchObject({ count: 0, undetected: 1 })
	})

	it(`keeps at most ${RETUNE_TAINT_WINDOWS} disjoint bracket windows, merging the oldest past the bound`, () => {
		const m = new RetuneDelayMeter()
		// 10 Hz × 2 B: each window is its bracket plus 100 B; brackets 1000 B apart stay disjoint.
		const bracket = (at: number) => {
			m.onTestMode({ session: 1, on: true, pos: at }, 10, 2)
			m.onTestMode({ session: 1, on: false, pos: at + 10 }, 10, 2)
		}
		for (let i = 0; i < RETUNE_TAINT_WINDOWS + 1; i++) bracket(1000 * (i + 1))
		const windows = (
			m as unknown as { taints: { from: number; until: number }[] }
		).taints
		expect(windows).toHaveLength(RETUNE_TAINT_WINDOWS)
		// The two oldest merged into one covering both (a superset).
		expect(windows[0]).toMatchObject({ from: 1000, until: 2110 })
		// A clean block between the merged windows' brackets is tainted (conservative).
		m.onBlock({ ...block(1500, flat(-90)), posB: 1600 })
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1700 },
			F0,
			20,
		)
		m.onBlock({ ...block(1700, flat(-50)), posB: 1750 })
		expect(m.status()).toMatchObject({ count: 0, undetected: 1 })
	})

	it("matches a small retune by its shift, not by noise", () => {
		const m = new RetuneDelayMeter()
		const ref = Array.from({ length: BINS }, (_, k) => (k === 30 ? -40 : -90))
		m.onBlock(block(0, ref))
		// +500 Hz = 5 bins: the carrier moves from bin 30 to bin 25.
		m.onReceipt(
			{ session: 1, field: "frequency", value: F0 + 500, pos: 1000 },
			F0,
			2000,
		)
		const noisy = ref.map((v, k) => (k % 2 === 0 ? v + 1 : v - 1))
		m.onBlock(block(1000, noisy))
		expect(m.status().count).toBe(0)
		m.onBlock(
			block(
				2000,
				ref.map((_, k) => (k === 25 ? -40 : -90)),
			),
		)
		expect(m.status()).toMatchObject({ count: 1, p50Bytes: 1000 })
	})

	it("counts undetected: a quiet band past the limit, another session, a newer frame first", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1000 },
			F0,
			200,
		)
		// 5 s at 200 B/s is 1000 B: a block starting past it gives up.
		m.onBlock(block(2001, flat(-90)))
		expect(m.status().undetected).toBe(1)
		m.onReceipt(
			{ session: 1, field: "frequency", value: F2, pos: 3000 },
			null,
			200,
		)
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 3100 },
			null,
			200,
		)
		expect(m.status().undetected).toBe(2)
		m.onBlock(block(3200, flat(-50), 2))
		expect(m.status()).toMatchObject({ count: 0, undetected: 3 })
		// By reason: they add up to `undetected`.
		expect(m.status().undetectedReasons).toEqual({
			superseded: 1,
			unmeasurable: 0,
			session: 1,
			noReference: 0,
			grid: 0,
			bracket: 0,
			timeout: 1,
		})
		// No payload rate, no reference, another bin grid.
		m.onReceipt(
			{ session: 2, field: "frequency", value: F2, pos: 4000 },
			F0,
			null,
		)
		m.onReceipt(
			{ session: 2, field: "frequency", value: F1, pos: 4100 },
			null,
			200,
		)
		m.onBlock(block(4200, flat(-50), 2))
		// A reference wholly before the next flush, then a block on another grid.
		m.onBlock(block(3400, flat(-90), 2))
		m.onReceipt(
			{ session: 2, field: "frequency", value: F2, pos: 4400 },
			null,
			200,
		)
		m.onBlock({ ...block(4500, flat(-50), 2), binHz: 200 })
		expect(m.status().undetectedReasons).toEqual({
			superseded: 1,
			unmeasurable: 1,
			session: 1,
			noReference: 1,
			grid: 1,
			bracket: 0,
			timeout: 1,
		})
		expect(m.status().undetected).toBe(6)
	})

	it("skips receipts inside a scanner marker bracket and never takes test-mode blocks as content", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		// Test mode on at 1000: a hop's rate and centre inside the bracket start nothing.
		m.onTestMode({ session: 1, on: true, pos: 1000 }, 1000, 2)
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1000 },
			F0,
			2000,
		)
		// The test pattern differs from the reference: no measurement, no undetected either.
		m.onBlock(block(1000, flat(-30)))
		m.onTestMode({ session: 1, on: false, pos: 2000 }, 1000, 2)
		m.onBlock(block(2000, flat(-30)))
		expect(m.status()).toMatchObject({ count: 0, undetected: 0 })
		// A change soon after the bracket: blocks within RETUNE_DETECT_MAX_MS of payload after
		// test mode off may still carry the pattern, so they are no reference: undetected.
		m.onReceipt(
			{ session: 1, field: "frequency", value: F2, pos: 3000 },
			null,
			2000,
		)
		m.onBlock(block(3000, flat(-90)))
		expect(m.status()).toMatchObject({ count: 0, undetected: 1 })
		expect(m.status().undetectedReasons.bracket).toBe(1)
		// Past that window a clean block is a reference again.
		const clean = 2000 + 5 * 2000
		m.onBlock(block(clean, flat(-90)))
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: clean + 1000 },
			null,
			2000,
		)
		m.onBlock(block(clean + 1000, flat(-90 + CHANGE_DB)))
		expect(m.status()).toMatchObject({ count: 1, p50Bytes: 0, undetected: 1 })
	})

	it("a test-mode bracket opening drops a pending measurement uncounted", () => {
		const m = new RetuneDelayMeter()
		m.onBlock(block(0, flat(-90)))
		m.onReceipt(
			{ session: 1, field: "frequency", value: F1, pos: 1000 },
			F0,
			2000,
		)
		m.onTestMode({ session: 1, on: true, pos: 1100 }, 1000, 2)
		m.onBlock(block(1100, flat(-30)))
		expect(m.status()).toMatchObject({ count: 0, undetected: 0 })
	})

	it(`keeps the last ${RETUNE_DELAY_SAMPLES} measurements for p50 and max, at and past the bound`, () => {
		const m = new RetuneDelayMeter()
		let pos = 0
		let value = F0
		// The value in effect before the session's first receipt (the engine's centre).
		let before: number | null = F0
		const one = (bytes: number) => {
			m.onBlock(block(pos, flat(-90)))
			value += 1_000_000
			m.onReceipt(
				{ session: 1, field: "frequency", value, pos: pos + 1000 },
				before,
				1000,
			)
			before = null
			m.onBlock(block(pos + 1000 + bytes, flat(-50)))
			pos += 1000 + bytes + 1000
		}
		// The first: the largest delay; then RETUNE_DELAY_SAMPLES − 1 small ones.
		one(900)
		for (let i = 1; i < RETUNE_DELAY_SAMPLES; i++) one(10)
		expect(m.status()).toMatchObject({
			count: RETUNE_DELAY_SAMPLES,
			maxBytes: 900,
		})
		one(10)
		expect(m.status()).toMatchObject({
			count: RETUNE_DELAY_SAMPLES + 1,
			maxBytes: 10,
		})
	})
})

describe("SpectrumEngine retune delay (real SourceManager, stamped fake with a delay queue)", () => {
	it("sees an upstream delay in the delay it reports", async () => {
		const fake = await startStampedRtlTcp({ initialHz: F0, initialRate: RATE })
		cleanups.push(() => fake.close())
		const manager = new SourceManager(logger, {
			tuningSettleMs: () => 0,
			tuningInFlightBytes: 4096,
		})
		cleanups.push(() => manager.disconnectAll())
		await manager.connect({
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: fake.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: RATE,
				centerFreq: F0,
				exclusive: false,
			},
		} as SourceConfig)
		const ledger = manager.tuningLedger
		await until(() => (ledger.position("rtl")?.pos ?? 0) > 0)
		const fanout = new FanoutManager(logger)
		fanout.attachSource(manager.getStream("rtl")!)
		cleanups.push(() => fanout.destroy())
		const settings = testSettings()
		const engine: SpectrumEngine = new SpectrumEngine({
			sourceId: "rtl",
			sources: manager,
			routing: { getFanout: () => fanout, releaseUnused: () => undefined },
			tuner: null,
			settings: () => settings,
			logger: pino({ level: "silent" }),
			createHost: (cfg, handlers) =>
				new StampHost(
					handlers,
					blockSamplesOf(cfg.integrationMs, cfg.sampleRateHz, cfg.fftSize),
					() => engine.currentEpoch().epoch,
				),
		})
		cleanups.push(() => engine.stop())
		await engine.start()
		await wait(300)
		const delay = () => engine.trustShadow()!.retuneDelay

		// No upstream delay: the change shows within the in-flight bytes.
		manager.writeToSource("rtl", frame(0x01, F1), { writer: "operator" })
		await until(() => delay().count === 1)
		const prompt = delay().maxMs!
		// 400 ms of upstream delay before the next command takes effect.
		fake.setCommandDelay(DELAY_MS)
		await wait(300)
		manager.writeToSource("rtl", frame(0x01, F2), { writer: "operator" })
		await until(() => delay().count === 2)
		const delayed = delay().maxMs!
		expect(delay().undetected).toBe(0)
		expect(delayed - prompt).toBeGreaterThan(DELAY_MS * 0.6)
		expect(delayed - prompt).toBeLessThan(DELAY_MS * 2)
		expect(delay().maxBytes).toBeGreaterThan(
			((DELAY_MS * 0.6) / 1000) * RATE * 2,
		)
	}, 30_000)
})
