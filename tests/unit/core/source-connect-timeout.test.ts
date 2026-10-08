import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	SourceManager,
	SOURCE_CONNECT_TIMEOUT_MS,
} from "../../../src/core/source-manager.js"

const behavior = vi.hoisted(() => ({ connect: false, attempts: 0 }))
vi.mock("node:net", async importOriginal => {
	const original = await importOriginal<Record<string, unknown>>()
	const { EventEmitter } = await import("node:events")
	class Socket extends EventEmitter {
		private timer?: ReturnType<typeof setTimeout>
		setTimeout(ms: number) {
			clearTimeout(this.timer)
			if (ms) this.timer = setTimeout(() => this.emit("timeout"), ms)
			return this
		}
		isPaused() {
			return false
		}
		connect() {
			behavior.attempts++
			if (behavior.connect) queueMicrotask(() => this.emit("connect"))
			return this
		}
		destroy() {
			clearTimeout(this.timer)
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
	vi.useRealTimers()
	behavior.connect = false
	behavior.attempts = 0
})
const source = {
	id: "receiver",
	type: "rtl_tcp" as const,
	host: "receiver.invalid",
	port: 5555,
	loop: false,
	playbackSpeed: 1,
	caps: {
		kind: "iq" as const,
		format: "U8_IQ" as const,
		sampleRate: 2048000,
		exclusive: false,
	},
}

describe("Source connection deadlines", () => {
	it("bounds a stalled startup and retains the source for automatic recovery", async () => {
		vi.useFakeTimers()
		manager = new SourceManager(pino({ level: "silent" }))
		const connected = manager.connect(source)
		const failure = expect(connected).rejects.toThrow("Failed to connect")
		await vi.advanceTimersByTimeAsync(SOURCE_CONNECT_TIMEOUT_MS)
		await failure
		expect(manager.getStatus(source.id)).toMatchObject({
			connected: false,
			reconnectAttempts: 1,
			lastError: `Source connection timed out after ${SOURCE_CONNECT_TIMEOUT_MS}ms`,
		})
		await vi.advanceTimersByTimeAsync(4000)
		expect(behavior.attempts).toBe(2)
		await vi.advanceTimersByTimeAsync(SOURCE_CONNECT_TIMEOUT_MS)
		expect(manager.getStatus(source.id)?.reconnectAttempts).toBe(2)
		behavior.connect = true
		await vi.advanceTimersByTimeAsync(8000)
		expect(behavior.attempts).toBe(3)
		expect(manager.getStatus(source.id)?.connected).toBe(true)
	})

	it("does not disconnect a connected receiver that has not produced samples", async () => {
		vi.useFakeTimers()
		behavior.connect = true
		manager = new SourceManager(pino({ level: "silent" }))
		const connected = manager.connect(source)
		await vi.advanceTimersByTimeAsync(0)
		await connected
		await vi.advanceTimersByTimeAsync(SOURCE_CONNECT_TIMEOUT_MS * 3)
		expect(behavior.attempts).toBe(1)
		expect(manager.getStatus(source.id)).toMatchObject({
			connected: true,
			activity: { state: "stale" },
		})
	})
})
