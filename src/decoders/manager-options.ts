/**
 * Builds DecoderManager options from application config, so YAML `health`
 * settings (idleTimeout, checkInterval) and the resolved band region
 * actually reach the manager.
 */

import type { HealthConfig } from "../config.js"
import type { DecoderBandRegion } from "./band-region.js"
import type { DecoderManagerConfig } from "./manager.js"
import type { DecoderConfig } from "./types.js"
import type {
	PlacementPlanner,
	ResolvedMode,
	PlannerVfo,
	BandplanChannelLookup,
	EfficiencyGate,
} from "./enablement/contract.js"

export interface DecoderEnablementOptions {
	planner: PlacementPlanner
	resolveMode: (id: string) => ResolvedMode
	isCatalogue: (config: DecoderConfig) => boolean
	unavailable: (id: string) => boolean
	recheckAvailable: (id: string) => Promise<boolean>
	vfo: () => PlannerVfo | null
	bandplanChannels: BandplanChannelLookup
	maxBandplanChannels: number
	gate?: EfficiencyGate
}

export function createDecoderManagerOptions(
	health: HealthConfig | undefined,
	bandRegion?: DecoderBandRegion,
): Partial<DecoderManagerConfig> {
	return {
		restartDelay: 2000,
		maxRestartDelay: 30000,
		maxRestarts: 0, // Unlimited restarts
		...(health
			? {
					idleTimeout: health.idleTimeout,
					healthCheckInterval: health.checkInterval,
					...(health.faultAfterFailures !== undefined
						? { faultAfterFailures: health.faultAfterFailures }
						: {}),
					...(health.bandSuspension !== undefined
						? { bandSuspension: health.bandSuspension }
						: {}),
				}
			: {}),
		...(bandRegion ? { bandRegion: { ...bandRegion } } : {}),
	}
}
