/** acarsdec ambient interpreter (WG7 req 1.3): frequency in Hz, `error === 0`, tail identity. */
import type { DecoderOutputLike } from "./double-match.js"
import { asRecord, interpretWith, nearTarget } from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

const MAX_TAIL_INPUT = 32

/** Registration: leading dots stripped, trimmed, upper-cased, 1-8 of [A-Z0-9-]. */
function tailOf(raw: unknown): string | undefined {
	if (typeof raw !== "string" || raw.length > MAX_TAIL_INPUT) return undefined
	const tail = raw.trim().replace(/^\.+/, "").trim().toUpperCase()
	return /^[A-Z0-9-]{1,8}$/.test(tail) ? tail : undefined
}

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseAcars(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "acars") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	// ACARSMessage.frequency is Hz (the adapter converts acarsdec's MHz)
	const frequency = data["frequency"]
	let hz: number
	if (frequency === undefined) {
		const only = ctx.targetsHz.length === 1 ? ctx.targetsHz[0] : undefined
		if (only === undefined) return null
		hz = only
	} else if (
		typeof frequency === "number" &&
		Number.isFinite(frequency) &&
		frequency > 0
	) {
		hz = frequency
	} else return null
	if (!nearTarget(hz, ctx.targetsHz)) return null
	const error = data["error"]
	const crcClean = typeof error === "number" && error === 0
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "acars",
		crcClean: crcClean,
		identity: {
			key: "acars:reg",
			kind: "acars-reg",
			value: tailOf(data["tail"]),
		},
	}
}

export const interpretAcars = interpretWith(parseAcars)
