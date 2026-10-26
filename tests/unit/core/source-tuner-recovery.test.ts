import * as net from "node:net"
import { once } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import {
	SourceManager,
	calculateBackoffDelay,
	SOURCE_CONNECT_TIMEOUT_MS,
	TUNER_COMMAND_TIMEOUT_MS,
} from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import Fastify from "fastify"
import { tunerRoutes } from "../../../src/api/routes/tuner.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})
const frame = (command: number, value: number) => {
	const data = Buffer.alloc(5)
	data[0] = command
	data.writeUInt32BE(value, 1)
	return data
}
async function setup(payloadOnReconnect = true) {
	let connections = 0
	const sockets = new Set<net.Socket>()
	const frames: number[] = []
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on("error", () => {})
		socket.on("close", () => sockets.delete(socket))
		let pending = Buffer.alloc(0)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			while (pending.length >= 5) {
				frames.push(pending.readUInt32BE(1))
				pending = pending.subarray(5)
			}
		})
		connections++
		socket.write(
			Buffer.concat([
				Buffer.from("RTL0"),
				Buffer.alloc(8),
				Buffer.alloc(connections === 1 || payloadOnReconnect ? 8 : 0),
			]),
		)
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	const manager = new SourceManager(createLogger({ level: "fatal" }))
	cleanup.push(() => manager.disconnectAll())
	const accepted = once(server, "connection")
	await manager.connect({
		id: "source",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: (server.address() as net.AddressInfo).port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps: {
			kind: "iq",
			sampleRate: 1_000_000,
			format: "U8_IQ",
			exclusive: false,
		},
	})
	await accepted
	return { manager, server, sockets, frames }
}

it("waits through rate recovery and applies two queued commands in FIFO order", async () => {
	const { manager, frames } = await setup()
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(1_234_567)
	vi.spyOn(Math, "random").mockReturnValue(0)
	const disconnected = once(manager, "disconnected")
	let complete = false
	const rate = manager
		.runTunerCommand("source", async () => {
			manager.writeToSource("source", frame(2, 1_200_000))
			manager.updateSourceCaps("source", { sampleRate: 1_200_000 })
		})
		.then(() => {
			complete = true
		})
	await disconnected
	const first = manager.runTunerCommand("source", async () => {
		manager.writeToSource("source", frame(1, 12_345))
	})
	const second = manager.runTunerCommand("source", async () => {
		manager.writeToSource("source", frame(1, 12_347))
	})
	expect(complete).toBe(false)
	const connected = once(manager, "connected")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await connected
	await Promise.all([rate, first, second])
	// Observe receipt rather than using elapsed wall time as an assertion.
	await new Promise<void>(resolve => {
		const check = () => (frames.length === 3 ? resolve() : setImmediate(check))
		check()
	})
	expect(frames).toEqual([1_200_000, 12_345, 12_347])
})

it("fails at the recovery bound and past it with a typed retry error", async () => {
	const { manager, server } = await setup()
	// Stop accepting new connections without touching anything outside this fake.
	server.close()
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(7_654_321)
	const disconnected = once(manager, "disconnected")
	const pending = manager.runTunerCommand("source", async () => {
		manager.writeToSource("source", frame(2, 1_200_000))
	})
	const rejected = expect(pending).rejects.toMatchObject({
		code: "SOURCE_RECONNECTING",
		message: expect.stringContaining("retry"),
	})
	await disconnected
	let settled = false
	void pending.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)
	const bound = calculateBackoffDelay(1) + SOURCE_CONNECT_TIMEOUT_MS
	await vi.advanceTimersByTimeAsync(bound - 1)
	expect(settled).toBe(false)
	await vi.advanceTimersByTimeAsync(1)
	await rejected
	await vi.advanceTimersByTimeAsync(1)
	await expect(
		manager.runTunerCommand("source", async () => {}),
	).rejects.toBeInstanceOf(WaveKitError)
})

it("keeps unrelated disconnects fast and typed", async () => {
	const { manager, sockets } = await setup()
	const disconnected = once(manager, "disconnected")
	for (const socket of sockets) socket.destroy()
	await disconnected
	await expect(
		manager.runTunerCommand("source", async () => {
			manager.writeToSource("source", frame(1, 12_345))
		}),
	).rejects.toMatchObject({ code: "SOURCE_DISCONNECTED" })
})

it("sample-rate HTTP success waits for IQ before a queued frequency request runs", async () => {
	const { manager, frames } = await setup()
	const controller = new TunerController(
		createLogger({ level: "fatal" }),
		manager,
	)
	controller.initializeSource("source", manager.getCaps("source"), "rtl_tcp")
	controller.on("error", () => {})
	const app = Fastify()
	await app.register(tunerRoutes, {
		tunerController: controller,
		sourceManager: manager,
	})
	await app.ready()
	cleanup.push(() => app.close())
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(1_234_567)
	const disconnected = once(manager, "disconnected")
	let complete = false
	const rate = app
		.inject({
			method: "POST",
			url: "/api/tuner/source/sample-rate",
			payload: { hz: 1_200_000 },
		})
		.then(result => {
			complete = true
			return result
		})
	await disconnected
	const tune = app
		.inject({
			method: "POST",
			url: "/api/tuner/source/frequency",
			payload: { hz: 123_456_789 },
		})
		.then(result => result)
	expect(complete).toBe(false)
	const payload = once(manager, "payload-started")
	await vi.advanceTimersByTimeAsync(calculateBackoffDelay(1))
	await payload
	expect((await rate).statusCode).toBe(200)
	expect((await tune).statusCode).toBe(200)
	expect(controller.getState("source")).toMatchObject({
		frequency: 123_456_789,
		sampleRate: 1_200_000,
	})
	expect(frames[0]).toBe(1_200_000)
})

it("bounds hung execution at 9 s, advances the FIFO and blocks a late write", async () => {
	const { manager } = await setup()
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(3_456_789)
	let resume: () => void = () => {}
	const gate = new Promise<void>(resolve => {
		resume = resolve
	})
	const write = vi.spyOn(net.Socket.prototype, "write")
	let lateError: unknown
	const hung = manager.runTunerCommand("source", async () => {
		await gate
		try {
			manager.writeToSource("source", frame(1, 12_345))
		} catch (error) {
			lateError = error
			throw error
		}
	})
	const rejected = expect(hung).rejects.toMatchObject({
		code: "TUNER_COMMAND_TIMEOUT",
	})
	const next = vi.fn(async () => {
		manager.writeToSource("source", frame(4, 42))
	})
	const queued = manager.runTunerCommand("source", next)
	await vi.advanceTimersByTimeAsync(TUNER_COMMAND_TIMEOUT_MS - 1)
	expect(next).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	await rejected
	await queued
	expect(next).toHaveBeenCalledOnce()
	await vi.advanceTimersByTimeAsync(1)
	resume()
	await vi.advanceTimersByTimeAsync(0)
	expect(lateError).toBeInstanceOf(WaveKitError)
	expect(lateError).toMatchObject({ code: "TUNER_COMMAND_TIMEOUT" })
	expect(write).toHaveBeenCalledTimes(1)
	expect(write).toHaveBeenCalledWith(frame(4, 42))
})

it("removing a source rejects hung and queued commands immediately", async () => {
	const { manager } = await setup()
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(4_321_987)
	const hung = manager.runTunerCommand(
		"source",
		() => new Promise<never>(() => {}),
	)
	const next = vi.fn(async () => {})
	const queued = manager.runTunerCommand("source", next)
	const checks = [hung, queued].map(pending =>
		expect(pending).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" }),
	)
	await vi.advanceTimersByTimeAsync(137)
	await manager.disconnect("source")
	await Promise.all(checks)
	expect(next).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(TUNER_COMMAND_TIMEOUT_MS + 1)
	expect(next).not.toHaveBeenCalled()
})

it("clears expired recovery when background reconnect finally supplies IQ", async () => {
	const { manager, sockets } = await setup(false)
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	vi.setSystemTime(5_432_109)
	vi.spyOn(Math, "random").mockReturnValue(0)
	const disconnected = once(manager, "disconnected")
	const rate = manager.runTunerCommand("source", async () => {
		manager.writeToSource("source", frame(2, 1_200_000))
	})
	const rejected = expect(rate).rejects.toMatchObject({
		code: "SOURCE_RECONNECTING",
	})
	await disconnected
	const connected = once(manager, "connected")
	const backoff = calculateBackoffDelay(1)
	await vi.advanceTimersByTimeAsync(backoff)
	await connected
	await vi.advanceTimersByTimeAsync(SOURCE_CONNECT_TIMEOUT_MS)
	await rejected
	await vi.advanceTimersByTimeAsync(137)
	const payload = once(manager, "payload-started")
	for (const socket of sockets) socket.write(Buffer.alloc(8))
	await payload
	const lost = once(manager, "disconnected")
	for (const socket of sockets) socket.destroy()
	await lost
	await expect(
		manager.runTunerCommand("source", async () => {
			manager.writeToSource("source", frame(4, 42))
		}),
	).rejects.toMatchObject({ code: "SOURCE_DISCONNECTED" })
})
