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

export interface RenderHandle {
	frame(): string[]
	text(): string
	press(seq: string): Promise<void>
	resize(cols: number, rows: number): Promise<void>
	rerender(el: ReactElement): Promise<void>
	writes(): readonly string[]
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
	// useInput attaches in a passive effect; input sent before it flushes is dropped.
	await settle()
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
		press: async seq => {
			stdin.feed(seq)
			await settle()
		},
		resize: async (cols, rows) => {
			stdout.columns = cols
			stdout.rows = rows
			stdout.emit("resize")
			// use-terminal-size debounces 50 ms.
			await settle(90)
		},
		rerender: async next => {
			instance.rerender(next)
			await settle()
		},
		writes: () => stdout.chunks,
		unmount: () => {
			instance.unmount()
			instance.cleanup()
		},
	}
}
