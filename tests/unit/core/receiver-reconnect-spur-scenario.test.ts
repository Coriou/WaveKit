/**
 * Fake-link scenario: the same receiver reconnecting while the IQ carries fixed spur lines.
 *
 * Production composition as src/index.ts wires it (SourceManager, fanout routing, the tuner with
 * its wiring, ScannerService with its spectrum service and passive scanning, the receiver identity
 * tracker and the per-receiver learned state attached through `learnedState`), against an
 * in-process fake rtl_tcp on an ephemeral loopback port that feeds noise plus fixed tones (spur
 * lines: they never move with the tuning). The receiver's namespace holds a learned spur map that
 * covers those lines. The fake drops the connection and the core reconnects to the same receiver:
 * no scanner discovery may appear in the reconnect window (a fresh engine would lose the spur map
 * and report the lines as signals). No request leaves the process.
 */
import net from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import { ScannerPersistence } from "../../../src/core/scanner/store/persistence.js"
import type { EngineState } from "../../../src/core/spectrum/types.js"
import { ScannerConfigSchema, type SourceConfig } from "../../../src/config.js"
import type { ScannerSettings } from "../../../src/core/scanner/types.js"
import { ReceiverIdentityTracker } from "../../../src/core/receiver-identity-tracker.js"
import { ReceiverLearnedState } from "../../../src/core/receiver-identity-state.js"
import {
	receiverBoundToTuner,
	wireReceiverTracker,
} from "../../../src/core/receiver-identity-wiring.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../mocks/scanner/signals.js"

const FS = 1_024_000
const CENTRE = 446_100_000
/** Baseband offsets of the spur lines (fixed: they follow the receiver, not the RF). */
const SPUR_OFFSETS = [150_000, -230_000]
/**
 * What this composition learns from that IQ after about 32 s (measured): both lines promoted to
 * provisional spurs at bins 512 + offset / 1 kHz (1024-point FFT at 1.024 Msps, AGC), and the
 * absolute floor. Seeded so the test need not wait for the learning; without it the line at
 * -230 kHz is a discovery within about a second.
 */
const LEARNED: EngineState = {
	version: 1,
	absoluteFloors: [{ key: "1024000:agc:1024", dbfs: -56.35 }],
	spurs: [],
	kByRange: [],
	provisionalSpurs: SPUR_OFFSETS.map(offset => ({
		key: "1024000:agc:1024",
		basebandBin: 512 + offset / 1000,
		widthBins: 1,
		comb: false,
	})),
}
/** Header-only identity (no sdr-host): the source-scoped model key of tuner 5 with 29 gains. */
const RECEIVER_KEY = "source:rtl|model:5:29"

/** Noise plus fixed tones in 20 ms chunks; `drop()` ends every client connection. */
async function spurRtlTcp() {
	const rng = mulberry32(7)
	const chunkSamples = Math.round(FS * 0.02)
	const sockets = new Set<net.Socket>()
	let accepts = 0
	const server = net.createServer(socket => {
		accepts += 1
		sockets.add(socket)
		socket.on("error", () => undefined)
		socket.on("close", () => sockets.delete(socket))
		socket.on("data", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
	})
	const timer = setInterval(() => {
		const iq = gaussianNoise(rng, chunkSamples, 0.04)
		for (const offset of SPUR_OFFSETS)
			addInto(iq, tone(chunkSamples, FS, offset, 0.25))
		const bytes = Buffer.from(packCu8(iq.re, iq.im))
		for (const s of sockets) if (!s.destroyed) s.write(bytes)
	}, 20)
	timer.unref()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as net.AddressInfo).port,
		accepts: () => accepts,
		drop: () => {
			for (const s of sockets) s.destroy()
		},
		close: async () => {
			clearInterval(timer)
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 50))
	}
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe("scenario: reconnect to the same receiver with spur lines in the IQ", () => {
	it("keeps the spur map across the reconnect: no discovery in the reconnect window", async () => {
		const server = await spurRtlTcp()
		cleanup.push(() => server.close())
		const stateDir = await mkdtemp(join(tmpdir(), "wk-spur-scenario-"))
		cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
		const logger = createLogger({ level: "fatal" })
		// The receiver's namespace already holds its learned spur map.
		await new ScannerPersistence({
			dir: join(stateDir, "scanner"),
			logger,
			now: Date.now,
		}).writeEngineIn("rtl", RECEIVER_KEY, LEARNED)
		const source: SourceConfig = {
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: server.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: FS,
				centerFreq: CENTRE,
				exclusive: false,
			},
		}
		const sourceManager = new SourceManager(logger)
		sourceManager.on("error", () => undefined)
		const fanout = new FanoutManager(logger)
		const routing = new SourceFanoutRouter(sourceManager, fanout, logger, "rtl")
		const tracked = (id: string) => id === "rtl"
		const tracker = new ReceiverIdentityTracker({
			sources: sourceManager,
			logger,
			sdrHostApplies: () => false,
		})
		let tuner: TunerController | undefined
		const learned = new ReceiverLearnedState({
			stateDir,
			logger,
			tracked,
			onBound: receiverBoundToTuner(tracker, () => tuner),
		})
		await learned.load()
		wireReceiverTracker(tracker, learned)
		tuner = new TunerController(logger, sourceManager, {
			receiverIdentity: id =>
				tracked(id) ? tracker.provisional(id) : undefined,
			receiverTracked: tracked,
		})
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
			storage: { dir: join(stateDir, "scanner") },
		}) as ScannerSettings
		const scanner = new ScannerService({
			settings,
			learnedState: (store, gated, writable) =>
				learned.attach(store, gated, writable),
			sourceConfigs: [source],
			decoderConfigs: [],
			region: "EU",
			stateDir,
			sources: sourceManager,
			routing,
			tuner,
			decoders,
			digitalVoice: null,
			liveDemod: null,
			logger,
			engineHost: "inline",
		})
		learned.setSpectrum(scanner.spectrum)
		cleanup.push(async () => {
			await scanner.stop()
			await decoders.destroy()
			tracker.stop()
			await sourceManager.disconnectAll()
		})
		const settled: string[] = []
		tracker.on("settled", (_id: string, identity: { key: string }) =>
			settled.push(identity.key),
		)
		const discoveries = () => scanner.listDiscoveries({ limit: 50 }).items
		let swaps = 0
		const replace = scanner.spectrum.replaceLearnedState.bind(scanner.spectrum)
		scanner.spectrum.replaceLearnedState = async (id, next) => {
			swaps += 1
			await replace(id, next)
		}
		await scanner.start()
		await sourceManager.connect(source)
		await waitFor(() => settled.length === 1, 10_000)
		expect(settled).toEqual([RECEIVER_KEY])
		await learned.idle("rtl")
		// The seeded map is in use: the lines are no discovery.
		await new Promise(resolve => setTimeout(resolve, 3_000))
		expect(discoveries()).toEqual([])
		const swapsBefore = swaps

		// The link drops; the core reconnects to the same receiver.
		server.drop()
		await waitFor(() => server.accepts() === 2, 20_000)
		await waitFor(() => settled.length === 2, 10_000)
		expect(settled).toEqual([RECEIVER_KEY, RECEIVER_KEY])
		// The reconnect window and well past it: nothing new, and the engine was never swapped.
		await new Promise(resolve => setTimeout(resolve, 6_000))
		expect(discoveries()).toEqual([])
		expect(swaps).toBe(swapsBefore)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
	}, 60_000)
})
