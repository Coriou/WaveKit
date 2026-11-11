/**
 * Lane RS: the accepted tuning (centre, rate, gain) is replayed on a reconnect only to the
 * receiver it was accepted on. Production wiring: a real SourceManager, TunerController,
 * wireTunerControl and ReceiverIdentityTracker against an in-process fake rtl_tcp on an ephemeral
 * loopback port whose header (dongle model) the test switches. Real timers.
 */
import * as net from "node:net"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { ReceiverIdentityTracker } from "../../../src/core/receiver-identity-tracker.js"
import type { ReceiverIdentity } from "../../../src/core/receiver-identity.js"
import { createLogger } from "../../../src/utils/logger.js"

const log = createLogger({ level: "fatal" })
const RATE = 2_048_000
const CENTRE = 100_000_000
const A_CENTRE = 145_000_000
const B_CENTRE = 433_000_000
const SET_FREQUENCY = 0x01
const SET_GAIN = 0x04

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

type Model = [number, number] | "bad"

async function fakeRtlTcp(model: () => Model) {
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
		const m = model()
		const header = Buffer.alloc(12)
		header.write(m === "bad" ? "XXXX" : "RTL0", 0, "ascii")
		header.writeUInt32BE(m === "bad" ? 0 : m[0], 4)
		header.writeUInt32BE(m === "bad" ? 0 : m[1], 8)
		socket.write(Buffer.concat([header, Buffer.alloc(8)]))
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
	return {
		port: (server.address() as net.AddressInfo).port,
		sockets,
		frames,
		settled: async (index: number) => {
			// The connect sync writes synchronously at the first payload; wait for the frames to land.
			while (frames.length <= index)
				await new Promise<void>(resolve => waiters.push(resolve))
			await new Promise(resolve => setTimeout(resolve, 100))
		},
	}
}

const next1 = (
	manager: SourceManager,
	event: "disconnected" | "payload-started",
) => new Promise<void>(resolve => manager.once(event, () => resolve()))

async function setup() {
	let model: Model = [5, 29]
	const rtl = await fakeRtlTcp(() => model)
	const manager = new SourceManager(log)
	manager.on("error", () => {})
	cleanup.push(() => manager.disconnectAll())
	const tracker = new ReceiverIdentityTracker({
		sources: manager,
		logger: log,
		sdrHostApplies: () => false,
	})
	cleanup.push(() => tracker.stop())
	const controller = new TunerController(log, manager, {
		defaultFrequency: CENTRE,
		defaultSampleRate: RATE,
		receiverIdentity: id => tracker.provisional(id),
		receiverTracked: () => true,
	})
	controller.on("error", () => {})
	// As src/index.ts: the settled identity binds the receiver's learned state.
	tracker.on("identity", (id: string, identity: ReceiverIdentity) =>
		controller.noteReceiverBound(
			id,
			{
				key: identity.strength === "unknown" ? null : identity.key,
				adoptLegacy: false,
			},
			identity,
		),
	)
	wireTunerControl({
		log,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: { handleSourceConnected: () => {} } as unknown as TunerRelay,
		relayEnabled: false,
	})
	const payload = once(manager, "payload-started")
	await manager.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: rtl.port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps: {
			kind: "iq",
			sampleRate: RATE,
			centerFreq: CENTRE,
			format: "U8_IQ",
			exclusive: false,
		},
	})
	await payload
	await rtl.settled(0)
	/** Another dongle behind the same endpoint: drop the connection, the reconnect reads its header. */
	const flapTo = async (next: Model) => {
		model = next
		vi.spyOn(Math, "random").mockReturnValue(0)
		// Not events.once: it rejects on the manager's "error" event, which a reset may emit.
		const lost = next1(manager, "disconnected")
		const back = next1(manager, "payload-started")
		const index = rtl.frames.length
		for (const socket of rtl.sockets) socket.destroy()
		await lost
		await back
		await rtl.settled(index)
		return rtl.frames[index] ?? []
	}
	return { rtl, manager, controller, flapTo }
}

describe("receiver gate on the reconnect restore", () => {
	it(
		"A -> B -> A: B gets the configured tuning, A resumes its own tuning and gain",
		{ timeout: 30_000 },
		async () => {
			const { controller, flapTo } = await setup()
			await controller.setFrequency("rtl", A_CENTRE)
			await controller.setGainMode("rtl", "manual")
			await controller.setGain("rtl", 280)
			expect(controller.receiverTuningRestore("rtl")).toMatchObject({
				restored: false,
			})

			const onB = await flapTo([1, 14])
			expect(onB).toContainEqual([SET_FREQUENCY, CENTRE])
			expect(onB).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(onB).not.toContainEqual([SET_GAIN, 280])
			expect(controller.getState("rtl")?.frequency).toBe(CENTRE)
			expect(controller.getState("rtl")?.gainMode).not.toBe("manual")
			expect(controller.receiverTuningRestore("rtl")).toEqual({
				restored: false,
				reason: "another receiver: configured tuning",
			})
			await controller.setFrequency("rtl", B_CENTRE)

			const onA = await flapTo([5, 29])
			expect(onA).toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(onA).toContainEqual([SET_GAIN, 280])
			expect(onA).not.toContainEqual([SET_FREQUENCY, B_CENTRE])
			expect(controller.getState("rtl")).toMatchObject({
				frequency: A_CENTRE,
				gainMode: "manual",
				gain: 280,
			})
			expect(controller.receiverTuningRestore("rtl")).toEqual({
				restored: true,
				reason: "this receiver's tuning from earlier",
			})

			// And B, again: its own centre, not A's.
			const backOnB = await flapTo([1, 14])
			expect(backOnB).toContainEqual([SET_FREQUENCY, B_CENTRE])
			expect(backOnB).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
		},
	)

	it(
		"the same receiver reconnecting replays as before",
		{ timeout: 15_000 },
		async () => {
			const { controller, flapTo } = await setup()
			await controller.setFrequency("rtl", A_CENTRE)
			const again = await flapTo([5, 29])
			expect(again).toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(controller.receiverTuningRestore("rtl")).toEqual({
				restored: true,
				reason: "same receiver",
			})
		},
	)

	it(
		"an unknown receiver gets nothing restored",
		{ timeout: 15_000 },
		async () => {
			const { controller, flapTo } = await setup()
			await controller.setFrequency("rtl", A_CENTRE)
			const unknown = await flapTo("bad")
			expect(unknown).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(controller.getState("rtl")?.frequency).toBe(CENTRE)
			expect(controller.receiverTuningRestore("rtl")).toEqual({
				restored: false,
				reason: "receiver unknown: nothing restored",
			})
		},
	)
})
