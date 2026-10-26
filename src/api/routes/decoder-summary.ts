import type { DecoderSummary } from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"

/** 60 seconds × 1,000 milliseconds; inclusive at the last millisecond. */
export const DECODING_WINDOW_MS = 60 * 1_000

// Precedence: crash/restart failure, suspension, recent running output, idle.
// A retained lastError alone is historical and does not mark a recovered run failed.
function healthOf(
	status: DecoderStatus,
	last: number | undefined,
	now: number,
): DecoderSummary["health"] {
	if (status.health === "faulted" || status.health === "restarting")
		return "failed"
	if (status.suspension || status.suspended) return "suspended"
	if (
		status.running &&
		last !== undefined &&
		last <= now &&
		now - last <= DECODING_WINDOW_MS
	)
		return "decoding"
	return "idle"
}

export function decoderSummary(
	status: DecoderStatus,
	now: number,
): DecoderSummary {
	const last = status.lastOutputAt?.getTime()
	// Precedence: crash/restart failure, suspension, recent running output, idle.
	// A retained lastError alone is historical and does not mark a recovered run failed.
	const health = healthOf(status, last, now)
	return {
		id: status.id,
		protocol: status.type,
		state: status.running ? "running" : "stopped",
		placements:
			status.placements !== undefined
				? status.placements
						.filter(p => p.running)
						.map(p => ({
							sourceId: p.sourceId,
							frequencyHz: p.channelHz ?? null,
						}))
				: status.running
					? [
							{
								sourceId: status.sourceId ?? null,
								// Without a placement view, only a single declared target is unambiguous.
								frequencyHz:
									status.targetFrequenciesHz?.length === 1
										? status.targetFrequenciesHz[0]!
										: null,
							},
						]
					: [],
		eventsOut: status.stats.eventsOut,
		lastOutputAt: status.lastOutputAt?.toISOString() ?? null,
		suspensionReason: status.suspension?.reasonCode ?? null,
		health,
	}
}

export const decoderSummaryRoutes: FastifyPluginAsync<{
	decoderManager: Pick<DecoderManager, "getAllStatus">
}> = async (app, { decoderManager }) => {
	app.get(
		"/api/decoders/summary",
		{
			schema: {
				summary: "Summarize decoder output and health",
				tags: ["decoders"],
			},
		},
		async () => {
			const now = Date.now()
			return decoderManager
				.getAllStatus()
				.map(status => decoderSummary(status, now))
		},
	)
}
