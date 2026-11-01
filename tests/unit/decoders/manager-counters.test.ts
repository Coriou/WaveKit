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
import type { SourceManager } from "../../../src/core/source-manager.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"
import {
	COUNTER_FLUSH_MS,
	DecoderCounterReporter,
	LISTENING_FENCE_MS,
	receptionHint,
	type DecoderCounterEvent,
} from "../../../src/decoders/decoder-counters.js"
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
			preambles: { total: 15, perMin: 15, latest: 15, listening: 15 },
			framesOk: { total: 0, perMin: 0, latest: 0, listening: 0 },
		})
		vi.advanceTimersByTime(2 * 60_000)
		expect(manager.getStatus("a")?.counters?.preambles).toEqual({
			total: 15,
			perMin: 0,
			latest: 15,
			listening: 15,
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

describe("listening periods in the manager", () => {
	it("starts a new listening period when the decoder restarts, keeping totals", async () => {
		manager.createDecoder({ id: "a", type: "stub", enabled: true, options: {} })
		await manager.startDecoder("a")
		const stub = decoders.get("a")!
		stub.report({
			deltas: { preambles: 1, framesOk: 0 },
			latest: { preambles: 1, framesOk: 0 },
		})
		expect(receptionHint(manager.getStatus("a")?.counters)).toBe(
			"heard-undecoded",
		)
		await manager.restartDecoder("a")
		for (let minute = 0; minute < 5; minute++) {
			vi.advanceTimersByTime(60_000)
			stub.report({
				deltas: { preambles: 0, framesOk: 0 },
				latest: { preambles: 0, framesOk: 0 },
			})
		}
		const counters = manager.getStatus("a")?.counters
		expect(receptionHint(counters)).toBe("nothing-heard")
		expect(counters?.preambles).toMatchObject({ total: 1, listening: 0 })
	})
	it("starts a new listening period when a whole-source decoder's centre moves without a restart", async () => {
		const sources = new FakeSources()
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
		const registry = new DecoderRegistry()
		let passive: RateDecoder | undefined
		registry.register(
			"dsd-fme",
			config => {
				passive = new RateDecoder(config.id, caps)
				return passive
			},
			caps,
		)
		const own = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{
				restartDelay: 10,
				maxRestartDelay: 100,
				validateVersions: false,
			},
		)
		try {
			own.setSourceManager(sources as unknown as SourceManager)
			own.createDecoder({
				id: "voice",
				type: "dsd-fme",
				enabled: true,
				sourceId: "rtl",
				options: {},
			})
			await own.startDecoder("voice")
			expect(passive?.starts).toBe(1)
			passive!.emit("counters", {
				deltas: { detections: 3, framesOk: 0 },
				latest: { detections: 3, framesOk: 0 },
			})
			sources.setCenter("rtl", 446_100_000)
			await vi.advanceTimersByTimeAsync(350)
			// dsd-fme takes a centre move without a restart.
			expect(passive?.starts).toBe(1)
			const counters = own.getStatus("voice")?.counters
			expect(counters?.detections).toMatchObject({ total: 3, listening: 0 })
			expect(receptionHint(counters)).toBe("nothing-heard")
		} finally {
			await own.destroy()
		}
	})

	it("flushes a centre move's pending counts into the old period and fences the tool's next interval", async () => {
		const sources = new FakeSources()
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
		const registry = new DecoderRegistry()
		let passive: RateDecoder | undefined
		let counts: DecoderCounterReporter | undefined
		registry.register(
			"dsd-fme",
			config => {
				const decoder = new RateDecoder(config.id, caps)
				const reporter = new DecoderCounterReporter(event =>
					decoder.emit("counters", event),
				)
				passive = decoder
				counts = reporter
				return Object.assign(decoder, { flushCounters: () => reporter.flush() })
			},
			caps,
		)
		const own = new DecoderManager(
			registry,
			new FanoutManager(logger),
			logger,
			{ restartDelay: 10, maxRestartDelay: 100, validateVersions: false },
		)
		try {
			own.setSourceManager(sources as unknown as SourceManager)
			own.createDecoder({
				id: "voice",
				type: "dsd-fme",
				enabled: true,
				sourceId: "rtl",
				options: {},
			})
			await own.startDecoder("voice")
			counts!.count("framesOk", 0)
			counts!.count("detections")
			// The sync is still batched when the centre moves.
			sources.setCenter("rtl", 446_100_000)
			await vi.advanceTimersByTimeAsync(350)
			expect(passive?.starts).toBe(1)
			await vi.advanceTimersByTimeAsync(COUNTER_FLUSH_MS)
			let counters = own.getStatus("voice")?.counters
			expect(counters?.detections).toMatchObject({ total: 1, listening: 0 })
			expect(receptionHint(counters)).toBe("nothing-heard")
			// A sync counted after the move is new air.
			counts!.count("detections")
			counts!.flush()
			expect(own.getStatus("voice")?.counters?.detections).toMatchObject({
				total: 2,
				listening: 1,
			})
			// A tool interval report inside the fence counts toward totals only.
			sources.setCenter("rtl", 446_200_000)
			await vi.advanceTimersByTimeAsync(350)
			passive!.emit("counters", {
				deltas: { detections: 5 },
				latest: { detections: 5 },
			})
			counters = own.getStatus("voice")?.counters
			expect(counters?.detections).toMatchObject({ total: 7, listening: 0 })
			await vi.advanceTimersByTimeAsync(LISTENING_FENCE_MS)
			passive!.emit("counters", {
				deltas: { detections: 1 },
				latest: { detections: 1 },
			})
			counters = own.getStatus("voice")?.counters
			expect(counters?.detections).toMatchObject({ total: 8, listening: 1 })
			expect(receptionHint(counters)).toBe("heard-undecoded")
		} finally {
			await own.destroy()
		}
	})
})
