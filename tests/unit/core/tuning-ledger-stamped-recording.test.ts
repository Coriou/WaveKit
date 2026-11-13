/**
 * A recording is never back-dated across a tuning proof, through production wiring: a real
 * SourceManager, fanout routing, TunerController with wireTunerControl and its assert, the real
 * SpectrumEngine (inline host) and the real WidebandAnalogRecorder reading the engine's ring. The
 * in-process fake rtl_tcp (ephemeral loopback port) stamps each sample with the frequency frame
 * the receiver had executed when it produced it (a new stamp per frame, so the assert's frame of
 * the centre the receiver already sits on is told apart), and executes frames 200 ms after it
 * reads them (an upstream delay inside the ledger's 400 ms settle). A carrier on air at the same
 * offset across the assert's receipt is recorded: its file, labelled commanded, holds no sample
 * from before the receipt took effect.
 */
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	WidebandAnalogRecorder,
	type WidebandEngineView,
} from "../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { SpectrumEngine } from "../../../src/core/spectrum/spectrum-engine.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"
import {
	fakeOps,
	input,
	snapshot,
} from "./scanner/wideband-recorder-harness.js"

const RATE = 1_024_000
const F0 = 446_100_000
/** The ledger settle (400 ms at 1.024 Msps U8) beside a 16 KiB in-flight estimate. */
const SETTLE_MS = 400
const IN_FLIGHT = 16 * 1024
/** The receiver executes a frame this long after reading it (inside the settle). */
const COMMAND_DELAY_MS = 200
/** The engine's own DSP-epoch settle for a non-scanner write: shorter than the ledger's. */
const NETWORK_SETTLE_MS = 50

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

describe("recordings and the tuning proof (production wiring, stamped radio)", () => {
	it("a carrier on air across the assert's receipt: the first file never holds pre-receipt samples while labelled commanded", async () => {
		const fake = await startStampedRtlTcp({
			initialHz: F0,
			initialRate: RATE,
			chunkBytes: 8192,
			intervalMs: 5,
			commandDelayMs: COMMAND_DELAY_MS,
			restampFrequencyFrames: true,
		})
		cleanups.push(() => fake.close())
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
		cleanups.push(() => sourceManager.disconnectAll())
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
		const settings = testSettings(s => {
			s.sweep.markers = false
			s.sweep.settleMs.network = NETWORK_SETTLE_MS
		})
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources: sourceManager,
			routing,
			tuner,
			settings: () => settings,
			logger: pino({ level: "silent" }),
			host: "inline",
		})
		engine.on("error", () => undefined)
		cleanups.push(() => engine.stop())
		// Boot order: the engine opens before the first payload; the assert proves the centre the
		// receiver already sits on (its frame takes effect 200 ms after it is read).
		const connected = sourceManager.connect(source)
		await until(() => sourceManager.getCaps("rtl") !== undefined)
		await engine.start()
		// Block summaries label currentEpoch() (the scanner turns the feed on).
		engine.setSpectrumFeed(true)
		await connected
		await until(() => engine.currentEpoch().tuningTrust === "commanded")
		const receipts = sourceManager.tuningLedger
			.receipts("rtl")
			.filter(r => r.field === "frequency")
		expect(receipts.map(r => [r.value, r.writer])).toEqual([[F0, "assert"]])
		// The stamp of the bytes from before the assert's frame took effect (the first frame seen).
		const preReceipt = fake.centreStamp(F0)!

		// A carrier on air since the current epoch began, at the same offset across the receipt.
		const epoch = engine.currentEpoch()
		const reads: { from: number; stamps: Uint8Array }[] = []
		const view: WidebandEngineView = {
			format: engine.format,
			currentEpoch: () => engine.currentEpoch(),
			liveEdge: () => engine.liveEdge(),
			readRing: (from, to) => {
				const got = engine.readRing(from, to)
				if (got) reads.push({ from: got.startSample, stamps: got.bytes })
				return got
			},
			tap: listener => engine.tap(listener),
		}
		let rec!: WidebandAnalogRecorder
		const { begin } = fakeOps(b => rec.bindingLive(b))
		rec = new WidebandAnalogRecorder({
			engine: () => view,
			settings: () => ({
				preRollMs: 300,
				hangMs: 2000,
				cpuBudgetCores: 1,
				ringSeconds: settings.ringSeconds,
			}),
			beginAnalog: begin,
			logger: pino({ level: "silent" }),
			now: () => Date.now(),
			schedule: run => setImmediate(run),
		})
		cleanups.push(() => rec.stop())
		const track = snapshot("t1", epoch.startSample ?? 0, engine.liveEdge(), {
			stream: epoch.stream,
			epoch: epoch.epoch,
			centreHz: epoch.centreHz + 50_000,
			tuningTrust: "commanded",
		})
		rec.track(input("o1", track))
		await until(() => reads.length > 0, 5000)
		await wait(300)

		let checked = 0
		let pre = 0
		for (const r of reads)
			for (let i = 0; i < r.stamps.length; i += 2) {
				checked += 1
				if (r.stamps[i] === preReceipt) pre += 1
			}
		expect(epoch.tuningTrust).toBe("commanded")
		expect(checked).toBeGreaterThan(0)
		expect(pre).toBe(0)
		expect(Math.min(...reads.map(r => r.from))).toBeGreaterThanOrEqual(
			epoch.trustedFromSample ?? Number.POSITIVE_INFINITY,
		)
	}, 30_000)
})
