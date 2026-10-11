/** Scanner-private recording authority. Prepared records never grant download availability. */
import { randomUUID } from "node:crypto"
import { z } from "zod"

export const MAX_RECOVERY_OPERATIONS = 4096
export const MAX_OPERATION_METADATA_BYTES = 16 * 1024
export const UUIDSchema = z.string().uuid()
export const RecordingIdentitySchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/)
const boundedText = z.string().min(1).max(256)
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hz = z.number().finite().nonnegative()
export const RecordingBindingSchema = z
	.object({
		sourceId: boundedText.nullable(),
		engineInstanceId: UUIDSchema.nullable(),
		stream: safeCount.nullable(),
		epoch: safeCount.nullable(),
		channelId: boundedText.nullable(),
		channelGeneration: safeCount.nullable(),
		inputFormat: z.literal("cf32").nullable(),
		inputSampleRateHz: z.number().finite().positive().nullable(),
		groupDelayInputSamples: z.number().finite().nonnegative().nullable(),
		targetHz: hz.nullable(),
		captureCentreHz: hz.nullable(),
		tuningTrust: z.enum(["commanded", "relay", "unverified"]).nullable(),
	})
	.strict()
export type RecordingBinding = Readonly<z.output<typeof RecordingBindingSchema>>

export function recordingAlias(
	discoveryId: string,
	operationId: string,
): string {
	return `${discoveryId}~analog-${operationId}.wav`
}
export function recordingArtifact(
	discoveryId: string,
	operationId: string,
): string {
	return `recordings/analog/${discoveryId}/analog-${operationId}.wav`
}

export const PreparedRecordingMetadataSchema = z
	.object({
		version: z.literal(1),
		operationId: UUIDSchema,
		producerRecordingId: UUIDSchema,
		discoveryId: RecordingIdentitySchema,
		observationId: RecordingIdentitySchema,
		alias: z.string().min(1).max(256),
		desiredState: z.enum(["linked", "cut"]),
		binding: RecordingBindingSchema,
		expectedOutput: z
			.object({
				sampleRateHz: z.literal(8000),
				channelCount: z.literal(1),
				outputFrames: safeCount.max(960_000),
				fileBytes: safeCount.max(1_920_044),
			})
			.strict(),
		artifact: z.string().min(1).max(512),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.producerRecordingId !== value.operationId ||
			value.alias !== recordingAlias(value.discoveryId, value.operationId) ||
			value.artifact !==
				recordingArtifact(value.discoveryId, value.operationId) ||
			value.expectedOutput.fileBytes !==
				44 + 2 * value.expectedOutput.outputFrames ||
			Buffer.byteLength(JSON.stringify(value)) > MAX_OPERATION_METADATA_BYTES
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Invalid recording identity/output or metadata bound",
			})
	})
export type PreparedRecordingMetadata = Readonly<
	Omit<
		z.output<typeof PreparedRecordingMetadataSchema>,
		"binding" | "expectedOutput"
	> & {
		binding: RecordingBinding
		expectedOutput: Readonly<
			z.output<typeof PreparedRecordingMetadataSchema>["expectedOutput"]
		>
	}
>
export const PreparedRecordingOperationsSchema = z
	.array(PreparedRecordingMetadataSchema)
	.max(MAX_RECOVERY_OPERATIONS)
	.superRefine((records, ctx) => {
		if (
			new Set(records.map(record => record.operationId)).size !== records.length
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Duplicate recording operation",
			})
	})
export function samePreparedRecording(
	a: PreparedRecordingMetadata,
	b: PreparedRecordingMetadata,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

const engineIds = new WeakMap<object, string>()
export function recordingEngineInstanceId(engine: object): string {
	let id = engineIds.get(engine)
	if (id === undefined) {
		id = randomUUID()
		engineIds.set(engine, id)
	}
	return id
}
