import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const SOURCE_RATE = 2_400_000
const caps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}

/** In-process adapter: retain the options actually injected by the real manager. */
class ClockDecoder extends RateDecoder {
	options: Record<string, unknown> = {}
	override updateOptions(updates: Record<string, unknown>): void {
		Object.assign(this.options, updates)
	}
}

let manager: DecoderManager
let fanout: FanoutManager

beforeEach(() => {
	const logger = pino({ level: "silent" })
	const sources = new FakeSources()
	sources.caps.set("isolated", iqCaps(SOURCE_RATE))
	const registry = new DecoderRegistry()
	for (const type of ["dumpvdl2", "lora-meshtastic"]) {
		registry.register(
			type,
			config => {
				const decoder = new ClockDecoder(config.id, caps)
				decoder.updateOptions(config.options)
				return decoder
			},
			caps,
		)
	}
	fanout = new FanoutManager(logger)
	manager = new DecoderManager(registry, fanout, logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})

afterEach(async () => {
	await manager.destroy()
})

describe("DecoderManager replay input clock", () => {
	it.each([
		{ type: "dumpvdl2", replayRate: 105_000 },
		{ type: "lora-meshtastic", replayRate: 250_000 },
	])(
		"preserves $type replay clock but injects the live source clock",
		async ({ type, replayRate }) => {
			const config = {
				id: "replay",
				type,
				enabled: true,
				sourceId: "isolated",
				// U8 replay must exercise the type guard, not the existing cf32 guard.
				options: { inputSampleRate: replayRate, inputIqFormat: "cu8" },
			}
			const input = new PassThrough()
			try {
				const replay = (await manager.createEphemeralDecoder(config, {
					owner: "scanner",
					jobId: "isolated-job",
					input,
				})) as ClockDecoder
				const live = manager.createDecoder({
					...config,
					id: "live",
				}) as ClockDecoder
				await manager.startDecoder("live")

				expect(replay.running).toBe(true)
				expect(replay.input).toBe(input)
				expect(replay.options["inputSampleRate"]).toBe(replayRate)
				expect(live.running).toBe(true)
				expect(live.input).not.toBeNull()
				expect(live.input).not.toBe(input)
				expect(live.options["inputSampleRate"]).toBe(SOURCE_RATE)
				expect(fanout.getBranchIds()).toEqual(["decoder-live"])
			} finally {
				input.destroy()
			}
		},
	)
})
