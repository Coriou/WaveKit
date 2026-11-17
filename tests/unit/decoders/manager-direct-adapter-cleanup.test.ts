/**
 * Direct channel input with the real dsd-fme adapter: when its child exits on EOF at its channel's end, no requested
 * stop ever reaches the adapter, so the manager runs that adapter instance's own stop() once, before it is started
 * again or replaced. Without it, each restart installs another call-timeout interval over the only reference to the
 * previous one, and the open call is never ended. A stop() that never settles holds nothing for longer than the
 * placement stop's deadline, and its instance never starts again. Only the child process is fake (spawn and the
 * process-group signal are replaced in this file); nothing is executed and nothing connects anywhere.
 */
import type * as ChildProcessModule from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import type { ChannelInputMode } from "../../../src/core/channelizer/types.js"
import {
	placementKey,
	type WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { PLACEMENT_STOP_TIMEOUT_MS } from "../../../src/decoders/placement-lifecycle.js"
import { signalDecoder } from "../../../src/decoders/process-tools.js"
import type * as ProcessToolsModule from "../../../src/decoders/process-tools.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import { FakeSources, iqCaps } from "../../mocks/rate-fakes.js"
import { CENTER, DirectProvider } from "./direct-channel-fakes.js"

/** A child that never runs: it reports `spawn` on the next microtask and exits when told to (or when signalled). */
class FakeChild extends EventEmitter {
	readonly pid = 1
	readonly stdin = null
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	exitCode: number | null = null
	signalCode: string | null = null
	killed = false
	private ended = false
	end(code: number | null, signal: string | null = null) {
		if (this.ended) return
		this.ended = true
		this.exitCode = code
		this.signalCode = signal
		this.stdout.end()
		this.stderr.end()
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
	}
	kill(signal?: NodeJS.Signals) {
		this.signal(signal ?? "SIGTERM")
		return true
	}
	signal(signal: string) {
		if (this.ended || signal === "SIGKILL") return
		queueMicrotask(() => this.end(null, signal))
	}
}

const children: FakeChild[] = []

vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()
	return {
		...actual,
		spawn: vi.fn(() => {
			const child = new FakeChild()
			children.push(child)
			queueMicrotask(() => child.emit("spawn"))
			return child
		}),
	}
})

// The process-group signal goes to the fake child, never to a real process.
vi.mock("../../../src/decoders/process-tools.js", async importOriginal => {
	const actual = await importOriginal<typeof ProcessToolsModule>()
	return {
		...actual,
		signalDecoder: vi.fn((proc: unknown, signal: string) => {
			if (proc instanceof FakeChild) proc.signal(signal)
		}),
	}
})

const DEBOUNCE = 350
/** The caps worker's own debounce (CAPS_CHANGE_DEBOUNCE_MS in manager.ts); DEBOUNCE above is that with a margin. */
const CAPS_WORKER_DEBOUNCE_MS = 300
const CALL_CHECK_MS = 500
/** The opening of a DMR voice call as dsd-fme prints it, each line after the given milliseconds; no terminator. */
const CALL_LINES: Array<[number, string]> = [
	[0, "Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VC*"],
	[30, " SLOT 1 TGT=9 SRC=123 Group Call "],
	[400, "Sync: no sync"],
	[260, "Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VC1"],
	[30, " SLOT 1 TGT=9 SRC=123 Group Call "],
]

let manager: DecoderManager
let provider: DirectProvider
let sources: FakeSources
let voice: DsdFmeDecoder[]
let outputs: DecoderOutput[]
/** The handles of call-timeout intervals still installed. */
let live: Set<unknown>
let stopCalls: MockInstance<DsdFmeDecoder["stop"]>
/** The manager's warnings and errors. */
let warnings: Array<Record<string, unknown>>
const logger = pino({ level: "silent" })
const CONFIG: DecoderConfig = {
	id: "voice",
	type: "dsd-fme",
	enabled: true,
	options: { mode: "auto", channelHz: CENTER },
	useChannelizer: true,
}

beforeEach(() => {
	vi.useFakeTimers()
	children.length = 0
	voice = []
	outputs = []
	live = new Set()
	const setInterval = globalThis.setInterval
	const clearInterval = globalThis.clearInterval
	vi.spyOn(globalThis, "setInterval").mockImplementation(((
		handler: () => void,
		ms?: number,
	) => {
		const handle = setInterval(handler, ms)
		if (ms === CALL_CHECK_MS) live.add(handle)
		return handle
	}) as typeof globalThis.setInterval)
	vi.spyOn(globalThis, "clearInterval").mockImplementation(((
		handle: Parameters<typeof globalThis.clearInterval>[0],
	) => {
		live.delete(handle)
		clearInterval(handle)
	}) as typeof globalThis.clearInterval)
	stopCalls = vi.spyOn(DsdFmeDecoder.prototype, "stop")
	warnings = []
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

/** The manager with the real dsd-fme adapter; with `placements`, one primary placement as the core runs it. */
function setup(channelInput: ChannelInputMode, placements: boolean) {
	const registry = new DecoderRegistry()
	registry.register(
		"dsd-fme",
		cfg => {
			const decoder = new DsdFmeDecoder(cfg, logger)
			decoder.on("output", (output: DecoderOutput) => outputs.push(output))
			voice.push(decoder)
			return decoder
		},
		new DsdFmeDecoder(CONFIG, logger).caps,
	)
	const wanted: WantedPlacement[] = [
		{
			key: placementKey("voice", "rtl", "channel", CENTER),
			decoderId: "voice",
			sourceId: "rtl",
			channelHz: CENTER,
			reach: "channel",
			origin: "configured",
			primary: true,
			costCores: 0.14,
			sampleRateHz: 2_048_000,
		},
	]
	const managerLog = pino(
		{ level: "warn" },
		{ write: (line: string) => void warnings.push(JSON.parse(line)) },
	)
	manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		managerLog,
		{
			restartDelay: 10,
			maxRestartDelay: 40,
			validateVersions: false,
			channelInput,
			...(placements
				? {
						enablement: {
							planner: () => ({ wanted, unplaced: new Map() }),
							resolveMode: () => ({
								mode: "auto" as const,
								source: "default" as const,
							}),
							isCatalogue: () => true,
							unavailable: () => false,
							recheckAvailable: async () => true,
							vfo: () => null,
							bandplanChannels: () => [],
							maxBandplanChannels: 4,
						},
					}
				: {}),
		},
	)
	manager.setSourceManager(sources as unknown as SourceManager)
	provider = new DirectProvider()
	manager.setChannelizer(provider)
	manager.createDecoder(CONFIG)
}

async function start(placements: boolean) {
	if (placements) await manager.startAll()
	else await manager.startDecoder("voice")
}

/** Feeds dsd-fme's own output lines to the running adapter, as its stderr would, as time passes. */
async function hearCall(decoder: DsdFmeDecoder) {
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
	}
	for (const [afterMs, line] of CALL_LINES) {
		await vi.advanceTimersByTimeAsync(afterMs)
		internals.handleOutputLine(line)
	}
	await vi.advanceTimersByTimeAsync(100)
}

function ofType(type: string) {
	return outputs.filter(output => output.type === type)
}

/** stop() calls that reached this adapter instance. */
function stopsOf(decoder: DsdFmeDecoder) {
	return stopCalls.mock.contexts.filter(context => context === decoder).length
}

/** The source goes away with the channel and the child exits on its EOF: the decoder waits as a channel hold. */
function loseSource() {
	sources.caps.delete("rtl")
	provider.endGeneration("rtl", ["voice-g1"], "source-lost")
	children.at(-1)!.end(0)
}

function restoreSource() {
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	sources.emit("caps-changed", "rtl", sources.caps.get("rtl"))
}

/**
 * The first instance's cleanup stop() does its work but never settles (or settles when `release` is called). Every
 * call to it is counted in `calls`.
 */
function hangCleanup(decoder: DsdFmeDecoder) {
	const real = DsdFmeDecoder.prototype.stop
	const hung = { calls: 0, release: () => {} }
	vi.spyOn(decoder, "stop").mockImplementation(() => {
		hung.calls++
		void real.call(decoder)
		return new Promise<void>(resolve => {
			hung.release = resolve
		})
	})
	return hung
}

/** Resolves `done` when `promise` does, so a test can look at it at a given fake time. */
function track(promise: Promise<unknown>) {
	const state = { done: false }
	void promise.then(() => {
		state.done = true
	})
	return state
}

function cleanupTimeouts() {
	return warnings.filter(line => line["reasonCode"] === "cleanup-timeout")
}

describe.each([
	["placements (the production setup)", true],
	["no placements", false],
] as const)("an expected exit, %s", (_name, placements) => {
	it("two EOF restarts: one live call-timeout interval, the earlier calls ended, no timer after destroy", async () => {
		setup("direct", placements)
		await start(placements)
		expect(voice).toHaveLength(1)
		const decoder = voice[0]!
		expect(children).toHaveLength(1)
		expect(live.size).toBe(1)
		await hearCall(decoder)
		expect(ofType("call_start")).toHaveLength(1)

		for (let move = 1; move <= 2; move++) {
			// The capture centre moves: the channel ends and the child exits on its EOF before the caps worker.
			provider.endGeneration("rtl", [`voice-g${move}`])
			children.at(-1)!.end(0)
			expect(stopCalls).toHaveBeenCalledTimes(move - 1)
			await vi.advanceTimersByTimeAsync(DEBOUNCE)
			expect(children).toHaveLength(move + 1)
			expect(manager.getStatus("voice")).toMatchObject({
				running: true,
				restartCount: 0,
			})
			expect(manager.getStatus("voice")?.lastError ?? null).toBeNull()
			// The adapter's stop() ran once for that exit, before the new start: one interval, the call ended.
			expect(stopCalls).toHaveBeenCalledTimes(move)
			expect(live.size).toBe(1)
			expect(ofType("call_end")).toHaveLength(move)
			await hearCall(decoder)
			expect(ofType("call_start")).toHaveLength(move + 1)
		}

		await manager.destroy()
		expect(live.size).toBe(0)
		expect(ofType("call_end")).toHaveLength(3)
		// Nothing of the adapter is left to fire.
		const before = outputs.length
		await vi.advanceTimersByTimeAsync(60_000)
		expect(outputs.length).toBe(before)
	})

	it("an exit held for its lost source: the adapter's stop() runs before the resume, once", async () => {
		setup("direct", placements)
		await start(placements)
		await hearCall(voice[0]!)
		sources.caps.delete("rtl")
		provider.endGeneration("rtl", ["voice-g1"], "source-lost")
		children[0]!.end(0)
		expect(manager.getStatus("voice")).toMatchObject({
			running: false,
			suspended: true,
		})
		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
		sources.emit("caps-changed", "rtl", sources.caps.get("rtl"))
		await vi.advanceTimersByTimeAsync(DEBOUNCE)
		expect(children).toHaveLength(2)
		expect(manager.getStatus("voice")).toMatchObject({ running: true })
		expect(stopCalls).toHaveBeenCalledTimes(1)
		expect(live.size).toBe(1)
		expect(ofType("call_end")).toHaveLength(1)
		await manager.destroy()
		expect(live.size).toBe(0)
	})

	it("options staged during the source-loss hold: the retired instance is cleaned up before its replacement starts", async () => {
		const realStart = DsdFmeDecoder.prototype.start
		const starts: Array<{
			instance: DsdFmeDecoder
			live: number
			ended: number
		}> = []
		vi.spyOn(DsdFmeDecoder.prototype, "start").mockImplementation(
			async function (this: DsdFmeDecoder) {
				starts.push({
					instance: this,
					live: live.size,
					ended: ofType("call_end").length,
				})
				return realStart.call(this)
			},
		)
		setup("direct", placements)
		await start(placements)
		const retired = voice[0]!
		await hearCall(retired)
		loseSource()
		expect(manager.getStatus("voice")).toMatchObject({ suspended: true })
		expect(manager.stageDecoderOptions("voice", { callTimeoutMs: 6000 })).toBe(
			true,
		)
		restoreSource()
		await vi.advanceTimersByTimeAsync(DEBOUNCE)
		// The staged options rebuilt the adapter; the new instance runs.
		expect(voice).toHaveLength(2)
		const replacement = voice[1]!
		expect(manager.getStatus("voice")).toMatchObject({ running: true })
		expect(starts.map(entry => entry.instance)).toEqual([retired, replacement])
		// When the replacement started, the retired instance's interval was gone and its call ended.
		expect(starts[1]).toMatchObject({ live: 0, ended: 1 })
		expect(stopsOf(retired)).toBe(1)
		expect(stopsOf(replacement)).toBe(0)
		expect(live.size).toBe(1)
		await manager.destroy()
		expect(live.size).toBe(0)
		const before = outputs.length
		await vi.advanceTimersByTimeAsync(60_000)
		expect(outputs.length).toBe(before)
	})

	it("a cleanup stop() that never settles: stopDecoder completes at the bound, not before; the next start uses a new instance", async () => {
		setup("direct", placements)
		await start(placements)
		const first = voice[0]!
		const hung = hangCleanup(first)
		loseSource()
		await vi.advanceTimersByTimeAsync(0)
		expect(hung.calls).toBe(1)
		const stopping = track(manager.stopDecoder("voice"))
		await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS - 1)
		expect(stopping.done).toBe(false)
		expect(cleanupTimeouts()).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(stopping.done).toBe(true)
		// One warning, with no error content.
		expect(cleanupTimeouts()).toHaveLength(1)
		expect(cleanupTimeouts()[0]).not.toHaveProperty("err")
		expect(hung.calls).toBe(1)

		sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
		await start(placements)
		expect(voice).toHaveLength(2)
		expect(children).toHaveLength(2)
		expect(manager.getStatus("voice")).toMatchObject({ running: true })
		expect(manager.getDecoder("voice")).toBe(voice[1])
		// The fenced instance was never started again, and nothing stopped it a second time.
		expect(hung.calls).toBe(1)

		// The old stop() settling late changes nothing: no signal, no state change, no event.
		const events = vi.spyOn(manager, "emit")
		const signals = vi.mocked(signalDecoder).mock.calls.length
		const status = manager.getStatus("voice")
		hung.release()
		await vi.advanceTimersByTimeAsync(0)
		expect(events).not.toHaveBeenCalled()
		expect(vi.mocked(signalDecoder).mock.calls.length).toBe(signals)
		expect(children[1]).toMatchObject({ exitCode: null, signalCode: null })
		expect(manager.getStatus("voice")).toEqual(status)
		expect(cleanupTimeouts()).toHaveLength(1)
		await manager.destroy()
		expect(live.size).toBe(0)
	})

	it("a cleanup stop() that never settles: a start that meets it waits the bound, then runs on a new instance", async () => {
		setup("direct", placements)
		await start(placements)
		const first = voice[0]!
		const hung = hangCleanup(first)
		// The capture centre moves (caps stay): the caps worker restarts the decoder after its debounce.
		provider.endGeneration("rtl", ["voice-g1"])
		children[0]!.end(0)
		// The worker's pass runs at the end of its debounce and meets the cleanup still running.
		await vi.advanceTimersByTimeAsync(CAPS_WORKER_DEBOUNCE_MS)
		expect(children).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS - 1)
		expect(children).toHaveLength(1)
		expect(voice).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(children).toHaveLength(2)
		expect(voice).toHaveLength(2)
		expect(manager.getDecoder("voice")).toBe(voice[1])
		expect(manager.getStatus("voice")).toMatchObject({
			running: true,
			restartCount: 0,
		})
		expect(manager.getStatus("voice")?.lastError ?? null).toBeNull()
		expect(hung.calls).toBe(1)
		expect(cleanupTimeouts()).toHaveLength(1)
		hung.release()
		await vi.advanceTimersByTimeAsync(0)
		expect(children[1]).toMatchObject({ exitCode: null, signalCode: null })
		expect(manager.getStatus("voice")).toMatchObject({ running: true })
		await manager.destroy()
		expect(live.size).toBe(0)
	})

	it("a cleanup stop() that never settles: removal completes at the bound, not before", async () => {
		setup("direct", placements)
		await start(placements)
		const hung = hangCleanup(voice[0]!)
		loseSource()
		const removing = track(manager.removeDecoder("voice"))
		await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS - 1)
		expect(removing.done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(removing.done).toBe(true)
		expect(manager.getStatus("voice")).toBeUndefined()
		expect(hung.calls).toBe(1)
		expect(cleanupTimeouts()).toHaveLength(1)
		await manager.destroy()
	})

	it("a cleanup stop() that never settles: destroy completes at the bound", async () => {
		setup("direct", placements)
		await start(placements)
		const hung = hangCleanup(voice[0]!)
		loseSource()
		const destroying = track(manager.destroy())
		await vi.advanceTimersByTimeAsync(PLACEMENT_STOP_TIMEOUT_MS - 1)
		expect(destroying.done).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(destroying.done).toBe(true)
		expect(manager.getStatus("voice")).toBeUndefined()
		expect(hung.calls).toBe(1)
		expect(cleanupTimeouts()).toHaveLength(1)
	})

	it("three concurrent stops during the cleanup: the adapter's stop() is called once", async () => {
		setup("direct", placements)
		await start(placements)
		const first = voice[0]!
		const hung = hangCleanup(first)
		loseSource()
		await vi.advanceTimersByTimeAsync(0)
		const stops = [
			manager.stopDecoder("voice"),
			manager.stopDecoder("voice"),
			manager.stopDecoder("voice"),
		]
		await vi.advanceTimersByTimeAsync(10)
		hung.release()
		await vi.advanceTimersByTimeAsync(0)
		await Promise.all(stops)
		expect(hung.calls).toBe(1)
		expect(cleanupTimeouts()).toHaveLength(0)
		expect(manager.getStatus("voice")).toMatchObject({ running: false })
		await manager.destroy()
		expect(hung.calls).toBe(1)
	})

	it("relay mode: the restart's stop() reaches the running adapter, as before", async () => {
		setup("relay", placements)
		await start(placements)
		await hearCall(voice[0]!)
		provider.endGeneration("rtl", ["voice-g1"])
		await vi.advanceTimersByTimeAsync(DEBOUNCE)
		expect(children).toHaveLength(2)
		expect(stopCalls).toHaveBeenCalledTimes(1)
		expect(live.size).toBe(1)
		expect(ofType("call_end")).toHaveLength(1)
		await manager.destroy()
		expect(live.size).toBe(0)
	})
})
