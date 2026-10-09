/**
 * Decoder status serialization shared by REST (/api/decoders) and the
 * `decoder:status` WebSocket event so both carry identical fields.
 */

import type {
	DecoderCaps as ApiDecoderCaps,
	DecoderInfo as ApiDecoderInfo,
	DecoderStatus as ApiDecoderStatus,
} from "@wavekit/api-types"
import type {
	DecoderCaps as InternalDecoderCaps,
	DecoderStatus as InternalDecoderStatus,
} from "../../decoders/types.js"
import type { DecoderRegistry } from "../../decoders/registry.js"
import { boundDecoderErrorMessage } from "../../decoders/status-fields.js"

export function toApiDecoderStatus(
	status: InternalDecoderStatus,
): ApiDecoderStatus {
	return {
		id: status.id,
		type: status.type,
		running: status.running,
		health: status.health,
		...(status.pid !== undefined ? { pid: status.pid } : {}),
		uptime: status.uptime,
		stats: status.stats,
		lastOutputAt: status.lastOutputAt
			? status.lastOutputAt.toISOString()
			: null,
		restartCount: status.restartCount,
		...(status.version !== undefined ? { version: status.version } : {}),
		// No built-in capture limits are inferred from legacy audio/IQ preferences.
		rateAssessment: status.rateAssessment ?? {
			verdict: "unknown",
			reasonCode: "unknown-requirements",
		},
		...(status.bandAssessment !== undefined
			? {
					bandAssessment: {
						...status.bandAssessment,
						...(status.bandAssessment.targetsHz
							? { targetsHz: [...status.bandAssessment.targetsHz] }
							: {}),
					},
				}
			: {}),
		...(status.sourceId !== undefined ? { sourceId: status.sourceId } : {}),
		...(status.deviceSerial !== undefined
			? { deviceSerial: status.deviceSerial }
			: {}),
		...(status.targetFrequenciesHz !== undefined
			? { targetFrequenciesHz: [...status.targetFrequenciesHz] }
			: {}),
		...(status.lastError !== undefined
			? {
					lastError: {
						kind: status.lastError.kind,
						message: boundDecoderErrorMessage(status.lastError.message),
						at: status.lastError.at.toISOString(),
					},
				}
			: {}),
		...(status.idleTimeoutMs !== undefined
			? { idleTimeoutMs: status.idleTimeoutMs }
			: {}),
		...(status.nextRestartAt !== undefined
			? { nextRestartAt: status.nextRestartAt.toISOString() }
			: {}),
		...(status.desiredRunning !== undefined
			? { desiredRunning: status.desiredRunning }
			: {}),
		...(status.suspended !== undefined ? { suspended: status.suspended } : {}),
		...(status.suspension !== undefined
			? {
					suspension: {
						reasonCode: status.suspension.reasonCode,
						since: status.suspension.since.toISOString(),
					},
				}
			: {}),
		...(status.transition !== undefined
			? { transition: status.transition }
			: {}),
	}
}

export function toApiDecoderCaps(caps: InternalDecoderCaps): ApiDecoderCaps {
	return {
		input: caps.input,
		output: caps.output,
		integrationPattern: caps.integrationPattern,
		...(caps.wantsExclusiveSource !== undefined
			? { wantsExclusiveSource: caps.wantsExclusiveSource }
			: {}),
		...(caps.preferredSampleRates !== undefined
			? { preferredSampleRates: caps.preferredSampleRates }
			: {}),
		...(caps.rateRequirements !== undefined
			? { rateRequirements: caps.rateRequirements }
			: {}),
	}
}

/** GET /api/decoders item: status plus registered capabilities when known. */
export function toApiDecoderInfo(
	status: InternalDecoderStatus,
	registry?: Pick<DecoderRegistry, "getCaps"> | undefined,
): ApiDecoderInfo {
	const caps = registry?.getCaps(status.type)
	const apiStatus = toApiDecoderStatus(status)
	return caps ? { ...apiStatus, caps: toApiDecoderCaps(caps) } : apiStatus
}
