/**
 * Tuner state restoration on source reconnection (fake command transport).
 * Design: docs/superpowers/specs/2026-10-08-tuner-reconnect-sync.md
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const testLogger = createLogger({ level: "fatal" })

/** Fake transport: records every frame written upstream and mirrors caps. */
function createFakeTransport() {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const frames: Array<[number, number]> = []
	const capsChanges: Array<Partial<SourceCaps>> = []
	let failAfter: number | null = null
	const transport = {
		caps,
		frames,
		capsChanges,
		failAfterWrites(count: number | null) {
			failAfter = count
		},
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			if (failAfter !== null && failAfter <= 0) {
				throw new Error("Source rtl-1 socket is not writable")
			}
			if (failAfter !== null) failAfter--
			frames.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		}),
		isRtlTcpSource: vi.fn(() => true),
		updateSourceCaps: vi.fn((_id: string, updates: Partial<SourceCaps>) => {
			const changed = Object.entries(updates).some(
				([key, value]) => Reflect.get(caps, key) !== value,
			)
			if (!changed) return caps
			Object.assign(caps, updates)
			capsChanges.push(updates)
			return caps
		}),
		getCaps: vi.fn(() => ({ ...caps })),
		setTuningCaps: vi.fn(
			(
				_id: string,
				tuning: { sampleRate: number; centerFreq?: number | undefined },
			) => {
				if (
					caps.sampleRate === tuning.sampleRate &&
					caps.centerFreq === tuning.centerFreq
				)
					return caps
				caps.sampleRate = tuning.sampleRate
				if (tuning.centerFreq === undefined) delete caps.centerFreq
				else caps.centerFreq = tuning.centerFreq
				capsChanges.push({ ...tuning })
				return caps
			},
		),
	}
	return transport
}

type FakeTransport = ReturnType<typeof createFakeTransport>

describe("TunerController reconnect synchronization", () => {
	let transport: FakeTransport
	let controller: TunerController

	beforeEach(() => {
		transport = createFakeTransport()
		controller = new TunerController(
			testLogger,
			transport as unknown as SourceManager,
		)
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
	})

	const reconnect = () => {
		transport.frames.length = 0
		transport.capsChanges.length = 0
		return controller.synchronizeOnConnect("rtl-1")
	}

	it("writes nothing when only config defaults exist", () => {
		const result = reconnect()
		expect(result.commands).toEqual([])
		expect(transport.frames).toEqual([])
		expect(controller.getState("rtl-1")?.commandCount).toBe(0)
	})

	it("replays the last accepted state with rate before center and gain mode before gain", async () => {
		await controller.setGain("rtl-1", 300)
		await controller.setFrequency("rtl-1", 145_000_000)
		await controller.setGainMode("rtl-1", "manual")
		await controller.setGain("rtl-1", 400)
		await controller.setSampleRate("rtl-1", 2_400_000)
		await controller.setPpm("rtl-1", -2)
		await controller.setBiasTee("rtl-1", true)
		await controller.setAgcMode("rtl-1", false)
		await controller.setDirectSampling("rtl-1", "q")
		await controller.setFrequency("rtl-1", 145_500_000)

		const result = reconnect()
		expect(transport.frames).toEqual([
			[0x09, 2],
			[0x05, 0xfffffffe],
			[0x02, 2_400_000],
			[0x01, 145_500_000],
			[0x0e, 1],
			[0x08, 0],
			[0x03, 1],
			[0x04, 400],
		])
		expect(result.commands).toHaveLength(8)
		expect(result.error).toBeUndefined()
	})

	it("keeps the gain group in acceptance order (AGC selected after a manual gain)", async () => {
		await controller.setGainMode("rtl-1", "manual")
		await controller.setGain("rtl-1", 250)
		await controller.setGainMode("rtl-1", "agc")
		reconnect()
		expect(transport.frames).toEqual([
			[0x04, 250],
			[0x03, 0],
		])
	})

	it("drops a cleared tuner IF gain from the desired state", async () => {
		await controller.setTunerIfGain("rtl-1", 1, 30)
		await controller.configure("rtl-1", { tunerIfGain: null })
		reconnect()
		expect(transport.frames).toEqual([])
	})

	it("does not emit caps-changed (no decoder restart) when metadata already matches", async () => {
		await controller.setSampleRate("rtl-1", 2_400_000)
		await controller.setFrequency("rtl-1", 162_000_000)
		reconnect()
		reconnect()
		expect(transport.capsChanges).toEqual([])
	})

	it("propagates a metadata divergence exactly once", async () => {
		await controller.setFrequency("rtl-1", 162_000_000)
		transport.caps.centerFreq = 100_000_000
		reconnect()
		expect(transport.capsChanges).toEqual([
			{ sampleRate: 2_048_000, centerFreq: 162_000_000 },
		])
		reconnect()
		expect(transport.capsChanges).toEqual([])
	})

	it("never keeps caps that no accepted command backs (falls back to the configured baseline)", () => {
		// e.g. caps moved by a relay rate the controller rejected as out of range
		transport.caps.sampleRate = 3_500_000
		transport.caps.centerFreq = 446_866_968
		const result = reconnect()
		expect(result.commands).toEqual([])
		expect(transport.frames).toEqual([])
		expect(transport.capsChanges).toEqual([
			{ sampleRate: 2_048_000, centerFreq: 100_000_000 },
		])
	})

	it("replays relay-client state while an SDR++ client holds control", () => {
		controller.syncExternalControl("rtl-1", true)
		controller.applyExternalCommand("rtl-1", 0x02, 1_024_000)
		controller.applyExternalCommand("rtl-1", 0x01, 433_920_000)
		controller.applyExternalCommand("rtl-1", 0x0d, 7)
		controller.applyExternalCommand("rtl-1", 0x01, 1) // out of range: ignored
		reconnect()
		expect(controller.getState("rtl-1")?.controlMode).toBe("external")
		expect(transport.frames).toEqual([
			[0x02, 1_024_000],
			[0x01, 433_920_000],
			[0x0d, 7],
		])
	})

	it("lets a command issued in reaction to the replay supersede it on the wire", async () => {
		await controller.setFrequency("rtl-1", 145_000_000)
		let reacted = false
		controller.on("command-sent", () => {
			if (reacted) return
			reacted = true
			void controller.setFrequency("rtl-1", 146_000_000)
		})
		reconnect()
		await new Promise(resolve => setImmediate(resolve))
		expect(transport.frames).toEqual([
			[0x01, 145_000_000],
			[0x01, 146_000_000],
		])
		expect(controller.getState("rtl-1")?.frequency).toBe(146_000_000)

		// The newer command is now the desired state for the next reconnect.
		reconnect()
		expect(transport.frames).toEqual([[0x01, 146_000_000]])
	})

	it("stops on a mid-replay disconnect and replays fully on the next connection", async () => {
		await controller.setSampleRate("rtl-1", 2_400_000)
		await controller.setFrequency("rtl-1", 145_000_000)
		await controller.setGain("rtl-1", 300)
		const errors: Error[] = []
		controller.on("error", (_id, err) => errors.push(err))

		transport.failAfterWrites(1)
		const failed = reconnect()
		expect(transport.frames).toEqual([[0x02, 2_400_000]])
		expect(failed.error).toMatch(/not writable/)
		expect(errors).toHaveLength(1)
		expect(controller.getState("rtl-1")?.lastError).toMatch(/not writable/)

		transport.failAfterWrites(null)
		const ok = reconnect()
		expect(ok.error).toBeUndefined()
		expect(transport.frames).toEqual([
			[0x02, 2_400_000],
			[0x01, 145_000_000],
			[0x04, 300],
		])
		expect(controller.getState("rtl-1")?.lastError).toBeUndefined()
	})

	it("bounds repeated reconnects to one batch per connection", async () => {
		await controller.setFrequency("rtl-1", 145_000_000)
		await controller.setSampleRate("rtl-1", 2_400_000)
		const before = controller.getState("rtl-1")?.commandCount ?? 0
		for (let i = 0; i < 10; i++) reconnect()
		expect(transport.writeToSource).toHaveBeenCalledTimes(2 + 10 * 2)
		expect(controller.getState("rtl-1")?.commandCount).toBe(before + 20)
	})

	it("emits command-sent per replayed command and one state-changed, never readback fields", async () => {
		await controller.setFrequency("rtl-1", 145_000_000)
		const sent: string[] = []
		const states: unknown[] = []
		controller.on("command-sent", (_id, name) => sent.push(name))
		controller.on("state-changed", (_id, state) => states.push(state))
		reconnect()
		expect(sent).toEqual(["set-frequency"])
		expect(states).toHaveLength(1)
		const keys = Object.keys(states[0] as object)
		expect(keys.some(key => /ack|readback|actual|confirmed/i.test(key))).toBe(
			false,
		)
	})

	it("forgets desired state when the source is removed", async () => {
		await controller.setFrequency("rtl-1", 145_000_000)
		controller.removeSource("rtl-1")
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
		reconnect()
		expect(transport.frames).toEqual([])
	})

	it("ignores unknown sources", () => {
		expect(controller.synchronizeOnConnect("missing").commands).toEqual([])
	})
})

describe("Pi reboot scenario: SDR++ left caps at 2.16 Msps / 446.866968 MHz", () => {
	// Live evidence: the Pi was reflashed and rtl_tcp came back at its configured
	// 2.048 Msps while core metadata still claimed the pre-outage relay tuning.
	const setup = (reconnectPolicy?: "restore" | "reset") => {
		const transport = createFakeTransport()
		transport.caps.centerFreq = 446_000_000
		const controller = new TunerController(
			testLogger,
			transport as unknown as SourceManager,
			reconnectPolicy ? { reconnectPolicy } : {},
		)
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
		controller.syncExternalControl("rtl-1", true)
		controller.applyExternalCommand("rtl-1", 0x02, 2_160_000)
		controller.applyExternalCommand("rtl-1", 0x01, 446_866_968)
		controller.applyExternalCommand("rtl-1", 0x04, 297)
		controller.syncExternalControl("rtl-1", false)
		transport.frames.length = 0
		transport.capsChanges.length = 0
		return { transport, controller }
	}

	it("restore (default) re-commands the accepted tuning so caps are backed by a fresh command", () => {
		const { transport, controller } = setup()
		const result = controller.synchronizeOnConnect("rtl-1")
		expect(result.policy).toBe("restore")
		expect(transport.frames).toEqual([
			[0x02, 2_160_000],
			[0x01, 446_866_968],
			[0x04, 297],
		])
		expect(transport.caps.sampleRate).toBe(2_160_000)
		expect(transport.capsChanges).toEqual([]) // no decoder restart
	})

	it("reset sends nothing and returns state and caps to the configured baseline once", () => {
		const { transport, controller } = setup("reset")
		const states: unknown[] = []
		controller.on("state-changed", (_id, state) => states.push(state))

		const result = controller.synchronizeOnConnect("rtl-1")
		expect(result).toEqual({ policy: "reset", commands: [], reset: true })
		expect(transport.frames).toEqual([])
		expect(transport.capsChanges).toEqual([
			{ sampleRate: 2_048_000, centerFreq: 446_000_000 },
		])
		const state = controller.getState("rtl-1")
		expect(state?.sampleRate).toBe(2_048_000)
		expect(state?.frequency).toBe(446_000_000)
		expect(state?.gainMode).toBe("agc")
		expect(state?.gain).toBe(0)
		expect(states).toHaveLength(1)

		// Accepted state was discarded: a second reconnect is a no-op.
		expect(controller.synchronizeOnConnect("rtl-1").reset).toBe(false)
		expect(transport.capsChanges).toHaveLength(1)
	})

	it("reset drops a centerFreq the configuration never declared", () => {
		const transport = createFakeTransport()
		delete transport.caps.centerFreq
		const controller = new TunerController(
			testLogger,
			transport as unknown as SourceManager,
			{ reconnectPolicy: "reset" },
		)
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
		controller.applyExternalCommand("rtl-1", 0x01, 446_866_968)
		expect(transport.caps.centerFreq).toBe(446_866_968)
		controller.synchronizeOnConnect("rtl-1")
		expect(transport.caps.centerFreq).toBeUndefined()
		expect(transport.frames).toEqual([])
	})

	it("reset with nothing accepted is a no-op", () => {
		const transport = createFakeTransport()
		const controller = new TunerController(
			testLogger,
			transport as unknown as SourceManager,
			{ reconnectPolicy: "reset" },
		)
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
		expect(controller.synchronizeOnConnect("rtl-1").reset).toBe(false)
		expect(transport.capsChanges).toEqual([])
		expect(transport.frames).toEqual([])
	})
})
