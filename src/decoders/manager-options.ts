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
import type {
	ActivityEpoch,
	ChannelActivityPort,
} from "./enablement/activity-contract.js"
import type { ActivityPolicy } from "./enablement/activity-plan.js"

/**
 * Activity-ranked decoder channels (Stage 1). Absent: the planner keeps
 * today's eligibility, order and caps.
 */
export interface DecoderActivityOptions {
	port: ChannelActivityPort
	/** The spectrum epoch of a source; null: that source is unranked (nearest order). */
	epochOf: (sourceId: string) => ActivityEpoch | null
	policy: ActivityPolicy
	/** The one monotonic clock of snapshots, dwell, moves and deadlines (default performance.now). */
	monoNow?: () => number
}

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
	activity?: DecoderActivityOptions
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
