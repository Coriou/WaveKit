/**
 * WG3 req 5.2 (MA.2 lane P wiring): the decoder provenance index Main passes to
 * startActivityRuntime as `resolveProvenance`, driven by a real DecoderManager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	createDecoderProvenanceIndex,
	type DecoderProvenanceIndex,
} from "../../../src/decoders/provenance-bindings.js"
import { createActivityIngress } from "../../../src/core/activity/ingress.js"
import type { DecodeEnvelope } from "../../../src/core/activity/types.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class StubDecoder extends EventEmitter implements Decoder {
	readonly output = new PassThrough({ objectMode: true })
	running = false
	failStart = false
	constructor(
		readonly id: string,
		readonly type: string,
		readonly caps: DecoderCaps,
	) {
		super()
	}
	async start() {
		if (this.failStart) throw new Error("spawn acarsdec ENOENT")
		this.running = true
		this.emit("started")
	}
	async stop() {
		this.running = false
		this.emit("stopped")
	}
	async restart() {
		await this.stop()
		await this.start()
	}
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
			running: this.running,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
	crash(code: number | null, signal: string | null = null) {
		this.running = false
		this.emit("exit", code, signal)
	}
}

const stdinCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const externalCaps: DecoderCaps = {
	input: "external",
	output: "jsonl",
	integrationPattern: "external_sdr",
}

let manager: DecoderManager
let fanout: FanoutManager
const decoders = new Map<string, StubDecoder>()

function create(config: Partial<DecoderConfig> & { id: string }): StubDecoder {
	manager.createDecoder({
		type: "stdin",
		enabled: true,
		options: {},
		...config,
	})
	return decoders.get(config.id)!
}

beforeEach(() => {
	vi.useFakeTimers()
	decoders.clear()
	const registry = new DecoderRegistry()
	for (const [type, caps] of [
		["stdin", stdinCaps],
		["external", externalCaps],
	] as const) {
		registry.register(
			type,
			config => {
				const decoder = new StubDecoder(config.id, config.type, caps)
				decoders.set(config.id, decoder)
				return decoder
			},
			caps,
		)
	}
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
	index?.dispose()
	await manager.destroy()
	fanout.destroy()
	vi.useRealTimers()
})

let index: DecoderProvenanceIndex | undefined
let defaultSource: string | undefined = "sdr-main"

function open(): DecoderProvenanceIndex {
	index = createDecoderProvenanceIndex(manager, () => defaultSource)
	return index
}

describe("decoder provenance index (WG3 req 5.2)", () => {
	beforeEach(() => {
		defaultSource = "sdr-main"
	})

	it("binds decoders created before and after it opens; unknown ids are null", () => {
		create({ id: "early", sourceId: "sdr-b", frequencies: [131_550_000] })
		const { lookup } = open()
		create({ id: "late", options: { frequency: 1_090_000_000 } })
		expect(lookup("early")).toEqual({
			sourceId: "sdr-b",
			targetFrequenciesHz: [131_550_000],
			tuningTrust: "unverified",
		})
		expect(lookup("late")).toEqual({
			sourceId: "sdr-main",
			targetFrequenciesHz: [1_090_000_000],
			tuningTrust: "unverified",
		})
		expect(lookup("nobody")).toBeNull()
	})

	it("gives an external-input decoder no source and no invented targets", () => {
		create({ id: "ext", type: "external", sourceId: "sdr-b" })
		create({ id: "plain" })
		const { lookup } = open()
		expect(lookup("ext")).toEqual({
			sourceId: null,
			targetFrequenciesHz: [],
			tuningTrust: "unverified",
		})
		expect(lookup("plain")?.targetFrequenciesHz).toEqual([])
	})

	it("follows the default source at lookup time and reuses the binding object", () => {
		create({ id: "d" })
		const { lookup } = open()
		const first = lookup("d")
		expect(lookup("d")).toBe(first)
		defaultSource = "sdr-other"
		expect(lookup("d")?.sourceId).toBe("sdr-other")
		defaultSource = undefined
		expect(lookup("d")?.sourceId).toBeNull()
	})

	it("drops a removed decoder and binds its re-created successor", async () => {
		create({ id: "acars", frequencies: [131_550_000] })
		const { lookup } = open()
		await manager.removeDecoder("acars")
		expect(lookup("acars")).toBeNull()
		create({ id: "acars", sourceId: "sdr-b", frequencies: [131_725_000] })
		expect(lookup("acars")).toEqual({
			sourceId: "sdr-b",
			targetFrequenciesHz: [131_725_000],
			tuningTrust: "unverified",
		})
	})

	it("stops following the manager after dispose", () => {
		const idx = open()
		idx.dispose()
		create({ id: "after" })
		expect(idx.lookup("after")).toBeNull()
	})

	it("stamps a reception with the binding through the activity ingress", async () => {
		// The envelope validates real Date instances; fake timers replace Date.
		vi.useRealTimers()
		create({ id: "adsb", sourceId: "sdr-b", frequencies: [1_090_000_000] })
		const { lookup } = open()
		const seen: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				seen.push(envelope)
			},
			logger,
			now: () => new Date("2026-10-16T00:00:01.000Z"),
			randomUUID: () => "evt-1",
			resolveProvenance: lookup,
		})
		const reception = {
			timestamp: new Date("2026-10-16T00:00:00.000Z"),
			decoder: "adsb",
			type: "aircraft" as const,
			data: { icao: "abc123" },
		}
		ingress.publish("adsb", "readsb", reception)
		expect(seen.at(-1)?.provenance).toEqual({
			sourceId: "sdr-b",
			frequency: {
				hz: 1_090_000_000,
				basis: "channel",
				tuningTrust: "unverified",
			},
		})
		// A replaced decoder's new binding is what the next reception carries.
		await manager.removeDecoder("adsb")
		create({ id: "adsb", frequencies: [1_089_000_000, 1_090_000_000] })
		ingress.publish("adsb", "readsb", reception)
		expect(seen.at(-1)?.provenance).toEqual({
			sourceId: "sdr-main",
			frequency: null,
		})
		expect(ingress.counters().provenanceFailures).toBe(0)
	})
})
