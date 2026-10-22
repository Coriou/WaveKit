/**
 * In-process stand-ins for a wavekit-chan demod spawn. Unix sockets live under
 * /tmp so the path stays inside the platform limit. Not a vitest file.
 */

import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { SilenceFillClock } from "../../../../src/core/live-audio-silence.js"

let nextPid = 8_100_000

export interface ControlMessage {
	[key: string]: unknown
}

export function controlMessages(text: string): ControlMessage[] {
	return text
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as ControlMessage)
}

export function demodEvent(
	type: string,
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return { v: 1, type, generation: 1, id: "live-demod", ...fields }
}

interface FakeExit {
	pid: number
	receive(signal: NodeJS.Signals): void
}

export class VersionFake extends EventEmitter implements FakeExit {
	stdout = new PassThrough()
	stderr = new PassThrough()
	stdin = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null

	constructor(mode: "current" | "old" | "enoent") {
		super()
		process.nextTick(() => {
			if (this.exitCode !== null || this.signalCode !== null) return
			if (mode === "enoent") {
				const error = new Error("spawn ENOENT") as NodeJS.ErrnoException
				error.code = "ENOENT"
				error.errno = -2
				error.syscall = "spawn"
				this.emit("error", error)
				return
			}
			const line =
				mode === "old"
					? "wavekit-chan 0.1.0 protocol 1\n"
					: "wavekit-chan 0.2.0 protocol 2\n"
			this.stdout.write(line)
			this.exit(0, null)
		})
	}

	receive(signal: NodeJS.Signals): void {
		this.exit(null, signal)
	}

	exit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
	}
}

export class ChannelFake extends EventEmitter implements FakeExit {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	control = new PassThrough()
	stdio: Array<PassThrough | null>
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	signals: NodeJS.Signals[] = []
	controlText = ""
	audio: Socket | null = null
	/** Runs after the `opened` line is written, still inside that write. */
	onOpenedWritten: (() => void) | null = null
	private server: Server | null = null
	private socketDir: string | null = null
	private opening = false
	private readonly exitOnShutdown: boolean
	private readonly autoExit: boolean
	private readonly rejectOpen: boolean
	private readonly emitReady: boolean
	private readonly holdReady: boolean
	private readonly readyRepeat: number
	private readonly openedChunkSuffix: string

	constructor(options?: {
		exitOnShutdown?: boolean
		autoExit?: boolean
		rejectOpen?: boolean
		/** When false, the fake never writes `ready` (timeout / spawn-failure tests). */
		emitReady?: boolean
		/**
		 * When true, `ready` waits for `writeReady()`. The handshake can be
		 * delivered after `stop()`.
		 */
		holdReady?: boolean
		/** Copies of `ready` in the first stdout chunk. Default 1. */
		readyRepeat?: number
		/**
		 * Text appended to the `opened` line in the same stdout write. A gate
		 * or metrics event here arrives before the run is adopted.
		 */
		openedChunkSuffix?: string
	}) {
		super()
		this.exitOnShutdown = options?.exitOnShutdown ?? true
		this.autoExit = options?.autoExit ?? false
		this.rejectOpen = options?.rejectOpen ?? false
		this.emitReady = options?.emitReady ?? true
		this.holdReady = options?.holdReady ?? false
		this.readyRepeat = Math.max(1, options?.readyRepeat ?? 1)
		this.openedChunkSuffix = options?.openedChunkSuffix ?? ""
		this.stdio = [this.stdin, this.stdout, this.stderr, this.control]
		this.stdin.resume()
		this.stderr.resume()
		this.control.on("data", (chunk: Buffer) => {
			this.controlText += chunk.toString("utf8")
			if (this.exitOnShutdown && this.controlText.includes('"type":"shutdown"'))
				this.exit(0, null)
			if (this.controlText.includes('"type":"open"') && !this.opening) {
				this.opening = true
				if (this.rejectOpen) {
					this.emitLine(
						demodEvent("rejected", {
							reasonCode: "channel-request-invalid",
							detail: "secret-detail",
						}),
					)
					return
				}
				void this.openSocket().catch(() => {
					this.exit(1, null)
				})
			}
		})
		process.nextTick(() => {
			if (this.exitCode !== null || !this.emitReady || this.holdReady) return
			this.writeReady()
		})
	}

	/** Deliver `ready`. Used when `holdReady` kept the handshake back. */
	writeReady(): void {
		const line = `${JSON.stringify({ v: 1, type: "ready", generation: 1, pid: this.pid })}\n`
		this.stdout.write(line.repeat(this.readyRepeat))
	}

	emitLine(value: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify(value)}\n`)
	}

	receive(signal: NodeJS.Signals): void {
		this.signals.push(signal)
		this.exit(null, signal)
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
		this.server?.close()
	}

	async dispose(): Promise<void> {
		this.audio?.destroy()
		this.server?.close()
		if (this.socketDir)
			await rm(this.socketDir, { recursive: true, force: true })
	}

	private async openSocket(): Promise<void> {
		const dir = await mkdtemp(join("/tmp", "wkdmt-"))
		this.socketDir = dir
		const socketPath = join(dir, "live-demod.sock")
		const server = createServer(sock => {
			this.audio = sock
		})
		this.server = server
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(socketPath, () => resolve())
		})
		if (this.exitCode !== null) return
		// One write: `opened` and anything trailing it are one stdout chunk.
		const opened = JSON.stringify(
			demodEvent("opened", {
				socket: socketPath,
				outputRateHz: 48000,
				format: "s16le",
				kind: "demod",
				filterTaps: 1,
				groupDelaySamples: 0,
			}),
		)
		this.stdout.write(`${opened}\n${this.openedChunkSuffix}`)
		this.onOpenedWritten?.()
		if (this.autoExit) process.nextTick(() => this.exit(1, null))
	}
}

interface Timer {
	at: number
	cb: () => void
}

export function manualClock(): SilenceFillClock & {
	advance(ms: number): void
} {
	let now = 0
	const timers: Timer[] = []
	return {
		now: () => now,
		setTimer(callback, ms) {
			const timer = { at: now + ms, cb: callback }
			timers.push(timer)
			return timer
		},
		clearTimer(handle) {
			const index = timers.indexOf(handle as Timer)
			if (index >= 0) timers.splice(index, 1)
		},
		advance(ms) {
			now += ms
			for (;;) {
				const due = timers
					.filter(timer => timer.at <= now)
					.sort((a, b) => a.at - b.at)
				const next = due[0]
				if (!next) return
				const index = timers.indexOf(next)
				if (index >= 0) timers.splice(index, 1)
				next.cb()
			}
		},
	}
}
