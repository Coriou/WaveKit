/** acarsdec ambient interpreter (WG7 req 1.3): frequency in Hz, `error === 0`, tail identity. */
import type { DecodeEvidence } from "../../types.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"
import {
	acceptAmbient,
	asRecord,
	interpretWith,
	nearTarget,
} from "./ambient-decode.js"
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

/**
 * A replayed IQ capture of one ACARS channel (acarsdec reading the capture's AM audio, so it
 * reports no frequency of its own: 0 or none). ONE block with acarsdec `error` 0 (its framing,
 * parity and CRC-16 all valid, no bit corrected) is the decode, at the capture's channel: a
 * replay holds at most 4 s and pairs identities only within itself, so two blocks of one
 * aircraft almost never fall in one capture. Any block with errors, a malformed one, or one
 * without a valid registration is no identity. Live and ambient decodes keep the two-decode rule.
 */
export function interpretAcarsReplay(
	out: DecoderOutputLike,
	state: InterpreterState,
	channelHz: number,
): DecodeEvidence[] {
	if (!Number.isFinite(channelHz) || channelHz <= 0) return []
	const data = asRecord(out.data)
	if (data === undefined) return []
	// Only an error count acarsdec printed itself counts (the adapter defaults a missing one to 0).
	if (data["errorKnown"] !== true) return []
	// acarsdec reading audio reports frequency 0: the channel is the capture's.
	const { frequency, ...rest } = data
	const sanitised =
		frequency === 0 || frequency === undefined ? rest : { ...rest, frequency }
	const parsed = parseAcars(
		{ ...out, data: sanitised },
		{ targetsHz: [channelHz] },
	)
	if (!parsed || !parsed.crcClean) return []
	const value = parsed.identity.value
	if (value === undefined) return []
	state.match.markAccepted(parsed.identity.key, value)
	return acceptAmbient(state, parsed).map(({ hz: _hz, ...ev }) => ev)
}
