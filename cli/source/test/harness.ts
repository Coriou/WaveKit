import { EventEmitter } from "node:events"
import { render } from "ink"
import type { ReactElement } from "react"
import { stripAnsi } from "../ui/text.js"

class FakeStdout extends EventEmitter {
	columns: number
	rows: number
	isTTY = false
	readonly chunks: string[] = []
	constructor(cols: number, rows: number) {
		super()
		this.columns = cols
		this.rows = rows
	}
	write(chunk: string): boolean {
		this.chunks.push(chunk)
		return true
	}
}

class FakeStdin extends EventEmitter {
	isTTY = true
	private readonly queue: string[] = []
	setRawMode(): this {
		return this
	}
	setEncoding(): this {
		return this
	}
	ref(): this {
		return this
	}
	unref(): this {
		return this
	}
	resume(): this {
		return this
	}
	pause(): this {
		return this
	}
	read(): string | null {
		return this.queue.shift() ?? null
	}
	feed(chunk: string): void {
		this.queue.push(chunk)
		this.emit("readable")
	}
}

export const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	pgup: "\x1b[5~",
	pgdn: "\x1b[6~",
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	backspace: "\x7f",
	ctrlC: "\x03",
	space: " ",
} as const

export function settle(ms = 15): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

/** Upper bound for every wait; generous because the host may be heavily loaded. */
export const WAIT_TIMEOUT_MS = 5000
const POLL_MS = 5

/** Poll until `predicate()` holds; resolves false (never throws) on timeout. */
export async function pollUntil(
	predicate: () => boolean,
	timeoutMs = WAIT_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) return false
		await settle(POLL_MS)
	}
	return true
}

export interface WaitOptions {
	/** false = the input is not expected to change the frame; wait briefly instead of for a write. */
	expectWrite?: boolean
}

export interface RenderHandle {
	frame(): string[]
	text(): string
	/** Feed one key, then wait for the frame it produces (or briefly, with expectWrite: false). */
	press(seq: string, opts?: WaitOptions): Promise<void>
	resize(cols: number, rows: number, opts?: WaitOptions): Promise<void>
	rerender(el: ReactElement, opts?: WaitOptions): Promise<void>
	/** Poll the current frame until `predicate` holds; throws with the last frame on timeout. */
	waitFor(
		predicate: (frame: string[]) => boolean,
		timeoutMs?: number,
	): Promise<void>
	writes(): readonly string[]
	/** True once the app called useApp().exit() (or was unmounted). */
	exited(): boolean
	unmount(): void
}

/** Ink debug mode writes the full frame on every commit; the last non-empty write is the current frame. */
export async function renderAt(
	el: ReactElement,
	size: { cols: number; rows: number },
): Promise<RenderHandle> {
	const stdout = new FakeStdout(size.cols, size.rows)
	const stdin = new FakeStdin()
	const instance = render(el, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	})
	let exited = false
	void instance.waitUntilExit().then(
		() => {
			exited = true
		},
		() => {
			exited = true
		},
	)
	// Wait for the first frame. useInput attaches in a passive effect after it;
	// input sent before that flushes is dropped, hence the extra settle.
	await pollUntil(() => stdout.chunks.length > 0)
	await settle()
	/** Wait for a write after `before` chunks, then until no write lands for quietMs. */
	const afterInput = async (
		before: number,
		opts: WaitOptions | undefined,
		quietMs: number,
	): Promise<void> => {
		if (opts?.expectWrite === false) {
			await settle(quietMs)
			return
		}
		await pollUntil(() => stdout.chunks.length > before)
		const deadline = Date.now() + WAIT_TIMEOUT_MS
		let seen = stdout.chunks.length
		while (Date.now() < deadline) {
			await settle(quietMs)
			if (stdout.chunks.length === seen) return
			seen = stdout.chunks.length
		}
	}
	const frame = (): string[] => {
		for (let i = stdout.chunks.length - 1; i >= 0; i--) {
			const chunk = stdout.chunks[i] ?? ""
			const plain = stripAnsi(chunk)
			if (plain.trim() !== "") return plain.split("\n")
		}
		return []
	}
	return {
		frame,
		text: () => frame().join("\n"),
		press: async (seq, opts) => {
			const before = stdout.chunks.length
			stdin.feed(seq)
			await afterInput(before, opts, 15)
		},
		resize: async (cols, rows, opts) => {
			const before = stdout.chunks.length
			stdout.columns = cols
			stdout.rows = rows
			stdout.emit("resize")
			// use-terminal-size debounces 50 ms, so the quiet window must exceed it.
			await afterInput(before, opts, 90)
		},
		rerender: async (next, opts) => {
			const before = stdout.chunks.length
			instance.rerender(next)
			await afterInput(before, opts, 15)
		},
		waitFor: async (predicate, timeoutMs = WAIT_TIMEOUT_MS) => {
			if (!(await pollUntil(() => predicate(frame()), timeoutMs))) {
				throw new Error(
					`waitFor timed out after ${timeoutMs} ms; last frame:\n${frame().join("\n")}`,
				)
			}
		},
		writes: () => stdout.chunks,
		exited: () => exited,
		unmount: () => {
			instance.unmount()
			instance.cleanup()
		},
	}
}
