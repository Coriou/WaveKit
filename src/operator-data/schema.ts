import type { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import {
	zodValidationFields,
	type ValidationField,
} from "../api/validation-errors.js"
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
	/** For a 400 or 428: the request fields that failed and what each accepts (static schema text). */
	readonly fields?: ValidationField[]
	constructor(
		code: OperatorDataErrorCode,
		current?: ExpectedToken,
		fields?: readonly ValidationField[],
	) {
		super(OPERATOR_DATA_ERROR_DEFINITIONS[code][1], code)
		this.name = "OperatorDataError"
		this.statusCode = OPERATOR_DATA_ERROR_DEFINITIONS[code][0]
		if (current) this.current = { ...current }
		if (fields && fields.length > 0)
			this.fields = fields.map(f => ({ field: f.field, expected: f.expected }))
	}
}

/** What `expected` must be: the token of the snapshot the write is based on. */
export const EXPECTED_TOKEN_TEXT =
	"object with fields storeId, revision: the snapshot.storeId and snapshot.revision of GET /api/operator-data"

/**
 * Static text for the mutation schema's refinements, keyed by field pattern (array indexes as
 * "*"; "body" is the request body itself). Never a submitted value.
 */
const MUTATION_RULES: Readonly<Record<string, string>> = Object.freeze({
	"frequency.name": "1 to 128 characters after trimming, no control characters",
	"frequency.group":
		"1 to 64 characters after trimming, no control characters; omit it for no group",
	"frequency.bandwidthHz": "0 for mode raw, positive for every other mode",
	"frequency.tone": '{ "kind": "none" } unless mode is "nfm"',
	savedFrequencyId:
		'a saved frequency id from the snapshot; required with command "open-saved-frequency"',
	body: "set and/or reset with at least one key; reset keys distinct and not also in set",
})

/** Field-level overrides where the schema text alone would mislead. */
const MUTATION_EXPECTED: Readonly<Record<string, string>> = Object.freeze({
	expected: EXPECTED_TOKEN_TEXT,
	"expected.storeId":
		"string (uuid): snapshot.storeId of GET /api/operator-data",
	"expected.revision":
		"integer (0 or more): snapshot.revision of GET /api/operator-data",
})

function parse<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	value: unknown,
	describe?: z.ZodTypeAny,
): T {
	const result = schema.safeParse(value)
	if (!result.success) {
		const quota = result.error.issues.some(
			issue =>
				(issue.code === "too_big" && issue.type === "array") ||
				(issue.code === "custom" && issue.params?.["quota"] === true),
		)
		if (quota) throw new OperatorDataError("OPERATOR_DATA_QUOTA")
		throw new OperatorDataError(
			"OPERATOR_DATA_INVALID",
			undefined,
			describe
				? zodValidationFields(result.error, describe, {
						expected: MUTATION_EXPECTED,
						rules: MUTATION_RULES,
					})
				: undefined,
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
		throw new OperatorDataError(
			"OPERATOR_DATA_PRECONDITION_REQUIRED",
			undefined,
			[{ field: "expected", expected: `required; ${EXPECTED_TOKEN_TEXT}` }],
		)
	const mutation = parse(mutationSchema, value, mutationSchema)
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
