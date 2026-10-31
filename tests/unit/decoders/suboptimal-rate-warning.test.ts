/**
 * R5: "Decoder running with suboptimal sample rate" is logged once per
 * decoder and rate, not on every source evaluation.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const DEBOUNCE = 350
const PREFERRED_HZ = 1_200_000
const MESSAGE = "Decoder running with suboptimal sample rate"
let sources: FakeSources
let manager: DecoderManager
let warn: ReturnType<typeof vi.fn>

beforeEach(() => {
	vi.useFakeTimers()
	sources = new FakeSources()
	sources.caps.set("rtl", iqCaps(2_400_000))
	const caps: DecoderCaps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
		preferredSampleRates: [PREFERRED_HZ],
	}
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => new RateDecoder(config.id, caps),
		caps,
	)
	warn = vi.fn()
	const logger = pino({
		level: "silent",
		onChild(child) {
			vi.spyOn(child, "warn").mockImplementation(warn)
		},
	})
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

/** The rates warned about, in order. */
function warnedRates(): number[] {
	return warn.mock.calls
		.filter(call => call[1] === MESSAGE)
		.map(call => (call[0] as { currentSampleRate: number }).currentSampleRate)
}

async function rate(hz: number) {
	sources.setRate("rtl", hz)
	await vi.advanceTimersByTimeAsync(DEBOUNCE)
}

it("warns once per decoder and rate, and again when the rate returns", async () => {
	manager.createDecoder({
		id: "dec",
		type: "rate-test",
		enabled: true,
		options: {},
	})
	await manager.startDecoder("dec")
	for (let i = 0; i < 5; i++) await rate(2_400_000)
	expect(warnedRates()).toEqual([2_400_000])
	await rate(1_800_000)
	await rate(1_800_000)
	expect(warnedRates()).toEqual([2_400_000, 1_800_000])
	// A different rate, then the first one again: it warns again.
	await rate(2_400_000)
	expect(warnedRates()).toEqual([2_400_000, 1_800_000, 2_400_000])
	// A preferred rate warns nothing and re-arms the warning.
	await rate(PREFERRED_HZ)
	await rate(2_400_000)
	expect(warnedRates()).toEqual([2_400_000, 1_800_000, 2_400_000, 2_400_000])
})

it("re-arms when the rate changes while the decoder is suspended", async () => {
	manager.createDecoder({
		id: "dec",
		type: "rate-test",
		enabled: true,
		options: {},
	})
	await manager.startDecoder("dec")
	await rate(2_400_000)
	expect(warnedRates()).toEqual([2_400_000])
	// An unusable rate suspends the decoder: it is not adapted, so no warning.
	await rate(20_000)
	expect(manager.getStatus("dec")?.suspended).toBe(true)
	await rate(2_400_000)
	expect(manager.getStatus("dec")?.suspended).toBe(false)
	await rate(2_400_000)
	expect(warnedRates()).toEqual([2_400_000, 2_400_000])
})

it("keys the warning per decoder", async () => {
	for (const id of ["a", "b"])
		manager.createDecoder({ id, type: "rate-test", enabled: true, options: {} })
	await manager.startDecoder("a")
	await manager.startDecoder("b")
	await rate(2_400_000)
	await rate(2_400_000)
	const ids = warn.mock.calls
		.filter(call => call[1] === MESSAGE)
		.map(call => (call[0] as { decoderId: string }).decoderId)
	expect(ids.sort()).toEqual(["a", "b"])
})
