/**
 * A paused receiver feed (POST /api/sources/:id/pause) suspends the configured decoders on
 * that source with reason "source-paused" until it is resumed; it outranks a scanner hold,
 * and a start on a paused feed is recorded and suspended, never refused.
 */
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const iqDecoderCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

/** FakeSources with the feed half of SourceManager: isPaused and "feed-changed". */
class PausableSources extends FakeSources {
	readonly paused = new Set<string>()
	isPaused(id: string): boolean {
		return this.paused.has(id)
	}
	pause(id: string): void {
		this.paused.add(id)
		this.emit("feed-changed", id, { state: "paused", since: "" })
	}
	resume(id: string): void {
		this.paused.delete(id)
		this.emit("feed-changed", id, { state: "live", since: "" })
	}
}

let sources: PausableSources
let manager: DecoderManager
let decoders: Map<string, RateDecoder>

const flush = async () => {
	for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
}

function createConfigured(id = "dmr", sourceId = "rtl"): RateDecoder {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		sourceId,
		options: {},
	})
	return decoders.get(id)!
}

beforeEach(() => {
	vi.useFakeTimers()
	sources = new PausableSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	sources.caps.set("other", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			const decoder = new RateDecoder(config.id, iqDecoderCaps)
			decoders.set(config.id, decoder)
			return decoder
		},
		iqDecoderCaps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})

afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("source-paused suspension", () => {
	it("suspends the source's decoders on pause and resumes them on resume", async () => {
		const decoder = createConfigured()
		const elsewhere = createConfigured("ais", "other")
		await manager.startDecoder("dmr")
		await manager.startDecoder("ais")

		sources.pause("rtl")
		await flush()
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "source-paused" },
			desiredRunning: true,
		})
		// Another source's decoder is untouched.
		expect(elsewhere.running).toBe(true)
		expect(manager.getStatus("ais")?.suspended).toBe(false)

		sources.resume("rtl")
		await flush()
		expect(decoder.running).toBe(true)
		expect(decoder.starts).toBe(2)
		expect(manager.getStatus("dmr")?.suspended).toBe(false)
	})

	it("outranks a scanner hold; the hold's reason returns after resume", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		sources.pause("rtl")
		await flush()
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"source-paused",
		)
		sources.resume("rtl")
		await flush()
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"tuner-scanning",
		)
		await manager.releaseSource("rtl", "j1")
		expect(decoder.running).toBe(true)
	})

	it("records a start on a paused feed as suspended instead of refusing it", async () => {
		const decoder = createConfigured()
		sources.pause("rtl")
		await flush()
		await manager.restartDecoder("dmr", { refuseIfHeld: true })
		await flush()
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspension: { reasonCode: "source-paused" },
		})
		sources.resume("rtl")
		await flush()
		expect(decoder.running).toBe(true)
	})

	it("stops listening for feed changes once destroyed", async () => {
		createConfigured()
		await manager.destroy()
		expect(sources.listenerCount("feed-changed")).toBe(0)
		// afterEach destroys again; a second destroy is harmless.
	})
})
