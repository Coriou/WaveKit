import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
	ALT_ENTER,
	ALT_EXIT,
	createScreen,
	installExitHandlers,
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
	it("restores and exits with the conventional codes", () => {
		const proc = Object.assign(new EventEmitter(), {
			stderr: { write: vi.fn() },
		})
		const screen = { enter: vi.fn(), restore: vi.fn() }
		const shutdown = vi.fn()
		installExitHandlers(proc, screen, shutdown)
		proc.emit("SIGINT")
		proc.emit("SIGTERM")
		proc.emit("uncaughtException", new Error("boom"))
		proc.emit("exit")
		expect(shutdown.mock.calls.map(c => c[0])).toEqual([130, 143, 1])
		expect(screen.restore).toHaveBeenCalled()
		expect(proc.stderr.write).toHaveBeenCalledWith("wavekit: boom\n")
	})
	it("reports unhandled rejections on one sanitised line", () => {
		const proc = Object.assign(new EventEmitter(), {
			stderr: { write: vi.fn() },
		})
		const screen = { enter: vi.fn(), restore: vi.fn() }
		const shutdown = vi.fn()
		installExitHandlers(proc, screen, shutdown)
		proc.emit("unhandledRejection", "first line\x1b[2J\nsecond line")
		expect(proc.stderr.write).toHaveBeenCalledWith("wavekit: first line[2J\n")
		expect(shutdown).toHaveBeenCalledWith(1)
		expect(screen.restore).toHaveBeenCalledTimes(1)
	})
})
