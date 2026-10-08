import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
	ALT_ENTER,
	ALT_EXIT,
	createScreen,
	createShutdown,
	installExitHandlers,
	oneLine,
	osc52,
} from "../../../cli/source/terminal.js"

describe("screen", () => {
	it("enters and restores the alternate screen once, only on a TTY", () => {
		const writes: string[] = []
		const tty = createScreen({ isTTY: true, write: s => writes.push(s) })
		tty.enter()
		tty.enter()
		tty.restore()
		tty.restore()
		expect(writes.join("")).toBe(`${ALT_ENTER}\x1b[?25h${ALT_EXIT}`)
		const pipe: string[] = []
		const p = createScreen({ isTTY: false, write: s => pipe.push(s) })
		p.enter()
		p.restore()
		expect(pipe).toEqual([])
	})
	it("encodes OSC 52 clipboard writes", () => {
		expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07")
		expect(osc52("€")).toBe(
			`\x1b]52;c;${Buffer.from("€").toString("base64")}\x07`,
		)
	})
	it("routes signals and crashes to shutdown with the conventional codes", () => {
		const proc = new EventEmitter()
		const screen = { enter: vi.fn(), restore: vi.fn() }
		const shutdown = vi.fn()
		installExitHandlers(proc, screen, shutdown)
		proc.emit("SIGINT")
		proc.emit("SIGTERM")
		proc.emit("uncaughtException", new Error("boom"))
		proc.emit(
			"unhandledRejection",
			"first line\x1b[2J\x1b]0;title\x07\nsecond line",
		)
		expect(shutdown.mock.calls).toEqual([
			[130],
			[143],
			[1, "boom"],
			[1, "first line"],
		])
		// Crash handlers leave the restore to shutdown (after Ink unmounts).
		expect(screen.restore).not.toHaveBeenCalled()
		proc.emit("exit")
		expect(screen.restore).toHaveBeenCalledTimes(1)
	})
	it("shuts down once: unmount, then restore, then message, then exit", () => {
		const order: string[] = []
		const shutdown = createShutdown({
			unmount: () => {
				order.push("unmount")
				throw new Error("already unmounted")
			},
			screen: {
				enter: () => order.push("enter"),
				restore: () => order.push("restore"),
			},
			stderr: { write: s => order.push(`stderr ${s}`) },
			exit: code => order.push(`exit ${code}`),
		})
		shutdown(1, "boom")
		shutdown(130)
		expect(order).toEqual([
			"unmount",
			"restore",
			"stderr wavekit: boom\n",
			"exit 1",
		])
	})
	it("keeps the first line of an error and strips whole escape sequences", () => {
		expect(oneLine(new Error("a\x1b[31mred\x1b[0m\r\nb"))).toBe("ared")
		expect(oneLine({ toString: () => "\x9b2Jx" })).toBe("x")
	})
})
