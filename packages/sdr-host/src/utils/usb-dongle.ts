import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "@wavekit/shared"

const execAsync = promisify(exec)
type ExecRunner = (command: string) => Promise<{ stdout: string }>

export interface DongleInfo {
	present: boolean
	product: string | null
	serial: string | null
	usb: {
		vid: string
		pid: string
		bus: number
		device: number
	} | null
	driverConflict: boolean
	conflictingDriver: string | null
}

/**
 * RTL-SDR vendor/product IDs
 */
const RTL_SDR_USB_IDS = [
	{ vid: "0bda", pid: "2838" }, // RTL2838UHIDIR (most common)
	{ vid: "0bda", pid: "2832" }, // RTL2832U
]

/**
 * Detects RTL-SDR dongle presence by parsing lsusb output.
 */
export async function detectDongle(
	logger: Logger,
	execRunner: ExecRunner = execAsync,
): Promise<DongleInfo> {
	const log = createComponentLogger(logger, "UsbDongle")

	try {
		const { stdout } = await execRunner("lsusb -v 2>/dev/null || lsusb")

		for (const { vid, pid } of RTL_SDR_USB_IDS) {
			// Match format: Bus 001 Device 004: ID 0bda:2838
			const pattern = new RegExp(
				`Bus\\s+(\\d+)\\s+Device\\s+(\\d+):\\s+ID\\s+${vid}:${pid}(?:\\s+(.+))?`,
				"i",
			)
			const match = stdout.match(pattern)

			if (match) {
				const bus = parseInt(match[1] ?? "0", 10)
				const device = parseInt(match[2] ?? "0", 10)
				const product = match[3]?.trim() ?? null

				// Check for driver conflict
				const driverConflict = await checkDriverConflict(logger, execRunner)

				log.info({ vid, pid, bus, device, product }, "RTL-SDR dongle detected")

				return {
					present: true,
					product,
					serial: null, // Would need rtl_test to get serial
					usb: { vid, pid, bus, device },
					driverConflict: driverConflict.conflict,
					conflictingDriver: driverConflict.driver,
				}
			}
		}

		log.warn("No RTL-SDR dongle detected")
		return {
			present: false,
			product: null,
			serial: null,
			usb: null,
			driverConflict: false,
			conflictingDriver: null,
		}
	} catch (error) {
		log.error({ error }, "Failed to detect dongle")
		return {
			present: false,
			product: null,
			serial: null,
			usb: null,
			driverConflict: false,
			conflictingDriver: null,
		}
	}
}

/**
 * Checks if the DVB kernel driver has claimed the RTL-SDR device.
 */
export async function checkDriverConflict(
	logger: Logger,
	execRunner: ExecRunner = execAsync,
): Promise<{ conflict: boolean; driver: string | null }> {
	const log = createComponentLogger(logger, "UsbDongle")

	try {
		const { stdout } = await execRunner("lsmod 2>/dev/null")

		const conflictingDrivers = [
			"dvb_usb_rtl28xxu",
			"rtl2832",
			"rtl2830",
			"dvb_usb_v2",
		]

		for (const driver of conflictingDrivers) {
			if (stdout.includes(driver)) {
				log.warn({ driver }, "Conflicting kernel driver detected")
				return { conflict: true, driver }
			}
		}

		return { conflict: false, driver: null }
	} catch {
		// lsmod not available or failed, assume no conflict
		return { conflict: false, driver: null }
	}
}
