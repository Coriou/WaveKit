/**
 * On every new connection the core writes the declared-only sample rate and frequency, so they
 * become proven (a shared rtlmux keeps the last client's tuning). In-process fake rtl_tcp on an
 * ephemeral loopback port.
 */
import * as net from "node:net"
import { once } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
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

it("an accepted frequency is replayed, not written twice, and the declared rate is written first", async () => {
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
	await rtl.framesOn(1, 2)
	expect(tuningFrames(rtl.frames[1])).toEqual([
		[SET_SAMPLE_RATE, RATE],
		[SET_FREQUENCY, 145_000_000],
	])
	expect(controller.getState("rtl")?.declaredOnlyFields).toBeUndefined()
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
