/**
 * WG11 req 6.4 / 1.7 (pure): the replay trials of one IQ capture. The discovery's known protocol's probe
 * mode first (`known: true`), then the probe modes `identifyScores` gives the captured track (bandplan
 * priors, narrow raster per req 1.3), deduplicated by mode key, at most IQ_REPLAY_MAX_TRIALS. Without a
 * track: the known protocol alone, else the probe modes of the protocols the capture's priors name above 0.
 * Never `rtl433` (the replay transport refuses it), never an ambient-only or analog protocol. Imports are
 * pure planning helpers only (identify.ts is already part of the core bundle through the scanner).
 */
import { SCANNER_AMBIENT_PROTOCOLS } from "@wavekit/api-types"
import {
	IDENTIFY_ANALOG_PROTOCOLS,
	IDENTIFY_PROTOCOLS,
	identifyModeFor,
	identifyScores,
} from "./identify.js"
import {
	IQ_REPLAY_MAX_TRIALS,
	type IqReplayPlanInput,
	type IqReplayPlanner,
	type IqReplayTrial,
} from "./iq-capture-contract.js"
import type { ProbeMode } from "./probes/probe-pool.js"
import type { ScannerProtocol } from "./types.js"

function modeKey(mode: ProbeMode): string {
	return `${mode.decoderType}:${JSON.stringify(mode.options)}`
}

/** The replayable probe mode of a protocol, or null (no decoder, rtl433, ambient-only, analog, unknown). */
function replayModeOf(protocol: ScannerProtocol): ProbeMode | null {
	if (
		!IDENTIFY_PROTOCOLS.includes(protocol) ||
		SCANNER_AMBIENT_PROTOCOLS.includes(protocol) ||
		IDENTIFY_ANALOG_PROTOCOLS.includes(protocol)
	)
		return null
	const mode = identifyModeFor(protocol)
	if (!mode || mode.decoderType === "rtl433") return null
	return mode
}

/**
 * Dedup by mode key (first wins) and the IQ_REPLAY_MAX_TRIALS bound, in candidate order. Exported for the
 * bound test: the built-in probe modes give fewer distinct keys than the bound.
 */
export function boundReplayTrials(
	candidates: readonly IqReplayTrial[],
): IqReplayTrial[] {
	const out: IqReplayTrial[] = []
	const keys = new Set<string>()
	for (const c of candidates) {
		if (out.length >= IQ_REPLAY_MAX_TRIALS) break
		const key = modeKey(c.mode)
		if (keys.has(key)) continue
		keys.add(key)
		out.push(c)
	}
	return out
}

export function planReplayTrials(input: IqReplayPlanInput): IqReplayTrial[] {
	const candidates: IqReplayTrial[] = []
	const add = (protocol: ScannerProtocol, known: boolean): void => {
		const mode = replayModeOf(protocol)
		if (mode) candidates.push({ protocol, mode, known })
	}
	if (input.knownProtocol !== null) add(input.knownProtocol, true)
	if (input.track) {
		for (const h of identifyScores(input.track, {
			priors: input.priors,
			protocols: [],
			narrow: input.narrowRaster === true,
		}))
			add(h.protocol, false)
	} else if (input.knownProtocol === null) {
		const named = (
			Object.entries(input.priors) as [ScannerProtocol, number | undefined][]
		)
			.filter(([, prior]) => typeof prior === "number" && prior > 0)
			.sort(([a, pa], [b, pb]) => (pb ?? 0) - (pa ?? 0) || a.localeCompare(b))
		for (const [protocol] of named) add(protocol, false)
	}
	return boundReplayTrials(candidates)
}

/** Type check: the planner satisfies the frozen contract's port. */
export const replayPlanner: IqReplayPlanner = planReplayTrials
