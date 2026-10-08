/**
 * Builds DecoderManager options from application config, so YAML `health`
 * settings (idleTimeout, checkInterval) actually reach the manager.
 */

import type { HealthConfig } from "../config.js"
import type { DecoderManagerConfig } from "./manager.js"

export function createDecoderManagerOptions(
	health: HealthConfig | undefined,
): Partial<DecoderManagerConfig> {
	return {
		restartDelay: 2000,
		maxRestartDelay: 30000,
		maxRestarts: 0, // Unlimited restarts
		...(health
			? {
					idleTimeout: health.idleTimeout,
					healthCheckInterval: health.checkInterval,
				}
			: {}),
	}
}
