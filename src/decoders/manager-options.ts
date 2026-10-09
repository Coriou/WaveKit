/**
 * Builds DecoderManager options from application config, so YAML `health`
 * settings (idleTimeout, checkInterval) and the resolved band region
 * actually reach the manager.
 */

import type { HealthConfig } from "../config.js"
import type { DecoderBandRegion } from "./band-region.js"
import type { DecoderManagerConfig } from "./manager.js"

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
