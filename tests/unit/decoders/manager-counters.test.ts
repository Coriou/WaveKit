/**
 * Decoder frame counters through the manager: an adapter's "counters" events
 * become totals and rates on getStatus(), kept per decoder and forgotten with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { DecoderCounterEvent } from "../../../src/decoders/decoder-counters.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class StubDecoder extends EventEmitter implements Decoder {
	readonly output = new PassThrough({ objectMode: true })
	constructor(
		readonly id: string,
		readonly type: string,
		readonly caps: DecoderCaps,
	) {
		super()
	}
	async start() {
		this.emit("started")
	}
	async stop() {
		this.emit("stopped")
	}
	async restart() {}
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
			running: false,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
	report(event: DecoderCounterEvent) {
		this.emit("counters", event)
	}
}

const caps: DecoderCaps = {
	input: "iq",
	output: "jsonl",
	integrationPattern: "pure_consumer",
}

let manager: DecoderManager
let fanout: FanoutManager
const decoders = new Map<string, StubDecoder>()

beforeEach(() => {
	vi.useFakeTimers({ now: 1_000_000_000_000 })
	decoders.clear()
	const registry = new DecoderRegistry()
	registry.register(
		"stub",
		config => {
			const decoder = new StubDecoder(config.id, config.type, caps)
			decoders.set(config.id, decoder)
			return decoder
		},
		caps,
	)
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

describe("decoder counters in the manager", () => {
	it("reports no counters for a decoder that never sent any", () => {
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		expect(manager.getStatus("a")).not.toHaveProperty("counters")
	})

	it("folds counter events into totals and a minute rate", () => {
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		const stub = decoders.get("a")!
		stub.report({
			deltas: { preambles: 12, framesOk: 0 },
			latest: { preambles: 12, framesOk: 0 },
		})
		stub.report({
			deltas: { preambles: 3, framesOk: 0 },
			latest: { preambles: 15, framesOk: 0 },
		})
		expect(manager.getStatus("a")?.counters).toEqual({
			preambles: { total: 15, perMin: 15, latest: 15 },
			framesOk: { total: 0, perMin: 0, latest: 0 },
		})
		vi.advanceTimersByTime(2 * 60_000)
		expect(manager.getStatus("a")?.counters?.preambles).toEqual({
			total: 15,
			perMin: 0,
			latest: 15,
		})
	})

	it("forgets a removed decoder's counters", async () => {
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		decoders.get("a")!.report({ deltas: { framesOk: 2 }, latest: {} })
		await manager.removeDecoder("a")
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		expect(manager.getStatus("a")).not.toHaveProperty("counters")
	})

	it("survives a throwing record without breaking the decoder's other events", () => {
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		const stub = decoders.get("a")!
		expect(() =>
			stub.report(null as unknown as DecoderCounterEvent),
		).not.toThrow()
		stub.report({ deltas: { crcBad: 1 }, latest: { crcBad: 1 } })
		expect(manager.getStatus("a")?.counters?.crcBad?.total).toBe(1)
	})
})
