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

/** The fake's rtl_tcp header: tuner type and gain count (an R820T unless a test says otherwise). */
type Header = { tunerType: number; gainCount: number }
const R820T: Header = { tunerType: 5, gainCount: 29 }

function headerBytes({ tunerType, gainCount }: Header): Buffer {
	const header = Buffer.alloc(12)
	header.write("RTL0", 0, "ascii")
	header.writeUInt32BE(tunerType, 4)
	header.writeUInt32BE(gainCount, 8)
	return header
}

async function setup(tuner?: SourceTunerConfig, header: Header = R820T) {
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
		socket.write(Buffer.concat([headerBytes(header), Buffer.alloc(8)]))
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
 * rtl_tcp's gain mode after the frames it got on an R820T: SET_GAIN and SET_TUNER_GAIN_INDEX both go
 * through `rtlsdr_set_tuner_gain`, which selects manual there. The receiver keeps its mode across
 * connections.
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
		name: "a gain, then AGC from manual",
		tuner: MANUAL_445,
		steps: [{ write: { gain: 300 } }, { write: { gainMode: "agc" } }],
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
		await patch({ gain: 220 })
		await patch({ gainMode: "agc" })
		expect(h.read().gainMode).toBe("agc")
		await reconnect()
		expect(h.read().gainMode).toBe("agc")
	})
})

describe("a gain write leaves AGC only where the tuner does", () => {
	const unknownMode = (state: TunerState) =>
		(state.unknownFields ?? []).includes("gainMode")

	it.each([
		{ name: "R820T", header: { tunerType: 5, gainCount: 29 } },
		{ name: "R828D", header: { tunerType: 6, gainCount: 29 } },
	])(
		"$name: a gain and a gain index from AGC read manual",
		async ({ header }) => {
			const h = await setup(AGC, header)
			await h.flushed()
			await h.controller.setGain("rtl", 300, { origin: "rest" })
			expect(h.read().gainMode).toBe("manual")
			expect(unknownMode(h.read())).toBe(false)
			await h.controller.setGainMode("rtl", "agc", { origin: "rest" })
			await h.controller.setTunerGainIndex("rtl", 28, { origin: "rest" })
			expect(h.read().gainMode).toBe("manual")
			expect(unknownMode(h.read())).toBe(false)
		},
	)

	it.each([
		{ name: "E4000", header: { tunerType: 1, gainCount: 14 } },
		{ name: "FC0013", header: { tunerType: 3, gainCount: 23 } },
		{ name: "no gain table", header: { tunerType: 0, gainCount: 0 } },
	])(
		"$name: a gain or gain index from AGC leaves the mode unknown",
		async ({ header }) => {
			const h = await setup(AGC, header)
			await h.flushed()
			expect(h.read().gainMode).toBe("agc")
			expect(unknownMode(h.read())).toBe(false)
			await h.controller.setGain("rtl", 300, { origin: "rest" })
			expect(unknownMode(h.read())).toBe(true)
			// The next AGC request is written, and proves the mode again.
			const res = await h.app.inject({
				method: "PATCH",
				url: "/api/tuner/rtl/config",
				payload: { gainMode: "agc" },
			})
			expect(res.statusCode).toBe(200)
			await h.flushed()
			expect(h.gainFrames(1).at(-1)).toEqual([SET_GAIN_MODE, 0])
			expect(unknownMode(h.read())).toBe(false)
			await h.controller.setTunerGainIndex("rtl", 0, { origin: "rest" })
			expect(unknownMode(h.read())).toBe(true)
		},
	)

	it("E4000: a gain written while an AGC write is in flight never keeps the old manual", async () => {
		const h = await setup(MANUAL_445, { tunerType: 1, gainCount: 14 })
		await h.flushed()
		expect(h.read().gainMode).toBe("manual")
		expect(unknownMode(h.read())).toBe(false)
		const agc = h.controller.setGainMode("rtl", "agc", { origin: "rest" })
		const gain = h.controller.setGain("rtl", 300, { origin: "rest" })
		await Promise.all([agc, gain])
		await h.flushed()
		expect(h.gainFrames(1).slice(-2)).toEqual([
			[SET_GAIN_MODE, 0],
			[SET_GAIN, 300],
		])
		// The receiver is in AGC (E4000 gain writes keep the mode): never claim manual.
		expect(unknownMode(h.read())).toBe(true)
	})

	it("a gain index rtl_tcp ignores (past the gain table) leaves the mode unknown", async () => {
		const h = await setup(AGC, { tunerType: 5, gainCount: 3 })
		await h.flushed()
		await h.controller.setTunerGainIndex("rtl", 3, { origin: "rest" })
		expect(unknownMode(h.read())).toBe(true)
	})

	it("an IF gain from a relay client never moves the gain mode", async () => {
		const h = await setup(AGC)
		await h.flushed()
		h.controller.applyExternalCommand("rtl", 0x06, 5)
		expect(h.read().gainMode).toBe("agc")
		expect(unknownMode(h.read())).toBe(false)
		h.controller.applyExternalCommand("rtl", 0x0e, (1 << 16) | 30)
		expect(h.read().gainMode).toBe("agc")
		expect(unknownMode(h.read())).toBe(false)
	})

	it("relay gain frames follow the same rule", async () => {
		const r820t = await setup(AGC)
		await r820t.flushed()
		r820t.controller.applyExternalCommand("rtl", SET_TUNER_GAIN_INDEX, 99)
		expect(unknownMode(r820t.read())).toBe(true)
		r820t.controller.applyExternalCommand("rtl", SET_TUNER_GAIN_INDEX, 4)
		expect(r820t.read().gainMode).toBe("manual")
		expect(unknownMode(r820t.read())).toBe(false)
		for (const close of cleanup.splice(0).reverse()) await close()
		const e4000 = await setup(AGC, { tunerType: 1, gainCount: 14 })
		await e4000.flushed()
		e4000.controller.applyExternalCommand("rtl", SET_GAIN, 300)
		expect(unknownMode(e4000.read())).toBe(true)
	})
})

describe("PATCH /config and the gain index route refuse what rtl_tcp would not do", () => {
	const patch = (
		h: Awaited<ReturnType<typeof setup>>,
		payload: Record<string, unknown>,
	) => h.app.inject({ method: "PATCH", url: "/api/tuner/rtl/config", payload })

	it.each([
		{ gainMode: "agc", gain: 317 },
		{ gainMode: "agc", tunerGainIndex: 7 },
		{ gainMode: "agc", gain: 317, tunerGainIndex: 7 },
	])(
		"AGC beside a gain or gain index: 400 naming the conflict, nothing written (%o)",
		async payload => {
			const h = await setup(MANUAL_445)
			await h.flushed()
			const before = h.gainFrames(1)
			const res = await patch(h, payload)
			expect(res.statusCode).toBe(400)
			const body = res.json<{
				code: string
				message: string
				fields: unknown
			}>()
			expect(body.code).toBe("VALIDATION_ERROR")
			expect(body.message).toContain(
				'"gainMode" "agc" cannot be sent with "gain" or "tunerGainIndex"',
			)
			expect(body.fields).toEqual([
				{
					field: "gainMode",
					expected: expect.stringContaining("in one update"),
				},
			])
			expect(res.body).not.toContain("317")
			expect(res.body).not.toMatch(/\b7\b/)
			await h.flushed()
			expect(h.gainFrames(1)).toEqual(before)
			expect(h.read().gainMode).toBe("manual")
		},
	)

	it.each([29, 30, 1000])(
		"a gain index at or past the gain table (%i) is a 400 naming the range",
		async index => {
			const h = await setup(MANUAL_445)
			await h.flushed()
			const before = h.gainFrames(1)
			const expected =
				"integer, tuner gain table index (0-28) for this receiver"
			const viaPatch = await patch(h, { tunerGainIndex: index })
			expect(viaPatch.statusCode).toBe(400)
			expect(viaPatch.json()).toMatchObject({
				code: "VALIDATION_ERROR",
				message: `Invalid tuner value at tunerGainIndex; expected ${expected}`,
				fields: [{ field: "tunerGainIndex", expected }],
			})
			const viaPost = await h.app.inject({
				method: "POST",
				url: "/api/tuner/rtl/tuner-gain-index",
				payload: { index },
			})
			expect(viaPost.statusCode).toBe(400)
			expect(viaPost.json()).toMatchObject({
				message: `Invalid tuner value at index; expected ${expected}`,
				fields: [{ field: "index", expected }],
			})
			await h.flushed()
			expect(h.gainFrames(1)).toEqual(before)
		},
	)

	it("the last index in the gain table is written", async () => {
		const h = await setup(MANUAL_445)
		await h.flushed()
		const res = await patch(h, { tunerGainIndex: 28 })
		expect(res.statusCode).toBe(200)
		await h.flushed()
		expect(h.gainFrames(1).at(-1)).toEqual([SET_TUNER_GAIN_INDEX, 28])
	})

	it("with no gain table in the header the index is not range-checked (the mode goes unknown)", async () => {
		const h = await setup(AGC, { tunerType: 0, gainCount: 0 })
		await h.flushed()
		const res = await patch(h, { tunerGainIndex: 5 })
		expect(res.statusCode).toBe(200)
		expect(h.read().unknownFields ?? []).toContain("gainMode")
	})
})
