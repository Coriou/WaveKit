import { z } from "zod"

export const accessRequestSchema = z.object({
	method: z
		.string()
		.min(1)
		.max(32)
		.regex(/^[A-Z]+$/),
	rawTarget: z.string().min(1).max(8192),
	rawHeaders: z.array(z.string().max(8192)).max(256),
	transport: z.enum(["http", "websocket"]),
	surface: z.enum(["api", "audio"]),
	remoteAddress: z.string().max(256),
})

export const accessPolicySchema = z.object({
	listenerScheme: z.enum(["http", "https"]),
	allowedAuthorities: z.array(z.string().min(1).max(300)).min(1).max(64),
	allowedOrigins: z.array(z.string().min(1).max(320)).max(64),
	sessionCookieName: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/),
	machineSecretDigest: z.custom<Uint8Array>(
		value => value instanceof Uint8Array && value.length === 32,
	),
})

export const sessionOptionsSchema = z.object({
	ttlMs: z
		.number()
		.int()
		.min(1)
		.max(30 * 24 * 60 * 60 * 1000)
		.default(30 * 24 * 60 * 60 * 1000),
	maxSessions: z.number().int().min(1).max(32).default(32),
	maxListenersPerSession: z.number().int().min(1).max(64).default(16),
	credentialBinding: z.string().regex(/^[a-f0-9]{64}$/),
})

export const sessionSnapshotSchema = z
	.object({
		version: z.literal(1),
		credentialBinding: z.string().regex(/^[a-f0-9]{64}$/),
		sessions: z
			.array(
				z
					.object({
						deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{43}$/),
						tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
						csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
						createdAt: z.number().int().nonnegative().safe(),
						renewedAt: z.number().int().nonnegative().safe(),
						expiresAt: z.number().int().nonnegative().safe(),
					})
					.strict(),
			)
			.max(32),
	})
	.strict()
