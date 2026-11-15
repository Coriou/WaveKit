/**
 * Listen (2026-11-15) in the LiveDemodulator: the open squelch keeps stage 1 detecting at the
 * auto threshold (same squelch edges and transmission events as auto on the same scene) while
 * every block reaches the demodulator raw and every PCM byte reaches clients; `voiceOnly: false`
 * turns the evidence gate off under auto; `listenMode` is stored without a restart.
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach,
	vi,
	type MockInstance,
} from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import type { AnalogTransmissionEventData } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type {
	LiveDemodulator as LiveDemodulatorType,
	LiveDemodulatorOptions,
} from "../../../src/core/live-demodulator.js"
import { wireAnalogTransmissions } from "../../../src/core/analog-transmission.js"
import {
	AUTO_ROUTE_STREAM,
	type AutoRouteClock,
} from "../../../src/core/auto-listen/contract.js"
import type { AutoListenRouter } from "../../../src/core/auto-listen/router.js"
import { FmChannelSynth, carrierWindows } from "./fm-synth.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const testLogger = createLogger({ level: "fatal" })
const RATE = 25_000
const BLOCK_SAMPLES = 250
const BLOCK_MS = 10
let nextPid = 6_000_000

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null

	receive(signal: NodeJS.Signals): void {
		setTimeout(() => this.exit(null, signal), 0)
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
	}
}

let processes: MockChildProcess[] = []
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

async function findAvailablePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "127.0.0.1", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

class ClientTransport extends Writable {
	readonly chunks: Buffer[] = []
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

type Internals = {
	handleAudioData(chunk: Buffer): void
	registerClient(response: http.ServerResponse, remoteAddress: string): unknown
	autoRoute: AutoListenRouter
	run: { stream: { rate: number } } | null
}

/** An injected `/auto` pacer clock: `tick` advances time and runs the pacer once. */
class RouteClock implements AutoRouteClock {
	t = 0
	private fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

/** A constant carrier block (power `dbfs`), complex float32. */
function carrierBlock(dbfs: number): Buffer {
	const block = Buffer.alloc(BLOCK_SAMPLES * 8)
	for (let n = 0; n < BLOCK_SAMPLES; n++)
		block.writeFloatLE(10 ** (dbfs / 20), n * 8)
	return block
}

/** A block of channel noise at about `dbfs` (deterministic, seeded uniform I and Q). */
function noiseBlock(dbfs: number, seed: number): Buffer {
	const block = Buffer.alloc(BLOCK_SAMPLES * 8)
	// Uniform in [-a, a] has power a²/3 per component: a = sqrt(3 · P / 2) per component.
	const a = Math.sqrt((3 * 10 ** (dbfs / 10)) / 2)
	let state = seed * 2_654_435_761 + 1
	const next = () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
		return (state / 2_147_483_648) * 2 - 1
	}
	for (let n = 0; n < BLOCK_SAMPLES * 2; n++)
		block.writeFloatLE(a * next(), n * 4)
	return block
}

/** `count` noise blocks with distinct seeds. */
async function feedNoise(
	feedBlock: (block: Buffer) => Promise<void>,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i++) await feedBlock(noiseBlock(-70, i + 1))
}

/** 10 ms of nonzero s16le PCM (a 1 kHz tone). */
function pcmBlock(seed: number): Buffer {
	const pcm = Buffer.alloc((RATE / 100) * 2)
	for (let n = 0; n < RATE / 100; n++)
		pcm.writeInt16LE(
			Math.round(8000 * Math.sin((2 * Math.PI * 1000 * (n + seed)) / RATE)),
			n * 2,
		)
	return pcm
}

/**
 * The scene: noise 1.5 s, carrier 2 s, noise 2 s, carrier 1.2 s, noise 2.3 s (900 blocks), at
 * 20 dB CNR; two transmissions in auto.
 */
const SCENE_BLOCKS = 900
const SCENE_WINDOWS: ReadonlyArray<readonly [number, number]> = [
	[1500, 3500],
	[5500, 6700],
]

interface SceneTrace {
	edges: Array<[number, boolean]>
	events: Array<
		Pick<
			AnalogTransmissionEventData,
			"state" | "startedAt" | "endedAt" | "durationMs" | "closeReason"
		>
	>
	modes: string[]
	frontIq: Buffer
	backIq: Buffer
}

describe("LiveDemodulator Listen: open, voiceOnly, listenMode", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let liveDemod: LiveDemodulatorType
	let port: number
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	const fanoutManager = {
		addBranch: vi.fn(() => new PassThrough()),
		removeBranch: vi.fn(),
	}
	const sourceManager = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "rtl-pi", connected: true }],
		getStatus: () => ({ id: "rtl-pi", connected: true }),
		getCaps: () => ({ kind: "iq", sampleRate: 2_400_000, format: "U8_IQ" }),
	})

	function create(
		overrides: Record<string, unknown> = {},
		options: LiveDemodulatorOptions = {},
	): LiveDemodulatorType {
		const config = LiveDemodConfigSchema.parse({
			engine: "csdr",
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			...overrides,
		})
		return new LiveDemodulatorClass(
			testLogger,
			sourceManager,
			fanoutManager,
			config,
			{ httpHost: "127.0.0.1", ...options },
		)
	}

	function internals(): Internals {
		return liveDemod as unknown as Internals
	}

	function front(): MockChildProcess {
		const proc = processes.at(-2)
		if (!proc) throw new Error("pipeline not started")
		return proc
	}

	/** Writes channel IQ blocks to the front, waiting for each to pass the squelch. */
	async function feed(block: Buffer, count = 1): Promise<void> {
		const back = processes.at(-1)
		if (back && !back.stdin.readableFlowing) back.stdin.resume()
		for (let i = 0; i < count; i++)
			await new Promise<void>(resolve =>
				front().stdout.write(Buffer.from(block), () => resolve()),
			)
	}

	function client(): ClientTransport {
		const transport = new ClientTransport()
		internals().registerClient(
			transport as unknown as http.ServerResponse,
			"local",
		)
		return transport
	}

	async function runScene(
		overrides: Record<string, unknown>,
		seed: number,
	): Promise<SceneTrace> {
		await liveDemod.stop().catch(() => undefined)
		liveDemod = create(overrides)
		let t = Date.parse("2026-11-15T10:00:00.000Z")
		const events: SceneTrace["events"] = []
		const modes: string[] = []
		const tracker = wireAnalogTransmissions({
			source: liveDemod,
			frequencyAt: () => null,
			broadcast: event => {
				modes.push(event.squelchMode)
				events.push({
					state: event.state,
					startedAt: event.startedAt,
					endedAt: event.endedAt,
					durationMs: event.durationMs,
					closeReason: event.closeReason,
				})
			},
			sink: () => null,
			now: () => t,
		})
		await liveDemod.start()
		const back: Buffer[] = []
		processes.at(-1)!.stdin.on("data", (chunk: Buffer) => back.push(chunk))
		const edges: Array<[number, boolean]> = []
		let block = 0
		liveDemod.on("squelch-changed", (open: boolean) =>
			edges.push([block, open]),
		)
		const synth = new FmChannelSynth({
			sampleRate: RATE,
			bandwidthHz: 12_500,
			seed,
			cnrDb: 20,
			carrier: carrierWindows(SCENE_WINDOWS, RATE),
		})
		const frontIq: Buffer[] = []
		for (; block < SCENE_BLOCKS; block++) {
			const iq = Buffer.from(synth.next())
			frontIq.push(iq)
			front().stdout.write(Buffer.from(iq))
			t += BLOCK_MS
		}
		tracker.stop()
		return {
			edges,
			events,
			modes,
			frontIq: Buffer.concat(frontIq),
			backIq: Buffer.concat(back),
		}
	}

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		port = await findAvailablePort()
		processes = []
		spawnMock.mockImplementation(() => {
			const proc = new MockChildProcess()
			processes.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const proc = processes.find(p => p.pid === Math.abs(pid))
				if (!proc) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException
					err.code = "ESRCH"
					throw err
				}
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
		liveDemod = create()
	})

	afterEach(async () => {
		try {
			await liveDemod.stop()
		} catch {
			// ignore
		}
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	describe("open detects like auto", () => {
		for (const seed of [1, 2, 3]) {
			it(`seed ${seed}: same squelch edges and transmission events as auto; IQ reaches the demodulator raw`, async () => {
				// A stored manual line (-45) is kept in both; neither auto nor open reads it.
				const auto = await runScene({ squelchMode: "auto", squelch: -45 }, seed)
				const open = await runScene({ squelchMode: "open", squelch: -45 }, seed)
				expect(auto.edges.length).toBeGreaterThanOrEqual(4)
				expect(open.edges).toEqual(auto.edges)
				const opened = auto.events.filter(e => e.state === "open")
				expect(opened).toHaveLength(SCENE_WINDOWS.length)
				expect(open.events).toEqual(auto.events)
				expect(new Set(auto.modes)).toEqual(new Set(["auto"]))
				// Open: no stage-1 replacement; auto replaced its closed blocks.
				expect(open.backIq.equals(open.frontIq)).toBe(true)
				expect(auto.backIq.length).toBe(auto.frontIq.length)
				expect(auto.backIq.equals(auto.frontIq)).toBe(false)
			})
		}

		it("squelch 0 (the migrated Off): the same stage-1 edges as auto", async () => {
			const auto = await runScene({ squelchMode: "auto" }, 4)
			const open = await runScene({ squelchMode: "open" }, 4)
			expect(auto.edges.length).toBeGreaterThanOrEqual(4)
			expect(open.edges).toEqual(auto.edges)
			expect(open.backIq.equals(open.frontIq)).toBe(true)
			expect(liveDemod.getStatus().thresholdDbfs).toBeLessThan(0)
		})
	})

	describe("open audio", () => {
		it("passes PCM unchanged while stage 1 is closed and open; no evidence gate", async () => {
			liveDemod = create({ squelchMode: "open" })
			await liveDemod.start()
			await feedNoise(b => feed(b), 100)
			expect(liveDemod.isSquelchOpen()).toBe(false)
			const listener = client()
			const sent: Buffer[] = []
			for (let i = 0; i < 50; i++) {
				const pcm = pcmBlock(i * 250)
				sent.push(pcm)
				internals().handleAudioData(Buffer.from(pcm))
			}
			await feed(carrierBlock(-20), 5)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			for (let i = 50; i < 100; i++) {
				const pcm = pcmBlock(i * 250)
				sent.push(pcm)
				internals().handleAudioData(Buffer.from(pcm))
			}
			expect(listener.received().equals(Buffer.concat(sent))).toBe(true)
			expect(liveDemod.getStatus().autoSquelch).toEqual({ state: "off" })
		})

		it("ignores a configured tone squelch and keeps it for the return to auto", async () => {
			const tone = { kind: "ctcss", frequencyTenthsHz: 885 } as const
			liveDemod = create({ squelchMode: "open", toneSquelch: tone })
			await liveDemod.start()
			await feed(carrierBlock(-20), 5)
			const listener = client()
			const pcm = pcmBlock(0)
			internals().handleAudioData(Buffer.from(pcm))
			expect(listener.received().equals(pcm)).toBe(true)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "off" })
			expect(liveDemod.getStatus().config.toneSquelch).toEqual(tone)
			await liveDemod.reconfigure({ squelchMode: "auto" })
			expect(liveDemod.getStatus().toneSquelch?.state).not.toBe("off")
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})

		it("auto <-> open keeps the run, the floor and the stage-1 gate (no config close)", async () => {
			liveDemod = create({ squelchMode: "auto", squelch: -45 })
			await liveDemod.start()
			await feedNoise(b => feed(b), 100)
			const floor = liveDemod.getStatus().noiseFloorDbfs
			expect(floor).toBeDefined()
			await feed(carrierBlock(-20), 60)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			const edges: boolean[] = []
			liveDemod.on("squelch-changed", (open: boolean) => edges.push(open))
			await liveDemod.reconfigure({ squelchMode: "open" })
			expect(liveDemod.isSquelchOpen()).toBe(true)
			// The core does not stand for a config teardown of the over.
			expect(liveDemod.transmissionCloseOverride()).toBeNull()
			expect(liveDemod.getStatus().noiseFloorDbfs).toBe(floor)
			await liveDemod.reconfigure({ squelchMode: "auto" })
			expect(liveDemod.getStatus().noiseFloorDbfs).toBe(floor)
			expect(liveDemod.transmissionCloseOverride()).toBeNull()
			expect(edges).toEqual([])
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})
	})

	describe("open on /auto", () => {
		/**
		 * The scene on `/auto`: per 10 ms one IQ block through stage 1, one PCM block of the run's
		 * rate and one pacer tick. Returns the `/auto` bytes emitted while the pacer ran inside the
		 * noise gap between the carriers (hang and router latency margins excluded), and the span
		 * qualifications the demodulator gave the router there.
		 */
		async function autoGap(mode: "auto" | "open"): Promise<{
			gap: Buffer
			gapFlags: boolean[]
			total: number
		}> {
			await liveDemod.stop().catch(() => undefined)
			const clock = new RouteClock()
			liveDemod = create({ squelchMode: mode }, { autoRouteClock: clock })
			await liveDemod.start()
			const router = internals().autoRoute
			const flags: Array<[number, boolean]> = []
			let block = 0
			const push = router.pushAnalog.bind(router)
			router.pushAnalog = (chunk, start, end, audible, stream) => {
				flags.push([block, audible])
				push(chunk, start, end, audible, stream)
			}
			const transport = new ClientTransport()
			router.registry.register(
				transport as unknown as http.ServerResponse,
				"auto",
				AUTO_ROUTE_STREAM,
			)
			expect(router.wanted).toBe(true)
			const rate = internals().run?.stream.rate ?? RATE
			const synth = new FmChannelSynth({
				sampleRate: RATE,
				bandwidthHz: 12_500,
				seed: 5,
				cnrDb: 20,
				carrier: carrierWindows(SCENE_WINDOWS, RATE),
			})
			// The noise gap is 3.5 s to 5.5 s; keep 0.6 s clear of each edge.
			const gapFrom = 410
			const gapTo = 490
			let gapStart = 0
			let gapEnd = 0
			for (; block < SCENE_BLOCKS; block++) {
				await feed(Buffer.from(synth.next()))
				const pcm = Buffer.alloc((rate / 100) * 2)
				for (let n = 0; n < rate / 100; n++)
					pcm.writeInt16LE(
						Math.round(8000 * Math.sin((2 * Math.PI * 700 * n) / rate)),
						n * 2,
					)
				internals().handleAudioData(pcm)
				if (block === gapFrom) gapStart = transport.received().length
				clock.tick(BLOCK_MS)
				if (block === gapTo) gapEnd = transport.received().length
			}
			const all = transport.received()
			return {
				gap: all.subarray(gapStart, gapEnd),
				gapFlags: flags
					.filter(([at]) => at >= gapFrom && at <= gapTo)
					.map(([, audible]) => audible),
				total: all.length,
			}
		}

		it("open: noise between carriers is audible on /auto; auto keeps it silent", async () => {
			const open = await autoGap("open")
			expect(open.gap.length).toBeGreaterThan(0)
			expect(open.gapFlags.length).toBeGreaterThan(0)
			expect(open.gapFlags.every(Boolean)).toBe(true)
			expect(open.gap.some(b => b !== 0)).toBe(true)
			const auto = await autoGap("auto")
			expect(auto.gap.length).toBeGreaterThan(0)
			expect(auto.gapFlags.length).toBeGreaterThan(0)
			expect(auto.gapFlags.some(Boolean)).toBe(false)
			expect(auto.gap.every(b => b === 0)).toBe(true)
		})
	})

	describe("voiceOnly", () => {
		async function heard(voiceOnly: boolean | undefined): Promise<{
			received: Buffer
			sent: Buffer
			state: string | undefined
		}> {
			await liveDemod.stop().catch(() => undefined)
			liveDemod = create({
				squelchMode: "auto",
				...(voiceOnly !== undefined ? { voiceOnly } : {}),
			})
			await liveDemod.start()
			await feedNoise(b => feed(b), 100)
			await feed(carrierBlock(-20), 5)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			const listener = client()
			const sent: Buffer[] = []
			for (let i = 0; i < 20; i++) {
				const pcm = pcmBlock(i * 250)
				sent.push(pcm)
				internals().handleAudioData(Buffer.from(pcm))
			}
			return {
				received: listener.received(),
				sent: Buffer.concat(sent),
				state: liveDemod.getStatus().autoSquelch?.state,
			}
		}

		it("false: stage 1 alone, every byte stage 1 passes plays at once", async () => {
			const off = await heard(false)
			expect(off.state).toBe("off")
			expect(off.received.equals(off.sent)).toBe(true)
		})

		it("absent or true: the evidence gate holds a bare tone", async () => {
			for (const voiceOnly of [undefined, true]) {
				const on = await heard(voiceOnly)
				expect(on.state).toBe("waiting")
				expect(on.received.equals(on.sent)).toBe(false)
			}
		})

		it("switches at runtime without a restart", async () => {
			liveDemod = create({ squelchMode: "auto" })
			await liveDemod.start()
			await feedNoise(b => feed(b), 100)
			await feed(carrierBlock(-20), 5)
			expect(liveDemod.getStatus().autoSquelch?.state).toBe("waiting")
			await liveDemod.reconfigure({ voiceOnly: false })
			expect(liveDemod.getStatus().autoSquelch).toEqual({ state: "off" })
			await liveDemod.reconfigure({ voiceOnly: true })
			expect(liveDemod.getStatus().autoSquelch?.state).toBe("waiting")
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})
	})

	it("listenMode is stored and reported without a restart", async () => {
		await liveDemod.start()
		await liveDemod.reconfigure({ listenMode: "digital" })
		expect(liveDemod.getStatus().config.listenMode).toBe("digital")
		expect(spawnMock).toHaveBeenCalledTimes(2)
		await expect(
			liveDemod.reconfigure({ listenMode: "decoded" as "digital" }),
		).rejects.toThrow()
		expect(liveDemod.getStatus().config.listenMode).toBe("digital")
	})
})
