import { safeErrorFields } from "../decoders/safe-error-fields.js"

/** Never interpolate thrown messages: they may contain credentials or full paths. */
export function formatStartupFailure(error: unknown): string {
	const fields = safeErrorFields(error)
	return `WaveKit startup failed: ${fields.type} [${fields.code ?? "UNKNOWN"}]: startup could not complete\n`
}
