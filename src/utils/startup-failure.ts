import { safeErrorFields } from "../decoders/safe-error-fields.js"

const SAFE_REASONS = new Set([
	"lock-held",
	"invalid",
	"oversized",
	"permissions",
	"io",
])

function safeReason(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "reason")
		const value: unknown =
			descriptor && "value" in descriptor ? descriptor.value : undefined
		return typeof value === "string" && SAFE_REASONS.has(value)
			? value
			: undefined
	} catch {
		return undefined
	}
}

/** Never interpolate thrown messages: they may contain credentials or full paths. */
export function formatStartupFailure(error: unknown): string {
	const fields = safeErrorFields(error)
	const reason = safeReason(error)
	return `WaveKit startup failed: ${fields.type} [${fields.code ?? "UNKNOWN"}${reason ? `/${reason}` : ""}]: startup could not complete\n`
}
