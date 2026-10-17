/**
 * WG7 MA.1: the storage report's decoder list is the decoder manager's current
 * config-owned decoders, so a dsd-fme decoder created after startup adds its WAV
 * directory to the next report, and scanner probes never do.
 */
import { resolve } from "node:path"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { liveStorageReportSources } from "../../../../src/core/storage-report/areas-from-config.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { DecoderCaps } from "../../../../src/decoders/types.js"
import { RateDecoder } from "../../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const caps: DecoderCaps = {
	input: "audio_pcm",
	output: "text",
	integrationPattern: "pure_consumer",
}

let manager: DecoderManager

beforeEach(() => {
	const registry = new DecoderRegistry()
	registry.register("dsd-fme", config => new RateDecoder(config.id, caps), caps)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
})
afterEach(async () => {
	await manager.destroy()
})

function wavPaths(): readonly string[] | undefined {
	const sources = liveStorageReportSources({
		stateDir: "/state",
		activityMaxDbBytes: null,
		scannerStorage: { dir: null, maxRecordingsMb: 10, minFreeDiskMb: 0 },
		scanner: () => null,
		decoders: () => manager.getConfiguredDecoderConfigs(),
		accessDirectory: null,
	})
	return sources
		.areas()
		.find((a: StorageAreaSource) => a.id === "digital-voice-wav")?.paths
}

describe("storage report decoder list (WG7 MA.1)", () => {
	it("lists a decoder created after startup and drops it once removed", async () => {
		expect(wavPaths()).toEqual([])
		manager.createDecoder({
			id: "dmr-runtime",
			type: "dsd-fme",
			enabled: true,
			options: { output: "wav", wavDir: "/rec/runtime" },
		})
		expect(wavPaths()).toEqual([resolve("/rec/runtime")])
		expect(manager.getConfiguredDecoderConfigs().map(c => c.id)).toEqual([
			"dmr-runtime",
		])
		await manager.removeDecoder("dmr-runtime")
		expect(wavPaths()).toEqual([])
	})

	it("leaves scanner probes out of the list", async () => {
		await manager.createEphemeralDecoder(
			{
				id: "scan-j1-dmr-1",
				type: "dsd-fme",
				enabled: true,
				options: {
					enablePerCallRecording: true,
					perCallRecordingDir: "/state/scanner/j1",
				},
			},
			{ owner: "scanner", jobId: "j1", input: new PassThrough() },
		)
		expect(manager.getStatus("scan-j1-dmr-1")?.owner).toBe("scanner")
		expect(manager.getConfiguredDecoderConfigs()).toEqual([])
		expect(wavPaths()).toEqual([])
	})
})
