// tests/unit/core/tuner-origin.test.ts
/**
 * Signal discovery spec § 4.6 and § 10.3: test-mode writes are never accepted
 * state (reconnect replay can never re-send TEST_MODE 1), and every write
 * reports who issued it so the arbiter can tell operator preemption from its
 * own commands and from replay.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerCommandOrigin } from "@wavekit/api-types"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const SET_FREQUENCY = 0x01
const SET_GAIN = 0x04
const SET_TEST_MODE = 0x07

function fakeTransport() {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 100_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const frames: Array<[number, number]> = []
	return {
		caps,
		frames,
		writeToSource: vi.fn((_id: string, payload: Buffer) => {
			frames.push([payload.readUInt8(0), payload.readUInt32BE(1)])
			return true
		}),
		isRtlTcpSource: vi.fn(() => true),
		updateSourceCaps: vi.fn((_id: string, updates: Partial<SourceCaps>) =>
			Object.assign(caps, updates),
		),
		getCaps: vi.fn(() => ({ ...caps })),
		setTuningCaps: vi.fn(
			(
				_id: string,
				tuning: { sampleRate: number; centerFreq?: number | undefined },
			) => {
				caps.sampleRate = tuning.sampleRate
				if (tuning.centerFreq === undefined) delete caps.centerFreq
				else caps.centerFreq = tuning.centerFreq
				return caps
			},
		),
	}
}

describe("TunerController origin tags and test mode", () => {
	let transport: ReturnType<typeof fakeTransport>
	let controller: TunerController
	let sent: Array<{
		command: string
		value: number
		origin: TunerCommandOrigin | undefined
	}>

	beforeEach(() => {
		transport = fakeTransport()
		controller = new TunerController(
			createLogger({ level: "fatal" }),
			transport as unknown as SourceManager,
		)
		controller.initializeSource("rtl-1", { ...transport.caps }, "rtl_tcp")
		sent = []
		controller.on(
			"command-sent",
			(
				_id: string,
				command: string,
				value: number,
				origin?: TunerCommandOrigin,
			) => sent.push({ command, value, origin }),
		)
	})

	const reconnect = () => {
		transport.frames.length = 0
		return controller.synchronizeOnConnect("rtl-1")
	}

	it("never replays test mode set through the API, even left on", async () => {
		await controller.setFrequency("rtl-1", 446_000_000)
		await controller.setTestMode("rtl-1", true)
		expect(controller.getState("rtl-1")?.testMode).toBe(true) // reported, not desired
		expect(controller.getState("rtl-1")?.unknownFields ?? []).not.toContain(
			"testMode",
		) // known (inferred)
		reconnect()
		expect(transport.frames).toEqual([[SET_FREQUENCY, 446_000_000]])
	})

	it("never replays test mode observed from the relay", () => {
		controller.applyExternalCommand("rtl-1", SET_TEST_MODE, 1)
		expect(controller.getState("rtl-1")?.testMode).toBe(true)
		expect(controller.getState("rtl-1")?.unknownFields ?? []).not.toContain(
			"testMode",
		)
		reconnect()
		expect(transport.frames.some(([cmd]) => cmd === SET_TEST_MODE)).toBe(false)
	})

	it("writes a marker sequence on the wire in order and accepts only the frequency", async () => {
		await controller.setTestMode("rtl-1", true, { origin: "scanner" })
		await controller.setFrequency("rtl-1", 412_600_000, { origin: "scanner" })
		await controller.setTestMode("rtl-1", false, { origin: "scanner" })
		expect(transport.frames).toEqual([
			[SET_TEST_MODE, 1],
			[SET_FREQUENCY, 412_600_000],
			[SET_TEST_MODE, 0],
		])
		reconnect()
		expect(transport.frames).toEqual([[SET_FREQUENCY, 412_600_000]])
	})

	it("accept: false writes and updates state and caps, marks the field known, but is not replayed", async () => {
		await controller.setFrequency("rtl-1", 433_920_000, {
			origin: "scanner",
			accept: false,
		})
		await controller.setGain("rtl-1", 300, { origin: "scanner", accept: false })
		expect(controller.getState("rtl-1")?.frequency).toBe(433_920_000)
		expect(transport.caps.centerFreq).toBe(433_920_000)
		expect(controller.getState("rtl-1")?.unknownFields ?? []).not.toContain(
			"gain",
		)
		reconnect()
		expect(
			transport.frames.some(
				([cmd]) => cmd === SET_FREQUENCY || cmd === SET_GAIN,
			),
		).toBe(false)
	})

	it("accept: false after an earlier accepted write replays the current value (replay encodes state)", async () => {
		await controller.setFrequency("rtl-1", 145_000_000)
		await controller.setFrequency("rtl-1", 433_920_000, {
			origin: "scanner",
			accept: false,
		})
		reconnect()
		expect(transport.frames).toEqual([[SET_FREQUENCY, 433_920_000]])
	})

	it("reports the origin of every write; untagged writes report none", async () => {
		await controller.setFrequency("rtl-1", 145_000_000, { origin: "rest" })
		await controller.setGain("rtl-1", 300, { origin: "scanner" })
		await controller.setPpm("rtl-1", 1)
		expect(sent).toEqual([
			{ command: "set-frequency", value: 145_000_000, origin: "rest" },
			{ command: "set-gain", value: 300, origin: "scanner" },
			{ command: "set-freq-correction", value: 1, origin: undefined },
		])
	})

	it("configure tags each command it sends", async () => {
		await controller.configure(
			"rtl-1",
			{ frequency: 144_800_000, gainMode: "manual", gain: 250 },
			{ origin: "rest" },
		)
		expect(sent.map(s => s.origin)).toEqual(["rest", "rest", "rest"])
	})

	it("reconnect replay reports origin replay", async () => {
		await controller.setFrequency("rtl-1", 145_500_000, { origin: "scanner" })
		sent.length = 0
		reconnect()
		expect(sent).toEqual([
			{ command: "set-frequency", value: 145_500_000, origin: "replay" },
		])
	})
})
