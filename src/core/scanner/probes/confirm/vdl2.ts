/** dumpvdl2 ambient interpreter (WG7 req 1.3): frequency in Hz, source address identity. */
import type { DecoderOutputLike } from "./double-match.js"
import {
	asRecord,
	interpretWith,
	nearTarget,
	placedFrequency,
} from "./ambient-decode.js"
import type { AmbientInterpretCtx, AmbientParsed } from "./ambient-decode.js"

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

/**
 * dumpvdl2 prints only AVLC frames whose FCS (CRC-16) passed, so a printed frame's addresses are
 * checked content. An embedded ACARS message that failed its own CRC (`crcOk: false`) or that
 * dumpvdl2 flagged as an error (`error` not 0), or an embedded value that is not a plain
 * object, makes the frame unclean: a message that failed a CRC never proves.
 */
export function vdl2FrameClean(data: Record<string, unknown>): boolean {
	const acars = data["acars"]
	if (acars === undefined) return true
	const embedded = asRecord(acars)
	if (embedded === undefined) return false
	if (embedded["crcOk"] !== undefined) return false
	const error = embedded["error"]
	return error === undefined || error === 0
}

/** Pure parse step: no acceptance memory is touched (null: no evidence). */
export function parseVdl2(
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
): AmbientParsed | null {
	if (out.type !== "vdl2") return null
	const data = asRecord(out.data)
	if (data === undefined) return null
	// VDL2Message.frequency is Hz (dumpvdl2's `freq`; the adapter writes 0 when absent)
	const hz = placedFrequency(data["frequency"], ctx)
	if (typeof hz !== "number" || !Number.isFinite(hz) || hz <= 0) return null
	if (!nearTarget(hz, ctx.targetsHz)) return null
	return {
		hz,
		timestamp: out.timestamp,
		protocol: "vdl2",
		crcClean: vdl2FrameClean(data),
		identity: {
			key: "vdl2:addr",
			kind: "vdl2-addr",
			value: addrOf(data["fromaddr"]) ?? addrOf(data["icao"]),
		},
	}
}

export const interpretVdl2 = interpretWith(parseVdl2)
