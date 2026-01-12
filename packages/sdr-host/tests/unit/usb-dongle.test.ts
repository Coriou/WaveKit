import { describe, it, expect, vi } from "vitest"
import { createLogger } from "@wavekit/shared"

const logger = createLogger({ level: "fatal" })

describe("usb-dongle", () => {
	it("detects RTL-SDR dongle and driver conflict", async () => {
		const { detectDongle } = await import("../../src/utils/usb-dongle.js")
		const execRunner = vi.fn()
		execRunner.mockResolvedValueOnce({
			stdout:
				"Bus 001 Device 004: ID 0bda:2838 Realtek Semiconductor Corp. RTL2838UHIDIR",
		})
		execRunner.mockResolvedValueOnce({ stdout: "dvb_usb_rtl28xxu 123 0" })

		const result = await detectDongle(logger, execRunner)

		expect(result.present).toBe(true)
		expect(result.usb?.vid).toBe("0bda")
		expect(result.usb?.pid).toBe("2838")
		expect(result.driverConflict).toBe(true)
		expect(result.conflictingDriver).toBe("dvb_usb_rtl28xxu")
	})

	it("returns not present when no dongle is found", async () => {
		const { detectDongle } = await import("../../src/utils/usb-dongle.js")
		const execRunner = vi.fn().mockResolvedValueOnce({
			stdout: "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub",
		})
		const result = await detectDongle(logger, execRunner)

		expect(result.present).toBe(false)
		expect(result.usb).toBeNull()
	})

	it("checkDriverConflict returns false when drivers not loaded", async () => {
		const { checkDriverConflict } =
			await import("../../src/utils/usb-dongle.js")
		const execRunner = vi.fn().mockResolvedValueOnce({
			stdout: "snd_usb_audio 456 0",
		})
		const result = await checkDriverConflict(logger, execRunner)

		expect(result.conflict).toBe(false)
		expect(result.driver).toBeNull()
	})
})
