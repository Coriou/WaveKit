import { z } from "zod"
import { normalizeAuthority, normalizeOrigin } from "./authority.js"
import { resolveAccessBootstrap } from "./bootstrap-policy.js"
import type { ProtectedAccessBootstrap } from "./bootstrap-policy.js"
import { WaveKitError } from "../utils/errors.js"

const authorities = z.array(z.string().min(1).max(300)).min(1).max(64)
const audioBoundary = z
	.object({
		allowedAuthorities: authorities,
		bindHost: z.enum(["127.0.0.1", "::1"]),
	})
	.strict()

/** Public deployment facts only. Private state is supplied separately at startup. */
export const AccessRuntimeConfigSchema = z
	.discriminatedUnion("mode", [
		z.object({ mode: z.literal("legacy") }).strict(),
		z
			.object({
				mode: z.literal("protected"),
				listenerScheme: z.enum(["http", "https"]),
				exposure: z.enum(["local-http", "tls-termination"]),
				allowedAuthorities: authorities,
				allowedOrigins: z.array(z.string().min(1).max(320)).min(1).max(64),
				audio: z
					.object({ analog: audioBoundary, digital: audioBoundary })
					.strict(),
				publicOrigins: z
					.object({
						api: z.string().min(1).max(320),
						analogAudio: z.string().min(1).max(320),
						digitalAudio: z.string().min(1).max(320),
					})
					.strict(),
				healthProbe: z
					.object({
						target: z.string().min(1).max(320),
						host: z.string().min(1).max(300),
					})
					.strict(),
			})
			.strict(),
	])
	.default({ mode: "legacy" })

export type RuntimeAccessConfig = z.infer<typeof AccessRuntimeConfigSchema>
export type ProtectedRuntimeAccessConfig = Extract<
	RuntimeAccessConfig,
	{ mode: "protected" }
>

function invalid(): never {
	throw new WaveKitError(
		"Invalid access configuration",
		"ACCESS_CONFIG_INVALID",
	)
}

function canonicalOrigin(value: string): URL {
	const origin = normalizeOrigin(value)
	if (!origin || origin !== value) return invalid()
	return new URL(origin)
}

function authority(origin: URL, scheme: "http" | "https"): string {
	return normalizeAuthority(origin.host, scheme) ?? invalid()
}

function loopback(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
}

/** Validate actual plaintext bindings independently of advertised/proxied origins. */
export function validateProtectedRuntimeMapping(
	access: ProtectedRuntimeAccessConfig,
	api: { host: string; port: number },
	ports: { analog: number; digital: number },
): ProtectedAccessBootstrap {
	const publicApi = canonicalOrigin(access.publicOrigins.api)
	const analog = canonicalOrigin(access.publicOrigins.analogAudio)
	const digital = canonicalOrigin(access.publicOrigins.digitalAudio)
	const scheme = access.listenerScheme
	const origins = [
		publicApi,
		analog,
		digital,
		...access.allowedOrigins.map(canonicalOrigin),
	]
	if (
		origins.some(
			origin =>
				origin.protocol !== `${scheme}:` ||
				origin.hostname !== publicApi.hostname,
		) ||
		analog.origin === digital.origin ||
		publicApi.origin === analog.origin ||
		publicApi.origin === digital.origin ||
		(scheme === "http" &&
			(access.exposure !== "local-http" || !loopback(publicApi.hostname))) ||
		(scheme === "https" && access.exposure !== "tls-termination") ||
		!["127.0.0.1", "::1"].includes(api.host) ||
		new Set([api.port, ports.analog, ports.digital]).size !== 3
	)
		return invalid()
	// The runtime creates HTTP listeners. TLS termination must be in the same
	// network namespace; this check never certifies the external deployment.
	const probe = canonicalOrigin(access.healthProbe.target)
	if (
		probe.protocol !== "http:" ||
		probe.hostname !== (api.host === "::1" ? "[::1]" : api.host) ||
		Number(probe.port || 80) !== api.port
	)
		return invalid()
	const probeAuthority = normalizeAuthority(access.healthProbe.host, scheme)
	if (!probeAuthority) return invalid()
	const plan = resolveAccessBootstrap({
		mode: "protected",
		listenerScheme: scheme,
		allowedAuthorities: access.allowedAuthorities,
		allowedOrigins: access.allowedOrigins,
		externalAudioOrigins: [analog.origin, digital.origin],
	})
	if (plan.mode !== "protected") return invalid()
	const apiAuthorities = new Set([authority(publicApi, scheme), probeAuthority])
	if (
		plan.allowedAuthorities.length !== apiAuthorities.size ||
		plan.allowedAuthorities.some(value => !apiAuthorities.has(value))
	)
		return invalid()
	for (const [origin, boundary] of [
		[analog, access.audio.analog],
		[digital, access.audio.digital],
	] as const) {
		const expected = authority(origin, scheme)
		if (
			boundary.allowedAuthorities.length !== 1 ||
			normalizeAuthority(boundary.allowedAuthorities[0]!, scheme) !== expected
		)
			return invalid()
	}
	// Local HTTP has no proxy to translate address families or external ports.
	if (
		scheme === "http" &&
		((publicApi.hostname === "localhost"
			? api.host !== "127.0.0.1"
			: publicApi.hostname !== (api.host === "::1" ? "[::1]" : api.host)) ||
			access.audio.analog.bindHost !== api.host ||
			access.audio.digital.bindHost !== api.host)
	)
		return invalid()
	// Local HTTP has no proxy to translate external ports.
	if (
		scheme === "http" &&
		(Number(publicApi.port || 80) !== api.port ||
			Number(analog.port || 80) !== ports.analog ||
			Number(digital.port || 80) !== ports.digital)
	)
		return invalid()
	return plan
}
