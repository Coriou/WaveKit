/**
 * POST /api/tuner/:sourceId/tune through the real route, TunerController and SourceManager against
 * an in-process fake rtl_tcp on an ephemeral loopback port. Time is faked only for the timers.
 */
import { EventEmitter, once } from "node:events"
import * as net from "node:net"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	TUNE_RESTORE_MAX_S,
	type SdrHostStatus,
	type TuneRestore,
	type TunerState,
} from "@wavekit/api-types"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import type { SourceTunerConfig } from "../../../src/config.js"
import {
	ApiServer,
	type ApiServerDependencies,
} from "../../../src/api/server.js"
import {
	BAND_GAIN_SAVED_FILE_NAME,
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import { identifyTargetNextStep } from "../../../src/core/scanner/identify.js"
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
	type TunerLeaseJob,
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
		/** The source's configured gain, written on each new connection. */
		tuner?: SourceTunerConfig
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
	let leaseHolder: (sourceId: string) => string | null = () => null
	let leaseJob: Omit<TunerLeaseJob, "jobId"> = {
		name: "Night sweep",
		autoAfterIdleMs: 60_000,
		starting: false,
		reason: null,
		waiters: [],
	}
	let receiver: SdrHostStatus | undefined
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
		principalKind: () => principal,
		scannerLeaseHolder: sourceId => {
			const jobId = leaseHolder(sourceId)
			return jobId === null ? null : { jobId, ...leaseJob }
		},
		receiverStatus: () => receiver,
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
			...(options.tuner ? { tuner: options.tuner } : {}),
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
		useLeases: (holder: (sourceId: string) => string | null) => {
			leaseHolder = holder
		},
		describeLeaseJob: (job: Partial<Omit<TunerLeaseJob, "jobId">>) => {
			leaseJob = { ...leaseJob, ...job }
		},
		useReceiver: (status: SdrHostStatus) => {
			receiver = status
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

	describe("a setting already at the asked value is applied", () => {
		const BODY_GAIN = 445
		async function tuneWithRate(h: Awaited<ReturnType<typeof setup>>) {
			const disconnected = event(h.manager, "disconnected")
			const answer = h.post({
				frequencyHz: TUNE_HZ,
				sampleRateHz: OTHER_RATE,
				gainMode: "manual",
				gain: BODY_GAIN,
			})
			await disconnected
			await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
			return answer
		}

		it("gain mode already manual, with a rate change: no partial", async () => {
			const h = await setup()
			expect(
				(await h.post({ gainMode: "manual", gain: 200 })).json().usable,
			).toBe(true)
			expect(h.read().gainMode).toBe("manual")
			h.fakeTime()
			const res = await tuneWithRate(h)
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
				gainMode: "manual",
				gain: BODY_GAIN,
			})
		})

		it("gain mode already manual, no rate change: no partial", async () => {
			const h = await setup()
			await h.post({ gainMode: "manual", gain: 200 })
			const res = await h.post({
				frequencyHz: TUNE_HZ,
				sampleRateHz: START_RATE,
				gainMode: "manual",
				gain: BODY_GAIN,
			})
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
			})
		})

		it("gain mode manual from the configured gain only, with a rate change: no partial", async () => {
			// The reconnect clears the configured frames' proof and skips the configured gain mode,
			// since the tune's gain is held: the mode the tune asked for must still count.
			const h = await setup({ tuner: { gainMode: "manual", gainDb: 20 } })
			await until(() => h.frames.some(f => f.cmd === SET_GAIN_MODE))
			expect(h.read().gainMode).toBe("manual")
			expect(h.read().unknownFields ?? []).not.toContain("gainMode")
			h.fakeTime()
			const res = await tuneWithRate(h)
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
				gainMode: "manual",
				gain: BODY_GAIN,
			})
			expect(res.json().unknownFields ?? []).not.toContain("gainMode")
			// and the next reconnect replays the mode with the gain: still known
			expect(h.read().unknownFields ?? []).not.toContain("gainMode")
		})

		it("gain mode and gain both equal to the configured ones, with a rate change: no partial", async () => {
			const h = await setup({ tuner: { gainMode: "manual", gainDb: 44.5 } })
			await until(() => h.frames.some(f => f.cmd === SET_GAIN))
			expect(h.read()).toMatchObject({ gainMode: "manual", gain: BODY_GAIN })
			h.fakeTime()
			const res = await tuneWithRate(h)
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
			})
			expect(res.json().unknownFields ?? []).not.toContain("gain")
			// the new connection gets the operator's mode and gain, from the replay
			await until(() =>
				h.frames.some(f => f.connection === 2 && f.cmd === SET_GAIN),
			)
			expect(
				h.frames
					.filter(
						f =>
							f.connection === 2 &&
							(f.cmd === SET_GAIN_MODE || f.cmd === SET_GAIN),
					)
					.map(f => [f.cmd, f.value]),
			).toEqual([
				[SET_GAIN_MODE, 1],
				[SET_GAIN, BODY_GAIN],
			])
		})

		it("from AGC to manual, with a rate change: no partial", async () => {
			const h = await setup()
			await h.post({ gainMode: "agc" })
			expect(h.read().gainMode).toBe("agc")
			h.fakeTime()
			const res = await tuneWithRate(h)
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
				gainMode: "manual",
				gain: BODY_GAIN,
			})
		})

		it("a fresh source whose gain mode was never written, with a rate change: no partial", async () => {
			const h = await setup()
			h.fakeTime()
			const res = await tuneWithRate(h)
			expect(res.statusCode).toBe(200)
			expect(res.json()).toMatchObject({
				usable: true,
				applied: ["sampleRateHz", "frequencyHz", "gainMode", "gain"],
				notApplied: [],
			})
		})
	})

	it("names the key list for an unknown body field, before the at-least-one rule, and writes nothing", async () => {
		const h = await setup()
		const before = h.frames.length
		const keys =
			"only the fields sampleRateHz, frequencyHz, gainMode, gain, restoreAfterS, preempt"
		for (const body of [
			{ gainTenthsDb: 445 },
			{ frequencyHz: TUNE_HZ, gainTenthsDb: 445 },
		]) {
			const res = await h.post(body)
			expect(res.statusCode).toBe(400)
			expect(res.json()).toEqual({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message: `Invalid request body: ${keys}`,
				fields: [{ field: "body", expected: keys }],
			})
			expect(res.body).not.toContain("gainTenthsDb")
		}
		// an empty body still answers the at-least-one rule
		expect((await h.post({})).json().fields[0].expected).toMatch(
			/^at least one of/,
		)
		expect(h.frames.length).toBe(before)
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

	it("names the job under a held lease and writes nothing, unlike the other routes", async () => {
		const h = await setup()
		const { arbiter, lost } = arbiterOn(h)
		h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
		expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
		const frames = h.frames.length
		const res = await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({
			code: "TUNER_LEASE_HELD",
			jobId: "job",
			jobName: "Night sweep",
		})
		expect(res.json().message).toContain('"preempt": true')
		expect(res.json().message).toContain("job")
		expect(lost).toEqual([])
		expect(arbiter.holder("rtl")?.jobId).toBe("job")
		expect(h.frames.length).toBe(frames)
		expect(h.read()).not.toHaveProperty("restore")
		// The separate routes are unchanged: an operator write still preempts.
		const route = await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl/frequency",
			payload: { hz: TUNE_HZ },
		})
		expect(route.statusCode).toBe(200)
		expect(lost).toEqual(["preempted-operator"])
	})

	it("refuses a lease taken while it queued, with nothing written", async () => {
		const h = await setup()
		const { arbiter, lost } = arbiterOn(h)
		h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
		h.fakeTime()
		const queued = vi.spyOn(h.manager, "runTunerCommand")
		h.holdQueue(1_000)
		const frames = h.frames.length
		const answer = h.post({ frequencyHz: TUNE_HZ })
		await until(() => queued.mock.calls.length === 2)
		expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
		await vi.advanceTimersByTimeAsync(1_000)
		const res = await answer
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({
			code: "TUNER_LEASE_HELD",
			jobId: "job",
			applied: [],
		})
		expect(lost).toEqual([])
		expect(h.frames.length).toBe(frames)
	})

	describe("with a lease that arrives after the tune's turn has come", () => {
		async function leasable() {
			const h = await setup()
			const { arbiter, lost } = arbiterOn(h)
			h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
			const acquire = () => {
				expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
			}
			const inRetuneHook = () =>
				h.controller.setBeforeOperatorRetune(() => {
					acquire()
					return Promise.resolve()
				})
			const onTuneFrame = () => {
				const frame = (_id: string, _command: string, value: number) => {
					if (value !== TUNE_HZ) return
					h.controller.off("command-sent", frame)
					acquire()
				}
				h.controller.on("command-sent", frame)
			}
			return { h, arbiter, lost, acquire, inRetuneHook, onTuneFrame }
		}

		it("stops at 409 before its first frame, the lease untouched", async () => {
			const { h, arbiter, lost, inRetuneHook } = await leasable()
			inRetuneHook()
			const frames = h.frames.length
			const res = await h.post({ frequencyHz: TUNE_HZ, gain: 300 })
			expect(res.statusCode).toBe(409)
			expect(res.json()).toMatchObject({
				code: "TUNER_LEASE_HELD",
				jobId: "job",
				applied: [],
				notApplied: ["frequencyHz", "gain"],
			})
			expect(res.json()).not.toHaveProperty("preempted")
			expect(res.json().message).toContain("nothing was written")
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")?.jobId).toBe("job")
			expect(h.frames.length).toBe(frames)
		})

		it("refuses the rate policy's own frame in the hook as well", async () => {
			const { h, arbiter, lost, acquire } = await leasable()
			h.controller.setBeforeOperatorRetune(async sourceId => {
				acquire()
				await h.controller.setPpm(sourceId, 1, { origin: "decoder-rate" })
			})
			const frames = h.frames.length
			const res = await h.post({ frequencyHz: TUNE_HZ })
			expect(res.statusCode).toBe(409)
			expect(res.json().code).toBe("TUNER_LEASE_HELD")
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")?.jobId).toBe("job")
			expect(h.frames.length).toBe(frames)
		})

		it("stops between frames and reports what already applied", async () => {
			const { h, arbiter, lost, onTuneFrame } = await leasable()
			onTuneFrame()
			const res = await h.post({ frequencyHz: TUNE_HZ, gain: 300 })
			expect(res.statusCode).toBe(409)
			expect(res.json()).toMatchObject({
				code: "TUNER_LEASE_HELD",
				jobId: "job",
				applied: ["frequencyHz"],
				notApplied: ["gain"],
				state: { frequency: TUNE_HZ },
			})
			expect(res.json().message).toContain("nothing more was written")
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")?.jobId).toBe("job")
			expect(h.frames.some(f => f.cmd === SET_GAIN)).toBe(false)
		})

		it("a temporary tune stopped by it leaves no restore over the job", async () => {
			const { h, onTuneFrame } = await leasable()
			await h.post({ gainMode: "manual", gain: 200 })
			onTuneFrame()
			const res = await h.post({
				frequencyHz: TUNE_HZ,
				gain: 300,
				restoreAfterS: 1,
			})
			expect(res.statusCode).toBe(409)
			expect(res.json().code).toBe("TUNER_LEASE_HELD")
			expect(restoreOf(h.read())).toMatchObject({
				status: "cancelled",
				cancelledBy: { actor: "scanner-job", reason: "scanner-lease" },
			})
		})

		it("with preempt takes it and reports it as a lease found at the start", async () => {
			const { h, arbiter, lost, inRetuneHook } = await leasable()
			inRetuneHook()
			const res = await h.post({
				frequencyHz: TUNE_HZ,
				restoreAfterS: 5,
				preempt: true,
			})
			expect(res.statusCode).toBe(200)
			expect(lost).toEqual(["preempted-operator"])
			expect(arbiter.holder("rtl")).toBeUndefined()
			expect(res.json().preempted).toMatchObject({
				jobId: "job",
				job: "paused",
			})
			expect(res.json().preempted.message).toContain("No restore comes")
			expect(h.read().lastTune?.preempted?.jobId).toBe("job")
			expect(restoreOf(h.read())).toMatchObject({
				status: "cancelled",
				state: {},
				cancelledBy: {
					reason: "scanner-preempted",
					job: { jobId: "job" },
				},
			})
			expect(restoreOf(h.read()).state).toEqual({})
		})

		it("with preempt between frames, the next frame takes it", async () => {
			const { h, lost, onTuneFrame } = await leasable()
			onTuneFrame()
			const res = await h.post({
				frequencyHz: TUNE_HZ,
				gain: 300,
				preempt: true,
			})
			expect(res.statusCode).toBe(200)
			expect(lost).toEqual(["preempted-operator"])
			expect(res.json().preempted.jobId).toBe("job")
			expect(h.read()).toMatchObject({ frequency: TUNE_HZ, gain: 300 })
		})

		it("with preempt and a setting left at its value, that setting's frame takes it", async () => {
			const { h, arbiter, lost, onTuneFrame } = await leasable()
			await h.post({ gainMode: "manual", gain: 200 })
			await until(() => h.frames.some(f => f.cmd === SET_GAIN))
			h.frames.length = 0
			onTuneFrame()
			const res = await h.post({
				frequencyHz: TUNE_HZ,
				gain: 200,
				preempt: true,
			})
			expect(res.statusCode).toBe(200)
			expect(res.json().preempted.jobId).toBe("job")
			expect(lost).toEqual(["preempted-operator"])
			expect(arbiter.holder("rtl")).toBeUndefined()
			await until(() => h.frames.some(f => f.cmd === SET_GAIN))
		})

		it("with preempt and no setting left at all, the tune was over before the lease came", async () => {
			const { h, arbiter, lost, onTuneFrame } = await leasable()
			onTuneFrame()
			const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
			expect(res.statusCode).toBe(200)
			expect(res.json()).not.toHaveProperty("preempted")
			expect(lost).toEqual([])
			expect(arbiter.holder("rtl")?.jobId).toBe("job")
		})
	})

	it("refuses when the lease cannot be read, unless told to preempt", async () => {
		const h = await setup()
		h.useLeases(() => {
			throw new Error("no answer")
		})
		const res = await h.post({ frequencyHz: TUNE_HZ })
		expect(res.statusCode).toBe(409)
		expect(res.json().code).toBe("TUNER_LEASE_HELD")
		expect(res.json().message).toContain("could not be read")
		const forced = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
		expect(forced.statusCode).toBe(200)
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
			await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
			await until(() => h.frames.length === 1)
			h.frames.length = 0
			h.useLeases(() => {
				throw new Error("no answer")
			})
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

describe("who moved the tuner, across a reconnect", () => {
	it("a web rate change says web in its own answer and after the replay", async () => {
		const h = await setup({ principal: "session" })
		h.fakeTime()
		await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl/frequency",
			payload: { hz: OTHER_HZ },
		})
		await vi.advanceTimersByTimeAsync(2_000)
		const disconnected = event(h.manager, "disconnected")
		const answer = h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl/sample-rate",
			payload: { hz: OTHER_RATE },
		})
		await disconnected
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		const res = await answer
		expect(res.statusCode).toBe(200)
		await until(() =>
			h.frames.some(f => f.connection === 2 && f.cmd === SET_FREQUENCY),
		)
		for (const change of [res.json().lastChange, h.read().lastChange])
			expect(change).toMatchObject({
				actor: "web",
				reason: "rest-command",
				fields: ["sampleRate"],
			})
	})

	it("POST /tune keeps its actor and all its fields through the recovery between them", async () => {
		const h = await setup()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		const answer = h.post({
			sampleRateHz: OTHER_RATE,
			frequencyHz: TUNE_HZ,
			gainMode: "manual",
			gain: 300,
		})
		await disconnected
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
		const res = await answer
		expect(res.statusCode).toBe(200)
		const fields = ["sampleRate", "frequency", "gainMode", "gain"]
		expect(res.json().lastChange).toMatchObject({
			actor: "agent",
			reason: "rest-command",
		})
		expect([...res.json().lastChange.fields].sort()).toEqual([...fields].sort())
	})

	it("a dropout leaves the last mover, its time and its fields as they were", async () => {
		const h = await setup({ principal: "session" })
		h.fakeTime()
		await h.app.inject({
			method: "POST",
			url: "/api/tuner/rtl/frequency",
			payload: { hz: OTHER_HZ },
		})
		const before = h.read().lastChange
		expect(before?.actor).toBe("web")
		await until(() => h.frames.some(f => f.value === OTHER_HZ))
		const dropped = event(h.manager, "disconnected")
		h.sockets[0]!.destroy()
		await dropped
		const back = event(h.manager, "payload-started")
		await vi.advanceTimersByTimeAsync(calculateBackoffDelay(2))
		await back
		await until(() =>
			h.frames.some(f => f.connection === 2 && f.value === OTHER_HZ),
		)
		expect(h.read().lastChange).toEqual(before)
	})
})

describe("the user always wins over a temporary tune", () => {
	async function ready() {
		const h = await setup()
		await h.post({ frequencyHz: OTHER_HZ, gainMode: "manual", gain: 200 })
		await until(() => h.frames.length === 4)
		h.frames.length = 0
		h.fakeTime()
		return h
	}
	const inject =
		(method: "POST" | "PATCH", url: string, payload: object) =>
		(h: Awaited<ReturnType<typeof setup>>) =>
			h.app.inject({ method, url: `/api/tuner/rtl/${url}`, payload })

	// Three writes behind a tune holding the queue: none has a new value to show, and each is a
	// choice. The tune's last frame and the next command's start are one microtask apart.
	it.each([
		["POST ppm", inject("POST", "ppm", { ppm: 3 })],
		[
			"POST gain with the tune's own value",
			inject("POST", "gain", { gain: 300 }),
		],
		[
			"POST frequency with the tune's own value",
			inject("POST", "frequency", { hz: TUNE_HZ }),
		],
	])(
		"%s queued right behind the tune cancels the restore",
		async (_name, write) => {
			const h = await ready()
			const queued = vi.spyOn(h.manager, "runTunerCommand")
			h.holdQueue(1_000)
			const tune = h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 1 })
			await until(() => queued.mock.calls.length === 2)
			const user = write(h)
			await until(() => queued.mock.calls.length === 3)
			await vi.advanceTimersByTimeAsync(1_000)
			expect((await user).statusCode).toBe(200)
			await tune
			expect(restoreOf(h.read())).toMatchObject({
				status: "cancelled",
				cancelledBy: { actor: "agent", reason: "tuner-write" },
			})
			await until(() => h.frames.some(f => f.cmd === SET_GAIN))
			h.frames.length = 0
			await vi.advanceTimersByTimeAsync(10_000)
			expect(h.frames).toEqual([])
			expect(h.read()).toMatchObject({ frequency: TUNE_HZ, gain: 300 })
		},
	)

	it.each([
		["the frequency", { frequency: TUNE_HZ }],
		["the gain", { gain: 300 }],
		["the frequency and the gain", { frequency: TUNE_HZ, gain: 300 }],
	])(
		"an unchanged PATCH of %s cancels a pending restore, no frame sent",
		async (_name, payload) => {
			const h = await ready()
			await h.post({ frequencyHz: TUNE_HZ, gain: 300, restoreAfterS: 5 })
			await until(() => h.frames.length === 2)
			h.frames.length = 0
			const res = await inject("PATCH", "config", payload)(h)
			expect(res.statusCode).toBe(200)
			expect(restoreOf(h.read())).toMatchObject({
				status: "cancelled",
				cancelledBy: { actor: "agent", reason: "tuner-write" },
			})
			await vi.advanceTimersByTimeAsync(10_000)
			expect(h.frames).toEqual([])
			expect(h.read()).toMatchObject({ frequency: TUNE_HZ, gain: 300 })
		},
	)

	it("an unchanged PATCH queued behind the tune cancels too", async () => {
		const h = await ready()
		const queued = vi.spyOn(h.manager, "runTunerCommand")
		h.holdQueue(1_000)
		const tune = h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => queued.mock.calls.length === 2)
		const user = inject("PATCH", "config", { frequency: TUNE_HZ })(h)
		await until(() => queued.mock.calls.length === 3)
		await vi.advanceTimersByTimeAsync(1_000)
		expect((await user).statusCode).toBe(200)
		await tune
		expect(restoreOf(h.read()).status).toBe("cancelled")
		await vi.advanceTimersByTimeAsync(10_000)
		expect(h.read().frequency).toBe(TUNE_HZ)
	})

	it("an empty PATCH chooses nothing and leaves the restore", async () => {
		const h = await ready()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		await inject("PATCH", "config", {})(h)
		expect(restoreOf(h.read()).status).toBe("pending")
	})

	it("the rate policy's write inside the tune is the tune's own; outside it is not", async () => {
		const h = await ready()
		let raise = true
		h.controller.setBeforeOperatorRetune(async sourceId => {
			if (!raise) return
			raise = false
			await h.controller.setPpm(sourceId, 1, { origin: "decoder-rate" })
		})
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		expect(restoreOf(h.read()).status).toBe("pending")
		await h.controller.setPpm("rtl", 2, { origin: "decoder-rate" })
		expect(restoreOf(h.read())).toMatchObject({
			status: "cancelled",
			cancelledBy: { actor: "decoder-rate", reason: "tuner-write" },
		})
	})

	it("says a write overrode the tune, with no retry hint", async () => {
		const h = await ready()
		const queued = vi.spyOn(h.manager, "runTunerCommand")
		h.holdQueue(1_000)
		const tune = h.post({ frequencyHz: TUNE_HZ })
		await until(() => queued.mock.calls.length === 2)
		const user = inject("POST", "frequency", { hz: TUNE_HZ + 1 })(h)
		await until(() => queued.mock.calls.length === 3)
		await vi.advanceTimersByTimeAsync(1_000)
		await user
		const res = await tune
		expect(res.statusCode).toBe(409)
		expect(res.headers).not.toHaveProperty("retry-after")
		expect(res.json()).toMatchObject({
			code: "TUNER_TUNE_OVERRIDDEN",
			usable: true,
			notApplied: ["frequencyHz"],
			state: {
				frequency: TUNE_HZ + 1,
				lastTune: { code: "TUNER_TUNE_OVERRIDDEN" },
			},
		})
		expect(h.read().frequency).toBe(TUNE_HZ + 1)
	})

	describe("with another write landing while the tune runs", () => {
		const relayCentre = (h: Awaited<ReturnType<typeof setup>>) =>
			h.controller.applyExternalCommand("rtl", SET_FREQUENCY, OTHER_HZ + 1)

		it.each([
			["temporary", { restoreAfterS: 5 }, "external-control"],
			["that stays", {}, undefined],
		])(
			"a relay frequency in the retune hook stands over a tune %s",
			async (_name, extra, reason) => {
				const h = await ready()
				h.controller.setBeforeOperatorRetune(() => {
					relayCentre(h)
					return Promise.resolve()
				})
				const res = await h.post({ frequencyHz: TUNE_HZ, ...extra })
				expect(res.statusCode).toBe(409)
				expect(res.headers).not.toHaveProperty("retry-after")
				expect(res.json()).toMatchObject({
					code: "TUNER_TUNE_OVERRIDDEN",
					applied: [],
					notApplied: ["frequencyHz"],
					state: {
						frequency: OTHER_HZ + 1,
						lastChange: { actor: "relay" },
						lastTune: { code: "TUNER_TUNE_OVERRIDDEN" },
					},
				})
				expect(h.frames).toEqual([])
				if (reason !== undefined)
					expect(restoreOf(h.read())).toMatchObject({
						status: "cancelled",
						cancelledBy: { actor: "relay", reason },
					})
				await vi.advanceTimersByTimeAsync(10_000)
				expect(h.frames).toEqual([])
				expect(h.read().frequency).toBe(OTHER_HZ + 1)
			},
		)

		it("a write landing between its frames stops the frames left, and says what applied", async () => {
			const h = await ready()
			const frame = (_id: string, _command: string, value: number) => {
				if (value !== TUNE_HZ) return
				h.controller.off("command-sent", frame)
				h.controller.applyExternalCommand("rtl", SET_GAIN, 123)
			}
			h.controller.on("command-sent", frame)
			const res = await h.post({ frequencyHz: TUNE_HZ, gain: 300 })
			expect(res.statusCode).toBe(409)
			expect(res.json()).toMatchObject({
				code: "TUNER_TUNE_OVERRIDDEN",
				applied: ["frequencyHz"],
				notApplied: ["gain"],
				state: { frequency: TUNE_HZ, gain: 123 },
			})
			await until(() => h.frames.length >= 1)
			expect(h.frames.map(f => f.cmd)).toEqual([SET_FREQUENCY])
		})

		it("a REST write in the hook counts as much as a relay's", async () => {
			const h = await ready()
			let once = true
			h.controller.setBeforeOperatorRetune(async sourceId => {
				if (!once) return
				once = false
				await h.controller.setPpm(sourceId, 3, { origin: "rest", actor: "web" })
			})
			const res = await h.post({ frequencyHz: TUNE_HZ })
			expect(res.statusCode).toBe(409)
			expect(res.json()).toMatchObject({
				code: "TUNER_TUNE_OVERRIDDEN",
				state: { frequency: OTHER_HZ, lastChange: { actor: "web" } },
			})
		})

		it("a write queued ahead of the tune is older, and stops nothing", async () => {
			const h = await ready()
			const queued = vi.spyOn(h.manager, "runTunerCommand")
			const user = inject("POST", "ppm", { ppm: 3 })(h)
			await until(() => queued.mock.calls.length === 1)
			const res = await h.post({ frequencyHz: TUNE_HZ, gain: 300 })
			expect((await user).statusCode).toBe(200)
			expect(res.statusCode).toBe(200)
			expect(h.read()).toMatchObject({ frequency: TUNE_HZ, gain: 300 })
		})
	})

	it("a tune that stays ends a restore already writing, and queues behind it", async () => {
		const h = await ready()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 1 })
		await until(() => h.frames.length === 1)
		h.frames.length = 0
		h.holdQueue(2_000)
		await vi.advanceTimersByTimeAsync(1_000)
		await until(() => restoreOf(h.read()).status === "restoring")
		// A second temporary tune still waits its turn: it has nothing to keep the first one's snapshot.
		const busy = await h.post({ frequencyHz: TUNE_HZ + 1, restoreAfterS: 1 })
		expect(busy.statusCode).toBe(409)
		expect(busy.json().code).toBe("TUNER_TUNE_BUSY")
		const answer = h.post({ frequencyHz: TUNE_HZ + 2 })
		await until(() => restoreOf(h.read()).status === "cancelled")
		expect(restoreOf(h.read()).cancelledBy).toMatchObject({
			actor: "agent",
			reason: "tuner-write",
		})
		await vi.advanceTimersByTimeAsync(2_000)
		expect((await answer).statusCode).toBe(200)
		await until(() => h.frames.some(f => f.value === TUNE_HZ + 2))
		expect(h.frames.some(f => f.value === OTHER_HZ)).toBe(false)
		expect(h.read().frequency).toBe(TUNE_HZ + 2)
	})

	it("gives the receiver's own facts in the verdict of a silent source", async () => {
		const h = await setup()
		h.server.close()
		h.fakeTime()
		const disconnected = event(h.manager, "disconnected")
		const answer = h.post({ sampleRateHz: OTHER_RATE })
		await disconnected
		await vi.advanceTimersByTimeAsync(TUNE_DEADLINE_MS - 1)
		h.useReceiver({
			sourceId: "rtl",
			available: true,
			lastFetchedAt: new Date().toISOString(),
			receiverFacts: { deviceFound: false, rtlTcpRunning: false },
		} as SdrHostStatus)
		await vi.advanceTimersByTimeAsync(1)
		const res = await answer
		expect(res.statusCode).toBe(503)
		expect(res.json().sourceVerdict).toMatchObject({
			code: "receiver-no-device",
			deviceFacts: "absent",
		})
	})
})

/** A scanner job's hop, as its lease writes it. */
async function hop(
	h: Awaited<ReturnType<typeof setup>>,
	hz: number,
	gain?: number,
): Promise<void> {
	const scanner = { origin: "scanner", accept: false, jobId: "job" } as const
	await h.controller.setFrequency("rtl", hz, scanner)
	if (gain !== undefined) await h.controller.setGain("rtl", gain, scanner)
}

describe("a tune with preempt: true under a scanner lease", () => {
	async function leased() {
		const h = await setup()
		await h.post({ frequencyHz: OTHER_HZ, gainMode: "manual", gain: 200 })
		await until(() => h.frames.length === 4)
		const { arbiter, lost } = arbiterOn(h)
		h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
		const lease = arbiter.acquire("job", "rtl", 50)
		if (!lease.ok) throw new Error("no lease")
		// The job's own hop: what a restore must never go back to.
		await hop(h, 433_000_000, 450)
		await until(() => h.frames.some(f => f.value === 433_000_000))
		h.frames.length = 0
		h.fakeTime()
		return { h, arbiter, lost, lease: lease.lease }
	}

	it("reports the job, pauses it, and answers usable", async () => {
		const { h, lost, arbiter } = await leased()
		const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(lost).toEqual(["preempted-operator"])
		expect(arbiter.holder("rtl")).toBeUndefined()
		expect(res.json().preempted).toMatchObject({
			jobId: "job",
			jobName: "Night sweep",
			job: "paused",
			autoAfterIdleMs: 60_000,
		})
		expect(res.json().preempted.message).toContain("60000 ms")
		expect(h.read().lastTune?.preempted?.jobId).toBe("job")
	})

	it("never restores to the job's hop: no restore comes, and the block says so", async () => {
		const { h } = await leased()
		const res = await h.post({
			frequencyHz: TUNE_HZ,
			restoreAfterS: 5,
			preempt: true,
		})
		expect(res.statusCode).toBe(200)
		expect(restoreOf(res.json())).toMatchObject({
			status: "cancelled",
			state: {},
			cancelledBy: {
				actor: "agent",
				reason: "scanner-preempted",
				job: { jobId: "job", jobName: "Night sweep" },
			},
		})
		expect(Date.parse(restoreOf(res.json()).at)).toBe(Date.now() + 5_000)
		expect(res.json().preempted.message).toContain("No restore comes")
		await until(() => h.frames.some(f => f.value === TUNE_HZ))
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(10_000)
		expect(h.frames).toEqual([])
		expect(h.read()).toMatchObject({ frequency: TUNE_HZ, gain: 450 })
	})

	it("says a job with no auto-resume stays paused, in the field and the message", async () => {
		const { h } = await leased()
		h.describeLeaseJob({ autoAfterIdleMs: null })
		const res = await h.post({
			frequencyHz: TUNE_HZ,
			restoreAfterS: 5,
			preempt: true,
		})
		expect(res.json().preempted).toMatchObject({
			job: "paused",
			autoAfterIdleMs: null,
		})
		expect(res.json().preempted.message).toContain("stays paused")
		expect(res.json().preempted.message).toContain(
			"POST /api/scanner/jobs/job/resume",
		)
	})

	it("says a job still starting failed", async () => {
		const { h } = await leased()
		h.describeLeaseJob({ starting: true })
		const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
		expect(res.json().preempted).toMatchObject({
			job: "failed",
			// Its rule says 60 s, and a failed job still never comes back by itself.
			autoAfterIdleMs: null,
		})
		expect(res.json().preempted.message).not.toContain("by itself")
	})

	it("an auto-resume inside a longer restoreAfterS finds nothing to fight", async () => {
		const { h, arbiter } = await leased()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 300, preempt: true })
		await until(() => h.frames.some(f => f.value === TUNE_HZ))
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(60_000)
		const back = arbiter.acquire("job", "rtl", 50)
		if (!back.ok) throw new Error("no lease")
		await hop(h, 434_000_000)
		await until(() => h.frames.some(f => f.value === 434_000_000))
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(300_000)
		expect(h.frames).toEqual([])
		expect(arbiter.holder("rtl")).toBe(back.lease)
		expect(h.read().frequency).toBe(434_000_000)
	})

	it("a tune to the values already in place sends one frame, takes the lease, restores nothing", async () => {
		const { h, lost, arbiter } = await leased()
		const res = await h.post({
			frequencyHz: 433_000_000,
			restoreAfterS: 5,
			preempt: true,
		})
		expect(res.statusCode).toBe(200)
		expect(res.json().preempted.jobId).toBe("job")
		expect(lost).toEqual(["preempted-operator"])
		expect(arbiter.holder("rtl")).toBeUndefined()
		await until(() => h.frames.some(f => f.value === 433_000_000))
		expect(restoreOf(res.json()).cancelledBy).toMatchObject({
			reason: "scanner-preempted",
			job: { jobId: "job" },
		})
		h.frames.length = 0
		await vi.advanceTimersByTimeAsync(10_000)
		expect(h.frames).toEqual([])
	})

	it("sends a value in place only until one frame took the lease", async () => {
		const { h, lost } = await leased()
		const res = await h.post({
			frequencyHz: 433_000_000,
			gainMode: "manual",
			gain: 450,
			preempt: true,
		})
		expect(res.statusCode).toBe(200)
		expect(lost).toEqual(["preempted-operator"])
		await until(() => h.frames.some(f => f.value === 433_000_000))
		// The frame sent took the lease; a second one for this tune's centre would show here.
		expect(h.frames.filter(f => f.value === 433_000_000)).toHaveLength(1)
		expect(h.read()).toMatchObject({ frequency: 433_000_000, gain: 450 })
	})

	it("says a job paused for a reason that never resumes by itself needs a resume", async () => {
		for (const reason of ["operator", "resumed-without-retune"]) {
			const { h } = await leased()
			h.describeLeaseJob({ reason })
			const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
			expect(res.json().preempted.autoAfterIdleMs).toBeNull()
			expect(res.json().preempted.message).toContain(`stays paused (${reason})`)
			expect(res.json().preempted.message).toContain(
				"POST /api/scanner/jobs/job/resume",
			)
		}
	})

	it("any other pause keeps the job's own automatic resume", async () => {
		const { h } = await leased()
		h.describeLeaseJob({ reason: "source-down" })
		const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
		expect(res.json().preempted.autoAfterIdleMs).toBe(60_000)
		expect(res.json().preempted.message).toContain("resumes by itself")
	})

	it("changes nothing with no lease held", async () => {
		const h = await setup()
		const res = await h.post({ frequencyHz: TUNE_HZ, preempt: true })
		expect(res.statusCode).toBe(200)
		expect(res.json()).not.toHaveProperty("preempted")
	})

	it("a job that returns during a restore armed with no lease ends it, naming the job", async () => {
		const h = await setup()
		await h.post({ frequencyHz: OTHER_HZ, gainMode: "manual", gain: 200 })
		await until(() => h.frames.length === 4)
		const { arbiter, lost } = arbiterOn(h)
		h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
		h.fakeTime()
		await h.post({ frequencyHz: TUNE_HZ, restoreAfterS: 300 })
		await vi.advanceTimersByTimeAsync(60_000)
		const lease = arbiter.acquire("job", "rtl", 50)
		if (!lease.ok) throw new Error("no lease")
		await hop(h, 434_000_000)
		await until(() => h.frames.some(f => f.value === 434_000_000))
		h.frames.length = 0
		expect(restoreOf(h.read()).cancelledBy).toMatchObject({
			reason: "scanner-lease",
			job: { jobId: "job", jobName: "Night sweep" },
		})
		await vi.advanceTimersByTimeAsync(300_000)
		expect(h.frames).toEqual([])
		expect(lost).toEqual([])
	})
})

describe("a temporary tune and the gain saved before a band", () => {
	const BAND_HZ = 868_100_000
	const OUTSIDE_HZ = 145_000_000
	const SAVED_PATH = `/state/${BAND_GAIN_SAVED_FILE_NAME}`

	async function wireBandGain(
		h: Awaited<ReturnType<typeof setup>>,
		files: Map<string, string>,
	) {
		const fs: BandGainFs = {
			readFile: path => {
				const text = files.get(path)
				return text === undefined
					? Promise.reject(
							Object.assign(new Error("missing"), { code: "ENOENT" }),
						)
					: Promise.resolve(Buffer.from(text))
			},
			atomicWrite: (path, data) => {
				files.set(path, data)
				return Promise.resolve()
			},
		}
		const service = new BandGainSettingsService({
			stateDir: "/state",
			config: {
				applyToMyTuning: true,
				entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
			},
			logger: quiet,
			fs,
		})
		await service.load()
		h.controller.setBandGain(service)
	}

	/** Gain 200 outside the bands, with no record and no file yet. */
	async function atUserGain() {
		const h = await setup()
		const files = new Map<string, string>()
		await wireBandGain(h, files)
		const write = (url: string, payload: object) =>
			h.app.inject({
				method: "POST",
				url: `/api/tuner/rtl/${url}`,
				payload,
			})
		await write("gain-mode", { mode: "manual" })
		await write("gain", { gain: 200 })
		const settled = async () => {
			for (let i = 0; i < 20; i++)
				await new Promise<void>(resolve => {
					setImmediate(resolve)
				})
		}
		return {
			h,
			files,
			write,
			settled,
			saved: () => files.get(SAVED_PATH),
		}
	}

	/** Gain 200 saved by entering a band: the file holds the record. */
	async function inBand() {
		const base = await atUserGain()
		await base.write("frequency", { hz: BAND_HZ })
		await until(() => base.saved()?.includes('"gain": 200') === true)
		expect(base.h.read()).toMatchObject({
			gain: 297,
			bandGain: { tenthsDb: 297 },
		})
		const before = base.saved()
		base.h.fakeTime()
		return { ...base, before }
	}

	/** Gain 200 outside the bands: the file does not exist. */
	async function outsideBands() {
		const base = await atUserGain()
		await base.settled()
		expect(base.saved()).toBeUndefined()
		base.h.fakeTime()
		return { ...base, before: undefined }
	}

	/** The same state directory read by a core that has just started. */
	async function restarted(files: Map<string, string>) {
		vi.useRealTimers()
		const h = await setup()
		await wireBandGain(h, files)
		return h
	}

	const del = (h: Awaited<ReturnType<typeof setup>>) =>
		h.app.inject({ method: "DELETE", url: "/api/tuner/rtl/tune/restore" })

	it.each([
		["the centre alone", {}],
		["an explicit gain", { gain: 300 }],
	])("leaves it exactly as it was, durably, with %s", async (_name, extra) => {
		const { h, write, before, saved, settled } = await inBand()
		const res = await h.post({
			frequencyHz: OUTSIDE_HZ,
			restoreAfterS: 5,
			...extra,
		})
		expect(res.statusCode).toBe(200)
		await settled()
		expect(saved()).toBe(before)
		await vi.advanceTimersByTimeAsync(5_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await settled()
		expect(saved()).toBe(before)
		expect(h.read()).toMatchObject({
			frequency: BAND_HZ,
			gain: 297,
			bandGain: { tenthsDb: 297 },
		})
		// Leaving the band gives the user's gain back, as if the tune had never been.
		await write("frequency", { hz: OUTSIDE_HZ })
		expect(h.read().gain).toBe(200)
	})

	it("entering a band with no record writes no file, and its restore leaves none", async () => {
		const { h, files, settled, saved } = await outsideBands()
		await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
		expect(h.read().gain).toBe(297)
		await settled()
		expect(files.has(SAVED_PATH)).toBe(false)
		await vi.advanceTimersByTimeAsync(5_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await settled()
		expect(saved()).toBeUndefined()
		expect(h.read()).toMatchObject({ frequency: START_HZ, gain: 200 })
	})

	it("what it held does not outlive its restore: a later band saves the gain of then", async () => {
		const { h, write, settled, saved } = await outsideBands()
		await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
		await vi.advanceTimersByTimeAsync(5_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await write("gain", { gain: 150 })
		await write("frequency", { hz: BAND_HZ })
		await settled()
		expect(saved()).toContain('"gain": 150')
		await write("frequency", { hz: OUTSIDE_HZ })
		expect(h.read().gain).toBe(150)
	})

	it("a second temporary tune leaving the band goes by what the first one held", async () => {
		const { h, settled, saved } = await outsideBands()
		await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
		await h.post({ frequencyHz: OUTSIDE_HZ, restoreAfterS: 5 })
		expect(h.read().gain).toBe(200)
		await settled()
		expect(saved()).toBeUndefined()
		await vi.advanceTimersByTimeAsync(5_000)
		await until(() => restoreOf(h.read()).status === "restored")
		await settled()
		expect(saved()).toBeUndefined()
		expect(h.read()).toMatchObject({ frequency: START_HZ, gain: 200 })
	})

	type Band = Awaited<ReturnType<typeof inBand>>
	/** The tune stays, so it becomes an operator tune, once. */
	const STAYS: Array<[string, (band: Band, body: object) => Promise<void>]> = [
		[
			"DELETE",
			async ({ h }, body) => {
				await h.post(body)
				await del(h)
				expect(restoreOf(h.read()).status).toBe("cancelled")
			},
		],
		[
			"a user's write to another field",
			async ({ h, write }, body) => {
				await h.post(body)
				await write("ppm", { ppm: 3 })
				expect(restoreOf(h.read()).status).toBe("cancelled")
			},
		],
		[
			"a scanner lease",
			async ({ h }, body) => {
				const { arbiter } = arbiterOn(h)
				h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
				await h.post(body)
				expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
				await vi.advanceTimersByTimeAsync(5_000)
				expect(restoreOf(h.read()).cancelledBy?.reason).toBe("scanner-lease")
			},
		],
		[
			"preempting a job",
			async ({ h }, body) => {
				const { arbiter } = arbiterOn(h)
				h.useLeases(id => arbiter.holder(id)?.jobId ?? null)
				expect(arbiter.acquire("job", "rtl", 50).ok).toBe(true)
				const res = await h.post({ ...body, preempt: true })
				expect(res.statusCode).toBe(200)
				expect(restoreOf(h.read()).cancelledBy?.reason).toBe(
					"scanner-preempted",
				)
			},
		],
	]
	/** The tune does not stay as an operator's: nothing of it reaches the file. */
	const DROPS: Array<[string, (band: Band, body: object) => Promise<void>]> = [
		[
			"its restore",
			async ({ h }, body) => {
				await h.post(body)
				await vi.advanceTimersByTimeAsync(5_000)
				await until(() => restoreOf(h.read()).status === "restored")
			},
		],
		[
			"a failed restore",
			async ({ h }, body) => {
				await h.post(body)
				vi.spyOn(h.manager, "writeToSource").mockImplementation(() => {
					throw Object.assign(new Error("Source rtl is not connected"), {
						code: "SOURCE_DISCONNECTED",
					})
				})
				await vi.advanceTimersByTimeAsync(5_000)
				await until(() => restoreOf(h.read()).status === "failed")
			},
		],
		[
			"shutdown",
			async ({ h }, body) => {
				await h.post(body)
				await h.app.close()
			},
		],
		[
			"the source's removal",
			async ({ h }, body) => {
				await h.post(body)
				await h.manager.disconnect("rtl")
			},
		],
	]

	const GAINS: Array<[string, object]> = [
		["the centre alone", {}],
		["an explicit gain", { gain: 300 }],
	]

	describe.each(GAINS)("out of a band with %s", (_tune, extra) => {
		it.each(DROPS)(
			"the saved file stays byte-identical through %s",
			async (_path, end) => {
				const band = await inBand()
				await end(band, {
					frequencyHz: OUTSIDE_HZ,
					restoreAfterS: 5,
					...extra,
				})
				await band.settled()
				expect(band.saved()).toBe(band.before)
			},
		)
	})

	describe.each(GAINS)("into a band, no record, with %s", (_tune, extra) => {
		it.each(DROPS)("no file appears through %s", async (_path, end) => {
			const band = await outsideBands()
			await end(band, { frequencyHz: BAND_HZ, restoreAfterS: 5, ...extra })
			await band.settled()
			expect(band.saved()).toBeUndefined()
		})
	})

	it("a restart with a restore pending leaves the file as it was", async () => {
		const band = await inBand()
		await band.h.post({ frequencyHz: OUTSIDE_HZ, gain: 300, restoreAfterS: 5 })
		await band.settled()
		const h = await restarted(band.files)
		expect(band.saved()).toBe(band.before)
		await h.post({ frequencyHz: OUTSIDE_HZ + 1 })
		expect(h.read().gain).toBe(200)
	})

	describe("that stays with a gain of its own", () => {
		it.each(STAYS)(
			"the saved gain goes, durably, through %s",
			async (_path, stay) => {
				const band = await inBand()
				await stay(band, {
					frequencyHz: OUTSIDE_HZ,
					restoreAfterS: 5,
					gain: 300,
				})
				await band.settled()
				expect(band.saved()).not.toContain('"gain": 200')
			},
		)

		it("treats a gain mode the same", async () => {
			const { h, settled, saved } = await inBand()
			await h.post({
				frequencyHz: OUTSIDE_HZ,
				restoreAfterS: 5,
				gainMode: "agc",
			})
			await del(h)
			await settled()
			expect(saved()).not.toContain('"gain": 200')
		})

		const keep = async () => {
			const band = await inBand()
			await band.h.post({
				frequencyHz: OUTSIDE_HZ,
				restoreAfterS: 5,
				gain: 300,
			})
			await del(band.h)
			await band.settled()
			return band
		}

		it("a later retune leaves that gain on the tuner", async () => {
			const { h, write, settled, saved } = await keep()
			await write("frequency", { hz: OUTSIDE_HZ + 1 })
			await settled()
			expect(h.read().gain).toBe(300)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("a retune into a band saves that gain in the old one's place", async () => {
			const { h, write, settled, saved } = await keep()
			await write("frequency", { hz: BAND_HZ })
			await settled()
			expect(h.read().gain).toBe(297)
			expect(saved()).toContain('"gain": 300')
			await write("frequency", { hz: OUTSIDE_HZ })
			expect(h.read().gain).toBe(300)
		})

		it("the old gain does not come back after the source is removed and re-added", async () => {
			const { h, write, settled, saved } = await keep()
			vi.useRealTimers()
			await h.manager.disconnect("rtl")
			await h.connect()
			await write("frequency", { hz: OUTSIDE_HZ + 1 })
			await settled()
			expect(h.read().frequency).toBe(OUTSIDE_HZ + 1)
			expect(h.read().gain).not.toBe(200)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("the old gain does not come back in a core started on the same files", async () => {
			const { files, saved } = await keep()
			const h = await restarted(files)
			await h.post({ frequencyHz: OUTSIDE_HZ + 1 })
			expect(h.read().frequency).toBe(OUTSIDE_HZ + 1)
			expect(h.read().gain).not.toBe(200)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("into a band with no record, it saves nothing and leaving keeps its gain", async () => {
			const { h, write, settled, saved } = await outsideBands()
			await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5, gain: 300 })
			await del(h)
			await settled()
			expect(saved()).toBeUndefined()
			await write("frequency", { hz: OUTSIDE_HZ })
			expect(h.read().gain).toBe(300)
		})
	})

	describe("that stays with no gain, having entered a band with no record", () => {
		it.each(STAYS)("its save is written through %s", async (_path, stay) => {
			const band = await outsideBands()
			await stay(band, { frequencyHz: BAND_HZ, restoreAfterS: 5 })
			await band.settled()
			expect(band.saved()).toContain('"gain": 200')
			expect(band.h.read().gain).toBe(297)
		})

		it("leaving the band gives the user's gain back and clears the record", async () => {
			const { h, write, settled, saved } = await outsideBands()
			await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
			await del(h)
			await settled()
			await write("frequency", { hz: OUTSIDE_HZ })
			await settled()
			expect(h.read().gain).toBe(200)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("a core started on the same files still gives that gain back", async () => {
			const { files, h: old, settled } = await outsideBands()
			await old.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
			await del(old)
			await settled()
			const h = await restarted(files)
			await h.post({ frequencyHz: OUTSIDE_HZ })
			expect(h.read().gain).toBe(200)
		})

		it("a temporary tune during its slow save does not supersede the record", async () => {
			const { h, settled, saved } = await outsideBands()
			await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
			const service = h.controller.bandGainSettings()
			if (service === null) throw new Error("no band gain service")
			const save = service.saveOperatorGains.bind(service)
			let release = () => {}
			const held = new Promise<void>(resolve => {
				release = resolve
			})
			vi.spyOn(service, "saveOperatorGains").mockImplementationOnce(
				async (...args) => {
					await held
					return save(...args)
				},
			)
			await del(h)
			await h.post({ frequencyHz: OUTSIDE_HZ, gain: 300, restoreAfterS: 5 })
			release()
			await settled()
			expect(saved()).toContain('"gain": 200')
			await vi.advanceTimersByTimeAsync(5_000)
			await until(() => restoreOf(h.read()).status === "restored")
			await settled()
			expect(saved()).toContain('"gain": 200')
			await h.post({ frequencyHz: OUTSIDE_HZ })
			expect(h.read().gain).toBe(200)
		})

		it("a failed save takes it back, with the tune still standing", async () => {
			const { h, settled, saved } = await outsideBands()
			await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
			const service = h.controller.bandGainSettings()
			if (service === null) throw new Error("no band gain service")
			vi.spyOn(service, "saveOperatorGains").mockResolvedValue(false)
			await del(h)
			await settled()
			expect(saved()).toBeUndefined()
			expect(h.read().gain).toBe(297)
			// The record was taken back: leaving the band has nothing to write.
			vi.restoreAllMocks()
			await h.post({ frequencyHz: OUTSIDE_HZ })
			expect(h.read().gain).toBe(297)
		})
	})

	describe("that stays with no gain, needing no save", () => {
		it.each(STAYS)(
			"the file stays byte-identical through %s, leaving a band",
			async (_path, stay) => {
				const band = await inBand()
				await stay(band, { frequencyHz: OUTSIDE_HZ, restoreAfterS: 5 })
				await band.settled()
				expect(band.saved()).toBe(band.before)
			},
		)

		it.each(STAYS)(
			"no file appears through %s, outside the bands",
			async (_path, stay) => {
				const band = await outsideBands()
				await stay(band, { frequencyHz: OUTSIDE_HZ, restoreAfterS: 5 })
				await band.settled()
				expect(band.saved()).toBeUndefined()
			},
		)

		const keep = async () => {
			const band = await inBand()
			await band.h.post({ frequencyHz: OUTSIDE_HZ, restoreAfterS: 5 })
			await del(band.h)
			await band.settled()
			expect(band.saved()).toBe(band.before)
			return band
		}

		it("a retune gives the saved gain back and clears it, as any exit from a band", async () => {
			const { h, write, settled, saved } = await keep()
			await write("frequency", { hz: OUTSIDE_HZ + 1 })
			await settled()
			expect(h.read().gain).toBe(200)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("a return to the band still holds it, and leaving gives it back", async () => {
			const { h, write, settled, before, saved } = await keep()
			await write("frequency", { hz: BAND_HZ })
			await settled()
			expect(h.read().gain).toBe(297)
			expect(saved()).toBe(before)
			await write("frequency", { hz: OUTSIDE_HZ })
			await settled()
			expect(h.read().gain).toBe(200)
			expect(saved()).not.toContain('"gain": 200')
		})

		it("the next temporary tune leaves it alone too, and writes it nowhere", async () => {
			const { h, before, saved, settled } = await keep()
			await h.post({ frequencyHz: OUTSIDE_HZ + 1, restoreAfterS: 5 })
			await settled()
			expect(saved()).toBe(before)
			await vi.advanceTimersByTimeAsync(5_000)
			await until(() => restoreOf(h.read()).status === "restored")
			await settled()
			expect(saved()).toBe(before)
		})
	})

	it("cancelled by a user's gain, that gain stands and the saved one is gone", async () => {
		const { h, write, settled, saved } = await inBand()
		await h.post({ frequencyHz: OUTSIDE_HZ, restoreAfterS: 5 })
		await write("gain", { gain: 150 })
		await settled()
		expect(restoreOf(h.read()).status).toBe("cancelled")
		expect(saved()).not.toContain('"gain": 200')
		await write("frequency", { hz: OUTSIDE_HZ + 1 })
		expect(h.read().gain).toBe(150)
	})

	it("cancelled by a user's gain after entering a band, nothing older comes back", async () => {
		const { h, write, settled, saved } = await outsideBands()
		await h.post({ frequencyHz: BAND_HZ, restoreAfterS: 5 })
		await write("gain", { gain: 150 })
		await settled()
		expect(saved()).not.toContain('"gain": 200')
		await write("frequency", { hz: OUTSIDE_HZ })
		expect(h.read().gain).toBe(150)
	})

	it("cancelled by a user's retune, the explicit gain of the tune stays with it", async () => {
		const { h, write, settled, saved } = await inBand()
		await h.post({ frequencyHz: OUTSIDE_HZ, gain: 300, restoreAfterS: 5 })
		await write("frequency", { hz: OUTSIDE_HZ + 1 })
		await settled()
		expect(restoreOf(h.read()).status).toBe("cancelled")
		expect(h.read().gain).toBe(300)
		expect(saved()).not.toContain('"gain": 200')
	})
})

describe("POST /tune through the real ApiServer", () => {
	it("a restore yields to the scanner's lease, with no write", async () => {
		const h = await setup()
		await h.post({ frequencyHz: OTHER_HZ })
		await until(() => h.frames.some(f => f.value === OTHER_HZ))
		let holder: {
			jobId: string
			name: string
			autoAfterIdleMs: null
			starting: false
			reason: null
			waiters: never[]
		} | null = null
		const server = new ApiServer(
			{
				logger: quiet,
				tunerController: h.controller,
				sourceManager: h.manager,
				scanner: Object.assign(new EventEmitter(), {
					tunerLeaseJob: () => holder,
					settings: () => testSettings(),
				}),
				decoderManager: Object.assign(new EventEmitter(), {
					getAllDecoders: () => [],
					getAllStatus: () => [],
					getAllHealth: () => new Map(),
				}),
				fanoutManager: Object.assign(new EventEmitter(), {
					getTelemetrySnapshot: () => ({
						timestamp: new Date().toISOString(),
						branches: [],
						backpressureActiveCount: 0,
						droppedBytesTotal: 0,
						droppedChunksTotal: 0,
					}),
				}),
				audioOutput: Object.assign(new EventEmitter(), {
					getConnectedClients: () => 0,
					getPort: () => 0,
				}),
			} as unknown as ApiServerDependencies,
			{ host: "127.0.0.1", port: 0 },
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const tune = (payload: object) =>
			app.inject({ method: "POST", url: "/api/tuner/rtl/tune", payload })
		h.fakeTime()
		const armed = await tune({ frequencyHz: TUNE_HZ, restoreAfterS: 5 })
		expect(armed.statusCode).toBe(200)
		await until(() => h.frames.some(f => f.value === TUNE_HZ))
		h.frames.length = 0
		holder = {
			jobId: "job",
			name: "Night sweep",
			autoAfterIdleMs: null,
			starting: false,
			reason: null,
			waiters: [],
		}
		await vi.advanceTimersByTimeAsync(5_000)
		const read = await app.inject({ url: "/api/tuner/rtl" })
		expect(restoreOf(read.json())).toMatchObject({
			status: "cancelled",
			cancelledBy: {
				actor: "scanner-job",
				reason: "scanner-lease",
				job: { jobId: "job", jobName: "Night sweep" },
			},
		})
		expect(h.frames).toEqual([])
		// And the route refuses through the same wiring, naming the job.
		const refused = await tune({ frequencyHz: OTHER_HZ })
		expect(refused.statusCode).toBe(409)
		expect(refused.json()).toMatchObject({
			code: "TUNER_LEASE_HELD",
			jobId: "job",
			jobName: "Night sweep",
		})
		// The wrong-shaped response schemas would drop these: the 200 keeps them.
		holder = null
		const free = await tune({ frequencyHz: OTHER_HZ })
		expect(free.json().restore.cancelledBy.job.jobName).toBe("Night sweep")
	})
})

describe("identify's details.next through this route", () => {
	const window = { sampleRateHz: START_RATE }

	it.each([
		["the lower edge", 24_000_000],
		["just above the lower edge", 24_050_000],
		["mid band", 101_000_000],
		["high in the band", 1_766_000_000],
		["the top edge", 1_900_000_000],
	])("%s: the call it names is accepted", async (_name, frequencyHz) => {
		const h = await setup()
		const next = identifyTargetNextStep(
			"rtl",
			{ frequencyHz },
			window,
			false,
		) as { path: string; body: { frequencyHz: number } }
		expect(next.path).toBe("/api/tuner/rtl/tune")
		const res = await h.post(next.body)
		expect(res.statusCode, res.body).toBe(200)
	})

	it.each([150_000, 23_999_999, 1_900_000_001])(
		"%i Hz is outside the tuner: it names no call",
		frequencyHz => {
			expect(
				identifyTargetNextStep("rtl", { frequencyHz }, window, false),
			).not.toHaveProperty("method")
		},
	)
})
