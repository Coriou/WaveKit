/** Meshtastic LoRa ambient interpreter (WG7 req 1.3): RF packets only, `!%08x` node identity. */
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"
import { ambientEvidence, asRecord, nearTarget } from "./ambient-decode.js"
import type { AmbientDecode, AmbientInterpretCtx } from "./ambient-decode.js"

function nodeOf(raw: unknown): string | undefined {
	if (
		typeof raw !== "number" ||
		!Number.isInteger(raw) ||
		raw < 0 ||
		raw > 0xffffffff
	)
		return undefined
	return `!${(raw >>> 0).toString(16).padStart(8, "0")}`
}

export function interpretMeshtastic(
	out: DecoderOutputLike,
	state: InterpreterState,
	ctx: AmbientInterpretCtx,
): AmbientDecode[] {
	if (out.type !== "meshtastic") return []
	const data = asRecord(out.data)
	if (data === undefined) return []
	// a packet forwarded via MQTT was not heard on this antenna: no evidence at all
	if (data["viaMqtt"] === true) return []
	// MeshtasticPacket.frequency is the decoder's tuned frequency in Hz
	const hz = data["frequency"]
	if (typeof hz !== "number" || !Number.isFinite(hz) || hz <= 0) return []
	if (!nearTarget(hz, ctx.targetsHz)) return []
	return ambientEvidence(state, out.timestamp, hz, "lora", true, {
		key: "lora:node",
		kind: "lora-node",
		value: nodeOf(data["from"]),
	})
}
