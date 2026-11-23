import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { SourceManager } from "../../../src/core/source-manager.js"

// The default intake is byte-identical to the path before the seam: `new net.Socket()` with no
// argument, then `connect(port, host)` with exactly those two arguments.
const calls = vi.hoisted(() => ({
	constructed: [] as unknown[][],
	connects: [] as unknown[][],
}))
vi.mock("node:net", async importOriginal => {
	const original = await importOriginal<Record<string, unknown>>()
	const { EventEmitter } = await import("node:events")
	class Socket extends EventEmitter {
		constructor(...args: unknown[]) {
			super()
			calls.constructed.push(args)
		}
		setTimeout() {
			return this
		}
		setKeepAlive() {
			return this
		}
		isPaused() {
			return false
		}
		connect(...args: unknown[]) {
			calls.connects.push(args)
			return this
		}
		destroy() {
			this.emit("close")
			return this
		}
	}
	return { ...original, Socket }
})

let manager: SourceManager | undefined
afterEach(async () => {
	await manager?.disconnectAll()
	manager = undefined
	calls.constructed.length = 0
	calls.connects.length = 0
})

describe("default source intake", () => {
	it("constructs net.Socket() with no argument and calls connect(port, host)", async () => {
		manager = new SourceManager(pino({ level: "silent" }))
		void manager
			.connect({
				id: "rx",
				type: "rtl_tcp",
				host: "receiver.invalid",
				port: 5555,
				loop: false,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: 2_048_000,
					exclusive: false,
				},
			})
			.catch(() => {})
		await new Promise(resolve => setImmediate(resolve))
		expect(calls.constructed).toEqual([[]])
		expect(calls.connects).toEqual([[5555, "receiver.invalid"]])
		expect(manager.connectionLocalPort("rx")).toBeNull()
	})
})
