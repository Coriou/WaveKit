/**
 * WG11 req 6.4 / 1.7 and WG12 req 4.4, 4.6, 5.5, 5.6 (pure): the replay trials of one IQ
 * capture. The discovery's known protocol's probe mode first (`known: true`), then one analog
 * trial when an analog prior above 0 selects one (a prior of 0 excludes that protocol; a missing
 * prior does not count), then the digital probe modes `identifyScores` gives the captured track
 * (bandplan priors, narrow raster per req 1.3), deduplicated by mode key, at most
 * IQ_REPLAY_MAX_TRIALS with the analog trial counted. Without a track: the known protocol, the
 * analog trial, else the probe modes of the protocols the capture's priors name above 0.
 * The analog protocol is `analog-am` when a shipped band plan at `capture.rfHz` lists it and its
 * prior is above 0, else `analog-fm` when its prior is above 0, else `analog-am` when its prior
 * is above 0, else none. Modulation follows the protocol (`am` or `nfm`). Never a protocol whose
 * prior is 0. `replayModeOf` keeps analog out of probe modes. Never `rtl433`, never an
 * ambient-only protocol as a probe.
 */
import { SCANNER_AMBIENT_PROTOCOLS } from "@wavekit/api-types"
import { bandplansFor } from "./bandplan/index.js"
import type { BandRegionCode } from "./bandplan/index.js"
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
import type { AnalogTrialMode } from "./scanner-redesign-contract.js"
import type { ScannerProtocol } from "./types.js"

/**
 * Every shipped region. The frozen plan input carries no region (Main will be told);
 * the lookup therefore searches every shipped plan.
 */
const BAND_REGIONS = [
	"EU",
	"US",
	"CA",
	"AU",
	"NZ",
	"JP",
	"CN",
] as const satisfies readonly BandRegionCode[]

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

function finitePrior(
	priors: Partial<Record<ScannerProtocol, number>>,
	protocol: ScannerProtocol,
): number | undefined {
	const value = priors[protocol]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Prior above 0. An explicit 0 excludes the protocol; a missing prior is not above 0. */
function priorAboveZero(
	priors: Partial<Record<ScannerProtocol, number>>,
	protocol: ScannerProtocol,
): boolean {
	const value = finitePrior(priors, protocol)
	return value !== undefined && value > 0
}

/**
 * One analog trial, or none. `analog-am` when the band lists AM and its prior is above 0;
 * else `analog-fm` when its prior is above 0; else `analog-am` when its prior is above 0.
 * Never a protocol whose prior is 0.
 */
function chooseAnalogTrial(input: IqReplayPlanInput): IqReplayTrial | null {
	const am = priorAboveZero(input.priors, "analog-am")
	const fm = priorAboveZero(input.priors, "analog-fm")
	if (bandplanListsAm(input.capture.rfHz) && am) return analogTrial("am")
	if (fm) return analogTrial("nfm")
	if (am) return analogTrial("am")
	return null
}

/** True when any shipped band plan range covering `hz` lists `analog-am`. */
function bandplanListsAm(hz: number): boolean {
	if (!Number.isFinite(hz)) return false
	for (const region of BAND_REGIONS) {
		for (const plan of bandplansFor(region)) {
			for (const range of plan.ranges) {
				if (hz < range.startHz || hz > range.endHz) continue
				if (range.protocols?.includes("analog-am")) return true
			}
		}
	}
	return false
}

function analogTrial(analogMode: AnalogTrialMode): IqReplayTrial {
	const protocol = analogMode === "am" ? "analog-am" : "analog-fm"
	const mode: ProbeMode = {
		decoderType: "dsd-fme",
		protocol,
		covers: [protocol],
		options: { analogTrial: analogMode },
		holdMs: 0,
	}
	return {
		protocol,
		mode,
		known: false,
		kind: "analog",
		analogMode,
	}
}

/**
 * Dedup by mode key (first wins) and the IQ_REPLAY_MAX_TRIALS bound, in candidate order. Exported for the
 * bound test: the built-in probe modes give fewer distinct keys than the bound. The analog trial counts.
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
	// A prior of 0 removes a protocol (requirement 1.3), the known one included.
	if (input.knownProtocol !== null && input.priors[input.knownProtocol] !== 0)
		add(input.knownProtocol, true)
	const analog = chooseAnalogTrial(input)
	if (analog) candidates.push(analog)
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
