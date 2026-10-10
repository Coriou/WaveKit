import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { normalizeAuthority, normalizeOrigin } from "./authority.js"

const settingsSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("legacy") }).strict(),
	z
		.object({
			mode: z.literal("protected"),
			listenerScheme: z.enum(["http", "https"]),
			allowedAuthorities: z.array(z.string().min(1).max(300)).min(1).max(64),
			allowedOrigins: z.array(z.string().min(1).max(320)).max(64),
			externalAudioOrigins: z
				.array(z.string().min(1).max(320))
				.max(16)
				.default([]),
		})
		.strict(),
])

export interface LegacyAccessBootstrap {
	readonly mode: "legacy"
}

export interface ProtectedAccessBootstrap {
	readonly mode: "protected"
	/** Explicit external listener context, never derived from request headers. */
	readonly listenerScheme: "http" | "https"
	readonly allowedAuthorities: readonly string[]
	readonly allowedOrigins: readonly string[]
	readonly externalAudioOrigins: readonly string[]
}

export type AccessBootstrap = LegacyAccessBootstrap | ProtectedAccessBootstrap

function invalid(): never {
	throw new WaveKitError(
		"Invalid access configuration",
		"ACCESS_CONFIG_INVALID",
	)
}

function concrete(authority: string): boolean {
	return !authority.startsWith("0.0.0.0:") && !authority.startsWith("[::]:")
}

function origins(values: string[]): readonly string[] {
	const normalized = values.map(value => {
		const origin = normalizeOrigin(value)
		if (!origin) return invalid()
		const url = new URL(origin)
		const authority = normalizeAuthority(
			url.host,
			url.protocol === "https:" ? "https" : "http",
		)
		if (!authority || !concrete(authority)) return invalid()
		return origin
	})
	return Object.freeze([...new Set(normalized)])
}

/** Public settings only. This plan neither opens listeners nor loads private state. */
export function resolveAccessBootstrap(input: unknown = {}): AccessBootstrap {
	const absent = z.object({}).strict().safeParse(input).success
	const parsed = settingsSchema.safeParse(absent ? { mode: "legacy" } : input)
	if (!parsed.success) return invalid()
	const settings = parsed.data
	if (settings.mode === "legacy") return Object.freeze({ mode: "legacy" })
	const authorities = settings.allowedAuthorities.map(value => {
		const normalized = normalizeAuthority(value, settings.listenerScheme)
		if (!normalized || !concrete(normalized)) return invalid()
		return normalized
	})
	return Object.freeze({
		mode: "protected",
		listenerScheme: settings.listenerScheme,
		allowedAuthorities: Object.freeze([...new Set(authorities)]),
		allowedOrigins: origins(settings.allowedOrigins),
		externalAudioOrigins: origins(settings.externalAudioOrigins),
	})
}

const availabilitySchema = z
	.object({ sessions: z.boolean(), pairing: z.boolean() })
	.strict()

export interface AccessCapabilities {
	readonly mode: "legacy" | "protected"
	readonly sessionAvailable: boolean
	readonly pairingAvailable: boolean
}

/** Call only with actual mounted-service availability, not anticipated setup state. */
export function accessCapabilities(
	plan: AccessBootstrap,
	availability: unknown,
): AccessCapabilities {
	const parsed = availabilitySchema.safeParse(availability)
	if (!parsed.success) return invalid()
	const active = plan.mode === "protected"
	const sessionAvailable = active && parsed.data.sessions
	return Object.freeze({
		mode: plan.mode,
		sessionAvailable,
		pairingAvailable:
			sessionAvailable &&
			parsed.data.pairing &&
			plan.mode === "protected" &&
			plan.allowedOrigins.length > 0,
	})
}
