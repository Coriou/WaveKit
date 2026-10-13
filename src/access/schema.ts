import {
	ACCESS_DEVICES_LIMITS,
	accessDeviceKindSchema,
	accessDeviceNameSchema,
} from "@wavekit/api-types"
import type { AccessDeviceKind } from "@wavekit/api-types"
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

const clockSchema = z.number().int().nonnegative().safe()
const credentialBindingSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sessionIdentitySchema = {
	deviceId: z.string().regex(/^device_[A-Za-z0-9_-]{43}$/),
	tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
	csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	createdAt: clockSchema,
	renewedAt: clockSchema,
	expiresAt: clockSchema,
}
/** Contract rule: epoch ms, multiple of one UTC hour. Null is unset, not hour zero. */
const lastSeenAtSchema = clockSchema.refine(
	value => value % ACCESS_DEVICES_LIMITS.lastSeenResolutionMs === 0,
	"lastSeenAt must be hour-aligned",
)
const sessionRecordV1Schema = z.object(sessionIdentitySchema).strict()
const sessionRecordV2Schema = z
	.object({
		...sessionIdentitySchema,
		name: accessDeviceNameSchema.nullable(),
		kind: accessDeviceKindSchema.nullable(),
		lastSeenAt: lastSeenAtSchema.nullable(),
	})
	.strict()

/**
 * Snapshot version 2 carries operator name, kind and coarse last-seen.
 * Version 1 records load with those fields null. Every write is version 2.
 * The private-storage envelope stays version 1; an older WaveKit rejects this
 * inner version and fails closed like any other invalid file.
 */
export const sessionSnapshotSchema = z.union([
	z
		.object({
			version: z.literal(1),
			credentialBinding: credentialBindingSchema,
			sessions: z.array(sessionRecordV1Schema).max(32),
		})
		.strict()
		.transform(data => ({
			version: 2 as const,
			credentialBinding: data.credentialBinding,
			sessions: data.sessions.map(record => ({
				...record,
				name: null as string | null,
				kind: null as AccessDeviceKind | null,
				lastSeenAt: null as number | null,
			})),
		})),
	z
		.object({
			version: z.literal(2),
			credentialBinding: credentialBindingSchema,
			sessions: z.array(sessionRecordV2Schema).max(32),
		})
		.strict(),
])
