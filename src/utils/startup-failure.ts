import { safeErrorFields } from "../decoders/safe-error-fields.js"
import {
	CHANNEL_INPUT_ENV,
	unknownChannelInputModeError,
} from "../decoders/channel-input-mode.js"
import { ConfigValidationError } from "./errors.js"

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

/** An own data property, never a getter or a proxy trap's result. */
function ownValue(target: unknown, key: string): unknown {
	if (typeof target !== "object" || target === null) return undefined
	const descriptor = Object.getOwnPropertyDescriptor(target, key)
	return descriptor && "value" in descriptor ? descriptor.value : undefined
}

/**
 * Config issues a startup failure may name, by the variable they are about: the issue line is rebuilt from the
 * core's own constants (the variable name and the accepted values), never from the error's text, and only for an
 * issue equal to the one the core raises for it.
 */
const TRUSTED_ISSUES: ReadonlyMap<string, string> = new Map(
	unknownChannelInputModeError()
		.zodError.issues.filter(
			issue => issue.code === "custom" && issue.path[0] === CHANNEL_INPUT_ENV,
		)
		.map(issue => [CHANNEL_INPUT_ENV, issue.message] as const),
)

/** The trusted issue lines of a ConfigValidationError (at most one per known variable); none otherwise. */
function trustedIssueLines(error: unknown): string[] {
	try {
		if (!(error instanceof ConfigValidationError)) return []
		const issues = ownValue(ownValue(error, "zodError"), "issues")
		if (!Array.isArray(issues)) return []
		const lines = new Set<string>()
		for (const issue of issues.slice(0, 16)) {
			const path = ownValue(issue, "path")
			const variable =
				Array.isArray(path) && path.length === 1
					? ownValue(path, "0")
					: undefined
			const message =
				typeof variable === "string" ? TRUSTED_ISSUES.get(variable) : undefined
			if (
				message !== undefined &&
				ownValue(issue, "code") === "custom" &&
				ownValue(issue, "message") === message
			)
				lines.add(`  - ${String(variable)}: ${message}`)
		}
		return [...lines]
	} catch {
		return []
	}
}

/**
 * Never interpolate thrown messages: they may contain credentials or full paths. A ConfigValidationError the core
 * raises for a known variable (an unknown WAVEKIT_CHANNEL_INPUT) adds one line naming the variable and the accepted
 * values, never the value given.
 */
export function formatStartupFailure(error: unknown): string {
	const fields = safeErrorFields(error)
	const reason = safeReason(error)
	const issues = trustedIssueLines(error)
	return `WaveKit startup failed: ${fields.type} [${fields.code ?? "UNKNOWN"}${reason ? `/${reason}` : ""}]: startup could not complete\n${issues.map(line => `${line}\n`).join("")}`
}
