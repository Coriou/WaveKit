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
	stderr: { write(s: string): unknown }
}

/** First line of the error, with C0/C1 controls removed so it cannot move the restored cursor. */
function oneLine(err: unknown): string {
	const text = err instanceof Error ? err.message : String(err)
	return (text.split(/\r?\n/)[0] ?? "").replace(
		/[\u0000-\u001f\u007f-\u009f]/g,
		"",
	)
}

export function installExitHandlers(
	proc: ProcessLike,
	screen: Screen,
	shutdown: (code: number) => void,
): void {
	const fatal = (err: unknown): void => {
		screen.restore()
		proc.stderr.write(`wavekit: ${oneLine(err)}\n`)
		shutdown(1)
	}
	proc.on("exit", () => screen.restore())
	proc.on("SIGINT", () => shutdown(130))
	proc.on("SIGTERM", () => shutdown(143))
	proc.on("uncaughtException", fatal)
	proc.on("unhandledRejection", fatal)
}
