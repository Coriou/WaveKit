/**
 * WG11 lane GN goldens (requirement 4.6): the connect writes of the WG11 base,
 * recorded before the configured gain change and hardcoded as literals. With
 * no `tuner` configured they must stay byte-identical: rtl_tcp 5-byte frames in
 * order, `command-sent` events and origins, and the frequency/rate trust and
 * `unknownFields` / `declaredOnlyFields` state after each connect. One change since:
 * each connection's first sync writes a declared-only rate and centre (origin
 * `config`, rate first), so they are proven instead of declared only.
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
		assertTunerCommandActive: () => {},
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			frames.push(payload.toString("hex"))
			return true
		}),
		isRtlTcpSource: vi.fn(() => true),
		// An R820T header: there a gain write selects manual gain.
		getRtlTcpInfo: vi.fn(() => ({
			magic: "RTL0",
			tunerType: 5,
			gainCount: 29,
		})),
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
/** The connect write of the declared rate (2.048 Msps) and centre (100 MHz), rate first. */
const DECLARED_FRAMES = ["02001f4000", "0105f5e100"]
const DECLARED_SENT: Array<[string, number, TunerCommandOrigin]> = [
	["set-sample-rate", 2_048_000, "config"],
	["set-frequency", 100_000_000, "config"],
]

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

	it("no desired fields: the declared tuning on each connect, nothing on a repeat", () => {
		const h = harness()
		h.connect()
		const connected = (commandCount: number) => ({
			frames: DECLARED_FRAMES,
			sent: DECLARED_SENT,
			state: {
				...baseState,
				commandCount,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
		expect(h.snapshot()).toEqual(connected(2))
		// Once per connection, as the configured gain: the proof stays, the per-sync write record goes.
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual({
			...connected(2),
			frames: [],
			sent: [],
			tuningWritten: false,
		})
		h.connect()
		expect(h.snapshot()).toEqual(connected(4))
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
				commandCount: 4,
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
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
		const replayed = (commandCount: number, declared: boolean) => ({
			frames: [
				...(declared ? DECLARED_FRAMES : []),
				"0300000001",
				"040000012c",
			],
			sent: [
				...(declared ? DECLARED_SENT : []),
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
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
		h.connect()
		expect(h.snapshot()).toEqual(replayed(8, true))
		// A second payload-started on the same connection replays again today (the declared tuning once).
		h.sources.emit("payload-started", SRC)
		expect(h.snapshot()).toEqual({
			...replayed(10, false),
			tuningWritten: false,
		})
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
				commandCount: 3,
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
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
		h.connect()
		expect(h.snapshot()).toEqual({
			frames: [...DECLARED_FRAMES, "0400000118"],
			sent: [...DECLARED_SENT, ["set-gain", 280, "replay"]],
			state: {
				...baseState,
				gainMode: "manual",
				gain: 280,
				commandCount: 6,
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
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
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
		// The reset policy writes no tuning: centre and rate are declared only again.
		expect(h.snapshot()).toEqual({
			frames: [],
			sent: [],
			state: {
				...baseState,
				commandCount: 3,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: ["frequency", "sampleRate"],
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
				commandCount: 6,
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
				commandCount: 6,
				unknownFields: UNKNOWN_ALL_GAIN,
				declaredOnlyFields: undefined,
			},
			tuningWritten: true,
		})
	})
})
