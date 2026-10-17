/**
 * WG8 req 3.1 (Main wiring, src/index.ts): a decoder rebuilt at its next start (staged
 * settings) keeps its audio pipe and its digital-voice attachment, each exactly once, and the
 * replaced instance is released.
 */
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import pino from "pino"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { Config } from "../../../src/config.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type { Decoder, DecoderStatus } from "../../../src/decoders/types.js"
import {
	followRebuiltVoiceDecoders,
	wireDecoderAudioToOutput,
} from "../../../src/index.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const CAPS = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
} as const
const AUDIO_CONFIG = { audio: { monitoring: false } } as unknown as Config

class AudioDsd extends RateDecoder {
	readonly audio = new PassThrough()
	// RateDecoder declares `null`; the runtime contract is `Readable | null`.
	override getAudioOutput(): null {
		return this.audio as unknown as null
	}
	override getStatus(): DecoderStatus {
		return { ...super.getStatus(), type: "dsd-fme" }
	}
}

class FakeAudioOutput {
	source: Readable | null = null
	attachSource(source: Readable): void {
		this.source = source
	}
	detachSource(): void {
		this.source = null
	}
}

/** Mirrors DigitalVoiceService.attachDecoder: one voice-call listener, previous detached. */
class FakeVoice {
	readonly attached: Array<{ id: string; source: EventEmitter }> = []
	private detach: (() => void) | undefined
	attachDecoder(id: string, source: EventEmitter): void {
		this.detach?.()
		const listener = () => {}
		source.on("voice-call", listener)
		this.detach = () => source.off("voice-call", listener)
		this.attached.push({ id, source })
	}
}

function received(stream: Readable): Buffer[] {
	const chunks: Buffer[] = []
	stream.on("data", (c: Buffer) => chunks.push(c))
	return chunks
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

let manager: DecoderManager
let instances: AudioDsd[]

beforeEach(() => {
	instances = []
	const registry = new DecoderRegistry()
	registry.register(
		"dsd-fme",
		config => {
			const d = new AudioDsd(config.id, { ...CAPS })
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
})
afterEach(async () => {
	await manager.destroy()
})

describe("rebuilt decoder wiring in src/index.ts", () => {
	it("re-pipes audio to the rebuilt instance and re-attaches digital voice once", async () => {
		const voice = new FakeVoice()
		const attached = new Map<string, Decoder>()
		const first = manager.createDecoder({
			id: "dmr",
			type: "dsd-fme",
			enabled: true,
			options: { frequencies: [446_000_000] },
		})
		voice.attachDecoder("dmr", first as unknown as EventEmitter)
		attached.set("dmr", first)
		followRebuiltVoiceDecoders(manager, voice, attached)
		const output = new FakeAudioOutput()
		const cleanup = wireDecoderAudioToOutput(
			manager,
			{ addBranch: () => new PassThrough() },
			output,
			AUDIO_CONFIG,
			logger,
		)
		const combined = output.source
		if (combined === null) throw new Error("no combined stream")
		const chunks = received(combined)

		await manager.startDecoder("dmr")
		expect(instances).toHaveLength(1)
		instances[0]!.audio.write(Buffer.from([1]))
		await flush()
		expect(chunks.map(c => [...c])).toEqual([[1]])

		manager.stageDecoderOptions("dmr", { frequencies: [446_100_000] })
		await manager.restartDecoder("dmr")
		expect(instances).toHaveLength(2)
		const [old, rebuilt] = instances as [AudioDsd, AudioDsd]
		expect(manager.getDecoder("dmr")).toBe(rebuilt)

		// Digital voice follows the new instance exactly once; the old listener is gone.
		expect(voice.attached.map(a => a.source)).toEqual([first, rebuilt])
		expect(old.listenerCount("voice-call")).toBe(0)
		expect(rebuilt.listenerCount("voice-call")).toBe(1)

		// Audio: only the rebuilt instance reaches the combined stream, once.
		old.audio.write(Buffer.from([2]))
		rebuilt.audio.write(Buffer.from([3]))
		await flush()
		expect(chunks.map(c => [...c])).toEqual([[1], [3]])

		// A plain restart (no staging) does not re-attach.
		await manager.restartDecoder("dmr")
		expect(instances).toHaveLength(2)
		expect(voice.attached).toHaveLength(2)
		rebuilt.audio.write(Buffer.from([4]))
		await flush()
		expect(chunks.map(c => [...c])).toEqual([[1], [3], [4]])
		cleanup()
	})

	it("drops the replaced pipe on decoder:created even without decoder:stopped", async () => {
		const events = new EventEmitter()
		let current = new AudioDsd("dmr", { ...CAPS })
		current.running = true
		const fakeManager = {
			on: (event: string, fn: (...args: unknown[]) => void) =>
				events.on(event, fn),
			getDecoder: (id: string) => (id === "dmr" ? current : undefined),
			getAllDecoders: () => [current],
		} as unknown as Parameters<typeof wireDecoderAudioToOutput>[0]
		const output = new FakeAudioOutput()
		wireDecoderAudioToOutput(
			fakeManager,
			{ addBranch: () => new PassThrough() },
			output,
			AUDIO_CONFIG,
			logger,
		)
		const chunks = received(output.source!)
		const old = current
		current = new AudioDsd("dmr", { ...CAPS })
		events.emit("decoder:created", "dmr")
		events.emit("decoder:started", "dmr")
		old.audio.write(Buffer.from([7]))
		current.audio.write(Buffer.from([8]))
		await flush()
		expect(chunks.map(c => [...c])).toEqual([[8]])
		// A second started for the same instance never pipes twice
		events.emit("decoder:started", "dmr")
		current.audio.write(Buffer.from([9]))
		await flush()
		expect(chunks.map(c => [...c])).toEqual([[8], [9]])
	})

	it("never follows ids it did not attach at boot (scanner probes)", () => {
		const events = new EventEmitter()
		const probe = new AudioDsd("probe-1", { ...CAPS })
		const voice = new FakeVoice()
		followRebuiltVoiceDecoders(
			{
				on: (event: string, fn: (id: string) => void) => events.on(event, fn),
				getDecoder: () => probe,
			} as unknown as Parameters<typeof followRebuiltVoiceDecoders>[0],
			voice,
			new Map(),
		)
		events.emit("decoder:created", "probe-1")
		expect(voice.attached).toHaveLength(0)
	})
})
