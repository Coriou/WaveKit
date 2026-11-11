/**
 * The spectrum epoch after a tune. POST /tune with a rate change (its pipeline restart and its
 * reconnect), a source dropout and its replay, and a tune whose values are already in place must
 * each leave the scanner's current epoch `commanded` once the centre and rate are proven, as the
 * individual routes do; a really unknown centre keeps it `unverified`.
 *
 * Real ScannerService (SpectrumEngine, inline pipeline), TunerController and SourceManager over an
 * in-process fake rtl_tcp on an ephemeral loopback port that streams IQ; the source's bytes reach
 * the engine through a fake fanout, in the order the source manager delivers them. A pipeline
 * worker busy with its backlog finishes a restart late: `slowRestart` holds the inline host's close
 * open until the reconnect has replayed, so the tune's writes and the replay land inside it.
 */
import { once } from "node:events"
import * as net from "node:net"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { InlinePipelineHost } from "../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineEpoch,
	SpectrumEngine,
} from "../../../src/core/spectrum/spectrum-engine.js"
import type { SpectrumService } from "../../../src/core/spectrum/spectrum-service.js"
import type { PipelineEvent } from "../../../src/core/spectrum/types.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"
import { FakeFanout, testSettings } from "../../mocks/scanner/engine-fakes.js"
import {
	ServiceFakeDecoders,
	settled,
} from "../../mocks/scanner/service-fakes.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../mocks/scanner/signals.js"
import { makeTmpDir } from "../../helpers/tmp-dir.js"

const START_HZ = 446_100_000
const TUNE_HZ = 446_200_000
const START_RATE = 2_400_000
const TUNE_RATE = 1_024_000
/** 0.1 s at the tune rate; a 50 kHz offset makes a whole number of cycles, so blocks join cleanly. */
const BLOCK_SAMPLES = 102_400
const CHUNK_BYTES = 20_480

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close()
	vi.restoreAllMocks()
})

const quiet = createLogger({ level: "fatal" })

/** A reconnect waits out a real backoff (equal jitter at its floor): a bound, never a sleep. */
const WAIT = { timeout: 10_000, interval: 10 }

function block(withTone: boolean): Buffer {
	const rng = mulberry32(withTone ? 7 : 3)
	const noise = gaussianNoise(rng, BLOCK_SAMPLES, 0.02)
	const iq = withTone
		? addInto(noise, tone(BLOCK_SAMPLES, TUNE_RATE, 50_000, 0.4))
		: noise
	return Buffer.from(packCu8(iq.re, iq.im))
}

async function setup(options: { declareCentre?: boolean } = {}) {
	// Equal-jitter backoff at its floor: a reconnect comes after half the base delay.
	vi.spyOn(Math, "random").mockReturnValue(0)
	const quietBlock = block(false)
	const toneBlock = block(true)
	let toneOn = false
	const sockets: net.Socket[] = []
	let connections = 0
	const server = net.createServer(socket => {
		connections++
		sockets.push(socket)
		socket.on("error", () => {})
		socket.on("data", () => {})
		socket.write(Buffer.concat([Buffer.from("RTL0"), Buffer.alloc(8)]))
		let at = 0
		const timer = setInterval(() => {
			if (socket.destroyed) return
			const src = toneOn ? toneBlock : quietBlock
			socket.write(src.subarray(at, at + CHUNK_BYTES))
			at = (at + CHUNK_BYTES) % src.length
		}, 10)
		socket.on("close", () => clearInterval(timer))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => {
			server.close(() => resolve())
		})
	})
	const port = (server.address() as net.AddressInfo).port
	const caps = {
		kind: "iq" as const,
		sampleRate: START_RATE,
		...(options.declareCentre === false ? {} : { centerFreq: START_HZ }),
		format: "U8_IQ" as const,
		exclusive: false,
	}
	const manager = new SourceManager(quiet)
	cleanup.push(() => manager.disconnectAll())
	manager.on("error", () => {})
	const controller = new TunerController(quiet, manager, {})
	controller.on("error", () => {})
	wireTunerControl({
		log: quiet,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	const dir = makeTmpDir("wk-tune-trust-")
	const fanout = new FakeFanout()
	manager.on("data", (_id: string, chunk: Buffer) => fanout.write(chunk))
	const source = {
		id: "rtl",
		type: "rtl_tcp" as const,
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		caps,
	}
	const service = new ScannerService({
		settings: testSettings(s => {
			s.sweep.markers = false
			s.sweep.settleMs.local = 50
			s.sweep.settleMs.network = 50
			s.passive.enabled = false
		}, dir),
		sourceConfigs: [source],
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: manager as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: controller as never,
		decoders: new ServiceFakeDecoders() as never,
		digitalVoice: null,
		liveDemod: null,
		logger: pino({ level: "silent" }),
		engineHost: "inline",
		tickMs: 20,
	})
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
		principalKind: () => "machine",
		scannerLeaseHolder: sourceId => service.tunerLeaseJob(sourceId),
	})
	await app.ready()
	cleanup.push(() => app.close())
	await service.start()
	cleanup.push(() => service.stop())
	const payload = once(manager, "payload-started")
	await manager.connect({ ...source, stallTimeoutMs: 0 })
	await payload
	const spectrum = (service as unknown as { spectrum: SpectrumService })
		.spectrum
	const engine: SpectrumEngine = await spectrum.acquire("rtl", "trust-test")
	cleanup.push(() => spectrum.release("rtl", "trust-test"))
	const tracks: Extract<PipelineEvent, { kind: "track-open" }>[] = []
	/** Each epoch as it started, with the label it started on. */
	const started: EngineEpoch[] = []
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
		if (ev.kind === "track-open") tracks.push(ev)
		if (ev.kind === "epoch-started") started.push({ ...epoch })
	})
	await settled(service)
	const post = (url: string, body: object) =>
		app.inject({ method: "POST", url: `/api/tuner/rtl/${url}`, payload: body })
	/** Waits until the engine's epoch reads `trust`: a bounded wait, the trust is the check. */
	const trustBecomes = async (trust: string) => {
		await vi.waitFor(async () => {
			await settled(service)
			expect(engine.currentEpoch().tuningTrust).toBe(trust)
		}, WAIT)
	}
	/**
	 * A transmission in the current epoch passes the wideband recorder's tuning admission: the
	 * engine's epoch is this track's stream and epoch, and both its label and the track's are
	 * commanded (WidebandAnalogRecorder: refused:tuning otherwise).
	 */
	const transmissionAdmitted = async () => {
		const from = tracks.length
		toneOn = true
		try {
			await vi.waitFor(async () => {
				await settled(service)
				const epoch = engine.currentEpoch()
				const track = tracks
					.slice(from)
					.map(ev => ev.track)
					.find(t => t.stream === epoch.stream && t.epoch === epoch.epoch)
				expect(track?.tuningTrust).toBe("commanded")
				expect(epoch.tuningTrust).toBe("commanded")
			}, WAIT)
		} finally {
			toneOn = false
		}
	}
	/**
	 * The next pipeline restart closes its old host only after the reconnect replayed its frequency
	 * (a worker still busy with its backlog): everything up to the replay lands inside the restart.
	 */
	const slowRestart = () => {
		const replayed = new Promise<void>(resolve => {
			const onCommand = (
				_id: string,
				command: string,
				_value: number,
				origin?: string,
			) => {
				if (command !== "set-sample-rate" || origin !== "replay") return
				controller.off("command-sent", onCommand)
				resolve()
			}
			controller.on("command-sent", onCommand)
		})
		const close = InlinePipelineHost.prototype.close
		vi.spyOn(InlinePipelineHost.prototype, "close").mockImplementationOnce(
			async function (this: InlinePipelineHost) {
				await replayed
				await new Promise<void>(resolve => {
					setImmediate(resolve)
				})
				return close.call(this)
			},
		)
	}
	/**
	 * Holds the next pipeline restart's old-host close until `release()`: the commands sent
	 * meanwhile land inside the restart.
	 */
	const holdRestart = () => {
		let release = () => {}
		const held = new Promise<void>(resolve => {
			release = resolve
		})
		const close = InlinePipelineHost.prototype.close
		vi.spyOn(InlinePipelineHost.prototype, "close").mockImplementationOnce(
			async function (this: InlinePipelineHost) {
				await held
				return close.call(this)
			},
		)
		return () => release()
	}
	/** The engine's fanout branch: pausing it keeps accepted bytes buffered ahead of the engine. */
	const branch = () => {
		const found = fanout.branches.get("scanner-rtl")
		if (!found) throw new Error("no scanner branch")
		return found.stream
	}
	return {
		controller,
		service,
		engine,
		manager,
		holdRestart,
		branch,
		started,
		post,
		trustBecomes,
		transmissionAdmitted,
		slowRestart,
		connections: () => connections,
		/** The next session's first payload (`once` would reject on the source's error event). */
		nextPayload: () =>
			new Promise<void>(resolve => {
				manager.once("payload-started", () => resolve())
			}),
		dropConnection: () => {
			for (const socket of sockets) socket.destroy()
		},
	}
}

const RATE_CHANGE_TUNE = {
	frequencyHz: TUNE_HZ,
	sampleRateHz: TUNE_RATE,
	gainMode: "manual",
	gain: 300,
}

describe("the spectrum epoch after a tune", { timeout: 30_000 }, () => {
	it("a rate change whose pipeline restart outlasts the reconnect leaves a commanded epoch", async () => {
		// The centre unknown before the tune: the rate's own epoch is unverified when it is written.
		const h = await setup({ declareCentre: false })
		await h.trustBecomes("unverified")
		h.slowRestart()
		const res = await h.post("tune", RATE_CHANGE_TUNE)
		expect(res.statusCode).toBe(200)
		expect(res.json().usable).toBe(true)
		expect(h.connections()).toBe(2)
		const state = h.controller.getState("rtl")!
		expect(state.unknownFields ?? []).not.toContain("frequency")
		expect(state.unknownFields ?? []).not.toContain("sampleRate")
		expect(state.declaredOnlyFields ?? []).toEqual([])
		await h.trustBecomes("commanded")
		expect(h.engine.currentEpoch()).toMatchObject({
			centreHz: TUNE_HZ,
			sampleRateHz: TUNE_RATE,
		})
		await h.transmissionAdmitted()
	})

	it("a rate change with a prompt pipeline restart leaves a commanded epoch", async () => {
		const h = await setup()
		expect((await h.post("frequency", { hz: START_HZ })).statusCode).toBe(200)
		await h.trustBecomes("commanded")
		const res = await h.post("tune", RATE_CHANGE_TUNE)
		expect(res.statusCode).toBe(200)
		expect(res.json().usable).toBe(true)
		await h.trustBecomes("commanded")
		expect(h.engine.currentEpoch()).toMatchObject({
			centreHz: TUNE_HZ,
			sampleRateHz: TUNE_RATE,
		})
		await h.transmissionAdmitted()
	})

	it("a dropout and its replay leave a commanded epoch on the new connection", async () => {
		const h = await setup()
		expect((await h.post("tune", RATE_CHANGE_TUNE)).statusCode).toBe(200)
		await h.trustBecomes("commanded")
		const before = h.engine.currentEpoch()
		const reconnected = h.nextPayload()
		h.dropConnection()
		await reconnected
		expect(h.connections()).toBe(3)
		await h.trustBecomes("commanded")
		expect(h.engine.currentEpoch().stream).toBeGreaterThan(before.stream)
		await h.transmissionAdmitted()
	})

	it("a dropout whose replay lands inside a pipeline restart leaves a commanded epoch", async () => {
		const h = await setup()
		expect((await h.post("tune", RATE_CHANGE_TUNE)).statusCode).toBe(200)
		await h.trustBecomes("commanded")
		const before = h.engine.currentEpoch()
		h.slowRestart()
		// A restart (a tuning change) still closing its old host when the source drops and returns.
		const restart = h.engine.reconfigure()
		const reconnected = h.nextPayload()
		h.dropConnection()
		await reconnected
		await restart
		await h.trustBecomes("commanded")
		// The restarted stream is the new connection's: it starts unverified (nothing from the old
		// connection proves it), and the replay's epoch makes it commanded.
		const opened = h.started.find(
			e => e.stream > before.stream && e.settleMode === "none",
		)
		expect(opened?.tuningTrust).toBe("unverified")
		await h.transmissionAdmitted()
	})

	it("a tune whose values are already in place keeps a commanded epoch", async () => {
		const h = await setup()
		expect((await h.post("tune", RATE_CHANGE_TUNE)).statusCode).toBe(200)
		await h.trustBecomes("commanded")
		const before = h.engine.currentEpoch()
		const res = await h.post("tune", RATE_CHANGE_TUNE)
		expect(res.statusCode).toBe(200)
		expect(h.connections()).toBe(2)
		await h.trustBecomes("commanded")
		expect(h.engine.currentEpoch().stream).toBe(before.stream)
		await h.transmissionAdmitted()
	})

	it("a declared centre and rate a tune writes in place stay commanded", async () => {
		const h = await setup()
		// The connect's assert wrote the declared centre and rate: commanded before any tune.
		await h.trustBecomes("commanded")
		const res = await h.post("tune", {
			frequencyHz: START_HZ,
			sampleRateHz: START_RATE,
		})
		expect(res.statusCode).toBe(200)
		expect(h.connections()).toBe(1)
		await h.trustBecomes("commanded")
	})

	it("while the centre is really unknown the epoch stays unverified, restart and replay included", async () => {
		const h = await setup({ declareCentre: false })
		await h.trustBecomes("unverified")
		h.slowRestart()
		const res = await h.post("tune", { sampleRateHz: TUNE_RATE })
		expect(res.statusCode).toBe(200)
		expect(h.connections()).toBe(2)
		expect(h.controller.getState("rtl")?.unknownFields).toContain("frequency")
		// The replay's own epoch starts (a timer-settled epoch at the new rate) and reads unverified.
		await vi.waitFor(async () => {
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
			expect(h.engine.currentEpoch()).toMatchObject({
				sampleRateHz: TUNE_RATE,
				settleMode: "timer",
			})
		}, WAIT)
		expect(h.engine.currentEpoch().tuningTrust).toBe("unverified")
	})

	it("a proven command after an unproven one during a restart leaves a commanded epoch", async () => {
		// Declared centre and rate, asserted on connect; the rate and the centre written in place
		// again during a restart keep the label commanded.
		const h = await setup()
		await h.trustBecomes("commanded")
		const release = h.holdRestart()
		const restart = h.engine.reconfigure()
		expect((await h.post("sample-rate", { hz: START_RATE })).statusCode).toBe(
			200,
		)
		expect((await h.post("frequency", { hz: START_HZ })).statusCode).toBe(200)
		expect(h.controller.getState("rtl")?.declaredOnlyFields ?? []).toEqual([])
		release()
		await restart
		await h.trustBecomes("commanded")
		// The recorder's tuning admission reads this label (the harness tone needs the tune rate).
		await settled(h.service)
		expect(h.engine.currentEpoch().tuningTrust).toBe("commanded")
	})

	it("two commands during one restart post in order with the newest label", async () => {
		const h = await setup()
		// Commanded from the connect's assert of the declared centre and rate.
		await h.trustBecomes("commanded")
		const before = h.engine.currentEpoch()
		const release = h.holdRestart()
		const restart = h.engine.reconfigure()
		expect((await h.post("sample-rate", { hz: START_RATE })).statusCode).toBe(
			200,
		)
		expect((await h.post("frequency", { hz: TUNE_HZ })).statusCode).toBe(200)
		release()
		await restart
		await h.trustBecomes("commanded")
		expect(h.engine.currentEpoch()).toMatchObject({ centreHz: TUNE_HZ })
		// Nothing after the restart reverts to the earlier command's label or centre.
		const after = h.started.filter(e => e.stream > before.stream)
		const last = after[after.length - 1]
		expect(last).toMatchObject({ centreHz: TUNE_HZ, tuningTrust: "commanded" })
		// The recorder's tuning admission reads this label (the harness tone needs the tune rate).
		await settled(h.service)
		expect(h.engine.currentEpoch().tuningTrust).toBe("commanded")
	})

	it("a replay right after a disconnect proves the new stream, never the old one", async () => {
		const h = await setup()
		expect((await h.post("tune", RATE_CHANGE_TUNE)).statusCode).toBe(200)
		await h.trustBecomes("commanded")
		const before = h.engine.currentEpoch()
		const stream = h.branch()
		stream.pause()
		try {
			// Accepted bytes wait in the branch, so the disconnect's boundary is still ahead.
			await vi.waitFor(() => {
				expect(stream.readableLength).toBeGreaterThan(0)
			}, WAIT)
			// One tick: an old-connection command, the disconnect, the new connection's replay.
			h.controller.emit("command-sent", "rtl", "set-frequency", TUNE_HZ, "rest")
			h.manager.emit("disconnected", "rtl")
			h.controller.emit(
				"command-sent",
				"rtl",
				"set-frequency",
				TUNE_HZ,
				"replay",
			)
		} finally {
			stream.resume()
		}
		await vi.waitFor(async () => {
			await settled(h.service)
			const epoch = h.engine.currentEpoch()
			expect(epoch.stream).toBeGreaterThan(before.stream)
			expect(epoch.tuningTrust).toBe("commanded")
		}, WAIT)
		await h.transmissionAdmitted()
	})
})
