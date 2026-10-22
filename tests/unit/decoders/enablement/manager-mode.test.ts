import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type { DecoderMode } from "@wavekit/api-types"
import type { DecoderEnablementOptions } from "../../../../src/decoders/manager-options.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	vi.useRealTimers()
})

function setup(unavailable = false, enabled = true) {
	vi.useFakeTimers()
	let mode: DecoderMode = "auto"
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 162_000_000 })
	const registry = new DecoderRegistry()
	const decoder = new RateDecoder("dec", {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	})
	registry.register("rate-test", () => decoder, decoder.caps)
	const recheck = vi.fn(async () => !unavailable)
	const enablement: DecoderEnablementOptions = {
		// Built-ins run only through placements: plan a raw placement for "dec".
		planner: () => ({
			wanted: [
				{
					key: "dec#raw@rtl",
					decoderId: "dec",
					sourceId: "rtl",
					channelHz: null,
					reach: "raw",
					origin: "configured",
					primary: true,
					costCores: 0.1,
					sampleRateHz: 2_400_000,
				},
			],
			unplaced: new Map(),
		}),
		resolveMode: () => ({ mode, source: "settings" }),
		isCatalogue: () => true,
		unavailable: () => unavailable,
		recheckAvailable: recheck,
		vfo: () => null,
		bandplanChannels: () => [],
		maxBandplanChannels: 4,
	}
	const logger = pino({ level: "silent" })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		...(enabled ? { enablement } : {}),
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.createDecoder({
		id: "dec",
		type: "rate-test",
		enabled: true,
		options: {},
	})
	return {
		manager,
		decoder,
		sources,
		recheck,
		mode: (value: DecoderMode) => {
			mode = value
		},
		available: () => {
			unavailable = false
		},
	}
}

it("unavailable catalogue instance never spawns and never schedules a restart", async () => {
	const { manager, decoder, recheck } = setup(true)
	await manager.startAll()
	await vi.advanceTimersByTimeAsync(60_000)
	expect(decoder.starts).toBe(0)
	expect(recheck).not.toHaveBeenCalled()
	expect(manager.getStatus("dec")).toMatchObject({
		suspended: true,
		suspension: { reasonCode: "decoder-unavailable" },
	})
	expect(manager.getStatus("dec")?.nextRestartAt).toBeUndefined()
})

it("off stops now; leaving off starts with startMode auto", async () => {
	const { manager, decoder, mode } = setup()
	await manager.startDecoder("dec")
	mode("off")
	await manager.applyDecoderMode("dec", "off")
	expect(decoder.running).toBe(false)
	expect(manager.getStatus("dec")?.desiredRunning).toBe(false)
	mode("always")
	await manager.applyDecoderMode("dec", "always")
	expect(manager.getStatus("dec")?.startMode).toBe("auto")
	expect(decoder.running).toBe(true)
})

it("REST stop of always holds until start, mode change or restart and keeps the stored mode", async () => {
	const { manager, decoder, sources, mode } = setup()
	mode("always")
	await manager.startAll()
	await manager.stopDecoder("dec")
	sources.setCenter("rtl", 163_000_000)
	await vi.advanceTimersByTimeAsync(350)
	expect(decoder.running).toBe(false)
	expect(manager.getStatus("dec")?.mode).toBe("always")
	await manager.startDecoder("dec", { startMode: "operator" })
	expect(decoder.running).toBe(true)
})

it("REST start of an unavailable instance re-checks the binary: found starts it, still missing stays decoder-unavailable without spawning", async () => {
	const { manager, decoder, recheck, available } = setup(true)
	await manager.startDecoder("dec", { startMode: "operator" })
	expect(recheck).toHaveBeenCalledTimes(1)
	expect(decoder.starts).toBe(0)
	available()
	await manager.startDecoder("dec", { startMode: "operator" })
	expect(recheck).toHaveBeenCalledTimes(2)
	expect(decoder.starts).toBe(1)
})

it("without enablement options, existing manager tests are unchanged", async () => {
	const { manager, decoder } = setup(false, false)
	await manager.startAll()
	expect(decoder.starts).toBe(1)
	expect(manager.getStatus("dec")?.mode).toBeUndefined()
	expect(manager.getAllStatus()).toHaveLength(1)
})

it("restart in off mode preserves stopped parent intent", async () => {
	const { manager, decoder, mode } = setup()
	await manager.startDecoder("dec")
	mode("off")
	await manager.applyDecoderMode("dec", "off")
	await manager.restartDecoder("dec")
	expect(manager.getStatus("dec")?.desiredRunning).toBe(false)
	expect(decoder.running).toBe(false)
})
