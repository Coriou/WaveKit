import { RECEIVER_SAMPLE_RATE_PRESETS_HZ } from "@wavekit/api-types"
import { z } from "zod"
import type {
	ReceiverCapabilities,
	ReceiverCapabilitiesPage,
	ReceiverCommandValidation,
	ReceiverControlId,
	ReceiverControlUnit,
	ReceiverSourceDescription,
} from "@wavekit/api-types"

export const RECEIVER_CAPABILITIES_LIMITS = Object.freeze({
	itemBytes: 16 * 1024,
	pageBytes: 256 * 1024,
	pageLimit: 16,
	defaultPageLimit: 8,
	candidates: 17,
	sourceIdBytes: 256,
	sourceIdCodeUnits: 100,
	deliveryTimeoutMs: 10000,
})

export interface ReceiverRestCommandPolicyRow {
	readonly id: ReceiverControlId
	readonly unit: ReceiverControlUnit
	readonly opcode: number
	readonly rule: ReceiverCommandValidation
}

/** Supplied by Main's shared REST descriptor, never a local policy fallback. */
export type ReceiverRestCommandPolicy = readonly ReceiverRestCommandPolicyRow[]

export interface SourceReceiverEvidence {
	readonly sourceId: string
	readonly sourceStateToken: object
	readonly sourceIncarnation: string
	readonly sessionId: string | null
	readonly snapshotId: string
	readonly capturedAt: number
	readonly source: ReceiverSourceDescription
	readonly caps: {
		readonly sampleRate: number
		readonly centerFreq: number | null
	}
	readonly connection: "connecting" | "connected" | "disconnected" | "ended"
	readonly delivery: {
		readonly state:
			| "disconnected"
			| "waiting"
			| "streaming"
			| "stale"
			| "paused"
			| "ended"
		readonly lastSampleAt: number | null
		readonly sampleAgeMs: number | null
		readonly timeoutMs: 10000
	}
	readonly header: {
		readonly capture: "not-applicable" | "missing" | "partial" | "complete"
		readonly bytes: Buffer | null
		readonly capturedAt: number | null
	}
}

export type ReceiverEvidenceRead =
	| { readonly kind: "missing" | "unavailable" | "conflict" | "limit" }
	| { readonly kind: "present"; readonly evidence: SourceReceiverEvidence }

export type ReceiverEvidencePageRead =
	| { readonly kind: "unavailable" | "conflict" | "limit" }
	| {
			readonly kind: "candidates"
			readonly candidates: readonly SourceReceiverEvidence[]
			readonly capturedAt: number
			readonly snapshotId: string | null
	}

/** Synchronous detached captures. No lifecycle or writable capability is exposed. */
export interface ReceiverEvidenceReader {
	read(sourceId: string): ReceiverEvidenceRead
	readPage(after: string | null, limit: number): ReceiverEvidencePageRead
}

export type ReceiverProviderFailureCode =
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "FAILED"
	| "CONFLICT"
	| "LIMIT"
export type ReceiverProviderResult<
	T,
	C extends ReceiverProviderFailureCode = ReceiverProviderFailureCode,
> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: C }

export interface ReceiverCapabilitiesProvider {
	get(sourceId: string): ReceiverProviderResult<ReceiverCapabilities>
	list(input: {
		readonly after: string | null
		readonly limit: number
	}): ReceiverProviderResult<
		ReceiverCapabilitiesPage,
		Exclude<ReceiverProviderFailureCode, "NOT_FOUND">
	>
	dispose(): void
}

/** No normalization, trimming, second decoding or UTF8 replacement. */
export function isReceiverSourceId(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1 || value.length > 100)
		return false
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f || "/\\?#".includes(value[i] ?? ""))
			return false
		if (code >= 0xd800 && code <= 0xdbff) {
			const low = value.charCodeAt(++i)
			if (!(low >= 0xdc00 && low <= 0xdfff)) return false
		} else if (code >= 0xdc00 && code <= 0xdfff) return false
	}
	return Buffer.byteLength(value, "utf8") <= 256
}

export function isReceiverToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{32}$/.test(value) &&
		value !== "0".repeat(32)
	)
}

export function isReceiverTime(value: unknown): value is number {
	// Fixed 24-character UTC format excludes expanded/signed Date years.
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= -62167219200000 &&
		value <= 253402300799999
	)
}

/** Reject accessors, cycles, exotic prototypes and oversized input before schema traversal.
 * Opaque sourceStateToken is deliberately not traversed or published. Proxy traps are
 * outside the trusted injected reader boundary; thrown traps still map to FAILED.
 */
export function isDetachedPlainData(
	value: unknown,
	allowEvidence = false,
): boolean {
	let nodes = 0
	const seen = new Set<object>()
	function visit(item: unknown, depth: number): boolean {
		if (++nodes > 4096 || depth > 12) return false
		if (item === null || typeof item === "boolean" || typeof item === "number")
			return true
		if (typeof item === "string") return true
		if (typeof item !== "object") return false
		if (Buffer.isBuffer(item)) return allowEvidence && item.length === 12
		if (seen.has(item)) return false
		seen.add(item)
		const array = Array.isArray(item)
		const proto: unknown = Object.getPrototypeOf(item)
		if (
			array
				? proto !== Array.prototype
				: proto !== Object.prototype && proto !== null
		)
			return false
		if (array) {
			// Bound logical length BEFORE enumeration or Zod's spread/map traversal.
			// The global cap admits all legal raw pages/policies; schemas apply their
			// tighter 17/15/3/2 bounds afterward. Never iterate a sparse large length.
			const lengthDescriptor = Object.getOwnPropertyDescriptor(item, "length")
			if (!lengthDescriptor || !("value" in lengthDescriptor)) return false
			const length: unknown = lengthDescriptor.value
			if (
				typeof length !== "number" ||
				!Number.isInteger(length) ||
				length < 0 ||
				length > 32
			)
				return false
			const keys = Reflect.ownKeys(item)
			if (keys.length !== length + 1) return false
			for (let index = 0; index < length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
				if (
					!descriptor ||
					!("value" in descriptor) ||
					!visit(descriptor.value, depth + 1)
				)
					return false
			}
			seen.delete(item)
			return true
		}
		const keys = Reflect.ownKeys(item)
		if (keys.length > 20) return false
		for (const key of keys) {
			if (typeof key !== "string") return false
			const descriptor = Object.getOwnPropertyDescriptor(item, key)
			if (!descriptor || !("value" in descriptor)) return false
			if (allowEvidence && key === "sourceStateToken") {
				if (descriptor.value === null || typeof descriptor.value !== "object")
					return false
				continue
			}
			if (!visit(descriptor.value, depth + 1)) return false
		}
		seen.delete(item)
		return true
	}
	return visit(value, 0)
}

export function freezeReceiverData<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeReceiverData(child)
		Object.freeze(value)
	}
	return value
}

const safeInteger = z.number().int().safe()
const positiveInteger = safeInteger.positive()
const token = z.string().refine(isReceiverToken)
const time = safeInteger.refine(isReceiverTime)
const sourceId = z.string().refine(isReceiverSourceId)
const date = z
	.string()
	.length(24)
	.refine(value => {
		const parsed = Date.parse(value)
		return isReceiverTime(parsed) && new Date(parsed).toISOString() === value
	})
const range = z
	.object({ min: safeInteger, max: safeInteger })
	.strict()
	.refine(value => value.min <= value.max)
export const receiverValidationSchema = z.union([
	z
		.object({
			kind: z.literal("integer-range"),
			min: safeInteger,
			max: safeInteger,
		})
		.strict()
		.refine(value => value.min <= value.max),
	z
		.object({
			kind: z.literal("integer-ranges"),
			ranges: z.tuple([range, range]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("enum"),
			values: z.array(z.string().min(1).max(16)).min(1).max(3),
		})
		.strict(),
	z.object({ kind: z.literal("boolean") }).strict(),
	z.object({ kind: z.literal("uint16-pair") }).strict(),
])

export const receiverSourceSchema = z
	.object({
		type: z.enum(["rtl_tcp", "sdrpp-network", "recording"]),
		kind: z.enum(["iq", "audio_pcm", "recording"]),
		format: z.enum(["U8_IQ", "S16_IQ", "S16LE", "FLOAT32LE", "auto"]),
	})
	.strict()

export const receiverEvidenceSchema = z
	.object({
		sourceId: z.string().max(512),
		sourceStateToken: z.custom<object>(
			value => value !== null && typeof value === "object",
		),
		sourceIncarnation: token,
		sessionId: token.nullable(),
		snapshotId: token,
		capturedAt: time,
		source: receiverSourceSchema,
		caps: z
			.object({
				sampleRate: positiveInteger,
				centerFreq: positiveInteger.nullable(),
			})
			.strict(),
		connection: z.enum(["connecting", "connected", "disconnected", "ended"]),
		delivery: z
			.object({
				state: z.enum([
					"disconnected",
					"waiting",
					"streaming",
					"stale",
					"paused",
					"ended",
				]),
				lastSampleAt: time.nullable(),
				sampleAgeMs: safeInteger.nonnegative().nullable(),
				timeoutMs: z.literal(10000),
			})
			.strict(),
		header: z
			.object({
				capture: z.enum(["not-applicable", "missing", "partial", "complete"]),
				bytes: z.custom<Buffer>(Buffer.isBuffer).nullable(),
				capturedAt: time.nullable(),
			})
			.strict(),
	})
	.strict()

const controlIds = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"ifGain",
	"testMode",
	"agcMode",
	"directSampling",
	"offsetTuning",
	"rtlXtal",
	"tunerXtal",
	"gainIndex",
	"biasTee",
	"tunerIfGain",
] as const
const controlUnits = [
	"Hz",
	"enum",
	"tenthsDb",
	"ppm",
	"rawInteger",
	"boolean",
	"index",
	"stageRawPair",
] as const
export const receiverPolicySchema = z
	.array(
		z
			.object({
				id: z.enum(controlIds),
				unit: z.enum(controlUnits),
				opcode: safeInteger.min(1).max(15),
				rule: receiverValidationSchema,
			})
			.strict(),
	)
	.length(15)

const headerSchema = z.discriminatedUnion("state", [
	z
		.object({
			state: z.literal("advertised"),
			provenance: z.literal("rtl-peer-header"),
			sessionId: token,
			observedAt: date,
			tunerType: safeInteger.min(0).max(0xffffffff),
			gainCount: safeInteger.min(0).max(0xffffffff),
		})
		.strict(),
	z
		.object({
			state: z.literal("unknown"),
			reason: z.enum([
				"not-connected",
				"awaiting-header",
				"partial-header",
				"invalid-header",
				"format-not-captured",
			]),
		})
		.strict(),
	z
		.object({
			state: z.literal("not-applicable"),
			reason: z.enum(["non-rtl-transport", "non-iq-source"]),
		})
		.strict(),
])
const sampleRatePresetsSchema = z.discriminatedUnion("state", [
	z
		.object({
			state: z.literal("suggested"),
			provenance: z.literal("wavekit-rtl-rate-presets"),
			valuesHz: z
				.array(
					positiveInteger.refine(hz =>
						RECEIVER_SAMPLE_RATE_PRESETS_HZ.includes(hz),
					),
				)
				.max(RECEIVER_SAMPLE_RATE_PRESETS_HZ.length),
		})
		.strict(),
	z
		.object({
			state: z.literal("not-applicable"),
			reason: z.literal("non-rtl-transport"),
		})
		.strict(),
])
/**
 * WG6 req 8.1: the frozen RTL presets that lie inside the sampleRate command's validated
 * rule, in frozen order. A rule of another kind admits none (fail closed).
 */
export function sampleRatePresetsWithin(
	rule: ReceiverCommandValidation | undefined,
): readonly number[] {
	const inside = (hz: number): boolean => {
		if (rule?.kind === "integer-range") return hz >= rule.min && hz <= rule.max
		if (rule?.kind === "integer-ranges")
			return rule.ranges.some(r => hz >= r.min && hz <= r.max)
		return false
	}
	return Object.freeze(RECEIVER_SAMPLE_RATE_PRESETS_HZ.filter(inside))
}

const receiverCapabilitiesObjectSchema = z
	.object({
		schemaVersion: z.literal(1),
		sourceId,
		sourceIncarnation: token,
		sessionId: token.nullable(),
		snapshotId: token,
		capturedAt: date,
		source: receiverSourceSchema,
		connection: z.enum(["connecting", "connected", "disconnected", "ended"]),
		delivery: z
			.object({
				state: z.enum([
					"disconnected",
					"waiting",
					"streaming",
					"stale",
					"paused",
					"ended",
				]),
				lastSampleAt: date.nullable(),
				sampleAgeMs: safeInteger.nonnegative().nullable(),
				timeoutMs: z.literal(10000),
			})
			.strict(),
		peerHeader: headerSchema,
		controls: z
			.array(
				z
					.object({
						id: z.enum(controlIds),
						unit: z.enum(controlUnits),
						command: z
							.object({
								state: z.literal("implemented"),
								opcode: safeInteger.min(1).max(15),
								validation: z
									.object({
										authority: z.literal("admitted-rest-argument-policy"),
										rule: receiverValidationSchema,
									})
									.strict(),
							})
							.strict(),
						transport: z.discriminatedUnion("state", [
							z
								.object({
									state: z.literal("applicable"),
									reason: z.literal("rtl-tcp"),
								})
								.strict(),
							z
								.object({
									state: z.literal("not-applicable"),
									reason: z.literal("non-rtl-transport"),
								})
								.strict(),
						]),
						physical: z
							.object({
								state: z.literal("unknown"),
								reason: z.literal("no-qualified-readback"),
							})
							.strict(),
						currentValue: z
							.object({
								state: z.literal("unknown"),
								reason: z.literal(
									"session-qualified-command-evidence-not-provided",
								),
							})
							.strict(),
					})
					.strict(),
			)
			.length(15),
		declaredStream: z
			.object({
				provenance: z.literal("source-config-or-core-metadata"),
				sampleRateHz: positiveInteger,
				centerFrequencyHz: positiveInteger.nullable(),
			})
			.strict(),
		sampleRatePresets: sampleRatePresetsSchema,
	})
	.strict()

export const receiverCapabilitiesSchema = receiverCapabilitiesObjectSchema

/**
 * Presets correlation (checked with the other item correlations, failure is CONFLICT):
 * `suggested` exactly on rtl_tcp sources, and its valuesHz equal, in order, to the
 * frozen presets inside the item's own sampleRate validation rule.
 */
export function sampleRatePresetsCoherent(
	item: Pick<ReceiverCapabilities, "source" | "controls" | "sampleRatePresets">,
): boolean {
	const presets = item.sampleRatePresets
	if (presets === undefined) return false
	if ((item.source.type === "rtl_tcp") !== (presets.state === "suggested"))
		return false
	if (presets.state !== "suggested") return true
	const rule = item.controls.find(c => c.id === "sampleRate")?.command
		.validation.rule
	const expected = sampleRatePresetsWithin(rule)
	return (
		presets.valuesHz.length === expected.length &&
		presets.valuesHz.every((hz, i) => hz === expected[i])
	)
}

export const receiverCapabilitiesPageSchema = z
	.object({
		schemaVersion: z.literal(1),
		items: z.array(receiverCapabilitiesSchema).max(16),
		nextAfter: sourceId.nullable(),
	})
	.strict()
