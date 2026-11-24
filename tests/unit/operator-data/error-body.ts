/**
 * Reads an operator-data error body: `fields` (on a 400 or 428) is checked on its own, the rest
 * against the strict public error DTO. Works whether or not the DTO schema lists `fields`.
 */
import { z } from "zod"
import {
	operatorDataErrorDtoSchema,
	type OperatorDataErrorDto,
} from "@wavekit/api-types"

const fieldsSchema = z
	.array(z.object({ field: z.string(), expected: z.string() }).strict())
	.min(1)
	.max(8)

export type ParsedErrorBody = OperatorDataErrorDto & {
	fields?: { field: string; expected: string }[]
}

export function parseErrorBody(value: unknown): ParsedErrorBody {
	const record = z.record(z.unknown()).parse(value)
	const { fields, ...rest } = record
	const dto = operatorDataErrorDtoSchema.parse(rest)
	if (fields === undefined) return dto
	if (
		dto.code !== "OPERATOR_DATA_INVALID" &&
		dto.code !== "OPERATOR_DATA_PRECONDITION_REQUIRED"
	)
		throw new Error(`fields on ${dto.code}`)
	return { ...dto, fields: fieldsSchema.parse(fields) }
}
