import { isAbsolute } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import type { AccessRouteServices } from "./access-routes.js"
import { normalizeAuthority } from "./authority.js"
import { resolveAccessBootstrap } from "./bootstrap-policy.js"
import type { ProtectedAccessBootstrap } from "./bootstrap-policy.js"
import { ConnectionLeases } from "./connection-leases.js"
import { PairingService } from "./pairing.js"
import { AccessPolicy } from "./policy.js"
import { PrivateAccessStorage } from "./private-storage.js"
import { SessionFlows } from "./session-flows.js"
import { SessionStore } from "./sessions.js"

export interface AccessAudioBoundary {
	readonly listenerScheme: "http" | "https"
	readonly allowedAuthorities: readonly string[]
}

export interface AccessRuntimeOptions {
	readonly bootstrap: ProtectedAccessBootstrap
	/** Explicit audio listener boundary; never inferred from advertised URLs. */
	readonly audio: AccessAudioBoundary
	readonly directory: string
	readonly ownership: "single-host-pid-namespace"
	readonly sessionCookieName?: string
}

/** Structurally usable as FastifyAccessOptions or NodeHttpAccessOptions. */
export interface AccessRuntimeListener {
	readonly policy: AccessPolicy
	readonly sessions: SessionStore
	/** Borrowed by adapters; this context alone owns the shared manager. */
	readonly leases: ConnectionLeases
}

export interface AccessRuntimeContext {
	readonly api: AccessRuntimeListener
	readonly audio: AccessRuntimeListener
	readonly services: Readonly<AccessRouteServices>
	/**
	 * Caller must first stop admissions and drain flows/adapters. Disposes leases
	 * before releasing private storage. Does not log out remembered browsers.
	 */
	close(): Promise<void>
}

const optionsSchema = z
	.object({
		bootstrap: z.unknown(),
		audio: z
			.object({
				listenerScheme: z.enum(["http", "https"]),
				allowedAuthorities: z.array(z.string().min(1).max(300)).min(1).max(64),
			})
			.strict(),
		directory: z
			.string()
			.min(1)
			.max(4096)
			.refine(isAbsolute)
			.refine(value => !value.includes("\0")),
		ownership: z.literal("single-host-pid-namespace"),
		sessionCookieName: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/)
			.default("wavekit_session"),
	})
	.strict()

function unavailable(): WaveKitError {
	return new WaveKitError(
		"Access runtime unavailable",
		"ACCESS_RUNTIME_UNAVAILABLE",
	)
}

/**
 * Unmounted protected authority. Await before handing dependencies to listeners;
 * this opens no server and advertises no live protection. Startup never provisions
 * or falls back to legacy. Storage is private to this lifecycle, not public config.
 */
export async function openAccessRuntime(
	options: AccessRuntimeOptions,
): Promise<AccessRuntimeContext> {
	let storage: PrivateAccessStorage | undefined
	let leases: ConnectionLeases | undefined
	try {
		const parsed = optionsSchema.safeParse(options)
		if (!parsed.success) throw unavailable()
		const config = parsed.data
		const bootstrap = resolveAccessBootstrap(config.bootstrap)
		if (bootstrap.mode !== "protected") throw unavailable()
		const audio = resolveAccessBootstrap({
			mode: "protected",
			...config.audio,
			allowedOrigins: bootstrap.allowedOrigins,
			externalAudioOrigins: [],
		})
		if (audio.mode !== "protected") throw unavailable()
		if (
			audio.listenerScheme !== bootstrap.listenerScheme ||
			audio.allowedAuthorities.some(
				authority => !bootstrap.allowedAuthorities.includes(authority),
			) ||
			bootstrap.externalAudioOrigins.some(origin => {
				const url = new URL(origin)
				const scheme = url.protocol === "https:" ? "https" : "http"
				const authority = normalizeAuthority(url.host, scheme)
				return (
					scheme !== audio.listenerScheme ||
					!authority ||
					!audio.allowedAuthorities.includes(authority)
				)
			})
		)
			throw unavailable()
		if (
			(config.sessionCookieName.startsWith("__Host-") ||
				config.sessionCookieName.startsWith("__Secure-")) &&
			bootstrap.listenerScheme !== "https"
		)
			throw unavailable()
		storage = await PrivateAccessStorage.open({
			directory: config.directory,
			ownership: config.ownership,
			mode: "load",
		})
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			snapshot: storage.startupSnapshot(),
			persist: storage.persist,
		})
		const common = {
			allowedOrigins: bootstrap.allowedOrigins,
			sessionCookieName: config.sessionCookieName,
			machineSecretDigest: storage.machineSecretDigest(),
			sessions,
		}
		const apiPolicy = new AccessPolicy({
			...common,
			listenerScheme: bootstrap.listenerScheme,
			allowedAuthorities: bootstrap.allowedAuthorities,
		})
		const audioPolicy = new AccessPolicy({
			...common,
			listenerScheme: audio.listenerScheme,
			allowedAuthorities: audio.allowedAuthorities,
		})
		leases = new ConnectionLeases(sessions)
		const services = Object.freeze({
			pairing: new PairingService({ policy: apiPolicy, sessions }),
			flows: new SessionFlows({ policy: apiPolicy, sessions }),
		})
		const ownedStorage = storage
		const ownedLeases = leases
		let closing: Promise<void> | undefined
		return Object.freeze({
			api: Object.freeze({ policy: apiPolicy, sessions, leases }),
			audio: Object.freeze({ policy: audioPolicy, sessions, leases }),
			services,
			close(): Promise<void> {
				closing ??= Promise.resolve().then(async () => {
					let failed = false
					try {
						ownedLeases.dispose()
					} catch {
						failed = true
					}
					try {
						await ownedStorage.close()
					} catch {
						failed = true
					}
					if (failed) throw unavailable()
				})
				return closing
			},
		})
	} catch {
		try {
			leases?.dispose()
		} catch {
			/* Storage must still close if transport cleanup fails. */
		}
		await storage?.close().catch(() => undefined)
		throw unavailable()
	}
}
