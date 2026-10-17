/**
 * WG9 req 2.5, 2.7 (Main wiring): the recording inventory needs the deletion decision and the
 * keep service needs the inventory, so startup builds the inventory with a protection port that
 * reads the keep service late. Until the service is bound, and whenever it throws, every answer
 * is "protected" (fail closed by meaning), so nothing listed or pruned can lose a kept file.
 * Pure: imports only the contract types, so the startup bundle stays free of runtime modules.
 */
import type { RecordingProtection } from "./contract.js"

/** A protection port that forwards to `current()` and answers protected while it is unset. */
export function lateBoundRecordingProtection(
	current: () => RecordingProtection | undefined,
): RecordingProtection {
	const ask = (decide: (port: RecordingProtection) => boolean): boolean => {
		const port = current()
		if (port === undefined) return true
		try {
			return decide(port) !== false
		} catch {
			return true
		}
	}
	return {
		isProtected: key => ask(p => p.isProtected(key)),
		isDsdFmeFileProtected: basename =>
			ask(p => p.isDsdFmeFileProtected(basename)),
		isScannerFileProtected: (discoveryId, basename) =>
			ask(p => p.isScannerFileProtected(discoveryId, basename)),
		discoveryHoldsKept: discoveryId =>
			ask(p => p.discoveryHoldsKept(discoveryId)),
	}
}
