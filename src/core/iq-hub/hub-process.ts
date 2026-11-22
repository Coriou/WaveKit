/**
 * One `wavekit-iqhub` child process: spawned with `stdio: ["ignore", "pipe", "pipe", "pipe"]` (fd 3
 * is the control pipe), its socket directory a private `mkdtemp` (mode 0700) under the OS temp
 * directory, its stdout read as event lines (bounded), its stderr kept as a 2 KiB tail. The
 * supervisor talks to it through the HubProcess interface only, so tests inject a fake hub
 * through a HubProcessFactory.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Writable } from "node:stream"
import { WaveKitError } from "../../utils/errors.js"
import { HUB_MAX_EVENT_LINE_BYTES } from "./protocol.js"

export const HUB_STDERR_TAIL_BYTES = 2048
/** `sun_path` bound portable to macOS (104 with its NUL) and Linux (108). */
export const HUB_SOCKET_PATH_MAX_BYTES = 103

export interface HubExit {
	code: number | null
	signal: NodeJS.Signals | null
	/** Set when the process could not be spawned (ENOENT, EACCES, ...): its code only. */
	spawnError: string | null
}

export interface HubProcessHandlers {
	/** One event line (without its newline), in order. */
	onLine(line: string): void
	/** Once, when the process is gone (or never started). */
	onExit(exit: HubExit): void
}

export interface HubProcess {
	readonly pid: number | null
	/** The private socket directory this hub was given (removed by `removeSocketDir`). */
	readonly socketDir: string
	/** Writes one request line; false when the control pipe is closed. */
	send(line: string): boolean
	/** Ends the control pipe (the hub exits 0 on its EOF). */
	endControl(): void
	/** Signals the own child by its handle (never by name or pattern). */
	kill(signal: "SIGKILL" | "SIGTERM" | "SIGSTOP" | "SIGCONT"): void
	/** The last bytes of stderr, control characters replaced (at most HUB_STDERR_TAIL_BYTES). */
	stderrTail(): string
	removeSocketDir(): Promise<void>
}

export interface HubSpawnOptions {
	sourceId: string
	ringMs: number
	statsFile?: string | undefined
}

export type HubProcessFactory = (
	options: HubSpawnOptions,
	handlers: HubProcessHandlers,
) => Promise<HubProcess>

/** Splits a byte stream into lines; a line over `maxBytes` is skipped up to its newline. */
export class LineSplitter {
	private parts: Buffer[] = []
	private length = 0
	private skipping = false
	oversized = 0

	constructor(
		private readonly maxBytes: number,
		private readonly onLine: (line: string) => void,
	) {}

	push(chunk: Buffer): void {
		let start = 0
		while (start < chunk.length) {
			const nl = chunk.indexOf(0x0a, start)
			const end = nl === -1 ? chunk.length : nl
			if (!this.skipping) {
				const piece = chunk.subarray(start, end)
				if (this.length + piece.length > this.maxBytes) {
					this.skipping = true
					this.oversized += 1
					this.parts = []
					this.length = 0
				} else if (piece.length > 0) {
					this.parts.push(piece)
					this.length += piece.length
				}
			}
			if (nl === -1) return
			if (!this.skipping) {
				const line =
					this.parts.length === 1
						? (this.parts[0] as Buffer).toString("utf8")
						: Buffer.concat(this.parts, this.length).toString("utf8")
				this.parts = []
				this.length = 0
				if (line.length > 0) this.onLine(line)
			}
			this.skipping = false
			start = nl + 1
		}
	}
}

function sanitizeTail(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?")
}

/** The hub binary named by `bin` (a path or a name on PATH), spawned for real. */
export function spawnHubProcessFactory(bin: string): HubProcessFactory {
	return async (options, handlers) => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wk-iqhub-"))
		await fs.promises.chmod(dir, 0o700)
		const sockPath = path.join(dir, "hub.sock")
		if (Buffer.byteLength(sockPath) > HUB_SOCKET_PATH_MAX_BYTES) {
			await fs.promises.rm(dir, { recursive: true, force: true })
			throw new WaveKitError(
				"IQ hub socket path is too long for the OS temp directory",
				"IQHUB_UNAVAILABLE",
			)
		}
		const args = [
			"--control-fd",
			"3",
			"--socket-dir",
			dir,
			"--ring-ms",
			String(options.ringMs),
			...(options.statsFile !== undefined
				? ["--stats-file", options.statsFile]
				: []),
		]
		let child: ChildProcess
		try {
			child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] })
		} catch {
			// A synchronous throw (an invalid path or argument): no child owns the directory.
			await fs.promises.rm(dir, { recursive: true, force: true })
			throw new WaveKitError("IQ hub could not be spawned", "IQHUB_UNAVAILABLE")
		}
		let tail = ""
		let exited = false
		const exit = (value: HubExit) => {
			if (exited) return
			exited = true
			handlers.onExit(value)
		}
		const control = child.stdio[3] as Writable | null | undefined
		control?.on("error", () => {
			/* EPIPE after the hub exited: its exit is reported. */
		})
		const splitter = new LineSplitter(HUB_MAX_EVENT_LINE_BYTES, line =>
			handlers.onLine(line),
		)
		child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk))
		child.stdout?.on("error", () => {})
		child.stderr?.on("data", (chunk: Buffer) => {
			tail = (tail + chunk.toString("utf8")).slice(-HUB_STDERR_TAIL_BYTES)
		})
		child.stderr?.on("error", () => {})
		child.on("error", (err: NodeJS.ErrnoException) => {
			if (child.pid === undefined)
				exit({
					code: null,
					signal: null,
					spawnError: typeof err.code === "string" ? err.code : "spawn",
				})
		})
		child.on("close", (code, signal) =>
			exit({ code, signal, spawnError: null }),
		)
		return {
			pid: child.pid ?? null,
			socketDir: dir,
			send(line: string): boolean {
				if (exited || !control || control.destroyed || control.writableEnded)
					return false
				control.write(line)
				return true
			},
			endControl(): void {
				if (control && !control.writableEnded) control.end()
			},
			kill(signal): void {
				if (!exited && child.exitCode === null) child.kill(signal)
			},
			stderrTail(): string {
				return sanitizeTail(tail)
			},
			removeSocketDir(): Promise<void> {
				return fs.promises.rm(dir, { recursive: true, force: true })
			},
		}
	}
}
