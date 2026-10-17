import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"

export interface LogLine {
	level: string
	args: unknown[]
}

/** A pino-shaped logger recording every call (child returns the same recorder). */
export function spyLogger(): { logger: Logger; lines: LogLine[] } {
	const lines: LogLine[] = []
	const rec =
		(level: string) =>
		(...args: unknown[]) => {
			lines.push({ level, args })
		}
	const logger = {
		info: rec("info"),
		warn: rec("warn"),
		error: rec("error"),
		debug: rec("debug"),
		trace: rec("trace"),
		fatal: rec("fatal"),
		child: () => logger,
	}
	return { logger: logger as unknown as Logger, lines }
}

/** Fails when any log line mentions one of the given secrets (ids, paths, frequencies). */
export function logText(lines: LogLine[]): string {
	return lines.map(l => JSON.stringify(l.args)).join("\n")
}

export class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly control = new PassThrough()
	readonly stdio: unknown[]
	/** Never a real pid: the code under test must not signal a real process group. */
	pid: number | undefined = undefined
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	readonly controlLines: string[] = []
	readonly stdinBytes: Buffer[] = []
	autoExit = true
	constructor(
		readonly command: string,
		readonly args: readonly string[],
		readonly options: SpawnOptions,
		opts: { drainStdin?: boolean } = {},
	) {
		super()
		this.stdio = [this.stdin, this.stdout, this.stderr, this.control]
		let pending = ""
		this.control.on("data", (b: Buffer) => {
			pending += b.toString("utf8")
			let nl = pending.indexOf("\n")
			while (nl !== -1) {
				const line = pending.slice(0, nl)
				this.controlLines.push(line)
				if (this.autoExit && line.includes('"type":"shutdown"'))
					queueMicrotask(() => this.exit(0))
				pending = pending.slice(nl + 1)
				nl = pending.indexOf("\n")
			}
		})
		if (opts.drainStdin !== false)
			this.stdin.on("data", (b: Buffer) => this.stdinBytes.push(b))
	}
	commands(): Record<string, unknown>[] {
		return this.controlLines.map(l => JSON.parse(l) as Record<string, unknown>)
	}
	emitLine(line: string): void {
		this.stdout.write(`${line}\n`)
	}
	event(obj: Record<string, unknown>): void {
		this.emitLine(JSON.stringify(obj))
	}
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.stdout.end()
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
	}
	kill(sig?: NodeJS.Signals): boolean {
		this.exit(null, sig ?? "SIGTERM")
		return true
	}
}

export function fakeSpawner(opts: {
	drainStdin?: boolean
	enoent?: boolean
	onSpawn?: (child: FakeChild) => void
}) {
	const children: FakeChild[] = []
	const spawn = vi.fn(
		(command: string, args: readonly string[], options: SpawnOptions) => {
			const child = new FakeChild(command, args, options, opts)
			children.push(child)
			if (opts.enoent) {
				child.pid = undefined
				queueMicrotask(() => {
					const err = Object.assign(new Error("spawn ENOENT"), {
						code: "ENOENT",
					})
					child.emit("error", err)
					child.exit(-2)
				})
			} else opts.onSpawn?.(child)
			return child as unknown as ChildProcess
		},
	)
	return { spawn, children }
}

export const flush = async (n = 5): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r))
}
