/**
 * A paused receiver feed and channelizer-placed decoders: while paused a decoder fed by a channel
 * reads suspended with reason "source-paused" (also after the channelizer drops its channels on the
 * pause's disconnect), never a channel rejection or a failure, and runs on a fresh channel on resume.
 */
import pino from "pino"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	DecoderCaps,
	DecoderChannelRequestResult,
} from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"
import { FakeChannelProvider } from "../../mocks/channel-fakes.js"

const logger = pino({ level: "silent" })
const CENTER = 162e6
const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

class ChannelDecoder extends RateDecoder {
	getChannelRequest(): DecoderChannelRequestResult {
		return {
			centerHz: CENTER,
			bandwidthHz: 364_800,
			transitionHz: 9_600,
			outputRateHz: 384_000,
			format: "cu8",
		}
	}
}

/** FakeSources with the feed half of SourceManager, and the disconnect a pause emits. */
class PausableSources extends FakeSources {
	readonly paused = new Set<string>()
	isPaused(id: string): boolean {
		return this.paused.has(id)
	}
	pause(id: string): void {
		this.paused.add(id)
		this.emit("feed-changed", id, { state: "paused", since: "" })
		this.emit("disconnected", id)
	}
	resume(id: string): void {
		this.paused.delete(id)
		this.emit("feed-changed", id, { state: "live", since: "" })
		this.emit("connected", id)
	}
}

let sources: PausableSources
let provider: FakeChannelProvider
let manager: DecoderManager
let decoder: ChannelDecoder | undefined

const settle = () => vi.advanceTimersByTimeAsync(350)

beforeEach(() => {
	vi.useFakeTimers()
	sources = new PausableSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	const registry = new DecoderRegistry()
	registry.register(
		"chan-test",
		config => (decoder = new ChannelDecoder(config.id, caps)),
		caps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	provider = new FakeChannelProvider()
	manager.setChannelizer(provider)
})

afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

it("reads source-paused while paused, even after its channel is dropped, and resumes on a new channel", async () => {
	manager.createDecoder({
		id: "dec",
		type: "chan-test",
		enabled: true,
		sourceId: "rtl",
		options: {},
		useChannelizer: true,
	})
	await manager.startDecoder("dec")
	expect(decoder?.running).toBe(true)
	expect(provider.calls).toHaveLength(1)

	sources.pause("rtl")
	// The channelizer drops the source's channels on the pause's disconnect.
	provider.invalidate("rtl", ["dec-g1"])
	await settle()
	const paused = manager.getStatus("dec")!
	expect(paused).toMatchObject({
		suspended: true,
		desiredRunning: true,
		restartCount: 0,
		suspension: { reasonCode: "source-paused" },
	})
	expect(paused.lastError ?? null).toBeNull()
	expect(decoder?.running).toBe(false)
	// No channel is asked of a paused source.
	expect(provider.calls).toHaveLength(1)

	sources.resume("rtl")
	await settle()
	const resumed = manager.getStatus("dec")!
	expect(resumed.suspended ?? false).toBe(false)
	expect(resumed.restartCount).toBe(0)
	expect(decoder?.running).toBe(true)
	expect(provider.calls).toHaveLength(2)
})
