/**
 * Spec § 9 CPU estimates in cores. Task 43 replaces the numbers with the channelizer capacity
 * gate's measurements; the probe pool (Task 34) and the preview use only these exports.
 */
export const CPU_COST = {
	engine: 0.08,
	offsetProbe: 0.5,
	channelBase: 0.05,
	decoder: {
		"dsd-fme": 0.045,
		"multimon-ng": 0.03,
		direwolf: 0.05,
		rtl433: 0.1,
	},
} as const

const UNKNOWN_DECODER_CORES = 0.1

export function probeCores(
	transport: "offset" | "channel",
	decoderType: string,
): number {
	if (transport === "offset") return CPU_COST.offsetProbe
	const decoders: Readonly<Record<string, number>> = CPU_COST.decoder
	return CPU_COST.channelBase + (decoders[decoderType] ?? UNKNOWN_DECODER_CORES)
}
