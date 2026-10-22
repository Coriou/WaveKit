/**
 * WG12 req 7: what a scan job is doing. Pure. Settling beats holding beats a
 * parked live probe, then replay, then an open capture, else watching.
 */
import type { ScanJobPhase, ScannerProtocol } from "@wavekit/api-types"
import type { JobPhaseInput } from "./scanner-redesign-contract.js"

export interface JobProgressFields {
	phase: ScanJobPhase
	parked: boolean
	replayQueueDepth: number
	/** Null while parked (req 1.3). The caller's period otherwise, including null. */
	sweepPeriodMs: number | null
	holding?: {
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	}
	trial?: {
		protocol: ScannerProtocol
		decoder: string
		transport: "offset" | "channel" | "replay"
		discoveryId: string | null
	}
}

export function jobPhase(input: JobPhaseInput): ScanJobPhase {
	if (input.schedulerPhase === "tuning" || input.schedulerPhase === "settling")
		return "settling"
	if (input.hold !== null) return "holding"
	if (input.parked && input.liveProbe !== null) return "trialing"
	if (input.activity.replaying !== null) return "replaying"
	if (input.activity.capturing > 0) return "capturing"
	return "watching"
}

/** Progress fields derived from the phase. `holding` is present only for holding and trialing. */
export function jobProgressFields(
	input: JobPhaseInput,
	sweepPeriodMs: number | null,
): JobProgressFields {
	const phase = jobPhase(input)
	const holding =
		phase === "holding"
			? input.hold
			: phase === "trialing" && input.liveProbe !== null
				? {
						discoveryId: input.liveProbe.discoveryId,
						frequencyHz: input.liveProbe.frequencyHz,
						trackId: input.liveProbe.trackId,
					}
				: null
	const probe = input.liveProbe
	const replay = input.activity.replaying
	const trial = probe
		? {
				protocol: probe.protocol,
				decoder: probe.decoder,
				transport: probe.transport,
				discoveryId: probe.discoveryId,
			}
		: replay
			? {
					protocol: replay.protocol,
					decoder: replay.decoder,
					transport: "replay" as const,
					discoveryId: replay.discoveryId,
				}
			: null
	return {
		phase,
		parked: input.parked,
		replayQueueDepth: input.activity.replayQueueDepth,
		sweepPeriodMs: input.parked ? null : sweepPeriodMs,
		...(holding ? { holding } : {}),
		...(trial ? { trial } : {}),
	}
}
