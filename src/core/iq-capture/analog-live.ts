import { judgeAnalogResult } from "./analog-result.js"
import type { IqCaptureService } from "./service.js"
import type {
	AnalogTrialResult,
	AnalogTrialRunner,
} from "../scanner/scanner-redesign-contract.js"

/** A private lease on the same capture/analyze pipeline used by persistent replay. */
export function createAnalogLiveRunner(
	service: Pick<IqCaptureService, "withTrial"> &
		Partial<Pick<IqCaptureService, "leaseSession">>,
	replay: AnalogTrialRunner,
): AnalogTrialRunner {
	return {
		...(service.leaseSession
			? { leaseSession: (sourceId: string) => service.leaseSession!(sourceId) }
			: {}),
		run: (id, mode, signal) => replay.run(id, mode, signal),
		async runLive(req, mode, signal) {
			let unavailable: "unavailable" | "not-protected" = "unavailable"
			try {
				const result = await service.withTrial(req, signal, async id => {
					const raw = await replay.run(id, mode, signal)
					return (
						judgeAnalogResult(raw, mode).analog ??
						failed(mode, "analyze-failed")
					)
				})
				if (typeof result !== "string" && !signal.aborted) return result
				if (result === "not-protected") unavailable = result
			} catch {
				// A failed lease or runner is never evidence.
			}
			return {
				outcome: "no-sync",
				mode,
				voice: false,
				tones: { ctcssHz: null, dcs: null, audioSeconds: 0 },
				stats: null,
				error: signal.aborted ? "cancelled" : unavailable,
			}
		},
	}
}

function failed(
	mode: "nfm" | "am",
	error: "analyze-failed",
): AnalogTrialResult {
	return {
		outcome: "no-sync",
		mode,
		voice: false,
		tones: { ctcssHz: null, dcs: null, audioSeconds: 0 },
		stats: null,
		error,
	}
}
