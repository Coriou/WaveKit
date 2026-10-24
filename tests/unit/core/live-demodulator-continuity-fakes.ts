/**
 * Shared fakes for the WG10 live audio continuity tests: fake CSDR
 * processes, a fake source manager and fanout, a capturing logger and a
 * stand-in client transport. No sockets, no real processes.
 */

import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import pino from "pino"
import type { Logger } from "../../../src/utils/logger.js"
import type { AutoRouteClock } from "../../../src/core/auto-listen/contract.js"

let nextPid = 7_000_000

export class FakeProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	signals: NodeJS.Signals[] = []

	constructor(readonly command: string) {
		super()
		// A stage nobody reads must not stall the branch.
		this.stdin.resume()
	}

	receive(signal: NodeJS.Signals): void {
		this.signals.push(signal)
		setTimeout(() => this.exit(null, signal), 0)
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
	}

	get alive(): boolean {
		return this.exitCode === null && this.signalCode === null
	}
}

export function createFakeSourceManager(sampleRate = 2_400_000) {
	const emitter = new EventEmitter()
	const caps = { kind: "iq", sampleRate, format: "U8_IQ" as const }
	return {
		caps,
		getAllStatus: () => [{ id: "rtl-pi", connected: true }],
		getStatus: () => ({ id: "rtl-pi", connected: true }),
		getCaps: () => ({ ...caps }),
		on(event: string, listener: (...args: unknown[]) => void) {
			emitter.on(event, listener)
			return emitter
		},
		off(event: string, listener: (...args: unknown[]) => void) {
			emitter.off(event, listener)
			return emitter
		},
		emitCaps(update: Record<string, unknown>) {
			Object.assign(caps, update)
			emitter.emit("caps-changed", "rtl-pi", { ...caps, ...update })
		},
	}
}

export function createFakeFanout() {
	const branch = new PassThrough()
	return {
		branch,
		addBranch: () => branch,
		removeBranch: () => undefined,
	}
}

export interface CapturedLog {
	level: number
	msg: string
	[key: string]: unknown
}

/** A debug-level logger that keeps every line (without time) in memory. */
export function capturingLogger(): { logger: Logger; lines: CapturedLog[] } {
	const lines: CapturedLog[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, cb) {
			for (const line of chunk.toString().split("\n")) {
				if (line.trim()) lines.push(JSON.parse(line) as CapturedLog)
			}
			cb()
		},
	})
	const logger = pino(
		{ level: "debug", base: null, timestamp: false },
		sink,
	) as unknown as Logger
	return { logger, lines }
}

/** Stand-in for http.ServerResponse. */
export class ClientTransport extends Writable {
	readonly chunks: Buffer[] = []
	constructor() {
		super({ highWaterMark: 1 << 30 })
	}
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitFor(
	condition: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (condition()) return
		await delay(2)
	}
	throw new Error("Timed out waiting for condition")
}

/** Injected clock for the silence fill and the front swap timeout. */
export class ManualClock {
	time = 0
	private timers: Array<{ at: number; id: number; callback: () => void }> = []
	private nextId = 1

	now = (): number => this.time

	setTimer = (callback: () => void, ms: number): unknown => {
		const id = this.nextId++
		this.timers.push({ at: this.time + ms, id, callback })
		return id
	}

	clearTimer = (handle: unknown): void => {
		this.timers = this.timers.filter(timer => timer.id !== handle)
	}

	get pending(): number {
		return this.timers.length
	}

	/** Advances time, firing each due timer at its own time, in order. */
	advance(ms: number): void {
		const end = this.time + ms
		for (;;) {
			this.timers.sort((a, b) => a.at - b.at || a.id - b.id)
			const next = this.timers[0]
			if (next === undefined || next.at > end) break
			this.timers.shift()
			this.time = Math.max(this.time, next.at)
			next.callback()
		}
		this.time = end
	}
}

export interface DemodHarnessOptions {
	config?: Record<string, unknown>
	logger?: Logger
	clock?: ManualClock
	restartBaseDelayMs?: number
	/** Called with each fake stage as it is spawned. */
	onSpawn?: (proc: FakeProcess) => void
	/** IQ rate the fake source reports (default 2.4 Msps). */
	sourceSampleRate?: number
	/** Pacing clock of the `/auto` router (default: the real clock). */
	autoRouteClock?: AutoRouteClock
}

/**
 * A started-ready LiveDemodulator on fake stages (the `spawnStage` seam),
 * an injected clock, and process-group kills routed to the fakes.
 */
export async function createDemodHarness(options: DemodHarnessOptions = {}) {
	const { LiveDemodulator } =
		await import("../../../src/core/live-demodulator.js")
	const { LiveDemodConfigSchema } = await import("../../../src/config.js")
	const { createLogger } = await import("../../../src/utils/logger.js")
	const processes: FakeProcess[] = []
	const clock = options.clock ?? new ManualClock()
	const sourceManager = createFakeSourceManager(options.sourceSampleRate)
	const fanout = createFakeFanout()
	const realKill = process.kill.bind(process)
	const killSpy = (pid: number, signal?: string | number): true => {
		const proc = processes.find(p => p.pid === Math.abs(pid))
		if (!proc) {
			const err = new Error("ESRCH") as NodeJS.ErrnoException
			err.code = "ESRCH"
			throw err
		}
		proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
		return true
	}
	process.kill = killSpy as typeof process.kill
	const config = LiveDemodConfigSchema.parse({
		enabled: true,
		sourceId: "rtl-pi",
		httpPort: await findFreePort(),
		...options.config,
	})
	const demod = new LiveDemodulator(
		options.logger ?? createLogger({ level: "fatal" }),
		sourceManager as never,
		fanout as never,
		config,
		{
			httpHost: "127.0.0.1",
			clock,
			restartBaseDelayMs: options.restartBaseDelayMs ?? 1,
			...(options.autoRouteClock !== undefined
				? { autoRouteClock: options.autoRouteClock }
				: {}),
			spawnStage: (command: string) => {
				const proc = new FakeProcess(command)
				processes.push(proc)
				options.onSpawn?.(proc)
				return proc as never
			},
		},
	)
	const internals = demod as unknown as {
		registerClient(
			response: unknown,
			remoteAddress: string,
		): { id: string; stream: { rate: number; format: string } }
		run: {
			front: FakeProcess
			back: FakeProcess
			squelch: { process(chunk: Buffer): Buffer[] }
			stream: { rate: number; format: "s16le" | "f32le" }
		} | null
	}
	return {
		demod,
		processes,
		clock,
		sourceManager,
		fanout,
		internals,
		/** Fake front (role "front") and back processes of the current run. */
		current() {
			const run = internals.run
			if (run === null) throw new Error("no run")
			return { front: run.front, back: run.back }
		},
		addClient(name = "c") {
			const transport = new ClientTransport()
			const client = internals.registerClient(transport, name)
			return { transport, client }
		},
		async dispose() {
			try {
				await demod.stop()
			} catch {
				// cleanup only
			}
			process.kill = realKill
		},
	}
}

export async function findFreePort(): Promise<number> {
	const http = await import("node:http")
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

/** Channel IQ: `samples` complex float32 samples, every value `value`. */
export function channelIq(samples: number, value: number): Buffer {
	const buffer = Buffer.alloc(samples * 8)
	for (let i = 0; i < samples * 2; i++) buffer.writeFloatLE(value, i * 4)
	return buffer
}

/** Writes and lets the stream machinery deliver it. */
export async function writeAndSettle(
	stream: NodeJS.WritableStream,
	chunk: Buffer,
): Promise<void> {
	await new Promise<void>(resolve => stream.write(chunk, () => resolve()))
	await delay(1)
}
