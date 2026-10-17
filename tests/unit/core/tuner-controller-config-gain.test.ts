/**
 * WG11 lane GN (requirements 4.2-4.6, design "Gain and AGC on connect"):
 * configured gain and AGC written once per connection, in order, origin
 * `config`, never over a value the operator set in this process, never under
 * external control, and never claimed known before it was written.
 *
 * In-memory fake transport only (no socket).
 */
import { EventEmitter } from "node:events"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TunerCommandOrigin } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import {
	TunerController,
	type TunerReconnectPolicy,
} from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { SourceTunerConfig } from "../../../src/config.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"

const SRC = "rtl-1"

interface Snapshot {
	frames: string[]
	sent: Array<[string, number, TunerCommandOrigin | undefined]>
	state: {
		frequency: number
		sampleRate: number
		gainMode: string
		gain: number
		agcMode: boolean
		controlMode: string
		commandCount: number
		unknownFields: string[] | undefined
		declaredOnlyFields: string[] | undefined
		lastError: string | undefined
	}
	tuningWritten: boolean
}

function harness(policy: TunerReconnectPolicy = "restore") {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const frames: string[] = []
	let failAfter: number | null = null
	const sources = Object.assign(new EventEmitter(), {
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			if (failAfter !== null && failAfter <= 0)
				throw new Error("Source rtl-1 socket is not writable")
			if (failAfter !== null) failAfter--
			frames.push(payload.toString("hex"))
			return true
		}),
		isRtlTcpSource: vi.fn(() => true),
		updateSourceCaps: vi.fn((_id: string, updates: Partial<SourceCaps>) =>
			Object.assign(caps, updates),
		),
		getCaps: vi.fn(() => ({ ...caps })),
		setTuningCaps: vi.fn(
			(
				_id: string,
				tuning: { sampleRate: number; centerFreq?: number | undefined },
			) => {
				caps.sampleRate = tuning.sampleRate
				if (tuning.centerFreq === undefined) delete caps.centerFreq
				else caps.centerFreq = tuning.centerFreq
				return caps
			},
		),
	})
	let relayClients = 0
	const relay = Object.assign(new EventEmitter(), {
		handleSourceConnected: vi.fn(),
		getStatus: vi.fn(() => ({
			sourceId: SRC,
			clientsConnected: relayClients,
			controlPolicy: "shared" as const,
		})),
	})
	const controller = new TunerController(
		createLogger({ level: "fatal" }),
		sources as unknown as SourceManager,
		{ reconnectPolicy: policy },
	)
	wireTunerControl({
		log: createLogger({ level: "fatal" }),
		sourceManager: sources as unknown as SourceManager,
		tunerController: controller,
		tunerRelay: relay as unknown as TunerRelay,
		relayEnabled: true,
	})
	const sent: Snapshot["sent"] = []
	controller.on(
		"command-sent",
		(_id: string, name: string, value: number, origin?: TunerCommandOrigin) =>
			sent.push([name, value, origin]),
	)
	const connect = () => {
		sources.emit("connected", SRC)
		sources.emit("payload-started", SRC)
	}
	const snapshot = (): Snapshot => {
		const s = controller.getState(SRC)
		if (!s) throw new Error("no state")
		const out: Snapshot = {
			frames: [...frames],
			sent: [...sent],
			state: {
				frequency: s.frequency,
				sampleRate: s.sampleRate,
				gainMode: s.gainMode,
				gain: s.gain,
				agcMode: s.agcMode,
				controlMode: s.controlMode,
				commandCount: s.commandCount,
				unknownFields: s.unknownFields,
				declaredOnlyFields: s.declaredOnlyFields,
				lastError: s.lastError,
			},
			tuningWritten: controller.tuningWrittenOnConnection(SRC),
		}
		frames.length = 0
		sent.length = 0
		return out
	}
	const relayClient = (connected: boolean) => {
		relayClients = connected ? 1 : 0
		relay.emit(connected ? "client-connected" : "client-disconnected")
	}
	const relayCommand = (command: number, value: number) =>
		relay.emit("command-received", { sourceId: SRC, command, value })
	const failAfterWrites = (count: number | null) => {
		failAfter = count
	}
	return {
		controller,
		sources,
		caps,
		frames,
		sent,
		connect,
		snapshot,
		relayClient,
		relayCommand,
		failAfterWrites,
	}
}

const MANUAL_496: SourceTunerConfig = {
	gainMode: "manual",
	gainDb: 49.6,
	agcMode: false,
}
const DECLARED_BOTH = ["frequency", "sampleRate"]
const UNKNOWN_REST = [
	"ppm",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
]

function configured(
	tuner: SourceTunerConfig | undefined,
	policy: TunerReconnectPolicy = "restore",
) {
	const h = harness(policy)
	h.sources.emit("connected", SRC)
	h.controller.setConfiguredTuning(SRC, tuner)
	h.snapshot()
	return h
}

describe("WG11 GN: configured gain and AGC on connect", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-10-17T00:00:00Z"))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("is not shown as written before the first payload (state baseline, still unknown)", () => {
		const h = configured(MANUAL_496)
		const s = h.controller.getState(SRC)
		expect(s?.gainMode).toBe("manual")
		expect(s?.gain).toBe(496)
		expect(s?.agcMode).toBe(false)
		expect(s?.unknownFields).toEqual(
			expect.arrayContaining(["gainMode", "gain", "agcMode"]),
		)
		expect(h.frames).toEqual([])
	})

	it("manual 49.6 dB, AGC off: exact frames in order, origin config, then known", () => {
		const h = configured(MANUAL_496)
		const states: unknown[] = []
		h.controller.on("state-changed", (_id: string, s: unknown) =>
			states.push(s),
		)
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual({
			frames: ["0300000001", "04000001f0", "0800000000"],
			sent: [
				["set-gain-mode", 1, "config"],
				["set-gain", 496, "config"],
				["set-agc-mode", 0, "config"],
			],
			state: {
				frequency: 100_000_000,
				sampleRate: 2_048_000,
				gainMode: "manual",
				gain: 496,
				agcMode: false,
				controlMode: "internal",
				commandCount: 3,
				unknownFields: UNKNOWN_REST,
				declaredOnlyFields: DECLARED_BOTH,
				lastError: undefined,
			},
			// Frequency/rate trust is the golden one: nothing proved them.
			tuningWritten: false,
		})
		expect(states.length).toBeGreaterThan(0)
		expect(h.caps.sampleRate).toBe(2_048_000)
		expect(h.caps.centerFreq).toBe(100_000_000)
	})

	it("agc mode: only the gain mode 0 frame, plus AGC when given", () => {
		const a = configured({ gainMode: "agc" })
		a.sources.emit("payload-started", SRC)
		const sa = a.snapshot()
		expect(sa.frames).toEqual(["0300000000"])
		expect(sa.sent).toEqual([["set-gain-mode", 0, "config"]])
		expect(sa.state.unknownFields).toContain("gain")
		expect(sa.state.unknownFields).toContain("agcMode")
		const b = configured({ gainMode: "agc", agcMode: true })
		b.sources.emit("payload-started", SRC)
		expect(b.snapshot().frames).toEqual(["0300000000", "0800000001"])
	})

	it("once per connection: a repeated payload-started writes nothing more", () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot().frames).toHaveLength(3)
		h.sources.emit("payload-started", SRC)
		const again = h.snapshot()
		expect(again.frames).toEqual([])
		expect(again.state.unknownFields).toEqual(UNKNOWN_REST)
	})

	it("a reconnect writes the set again", () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		h.snapshot()
		h.connect()
		expect(h.snapshot().frames).toEqual([
			"0300000001",
			"04000001f0",
			"0800000000",
		])
	})

	it("a REST gain wins on restore; the configured mode and AGC are still written first", async () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		await h.controller.setGain(SRC, 300, { origin: "rest" })
		h.snapshot()
		h.connect()
		const s = h.snapshot()
		expect(s.frames).toEqual(["0300000001", "0800000000", "040000012c"])
		expect(s.sent).toEqual([
			["set-gain-mode", 1, "config"],
			["set-agc-mode", 0, "config"],
			["set-gain", 300, "replay"],
		])
		expect(s.state.gain).toBe(300)
	})

	it("a REST gain mode also keeps the configured gain off the wire", async () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		await h.controller.setGainMode(SRC, "agc", { origin: "rest" })
		h.snapshot()
		h.connect()
		const s = h.snapshot()
		expect(s.frames).toEqual(["0800000000", "0300000000"])
		expect(s.state.gainMode).toBe("agc")
	})

	it("reset policy discards the REST value and returns to the configured baseline", async () => {
		const h = configured(MANUAL_496, "reset")
		h.sources.emit("payload-started", SRC)
		await h.controller.setGain(SRC, 300, { origin: "rest" })
		await h.controller.setAgcMode(SRC, true, { origin: "rest" })
		h.snapshot()
		h.connect()
		const s = h.snapshot()
		expect(s.frames).toEqual(["0300000001", "04000001f0", "0800000000"])
		expect(s.sent.map(e => e[2])).toEqual(["config", "config", "config"])
		expect(s.state.gain).toBe(496)
		expect(s.state.agcMode).toBe(false)
		expect(s.state.unknownFields).toEqual(UNKNOWN_REST)
		expect(s.tuningWritten).toBe(false)
		expect(s.state.declaredOnlyFields).toEqual(DECLARED_BOTH)
	})

	it("a relay-accepted gain wins (and its implied manual mode)", () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		h.relayClient(true)
		h.relayCommand(0x04, 280)
		h.relayClient(false)
		h.snapshot()
		h.connect()
		const s = h.snapshot()
		expect(s.frames).toEqual(["0800000000", "0400000118"])
		expect(s.sent).toEqual([
			["set-agc-mode", 0, "config"],
			["set-gain", 280, "replay"],
		])
		expect(s.state.gain).toBe(280)
	})

	it("external control writes nothing configured", () => {
		const h = configured(MANUAL_496)
		h.relayClient(true)
		h.snapshot()
		h.sources.emit("payload-started", SRC)
		const s = h.snapshot()
		expect(s.frames).toEqual([])
		expect(s.sent).toEqual([])
		expect(s.state.unknownFields).toEqual(
			expect.arrayContaining(["gainMode", "gain", "agcMode"]),
		)
	})

	it("a failed write is the restore failure: nothing claimed, retried next connection", async () => {
		const h = configured(MANUAL_496)
		await h.controller.setFrequency(SRC, 145_000_000, { origin: "rest" })
		h.snapshot()
		const errors: Error[] = []
		h.controller.on("error", (_id: string, err: Error) => errors.push(err))
		h.failAfterWrites(1)
		const result = h.controller.synchronizeOnConnect(SRC)
		expect(result.error).toBe(
			"Tuner state restore failed: Source rtl-1 socket is not writable",
		)
		expect(result.commands).toEqual(["set-gain-mode"])
		expect(errors).toHaveLength(1)
		const s = h.snapshot()
		expect(s.frames).toEqual(["0300000001"])
		expect(s.sent).toEqual([["set-gain-mode", 1, "config"]])
		expect(s.state.lastError).toBe(result.error)
		expect(s.state.unknownFields).toEqual(
			expect.arrayContaining(["gainMode", "gain", "agcMode"]),
		)
		// The restore did not run after the failure.
		expect(s.tuningWritten).toBe(false)
		h.failAfterWrites(null)
		h.connect()
		const next = h.snapshot()
		expect(next.frames).toEqual([
			"0300000001",
			"04000001f0",
			"0800000000",
			"0108a48640",
		])
		expect(next.state.lastError).toBeUndefined()
		expect(next.state.unknownFields).toEqual(UNKNOWN_REST)
	})

	it("setConfiguredTuning(undefined) restores the golden behaviour", () => {
		const h = configured(MANUAL_496)
		h.controller.setConfiguredTuning(SRC, undefined)
		h.snapshot()
		h.sources.emit("payload-started", SRC)
		const s = h.snapshot()
		expect(s.frames).toEqual([])
		expect(s.state.gainMode).toBe("agc")
		expect(s.state.gain).toBe(0)
		expect(s.state.agcMode).toBe(true)
		expect(s.state.commandCount).toBe(0)
	})

	it("a changed configuration is unknown until written again", () => {
		const h = configured(MANUAL_496)
		h.sources.emit("payload-started", SRC)
		h.controller.setConfiguredTuning(SRC, { gainMode: "manual", gainDb: 20 })
		const s = h.snapshot()
		expect(s.state.gain).toBe(200)
		expect(s.state.unknownFields).toEqual(
			expect.arrayContaining(["gainMode", "gain"]),
		)
	})

	it("a source without state (not rtl_tcp) is never written", () => {
		const h = harness()
		h.controller.setConfiguredTuning("other", MANUAL_496)
		h.controller.noteSourceConnected("other")
		expect(h.controller.synchronizeOnConnect("other").commands).toEqual([])
		expect(h.frames).toEqual([])
	})
})

type Action =
	| { kind: "connect" }
	| { kind: "repeat" }
	| { kind: "rest"; field: "gainMode" | "gain" | "agcMode"; value: number }
	| { kind: "relay"; field: "gainMode" | "gain" | "agcMode"; value: number }
	| { kind: "external"; on: boolean }

const actionArb: fc.Arbitrary<Action> = fc.oneof(
	fc.constant<Action>({ kind: "connect" }),
	fc.constant<Action>({ kind: "repeat" }),
	fc.record({
		kind: fc.constant("rest" as const),
		field: fc.constantFrom(
			"gainMode" as const,
			"gain" as const,
			"agcMode" as const,
		),
		value: fc.integer({ min: 0, max: 500 }),
	}),
	fc.record({
		kind: fc.constant("relay" as const),
		field: fc.constantFrom(
			"gainMode" as const,
			"gain" as const,
			"agcMode" as const,
		),
		value: fc.integer({ min: 0, max: 500 }),
	}),
	fc.record({ kind: fc.constant("external" as const), on: fc.boolean() }),
)

const tunerArb: fc.Arbitrary<SourceTunerConfig | undefined> = fc.oneof(
	fc.constant(undefined),
	fc
		.record({
			gainDb: fc.integer({ min: 0, max: 500 }).map(t => t / 10),
			agcMode: fc.option(fc.boolean(), { nil: undefined }),
		})
		.map(
			({ gainDb, agcMode }): SourceTunerConfig =>
				agcMode === undefined
					? { gainMode: "manual", gainDb }
					: { gainMode: "manual", gainDb, agcMode },
		),
	fc
		.option(fc.boolean(), { nil: undefined })
		.map(
			(agcMode): SourceTunerConfig =>
				agcMode === undefined
					? { gainMode: "agc" }
					: { gainMode: "agc", agcMode },
		),
)

describe("WG11 GN Property 9", () => {
	// Feature: web-gaps-11, Property 9: Configured gain, once, never over the operator
	// Validates: Requirements 4.2, 4.3
	it("configured frames are written iff configured, internal and not held; once per connection, in order, origin config", async () => {
		await fc.assert(
			fc.asyncProperty(
				tunerArb,
				fc.constantFrom<TunerReconnectPolicy>("restore", "reset"),
				fc.array(actionArb, { minLength: 1, maxLength: 25 }),
				async (tuner, policy, actions) => {
					const h = harness(policy)
					h.sources.emit("connected", SRC)
					h.controller.setConfiguredTuning(SRC, tuner)
					h.sources.emit("payload-started", SRC)
					const held = new Set<string>()
					let external = false
					const expected = (): string[] => {
						if (!tuner || external) return []
						const out: string[] = []
						const hex = (cmd: number, v: number) =>
							Buffer.from([
								cmd,
								v >>> 24,
								(v >>> 16) & 0xff,
								(v >>> 8) & 0xff,
								v & 0xff,
							]).toString("hex")
						const manual = tuner.gainMode === "manual"
						if (!held.has("gainMode")) out.push(hex(3, manual ? 1 : 0))
						if (
							manual &&
							tuner.gainDb !== undefined &&
							!held.has("gain") &&
							!held.has("gainMode")
						)
							out.push(hex(4, Math.round(tuner.gainDb * 10)))
						if (tuner.agcMode !== undefined && !held.has("agcMode"))
							out.push(hex(8, tuner.agcMode ? 1 : 0))
						return out
					}
					// The first connection had no operator values.
					const first = h.snapshot()
					expect(first.frames).toEqual(expected())
					for (const action of actions) {
						if (action.kind === "external") {
							external = action.on
							h.relayClient(action.on)
							h.snapshot()
							continue
						}
						if (action.kind === "rest") {
							if (external) continue
							if (action.field === "gain")
								await h.controller.setGain(SRC, action.value, {
									origin: "rest",
								})
							else if (action.field === "gainMode")
								await h.controller.setGainMode(
									SRC,
									action.value % 2 === 1 ? "manual" : "agc",
									{ origin: "rest" },
								)
							else
								await h.controller.setAgcMode(SRC, action.value % 2 === 1, {
									origin: "rest",
								})
							held.add(action.field)
							h.snapshot()
							continue
						}
						if (action.kind === "relay") {
							if (!external) h.relayClient(true)
							const cmd =
								action.field === "gainMode"
									? 3
									: action.field === "gain"
										? 4
										: 8
							h.relayCommand(
								cmd,
								action.field === "gain" ? action.value : action.value % 2,
							)
							if (!external) h.relayClient(false)
							held.add(action.field)
							if (action.field === "gain") held.add("gainMode")
							h.snapshot()
							continue
						}
						const isConnect = action.kind === "connect"
						if (isConnect) {
							if (policy === "reset") held.clear()
							h.connect()
						} else h.sources.emit("payload-started", SRC)
						const s = h.snapshot()
						const configSent = s.sent.filter(e => e[2] === "config")
						const want = isConnect ? expected() : []
						expect(s.frames.slice(0, want.length)).toEqual(want)
						expect(configSent).toHaveLength(want.length)
						expect(
							s.sent.slice(0, want.length).every(e => e[2] === "config"),
						).toBe(true)
						// Written and known, never claimed before.
						if (isConnect && tuner && !external)
							for (const f of ["gainMode", "gain", "agcMode"])
								if (
									!held.has(f) &&
									want.some(w =>
										w.startsWith(
											f === "gainMode" ? "03" : f === "gain" ? "04" : "08",
										),
									)
								)
									expect(s.state.unknownFields ?? []).not.toContain(f)
					}
				},
			),
			{ numRuns: 150 },
		)
	})
})
