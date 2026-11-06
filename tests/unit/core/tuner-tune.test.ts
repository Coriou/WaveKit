/**
 * POST /api/tuner/:sourceId/tune through the real route, TunerController and SourceManager against
 * an in-process fake rtl_tcp on an ephemeral loopback port. Time is faked only for the timers.
 */
import { once } from "node:events"
import type { EventEmitter } from "node:events"
import * as net from "node:net"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	TUNE_RESTORE_MAX_S,
	type TuneRestore,
	type TunerState,
} from "@wavekit/api-types"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { TunerArbiter } from "../../../src/core/scanner/tuner-arbiter.js"
import {
	SourceManager,
	TUNER_COMMAND_TIMEOUT_MS,
	calculateBackoffDelay,
} from "../../../src/core/source-manager.js"
import {
	TunerController,
	type TunerReconnectPolicy,
} from "../../../src/core/tuner-controller.js"
import {
	TUNE_DEADLINE_MS,
	type TunerLeaseHolder,
} from "../../../src/core/tuner-tune.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import { createLogger } from "../../../src/utils/logger.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

const SET_RATE = 2
const SET_FREQUENCY = 1
const SET_GAIN_MODE = 3
const SET_GAIN = 4
const SET_PPM = 5
const START_RATE = 1_024_000
const START_HZ = 100_000_000
const OTHER_RATE = 2_400_000
const TUNE_HZ = 120_000_000
const OTHER_HZ = 130_000_000

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

const quiet = createLogger({ level: "fatal" })

/** `once` without its rejection on "error": a source's errors here are expected. */
const event = (emitter: EventEmitter, name: string): Promise<void> =>
	new Promise(resolve => {
		emitter.once(name, () => resolve())
	})

async function setup(
	options: {
		payloadOnReconnect?: boolean
		reconnectPolicy?: TunerReconnectPolicy
		principal?: "machine" | "session"
	} = {},
) {
	const { payloadOnReconnect = true, principal = "machine" } = options
	let connections = 0
	const sockets: net.Socket[] = []
	const frames: Array<{ cmd: number; value: number; connection: number }> = []
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
			Buffer.concat([
				Buffer.from("RTL0"),
				Buffer.alloc(8),
				Buffer.alloc(connection === 1 || payloadOnReconnect ? 8 : 0),
			]),
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
	const controller = new TunerController(
		quiet,
		manager,
		options.reconnectPolicy ? { reconnectPolicy: options.reconnectPolicy } : {},
	)
	wireTunerControl({
		log: quiet,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	let leaseHolder: TunerLeaseHolder = () => null
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
		principalKind: () => principal,
		scannerLeaseHolder: sourceId => leaseHolder(sourceId),
	})
	await app.ready()
	cleanup.push(() => app.close())
	manager.on("error", () => {})
	controller.on("error", () => {})
	const connect = async () => {
		const payload = event(manager, "payload-started")
		await manager.connect({
			id: "rtl",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: (server.address() as net.AddressInfo).port,
			loop: false,
			playbackSpeed: 1,
			stallTimeoutMs: 0,
			caps: {
				kind: "iq",
				sampleRate: START_RATE,
				centerFreq: START_HZ,
				format: "U8_IQ",
				exclusive: false,
			},
		})
		await payload
	}
	await connect()
	const post = (body: unknown) =>
		app.inject({
			method: "POST",
			url: "/api/tuner/rtl/tune",
			payload: body as object,
		})
	const read = () => controller.getState("rtl")!
	return {
		app,
		controller,
		manager,
		server,
		sockets,
		frames,
		post,
		read,
		connect,
		useLeases: (holder: TunerLeaseHolder) => {
			leaseHolder = holder
		},
		/** What a tune or restore waiting for the source holds on it. */
		waitListeners: () =>
			manager.listenerCount("payload-started") +
			manager.listenerCount("source-removed"),
		/** A command that takes the queue for `ms` of fake time. */
		holdQueue: (ms: number) => {
			void manager
				.runTunerCommand(
					"rtl",
					() =>
						new Promise<void>(resolve => {
							setTimeout(resolve, ms)
						}),
				)
				.catch(() => {})
		},
		connections: () => connections,
		fakeTime: () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			vi.spyOn(Math, "random").mockReturnValue(0)
		},
	}
}

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 2_000; i++) {
		if (done()) return
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
	}
	throw new Error("condition never held")
}

function restoreOf(state: TunerState): TuneRestore {
	if (state.restore === undefined) throw new Error("no restore block")
	return state.restore
}

/** A real arbiter over the harness's controller and source, with its lease losses recorded. */
function arbiterOn(h: Awaited<ReturnType<typeof setup>>) {
	const arbiter = new TunerArbiter({
		tuner: h.controller,
		sources: h.manager,
		epochs: () => undefined,
		settings: () => testSettings(),
		link: () => "network",
		persistLease: () => Promise.resolve(),
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger: pino({ level: "silent" }),
		now: () => Date.now(),
	} as never)
	const lost: string[] = []
	arbiter.on("lease-lost", (_lease: unknown, reason: string) =>
		lost.push(reason),
	)
	h.manager.emit("payload-started", "rtl")
	return { arbiter, lost }
}

describe("tune in one call", () => {
	it("answers usable after the reconnect a rate change brings, in rate, centre, gain order", async () => {
		const h = await setup()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		let answered = false
		const answer = h
			.post({
				sampleRateHz: OTHER_RATE,
				frequencyHz: TUNE_HZ,
				gainMode: "manual",
				gain: 300,
			})
			.finally(() => {
				answered = true
			})
		await disconnected
		expect(answered).toBe(false)
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		const res = await answer
		expect(res.statusCode).toBe(200)
		const body = res.json()
		expect(body.usable).toBe(true)
		expect(body.applied).toEqual([
			"sampleRateHz",
			"frequencyHz",
			"gainMode",
			"gain",
		])
		expect(body.notApplied).toEqual([])
		expect(body).toMatchObject({
			sampleRate: OTHER_RATE,
			frequency: TUNE_HZ,
			gainMode: "manual",
			gain: 300,
		})
		expect(h.manager.isTunerUsable("rtl")).toBe(true)
		expect(h.connections()).toBe(2)
		await until(() => h.frames.some(f => f.connection === 2))
		expect(
			h.frames.filter(f => f.connection === 1).map(f => [f.cmd, f.value]),
		).toEqual([
			[SET_RATE, OTHER_RATE],
			[SET_FREQUENCY, TUNE_HZ],
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 300],
		])
		// The next command works at once: the failure this route exists to end.
		expect((await h.post({ frequencyHz: OTHER_HZ })).json().usable).toBe(true)
	})

	it("needs no reconnect and answers at once without a rate change", async () => {
		const h = await setup()
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({
			usable: true,
			applied: ["frequencyHz"],
			frequency: TUNE_HZ,
			lastChange: { actor: "agent", reason: "rest-command" },
			lastTune: { usable: true, applied: ["frequencyHz"], notApplied: [] },
		})
		expect(h.connections()).toBe(1)
	})

	it("waits for a source that dropped before it writes anything", async () => {
		const h = await setup()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await disconnected
		let answered = false
		const answer = h.post({ frequencyHz: TUNE_HZ }).finally(() => {
			answered = true
		})
		await vi.advanceTimersByTimeAsync(1)
		expect(answered).toBe(false)
		expect(h.frames).toEqual([])
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
		const res = await answer
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({ usable: true, frequency: TUNE_HZ })
		await until(() =>
			h.frames.some(f => f.cmd === SET_FREQUENCY && f.value === TUNE_HZ),
		)
		expect(h.frames.every(f => f.connection === 2)).toBe(true)
	})

	it("answers 503 with the verdict and what was applied, at the deadline and not before", async () => {
		const h = await setup()
		h.server.close()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		let answered = false
		const answer = h
			.post({ sampleRateHz: OTHER_RATE, frequencyHz: TUNE_HZ })
			.finally(() => {
				answered = true
			})
		await disconnected
		// 2 × 9 s: one command, one recovery.
		expect(TUNE_DEADLINE_MS).toBe(2 * TUNER_COMMAND_TIMEOUT_MS)
		expect(TUNE_DEADLINE_MS).toBe(18_000)
		await vi.advanceTimersByTimeAsync(TUNE_DEADLINE_MS - 1)
		expect(answered).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.headers["retry-after"]).toBe("1")
		const body = res.json()
		expect(body).toMatchObject({
			code: "TUNER_NOT_USABLE",
			usable: false,
			applied: ["sampleRateHz", "frequencyHz"],
			notApplied: [],
			state: { lastTune: { usable: false, code: "TUNER_NOT_USABLE" } },
		})
		expect(body.sourceVerdict.code).not.toBe("ok")
		expect(typeof body.sourceVerdict.message).toBe("string")
	})

	it("answers 200 when the source returns after its recovery window but before the deadline", async () => {
		const h = await setup({ payloadOnReconnect: false })
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		const answer = h.post({ sampleRateHz: OTHER_RATE })
		await disconnected
		const reconnected = event(h.manager, "connected")
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		await reconnected
		// Recovery's own bound is 4 s backoff + 5 s connect, far less at this random: past it.
		await vi.advanceTimersByTimeAsync(TUNER_COMMAND_TIMEOUT_MS + 1)
		await until(() => h.sockets.length === 2)
		h.sockets[1]!.write(Buffer.alloc(8))
		const res = await answer
		expect(res.statusCode).toBe(200)
		expect(res.json()).toMatchObject({
			usable: true,
			sampleRate: OTHER_RATE,
		})
	})

	it("starts no write after the deadline for a tune still queued behind other commands", async () => {
		const h = await setup()
		h.fakeTime()
		// Three commands that use up their whole 9 s: the tune would start at 27 s.
		for (let i = 0; i < 3; i++)
			void h.manager
				.runTunerCommand("rtl", () => new Promise<void>(() => {}))
				.catch(() => {})
		let answered = false
		const answer = h.post({ frequencyHz: TUNE_HZ }).finally(() => {
			answered = true
		})
		// In steps: the request reaches the route on a later turn than this line.
		while (!answered) await vi.advanceTimersByTimeAsync(1_000)
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			code: "TUNER_NOT_USABLE",
			applied: [],
			notApplied: ["frequencyHz"],
		})
		// Nothing had started: nothing can still land.
		expect(res.json().inFlight).toBeUndefined()
		await vi.advanceTimersByTimeAsync(3 * TUNER_COMMAND_TIMEOUT_MS)
		await until(() =>
			(h.read().lastTune?.notApplied ?? []).includes("frequencyHz"),
		)
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames).toEqual([])
		expect(h.read().frequency).toBe(START_HZ)
	})

	it("says inFlight when a setting is being written as the deadline passes", async () => {
		const h = await setup()
		// The source never returns from the rate change, whose recovery runs past the deadline.
		h.server.close()
		h.fakeTime()
		// Two commands of 8 s: the tune starts at 16 s, 2 s before its deadline of 18 s.
		h.holdQueue(8_000)
		h.holdQueue(8_000)
		let answered = false
		const answer = h.post({ sampleRateHz: OTHER_RATE }).finally(() => {
			answered = true
		})
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		await vi.advanceTimersByTimeAsync(16_000)
		await until(() => h.frames.some(f => f.cmd === SET_RATE))
		expect(answered).toBe(false)
		while (!answered) await vi.advanceTimersByTimeAsync(100)
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			code: "TUNER_NOT_USABLE",
			usable: false,
			inFlight: true,
		})
	})

	it("reports exactly what applied when a write fails partway", async () => {
		const h = await setup()
		const write = h.manager.writeToSource.bind(h.manager)
		vi.spyOn(h.manager, "writeToSource").mockImplementation((id, frame) => {
			if (frame[0] === SET_GAIN)
				throw Object.assign(new Error("Source rtl is not connected"), {
					code: "SOURCE_DISCONNECTED",
				})
			return write(id, frame)
		})
		const res = await h.post({
			frequencyHz: TUNE_HZ,
			gainMode: "manual",
			gain: 300,
		})
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			code: "SOURCE_DISCONNECTED",
			applied: ["frequencyHz", "gainMode"],
			notApplied: ["gain"],
			state: {
				frequency: TUNE_HZ,
				lastTune: {
					applied: ["frequencyHz", "gainMode"],
					notApplied: ["gain"],
					code: "SOURCE_DISCONNECTED",
				},
			},
		})
	})

	it("is never a false success when a reset reconnect discards the rate", async () => {
		const h = await setup({ reconnectPolicy: "reset" })
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		const answer = h.post({ sampleRateHz: OTHER_RATE })
		await disconnected
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			code: "TUNER_TUNE_PARTIAL",
			usable: true,
			applied: [],
			notApplied: ["sampleRateHz"],
		})
	})

	it("refuses external control as the other routes do and writes nothing", async () => {
		const h = await setup()
		h.controller.setControlMode("rtl", "external")
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(409)
		expect(res.json().code).toBe("TUNER_CONTROL_EXTERNAL")
		expect(h.frames).toEqual([])
	})

	it("takes a scanner lease as the other routes do: the operator preempts it", async () => {
		const h = await setup()
		const { arbiter, lost } = arbiterOn(h)
		const lease = arbiter.acquire("job", "rtl", 50)
		expect(lease.ok).toBe(true)
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(200)
		expect(lost).toEqual(["preempted-operator"])
	})

	it("runs one tune per source and answers a second 409", async () => {
		const h = await setup()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		const first = h.post({ sampleRateHz: OTHER_RATE })
		await disconnected
		const second = await h.post({ frequencyHz: TUNE_HZ })
		expect(second.statusCode).toBe(409)
		expect(second.json().code).toBe("TUNER_TUNE_BUSY")
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		expect((await first).statusCode).toBe(200)
		expect((await h.post({ frequencyHz: TUNE_HZ })).statusCode).toBe(200)
	})

	it("finishes the whole tune and records it when the client goes away", async () => {
		const h = await setup()
		await h.app
			.inject({
				method: "POST",
				url: "/api/tuner/rtl/tune",
				payload: { frequencyHz: TUNE_HZ, gain: 300 },
				simulate: { close: true, end: true, split: false, error: false },
			})
			.catch(() => {})
		await until(() => h.read().lastTune !== undefined)
		expect(h.read()).toMatchObject({
			frequency: TUNE_HZ,
			gain: 300,
			lastTune: { usable: true, applied: ["frequencyHz", "gain"] },
		})
	})

	it.each<[string, Record<string, unknown>, string]>([
		["no setting", {}, "body"],
		["only restoreAfterS", { restoreAfterS: 10 }, "body"],
		["an unknown field", { frequencyHz: TUNE_HZ, hz: 1 }, "body"],
		["a frequency below the range", { frequencyHz: 23_999_999 }, "frequencyHz"],
		[
			"a frequency above the range",
			{ frequencyHz: 1_900_000_001 },
			"frequencyHz",
		],
		["a rate above the range", { sampleRateHz: 3_200_001 }, "sampleRateHz"],
		["a rate in the RTL gap", { sampleRateHz: 500_000 }, "sampleRateHz"],
		["a gain past the range", { gain: 501 }, "gain"],
		["a gain mode outside the list", { gainMode: "auto" }, "gainMode"],
		[
			"a restore of zero",
			{ frequencyHz: TUNE_HZ, restoreAfterS: 0 },
			"restoreAfterS",
		],
		[
			"a restore past the maximum",
			{ frequencyHz: TUNE_HZ, restoreAfterS: TUNE_RESTORE_MAX_S + 1 },
			"restoreAfterS",
		],
		[
			"a restore that is no integer",
			{ frequencyHz: TUNE_HZ, restoreAfterS: 1.5 },
			"restoreAfterS",
		],
	])("answers 400 with nothing written: %s", async (_name, body, field) => {
		const h = await setup()
		const res = await h.post(body)
		expect(res.statusCode).toBe(400)
		const answer = res.json()
		expect(answer.code).toMatch(/VALIDATION_ERROR/)
		expect(JSON.stringify(answer)).not.toContain("23999999")
		expect(answer.fields.map((f: { field: string }) => f.field)).toContain(
			field,
		)
		expect(h.frames).toEqual([])
	})

	it("takes the bounds of the rate and the gain", async () => {
		const h = await setup()
		expect((await h.post({ gain: 0 })).statusCode).toBe(200)
		expect((await h.post({ gain: 500 })).statusCode).toBe(200)
		expect((await h.post({ frequencyHz: 24_000_000 })).statusCode).toBe(200)
		expect((await h.post({ frequencyHz: 1_900_000_000 })).statusCode).toBe(200)
	})

	it("answers at once for a paused feed: nothing will bring it back by itself", async () => {
		const h = await setup()
		await h.manager.pause("rtl")
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			code: "TUNER_NOT_USABLE",
			usable: false,
			applied: [],
			notApplied: ["frequencyHz"],
			sourceVerdict: { code: "feed-paused" },
		})
	})

	it("answers 404 for a source with no tuner", async () => {
		const h = await setup()
		const res = await h.app.inject({
			method: "POST",
			url: "/api/tuner/none/tune",
			payload: { frequencyHz: TUNE_HZ },
		})
		expect(res.statusCode).toBe(404)
		expect(res.json().code).toBe("TUNER_SOURCE_NOT_FOUND")
	})
})

describe("shutdown and source removal during a tune", () => {
	async function waiting() {
		const h = await setup()
		h.fakeTime()
		const dropped = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await dropped
		const listeners = h.waitListeners()
		const timers = vi.getTimerCount()
		const answer = h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		await until(() => h.waitListeners() > listeners)
		return { h, listeners, timers, answer }
	}

	it("aborts a tune waiting for the source on shutdown: it writes nothing when IQ returns", async () => {
		const { h, listeners, timers, answer } = await waiting()
		expect(vi.getTimerCount()).toBeGreaterThan(timers)
		await h.app.close()
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({
			usable: false,
			applied: [],
			notApplied: ["frequencyHz"],
		})
		// Its listeners and its timer are gone, not left for the deadline.
		expect(h.waitListeners()).toBe(listeners)
		expect(vi.getTimerCount()).toBe(timers)
		const back = event(h.manager, "payload-started")
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
		await back
		await vi.advanceTimersByTimeAsync(TUNE_DEADLINE_MS)
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames.filter(f => f.value === TUNE_HZ)).toEqual([])
		expect(h.read().frequency).toBe(START_HZ)
		expect(h.read().restore).toBeUndefined()
	})

	it("aborts the wait after the writes on shutdown: the request answers at once as not usable", async () => {
		const h = await setup({ payloadOnReconnect: false })
		const answer = h.post({ sampleRateHz: OTHER_RATE })
		await until(() => h.frames.some(f => f.value === OTHER_RATE))
		await h.app.close()
		// No payload ever comes, so only the abort can end the wait inside this test's time.
		expect((await answer).json()).toMatchObject({
			usable: false,
			applied: ["sampleRateHz"],
		})
	})

	it("stops a tune queued behind a command on shutdown: its turn writes nothing", async () => {
		const h = await setup()
		h.fakeTime()
		h.holdQueue(5_000)
		const answer = h.post({ frequencyHz: TUNE_HZ, gain: 300 })
		// In its turn at the queue.
		for (let i = 0; i < 2; i++)
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
		await h.app.close()
		expect((await answer).statusCode).toBe(503)
		await vi.advanceTimersByTimeAsync(5_000)
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames).toEqual([])
		expect(h.read().frequency).toBe(START_HZ)
	})

	it("ends a waiting tune when its source goes, with its listeners and timer", async () => {
		const { h, listeners, answer } = await waiting()
		await h.manager.disconnect("rtl")
		const res = await answer
		expect(res.statusCode).toBe(404)
		expect(res.json().code).toBe("TUNER_SOURCE_NOT_FOUND")
		expect(h.waitListeners()).toBe(listeners)
	})

	it("writes nothing to a source re-added under the same id", async () => {
		const h = await setup()
		h.fakeTime()
		h.holdQueue(5_000)
		const answer = h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		await h.manager.disconnect("rtl")
		expect((await answer).statusCode).toBe(404)
		await h.connect()
		// The old tune is over: a new one is not refused as busy.
		await vi.advanceTimersByTimeAsync(5_000)
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames.filter(f => f.value === TUNE_HZ)).toEqual([])
		expect(h.read()).toMatchObject({ frequency: START_HZ })
		expect(h.read().restore).toBeUndefined()
		expect(h.read().lastTune).toBeUndefined()
	})
})

describe("a temporary tune", () => {
	async function tuned(options: Parameters<typeof setup>[0] = {}) {
		const h = await setup(options)
		// A prior tuning the core knows, every field of it.
		const prior = await h.post({
			frequencyHz: OTHER_HZ,
			gainMode: "manual",
			gain: 200,
		})
		expect(prior.statusCode).toBe(200)
		// The rate proof, the centre, the mode and the gain have all arrived.
		await until(() => h.frames.length === 4)
		h.frames.length = 0
		h.fakeTime()
		return h
	}

	it("puts the prior tuning back when due, as the core's own write", async () => {
		const h = await tuned()
		const res = await h.post({
			frequencyHz: TUNE_HZ,
			gain: 300,
			restoreAfterS: 5,
		})
		expect(res.statusCode).toBe(200)
		const armed = restoreOf(res.json())
		expect(armed.status).toBe("pending")
		expect(armed.state).toMatchObject({
			frequency: OTHER_HZ,
			gainMode: "manual",
			gain: 200,
		})
		expect(Date.parse(armed.at)).toBe(Date.now() + 5_000)
		await until(() => h.frames.length === 2)
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(4_999)
		expect(h.read().frequency).toBe(TUNE_HZ)
		await vi.advanceTimersByTimeAsync(1)
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read()).toMatchObject({
			frequency: OTHER_HZ,
			gain: 200,
			lastChange: { actor: "restore", reason: "tune-restore" },
		})
		expect(restoreOf(h.read()).restored).toEqual([
			"sampleRateHz",
			"frequencyHz",
			"gainMode",
			"gain",
		])
		await until(() => h.frames.length === 2)
		expect(h.frames.map(f => [f.cmd, f.value])).toEqual([
			[SET_FREQUENCY, OTHER_HZ],
			[SET_GAIN, 200],
		])
	})

	it("reconnects for a rate it puts back, and ends usable", async () => {
		const h = await tuned()
		const left = event(h.manager, "disconnected")
		const answer = h.post({ sampleRateHz: OTHER_RATE, restoreAfterS: 1 })
		await left
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		expect((await answer).statusCode).toBe(200)
		const back = event(h.manager, "disconnected")
		await vi.advanceTimersByTimeAsync(1_000)
		await back
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read().sampleRate).toBe(START_RATE)
		expect(h.manager.isTunerUsable("rtl")).toBe(true)
	})

	it.each<
		[
			string,
			(h: Awaited<ReturnType<typeof tuned>>) => Promise<void>,
			string,
			string,
		]
	>([
		[
			"an agent's frequency write",
			async h => {
				const res = await h.app.inject({
					method: "POST",
					url: "/api/tuner/rtl/frequency",
					payload: { hz: OTHER_HZ + 1 },
				})
				expect(res.statusCode).toBe(200)
			},
			"agent",
			"tuner-write",
		],
		[
			"a scanner job's hop",
			h =>
				h.controller.setFrequency("rtl", OTHER_HZ + 1, {
					origin: "scanner",
					jobId: "job",
				}),
			"scanner-job",
			"tuner-write",
		],
		[
			"a relay client's write",
			async h => {
				h.controller.applyExternalCommand("rtl", SET_FREQUENCY, OTHER_HZ + 1)
			},
			"relay",
			"external-control",
		],
		[
			"a write to another field",
			async h => {
				const res = await h.app.inject({
					method: "POST",
					url: "/api/tuner/rtl/ppm",
					payload: { ppm: 3 },
				})
				expect(res.statusCode).toBe(200)
			},
			"agent",
			"tuner-write",
		],
		[
			"the control going external",
			async h => {
				h.controller.setControlMode("rtl", "external")
			},
			"relay",
			"external-control",
		],
	])(
		"yields for good to %s and never overwrites it",
		async (_name, interfere, actor, reason) => {
			const h = await tuned()
			const res = await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
			expect(res.statusCode).toBe(200)
			await until(() => h.frames.length >= 1)
			await interfere(h)
			const stayed = h.read()
			expect(restoreOf(stayed).status).toBe("cancelled")
			expect(restoreOf(stayed).cancelledBy).toMatchObject({ actor, reason })
			h.frames.length = 0
			await vi.advanceTimersByTimeAsync(10_000)
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
			expect(h.frames.filter(f => f.value === OTHER_HZ)).toEqual([])
			expect(h.read().frequency).toBe(stayed.frequency)
			expect(h.read().lastChange?.actor).not.toBe("restore")
		},
	)

	it("yields to a tune that stays, even one that changes nothing", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(200)
		expect(restoreOf(res.json())).toMatchObject({
			status: "cancelled",
			cancelledBy: { actor: "agent", reason: "tuner-write" },
		})
		await vi.advanceTimersByTimeAsync(10_000)
		expect(h.read().frequency).toBe(TUNE_HZ)
	})

	it("stops between settings when another actor writes during the restore", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
		const onSent = (
			_id: string,
			command: string,
			_value: number,
			origin?: string,
		) => {
			if (command === "set-frequency" && origin === "rest") {
				h.controller.off("command-sent", onSent)
				void h.controller.setFrequency("rtl", OTHER_HZ + 1, {
					origin: "scanner",
					jobId: "job",
				})
			}
		}
		h.controller.on("command-sent", onSent)
		await vi.advanceTimersByTimeAsync(1_000)
		await until(() => restoreOf(h.read()).status === "cancelled")
		expect(restoreOf(h.read())).toMatchObject({
			cancelledBy: { actor: "scanner-job", reason: "tuner-write" },
			// Its frequency frame went out, but the hop's overwrote it: that setting is not back.
			restored: ["sampleRateHz"],
		})
		expect(h.read().gain).toBe(300)
	})

	describe("with a write landing while a restore frame is in flight", () => {
		const onRestoreFrequency = (
			h: Awaited<ReturnType<typeof tuned>>,
			act: () => void,
		) => {
			const onSent = (
				_id: string,
				command: string,
				value: number,
				origin?: string,
			) => {
				if (command !== "set-frequency" || origin !== "rest") return
				if (value !== OTHER_HZ) return
				h.controller.off("command-sent", onSent)
				act()
			}
			h.controller.on("command-sent", onSent)
		}

		it.each<
			[string, (h: Awaited<ReturnType<typeof tuned>>) => void, string, string]
		>([
			[
				"a relay client",
				h =>
					h.controller.applyExternalCommand("rtl", SET_FREQUENCY, OTHER_HZ + 1),
				"relay",
				"external-control",
			],
			[
				"a scanner hop",
				h => {
					void h.controller.setFrequency("rtl", OTHER_HZ + 1, {
						origin: "scanner",
						jobId: "job",
					})
				},
				"scanner-job",
				"tuner-write",
			],
			[
				"a REST write",
				h => {
					void h.controller.setFrequency("rtl", OTHER_HZ + 1, {
						origin: "rest",
						actor: "agent",
					})
				},
				"agent",
				"tuner-write",
			],
		])(
			"leaves %s in the state and in the replay",
			async (_name, write, actor, reason) => {
				const h = await tuned()
				await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
				await until(() => h.frames.length === 2)
				h.frames.length = 0
				onRestoreFrequency(h, () => write(h))
				await vi.advanceTimersByTimeAsync(1_000)
				await until(() => restoreOf(h.read()).status === "cancelled")
				expect(restoreOf(h.read()).cancelledBy).toMatchObject({ actor, reason })
				// Its setter resumed after the write and changed nothing.
				await new Promise<void>(resolve => {
					setImmediate(resolve)
				})
				expect(h.read().frequency).toBe(OTHER_HZ + 1)
				expect(restoreOf(h.read()).restored).toEqual(["sampleRateHz"])
				// No further restore frame: the gain stays the temporary one.
				expect(h.read().gain).toBe(300)
				await until(() =>
					h.frames.some(f => f.cmd === SET_FREQUENCY && f.value === OTHER_HZ),
				)
				expect(h.frames.some(f => f.cmd === SET_GAIN)).toBe(false)
				h.frames.length = 0
				// A reconnect sync writes what the state holds.
				if (h.read().controlMode === "external")
					h.controller.setControlMode("rtl", "internal")
				const dropped = event(h.manager, "disconnected")
				h.sockets[0]!.destroy()
				await dropped
				const back = event(h.manager, "payload-started")
				await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
				await back
				await until(() => h.frames.some(f => f.cmd === SET_FREQUENCY))
				expect(
					h.frames.filter(f => f.cmd === SET_FREQUENCY).map(f => f.value),
				).toEqual([OTHER_HZ + 1])
				expect(h.read().frequency).toBe(OTHER_HZ + 1)
			},
		)

		it("leaves a REST route queued behind the restore last in the state and the replay", async () => {
			const h = await tuned()
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
			await until(() => h.frames.length === 1)
			let answer: ReturnType<typeof h.post> | undefined
			onRestoreFrequency(h, () => {
				answer = h.app.inject({
					method: "POST",
					url: "/api/tuner/rtl/frequency",
					payload: { hz: OTHER_HZ + 1 },
				}) as ReturnType<typeof h.post>
			})
			await vi.advanceTimersByTimeAsync(1_000)
			await until(() => answer !== undefined)
			expect((await answer!).statusCode).toBe(200)
			expect(h.read().frequency).toBe(OTHER_HZ + 1)
			expect(h.read().lastChange?.actor).toBe("agent")
			h.frames.length = 0
			const dropped = event(h.manager, "disconnected")
			h.sockets[0]!.destroy()
			await dropped
			const back = event(h.manager, "payload-started")
			await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
			await back
			await until(() => h.frames.some(f => f.cmd === SET_FREQUENCY))
			expect(
				h.frames.filter(f => f.cmd === SET_FREQUENCY).map(f => f.value),
			).toEqual([OTHER_HZ + 1])
		})

		it("still shows the setting it did put back when the write was to another field", async () => {
			const h = await tuned()
			await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
			await until(() => h.frames.length === 2)
			onRestoreFrequency(h, () => {
				void h.controller.setPpm("rtl", 3, { origin: "rest", actor: "agent" })
			})
			await vi.advanceTimersByTimeAsync(1_000)
			await until(() => restoreOf(h.read()).status === "cancelled")
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
			expect(h.read()).toMatchObject({ frequency: OTHER_HZ, gain: 300, ppm: 3 })
			expect(restoreOf(h.read()).restored).toEqual([
				"sampleRateHz",
				"frequencyHz",
			])
			await until(() => h.frames.some(f => f.cmd === SET_PPM))
		})
	})

	describe("the 18 s of a restore", () => {
		it("ends at its deadline behind a queue, and writes nothing when the queue clears", async () => {
			const h = await tuned()
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
			await until(() => h.frames.length === 1)
			h.frames.length = 0
			// Three commands of 8 s from now: the restore, due in 5 s, would start 19 s after that.
			for (let i = 0; i < 3; i++) h.holdQueue(8_000)
			await vi.advanceTimersByTimeAsync(5_000 + TUNE_DEADLINE_MS - 1)
			expect(restoreOf(h.read()).status).toBe("restoring")
			await vi.advanceTimersByTimeAsync(1)
			expect(restoreOf(h.read())).toMatchObject({
				status: "failed",
				failure: "TUNER_RESTORE_DEADLINE",
				restored: [],
			})
			await vi.advanceTimersByTimeAsync(3 * 8_000)
			await new Promise<void>(resolve => {
				setImmediate(resolve)
			})
			expect(h.frames).toEqual([])
			expect(h.read().frequency).toBe(TUNE_HZ)
			expect(restoreOf(h.read()).status).toBe("failed")
		})

		// Due at 1 s, so its 18 s end at 19 s; three commands of about 6.3 s hold the queue.
		it.each<[string, number, number, string]>([
			["one tick before", 6_333, 18_999, "restored"],
			["exactly at", 6_334, 19_000, "failed"],
		])(
			"bounds the first write: a queue clearing %s the deadline",
			async (_name, last, end, status) => {
				const h = await tuned()
				await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
				await until(() => h.frames.length === 1)
				h.frames.length = 0
				expect(6_333 + 6_333 + last).toBe(end)
				h.holdQueue(6_333)
				h.holdQueue(6_333)
				h.holdQueue(last)
				await vi.advanceTimersByTimeAsync(end)
				await until(() => restoreOf(h.read()).status === status)
				await new Promise<void>(resolve => {
					setImmediate(resolve)
				})
				const wrote = h.frames.filter(f => f.value === OTHER_HZ)
				expect(wrote.length).toBe(status === "restored" ? 1 : 0)
				expect(h.read().frequency).toBe(
					status === "restored" ? OTHER_HZ : TUNE_HZ,
				)
			},
		)

		it("starts no further write once its budget is spent, even with its timer late", async () => {
			const h = await tuned()
			await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
			await until(() => h.frames.length === 2)
			h.frames.length = 0
			const onSent = (_id: string, command: string, _v: number, o?: string) => {
				if (command !== "set-frequency" || o !== "rest") return
				h.controller.off("command-sent", onSent)
				// The clock passes the deadline with no timer run: a stalled event loop.
				vi.setSystemTime(Date.now() + TUNE_DEADLINE_MS)
			}
			h.controller.on("command-sent", onSent)
			await vi.advanceTimersByTimeAsync(1_000)
			await until(() => restoreOf(h.read()).status === "failed")
			expect(restoreOf(h.read())).toMatchObject({
				failure: "TUNER_RESTORE_DEADLINE",
				// The gain mode was already back, with no write; the gain was not.
				restored: ["sampleRateHz", "frequencyHz", "gainMode"],
			})
			expect(h.read().gain).toBe(300)
			await until(() => h.frames.some(f => f.cmd === SET_FREQUENCY))
			expect(h.frames.some(f => f.cmd === SET_GAIN)).toBe(false)
		})

		it("does not report restored when its budget is spent by the final check", async () => {
			const h = await tuned()
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
			await until(() => h.frames.length === 1)
			const onSent = (_id: string, command: string, _v: number, o?: string) => {
				if (command !== "set-frequency" || o !== "rest") return
				h.controller.off("command-sent", onSent)
				vi.setSystemTime(Date.now() + TUNE_DEADLINE_MS)
			}
			h.controller.on("command-sent", onSent)
			await vi.advanceTimersByTimeAsync(1_000)
			await until(() => restoreOf(h.read()).status !== "restoring")
			expect(restoreOf(h.read())).toMatchObject({
				status: "failed",
				failure: "TUNER_RESTORE_DEADLINE",
				restored: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
			})
			// The write did land before the time ran out: the state says so.
			expect(h.read().frequency).toBe(OTHER_HZ)
		})
	})

	describe("and a scanner lease", () => {
		it("cancels for good when it comes due under a lease with no hop yet, preempting nothing", async () => {
			const h = await tuned()
			const { arbiter, lost } = arbiterOn(h)
			h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
			await until(() => h.frames.some(f => f.value === TUNE_HZ))
			h.frames.length = 0
			const lease = arbiter.acquire("job", "rtl", 50)
			if (!lease.ok) throw new Error("no lease")
			await vi.advanceTimersByTimeAsync(5_000)
			expect(restoreOf(h.read())).toMatchObject({
				status: "cancelled",
				cancelledBy: { actor: "scanner-job", reason: "scanner-lease" },
			})
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")).toBe(lease.lease)
			expect(h.frames).toEqual([])
			// For good: the lease going away brings nothing back.
			await arbiter.release(lease.lease, { restore: false })
			await vi.advanceTimersByTimeAsync(10_000)
			expect(restoreOf(h.read()).status).toBe("cancelled")
			expect(h.frames.filter(f => f.value === OTHER_HZ)).toEqual([])
			expect(h.read().frequency).toBe(TUNE_HZ)
		})

		it("cancels as soon as the state next changes under a lease", async () => {
			const h = await tuned()
			const { arbiter, lost } = arbiterOn(h)
			h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 60 })
			const lease = arbiter.acquire("job", "rtl", 50)
			expect(lease.ok).toBe(true)
			expect(restoreOf(h.read()).status).toBe("pending")
			h.controller.publishState("rtl")
			expect(restoreOf(h.read()).cancelledBy?.reason).toBe("scanner-lease")
			expect(lost).toEqual([])
		})

		it("stops between settings when a lease is taken while it writes", async () => {
			const h = await tuned()
			const { arbiter, lost } = arbiterOn(h)
			h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
			await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
			await until(() =>
				h.frames.some(f => f.cmd === SET_GAIN && f.value === 300),
			)
			h.frames.length = 0
			const onSent = (_id: string, command: string, _v: number, o?: string) => {
				if (command !== "set-frequency" || o !== "rest") return
				h.controller.off("command-sent", onSent)
				expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
			}
			h.controller.on("command-sent", onSent)
			await vi.advanceTimersByTimeAsync(1_000)
			await until(() => restoreOf(h.read()).status === "cancelled")
			expect(restoreOf(h.read()).cancelledBy).toMatchObject({
				actor: "scanner-job",
				reason: "scanner-lease",
			})
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")?.jobId).toBe("job")
			await until(() => h.frames.some(f => f.cmd === SET_FREQUENCY))
			expect(h.frames.some(f => f.cmd === SET_GAIN)).toBe(false)
			expect(h.read().gain).toBe(300)
		})

		it("writes nothing when the lease cannot be read", async () => {
			const h = await tuned()
			h.useLeases(() => {
				throw new Error("no answer")
			})
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
			await until(() => h.frames.length === 1)
			h.frames.length = 0
			await vi.advanceTimersByTimeAsync(5_000)
			expect(restoreOf(h.read()).cancelledBy?.actor).toBe("scanner-job")
			expect(h.frames).toEqual([])
		})
	})

	it("cancels on DELETE, then has nothing left to cancel", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		const url = "/api/tuner/rtl/tune/restore"
		const cancelled = await h.app.inject({ method: "DELETE", url })
		expect(cancelled.statusCode).toBe(200)
		expect(restoreOf(cancelled.json())).toMatchObject({
			status: "cancelled",
			cancelledBy: { actor: "agent", reason: "cancel-request" },
		})
		await vi.advanceTimersByTimeAsync(10_000)
		expect(h.read().frequency).toBe(TUNE_HZ)
		const again = await h.app.inject({ method: "DELETE", url })
		expect(again.statusCode).toBe(404)
		expect(again.json().code).toBe("TUNER_RESTORE_NOT_PENDING")
		const none = await h.app.inject({
			method: "DELETE",
			url: "/api/tuner/none/tune/restore",
		})
		expect(none.statusCode).toBe(404)
		expect(none.json().code).toBe("TUNER_SOURCE_NOT_FOUND")
	})

	it("honours a DELETE that arrives while the temporary tune is still running", async () => {
		const h = await tuned()
		const disconnected = event(h.manager, "disconnected")
		const answer = h.post({ sampleRateHz: OTHER_RATE, restoreAfterS: 1 })
		await disconnected
		const cancelled = await h.app.inject({
			method: "DELETE",
			url: "/api/tuner/rtl/tune/restore",
		})
		expect(cancelled.statusCode).toBe(200)
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		const res = await answer
		expect(res.statusCode).toBe(200)
		expect(restoreOf(res.json())).toMatchObject({
			status: "cancelled",
			cancelledBy: { actor: "agent", reason: "cancel-request" },
		})
		await vi.advanceTimersByTimeAsync(5_000)
		expect(h.read().sampleRate).toBe(OTHER_RATE)
	})

	it("drops the restore with its source", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		await h.manager.disconnect("rtl")
		expect(h.controller.getState("rtl")).toBeUndefined()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(h.frames).toEqual([])
	})

	it("drops the restore on shutdown and writes nothing", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => h.frames.length >= 1)
		h.frames.length = 0
		await h.app.close()
		await vi.advanceTimersByTimeAsync(5_000)
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames).toEqual([])
		expect(h.read().frequency).toBe(TUNE_HZ)
		expect(h.read().restore).toBeUndefined()
	})

	it("ends a restore waiting for the source on shutdown, its listeners and timers with it", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		const dropped = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await dropped
		const before = h.waitListeners()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(restoreOf(h.read()).status).toBe("restoring")
		expect(h.waitListeners()).toBeGreaterThan(before)
		await h.app.close()
		expect(h.waitListeners()).toBe(before)
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(3))
		await new Promise<void>(resolve => {
			setImmediate(resolve)
		})
		expect(h.frames.filter(f => f.value === OTHER_HZ)).toEqual([])
	})

	it("keeps the original snapshot through a new temporary tune, with the new time", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 5 })
		await vi.advanceTimersByTimeAsync(3_000)
		const res = await h.post({ frequencyHz: TUNE_HZ + 1, restoreAfterS: 5 })
		expect(res.statusCode).toBe(200)
		const block = restoreOf(res.json())
		expect(block.status).toBe("pending")
		expect(block.state).toMatchObject({ frequency: OTHER_HZ, gain: 200 })
		expect(Date.parse(block.at)).toBe(Date.now() + 5_000)
		// The first tune's time passes without a write.
		await vi.advanceTimersByTimeAsync(2_000)
		expect(h.read().frequency).toBe(TUNE_HZ + 1)
		expect(restoreOf(h.read()).status).toBe("pending")
		await vi.advanceTimersByTimeAsync(3_000)
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read()).toMatchObject({ frequency: OTHER_HZ, gain: 200 })
	})

	it("keeps the pending restore when a new temporary tune writes nothing", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		const write = h.manager.writeToSource.bind(h.manager)
		const spy = vi.spyOn(h.manager, "writeToSource").mockImplementation(() => {
			throw Object.assign(new Error("Source rtl is not connected"), {
				code: "SOURCE_DISCONNECTED",
			})
		})
		const res = await h.post({ frequencyHz: TUNE_HZ + 1, restoreAfterS: 60 })
		expect(res.statusCode).toBe(503)
		spy.mockImplementation(write)
		expect(restoreOf(h.read()).status).toBe("pending")
		await vi.advanceTimersByTimeAsync(5_000)
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read().frequency).toBe(OTHER_HZ)
	})

	it("keeps the pending restore's time when a new temporary tune finds its values in place", async () => {
		const h = await tuned()
		const first = await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		const due = restoreOf(first.json()).at
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		const again = await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 60 })
		expect(again.statusCode).toBe(200)
		expect(again.json().applied).toEqual(["frequencyHz"])
		expect(restoreOf(again.json())).toMatchObject({
			status: "pending",
			at: due,
		})
		expect(h.frames).toEqual([])
		await vi.advanceTimersByTimeAsync(4_999)
		expect(restoreOf(h.read()).status).toBe("pending")
		await vi.advanceTimersByTimeAsync(1)
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read().frequency).toBe(OTHER_HZ)
	})

	it("refuses when a setting's prior value is unknown, writing nothing", async () => {
		const h = await setup()
		const res = await h.post({ gain: 300, restoreAfterS: 5 })
		expect(res.statusCode).toBe(409)
		expect(res.json().code).toBe("TUNER_RESTORE_PRIOR_UNKNOWN")
		expect(h.frames).toEqual([])
		expect(h.read().restore).toBeUndefined()
	})

	it("goes back to AGC with the mode written last, whatever the state shows", async () => {
		const h = await setup()
		await h.post({ gainMode: "agc" })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		h.fakeTime()
		const res = await h.post({ gain: 300, restoreAfterS: 1 })
		expect(res.statusCode).toBe(200)
		expect(restoreOf(res.json()).state).toMatchObject({ gainMode: "agc" })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(1_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await until(() => h.frames.length >= 1)
		expect(h.frames.at(-1)).toMatchObject({ cmd: SET_GAIN_MODE, value: 0 })
	})

	it("writes the gain again after a mode it puts back", async () => {
		const h = await tuned()
		await h.post({ gainMode: "agc", restoreAfterS: 1 })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(1_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await until(() => h.frames.length === 2)
		expect(h.frames.map(f => [f.cmd, f.value])).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 200],
		])
	})

	it("reports a restore that fails, once, and does not retry", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => h.frames.length >= 1)
		const write = vi
			.spyOn(h.manager, "writeToSource")
			.mockImplementation(() => {
				throw Object.assign(new Error("Source rtl is not connected"), {
					code: "SOURCE_DISCONNECTED",
				})
			})
		await vi.advanceTimersByTimeAsync(1_000)
		await until(() => restoreOf(h.read()).status === "failed")
		expect(restoreOf(h.read()).failure).toBe("SOURCE_DISCONNECTED")
		const attempts = write.mock.calls.length
		await vi.advanceTimersByTimeAsync(60_000)
		expect(write.mock.calls.length).toBe(attempts)
		expect(h.read().frequency).toBe(TUNE_HZ)
	})

	it("yields when a reset reconnect moved the tuner with no write to say who", async () => {
		const h = await tuned({ reconnectPolicy: "reset" })
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 60 })
		const dropped = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await dropped
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
		await until(() => restoreOf(h.read()).status === "cancelled")
		expect(restoreOf(h.read()).cancelledBy?.reason).toBe("state-changed")
	})

	it("keeps a restore through a dropout that replays the same tuning", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 60 })
		const dropped = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await dropped
		const back = event(h.manager, "payload-started")
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
		await back
		expect(restoreOf(h.read()).status).toBe("pending")
		await vi.advanceTimersByTimeAsync(60_000)
		await until(() => restoreOf(h.read()).status === "restored")
		expect(h.read().frequency).toBe(OTHER_HZ)
	})

	it("accepts the bounds of restoreAfterS", async () => {
		const h = await tuned()
		const first = await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		expect(first.statusCode).toBe(200)
		const last = await h.post({
			frequencyHz: TUNE_HZ + 1,
			restoreAfterS: TUNE_RESTORE_MAX_S,
		})
		expect(last.statusCode).toBe(200)
		expect(Date.parse(restoreOf(last.json()).at)).toBe(
			Date.now() + TUNE_RESTORE_MAX_S * 1_000,
		)
	})

	it("shows on GET /api/tuner", async () => {
		const h = await tuned()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		const res = await h.app.inject({ method: "GET", url: "/api/tuner/rtl" })
		expect(restoreOf(res.json())).toMatchObject({
			status: "pending",
			state: { frequency: OTHER_HZ },
		})
		const list = await h.app.inject({ method: "GET", url: "/api/tuner" })
		expect(restoreOf(list.json()[0]).status).toBe("pending")
	})
})
