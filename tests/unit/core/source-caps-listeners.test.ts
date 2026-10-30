/**
 * SourceManager listeners: subsystems register once, not per connection. Five reconnects of
 * an rtl_tcp source (a mocked socket, fake timers) leave every event's listener count where
 * the first connection left it, and the cap is the one stated in SOURCE_MANAGER_MAX_LISTENERS.
 */
import type { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import {
	SOURCE_MANAGER_MAX_LISTENERS,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const transport = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }))
vi.mock("node:net", async () => {
	const { EventEmitter: Base } = await import("node:events")
	return {
		Socket: class extends Base {
			constructor() {
				super()
				transport.sockets.push(this)
			}
			connect() {}
			setTimeout() {}
			setKeepAlive() {}
			pause() {}
			resume() {}
			isPaused() {
				return false
			}
			destroy() {
				this.emit("close")
			}
		},
	}
})

afterEach(() => {
	vi.useRealTimers()
	transport.sockets = []
})

function counts(sources: SourceManager): Record<string, number> {
	const out: Record<string, number> = {}
	for (const name of sources.eventNames())
		out[String(name)] = sources.listenerCount(name)
	return out
}

it("keeps every SourceManager listener count stable across reconnects", async () => {
	vi.useFakeTimers()
	const log = createLogger({ level: "fatal" })
	const sources = new SourceManager(log)
	expect(sources.getMaxListeners()).toBe(SOURCE_MANAGER_MAX_LISTENERS)
	const fanout = new FanoutManager(log)
	const router = new SourceFanoutRouter(sources, fanout, log, "s")
	const header = Buffer.alloc(12)
	header.write("RTL0")
	const payload = () => {
		transport.sockets
			.at(-1)!
			.emit("data", Buffer.concat([header, Buffer.alloc(32, 128)]))
	}
	try {
		const connecting = sources.connect({
			id: "s",
			type: "rtl_tcp",
			host: "test.invalid",
			port: 1234,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2048000,
				exclusive: false,
			},
		})
		transport.sockets.at(-1)!.emit("connect")
		await connecting
		payload()
		await vi.advanceTimersByTimeAsync(1000)
		const baseline = counts(sources)
		expect(baseline["caps-changed"]).toBeGreaterThan(0)
		for (let i = 0; i < 5; i++) {
			const before = transport.sockets.length
			transport.sockets.at(-1)!.emit("close")
			// Exponential backoff: wait until the next socket exists (bounded).
			for (let t = 0; t < 120 && transport.sockets.length === before; t++)
				await vi.advanceTimersByTimeAsync(1000)
			expect(transport.sockets.length).toBe(before + 1)
			transport.sockets.at(-1)!.emit("connect")
			expect(sources.getStatus("s")?.connected).toBe(true)
			payload()
			await vi.advanceTimersByTimeAsync(1000)
			expect(counts(sources)).toEqual(baseline)
		}
		for (const n of Object.values(counts(sources)))
			expect(n).toBeLessThanOrEqual(SOURCE_MANAGER_MAX_LISTENERS)
	} finally {
		router.destroy()
		await sources.disconnectAll()
	}
})
