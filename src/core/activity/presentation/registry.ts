import type { DecoderOutput } from "../../../decoders/types.js"
import type { DecodePresentation } from "../types.js"
import { presentAcars, presentVdl2 } from "./acars-vdl2.js"
import { presentAircraft } from "./aircraft.js"
import { presentAprs } from "./aprs.js"
import { presentVoice } from "./digital-voice.js"
import { presentMeshtastic } from "./meshtastic.js"
import { presentTextual } from "./pager.js"
import { presentSensor } from "./sensor.js"
import { presentShip } from "./ship.js"

/**
 * Pure presentation of one decoder output. Unknown types and payloads that
 * fail the Zod object boundary return undefined. A mapper that throws is
 * swallowed: the ingress then stores the reception without a presentation.
 * `decoderType` is accepted and ignored; protocol is never inferred from it.
 */
export function presentDecoderOutput(
	output: DecoderOutput,
	decoderType: string | undefined,
): DecodePresentation | undefined {
	void decoderType
	try {
		switch (output.type) {
			case "aircraft":
				return presentAircraft(output.data)
			case "ship":
				return presentShip(output.data)
			case "aprs":
				return presentAprs(output.data)
			case "meshtastic":
				return presentMeshtastic(output.data)
			case "acars":
				return presentAcars(output.data)
			case "vdl2":
				return presentVdl2(output.data)
			case "message":
			case "decode":
				return presentTextual(output.type, output.data)
			case "call":
			case "call_start":
			case "call_end":
				return presentVoice(output.data)
			case "signal":
				return presentSensor(output.data)
			default:
				return undefined
		}
	} catch {
		return undefined
	}
}
