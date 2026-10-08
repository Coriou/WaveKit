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

/** Refresh the shared status snapshot after USB insertions and removals. */
export function startPreflightMonitoring(
	result: PreflightResult,
	logger: Logger,
	options: {
		intervalMs?: number
		refresh?: () => Promise<PreflightResult>
		onDeviceChange?: () => Promise<void>
	} = {},
): () => Promise<void> {
	// Startup diagnostics are already logged. During polling, log state changes.
	const pollLogger = logger.child({}, { level: "silent" })
	const refresh = options.refresh ?? (() => runPreflight(pollLogger))
	const identity = (dongle: DongleInfo): string =>
		JSON.stringify([dongle.present, dongle.usb, dongle.serial])
	let handledIdentity = identity(result.dongle)
	let stopped = false
	let pending: Promise<void> | null = null
	const timer = setInterval(() => {
		// USB commands can take longer than the poll interval. Keep one in flight.
		if (pending || stopped) return
		pending = Promise.resolve()
			.then(refresh)
			.then(async updated => {
				if (stopped) return
				const changed = JSON.stringify(result) !== JSON.stringify(updated)
				Object.assign(result, updated)
				const currentIdentity = identity(updated.dongle)
				if (currentIdentity !== handledIdentity) {
					await options.onDeviceChange?.()
					// A failed restart is retried on the next poll, without overlap.
					handledIdentity = currentIdentity
				}
				if (changed) {
					logger.info(
						{ dongle: updated.dongle, ready: updated.ready },
						"USB status changed",
					)
				}
			})
			.catch(error => {
				logger.warn({ error }, "Failed to refresh USB status")
			})
			.finally(() => {
				pending = null
			})
	}, options.intervalMs ?? 5000)
	timer.unref()
	return async () => {
		stopped = true
		clearInterval(timer)
		await pending
	}
}
