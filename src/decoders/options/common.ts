import { z } from "zod"

/** A decimal number written as text (YAML `"12"`, `"-0.5"`). */
export const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/
/** A non-negative integer written as text (YAML `"1"`, `"30003"`). */
export const INTEGER_TEXT = /^\d+$/

/**
 * A number, or the same number written as text, for keys the adapter only turns
 * into a command line argument (String(), template literal, toString()), where a
 * numeric string produces the same argument. Text must also satisfy the number
 * schema (range, integer, finite) once read as a number.
 */
export function numberOrText(
	schema: z.ZodNumber,
	pattern: RegExp = DECIMAL_TEXT,
): z.ZodUnion<[z.ZodNumber, z.ZodEffects<z.ZodString>]> {
	return z.union([
		schema,
		z
			.string()
			.regex(pattern)
			.refine(text => schema.safeParse(Number(text)).success),
	])
}
