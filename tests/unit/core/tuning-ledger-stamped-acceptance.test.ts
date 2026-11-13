/**
 * Tuning trust step 3 acceptance: the spectrum engine's labels against a stamped radio, through
 * production wiring (SourceManager, fanout routing, TunerController with wireTunerControl and its
 * assert, ScannerService with its spectrum service, TunerArbiter and JobRunner), on the inline and
 * the worker-thread pipeline hosts. The in-process fake rtl_tcp (ephemeral loopback port) stamps
 * every sample with the centre and rate it was tuned to when it produced it, so a block labelled
 * trusted can be checked sample by sample. Phases: the engine runs before the first payload
 * (boot order), a fresh core is proven by the assert, an operator retune, a scanner hop dwell,
 * a flap (reconnect), a relay frame, a pipeline error, an untracked retune caught by the
 * host-centre detector. Assertions are on stamps and positions; trust only ever comes from
 * receipts and the real byte flow, never from counting samples.
 */
import { build } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ScannerConfigSchema, type SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import {
	installSpectrumWorkerUrl,
	type EngineEpoch,
	type HostCentreReader,
	type SpectrumEngine,
} from "../../../src/core/spectrum/spectrum-engine.js"
import type { PipelineEvent } from "../../../src/core/spectrum/types.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { createLogger } from "../../../src/utils/logger.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"

const RATE = 1_024_000
const F0 = 446_100_000
const F1 = 446_500_000
const F2 = 447_300_000
/** The ledger settle: 50 ms at 1.024 Msps U8 (102 400 B) beside a 16 KiB in-flight estimate. */
const SETTLE_MS = 50
const IN_FLIGHT = 16 * 1024

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
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
	/** Stamps (centre index, rate index) of samples [a, b) of `stream` it holds. */
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

async function compose(host: "inline" | "thread") {
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		chunkBytes: 8192,
		intervalMs: 5,
	})
	cleanups.push(() => fake.close())
	const dir = mkdtempSync(join(tmpdir(), "wk-ledger-acceptance-"))
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
	wireTunerControl({
		log: logger,
		sourceManager,
		tunerController: tuner,
		tunerRelay: new TunerRelay(
			logger,
			sourceManager,
			new FanoutManager(logger),
			{
				enabled: false,
				host: "127.0.0.1",
				port: 1,
				controlPolicy: "shared",
			},
		),
		relayEnabled: false,
	})
	const decoders = new DecoderManager(new DecoderRegistry(), fanout, logger)
	decoders.setSourceManager(sourceManager, routing)
	const settings = ScannerConfigSchema.parse({
		storage: { dir: join(dir, "scanner") },
	}) as ScannerSettings
	settings.sweep.markers = false
	settings.sweep.settleMs.local = SETTLE_MS
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
		engineHost: host,
	})
	cleanups.push(async () => {
		await scanner.stop()
		await decoders.destroy()
		await sourceManager.disconnectAll()
	})
	return { fake, source, sourceManager, tuner, scanner }
}

/** Every block summary the engine labels, checked against the stamps of its samples. */
function watch(
	engine: SpectrumEngine,
	fake: Awaited<ReturnType<typeof startStampedRtlTcp>>,
) {
	const log = new StampLog()
	engine.tap((start, bytes) =>
		log.add(engine.accounting().stream, start, bytes),
	)
	const counts = {
		blocks: 0,
		trusted: 0,
		foreign: 0,
		trustedAt: new Map<number, number>(),
		lastTrustedAt: 0,
	}
	const claims: { centreHz: number; trust: string }[] = []
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
		if (ev.kind === "epoch-started")
			claims.push({ centreHz: epoch.centreHz, trust: epoch.tuningTrust })
		if (ev.kind !== "block-summary") return
		counts.blocks += 1
		if (epoch.tuningTrust === "unverified") return
		const s = ev.summary
		const cfg = engine.config()!
		const block = Math.round((cfg.integrationMs * cfg.sampleRateHz) / 1000)
		let checked = 0
		let foreign = false
		for (const [c, r] of log.stamps(
			s.stream,
			s.endSample - block,
			s.endSample,
		)) {
			checked += 1
			if (fake.centreOf(c) !== s.centreHz || fake.rateOf(r) !== s.sampleRateHz)
				foreign = true
		}
		counts.trusted += 1
		if (foreign) counts.foreign += 1
		if (checked > 0 && !foreign) {
			counts.trustedAt.set(
				s.centreHz,
				(counts.trustedAt.get(s.centreHz) ?? 0) + 1,
			)
			counts.lastTrustedAt = Date.now()
		}
	})
	return { counts, claims }
}

async function scenario(host: "inline" | "thread"): Promise<void> {
	const { fake, source, sourceManager, tuner, scanner } = await compose(host)
	await scanner.start()
	// Boot order: the engine opens before the source's first payload (as soon as its caps exist).
	const connected = sourceManager.connect(source)
	await until(() => sourceManager.getCaps("rtl") !== undefined)
	const engine = await scanner.spectrum.acquire("rtl", "ledger-acceptance")
	const openedBeforePayload =
		sourceManager.tuningLedger.position("rtl") === null
	const { counts, claims } = watch(engine, fake)
	await connected
	expect(openedBeforePayload).toBe(true)

	// Fresh core: nothing carried; the assert writes the held centre and rate, proven past the settle.
	await until(() => (counts.trustedAt.get(F0) ?? 0) >= 3)
	const fresh = sourceManager.tuningLedger.receipts("rtl")
	expect(fresh.map(r => [r.field, r.writer])).toEqual(
		expect.arrayContaining([
			["frequency", "assert"],
			["sampleRate", "assert"],
		]),
	)

	// Operator retune.
	await tuner.setFrequency("rtl", F1, { origin: "rest" })
	await until(() => (counts.trustedAt.get(F1) ?? 0) >= 3)

	// Flap: a reconnect starts a new session, unverified until the assert's receipts settle.
	const before = counts.trustedAt.get(F1) ?? 0
	fake.dropConnections()
	await until(() => fake.connections() === 2)
	await until(() => (counts.trustedAt.get(F1) ?? 0) >= before + 3)
	expect(sourceManager.tuningLedger.position("rtl")?.session).toBe(2)

	// A relay frame at another centre (no controller state change): its blocks are never trusted
	// at the engine's centre; the core's own retune proves it again.
	sourceManager.writeToSource("rtl", Buffer.from([0x01, ...u32(F2)]), {
		writer: "relay",
	})
	await wait(300)
	await tuner.setFrequency("rtl", F1, { origin: "rest" })
	const afterRelay = counts.trustedAt.get(F1) ?? 0
	await until(() => (counts.trustedAt.get(F1) ?? 0) >= afterRelay + 3)

	// A pipeline error doubts both fields; the assert re-proves within the settle (plus slack).
	const errorAt = Date.now()
	const marked = counts.trustedAt.get(F1) ?? 0
	const pipeline = (
		engine as unknown as { host: { handlers: { error(err: Error): void } } }
	).host
	engine.on("error", () => undefined)
	pipeline.handlers.error(new Error("injected pipeline error"))
	expect(
		sourceManager.tuningLedger
			.doubts("rtl")
			.some(d => d.reason === "pipeline-error"),
	).toBe(true)
	await until(() => (counts.trustedAt.get(F1) ?? 0) >= marked + 1, 5000)
	const reproofMs = Date.now() - errorAt

	// An untracked retune: the receiver moves to F2 without any frame (its host reports the move;
	// its samples carry the F2 stamp from now on). The host-centre detector doubts the
	// frequency from its last matching poll; the assert re-proves the held centre (F1), and the next
	// poll that matches again lets the engine's epochs follow caps.
	const poll = (
		engine as unknown as {
			checkHostCentre(reader: HostCentreReader): Promise<void>
		}
	).checkHostCentre.bind(engine)
	const hostCentre: HostCentreReader = {
		read: () => Promise.resolve(fake.reportedCentre()),
	}
	await poll(hostCentre)
	const beforeUntracked = sourceManager.tuningLedger
		.receipts("rtl")
		.filter(r => r.field === "frequency").length
	fake.retuneSilently(F2, 0)
	await poll(hostCentre)
	expect(
		sourceManager.tuningLedger
			.doubts("rtl")
			.some(d => d.reason === "host-centre-mismatch"),
	).toBe(true)
	// The assert answers the doubt with a frame of the held centre (writer assert).
	await until(
		() =>
			sourceManager.tuningLedger
				.receipts("rtl")
				.filter(r => r.field === "frequency").length > beforeUntracked,
	)
	const reassert = sourceManager.tuningLedger
		.receipts("rtl")
		.filter(r => r.field === "frequency")
		.at(-1)!
	expect([reassert.value, reassert.writer]).toEqual([F1, "assert"])
	await until(() => fake.reportedCentre() === F1)
	expect(fake.tuning().centre).toBe(F1)
	await poll(hostCentre)
	const afterUntracked = counts.trustedAt.get(F1) ?? 0
	await until(() => (counts.trustedAt.get(F1) ?? 0) >= afterUntracked + 3)

	// A scanner hop dwell: the arbiter's hop epoch claims its own receipt, its blocks are trusted
	// at the hop centre with the hop's stamps.
	const job = await scanner.createJob({
		sourceId: "rtl",
		mode: "sweep",
		ranges: [{ startHz: 450_000_000, endHz: 452_000_000 }],
		takeover: true,
		resume: { autoAfterIdleMs: null },
	})
	await until(
		() =>
			claims.some(c => c.trust === "commanded" && c.centreHz > 449_000_000) &&
			[...counts.trustedAt.keys()].some(hz => hz > 449_000_000),
		20_000,
	)
	const hopReceipts = sourceManager.tuningLedger
		.receipts("rtl")
		.filter(r => r.field === "frequency" && r.writer === "scanner")
	expect(hopReceipts.length).toBeGreaterThan(0)
	await scanner.cancelJob(job.id)

	expect(counts.foreign).toBe(0)
	expect(counts.trusted).toBeGreaterThan(10)
	await scanner.spectrum.release("rtl", "ledger-acceptance")
	expect(reproofMs).toBeLessThan(5000)
	process.stderr.write(
		`[${host}] engine opened before first payload ${openedBeforePayload}, blocks ${counts.blocks} trusted ${counts.trusted} foreign ${counts.foreign} pipeline-error re-proof ${reproofMs} ms\n`,
	)
}

function u32(value: number): number[] {
	const b = Buffer.alloc(4)
	b.writeUInt32BE(value, 0)
	return [...b]
}

describe("tuning-ledger labels against a stamped radio (production wiring)", () => {
	const dir = mkdtempSync(join(tmpdir(), "wk-ledger-worker-"))
	const worker = join(dir, "spectrum-worker.mjs")
	beforeAll(async () => {
		await build({
			entryPoints: ["src/core/spectrum/spectrum-worker.ts"],
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: worker,
			define: { __WAVEKIT_VERSION__: JSON.stringify("test") },
			// Bundled CommonJS dependencies need a require in an ES module worker.
			banner: {
				js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
			},
			logLevel: "silent",
		})
		installSpectrumWorkerUrl(pathToFileURL(worker))
	}, 60_000)
	afterAll(() => {
		installSpectrumWorkerUrl(undefined)
		rmSync(dir, { recursive: true, force: true })
	})

	it("inline host: 0 foreign-stamped blocks trusted across boot, assert, retune, hop, flap, relay frame, pipeline error and untracked retune", async () => {
		await scenario("inline")
	}, 90_000)

	it("worker-thread host: the same", async () => {
		await scenario("thread")
	}, 90_000)
})
