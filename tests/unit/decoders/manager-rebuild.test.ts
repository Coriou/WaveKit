/**
 * WG8 (web-gaps-8 req 3.1-3.4): staged decoder options rebuild the adapter at
 * the next start, on every start path, and only then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Writable } from "node:stream"
import { PassThrough } from "node:stream"
import pino from "pino"
import {
	DecoderManager,
	DecoderRebuildError,
} from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const POCSAG = 466_075_000
const ELSEWHERE = 1_090_000_000
const SENTINEL = "SENTINEL-boom-/tmp/secret-host.example"
const CAPS = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
} as const

let sources: FakeSources
let manager: DecoderManager
let creates: DecoderConfig[]
let instances: RateDecoder[]
let created: string[]
let logLines: string[]

function setup() {
	creates = []
	instances = []
	created = []
	logLines = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, cb) {
			logLines.push(chunk.toString())
			cb()
		},
	})
	const logger = pino({ level: "debug" }, sink)
	const registry = new DecoderRegistry()
	registry.register(
		"rt",
		config => {
			creates.push(structuredClone(config))
			if (config.options["boom"] === true) throw new Error(SENTINEL)
			const decoder = new RateDecoder(config.id, { ...CAPS })
			const targets = config.options["targets"]
			if (Array.isArray(targets))
				decoder.band = { targetsHz: targets as number[], basis: "configured" }
			instances.push(decoder)
			return decoder
		},
		{ ...CAPS },
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.on("decoder:created", (id: string) => created.push(id))
}

function create(id = "dec", options: Record<string, unknown> = {}) {
	manager.createDecoder({
		id,
		type: "rt",
		enabled: true,
		options: { targets: [POCSAG], ...options },
	})
	created.length = 0
	return instances.at(-1)!
}

const output = (id: string): DecoderOutput => ({
	decoder: id,
	timestamp: new Date(),
	type: "signal",
	data: {},
})

beforeEach(() => {
	vi.useFakeTimers()
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: POCSAG })
	setup()
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("staging", () => {
	it("stage, pending, start rebuilds once, then not pending", async () => {
		const old = create()
		expect(manager.stageDecoderOptions("dec", { mode: "fast" })).toBe(true)
		expect(manager.isRestartPending("dec")).toBe(true)
		expect(creates).toHaveLength(1)
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(creates).toHaveLength(2)
		expect(creates[1]!.options).toEqual({ targets: [POCSAG], mode: "fast" })
		const fresh = manager.getDecoder("dec")
		expect(fresh).not.toBe(old)
		expect(fresh).toBe(instances[1])
		expect(old.starts).toBe(0)
		expect(instances[1]!.starts).toBe(1)
		expect(manager.isRestartPending("dec")).toBe(false)
		expect(created).toEqual(["dec"])
		expect(manager.getStatus("dec")).toMatchObject({
			running: true,
			health: "running",
			restartCount: 0,
		})
		// The next start does not rebuild again.
		await manager.restartDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(created).toEqual(["dec"])
	})

	it("staging never touches a running process", async () => {
		const old = create()
		await manager.startDecoder("dec")
		expect(manager.stageDecoderOptions("dec", { mode: "fast" })).toBe(true)
		expect(old.running).toBe(true)
		expect(old.stops).toBe(0)
		expect(creates).toHaveLength(1)
		await manager.restartDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(manager.getDecoder("dec")).toBe(instances[1])
		expect(instances[1]!.running).toBe(true)
	})

	it("staging options equal to the current ones does not rebuild", async () => {
		create("dec", { mode: "slow", list: [1, 2] })
		expect(
			manager.stageDecoderOptions("dec", { mode: "slow", list: [1, 2] }),
		).toBe(false)
		expect(manager.stageDecoderOptions("dec", { absent: null })).toBe(false)
		expect(manager.isRestartPending("dec")).toBe(false)
		await manager.startDecoder("dec")
		expect(creates).toHaveLength(1)
		expect(created).toEqual([])
	})

	it("reverting to the configured value rebuilds back", async () => {
		create("dec", { mode: "slow" })
		manager.stageDecoderOptions("dec", { mode: "fast" })
		await manager.startDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(manager.stageDecoderOptions("dec", { mode: "slow" })).toBe(true)
		await manager.restartDecoder("dec")
		expect(creates).toHaveLength(3)
		expect(creates[2]!.options).toEqual({ targets: [POCSAG], mode: "slow" })
		expect(manager.isRestartPending("dec")).toBe(false)
	})

	it("a revert staged before the start clears the staging", async () => {
		create("dec", { mode: "slow" })
		expect(manager.stageDecoderOptions("dec", { mode: "fast" })).toBe(true)
		expect(manager.stageDecoderOptions("dec", { mode: "slow" })).toBe(false)
		await manager.startDecoder("dec")
		expect(creates).toHaveLength(1)
	})

	it("null removes a key; other keys are kept", async () => {
		create("dec", { mode: "slow", keep: 7 })
		expect(manager.stageDecoderOptions("dec", { mode: null })).toBe(true)
		await manager.startDecoder("dec")
		expect(creates[1]!.options).toEqual({ targets: [POCSAG], keep: 7 })
	})

	it("stagings accumulate across calls", async () => {
		create()
		manager.stageDecoderOptions("dec", { a: 1 })
		manager.stageDecoderOptions("dec", { b: "x" })
		await manager.startDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(creates[1]!.options).toMatchObject({ a: 1, b: "x" })
	})

	it("a caller mutating the staged array afterwards changes nothing", async () => {
		create()
		const list = [1, 2]
		manager.stageDecoderOptions("dec", { list })
		list.push(3)
		await manager.startDecoder("dec")
		expect(creates[1]!.options["list"]).toEqual([1, 2])
	})

	it("unknown id: false", () => {
		expect(manager.stageDecoderOptions("nope", { a: 1 })).toBe(false)
		expect(manager.isRestartPending("nope")).toBe(false)
	})

	it("probe ids: false and nothing staged", async () => {
		await manager.createEphemeralDecoder(
			{ id: "probe-1", type: "rt", enabled: true, options: {} },
			{ owner: "scanner", jobId: "job", input: new PassThrough() },
		)
		expect(manager.stageDecoderOptions("probe-1", { a: 1 })).toBe(false)
		expect(manager.isRestartPending("probe-1")).toBe(false)
		await manager.stopDecoder("probe-1")
		await manager.startDecoder("probe-1")
		expect(creates).toHaveLength(1)
		await manager.removeEphemeralDecoder("probe-1")
	})

	it("removal while staged clears the state", async () => {
		create()
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.removeDecoder("dec")
		expect(manager.isRestartPending("dec")).toBe(false)
		create()
		expect(manager.isRestartPending("dec")).toBe(false)
		await manager.startDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(creates[1]!.options).toEqual({ targets: [POCSAG] })
	})
})

describe("rebuild wiring", () => {
	it("the old instance's listeners are gone: one decoder:output per event", async () => {
		const old = create()
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.startDecoder("dec")
		const fresh = instances[1]!
		const outputs: string[] = []
		manager.on("decoder:output", (id: string) => outputs.push(id))
		expect(old.listenerCount("output")).toBe(0)
		expect(old.listenerCount("exit")).toBe(0)
		old.emit("output", output("dec"))
		old.emit("exit", 1, null)
		expect(outputs).toEqual([])
		fresh.emit("output", output("dec"))
		expect(outputs).toEqual(["dec"])
		expect(fresh.listenerCount("output")).toBe(1)
		expect(manager.getStatus("dec")?.restartCount).toBe(0)
	})

	it("the new instance gets the fanout input and the source reservation", async () => {
		create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.restartDecoder("dec")
		const fresh = instances[1]!
		expect(fresh.input).not.toBeNull()
		expect(instances[0]!.input).toBeNull()
		expect(sources.assignments.get("dec")).toBe("rtl")
	})

	it("band and rate are re-derived from the rebuilt config", async () => {
		create("dec", { targets: [ELSEWHERE] })
		await manager.startDecoder("dec")
		expect(manager.getStatus("dec")).toMatchObject({
			suspended: true,
			bandAssessment: { verdict: "out-of-band" },
		})
		manager.stageDecoderOptions("dec", { targets: [POCSAG] })
		await manager.restartDecoder("dec")
		expect(manager.getStatus("dec")).toMatchObject({
			running: true,
			suspended: false,
			bandAssessment: { verdict: "in-band", targetsHz: [POCSAG] },
			rateAssessment: { verdict: "best" },
		})
		expect(instances[1]!.starts).toBe(1)
	})

	it("decoder:created is emitted once per rebuild, before decoder:started", async () => {
		create()
		const events: string[] = []
		manager.on("decoder:created", () => events.push("created"))
		manager.on("decoder:started", () => events.push("started"))
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { a: 2 })
		await manager.restartDecoder("dec")
		expect(events).toEqual(["created", "started", "created", "started"])
	})
})

describe("every start path reaches the rebuild", () => {
	it("restartDecoder", async () => {
		create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.restartDecoder("dec")
		expect(creates).toHaveLength(2)
		expect(instances[1]!.running).toBe(true)
	})

	it("automatic restart after a crash", async () => {
		const old = create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { a: 1 })
		old.crash()
		expect(manager.getStatus("dec")?.restartCount).toBe(1)
		await vi.advanceTimersByTimeAsync(10)
		expect(creates).toHaveLength(2)
		expect(manager.getDecoder("dec")).toBe(instances[1])
		expect(instances[1]!.running).toBe(true)
		expect(old.starts).toBe(1)
		// Fresh create: counters reset, crash error cleared.
		expect(manager.getStatus("dec")).toMatchObject({
			restartCount: 0,
			health: "running",
		})
		expect(manager.getStatus("dec")?.lastError).toBeUndefined()
	})

	it("startAll", async () => {
		create()
		manager.stageDecoderOptions("dec", { a: 1 })
		await manager.startAll()
		expect(creates).toHaveLength(2)
		expect(instances[1]!.running).toBe(true)
	})

	it("band resume of a suspended decoder", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		create()
		await manager.startDecoder("dec")
		expect(manager.getStatus("dec")?.suspended).toBe(true)
		manager.stageDecoderOptions("dec", { a: 1 })
		sources.setCenter("rtl", POCSAG)
		await vi.advanceTimersByTimeAsync(350)
		expect(creates).toHaveLength(2)
		expect(manager.getDecoder("dec")).toBe(instances[1])
		expect(instances[1]!.running).toBe(true)
		expect(manager.getStatus("dec")?.suspended).toBe(false)
	})

	it("rate change restart (caps worker)", async () => {
		const old = create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { a: 1 })
		sources.setRate("rtl", 2_048_000)
		await vi.advanceTimersByTimeAsync(350)
		expect(old.stops).toBeGreaterThan(0)
		expect(creates).toHaveLength(2)
		expect(instances[1]!.running).toBe(true)
	})
})

describe("internal start paths re-check eligibility after a rebuild", () => {
	it("crash restart: rebuilt targets out of band suspend instead of spawning", async () => {
		const old = create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { targets: [ELSEWHERE] })
		old.crash()
		await vi.advanceTimersByTimeAsync(10)
		expect(creates).toHaveLength(2)
		const rebuilt = instances[1]!
		expect(manager.getDecoder("dec")).toBe(rebuilt)
		expect(rebuilt.running).toBe(false)
		expect(rebuilt.starts).toBe(0)
		const status = manager.getStatus("dec")
		expect(status?.suspended).toBe(true)
		expect(status?.desiredRunning).toBe(true)

		// Same answer as a fresh manager booted with that config.
		await manager.destroy()
		setup()
		create("dec", { targets: [ELSEWHERE] })
		await manager.startDecoder("dec")
		const fresh = manager.getStatus("dec")
		expect(fresh?.suspended).toBe(true)
		expect(status?.suspension?.reasonCode).toBe("frequency-out-of-band")
		expect(fresh?.suspension?.reasonCode).toBe("frequency-out-of-band")
	})

	it("resume: rebuilt targets out of band at the new center stay suspended", async () => {
		sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: ELSEWHERE })
		create()
		await manager.startDecoder("dec")
		expect(manager.getStatus("dec")?.suspended).toBe(true)
		manager.stageDecoderOptions("dec", { targets: [ELSEWHERE] })
		sources.setCenter("rtl", POCSAG)
		await vi.advanceTimersByTimeAsync(350)
		expect(creates).toHaveLength(2)
		expect(instances[1]!.running).toBe(false)
		expect(instances[1]!.starts).toBe(0)
		expect(manager.getStatus("dec")?.suspended).toBe(true)
		// Back on the rebuilt target: it resumes normally.
		sources.setCenter("rtl", ELSEWHERE)
		await vi.advanceTimersByTimeAsync(350)
		expect(creates).toHaveLength(2)
		expect(instances[1]!.running).toBe(true)
		expect(manager.getStatus("dec")?.suspended).toBe(false)
	})
})

describe("without staging nothing is constructed (req 3.4)", () => {
	it("start, restart, crash restart, rate restart, startAll: one create", async () => {
		const decoder = create()
		await manager.startAll()
		await manager.restartDecoder("dec")
		decoder.crash()
		await vi.advanceTimersByTimeAsync(10)
		sources.setRate("rtl", 2_048_000)
		await vi.advanceTimersByTimeAsync(350)
		await manager.stopDecoder("dec")
		await manager.startDecoder("dec", { startMode: "operator" })
		expect(creates).toHaveLength(1)
		expect(manager.getDecoder("dec")).toBe(decoder)
		expect(decoder.starts).toBeGreaterThanOrEqual(4)
		expect(created).toEqual([])
	})
})

describe("rebuild failure", () => {
	it("keeps the old instance and staging, stops, fixed error, no created", async () => {
		const old = create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { boom: true })
		const err: unknown = await manager.restartDecoder("dec").then(
			() => null,
			(e: unknown) => e,
		)
		expect(err).toBeInstanceOf(DecoderRebuildError)
		expect(err).toBeInstanceOf(WaveKitError)
		expect((err as WaveKitError).message).toBe("Decoder rebuild failed")
		expect((err as WaveKitError).code).toBe("DECODER_REBUILD_FAILED")
		expect((err as WaveKitError).cause).toBeUndefined()
		expect(manager.getDecoder("dec")).toBe(old)
		expect(old.listenerCount("output")).toBe(1)
		expect(manager.isRestartPending("dec")).toBe(true)
		expect(created).toEqual([])
		const status = manager.getStatus("dec")!
		expect(status).toMatchObject({
			running: false,
			desiredRunning: false,
			suspended: false,
			health: "faulted",
			lastError: { kind: "error", message: "Decoder rebuild failed" },
		})
		expect(sources.assignments.has("dec")).toBe(false)
		const logs = logLines.join("\n")
		expect(logs).toContain("Decoder rebuild failed; previous instance kept")
		expect(logs).not.toContain("SENTINEL")
		expect(logs).not.toContain("secret-host")
		expect(JSON.stringify(status)).not.toContain("SENTINEL")
		// No retry is scheduled.
		await vi.advanceTimersByTimeAsync(1000)
		expect(creates).toHaveLength(2)
		// Clearing the bad key lets the next start run the old instance again.
		expect(manager.stageDecoderOptions("dec", { boom: null })).toBe(false)
		await manager.startDecoder("dec")
		expect(old.running).toBe(true)
		expect(creates).toHaveLength(2)
	})

	it("a failing rebuild on an automatic restart stops the decoder without retrying", async () => {
		const old = create()
		await manager.startDecoder("dec")
		manager.stageDecoderOptions("dec", { boom: true })
		old.crash()
		await vi.advanceTimersByTimeAsync(10)
		expect(creates).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1000)
		expect(creates).toHaveLength(2)
		expect(manager.getDecoder("dec")).toBe(old)
		expect(manager.getStatus("dec")).toMatchObject({
			running: false,
			desiredRunning: false,
			health: "faulted",
			lastError: { message: "Decoder rebuild failed" },
		})
		expect(manager.isRestartPending("dec")).toBe(true)
	})

	it("startAll logs the failure without the constructor text", async () => {
		create()
		manager.stageDecoderOptions("dec", { boom: true })
		await manager.startAll()
		expect(manager.getStatus("dec")?.running).toBe(false)
		expect(logLines.join("\n")).not.toContain("SENTINEL")
	})
})
