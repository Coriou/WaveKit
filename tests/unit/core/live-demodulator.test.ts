/**
 * Live Demodulator Unit Tests
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
import { createLogger } from "../../../src/utils/logger.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type {
	LiveDemodConfig,
	LiveDemodulator as LiveDemodulatorType,
	LiveDemodulatorOptions,
} from "../../../src/core/live-demodulator.js"

vi.mock("node:child_process", () => {
	return {
		spawn: vi.fn(),
	}
})

import { spawn } from "node:child_process"

const testLogger = createLogger({ level: "fatal" })

let nextPid = 4_000_000

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	signals: NodeJS.Signals[] = []
	ignoreSigterm = false

	constructor(readonly command: string) {
		super()
	}

	receive(signal: NodeJS.Signals): void {
		this.signals.push(signal)
		if (signal === "SIGTERM" && this.ignoreSigterm) return
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

function createMockFanoutManager() {
	const branch = new PassThrough()
	return {
		branch,
		addBranch: vi.fn().mockReturnValue(branch),
		removeBranch: vi.fn(),
	}
}

function createMockSourceManager(sampleRate = 2_400_000) {
	const emitter = new EventEmitter()
	const caps = { kind: "iq", sampleRate, format: "U8_IQ" as const }
	return {
		caps,
		getAllStatus: vi.fn().mockReturnValue([{ id: "rtl-pi", connected: true }]),
		getStatus: vi.fn().mockReturnValue({ id: "rtl-pi", connected: true }),
		getCaps: vi.fn(() => ({ ...caps })),
		on: vi.fn((event: string, listener: (...args: any[]) => void) => {
			emitter.on(event, listener)
			return emitter
		}),
		off: vi.fn((event: string, listener: (...args: any[]) => void) => {
			emitter.off(event, listener)
			return emitter
		}),
		emitCaps(update: Partial<typeof caps> & { centerFreq?: number }) {
			Object.assign(caps, update)
			emitter.emit("caps-changed", "rtl-pi", { ...caps, ...update })
		},
	}
}

/**
 * A free port outside the OS ephemeral range: ephemeral ports are handed to
 * outgoing connections (other test processes on this machine), which made
 * "find a free port, then listen" race.
 */
async function findAvailablePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "0.0.0.0", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (condition()) return
		await delay(5)
	}
	throw new Error("Timed out waiting for condition")
}

/** Stand-in for http.ServerResponse that can stall. */
class ClientTransport extends Writable {
	readonly chunks: Buffer[] = []
	private pending: (() => void) | undefined
	constructor(private stalled: boolean) {
		super({ highWaterMark: 16 * 1024 })
	}
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		if (this.stalled) this.pending = cb
		else cb()
	}
	resume(): void {
		this.stalled = false
		const cb = this.pending
		this.pending = undefined
		cb?.()
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

type Internals = {
	clients: Map<string, unknown>
	handleAudioData(chunk: Buffer): void
	registerClient(
		response: http.ServerResponse,
		remoteAddress: string,
	): { id: string; droppedBytes: number }
}

describe("LiveDemodulator", () => {
	let LiveDemodulatorClass: new (...args: any[]) => LiveDemodulatorType
	let liveDemod: LiveDemodulatorType
	let sourceManager: ReturnType<typeof createMockSourceManager>
	let fanoutManager: ReturnType<typeof createMockFanoutManager>
	let port: number
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>

	function create(
		overrides: Partial<LiveDemodConfig> = {},
		options: LiveDemodulatorOptions = {},
	): LiveDemodulatorType {
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			...overrides,
		})
		return new LiveDemodulatorClass(
			testLogger,
			sourceManager as any,
			fanoutManager as any,
			config,
			options,
		)
	}

	function internals(): Internals {
		return liveDemod as unknown as Internals
	}

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: any[]
		) => LiveDemodulatorType
		port = await findAvailablePort()
		fanoutManager = createMockFanoutManager()
		sourceManager = createMockSourceManager()
		processes = []
		spawnMock.mockImplementation((_cmd: string, args: string[]) => {
			const proc = new MockChildProcess(args[1] ?? "")
			processes.push(proc)
			return proc as unknown as ChildProcess
		})
		// Never signal real process groups: route group kills to the mocks.
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
		vi.useRealTimers()
		try {
			await liveDemod.stop()
		} catch {
			// Ignore cleanup errors
		}
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	it("spawns a front and a back CSDR process in their own process groups", async () => {
		await liveDemod.start()
		expect(processes).toHaveLength(2)
		const [front, back] = processes
		expect(front!.command).toBe(
			"csdr convert -i char -o float | csdr firdecimate 96 0.002604 --cutoff 0.3750",
		)
		expect(back!.command).toBe(
			"csdr fmdemod | csdr dcblock | csdr gain 2 | csdr limit | csdr convert -i float -o s16",
		)
		const options = spawnMock.mock.calls[0]![2] as { detached: boolean }
		expect(options.detached).toBe(process.platform !== "win32")
	})

	it("pipes capture IQ to the front and gated channel IQ to the back", async () => {
		await liveDemod.start()
		const [front, back] = processes
		const toFront: Buffer[] = []
		front!.stdin.on("data", chunk => toFront.push(chunk))
		const toBack: Buffer[] = []
		back!.stdin.on("data", chunk => toBack.push(chunk))

		fanoutManager.branch.write(Buffer.from([1, 2, 3, 4]))
		// 10 ms of channel IQ at 25 kHz = 250 complex samples.
		const channel = Buffer.alloc(250 * 8)
		channel.writeFloatLE(0.5, 0)
		front!.stdout.write(channel)
		await waitFor(() => toFront.length > 0 && toBack.length > 0)
		expect(Buffer.concat(toFront)).toEqual(Buffer.from([1, 2, 3, 4]))
		expect(Buffer.concat(toBack).equals(channel)).toBe(true)
		expect(liveDemod.getStatus().channelPowerDbfs).toBeDefined()
		expect(liveDemod.getStatus().squelchOpen).toBe(true)
	})

	it("streams audio from the back process to clients in whole samples", async () => {
		await liveDemod.start()
		const client = new ClientTransport(false)
		internals().registerClient(
			client as unknown as http.ServerResponse,
			"local",
		)
		const [, back] = processes
		back!.stdout.write(Buffer.from([1, 2, 3]))
		await delay(10)
		expect(client.received()).toEqual(Buffer.from([1, 2]))
		back!.stdout.write(Buffer.from([4]))
		await delay(10)
		expect(client.received()).toEqual(Buffer.from([1, 2, 3, 4]))
		expect(liveDemod.getStatus().bytesStreamed).toBe(4)
		expect(liveDemod.getStatus().clientCount).toBe(1)
	})

	it("keeps about one second for a stalled client, dropping the oldest audio", () => {
		const slow = new ClientTransport(true)
		const healthy = new ClientTransport(false)
		internals().registerClient(slow as unknown as http.ServerResponse, "slow")
		internals().registerClient(healthy as unknown as http.ServerResponse, "ok")
		const chunks: Buffer[] = []
		for (let n = 0; n < 40; n++) {
			const chunk = Buffer.alloc(10_000, n)
			chunks.push(chunk)
			internals().handleAudioData(chunk)
		}
		// 25 kHz s16le: one second is 50,000 bytes.
		const slowState = [...internals().clients.values()][0] as {
			queuedBytes: number
			droppedBytes: number
		}
		expect(slowState.queuedBytes).toBeLessThanOrEqual(50_000)
		expect(slowState.droppedBytes).toBeGreaterThan(0)
		expect(slow.destroyed).toBe(false)
		expect(healthy.received().equals(Buffer.concat(chunks))).toBe(true)

		// After recovering, the slow client gets the newest audio, not the oldest.
		slow.resume()
		internals().handleAudioData(Buffer.alloc(10_000, 99))
		const received = slow.received()
		expect(received.at(-1)).toBe(99)
		expect(received.length).toBeLessThan(40 * 10_000)
	})

	it("disconnects a client that accepts nothing for the stall timeout", () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		liveDemod = create({}, { clientStallTimeoutMs: 5000 })
		const slow = new ClientTransport(true)
		internals().registerClient(slow as unknown as http.ServerResponse, "slow")
		internals().handleAudioData(Buffer.alloc(20_000))
		vi.setSystemTime(Date.now() + 6000)
		internals().handleAudioData(Buffer.alloc(2))
		expect(slow.destroyed).toBe(true)
		expect(liveDemod.getStatus().clientCount).toBe(0)
	})

	it("applies a squelch change live without restarting CSDR", async () => {
		await liveDemod.start()
		await liveDemod.reconfigure({ squelch: -50 })
		expect(spawnMock).toHaveBeenCalledTimes(2)
		const [front, back] = processes
		const toBack: Buffer[] = []
		back!.stdin.on("data", chunk => toBack.push(chunk))
		// A -80 dBFS channel stays muted: the back process receives zeros.
		const quiet = Buffer.alloc(250 * 8)
		for (let i = 0; i < 500; i++) quiet.writeFloatLE(1e-4, i * 4)
		front!.stdout.write(quiet)
		await waitFor(() => toBack.length > 0)
		expect(Buffer.concat(toBack).every(byte => byte === 0)).toBe(true)
		expect(liveDemod.getStatus().squelchOpen).toBe(false)
	})

	it("restarts the pipeline when a DSP setting changes", async () => {
		await liveDemod.start()
		await liveDemod.reconfigure({ gain: 5 })
		expect(spawnMock).toHaveBeenCalledTimes(4)
		expect(processes[3]!.command).toContain("csdr gain 5")
		expect(processes[0]!.signals).toContain("SIGTERM")
		expect(processes[1]!.signals).toContain("SIGTERM")
	})

	it("rejects an offset outside the capture without touching the running pipeline", async () => {
		await liveDemod.start()
		await expect(
			liveDemod.reconfigure({ offsetHz: 1_500_000 }),
		).rejects.toThrow(/offsetHz/)
		expect(spawnMock).toHaveBeenCalledTimes(2)
		expect(liveDemod.getStatus().config.offsetHz).toBe(0)
		await liveDemod.reconfigure({ offsetHz: 6000 })
		expect(processes[2]!.command).toContain("csdr shift -0.0025000000")
	})

	it("keeps running across a centre-frequency retune", async () => {
		await liveDemod.start()
		sourceManager.emitCaps({ centerFreq: 446_093_750 } as never)
		await delay(400)
		expect(spawnMock).toHaveBeenCalledTimes(2)
		expect(processes[0]!.signals).toEqual([])
	})

	it("restarts on a sample-rate change and disconnects clients told the old rate", async () => {
		await liveDemod.start()
		const client = new ClientTransport(false)
		internals().registerClient(client as unknown as http.ServerResponse, "c")
		sourceManager.emitCaps({ sampleRate: 2_048_000 })
		await waitFor(() => spawnMock.mock.calls.length === 4, 2000)
		await waitFor(() => liveDemod.getStatus().clientCount === 0)
		expect(client.writableEnded).toBe(true)
		expect(processes[2]!.command).toContain("csdr firdecimate 82 ")
	})

	it("kills the process group and escalates to SIGKILL when SIGTERM is ignored", async () => {
		liveDemod = create({}, { stopTimeoutMs: 30 })
		await liveDemod.start()
		const [front, back] = processes
		front!.ignoreSigterm = true
		const stdout = front!.stdout
		await liveDemod.stop()
		expect(killSpy).toHaveBeenCalledWith(-front!.pid, "SIGTERM")
		expect(killSpy).toHaveBeenCalledWith(-back!.pid, "SIGTERM")
		expect(front!.signals).toEqual(["SIGTERM", "SIGKILL"])
		expect(stdout.destroyed).toBe(true)
		expect(back!.stdout.destroyed).toBe(true)
	})

	it("restarts a crashed pipeline with exponential backoff, then gives up", async () => {
		vi.useFakeTimers()
		liveDemod = create({}, { maxRestartAttempts: 2, stableRunMs: 60_000 })
		const starting = liveDemod.start()
		await vi.advanceTimersByTimeAsync(0)
		await starting

		processes[0]!.exit(1)
		await vi.advanceTimersByTimeAsync(10)
		expect(liveDemod.getStatus().pipelineHealth).toBe("error")
		expect(processes[1]!.signals).toContain("SIGTERM")
		await vi.advanceTimersByTimeAsync(980)
		expect(spawnMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(20)
		expect(spawnMock).toHaveBeenCalledTimes(4)
		expect(liveDemod.getStatus().pipelineHealth).toBe("running")
		expect(liveDemod.getStatus().pipelineRestarts).toBe(1)

		// Second failure waits twice as long.
		processes[2]!.exit(1)
		await vi.advanceTimersByTimeAsync(1990)
		expect(spawnMock).toHaveBeenCalledTimes(4)
		await vi.advanceTimersByTimeAsync(20)
		expect(spawnMock).toHaveBeenCalledTimes(6)

		// Third consecutive failure exceeds maxRestartAttempts: no more restarts.
		processes[4]!.exit(1)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(spawnMock).toHaveBeenCalledTimes(6)
		expect(liveDemod.getStatus().lastError).toMatch(/gave up/)

		// POST /start restarts a dead pipeline while the HTTP server is up.
		const restarting = liveDemod.start()
		await vi.advanceTimersByTimeAsync(0)
		await restarting
		expect(spawnMock).toHaveBeenCalledTimes(8)
		expect(liveDemod.getStatus().pipelineHealth).toBe("running")
	})

	it("serves raw and WAV streams with self-describing headers", async () => {
		await liveDemod.start()
		const get = (path: string) =>
			new Promise<http.IncomingMessage>((resolve, reject) => {
				const req = http.get({ host: "127.0.0.1", port, path }, resolve)
				req.on("error", reject)
			})
		const raw = await get("/stream")
		expect(raw.headers["content-type"]).toBe("application/octet-stream")
		expect(raw.headers["x-audio-format"]).toBe("s16le")
		expect(raw.headers["x-sample-rate"]).toBe("25000")
		expect(raw.headers["x-channels"]).toBe("1")

		const wav = await get("/stream.wav")
		expect(wav.headers["content-type"]).toBe("audio/wav")
		const header = await new Promise<Buffer>(resolve =>
			wav.once("data", (chunk: Buffer) => resolve(chunk)),
		)
		expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF")
		expect(header.readUInt16LE(20)).toBe(1)
		expect(header.readUInt32LE(24)).toBe(25_000)
		expect(header.readUInt16LE(34)).toBe(16)
		await waitFor(() => liveDemod.getStatus().clientCount === 2)
		raw.destroy()
		wav.destroy()
	})

	it("changes httpPort promptly while a client is connected", async () => {
		await liveDemod.start()
		const response = await new Promise<http.IncomingMessage>(
			(resolve, reject) => {
				const req = http.get(
					{ host: "127.0.0.1", port, path: "/stream" },
					resolve,
				)
				req.on("error", reject)
			},
		)
		response.on("error", () => undefined)
		response.resume()
		const newPort = await findAvailablePort()
		const started = Date.now()
		await liveDemod.reconfigure({ httpPort: newPort })
		expect(Date.now() - started).toBeLessThan(1000)
		expect(spawnMock).toHaveBeenCalledTimes(2)
		expect(liveDemod.getStatus().httpUrl).toContain(String(newPort))
	})

	it("calculates effective sample rate from bandwidth", () => {
		const status = liveDemod.getStatus()
		expect(status.decimationFactor).toBe(96)
		expect(Math.round(status.effectiveSampleRate)).toBe(25000)
		expect(status.wavUrl).toBe(`http://localhost:${port}/stream.wav`)
	})
})
