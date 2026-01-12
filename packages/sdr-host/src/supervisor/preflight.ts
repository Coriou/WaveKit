import type { Logger } from "@wavekit/shared"
import { createComponentLogger } from "@wavekit/shared"
import { detectDongle, type DongleInfo } from "../utils/usb-dongle.js"

export interface PreflightResult {
	ready: boolean
	dongle: DongleInfo
	warnings: string[]
	errors: string[]
}

/**
 * Runs preflight checks before starting services.
 */
export async function runPreflight(logger: Logger): Promise<PreflightResult> {
	const log = createComponentLogger(logger, "Preflight")
	const warnings: string[] = []
	const errors: string[] = []

	log.info("Running preflight checks")

	// Check for dongle
	const dongle = await detectDongle(logger)

	if (!dongle.present) {
		errors.push("No RTL-SDR dongle detected. Check USB connection.")
	}

	if (dongle.driverConflict && dongle.conflictingDriver) {
		warnings.push(
			`DVB driver conflict: ${dongle.conflictingDriver} is loaded. ` +
				`Run: sudo rmmod ${dongle.conflictingDriver}`,
		)
	}

	const ready = errors.length === 0

	if (ready) {
		log.info("Preflight checks passed")
	} else {
		log.error({ errors, warnings }, "Preflight checks failed")
	}

	return {
		ready,
		dongle,
		warnings,
		errors,
	}
}
