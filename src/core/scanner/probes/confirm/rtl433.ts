/** rtl_433 confirm interpreter (spec § 6.4): model + id with a checksum/MIC field, seen twice. */
import { z } from "zod"
import type { DecodeEvidence } from "../../types.js"
import { evidenceBase } from "./double-match.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"

const DeviceSchema = z
	.object({
		model: z.string().min(1),
		id: z.union([z.number(), z.string().min(1)]),
		mic: z.string().min(1),
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
