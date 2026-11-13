import type { TunerController } from "../../src/core/tuner-controller.js"
import type { TuningLedger } from "../../src/core/tuning-ledger.js"

/**
 * Whether the tuning ledger the controller reads (the source manager's, or its stand-in for a
 * test double) holds a frame of both frequency and sample rate on the live session that no doubt
 * has undone: proven, settling or waiting to leave, whoever wrote it.
 */
export function tuningHeldOnConnection(
	controller: TunerController,
	sourceId: string,
): boolean {
	if (controller.getState(sourceId) === undefined) return false
	const ledger = (controller as unknown as { ledger(): TuningLedger }).ledger()
	const fields = ledger.fieldState(sourceId)
	return (["sampleRate", "frequency"] as const).every(field => {
		const fs = fields[field]
		return fs.queued !== null || fs.state !== "unverified"
	})
}
