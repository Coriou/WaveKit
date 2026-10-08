/**
 * Health across unexpected exits: "restarting" while a retry is scheduled,
 * "faulted" for a crash loop even with an unlimited restart budget.
 * Contract: docs/CLI-COORDINATION.md "proposed decoder health contract".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import {
	DecoderManager,
	type DecoderManagerConfig,
} from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { toApiDecoderStatus } from "../../../src/api/serializers/decoder-status.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class CrashingDecoder extends EventEmitter implements Decoder {
	readonly id = "acars"
	readonly type = "test"
	readonly caps: DecoderCaps = {
		input: "audio_pcm",
		output: "text",
		integrationPattern: "pure_consumer",
	}
	readonly output = new PassThrough({ objectMode: true })
	running = false
	starts = 0
	failStart = false
	private startedAt = 0
	async start() {
		this.starts++
		if (this.failStart) throw new Error("spawn failed")
		this.running = true
		this.startedAt = Date.now()
		this.emit("started")
	}
	async stop() {
		this.running = false
		this.emit("stopped")
	}
	async restart() {
		await this.stop()
		await this.start()
	}
	attachInput(_input: Readable) {}
	detachInput() {}
	updateOptions(_updates: Record<string, unknown>) {}
	getOutput() {
		return this.output
	}
	getAudioOutput() {
		return null
	}
	getHealth() {
		return "running" as const
	}
	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: this.running,
			health: "running",
			uptime: this.running ? (Date.now() - this.startedAt) / 1000 : 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
	crash() {
		this.running = false
		this.emit("exit", 1, null)
	}
	produceOutput() {
		const output: DecoderOutput = {
			decoder: this.id,
			timestamp: new Date(),
			type: "signal",
			data: {},
		}
		this.emit("output", output)
	}
}

let decoder: CrashingDecoder
let manager: DecoderManager
let healthEvents: DecoderHealth[]

function setup(config: Partial<DecoderManagerConfig> = {}) {
	decoder = new CrashingDecoder()
	const registry = new DecoderRegistry()
	registry.register("test", () => decoder, decoder.caps)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		maxRestarts: 0,
		faultAfterFailures: 3,
		stableRunMs: 1000,
		healthCheckInterval: 100,
		idleTimeout: 60_000,
		validateVersions: false,
		...config,
	})
	healthEvents = []
	manager.on("decoder:health", (_id: string, health: DecoderHealth) =>
		healthEvents.push(health),
	)
	manager.createDecoder({
		id: "acars",
		type: "test",
		enabled: true,
		options: {},
	})
}

beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("health on unexpected exit", () => {
	it("reports restarting with nextRestartAt while a retry is scheduled", async () => {
		setup()
		await manager.startDecoder("acars")
		const published: Array<ReturnType<typeof toApiDecoderStatus>> = []
		manager.on("decoder:status-changed", (id: string) =>
			published.push(toApiDecoderStatus(manager.getStatus(id)!)),
		)
		const before = Date.now()
		decoder.crash()
		const status = manager.getStatus("acars")!
		expect(status).toMatchObject({ running: false, health: "restarting" })
		expect(status.nextRestartAt?.getTime()).toBe(before + 10)
		// The status published for the exit already carries the new state.
		expect(published.at(-1)).toMatchObject({
			running: false,
			health: "restarting",
			nextRestartAt: new Date(before + 10).toISOString(),
		})

		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.starts).toBe(2)
		expect(manager.getStatus("acars")).toMatchObject({
			running: true,
			health: "running",
		})
		expect(manager.getStatus("acars")?.nextRestartAt).toBeUndefined()
		expect(healthEvents).toEqual(["restarting", "running"])
	})

	it("faults a crash loop with unlimited restarts but keeps retrying at max backoff", async () => {
		setup()
		await manager.startDecoder("acars")
		decoder.crash() // failure 1
		await vi.advanceTimersByTimeAsync(10)
		decoder.crash() // failure 2
		await vi.advanceTimersByTimeAsync(20)
		expect(manager.getStatus("acars")?.health).toBe("running")
		decoder.crash() // failure 3: threshold reached
		expect(manager.getStatus("acars")).toMatchObject({
			running: false,
			health: "faulted",
			restartCount: 3,
		})
		expect(manager.getStatus("acars")?.nextRestartAt).toBeDefined()

		// A retry that has not proven stable keeps the crash loop faulted.
		await vi.advanceTimersByTimeAsync(40)
		expect(decoder.starts).toBe(4)
		expect(manager.getStatus("acars")).toMatchObject({
			running: true,
			health: "faulted",
		})
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("faulted")
		await vi.advanceTimersByTimeAsync(40)
		expect(decoder.starts).toBe(5)

		// A stable run (uptime >= stableRunMs) clears the fault.
		await vi.advanceTimersByTimeAsync(1100)
		expect(manager.getStatus("acars")?.health).toBe("running")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("restarting")
	})

	it("output during a retry run clears the crash-loop fault", async () => {
		setup({ faultAfterFailures: 1 })
		await manager.startDecoder("acars")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("faulted")
		await vi.advanceTimersByTimeAsync(10)
		expect(manager.getStatus("acars")?.health).toBe("faulted")
		decoder.produceOutput()
		expect(manager.getStatus("acars")?.health).toBe("running")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("faulted")
	})

	it("a stable run between crashes resets the consecutive count", async () => {
		setup()
		await manager.startDecoder("acars")
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(1000)
			decoder.crash()
			expect(manager.getStatus("acars")?.health).toBe("restarting")
			await vi.advanceTimersByTimeAsync(10)
		}
	})

	it("an exhausted finite budget is terminal: faulted without nextRestartAt", async () => {
		setup({ maxRestarts: 1, faultAfterFailures: 10 })
		await manager.startDecoder("acars")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("restarting")
		await vi.advanceTimersByTimeAsync(10)
		decoder.crash()
		expect(manager.getStatus("acars")).toMatchObject({
			running: false,
			health: "faulted",
		})
		expect(manager.getStatus("acars")?.nextRestartAt).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1000)
		expect(decoder.starts).toBe(2)
	})

	it("failed restart attempts count toward the crash loop", async () => {
		setup()
		await manager.startDecoder("acars")
		decoder.failStart = true
		decoder.crash() // 1
		await vi.advanceTimersByTimeAsync(10) // spawn fails: 2
		expect(manager.getStatus("acars")?.health).toBe("restarting")
		await vi.advanceTimersByTimeAsync(20) // spawn fails: 3
		expect(manager.getStatus("acars")?.health).toBe("faulted")
		expect(manager.getStatus("acars")?.nextRestartAt).toBeDefined()
	})

	it("explicit stop cancels the retry and clears restarting; explicit start resets a fault", async () => {
		setup({ faultAfterFailures: 1 })
		await manager.startDecoder("acars")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("faulted")
		await manager.stopDecoder("acars")
		expect(manager.getStatus("acars")?.nextRestartAt).toBeUndefined()
		await manager.startDecoder("acars")
		expect(manager.getStatus("acars")?.health).toBe("running")
		await manager.destroy()

		setup({ faultAfterFailures: 5 })
		await manager.startDecoder("acars")
		decoder.crash()
		expect(manager.getStatus("acars")?.health).toBe("restarting")
		await manager.stopDecoder("acars")
		expect(manager.getStatus("acars")).toMatchObject({
			running: false,
			health: "running",
		})
		expect(manager.getStatus("acars")?.nextRestartAt).toBeUndefined()
		await vi.advanceTimersByTimeAsync(100)
		expect(decoder.starts).toBe(1)
	})
})
