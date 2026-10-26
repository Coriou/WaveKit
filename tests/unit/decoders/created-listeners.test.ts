/**
 * WG8 (web-gaps-8 req 3.2): `decoder:created` listeners treat a known id as a
 * replacement after a rebuild (rebinding, no duplicate subscription, no leak).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"
import { createDecoderProvenanceIndex } from "../../../src/decoders/provenance-bindings.js"
import { AmbientEvidence } from "../../../src/core/scanner/probes/ambient.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const CAPS = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
} as const

/** Reports type dsd-fme so the ambient watcher attaches its `link` listener. */
class DsdLike extends RateDecoder {
	override getStatus(): DecoderStatus {
		return { ...super.getStatus(), type: "dsd-fme" }
	}
}

let manager: DecoderManager
let instances: RateDecoder[]

beforeEach(() => {
	instances = []
	const registry = new DecoderRegistry()
	registry.register(
		"dsd-fme",
		config => {
			const d = new DsdLike(config.id, { ...CAPS })
			instances.push(d)
			return d
		},
		{ ...CAPS },
	)
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.createDecoder({
		id: "dec",
		type: "dsd-fme",
		enabled: true,
		options: { frequencies: [446_000_000] },
	})
})
afterEach(async () => {
	await manager.destroy()
})

describe("decoder:created listeners after a rebuild", () => {
	it("provenance bindings rebind the known id to the rebuilt targets", async () => {
		const index = createDecoderProvenanceIndex(manager, () => "rtl")
		expect(index.lookup("dec")?.targetFrequenciesHz).toEqual([446_000_000])
		manager.stageDecoderOptions("dec", { frequencies: [446_100_000] })
		await manager.startDecoder("dec")
		expect(instances).toHaveLength(2)
		expect(index.lookup("dec")?.targetFrequenciesHz).toEqual([446_100_000])
		// One listener each, not one per rebuild.
		expect(manager.listenerCount("decoder:created")).toBe(1)
		index.dispose()
		expect(manager.listenerCount("decoder:created")).toBe(0)
	})

	it("ambient evidence moves its link listener to the new instance", async () => {
		const ambient = new AmbientEvidence({
			decoders: manager,
			targetOf: () => null,
			epochOf: () => null,
			logger,
		})
		ambient.start()
		// Every instance also holds the manager's own listener (it binds placed lines).
		const ambientLinks = (d: { listenerCount(e: string): number }) =>
			d.listenerCount("link") - 1
		const old = instances[0]!
		expect(ambientLinks(old)).toBe(1)
		manager.stageDecoderOptions("dec", { frequencies: [446_100_000] })
		await manager.startDecoder("dec")
		const fresh = instances[1]!
		// a discarded instance keeps no listener at all
		expect(old.listenerCount("link")).toBe(0)
		expect(ambientLinks(fresh)).toBe(1)
		expect(ambient.watchedDecoderIds).toEqual(["dec"])
		manager.stageDecoderOptions("dec", { frequencies: [446_200_000] })
		await manager.restartDecoder("dec")
		expect(fresh.listenerCount("link")).toBe(0)
		expect(ambientLinks(instances[2]!)).toBe(1)
		ambient.stop()
		expect(ambientLinks(instances[2]!)).toBe(0)
	})
})
