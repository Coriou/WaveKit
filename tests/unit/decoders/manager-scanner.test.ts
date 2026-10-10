// tests/unit/decoders/manager-scanner.test.ts
/**
 * Signal discovery spec § 6.5 and § 10.4: scanner probes are runtime-only
 * decoders with their own input, and a sweep holds configured decoders on
 * its source once instead of suspending and resuming them on every hop.
 */
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const DEBOUNCE = 350
const iqDecoderCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
let sources: FakeSources
let manager: DecoderManager
let decoders: Map<string, RateDecoder>
let created: string[]
let removed: string[]
let restarting: string[]

/**
 * Mirrors BaseDecoder's input handling (base-decoder.ts attachInput/start):
 * attachInput adds a `data` listener, so the stream starts flowing on the
 * next tick, and pipes to stdin only once a process exists; the process is
 * spawned after an await inside start().
 */
class StdinDecoder extends RateDecoder {
	readonly stdinBytes: Buffer[] = []
	trackedBytes = 0
	private stdin: PassThrough | null = null
	private readonly track = (chunk: Buffer): void => {
		this.trackedBytes += chunk.length
	}
	override async start(): Promise<void> {
		await new Promise<void>(resolve => process.nextTick(resolve)) // spawn
		await super.start()
		this.stdin = new PassThrough()
		this.stdin.on("data", (chunk: Buffer) => this.stdinBytes.push(chunk))
		this.input?.pipe(this.stdin)
	}
	override attachInput(input: Readable): void {
		super.attachInput(input)
		input.on("data", this.track)
		if (this.stdin) input.pipe(this.stdin)
	}
	override detachInput(): void {
		if (this.input && this.stdin) this.input.unpipe(this.stdin)
		this.input?.off("data", this.track)
		super.detachInput()
	}
}

const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE)
const ticks = async (n = 10) => {
	for (let i = 0; i < n; i++)
		await new Promise<void>(resolve => process.nextTick(resolve))
}
function createConfigured(id = "dmr") {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		sourceId: "rtl",
		options: { input: "iq" },
	})
	return decoders.get(id)!
}
function probeConfig(id = "scan-j1-dmr-1") {
	return {
		id,
		type: "rate-test",
		enabled: true,
		sourceId: "rtl",
		options: { input: "iq" },
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			const decoder = new RateDecoder(config.id, {
				input: config.options["input"] as DecoderCaps["input"],
				output: "text",
				integrationPattern: "pure_consumer",
			})
			decoders.set(config.id, decoder)
			return decoder
		},
		iqDecoderCaps,
	)
	registry.register(
		"stdin-test",
		config => {
			const decoder = new StdinDecoder(config.id, iqDecoderCaps)
			decoders.set(config.id, decoder)
			return decoder
		},
		iqDecoderCaps,
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	created = []
	removed = []
	restarting = []
	manager.on("decoder:created", (id: string) => created.push(id))
	manager.on("decoder:removed", (id: string) => removed.push(id))
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("ephemeral scanner probes", () => {
	it("starts on the scanner's input, reports owner/job/ephemeral, and emits created", async () => {
		const input = new PassThrough()
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input,
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		expect(probe.running).toBe(true)
		expect(probe.input).toBe(input)
		expect(manager.getStatus("scan-j1-dmr-1")).toMatchObject({
			owner: "scanner",
			scannerJobId: "j1",
			ephemeral: true,
			sourceId: "rtl",
			desiredRunning: true,
		})
		expect(created).toEqual(["scan-j1-dmr-1"])
	})

	it("pipes the pre-roll buffered before the spawn to the process (spec § 6.5)", async () => {
		const input = new PassThrough()
		const preRoll = Buffer.alloc(4096, 1)
		input.write(preRoll) // the probe pool writes the pre-roll before creating the probe
		await manager.createEphemeralDecoder(
			{ ...probeConfig("scan-pre"), type: "stdin-test" },
			{ owner: "scanner", jobId: "j1", input },
		)
		const live = Buffer.alloc(1024, 2)
		input.write(live)
		await ticks()
		const probe = decoders.get("scan-pre") as StdinDecoder
		expect(Buffer.concat(probe.stdinBytes)).toEqual(
			Buffer.concat([preRoll, live]),
		)
		expect(probe.trackedBytes).toBe(preRoll.length + live.length)
	})

	it("configured decoders report owner config and no probe fields", () => {
		createConfigured()
		const status = manager.getStatus("dmr")!
		expect(status.owner).toBe("config")
		expect(status.ephemeral).toBeUndefined()
		expect(status.scannerJobId).toBeUndefined()
		expect(created).toEqual(["dmr"])
	})

	it("rejects an id that already exists", async () => {
		createConfigured("scan-j1-dmr-1")
		await expect(
			manager.createEphemeralDecoder(probeConfig(), {
				owner: "scanner",
				jobId: "j1",
			}),
		).rejects.toMatchObject({ code: "DECODER_EXISTS" })
	})

	it("a failed start removes the probe and rethrows", async () => {
		const registry = (manager as unknown as { registry: DecoderRegistry })
			.registry
		registry.register(
			"failing",
			config => {
				const decoder = new RateDecoder(config.id, iqDecoderCaps)
				decoder.failStart = true
				return decoder
			},
			iqDecoderCaps,
		)
		await expect(
			manager.createEphemeralDecoder(
				{ ...probeConfig("scan-x"), type: "failing" },
				{ owner: "scanner", jobId: "j1" },
			),
		).rejects.toThrow("spawn failed")
		expect(manager.getStatus("scan-x")).toBeUndefined()
		expect(removed).toEqual(["scan-x"])
		expect(sources.assignments.has("scan-x")).toBe(false)
	})

	it("is not suspended, resumed or restarted by caps changes", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		sources.setRate("rtl", 20_000) // unusable for configured decoders
		await settle()
		sources.setCenter("rtl", 447_000_000)
		await settle()
		expect(probe.starts).toBe(1)
		expect(probe.stops).toBe(0)
		expect(manager.getStatus("scan-j1-dmr-1")?.suspended).toBe(false)
	})

	it("is never auto-restarted after it exits", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		probe.crash()
		await vi.advanceTimersByTimeAsync(200)
		expect(restarting).toEqual([])
		expect(probe.starts).toBe(1)
		expect(probe.input).toBeNull()
		expect(manager.getStatus("scan-j1-dmr-1")).toMatchObject({
			health: "faulted",
			desiredRunning: false,
		})
	})

	it("removeEphemeralDecoder stops, detaches, releases the source and emits removed", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		await manager.removeEphemeralDecoder("scan-j1-dmr-1")
		expect(probe.running).toBe(false)
		expect(probe.input).toBeNull()
		expect(manager.getStatus("scan-j1-dmr-1")).toBeUndefined()
		expect(sources.assignments.has("scan-j1-dmr-1")).toBe(false)
		expect(removed).toEqual(["scan-j1-dmr-1"])
		await manager.removeEphemeralDecoder("scan-j1-dmr-1") // unknown id: no-op
	})

	it("refuses to remove a configured decoder through the probe API", async () => {
		createConfigured()
		await expect(manager.removeEphemeralDecoder("dmr")).rejects.toMatchObject({
			code: "DECODER_NOT_EPHEMERAL",
		})
		expect(manager.getStatus("dmr")).toBeDefined()
	})
})

describe("source hold for a sweep (spec § 10.4)", () => {
	it("suspends running configured decoders by the time holdSource resolves and resumes them when releaseSource resolves", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(true)
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "tuner-scanning" },
			desiredRunning: true,
		})
		await manager.releaseSource("rtl", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(false)
		expect(decoder.starts).toBe(2)
		expect(manager.getStatus("dmr")?.suspended).toBe(false)
	})

	it("stays suspended while the scanner hops every 100 ms, which keeps re-arming the caps debounce", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		for (let hop = 0; hop < 20; hop++) {
			sources.setCenter("rtl", 412_000_000 + hop * 1_600_000)
			await vi.advanceTimersByTimeAsync(100)
			expect(decoder.running).toBe(false)
			expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
				"tuner-scanning",
			)
		}
		expect(decoder.starts).toBe(1)
		expect(decoder.stops).toBe(1)
		await manager.releaseSource("rtl", "j1")
		expect(decoder.starts).toBe(2)
		await settle() // the debounced hop evaluation finds nothing left to do
		expect(decoder.starts).toBe(2)
		expect(decoder.stops).toBe(1)
	})

	it("releasing one holder keeps another holder's hold", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.holdSource("rtl", "tuner-scanning", "j2")
		await manager.releaseSource("rtl", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(true)
		await settle()
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"tuner-scanning",
		)
		await manager.releaseSource("rtl", "j1") // already released: no-op
		expect(manager.isSourceHeld("rtl")).toBe(true)
		await manager.releaseSource("rtl", "j2")
		expect(manager.isSourceHeld("rtl")).toBe(false)
		expect(decoder.running).toBe(true)
		expect(decoder.starts).toBe(2)
	})

	it("outranks an unusable rate as the reported reason, which returns after release", async () => {
		createConfigured()
		await manager.startDecoder("dmr")
		sources.setRate("rtl", 20_000)
		await settle()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"tuner-scanning",
		)
		await manager.releaseSource("rtl", "j1")
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"insufficient-sample-rate",
		)
	})

	it("holds pinned (operator) decoders too", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr", { startMode: "operator" })
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			startMode: "operator",
			suspended: true,
		})
	})

	it("refuses refuseIfHeld starts and restarts on a held source, leaving the intent untouched", async () => {
		const decoder = createConfigured()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await expect(
			manager.startDecoder("dmr", {
				startMode: "operator",
				refuseIfHeld: true,
			}),
		).rejects.toSatisfy(
			(err: unknown) =>
				err instanceof WaveKitError && err.code === "SOURCE_HELD_BY_SCANNER",
		)
		expect(decoder.starts).toBe(0)
		expect(manager.getStatus("dmr")?.desiredRunning).toBe(false)
		await manager.releaseSource("rtl", "j1")
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await expect(
			manager.restartDecoder("dmr", { refuseIfHeld: true }),
		).rejects.toMatchObject({
			code: "SOURCE_HELD_BY_SCANNER",
		})
		expect(decoder.stops).toBe(1) // the hold's suspension only; the refused restart stopped nothing
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspended: true,
		})
	})

	it("startAll during a hold records the decoders as wanted and suspended; they start on release", async () => {
		const decoder = createConfigured()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.startAll()
		expect(decoder.starts).toBe(0)
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "tuner-scanning" },
		})
		await manager.releaseSource("rtl", "j1")
		expect(decoder.running).toBe(true)
		expect(manager.getStatus("dmr")?.suspended).toBe(false)
	})

	it("does not affect probes or decoders on other sources", async () => {
		sources.caps.set("spare", { ...iqCaps(2_400_000), centerFreq: 144_800_000 })
		manager.createDecoder({
			id: "aprs",
			type: "rate-test",
			enabled: true,
			sourceId: "spare",
			options: { input: "iq" },
		})
		await manager.startDecoder("aprs")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		expect(decoders.get("aprs")!.running).toBe(true)
		expect(decoders.get("scan-j1-dmr-1")!.running).toBe(true)
	})
})
