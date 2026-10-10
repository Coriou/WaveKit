/** direwolf confirm interpreter (spec § 6.4): direwolf emits only FCS-valid frames; one frame confirms. */
import { z } from "zod"
import type { DecodeEvidence } from "../../types.js"
import { evidenceBase } from "./double-match.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"

const FrameSchema = z.object({ source: z.string() }).passthrough()

export function interpretDirewolf(
	out: DecoderOutputLike,
	state: InterpreterState,
): DecodeEvidence[] {
	if (out.type !== "aprs") return []
	const parsed = FrameSchema.safeParse(out.data)
	if (!parsed.success) return []
	const call = parsed.data.source.trim().toUpperCase()
	if (call === "") return []
	// every FCS-valid frame is evidence; the first one accepts the callsign
	state.match.markAccepted("aprs:call", call)
	return [
		{
			...evidenceBase(state, out.timestamp.getTime()),
			protocol: "aprs",
			identity: { kind: "aprs-call", value: call },
			metadata: { callsigns: [call] },
		},
	]
}
