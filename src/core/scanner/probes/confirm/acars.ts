/** acarsdec ambient interpreter (WG7 req 1.3): frequency in Hz, `error === 0`, tail identity. */
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"
import { ambientEvidence, asRecord, nearTarget } from "./ambient-decode.js"
import type { AmbientDecode, AmbientInterpretCtx } from "./ambient-decode.js"

const MAX_TAIL_INPUT = 32

/** Registration: leading dots stripped, trimmed, upper-cased, 1-8 of [A-Z0-9-]. */
function tailOf(raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw.length > MAX_TAIL_INPUT) return undefined
	const tail = raw.trim().replace(/^\.+/, "").trim().toUpperCase()
	return /^[A-Z0-9-]{1,8}$/.test(tail) ? tail : undefined
}

export function interpretAcars(
	out: DecoderOutputLike,
	state: InterpreterState,
	ctx: AmbientInterpretCtx,
): AmbientDecode[] {
	if (out.type !== "acars") return []
	const data = asRecord(out.data)
	if (data === undefined) return []
	// ACARSMessage.frequency is Hz (the adapter converts acarsdec's MHz)
	const frequency = data["frequency"]
	let hz: number
	if (frequency === undefined) {
		const only = ctx.targetsHz.length === 1 ? ctx.targetsHz[0] : undefined
		if (only === undefined) return []
		hz = only
	} else if (
		typeof frequency === "number" &&
		Number.isFinite(frequency) &&
		frequency > 0
	) {
		hz = frequency
	} else return []
	if (!nearTarget(hz, ctx.targetsHz)) return []
	const error = data["error"]
	const crcClean = typeof error === "number" && error === 0
	return ambientEvidence(state, out.timestamp, hz, "acars", crcClean, {
		key: "acars:reg",
		kind: "acars-reg",
		value: tailOf(data["tail"]),
	})
}
