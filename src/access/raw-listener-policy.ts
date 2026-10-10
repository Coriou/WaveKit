import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"

const listenerSchema = z
	.object({ enabled: z.boolean(), host: z.string().min(1).max(300).optional() })
	.strict()
const exceptionSchema = z
	.object({ host: z.enum(["127.0.0.1", "::1"]) })
	.strict()
const settingsSchema = z
	.object({
		mode: z.enum(["legacy", "protected"]),
		audio: listenerSchema,
		relay: listenerSchema,
		exceptions: z
			.object({
				audio: exceptionSchema.optional(),
				relay: exceptionSchema.optional(),
			})
			.strict()
			.optional(),
	})
	.strict()

export interface LegacyRawListener {
	readonly kind: "legacy"
	readonly enabled: boolean
	readonly host?: string
}

export interface DisabledRawListener {
	readonly kind: "disabled"
}

export interface PendingRawListener {
	readonly kind: "needs-verification"
	readonly host: "127.0.0.1" | "::1"
	readonly protocol: "unauthenticated"
}

export type RawListenerDecision =
	| LegacyRawListener
	| DisabledRawListener
	| PendingRawListener

export interface RawListenerDecisions {
	readonly audio: RawListenerDecision
	readonly relay: RawListenerDecision
}

/** No protected result enables a socket. Deployment verification is a later gate. */
export function decideRawListeners(input: unknown): RawListenerDecisions {
	const parsed = settingsSchema.safeParse(input)
	if (!parsed.success)
		throw new WaveKitError(
			"Invalid raw listener policy",
			"ACCESS_CONFIG_INVALID",
		)
	const settings = parsed.data
	function decide(kind: "audio" | "relay"): RawListenerDecision {
		const listener = settings[kind]
		if (settings.mode === "legacy")
			return Object.freeze({
				kind: "legacy",
				enabled: listener.enabled,
				...(listener.host !== undefined ? { host: listener.host } : {}),
			})
		const exception = settings.exceptions?.[kind]
		if (!listener.enabled || !exception)
			return Object.freeze({ kind: "disabled" })
		return Object.freeze({
			kind: "needs-verification",
			host: exception.host,
			protocol: "unauthenticated",
		})
	}
	return Object.freeze({ audio: decide("audio"), relay: decide("relay") })
}
