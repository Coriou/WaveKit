import { exec } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "@wavekit/shared"

const execAsync = promisify(exec)
type ExecRunner = (command: string) => Promise<{ stdout: string }>
const runUsbCommand: ExecRunner = command =>
	execAsync(command, { timeout: 3000 })

export interface DongleInfo {
	present: boolean
	product: string | null
	/** The USB serial string (sysfs), when readable and plain; null otherwise. */
	serial: string | null
	/**
	 * True when `serial` is a well-known default many dongles share (`00000001`, `0`, all zeros):
	 * it names no unit. Absent while there is no serial.
	 */
	serialWeak?: boolean
	usb: {
		vid: string
		pid: string
		bus: number
		device: number
	} | null
	driverConflict: boolean
	conflictingDriver: string | null
	/**
	 * False: lsusb answered, so `present` is an observation. True: lsusb failed or timed out (a
	 * loaded host can take over the 3 s limit), so `present: false` observes nothing. Older hosts
	 * do not send it, and their `present: false` can mean either.
	 */
	probeFailed?: boolean
}

/**
 * RTL-SDR vendor/product IDs
 */
const RTL_SDR_USB_IDS = [
	{ vid: "0bda", pid: "2838" }, // RTL2838UHIDIR (most common)
	{ vid: "0bda", pid: "2832" }, // RTL2832U
]

/** USB serials shown: letters, digits, `.`, `_`, `-`, at most 32 characters; anything else: none. */
const USB_SERIAL = /^[A-Za-z0-9._-]{1,32}$/
/** Factory defaults shared by many dongles: empty, `0`, `1`, all zeros, zeros then `1` (`00000001`). */
const WEAK_SERIAL = /^0*1?$/

export function isWeakUsbSerial(serial: string): boolean {
	return WEAK_SERIAL.test(serial)
}

/** Reads sysfs; injectable for tests (never opens the USB device itself). */
export interface UsbSysfs {
	readdir(path: string): Promise<string[]>
	readFile(path: string): Promise<string>
}

const SYSFS_USB_DEVICES = "/sys/bus/usb/devices"
/** A host has a few dozen USB nodes; this bounds the scan. */
const SYSFS_MAX_ENTRIES = 256
const nodeSysfs: UsbSysfs = {
	readdir: path => readdir(path),
	readFile: path => readFile(path, "utf8"),
}

/**
 * The serial string of the USB device at `bus`/`device` from sysfs (`busnum`, `devnum` and
 * `serial` of each `/sys/bus/usb/devices` node), or null when it is not readable or not plain.
 */
export async function readUsbSerial(
	bus: number,
	device: number,
	sysfs: UsbSysfs = nodeSysfs,
	root: string = SYSFS_USB_DEVICES,
): Promise<string | null> {
	let names: string[]
	try {
		names = (await sysfs.readdir(root)).slice(0, SYSFS_MAX_ENTRIES)
	} catch {
		return null
	}
	for (const name of names) {
		// Interfaces (`1-1:1.0`) have no busnum; skip them without reading.
		if (name.includes(":")) continue
		const read = (file: string) =>
			sysfs.readFile(join(root, name, file)).then(
				text => text.trim(),
				() => null,
			)
		const busnum = await read("busnum")
		const devnum = await read("devnum")
		if (busnum === null || devnum === null) continue
		if (Number(busnum) !== bus || Number(devnum) !== device) continue
		const serial = await read("serial")
		return serial !== null && USB_SERIAL.test(serial) ? serial : null
	}
	return null
}

/**
 * Detects RTL-SDR dongle presence by parsing lsusb output; the serial comes from sysfs.
 */
export async function detectDongle(
	logger: Logger,
	execRunner: ExecRunner = runUsbCommand,
	sysfs: UsbSysfs = nodeSysfs,
): Promise<DongleInfo> {
	const log = createComponentLogger(logger, "UsbDongle")

	try {
		const { stdout } = await execRunner("lsusb")

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

				const serial = await readUsbSerial(bus, device, sysfs)

				log.info({ vid, pid, bus, device, product }, "RTL-SDR dongle detected")

				return {
					present: true,
					product,
					serial,
					...(serial !== null ? { serialWeak: isWeakUsbSerial(serial) } : {}),
					usb: { vid, pid, bus, device },
					driverConflict: driverConflict.conflict,
					conflictingDriver: driverConflict.driver,
					probeFailed: false,
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
			probeFailed: false,
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
			probeFailed: true,
		}
	}
}

/**
 * Checks if the DVB kernel driver has claimed the RTL-SDR device.
 */
export async function checkDriverConflict(
	logger: Logger,
	execRunner: ExecRunner = runUsbCommand,
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
