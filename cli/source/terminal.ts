import { sanitize } from "./ui/text.js"

export const ALT_ENTER = "\x1b[?1049h"
export const ALT_EXIT = "\x1b[?1049l"
export const CURSOR_SHOW = "\x1b[?25h"

export interface Screen {
	enter(): void
	restore(): void
}

/** Alternate screen on a TTY only; `restore` is idempotent so every exit path may call it. */
export function createScreen(out: {
	write(s: string): unknown
	isTTY?: boolean
}): Screen {
	let active = false
	return {
		enter: () => {
			if (active || out.isTTY !== true) return
			out.write(ALT_ENTER)
			active = true
		},
		restore: () => {
			if (!active) return
			active = false
			out.write(CURSOR_SHOW + ALT_EXIT)
		},
	}
}

/** OSC 52 clipboard write; whether the terminal honours it cannot be observed. */
export function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`
}

export interface ProcessLike {
	on(event: string, fn: (...args: unknown[]) => void): unknown
}

/** First line of the error, sanitised (whole escape sequences removed) so it cannot move the restored cursor. */
export function oneLine(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err)
	return sanitize(text.split(/\r?\n/)[0] ?? "")
}

export type Shutdown = (code: number, message?: string) => void

export interface ShutdownDeps {
	/** Unmount the Ink tree; may be absent before render. Errors are ignored. */
	unmount: () => void
	screen: Screen
	stderr: { write(s: string): unknown }
	exit: (code: number) => void
}

/**
 * Runs once: unmount Ink first (its last frame is written to the alternate
 * screen, not over the user's shell), then restore the main screen, then print
 * the message, then exit.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
	let done = false
	return (code, message) => {
		if (done) return
		done = true
		try {
			deps.unmount()
		} catch {
			// The tree may already be gone; the screen still has to be restored.
		}
		deps.screen.restore()
		if (message !== undefined) deps.stderr.write(`wavekit: ${message}\n`)
		deps.exit(code)
	}
}

/** exit restores the screen; SIGINT 130, SIGTERM 143; uncaught errors print one sanitised line and exit 1. */
export function installExitHandlers(
	proc: ProcessLike,
	screen: Screen,
	shutdown: Shutdown,
): void {
	const fatal = (err: unknown): void => shutdown(1, oneLine(err))
	proc.on("exit", () => screen.restore())
	proc.on("SIGINT", () => shutdown(130))
	proc.on("SIGTERM", () => shutdown(143))
	proc.on("uncaughtException", fatal)
	proc.on("unhandledRejection", fatal)
}

/**
 * Runs the startup steps (enter the screen, start the runtime, render). A
 * synchronous throw goes through shutdown, which restores the terminal before
 * printing one sanitised line; otherwise it would reject the entry import and
 * be written onto the alternate screen, then wiped by the restore.
 */
export function startOrShutdown<T>(
	steps: () => T,
	shutdown: Shutdown,
): T | undefined {
	try {
		return steps()
	} catch (err: unknown) {
		shutdown(1, oneLine(err))
		return undefined
	}
}
