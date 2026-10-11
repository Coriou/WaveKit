import { z } from "zod"

export const ACCESS_BOOTSTRAP_LIMITS = Object.freeze({
	originCharacters: 320,
	webSocketCharacters: 323,
	bodyBytes: 4096,
})

/** Browser-neutral check of an already canonical, concrete HTTP(S) origin. */
function canonicalOrigin(value: string): boolean {
	if (value.length > ACCESS_BOOTSTRAP_LIMITS.originCharacters) return false
	try {
		const url = new URL(value)
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.origin !== value ||
			url.username !== "" || url.password !== "" ||
			url.hostname === "0.0.0.0" || url.hostname === "[::]" ||
			(url.port !== "" && Number(url.port) < 1)
		) return false
		if (url.hostname.startsWith("[")) return true
		return url.hostname.length <= 253 && url.hostname.split(".").every(
			label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
		)
	} catch {
		return false
	}
}

const originSchema = z.string().min(1)
	.max(ACCESS_BOOTSTRAP_LIMITS.originCharacters)
	.refine(canonicalOrigin, "Invalid canonical origin")

export const accessBootstrapDtoSchema = z.object({
	version: z.literal(1),
	apiOrigin: originSchema,
	webSocketUrl: z.string().min(1).max(ACCESS_BOOTSTRAP_LIMITS.webSocketCharacters),
	analogAudioOrigin: originSchema,
	digitalAudioOrigin: originSchema,
	access: z.object({
		mode: z.literal("protected"),
		sessionAvailable: z.boolean(),
		pairingAvailable: z.boolean(),
	}).strict(),
	capabilities: z.object({
		analogAudioAvailable: z.boolean(),
		digitalAudioAvailable: z.boolean(),
		operatorDataAvailable: z.boolean(),
	}).strict(),
}).strict().superRefine((value, ctx) => {
	// Field issues already reject oversized strings; do not allocate their encoding.
	if (
		value.apiOrigin.length > ACCESS_BOOTSTRAP_LIMITS.originCharacters ||
		value.analogAudioOrigin.length > ACCESS_BOOTSTRAP_LIMITS.originCharacters ||
		value.digitalAudioOrigin.length > ACCESS_BOOTSTRAP_LIMITS.originCharacters ||
		value.webSocketUrl.length > ACCESS_BOOTSTRAP_LIMITS.webSocketCharacters
	) return
	if (value.webSocketUrl !== `${value.apiOrigin.replace(/^http/, "ws")}/ws`)
		ctx.addIssue({ code: "custom", path: ["webSocketUrl"], message: "Invalid API WebSocket URL" })
	if (value.access.pairingAvailable && !value.access.sessionAvailable)
		ctx.addIssue({ code: "custom", path: ["access"], message: "Pairing requires session availability" })
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ACCESS_BOOTSTRAP_LIMITS.bodyBytes)
		ctx.addIssue({ code: "custom", message: "Bootstrap byte limit exceeded" })
})

export type AccessBootstrapDto = z.infer<typeof accessBootstrapDtoSchema>
