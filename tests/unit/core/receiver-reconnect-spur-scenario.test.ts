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
 * and report the lines as signals). A variant adds an in-process fake sdr-host (HTTP on an
 * ephemeral loopback port) reporting a fixed unit id, polled by the production SdrHostPoller:
 * each connection kicks a poll (pollNow) whose identity result settles the unit key. A third
 * variant is a Pi reboot: the sdr-host API answers 503 from the drop until 2 s after the reconnect
 * (rtlmux listens first); the failed polls are retried and the unit key still settles, with no
 * swap through the weak key. A fourth is a slow sdr-host API at boot (it answers 10 s after
 * rtlmux, past the 7 s bound): the model key settles at the bound, the late answer swaps to the
 * unit key once. No request leaves the process.
 *
 * Saved spur lines load verified only from a resumed namespace of a strong receiver key (a unit
 * key or a strong serial), and only lines saved verified (`verified: true`): a weak model key's
 * lines load unverified, since every dongle of that model on the source shares the key. Without an sdr-host the key is that weak model key, so a
 * parked receiver (one centre) cannot verify its lines: even quiet lines stay unmasked and are
 * tracked (the documented weak-key limit). That variant runs the quiet lines and asserts the
 * reconnect adds nothing (the same discovery ids before the drop and after the reconnect window).
 *
 * Line levels. The fake's noise is σ = 0.04 (total complex power σ²) at a 1024-point FFT, so the
 * per-bin noise power is σ² · 1.5 / 1024 ≈ 2.34e-6 (Hann, tone-calibrated as in the pipeline
 * tests) and a bin-centred tone of amplitude a puts r = a² / 2.34e-6 floors on its centre bin and
 * 1.5 · r over its main lobe; its 12.5 kHz slot level (13 bins) is 1 + 1.5 · r / 13. QUIET_AMP
 * 0.0045: r ≈ 8.6, slot ≈ 2.0 → +3.0 dB, inside the measured +3.5 dB of real receiver lines and
 * under the 6 dB lift gate, so a verified line masks. LOUD_AMP 0.25: r ≈ 26 700, slot ≈ +35 dB,
 * past the gate: a verified mask lifts there (a real carrier never hides behind a spur bin).
 */
import http from "node:http"
import net from "node:net"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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
import {
	ReceiverIdentityTracker,
	receiverSdrHostWaitMs,
} from "../../../src/core/receiver-identity-tracker.js"
import { SdrHostPoller } from "../../../src/core/sdr-host-poller.js"
import { SpectrumEngine } from "../../../src/core/spectrum/spectrum-engine.js"
import {
	RECEIVER_NAMESPACES_FILE_NAME,
	ReceiverLearnedState,
} from "../../../src/core/receiver-identity-state.js"
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
/** Tone amplitudes of the lines (module doc: slot level ≈ +3.0 dB and ≈ +35 dB). */
const QUIET_AMP = 0.0045
const LOUD_AMP = 0.25
/**
 * What this composition learns from that IQ after about 32 s (measured): both lines promoted to
 * provisional spurs at bins 512 + offset / 1 kHz (1024-point FFT at 1.024 Msps, AGC), verified
 * when saved, and the absolute floor. Seeded so the test need not wait for the learning; without it the line at
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
		verified: true,
	})),
}
/** Header-only identity (no sdr-host): the source-scoped model key of tuner 5 with 29 gains. */
const RECEIVER_KEY = "source:rtl|model:5:29"
/** The fake sdr-host's persisted unit id, and the key it gives the receiver. */
const UNIT_ID = "0123456789abcdef0123456789abcdef"
const UNIT_KEY = `unit:${UNIT_ID}`

/**
 * A fake sdr-host status API on an ephemeral loopback port: a fixed unit id, no /api/host; while
 * `down`, every request answers 503 (the Node API not up yet).
 */
async function fakeSdrHost() {
	let statusRequests = 0
	let failedRequests = 0
	let down = false
	const server = http.createServer((req, res) => {
		if (down) {
			if (req.url === "/api/status") failedRequests += 1
			res.writeHead(503)
			res.end()
			return
		}
		if (req.url === "/api/status") {
			statusRequests += 1
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					version: "1.0.0",
					receiverId: "f".repeat(32),
					unitId: UNIT_ID,
				}),
			)
			return
		}
		res.writeHead(404)
		res.end()
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return {
		apiUrl: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
		statusRequests: () => statusRequests,
		failedRequests: () => failedRequests,
		setDown: (value: boolean) => {
			down = value
		},
		close: async () => {
			server.closeAllConnections()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

/** Noise plus fixed tones of amplitude `amp` in 20 ms chunks; `drop()` ends every client connection. */
async function spurRtlTcp(amp: number) {
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
			addInto(iq, tone(chunkSamples, FS, offset, amp))
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

/**
 * The scenario; `withSdrHost`: the source has a configured sdr-host (the fake), so both settles
 * wait for this connection's kicked poll and land on the unit key. `sdrHostLate`: the sdr-host API
 * is down (503) from the drop until 2 s after the reconnect. `amp`: the lines' tone amplitude.
 * `loud` (unit key, LOUD_AMP): the run ends after the first settle, asserting the lines lift.
 */
async function runScenario(
	withSdrHost: boolean,
	sdrHostLate = false,
	bootLateMs = 0,
	amp = LOUD_AMP,
): Promise<void> {
	const server = await spurRtlTcp(amp)
	cleanup.push(() => server.close())
	const stateDir = await mkdtemp(join(tmpdir(), "wk-spur-scenario-"))
	cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
	const logger = createLogger({ level: "fatal" })
	const sdrHost = withSdrHost ? await fakeSdrHost() : null
	if (sdrHost) cleanup.push(() => sdrHost.close())
	const key = sdrHost ? UNIT_KEY : RECEIVER_KEY
	// The receiver's namespace already holds its learned spur map.
	await new ScannerPersistence({
		dir: join(stateDir, "scanner"),
		logger,
		now: Date.now,
	}).writeEngineIn("rtl", key, LEARNED)
	// A slow-boot run restarts a core that knew the unit receiver (its key is on record).
	if (bootLateMs > 0)
		await writeFile(
			join(stateDir, RECEIVER_NAMESPACES_FILE_NAME),
			JSON.stringify({
				version: 1,
				sources: [{ sourceId: "rtl", adoptedBy: UNIT_KEY, keys: [UNIT_KEY] }],
			}),
		)
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
		...(sdrHost ? { sdrHost: { apiUrl: sdrHost.apiUrl } } : {}),
	} as SourceConfig
	const sourceManager = new SourceManager(logger)
	sourceManager.on("error", () => undefined)
	const fanout = new FanoutManager(logger)
	const routing = new SourceFanoutRouter(sourceManager, fanout, logger, "rtl")
	const tracked = (id: string) => id === "rtl"
	// As src/index.ts: the poller with the source's configured apiUrl, its identity results
	// into the tracker, a kicked poll at every connection.
	const poller = sdrHost
		? new SdrHostPoller(logger, [{ sourceId: "rtl", apiUrl: sdrHost.apiUrl }], {
				pollIntervalMs: 60_000,
				timeoutMs: 2_000,
			})
		: undefined
	poller?.on("error", () => undefined)
	const tracker = new ReceiverIdentityTracker({
		sources: sourceManager,
		logger,
		sdrHostApplies: id =>
			poller?.getStatus(id) !== undefined &&
			(sourceManager.getSelectedCandidate(id)?.index ?? 0) === 0,
		sdrHostWaitMs: receiverSdrHostWaitMs(2_000),
		kickSdrHostPoll: (id, retry) => poller?.pollNow(id, retry),
		sdrHostExpected: (id): boolean =>
			poller?.getStatus(id) !== undefined &&
			(source.sdrHost?.apiUrl !== undefined ||
				poller.hasAnswered(id) ||
				learned.lastKey(id)?.startsWith("unit:") === true),
	})
	poller?.on("identity-result", (id, result) =>
		tracker.noteSdrHostResult(id, result),
	)
	let tuner: TunerController | undefined
	const learned = new ReceiverLearnedState({
		stateDir,
		logger,
		tracked,
		onBound: receiverBoundToTuner(tracker, () => tuner),
		sdrHostConfigured: id => poller?.getStatus(id) !== undefined,
	})
	await learned.load()
	wireReceiverTracker(tracker, learned)
	tuner = new TunerController(logger, sourceManager, {
		receiverIdentity: id => (tracked(id) ? tracker.provisional(id) : undefined),
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
		poller?.stop()
		await scanner.stop()
		await decoders.destroy()
		tracker.stop()
		await sourceManager.disconnectAll()
	})
	// Every spectrum pipeline built (a new host is a pipeline restart).
	const builds = vi.spyOn(
		SpectrumEngine.prototype as unknown as {
			createHost: (rate: number) => unknown
		},
		"createHost",
	)
	cleanup.push(() => builds.mockRestore())
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
	/**
	 * Each line as the engine sees it now: masked (a spur mask covers its RF) and tracked (a
	 * tracked segment of the last second, after line filtering, reaches within a bin of it).
	 */
	const lineStates = async () => {
		const masks = await scanner.spectrum.engine("rtl")?.artefactMasks()
		if (!masks) throw new Error("no artefact masks")
		return SPUR_OFFSETS.map(offset => {
			const hz = CENTRE + offset
			return {
				offset,
				masked: masks.spurs.some(m => m.startHz <= hz && hz <= m.endHz),
				tracked: masks.activity.some(
					r => r.startHz <= hz + 1000 && hz - 1000 <= r.endHz,
				),
			}
		})
	}
	/** lineStates sampled `times` times 500 ms apart: every sample must show `want`. */
	const expectLines = async (
		want: { masked: boolean; tracked: boolean },
		times = 4,
	) => {
		for (let n = 0; n < times; n++) {
			if (n > 0) await new Promise(resolve => setTimeout(resolve, 500))
			expect(await lineStates()).toEqual(
				SPUR_OFFSETS.map(offset => ({ offset, ...want })),
			)
		}
	}
	await scanner.start()
	if (bootLateMs > 0) sdrHost?.setDown(true)
	poller?.start()
	await sourceManager.connect(source)
	if (bootLateMs > 0 && sdrHost) {
		// The API answers bootLateMs after rtlmux took the connection, past the hard bound: the
		// identity settles on the source-scoped model at the bound, then the late answer upgrades
		// it to the unit key (one swap). The engine runs before the first settle with nothing
		// loaded, so the lines may be discoveries in that window (not asserted here).
		await waitFor(() => server.accepts() === 1, 5_000)
		await new Promise(resolve => setTimeout(resolve, bootLateMs))
		expect(settled).toEqual([RECEIVER_KEY])
		expect(sdrHost.failedRequests()).toBeGreaterThan(1)
		const swapsAtModel = swaps
		const buildsAtModel = builds.mock.calls.length
		sdrHost.setDown(false)
		await waitFor(() => settled.length === 2, 5_000)
		expect(settled).toEqual([RECEIVER_KEY, UNIT_KEY])
		await learned.idle("rtl")
		const seen = new Set(discoveries().map(d => d.id))
		// Past the upgrade: exactly one swap (model -> unit; a swap restarts the pipeline once) and
		// the unit key resumed, with no new discovery id after it. The swap is a take-over, so the
		// unit's lines load unverified (never trusted); masks are not asserted here.
		await new Promise(resolve => setTimeout(resolve, 4_000))
		expect(swaps).toBe(swapsAtModel + 1)
		expect(discoveries().filter(d => !seen.has(d.id))).toEqual([])
		expect(builds.mock.calls.length).toBe(buildsAtModel + 1)
		expect(learned.view("rtl")?.key).toBe(UNIT_KEY)
		expect(learned.view("rtl")?.namespaceState).toBe("resumed")
		return
	}
	await waitFor(() => settled.length === 1, 10_000)
	expect(settled).toEqual([key])
	await learned.idle("rtl")
	// The seeded map is in use: under a unit key the lines are no discovery. Under the weak model
	// key they load unverified (weak-key limit, module doc): even quiet, they are tracked.
	await new Promise(resolve => setTimeout(resolve, 3_000))
	const weak = sdrHost === null
	if (weak) await expectLines({ masked: false, tracked: true })
	else if (amp === LOUD_AMP) {
		// Trusted lines, but loud past the 6 dB gate: each mask lifts and the tone is tracked.
		await expectLines({ masked: false, tracked: true })
		return
	} else {
		// Trusted quiet lines mask at once from one centre: no track, no discovery.
		await expectLines({ masked: true, tracked: false })
		expect(discoveries()).toEqual([])
	}
	const discoveryIdsBefore = discoveries().map(d => d.id)
	const swapsBefore = swaps
	const buildsBefore = builds.mock.calls.length
	const statusBefore = sdrHost?.statusRequests() ?? 0
	expect(buildsBefore).toBeGreaterThan(0)

	// The link drops; the core reconnects to the same receiver.
	if (sdrHostLate) sdrHost?.setDown(true)
	server.drop()
	await waitFor(() => server.accepts() === 2, 20_000)
	if (sdrHostLate && sdrHost) {
		// The API comes up 2 s after rtlmux took the connection; until then nothing settles.
		await new Promise(resolve => setTimeout(resolve, 2_000))
		expect(settled).toEqual([key])
		expect(sdrHost.failedRequests()).toBeGreaterThan(1)
		sdrHost.setDown(false)
	}
	await waitFor(() => settled.length === 2, 10_000)
	expect(settled).toEqual([key, key])
	// The reconnect asked the sdr-host again (its kicked poll settled the unit key).
	if (sdrHost) expect(sdrHost.statusRequests()).toBeGreaterThan(statusBefore)
	// The reconnect window and well past it: nothing new, and the engine was never swapped.
	await new Promise(resolve => setTimeout(resolve, 6_000))
	// The same discoveries as before the drop (none, or under the weak key the same one): the
	// reconnect adds no discovery id.
	expect(discoveries().map(d => d.id)).toEqual(discoveryIdsBefore)
	expect(swaps).toBe(swapsBefore)
	expect(builds.mock.calls.length).toBe(buildsBefore)
	// Still masked, still no track: the reconnect kept the trusted lines in the same pipeline.
	// Under the weak key still unmasked and tracked: the reconnect trusted nothing.
	await expectLines(
		weak ? { masked: false, tracked: true } : { masked: true, tracked: false },
	)
	expect(learned.view("rtl")?.namespaceState).toBe("resumed")
	expect(learned.view("rtl")?.key).toBe(key)
	if (sdrHost) {
		// Nothing was ever learned under the source-scoped key.
		const namespaces = await readdir(
			join(stateDir, "scanner", "engine", "receivers", "rtl"),
		).catch(() => [])
		expect(namespaces.some(n => n.includes("model"))).toBe(false)
	}
}

describe("scenario: reconnect to the same receiver with spur lines in the IQ", () => {
	it("under a weak model key the quiet lines are tracked, not masked, and the reconnect adds no discovery: no swap, no pipeline rebuild", async () => {
		await runScenario(false, false, 0, QUIET_AMP)
	}, 60_000)

	it("with a fake sdr-host the quiet lines stay masked and untracked across the reconnect: the unit key settles twice, no swap, no pipeline rebuild, no discovery", async () => {
		await runScenario(true, false, 0, QUIET_AMP)
	}, 60_000)

	it("with a fake sdr-host a loud tone on a saved verified line lifts the mask and is tracked", async () => {
		await runScenario(true)
	}, 60_000)

	it("a slow sdr-host API at boot (answers 10 s after rtlmux, past the 7 s bound): model key at the bound, then one swap to the unit key, no discovery after it", async () => {
		await runScenario(true, false, 10_000)
	}, 60_000)

	it("a Pi reboot (the sdr-host API answers 503 until 2 s after the reconnect): the quiet lines stay masked and untracked, the unit key settles, no swap, no pipeline rebuild, no discovery", async () => {
		await runScenario(true, true, 0, QUIET_AMP)
	}, 60_000)
})
