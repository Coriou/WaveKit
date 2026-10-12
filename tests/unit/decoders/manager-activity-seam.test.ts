import { EventEmitter } from "node:events"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class ControlledDecoder extends EventEmitter implements Decoder {
	readonly caps: DecoderCaps = {
		input: "audio_pcm",
		output: "text",
		integrationPattern: "pure_consumer",
	}
	readonly output = new PassThrough({ objectMode: true })
	constructor(
		readonly id: string,
		readonly type: string,
	) {
		super()
	}
	async start() {}
	async stop() {}
	async restart() {}
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
			running: false,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
}

function sampleOutput(): DecoderOutput {
	return {
		decoder: "adsb-1",
		timestamp: new Date("2026-10-12T00:00:00.000Z"),
		type: "aircraft",
		data: { icao: "abc123" },
	}
}

describe("DecoderManager activity publication seam", () => {
	const managers: DecoderManager[] = []

	afterEach(async () => {
		await Promise.all(managers.splice(0).map(manager => manager.destroy()))
	})

	function setup(): { manager: DecoderManager; decoder: ControlledDecoder } {
		const decoder = new ControlledDecoder("adsb-1", "readsb")
		const registry = new DecoderRegistry()
		registry.register("readsb", () => decoder, decoder.caps)
		const fanout = new FanoutManager(logger)
		const manager = new DecoderManager(registry, fanout, logger, {
			validateVersions: false,
			healthCheckInterval: 60_000,
		})
		managers.push(manager)
		manager.createDecoder({
			id: "adsb-1",
			type: "readsb",
			enabled: true,
			options: {},
		})
		return { manager, decoder }
	}

	it("gives legacy listeners the same arguments and order with or without a publisher", () => {
		const { manager, decoder } = setup()
		const order: string[] = []
		const legacy: unknown[][] = []
		manager.on("decoder:output", (...args: unknown[]) => {
			order.push("first")
			legacy.push(args)
		})
		manager.on("decoder:output", (...args: unknown[]) => {
			order.push("second")
			legacy.push(args)
		})
		const first = sampleOutput()
		decoder.emit("output", first)
		expect(order).toEqual(["first", "second"])
		expect(legacy).toEqual([
			["adsb-1", first],
			["adsb-1", first],
		])

		const published: unknown[][] = []
		manager.setActivityPublisher((decoderId, decoderType, output) => {
			order.push("publisher")
			published.push([decoderId, decoderType, output])
		})
		const second = sampleOutput()
		decoder.emit("output", second)
		expect(order).toEqual(["first", "second", "first", "second", "publisher"])
		expect(legacy.slice(2)).toEqual([
			["adsb-1", second],
			["adsb-1", second],
		])
		expect(published).toEqual([["adsb-1", "readsb", second]])
		expect(manager.getStatus("adsb-1")?.health).toBe("running")
	})

	it("keeps health and legacy delivery when the publisher throws", () => {
		const { manager, decoder } = setup()
		const health = vi.fn()
		const received: unknown[][] = []
		manager.on("decoder:health", health)
		manager.on("decoder:output", (...args: unknown[]) => {
			received.push(args)
		})
		manager.setActivityPublisher(() => {
			throw new Error("activity down")
		})
		const output = sampleOutput()
		expect(() => decoder.emit("output", output)).not.toThrow()
		expect(() => decoder.emit("output", output)).not.toThrow()
		expect(received).toEqual([
			["adsb-1", output],
			["adsb-1", output],
		])
		expect(health).not.toHaveBeenCalled()
		expect(manager.getStatus("adsb-1")).toMatchObject({
			health: "running",
			restartCount: 0,
		})
	})

	it("stops publishing when the hook is cleared", () => {
		const { manager, decoder } = setup()
		const published = vi.fn()
		manager.setActivityPublisher(published)
		decoder.emit("output", sampleOutput())
		manager.setActivityPublisher(null)
		decoder.emit("output", sampleOutput())
		expect(published).toHaveBeenCalledTimes(1)
		expect(published).toHaveBeenCalledWith(
			"adsb-1",
			"readsb",
			expect.objectContaining({ decoder: "adsb-1", type: "aircraft" }),
		)
	})
})
