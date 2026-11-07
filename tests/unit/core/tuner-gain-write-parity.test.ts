/**
 * Gain writes through PATCH /api/tuner/:sourceId/config and POST /api/tuner/:sourceId/tune, the
 * controller setters and relay commands, through the real routes, TunerController and SourceManager
 * against an in-process fake rtl_tcp on an ephemeral loopback port. A model of rtl_tcp's gain mode
 * (SET_GAIN and SET_TUNER_GAIN_INDEX select manual) checks that the state never claims a mode the
 * receiver does not have. Time is faked only for the reconnect backoff.
 */
import { type EventEmitter, once } from "node:events"
import * as net from "node:net"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import type { SourceTunerConfig } from "../../../src/config.js"
import {
	SourceManager,
	calculateBackoffDelay,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"

const SET_GAIN_MODE = 3
const SET_GAIN = 4
const SET_PPM = 5
const SET_TUNER_GAIN_INDEX = 0x0d
const GAIN_FRAMES = new Set([SET_GAIN_MODE, SET_GAIN, SET_TUNER_GAIN_INDEX])

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

const quiet = createLogger({ level: "fatal" })

const event = (emitter: EventEmitter, name: string): Promise<void> =>
	new Promise(resolve => {
		emitter.once(name, () => resolve())
	})

type Frame = { cmd: number; value: number; connection: number }

async function setup(tuner?: SourceTunerConfig) {
	let connections = 0
	const sockets: net.Socket[] = []
	const frames: Frame[] = []
	const server = net.createServer(socket => {
		sockets.push(socket)
		const connection = ++connections
		socket.on("error", () => {})
		let pending = Buffer.alloc(0)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			while (pending.length >= 5) {
				frames.push({
					cmd: pending.readUInt8(0),
					value: pending.readUInt32BE(1),
					connection,
				})
				pending = pending.subarray(5)
			}
		})
		socket.write(
			Buffer.concat([Buffer.from("RTL0"), Buffer.alloc(8), Buffer.alloc(8)]),
		)
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => {
			server.close(() => resolve())
		})
	})
	const manager = new SourceManager(quiet)
	cleanup.push(() => manager.disconnectAll())
	const controller = new TunerController(quiet, manager, {})
	wireTunerControl({
		log: quiet,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
		principalKind: () => "machine",
		scannerLeaseHolder: () => null,
		receiverStatus: () => undefined,
	})
	await app.ready()
	cleanup.push(() => app.close())
	manager.on("error", () => {})
	controller.on("error", () => {})
	const payload = event(manager, "payload-started")
	await manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: (server.address() as net.AddressInfo).port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		...(tuner ? { tuner } : {}),
		caps: {
			kind: "iq",
			sampleRate: 1_024_000,
			centerFreq: 100_000_000,
			format: "U8_IQ",
			exclusive: false,
		},
	})
	await payload
	const read = () => controller.getState("rtl")!
	let marker = 0
	/** Every frame written so far has reached the fake: a PPM marker after them has arrived. */
	const flushed = async () => {
		const connection = connections
		const value = ++marker
		await controller.setPpm("rtl", value)
		for (let i = 0; i < 2_000; i++) {
			if (
				frames.some(
					f =>
						f.connection === connection &&
						f.cmd === SET_PPM &&
						f.value === value,
				)
			)
				return
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
		}
		throw new Error("the marker never arrived")
	}
	/** Drops the connection and waits for the next one's payload (fake time). */
	const reconnect = async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		vi.spyOn(Math, "random").mockReturnValue(0)
		const before = connections
		const back = event(manager, "payload-started")
		const dropped = event(manager, "disconnected")
		sockets[sockets.length - 1]!.destroy()
		await dropped
		for (let n = 1; connections === before && n < 8; n++)
			await vi.advanceTimersByTimeAsync(calculateBackoffDelay(n))
		await back
		vi.useRealTimers()
	}
	const gainFrames = (connection: number) =>
		frames
			.filter(f => f.connection === connection && GAIN_FRAMES.has(f.cmd))
			.map(f => [f.cmd, f.value] as [number, number])
	return {
		app,
		controller,
		frames,
		read,
		flushed,
		reconnect,
		gainFrames,
		connections: () => connections,
	}
}

/**
 * rtl_tcp's gain mode after the frames it got: SET_GAIN and SET_TUNER_GAIN_INDEX both go through
 * `rtlsdr_set_tuner_gain`, which selects manual. The receiver keeps its mode across connections.
 */
function modelMode(frames: readonly Frame[]): "agc" | "manual" | undefined {
	let mode: "agc" | "manual" | undefined
	for (const { cmd, value } of frames) {
		if (cmd === SET_GAIN || cmd === SET_TUNER_GAIN_INDEX) mode = "manual"
		else if (cmd === SET_GAIN_MODE) mode = value === 1 ? "manual" : "agc"
	}
	return mode
}

/** A known gain mode in the state is the receiver's. */
function expectAgrees(state: TunerState, frames: readonly Frame[]) {
	const mode = modelMode(frames)
	if (mode === undefined) return
	if ((state.unknownFields ?? []).includes("gainMode")) return
	expect(state.gainMode).toBe(mode)
}

type Step =
	| { write: Record<string, unknown> }
	| { index: number }
	| { setGain: number }

type Route = "patch" | "tune"

async function run(
	h: Awaited<ReturnType<typeof setup>>,
	route: Route,
	steps: readonly Step[],
) {
	for (const step of steps) {
		if ("index" in step)
			await h.controller.setTunerGainIndex("rtl", step.index, {
				origin: "rest",
			})
		else if ("setGain" in step)
			await h.controller.setGain("rtl", step.setGain, { origin: "rest" })
		else {
			const res = await h.app.inject(
				route === "patch"
					? {
							method: "PATCH",
							url: "/api/tuner/rtl/config",
							payload: step.write,
						}
					: {
							method: "POST",
							url: "/api/tuner/rtl/tune",
							payload: step.write,
						},
			)
			expect(res.statusCode).toBe(200)
		}
		await h.flushed()
		expectAgrees(h.read(), h.frames)
	}
}

/** What a route's writes leave: the live gain frames, the replay's, and the gain state after it. */
async function outcome(
	route: Route,
	tuner: SourceTunerConfig | undefined,
	steps: readonly Step[],
) {
	const h = await setup(tuner)
	await h.flushed()
	await run(h, route, steps)
	const live = h.gainFrames(1)
	const liveState = pick(h.read())
	await h.reconnect()
	await h.flushed()
	expectAgrees(h.read(), h.frames)
	const result = {
		live,
		liveState,
		replay: h.gainFrames(h.connections()),
		state: pick(h.read()),
	}
	for (const close of cleanup.splice(0).reverse()) await close()
	return result
}

function pick(state: TunerState) {
	const unknown = (state.unknownFields ?? []).filter(
		f => f === "gainMode" || f === "gain",
	)
	return {
		...(unknown.includes("gainMode") ? {} : { gainMode: state.gainMode }),
		...(unknown.includes("gain") || state.gainMode === "agc"
			? {}
			: { gain: state.gain }),
		unknown,
	}
}

const MANUAL_445: SourceTunerConfig = { gainMode: "manual", gainDb: 44.5 }
const AGC: SourceTunerConfig = { gainMode: "agc" }

const CASES: Array<{
	name: string
	tuner?: SourceTunerConfig
	steps: Step[]
}> = [
	{
		name: "the configured manual mode asked again beside a held gain index",
		tuner: MANUAL_445,
		steps: [{ index: 2 }, { write: { gainMode: "manual" } }],
	},
	{
		name: "a gain, then the configured manual mode asked again",
		tuner: MANUAL_445,
		steps: [{ write: { gain: 300 } }, { write: { gainMode: "manual" } }],
	},
	{
		name: "AGC, then the configured gain asked again",
		tuner: MANUAL_445,
		steps: [{ write: { gainMode: "agc" } }, { write: { gain: 445 } }],
	},
	{
		name: "a gain alone on a configured AGC tuner",
		tuner: AGC,
		steps: [{ write: { gain: 300 } }],
	},
	{
		name: "AGC asked again after a gain index on a configured AGC tuner",
		tuner: AGC,
		steps: [{ index: 2 }, { write: { gainMode: "agc" } }],
	},
	{
		name: "manual with a gain, AGC, then a gain index",
		steps: [
			{ write: { gainMode: "manual", gain: 200 } },
			{ write: { gainMode: "agc" } },
			{ index: 2 },
		],
	},
	{
		name: "AGC with a gain from manual",
		tuner: MANUAL_445,
		steps: [{ write: { gainMode: "agc", gain: 300 } }],
	},
	{
		name: "AGC on a fresh tuner whose mode was never set",
		steps: [{ write: { gainMode: "agc" } }],
	},
	{
		name: "manual on a fresh tuner whose mode was never set",
		steps: [{ write: { gainMode: "manual" } }],
	},
	{
		name: "a setter gain on AGC, then AGC asked again",
		tuner: AGC,
		steps: [{ setGain: 250 }, { write: { gainMode: "agc" } }],
	},
]

describe("PATCH /config and POST /tune write the gain alike", () => {
	it.each(CASES)(
		"$name: the same frames, replay and state through both",
		async ({ tuner, steps }) => {
			const patch = await outcome("patch", tuner, steps)
			const tune = await outcome("tune", tuner, steps)
			expect(patch).toEqual(tune)
		},
	)

	it("a mode in place beside a held gain index stays known after a reconnect through PATCH", async () => {
		const { state, replay } = await outcome(
			"patch",
			MANUAL_445,
			CASES[0]!.steps,
		)
		expect(replay).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_TUNER_GAIN_INDEX, 2],
		])
		expect(state.gainMode).toBe("manual")
		expect(state.unknown).not.toContain("gainMode")
	})

	it("a mode in place beside a held gain stays known after a reconnect through PATCH", async () => {
		const { state, replay } = await outcome(
			"patch",
			MANUAL_445,
			CASES[1]!.steps,
		)
		expect(replay).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 300],
		])
		expect(state).toMatchObject({ gainMode: "manual", gain: 300 })
		expect(state.unknown).toEqual([])
	})

	it("PATCH writes a mode it never proved, even at the value the state shows", async () => {
		const { live, state } = await outcome("patch", undefined, CASES[7]!.steps)
		expect(live).toEqual([[SET_GAIN_MODE, 0]])
		expect(state).toMatchObject({ gainMode: "agc" })
		expect(state.unknown).not.toContain("gainMode")
	})
})

describe("a gain write leaves AGC, as on the receiver", () => {
	it("AGC asked after a gain index writes the mode", async () => {
		const h = await setup(AGC)
		await h.flushed()
		await h.controller.setTunerGainIndex("rtl", 2, { origin: "rest" })
		await h.flushed()
		expect(h.read().gainMode).toBe("manual")
		const res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl/tune",
			payload: { gainMode: "agc" },
		})
		expect(res.json()).toMatchObject({ applied: ["gainMode"], notApplied: [] })
		await h.flushed()
		expect(h.gainFrames(1).at(-1)).toEqual([SET_GAIN_MODE, 0])
		expect(h.read().gainMode).toBe("agc")
	})

	it("state and receiver agree at every step across setters, both routes, relay commands and reconnects", async () => {
		const h = await setup(AGC)
		await h.flushed()
		const check = async () => {
			await h.flushed()
			expectAgrees(h.read(), h.frames)
		}
		const patch = async (payload: Record<string, unknown>) => {
			const res = await h.app.inject({
				method: "PATCH",
				url: "/api/tuner/rtl/config",
				payload,
			})
			expect(res.statusCode).toBe(200)
			await check()
		}
		const tune = async (payload: Record<string, unknown>) => {
			const res = await h.app.inject({
				method: "POST",
				url: "/api/tuner/rtl/tune",
				payload,
			})
			expect(res.statusCode).toBe(200)
			await check()
		}
		/** A relay client's frame reaches the receiver, and the controller applies it. */
		const relay = async (cmd: number, value: number) => {
			h.frames.push({ cmd, value, connection: h.connections() })
			h.controller.applyExternalCommand("rtl", cmd, value)
			expectAgrees(h.read(), h.frames)
			await h.controller.configure("rtl", { controlMode: "internal" })
			await check()
		}
		const reconnect = async () => {
			await h.reconnect()
			await check()
		}

		await h.controller.setGain("rtl", 300, { origin: "rest" })
		await check()
		expect(h.read().gainMode).toBe("manual")
		await tune({ gainMode: "agc" })
		expect(h.read().gainMode).toBe("agc")
		await h.controller.setTunerGainIndex("rtl", 3, { origin: "rest" })
		await check()
		expect(h.read().gainMode).toBe("manual")
		await reconnect()
		await patch({ gainMode: "agc" })
		expect(h.read().gainMode).toBe("agc")
		await patch({ gain: 250 })
		expect(h.read().gainMode).toBe("manual")
		await reconnect()
		await patch({ tunerGainIndex: 4 })
		await tune({ gainMode: "agc", gain: 200 })
		expect(h.read().gainMode).toBe("agc")
		await reconnect()
		await relay(SET_GAIN, 150)
		expect(h.read().gainMode).toBe("manual")
		await tune({ gainMode: "agc" })
		await relay(SET_TUNER_GAIN_INDEX, 1)
		await reconnect()
		await tune({ gain: 220 })
		expect(h.read().gainMode).toBe("manual")
		await patch({ gainMode: "agc", gain: 220 })
		expect(h.read().gainMode).toBe("agc")
		await reconnect()
		expect(h.read().gainMode).toBe("agc")
	})
})
