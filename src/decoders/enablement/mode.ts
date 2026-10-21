import type { DecoderMode } from "@wavekit/api-types"
import type { ResolvedMode } from "./contract.js"

export function resolveDecoderMode(input: {
	settingsMode?: DecoderMode | undefined
	settingsEnabled?: boolean | undefined
	configMode?: DecoderMode | undefined
	configEnabled: boolean
	configBandSuspension?: boolean | undefined
	apiBandSuspension?: boolean | undefined
}): ResolvedMode {
	if (input.settingsMode !== undefined)
		return { mode: input.settingsMode, source: "settings" }
	if (input.settingsEnabled === false)
		return { mode: "off", source: "settings" }
	if (input.configMode !== undefined)
		return { mode: input.configMode, source: "config" }
	if (!input.configEnabled) return { mode: "off", source: "legacy-enabled" }
	if (input.configBandSuspension === false || input.apiBandSuspension === false)
		return { mode: "always", source: "legacy-band" }
	return { mode: "auto", source: "default" }
}
