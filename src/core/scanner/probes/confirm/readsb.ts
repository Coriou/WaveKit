/**
 * readsb ambient interpreter: Mode S / ADS-B at 1090 MHz, the 24-bit ICAO address as identity.
 *
 * Counts only a CRC-proven address: an SBS or JSON line (readsb writes those only from messages
 * whose CRC checked), or a Beast frame of a format carrying the address in clear (DF11, DF17,
 * DF18) whose CRC-24 remainder is 0 (`modeS.crcOk`). A Beast frame of any other format, a CRC
 * failure, a non-ICAO address (readsb's `~` prefix) or malformed data is no evidence at all.
 * The identity is accepted on the second such message from the same address (H2).
 * The decode's frequency is its placement's channel when it carries one, else 1090 MHz.
 */
import { z } from "zod"
import type { DecoderOutputLike } from "./double-match.js"
import { asRecord, interpretWith, nearTarget } from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

/** The Mode S downlink frequency (ICAO Annex 10 Vol IV): 1090 MHz. */
export const ADSB_HZ = 1_090_000_000

/** Exactly 6 hex digits; anything longer is refused before it is read. */
const IcaoSchema = z
	.string()
	.max(6)
	.regex(/^[0-9A-Fa-f]{6}$/)

const ModeSSchema = z.object({
	df: z.number().int().min(0).max(31),
	crcOk: z.boolean(),
})

const ChannelSchema = z.object({
	channelHz: z.number().finite().positive(),
})

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseReadsb(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "aircraft") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	const icao = IcaoSchema.safeParse(data["icao"])
	if (!icao.success) return null
	const modeS = data["modeS"]
	if (modeS !== undefined) {
		const frame = ModeSSchema.safeParse(modeS)
		if (!frame.success || !frame.data.crcOk) return null
	}
	const placed = ChannelSchema.safeParse(out.provenanceBinding)
	const hz = placed.success ? placed.data.channelHz : ADSB_HZ
	if (!nearTarget(hz, ctx.targetsHz)) return null
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "adsb",
		crcClean: true,
		identity: {
			key: "adsb:icao",
			kind: "icao",
			value: icao.data.toLowerCase(),
		},
	}
}

export const interpretReadsb = interpretWith(parseReadsb)
