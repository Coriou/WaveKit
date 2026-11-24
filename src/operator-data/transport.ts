import { effectivePreferences } from "./domain.js"
import {
	MAX_VALIDATION_FIELDS,
	type ValidationField,
} from "../api/validation-errors.js"
import {
	EXPECTED_TOKEN_TEXT,
	OPERATOR_DATA_LIMITS,
	OperatorDataError,
	expectedTokenSchema,
	uuidSchema,
	validateSnapshot,
} from "./schema.js"
import type {
	ExpectedToken,
	OperatorDataErrorCode,
	OperatorDataSnapshot,
} from "./schema.js"
import type { OperatorDataMutationResult } from "./service.js"

import type {
	OperatorDataReadDto,
	OperatorDataWriteDto,
	OperatorDataErrorDto,
} from "@wavekit/api-types"
export type {
	OperatorDataReadDto,
	OperatorDataWriteDto,
	OperatorDataErrorDto,
} from "@wavekit/api-types"

/** Full replacement state, suitable for the existing single synchronous commit sink.
 * Tone selection describes stored intent only, not observed tones or RF support.
 */
export function toOperatorDataReadDto(
	snapshot: OperatorDataSnapshot,
): OperatorDataReadDto {
	const detached = validateSnapshot(snapshot)
	const dto: OperatorDataReadDto = {
		snapshot: detached,
		preferences: effectivePreferences(detached),
		capabilities: {
			toneSelection: true,
			toneDetection: false,
			toneSquelch: false,
		},
		limits: { ...OPERATOR_DATA_LIMITS },
	}
	// Pure compact DTO bound only; mounts must measure envelope and slow-reader bounds.
	if (Buffer.byteLength(JSON.stringify(dto), "utf8") > 1024 * 1024)
		throw new OperatorDataError("OPERATOR_DATA_QUOTA")
	return dto
}

export function toOperatorDataWriteDto(
	result: OperatorDataMutationResult,
): OperatorDataWriteDto {
	const snapshot = validateSnapshot(result.snapshot)
	if (!Object.hasOwn(result, "savedFrequencyId")) return { snapshot }
	const id = uuidSchema.safeParse(result.savedFrequencyId)
	if (
		!id.success ||
		!snapshot.savedFrequencies.some(frequency => frequency.id === id.data)
	)
		throw new OperatorDataError("OPERATOR_DATA_INVALID")
	return { snapshot, savedFrequencyId: id.data }
}

function knownCode(code: unknown): code is OperatorDataErrorCode {
	switch (code) {
		case "OPERATOR_DATA_INVALID":
		case "OPERATOR_DATA_PRECONDITION_REQUIRED":
		case "OPERATOR_DATA_CONFLICT":
		case "OPERATOR_DATA_NOT_FOUND":
		case "OPERATOR_DATA_QUOTA":
		case "OPERATOR_DATA_BUSY":
		case "OPERATOR_DATA_UNAVAILABLE":
			return true
		default:
			return false
	}
}

/** An error body: the canonical DTO, whose `fields` (400 and 428 only) has the shape of every other route's 400. */
export type OperatorDataErrorBody = OperatorDataErrorDto

/** A 400 whose cause has no field of its own (an internal check) still names what to send. */
export const INVALID_FALLBACK: Readonly<ValidationField> = {
	field: "body",
	expected:
		"a valid operator-data request: see docs/API.md, operator data, for each route's body",
}

/** Copies only well-formed, bounded fields; anything else drops to the fallback. */
function safeFields(fields: unknown): ValidationField[] {
	if (!Array.isArray(fields)) return []
	const out: ValidationField[] = []
	const items: unknown[] = fields.slice(0, MAX_VALIDATION_FIELDS)
	for (const item of items) {
		if (typeof item !== "object" || item === null) return []
		const field: unknown = Reflect.get(item, "field")
		const expected: unknown = Reflect.get(item, "expected")
		if (
			typeof field !== "string" ||
			typeof expected !== "string" ||
			field.length > 128 ||
			expected.length > 512
		)
			return []
		out.push({ field, expected })
	}
	return out
}

/** Future mounts must explicitly send this status/body: the global WaveKitError
 * handler uses 400. No exception object or internal delivery outcome is serialized;
 * `fields` holds static schema text only.
 */
export function toOperatorDataErrorResponse(error: unknown): {
	statusCode: number
	body: OperatorDataErrorBody
} {
	let code: OperatorDataErrorCode = "OPERATOR_DATA_UNAVAILABLE"
	let current: ExpectedToken | undefined
	let fields: ValidationField[] = []
	try {
		if (error instanceof OperatorDataError) {
			const candidate: unknown = error.code
			if (knownCode(candidate)) code = candidate
			if (code === "OPERATOR_DATA_CONFLICT") {
				const token = expectedTokenSchema.safeParse(error.current)
				if (token.success) current = token.data
			}
			if (
				code === "OPERATOR_DATA_INVALID" ||
				code === "OPERATOR_DATA_PRECONDITION_REQUIRED"
			)
				fields = safeFields(error.fields)
		}
	} catch {
		// Even malformed internal errors (including throwing accessors) stay generic.
		code = "OPERATOR_DATA_UNAVAILABLE"
		current = undefined
		fields = []
	}
	if (code === "OPERATOR_DATA_INVALID" && fields.length === 0)
		fields = [{ ...INVALID_FALLBACK }]
	if (code === "OPERATOR_DATA_PRECONDITION_REQUIRED" && fields.length === 0)
		fields = [
			{ field: "expected", expected: `required; ${EXPECTED_TOKEN_TEXT}` },
		]
	const canonical = new OperatorDataError(code)
	return {
		statusCode: canonical.statusCode,
		body: {
			error: "OperatorDataError",
			code,
			message: canonical.message,
			...(current ? { details: { current } } : {}),
			...(fields.length > 0 ? { fields } : {}),
		},
	}
}
