/**
 * WG10 lane RK2: the scanner side of a `scan:` recording delete (docs/specs/web-gaps-10,
 * requirements 1.1-1.4; design "Recording follow-ups (lane RK2)", Scanner delete). The keep
 * service calls it under the key's mutex with the key marked deleting.
 *
 * Order (binding): the evidence store unlinks the verified file first, the discovery bookkeeping
 * follows. A bookkeeping failure after the unlink leaves a dangling id that resolves to no file;
 * it is logged as a count and the answer stays `deleted` (the file is gone). The reverse order
 * could leave a file the operator deleted listed as present.
 *
 * The `discovery` `updated` event follows from the discovery store's `change` emission (the
 * scanner service turns store changes into discovery events), so no extra callback is needed.
 *
 * Logs: component logger `ScannerRecordingDelete`; fixed text and counts only, errors through
 * `safeErrorFields`; never an id, key, path or file name. Imports stay minimal.
 */
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import type { ScannerRecordingDeleter } from "../recordings/contract.js"
import { createComponentLogger } from "../../utils/logger.js"
import type { Logger } from "../../utils/logger.js"

export interface ScannerRecordingDeleterDeps {
	/** `EvidenceStore.deleteRecording`: verified unlink under the discovery's serialisation. */
	evidence: {
		deleteRecording(
			recordingId: string,
			stillDeletable: () => boolean,
		): Promise<"deleted" | "not-found">
	}
	/** `DiscoveryStore.forgetRecording`: journaled removal of the id (false: no holder). */
	discovery: { forgetRecording(recordingId: string): boolean }
	logger: Logger
}

export function createScannerRecordingDeleter(
	deps: ScannerRecordingDeleterDeps,
): ScannerRecordingDeleter {
	const log = createComponentLogger(deps.logger, "ScannerRecordingDelete")
	return {
		async deleteRecording(recordingId, stillDeletable) {
			const outcome = await deps.evidence.deleteRecording(
				recordingId,
				stillDeletable,
			)
			if (outcome !== "deleted") return outcome
			let forgotten = 0
			try {
				forgotten = deps.discovery.forgetRecording(recordingId) ? 1 : 0
			} catch (error: unknown) {
				log.warn(
					{ err: safeErrorFields(error), dangling: 1 },
					"Scanner recording deleted; its bookkeeping could not be updated",
				)
				return "deleted"
			}
			log.info({ forgotten }, "Scanner recording deleted")
			return "deleted"
		},
	}
}
