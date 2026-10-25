/** rtl_433 confirm interpreter (spec § 6.4): model + id with a checksum/MIC field, seen twice. */
import { z } from "zod"
import type { DecodeEvidence } from "../../types.js"
import { evidenceBase } from "./double-match.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"

/**
 * Longest model name accepted. rtl_433 25.12 model names are at most about
 * 40 characters; 128 leaves headroom for future names while keeping the
 * identity value (model + ":" + id) at most 128 + 1 + 64 = 193 characters.
 * Anything longer is not an rtl_433 model: no evidence, the discovery stays
 * unidentified.
 */
export const RTL433_MODEL_MAX_CHARS = 128
/** Longest string id or mic accepted (rtl_433 ids are short numbers or hex). */
export const RTL433_FIELD_MAX_CHARS = 64

const DeviceSchema = z
	.object({
		model: z
			.string()
			.min(1)
			.max(RTL433_MODEL_MAX_CHARS)
			.regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/),
		id: z.union([
			z.number().finite(),
			z.string().min(1).max(RTL433_FIELD_MAX_CHARS),
		]),
		mic: z.string().min(1).max(RTL433_FIELD_MAX_CHARS),
	})
	.passthrough()

export function interpretRtl433(
	out: DecoderOutputLike,
	state: InterpreterState,
): DecodeEvidence[] {
	if (out.type !== "signal") return []
	const parsed = DeviceSchema.safeParse(out.data)
	if (!parsed.success) return []
	const value = `${parsed.data.model}:${String(parsed.data.id)}`
	// accepted on the second checksummed decode; every later checksummed decode is evidence again
	if (
		!state.match.isAccepted("ism:device", value) &&
		!state.match.accept("ism:device", value, true)
	)
		return []
	return [
		{
			...evidenceBase(state, out.timestamp.getTime()),
			protocol: "ism",
			identity: { kind: "ism-model", value },
			metadata: { ismModels: [parsed.data.model] },
		},
	]
}
