import type { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import {
	OPERATOR_DATA_LIMITS,
	OPERATOR_DATA_ERROR_DEFINITIONS,
	mutationSchema,
	snapshotSchema,
} from "@wavekit/api-types"
import type {
	ExpectedToken,
	OperatorDataErrorCode,
	OperatorDataSnapshot,
	OperatorDataMutation,
} from "@wavekit/api-types"
export {
	OPERATOR_DATA_LIMITS,
	uuidSchema,
	revisionSchema,
	expectedTokenSchema,
	timestampSchema,
	modeSchema,
	toneSchema,
	savedFrequencyInputSchema,
	savedFrequencySchema,
	preferenceKeySchema,
	preferencesSchema,
	preferenceOverridesSchema,
	commandSchema,
	commandReferenceSchema,
	commandUsageSchema,
	commandUsageKey,
	compareCommandUsage,
	snapshotSchema,
	mutationSchema,
} from "@wavekit/api-types"
export type {
	ExpectedToken,
	SavedFrequencyInput,
	SavedFrequency,
	PreferenceKey,
	Preferences,
	PreferenceOverrides,
	CommandReference,
	CommandUsage,
	OperatorDataSnapshot,
	OperatorDataMutation,
	OperatorDataErrorCode,
} from "@wavekit/api-types"

export class OperatorDataError extends WaveKitError {
	readonly statusCode: number
	readonly current?: ExpectedToken
	constructor(code: OperatorDataErrorCode, current?: ExpectedToken) {
		super(OPERATOR_DATA_ERROR_DEFINITIONS[code][1], code)
		this.name = "OperatorDataError"
		this.statusCode = OPERATOR_DATA_ERROR_DEFINITIONS[code][0]
		if (current) this.current = { ...current }
	}
}

function parse<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	value: unknown,
): T {
	const result = schema.safeParse(value)
	if (!result.success) {
		const quota = result.error.issues.some(
			issue =>
				(issue.code === "too_big" && issue.type === "array") ||
				(issue.code === "custom" && issue.params?.["quota"] === true),
		)
		throw new OperatorDataError(
			quota ? "OPERATOR_DATA_QUOTA" : "OPERATOR_DATA_INVALID",
		)
	}
	return result.data
}
/** Validates and returns a detached snapshot; never repairs unknown-version state. */
export function validateSnapshot(value: unknown): OperatorDataSnapshot {
	return parse(snapshotSchema, value)
}
/** Compact JSON, bounded by its actual UTF-8 encoding. Storage writes these exact bytes. */
export function encodeSnapshot(value: unknown): string {
	return JSON.stringify(validateSnapshot(value))
}
export function parseMutation(value: unknown): OperatorDataMutation {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(!Object.hasOwn(value, "expected") ||
			Reflect.get(value, "expected") === undefined)
	)
		throw new OperatorDataError("OPERATOR_DATA_PRECONDITION_REQUIRED")
	const mutation = parse(mutationSchema, value)
	let bytes: number
	try {
		bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
	} catch {
		throw new OperatorDataError("OPERATOR_DATA_INVALID")
	}
	if (bytes > OPERATOR_DATA_LIMITS.requestBytes)
		throw new OperatorDataError("OPERATOR_DATA_QUOTA")
	return mutation
}
