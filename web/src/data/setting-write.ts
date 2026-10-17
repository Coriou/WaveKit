/**
 * The answer of every settings write (station, decoder settings, preferences, decoder actions):
 * success, or a message for the drawer plus optional per-field messages. Writes resolve with it
 * and never reject.
 */
import { ApiError, errorMessage } from "./api-client.ts"

export interface SettingWriteOk {
	ok: true
}

export interface SettingWriteError {
	ok: false
	message: string
	/** Per-field (station field, decoder option key, preference key) messages. */
	fieldErrors?: Readonly<Record<string, string>>
}

export type SettingWriteResult = SettingWriteOk | SettingWriteError

export const WRITE_OK: SettingWriteOk = Object.freeze({ ok: true })

/** A failed write, with field messages only when there are some. */
export function writeError(
	message: string,
	fieldErrors?: Readonly<Record<string, string>>,
): SettingWriteError {
	return fieldErrors && Object.keys(fieldErrors).length > 0
		? { ok: false, message, fieldErrors }
		: { ok: false, message }
}

/** The error body of an ApiError as a record (empty for anything else). */
export function errorBody(error: unknown): Readonly<Record<string, unknown>> {
	if (!(error instanceof ApiError)) return {}
	const body = error.body
	return typeof body === "object" && body !== null && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: {}
}

/** A thrown value as a failed write with no field messages. */
export function failedWrite(error: unknown): SettingWriteError {
	return writeError(errorMessage(error))
}
