import { WaveKitError } from "../utils/errors.js"
import { PrivateAccessStorage } from "./private-storage.js"
import type { PrivateAccessStorageOptions } from "./private-storage.js"

export interface LocalAccessSetupStatus {
	kind: "ready" | "unavailable"
	code: string
	nextStep:
		| "start-core-and-pair-browser"
		| "stop-core-and-retry"
		| "repair-private-state-offline"
}

/**
 * Future guided local command, run while the core is stopped. It selects no
 * default directory or rollout mode, prints nothing, and returns no credential.
 * After provisioning, start the core and use an authenticated allowed-target
 * request for a short-lived pairing code; the running owner's files stay locked.
 * Incomplete/corrupt/foreign ownership needs explicit offline repair, not reset.
 */
export async function setupLocalAccess(
	options: Omit<PrivateAccessStorageOptions, "mode">,
): Promise<LocalAccessSetupStatus> {
	try {
		const storage = await PrivateAccessStorage.open({
			...options,
			mode: "provision",
		})
		const code = storage.created ? "ACCESS_SETUP_CREATED" : "ACCESS_SETUP_READY"
		await storage.close()
		return { kind: "ready", code, nextStep: "start-core-and-pair-browser" }
	} catch (error) {
		const code =
			error instanceof WaveKitError ? error.code : "ACCESS_STORAGE_UNAVAILABLE"
		return {
			kind: "unavailable",
			code,
			nextStep:
				code === "ACCESS_STORAGE_BUSY"
					? "stop-core-and-retry"
					: "repair-private-state-offline",
		}
	}
}
