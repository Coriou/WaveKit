import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import {
	MULTIMON_CAPS,
	createMultimonDecoder,
} from "../../../../src/decoders/builtin/multimon-ng.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import { FakeSources, iqCaps } from "../../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
let manager: DecoderManager
let built: Decoder[]

beforeEach(() => {
	built = []
	const registry = new DecoderRegistry()
	registry.register(
		"multimon-ng",
		config => {
			const decoder = createMultimonDecoder(config, logger)
			// No process: only the planned pipeline is inspected.
			decoder.start = async () => undefined
			decoder.stop = async () => undefined
			built.push(decoder)
			return decoder
		},
		MULTIMON_CAPS,
	)
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: 446_000_000 })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})

afterEach(async () => {
	await manager.destroy()
})

const argvOf = (d: Decoder): string =>
	(d as unknown as { getArgs(): string[] }).getArgs().join(" ")

// WG11 req 6.5: the replay probe feeds cf32 at the capture rate; the source rate must not leak in.
describe("ephemeral cf32 input probe on a 2.048 Msps source", () => {
	it("keeps the capture rate: no spurious resample stage", async () => {
		await manager.createEphemeralDecoder(
			{
				id: "replay-1",
				type: "multimon-ng",
				enabled: true,
				sourceId: "rtl",
				options: {
					channelHz: 446_125_000,
					inputIqFormat: "cf32",
					inputSampleRate: 48_000,
				},
			},
			{ owner: "scanner", jobId: "j1", input: new PassThrough() },
		)
		const pipeline = argvOf(built[0]!)
		expect(pipeline).not.toContain("47628")
		expect(pipeline).not.toContain("2048000")
		expect(pipeline).toContain(
			"sox -t raw -r 48000 -e signed -b 16 -c 1 - -t raw -r 22050",
		)
	})

	it("still applies the source rate to a raw (non cf32) caller input", async () => {
		await manager.createEphemeralDecoder(
			{
				id: "offset-1",
				type: "multimon-ng",
				enabled: true,
				sourceId: "rtl",
				options: { offsetHz: 125_000 },
			},
			{ owner: "scanner", jobId: "j1", input: new PassThrough() },
		)
		expect(argvOf(built[0]!)).toContain("csdr")
		expect(
			(built[0] as unknown as { config: { options: Record<string, unknown> } })
				.config.options["inputSampleRate"],
		).toBe(2_048_000)
	})
})
