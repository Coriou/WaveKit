/** dumpvdl2 ambient interpreter (WG7 req 1.3): frequency in Hz, source address identity. */
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"
import { ambientEvidence, asRecord, nearTarget } from "./ambient-decode.js"
import type { AmbientDecode, AmbientInterpretCtx } from "./ambient-decode.js"

/** 24-bit address as 6 upper-case hex digits (string, or integer 0..0xFFFFFF). */
function addrOf(raw: unknown): string | undefined {
	if (typeof raw === "string") {
		if (raw.length > 16) return undefined
		const v = raw.trim().toUpperCase()
		return /^[0-9A-F]{6}$/.test(v) ? v : undefined
	}
	if (
		typeof raw === "number" &&
		Number.isInteger(raw) &&
		raw >= 0 &&
		raw <= 0xffffff
	)
		return raw.toString(16).toUpperCase().padStart(6, "0")
	return undefined
}

export function interpretVdl2(
	out: DecoderOutputLike,
	state: InterpreterState,
	ctx: AmbientInterpretCtx,
): AmbientDecode[] {
	if (out.type !== "vdl2") return []
	const data = asRecord(out.data)
	if (data === undefined) return []
	// VDL2Message.frequency is Hz (dumpvdl2's `freq`; the adapter writes 0 when absent)
	const hz = data["frequency"]
	if (typeof hz !== "number" || !Number.isFinite(hz) || hz <= 0) return []
	if (!nearTarget(hz, ctx.targetsHz)) return []
	// dumpvdl2 emits only frames that passed the FCS
	return ambientEvidence(state, out.timestamp, hz, "vdl2", true, {
		key: "vdl2:addr",
		kind: "vdl2-addr",
		value: addrOf(data["fromaddr"]) ?? addrOf(data["icao"]),
	})
}
