/**
 * The accepted tuning (centre, rate, gain) is replayed on a reconnect only to the
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
import {
	resolveReceiverIdentity,
	type ReceiverIdentity,
} from "../../../src/core/receiver-identity.js"
import { createLogger } from "../../../src/utils/logger.js"

const log = createLogger({ level: "fatal" })
const RATE = 2_048_000
const CENTRE = 100_000_000
const A_CENTRE = 145_000_000
const B_CENTRE = 433_000_000
const SET_FREQUENCY = 0x01
const SET_GAIN = 0x04
const SET_SAMPLE_RATE = 0x02

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

			// Another receiver: nothing of A is replayed or asserted; the state is the configured
			// baseline, and assert holds only the declared centre (its fallback, rule 3).
			const onB = await flapTo([1, 14])
			expect(onB.filter(([cmd]) => cmd === SET_FREQUENCY)).toEqual([
				[SET_FREQUENCY, CENTRE],
			])
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

/** The controller alone, with the receiver identity the test sets, and a recording transport. */
function direct() {
	const frames: Array<[number, number]> = []
	const caps = {
		kind: "iq" as const,
		sampleRate: RATE,
		centerFreq: CENTRE,
		format: "U8_IQ" as const,
		exclusive: false,
	}
	const transport = {
		assertTunerCommandActive: () => {},
		writeToSource: (_id: string, payload: Buffer) => {
			frames.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		},
		isRtlTcpSource: () => true,
		updateSourceCaps: (_id: string, updates: Partial<typeof caps>) =>
			Object.assign(caps, updates),
		getCaps: () => ({ ...caps }),
		setTuningCaps: (
			_id: string,
			tuning: { sampleRate: number; centerFreq?: number | undefined },
		) => Object.assign(caps, tuning),
	}
	let current: ReceiverIdentity | undefined
	const controller = new TunerController(
		log,
		transport as unknown as SourceManager,
		{
			defaultFrequency: CENTRE,
			defaultSampleRate: RATE,
			receiverIdentity: () => current,
			receiverTracked: () => true,
		},
	)
	controller.on("error", () => {})
	controller.initializeSource("rtl", { ...caps }, "rtl_tcp")
	/** A new connection reaching `identity`: the frames its connect sync wrote. */
	const connect = (
		identity: ReceiverIdentity,
		options?: { resume: "plain" | "restore" },
	) => {
		current = identity
		controller.noteSourceConnected("rtl")
		const from = frames.length
		controller.synchronizeOnConnect("rtl", options)
		return frames.slice(from)
	}
	return { controller, connect }
}

const HDR = (tunerType: number, gainCount: number) => ({
	magic: "RTL0",
	tunerType,
	gainCount,
})
const ID_A = resolveReceiverIdentity("rtl", HDR(5, 29), null)
const ID_B = resolveReceiverIdentity("rtl", HDR(1, 14), null)
const ID_UNKNOWN = resolveReceiverIdentity("rtl", null, null)
const X_CENTRE = 300_000_000

describe("receiver gate: an unknown interlude", () => {
	it("A -> unknown -> A: A gets its own tuning back; what was accepted while unknown is not replayed", async () => {
		const { controller, connect } = direct()
		connect(ID_A)
		await controller.setFrequency("rtl", A_CENTRE)
		connect(ID_UNKNOWN)
		expect(controller.getState("rtl")?.frequency).toBe(CENTRE)
		await controller.setFrequency("rtl", X_CENTRE)
		const onA = connect(ID_A)
		expect(onA).toContainEqual([SET_FREQUENCY, A_CENTRE])
		expect(onA).not.toContainEqual([SET_FREQUENCY, X_CENTRE])
		expect(controller.getState("rtl")?.frequency).toBe(A_CENTRE)
		expect(controller.receiverTuningRestore("rtl")).toEqual({
			restored: true,
			reason: "this receiver's tuning from earlier",
		})
	})

	it("A -> unknown -> B: B gets the configured tuning, neither A's nor the unknown one's", async () => {
		const { controller, connect } = direct()
		connect(ID_A)
		await controller.setFrequency("rtl", A_CENTRE)
		connect(ID_UNKNOWN)
		await controller.setFrequency("rtl", X_CENTRE)
		const onB = connect(ID_B)
		// Assert holds the declared centre only: neither A's nor the unknown one's.
		expect(onB.filter(([cmd]) => cmd === SET_FREQUENCY)).toEqual([
			[SET_FREQUENCY, CENTRE],
		])
		expect(controller.getState("rtl")?.frequency).toBe(CENTRE)
		expect(controller.receiverTuningRestore("rtl")).toEqual({
			restored: false,
			reason: "another receiver: configured tuning",
		})
		// And A later still has its own.
		expect(connect(ID_A)).toContainEqual([SET_FREQUENCY, A_CENTRE])
	})

	it("an unknown receiver first, then A: nothing accepted while unknown is replayed to A", async () => {
		const { controller, connect } = direct()
		connect(ID_UNKNOWN)
		await controller.setFrequency("rtl", X_CENTRE)
		const onA = connect(ID_A)
		expect(onA).not.toContainEqual([SET_FREQUENCY, X_CENTRE])
		expect(controller.getState("rtl")?.frequency).toBe(CENTRE)
	})
})

describe("receiver gate after a plain resume", () => {
	it("another receiver keeps the values in doubt (unverified), not the configured baseline", async () => {
		const { controller, connect } = direct()
		connect(ID_A)
		await controller.setFrequency("rtl", A_CENTRE)
		controller.noteFeedPaused("rtl")
		connect(ID_A, { resume: "plain" })
		expect(controller.getState("rtl")?.unknownFields).toContain("frequency")
		// Accepted after the plain resume: replayed to A, but not B's to have.
		await controller.setGainMode("rtl", "manual")
		await controller.setGain("rtl", 280)

		const onB = connect(ID_B)
		expect(onB).toEqual([])
		const state = controller.getState("rtl")
		expect(state).toMatchObject({ frequency: A_CENTRE, gain: 280 })
		expect(state?.unknownFields).toEqual(
			expect.arrayContaining(["frequency", "gain", "gainMode"]),
		)
	})
})

const UNIT = (unitId: string) =>
	resolveReceiverIdentity("rtl", HDR(5, 29), { unitId })
const ID_UNIT_A = UNIT("a".repeat(32))
const ID_UNIT_B = UNIT("b".repeat(32))
const ID_MODEL_A = resolveReceiverIdentity("rtl", HDR(5, 29), null)

describe("receiver gate: what assert holds follows the receiver", () => {
	it("a swapped unit of the same model is asserted the declared centre, never the other unit's", async () => {
		const { controller, connect } = direct()
		connect(ID_UNIT_A)
		await controller.setFrequency("rtl", A_CENTRE)
		const onB = connect(ID_UNIT_B)
		expect(onB.filter(([cmd]) => cmd === SET_FREQUENCY)).toEqual([
			[SET_FREQUENCY, CENTRE],
		])
		// Back on A: its own accepted centre is held (and asserted) again.
		expect(connect(ID_UNIT_A)).toContainEqual([SET_FREQUENCY, A_CENTRE])
		expect(controller.getState("rtl")?.frequency).toBe(A_CENTRE)
	})

	it("a unit answer after the restore names another unit: its later sessions hold the declared centre", async () => {
		const { controller, connect } = direct()
		connect(ID_UNIT_A)
		await controller.setFrequency("rtl", A_CENTRE)
		// The header alone matches A's model: restored (and asserted) as the same receiver.
		expect(connect(ID_MODEL_A)).toContainEqual([SET_FREQUENCY, A_CENTRE])
		// Then the sdr-host names another unit: A's tuning is set aside.
		controller.noteReceiverBound(
			"rtl",
			{ key: ID_UNIT_B.key, adoptLegacy: false },
			ID_UNIT_B,
		)
		const again = connect(ID_UNIT_B)
		expect(again).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
		expect(again.filter(([cmd]) => cmd === SET_FREQUENCY)).toEqual([
			[SET_FREQUENCY, CENTRE],
		])
		// A keeps its own.
		expect(connect(ID_UNIT_A)).toContainEqual([SET_FREQUENCY, A_CENTRE])
	})

	it("an unknown receiver is asserted no accepted rate either", async () => {
		const { controller, connect } = direct()
		connect(ID_A)
		await controller.setSampleRate("rtl", 2_400_000)
		const unknown = connect(ID_UNKNOWN)
		expect(unknown).not.toContainEqual([SET_SAMPLE_RATE, 2_400_000])
		expect(unknown).toContainEqual([SET_SAMPLE_RATE, RATE])
		expect(connect(ID_A)).toContainEqual([SET_SAMPLE_RATE, 2_400_000])
	})
})
