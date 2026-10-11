import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"

const environmentSchema = z.record(z.string().optional())

/** Remove the reserved access namespace from every decoder/DSP child environment. */
export function childAccessEnvironment(
	input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const parsed = environmentSchema.safeParse(input)
	if (!parsed.success)
		throw new WaveKitError("Invalid child environment", "ACCESS_CONFIG_INVALID")
	return Object.fromEntries(
		Object.entries(parsed.data).filter(
			([name]) => !/^WAVEKIT_ACCESS(?:_|$)/i.test(name),
		),
	)
}

const safeCodes = {
	ACCESS_CONFIG_INVALID: "configuration",
	ACCESS_COOKIE_INVALID: "configuration",
	AUTH_REQUIRED: "authentication",
	CSRF_REQUIRED: "authentication",
	ORIGIN_FORBIDDEN: "authentication",
	HOST_FORBIDDEN: "authentication",
	MACHINE_REQUIRED: "authentication",
	SESSION_REQUIRED: "authentication",
	PAIRING_INVALID: "authentication",
	MALFORMED_REQUEST: "request",
	PREFLIGHT_FORBIDDEN: "request",
	PAIRING_RATE_LIMITED: "capacity",
	PAIRING_CAPACITY: "capacity",
	SESSION_CAPACITY: "capacity",
	ACCESS_CAPACITY: "capacity",
	ACCESS_STORAGE_INVALID: "storage",
	ACCESS_STORAGE_UNSAFE: "storage",
	ACCESS_STORAGE_INCOMPLETE: "storage",
	ACCESS_STORAGE_MISSING: "storage",
	ACCESS_STORAGE_BUSY: "storage",
	ACCESS_STORAGE_FOREIGN_OWNER: "storage",
	ACCESS_STORAGE_OWNERSHIP_UNVERIFIED: "storage",
	ACCESS_STORAGE_SCOPE_UNSUPPORTED: "storage",
	ACCESS_STORAGE_ROTATION_FAILED: "storage",
	ACCESS_STORAGE_UNAVAILABLE: "unavailable",
	ACCESS_UNAVAILABLE: "unavailable",
} as const

type SafeAccessCode = keyof typeof safeCodes

export interface AccessLogMetadata {
	readonly code: SafeAccessCode
	readonly category: (typeof safeCodes)[SafeAccessCode]
}

/** Intentionally discards message, cause, stack, paths, credentials and headers. */
export function accessLogMetadata(error: unknown): AccessLogMetadata {
	let code: SafeAccessCode = "ACCESS_UNAVAILABLE"
	try {
		const parsed = z.object({ code: z.string().max(64) }).safeParse(error)
		if (parsed.success && Object.hasOwn(safeCodes, parsed.data.code))
			code = parsed.data.code as SafeAccessCode
	} catch {
		/* Even an accessor on an untrusted error cannot escape the safe projection. */
	}
	return Object.freeze({ code, category: safeCodes[code] })
}

const routeTemplateSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^\/[A-Za-z0-9_/:.*-]*$/)

/** Pass a trusted registered route template ONLY; never request.url or its path. */
export function accessRequestLogLabel(registeredTemplate?: unknown): string {
	const parsed = routeTemplateSchema.safeParse(registeredTemplate)
	return parsed.success ? parsed.data : "[unmatched route]"
}
