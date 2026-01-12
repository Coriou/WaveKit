import { describe, it, expect, vi, beforeEach } from "vitest"
import { createLogger } from "@wavekit/shared"

const detectDongleMock = vi.fn()

vi.mock("../../src/utils/usb-dongle.js", () => ({
	detectDongle: detectDongleMock,
}))

const logger = createLogger({ level: "fatal" })

describe("runPreflight", () => {
	beforeEach(() => {
		detectDongleMock.mockReset()
	})
	it("marks readiness false when no dongle is detected", async () => {
		detectDongleMock.mockResolvedValueOnce({
			present: false,
			product: null,
			serial: null,
			usb: null,
			driverConflict: false,
			conflictingDriver: null,
		})

		const { runPreflight } = await import("../../src/supervisor/preflight.js")
		const result = await runPreflight(logger)

		expect(result.ready).toBe(false)
		expect(result.errors.length).toBe(1)
		expect(result.warnings.length).toBe(0)
	})

	it("adds warning when driver conflict detected", async () => {
		detectDongleMock.mockResolvedValueOnce({
			present: true,
			product: "RTL2838UHIDIR",
			serial: null,
			usb: { vid: "0bda", pid: "2838", bus: 1, device: 4 },
			driverConflict: true,
			conflictingDriver: "dvb_usb_rtl28xxu",
		})

		const { runPreflight } = await import("../../src/supervisor/preflight.js")
		const result = await runPreflight(logger)

		expect(result.ready).toBe(true)
		expect(result.warnings.length).toBe(1)
	})
})
