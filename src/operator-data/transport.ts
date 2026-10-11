import { effectivePreferences } from "./domain.js"
import {
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

/** Future mounts must explicitly send this status/body: the global WaveKitError
 * handler uses 400. No exception object or internal delivery outcome is serialized.
 */
export function toOperatorDataErrorResponse(error: unknown): {
	statusCode: number
	body: OperatorDataErrorDto
} {
	let code: OperatorDataErrorCode = "OPERATOR_DATA_UNAVAILABLE"
	let current: ExpectedToken | undefined
	try {
		if (error instanceof OperatorDataError) {
			const candidate: unknown = error.code
			if (knownCode(candidate)) code = candidate
			if (code === "OPERATOR_DATA_CONFLICT") {
				const token = expectedTokenSchema.safeParse(error.current)
				if (token.success) current = token.data
			}
		}
	} catch {
		// Even malformed internal errors (including throwing accessors) stay generic.
		code = "OPERATOR_DATA_UNAVAILABLE"
		current = undefined
	}
	const canonical = new OperatorDataError(code)
	return {
		statusCode: canonical.statusCode,
		body: {
			error: "OperatorDataError",
			code,
			message: canonical.message,
			...(current ? { details: { current } } : {}),
		},
	}
}
