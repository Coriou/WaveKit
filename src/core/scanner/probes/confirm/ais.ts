/** AIS-catcher ambient interpreter (WG7 req 1.3): channel A/B frequency, MMSI identity. */
import { SCANNER_AIS_CHANNEL_HZ } from "@wavekit/api-types"
import type { DecoderOutputLike } from "./double-match.js"
import { asRecord, interpretWith, nearTarget } from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

/**
 * MMSI as 9 digits. `ShipData.mmsi` is a string; a number is accepted only as an integer in
 * 0..999 999 999 and rendered zero-padded to 9 digits. Anything else has no identity.
 */
function mmsiOf(raw: unknown): string | undefined {
	if (typeof raw === "string") return /^\d{9}$/.test(raw) ? raw : undefined
	if (
		typeof raw === "number" &&
		Number.isInteger(raw) &&
		raw >= 0 &&
		raw <= 999_999_999
	)
		return String(raw).padStart(9, "0")
	return undefined
}

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseAis(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "ship") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	const channel = data["channel"]
	// the adapter normalises the channel to "A" | "B"; no or unknown channel is no evidence
	if (channel !== "A" && channel !== "B") return null
	const hz = SCANNER_AIS_CHANNEL_HZ[channel]
	if (!nearTarget(hz, ctx.targetsHz)) return null
	// the adapter drops sentences that fail the checksum
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "ais",
		crcClean: true,
		identity: {
			key: "ais:mmsi",
			kind: "ais-mmsi",
			value: mmsiOf(data["mmsi"]),
		},
	}
}

export const interpretAis = interpretWith(parseAis)
