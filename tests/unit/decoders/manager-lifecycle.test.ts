import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
class ControlledDecoder extends EventEmitter implements Decoder {
	readonly id = "test"
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
	async start() {
		this.starts++
		if (this.failStart) throw new Error("Missing decoder binary")
		this.running = true
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
			uptime: 0,
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
		this.output.write(output)
		this.emit("output", output)
	}
}

let decoder: ControlledDecoder
let manager: DecoderManager
let fanout: FanoutManager
beforeEach(() => {
	vi.useFakeTimers()
	decoder = new ControlledDecoder()
	const registry = new DecoderRegistry()
	registry.register("test", () => decoder, decoder.caps)
	fanout = new FanoutManager(logger)
	manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 100,
		maxRestarts: 2,
		validateVersions: false,
	})
	manager.createDecoder({
		id: "test",
		type: "test",
		enabled: true,
		options: {},
	})
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("DecoderManager lifecycle", () => {
	it("cleans up the fanout and exposes faulted health when startup fails", async () => {
		decoder.failStart = true
		await expect(manager.startDecoder("test")).rejects.toThrow(
			"Missing decoder binary",
		)
		expect(fanout.getBranchIds().length).toBe(0)
		expect(manager.getStatus("test")?.health).toBe("faulted")
		decoder.failStart = false
		await manager.startDecoder("test")
		expect(fanout.getBranchIds().length).toBe(1)
		expect(manager.getStatus("test")?.health).toBe("running")
	})

	it("preserves exponential backoff across crashes and reports the exhausted retry count", async () => {
		await manager.startDecoder("test")
		decoder.crash()
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.starts).toBe(2)
		decoder.crash()
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.starts).toBe(2)
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.starts).toBe(3)
		decoder.crash()
		expect(manager.getStatus("test")).toMatchObject({
			running: false,
			health: "faulted",
			restartCount: 2,
		})
	})

	it.each(["stopAll", "removeDecoder"] as const)(
		"%s cancels queued restarts after a crash",
		async action => {
			await manager.startDecoder("test")
			decoder.crash()
			if (action === "stopAll") await manager.stopAll()
			else await manager.removeDecoder("test")
			await vi.advanceTimersByTimeAsync(100)
			expect(decoder.starts).toBe(1)
			expect(fanout.getBranchIds().length).toBe(0)
		},
	)

	it("retries rejected starts and eventually marks the decoder faulted", async () => {
		await manager.startDecoder("test")
		decoder.failStart = true
		decoder.crash()
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.starts).toBe(2)
		await vi.advanceTimersByTimeAsync(20)
		expect(decoder.starts).toBe(3)
		expect(manager.getStatus("test")?.health).toBe("faulted")
		expect(fanout.getBranchIds().length).toBe(0)
	})

	it("drains decoder streams while forwarding events without growing the output buffer", async () => {
		vi.useRealTimers()
		await manager.startDecoder("test")
		const received = vi.fn()
		manager.on("decoder:output", received)
		await new Promise<void>(resolve => setImmediate(resolve))
		for (let i = 0; i < 1000; i++) decoder.produceOutput()
		await new Promise<void>(resolve => setImmediate(resolve))
		expect(received).toHaveBeenCalledTimes(1000)
		expect(decoder.output.readableLength).toBe(0)
		expect(decoder.output.writableLength).toBe(0)
	})
})
