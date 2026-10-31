/**
 * The replay verdict of one acarsdec or dumpvdl2 output line: the evidence a replayed capture
 * centred at `targetHz` gives, attributed at its raster channel (replayChannelHz). One owner for
 * the probe pool and the offline snapshot decoder (scripts/decode-snapshot.ts), so both judge a
 * line the same way. Only CRC-checked content proves (interpretAcarsReplay, interpretVdl2Replay).
 */
import type { DecodeEvidence } from "../types.js"
import { replayChannelHz } from "../replay-channel.js"
import { interpretAcarsReplay } from "./confirm/acars.js"
import type {
	DecoderOutputLike,
	InterpreterState,
} from "./confirm/double-match.js"
import { interpretVdl2Replay } from "./confirm/vdl2.js"

export type RasterReplayDecoder = "acarsdec" | "dumpvdl2"

export function interpretRasterReplay(
	decoderType: RasterReplayDecoder,
	out: DecoderOutputLike,
	state: InterpreterState,
	targetHz: number,
): DecodeEvidence[] {
	if (decoderType === "acarsdec")
		return interpretAcarsReplay(out, state, replayChannelHz("acars", targetHz))
	return interpretVdl2Replay(out, state, replayChannelHz("vdl2", targetHz))
}
