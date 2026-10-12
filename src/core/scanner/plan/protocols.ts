import type { FreqRange } from "../../spectrum/types.js"
import type { Hop, NormalisedJobSpec, ScannerProtocol } from "../types.js"

type ProtocolSpec = Pick<
	NormalisedJobSpec,
	"ranges" | "protocols" | "provenance"
>

/** Normalised protocols also contain range defaults; only operator provenance is an override. */
function protocolsInRange(
	spec: ProtocolSpec,
	covered: FreqRange,
): ScannerProtocol[] {
	if (spec.provenance["protocols"] === "operator") return [...spec.protocols]
	return [
		...new Set(
			spec.ranges
				.filter(r => r.endHz >= covered.startHz && r.startHz <= covered.endHz)
				.flatMap(r => r.protocols ?? []),
		),
	]
}

/** Runtime priors and probes use the ranges covering the actual candidate frequency. */
export function protocolsForFrequency(
	spec: ProtocolSpec,
	frequencyHz: number,
): ScannerProtocol[] {
	return protocolsInRange(spec, { startHz: frequencyHz, endHz: frequencyHz })
}

/** Preview combines the same range policy across the hop's usable window. */
export function protocolsForHop(
	spec: ProtocolSpec,
	hop: Pick<Hop, "covered">,
): ScannerProtocol[] {
	return protocolsInRange(spec, hop.covered)
}
