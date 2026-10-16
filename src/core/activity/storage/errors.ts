import { WaveKitError } from "../../../utils/errors.js"

/** A write acknowledgement did not arrive. The worker may still commit. */
export class ActivityWriteTimeoutError extends WaveKitError {
	constructor() {
		super("activity write timed out", "ACTIVITY_UNAVAILABLE")
		this.name = "ActivityWriteTimeoutError"
	}
}

/** node:sqlite or FTS5 is missing, or the store cannot be opened. */
export class ActivityUnavailableError extends WaveKitError {
	constructor(message: string, cause?: Error) {
		super(message, "ACTIVITY_UNAVAILABLE", cause)
		this.name = "ActivityUnavailableError"
	}
}

/** Another live process, or another opener in this process, holds the store. */
export class ActivityStoreLockedError extends WaveKitError {
	constructor(public readonly lockPath: string) {
		super(`Activity store is locked: ${lockPath}`, "ACTIVITY_STORE_LOCKED")
		this.name = "ActivityStoreLockedError"
	}
}

/**
 * The on-disk schema is not batch-1 schema v1. Batch 1 does not migrate.
 * `found` is the stored schemaVersion, or "missing" when the file is not ours.
 */
export class ActivitySchemaMismatchError extends WaveKitError {
	constructor(public readonly found: string) {
		super(
			`Activity store schema version ${found} does not match 1`,
			"ACTIVITY_SCHEMA_MISMATCH",
		)
		this.name = "ActivitySchemaMismatchError"
	}
}

export function errnoCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error))
		return undefined
	return typeof error.code === "string" ? error.code : undefined
}
