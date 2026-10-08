/**
 * Source status serialization shared by REST (GET /api/sources) and the
 * `source:status` WebSocket event so both carry identical fields.
 */

import type {
	DecoderAssignment as ApiDecoderAssignment,
	ExtendedSourceStatus as ApiExtendedSourceStatus,
	SourceCaps as ApiSourceCaps,
} from "@wavekit/api-types"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import type { FanoutTelemetryProvider } from "../../core/source-fanout-router.js"

export type SourceStatusReader = Pick<
	SourceManager,
	"getSourceAssignments" | "isSourceAvailable"
>

export function toApiSourceCaps(caps: SourceStatus["caps"]): ApiSourceCaps {
	return {
		kind: caps.kind,
		sampleRate: caps.sampleRate,
		format: caps.format,
		exclusive: caps.exclusive,
		...(caps.channels !== undefined ? { channels: caps.channels } : {}),
		...(caps.centerFreq !== undefined ? { centerFreq: caps.centerFreq } : {}),
	}
}

/** Counts fanout branches per source; empty when telemetry is unavailable. */
export function countConsumersBySource(
	fanout?: Pick<FanoutTelemetryProvider, "getTelemetrySnapshot"> | undefined,
): Map<string, number> {
	const counts = new Map<string, number>()
	if (!fanout) return counts
	for (const branch of fanout.getTelemetrySnapshot().branches) {
		if (!branch.sourceId) continue
		counts.set(branch.sourceId, (counts.get(branch.sourceId) ?? 0) + 1)
	}
	return counts
}

export function toApiExtendedSourceStatus(
	status: SourceStatus,
	sourceManager: SourceStatusReader,
	consumersBySourceId: ReadonlyMap<string, number>,
): ApiExtendedSourceStatus {
	const assignments: ApiDecoderAssignment[] = sourceManager
		.getSourceAssignments(status.id)
		.map(assignment => ({
			...assignment,
			assignedAt: assignment.assignedAt.toISOString(),
		}))

	return {
		id: status.id,
		connected: status.connected,
		activity: status.activity,
		bytesReceived: status.bytesReceived,
		dataRate: status.dataRate,
		reconnectAttempts: status.reconnectAttempts,
		caps: toApiSourceCaps(status.caps),
		assignments,
		consumers: consumersBySourceId.get(status.id) ?? assignments.length,
		available: sourceManager.isSourceAvailable(status.id),
		...(status.type !== undefined ? { type: status.type } : {}),
		...(status.url !== undefined ? { url: status.url } : {}),
		...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
	}
}
