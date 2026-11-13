/**
 * A sweep's dwell counts only proven blocks of its own hop (fix round 3: F2, F3, F7, and the
 * dwell rule of the job runner), through production wiring: SourceManager with its tuning ledger
 * (settle 1000 ms, as on a network link, beside a deep in-flight estimate), fanout routing, TunerController on wireTunerControl
 * with a real TunerRelay, ScannerService with its spectrum engine (inline host), TunerArbiter,
 * JobRunner and SweepScheduler, against the stamped fake rtl_tcp on an ephemeral loopback port
 * (with the RTL2832 test-mode ramp for scanner markers). Every block the sweep scheduler counts
 * is checked against the engine's label of that block and the stamps of its samples.
 */
import { mkdtempSync, rmSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScannerConfigSchema, type SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import { SweepScheduler } from "../../../src/core/scanner/scheduler.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import type {
	EngineEpoch,
	SpectrumEngine,
} from "../../../src/core/spectrum/spectrum-engine.js"
import type { PipelineEvent } from "../../../src/core/spectrum/types.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TuningReceipt } from "../../../src/core/tuning-ledger.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { createLogger } from "../../../src/utils/logger.js"
import { settleMs } from "../../../src/core/spectrum/network-settle.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"

const RATE = 1_024_000
const F0 = 446_100_000
const F2 = 447_300_000
/** The settle the user runs: 1000 ms (network link), for the ledger and for the hop's timer. */
const SETTLE_MS = 1000
/**
 * A deep network buffer: 5 MiB in flight at 1.024 Msps U8 (2.048 MB/s) is 2.56 s, so the ledger's
 * boundary (network-settle: the larger of the two) falls after the pipeline's first hop blocks.
 * (The stamped radio shows every hop the same scene, so the pipeline's stale discard holds a
 * hop's first blocks back for its 1 s maximum; a boundary of 1 s would pass before any.)
 */
const IN_FLIGHT = 5 * 1024 * 1024
const LEDGER_SETTLE_MS = settleMs(RATE, 2, {
	configuredSettleMs: SETTLE_MS,
	inFlightBytes: IN_FLIGHT,
})
/** Shorter than the settle: only a marker lets a hop's dwell finish within its settle. */
const DWELL_MS = 300

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

async function freePort(): Promise<number> {
	const server = net.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

/** Samples the engine received, per stream (from its tap), to check stamps by sample index. */
class StampLog {
	private readonly streams = new Map<
		number,
		{ start: number; bytes: Uint8Array }[]
	>()
	add(stream: number, start: number, bytes: Uint8Array): void {
		let list = this.streams.get(stream)
		if (!list) {
			list = []
			this.streams.set(stream, list)
		}
		list.push({ start, bytes: Uint8Array.from(bytes) })
	}
	*stamps(stream: number, a: number, b: number): Generator<[number, number]> {
		for (const piece of this.streams.get(stream) ?? []) {
			const end = piece.start + piece.bytes.length / 2
			if (end <= a || piece.start >= b) continue
			for (let s = Math.max(a, piece.start); s < Math.min(b, end); s++) {
				const i = (s - piece.start) * 2
				yield [piece.bytes[i]!, piece.bytes[i + 1]!]
			}
		}
	}
}

async function compose(opts: { markers: boolean; hopSettleMs: number }) {
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		chunkBytes: 8192,
		intervalMs: 5,
		testModeRamp: true,
	})
	cleanups.push(() => fake.close())
	const dir = mkdtempSync(join(tmpdir(), "wk-ledger-dwell-"))
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
	const source = {
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
	} as SourceConfig
	const sourceManager = new SourceManager(logger, {
		tuningSettleMs: () => SETTLE_MS,
		tuningInFlightBytes: IN_FLIGHT,
	})
	sourceManager.on("error", () => undefined)
	const fanout = new FanoutManager(logger)
	const routing = new SourceFanoutRouter(sourceManager, fanout, logger, "rtl")
	const tuner = new TunerController(logger, sourceManager)
	tuner.on("error", () => undefined)
	const relayFanout = new FanoutManager(logger)
	const relay = new TunerRelay(logger, sourceManager, relayFanout, {
		enabled: true,
		host: "127.0.0.1",
		port: await freePort(),
		sourceId: "rtl",
		controlPolicy: "shared",
	})
	await relay.start()
	cleanups.push(() => relay.stop())
	wireTunerControl({
		log: logger,
		sourceManager,
		tunerController: tuner,
		tunerRelay: relay,
		relayEnabled: true,
	})
	const decoders = new DecoderManager(new DecoderRegistry(), fanout, logger)
	decoders.setSourceManager(sourceManager, routing)
	const settings = ScannerConfigSchema.parse({
		storage: { dir: join(dir, "scanner") },
	}) as ScannerSettings
	settings.sweep.markers = opts.markers
	settings.sweep.settleMs.local = opts.hopSettleMs
	const scanner = new ScannerService({
		settings,
		sourceConfigs: [source],
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: sourceManager,
		routing,
		tuner,
		decoders,
		digitalVoice: null,
		liveDemod: null,
		logger,
		engineHost: "inline",
	})
	cleanups.push(async () => {
		await scanner.stop()
		await decoders.destroy()
		await sourceManager.disconnectAll()
	})
	const receipts: TuningReceipt[] = []
	sourceManager.tuningLedger.subscribe((id, change) => {
		if (id === "rtl" && change.kind === "receipt") receipts.push(change.receipt)
	})
	return { fake, source, sourceManager, tuner, relay, scanner, receipts }
}

interface Labelled {
	trust: string
	centreHz: number
	foreign: boolean
	checked: number
}

/** Each block summary's label and stamps, and every block the sweep scheduler counted. */
function watch(
	engine: SpectrumEngine,
	fake: Awaited<ReturnType<typeof startStampedRtlTcp>>,
) {
	const log = new StampLog()
	engine.tap((start, bytes) =>
		log.add(engine.accounting().stream, start, bytes),
	)
	const blocks = new Map<string, Labelled>()
	let foreign = 0
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
		if (ev.kind !== "block-summary") return
		const s = ev.summary
		const cfg = engine.config()!
		const block = Math.round((cfg.integrationMs * cfg.sampleRateHz) / 1000)
		let checked = 0
		let wrong = false
		for (const [c, r] of log.stamps(
			s.stream,
			s.endSample - block,
			s.endSample,
		)) {
			checked += 1
			if (fake.centreOf(c) !== s.centreHz || fake.rateOf(r) !== s.sampleRateHz)
				wrong = true
		}
		if (epoch.tuningTrust !== "unverified" && wrong) foreign += 1
		blocks.set(`${s.stream}:${s.endSample}`, {
			trust: epoch.tuningTrust,
			centreHz: s.centreHz,
			foreign: wrong,
			checked,
		})
	})
	const counted: { key: string; at: number }[] = []
	const onBlock = SweepScheduler.prototype.onBlock
	vi.spyOn(SweepScheduler.prototype, "onBlock").mockImplementation(function (
		this: SweepScheduler,
		endSample: number,
	) {
		counted.push({
			key: `${engine.accounting().stream}:${endSample}`,
			at: Date.now(),
		})
		return onBlock.call(this, endSample)
	})
	/** Every counted block, as the engine labelled it (null: a block it never emitted). */
	const countedBlocks = () => counted.map(c => blocks.get(c.key) ?? null)
	/** When the scheduler first counted a block at `centreHz` at or after `since` (ms), or null. */
	const firstCountedAt = (centreHz: number, since: number): number | null =>
		counted.find(c => c.at >= since && blocks.get(c.key)?.centreHz === centreHz)
			?.at ?? null
	/** Forgets what was counted so far (a job's plan preview simulates its sweep on a scheduler). */
	const resetCounted = () => {
		counted.length = 0
	}
	return {
		blocks,
		countedBlocks,
		firstCountedAt,
		resetCounted,
		foreign: () => foreign,
	}
}

const hopReceipts = (receipts: TuningReceipt[]) =>
	receipts.filter(r => r.field === "frequency" && r.writer === "scanner")

/**
 * `hopSettleMs`: the hop's pipeline settle (its timer epoch starts that long after the command);
 * the ledger's stays SETTLE_MS, so a shorter one offers the dwell blocks the ledger does not prove.
 */
async function startSweep(markers: boolean, hopSettleMs = SETTLE_MS) {
	const c = await compose({ markers, hopSettleMs })
	await c.scanner.start()
	await c.sourceManager.connect(c.source)
	const engine = await c.scanner.spectrum.acquire("rtl", "dwell-test")
	cleanups.push(() => c.scanner.spectrum.release("rtl", "dwell-test"))
	const w = watch(engine, c.fake)
	// The fresh core's assert proves F0 first (past the 1000 ms settle).
	await until(() =>
		[...w.blocks.values()].some(
			b => b.trust === "commanded" && b.centreHz === F0,
		),
	)
	const job = await c.scanner.createJob({
		sourceId: "rtl",
		mode: "sweep",
		ranges: [{ startHz: 450_000_000, endHz: 460_000_000 }],
		dwellMs: DWELL_MS,
		// The stamps and the marker ramp are no signals to hold on: hop on.
		hold: { policy: "never" },
		takeover: true,
		resume: { autoAfterIdleMs: null },
	})
	w.resetCounted()
	return { ...c, engine, w, job }
}

/** Counted blocks are all labelled trusted, at a hop centre, with their own stamps only. */
function expectCountedProven(w: ReturnType<typeof watch>): number {
	const counted = w.countedBlocks()
	for (const b of counted) {
		expect(b).not.toBeNull()
		expect(b!.trust).toBe("commanded")
		expect(b!.centreHz).toBeGreaterThan(449_000_000)
		expect(b!.foreign).toBe(false)
	}
	return counted.length
}

describe("a sweep dwell counts only its own hop's proven blocks (production wiring)", () => {
	it("a hop settle shorter than the ledger's: the hop blocks inside the ledger's settle count for nothing; the dwell runs on proven blocks", async () => {
		const s = await startSweep(false, 100)
		await until(() => hopReceipts(s.receipts).length >= 3, 30_000)
		await s.scanner.cancelJob(s.job.id)
		// Hops ran, each dwell finished, and not one counted block was unproven or another hop's.
		expect(expectCountedProven(s.w)).toBeGreaterThan(0)
		// The settle was honoured: unverified hop blocks exist (they were offered and not counted).
		expect(
			[...s.w.blocks.values()].some(
				b => b.trust === "unverified" && b.centreHz > 449_000_000,
			),
		).toBe(true)
		expect(s.w.foreign()).toBe(0)
	}, 60_000)

	it("markers: hop blocks are trusted from the marker on, a dwell shorter than the settle finishes on them, and a relay client's frame is labelled relay (F2, F7)", async () => {
		const s = await startSweep(true, 100)
		await until(() => hopReceipts(s.receipts).length >= 4, 30_000)
		const hops = hopReceipts(s.receipts)
		await s.scanner.cancelJob(s.job.id)
		expect(s.engine.trustShadow()!.markerBoundaries).toBeGreaterThan(0)
		expect(expectCountedProven(s.w)).toBeGreaterThan(0)
		// Each hop's dwell started on blocks the marker proved, before its receipt's settle would
		// have proven any (the ledger alone: receipt + LEDGER_SETTLE_MS).
		const delays = hops.slice(0, -1).map(r => {
			const at = s.w.firstCountedAt(r.value, r.at)
			expect(at).not.toBeNull()
			return at! - r.at
		})
		expect(LEDGER_SETTLE_MS).toBeGreaterThan(2000)
		expect(Math.max(...delays)).toBeLessThan(LEDGER_SETTLE_MS)
		expect(s.w.foreign()).toBe(0)
		// A real relay client's frame at another centre: its blocks are labelled relay, by stamps.
		const client = net.connect(s.relay.getStatus().port, "127.0.0.1")
		client.on("error", () => undefined)
		cleanups.push(() => client.destroy())
		await until(() => s.relay.getStatus().clientsConnected > 0)
		await wait(100)
		const cmd = Buffer.alloc(5)
		cmd[0] = 0x01
		cmd.writeUInt32BE(F2, 1)
		client.write(cmd)
		await until(() =>
			s.receipts.some(
				r => r.field === "frequency" && r.writer === "relay" && r.value === F2,
			),
		)
		await until(
			() =>
				[...s.w.blocks.values()].filter(
					b => b.trust === "relay" && b.centreHz === F2 && b.checked > 0,
				).length >= 3,
		)
		expect(s.w.foreign()).toBe(0)
	}, 60_000)

	it("a flap mid-dwell: the arbiter's re-sent hop reaches the job and its dwell counts from that hop's own receipt (F3)", async () => {
		const s = await startSweep(true)
		await until(() => hopReceipts(s.receipts).length >= 2, 30_000)
		const before = hopReceipts(s.receipts).length
		s.fake.dropConnections()
		await until(() => s.fake.connections() === 2)
		await until(
			() => hopReceipts(s.receipts).filter(r => r.session === 2).length >= 3,
			30_000,
		)
		await s.scanner.cancelJob(s.job.id)
		expect(hopReceipts(s.receipts).length).toBeGreaterThan(before)
		// Every block counted in the new session was proven, at a hop centre, by its own stamps.
		expect(expectCountedProven(s.w)).toBeGreaterThan(0)
		expect(s.w.foreign()).toBe(0)
	}, 60_000)

	it("a rate-truth doubt mid-dwell (no new stream): the re-sent hop is the job's, and the sweep keeps advancing (F3)", async () => {
		const s = await startSweep(true)
		await until(() => hopReceipts(s.receipts).length >= 2, 30_000)
		const before = hopReceipts(s.receipts).length
		s.sourceManager.tuningLedger.raiseDoubt(
			"rtl",
			"sampleRate",
			"rate-truth-mismatch",
		)
		await until(() => hopReceipts(s.receipts).length >= before + 4, 30_000)
		await s.scanner.cancelJob(s.job.id)
		expect(expectCountedProven(s.w)).toBeGreaterThan(0)
		expect(s.w.foreign()).toBe(0)
	}, 60_000)
})
