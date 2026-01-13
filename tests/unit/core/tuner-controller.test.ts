/**
 * Tuner Controller Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import {
	TunerController,
	TunerControlModeError,
	TunerValidationError,
} from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"

const testLogger = createLogger({ level: "fatal" })

function createMockSourceManager() {
	return {
		writeToSource: vi.fn<(id: string, payload: Buffer) => boolean>(),
		isRtlTcpSource: vi.fn<(id: string) => boolean>().mockReturnValue(true),
		updateSourceCaps:
			vi.fn<
				(id: string, updates: Partial<SourceCaps>) => SourceCaps | undefined
			>(),
	}
}

type MockSourceManager = ReturnType<typeof createMockSourceManager>

function makeCaps(overrides: Partial<SourceCaps> = {}): SourceCaps {
	return {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
		...overrides,
	}
}

function expectCommand(
	calls: Array<unknown[]>,
	index: number,
	cmd: number,
	value: number,
): void {
	const buffer = calls[index]?.[1] as Buffer | undefined
	expect(buffer).toBeInstanceOf(Buffer)
	if (!buffer) return
	expect(buffer.readUInt8(0)).toBe(cmd)
	expect(buffer.readUInt32BE(1)).toBe(value >>> 0)
}

describe("TunerController", () => {
	let sourceManager: MockSourceManager
	let controller: TunerController

	beforeEach(() => {
		sourceManager = createMockSourceManager()
		controller = new TunerController(
			testLogger,
			sourceManager as unknown as SourceManager,
		)
	})

	it("initializes source with caps defaults", () => {
		controller.initializeSource(
			"rtl-1",
			makeCaps({ centerFreq: 144_800_000, sampleRate: 2_400_000 }),
		)
		const state = controller.getState("rtl-1")
		expect(state?.frequency).toBe(144_800_000)
		expect(state?.sampleRate).toBe(2_400_000)
		expect(state?.controlMode).toBe("internal")
	})

	it("does not reinitialize existing state", async () => {
		controller.initializeSource(
			"rtl-1",
			makeCaps({ centerFreq: 100_000_000, sampleRate: 2_000_000 }),
		)
		await controller.setFrequency("rtl-1", 145_000_000)
		controller.initializeSource(
			"rtl-1",
			makeCaps({ centerFreq: 433_920_000, sampleRate: 1_000_000 }),
		)
		const state = controller.getState("rtl-1")
		expect(state?.frequency).toBe(145_000_000)
	})

	it("encodes RTL-TCP commands correctly", async () => {
		controller.initializeSource("rtl-1", makeCaps())

		await controller.setFrequency("rtl-1", 144_800_000)
		await controller.setSampleRate("rtl-1", 2_400_000)
		expect(sourceManager.updateSourceCaps).toHaveBeenCalledWith("rtl-1", {
			sampleRate: 2_400_000,
		})
		await controller.setGainMode("rtl-1", "manual")
		await controller.setGain("rtl-1", 400)
		await controller.setPpm("rtl-1", 10)
		await controller.setIfGain("rtl-1", 12)
		await controller.setTestMode("rtl-1", true)
		await controller.setAgcMode("rtl-1", false)
		await controller.setDirectSampling("rtl-1", "i")
		await controller.setOffsetTuning("rtl-1", true)
		await controller.setRtlXtal("rtl-1", 28_800_000)
		await controller.setTunerXtal("rtl-1", 28_800_000)
		await controller.setTunerGainIndex("rtl-1", 3)
		await controller.setBiasTee("rtl-1", true)
		await controller.setTunerIfGain("rtl-1", 2, 30)

		const calls = sourceManager.writeToSource.mock.calls
		expect(calls).toHaveLength(15)
		expectCommand(calls, 0, 0x01, 144_800_000)
		expectCommand(calls, 1, 0x02, 2_400_000)
		expectCommand(calls, 2, 0x03, 1)
		expectCommand(calls, 3, 0x04, 400)
		expectCommand(calls, 4, 0x05, 10)
		expectCommand(calls, 5, 0x06, 12)
		expectCommand(calls, 6, 0x07, 1)
		expectCommand(calls, 7, 0x08, 0)
		expectCommand(calls, 8, 0x09, 1)
		expectCommand(calls, 9, 0x0a, 1)
		expectCommand(calls, 10, 0x0b, 28_800_000)
		expectCommand(calls, 11, 0x0c, 28_800_000)
		expectCommand(calls, 12, 0x0d, 3)
		expectCommand(calls, 13, 0x0e, 1)
		expectCommand(calls, 14, 0x0f, (2 << 16) | 30)
	})

	it("encodes negative PPM values as unsigned", async () => {
		controller.initializeSource("rtl-1", makeCaps())
		await controller.setPpm("rtl-1", -1)
		const calls = sourceManager.writeToSource.mock.calls
		expectCommand(calls, 0, 0x05, 0xffffffff)
	})

	it("rejects out-of-range values", async () => {
		controller.initializeSource("rtl-1", makeCaps())
		await expect(controller.setFrequency("rtl-1", 1_000_000)).rejects.toThrow(
			TunerValidationError,
		)
		await expect(controller.setSampleRate("rtl-1", 10_000_000)).rejects.toThrow(
			TunerValidationError,
		)
		await expect(controller.setGain("rtl-1", -1)).rejects.toThrow(
			TunerValidationError,
		)
		await expect(controller.setPpm("rtl-1", 1000)).rejects.toThrow(
			TunerValidationError,
		)
	})

	it("blocks commands when control mode is external", async () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.setControlMode("rtl-1", "external")
		await expect(controller.setFrequency("rtl-1", 144_800_000)).rejects.toThrow(
			TunerControlModeError,
		)
		expect(sourceManager.writeToSource).not.toHaveBeenCalled()
	})

	it("syncs control mode with relay activity", () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.syncExternalControl("rtl-1", true)
		expect(controller.getState("rtl-1")?.controlMode).toBe("external")
		controller.syncExternalControl("rtl-1", false)
		expect(controller.getState("rtl-1")?.controlMode).toBe("internal")
	})

	it("preserves user-selected external mode when relay disconnects", () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.setControlMode("rtl-1", "external")
		controller.syncExternalControl("rtl-1", false)
		expect(controller.getState("rtl-1")?.controlMode).toBe("external")
	})

	it("applies relay commands to tuner state", () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.applyExternalCommand("rtl-1", 0x01, 145_000_000)
		const state = controller.getState("rtl-1")
		expect(state?.frequency).toBe(145_000_000)
		expect(state?.controlMode).toBe("external")
		expect(state?.commandCount).toBe(1)
		expect(state?.lastCommandAt).toBeTruthy()
	})

	it("decodes relay PPM commands", () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.applyExternalCommand("rtl-1", 0x05, 0xffffffff)
		const state = controller.getState("rtl-1")
		expect(state?.ppm).toBe(-1)
	})

	it("marks manual gain mode for relay gain commands", () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.applyExternalCommand("rtl-1", 0x04, 250)
		let state = controller.getState("rtl-1")
		expect(state?.gainMode).toBe("manual")
		controller.applyExternalCommand("rtl-1", 0x0d, 7)
		state = controller.getState("rtl-1")
		expect(state?.gainMode).toBe("manual")
	})

	it("captures write failures and emits error", async () => {
		controller.initializeSource("rtl-1", makeCaps())
		sourceManager.writeToSource.mockImplementation(() => {
			throw new Error("not connected")
		})

		const errors: Error[] = []
		controller.on("error", (_sourceId, error) => {
			errors.push(error)
		})

		await expect(controller.setFrequency("rtl-1", 144_800_000)).rejects.toThrow(
			"not connected",
		)

		const state = controller.getState("rtl-1")
		expect(state?.lastError).toBe("not connected")
		expect(errors).toHaveLength(1)
	})

	it("configure enforces control mode for command updates", async () => {
		controller.initializeSource("rtl-1", makeCaps())
		controller.setControlMode("rtl-1", "external")
		await expect(
			controller.configure("rtl-1", { frequency: 145_000_000 }),
		).rejects.toThrow(TunerControlModeError)
	})
})
