/**
 * Zod schemas for the scanner's persisted records (spec § 7.1, § 8). JSON has no `undefined`, so a
 * parsed optional key is either absent or set and the parsed value has exactly the interface type;
 * the `Assert` aliases fail the typecheck if a schema and its interface drift apart.
 */
import { z } from "zod"
import {
	PreparedRecordingOperationsSchema,
	UUIDSchema,
	MAX_RECOVERY_OPERATIONS,
} from "./recording-operation.js"
import type { PreparedRecordingMetadata } from "./recording-operation.js"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../recordings/contract.js"
import type {
	DecodeEvidence,
	Discovery,
	Observation,
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../types.js"
import type { Assert, SchemaMatches } from "../../spectrum/types.js"

type SameUnion<A, B> = [A] extends [B]
	? [B] extends [A]
		? true
		: false
	: false

export const ScannerProtocolSchema = z.enum([
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	"digital-unknown",
	"carrier",
	"unknown",
	"ais",
	"acars",
	"vdl2",
	"lora",
])
export const ScannerClassSchema = z.enum([
	"fsk4-12k5",
	"fsk4-6k25",
	"tdma-ms",
	"fsk2-wide",
	"gmsk-narrow",
	"afsk-fm",
	"analog-fm",
	"ook-burst",
	"carrier",
	"wideband",
	"unknown",
])
export const ProtocolFamilySchema = z.enum([
	"analog",
	"digital-voice",
	"pager",
	"packet",
	"ism",
	"carrier",
	"unknown",
])
export const ConfidenceSchema = z.enum([
	"activity",
	"candidate",
	"classified",
	"decoded",
])
export type ProtocolEnumCheck = Assert<
	SameUnion<ScannerProtocol, z.output<typeof ScannerProtocolSchema>>
>
export type ClassEnumCheck = Assert<
	SameUnion<ScannerClass, z.output<typeof ScannerClassSchema>>
>
export type FamilyEnumCheck = Assert<
	SameUnion<ProtocolFamily, z.output<typeof ProtocolFamilySchema>>
>
export type ConfidenceEnumCheck = Assert<
	SameUnion<ScannerConfidence, z.output<typeof ConfidenceSchema>>
>

const IdentitySchema = z.object({
	kind: z.enum([
		"dmr-cc",
		"p25-nac",
		"nxdn-ran",
		"ysf-dgid",
		"dstar-call",
		"dpmr-cc",
		"pocsag-capcode",
		"aprs-call",
		"ism-model",
		"ais-mmsi",
		"acars-reg",
		"vdl2-addr",
		"lora-node",
	]),
	value: z.string(),
})
const TuningTrustSchema = z.enum(["commanded", "relay", "unverified"])
const SignalStatsSchema = z.object({
	peakDbfs: z.number(),
	meanDbfs: z.number(),
	snrDb: z.number(),
	floorDbfs: z.number(),
})
const MetadataSchema = z.object({
	talkgroups: z.array(z.string()),
	sources: z.array(z.string()),
	slots: z.array(z.number()),
	callsigns: z.array(z.string()),
	capcodes: z.array(z.string()),
	ismModels: z.array(z.string()),
	ctcssHz: z.number().optional(),
})

export const DecodeEvidenceSchema = z.object({
	protocol: ScannerProtocolSchema,
	identity: IdentitySchema.optional(),
	metadata: MetadataSchema.required().partial(),
	crcClean: z.boolean(),
	encrypted: z.boolean().optional(),
	callId: z.string().optional(),
	at: z.number(),
	epoch: z.number().int(),
	origin: z.enum(["probe", "ambient"]),
	probeId: z.string().optional(),
	decoderId: z.string().optional(),
})
export type DecodeEvidenceCheck = Assert<
	SchemaMatches<DecodeEvidence, typeof DecodeEvidenceSchema>
>

export const DiscoverySchema = z.object({
	id: z.string().min(1),
	frequencyHz: z.number(),
	frequencyKey: z.string(),
	measuredOffsetHz: z.number(),
	bandwidthHz: z.number(),
	protocol: ScannerProtocolSchema,
	family: ProtocolFamilySchema,
	class: ScannerClassSchema,
	confidence: ConfidenceSchema,
	confidenceCap: z.enum(["adjacent-leak", "suspected-intermod"]).optional(),
	identity: IdentitySchema.optional(),
	encrypted: z.boolean(),
	undecodedReason: z
		.enum([
			"no-sync",
			"crc-errors",
			"timeout",
			"no-probe-transport",
			"budget",
			"unsupported-format",
		])
		.optional(),
	coChannel: z.array(z.string()),
	firstSeenAt: z.string(),
	lastSeenAt: z.string(),
	observationCount: z.number().int().nonnegative(),
	airtimeMs: z.number().nonnegative(),
	signal: z.object({ best: SignalStatsSchema, last: SignalStatsSchema }),
	metadata: MetadataSchema,
	sourceIds: z.array(z.string()),
	jobIds: z.array(z.string()),
	tuningTrust: TuningTrustSchema,
	operator: z
		.object({
			label: z.string().optional(),
			notes: z.string().optional(),
			lockout: z.boolean().optional(),
			keep: z.boolean().optional(),
		})
		.optional(),
	evidence: z.object({
		recordings: z.number().int().nonnegative(),
		psd: z.boolean(),
		iq: z.boolean(),
	}),
})
/** `proof` and `evidenceLevel` are derived DTO fields (A12). They are not journal keys. */
export type DiscoveryCheck = Assert<
	SchemaMatches<
		Omit<Discovery, "proof" | "evidenceLevel">,
		typeof DiscoverySchema
	>
>

export const ObservationSchema = z.object({
	id: z.string().min(1),
	discoveryId: z.string().min(1),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	endReason: z
		.enum(["quiet", "retune", "hop", "job-end", "max-duration", "gap"])
		.optional(),
	sampleRange: z.object({
		stream: z.number().int(),
		epoch: z.number().int(),
		start: z.number(),
		end: z.number().optional(),
	}),
	centerHz: z.number(),
	obwHz: z.number(),
	obwMethod: z.enum(["-20dB", "on-bins"]),
	peakDbfs: z.number(),
	meanDbfs: z.number(),
	snrDb: z.number(),
	floorDbfs: z.number(),
	thresholdDb: z.number(),
	dutyCycle: z.number(),
	acf30: z.number().optional(),
	acf60: z.number().optional(),
	hypotheses: z.array(
		z.object({ protocol: ScannerProtocolSchema, score: z.number() }),
	),
	decode: z.array(DecodeEvidenceSchema).optional(),
	recordingIds: z.array(z.string()),
	recording: z.enum(["linked", "cut", "encrypted-dropped", "none"]).optional(),
	flags: z.object({
		overload: z.boolean(),
		gap: z.boolean(),
		offRaster: z.boolean(),
		obwBiased: z.boolean(),
		adjacentLeak: z.boolean(),
		suspectedIntermod: z.boolean(),
		edge: z.boolean(),
	}),
	sourceId: z.string(),
	jobIds: z.array(z.string()),
	hopIndex: z.number().int().optional(),
	tuningTrust: TuningTrustSchema,
})
/** `proof` is a derived DTO field (A12). It is not a journal key. */
export type ObservationCheck = Assert<
	SchemaMatches<Omit<Observation, "proof">, typeof ObservationSchema>
>

/** One journal payload: the resulting records of one store mutation (spec § 8). */
export interface StoreMutation {
	discoveries: Discovery[]
	observations: Observation[]
	/** Discovery ids removed by this mutation. */
	deleted: string[]
	/** Observation ids unlinked by this mutation (a late truncated/iqImage/spur flag, P3). */
	removedObservations?: string[]
	correction?: { sourceId: string; hz: number }
	preparedRecordingOperations?: {
		add: PreparedRecordingMetadata[]
		remove: string[]
	}
	/** WG10 req 1.5: each changed owner's merge alias list as written (empty: none left). */
	aliases?: { id: string; aliases: string[] }[]
}

/** WG10 req 1.5: one owner's merge aliases (bounded; absent in state written before WG10). */
export const DiscoveryAliasEntrySchema = z
	.object({
		id: z
			.string()
			.max(64)
			.regex(/^d_[0-9A-Za-z]+$/),
		aliases: z
			.array(
				z
					.string()
					.max(64)
					.regex(/^d_[0-9A-Za-z]+$/),
			)
			.max(DISCOVERY_RECORDING_ALIASES_MAX),
	})
	.strict()
export const StoreMutationSchema = z
	.object({
		discoveries: z.array(DiscoverySchema),
		observations: z.array(ObservationSchema),
		deleted: z.array(z.string()),
		removedObservations: z.array(z.string()).optional(),
		correction: z.object({ sourceId: z.string(), hz: z.number() }).optional(),
		preparedRecordingOperations: z
			.object({
				add: PreparedRecordingOperationsSchema,
				remove: z.array(UUIDSchema).max(MAX_RECOVERY_OPERATIONS),
			})
			.strict()
			.superRefine((patch, ctx) => {
				if (
					new Set(patch.remove).size !== patch.remove.length ||
					patch.add.some(record => patch.remove.includes(record.operationId))
				)
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Duplicate/conflicting recording operation patch",
					})
			})
			.optional(),
		aliases: z.array(DiscoveryAliasEntrySchema).optional(),
	})
	.strict()
export type StoreMutationCheck = Assert<
	SchemaMatches<StoreMutation, typeof StoreMutationSchema>
>

export function parseStoreMutation(value: unknown): StoreMutation | null {
	const parsed = StoreMutationSchema.safeParse(value)
	return parsed.success ? (parsed.data as StoreMutation) : null
}

export function parseDiscoveries(value: unknown): Discovery[] | null {
	const parsed = z.array(DiscoverySchema).safeParse(value)
	return parsed.success ? (parsed.data as Discovery[]) : null
}

export function parseObservations(value: unknown): Observation[] | null {
	const parsed = z.array(ObservationSchema).safeParse(value)
	return parsed.success ? (parsed.data as Observation[]) : null
}
