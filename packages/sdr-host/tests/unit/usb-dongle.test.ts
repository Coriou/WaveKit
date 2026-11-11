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
		expect(result.probeFailed).toBe(false)
	})

	it("reports a failed lsusb apart from an observed absence", async () => {
		const { detectDongle } = await import("../../src/utils/usb-dongle.js")
		const execRunner = vi.fn().mockRejectedValueOnce(new Error("timed out"))

		const result = await detectDongle(logger, execRunner)

		expect(result.probeFailed).toBe(true)
		expect(result.present).toBe(false)
		expect(result.usb).toBeNull()
	})

	it("returns not present when no dongle is found", async () => {
		const { detectDongle } = await import("../../src/utils/usb-dongle.js")
		const execRunner = vi.fn().mockResolvedValueOnce({
			stdout: "Bus 001 Device 001: ID 1d6b:0002 Linux Foundation 2.0 root hub",
		})
		const result = await detectDongle(logger, execRunner)

		expect(result.present).toBe(false)
		expect(result.usb).toBeNull()
		expect(result.probeFailed).toBe(false)
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

	describe("USB serial from sysfs", () => {
		const sysfsOf = (nodes: Record<string, Record<string, string>>) => ({
			readdir: async () => Object.keys(nodes),
			readFile: async (path: string) => {
				const parts = path.split("/")
				const file = parts.pop()!
				const node = parts.pop()!
				const value = nodes[node]?.[file]
				if (value === undefined) throw new Error("ENOENT")
				return value
			},
		})
		const lsusb = () =>
			vi
				.fn()
				.mockResolvedValueOnce({
					stdout: "Bus 001 Device 004: ID 0bda:2838 Realtek RTL2838UHIDIR",
				})
				.mockResolvedValueOnce({ stdout: "" })

		it("reports the serial of the matching bus/device node", async () => {
			const { detectDongle } = await import("../../src/utils/usb-dongle.js")
			const sysfs = sysfsOf({
				usb1: { busnum: "1\n", devnum: "1\n" },
				"1-1": { busnum: "1\n", devnum: "4\n", serial: "SDR4711\n" },
				"1-1:1.0": { busnum: "1\n", devnum: "4\n", serial: "WRONG" },
			})
			const result = await detectDongle(logger, lsusb(), sysfs)
			expect(result.serial).toBe("SDR4711")
			expect(result.serialWeak).toBe(false)
		})

		it.each(["00000001", "0", "00000000", "1"])(
			"marks the default serial %s weak",
			async serial => {
				const { detectDongle } = await import("../../src/utils/usb-dongle.js")
				const sysfs = sysfsOf({
					"1-1": { busnum: "1", devnum: "4", serial },
				})
				const result = await detectDongle(logger, lsusb(), sysfs)
				expect(result.serial).toBe(serial)
				expect(result.serialWeak).toBe(true)
			},
		)

		it("reports no serial when unreadable, absent or not plain", async () => {
			const { detectDongle } = await import("../../src/utils/usb-dongle.js")
			for (const nodes of [
				{ "1-1": { busnum: "1", devnum: "4" } },
				{ "1-1": { busnum: "1", devnum: "4", serial: "has space" } },
				{ "1-1": { busnum: "1", devnum: "4", serial: "x".repeat(33) } },
				{ "1-1": { busnum: "2", devnum: "4", serial: "OTHERBUS" } },
			]) {
				const result = await detectDongle(logger, lsusb(), sysfsOf(nodes))
				expect(result.serial).toBeNull()
				expect(result.serialWeak).toBeUndefined()
			}
			const failing = {
				readdir: () => Promise.reject(new Error("no sysfs")),
				readFile: () => Promise.reject(new Error("no sysfs")),
			}
			const result = await detectDongle(logger, lsusb(), failing)
			expect(result.present).toBe(true)
			expect(result.serial).toBeNull()
		})
	})
})
