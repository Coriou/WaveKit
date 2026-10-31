/**
 * The LoRa wrapper holds its slot's offset from the capture centre as `--shift-hz`, so a
 * fixed-slot LoRa decoder restarts when the centre moves (the argv carries the new offset),
 * and keeps running when the caps change without a centre move.
 */
import pino from "pino"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps, DecoderConfig } from "../../../src/decoders/types.js"
import {
	buildDecoderArgs,
	parseLoraMeshtasticOptions,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

// Caps-change debounce of the manager (CAPS_CHANGE_DEBOUNCE_MS).
const DEBOUNCE_MS = 300
const SLOT_HZ = 869_525_000
const caps: DecoderCaps = {
	input: "iq",
	output: "jsonl",
	integrationPattern: "pure_consumer",
}

class OptionsDecoder extends RateDecoder {
	options: Record<string, unknown> = {}
	override updateOptions(updates: Record<string, unknown>): void {
		this.options = { ...this.options, ...updates }
	}
	/** The wrapper argv the real adapter would build from these options. */
	shiftArg(): string | undefined {
		const args = buildDecoderArgs(parseLoraMeshtasticOptions(this.options))
		return args[args.indexOf("--shift-hz") + 1]
	}
}

let manager: DecoderManager
let sources: FakeSources
let decoder: OptionsDecoder

beforeEach(() => {
	vi.useFakeTimers()
	const logger = pino({ level: "silent" })
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(1_024_000), centerFreq: 869_500_000 })
	const registry = new DecoderRegistry()
	registry.register(
		"lora-meshtastic",
		(config: DecoderConfig) => {
			decoder = new OptionsDecoder(config.id, caps)
			decoder.options = { ...config.options }
			return decoder
		},
		caps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})

afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

function create(options: Record<string, unknown> = {}): void {
	manager.createDecoder({
		id: "lora",
		type: "lora-meshtastic",
		enabled: true,
		sourceId: "rtl",
		options: {
			region: "EU_868",
			preset: "LongFast",
			frequency: SLOT_HZ,
			channelKey: "AQ==",
			...options,
		},
	})
}

it("a fixed slot restarts with the new --shift-hz when the centre moves", async () => {
	create()
	await manager.startDecoder("lora")
	expect(decoder.starts).toBe(1)
	// 869.525 - 869.500 MHz: the slot sits 25 kHz above the centre.
	expect(decoder.shiftArg()).toBe("25000")
	sources.setCenter("rtl", 869_570_000)
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
	expect(decoder.options["inputCenterFreq"]).toBe(869_570_000)
	expect(decoder.shiftArg()).toBe("-45000")
	expect(decoder.starts).toBe(2)
	expect(decoder.running).toBe(true)
})

it("a fixed slot keeps running when the caps change without a centre move", async () => {
	create()
	await manager.startDecoder("lora")
	sources.setCenter("rtl", 869_500_000)
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
	expect(decoder.starts).toBe(1)
	expect(decoder.shiftArg()).toBe("25000")
})

it("followCenter restarts on a centre move and decodes the centre (shift 0)", async () => {
	create({ followCenter: true })
	await manager.startDecoder("lora")
	sources.setCenter("rtl", 869_570_000)
	await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
	expect(decoder.starts).toBe(2)
	expect(decoder.shiftArg()).toBe("0")
})
