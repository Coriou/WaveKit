/**
 * WG11 lane GN goldens (requirement 4.6): the connect writes of the WG11 base,
 * recorded before the configured gain change and hardcoded as literals. With
 * no `tuner` configured they must stay byte-identical: rtl_tcp 5-byte frames in
 * order, `command-sent` events and origins, and the frequency/rate trust and
 * `unknownFields` / `declaredOnlyFields` state after each connect.
 *
 * In-memory fake transport only (no socket).
 */
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TunerCommandOrigin } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import {
	TunerController,
	type TunerReconnectPolicy,
} from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
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
	const sources = Object.assign(new EventEmitter(), {
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
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
	return { controller, sources, connect, snapshot, relayClient, relayCommand }
}

const UNKNOWN_ALL_GAIN = [
	"gainMode",
	"gain",
	"ppm",
	"agcMode",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
]
const DECLARED_BOTH = ["frequency", "sampleRate"]

const baseState = {
	frequency: 100_000_000,
	sampleRate: 2_048_000,
	gainMode: "agc",
	gain: 0,
	agcMode: true,
	controlMode: "internal",
	lastError: undefined,
}

describe("WG11 GN goldens: connect writes without a configured tuner", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-10-17T00:00:00Z"))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("no desired fields: nothing written on connect, repeat or reconnect", () => {
		const h = harness()
		h.connect()
		const idle = {
			frames: [],
			sent: [],
			state: {
				...baseState,
				commandCount: 0,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		}
		expect(h.snapshot()).toEqual(idle)
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual(idle)
		h.connect()
		expect(h.snapshot()).toEqual(idle)
	})

	it("desired gain via REST: replayed with origin replay on every payload-started", async () => {
		const h = harness()
		h.connect()
		h.snapshot()
		await h.controller.setGainMode(SRC, "manual", { origin: "rest" })
		await h.controller.setGain(SRC, 300, { origin: "rest" })
		expect(h.snapshot()).toEqual({
			frames: ["0300000001", "040000012c"],
			sent: [
				["set-gain-mode", 1, "rest"],
				["set-gain", 300, "rest"],
			],
			state: {
				...baseState,
				gainMode: "manual",
				gain: 300,
				commandCount: 2,
				unknownFields: [
					"ppm",
					"agcMode",
					"biasTee",
					"directSampling",
					"offsetTuning",
					"ifGain",
					"tunerIfGain",
					"testMode",
				],
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		})
		const replayed = (commandCount: number) => ({
			frames: ["0300000001", "040000012c"],
			sent: [
				["set-gain-mode", 1, "replay"],
				["set-gain", 300, "replay"],
			],
			state: {
				...baseState,
				gainMode: "manual",
				gain: 300,
				commandCount,
				unknownFields: [
					"ppm",
					"agcMode",
					"biasTee",
					"directSampling",
					"offsetTuning",
					"ifGain",
					"tunerIfGain",
					"testMode",
				],
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		})
		h.connect()
		expect(h.snapshot()).toEqual(replayed(4))
		// A second payload-started on the same connection replays again today.
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual(replayed(6))
	})

	it("relay-accepted gain: replayed after the relay client leaves", () => {
		const h = harness()
		h.connect()
		h.snapshot()
		h.relayClient(true)
		h.relayCommand(0x04, 280)
		h.relayClient(false)
		expect(h.snapshot()).toEqual({
			frames: [],
			sent: [],
			state: {
				...baseState,
				gainMode: "manual",
				gain: 280,
				commandCount: 1,
				unknownFields: [
					"ppm",
					"agcMode",
					"biasTee",
					"directSampling",
					"offsetTuning",
					"ifGain",
					"tunerIfGain",
					"testMode",
				],
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		})
		h.connect()
		expect(h.snapshot()).toEqual({
			frames: ["0400000118"],
			sent: [["set-gain", 280, "replay"]],
			state: {
				...baseState,
				gainMode: "manual",
				gain: 280,
				commandCount: 2,
				unknownFields: [
					"ppm",
					"agcMode",
					"biasTee",
					"directSampling",
					"offsetTuning",
					"ifGain",
					"tunerIfGain",
					"testMode",
				],
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		})
	})

	it("reset policy: accepted gain and tuning discarded, nothing written", async () => {
		const h = harness("reset")
		h.connect()
		h.snapshot()
		await h.controller.setGainMode(SRC, "manual", { origin: "rest" })
		await h.controller.setGain(SRC, 300, { origin: "rest" })
		await h.controller.setFrequency(SRC, 145_000_000, { origin: "rest" })
		h.snapshot()
		h.connect()
		expect(h.snapshot()).toEqual({
			frames: [],
			sent: [],
			state: {
				...baseState,
				commandCount: 3,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: DECLARED_BOTH,
			},
			tuningWritten: false,
		})
	})

	it("external (relay) control: today's replay still writes accepted state", async () => {
		const h = harness()
		h.connect()
		h.snapshot()
		await h.controller.setSampleRate(SRC, 2_400_000, { origin: "rest" })
		await h.controller.setFrequency(SRC, 145_000_000, { origin: "rest" })
		h.relayClient(true)
		h.snapshot()
		h.connect()
		expect(h.snapshot()).toEqual({
			frames: ["0200249f00", "0108a48640"],
			sent: [
				["set-sample-rate", 2_400_000, "replay"],
				["set-frequency", 145_000_000, "replay"],
			],
			state: {
				...baseState,
				frequency: 145_000_000,
				sampleRate: 2_400_000,
				controlMode: "external",
				commandCount: 4,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
	})

	it("reconnect: tuning trust is per connection (proven only after replay)", async () => {
		const h = harness()
		h.connect()
		await h.controller.setSampleRate(SRC, 2_400_000, { origin: "rest" })
		await h.controller.setFrequency(SRC, 145_000_000, { origin: "rest" })
		const live = h.snapshot()
		expect(live.tuningWritten).toBe(true)
		h.sources.emit("connected", SRC)
		expect(h.controller.tuningWrittenOnConnection(SRC)).toBe(true)
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual({
			frames: ["0200249f00", "0108a48640"],
			sent: [
				["set-sample-rate", 2_400_000, "replay"],
				["set-frequency", 145_000_000, "replay"],
			],
			state: {
				...baseState,
				frequency: 145_000_000,
				sampleRate: 2_400_000,
				commandCount: 4,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
	})
})
