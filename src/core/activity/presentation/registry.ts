import type { DecoderOutput } from "../../../decoders/types.js"
import type { DecodeEnvelopeContext, DecodePresentation } from "../types.js"
import { presentAcars, presentVdl2 } from "./acars-vdl2.js"
import { presentAircraft } from "./aircraft.js"
import { presentAprs } from "./aprs.js"
import { fitRowBudget } from "./budget.js"
import { presentVoice } from "./digital-voice.js"
import { presentMeshtastic } from "./meshtastic.js"
import { presentTextual } from "./pager.js"
import { presentSensor } from "./sensor.js"
import { presentShip } from "./ship.js"

export interface PresentationAttempt {
	presentation?: DecodePresentation
	/** Set when a mapper throws. The presentation is then omitted. */
	error?: unknown
}

function dispatch(output: DecoderOutput): DecodePresentation | undefined {
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
}

/**
 * Presentation plus a thrown-mapper signal for ingress. Zod failure is
 * `presentation: undefined` and no error. `decoderType` is ignored.
 */
export function presentDecoderOutputResult(
	output: DecoderOutput,
	decoderType: string | undefined,
	context?: DecodeEnvelopeContext,
): PresentationAttempt {
	void decoderType
	try {
		const view = dispatch(output)
		if (view === undefined) return {}
		return { presentation: fitRowBudget(output, view, context) }
	} catch (error) {
		return { error }
	}
}

/**
 * Pure presentation of one decoder output. Unknown types and payloads that
 * fail the Zod boundary return undefined. A mapper that throws is swallowed
 * here; ingress uses `presentDecoderOutputResult` so it can count that
 * failure. `decoderType` is accepted and ignored; protocol is never inferred
 * from it.
 */
export function presentDecoderOutput(
	output: DecoderOutput,
	decoderType: string | undefined,
): DecodePresentation | undefined {
	return presentDecoderOutputResult(output, decoderType).presentation
}
