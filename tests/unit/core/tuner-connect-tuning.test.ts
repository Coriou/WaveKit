/**
 * On every new connection the core writes the declared-only sample rate and frequency, so they
 * become proven (a shared rtlmux keeps the last client's tuning). In-process fake rtl_tcp on an
 * ephemeral loopback port.
 */
import * as net from "node:net"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SourceManager,
	calculateBackoffDelay,
} from "../../../src/core/source-manager.js"
import type { SourceCaps } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerControllerConfig } from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { tuningTrustOf } from "../../../src/core/tuning-trust.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	TunerArbiter,
	type Lease,
	type LeaseLostReason,
} from "../../../src/core/scanner/tuner-arbiter.js"
import { FakeClock } from "../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"

const log = createLogger({ level: "fatal" })
const RATE = 2_048_000
const CENTRE = 100_000_000
const SET_FREQUENCY = 0x01
const SET_SAMPLE_RATE = 0x02

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

interface FakeRtlTcp {
	port: number
	sockets: Set<net.Socket>
	/** Frames received, per connection (index 0 = first connection). */
	frames: Array<Array<[number, number]>>
	/** Resolves once connection `index` has received `count` frames. */
	framesOn: (index: number, count: number) => Promise<void>
}

async function fakeRtlTcp(): Promise<FakeRtlTcp> {
	const sockets = new Set<net.Socket>()
	const frames: Array<Array<[number, number]>> = []
	const waiters: Array<() => void> = []
	const server = net.createServer(socket => {
		sockets.add(socket)
		const mine: Array<[number, number]> = []
		frames.push(mine)
		socket.on("error", () => {})
		socket.on("close", () => sockets.delete(socket))
		let pending = Buffer.alloc(0)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			while (pending.length >= 5) {
				mine.push([pending.readUInt8(0), pending.readUInt32BE(1)])
				pending = pending.subarray(5)
			}
			for (const w of waiters.splice(0)) w()
		})
		// Header (magic, tuner type, gain count) then a first payload.
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(Buffer.concat([header, Buffer.alloc(8)]))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	const framesOn = async (index: number, count: number): Promise<void> => {
		while ((frames[index]?.length ?? 0) < count)
			await new Promise<void>(resolve => waiters.push(resolve))
	}
	return {
		port: (server.address() as net.AddressInfo).port,
		sockets,
		frames,
		framesOn,
	}
}

async function setup(
	config: TunerControllerConfig = {},
	beforeConnect: (manager: SourceManager) => void = () => {},
) {
	const rtl = await fakeRtlTcp()
	const manager = new SourceManager(log)
	cleanup.push(() => manager.disconnectAll())
	manager.on("error", () => {})
	beforeConnect(manager)
	const controller = new TunerController(log, manager, {
		defaultFrequency: CENTRE,
		defaultSampleRate: RATE,
		...config,
	})
	// A failed connect write emits `error` (the tests read lastError instead).
	controller.on("error", () => {})
	wireTunerControl({
		log,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: RATE,
		centerFreq: CENTRE,
		format: "U8_IQ",
		exclusive: false,
	}
	const payload = once(manager, "payload-started")
	await manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: rtl.port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps,
	})
	await payload
	return { rtl, manager, controller }
}

const tuningFrames = (frames: Array<[number, number]> | undefined) =>
	(frames ?? []).filter(
		([cmd]) => cmd === SET_FREQUENCY || cmd === SET_SAMPLE_RATE,
	)

it("writes the declared rate then centre on connect, so neither stays declared only", async () => {
	const { rtl, controller } = await setup()
	await rtl.framesOn(0, 2)
	expect(tuningFrames(rtl.frames[0])).toEqual([
		[SET_SAMPLE_RATE, RATE],
		[SET_FREQUENCY, CENTRE],
	])
	const state = controller.getState("rtl")
	expect(state?.declaredOnlyFields).toBeUndefined()
	expect(state?.unknownFields ?? []).not.toContain("frequency")
	expect(tuningTrustOf(state)).toBe("commanded")
	expect(controller.tuningWrittenOnConnection("rtl")).toBe(true)
})

it("repeats the write on a reconnect", async () => {
	const { rtl, manager, controller } = await setup()
	await rtl.framesOn(0, 2)
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.spyOn(Math, "random").mockReturnValue(0)
	const lost = once(manager, "disconnected")
	for (const socket of rtl.sockets) socket.destroy()
	await lost
	const payload = once(manager, "payload-started")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await payload
	vi.useRealTimers()
	await rtl.framesOn(1, 2)
	expect(tuningFrames(rtl.frames[1])).toEqual([
		[SET_SAMPLE_RATE, RATE],
		[SET_FREQUENCY, CENTRE],
	])
	expect(controller.getState("rtl")?.declaredOnlyFields).toBeUndefined()
	expect(controller.tuningWrittenOnConnection("rtl")).toBe(true)
})

it("writes nothing and keeps both declared only once the core lost ownership", async () => {
	const { rtl, controller } = await setup({ lostOwnership: () => true })
	// The sync ran on the first payload (awaited in setup): nothing went out.
	await new Promise(resolve => setImmediate(resolve))
	expect(tuningFrames(rtl.frames[0])).toEqual([])
	const state = controller.getState("rtl")
	expect(state?.declaredOnlyFields).toEqual(["frequency", "sampleRate"])
	expect(tuningTrustOf(state)).toBe("unverified")
})

it("writes nothing under external (relay) control on a reconnect", async () => {
	const { rtl, manager, controller } = await setup()
	await rtl.framesOn(0, 2)
	controller.setControlMode("rtl", "external", "relay")
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.spyOn(Math, "random").mockReturnValue(0)
	const lost = once(manager, "disconnected")
	for (const socket of rtl.sockets) socket.destroy()
	await lost
	const payload = once(manager, "payload-started")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await payload
	vi.useRealTimers()
	await new Promise(resolve => setImmediate(resolve))
	expect(tuningFrames(rtl.frames[1])).toEqual([])
	expect(controller.getState("rtl")?.declaredOnlyFields).toEqual([
		"frequency",
		"sampleRate",
	])
})

it("a plain resume writes no tuning (never fight another client)", async () => {
	const { rtl, manager, controller } = await setup()
	await rtl.framesOn(0, 2)
	controller.noteSourceConnected("rtl")
	const result = controller.synchronizeOnConnect("rtl", { resume: "plain" })
	expect(result.commands).toEqual([])
	expect(manager.isRtlTcpSource("rtl")).toBe(true)
	expect(tuningTrustOf(controller.getState("rtl"))).toBe("unverified")
})

it("an accepted frequency is replayed, not written twice, and the declared rate is left unwritten", async () => {
	const { rtl, manager, controller } = await setup()
	await rtl.framesOn(0, 2)
	await controller.setFrequency("rtl", 145_000_000)
	await rtl.framesOn(0, 3)
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.spyOn(Math, "random").mockReturnValue(0)
	const lost = once(manager, "disconnected")
	for (const socket of rtl.sockets) socket.destroy()
	await lost
	const payload = once(manager, "payload-started")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await payload
	vi.useRealTimers()
	await rtl.framesOn(1, 1)
	// The source was tuned since start: the declared rate is not written over that tuning.
	expect(tuningFrames(rtl.frames[1])).toEqual([[SET_FREQUENCY, 145_000_000]])
	expect(controller.getState("rtl")?.declaredOnlyFields).toEqual(["sampleRate"])
})

it("the reset policy writes no tuning: centre and rate stay declared only", async () => {
	const { rtl, controller } = await setup({ reconnectPolicy: "reset" })
	await new Promise(resolve => setImmediate(resolve))
	expect(tuningFrames(rtl.frames[0])).toEqual([])
	expect(controller.getState("rtl")?.declaredOnlyFields).toEqual([
		"frequency",
		"sampleRate",
	])
})

it("a failed connect write proves nothing and says so in lastError", async () => {
	let refuse = true
	const { controller } = await setup({}, manager => {
		const write = manager.writeToSource.bind(manager)
		vi.spyOn(manager, "writeToSource").mockImplementation((id, payload) => {
			if (refuse) {
				refuse = false
				throw new Error("socket is not writable")
			}
			return write(id, payload)
		})
	})
	const state = controller.getState("rtl")
	expect(state?.declaredOnlyFields).toEqual(["frequency", "sampleRate"])
	expect(state?.lastError).toBe(
		"Tuner state restore failed: socket is not writable",
	)
	expect(tuningTrustOf(state)).toBe("unverified")
})

it("a rate write that went out stays proven when the frequency write after it fails", async () => {
	let calls = 0
	const { rtl, controller } = await setup({}, manager => {
		const write = manager.writeToSource.bind(manager)
		vi.spyOn(manager, "writeToSource").mockImplementation((id, payload) => {
			calls++
			// The first frame (the rate) goes out; the second (the frequency) is refused.
			if (calls === 2) throw new Error("socket is not writable")
			return write(id, payload)
		})
	})
	await rtl.framesOn(0, 1)
	expect(tuningFrames(rtl.frames[0])).toEqual([[SET_SAMPLE_RATE, RATE]])
	const state = controller.getState("rtl")
	expect(state?.declaredOnlyFields).toEqual(["frequency"])
	expect(state?.lastError).toBe(
		"Tuner state restore failed: socket is not writable",
	)
	expect(tuningTrustOf(state)).toBe("unverified")
})

it("the connect proof lapses when the held value changes unwritten, and holds again on the written value", async () => {
	const { rtl, controller } = await setup()
	await rtl.framesOn(0, 2)
	expect(controller.getState("rtl")?.declaredOnlyFields).toBeUndefined()
	// A change of the held state this core never wrote to the receiver (white-box stand-in).
	const held = (
		controller as unknown as {
			tunerStates: Map<string, { frequency: number }>
		}
	).tunerStates.get("rtl")
	if (held === undefined) throw new Error("no tuner state")
	held.frequency = CENTRE + 1_000_000
	expect(controller.getState("rtl")?.declaredOnlyFields).toEqual(["frequency"])
	expect(tuningTrustOf(controller.getState("rtl"))).toBe("unverified")
	// Back on the value written on this connection: proven again, with no new frame.
	held.frequency = CENTRE
	expect(controller.getState("rtl")?.declaredOnlyFields).toBeUndefined()
	expect(tuningTrustOf(controller.getState("rtl"))).toBe("commanded")
	expect(tuningFrames(rtl.frames[0])).toHaveLength(2)
})

const SET_GAIN_MODE = 0x03
const SET_GAIN = 0x04
const SET_AGC_MODE = 0x08
const SET_TEST_MODE = 0x07
const JOB_CENTRE = 145_000_000

/** Drops the socket and waits for the next connection's first payload (backoff faked). */
async function flap(rtl: FakeRtlTcp, manager: SourceManager): Promise<void> {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.spyOn(Math, "random").mockReturnValue(0)
	const lost = once(manager, "disconnected")
	for (const socket of rtl.sockets) socket.destroy()
	await lost
	const payload = once(manager, "payload-started")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await payload
	vi.useRealTimers()
	await new Promise(resolve => setImmediate(resolve))
}

/** The production composition of the scanner's arbiter over the real controller and sources. */
function arbiterOver(manager: SourceManager, controller: TunerController) {
	const clock = new FakeClock()
	const arbiter = new TunerArbiter({
		tuner: controller,
		sources: manager,
		epochs: id => (id === "rtl" ? clock : undefined),
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
		logger: log,
	})
	cleanup.push(() => Promise.resolve(arbiter.dispose()))
	const lost: LeaseLostReason[] = []
	arbiter.on("lease-lost", (_lease: Lease, reason: LeaseLostReason) =>
		lost.push(reason),
	)
	const acquired = arbiter.acquire("job", "rtl", 50)
	if (!acquired.ok) throw new Error(`acquire refused: ${acquired.detail}`)
	return { arbiter, lease: acquired.lease, lost }
}

const sentLog = (controller: TunerController) => {
	const sent: Array<[string, number, string | undefined]> = []
	controller.on("command-sent", (_id, name: string, value: number, origin) =>
		sent.push([name, value, origin as string | undefined]),
	)
	return sent
}

describe("a held lease across a socket flap (the core's own tuning, never config over it)", () => {
	it("the job's centre is back on the wire after the reconnect and the config centre is not sent", async () => {
		const { rtl, manager, controller } = await setup()
		await rtl.framesOn(0, 2)
		const { arbiter, lease, lost } = arbiterOver(manager, controller)
		await arbiter.retune(lease, {
			centreHz: JOB_CENTRE,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		await rtl.framesOn(0, 5)
		expect(tuningFrames(rtl.frames[0])).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, CENTRE],
			[SET_FREQUENCY, JOB_CENTRE],
		])
		const sent = sentLog(controller)
		await flap(rtl, manager)
		await rtl.framesOn(1, 1)
		expect(tuningFrames(rtl.frames[1])).toEqual([[SET_FREQUENCY, JOB_CENTRE]])
		expect(sent).not.toContainEqual(["set-frequency", CENTRE, "config"])
		expect(controller.getState("rtl")?.frequency).toBe(JOB_CENTRE)
		expect(manager.getCaps("rtl")?.centerFreq).toBe(JOB_CENTRE)
		// The rate was tuned by nobody but the source was: it stays declared only, unwritten.
		expect(controller.getState("rtl")?.declaredOnlyFields).toEqual([
			"sampleRate",
		])
		expect(arbiter.holder("rtl")).toBe(lease)
		expect(lost).toEqual([])
	})

	it("an unaccepted job write the reconnect forgets is reasserted, not replaced by the config centre", async () => {
		const { rtl, manager, controller } = await setup()
		await rtl.framesOn(0, 2)
		const { arbiter, lease, lost } = arbiterOver(manager, controller)
		await controller.setFrequency("rtl", JOB_CENTRE, {
			origin: "scanner",
			jobId: "job",
			accept: false,
		})
		await rtl.framesOn(0, 3)
		const sent = sentLog(controller)
		await flap(rtl, manager)
		await rtl.framesOn(1, 1)
		expect(tuningFrames(rtl.frames[1])).toEqual([[SET_FREQUENCY, JOB_CENTRE]])
		expect(sent).toContainEqual(["set-frequency", JOB_CENTRE, "replay"])
		expect(sent).not.toContainEqual(["set-frequency", CENTRE, "config"])
		const state = controller.getState("rtl")
		expect(state?.frequency).toBe(JOB_CENTRE)
		expect(state?.declaredOnlyFields).toEqual(["sampleRate"])
		expect(manager.getCaps("rtl")?.centerFreq).toBe(JOB_CENTRE)
		expect(arbiter.holder("rtl")).toBe(lease)
		expect(lost).toEqual([])
		// Every later connection reasserts it too.
		await flap(rtl, manager)
		await rtl.framesOn(2, 1)
		expect(tuningFrames(rtl.frames[2])).toEqual([[SET_FREQUENCY, JOB_CENTRE]])
	})

	it("a relay client's tuning is never overwritten by the declared values", async () => {
		const { rtl, manager, controller } = await setup()
		await rtl.framesOn(0, 2)
		// An ignored (out-of-range) relay rate: the receiver may hold it, nothing proves it.
		controller.applyExternalCommand("rtl", SET_SAMPLE_RATE, 5)
		controller.setControlMode("rtl", "internal")
		await flap(rtl, manager)
		expect(tuningFrames(rtl.frames[1])).toEqual([])
		expect(controller.getState("rtl")?.declaredOnlyFields).toEqual([
			"frequency",
		])
	})
})

describe("frame sequence of a reconnect with a configured gain and a held job", () => {
	it("pins every frame of the first connection and of the reconnect, none written twice", async () => {
		const { rtl, manager, controller } = await setup({}, manager => {
			const getConfig = manager.getConfig.bind(manager)
			vi.spyOn(manager, "getConfig").mockImplementation(id => {
				const config = getConfig(id)
				return config
					? {
							...config,
							tuner: { gainMode: "manual", gainDb: 49.6, agcMode: false },
						}
					: config
			})
		})
		// First connection, nothing tuned yet: the declared rate and centre, then the configured gain.
		await rtl.framesOn(0, 5)
		expect(rtl.frames[0]).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, CENTRE],
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 496],
			[SET_AGC_MODE, 0],
		])
		const { arbiter, lease } = arbiterOver(manager, controller)
		await arbiter.retune(lease, {
			centreHz: JOB_CENTRE,
			gainTenthsDb: null,
			sampleRateHz: null,
		})
		await rtl.framesOn(0, 8)
		const hop = rtl.frames[0]?.slice(5)
		expect(hop).toEqual([
			[SET_TEST_MODE, 1],
			[SET_FREQUENCY, JOB_CENTRE],
			[SET_TEST_MODE, 0],
		])
		// Reconnect: the configured gain, the job's accepted centre replayed, TEST_MODE 0 from the
		// arbiter. No declared rate or centre: the source was tuned since start (5 frames, 25 bytes).
		await flap(rtl, manager)
		await rtl.framesOn(1, 5)
		expect(rtl.frames[1]).toEqual([
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 496],
			[SET_AGC_MODE, 0],
			[SET_FREQUENCY, JOB_CENTRE],
			[SET_TEST_MODE, 0],
		])
	})

	it("with nothing tuned since start a reconnect writes the declared tuning, then the configured gain", async () => {
		const { rtl, manager } = await setup({}, manager => {
			const getConfig = manager.getConfig.bind(manager)
			vi.spyOn(manager, "getConfig").mockImplementation(id => {
				const config = getConfig(id)
				return config
					? { ...config, tuner: { gainMode: "manual", gainDb: 49.6 } }
					: config
			})
		})
		await rtl.framesOn(0, 4)
		await flap(rtl, manager)
		await rtl.framesOn(1, 4)
		expect(rtl.frames[1]).toEqual([
			[SET_SAMPLE_RATE, RATE],
			[SET_FREQUENCY, CENTRE],
			[SET_GAIN_MODE, 1],
			[SET_GAIN, 496],
		])
	})
})

it("the kill switch writes no declared tuning on connect", async () => {
	const { rtl, controller } = await setup({
		writeDeclaredTuningOnConnect: false,
	})
	await new Promise(resolve => setImmediate(resolve))
	expect(tuningFrames(rtl.frames[0])).toEqual([])
	expect(controller.getState("rtl")?.declaredOnlyFields).toEqual([
		"frequency",
		"sampleRate",
	])
})
