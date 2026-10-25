import { WaveKitError } from "../../../utils/errors.js"

/** REST/WS reset reason carried on cursor failures. */
export type ActivityCursorReason =
	| "invalid-cursor"
	| "cursor-expired"
	| "store-changed"
	| "query-changed"
	| "cursor-gap"
	| "snapshot-reset"

/**
 * Query-lane failure. Routes map `statusCode` themselves. The process error
 * handler also honours `statusCode` on this class, so a throw that escapes
 * the plugin keeps 409, 410, 429 and 503.
 */
export class ActivityQueryError extends WaveKitError {
	readonly statusCode: number
	readonly reason: ActivityCursorReason | undefined

	constructor(
		message: string,
		code: string,
		statusCode: number,
		reason?: ActivityCursorReason,
		cause?: Error,
	) {
		super(message, code, cause)
		this.name = new.target.name
		this.statusCode = statusCode
		if (reason !== undefined) this.reason = reason
	}
}

/** Seconds a client should wait before retrying a busy Activity read. */
export const ACTIVITY_BUSY_RETRY_AFTER_SECONDS = 1

export class ActivityQueryBusyError extends ActivityQueryError {
	/** HTTP replies send this as `Retry-After`. */
	readonly retryAfterSeconds = ACTIVITY_BUSY_RETRY_AFTER_SECONDS

	constructor(message = "Activity query admission is full") {
		super(message, "ACTIVITY_QUERY_BUSY", 429)
	}
}

/**
 * Sets `Retry-After` on an HTTP reply when the error carries a retry hint.
 * Every Activity route and the process error handler call this, so a busy
 * 429 always says when to retry.
 */
export function applyRetryAfter(
	reply: { header: (name: string, value: string) => unknown },
	error: unknown,
): void {
	if (error instanceof ActivityQueryBusyError) {
		reply.header("Retry-After", String(error.retryAfterSeconds))
	}
}

export class ActivityQueryTimeoutError extends ActivityQueryError {
	constructor(message = "Activity query exceeded the reader deadline") {
		super(message, "ACTIVITY_QUERY_TIMEOUT", 429)
	}
}

export class ActivityQueryInvalidError extends ActivityQueryError {
	constructor(message: string) {
		super(message, "ACTIVITY_QUERY_INVALID", 400)
	}
}

export class ActivityCursorInvalidError extends ActivityQueryError {
	constructor(message = "Activity cursor is invalid") {
		super(message, "ACTIVITY_CURSOR_INVALID", 400, "invalid-cursor")
	}
}

export class ActivityCursorGapError extends ActivityQueryError {
	constructor(message = "Activity cursor is behind the prune watermark") {
		super(message, "ACTIVITY_CURSOR_GAP", 410, "cursor-gap")
	}
}

export class ActivitySnapshotResetError extends ActivityQueryError {
	constructor(
		reason: Exclude<ActivityCursorReason, "invalid-cursor" | "cursor-gap">,
		message: string,
	) {
		super(message, "ACTIVITY_SNAPSHOT_RESET", 409, reason)
	}
}

export class ActivityReaderFailedError extends ActivityQueryError {
	constructor(message = "Activity reader failed") {
		super(message, "ACTIVITY_QUERY_FAILED", 500)
	}
}

export class ActivityQueryClosedError extends ActivityQueryError {
	constructor() {
		super("Activity query service is closed", "ACTIVITY_QUERY_CLOSED", 503)
	}
}

export function activityRecordCorrupt(message: string): ActivityQueryError {
	return new ActivityQueryError(message, "ACTIVITY_RECORD_CORRUPT", 500)
}
