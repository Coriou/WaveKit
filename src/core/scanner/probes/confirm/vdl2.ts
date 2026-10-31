/** dumpvdl2 ambient interpreter (WG7 req 1.3): frequency in Hz, source address identity. */
import type { DecodeEvidence } from "../../types.js"
import type { DecoderOutputLike, InterpreterState } from "./double-match.js"
import {
	acceptAmbient,
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

/**
 * A 24-bit VDL2 address one replayed frame may stand on: six hex digits, never 000000 (no
 * station) nor FFFFFF (the all-stations broadcast address, a destination only).
 */
export function plausibleVdl2Address(value: string): boolean {
	return /^[0-9A-F]{6}$/.test(value) && value !== "000000" && value !== "FFFFFF"
}

/**
 * A replayed IQ capture of one VDL2 channel (dumpvdl2 given the capture's channel, so every frame
 * it prints names that channel). ONE frame proves, as one clean block does for ACARS
 * (`interpretAcarsReplay`): dumpvdl2 prints a frame only after its burst header CRC, its
 * Reed-Solomon FEC and the AVLC frame check sequence (CRC-16 over the whole frame) all passed, so
 * a printed source address is checked content as strong as an ACARS block's CRC-16. A replay
 * holds at most 4 s (IQ_CAPTURE_MAX_MS) and pairs identities only within itself; one VDL2 burst
 * lasts tens of ms and an aircraft rarely sends two in 4 s, so the two-frame rule would leave a
 * replay almost never proven. An unclean frame (`vdl2FrameClean`: an embedded ACARS block that
 * failed its CRC) or one without a plausible address is evidence without identity (the replay
 * verdict reads it: crc-errors or timeout); a frame at another channel is nothing. Live and
 * ambient decodes keep the two-frame rule.
 */
export function interpretVdl2Replay(
	out: DecoderOutputLike,
	state: InterpreterState,
	channelHz: number,
): DecodeEvidence[] {
	if (!Number.isFinite(channelHz) || channelHz <= 0) return []
	const parsed = parseVdl2(out, { targetsHz: [channelHz], channelHz })
	if (!parsed) return []
	const value = parsed.identity.value
	// Unclean or address-less output still counts as output (the replay's verdict), never as an identity.
	const proves =
		parsed.crcClean && value !== undefined && plausibleVdl2Address(value)
	if (proves) state.match.markAccepted(parsed.identity.key, value)
	const evidence = proves
		? parsed
		: { ...parsed, identity: { ...parsed.identity, value: undefined } }
	return acceptAmbient(state, evidence).map(({ hz: _hz, ...ev }) => ev)
}
