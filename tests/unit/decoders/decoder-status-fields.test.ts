/**
 * Decoder status fields requested by the CLI (CLI-COORDINATION requests 2-4):
 * sourceId / deviceSerial / targetFrequenciesHz, lastError, idleTimeoutMs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	DECODER_LAST_ERROR_MAX_LENGTH,
	createDecoderLastError,
	resolveDecoderTargetFrequencies,
} from "../../../src/decoders/status-fields.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class StubDecoder extends EventEmitter implements Decoder {
	readonly output = new PassThrough({ objectMode: true })
	running = false
	failStart = false
	constructor(
		readonly id: string,
		readonly type: string,
		readonly caps: DecoderCaps,
	) {
		super()
	}
	async start() {
		if (this.failStart) throw new Error("spawn acarsdec ENOENT")
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
	crash(code: number | null, signal: string | null = null) {
		this.running = false
		this.emit("exit", code, signal)
	}
}

const stdinCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const externalCaps: DecoderCaps = {
	input: "external",
	output: "jsonl",
	integrationPattern: "external_sdr",
}

let manager: DecoderManager
let fanout: FanoutManager
const decoders = new Map<string, StubDecoder>()

function create(config: Partial<DecoderConfig> & { id: string }): StubDecoder {
	manager.createDecoder({
		type: "stdin",
		enabled: true,
		options: {},
		...config,
	})
	return decoders.get(config.id)!
}

beforeEach(() => {
	vi.useFakeTimers()
	decoders.clear()
	const registry = new DecoderRegistry()
	for (const [type, caps] of [
		["stdin", stdinCaps],
		["external", externalCaps],
	] as const) {
		registry.register(
			type,
			config => {
				const decoder = new StubDecoder(config.id, config.type, caps)
				decoders.set(config.id, decoder)
				return decoder
			},
			caps,
		)
	}
	fanout = new FanoutManager(logger)
	manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 100,
		maxRestarts: 0,
		idleTimeout: 45_000,
		validateVersions: false,
	})
})

afterEach(async () => {
	await manager.destroy()
	fanout.destroy()
	vi.useRealTimers()
})

describe("idleTimeoutMs (request 4)", () => {
	it("reports the manager's effective idle timeout on every decoder", () => {
		create({ id: "a" })
		create({ id: "b", type: "external" })
		for (const status of manager.getAllStatus()) {
			expect(status.idleTimeoutMs).toBe(45_000)
		}
	})
})

describe("source binding and target (request 2)", () => {
	it("reports the configured sourceId for a stdin decoder that is not wired", () => {
		create({ id: "a", sourceId: "rtl-pi" })
		expect(manager.getStatus("a")?.sourceId).toBe("rtl-pi")
		expect(manager.getStatus("a")).not.toHaveProperty("deviceSerial")
	})

	it("omits sourceId for an external-SDR decoder and reports only its configured device serial", () => {
		create({
			id: "ext",
			type: "external",
			sourceId: "rtl-pi",
			deviceSerial: "00000003",
		})
		const status = manager.getStatus("ext")!
		expect(status).not.toHaveProperty("sourceId")
		expect(status.deviceSerial).toBe("00000003")
	})

	it("never invents a device hint when none is configured", () => {
		create({ id: "ext", type: "external" })
		expect(manager.getStatus("ext")).not.toHaveProperty("deviceSerial")
		expect(manager.getStatus("ext")).not.toHaveProperty("sourceId")
	})

	it("reports configured target frequencies and omits them when none are declared", () => {
		create({ id: "vdl", frequencies: [136_650_000, 136_975_000] })
		create({ id: "plain" })
		expect(manager.getStatus("vdl")?.targetFrequenciesHz).toEqual([
			136_650_000, 136_975_000,
		])
		expect(manager.getStatus("plain")).not.toHaveProperty("targetFrequenciesHz")
	})

	it("resolves frequencies from options and ignores invalid values", () => {
		const base = { id: "x", type: "t", enabled: true }
		expect(
			resolveDecoderTargetFrequencies({
				...base,
				options: { frequencies: [131_550_000] },
			}),
		).toEqual([131_550_000])
		expect(
			resolveDecoderTargetFrequencies({
				...base,
				options: { frequency: 869_525_000 },
			}),
		).toEqual([869_525_000])
		expect(
			resolveDecoderTargetFrequencies({
				...base,
				options: { frequencies: ["131.55", -1] },
			}),
		).toBeUndefined()
		expect(
			resolveDecoderTargetFrequencies({
				...base,
				frequencies: [1_090_000_000],
				options: { frequency: 5 },
			}),
		).toEqual([1_090_000_000])
	})
})

describe("lastError (request 3)", () => {
	it("is absent until something fails", () => {
		create({ id: "a" })
		expect(manager.getStatus("a")).not.toHaveProperty("lastError")
	})

	it("records an unexpected exit with code, signal and timestamp", async () => {
		vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"))
		const decoder = create({ id: "a" })
		await manager.startDecoder("a")
		decoder.crash(1)
		expect(manager.getStatus("a")?.lastError).toEqual({
			kind: "exit",
			message: "Process exited unexpectedly (code 1)",
			at: new Date("2026-10-08T12:00:00.000Z"),
		})
		decoder.crash(null, "SIGSEGV")
		expect(manager.getStatus("a")?.lastError?.message).toBe(
			"Process exited unexpectedly (signal SIGSEGV)",
		)
	})

	it("records decoder error events, bounded in size", async () => {
		const decoder = create({ id: "a" })
		manager.on("decoder:error", () => {})
		await manager.startDecoder("a")
		decoder.emit("error", new Error("x".repeat(5000)))
		const lastError = manager.getStatus("a")!.lastError!
		expect(lastError.kind).toBe("error")
		expect(lastError.message.length).toBe(DECODER_LAST_ERROR_MAX_LENGTH)
		expect(lastError.message.endsWith("…")).toBe(true)
	})

	it("is retained across automatic restarts so a crash loop keeps its cause visible", async () => {
		const decoder = create({ id: "a" })
		await manager.startDecoder("a")
		decoder.crash(2)
		await vi.advanceTimersByTimeAsync(10)
		expect(decoder.running).toBe(true)
		expect(manager.getStatus("a")).toMatchObject({
			running: true,
			restartCount: 1,
			lastError: {
				kind: "exit",
				message: "Process exited unexpectedly (code 2)",
			},
		})
	})

	it("keeps the real cause when an automatic restart fails to start", async () => {
		const decoder = create({ id: "a" })
		await manager.startDecoder("a")
		decoder.failStart = true
		decoder.crash(1)
		await vi.advanceTimersByTimeAsync(10)
		expect(manager.getStatus("a")?.lastError).toMatchObject({
			kind: "error",
			message: "spawn acarsdec ENOENT",
		})
	})

	it("is not recorded for an intentional stop", async () => {
		const decoder = create({ id: "a" })
		await manager.startDecoder("a")
		await manager.stopDecoder("a")
		decoder.crash(0)
		expect(manager.getStatus("a")).not.toHaveProperty("lastError")
	})

	it("records a failed start and clears on the next explicit start, like restartCount", async () => {
		const decoder = create({ id: "a" })
		decoder.failStart = true
		await expect(manager.startDecoder("a")).rejects.toThrow("ENOENT")
		expect(manager.getStatus("a")?.lastError).toMatchObject({
			kind: "error",
			message: "spawn acarsdec ENOENT",
		})
		decoder.failStart = false
		await manager.startDecoder("a")
		expect(manager.getStatus("a")).not.toHaveProperty("lastError")
		expect(manager.getStatus("a")?.restartCount).toBe(0)
	})

	it("normalizes non-Error values", () => {
		const at = new Date(0)
		expect(createDecoderLastError("boom", "error", at)).toEqual({
			kind: "error",
			message: "boom",
			at,
		})
		expect(createDecoderLastError(new Error(""), "error", at).message).toBe(
			"Error",
		)
	})
})
