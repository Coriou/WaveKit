/** Meshtastic LoRa ambient interpreter (WG7 req 1.3): RF packets only, `!%08x` node identity. */
import type { DecoderOutputLike } from "./double-match.js"
import { asRecord, interpretWith, nearTarget } from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

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

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseMeshtastic(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "meshtastic") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	// a packet forwarded via MQTT was not heard on this antenna: no evidence at all
	// (fail closed: only an absent or exactly-false flag is RF)
	const viaMqtt = data["viaMqtt"]
	if (viaMqtt !== undefined && viaMqtt !== false) return null
	// MeshtasticPacket.frequency is the decoder's tuned frequency in Hz
	const hz = data["frequency"]
	if (typeof hz !== "number" || !Number.isFinite(hz) || hz <= 0) return null
	if (!nearTarget(hz, ctx.targetsHz)) return null
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "lora",
		crcClean: true,
		identity: {
			key: "lora:node",
			kind: "lora-node",
			value: nodeOf(data["from"]),
		},
	}
}

export const interpretMeshtastic = interpretWith(parseMeshtastic)
