import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Logger } from "@wavekit/shared"

const execute = promisify(execFile)

/** Drop stale libusb handles; s6 starts a fresh receiver on the current device. */
export async function restartUsbReceiver(logger: Logger): Promise<void> {
	// rtl_tcp can survive device removal while endlessly retrying the dead USB
	// handle, including after SIGTERM. Kill only this supervised service; s6
	// reopens the device and rtlmux reconnects without losing downstream clients.
	await execute("/command/s6-svc", ["-k", "/run/service/rtl-tcp"], {
		timeout: 5000,
		maxBuffer: 65536,
	})
	logger.info("Restarted supervised rtl_tcp after USB device change")
}
